/// <reference types="node" />
import { DatabaseSync } from "node:sqlite";
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from "drizzle-kit/api";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createBaselineDatabase, insertBaselineRow } from "../../tests/fixtures/local-database";
import {
  type BaselineRow,
  manualRecord,
  openSessionScenarios,
  savedTimer,
} from "../../tests/fixtures/toki-baseline";
import { deletedClientRequestIds, timeSessions } from "./schema";

let statements: string[];
const opened: DatabaseSync[] = [];
beforeAll(async () => {
  const empty = await generateSQLiteDrizzleJson({});
  const schema = await generateSQLiteDrizzleJson({ timeSessions, deletedClientRequestIds });
  statements = await generateSQLiteMigration(empty, schema);
});
afterEach(() => {
  for (const sqlite of opened.splice(0)) sqlite.close();
});

function databases() {
  const existing = createBaselineDatabase().sqlite;
  const generated = new DatabaseSync(":memory:");
  opened.push(existing, generated);
  generated.exec(statements.join(";\n"));
  return [existing, generated] as const;
}

describe("Phase 53 Drizzle schema matches the existing physical database", () => {
  it("maps both tables, all columns, defaults and indexes without generating a migration to apply", () => {
    const [existing, generated] = databases();
    for (const table of ["time_sessions", "deleted_client_request_ids"]) {
      expect(generated.prepare(`PRAGMA table_info(${table})`).all()).toEqual(
        existing.prepare(`PRAGMA table_info(${table})`).all(),
      );
      const indexes = (db: DatabaseSync) =>
        db
          .prepare(`PRAGMA index_list(${table})`)
          .all()
          .map(({ name, unique, partial }) => ({
            // Kit emits a named unique index for an inline UNIQUE constraint.
            // Compare its columns/semantics, never apply that generated DDL.
            name: String(name).match(/^time_sessions_(?:one_open|saved_start|saved_end)$/u)
              ? name
              : "primary_or_unique",
            columns: db
              .prepare(`PRAGMA index_info('${String(name).replaceAll("'", "''")}')`)
              .all()
              .map(({ name }) => name),
            unique,
            partial,
          }))
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      expect(indexes(generated)).toEqual(indexes(existing));
    }
    expect(getTableConfig(timeSessions).checks).toHaveLength(10);
    // Kit does not model the trigger. Never replace migration history with its output.
    expect(statements.join("\n")).not.toMatch(/\b(?:TRIGGER|DROP|ALTER)\b/iu);
    expect(existing.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all()).toEqual(
      [{ name: "time_sessions_remember_deleted_request" }],
    );
  });

  it.each([
    ["negative start", { started_at_ms: -1 }],
    ["invalid mode", { mode: "invalid" as never }],
    ["invalid status", { status: "invalid" as never }],
    ["zero duration", { ended_at_ms: manualRecord.started_at_ms }],
    ["over 366 days", { ended_at_ms: manualRecord.started_at_ms + 31_622_400_001 }],
    ["empty saved title", { description: "" }],
    ["missing saved title", { description: null }],
    ["over 500 characters", { description: "x".repeat(501) }],
    ["invalid version", { version: 0 }],
    ["negative creation", { created_at_ms: -1 }],
    ["reversed audit times", { updated_at_ms: manualRecord.created_at_ms - 1 }],
    ["manual timer metadata", { timer_seconds: 60 }],
    ["manual unfinished state", { status: "running", ended_at_ms: null, description: null }],
  ] satisfies [string, Partial<BaselineRow>][])(
    "rejects the same invalid %s in both schemas",
    (_name, changes) => {
      for (const sqlite of databases()) {
        expect(() => insertBaselineRow(sqlite, { ...manualRecord, ...changes })).toThrow(
          /CHECK constraint failed/u,
        );
        expect(sqlite.prepare("SELECT * FROM time_sessions").all()).toEqual([]);
      }
    },
  );

  it.each(openSessionScenarios)(
    "preserves milliseconds, timer audit data and the one-open rule: $mode / $status",
    (open) => {
      const [existing, generated] = databases();
      for (const sqlite of [existing, generated]) {
        for (const row of [manualRecord, savedTimer, open]) insertBaselineRow(sqlite, row);
        expect(() =>
          insertBaselineRow(sqlite, {
            ...open,
            id: "second-open",
            client_request_id: "second-open",
          }),
        ).toThrow(/UNIQUE constraint failed/u);
        expect(() => insertBaselineRow(sqlite, { ...manualRecord, id: "same-request" })).toThrow(
          /UNIQUE constraint failed/u,
        );
        expect(sqlite.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      }
      expect(generated.prepare("SELECT * FROM time_sessions ORDER BY id").all()).toEqual(
        existing.prepare("SELECT * FROM time_sessions ORDER BY id").all(),
      );
    },
  );

  it.each([
    ["timer duration below range", { timer_seconds: 0 }],
    ["timer duration above range", { timer_seconds: 86401 }],
    ["missing deadline", { deadline_at_ms: null }],
    ["mismatched running deadline", { deadline_at_ms: 1 }],
    ["running end timestamp", { ended_at_ms: savedTimer.started_at_ms + 1 }],
    ["running description", { description: "unexpected" }],
  ] satisfies [string, Partial<BaselineRow>][])(
    "keeps the timer CHECK for %s",
    (_name, changes) => {
      const timer = openSessionScenarios[1];
      expect(timer).toBeDefined();
      if (!timer) throw new Error("Missing synthetic timer fixture");
      for (const sqlite of databases()) {
        expect(() => insertBaselineRow(sqlite, { ...timer, ...changes })).toThrow(
          /CHECK constraint failed/u,
        );
        expect(sqlite.prepare("SELECT * FROM time_sessions").all()).toEqual([]);
      }
    },
  );
});
