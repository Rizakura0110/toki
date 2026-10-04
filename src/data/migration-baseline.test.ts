import { afterEach, describe, expect, it } from "vitest";
import {
  createBaselineDatabase,
  insertBaselineRow,
  manualMigration,
} from "../../tests/fixtures/local-database";
import {
  type BaselineRow,
  discardedSession,
  manualRecord,
  openSessionScenarios,
  savedStopwatch,
  savedTimer,
} from "../../tests/fixtures/toki-baseline";

const databases: ReturnType<typeof createBaselineDatabase>[] = [];

function localDatabase(migrated = true) {
  const database = createBaselineDatabase(migrated);
  databases.push(database);
  return database.sqlite;
}

afterEach(() => {
  for (const { sqlite } of databases.splice(0)) sqlite.close();
});

describe("Phase 50 physical schema and synthetic migration baseline", () => {
  it.each(openSessionScenarios)(
    "preserves every column while migrating with a $mode / $status session",
    (openSession) => {
      const sqlite = localDatabase(false);
      const rows = [savedStopwatch, savedTimer, discardedSession, openSession];
      for (const row of rows) insertBaselineRow(sqlite, row);

      sqlite.exec(manualMigration);

      expect(sqlite.prepare("SELECT * FROM time_sessions ORDER BY id").all()).toEqual(rows);
      expect(sqlite.prepare("SELECT * FROM deleted_client_request_ids").all()).toEqual([]);
      expect(sqlite.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      insertBaselineRow(sqlite, manualRecord);
      expect(sqlite.prepare("SELECT * FROM time_sessions WHERE mode = 'manual'").get()).toEqual(
        manualRecord,
      );
    },
  );

  it("pins column affinity, defaults, primary keys, partial indexes and deletion trigger", () => {
    const sqlite = localDatabase();
    const columns = sqlite.prepare("PRAGMA table_info(time_sessions)").all();
    expect(columns).toEqual(
      [
        ["id", "TEXT", 1, null, 1],
        ["client_request_id", "TEXT", 1, null, 0],
        ["mode", "TEXT", 1, null, 0],
        ["status", "TEXT", 1, null, 0],
        ["started_at_ms", "INTEGER", 1, null, 0],
        ["timer_seconds", "INTEGER", 0, null, 0],
        ["deadline_at_ms", "INTEGER", 0, null, 0],
        ["ended_at_ms", "INTEGER", 0, null, 0],
        ["description", "TEXT", 0, null, 0],
        ["version", "INTEGER", 1, "1", 0],
        ["created_at_ms", "INTEGER", 1, null, 0],
        ["updated_at_ms", "INTEGER", 1, null, 0],
      ].map(([name, type, notnull, dflt_value, pk], cid) => ({
        cid,
        name,
        type,
        notnull,
        dflt_value,
        pk,
      })),
    );
    const definitions = sqlite
      .prepare("SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name")
      .all() as { name: string; sql: string }[];
    const sql = Object.fromEntries(
      definitions.map((entry) => [entry.name, entry.sql.replace(/\s+/gu, " ")]),
    );
    expect(sql.time_sessions_one_open).toBe(
      "CREATE UNIQUE INDEX time_sessions_one_open ON time_sessions ((1)) WHERE status IN ('running', 'awaiting_description')",
    );
    expect(sql.time_sessions_saved_start).toBe(
      "CREATE INDEX time_sessions_saved_start ON time_sessions (started_at_ms) WHERE status = 'saved'",
    );
    expect(sql.time_sessions_saved_end).toBe(
      "CREATE INDEX time_sessions_saved_end ON time_sessions (ended_at_ms) WHERE status = 'saved'",
    );
    expect(sql.time_sessions_remember_deleted_request).toBe(
      "CREATE TRIGGER time_sessions_remember_deleted_request AFTER DELETE ON time_sessions BEGIN INSERT INTO deleted_client_request_ids (client_request_id) VALUES (OLD.client_request_id); END",
    );
    expect(sql.deleted_client_request_ids).toBe(
      "CREATE TABLE deleted_client_request_ids ( client_request_id TEXT PRIMARY KEY NOT NULL )",
    );
    expect(Object.keys(sql).sort()).toEqual([
      "deleted_client_request_ids",
      "time_sessions",
      "time_sessions_one_open",
      "time_sessions_remember_deleted_request",
      "time_sessions_saved_end",
      "time_sessions_saved_start",
    ]);
  });

  it.each([
    ["negative start", { started_at_ms: -1 }],
    ["zero duration", { ended_at_ms: manualRecord.started_at_ms }],
    ["over 366 days", { ended_at_ms: manualRecord.started_at_ms + 31_622_400_001 }],
    ["empty saved title", { description: "" }],
    ["missing saved title", { description: null }],
    ["over 500 characters", { description: "x".repeat(501) }],
    ["invalid version", { version: 0 }],
    ["reversed audit times", { updated_at_ms: manualRecord.created_at_ms - 1 }],
    ["manual timer metadata", { timer_seconds: 60 }],
    ["manual unfinished state", { status: "running", ended_at_ms: null, description: null }],
  ] satisfies [string, Partial<BaselineRow>][])("rejects direct SQL with %s", (_name, changes) => {
    const sqlite = localDatabase();
    expect(() => insertBaselineRow(sqlite, { ...manualRecord, ...changes })).toThrow(
      /CHECK constraint failed/u,
    );
    expect(sqlite.prepare("SELECT * FROM time_sessions").all()).toEqual([]);
  });

  it.each(openSessionScenarios)(
    "enforces one unfinished session while retaining overlapping saved rows: $mode / $status",
    (openSession) => {
      const sqlite = localDatabase();
      for (const row of [savedStopwatch, savedTimer, manualRecord, openSession]) {
        insertBaselineRow(sqlite, row);
      }
      expect(() =>
        insertBaselineRow(sqlite, {
          ...openSession,
          id: "10000000-0000-4000-8000-000000000006",
          client_request_id: "20000000-0000-4000-8000-000000000006",
        }),
      ).toThrow(/UNIQUE constraint failed/u);
      expect(() =>
        insertBaselineRow(sqlite, { ...savedStopwatch, id: "different-record-id" }),
      ).toThrow(/UNIQUE constraint failed/u);
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM time_sessions").get()).toEqual({
        count: 4,
      });
    },
  );
});
