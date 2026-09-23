import { describe, expect, it } from "vitest";
import {
  addDays,
  dayRange,
  formatTokyoDateTimeInput,
  layoutDayRecords,
  parseTokyoDateTimeInput,
  tokyoDateKey,
  weekRange,
  weekStart,
} from "../../public/calendar-core.js";

const hour = 60 * 60 * 1_000;

describe("Tokyo calendar arithmetic", () => {
  it("uses Japan midnight independently of the device's local time zone", () => {
    const { startMs, endMs } = dayRange("2026-09-23");
    expect(startMs).toBe(Date.UTC(2026, 8, 22, 15));
    expect(endMs).toBe(Date.UTC(2026, 8, 23, 15));
    expect(tokyoDateKey(startMs - 1)).toBe("2026-09-22");
    expect(tokyoDateKey(startMs)).toBe("2026-09-23");
    expect(tokyoDateKey(endMs - 1)).toBe("2026-09-23");
    expect(tokyoDateKey(endMs)).toBe("2026-09-24");
  });

  it("moves across leap days and year boundaries without relying on local Date methods", () => {
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2024-02-29", 1)).toBe("2024-03-01");
    expect(addDays("2025-01-01", -2)).toBe("2024-12-30");
    expect(weekStart("2025-01-01")).toBe("2024-12-30");
    expect(weekStart("2026-09-27")).toBe("2026-09-21");
    expect(weekStart("2026-09-21")).toBe("2026-09-21");
    expect(weekRange("2025-01-01")).toEqual({
      startMs: Date.UTC(2024, 11, 29, 15),
      endMs: Date.UTC(2025, 0, 5, 15),
    });
  });

  it("rejects invalid keys, offsets and instants instead of silently rolling over", () => {
    expect(() => dayRange("2025-02-29")).toThrow(RangeError);
    expect(() => addDays("2024-13-01", 1)).toThrow(RangeError);
    expect(() => addDays("2024-01-01", 0.5)).toThrow(RangeError);
    expect(() => tokyoDateKey(Number.NaN)).toThrow(RangeError);
    expect(() => formatTokyoDateTimeInput(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it("round-trips datetime-local seconds through UTC without a browser time-zone shift", () => {
    const epochMs = Date.UTC(2026, 8, 22, 15, 5, 9);
    expect(formatTokyoDateTimeInput(epochMs)).toBe("2026-09-23T00:05:09");
    expect(parseTokyoDateTimeInput("2026-09-23T00:05:09")).toBe(epochMs);
    expect(parseTokyoDateTimeInput("2026-09-23T00:05")).toBe(epochMs - 9_000);
    expect(formatTokyoDateTimeInput(epochMs + 999)).toBe("2026-09-23T00:05:09");
  });

  it.each([
    "2026-02-30T12:00",
    "2026-09-23T24:00",
    "2026-09-23T12:60",
    "2026-09-23T12:01:60",
    "2026-09-23T12:01:00.123",
    "2026-09-23T12:01Z",
    "2026-09-23 12:01",
    "not a date",
  ])("rejects malformed datetime-local value %s", (value) => {
    expect(parseTokyoDateTimeInput(value)).toBeNull();
  });
});

describe("day timeline layout", () => {
  const dateKey = "2026-09-23";
  const startMs = dayRange(dateKey).startMs;
  const record = (id: string, startHour: number, endHour: number) => ({
    id,
    startedAtMs: startMs + startHour * hour,
    endedAtMs: startMs + endHour * hour,
    description: id,
  });

  it("clips a cross-midnight record on both dates without splitting its identity", () => {
    const crossing = record("cross", -1, 1);
    const today = layoutDayRecords([crossing], dateKey);
    expect(today).toHaveLength(1);
    expect(today[0]?.record).toBe(crossing);
    expect(today[0]?.clippedStartMs).toBe(startMs);
    expect(today[0]?.clippedEndMs).toBe(startMs + hour);
    expect(today[0]?.topPercent).toBe(0);
    expect(today[0]?.heightPercent).toBeCloseTo(100 / 24);
    const yesterday = layoutDayRecords([crossing], "2026-09-22");
    expect(yesterday[0]?.topPercent).toBeCloseTo((23 / 24) * 100);
    expect(yesterday[0]?.clippedEndMs).toBe(startMs);
  });

  it("excludes intervals that merely touch the half-open day boundary", () => {
    expect(layoutDayRecords([record("past", -1, 0)], dateKey)).toEqual([]);
    expect(layoutDayRecords([record("future", 24, 25)], dateKey)).toEqual([]);
  });

  it("uses independent overlap groups and reuses lanes after touching endpoints", () => {
    const a = record("a", 9, 11);
    const b = record("b", 10, 12);
    const c = record("c", 11, 13);
    const later = record("later", 13, 14);
    const layout = layoutDayRecords([later, c, b, a], dateKey);
    expect(layout.map((item) => item.record.id)).toEqual(["a", "b", "c", "later"]);
    expect(layout.map((item) => item.widthPercent)).toEqual([50, 50, 50, 100]);
    expect(layout.map((item) => item.leftPercent)).toEqual([0, 50, 0, 0]);
    expect(
      layoutDayRecords([record("early", 8, 9), a], dateKey).map((item) => item.widthPercent),
    ).toEqual([100, 100]);
  });

  it("keeps stable ordering for equal intervals and makes tiny records visible", () => {
    const first = record("first", 23 + 59 / 60, 24);
    const second = record("second", 23 + 59 / 60, 24);
    const layout = layoutDayRecords([first, second], dateKey);
    expect(layout.map((item) => item.record.id)).toEqual(["first", "second"]);
    expect(layout.map((item) => item.widthPercent)).toEqual([50, 50]);
    expect(layout[0]?.heightPercent).toBeLessThan(0.1);
    expect(layout[0]?.visualHeightPercent).toBe(0.75);
    expect((layout[0]?.visualTopPercent ?? 0) + (layout[0]?.visualHeightPercent ?? 0)).toBe(100);
  });

  it("keeps enlarged targets for adjacent tiny records from covering each other", () => {
    const first = record("first", 9, 9 + 10 / 3600);
    const second = record("second", 9 + 10 / 3600, 9 + 20 / 3600);
    const layout = layoutDayRecords([first, second], dateKey);
    expect(layout.map((item) => item.widthPercent)).toEqual([100, 100]);
    expect(layout.map((item) => item.visualWidthPercent)).toEqual([50, 50]);
    expect(layout.map((item) => item.visualLeftPercent)).toEqual([0, 50]);
  });

  it("ignores invalid records so one bad interval cannot hide valid records", () => {
    const good = record("good", 1, 2);
    const bad = { id: "bad", startedAtMs: 200, endedAtMs: null };
    expect(layoutDayRecords([bad, good], dateKey).map((item) => item.record.id)).toEqual(["good"]);
  });
});
