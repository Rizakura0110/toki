import { isTimeTag, type TimeTag } from "../contracts/tags";

export type MeasurementMode = "stopwatch" | "timer";
export interface MeasurementSession {
  readonly id: string;
  readonly mode: MeasurementMode;
  readonly status: "running" | "awaiting_description" | "saved" | "discarded";
  readonly startedAtMs: number;
  readonly deadlineAtMs: number | null;
  readonly endedAtMs: number | null;
  readonly timerSeconds: number | null;
  readonly draftDescription: string | null;
  readonly tag: TimeTag | null;
}
export interface CalendarRecord {
  readonly id: string;
  readonly status: "saved";
  readonly mode: MeasurementMode | "manual";
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly description: string;
  readonly version: number;
  readonly tag: TimeTag | null;
}
export interface SessionEnvelope {
  readonly session: MeasurementSession | null;
  readonly serverNowMs: number;
}
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = "ApiError";
  }
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isSession(value: unknown): value is MeasurementSession {
  return (
    isObject(value) &&
    typeof value.id === "string" &&
    (value.mode === "stopwatch" || value.mode === "timer") &&
    ["running", "awaiting_description", "saved", "discarded"].includes(String(value.status)) &&
    Number.isSafeInteger(value.startedAtMs) &&
    (value.deadlineAtMs === null || Number.isSafeInteger(value.deadlineAtMs)) &&
    (value.endedAtMs === null || Number.isSafeInteger(value.endedAtMs)) &&
    (value.timerSeconds === null || Number.isSafeInteger(value.timerSeconds)) &&
    (value.draftDescription === undefined ||
      value.draftDescription === null ||
      (typeof value.draftDescription === "string" && value.draftDescription.length <= 500)) &&
    (value.tag === undefined || value.tag === null || isTimeTag(value.tag))
  );
}
export function readSessionEnvelope(value: unknown): SessionEnvelope {
  if (
    !isObject(value) ||
    !Number.isSafeInteger(value.serverNowMs) ||
    (value.session !== null && !isSession(value.session))
  )
    throw new Error("INVALID_RESPONSE");
  const envelope = value as unknown as SessionEnvelope;
  return {
    ...envelope,
    session: envelope.session
      ? {
          ...envelope.session,
          draftDescription: envelope.session.draftDescription ?? null,
          tag: envelope.session.tag ?? null,
        }
      : null,
  };
}
export function readRecords(value: unknown): CalendarRecord[] {
  if (!isObject(value) || !Array.isArray(value.records)) throw new Error("INVALID_RESPONSE");
  return value.records.map((record: unknown) => {
    if (
      !isObject(record) ||
      typeof record.id !== "string" ||
      record.status !== "saved" ||
      !["stopwatch", "timer", "manual"].includes(String(record.mode)) ||
      !Number.isSafeInteger(record.startedAtMs) ||
      !Number.isSafeInteger(record.endedAtMs) ||
      typeof record.description !== "string" ||
      (record.tag !== undefined && record.tag !== null && !isTimeTag(record.tag)) ||
      !Number.isSafeInteger(record.version) ||
      Number(record.version) < 1 ||
      Number(record.endedAtMs) <= Number(record.startedAtMs)
    )
      throw new Error("INVALID_RESPONSE");
    return { ...record, tag: record.tag ?? null } as unknown as CalendarRecord;
  });
}
export async function requestJson(path: string, method = "GET", body?: object): Promise<unknown> {
  const options: RequestInit = { method, credentials: "same-origin", cache: "no-store" };
  if (method !== "GET") {
    options.headers = { "Content-Type": "application/json", "X-Toki-Client": "web" };
    options.body = JSON.stringify(body ?? {});
  }
  const response = await fetch(path, options);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    if (response.status === 401 || response.status === 403)
      throw new ApiError(response.status, "UNAUTHORIZED");
    throw new Error("INVALID_RESPONSE");
  }
  if (!response.ok) {
    const code = isObject(payload) && isObject(payload.error) ? payload.error.code : undefined;
    throw new ApiError(response.status, typeof code === "string" ? code : "REQUEST_FAILED");
  }
  return payload;
}
