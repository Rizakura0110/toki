import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarRecord, MeasurementSession } from "./api";
import { dayRange, formatTokyoDateTimeInput, tokyoDateKey } from "./calendar-core";
import { availableDate, CalendarStore } from "./calendar-store";
import { MeasurementStore } from "./measurement-store";

const NOW = Date.UTC(2026, 9, 17, 3);
const running: MeasurementSession = {
  id: "a/b",
  mode: "stopwatch",
  status: "running",
  startedAtMs: NOW - 1000,
  deadlineAtMs: null,
  endedAtMs: null,
  timerSeconds: null,
};
const stopped: MeasurementSession = { ...running, status: "awaiting_description", endedAtMs: NOW };
const record: CalendarRecord = {
  id: "r/1",
  mode: "stopwatch",
  status: "saved",
  startedAtMs: NOW + 123,
  endedAtMs: NOW + 10123,
  description: "記録",
  version: 2,
};
let fetchMock = vi.fn<typeof fetch>();
function envelope(session: MeasurementSession | null = null) {
  return Response.json({ session, serverNowMs: NOW });
}
function fail(status: number) {
  return Response.json({ error: { code: "FAIL" } }, { status });
}
function defer<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function body(index = fetchMock.mock.calls.length - 1) {
  return JSON.parse(String(fetchMock.mock.calls[index]?.[1]?.body));
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("measurement state independent of React lifecycles", () => {
  it("has side-effect-free construction, stable snapshots and removable subscribers", async () => {
    const store = new MeasurementStore(),
      changed = vi.fn();
    expect(fetchMock).not.toHaveBeenCalled();
    const initial = store.getSnapshot(),
      unsubscribe = store.subscribe(changed);
    expect(store.getSnapshot()).toBe(initial);
    store.setMode("timer");
    expect(initial.mode).toBe("stopwatch");
    expect(changed).toHaveBeenCalledOnce();
    unsubscribe();
    store.setTimer(0, "2");
    expect(changed).toHaveBeenCalledOnce();
    expect(store.getSnapshot().timer).toEqual(["2", "25", "0"]);
  });
  it("deduplicates initial reads and rapid starts, then stops, saves empty text and returns idle", async () => {
    const store = new MeasurementStore(),
      read = defer<Response>(),
      start = defer<Response>();
    fetchMock.mockReturnValueOnce(read.promise).mockReturnValueOnce(start.promise);
    const reading = store.refresh();
    void store.refresh();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    read.resolve(envelope());
    await reading;
    const starting = store.start();
    void store.start();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(body()).toMatchObject({ mode: "stopwatch", clientRequestId: expect.any(String) });
    start.resolve(envelope(running));
    await starting;
    store.setFocus(true);
    expect(store.getSnapshot().focus).toBe(true);
    fetchMock.mockResolvedValueOnce(envelope(stopped));
    await store.stop();
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe("/api/v1/session/a%2Fb/stop");
    expect(store.getSnapshot()).toMatchObject({ focus: false, time: "00:00:01" });
    store.setDescription("   ");
    fetchMock.mockResolvedValueOnce(envelope({ ...stopped, status: "saved" }));
    await store.save();
    expect(body()).toEqual({ description: "" });
    expect(store.getSnapshot()).toMatchObject({ session: null, notice: "記録を保存しました。" });
  });
  it("uses a monotonic server anchor, not later device-clock changes, with no polling", async () => {
    const store = new MeasurementStore();
    fetchMock.mockResolvedValueOnce(envelope(running));
    await store.refresh();
    vi.setSystemTime(NOW + 99999999);
    await vi.advanceTimersByTimeAsync(2000);
    store.tick();
    expect(store.getSnapshot().time).toBe("00:00:03");
    expect(fetchMock).toHaveBeenCalledOnce();
    store.setFocus(true);
    store.setFocus(false);
    expect(store.getSnapshot().focus).toBe(false);
  });
  it("resolves a timer deadline once and exits focus for description", async () => {
    const store = new MeasurementStore(),
      timer: MeasurementSession = {
        ...running,
        mode: "timer",
        timerSeconds: 1,
        startedAtMs: NOW,
        deadlineAtMs: NOW + 1000,
      };
    fetchMock
      .mockResolvedValueOnce(envelope(timer))
      .mockResolvedValueOnce(
        envelope({ ...timer, status: "awaiting_description", endedAtMs: NOW + 1000 }),
      );
    await store.refresh();
    store.setFocus(true);
    await vi.advanceTimersByTimeAsync(1001);
    store.tick();
    store.tick();
    await vi.waitFor(() => expect(store.getSnapshot().busy).toBe(false));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot()).toMatchObject({
      focus: false,
      session: { status: "awaiting_description" },
    });
    store.tick();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("does not repeatedly retry a failed automatic deadline read", async () => {
    const store = new MeasurementStore();
    fetchMock
      .mockResolvedValueOnce(
        envelope({ ...running, mode: "timer", deadlineAtMs: NOW + 1000, timerSeconds: 1 }),
      )
      .mockRejectedValueOnce(new Error("offline"));
    await store.refresh();
    await vi.advanceTimersByTimeAsync(1001);
    store.tick();
    await vi.waitFor(() => expect(store.getSnapshot().busy).toBe(false));
    store.tick();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().uncertain).toBe(true);
  });
  it("reuses an uncertain start key after reconciliation, but not for changed mode/duration", async () => {
    const store = new MeasurementStore();
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    await store.start();
    const original = body();
    expect(store.getSnapshot().uncertain).toBe(true);
    await store.start();
    expect(fetchMock).toHaveBeenCalledOnce();
    fetchMock.mockResolvedValueOnce(envelope()).mockResolvedValueOnce(envelope(running));
    await store.refresh();
    await store.start();
    expect(body()).toEqual(original);
    fetchMock.mockResolvedValueOnce(envelope());
    await store.refresh();
    store.setMode("timer");
    store.setTimer(1, "0");
    store.setTimer(2, "1");
    fetchMock.mockResolvedValueOnce(
      envelope({ ...running, mode: "timer", timerSeconds: 1, deadlineAtMs: NOW + 1000 }),
    );
    await store.start();
    expect(body()).toMatchObject({ mode: "timer", timerSeconds: 1 });
    expect(body().clientRequestId).not.toBe(original.clientRequestId);
  });
  it("validates timer and description locally, and permits corrected 400 input", async () => {
    const store = new MeasurementStore();
    store.setMode("timer");
    store.setTimer(1, "0");
    await store.start();
    expect(store.getSnapshot().error).toContain("1秒から24時間");
    expect(fetchMock).not.toHaveBeenCalled();
    store.setTimer(2, "1");
    fetchMock.mockResolvedValueOnce(fail(400));
    await store.start();
    expect(store.getSnapshot()).toMatchObject({ uncertain: false, errorRequiresSync: false });
    fetchMock.mockResolvedValueOnce(envelope(stopped));
    await store.refresh();
    store.setDescription("x".repeat(501));
    await store.save();
    expect(store.getSnapshot().error).toContain("500文字");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    store.setDescription(" 修正 ");
    expect(store.getSnapshot().error).toBe("");
    fetchMock.mockResolvedValueOnce(envelope({ ...stopped, status: "saved" }));
    await store.save();
    expect(body()).toEqual({ description: "修正" });
  });
  it.each([401, 403, 409, 500])(
    "requires explicit sync after a failed mutation (%i)",
    async (status) => {
      const store = new MeasurementStore();
      fetchMock.mockResolvedValueOnce(envelope(running)).mockResolvedValueOnce(fail(status));
      await store.refresh();
      store.setFocus(true);
      await store.stop();
      expect(store.getSnapshot()).toMatchObject({ uncertain: true, errorRequiresSync: true });
      store.setDescription("text");
      expect(store.getSnapshot().error).not.toBe("");
      fetchMock.mockResolvedValueOnce(envelope(stopped));
      await store.refresh();
      expect(store.getSnapshot()).toMatchObject({ uncertain: false, focus: false });
    },
  );
  it.each(["save", "discard"] as const)(
    "does not claim an unknown %s result was successful",
    async (action) => {
      const store = new MeasurementStore();
      fetchMock
        .mockResolvedValueOnce(envelope(stopped))
        .mockRejectedValueOnce(new Error("lost reply"))
        .mockResolvedValueOnce(envelope());
      await store.refresh();
      await store[action]();
      await store.refresh();
      expect(store.getSnapshot()).toMatchObject({ session: null, uncertain: false, notice: "" });
      expect(store.getSnapshot().error).toContain("結果は確認できません");
      await store.stop();
      await store.save();
      await store.discard();
      expect(fetchMock).toHaveBeenCalledTimes(3);
      store.setFocus(true);
      expect(store.getSnapshot().focus).toBe(false);
    },
  );
  it("retains input for the same unfinished session but resets it for a different session", async () => {
    const store = new MeasurementStore();
    fetchMock
      .mockResolvedValueOnce(envelope(stopped))
      .mockResolvedValueOnce(envelope(stopped))
      .mockResolvedValueOnce(envelope({ ...stopped, id: "different" }));
    await store.refresh();
    store.setDescription("draft");
    await store.refresh();
    expect(store.getSnapshot().description).toBe("draft");
    await store.refresh();
    expect(store.getSnapshot().description).toBe("");
    fetchMock.mockResolvedValueOnce(envelope({ ...stopped, id: "different", status: "discarded" }));
    await store.discard();
    expect(store.getSnapshot().session).toBeNull();
  });
});

describe("calendar state, concurrency and safe retries", () => {
  function calendar(small = false) {
    return new CalendarStore(() => small);
  }
  async function loaded() {
    const store = calendar();
    fetchMock.mockResolvedValueOnce(Response.json({ records: [record] }));
    await store.load();
    return store;
  }
  it("deduplicates initial reads, rejects stale responses and never mixes periods", async () => {
    const store = calendar(),
      a = defer<Response>(),
      b = defer<Response>();
    fetchMock.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const initial = store.load();
    expect(store.load()).toBe(initial);
    store.setDate("2026-10-18");
    b.resolve(Response.json({ records: [] }));
    await vi.waitFor(() => expect(store.getSnapshot().loading).toBe(false));
    a.resolve(Response.json({ records: [record] }));
    await initial;
    expect(store.getSnapshot().records).toEqual([]);
    expect(store.getSnapshot().dateKey).toBe("2026-10-18");
  });
  it("keeps supported dates and mobile day view, and navigates without invalid requests", async () => {
    fetchMock.mockImplementation(async () => Response.json({ records: [] }));
    const store = calendar(true);
    store.setView("week");
    expect(store.getSnapshot().view).toBe("day");
    expect(store.setDate("1970-01-01")).toBe(false);
    expect(store.setDate("2026-02-30")).toBe(false);
    store.setDate("1970-01-02");
    expect(store.canMove(-1)).toBe(false);
    store.move(-1);
    expect(store.getSnapshot().dateKey).toBe("1970-01-02");
    store.move(1);
    expect(store.getSnapshot().dateKey).toBe("1970-01-03");
    store.today();
    expect(store.getSnapshot().dateKey).toBe(tokyoDateKey(NOW));
    const desktop = calendar();
    desktop.setView("day");
    desktop.setDate("1970-01-02");
    desktop.setView("week");
    expect(desktop.getSnapshot().dateKey).toBe("1970-01-05");
    desktop.setDate("2100-12-31");
    expect(desktop.canMove(1)).toBe(false);
    expect(desktop.canMove(Number.NaN)).toBe(false);
    expect(availableDate("nonsense", "day")).toBe(false);
    expect(availableDate("2026-02-30", "week")).toBe(false);
    await vi.runAllTimersAsync();
  });
  it.each([400, 401, 403, 404, 409, 500])(
    "clears stale records and explains load failure (%i)",
    async (status) => {
      const store = await loaded();
      fetchMock.mockResolvedValueOnce(fail(status));
      await store.load();
      expect(store.getSnapshot()).toMatchObject({ records: [], loading: false });
      expect(store.getSnapshot().error).not.toBe("");
    },
  );
  it("preserves milliseconds on unchanged edit times and guards double submits/cancel", async () => {
    const store = await loaded(),
      pending = defer<Response>();
    store.openEdit("missing");
    expect(store.getSnapshot().editing).toBeNull();
    store.openEdit(record.id);
    store.setEdit("description", " changed ");
    fetchMock
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(Response.json({ records: [record] }));
    const saving = store.saveEdit();
    void store.saveEdit();
    store.closeEdit();
    store.beginDelete();
    expect(store.getSnapshot().editing).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(body()).toEqual({
      startedAtMs: record.startedAtMs,
      endedAtMs: record.endedAtMs,
      description: "changed",
      expectedVersion: 2,
    });
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe("/api/v1/records/r%2F1");
    pending.resolve(Response.json({ record }));
    await saving;
    expect(store.getSnapshot().editing).toBeNull();
  });
  it("accepts changed seconds, rejects invalid edit ranges/oversize text and allows cancel", async () => {
    const store = await loaded();
    await store.saveEdit();
    store.openEdit(record.id);
    for (const invalid of ["", "not-a-date", formatTokyoDateTimeInput(record.endedAtMs + 1000)]) {
      store.setEdit("start", invalid);
      await store.saveEdit();
      expect(store.getSnapshot().editError).not.toBe("");
    }
    store.setEdit("start", formatTokyoDateTimeInput(record.startedAtMs));
    store.setEdit("description", "x".repeat(501));
    await store.saveEdit();
    store.setEdit("description", "");
    store.setEdit("end", "2028-10-17T12:00:00");
    await store.saveEdit();
    expect(fetchMock).toHaveBeenCalledOnce();
    store.setEdit("end", "2026-10-17T12:00:12");
    fetchMock
      .mockResolvedValueOnce(Response.json({ record }))
      .mockResolvedValueOnce(Response.json({ records: [record] }));
    await store.saveEdit();
    expect(body(1).endedAtMs).toBe(NOW + 12000);
    expect(body(1).description).toBe("");
    store.openEdit(record.id);
    store.closeEdit();
    expect(store.getSnapshot().editing).toBeNull();
  });
  it.each([400, 401, 403, 404, 409, 500])(
    "prevents stale overwrite after edit failure (%i)",
    async (status) => {
      const store = await loaded();
      store.openEdit(record.id);
      fetchMock.mockResolvedValueOnce(fail(status));
      await store.saveEdit();
      expect(store.getSnapshot().editMustReload).toBe(status !== 400);
      if (status !== 400) {
        await store.saveEdit();
        expect(fetchMock).toHaveBeenCalledTimes(2);
      }
      fetchMock.mockResolvedValueOnce(Response.json({ records: [record] }));
      await store.reloadEdit();
      expect(store.getSnapshot().editing).toBeNull();
    },
  );
  it("requires delete confirmation and sends one versioned DELETE, even with rapid clicks", async () => {
    const store = await loaded(),
      pending = defer<Response>();
    await store.deleteRecord();
    store.openEdit(record.id);
    await store.deleteRecord();
    expect(fetchMock).toHaveBeenCalledOnce();
    store.beginDelete();
    store.cancelDelete();
    expect(store.getSnapshot().confirmingDelete).toBe(false);
    store.beginDelete();
    await store.saveEdit();
    expect(fetchMock).toHaveBeenCalledOnce();
    fetchMock
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(Response.json({ records: [] }));
    const deleting = store.deleteRecord();
    void store.deleteRecord();
    store.cancelDelete();
    expect(store.getSnapshot().confirmingDelete).toBe(true);
    expect(body()).toEqual({ expectedVersion: 2 });
    expect(fetchMock.mock.calls.at(-1)?.[1]?.method).toBe("DELETE");
    pending.resolve(Response.json({}));
    await deleting;
    expect(store.getSnapshot()).toMatchObject({
      editing: null,
      records: [],
      notice: "記録を削除しました。",
    });
  });
  it("never retries an uncertain deletion without reloading", async () => {
    const store = await loaded();
    store.openEdit(record.id);
    store.beginDelete();
    fetchMock.mockRejectedValueOnce(new Error("reply lost"));
    await store.deleteRecord();
    expect(store.getSnapshot()).toMatchObject({ editMustReload: true, confirmingDelete: false });
    store.beginDelete();
    await store.deleteRecord();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("creates future/overlapping empty records at whole minutes and uses one request key", async () => {
    const store = calendar();
    await store.saveCreate();
    fetchMock.mockImplementation(async (_path, options) =>
      options?.method === "POST" ? Response.json({}) : Response.json({ records: [] }),
    );
    store.openCreate();
    const initial = store.getSnapshot().create;
    store.openCreate();
    expect(store.getSnapshot().create).toBe(initial);
    store.setCreate("start", "2042-01-15T09:01:59");
    store.setCreate("end", "2042-01-15T10:01:59");
    store.setCreate("description", "  ");
    await store.saveCreate();
    expect(body(0)).toMatchObject({
      description: "",
      startedAtMs: dayRange("2042-01-15").startMs + (9 * 60 + 1) * 60000,
      clientRequestId: expect.any(String),
    });
    expect(store.getSnapshot()).toMatchObject({
      creating: false,
      dateKey: "2042-01-15",
      notice: "記録を追加しました。",
    });
    expect(body(0).endedAtMs % 60000).toBe(0);
  });
  it("locks the original payload on a lost create response and retries identically", async () => {
    const store = calendar(),
      pending = defer<Response>();
    store.openCreate();
    store.setCreate("description", "original");
    fetchMock.mockReturnValueOnce(pending.promise);
    const saving = store.saveCreate();
    void store.saveCreate();
    await store.closeCreate();
    store.setCreate("description", "during");
    expect(fetchMock).toHaveBeenCalledOnce();
    pending.resolve(fail(500));
    await saving;
    const original = body();
    store.setCreate("description", "after");
    expect(store.getSnapshot().create.description).toBe("original");
    fetchMock
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(Response.json({ records: [] }));
    await store.saveCreate();
    expect(body(1)).toEqual(original);
  });
  it("reconciles the submitted day when closing uncertain create without posting again", async () => {
    const store = calendar();
    store.openCreate();
    store.setCreate("start", "2042-01-15T09:00");
    store.setCreate("end", "2042-01-15T10:00");
    fetchMock
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(Response.json({ records: [] }));
    await store.saveCreate();
    await store.closeCreate();
    expect(store.getSnapshot()).toMatchObject({
      creating: false,
      dateKey: "2042-01-15",
      createRetryPayload: null,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("GET");
    await store.closeCreate();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it.each([400, 401, 403, 404, 409])(
    "handles manual creation API failure (%i) without blind retries",
    async (status) => {
      const store = calendar();
      store.openCreate();
      fetchMock.mockResolvedValueOnce(fail(status));
      await store.saveCreate();
      expect(store.getSnapshot().createMustReload).toBe(status !== 400);
      expect(store.getSnapshot().createRetryPayload).toBeNull();
      if (status !== 400) {
        store.setCreate("description", "locked");
        await store.saveCreate();
        expect(fetchMock).toHaveBeenCalledOnce();
      }
      fetchMock.mockResolvedValueOnce(Response.json({ records: [] }));
      await store.closeCreate(true);
      expect(store.getSnapshot().creating).toBe(false);
    },
  );
  it.each(["", "1969-12-31T09:00", "2101-01-01T09:00", "bad"])(
    "rejects invalid creation dates %s before sending",
    async (start) => {
      const store = calendar();
      store.openCreate();
      store.setCreate("start", start);
      await store.saveCreate();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(store.getSnapshot().createError).not.toBe("");
    },
  );
  it("rejects empty/long/reversed creation fields, and cancels an untouched form without reads", async () => {
    const store = calendar();
    store.openCreate();
    store.setCreate("end", "");
    await store.saveCreate();
    store.setCreate("end", "2026-10-16T08:00");
    await store.saveCreate();
    store.setCreate("end", "2028-10-17T10:00");
    await store.saveCreate();
    store.setCreate("end", "2026-10-17T10:00");
    store.setCreate("description", "x".repeat(501));
    await store.saveCreate();
    expect(fetchMock).not.toHaveBeenCalled();
    await store.closeCreate();
    expect(store.getSnapshot().creating).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
