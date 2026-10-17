import { ApiError, type CalendarRecord, readRecords, requestJson } from "./api";
import {
  addDays,
  dayRange,
  formatTokyoDateTimeInput,
  formatTokyoMinuteInput,
  parseTokyoDateTimeInput,
  parseTokyoMinuteInput,
  tokyoDateKey,
  weekRange,
} from "./calendar-core";
import { Store } from "./store";

export type CalendarView = "day" | "week";
export const MIN_DATE = "1970-01-02";
export const MIN_WEEK_DATE = "1970-01-05";
export const MAX_DATE = "2100-12-31";
const MAX_RECORD_MS = 366 * 86400000;
interface Fields {
  readonly start: string;
  readonly end: string;
  readonly description: string;
}
interface CreatePayload {
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly description: string;
  readonly clientRequestId: string;
}
interface CalendarState {
  readonly dateKey: string;
  readonly view: CalendarView;
  readonly records: readonly CalendarRecord[];
  readonly loading: boolean;
  readonly error: string;
  readonly notice: string;
  readonly editing: CalendarRecord | null;
  readonly edit: Fields;
  readonly editBusy: boolean;
  readonly editError: string;
  readonly editMustReload: boolean;
  readonly confirmingDelete: boolean;
  readonly creating: boolean;
  readonly create: Fields;
  readonly createBusy: boolean;
  readonly createError: string;
  readonly createMustReload: boolean;
  readonly createCanReload: boolean;
  readonly createRetryPayload: CreatePayload | null;
}
export function availableDate(dateKey: string, view: CalendarView): boolean {
  if (dateKey < (view === "week" ? MIN_WEEK_DATE : MIN_DATE) || dateKey > MAX_DATE) return false;
  try {
    const range = view === "week" ? weekRange(dateKey) : dayRange(dateKey);
    return Number.isSafeInteger(range.startMs) && range.startMs > 0;
  } catch {
    return false;
  }
}
function failureMessage(cause: unknown, fallback: string) {
  if (cause instanceof ApiError) {
    if (cause.status === 401 || cause.status === 403)
      return "認証を確認できませんでした。ログイン状態を確認してから再読み込みしてください。";
    if (cause.status === 400) return "日時や内容を確認してください。";
    if (cause.status === 404) return "記録が見つかりません。再読み込みして確認してください。";
    if (cause.status === 409)
      return "ほかの画面で記録が更新されました。上書きせず、記録を再読み込みしてください。";
  }
  return fallback;
}
const emptyFields = { start: "", end: "", description: "" };
export class CalendarStore extends Store<CalendarState> {
  private requestNumber = 0;
  private reading: { key: string; promise: Promise<void> } | null = null;
  private createRequestId: string | null = null;
  private createSubmittedStartMs: number | null = null;
  constructor(private readonly smallScreen: () => boolean) {
    super({
      dateKey: tokyoDateKey(Date.now()),
      view: smallScreen() ? "day" : "week",
      records: [],
      loading: true,
      error: "",
      notice: "",
      editing: null,
      edit: emptyFields,
      editBusy: false,
      editError: "",
      editMustReload: false,
      confirmingDelete: false,
      creating: false,
      create: emptyFields,
      createBusy: false,
      createError: "",
      createMustReload: false,
      createCanReload: false,
      createRetryPayload: null,
    });
  }
  load = (): Promise<void> => {
    const key = `${this.state.view}:${this.state.dateKey}`;
    if (this.reading?.key === key) return this.reading.promise;
    const number = ++this.requestNumber;
    const range =
      this.state.view === "week" ? weekRange(this.state.dateKey) : dayRange(this.state.dateKey);
    this.patch({ loading: true, error: "" });
    const promise = (async () => {
      try {
        const records = readRecords(
          await requestJson(`/api/v1/records?startMs=${range.startMs}&endMs=${range.endMs}`),
        );
        if (number === this.requestNumber) this.patch({ records, loading: false });
      } catch (cause) {
        if (number === this.requestNumber)
          this.patch({
            records: [],
            loading: false,
            error: failureMessage(
              cause,
              "記録を読み込めませんでした。通信を確認して再読み込みしてください。",
            ),
          });
      } finally {
        if (number === this.requestNumber) this.reading = null;
      }
    })();
    this.reading = { key, promise };
    return promise;
  };
  setView(view: CalendarView) {
    if ((view === "week" && this.smallScreen()) || view === this.state.view) return;
    this.patch({
      view,
      dateKey: availableDate(this.state.dateKey, view)
        ? this.state.dateKey
        : view === "week"
          ? MIN_WEEK_DATE
          : MIN_DATE,
      notice: "",
    });
    void this.load();
  }
  setDate(dateKey: string): boolean {
    if (!availableDate(dateKey, this.state.view)) return false;
    this.patch({ dateKey, notice: "" });
    void this.load();
    return true;
  }
  canMove(delta: number): boolean {
    try {
      return availableDate(addDays(this.state.dateKey, delta), this.state.view);
    } catch {
      return false;
    }
  }
  move(delta: number) {
    if (this.canMove(delta)) this.setDate(addDays(this.state.dateKey, delta));
  }
  today() {
    this.setDate(tokyoDateKey(Date.now()));
  }
  openEdit(id: string) {
    const record = this.state.records.find((record) => record.id === id);
    if (!record) return;
    this.patch({
      editing: record,
      edit: {
        start: formatTokyoDateTimeInput(record.startedAtMs),
        end: formatTokyoDateTimeInput(record.endedAtMs),
        description: record.description,
      },
      confirmingDelete: false,
      editError: "",
      editMustReload: false,
    });
  }
  setEdit(field: keyof Fields, value: string) {
    this.patch({ edit: { ...this.state.edit, [field]: value } });
  }
  closeEdit() {
    if (!this.state.editBusy)
      this.patch({ editing: null, confirmingDelete: false, editError: "", editMustReload: false });
  }
  private showEditError(error: string, mustReload: boolean) {
    this.patch({
      editError: error,
      editMustReload: mustReload,
      ...(mustReload ? { confirmingDelete: false } : {}),
    });
  }
  reloadEdit = async () => {
    this.closeEdit();
    this.patch({ notice: "" });
    await this.load();
  };
  saveEdit = async () => {
    const record = this.state.editing;
    if (!record || this.state.editBusy || this.state.confirmingDelete || this.state.editMustReload)
      return;
    const enteredStart = parseTokyoDateTimeInput(this.state.edit.start);
    const enteredEnd = parseTokyoDateTimeInput(this.state.edit.end);
    const start =
      enteredStart === Math.floor(record.startedAtMs / 1000) * 1000
        ? record.startedAtMs
        : enteredStart;
    const end =
      enteredEnd === Math.floor(record.endedAtMs / 1000) * 1000 ? record.endedAtMs : enteredEnd;
    const description = this.state.edit.description.trim();
    if (
      start === null ||
      end === null ||
      start <= 0 ||
      end <= start ||
      end - start > MAX_RECORD_MS ||
      description.length > 500
    ) {
      this.showEditError(
        "開始・終了日時と内容を確認してください。終了は開始より後、1件は366日以内です。",
        false,
      );
      return;
    }
    this.patch({ editBusy: true, editError: "", editMustReload: false });
    try {
      await requestJson(`/api/v1/records/${encodeURIComponent(record.id)}`, "PATCH", {
        startedAtMs: start,
        endedAtMs: end,
        description,
        expectedVersion: record.version,
      });
      this.patch({ editing: null, notice: "記録を更新しました。" });
      await this.load();
    } catch (cause) {
      this.showEditError(
        failureMessage(
          cause,
          "保存結果を確認できませんでした。再読み込みして記録を確認してください。",
        ),
        !(cause instanceof ApiError && cause.status === 400),
      );
    } finally {
      this.patch({ editBusy: false });
    }
  };
  beginDelete() {
    if (!this.state.editBusy && this.state.editing && !this.state.editMustReload)
      this.patch({ confirmingDelete: true });
  }
  cancelDelete() {
    if (!this.state.editBusy) this.patch({ confirmingDelete: false });
  }
  deleteRecord = async () => {
    const record = this.state.editing;
    if (!record || !this.state.confirmingDelete || this.state.editBusy || this.state.editMustReload)
      return;
    this.patch({ editBusy: true });
    try {
      await requestJson(`/api/v1/records/${encodeURIComponent(record.id)}`, "DELETE", {
        expectedVersion: record.version,
      });
      this.patch({ editing: null, confirmingDelete: false, notice: "記録を削除しました。" });
      await this.load();
    } catch (cause) {
      this.showEditError(
        failureMessage(
          cause,
          "削除結果を確認できませんでした。記録を再読み込みして確認してください。",
        ),
        true,
      );
    } finally {
      this.patch({ editBusy: false });
    }
  };
  openCreate() {
    if (this.state.creating || this.state.createBusy) return;
    const start = dayRange(this.state.dateKey).startMs + 9 * 3600000;
    this.createRequestId = crypto.randomUUID();
    this.createSubmittedStartMs = null;
    this.patch({
      creating: true,
      create: {
        start: formatTokyoMinuteInput(start),
        end: formatTokyoMinuteInput(start + 3600000),
        description: "",
      },
      createRetryPayload: null,
      createError: "",
      createMustReload: false,
      createCanReload: false,
    });
  }
  setCreate(field: keyof Fields, value: string) {
    if (!this.state.createBusy && !this.state.createRetryPayload && !this.state.createMustReload)
      this.patch({ create: { ...this.state.create, [field]: value } });
  }
  closeCreate = async (reload = false) => {
    if (this.state.createBusy || !this.state.creating) return;
    const date =
      this.createSubmittedStartMs === null ? null : tokyoDateKey(this.createSubmittedStartMs);
    const reconcile = reload || this.state.createCanReload;
    this.createRequestId = null;
    this.createSubmittedStartMs = null;
    this.patch({
      creating: false,
      createRetryPayload: null,
      createError: "",
      createMustReload: false,
      createCanReload: false,
    });
    if (reconcile) {
      if (date && availableDate(date, "day"))
        this.patch({
          dateKey: date,
          view: availableDate(date, this.state.view) ? this.state.view : "day",
        });
      this.patch({ notice: "" });
      await this.load();
    }
  };
  saveCreate = async () => {
    if (this.state.createBusy || !this.createRequestId || this.state.createMustReload) return;
    let payload = this.state.createRetryPayload;
    if (!payload) {
      const start = parseTokyoMinuteInput(this.state.create.start),
        end = parseTokyoMinuteInput(this.state.create.end),
        description = this.state.create.description.trim();
      if (
        start === null ||
        end === null ||
        start <= 0 ||
        !availableDate(this.state.create.start.slice(0, 10), "day") ||
        end <= start ||
        end - start > MAX_RECORD_MS ||
        description.length > 500
      ) {
        this.patch({
          createError:
            "開始日（1970年1月2日〜2100年12月31日）・終了日時と内容を確認してください。終了は開始より後、1件は366日以内です。",
          createMustReload: false,
          createCanReload: false,
        });
        return;
      }
      payload = {
        startedAtMs: start,
        endedAtMs: end,
        description,
        clientRequestId: this.createRequestId,
      };
    }
    this.createSubmittedStartMs = payload.startedAtMs;
    this.patch({
      createBusy: true,
      createError: "",
      createMustReload: false,
      createCanReload: false,
    });
    try {
      await requestJson("/api/v1/records", "POST", payload);
      this.createRequestId = null;
      this.createSubmittedStartMs = null;
      const dateKey = tokyoDateKey(payload.startedAtMs);
      this.patch({
        creating: false,
        createRetryPayload: null,
        dateKey,
        view: availableDate(dateKey, this.state.view) ? this.state.view : "day",
        notice: "記録を追加しました。",
      });
      await this.load();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 400)
        this.patch({
          createRetryPayload: null,
          createError: failureMessage(cause, "日時や内容を確認してください。"),
        });
      else if (cause instanceof ApiError && [401, 403, 404, 409].includes(cause.status))
        this.patch({
          createRetryPayload: null,
          createMustReload: true,
          createCanReload: true,
          createError:
            cause.status === 409
              ? "同じ登録リクエストは既に使用されています。記録を再読み込みして確認してください。"
              : failureMessage(
                  cause,
                  "記録を保存できませんでした。再読み込みして確認してください。",
                ),
        });
      else
        this.patch({
          createRetryPayload: payload,
          createCanReload: true,
          createError:
            "保存結果を確認できませんでした。同じ内容で再試行するか、記録を再読み込みして確認してください。",
        });
    } finally {
      this.patch({ createBusy: false });
    }
  };
}
