import type { TimeTag } from "../contracts/tags";
import {
  ApiError,
  type MeasurementMode,
  type MeasurementSession,
  readSessionEnvelope,
  requestJson,
  type SessionEnvelope,
} from "./api";
import { Store } from "./store";
import {
  durationForDisplay,
  estimateServerNowAtReceive,
  formatDuration,
  timerDuration,
} from "./time";

interface MeasurementState {
  readonly session: MeasurementSession | null;
  readonly loading: boolean;
  readonly busy: boolean;
  readonly uncertain: boolean;
  readonly focus: boolean;
  readonly error: string;
  readonly errorRequiresSync: boolean;
  readonly notice: string;
  readonly mode: MeasurementMode;
  readonly timer: readonly [string, string, string];
  readonly description: string;
  readonly tag: TimeTag | null;
  readonly time: string;
}
function failureMessage(cause: unknown, fallback: string) {
  if (cause instanceof ApiError) {
    if (cause.status === 401 || cause.status === 403)
      return "認証を確認できませんでした。ログイン状態を確認してから、状態を読み直してください。";
    if (cause.status === 409)
      return "別の画面で計測の状態が変わった可能性があります。状態を確認してください。";
    if (cause.status === 400) return "入力内容を確認してください。";
  }
  return fallback;
}
export class MeasurementStore extends Store<MeasurementState> {
  private serverAnchorMs = Date.now();
  private perfAnchorMs = performance.now();
  private deadlineSyncRequested = false;
  private pendingStart: {
    clientRequestId: string;
    mode: MeasurementMode;
    timerSeconds: number | null;
    description: string;
    tag: TimeTag | null;
  } | null = null;
  private pendingResolutionAction: "save" | "discard" | null = null;
  constructor() {
    super({
      session: null,
      loading: true,
      busy: false,
      uncertain: false,
      focus: false,
      error: "",
      errorRequiresSync: false,
      notice: "",
      mode: "stopwatch",
      timer: ["0", "25", "0"],
      description: "",
      tag: null,
      time: "00:00:00",
    });
  }
  setMode(mode: MeasurementMode) {
    this.patch({ mode, error: "" });
  }
  setTimer(index: 0 | 1 | 2, value: string) {
    const timer: [string, string, string] = [...this.state.timer];
    timer[index] = value;
    this.patch({ timer });
  }
  setDescription(description: string) {
    this.patch({ description, ...(!this.state.errorRequiresSync ? { error: "" } : {}) });
  }
  setTag(tag: TimeTag | null) {
    this.patch({ tag, ...(!this.state.errorRequiresSync ? { error: "" } : {}) });
  }
  setFocus(focus: boolean) {
    if (!focus || (this.state.session?.status === "running" && !this.state.busy))
      this.patch({ focus });
  }
  private accept(envelope: SessionEnvelope, started: number) {
    const previous = this.state.session;
    const received = performance.now();
    this.serverAnchorMs = estimateServerNowAtReceive(envelope.serverNowMs, started, received);
    this.perfAnchorMs = received;
    if (
      previous?.id !== envelope.session?.id ||
      previous?.status !== envelope.session?.status ||
      previous?.deadlineAtMs !== envelope.session?.deadlineAtMs
    )
      this.deadlineSyncRequested = false;
    if (envelope.session !== null) this.pendingStart = null;
    this.patch({
      session: envelope.session,
      focus: this.state.focus && envelope.session?.status === "running",
      ...(previous?.id !== envelope.session?.id
        ? {
            description: envelope.session?.draftDescription ?? "",
            tag: envelope.session?.tag ?? null,
          }
        : {}),
    });
    this.tick();
  }
  tick = () => {
    const session = this.state.session;
    if (!session) return;
    const now = this.serverAnchorMs + performance.now() - this.perfAnchorMs;
    const time = formatDuration(durationForDisplay(session, now));
    if (time !== this.state.time) this.patch({ time });
    if (
      session.status === "running" &&
      session.mode === "timer" &&
      session.deadlineAtMs !== null &&
      now >= session.deadlineAtMs &&
      !this.deadlineSyncRequested &&
      !this.state.busy
    ) {
      this.deadlineSyncRequested = true;
      void this.refresh();
    }
  };
  refresh = async () => {
    if (this.state.busy) return;
    this.patch({ busy: true });
    try {
      const started = performance.now();
      const envelope = readSessionEnvelope(await requestJson("/api/v1/session"));
      this.accept(envelope, started);
      if (envelope.session === null && this.pendingResolutionAction !== null) {
        this.patch({
          uncertain: false,
          errorRequiresSync: false,
          notice: "",
          error:
            this.pendingResolutionAction === "save"
              ? "未完了の計測はありません。直前の保存結果は確認できません。後でカレンダーに記録があるか確認してください。"
              : "未完了の計測はありません。直前の破棄結果は確認できません。後でカレンダーに記録がないか確認してください。",
        });
      } else {
        this.pendingResolutionAction = null;
        this.patch({ uncertain: false, error: "", errorRequiresSync: false });
      }
    } catch (cause) {
      this.patch({
        focus: false,
        uncertain: true,
        errorRequiresSync: true,
        notice: "",
        error: failureMessage(
          cause,
          "現在の状態を読み込めませんでした。通信を確認してから再試行してください。",
        ),
      });
    } finally {
      this.patch({ loading: false, busy: false });
      this.tick();
    }
  };
  private async mutate(path: string, body: object, notice: string) {
    if (this.state.busy || this.state.uncertain) return;
    this.patch({ busy: true, error: "", notice: "" });
    try {
      const started = performance.now();
      const envelope = readSessionEnvelope(await requestJson(path, "POST", body));
      this.accept(envelope, started);
      if (envelope.session?.status === "saved" || envelope.session?.status === "discarded")
        this.patch({ session: null, focus: false, description: "", tag: null });
      this.pendingResolutionAction = null;
      this.patch({ notice });
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 400) {
        this.patch({
          error: failureMessage(cause, "入力内容を確認してください。"),
          errorRequiresSync: false,
        });
      } else {
        if (path.endsWith("/save")) this.pendingResolutionAction = "save";
        else if (path.endsWith("/discard")) this.pendingResolutionAction = "discard";
        this.patch({
          uncertain: true,
          errorRequiresSync: true,
          error: failureMessage(
            cause,
            "更新結果を確認できませんでした。状態を確認してから操作を続けてください。",
          ),
        });
      }
    } finally {
      this.patch({ busy: false });
      this.tick();
    }
  }
  start = async () => {
    if (this.state.busy || this.state.uncertain) return;
    const { mode, tag } = this.state;
    const description = this.state.description.trim();
    if (description.length > 500) {
      this.patch({
        error: "内容は500文字以内で入力してください。",
        errorRequiresSync: false,
        notice: "",
      });
      return;
    }
    const timerSeconds = mode === "timer" ? timerDuration(this.state.timer) : null;
    if (mode === "timer" && timerSeconds === null) {
      this.patch({
        error: "タイマーは1秒から24時間の範囲で設定してください。",
        errorRequiresSync: false,
        notice: "",
      });
      return;
    }
    if (
      !this.pendingStart ||
      this.pendingStart.mode !== mode ||
      this.pendingStart.timerSeconds !== timerSeconds ||
      this.pendingStart.description !== description ||
      this.pendingStart.tag !== tag
    )
      this.pendingStart = {
        clientRequestId: crypto.randomUUID(),
        mode,
        timerSeconds,
        description,
        tag,
      };
    const body = {
      mode,
      ...(mode === "timer" ? { timerSeconds } : {}),
      ...(description ? { description } : {}),
      ...(tag ? { tag } : {}),
      clientRequestId: this.pendingStart.clientRequestId,
    };
    await this.mutate("/api/v1/session", body, "計測を始めました。");
  };
  stop = async () => {
    const id = this.state.session?.id;
    if (id)
      await this.mutate(
        `/api/v1/session/${encodeURIComponent(id)}/stop`,
        {},
        "計測を終了しました。必要なら内容を入力し、保存してください。",
      );
  };
  save = async () => {
    const id = this.state.session?.id;
    const description = this.state.description.trim();
    if (!id) return;
    if (description.length > 500) {
      this.patch({
        error: "内容は500文字以内で入力してください。",
        errorRequiresSync: false,
        notice: "",
      });
      return;
    }
    await this.mutate(
      `/api/v1/session/${encodeURIComponent(id)}/save`,
      {
        description,
        ...(this.state.tag !== null || this.state.session?.tag !== null
          ? { tag: this.state.tag }
          : {}),
      },
      "記録を保存しました。",
    );
  };
  discard = async () => {
    const id = this.state.session?.id;
    if (id)
      await this.mutate(
        `/api/v1/session/${encodeURIComponent(id)}/discard`,
        {},
        "未保存の計測を破棄しました。",
      );
  };
}
