import { useEffect, useRef, useSyncExternalStore } from "react";
import type { MeasurementStore } from "./measurement-store";
import { Header } from "./shared";

export function MeasurementScreen({ store }: { store: MeasurementStore }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const startRef = useRef<HTMLButtonElement>(null),
    retryRef = useRef<HTMLButtonElement>(null),
    enterRef = useRef<HTMLButtonElement>(null),
    exitRef = useRef<HTMLButtonElement>(null),
    descriptionRef = useRef<HTMLTextAreaElement>(null);
  const previousFocus = useRef(false);
  useEffect(() => {
    const visibility = () => {
      if (document.visibilityState === "visible") void store.refresh();
    };
    const pageshow = (event: PageTransitionEvent) => {
      if (event.persisted) void store.refresh();
    };
    const online = () => {
      if (store.getSnapshot().uncertain) void store.refresh();
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") store.setFocus(false);
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pageshow", pageshow);
    window.addEventListener("online", online);
    document.addEventListener("keydown", onEscape);
    const interval = window.setInterval(store.tick, 250);
    void store.refresh();
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pageshow", pageshow);
      window.removeEventListener("online", online);
      document.removeEventListener("keydown", onEscape);
    };
  }, [store]);
  useEffect(() => {
    document.title =
      state.session?.status === "running"
        ? "計測中 — Toki"
        : state.session?.status === "awaiting_description"
          ? "内容を入力 — Toki"
          : "Toki — 時間を記録する";
  }, [state.session?.status]);
  useEffect(() => {
    if (state.focus && !previousFocus.current) exitRef.current?.focus();
    if (!state.focus && previousFocus.current && state.busy) return;
    if (!state.focus && previousFocus.current) {
      const target = state.errorRequiresSync
        ? retryRef
        : state.session?.status === "awaiting_description"
          ? descriptionRef
          : state.session?.status === "running"
            ? enterRef
            : startRef;
      target.current?.focus();
    }
    previousFocus.current = state.focus;
  }, [state.focus, state.busy, state.session?.status, state.errorRequiresSync]);
  const locked = state.busy || state.uncertain;
  const lengthClass =
    state.time.length > 12 ? "time-long time-very-long" : state.time.length > 9 ? "time-long" : "";
  const detail = state.session
    ? `${new Intl.DateTimeFormat("ja-JP", {
        timeZone: "Asia/Tokyo",
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(state.session.startedAtMs)} に開始 · 日本時間`
    : "";
  return (
    <>
      <div id="normal-view" hidden={state.focus}>
        <Header calendar={false} />

        <main className="shell">
          <div className="intro">
            <p className="eyebrow">YOUR TIME, YOUR STORY</p>
            <h1>今日の時間を記録する</h1>
            <p>まずは測る。終わったら、その時間にしたことを残しましょう。</p>
          </div>

          <div id="notice" className="message message-success" role="status" hidden={!state.notice}>
            {state.notice}
          </div>
          <div id="sync-error" className="message message-error" role="alert" hidden={!state.error}>
            <p id="sync-error-text">{state.error}</p>
            <button
              id="retry-sync"
              className="text-button"
              type="button"
              ref={retryRef}
              hidden={!state.errorRequiresSync}
              disabled={state.busy}
              onClick={() => void store.refresh()}
            >
              状態を確認
            </button>
          </div>

          <div className="content-grid">
            <div className="primary-column">
              <section
                id="loading-panel"
                className="card state-card"
                aria-label="状態を読み込み中"
                hidden={!state.loading}
              >
                <span className="loading-dot" aria-hidden="true"></span>
                <p>計測の状態を確認しています…</p>
              </section>

              <section
                id="idle-panel"
                className="card state-card"
                aria-labelledby="idle-title"
                hidden={state.loading || state.session !== null || state.uncertain}
              >
                <div className="card-heading">
                  <span className="step-number" aria-hidden="true">
                    01
                  </span>
                  <div>
                    <p className="card-kicker">START A SESSION</p>
                    <h2 id="idle-title">計測を始める</h2>
                  </div>
                </div>

                <form
                  id="start-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void store.start();
                  }}
                >
                  <fieldset className="mode-fieldset">
                    <legend>計測方法</legend>
                    <div className="mode-options">
                      <label className="mode-option">
                        <input
                          type="radio"
                          name="mode"
                          value="stopwatch"
                          checked={state.mode === "stopwatch"}
                          onChange={() => store.setMode("stopwatch")}
                        />
                        <span>
                          <strong>ストップウォッチ</strong>
                          <small>経過した時間を測る</small>
                        </span>
                      </label>
                      <label className="mode-option">
                        <input
                          type="radio"
                          name="mode"
                          value="timer"
                          checked={state.mode === "timer"}
                          onChange={() => store.setMode("timer")}
                        />
                        <span>
                          <strong>タイマー</strong>
                          <small>決めた時間を測る</small>
                        </span>
                      </label>
                    </div>
                  </fieldset>

                  <fieldset
                    id="timer-inputs"
                    className="duration-fieldset"
                    hidden={state.mode !== "timer"}
                  >
                    <legend>設定時間</legend>
                    <div className="duration-inputs">
                      <label>
                        <span>時間</span>
                        <input
                          id="timer-hours"
                          type="number"
                          inputMode="numeric"
                          min="0"
                          max="24"
                          step="1"
                          value={state.timer[0]}
                          onChange={(event) => store.setTimer(0, event.target.value)}
                        />
                      </label>
                      <label>
                        <span>分</span>
                        <input
                          id="timer-minutes"
                          type="number"
                          inputMode="numeric"
                          min="0"
                          max="59"
                          step="1"
                          value={state.timer[1]}
                          onChange={(event) => store.setTimer(1, event.target.value)}
                        />
                      </label>
                      <label>
                        <span>秒</span>
                        <input
                          id="timer-seconds"
                          type="number"
                          inputMode="numeric"
                          min="0"
                          max="59"
                          step="1"
                          value={state.timer[2]}
                          onChange={(event) => store.setTimer(2, event.target.value)}
                        />
                      </label>
                    </div>
                    <p className="field-help">1秒から24時間まで設定できます。</p>
                  </fieldset>

                  <button
                    id="start-button"
                    className="button button-primary button-wide"
                    type="submit"
                    ref={startRef}
                    disabled={locked}
                  >
                    計測を始める <span aria-hidden="true">→</span>
                  </button>
                </form>
              </section>

              <section
                id="running-panel"
                className="card state-card running-card"
                aria-labelledby="running-title"
                hidden={state.session?.status !== "running" || state.loading}
              >
                <div className="card-heading">
                  <span className="step-number step-number-active" aria-hidden="true">
                    02
                  </span>
                  <div>
                    <p className="card-kicker">IN PROGRESS</p>
                    <h2 id="running-title">計測中</h2>
                  </div>
                  <span className="live-badge">
                    <span className="live-dot" aria-hidden="true"></span>計測中
                  </span>
                </div>

                <div className="time-stage">
                  <p id="running-time-label" className="time-label">
                    {state.session?.mode === "timer" ? "残り時間" : "経過時間"}
                  </p>
                  <output
                    id="running-time"
                    className={`time-value ${lengthClass}`}
                    role="timer"
                    aria-live="off"
                  >
                    {state.time}
                  </output>
                  <p id="running-detail" className="time-detail">
                    {detail}
                  </p>
                </div>

                <div className="running-actions">
                  <button
                    id="enter-focus"
                    className="button button-outline"
                    type="button"
                    ref={enterRef}
                    disabled={state.busy}
                    onClick={() => store.setFocus(true)}
                  >
                    時間だけ表示
                  </button>
                  <button
                    id="stop-button"
                    className="button button-primary"
                    type="button"
                    disabled={locked}
                    onClick={() => void store.stop()}
                  >
                    計測を終了
                  </button>
                </div>
                <p className="quiet-note">
                  この画面を閉じても計測は続きます。一時停止はできません。
                </p>
              </section>

              <section
                id="description-panel"
                className="card state-card"
                aria-labelledby="description-title"
                hidden={state.session?.status !== "awaiting_description" || state.loading}
              >
                <div className="card-heading">
                  <span className="step-number step-number-active" aria-hidden="true">
                    03
                  </span>
                  <div>
                    <p className="card-kicker">FINISH THE STORY</p>
                    <h2 id="description-title">何をしていましたか？</h2>
                  </div>
                </div>

                <div className="finished-summary">
                  <span>計測した時間</span>
                  <strong id="finished-time">{state.time}</strong>
                </div>

                <form
                  id="save-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void store.save();
                  }}
                >
                  <label className="description-label" htmlFor="description">
                    この時間にしたこと（任意）
                  </label>
                  <textarea
                    id="description"
                    rows={4}
                    maxLength={500}
                    placeholder="例：本を読む、企画を考える、散歩をする"
                    ref={descriptionRef}
                    value={state.description}
                    disabled={locked}
                    onChange={(event) => store.setDescription(event.target.value)}
                  ></textarea>
                  <div className="description-meta">
                    <p>空欄のまま保存すると「無題」で記録されます。</p>
                    <output id="description-count" htmlFor="description">
                      {state.description.length} / 500
                    </output>
                  </div>
                  <div className="save-actions">
                    <button
                      id="save-button"
                      className="button button-primary"
                      type="submit"
                      disabled={locked}
                    >
                      記録を保存
                    </button>
                    <button
                      id="discard-button"
                      className="button button-quiet"
                      type="button"
                      disabled={locked}
                      onClick={() => {
                        if (window.confirm("この計測を保存せずに破棄しますか？"))
                          void store.discard();
                      }}
                    >
                      保存せず破棄
                    </button>
                  </div>
                </form>
              </section>
            </div>

            <aside className="guide-card" aria-labelledby="guide-title">
              <p className="guide-eyebrow">HOW IT WORKS</p>
              <h2 id="guide-title">
                時間の輪郭を、
                <br />
                少しずつ。
              </h2>
              <ol className="guide-steps">
                <li>
                  <span aria-hidden="true">1</span>
                  <div>
                    <strong>測る</strong>
                    <p>時間を決めても、決めなくても。</p>
                  </div>
                </li>
                <li>
                  <span aria-hidden="true">2</span>
                  <div>
                    <strong>残す</strong>
                    <p>終わったら、その時間の内容をひと言。</p>
                  </div>
                </li>
                <li>
                  <span aria-hidden="true">3</span>
                  <div>
                    <strong>振り返る</strong>
                    <p>保存した記録をカレンダーで見返せます。</p>
                  </div>
                </li>
              </ol>
              <p className="guide-note">
                計測中の時刻はサーバーに保存されます。表示は端末内で更新するため、毎秒の通信はありません。
              </p>
            </aside>
          </div>
        </main>
      </div>

      <div id="focus-view" hidden={!state.focus}>
        <button
          id="exit-focus"
          className="focus-exit"
          type="button"
          ref={exitRef}
          onClick={() => store.setFocus(false)}
        >
          <output
            id="focus-time"
            className={`focus-time ${lengthClass}`}
            role="timer"
            aria-live="off"
          >
            {state.time}
          </output>
          <span className="sr-only">時間を押すか、Escapeキーで通常画面に戻ります。</span>
        </button>
      </div>
    </>
  );
}
