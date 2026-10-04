/// <reference types="node" />
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { BaselineRow } from "./toki-baseline";

export const initialMigration = readFileSync(
  new URL("../../migrations/0001_initial.sql", import.meta.url),
  "utf8",
);
export const manualMigration = readFileSync(
  new URL("../../migrations/0002_manual_records.sql", import.meta.url),
  "utf8",
);

/** An in-memory SQLite adapter, not a replacement for the Wrangler/D1 smoke gate. */
export function createBaselineDatabase(migrated = true) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(initialMigration);
  if (migrated) sqlite.exec(manualMigration);
  const db = {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql);
      let parameters: SQLInputValue[] = [];
      return {
        bind(...values: SQLInputValue[]) {
          parameters = values;
          return this;
        },
        async first<Row>() {
          return (statement.get(...parameters) as Row | undefined) ?? null;
        },
        async all<Row>() {
          return { results: statement.all(...parameters) as Row[] };
        },
        async run() {
          const before = sqlite.prepare("SELECT total_changes() AS count").get() as {
            count: number;
          };
          statement.run(...parameters);
          const after = sqlite.prepare("SELECT total_changes() AS count").get() as {
            count: number;
          };
          // D1 reports changes made by triggers as well as the DELETE itself.
          return { meta: { changes: after.count - before.count } };
        },
      };
    },
  } as unknown as D1Database;
  return { sqlite, db };
}

export function insertBaselineRow(sqlite: DatabaseSync, row: BaselineRow): void {
  sqlite
    .prepare(
      `INSERT INTO time_sessions
       (id, client_request_id, mode, status, started_at_ms, timer_seconds,
        deadline_at_ms, ended_at_ms, description, version, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.client_request_id,
      row.mode,
      row.status,
      row.started_at_ms,
      row.timer_seconds,
      row.deadline_at_ms,
      row.ended_at_ms,
      row.description,
      row.version,
      row.created_at_ms,
      row.updated_at_ms,
    );
}
