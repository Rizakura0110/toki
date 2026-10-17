import type { MeasurementSession } from "./api";

export function formatDuration(durationMs: number): string {
  const seconds = Math.floor(Math.max(0, Number.isFinite(durationMs) ? durationMs : 0) / 1000);
  return `${String(Math.floor(seconds / 3600)).padStart(2, "0")}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
export function durationForDisplay(session: MeasurementSession, nowMs: number): number {
  if (session.status === "running")
    return session.mode === "timer"
      ? Math.max(0, (session.deadlineAtMs ?? nowMs) - nowMs)
      : Math.max(0, nowMs - session.startedAtMs);
  return Math.max(0, (session.endedAtMs ?? session.startedAtMs) - session.startedAtMs);
}
export function estimateServerNowAtReceive(
  serverNowMs: number,
  started: number,
  received: number,
): number {
  return serverNowMs + Math.max(0, received - started) / 2;
}
export function timerDuration(fields: readonly string[]): number | null {
  if (fields.length !== 3 || fields.some((value) => value.trim() === "")) return null;
  const [hours, minutes, seconds] = fields.map(Number);
  if (
    hours === undefined ||
    minutes === undefined ||
    seconds === undefined ||
    ![hours, minutes, seconds].every(Number.isInteger) ||
    hours < 0 ||
    hours > 24 ||
    minutes < 0 ||
    minutes > 59 ||
    seconds < 0 ||
    seconds > 59
  )
    return null;
  const total = hours * 3600 + minutes * 60 + seconds;
  return total >= 1 && total <= 86400 ? total : null;
}
