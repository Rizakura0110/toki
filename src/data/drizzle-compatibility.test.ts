/// <reference types="node" />
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { createCurrentDatabase } from "../../tests/fixtures/local-database";
import * as legacy from "../../tests/fixtures/phase52-records";
import {
  type BaselineRow,
  discardedSession,
  expectedSession,
  manualRecord,
  BASELINE_NOW_MS as NOW,
  openSessionScenarios,
  BASELINE_START_MS as START,
  savedStopwatch,
  savedTimer,
} from "../../tests/fixtures/toki-baseline";
import * as modern from "./records";

type Repository = Pick<
  typeof legacy,
  | "getCurrentSession"
  | "getSession"
  | "startSession"
  | "stopSession"
  | "saveSession"
  | "discardSession"
  | "createManualRecord"
  | "editSavedRecord"
  | "deleteSavedRecord"
  | "listSavedRecords"
>;
type Query = { sql: string; parameters: unknown[] };
let directory: string;
let platform: PlatformProxy<{ DB: D1Database }>;
let d1: D1Database;
let physicalBaseline: unknown;

async function physicalState(db: D1Database) {
  return {
    schema: (
      await db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all()
    ).results,
    migrations: (await db.prepare("SELECT * FROM d1_migrations ORDER BY id").all()).results,
  };
}

beforeAll(async () => {
  await mkdir(resolve(".tmp"), { recursive: true });
  directory = await mkdtemp(resolve(".tmp/phase53-d1-"));
  const configPath = resolve(directory, "wrangler.json");
  const state = resolve(directory, "state");
  // Generated, isolated local fixture: no assets, account, remote IDs or secrets.
  await writeFile(
    configPath,
    JSON.stringify({
      name: "toki-phase53-test",
      compatibility_date: "2026-08-15",
      workers_dev: false,
      preview_urls: false,
      d1_databases: [
        {
          binding: "DB",
          database_name: "toki-phase53-test",
          remote: false,
          migrations_dir: resolve("migrations"),
        },
      ],
    }),
  );
  const env: NodeJS.ProcessEnv = { ...process.env, WRANGLER_SEND_METRICS: "false" };
  for (const key of [
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
    "ALLOWED_EMAIL",
    "TEAM_DOMAIN",
    "POLICY_AUD",
  ])
    delete env[key];
  await promisify(execFile)(
    process.execPath,
    [
      resolve("node_modules/wrangler/bin/wrangler.js"),
      "d1",
      "migrations",
      "apply",
      "DB",
      "--config",
      configPath,
      "--local",
      "--persist-to",
      state,
    ],
    { env, timeout: 60_000, maxBuffer: 1024 * 1024 },
  );
  platform = await getPlatformProxy<{ DB: D1Database }>({
    configPath,
    envFiles: [],
    remoteBindings: false,
    // CLI --persist-to adds v3; getPlatformProxy expects that final directory.
    persist: { path: resolve(state, "v3") },
  });
  d1 = platform.env.DB;
  physicalBaseline = await physicalState(d1);
}, 90_000);

afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  try {
    if (d1 && physicalBaseline) expect(await physicalState(d1)).toEqual(physicalBaseline);
  } finally {
    await platform?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

async function reset(db: D1Database, rows: readonly BaselineRow[] = []) {
  await db.prepare("DELETE FROM time_sessions").run();
  await db.prepare("DELETE FROM deleted_client_request_ids").run();
  for (const row of rows) {
    await db
      .prepare(`INSERT INTO time_sessions
      (id, client_request_id, mode, status, started_at_ms, timer_seconds, deadline_at_ms,
       ended_at_ms, description, version, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
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
      )
      .run();
  }
}

function observed(db: D1Database, queries: Query[]): D1Database {
  return {
    prepare(sql: string) {
      let statement = db.prepare(sql);
      let parameters: unknown[] = [];
      const record = () => queries.push({ sql, parameters });
      return {
        bind(...values: unknown[]) {
          parameters = values;
          statement = statement.bind(...values);
          return this;
        },
        first() {
          record();
          return statement.first();
        },
        all() {
          record();
          return statement.all();
        },
        raw() {
          record();
          return statement.raw();
        },
        run() {
          record();
          return statement.run();
        },
      };
    },
  } as unknown as D1Database;
}

async function contents(db: D1Database) {
  return {
    sessions: (await db.prepare("SELECT * FROM time_sessions ORDER BY id").all()).results,
    tombstones: (
      await db.prepare("SELECT * FROM deleted_client_request_ids ORDER BY client_request_id").all()
    ).results,
  };
}

async function scenario(repository: Repository, raw: D1Database) {
  await reset(raw, [savedStopwatch, savedTimer, discardedSession, manualRecord]);
  let nextId = 1;
  const uuid = vi
    .spyOn(crypto, "randomUUID")
    .mockImplementation(() => `60000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`);
  const queries: Query[] = [];
  const db = observed(raw, queries);
  const steps: unknown[] = [];
  async function step(operation: () => Promise<unknown>) {
    const before = queries.length;
    let result: unknown;
    try {
      result = await operation();
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error)) throw error;
      result = {
        code: error.code,
        message: error.message,
        currentSession: "currentSession" in error ? error.currentSession : undefined,
      };
    }
    if (repository === modern) result = legacyResult(result);
    steps.push({ result, queries: queries.length - before, rows: await contents(raw) });
    return result as modern.TokiSession;
  }
  try {
    await step(() => repository.getCurrentSession(db, NOW));
    await step(() => repository.listSavedRecords(db, START, NOW + 172_800_000));
    const request = { mode: "stopwatch" as const, clientRequestId: "phase53-measured" };
    const running = await step(() => repository.startSession(db, request, NOW));
    await step(() => repository.startSession(db, request, NOW + 1));
    await step(() =>
      repository.startSession(db, { ...request, clientRequestId: "second-tab" }, NOW + 2),
    );
    const stopped = await step(() => repository.stopSession(db, running.id, NOW + 1001));
    await step(() => repository.stopSession(db, running.id, NOW + 1002));
    const saved = await step(() => repository.saveSession(db, stopped.id, " \t　", NOW + 1003));
    await step(() => repository.saveSession(db, stopped.id, "", NOW + 1004));
    const input = {
      startedAtMs: saved.startedAtMs - 33,
      endedAtMs: saved.endedAtMs ?? 0,
      description: "  引用 '); DROP TABLE time_sessions; --  ",
      expectedVersion: saved.version,
    };
    const edited = await step(() => repository.editSavedRecord(db, saved.id, input, NOW + 1005));
    await step(() => repository.editSavedRecord(db, saved.id, input, NOW + 1006));
    await step(() => repository.deleteSavedRecord(db, saved.id, saved.version));
    await step(() => repository.deleteSavedRecord(db, saved.id, edited.version));
    await step(() => repository.startSession(db, request, NOW + 1007));
    const manual = {
      startedAtMs: NOW + 86_400_123,
      endedAtMs: NOW + 86_460_456,
      description: "",
      clientRequestId: "70000000-0000-4000-8000-000000000001",
    };
    const created = await step(() => repository.createManualRecord(db, manual, NOW + 1008));
    await step(() => repository.createManualRecord(db, manual, NOW + 1009));
    await step(() =>
      repository.createManualRecord(db, { ...manual, description: "different" }, NOW + 1010),
    );
    await step(() => repository.deleteSavedRecord(db, created.id, created.version));
    await step(() => repository.createManualRecord(db, manual, NOW + 1011));
    await step(() => repository.deleteSavedRecord(db, created.id, created.version));
    const timer = await step(() =>
      repository.startSession(
        db,
        { mode: "timer", timerSeconds: 1, clientRequestId: "phase53-timer" },
        NOW + 2000,
      ),
    );
    await step(() => repository.getCurrentSession(db, NOW + 3000));
    await step(() => repository.getCurrentSession(db, NOW + 3001));
    await step(() => repository.discardSession(db, timer.id, NOW + 3002));
    await step(() => repository.discardSession(db, timer.id, NOW + 3003));
    await step(() => repository.listSavedRecords(db, START, NOW + 172_800_000));
    return { steps, queries };
  } finally {
    uuid.mockRestore();
  }
}

/** Assert and remove only the intentional additive defaults, never hide old-field changes. */
function legacyResult(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(legacyResult);
  if (!value || typeof value !== "object") return value;
  const result = { ...value } as Record<string, unknown>;
  if ("clientRequestId" in result) {
    expect(result.draftDescription).toBeNull();
    expect(result.tag).toBeNull();
    expect(result).not.toHaveProperty("startTag");
    delete result.draftDescription;
    delete result.tag;
  }
  if ("currentSession" in result) result.currentSession = legacyResult(result.currentSession);
  return result;
}

describe("Phase 53 pre-Drizzle equivalence on SQLite and real local D1", () => {
  it("expires a tagged timer after a real idle interval while a changed-tag stopwatch record exists", async () => {
    await reset(d1);
    const startedAt = Date.now();
    const stopwatch = await modern.startSession(
      d1,
      {
        mode: "stopwatch",
        clientRequestId: crypto.randomUUID(),
        description: "開始前の予定",
        tag: "work",
      },
      startedAt,
    );
    await modern.stopSession(d1, stopwatch.id, startedAt + 1);
    const saved = await modern.saveSession(
      d1,
      stopwatch.id,
      "PCstopwatchの実績",
      startedAt + 2,
      "self_development",
    );
    const timer = await modern.startSession(
      d1,
      {
        mode: "timer",
        timerSeconds: 5,
        clientRequestId: crypto.randomUUID(),
        description: "開始前の予定",
        tag: "work",
      },
      Date.now(),
    );
    expect(await modern.getCurrentSession(d1, Date.now())).toMatchObject({
      id: timer.id,
      status: "running",
    });
    await new Promise((resolve) => setTimeout(resolve, 5100));
    expect(await modern.getCurrentSession(d1, Date.now())).toMatchObject({
      id: timer.id,
      status: "awaiting_description",
      endedAtMs: timer.deadlineAtMs,
      description: null,
      draftDescription: "開始前の予定",
      tag: "work",
    });
    expect(await modern.listSavedRecords(d1, startedAt, Date.now())).toEqual([saved]);
  }, 15_000);

  it.each(["SQLite", "D1"])(
    "keeps all outcomes, rows and per-operation query counts on %s",
    async (driver) => {
      const sqlite = driver === "SQLite" ? createCurrentDatabase() : undefined;
      const db = sqlite?.db ?? d1;
      try {
        const previous = await scenario(legacy, db);
        const current = await scenario(modern, db);
        expect(current.steps).toEqual(previous.steps);
        expect(current.steps).toHaveLength(26);
        for (const query of current.queries) {
          expect(query.sql).not.toContain("DROP TABLE");
          expect(query.sql).not.toMatch(/\b(?:begin|commit|alter|create)\b/iu);
        }
        const range = current.queries.find(
          ({ sql }) => sql.startsWith("select ") && sql.includes("order by"),
        );
        const expiry = current.queries.find(
          ({ sql }) => sql.startsWith("update ") && sql.includes("deadline_at_ms"),
        );
        const open = current.queries.find(
          ({ sql }) =>
            sql.startsWith("select ") && sql.includes("IN ('running', 'awaiting_description')"),
        );
        for (const [query, index] of [
          [range, "time_sessions_saved_"],
          [expiry, "time_sessions_one_open"],
          [open, "time_sessions_one_open"],
        ] as const) {
          expect(query).toBeDefined();
          const plan = await db
            .prepare(`EXPLAIN QUERY PLAN ${query?.sql}`)
            .bind(...(query?.parameters ?? []))
            .all<{ detail: string }>();
          expect(plan.results.some(({ detail }) => detail.includes(index))).toBe(true);
        }
      } finally {
        sqlite?.sqlite.close();
      }
    },
    30_000,
  );

  it.each(openSessionScenarios)(
    "keeps pre-existing $mode / $status sessions on local D1",
    async (row) => {
      const rows = [savedStopwatch, savedTimer, discardedSession, manualRecord, row];
      await reset(d1, rows);
      const before = await contents(d1);
      const previous = await legacy.getCurrentSession(d1, NOW);
      expect(legacyResult(await modern.getCurrentSession(d1, NOW))).toEqual(previous);
      expect(previous).toEqual(expectedSession(row));
      expect(await contents(d1)).toEqual(before);
    },
  );

  it.each([legacy, modern])(
    "rolls back deletion if the tombstone trigger fails",
    async (repository) => {
      await reset(d1, [savedStopwatch]);
      const before = await contents(d1);
      await d1
        .prepare(`CREATE TRIGGER phase53_reject_tombstone BEFORE INSERT ON deleted_client_request_ids
      BEGIN SELECT RAISE(ABORT, 'synthetic tombstone failure'); END`)
        .run();
      try {
        await expect(
          repository.deleteSavedRecord(d1, savedStopwatch.id, savedStopwatch.version),
        ).rejects.toThrow();
        expect(await contents(d1)).toEqual(before);
      } finally {
        await d1.prepare("DROP TRIGGER phase53_reject_tombstone").run();
      }
    },
  );

  it.each([legacy, modern])(
    "atomically limits simultaneous starts and competing edit/delete requests",
    async (repository) => {
      await reset(d1);
      const starts = await Promise.allSettled([
        repository.startSession(d1, { mode: "stopwatch", clientRequestId: "phase53-race-a" }, NOW),
        repository.startSession(d1, { mode: "stopwatch", clientRequestId: "phase53-race-b" }, NOW),
      ]);
      expect(starts.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      expect(starts.filter(({ status }) => status === "rejected")).toHaveLength(1);
      expect((await contents(d1)).sessions).toHaveLength(1);
      await reset(d1, [savedStopwatch]);
      const edits = await Promise.allSettled([
        repository.editSavedRecord(
          d1,
          savedStopwatch.id,
          {
            startedAtMs: savedStopwatch.started_at_ms,
            endedAtMs: savedStopwatch.ended_at_ms ?? 0,
            description: "concurrent",
            expectedVersion: savedStopwatch.version,
          },
          NOW,
        ),
        repository.deleteSavedRecord(d1, savedStopwatch.id, savedStopwatch.version),
      ]);
      expect(edits.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      expect(edits.filter(({ status }) => status === "rejected")).toHaveLength(1);
      const rows = await contents(d1);
      expect(rows.sessions.length + rows.tombstones.length).toBe(1);
    },
  );
});
