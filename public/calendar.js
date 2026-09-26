import {
  TIMELINE_HOUR_HEIGHT,
  addDays,
  dayRange,
  formatTokyoDateTimeInput,
  layoutDayRecords,
  parseTokyoDateTimeInput,
  tokyoDateKey,
  weekRange,
  weekStart,
} from "./calendar-core.js";

/** @typedef {"day" | "week"} CalendarView */
/**
 * @typedef {object} CalendarRecord
 * @property {string} id
 * @property {"saved"} status
 * @property {"stopwatch" | "timer" | "manual"} mode
 * @property {number} startedAtMs
 * @property {number} endedAtMs
 * @property {string} description
 * @property {number} version
 */

const MIN_DATE = "1970-01-02";
const MIN_WEEK_DATE = "1970-01-05";
const MAX_DATE = "2100-12-31";
const MAX_RECORD_MS = 366 * 24 * 60 * 60 * 1000;

class ApiError extends Error {
  /** @param {number} status @param {string} code */
  constructor(status, code) {
    super(code);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {CalendarRecord[]} */
function readRecords(value) {
  if (!isObject(value) || !Array.isArray(value.records)) throw new Error("INVALID_RESPONSE");
  /** @type {CalendarRecord[]} */
  const result = [];
  for (const item of value.records) {
    if (
      !isObject(item) ||
      typeof item.id !== "string" ||
      item.status !== "saved" ||
      (item.mode !== "stopwatch" && item.mode !== "timer" && item.mode !== "manual") ||
      !Number.isSafeInteger(item.startedAtMs) ||
      !Number.isSafeInteger(item.endedAtMs) ||
      typeof item.description !== "string" ||
      !Number.isSafeInteger(item.version) ||
      Number(item.version) < 1 ||
      Number(item.endedAtMs) <= Number(item.startedAtMs)
    ) {
      throw new Error("INVALID_RESPONSE");
    }
    result.push(/** @type {CalendarRecord} */ (item));
  }
  return result;
}

/** @param {string} path @param {"GET" | "PATCH" | "POST" | "DELETE"=} method @param {object=} body */
async function requestJson(path, method = "GET", body) {
  /** @type {RequestInit} */
  const options = { method, credentials: "same-origin", cache: "no-store" };
  if (method !== "GET") {
    options.headers = { "Content-Type": "application/json", "X-Toki-Client": "web" };
    options.body = JSON.stringify(body);
  }
  const response = await fetch(path, options);
  let payload;
  try {
    payload = await response.json();
  } catch {
    if (response.status === 401 || response.status === 403) {
      throw new ApiError(response.status, "UNAUTHORIZED");
    }
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

/** @param {CalendarRecord} record */
function recordLabel(record) {
  return `${record.description}、${formatTokyoDateTimeInput(record.startedAtMs).replace("T", " ")} から ${formatTokyoDateTimeInput(record.endedAtMs).replace("T", " ")} まで。編集する`;
}

/** @param {unknown} cause @param {string} fallback */
function failureMessage(cause, fallback) {
  if (cause instanceof ApiError) {
    if (cause.status === 401 || cause.status === 403) {
      return "認証を確認できませんでした。ログイン状態を確認してから再読み込みしてください。";
    }
    if (cause.status === 400) return "日時や内容を確認してください。";
    if (cause.status === 404) return "記録が見つかりません。再読み込みして確認してください。";
    if (cause.status === 409) {
      return "ほかの画面で記録が更新されました。上書きせず、記録を再読み込みしてください。";
    }
  }
  return fallback;
}

/** @param {string} dateKey @param {CalendarView} view */
function availableDate(dateKey, view) {
  if (dateKey < (view === "week" ? MIN_WEEK_DATE : MIN_DATE) || dateKey > MAX_DATE) return false;
  try {
    const range = view === "week" ? weekRange(dateKey) : dayRange(dateKey);
    return Number.isSafeInteger(range.startMs) && range.startMs > 0;
  } catch {
    return false;
  }
}

/** @param {string} key */
function dateHeading(key) {
  const start = dayRange(key).startMs;
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    weekday: "short",
  }).format(start);
}

/** @param {string} key */
function periodDateLabel(key) {
  const start = dayRange(key).startMs;
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(start);
}

if (typeof document !== "undefined") {
  const ui = {
    notice: element("calendar-notice"),
    error: element("calendar-error"),
    errorText: element("calendar-error-text"),
    retry: /** @type {HTMLButtonElement} */ (element("calendar-retry")),
    periodLabel: element("period-label"),
    recordCount: element("record-count"),
    dayView: /** @type {HTMLButtonElement} */ (element("day-view")),
    weekView: /** @type {HTMLButtonElement} */ (element("week-view")),
    previous: /** @type {HTMLButtonElement} */ (element("previous-period")),
    next: /** @type {HTMLButtonElement} */ (element("next-period")),
    today: /** @type {HTMLButtonElement} */ (element("today-period")),
    date: /** @type {HTMLInputElement} */ (element("calendar-date")),
    loading: element("calendar-loading"),
    empty: element("calendar-empty"),
    scroller: element("timeline-scroller"),
    timeline: element("timeline-inner"),
    recordsList: element("records-list"),
    newRecord: /** @type {HTMLButtonElement} */ (element("new-record")),
    dialog: /** @type {HTMLDialogElement} */ (element("edit-dialog")),
    editForm: /** @type {HTMLFormElement} */ (element("edit-form")),
    editStart: /** @type {HTMLInputElement} */ (element("edit-start")),
    editEnd: /** @type {HTMLInputElement} */ (element("edit-end")),
    editDescription: /** @type {HTMLTextAreaElement} */ (element("edit-description")),
    editError: element("edit-error"),
    editErrorText: element("edit-error-text"),
    editReload: /** @type {HTMLButtonElement} */ (element("edit-reload")),
    deleteConfirmation: element("delete-confirmation"),
    deleteCancel: /** @type {HTMLButtonElement} */ (element("delete-cancel")),
    deleteConfirm: /** @type {HTMLButtonElement} */ (element("delete-confirm")),
    editDelete: /** @type {HTMLButtonElement} */ (element("edit-delete")),
    editCancel: /** @type {HTMLButtonElement} */ (element("edit-cancel")),
    editSave: /** @type {HTMLButtonElement} */ (element("edit-save")),
    createDialog: /** @type {HTMLDialogElement} */ (element("create-dialog")),
    createForm: /** @type {HTMLFormElement} */ (element("create-form")),
    createStart: /** @type {HTMLInputElement} */ (element("create-start")),
    createEnd: /** @type {HTMLInputElement} */ (element("create-end")),
    createDescription: /** @type {HTMLTextAreaElement} */ (element("create-description")),
    createError: element("create-error"),
    createErrorText: element("create-error-text"),
    createReload: /** @type {HTMLButtonElement} */ (element("create-reload")),
    createCancel: /** @type {HTMLButtonElement} */ (element("create-cancel")),
    createSave: /** @type {HTMLButtonElement} */ (element("create-save")),
  };

  const smallScreen = window.matchMedia("(max-width: 700px)");
  /** @typedef {{startedAtMs: number, endedAtMs: number, description: string, clientRequestId: string}} CreatePayload */
  /** @type {{dateKey: string, view: CalendarView, records: CalendarRecord[], loading: boolean, error: string, notice: string, requestNumber: number, editing: CalendarRecord | null, editBusy: boolean, confirmingDelete: boolean, createBusy: boolean, createRequestId: string | null, createRetryPayload: CreatePayload | null, createSubmittedStartMs: number | null}} */
  const state = {
    dateKey: tokyoDateKey(Date.now()),
    view: smallScreen.matches ? "day" : "week",
    records: [],
    loading: true,
    error: "",
    notice: "",
    requestNumber: 0,
    editing: null,
    editBusy: false,
    confirmingDelete: false,
    createBusy: false,
    createRequestId: null,
    createRetryPayload: null,
    createSubmittedStartMs: null,
  };

  /** @param {string} message @param {boolean} reload */
  function showEditError(message, reload) {
    ui.editErrorText.textContent = message;
    ui.editError.hidden = false;
    ui.editReload.hidden = !reload;
    ui.editSave.disabled = reload;
    ui.editDelete.disabled = reload;
    if (reload) {
      state.confirmingDelete = false;
      ui.deleteConfirmation.hidden = true;
    }
  }

  function clearEditError() {
    ui.editError.hidden = true;
    ui.editErrorText.textContent = "";
    ui.editReload.hidden = true;
    ui.editSave.disabled = false;
    ui.editDelete.disabled = false;
  }

  /** @param {string} id */
  function openEdit(id) {
    const record = state.records.find((item) => item.id === id);
    if (record === undefined) return;
    state.editing = record;
    state.confirmingDelete = false;
    ui.deleteConfirmation.hidden = true;
    ui.editStart.value = formatTokyoDateTimeInput(record.startedAtMs);
    ui.editEnd.value = formatTokyoDateTimeInput(record.endedAtMs);
    ui.editDescription.value = record.description;
    clearEditError();
    ui.dialog.showModal();
    ui.editStart.focus();
  }

  /** @param {string} message @param {boolean} reload */
  function showCreateError(message, reload) {
    ui.createErrorText.textContent = message;
    ui.createError.hidden = false;
    ui.createReload.hidden = !reload;
    ui.createSave.disabled = reload;
  }

  function clearCreateError() {
    ui.createError.hidden = true;
    ui.createErrorText.textContent = "";
    ui.createReload.hidden = true;
    ui.createSave.disabled = false;
  }

  /** @param {boolean} disabled */
  function setCreateFieldsDisabled(disabled) {
    ui.createStart.disabled = disabled;
    ui.createEnd.disabled = disabled;
    ui.createDescription.disabled = disabled;
  }

  function openCreate() {
    const startMs = dayRange(state.dateKey).startMs + 9 * 60 * 60 * 1000;
    ui.createStart.value = formatTokyoDateTimeInput(startMs);
    ui.createEnd.value = formatTokyoDateTimeInput(startMs + 60 * 60 * 1000);
    ui.createDescription.value = "";
    state.createRequestId = crypto.randomUUID();
    state.createRetryPayload = null;
    state.createSubmittedStartMs = null;
    ui.createSave.textContent = "記録を保存";
    setCreateFieldsDisabled(false);
    clearCreateError();
    ui.createDialog.showModal();
    ui.createStart.focus();
  }

  /** @param {CalendarRecord} record @returns {HTMLButtonElement} */
  function recordButton(record) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "record-button";
    button.setAttribute("aria-label", recordLabel(record));
    const main = document.createElement("span");
    main.className = "record-main";
    const accent = document.createElement("span");
    accent.className = "record-accent";
    accent.setAttribute("aria-hidden", "true");
    const description = document.createElement("span");
    description.className = "record-description";
    description.textContent = record.description;
    main.replaceChildren(accent, description);
    const time = document.createElement("span");
    time.className = "record-time";
    time.textContent = `${formatTokyoDateTimeInput(record.startedAtMs).replace("T", " ")} – ${formatTokyoDateTimeInput(record.endedAtMs).replace("T", " ")}`;
    button.replaceChildren(main, time);
    button.addEventListener("click", () => openEdit(record.id));
    return button;
  }

  /** @param {string} dateKey @returns {HTMLElement} */
  function dayColumn(dateKey) {
    const day = document.createElement("div");
    day.className = "timeline-day";
    if (dateKey === tokyoDateKey(Date.now())) day.classList.add("today");
    const range = dayRange(dateKey);
    const laidOut = layoutDayRecords(state.records, dateKey);
    for (const item of laidOut) {
      const record = /** @type {CalendarRecord} */ (item.record);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "timeline-event";
      button.style.top = `${item.visualTopPercent}%`;
      button.style.height = `${item.visualHeightPercent}%`;
      button.style.left = `${item.visualLeftPercent}%`;
      button.style.width = `${item.visualWidthPercent}%`;
      button.setAttribute("aria-label", recordLabel(record));
      button.title = recordLabel(record);
      const time = document.createElement("span");
      time.className = "timeline-event-time";
      const startTime =
        item.clippedStartMs === range.startMs
          ? "00:00"
          : formatTokyoDateTimeInput(item.clippedStartMs).slice(11, 16);
      const endTime =
        item.clippedEndMs === range.endMs
          ? "24:00"
          : formatTokyoDateTimeInput(item.clippedEndMs).slice(11, 16);
      time.textContent = `${startTime}–${endTime}`;
      const description = document.createElement("span");
      description.className = "timeline-event-title";
      description.textContent = record.description;
      button.replaceChildren(description, time);
      button.addEventListener("click", () => openEdit(record.id));
      day.appendChild(button);
    }
    return day;
  }

  function renderTimeline() {
    const first = state.view === "week" ? weekStart(state.dateKey) : state.dateKey;
    const days = Array.from({ length: state.view === "week" ? 7 : 1 }, (_, index) =>
      addDays(first, index),
    );
    ui.timeline.className = state.view === "week" ? "timeline-inner week" : "timeline-inner";
    ui.timeline.style.setProperty("--timeline-hour-height", `${TIMELINE_HOUR_HEIGHT}px`);
    ui.timeline.style.setProperty("--timeline-day-height", `${24 * TIMELINE_HOUR_HEIGHT}px`);
    const head = document.createElement("div");
    head.className = "timeline-head";
    const spacer = document.createElement("div");
    spacer.className = "timeline-head-spacer";
    spacer.setAttribute("aria-hidden", "true");
    head.appendChild(spacer);
    for (const dateKey of days) {
      const heading = document.createElement("div");
      heading.className = "timeline-day-heading";
      if (dateKey === tokyoDateKey(Date.now())) heading.classList.add("today");
      heading.textContent = dateHeading(dateKey);
      head.appendChild(heading);
    }
    const body = document.createElement("div");
    body.className = "timeline-body";
    const axis = document.createElement("div");
    axis.className = "timeline-axis";
    for (let hour = 0; hour < 24; hour += 1) {
      const label = document.createElement("span");
      label.className = "timeline-hour";
      label.style.top = `${(hour / 24) * 100}%`;
      label.textContent = `${String(hour).padStart(2, "0")}:00`;
      axis.appendChild(label);
    }
    body.appendChild(axis);
    for (const dateKey of days) body.appendChild(dayColumn(dateKey));
    ui.timeline.replaceChildren(head, body);
  }

  function renderRecords() {
    const list = state.records
      .slice()
      .sort(
        (left, right) => left.startedAtMs - right.startedAtMs || left.id.localeCompare(right.id),
      );
    const nodes = list.map((record) => {
      const item = document.createElement("li");
      item.appendChild(recordButton(record));
      return item;
    });
    ui.recordsList.replaceChildren(...nodes);
  }

  /** @param {number} delta */
  function canMove(delta) {
    try {
      return availableDate(addDays(state.dateKey, delta), state.view);
    } catch {
      return false;
    }
  }

  function render() {
    const today = tokyoDateKey(Date.now());
    const first = state.view === "week" ? weekStart(state.dateKey) : state.dateKey;
    ui.periodLabel.textContent =
      state.view === "week"
        ? `${periodDateLabel(first)} 〜 ${periodDateLabel(addDays(first, 6))}`
        : periodDateLabel(state.dateKey);
    ui.recordCount.textContent = state.loading
      ? "記録を確認しています…"
      : `${state.records.length}件の記録`;
    ui.dayView.setAttribute("aria-pressed", String(state.view === "day"));
    ui.weekView.setAttribute("aria-pressed", String(state.view === "week"));
    ui.date.min = state.view === "week" ? MIN_WEEK_DATE : MIN_DATE;
    ui.date.max = MAX_DATE;
    ui.date.value = state.dateKey;
    ui.previous.disabled = !canMove(state.view === "week" ? -7 : -1);
    ui.next.disabled = !canMove(state.view === "week" ? 7 : 1);
    ui.today.disabled = state.dateKey === today;
    ui.notice.hidden = state.notice === "";
    ui.notice.textContent = state.notice;
    ui.error.hidden = state.error === "";
    ui.errorText.textContent = state.error;
    ui.loading.hidden = !state.loading;
    ui.empty.hidden = state.loading || state.error !== "" || state.records.length > 0;
    ui.scroller.hidden = state.loading || state.error !== "" || state.records.length === 0;
    if (!state.loading && state.error === "") {
      if (state.records.length > 0) renderTimeline();
      renderRecords();
    } else {
      ui.recordsList.replaceChildren();
    }
  }

  async function loadRecords() {
    const requestNumber = ++state.requestNumber;
    state.loading = true;
    state.error = "";
    render();
    const range = state.view === "week" ? weekRange(state.dateKey) : dayRange(state.dateKey);
    try {
      const path = `/api/v1/records?startMs=${range.startMs}&endMs=${range.endMs}`;
      const records = readRecords(await requestJson(path));
      if (requestNumber !== state.requestNumber) return;
      state.records = records;
      state.loading = false;
      render();
    } catch (cause) {
      if (requestNumber !== state.requestNumber) return;
      state.records = [];
      state.loading = false;
      state.error = failureMessage(
        cause,
        "記録を読み込めませんでした。通信を確認して再読み込みしてください。",
      );
      render();
    }
  }

  /** @param {CalendarView} view */
  function setView(view) {
    if (view === "week" && smallScreen.matches) return;
    if (state.view === view) return;
    state.view = view;
    if (!availableDate(state.dateKey, view)) {
      state.dateKey = view === "week" ? MIN_WEEK_DATE : MIN_DATE;
    }
    state.notice = "";
    void loadRecords();
  }

  /** @param {number} delta */
  function move(delta) {
    if (!canMove(delta)) return;
    state.dateKey = addDays(state.dateKey, delta);
    state.notice = "";
    void loadRecords();
  }

  async function submitEdit() {
    if (state.editBusy || state.confirmingDelete || state.editing === null) return;
    // An unchanged second preserves the original sub-second instant rather than truncating it.
    // Some browsers normalize datetime-local values by removing a trailing ":00".
    const enteredStartMs = parseTokyoDateTimeInput(ui.editStart.value);
    const enteredEndMs = parseTokyoDateTimeInput(ui.editEnd.value);
    const startMs =
      enteredStartMs === Math.floor(state.editing.startedAtMs / 1000) * 1000
        ? state.editing.startedAtMs
        : enteredStartMs;
    const endMs =
      enteredEndMs === Math.floor(state.editing.endedAtMs / 1000) * 1000
        ? state.editing.endedAtMs
        : enteredEndMs;
    const description = ui.editDescription.value.trim();
    if (
      startMs === null ||
      endMs === null ||
      startMs <= 0 ||
      endMs <= startMs ||
      endMs - startMs > MAX_RECORD_MS ||
      description.length < 1 ||
      description.length > 500
    ) {
      showEditError(
        "開始・終了日時と内容を確認してください。終了は開始より後、1件は366日以内です。",
        false,
      );
      return;
    }
    const record = state.editing;
    state.editBusy = true;
    ui.editSave.disabled = true;
    ui.editDelete.disabled = true;
    ui.editCancel.disabled = true;
    clearEditError();
    ui.editSave.disabled = true;
    ui.editDelete.disabled = true;
    try {
      await requestJson(`/api/v1/records/${encodeURIComponent(record.id)}`, "PATCH", {
        startedAtMs: startMs,
        endedAtMs: endMs,
        description,
        expectedVersion: record.version,
      });
      ui.dialog.close();
      state.editing = null;
      state.notice = "記録を更新しました。";
      await loadRecords();
    } catch (cause) {
      const mustReload = !(cause instanceof ApiError && cause.status === 400);
      showEditError(
        failureMessage(
          cause,
          "保存結果を確認できませんでした。再読み込みして記録を確認してください。",
        ),
        mustReload,
      );
    } finally {
      state.editBusy = false;
      ui.editCancel.disabled = false;
      if (ui.editReload.hidden) {
        ui.editSave.disabled = false;
        ui.editDelete.disabled = false;
      }
    }
  }

  function beginDelete() {
    if (state.editBusy || state.editing === null || !ui.editReload.hidden) return;
    state.confirmingDelete = true;
    ui.deleteConfirmation.hidden = false;
    ui.editSave.disabled = true;
    ui.editDelete.disabled = true;
    ui.deleteConfirm.focus();
  }

  function cancelDelete() {
    if (state.editBusy) return;
    state.confirmingDelete = false;
    ui.deleteConfirmation.hidden = true;
    ui.editSave.disabled = !ui.editReload.hidden;
    ui.editDelete.disabled = !ui.editReload.hidden;
    ui.editDelete.focus();
  }

  async function submitDelete() {
    if (state.editBusy || !state.confirmingDelete || state.editing === null) return;
    const record = state.editing;
    state.editBusy = true;
    ui.deleteConfirm.disabled = true;
    ui.deleteCancel.disabled = true;
    ui.editCancel.disabled = true;
    try {
      await requestJson(`/api/v1/records/${encodeURIComponent(record.id)}`, "DELETE", {
        expectedVersion: record.version,
      });
      ui.dialog.close();
      state.editing = null;
      state.notice = "記録を削除しました。";
      await loadRecords();
    } catch (cause) {
      showEditError(
        failureMessage(
          cause,
          "削除結果を確認できませんでした。記録を再読み込みして確認してください。",
        ),
        true,
      );
    } finally {
      state.editBusy = false;
      ui.deleteConfirm.disabled = false;
      ui.deleteCancel.disabled = false;
      ui.editCancel.disabled = false;
    }
  }

  async function submitCreate() {
    if (
      state.createBusy ||
      state.createRequestId === null ||
      (!ui.createReload.hidden && ui.createSave.disabled)
    ) {
      return;
    }
    let payload = state.createRetryPayload;
    if (payload === null) {
      const startedAtMs = parseTokyoDateTimeInput(ui.createStart.value);
      const endedAtMs = parseTokyoDateTimeInput(ui.createEnd.value);
      const description = ui.createDescription.value.trim();
      if (
        startedAtMs === null ||
        endedAtMs === null ||
        startedAtMs <= 0 ||
        !availableDate(ui.createStart.value.slice(0, 10), "day") ||
        endedAtMs <= startedAtMs ||
        endedAtMs - startedAtMs > MAX_RECORD_MS ||
        description.length < 1 ||
        description.length > 500
      ) {
        showCreateError(
          "開始日（1970年1月2日〜2100年12月31日）・終了日時と内容を確認してください。終了は開始より後、1件は366日以内です。",
          false,
        );
        return;
      }
      payload = { startedAtMs, endedAtMs, description, clientRequestId: state.createRequestId };
    }
    state.createBusy = true;
    state.createSubmittedStartMs = payload.startedAtMs;
    setCreateFieldsDisabled(true);
    ui.createSave.disabled = true;
    ui.createCancel.disabled = true;
    clearCreateError();
    ui.createSave.disabled = true;
    try {
      await requestJson("/api/v1/records", "POST", payload);
      ui.createDialog.close();
      state.createRequestId = null;
      state.createRetryPayload = null;
      const createdDateKey = tokyoDateKey(payload.startedAtMs);
      if (!availableDate(createdDateKey, state.view)) state.view = "day";
      state.dateKey = createdDateKey;
      state.notice = "記録を追加しました。";
      await loadRecords();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 400) {
        state.createRetryPayload = null;
        setCreateFieldsDisabled(false);
        showCreateError(failureMessage(cause, "日時や内容を確認してください。"), false);
      } else if (cause instanceof ApiError && [401, 403, 404, 409].includes(cause.status)) {
        state.createRetryPayload = null;
        showCreateError(
          cause.status === 409
            ? "同じ登録リクエストは既に使用されています。記録を再読み込みして確認してください。"
            : failureMessage(cause, "記録を保存できませんでした。再読み込みして確認してください。"),
          true,
        );
      } else {
        // A response may have been lost after D1 committed. Retry the same payload and key.
        state.createRetryPayload = payload;
        ui.createSave.textContent = "同じ内容で再試行";
        showCreateError(
          "保存結果を確認できませんでした。同じ内容で再試行するか、記録を再読み込みして確認してください。",
          false,
        );
        ui.createReload.hidden = false;
      }
    } finally {
      state.createBusy = false;
      ui.createCancel.disabled = false;
      if (ui.createReload.hidden) ui.createSave.disabled = false;
      if (state.createRetryPayload === null && ui.createReload.hidden) {
        setCreateFieldsDisabled(false);
      }
    }
  }

  ui.newRecord.addEventListener("click", openCreate);
  ui.dayView.addEventListener("click", () => setView("day"));
  ui.weekView.addEventListener("click", () => setView("week"));
  ui.previous.addEventListener("click", () => move(state.view === "week" ? -7 : -1));
  ui.next.addEventListener("click", () => move(state.view === "week" ? 7 : 1));
  ui.today.addEventListener("click", () => {
    state.dateKey = tokyoDateKey(Date.now());
    state.notice = "";
    void loadRecords();
  });
  ui.date.addEventListener("change", () => {
    if (!availableDate(ui.date.value, state.view)) {
      ui.date.value = state.dateKey;
      ui.date.setCustomValidity("選択できる日付を確認してください。");
      ui.date.reportValidity();
      ui.date.setCustomValidity("");
      return;
    }
    state.dateKey = ui.date.value;
    state.notice = "";
    void loadRecords();
  });
  ui.retry.addEventListener("click", () => void loadRecords());
  ui.editForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitEdit();
  });
  ui.editDelete.addEventListener("click", beginDelete);
  ui.deleteCancel.addEventListener("click", cancelDelete);
  ui.deleteConfirm.addEventListener("click", () => void submitDelete());
  ui.editCancel.addEventListener("click", () => ui.dialog.close());
  ui.editReload.addEventListener("click", () => {
    ui.dialog.close();
    state.editing = null;
    state.notice = "";
    void loadRecords();
  });
  ui.dialog.addEventListener("cancel", (event) => {
    if (state.editBusy) event.preventDefault();
  });
  ui.dialog.addEventListener("close", () => {
    state.editing = null;
    state.confirmingDelete = false;
    ui.deleteConfirmation.hidden = true;
    clearEditError();
  });
  ui.createForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitCreate();
  });
  function closeCreateAndReload() {
    const startedAtMs = state.createSubmittedStartMs;
    ui.createDialog.close();
    if (startedAtMs !== null) {
      const createdDateKey = tokyoDateKey(startedAtMs);
      if (availableDate(createdDateKey, "day")) {
        if (!availableDate(createdDateKey, state.view)) state.view = "day";
        state.dateKey = createdDateKey;
      }
    }
    state.notice = "";
    void loadRecords();
  }
  ui.createCancel.addEventListener("click", () => {
    if (state.createRetryPayload !== null || !ui.createReload.hidden) closeCreateAndReload();
    else ui.createDialog.close();
  });
  ui.createReload.addEventListener("click", closeCreateAndReload);
  ui.createDialog.addEventListener("cancel", (event) => {
    if (state.createBusy) {
      event.preventDefault();
    } else if (state.createRetryPayload !== null || !ui.createReload.hidden) {
      event.preventDefault();
      closeCreateAndReload();
    }
  });
  ui.createDialog.addEventListener("close", () => {
    state.createRequestId = null;
    state.createRetryPayload = null;
    state.createSubmittedStartMs = null;
    clearCreateError();
  });
  smallScreen.addEventListener("change", () => {
    if (smallScreen.matches && state.view === "week") setView("day");
  });

  render();
  void loadRecords();
}
