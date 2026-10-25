import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createCurrentDatabase, insertBaselineRow } from "../../tests/fixtures/local-database";
import { handleApiRequest as legacy } from "../../tests/fixtures/phase48/src/api/router";
import { BASELINE_NOW_MS as NOW, savedStopwatch } from "../../tests/fixtures/toki-baseline";
import { handleApiRequest as modern } from "../api/router";
import type { TokiSession } from "../data/records";

function counted(db: D1Database) {
  const queries: string[] = [];
  return {
    queries,
    db: {
      prepare(sql: string) {
        let statement = db.prepare(sql);
        return {
          bind(...values: unknown[]) {
            statement = statement.bind(...values);
            return this;
          },
          first() {
            queries.push(sql);
            return statement.first();
          },
          all() {
            queries.push(sql);
            return statement.all();
          },
          raw() {
            queries.push(sql);
            return statement.raw();
          },
          run() {
            queries.push(sql);
            return statement.run();
          },
        };
      },
    } as unknown as D1Database,
  };
}

function request(path: string, method = "GET", body?: unknown) {
  return new Request(`http://127.0.0.1${path}`, {
    method,
    headers: {
      Origin: "http://127.0.0.1",
      "X-Toki-Client": "web",
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("per-request D1 query budgets", () => {
  it("guards success, retry, conflict and deletion paths rather than returned row counts", async () => {
    const { db, sqlite } = createCurrentDatabase();
    const observed = counted(db);
    const bindings = { DB: observed.db, LOCAL_AUTH_BYPASS: "enabled" };
    const check = async (
      path: string,
      method: string,
      body: unknown,
      status: number,
      max: number,
    ) => {
      observed.queries.length = 0;
      const response = await modern(request(path, method, body), bindings);
      expect(response.status).toBe(status);
      expect(observed.queries.length).toBeGreaterThan(0);
      expect(observed.queries.length).toBeLessThanOrEqual(max);
      expect(observed.queries.length).toBeLessThan(50);
      expect(observed.queries.every((sql) => !/\b(?:CREATE|ALTER|DROP)\b/iu.test(sql))).toBe(true);
      return response.json() as Promise<{ session: TokiSession; record: TokiSession }>;
    };
    try {
      await check("/api/v1/session", "GET", undefined, 200, 2);
      const input = {
        mode: "stopwatch",
        clientRequestId: crypto.randomUUID(),
        description: "開始前の内容",
        tag: "work",
      };
      const { session } = await check("/api/v1/session", "POST", input, 201, 5);
      await check("/api/v1/session", "POST", input, 201, 3);
      await check(
        "/api/v1/session",
        "POST",
        { ...input, clientRequestId: crypto.randomUUID() },
        409,
        3,
      );
      await check(`/api/v1/session/${session.id}/stop`, "POST", {}, 200, 4);
      const saved = await check(
        `/api/v1/session/${session.id}/save`,
        "POST",
        { description: "", tag: "hobby" },
        200,
        4,
      );
      await check(
        `/api/v1/records/${session.id}`,
        "DELETE",
        { expectedVersion: saved.session.version + 1 },
        409,
        2,
      );
      await check(
        `/api/v1/records/${session.id}`,
        "DELETE",
        { expectedVersion: saved.session.version },
        200,
        1,
      );
      await check("/api/v1/session", "POST", input, 409, 7);
      const manual = {
        clientRequestId: crypto.randomUUID(),
        startedAtMs: NOW,
        endedAtMs: NOW + 1_000,
        description: "",
        tag: "housework",
      };
      const { record } = await check("/api/v1/records", "POST", manual, 201, 2);
      await check("/api/v1/records", "POST", manual, 201, 2);
      await check(
        `/api/v1/records/${record.id}`,
        "PATCH",
        {
          startedAtMs: NOW,
          endedAtMs: NOW + 1_000,
          description: "編集",
          tag: null,
          expectedVersion: record.version,
        },
        200,
        2,
      );
      await check(
        `/api/v1/records?startMs=${NOW}&endMs=${NOW + 86_400_000}`,
        "GET",
        undefined,
        200,
        1,
      );
    } finally {
      sqlite.close();
    }
  });
});

it("records a bounded local Node CPU regression proxy on 10,000 synthetic records", async () => {
  const { db, sqlite } = createCurrentDatabase();
  try {
    sqlite.exec("BEGIN");
    for (let i = 0; i < 10_000; i++) {
      const start = NOW - (10_000 - i) * 3_600_000;
      insertBaselineRow(sqlite, {
        ...savedStopwatch,
        id: `40000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        client_request_id: `50000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        started_at_ms: start,
        ended_at_ms: start + 60_000,
      });
    }
    sqlite.exec("COMMIT");
    const paths = ["/api/v1/session", `/api/v1/records?startMs=${NOW - 86_400_000}&endMs=${NOW}`];
    const report: Record<string, { cpuMsPerRequest: number; wallMsPerRequest: number }> = {};
    for (const [name, handler] of [
      ["legacy", legacy],
      ["modern", modern],
    ] as const) {
      const run = async (i: number) => {
        const response = await handler(request(paths[i % paths.length] ?? ""), {
          DB: db,
          LOCAL_AUTH_BYPASS: "enabled",
        });
        expect(response.status).toBe(200);
        await response.text();
      };
      for (let i = 0; i < 40; i++) await run(i);
      const cpu = process.cpuUsage();
      const wall = performance.now();
      const iterations = 300;
      for (let i = 0; i < iterations; i++) await run(i);
      const elapsed = process.cpuUsage(cpu);
      report[name] = {
        cpuMsPerRequest: (elapsed.user + elapsed.system) / 1_000 / iterations,
        wallMsPerRequest: (performance.now() - wall) / iterations,
      };
    }
    // This is a local Node+SQLite proxy with auth bypass, NOT Cloudflare's billed CPU.
    expect(report.modern?.cpuMsPerRequest).toBeLessThan(5);
    expect(report.modern?.cpuMsPerRequest ?? Infinity).toBeLessThan(
      (report.legacy?.cpuMsPerRequest ?? 0) * 3 + 1,
    );
    await mkdir(resolve(".tmp"), { recursive: true });
    await writeFile(
      resolve(".tmp/phase55-local-cpu.json"),
      `${JSON.stringify(
        {
          kind: "local-node-sqlite-auth-bypass-proxy-not-production-cpu",
          records: 10_000,
          requestsPerVersion: 300,
          report,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    sqlite.close();
  }
}, 30_000);
