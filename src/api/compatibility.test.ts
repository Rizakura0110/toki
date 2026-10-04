import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBaselineDatabase, insertBaselineRow } from "../../tests/fixtures/local-database";
import {
  BASELINE_NOW_MS,
  BASELINE_START_MS,
  discardedSession,
  expectedSession,
  manualRecord,
  openSessionScenarios,
  savedStopwatch,
  savedTimer,
} from "../../tests/fixtures/toki-baseline";
import { handleApiRequest } from "./router";

const ORIGIN = "http://127.0.0.1:8787";
const REQUEST_ID = "30000000-0000-4000-8000-000000000001";
let database: ReturnType<typeof createBaselineDatabase>;

function call(path: string, method = "GET", body?: unknown, headers?: HeadersInit) {
  return handleApiRequest(
    new Request(`${ORIGIN}${path}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      headers: {
        Origin: ORIGIN,
        "Content-Type": "application/json; charset=utf-8",
        "X-Toki-Client": "web",
        ...headers,
      },
    }),
    { DB: database.db, LOCAL_AUTH_BYPASS: "enabled" },
  );
}

async function expectJson(response: Response, status: number, body: unknown) {
  expect(response.status).toBe(status);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(await response.json()).toEqual(body);
}

beforeEach(() => {
  database = createBaselineDatabase();
  vi.spyOn(Date, "now").mockReturnValue(BASELINE_NOW_MS);
});

afterEach(() => {
  database.sqlite.close();
  vi.restoreAllMocks();
});

describe("Phase 50 HTTP compatibility with real SQLite and synthetic records", () => {
  it.each(openSessionScenarios)(
    "reads a pre-existing $mode / $status session without losing any JSON fields",
    async (row) => {
      insertBaselineRow(database.sqlite, row);
      await expectJson(await call("/api/v1/session"), 200, {
        session: expectedSession(row),
        serverNowMs: BASELINE_NOW_MS,
      });
    },
  );

  it("preserves list shape, stable tie ordering, nulls and millisecond precision", async () => {
    for (const row of [savedTimer, savedStopwatch, manualRecord, discardedSession]) {
      insertBaselineRow(database.sqlite, row);
    }
    await expectJson(
      await call(
        `/api/v1/records?startMs=${BASELINE_START_MS}&endMs=${BASELINE_NOW_MS + 172_800_000}`,
      ),
      200,
      {
        records: [savedStopwatch, savedTimer, manualRecord].map(expectedSession),
        serverNowMs: BASELINE_NOW_MS,
      },
    );
  });

  it("keeps start, retry, stop, blank save, stale edit and permanent deletion wire contracts", async () => {
    const input = { mode: "stopwatch", clientRequestId: REQUEST_ID };
    const created = await call("/api/v1/session", "POST", input);
    expect(created.status).toBe(201);
    const { session } = (await created.json()) as { session: ReturnType<typeof expectedSession> };
    expect(session.id).toMatch(/^[0-9a-f-]{36}$/u);
    const running = {
      id: session.id,
      clientRequestId: REQUEST_ID,
      mode: "stopwatch",
      status: "running",
      startedAtMs: BASELINE_NOW_MS,
      timerSeconds: null,
      deadlineAtMs: null,
      endedAtMs: null,
      description: null,
      version: 1,
      createdAtMs: BASELINE_NOW_MS,
      updatedAtMs: BASELINE_NOW_MS,
    };
    expect(session).toEqual(running);
    await expectJson(await call("/api/v1/session", "POST", input), 201, {
      session: running,
      serverNowMs: BASELINE_NOW_MS,
    });
    const stopped = {
      ...running,
      status: "awaiting_description",
      endedAtMs: BASELINE_NOW_MS + 1,
      version: 2,
    };
    await expectJson(await call(`/api/v1/session/${session.id}/stop`, "POST", {}), 200, {
      session: stopped,
      serverNowMs: BASELINE_NOW_MS,
    });
    const saved = { ...stopped, status: "saved", description: "無題", version: 3 };
    await expectJson(
      await call(`/api/v1/session/${session.id}/save`, "POST", { description: " \t　" }),
      200,
      { session: saved, serverNowMs: BASELINE_NOW_MS },
    );
    await expectJson(
      await call(`/api/v1/records/${session.id}`, "PATCH", {
        startedAtMs: saved.startedAtMs,
        endedAtMs: saved.endedAtMs,
        description: "Stale edit",
        expectedVersion: 1,
      }),
      409,
      { error: { code: "CONFLICT" } },
    );
    await expectJson(
      await call(`/api/v1/records/${session.id}`, "DELETE", { expectedVersion: 3 }),
      200,
      {
        deletedRecordId: session.id,
        serverNowMs: BASELINE_NOW_MS,
      },
    );
    await expectJson(await call("/api/v1/session", "POST", input), 409, {
      error: { code: "CONFLICT" },
    });
    await expectJson(
      await call(`/api/v1/records/${session.id}`, "DELETE", { expectedVersion: 3 }),
      404,
      {
        error: { code: "NOT_FOUND" },
      },
    );
  });

  it("creates and edits an overlapping future manual record without rounding existing milliseconds", async () => {
    insertBaselineRow(database.sqlite, manualRecord);
    const input = {
      startedAtMs: manualRecord.started_at_ms,
      endedAtMs: manualRecord.ended_at_ms,
      description: "",
      clientRequestId: REQUEST_ID,
    };
    const created = await call("/api/v1/records", "POST", input);
    expect(created.status).toBe(201);
    const { record } = (await created.json()) as { record: ReturnType<typeof expectedSession> };
    const expected = {
      ...expectedSession(manualRecord),
      id: record.id,
      clientRequestId: REQUEST_ID,
      createdAtMs: BASELINE_NOW_MS,
      updatedAtMs: BASELINE_NOW_MS,
    };
    expect(record).toEqual(expected);
    await expectJson(await call("/api/v1/records", "POST", input), 201, {
      record: expected,
      serverNowMs: BASELINE_NOW_MS,
    });
    await expectJson(
      await call(`/api/v1/records/${record.id}`, "PATCH", {
        startedAtMs: input.startedAtMs,
        endedAtMs: input.endedAtMs,
        description: "  変更した合成データ  ",
        expectedVersion: 1,
      }),
      200,
      {
        record: { ...expected, description: "変更した合成データ", version: 2 },
        serverNowMs: BASELINE_NOW_MS,
      },
    );
  });

  it("materializes timer expiry at its stored deadline and discards it without a calendar record", async () => {
    const row = {
      ...savedStopwatch,
      mode: "timer" as const,
      status: "running" as const,
      timer_seconds: 1,
      deadline_at_ms: BASELINE_START_MS + 1_000,
      ended_at_ms: null,
      description: null,
      version: 1,
      updated_at_ms: BASELINE_START_MS,
    };
    insertBaselineRow(database.sqlite, row);
    const expired = {
      ...expectedSession(row),
      status: "awaiting_description",
      endedAtMs: row.deadline_at_ms,
      updatedAtMs: BASELINE_NOW_MS,
      version: 2,
    };
    await expectJson(await call("/api/v1/session"), 200, {
      session: expired,
      serverNowMs: BASELINE_NOW_MS,
    });
    const discarded = { ...expired, status: "discarded", version: 3 };
    for (let retry = 0; retry < 2; retry++) {
      await expectJson(await call(`/api/v1/session/${row.id}/discard`, "POST", {}), 200, {
        session: discarded,
        serverNowMs: BASELINE_NOW_MS,
      });
    }
    await expectJson(await call("/api/v1/session"), 200, {
      session: null,
      serverNowMs: BASELINE_NOW_MS,
    });
    await expectJson(
      await call(`/api/v1/records?startMs=${BASELINE_START_MS}&endMs=${BASELINE_NOW_MS}`),
      200,
      { records: [], serverNowMs: BASELINE_NOW_MS },
    );
  });

  it("distinguishes storage validation errors from malformed request errors", async () => {
    const row = {
      ...savedStopwatch,
      status: "awaiting_description" as const,
      ended_at_ms: BASELINE_START_MS + 31_622_400_001,
      description: null,
    };
    insertBaselineRow(database.sqlite, row);
    await expectJson(
      await call(`/api/v1/session/${row.id}/save`, "POST", { description: "" }),
      400,
      { error: { code: "VALIDATION" } },
    );
    expect(database.sqlite.prepare("SELECT * FROM time_sessions").get()).toEqual(row);
  });

  it.each([
    ["/api/v1/session/", "GET", undefined, 404, "NOT_FOUND"],
    ["/api/v1/records/", "GET", undefined, 404, "NOT_FOUND"],
    ["/api/v1/session", "OPTIONS", undefined, 405, "METHOD_NOT_ALLOWED"],
    ["/api/v1/session?extra=1", "GET", undefined, 400, "INVALID_QUERY"],
    ["/api/v1/records?startMs=1&endMs=2&extra=1", "GET", undefined, 400, "INVALID_QUERY"],
    ["/api/v1/records?startMs=1&startMs=2&endMs=3", "GET", undefined, 400, "INVALID_QUERY"],
    [`/api/v1/session/${savedStopwatch.id}/stop`, "GET", undefined, 405, "METHOD_NOT_ALLOWED"],
    [`/api/v1/session/${savedStopwatch.id}/discard`, "POST", { extra: true }, 400, "INVALID_INPUT"],
    [`/api/v1/records/${savedStopwatch.id}`, "POST", {}, 405, "METHOD_NOT_ALLOWED"],
    ["/api/v1/records/not-a-uuid", "PATCH", {}, 404, "NOT_FOUND"],
    [
      "/api/v1/session",
      "POST",
      { mode: "stopwatch", clientRequestId: REQUEST_ID, extra: true },
      400,
      "INVALID_INPUT",
    ],
  ] as const)("pins %s %s response", async (path, method, body, status, code) => {
    await expectJson(await call(path, method, body), status, { error: { code } });
    expect(database.sqlite.prepare("SELECT * FROM time_sessions").all()).toEqual([]);
  });

  it("pins HEAD status and headers without depending on an internal response body", async () => {
    const response = await call("/api/v1/session", "HEAD");
    expect(response.status).toBe(405);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    // The actual HTTP transport strips HEAD bodies; the E2E suite checks that boundary.
    expect(database.sqlite.prepare("SELECT * FROM time_sessions").all()).toEqual([]);
  });

  it("accepts exactly 4096 body bytes and rejects an oversized or malformed body", async () => {
    const input = JSON.stringify({ mode: "stopwatch", clientRequestId: REQUEST_ID });
    for (const [body, status, code] of [
      [input.padEnd(4096, " "), 201, null],
      [input.padEnd(4097, " "), 400, "INVALID_INPUT"],
      ["{", 400, "INVALID_INPUT"],
    ] as const) {
      const response = await handleApiRequest(
        new Request(`${ORIGIN}/api/v1/session`, {
          method: "POST",
          body,
          headers: { Origin: ORIGIN, "X-Toki-Client": "web", "Content-Type": "application/json" },
        }),
        { DB: database.db, LOCAL_AUTH_BYPASS: "enabled" },
      );
      expect(response.status).toBe(status);
      if (code !== null) await expectJson(response, status, { error: { code } });
    }
    expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM time_sessions").get()).toEqual({
      count: 1,
    });
  });
});
