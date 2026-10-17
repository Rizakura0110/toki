import { useEffect, useRef, useSyncExternalStore } from "react";
import {
  addDays,
  dayRange,
  formatTokyoDateTimeInput,
  tokyoDateKey,
  weekStart,
} from "./calendar-core";
import type { CalendarStore } from "./calendar-store";
import { MAX_DATE, MIN_DATE, MIN_WEEK_DATE } from "./calendar-store";
import { Header, Modal } from "./shared";
import { recordLabel, Timeline } from "./timeline";

function periodLabel(date: string) {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(dayRange(date).startMs);
}
export function CalendarScreen({ store }: { store: CalendarStore }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const confirmRef = useRef<HTMLButtonElement>(null),
    deleteRef = useRef<HTMLButtonElement>(null);
  const previousDelete = useRef(false);
  useEffect(() => {
    document.title = "記録カレンダー — Toki";
    const media = window.matchMedia("(max-width: 700px)");
    const changed = () => {
      if (media.matches) store.setView("day");
    };
    changed();
    media.addEventListener("change", changed);
    void store.load();
    return () => media.removeEventListener("change", changed);
  }, [store]);
  useEffect(() => {
    if (state.confirmingDelete) confirmRef.current?.focus();
    else if (previousDelete.current && !state.editMustReload && state.editing)
      deleteRef.current?.focus();
    previousDelete.current = state.confirmingDelete;
  }, [state.confirmingDelete, state.editMustReload, state.editing]);
  const delta = state.view === "week" ? 7 : 1;
  const today = tokyoDateKey(Date.now());
  const first = weekStart(state.dateKey);
  const period =
    state.view === "week"
      ? `${periodLabel(first)} 〜 ${periodLabel(addDays(first, 6))}`
      : periodLabel(state.dateKey);
  const ordered = state.records
    .slice()
    .sort((left, right) => left.startedAtMs - right.startedAtMs || left.id.localeCompare(right.id));
  const editLocked = state.editBusy || state.editMustReload || state.confirmingDelete;
  const createLocked =
    state.createBusy || state.createMustReload || state.createRetryPayload !== null;
  return (
    <>
      <Header calendar />

      <main className="shell calendar-shell">
        <div className="calendar-intro">
          <div>
            <p className="eyebrow">THE SHAPE OF YOUR DAY</p>
            <h1>時間の記録</h1>
            <p>測った時間も、後から入力した時間も、日付とともに振り返る。</p>
          </div>
          <div className="calendar-intro-mark" aria-hidden="true">
            T.
          </div>
        </div>

        <div
          id="calendar-notice"
          className="message message-success"
          role="status"
          hidden={!state.notice}
        >
          {state.notice}
        </div>
        <div
          id="calendar-error"
          className="message message-error"
          role="alert"
          hidden={!state.error}
        >
          <p id="calendar-error-text">{state.error}</p>
          <button
            id="calendar-retry"
            className="text-button"
            type="button"
            onClick={() => void store.load()}
          >
            再読み込み
          </button>
        </div>

        <section className="calendar-panel" aria-label="カレンダーの操作">
          <div className="calendar-period">
            <p className="calendar-period-kicker">CALENDAR</p>
            <h2 id="period-label" aria-live="polite">
              {period}
            </h2>
            <p id="record-count" className="calendar-count">
              {state.loading ? "記録を確認しています…" : `${state.records.length}件の記録`}
            </p>
          </div>
          <div className="calendar-controls">
            <button
              id="new-record"
              className="button button-primary new-record-button"
              type="button"
              onClick={() => store.openCreate()}
            >
              ＋ 記録を追加
            </button>
            <fieldset className="view-switch">
              <legend className="sr-only">表示単位</legend>
              <button
                id="day-view"
                type="button"
                aria-pressed={state.view === "day"}
                onClick={() => store.setView("day")}
              >
                日
              </button>
              <button
                id="week-view"
                type="button"
                aria-pressed={state.view === "week"}
                onClick={() => store.setView("week")}
              >
                週
              </button>
            </fieldset>
            <fieldset className="date-nav">
              <legend className="sr-only">日付の移動</legend>
              <button
                id="previous-period"
                className="nav-button"
                type="button"
                aria-label="前の期間"
                disabled={!store.canMove(delta * -1)}
                onClick={() => store.move(delta * -1)}
              >
                ‹
              </button>
              <button
                id="today-period"
                className="today-button"
                type="button"
                disabled={state.dateKey === today}
                onClick={() => store.today()}
              >
                今日
              </button>
              <button
                id="next-period"
                className="nav-button"
                type="button"
                aria-label="次の期間"
                disabled={!store.canMove(delta)}
                onClick={() => store.move(delta)}
              >
                ›
              </button>
            </fieldset>
            <label className="calendar-date-field" htmlFor="calendar-date">
              <span className="sr-only">表示する日付</span>
              <input
                id="calendar-date"
                type="date"
                min={state.view === "week" ? MIN_WEEK_DATE : MIN_DATE}
                max={MAX_DATE}
                value={state.dateKey}
                onChange={(event) => {
                  const input = event.currentTarget;
                  if (!store.setDate(input.value)) {
                    input.value = state.dateKey;
                    input.setCustomValidity("選択できる日付を確認してください。");
                    input.reportValidity();
                    input.setCustomValidity("");
                  }
                }}
              />
            </label>
          </div>
        </section>

        <section className="calendar-card" aria-labelledby="timeline-title">
          <div className="calendar-section-heading">
            <div>
              <p className="card-kicker">TIMELINE</p>
              <h2 id="timeline-title">タイムライン</h2>
            </div>
            <p>表示・編集は日本時間</p>
          </div>
          <p className="timeline-note">
            短い記録も内容が読める高さで表示します。正確な時間は記録を開いて確認できます。
          </p>
          <div
            id="calendar-loading"
            className="calendar-state"
            role="status"
            hidden={!state.loading}
          >
            <span className="loading-dot" aria-hidden="true"></span>
            記録を読み込んでいます…
          </div>
          <p
            id="calendar-empty"
            className="calendar-empty"
            hidden={state.loading || !!state.error || state.records.length > 0}
          >
            この期間の記録はまだありません。計測を保存するか、記録を追加するとここに表示されます。
          </p>
          <section
            id="timeline-scroller"
            className="timeline-scroller"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users must be able to pan this named scroll region.
            tabIndex={0}
            aria-label="週・日のタイムライン"
            hidden={state.loading || !!state.error || state.records.length === 0}
          >
            {!state.loading && !state.error && state.records.length > 0 && (
              <Timeline
                records={state.records}
                dateKey={state.dateKey}
                view={state.view}
                edit={(id) => store.openEdit(id)}
              />
            )}
          </section>
        </section>

        <section className="calendar-card record-section" aria-labelledby="records-title">
          <div className="calendar-section-heading">
            <div>
              <p className="card-kicker">RECORDED MOMENTS</p>
              <h2 id="records-title">記録一覧</h2>
            </div>
            <p>記録を選ぶと編集できます</p>
          </div>
          <ul id="records-list" className="records-list">
            {!state.loading &&
              !state.error &&
              ordered.map((record) => (
                <li key={record.id}>
                  <button
                    type="button"
                    className="record-button"
                    aria-label={recordLabel(record)}
                    onClick={() => store.openEdit(record.id)}
                  >
                    <span className="record-main">
                      <span className="record-accent" aria-hidden="true" />
                      <span className="record-description">{record.description}</span>
                    </span>
                    <span className="record-time">
                      {`${formatTokyoDateTimeInput(record.startedAtMs).replace("T", " ")} – ${formatTokyoDateTimeInput(record.endedAtMs).replace("T", " ")}`}
                    </span>
                  </button>
                </li>
              ))}
          </ul>
        </section>
      </main>

      <Modal id="edit" open={state.editing !== null} cancel={() => store.closeEdit()}>
        <form
          id="edit-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void store.saveEdit();
          }}
        >
          <div className="edit-header">
            <p className="card-kicker">EDIT A RECORD</p>
            <h2 id="edit-title">記録を編集</h2>
            <p>日時と内容を修正できます。ほかの記録と時間が重なっても保存できます。</p>
          </div>
          <div className="edit-fields">
            <label htmlFor="edit-start">
              開始日時 <span>日本時間</span>
            </label>
            <input
              id="edit-start"
              type="datetime-local"
              step="1"
              required
              value={state.edit.start}
              onChange={(event) => store.setEdit("start", event.target.value)}
            />
            <label htmlFor="edit-end">
              終了日時 <span>日本時間</span>
            </label>
            <input
              id="edit-end"
              type="datetime-local"
              step="1"
              required
              value={state.edit.end}
              onChange={(event) => store.setEdit("end", event.target.value)}
            />
            <label htmlFor="edit-description">この時間にしたこと（任意）</label>
            <textarea
              id="edit-description"
              rows={4}
              maxLength={500}
              value={state.edit.description}
              onChange={(event) => store.setEdit("description", event.target.value)}
            ></textarea>
            <p className="edit-help">
              内容は500文字以内、空欄は「無題」で保存します。1件の時間は最大366日です。
            </p>
          </div>
          <div id="edit-error" className="edit-error" role="alert" hidden={!state.editError}>
            <p id="edit-error-text">{state.editError}</p>
            <button
              id="edit-reload"
              className="text-button"
              type="button"
              hidden={!state.editMustReload}
              onClick={() => void store.reloadEdit()}
            >
              記録を再読み込み
            </button>
          </div>
          <div
            id="delete-confirmation"
            className="delete-confirmation"
            hidden={!state.confirmingDelete}
          >
            <p>この記録を削除しますか？ 削除すると元に戻せません。</p>
            <div className="delete-confirmation-actions">
              <button
                id="delete-cancel"
                className="button button-quiet"
                type="button"
                disabled={state.editBusy}
                onClick={() => store.cancelDelete()}
              >
                削除をやめる
              </button>
              <button
                id="delete-confirm"
                className="button button-danger"
                type="button"
                ref={confirmRef}
                disabled={state.editBusy}
                onClick={() => void store.deleteRecord()}
              >
                削除する
              </button>
            </div>
          </div>
          <div className="edit-actions">
            <button
              id="edit-delete"
              className="button button-danger-outline"
              type="button"
              ref={deleteRef}
              disabled={editLocked}
              onClick={() => store.beginDelete()}
            >
              記録を削除
            </button>
            <button
              id="edit-cancel"
              className="button button-quiet"
              type="button"
              disabled={state.editBusy}
              onClick={() => store.closeEdit()}
            >
              キャンセル
            </button>
            <button
              id="edit-save"
              className="button button-primary"
              type="submit"
              disabled={editLocked}
            >
              変更を保存
            </button>
          </div>
        </form>
      </Modal>

      <Modal id="create" open={state.creating} cancel={() => void store.closeCreate()}>
        <form
          id="create-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void store.saveCreate();
          }}
        >
          <div className="edit-header">
            <p className="card-kicker">ADD A RECORD</p>
            <h2 id="create-title">記録を追加</h2>
            <p>計測せずに、時間と内容を記録できます。ほかの記録と時間が重なっても保存できます。</p>
          </div>
          <div className="edit-fields">
            <label htmlFor="create-start">
              開始日時 <span>日本時間</span>
            </label>
            <input
              id="create-start"
              type="datetime-local"
              step="60"
              required
              value={state.create.start}
              onChange={(event) => store.setCreate("start", event.target.value)}
              disabled={createLocked}
            />
            <label htmlFor="create-end">
              終了日時 <span>日本時間</span>
            </label>
            <input
              id="create-end"
              type="datetime-local"
              step="60"
              required
              value={state.create.end}
              onChange={(event) => store.setCreate("end", event.target.value)}
              disabled={createLocked}
            />
            <label htmlFor="create-description">この時間にしたこと（任意）</label>
            <textarea
              id="create-description"
              rows={4}
              maxLength={500}
              value={state.create.description}
              onChange={(event) => store.setCreate("description", event.target.value)}
              disabled={createLocked}
            ></textarea>
            <p className="edit-help">
              日時は分単位（秒は00）です。内容は500文字以内、空欄は「無題」で保存します。1件の時間は最大366日です。
            </p>
          </div>
          <div id="create-error" className="edit-error" role="alert" hidden={!state.createError}>
            <p id="create-error-text">{state.createError}</p>
            <button
              id="create-reload"
              className="text-button"
              type="button"
              hidden={!state.createCanReload}
              onClick={() => void store.closeCreate(true)}
            >
              記録を再読み込み
            </button>
          </div>
          <div className="edit-actions">
            <button
              id="create-cancel"
              className="button button-quiet"
              type="button"
              disabled={state.createBusy}
              onClick={() => void store.closeCreate()}
            >
              キャンセル
            </button>
            <button
              id="create-save"
              className="button button-primary"
              type="submit"
              disabled={state.createBusy || state.createMustReload}
            >
              {state.createRetryPayload ? "同じ内容で再試行" : "記録を保存"}
            </button>
          </div>
        </form>
      </Modal>
    </>
  );
}
