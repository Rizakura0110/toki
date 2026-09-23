// The server owns session timestamps and state. This module only animates their presentation.

/** @typedef {"stopwatch" | "timer"} SessionMode */
/** @typedef {"running" | "awaiting_description" | "saved" | "discarded"} SessionStatus */
/**
 * @typedef {object} TokiSession
 * @property {string} id
 * @property {SessionMode} mode
 * @property {SessionStatus} status
 * @property {number} startedAtMs
 * @property {number | null} deadlineAtMs
 * @property {number | null} endedAtMs
 * @property {number | null} timerSeconds
 */
/** @typedef {{ session: TokiSession | null, serverNowMs: number }} SessionEnvelope */

/** @param {number} durationMs */
export function formatDuration(durationMs) {
  const seconds = Math.floor(Math.max(0, Number.isFinite(durationMs) ? durationMs : 0) / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
}

/** @param {TokiSession} session @param {number} nowMs */
export function durationForDisplay(session, nowMs) {
  if (session.status === "running") {
    return session.mode === "timer"
      ? Math.max(0, (session.deadlineAtMs ?? nowMs) - nowMs)
      : Math.max(0, nowMs - session.startedAtMs);
  }
  return Math.max(0, (session.endedAtMs ?? session.startedAtMs) - session.startedAtMs);
}

/** Approximate one-way transport delay without trusting the device wall clock. */
/** @param {number} serverNowMs @param {number} requestStartedPerf @param {number} responseReceivedPerf */
export function estimateServerNowAtReceive(serverNowMs, requestStartedPerf, responseReceivedPerf) {
  return serverNowMs + Math.max(0, responseReceivedPerf - requestStartedPerf) / 2;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is TokiSession} */
function isSession(value) {
  if (!isObject(value)) return false;
  return (
    typeof value.id === "string" &&
    (value.mode === "stopwatch" || value.mode === "timer") &&
    ["running", "awaiting_description", "saved", "discarded"].includes(String(value.status)) &&
    Number.isSafeInteger(value.startedAtMs) &&
    (value.deadlineAtMs === null || Number.isSafeInteger(value.deadlineAtMs)) &&
    (value.endedAtMs === null || Number.isSafeInteger(value.endedAtMs)) &&
    (value.timerSeconds === null || Number.isSafeInteger(value.timerSeconds))
  );
}

/** @param {unknown} value @returns {SessionEnvelope} */
function readEnvelope(value) {
  if (
    !isObject(value) ||
    !Number.isSafeInteger(value.serverNowMs) ||
    (value.session !== null && !isSession(value.session))
  ) {
    throw new Error("INVALID_RESPONSE");
  }
  return /** @type {SessionEnvelope} */ (value);
}

class ApiError extends Error {
  /** @param {number} status @param {string} code */
  constructor(status, code) {
    super(code);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/** @param {string} path @param {"GET" | "POST"} method @param {object=} body @returns {Promise<unknown>} */
async function requestJson(path, method = "GET", body) {
  /** @type {RequestInit} */
  const options = {
    method,
    credentials: "same-origin",
    cache: "no-store",
  };
  if (method !== "GET") {
    options.headers = { "Content-Type": "application/json", "X-Toki-Client": "web" };
    options.body = JSON.stringify(body ?? {});
  }
  const response = await fetch(path, options);
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("INVALID_RESPONSE");
  }
  if (!response.ok) {
    const code = isObject(payload) && isObject(payload.error) ? payload.error.code : undefined;
    throw new ApiError(response.status, typeof code === "string" ? code : "REQUEST_FAILED");
  }
  return payload;
}

/** @param {string} id @returns {HTMLElement} */
function element(id) {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`Missing UI element: ${id}`);
  return found;
}

if (typeof document !== "undefined") {
  const ui = {
    normalView: element("normal-view"),
    focusView: element("focus-view"),
    loadingPanel: element("loading-panel"),
    idlePanel: element("idle-panel"),
    runningPanel: element("running-panel"),
    descriptionPanel: element("description-panel"),
    notice: element("notice"),
    error: element("sync-error"),
    errorText: element("sync-error-text"),
    retrySync: /** @type {HTMLButtonElement} */ (element("retry-sync")),
    startForm: /** @type {HTMLFormElement} */ (element("start-form")),
    timerInputs: element("timer-inputs"),
    timerHours: /** @type {HTMLInputElement} */ (element("timer-hours")),
    timerMinutes: /** @type {HTMLInputElement} */ (element("timer-minutes")),
    timerSeconds: /** @type {HTMLInputElement} */ (element("timer-seconds")),
    startButton: /** @type {HTMLButtonElement} */ (element("start-button")),
    runningTimeLabel: element("running-time-label"),
    runningTime: element("running-time"),
    runningDetail: element("running-detail"),
    enterFocus: /** @type {HTMLButtonElement} */ (element("enter-focus")),
    exitFocus: /** @type {HTMLButtonElement} */ (element("exit-focus")),
    focusTime: element("focus-time"),
    stopButton: /** @type {HTMLButtonElement} */ (element("stop-button")),
    finishedTime: element("finished-time"),
    saveForm: /** @type {HTMLFormElement} */ (element("save-form")),
    description: /** @type {HTMLTextAreaElement} */ (element("description")),
    descriptionCount: element("description-count"),
    saveButton: /** @type {HTMLButtonElement} */ (element("save-button")),
    discardButton: /** @type {HTMLButtonElement} */ (element("discard-button")),
  };

  /** @type {{ session: TokiSession | null, loading: boolean, busy: boolean, uncertain: boolean, focus: boolean, error: string, errorRequiresSync: boolean, notice: string, serverAnchorMs: number, perfAnchorMs: number, deadlineSyncRequested: boolean, pendingStart: { clientRequestId: string, mode: SessionMode, timerSeconds: number | null } | null, pendingResolutionAction: "save" | "discard" | null }} */
  const state = {
    session: null,
    loading: true,
    busy: false,
    uncertain: false,
    focus: false,
    error: "",
    errorRequiresSync: false,
    notice: "",
    serverAnchorMs: Date.now(),
    perfAnchorMs: performance.now(),
    deadlineSyncRequested: false,
    pendingStart: null,
    pendingResolutionAction: null,
  };

  /** @returns {number} */
  function estimatedServerNow() {
    // A monotonic clock prevents a device clock correction from changing the display mid-session.
    return state.serverAnchorMs + (performance.now() - state.perfAnchorMs);
  }

  /** @param {SessionEnvelope} envelope @param {number} requestStartedPerf */
  function acceptEnvelope(envelope, requestStartedPerf) {
    const previous = state.session;
    const receivedPerf = performance.now();
    state.serverAnchorMs = estimateServerNowAtReceive(
      envelope.serverNowMs,
      requestStartedPerf,
      receivedPerf,
    );
    state.perfAnchorMs = receivedPerf;
    state.session = envelope.session;
    if (
      previous?.id !== envelope.session?.id ||
      previous?.status !== envelope.session?.status ||
      previous?.deadlineAtMs !== envelope.session?.deadlineAtMs
    ) {
      state.deadlineSyncRequested = false;
    }
    if (envelope.session !== null) state.pendingStart = null;
    if (envelope.session?.status !== "running") state.focus = false;
    if (previous?.id !== envelope.session?.id) ui.description.value = "";
    ui.descriptionCount.textContent = `${ui.description.value.length} / 500`;
  }

  /** @param {string} message @param {boolean} requiresSync */
  function showError(message, requiresSync) {
    state.error = message;
    state.errorRequiresSync = requiresSync;
    state.notice = "";
  }

  /** @param {unknown} cause @param {string} fallback */
  function messageForFailure(cause, fallback) {
    if (cause instanceof ApiError) {
      if (cause.status === 401 || cause.status === 403) {
        return "認証を確認できませんでした。ログイン状態を確認してから、状態を読み直してください。";
      }
      if (cause.status === 409) {
        return "別の画面で計測の状態が変わった可能性があります。状態を確認してください。";
      }
      if (cause.status === 400) return "入力内容を確認してください。";
    }
    return fallback;
  }

  function updateClock() {
    const session = state.session;
    if (session === null) return;
    const nowMs = estimatedServerNow();
    const time = formatDuration(durationForDisplay(session, nowMs));
    ui.runningTime.textContent = time;
    ui.focusTime.textContent = time;
    ui.runningTime.classList.toggle("time-long", time.length > 9);
    ui.runningTime.classList.toggle("time-very-long", time.length > 12);
    ui.focusTime.classList.toggle("time-long", time.length > 9);
    ui.focusTime.classList.toggle("time-very-long", time.length > 12);
    ui.finishedTime.textContent = formatDuration(durationForDisplay(session, nowMs));
    if (
      session.status === "running" &&
      session.mode === "timer" &&
      session.deadlineAtMs !== null &&
      nowMs >= session.deadlineAtMs &&
      !state.deadlineSyncRequested &&
      !state.busy
    ) {
      state.deadlineSyncRequested = true;
      void refreshSession();
    }
  }

  function render() {
    const session = state.session;
    const running = session?.status === "running";
    const awaiting = session?.status === "awaiting_description";
    if (!running) state.focus = false;

    ui.normalView.hidden = state.focus;
    ui.focusView.hidden = !state.focus;
    ui.loadingPanel.hidden = !state.loading;
    ui.idlePanel.hidden = state.loading || session !== null || state.uncertain;
    ui.runningPanel.hidden = !running || state.loading;
    ui.descriptionPanel.hidden = !awaiting || state.loading;
    ui.notice.hidden = state.notice === "";
    ui.notice.textContent = state.notice;
    ui.error.hidden = state.error === "";
    ui.errorText.textContent = state.error;
    ui.retrySync.hidden = !state.errorRequiresSync;
    ui.retrySync.disabled = state.busy;

    const locked = state.busy || state.uncertain;
    ui.startButton.disabled = locked;
    ui.stopButton.disabled = locked;
    ui.saveButton.disabled = locked;
    ui.discardButton.disabled = locked;
    ui.enterFocus.disabled = state.busy;
    ui.description.disabled = locked;
    ui.runningTimeLabel.textContent = session?.mode === "timer" ? "残り時間" : "経過時間";
    if (running && session !== undefined) {
      const time = new Intl.DateTimeFormat("ja-JP", {
        timeZone: "Asia/Tokyo",
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(session.startedAtMs);
      ui.runningDetail.textContent = `${time} に開始 · 日本時間`;
    }
    document.title = running
      ? "計測中 — Toki"
      : awaiting
        ? "内容を入力 — Toki"
        : "Toki — 時間を記録する";
    updateClock();
  }

  async function refreshSession() {
    if (state.busy) return;
    const focusWasActive = state.focus;
    state.busy = true;
    render();
    try {
      const requestStartedPerf = performance.now();
      const envelope = readEnvelope(await requestJson("/api/v1/session"));
      acceptEnvelope(envelope, requestStartedPerf);
      state.uncertain = false;
      if (envelope.session === null && state.pendingResolutionAction !== null) {
        showError(
          state.pendingResolutionAction === "save"
            ? "未完了の計測はありません。直前の保存結果は確認できません。後でカレンダーに記録があるか確認してください。"
            : "未完了の計測はありません。直前の破棄結果は確認できません。後でカレンダーに記録がないか確認してください。",
          false,
        );
      } else {
        state.pendingResolutionAction = null;
        state.error = "";
        state.errorRequiresSync = false;
      }
    } catch (cause) {
      state.focus = false;
      state.uncertain = true;
      showError(
        messageForFailure(
          cause,
          "現在の状態を読み込めませんでした。通信を確認してから再試行してください。",
        ),
        true,
      );
    } finally {
      state.loading = false;
      state.busy = false;
      render();
      if (focusWasActive && !state.focus) {
        if (state.errorRequiresSync) ui.retrySync.focus();
        else if (state.session?.status === "awaiting_description") ui.description.focus();
        else if (state.session?.status === "running") ui.enterFocus.focus();
        else ui.startButton.focus();
      }
    }
  }

  /** @param {string} path @param {object} body @param {string} notice */
  async function mutate(path, body, notice) {
    if (state.busy || state.uncertain) return;
    state.busy = true;
    state.error = "";
    state.notice = "";
    render();
    try {
      const requestStartedPerf = performance.now();
      const envelope = readEnvelope(await requestJson(path, "POST", body));
      acceptEnvelope(envelope, requestStartedPerf);
      if (envelope.session?.status === "saved" || envelope.session?.status === "discarded") {
        state.session = null;
        state.focus = false;
      }
      state.pendingResolutionAction = null;
      state.notice = notice;
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 400) {
        showError(messageForFailure(cause, "入力内容を確認してください。"), false);
      } else {
        // The request may have reached the server. Reconcile before allowing another mutation.
        if (path.endsWith("/save")) state.pendingResolutionAction = "save";
        else if (path.endsWith("/discard")) state.pendingResolutionAction = "discard";
        state.uncertain = true;
        showError(
          messageForFailure(
            cause,
            "更新結果を確認できませんでした。状態を確認してから操作を続けてください。",
          ),
          true,
        );
      }
    } finally {
      state.busy = false;
      render();
    }
  }

  /** @returns {number | null} */
  function readTimerSeconds() {
    const fields = [ui.timerHours, ui.timerMinutes, ui.timerSeconds];
    if (fields.some((field) => field.value.trim() === "")) return null;
    const values = fields.map((field) => Number(field.value));
    const [hours, minutes, seconds] = values;
    if (
      hours === undefined ||
      minutes === undefined ||
      seconds === undefined ||
      !values.every(Number.isInteger) ||
      hours < 0 ||
      hours > 24 ||
      minutes < 0 ||
      minutes > 59 ||
      seconds < 0 ||
      seconds > 59
    ) {
      return null;
    }
    const total = hours * 3600 + minutes * 60 + seconds;
    return total >= 1 && total <= 86_400 ? total : null;
  }

  ui.startForm.addEventListener("change", () => {
    const selected = /** @type {HTMLInputElement | null} */ (
      ui.startForm.querySelector('input[name="mode"]:checked')
    );
    ui.timerInputs.hidden = selected?.value !== "timer";
    state.error = "";
    render();
  });

  ui.startForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const selected = /** @type {HTMLInputElement | null} */ (
      ui.startForm.querySelector('input[name="mode"]:checked')
    );
    const mode = selected?.value === "timer" ? "timer" : "stopwatch";
    const timerSeconds = mode === "timer" ? readTimerSeconds() : null;
    if (mode === "timer" && timerSeconds === null) {
      showError("タイマーは1秒から24時間の範囲で設定してください。", false);
      render();
      return;
    }
    if (
      state.pendingStart === null ||
      state.pendingStart.mode !== mode ||
      state.pendingStart.timerSeconds !== timerSeconds
    ) {
      state.pendingStart = { clientRequestId: crypto.randomUUID(), mode, timerSeconds };
    }
    const body =
      mode === "timer"
        ? { mode, timerSeconds, clientRequestId: state.pendingStart.clientRequestId }
        : { mode, clientRequestId: state.pendingStart.clientRequestId };
    void mutate("/api/v1/session", body, "計測を始めました。");
  });

  ui.stopButton.addEventListener("click", () => {
    const id = state.session?.id;
    if (id)
      void mutate(
        `/api/v1/session/${encodeURIComponent(id)}/stop`,
        {},
        "計測を終了しました。内容を入力してください。",
      );
  });

  ui.saveForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const id = state.session?.id;
    const description = ui.description.value.trim();
    if (!id) return;
    if (description.length < 1 || description.length > 500) {
      showError("内容を1〜500文字で入力してください。", false);
      render();
      return;
    }
    void mutate(
      `/api/v1/session/${encodeURIComponent(id)}/save`,
      { description },
      "記録を保存しました。",
    );
  });

  ui.discardButton.addEventListener("click", () => {
    const id = state.session?.id;
    if (id && window.confirm("この計測を保存せずに破棄しますか？")) {
      void mutate(
        `/api/v1/session/${encodeURIComponent(id)}/discard`,
        {},
        "未保存の計測を破棄しました。",
      );
    }
  });

  ui.description.addEventListener("input", () => {
    ui.descriptionCount.textContent = `${ui.description.value.length} / 500`;
    if (state.error && !state.errorRequiresSync) {
      state.error = "";
      render();
    }
  });

  ui.enterFocus.addEventListener("click", () => {
    if (state.session?.status !== "running") return;
    state.focus = true;
    render();
    ui.exitFocus.focus();
  });

  function exitFocus() {
    if (!state.focus) return;
    state.focus = false;
    render();
    ui.enterFocus.focus();
  }

  ui.exitFocus.addEventListener("click", exitFocus);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") exitFocus();
  });
  ui.retrySync.addEventListener("click", () => void refreshSession());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refreshSession();
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) void refreshSession();
  });
  window.addEventListener("online", () => {
    if (state.uncertain) void refreshSession();
  });

  // This interval touches the DOM only. It never polls the API or writes a stored duration.
  window.setInterval(updateClock, 250);
  void refreshSession();
}
