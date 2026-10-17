import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, readRecords, readSessionEnvelope, requestJson } from "./api";
import { timerDuration } from "./time";

afterEach(() => vi.unstubAllGlobals());
const session = {
  id: "session",
  mode: "stopwatch",
  status: "running",
  startedAtMs: 1000,
  deadlineAtMs: null,
  endedAtMs: null,
  timerSeconds: null,
};
const record = {
  ...session,
  mode: "manual",
  status: "saved",
  endedAtMs: 2000,
  description: "無題",
  version: 1,
};

describe("browser response boundaries", () => {
  it("accepts null or supported session states without exposing other server fields", () => {
    expect(readSessionEnvelope({ session: null, serverNowMs: 2000 }).session).toBeNull();
    for (const status of ["running", "awaiting_description", "saved", "discarded"]) {
      expect(
        readSessionEnvelope({ session: { ...session, status }, serverNowMs: 2000 }).session?.status,
      ).toBe(status);
    }
    expect(
      readSessionEnvelope({
        session: {
          ...session,
          mode: "timer",
          timerSeconds: 1,
          deadlineAtMs: 2000,
          endedAtMs: 2000,
        },
        serverNowMs: 2000,
      }).session?.mode,
    ).toBe("timer");
  });
  it.each([
    null,
    [],
    {},
    { session: {}, serverNowMs: 1 },
    { session, serverNowMs: "1" },
    { session: { ...session, mode: "manual" }, serverNowMs: 1 },
    { session: { ...session, endedAtMs: "1" }, serverNowMs: 1 },
  ])("rejects malformed session envelopes: %j", (value) => {
    expect(() => readSessionEnvelope(value)).toThrow("INVALID_RESPONSE");
  });
  it("accepts all calendar modes and an empty range", () => {
    expect(readRecords({ records: [] })).toEqual([]);
    for (const mode of ["manual", "timer", "stopwatch"])
      expect(readRecords({ records: [{ ...record, mode }] })[0]?.mode).toBe(mode);
  });
  it.each([
    null,
    {},
    { records: {} },
    { records: [null] },
    { records: [{ ...record, endedAtMs: 1000 }] },
    { records: [{ ...record, description: null }] },
    { records: [{ ...record, version: 0 }] },
    { records: [{ ...record, mode: "other" }] },
  ])("rejects malformed calendar responses: %j", (value) => {
    expect(() => readRecords(value)).toThrow("INVALID_RESPONSE");
  });
  it("keeps credentials same-origin and reads uncached, without mutation headers on GET", async () => {
    const fetch = vi.fn().mockImplementation(async () => Response.json({ records: [] }));
    vi.stubGlobal("fetch", fetch);
    expect(await requestJson("/api/v1/records")).toEqual({ records: [] });
    expect(fetch).toHaveBeenCalledWith("/api/v1/records", {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
    });
    await requestJson("/api/v1/session", "POST");
    expect(fetch).toHaveBeenLastCalledWith(
      "/api/v1/session",
      expect.objectContaining({
        body: "{}",
        headers: { "Content-Type": "application/json", "X-Toki-Client": "web" },
      }),
    );
  });
  it.each([401, 403])("recognizes non-JSON login responses (%i)", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("login", { status })));
    await expect(requestJson("/api/v1/session")).rejects.toMatchObject({
      status,
      code: "UNAUTHORIZED",
    });
  });
  it("distinguishes invalid JSON, network errors and API error codes", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("not json"))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(Response.json({ error: { code: "CONFLICT" } }, { status: 409 }))
      .mockResolvedValueOnce(Response.json({}, { status: 500 }));
    vi.stubGlobal("fetch", fetch);
    await expect(requestJson("/api/v1/session")).rejects.toThrow("INVALID_RESPONSE");
    await expect(requestJson("/api/v1/session")).rejects.toThrow("offline");
    await expect(requestJson("/api/v1/session")).rejects.toEqual(new ApiError(409, "CONFLICT"));
    await expect(requestJson("/api/v1/session")).rejects.toMatchObject({ code: "REQUEST_FAILED" });
  });
});

describe("timer form validation", () => {
  it.each([
    ["0", "0", "1"],
    ["24", "0", "0"],
    ["1", "2", "3"],
  ])("accepts valid fields %j", (...fields) => {
    expect(timerDuration(fields)).toBe(
      Number(fields[0]) * 3600 + Number(fields[1]) * 60 + Number(fields[2]),
    );
  });
  it.each([
    ["0", "0", "0"],
    ["24", "0", "1"],
    ["-1", "0", "1"],
    ["0", "60", "0"],
    ["0", "0", "60"],
    ["0.5", "0", "0"],
    ["", "1", "0"],
    ["0", "0", "NaN"],
    ["1", "0"],
  ])("rejects invalid fields %j", (...fields) => {
    expect(timerDuration(fields)).toBeNull();
  });
});
