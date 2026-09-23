import { beforeEach, describe, expect, it, vi } from "vitest";
import { TokiDataError } from "../data/records";
import { handleApiRequest, type ApiBindings } from "./router";

vi.mock("../data/records", async (importOriginal) => {
  const original = await importOriginal<typeof import("../data/records")>();
  return {
    ...original,
    getCurrentSession: vi.fn(),
    startSession: vi.fn(),
    stopSession: vi.fn(),
    saveSession: vi.fn(),
    discardSession: vi.fn(),
    listSavedRecords: vi.fn(),
    editSavedRecord: vi.fn(),
  };
});

import {
  discardSession,
  editSavedRecord,
  getCurrentSession,
  listSavedRecords,
  saveSession,
  startSession,
  stopSession,
} from "../data/records";

const BASE = "http://127.0.0.1:8787";
const SESSION_ID = "123e4567-e89b-42d3-a456-426614174000";
const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174001";
const DB = {} as D1Database;
const LOCAL: ApiBindings = { DB, LOCAL_AUTH_BYPASS: "enabled" };

function request(path: string, method = "GET", body?: unknown, headers?: HeadersInit): Request {
  return new Request(`${BASE}${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: {
      ...(method === "GET"
        ? {}
        : { Origin: BASE, "Content-Type": "application/json", "X-Toki-Client": "web" }),
      ...headers,
    },
  });
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("Toki API perimeter", () => {
  it("denies remote requests without a valid Access configuration or token", async () => {
    const response = await handleApiRequest(new Request("https://toki.example/api/v1/session"), {
      DB,
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { code: "FORBIDDEN" } });
    expect(getCurrentSession).not.toHaveBeenCalled();
  });

  it("only allows the development bypass on an exact HTTP loopback host", async () => {
    const response = await handleApiRequest(
      new Request("https://toki.example/api/v1/session"),
      LOCAL,
    );
    expect(response.status).toBe(403);
    expect(getCurrentSession).not.toHaveBeenCalled();
  });

  it("fails closed when D1 is not bound", async () => {
    const response = await handleApiRequest(request("/api/v1/session"), {
      LOCAL_AUTH_BYPASS: "enabled",
    });
    expect(response.status).toBe(503);
    expect(getCurrentSession).not.toHaveBeenCalled();
  });

  it("serves the open session with no-store headers and server time", async () => {
    vi.mocked(getCurrentSession).mockResolvedValue(null);
    const response = await handleApiRequest(request("/api/v1/session"), LOCAL);
    const result = (await response.json()) as { session: unknown; serverNowMs: number };
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(result.session).toBeNull();
    expect(Number.isSafeInteger(result.serverNowMs)).toBe(true);
    expect(getCurrentSession).toHaveBeenCalledWith(DB, result.serverNowMs);
  });

  it.each([
    ["missing Origin", { Origin: "" }],
    ["cross-origin", { Origin: "https://evil.example" }],
    ["missing client header", { "X-Toki-Client": "" }],
    ["non-JSON", { "Content-Type": "text/plain" }],
  ])("rejects mutation with %s", async (_label, headers) => {
    const response = await handleApiRequest(
      request(
        "/api/v1/session",
        "POST",
        { mode: "stopwatch", clientRequestId: REQUEST_ID },
        headers,
      ),
      LOCAL,
    );
    expect(response.status).toBe(403);
    expect(startSession).not.toHaveBeenCalled();
  });

  it("validates the start payload and calls the idempotent data operation", async () => {
    const invalid = await handleApiRequest(
      request("/api/v1/session", "POST", { mode: "timer" }),
      LOCAL,
    );
    expect(invalid.status).toBe(400);
    expect(startSession).not.toHaveBeenCalled();

    vi.mocked(startSession).mockResolvedValue({ id: SESSION_ID } as never);
    const response = await handleApiRequest(
      request("/api/v1/session", "POST", { mode: "stopwatch", clientRequestId: REQUEST_ID }),
      LOCAL,
    );
    expect(response.status).toBe(201);
    expect(startSession).toHaveBeenCalledWith(
      DB,
      { mode: "stopwatch", clientRequestId: REQUEST_ID },
      expect.any(Number),
    );
    expect((await response.json()) as object).toMatchObject({ session: { id: SESSION_ID } });
  });

  it("routes stop, save and discard through validated state transitions", async () => {
    vi.mocked(stopSession).mockResolvedValue({
      id: SESSION_ID,
      status: "awaiting_description",
    } as never);
    vi.mocked(saveSession).mockResolvedValue({ id: SESSION_ID, status: "saved" } as never);
    vi.mocked(discardSession).mockResolvedValue({ id: SESSION_ID, status: "discarded" } as never);
    const stop = await handleApiRequest(
      request(`/api/v1/session/${SESSION_ID}/stop`, "POST", {}),
      LOCAL,
    );
    const save = await handleApiRequest(
      request(`/api/v1/session/${SESSION_ID}/save`, "POST", { description: "Work" }),
      LOCAL,
    );
    const discard = await handleApiRequest(
      request(`/api/v1/session/${SESSION_ID}/discard`, "POST", {}),
      LOCAL,
    );
    expect([stop.status, save.status, discard.status]).toEqual([200, 200, 200]);
    expect(stopSession).toHaveBeenCalledWith(DB, SESSION_ID, expect.any(Number));
    expect(saveSession).toHaveBeenCalledWith(DB, SESSION_ID, "Work", expect.any(Number));
    expect(discardSession).toHaveBeenCalledWith(DB, SESSION_ID, expect.any(Number));
  });

  it("validates half-open interval queries and saved-record edits", async () => {
    vi.mocked(listSavedRecords).mockResolvedValue([]);
    vi.mocked(editSavedRecord).mockResolvedValue({ id: SESSION_ID, version: 2 } as never);
    const invalid = await handleApiRequest(
      request("/api/v1/records?startMs=2000&endMs=1000"),
      LOCAL,
    );
    const valid = await handleApiRequest(request("/api/v1/records?startMs=1000&endMs=2000"), LOCAL);
    const edit = await handleApiRequest(
      request(`/api/v1/records/${SESSION_ID}`, "PATCH", {
        startedAtMs: 1000,
        endedAtMs: 2000,
        description: "Work",
        expectedVersion: 1,
      }),
      LOCAL,
    );
    expect([invalid.status, valid.status, edit.status]).toEqual([400, 200, 200]);
    expect(listSavedRecords).toHaveBeenCalledWith(DB, 1000, 2000);
    expect(editSavedRecord).toHaveBeenCalledWith(
      DB,
      SESSION_ID,
      { startedAtMs: 1000, endedAtMs: 2000, description: "Work", expectedVersion: 1 },
      expect.any(Number),
    );
  });

  it("rejects duplicate query keys and unsupported routes/methods", async () => {
    const duplicate = await handleApiRequest(
      request("/api/v1/records?startMs=1&startMs=2&endMs=3"),
      LOCAL,
    );
    const unsupported = await handleApiRequest(request("/api/v1/unknown"), LOCAL);
    const method = await handleApiRequest(request("/api/v1/session", "DELETE", {}), LOCAL);
    expect([duplicate.status, unsupported.status, method.status]).toEqual([400, 404, 405]);
  });

  it("maps conflict and unexpected storage failures without leaking details", async () => {
    vi.mocked(getCurrentSession).mockRejectedValueOnce(
      new TokiDataError("conflict", "private detail"),
    );
    vi.mocked(getCurrentSession).mockRejectedValueOnce(new Error("private SQL secret"));
    const conflict = await handleApiRequest(request("/api/v1/session"), LOCAL);
    const internal = await handleApiRequest(request("/api/v1/session"), LOCAL);
    expect(conflict.status).toBe(409);
    expect(await conflict.text()).not.toContain("private detail");
    expect(internal.status).toBe(500);
    expect(await internal.text()).not.toContain("private SQL secret");
  });
});
