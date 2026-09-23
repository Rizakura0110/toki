import { describe, expect, it } from "vitest";
import {
  editRecordSchema,
  recordIdSchema,
  recordsQuerySchema,
  saveSessionSchema,
  sessionIdSchema,
  startSessionSchema,
} from "./api";

const REQUEST_ID = "550e8400-e29b-41d4-a716-446655440000";
const START_MS = Date.UTC(2026, 8, 23);
const DAY_MS = 24 * 60 * 60 * 1_000;

describe("session request contracts", () => {
  it("accepts a stopwatch request with a retry identifier", () => {
    expect(startSessionSchema.parse({ mode: "stopwatch", clientRequestId: REQUEST_ID })).toEqual({
      mode: "stopwatch",
      clientRequestId: REQUEST_ID,
    });
  });

  it("accepts timer bounds and rejects missing, fractional, or out-of-range durations", () => {
    for (const timerSeconds of [1, 86_400]) {
      expect(
        startSessionSchema.safeParse({ mode: "timer", timerSeconds, clientRequestId: REQUEST_ID })
          .success,
      ).toBe(true);
    }
    for (const timerSeconds of [undefined, 0, 0.5, 86_401]) {
      expect(
        startSessionSchema.safeParse({ mode: "timer", timerSeconds, clientRequestId: REQUEST_ID })
          .success,
      ).toBe(false);
    }
  });

  it("rejects unknown modes, malformed retry identifiers, and extra fields", () => {
    expect(
      startSessionSchema.safeParse({ mode: "countdown", clientRequestId: REQUEST_ID }).success,
    ).toBe(false);
    expect(startSessionSchema.safeParse({ mode: "stopwatch", clientRequestId: "a" }).success).toBe(
      false,
    );
    expect(
      startSessionSchema.safeParse({
        mode: "stopwatch",
        timerSeconds: 10,
        clientRequestId: REQUEST_ID,
      }).success,
    ).toBe(false);
    expect(
      startSessionSchema.safeParse({
        mode: "timer",
        timerSeconds: 10,
        clientRequestId: REQUEST_ID,
        admin: true,
      }).success,
    ).toBe(false);
  });

  it("accepts UUID path identifiers only", () => {
    expect(sessionIdSchema.safeParse(REQUEST_ID).success).toBe(true);
    expect(recordIdSchema.safeParse(REQUEST_ID).success).toBe(true);
    expect(sessionIdSchema.safeParse("../other").success).toBe(false);
    expect(recordIdSchema.safeParse(123).success).toBe(false);
  });
});

describe("saved record request contracts", () => {
  it("trims meaningful descriptions and bounds their length", () => {
    expect(saveSessionSchema.parse({ description: "  作業  " })).toEqual({ description: "作業" });
    expect(saveSessionSchema.safeParse({ description: "   " }).success).toBe(false);
    expect(saveSessionSchema.safeParse({ description: "a".repeat(500) }).success).toBe(true);
    expect(saveSessionSchema.safeParse({ description: "a".repeat(501) }).success).toBe(false);
    expect(saveSessionSchema.safeParse({ description: "作業", extra: true }).success).toBe(false);
  });

  it("accepts a bounded edit and rejects chronology, duration, version, and unknown fields", () => {
    const valid = {
      startedAtMs: START_MS,
      endedAtMs: START_MS + 366 * DAY_MS,
      description: "集中",
      expectedVersion: 1,
    };
    expect(editRecordSchema.safeParse(valid).success).toBe(true);
    expect(editRecordSchema.safeParse({ ...valid, endedAtMs: START_MS }).success).toBe(false);
    expect(editRecordSchema.safeParse({ ...valid, endedAtMs: START_MS - 1 }).success).toBe(false);
    expect(
      editRecordSchema.safeParse({ ...valid, endedAtMs: START_MS + 366 * DAY_MS + 1 }).success,
    ).toBe(false);
    expect(editRecordSchema.safeParse({ ...valid, startedAtMs: 1.5 }).success).toBe(false);
    expect(editRecordSchema.safeParse({ ...valid, expectedVersion: 0 }).success).toBe(false);
    expect(editRecordSchema.safeParse({ ...valid, extra: true }).success).toBe(false);
  });
});

describe("calendar query contract", () => {
  it("accepts decimal URLSearchParams-derived strings and transforms to epoch milliseconds", () => {
    const query = Object.fromEntries(
      new URLSearchParams({ startMs: String(START_MS), endMs: String(START_MS + 7 * DAY_MS) }),
    );
    expect(recordsQuerySchema.parse(query)).toEqual({
      startMs: START_MS,
      endMs: START_MS + 7 * DAY_MS,
    });
  });

  it("allows a 366-day half-open range but rejects invalid bounds and unknown keys", () => {
    const valid = { startMs: String(START_MS), endMs: String(START_MS + 366 * DAY_MS) };
    expect(recordsQuerySchema.safeParse(valid).success).toBe(true);
    for (const endMs of [START_MS, START_MS - 1, START_MS + 366 * DAY_MS + 1]) {
      expect(recordsQuerySchema.safeParse({ ...valid, endMs: String(endMs) }).success).toBe(false);
    }
    for (const startMs of ["0", `0${START_MS}`, ` ${START_MS}`, "1.5", "9007199254740993"]) {
      expect(recordsQuerySchema.safeParse({ ...valid, startMs }).success).toBe(false);
    }
    expect(recordsQuerySchema.safeParse({ ...valid, unknown: "1" }).success).toBe(false);
  });
});
