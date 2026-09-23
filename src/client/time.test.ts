import { describe, expect, it } from "vitest";
import {
  durationForDisplay,
  estimateServerNowAtReceive,
  formatDuration,
} from "../../public/app.js";

describe("browser-only Toki clock presentation", () => {
  it("formats whole hours, minutes and seconds without trusting invalid time", () => {
    expect(formatDuration(3_661_999)).toBe("01:01:01");
    expect(formatDuration(-1)).toBe("00:00:00");
    expect(formatDuration(Number.NaN)).toBe("00:00:00");
  });

  it("derives a stopwatch from the server start instant, not tick counts", () => {
    expect(
      durationForDisplay(
        {
          id: "test",
          mode: "stopwatch",
          status: "running",
          startedAtMs: 1_000,
          endedAtMs: null,
          deadlineAtMs: null,
          timerSeconds: null,
        },
        8_500,
      ),
    ).toBe(7_500);
  });

  it("clamps a timer at zero and preserves the server-finished duration", () => {
    const timer = {
      id: "test",
      mode: "timer" as const,
      status: "running" as const,
      startedAtMs: 1_000,
      endedAtMs: null,
      deadlineAtMs: 11_000,
      timerSeconds: 10,
    };
    expect(durationForDisplay(timer, 6_000)).toBe(5_000);
    expect(durationForDisplay(timer, 12_000)).toBe(0);
    expect(
      durationForDisplay({ ...timer, status: "awaiting_description", endedAtMs: 11_000 }, 90_000),
    ).toBe(10_000);
  });

  it("compensates roughly half the transport time using the monotonic clock", () => {
    expect(estimateServerNowAtReceive(10_000, 100, 2_100)).toBe(11_000);
    expect(estimateServerNowAtReceive(10_000, 300, 200)).toBe(10_000);
  });
});
