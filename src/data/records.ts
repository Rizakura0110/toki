/** D1-backed measurement sessions and the saved records derived from them. */
import { and, asc, eq, getTableColumns, gt, lt, lte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { isTimeTag, type TimeTag } from "../contracts/tags";
import {
  deletedClientRequestIds,
  openSessionPredicate,
  savedRecordPredicate,
  timeSessions,
} from "./schema";

export const MAX_TIMER_SECONDS = 24 * 60 * 60;
export const MAX_RECORD_MS = 366 * 24 * 60 * 60 * 1000;
export const MAX_DESCRIPTION_LENGTH = 500;

export type SessionMode = TokiSession["mode"];
export type MeasurementMode = Exclude<SessionMode, "manual">;
export type SessionStatus = TokiSession["status"];
type SessionRow = Readonly<typeof timeSessions.$inferSelect>;
export type TokiSession = Omit<SessionRow, "startTag">;
const { startTag: _startTag, ...sessionColumns } = getTableColumns(timeSessions);

function publicSession({ startTag: _startTag, ...session }: SessionRow): TokiSession {
  return session;
}

export type TokiDataErrorCode = "validation" | "conflict" | "not_found";

export class TokiDataError extends Error {
  readonly code: TokiDataErrorCode;
  readonly currentSession?: TokiSession;

  constructor(code: TokiDataErrorCode, message: string, currentSession?: TokiSession) {
    super(message);
    this.name = "TokiDataError";
    this.code = code;
    if (currentSession) this.currentSession = currentSession;
  }
}

export interface StartSessionInput {
  readonly mode: MeasurementMode;
  readonly timerSeconds?: number;
  readonly clientRequestId: string;
  readonly description?: string | undefined;
  readonly tag?: TimeTag | null | undefined;
}

export interface CreateManualRecordInput {
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly description: string;
  readonly clientRequestId: string;
  readonly tag?: TimeTag | null | undefined;
}

export interface EditSavedRecordInput {
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly description: string;
  readonly expectedVersion: number;
  readonly tag?: TimeTag | null | undefined;
}

function validInstant(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function requireNow(nowMs: number): void {
  if (!validInstant(nowMs)) {
    throw new TokiDataError("validation", "Invalid server time");
  }
}

function requireId(id: string): void {
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) {
    throw new TokiDataError("validation", "Invalid session ID");
  }
}

function normalizeDescription(value: string): string {
  if (typeof value !== "string") {
    throw new TokiDataError("validation", "Description is required");
  }
  const description = value.trim();
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw new TokiDataError("validation", "Description must be at most 500 characters");
  }
  // Keep the existing saved-record DB constraint and old clients compatible.
  return description || "無題";
}

function normalizeDraftDescription(value: string | undefined): string | null {
  if (value === undefined) return null;
  // Reuse validation, but an empty start must remain an empty draft, not "無題".
  normalizeDescription(value);
  return value.trim() || null;
}

function normalizeTag(value: TimeTag | null | undefined): TimeTag | null {
  if (value === undefined || value === null) return null;
  if (!isTimeTag(value)) throw new TokiDataError("validation", "Invalid time tag");
  return value;
}

function requireInterval(startedAtMs: number, endedAtMs: number): void {
  if (
    !validInstant(startedAtMs) ||
    !validInstant(endedAtMs) ||
    endedAtMs <= startedAtMs ||
    endedAtMs - startedAtMs > MAX_RECORD_MS
  ) {
    throw new TokiDataError("validation", "Invalid record interval");
  }
}

function requireVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new TokiDataError("validation", "Invalid record version");
  }
}

function requireStartInput(input: StartSessionInput, nowMs: number): void {
  requireNow(nowMs);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.clientRequestId)) {
    throw new TokiDataError("validation", "Invalid client request ID");
  }
  if (input.mode === "stopwatch") {
    if (input.timerSeconds !== undefined) {
      throw new TokiDataError("validation", "Stopwatch cannot have a timer duration");
    }
    return;
  }
  if (
    input.mode !== "timer" ||
    !Number.isSafeInteger(input.timerSeconds) ||
    input.timerSeconds === undefined ||
    input.timerSeconds < 1 ||
    input.timerSeconds > MAX_TIMER_SECONDS ||
    !Number.isSafeInteger(nowMs + input.timerSeconds * 1000)
  ) {
    throw new TokiDataError("validation", "Timer duration must be 1 to 86400 seconds");
  }
}

async function selectById(db: D1Database, id: string): Promise<TokiSession | null> {
  return (
    (await drizzle(db)
      .select(sessionColumns)
      .from(timeSessions)
      .where(eq(timeSessions.id, id))
      .limit(1)
      .get()) ?? null
  );
}

async function selectByRequestId(db: D1Database, requestId: string): Promise<SessionRow | null> {
  return (
    (await drizzle(db)
      .select()
      .from(timeSessions)
      .where(eq(timeSessions.clientRequestId, requestId))
      .limit(1)
      .get()) ?? null
  );
}

async function materializeExpiredTimer(db: D1Database, nowMs: number): Promise<void> {
  await drizzle(db)
    .update(timeSessions)
    .set({
      status: "awaiting_description",
      endedAtMs: timeSessions.deadlineAtMs,
      updatedAtMs: nowMs,
      version: sql`${timeSessions.version} + 1`,
    })
    .where(
      and(
        openSessionPredicate,
        eq(timeSessions.status, "running"),
        eq(timeSessions.mode, "timer"),
        lte(timeSessions.deadlineAtMs, nowMs),
      ),
    )
    .run();
}

/** Resolve a timer deadline on demand; no background Worker or per-second writes. */
export async function getCurrentSession(
  db: D1Database,
  nowMs: number,
): Promise<TokiSession | null> {
  requireNow(nowMs);
  await materializeExpiredTimer(db, nowMs);
  return (
    (await drizzle(db)
      .select(sessionColumns)
      .from(timeSessions)
      .where(openSessionPredicate)
      .limit(1)
      .get()) ?? null
  );
}

export async function getSession(
  db: D1Database,
  id: string,
  nowMs: number,
): Promise<TokiSession | null> {
  requireId(id);
  requireNow(nowMs);
  await materializeExpiredTimer(db, nowMs);
  return selectById(db, id);
}

/** Unique request ID and partial unique index make retries and two-tab starts safe. */
export async function startSession(
  db: D1Database,
  input: StartSessionInput,
  nowMs: number,
): Promise<TokiSession> {
  requireStartInput(input, nowMs);
  const draftDescription = normalizeDraftDescription(input.description);
  const tag = normalizeTag(input.tag);
  const matchesStart = (row: SessionRow) =>
    row.mode === input.mode &&
    row.timerSeconds === (input.timerSeconds ?? null) &&
    row.draftDescription === draftDescription &&
    row.startTag === tag;
  const current = await getCurrentSession(db, nowMs);
  const existing = await selectByRequestId(db, input.clientRequestId);
  if (existing) {
    if (!matchesStart(existing)) {
      throw new TokiDataError("conflict", "Request ID was used with different settings");
    }
    return publicSession(existing);
  }

  if (current) {
    throw new TokiDataError("conflict", "An unfinished session already exists", current);
  }

  const id = crypto.randomUUID();
  const timerSeconds = input.timerSeconds ?? null;
  const deadlineAtMs = timerSeconds === null ? null : nowMs + timerSeconds * 1000;
  // Keep OR IGNORE and the tombstone anti-check in one statement. Splitting the
  // check from the insert would allow a concurrent replay to resurrect a record.
  // Drizzle's bound SQL preserves the old conflict semantics, including CHECK.
  await drizzle(db).run(sql`INSERT OR IGNORE INTO ${timeSessions}
       (id, client_request_id, mode, status, started_at_ms, timer_seconds,
        deadline_at_ms, ended_at_ms, description, version, created_at_ms, updated_at_ms,
        draft_description, tag, start_tag)
       SELECT ${id}, ${input.clientRequestId}, ${input.mode}, 'running', ${nowMs}, ${timerSeconds}, ${deadlineAtMs}, NULL, NULL, 1, ${nowMs}, ${nowMs}, ${draftDescription}, ${tag}, ${tag}
       WHERE NOT EXISTS (
         SELECT 1 FROM ${deletedClientRequestIds} WHERE ${deletedClientRequestIds.clientRequestId} = ${input.clientRequestId}
       )`);

  const result = await selectByRequestId(db, input.clientRequestId);
  if (result) {
    if (!matchesStart(result)) {
      throw new TokiDataError("conflict", "Request ID was used with different settings");
    }
    return publicSession(result);
  }
  throw new TokiDataError(
    "conflict",
    "An unfinished session already exists",
    (await getCurrentSession(db, nowMs)) ?? undefined,
  );
}

export async function stopSession(db: D1Database, id: string, nowMs: number): Promise<TokiSession> {
  const session = await getSession(db, id, nowMs);
  if (!session) throw new TokiDataError("not_found", "Session not found");
  if (session.status === "awaiting_description" || session.status === "saved") return session;
  if (session.status !== "running") {
    throw new TokiDataError("conflict", "Session has already been discarded");
  }
  const endedAtMs = Math.max(
    session.startedAtMs + 1,
    Math.min(nowMs, session.deadlineAtMs ?? Number.POSITIVE_INFINITY),
  );
  await drizzle(db)
    .update(timeSessions)
    .set({
      status: "awaiting_description",
      endedAtMs,
      updatedAtMs: nowMs,
      version: sql`${timeSessions.version} + 1`,
    })
    .where(
      and(
        eq(timeSessions.id, id),
        eq(timeSessions.status, "running"),
        eq(timeSessions.version, session.version),
      ),
    )
    .run();
  const result = await selectById(db, id);
  if (!result) throw new TokiDataError("not_found", "Session not found");
  if (result.status === "awaiting_description" || result.status === "saved") return result;
  throw new TokiDataError("conflict", "Session state changed");
}

export async function saveSession(
  db: D1Database,
  id: string,
  descriptionInput: string,
  nowMs: number,
  tagInput?: TimeTag | null,
): Promise<TokiSession> {
  const description = normalizeDescription(descriptionInput);
  const normalizedTag = normalizeTag(tagInput);
  const session = await getSession(db, id, nowMs);
  if (!session) throw new TokiDataError("not_found", "Session not found");
  const tag = tagInput === undefined ? session.tag : normalizedTag;
  if (session.status === "saved" && session.description === description && session.tag === tag)
    return session;
  if (session.status !== "awaiting_description" || session.endedAtMs === null) {
    throw new TokiDataError("conflict", "Session is not awaiting a description");
  }
  requireInterval(session.startedAtMs, session.endedAtMs);
  await drizzle(db)
    .update(timeSessions)
    .set({
      status: "saved",
      description,
      tag,
      updatedAtMs: nowMs,
      version: sql`${timeSessions.version} + 1`,
    })
    .where(
      and(
        eq(timeSessions.id, id),
        eq(timeSessions.status, "awaiting_description"),
        eq(timeSessions.version, session.version),
      ),
    )
    .run();
  const result = await selectById(db, id);
  if (!result) throw new TokiDataError("not_found", "Session not found");
  if (result.status === "saved" && result.description === description && result.tag === tag)
    return result;
  throw new TokiDataError("conflict", "Session state changed");
}

export async function discardSession(
  db: D1Database,
  id: string,
  nowMs: number,
): Promise<TokiSession> {
  const session = await getSession(db, id, nowMs);
  if (!session) throw new TokiDataError("not_found", "Session not found");
  if (session.status === "discarded") return session;
  if (session.status !== "awaiting_description") {
    throw new TokiDataError("conflict", "Only an unsaved stopped session can be discarded");
  }
  await drizzle(db)
    .update(timeSessions)
    .set({ status: "discarded", updatedAtMs: nowMs, version: sql`${timeSessions.version} + 1` })
    .where(
      and(
        eq(timeSessions.id, id),
        eq(timeSessions.status, "awaiting_description"),
        eq(timeSessions.version, session.version),
      ),
    )
    .run();
  const result = await selectById(db, id);
  if (!result) throw new TokiDataError("not_found", "Session not found");
  if (result.status === "discarded") return result;
  throw new TokiDataError("conflict", "Session state changed");
}

/** A request UUID prevents a network retry from adding a second manual record. */
export async function createManualRecord(
  db: D1Database,
  input: CreateManualRecordInput,
  nowMs: number,
): Promise<TokiSession> {
  requireNow(nowMs);
  requireId(input.clientRequestId);
  requireInterval(input.startedAtMs, input.endedAtMs);
  const description = normalizeDescription(input.description);
  const tag = normalizeTag(input.tag);
  const id = crypto.randomUUID();
  // Same atomic, parameterized insertion as startSession; see the comment there.
  await drizzle(db).run(sql`INSERT OR IGNORE INTO ${timeSessions}
       (id, client_request_id, mode, status, started_at_ms, timer_seconds,
        deadline_at_ms, ended_at_ms, description, version, created_at_ms, updated_at_ms, tag)
       SELECT ${id}, ${input.clientRequestId}, 'manual', 'saved', ${input.startedAtMs}, NULL, NULL, ${input.endedAtMs}, ${description}, 1, ${nowMs}, ${nowMs}, ${tag}
       WHERE NOT EXISTS (
         SELECT 1 FROM ${deletedClientRequestIds} WHERE ${deletedClientRequestIds.clientRequestId} = ${input.clientRequestId}
       )`);

  const row = await selectByRequestId(db, input.clientRequestId);
  if (
    row?.mode === "manual" &&
    row.status === "saved" &&
    row.startedAtMs === input.startedAtMs &&
    row.endedAtMs === input.endedAtMs &&
    row.description === description &&
    row.tag === tag
  ) {
    return publicSession(row);
  }
  throw new TokiDataError("conflict", "Request ID has already been used");
}

/** Optimistic version check prevents two tabs silently overwriting saved edits. */
export async function editSavedRecord(
  db: D1Database,
  id: string,
  input: EditSavedRecordInput,
  nowMs: number,
): Promise<TokiSession> {
  requireId(id);
  requireNow(nowMs);
  requireInterval(input.startedAtMs, input.endedAtMs);
  requireVersion(input.expectedVersion);
  const description = normalizeDescription(input.description);
  const tag = normalizeTag(input.tag);
  const update = await drizzle(db)
    .update(timeSessions)
    .set({
      startedAtMs: input.startedAtMs,
      endedAtMs: input.endedAtMs,
      description,
      ...(input.tag === undefined ? {} : { tag }),
      updatedAtMs: nowMs,
      version: sql`${timeSessions.version} + 1`,
    })
    .where(
      and(
        eq(timeSessions.id, id),
        savedRecordPredicate,
        eq(timeSessions.version, input.expectedVersion),
      ),
    )
    .run();
  const result = await selectById(db, id);
  if (!result) throw new TokiDataError("not_found", "Record not found");
  if (update.meta.changes !== 1 || result.status !== "saved") {
    throw new TokiDataError("conflict", "Record was changed by another request");
  }
  return result;
}

/** Deletion and its request-ID tombstone happen in one SQLite statement. */
export async function deleteSavedRecord(
  db: D1Database,
  id: string,
  expectedVersion: number,
): Promise<void> {
  requireId(id);
  requireVersion(expectedVersion);
  const deletion = await drizzle(db)
    .delete(timeSessions)
    .where(
      and(eq(timeSessions.id, id), savedRecordPredicate, eq(timeSessions.version, expectedVersion)),
    )
    .run();
  // D1 includes the trigger's request-ID insert in its reported change count.
  if (deletion.meta.changes > 0) return;

  const current = await selectById(db, id);
  if (current?.status === "saved") {
    throw new TokiDataError("conflict", "Record was changed by another request");
  }
  throw new TokiDataError("not_found", "Record not found");
}

/** Half-open [start,end) range: records ending exactly at start are excluded. */
export async function listSavedRecords(
  db: D1Database,
  startMs: number,
  endMs: number,
): Promise<TokiSession[]> {
  requireInterval(startMs, endMs);
  return drizzle(db)
    .select(sessionColumns)
    .from(timeSessions)
    .where(
      and(
        savedRecordPredicate,
        lt(timeSessions.startedAtMs, endMs),
        gt(timeSessions.endedAtMs, startMs),
      ),
    )
    .orderBy(asc(timeSessions.startedAtMs), asc(timeSessions.id))
    .all();
}
