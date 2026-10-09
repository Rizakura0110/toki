import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBaselineDatabase, insertBaselineRow } from "../../tests/fixtures/local-database";
import { BASELINE_NOW_MS, savedTimer } from "../../tests/fixtures/toki-baseline";
import { AccessAuthError } from "../security/access";
import * as requestAuth from "../security/request";
import { type ApiBindings, handleApiRequest } from "./router";

const ORIGIN = "http://127.0.0.1:8787";
const ID = "123e4567-e89b-42d3-a456-426614174000";
const INVALID_ID = "------------------------------------";
const WRITE_HEADERS = {
  Origin: ORIGIN,
  "Content-Type": "application/json; charset=utf-8",
  "X-Toki-Client": "web",
};
let database: ReturnType<typeof createBaselineDatabase>;

function request(path: string, method = "GET", body?: string, headers = WRITE_HEADERS) {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
  });
}

function call(incoming: Request, bindings: ApiBindings = { DB: database.db }) {
  return handleApiRequest(incoming, { LOCAL_AUTH_BYPASS: "enabled", ...bindings });
}

async function expectError(response: Response, status: number, code: string, head = false) {
  expect(response.status).toBe(status);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(response.headers.has("Allow")).toBe(false);
  expect(response.headers.has("Access-Control-Allow-Origin")).toBe(false);
  // HEAD has no body at the transport boundary; frameworks may strip it earlier.
  if (!head) expect(await response.json()).toEqual({ error: { code } });
}

beforeEach(() => {
  database = createBaselineDatabase();
  vi.spyOn(database.db, "prepare");
  vi.spyOn(Date, "now").mockReturnValue(BASELINE_NOW_MS);
});

afterEach(() => {
  vi.restoreAllMocks();
  database.sqlite.close();
});

describe("Phase 52 routing and middleware compatibility", () => {
  it.each([
    ["/api/v1/session", "HEAD", 405, "METHOD_NOT_ALLOWED"],
    ["/api/v1/records?startMs=1&endMs=2", "HEAD", 405, "METHOD_NOT_ALLOWED"],
    [`/api/v1/session/${ID}/stop?extra=1`, "HEAD", 405, "METHOD_NOT_ALLOWED"],
    [`/api/v1/records/${ID}?extra=1`, "HEAD", 400, "INVALID_QUERY"],
    [`/api/v1/records/${INVALID_ID}`, "HEAD", 404, "NOT_FOUND"],
    ["/api/v1/session?extra=1", "PUT", 405, "METHOD_NOT_ALLOWED"],
    ["/api/v1/records?extra=1", "PUT", 405, "METHOD_NOT_ALLOWED"],
    [`/api/v1/session/${INVALID_ID}/stop?extra=1`, "GET", 405, "METHOD_NOT_ALLOWED"],
    [`/api/v1/session/${INVALID_ID}/stop?extra=1`, "POST", 400, "INVALID_QUERY"],
    [`/api/v1/session/${INVALID_ID}/stop`, "POST", 404, "NOT_FOUND"],
    [`/api/v1/records/${INVALID_ID}?extra=1`, "GET", 400, "INVALID_QUERY"],
    [`/api/v1/records/${INVALID_ID}`, "GET", 404, "NOT_FOUND"],
    [`/api/v1/records/${ID}?extra=1`, "POST", 400, "INVALID_QUERY"],
    [`/api/v1/records/${ID}`, "POST", 405, "METHOD_NOT_ALLOWED"],
  ] as const)("keeps validation precedence for %s %s", async (path, method, status, code) => {
    await expectError(await call(request(path, method)), status, code, method === "HEAD");
    expect(database.db.prepare).not.toHaveBeenCalled();
  });

  it.each([
    "/api/v1/session/",
    "/api/v1/Session",
    "/api/v1//session",
    `/api/v1/session/${ID.toUpperCase()}/stop`,
    `/api/v1/session/%31${ID.slice(1)}/stop`,
    `/api/v1/session/${ID}/STOP`,
    `/api/v1/session/${ID}/stop/`,
    `/api/v1/session/${ID}/unknown`,
    `/api/v1/records/${ID.toUpperCase()}`,
    `/api/v1/records/%31${ID.slice(1)}`,
    `/api/v1/records/${ID}/`,
    `/api/v1/records/${ID}/extra`,
    "/api/v1/records/%ZZ",
    "/api/v1/unknown",
  ])("does not normalize or decode a non-route: %s", async (path) => {
    await expectError(await call(request(path, "POST", "{}")), 404, "NOT_FOUND");
    expect(database.db.prepare).not.toHaveBeenCalled();
  });

  it.each(["/api/v1", "/api/v1?extra=1", "/api/v10/session", "/API/v1/session"])(
    "rejects non-API prefixes before the API authorization gate: %s",
    async (path) => {
      const auth = vi.spyOn(requestAuth, "authorizeRequest");
      await expectError(await call(request(path, "POST"), {}), 404, "NOT_FOUND");
      expect(auth).not.toHaveBeenCalled();
      expect(database.db.prepare).not.toHaveBeenCalled();
    },
  );

  it.each(["/api/v1/session", "/api/v1/unknown", `/api/v1/records/${INVALID_ID}`])(
    "keeps authorization, database and mutation gate ordering on %s",
    async (path) => {
      const unsafe = () => request(path, "POST", "{}", { ...WRITE_HEADERS, Origin: "" });
      await expectError(await call(unsafe(), { LOCAL_AUTH_BYPASS: "disabled" }), 403, "FORBIDDEN");
      await expectError(await call(unsafe(), {}), 503, "UNAVAILABLE");
      await expectError(await call(unsafe()), 403, "UNSAFE_REQUEST");
      expect(database.db.prepare).not.toHaveBeenCalled();
    },
  );

  it.each([
    [new AccessAuthError(401, "UNAUTHORIZED"), 401, "UNAUTHORIZED"],
    [new AccessAuthError(403, "FORBIDDEN"), 403, "FORBIDDEN"],
    [new Error("synthetic private authentication detail"), 401, "UNAUTHORIZED"],
  ] as const)("sanitizes authorization failures: %s", async (cause, status, code) => {
    vi.spyOn(requestAuth, "authorizeRequest").mockRejectedValueOnce(cause);
    await expectError(await call(request("/api/v1/unknown", "POST"), {}), status, code);
    expect(database.db.prepare).not.toHaveBeenCalled();
  });

  it("does not resolve an expired timer through HEAD's automatic GET fallback", async () => {
    const row = {
      ...savedTimer,
      status: "running" as const,
      ended_at_ms: null,
      description: null,
    };
    insertBaselineRow(database.sqlite, row);
    await expectError(
      await call(request("/api/v1/session", "HEAD")),
      405,
      "METHOD_NOT_ALLOWED",
      true,
    );
    expect(database.db.prepare).not.toHaveBeenCalled();
    expect(database.sqlite.prepare("SELECT * FROM time_sessions").get()).toEqual(row);
  });

  it.each([4096, 4097])(
    "limits a multibyte JSON body by bytes, not code units: %i",
    async (bytes) => {
      const input = JSON.stringify({
        startedAtMs: 1_000,
        endedAtMs: 2_000,
        description: "語".repeat(500),
        clientRequestId: ID,
      });
      const body = input + " ".repeat(bytes - new TextEncoder().encode(input).byteLength);
      expect(body.length).toBeLessThan(4096);
      expect(new TextEncoder().encode(body).byteLength).toBe(bytes);
      const response = await call(request("/api/v1/records", "POST", body));
      if (bytes === 4096) {
        expect(response.status).toBe(201);
        expect(await response.json()).toMatchObject({ record: { description: "語".repeat(500) } });
      } else {
        await expectError(response, 400, "INVALID_INPUT");
        expect(database.db.prepare).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["4097", "Infinity", "invalid"])(
    "rejects the declared body size before reading a payload: %s",
    async (statedSize) => {
      const incoming = new Request(`${ORIGIN}/api/v1/session`, {
        method: "POST",
        body: JSON.stringify({ mode: "stopwatch", clientRequestId: ID }),
        headers: { ...WRITE_HEADERS, "Content-Length": statedSize },
      });
      const read = vi.spyOn(incoming, "text");
      await expectError(await call(incoming), 400, "INVALID_INPUT");
      expect(read).not.toHaveBeenCalled();
      expect(database.db.prepare).not.toHaveBeenCalled();
    },
  );

  it("still checks actual body bytes when the declared size is smaller", async () => {
    const incoming = new Request(`${ORIGIN}/api/v1/session`, {
      method: "POST",
      body: JSON.stringify({ mode: "stopwatch", clientRequestId: ID }).padEnd(4097, " "),
      headers: { ...WRITE_HEADERS, "Content-Length": "1" },
    });
    await expectError(await call(incoming), 400, "INVALID_INPUT");
    expect(database.db.prepare).not.toHaveBeenCalled();
  });

  it.each(["", "{", "null", "[]", '{"unexpected":true}'])(
    "rejects an invalid empty-action payload: %s",
    async (body) => {
      await expectError(
        await call(request(`/api/v1/session/${ID}/stop`, "POST", body)),
        400,
        "INVALID_INPUT",
      );
      expect(database.db.prepare).not.toHaveBeenCalled();
    },
  );

  it("sanitizes a failed request-body read as the existing internal error response", async () => {
    const incoming = request("/api/v1/session", "POST", "{}");
    vi.spyOn(incoming, "text").mockRejectedValueOnce(
      new Error("synthetic private transport detail"),
    );
    await expectError(await call(incoming), 500, "INTERNAL_ERROR");
    expect(database.db.prepare).not.toHaveBeenCalled();
  });

  it("sanitizes unexpected storage failures without a framework error body", async () => {
    vi.mocked(database.db.prepare).mockImplementationOnce(() => {
      throw new Error("synthetic private SQL detail");
    });
    await expectError(await call(request("/api/v1/session")), 500, "INTERNAL_ERROR");
  });
});
