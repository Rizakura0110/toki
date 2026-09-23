/// <reference types="node" />
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  createManualRecord,
  deleteSavedRecord,
  discardSession,
  editSavedRecord,
  getCurrentSession,
  getSession,
  listSavedRecords,
  MAX_RECORD_MS,
  saveSession,
  startSession,
  stopSession,
  TokiDataError,
} from "./records";

const START = Date.UTC(2026, 8, 23, 23, 59, 0);
const initialMigration = readFileSync(
  new URL("../../migrations/0001_initial.sql", import.meta.url),
  "utf8",
);
const manualRecordMigration = readFileSync(
  new URL("../../migrations/0002_manual_records.sql", import.meta.url),
  "utf8",
);
const openConnections: DatabaseSync[] = [];

function localDb(
  sqlite = new DatabaseSync(":memory:"),
  onPrepare?: (sql: string) => void,
  includeTriggerChanges = false,
): D1Database {
  sqlite.exec(initialMigration);
  sqlite.exec(manualRecordMigration);
  openConnections.push(sqlite);
  return {
    prepare(sql: string) {
      onPrepare?.(sql);
      const prepared = sqlite.prepare(sql);
      let parameters: (string | number | null)[] = [];
      return {
        bind(...values: (string | number | null)[]) {
          parameters = values;
          return this;
        },
        async first<Row>() {
          return (prepared.get(...parameters) as Row | undefined) ?? null;
        },
        async all<Row>() {
          return { results: prepared.all(...parameters) as Row[] };
        },
        async run() {
          const result = prepared.run(...parameters);
          const triggerChanges =
            includeTriggerChanges &&
            sql.startsWith("DELETE FROM time_sessions") &&
            result.changes > 0
              ? 1
              : 0;
          return { meta: { changes: Number(result.changes) + triggerChanges } };
        },
      };
    },
  } as unknown as D1Database;
}

afterEach(() => {
  for (const sqlite of openConnections.splice(0)) sqlite.close();
});

async function savedStopwatch(db: D1Database, requestId: string, start = START) {
  const running = await startSession(db, { mode: "stopwatch", clientRequestId: requestId }, start);
  const stopped = await stopSession(db, running.id, start + 60_000);
  return saveSession(db, stopped.id, `Activity ${requestId}`, start + 60_001);
}

describe("Toki D1 session repository", () => {
  it("migrates existing sessions without changing rows or dropping the three indexes", () => {
    const sqlite = new DatabaseSync(":memory:");
    openConnections.push(sqlite);
    sqlite.exec(initialMigration);
    const insert = sqlite.prepare(
      `INSERT INTO time_sessions
       (id, client_request_id, mode, status, started_at_ms, timer_seconds,
        deadline_at_ms, ended_at_ms, description, version, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run(
      "saved",
      "saved-request",
      "timer",
      "saved",
      START,
      60,
      START + 60_000,
      START + 60_000,
      "Work",
      3,
      START,
      START + 60_001,
    );
    insert.run(
      "running",
      "running-request",
      "stopwatch",
      "running",
      START + 100_000,
      null,
      null,
      null,
      null,
      1,
      START + 100_000,
      START + 100_000,
    );
    insert.run(
      "discarded",
      "discarded-request",
      "stopwatch",
      "discarded",
      START - 100_000,
      null,
      null,
      START - 99_000,
      null,
      3,
      START - 100_000,
      START - 98_000,
    );
    const before = sqlite.prepare("SELECT * FROM time_sessions ORDER BY id").all();

    sqlite.exec(manualRecordMigration);

    expect(sqlite.prepare("SELECT * FROM time_sessions ORDER BY id").all()).toEqual(before);
    expect(sqlite.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    const indexes = sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'time_sessions_%' ORDER BY name",
      )
      .all() as { name: string }[];
    expect(indexes.map(({ name }) => name)).toEqual([
      "time_sessions_one_open",
      "time_sessions_saved_end",
      "time_sessions_saved_start",
    ]);
  });

  it("creates a manual record idempotently without consuming the open measurement slot", async () => {
    const db = localDb();
    const measured = await savedStopwatch(db, "already-saved", START - 60_000);
    const running = await startSession(
      db,
      { mode: "stopwatch", clientRequestId: "active-measurement" },
      START,
    );
    const input = {
      startedAtMs: START - 3_600_000,
      endedAtMs: START + 3_600_000,
      description: "  Earlier work  ",
      clientRequestId: crypto.randomUUID(),
    };
    const first = await createManualRecord(db, input, START + 1000);
    const retry = await createManualRecord(db, input, START + 2000);
    expect(first).toMatchObject({
      mode: "manual",
      status: "saved",
      startedAtMs: input.startedAtMs,
      endedAtMs: input.endedAtMs,
      description: "Earlier work",
      timerSeconds: null,
      deadlineAtMs: null,
      version: 1,
    });
    expect(retry).toEqual(first);
    expect((await getCurrentSession(db, START + 2000))?.id).toBe(running.id);
    expect(
      (await listSavedRecords(db, START - 60_000, START + 3_600_001)).map(({ id }) => id),
    ).toEqual([first.id, measured.id]);
    const future = await createManualRecord(
      db,
      {
        ...input,
        startedAtMs: START + 24 * 3_600_000,
        endedAtMs: START + 25 * 3_600_000,
        clientRequestId: crypto.randomUUID(),
      },
      START + 2000,
    );
    expect(future.startedAtMs).toBeGreaterThan(future.createdAtMs);
    await expect(
      createManualRecord(db, { ...input, description: "Different" }, START + 3000),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("rejects invalid manual records and a reused measurement request ID", async () => {
    const db = localDb();
    const measured = await savedStopwatch(db, crypto.randomUUID());
    const input = {
      startedAtMs: START,
      endedAtMs: START + 60_000,
      description: "Manual",
      clientRequestId: crypto.randomUUID(),
    };
    await expect(
      createManualRecord(db, { ...input, endedAtMs: START }, START),
    ).rejects.toMatchObject({ code: "validation" });
    await expect(
      createManualRecord(db, { ...input, endedAtMs: START + MAX_RECORD_MS + 1 }, START),
    ).rejects.toMatchObject({ code: "validation" });
    await expect(
      createManualRecord(db, { ...input, description: " " }, START),
    ).rejects.toMatchObject({ code: "validation" });
    await expect(
      createManualRecord(db, { ...input, clientRequestId: measured.clientRequestId }, START),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("deletes saved records by version and blocks a deleted create or start request replay", async () => {
    const sqlite = new DatabaseSync(":memory:");
    // D1 counts the deletion and the AFTER DELETE request-ID insert together.
    const db = localDb(sqlite, undefined, true);
    const input = {
      startedAtMs: START,
      endedAtMs: START + 60_000,
      description: "Manual",
      clientRequestId: crypto.randomUUID(),
    };
    const manual = await createManualRecord(db, input, START);
    await expect(deleteSavedRecord(db, manual.id, manual.version + 1)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await listSavedRecords(db, START, START + 60_000)).toHaveLength(1);
    await deleteSavedRecord(db, manual.id, manual.version);
    expect(await listSavedRecords(db, START, START + 60_000)).toEqual([]);
    expect(
      sqlite.prepare("SELECT * FROM time_sessions WHERE id = ?").get(manual.id),
    ).toBeUndefined();
    expect(
      sqlite
        .prepare("SELECT * FROM deleted_client_request_ids WHERE client_request_id = ?")
        .get(input.clientRequestId),
    ).toEqual({ client_request_id: input.clientRequestId });
    expect(
      (
        sqlite.prepare("PRAGMA table_info(deleted_client_request_ids)").all() as { name: string }[]
      ).map(({ name }) => name),
    ).toEqual(["client_request_id"]);
    await expect(deleteSavedRecord(db, manual.id, manual.version)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(createManualRecord(db, input, START + 2000)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await getCurrentSession(db, START + 2000)).toBeNull();

    const measured = await savedStopwatch(db, "measured-for-deletion", START + 3000);
    await deleteSavedRecord(db, measured.id, measured.version);
    expect(
      sqlite.prepare("SELECT * FROM time_sessions WHERE id = ?").get(measured.id),
    ).toBeUndefined();
    expect(
      sqlite
        .prepare("SELECT * FROM deleted_client_request_ids WHERE client_request_id = ?")
        .get(measured.clientRequestId),
    ).toEqual({ client_request_id: measured.clientRequestId });
    await expect(
      startSession(
        db,
        { mode: "stopwatch", clientRequestId: measured.clientRequestId },
        START + 120_000,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await getCurrentSession(db, START + 120_000)).toBeNull();
  });

  it("does not delete an unfinished or discarded measurement through the record route", async () => {
    const db = localDb();
    const running = await startSession(
      db,
      { mode: "stopwatch", clientRequestId: crypto.randomUUID() },
      START,
    );
    await expect(deleteSavedRecord(db, running.id, running.version)).rejects.toMatchObject({
      code: "not_found",
    });
    expect((await getSession(db, running.id, START + 1))?.status).toBe("running");
    const stopped = await stopSession(db, running.id, START + 1);
    await expect(deleteSavedRecord(db, stopped.id, stopped.version)).rejects.toMatchObject({
      code: "not_found",
    });
    const discarded = await discardSession(db, stopped.id, START + 2);
    await expect(deleteSavedRecord(db, discarded.id, discarded.version)).rejects.toMatchObject({
      code: "not_found",
    });
    expect((await getSession(db, discarded.id, START + 3))?.status).toBe("discarded");
  });

  it("starts, stops, saves, and lists a stopwatch across midnight", async () => {
    const db = localDb();
    const running = await startSession(
      db,
      { mode: "stopwatch", clientRequestId: "start-1" },
      START,
    );
    expect(running).toMatchObject({
      mode: "stopwatch",
      status: "running",
      startedAtMs: START,
      timerSeconds: null,
      deadlineAtMs: null,
      version: 1,
    });
    expect((await getCurrentSession(db, START + 30_000))?.id).toBe(running.id);

    const stopped = await stopSession(db, running.id, START + 60_000);
    expect(stopped).toMatchObject({ status: "awaiting_description", endedAtMs: START + 60_000 });
    expect(await listSavedRecords(db, START, START + 120_000)).toEqual([]);

    const saved = await saveSession(db, running.id, "  Reading   ", START + 60_100);
    expect(saved).toMatchObject({ status: "saved", description: "Reading", version: 3 });
    expect(await getCurrentSession(db, START + 61_000)).toBeNull();
    expect(await listSavedRecords(db, START + 30_000, START + 120_000)).toEqual([saved]);
    expect(await listSavedRecords(db, START + 60_000, START + 120_000)).toEqual([]);
    expect(await listSavedRecords(db, START - 60_000, START)).toEqual([]);
  });

  it("persists a timer deadline and materializes expiry exactly once on a later access", async () => {
    const db = localDb();
    const running = await startSession(
      db,
      { mode: "timer", timerSeconds: 90, clientRequestId: "timer-1" },
      START,
    );
    expect(running.deadlineAtMs).toBe(START + 90_000);
    expect((await getCurrentSession(db, START + 89_999))?.status).toBe("running");

    const expired = await getCurrentSession(db, START + 100_000);
    expect(expired).toMatchObject({
      status: "awaiting_description",
      endedAtMs: START + 90_000,
      version: 2,
    });
    expect((await getSession(db, running.id, START + 200_000))?.version).toBe(2);
    expect((await stopSession(db, running.id, START + 200_000)).endedAtMs).toBe(START + 90_000);
    await expect(
      startSession(db, { mode: "stopwatch", clientRequestId: "timer-2" }, START + 200_000),
    ).rejects.toMatchObject({ code: "conflict", currentSession: expired });
  });

  it("stops a timer early without waiting for the deadline", async () => {
    const db = localDb();
    const timer = await startSession(
      db,
      { mode: "timer", timerSeconds: 3600, clientRequestId: "timer-early" },
      START,
    );
    const stopped = await stopSession(db, timer.id, START + 10_000);
    expect(stopped.endedAtMs).toBe(START + 10_000);
    expect((await stopSession(db, timer.id, START + 20_000)).endedAtMs).toBe(START + 10_000);
    const saved = await saveSession(db, timer.id, "Exercise", START + 21_000);
    expect((await saveSession(db, timer.id, "Exercise", START + 22_000)).version).toBe(
      saved.version,
    );
    await expect(saveSession(db, timer.id, "Changed", START + 22_000)).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("permits overlapping saved records and independent edits beyond original timer deadline", async () => {
    const db = localDb();
    const first = await savedStopwatch(db, "first");
    const timer = await startSession(
      db,
      { mode: "timer", timerSeconds: 60, clientRequestId: "second" },
      START + 120_000,
    );
    await stopSession(db, timer.id, START + 150_000);
    const second = await saveSession(db, timer.id, "Other", START + 150_001);

    const moved = await editSavedRecord(
      db,
      second.id,
      {
        startedAtMs: START + 20_000,
        endedAtMs: START + 100_000,
        description: "  Overlapping  ",
        expectedVersion: second.version,
      },
      START + 160_000,
    );
    expect(moved).toMatchObject({
      status: "saved",
      startedAtMs: START + 20_000,
      endedAtMs: START + 100_000,
      description: "Overlapping",
      timerSeconds: 60,
      version: second.version + 1,
    });
    expect((await listSavedRecords(db, START, START + 110_000)).map((item) => item.id)).toEqual([
      first.id,
      second.id,
    ]);
    await expect(
      editSavedRecord(
        db,
        second.id,
        {
          startedAtMs: START,
          endedAtMs: START + 50_000,
          description: "Stale",
          expectedVersion: second.version,
        },
        START + 170_000,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("allows only one unfinished session and makes start requests idempotent", async () => {
    const db = localDb();
    const input = { mode: "stopwatch" as const, clientRequestId: "same-request" };
    const first = await startSession(db, input, START);
    expect((await startSession(db, input, START + 1000)).id).toBe(first.id);
    await expect(
      startSession(
        db,
        { mode: "timer", timerSeconds: 2, clientRequestId: input.clientRequestId },
        START + 1,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      startSession(db, { mode: "stopwatch", clientRequestId: "another" }, START + 1),
    ).rejects.toMatchObject({ code: "conflict", currentSession: first });

    const stopped = await stopSession(db, first.id, START + 1);
    expect(stopped.endedAtMs).toBe(START + 1);
    await expect(
      startSession(db, { mode: "stopwatch", clientRequestId: "another" }, START + 2),
    ).rejects.toMatchObject({ code: "conflict" });
    await discardSession(db, first.id, START + 3);
    const next = await startSession(
      db,
      { mode: "stopwatch", clientRequestId: "another" },
      START + 4,
    );
    expect(next.status).toBe("running");
  });

  it("uses the database unique index for simultaneous starts", async () => {
    const db = localDb();
    const outcomes = await Promise.allSettled([
      startSession(db, { mode: "stopwatch", clientRequestId: "race-a" }, START),
      startSession(db, { mode: "stopwatch", clientRequestId: "race-b" }, START),
    ]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await getCurrentSession(db, START))?.status).toBe("running");
  });

  it("discards an unsaved measurement without adding a calendar record", async () => {
    const db = localDb();
    const running = await startSession(
      db,
      { mode: "stopwatch", clientRequestId: "discard" },
      START,
    );
    await expect(discardSession(db, running.id, START + 1)).rejects.toMatchObject({
      code: "conflict",
    });
    await stopSession(db, running.id, START + 1);
    const discarded = await discardSession(db, running.id, START + 2);
    expect(discarded.status).toBe("discarded");
    expect((await discardSession(db, running.id, START + 3)).version).toBe(discarded.version);
    expect(await listSavedRecords(db, START, START + 1_000)).toEqual([]);
    await expect(stopSession(db, running.id, START + 4)).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(saveSession(db, running.id, "No", START + 4)).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("validates timer, description, record interval and request IDs", async () => {
    const db = localDb();
    for (const timerSeconds of [0, -1, 86401, 1.5, Number.NaN]) {
      await expect(
        startSession(db, { mode: "timer", timerSeconds, clientRequestId: "invalid-timer" }, START),
      ).rejects.toMatchObject({ code: "validation" });
    }
    await expect(
      startSession(db, { mode: "stopwatch", timerSeconds: 1, clientRequestId: "invalid" }, START),
    ).rejects.toMatchObject({ code: "validation" });
    await expect(
      startSession(db, { mode: "stopwatch", clientRequestId: "has spaces" }, START),
    ).rejects.toMatchObject({ code: "validation" });
    await expect(
      startSession(db, { mode: "stopwatch", clientRequestId: "bad-now" }, -1),
    ).rejects.toMatchObject({ code: "validation" });

    const running = await startSession(db, { mode: "stopwatch", clientRequestId: "valid" }, START);
    await stopSession(db, running.id, START + 1000);
    for (const description of ["", "  ", "x".repeat(501)]) {
      await expect(saveSession(db, running.id, description, START + 1001)).rejects.toMatchObject({
        code: "validation",
      });
    }
    await expect(listSavedRecords(db, START, START)).rejects.toMatchObject({ code: "validation" });
    await expect(listSavedRecords(db, START, START + MAX_RECORD_MS + 1)).rejects.toMatchObject({
      code: "validation",
    });
  });

  it("rejects invalid edits and missing records without modifying saved data", async () => {
    const db = localDb();
    const saved = await savedStopwatch(db, "editable");
    const basic = {
      startedAtMs: START,
      endedAtMs: START + 60_000,
      description: "Changed",
      expectedVersion: saved.version,
    };
    await expect(
      editSavedRecord(db, saved.id, { ...basic, endedAtMs: START }, START + 70_000),
    ).rejects.toMatchObject({ code: "validation" });
    await expect(
      editSavedRecord(
        db,
        saved.id,
        { ...basic, endedAtMs: START + MAX_RECORD_MS + 1 },
        START + 70_000,
      ),
    ).rejects.toMatchObject({ code: "validation" });
    await expect(
      editSavedRecord(db, saved.id, { ...basic, description: " " }, START + 70_000),
    ).rejects.toMatchObject({ code: "validation" });
    await expect(
      editSavedRecord(db, saved.id, { ...basic, expectedVersion: 0 }, START + 70_000),
    ).rejects.toMatchObject({ code: "validation" });
    await expect(getSession(db, "missing", START)).rejects.toMatchObject({ code: "validation" });
    await expect(stopSession(db, crypto.randomUUID(), START)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(saveSession(db, crypto.randomUUID(), "Valid", START)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(discardSession(db, crypto.randomUUID(), START)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(editSavedRecord(db, crypto.randomUUID(), basic, START)).rejects.toMatchObject({
      code: "not_found",
    });
    expect((await getSession(db, saved.id, START + 80_000))?.version).toBe(saved.version);
  });

  it("rejects saving an abandoned stopwatch longer than the maximum duration", async () => {
    const db = localDb();
    const running = await startSession(
      db,
      { mode: "stopwatch", clientRequestId: "abandoned" },
      START,
    );
    await stopSession(db, running.id, START + MAX_RECORD_MS + 1);
    await expect(
      saveSession(db, running.id, "Too long", START + MAX_RECORD_MS + 2),
    ).rejects.toBeInstanceOf(TokiDataError);
    await discardSession(db, running.id, START + MAX_RECORD_MS + 3);
  });

  it("keeps a dense saved history indexed and returns only records intersecting a range", async () => {
    const sqlite = new DatabaseSync(":memory:");
    const preparedSql: string[] = [];
    const db = localDb(sqlite, (sql) => preparedSql.push(sql));
    const minute = 60_000;
    const insert = sqlite.prepare(
      `INSERT INTO time_sessions
       (id, client_request_id, mode, status, started_at_ms, timer_seconds,
        deadline_at_ms, ended_at_ms, description, version, created_at_ms, updated_at_ms)
       VALUES (?, ?, 'stopwatch', 'saved', ?, NULL, NULL, ?, 'Recorded', 3, ?, ?)`,
    );
    sqlite.exec("BEGIN");
    for (let index = 0; index < 10_000; index++) {
      const startedAtMs = START + index * minute;
      insert.run(
        `saved-${index}`,
        `request-${index}`,
        startedAtMs,
        startedAtMs + minute,
        START,
        START,
      );
    }
    insert.run(
      "crossing",
      "request-crossing",
      START + 4_990 * minute,
      START + 5_070 * minute,
      START,
      START,
    );
    sqlite.exec("COMMIT");
    sqlite.exec("ANALYZE");

    const startMs = START + 5_000 * minute;
    const endMs = START + 5_060 * minute;
    const records = await listSavedRecords(db, startMs, endMs);
    expect(records).toHaveLength(61);
    expect(records[0]?.id).toBe("crossing");
    expect(records.at(-1)?.id).toBe("saved-5059");
    expect(records.some((record) => record.id === "saved-4999")).toBe(false);
    expect(records.some((record) => record.id === "saved-5060")).toBe(false);
    expect(
      records.every(
        (record) =>
          record.startedAtMs < endMs && record.endedAtMs !== null && record.endedAtMs > startMs,
      ),
    ).toBe(true);

    const plan = sqlite
      .prepare(
        `EXPLAIN QUERY PLAN SELECT * FROM time_sessions
         WHERE status = 'saved' AND started_at_ms < ? AND ended_at_ms > ?
         ORDER BY started_at_ms ASC, id ASC`,
      )
      .all(endMs, startMs) as { detail: string }[];
    expect(
      plan.some(({ detail }) => /USING INDEX time_sessions_saved_(start|end)/.test(detail)),
    ).toBe(true);

    const openPlan = sqlite
      .prepare(
        `EXPLAIN QUERY PLAN SELECT * FROM time_sessions
         WHERE status IN ('running', 'awaiting_description') LIMIT 1`,
      )
      .all() as { detail: string }[];
    expect(openPlan.some(({ detail }) => detail.includes("time_sessions_one_open"))).toBe(true);

    expect(await getCurrentSession(db, endMs)).toBeNull();
    const timerUpdate = preparedSql.find(
      (sql) => sql.includes("UPDATE time_sessions") && sql.includes("deadline_at_ms <= ?"),
    );
    expect(timerUpdate).toBeDefined();
    const timerUpdatePlan = sqlite
      .prepare(`EXPLAIN QUERY PLAN ${timerUpdate}`)
      .all(endMs, endMs) as { detail: string }[];
    expect(timerUpdatePlan.some(({ detail }) => detail.includes("time_sessions_one_open"))).toBe(
      true,
    );
  });
});
