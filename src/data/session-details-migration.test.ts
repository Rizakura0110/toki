import { afterEach, describe, expect, it } from "vitest";
import {
  createBaselineDatabase,
  createCurrentDatabase,
  insertBaselineRow,
  sessionDetailsMigration,
} from "../../tests/fixtures/local-database";
import {
  discardedSession,
  manualRecord,
  openSessionScenarios,
  savedStopwatch,
  savedTimer,
} from "../../tests/fixtures/toki-baseline";
import { TIME_TAGS } from "../contracts/tags";

const opened: ReturnType<typeof createBaselineDatabase>[] = [];
afterEach(() => {
  for (const { sqlite } of opened.splice(0)) sqlite.close();
});

describe("0003 additive session details migration", () => {
  it.each(openSessionScenarios)("preserves old rows and unfinished $mode / $status", (open) => {
    const database = createBaselineDatabase();
    opened.push(database);
    const { sqlite } = database;
    for (const row of [savedStopwatch, savedTimer, manualRecord, discardedSession, open]) {
      insertBaselineRow(sqlite, row);
    }
    sqlite.prepare("INSERT INTO deleted_client_request_ids VALUES (?)").run("old-deleted-request");
    const before = sqlite.prepare("SELECT * FROM time_sessions ORDER BY id").all();
    const schemaBefore = sqlite
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type IN ('index', 'trigger') ORDER BY name",
      )
      .all();
    const tombstonesBefore = sqlite.prepare("SELECT * FROM deleted_client_request_ids").all();
    sqlite.exec(sessionDetailsMigration);
    expect(sqlite.prepare("SELECT * FROM time_sessions ORDER BY id").all()).toEqual(
      before.map((row) => ({ ...row, draft_description: null, tag: null, start_tag: null })),
    );
    expect(
      sqlite
        .prepare(
          "SELECT name, sql FROM sqlite_master WHERE type IN ('index', 'trigger') ORDER BY name",
        )
        .all(),
    ).toEqual(schemaBefore);
    expect(sqlite.prepare("SELECT * FROM deleted_client_request_ids").all()).toEqual(
      tombstonesBefore,
    );
    expect(sqlite.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(() =>
      insertBaselineRow(sqlite, { ...open, id: "second-open", client_request_id: "second-open" }),
    ).toThrow(/UNIQUE constraint/u);
    sqlite.prepare("DELETE FROM time_sessions WHERE id = ?").run(savedStopwatch.id);
    expect(
      sqlite.prepare("SELECT * FROM deleted_client_request_ids ORDER BY client_request_id").all(),
    ).toEqual([
      { client_request_id: savedStopwatch.client_request_id },
      { client_request_id: "old-deleted-request" },
    ]);
  });

  it("enforces new column constraints while keeping the original status constraints", () => {
    const database = createCurrentDatabase();
    opened.push(database);
    const { sqlite } = database;
    const row = openSessionScenarios[0];
    if (!row) throw new Error("Missing fixture");
    insertBaselineRow(sqlite, row);
    sqlite.prepare("UPDATE time_sessions SET draft_description = ?").run("d".repeat(500));
    expect(() =>
      sqlite.prepare("UPDATE time_sessions SET draft_description = ?").run("d".repeat(501)),
    ).toThrow(/CHECK constraint/u);
    expect(() => sqlite.prepare("UPDATE time_sessions SET draft_description = ''").run()).toThrow(
      /CHECK constraint/u,
    );
    expect(() =>
      sqlite.prepare("UPDATE time_sessions SET description = 'running title'").run(),
    ).toThrow(/CHECK constraint/u);
    for (const { id } of TIME_TAGS) {
      sqlite.prepare("UPDATE time_sessions SET tag = ?, start_tag = ?").run(id, id);
    }
    for (const column of ["tag", "start_tag"]) {
      expect(() => sqlite.prepare(`UPDATE time_sessions SET ${column} = ?`).run("unknown")).toThrow(
        /CHECK constraint/u,
      );
    }
    sqlite
      .prepare("UPDATE time_sessions SET draft_description = NULL, tag = NULL, start_tag = NULL")
      .run();
  });
});
