/** D1-backed measurement sessions and the saved records derived from them. */

export const MAX_TIMER_SECONDS = 24 * 60 * 60;
export const MAX_RECORD_MS = 366 * 24 * 60 * 60 * 1000;
export const MAX_DESCRIPTION_LENGTH = 500;

export type SessionMode = "stopwatch" | "timer";
export type SessionStatus = "running" | "awaiting_description" | "saved" | "discarded";

export interface TokiSession {
  readonly id: string;
  readonly clientRequestId: string;
  readonly mode: SessionMode;
  readonly status: SessionStatus;
  readonly startedAtMs: number;
  readonly timerSeconds: number | null;
  readonly deadlineAtMs: number | null;
  readonly endedAtMs: number | null;
  readonly description: string | null;
  readonly version: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
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

interface SessionRow {
  id: string;
  client_request_id: string;
  mode: SessionMode;
  status: SessionStatus;
  started_at_ms: number;
  timer_seconds: number | null;
  deadline_at_ms: number | null;
  ended_at_ms: number | null;
  description: string | null;
  version: number;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface StartSessionInput {
  readonly mode: SessionMode;
  readonly timerSeconds?: number;
  readonly clientRequestId: string;
}

export interface EditSavedRecordInput {
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly description: string;
  readonly expectedVersion: number;
}

function rowToSession(row: SessionRow): TokiSession {
  return {
    id: row.id,
    clientRequestId: row.client_request_id,
    mode: row.mode,
    status: row.status,
    startedAtMs: row.started_at_ms,
    timerSeconds: row.timer_seconds,
    deadlineAtMs: row.deadline_at_ms,
    endedAtMs: row.ended_at_ms,
    description: row.description,
    version: row.version,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
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
  if (description.length < 1 || description.length > MAX_DESCRIPTION_LENGTH) {
    throw new TokiDataError("validation", "Description must be 1 to 500 characters");
  }
  return description;
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
  const row = await db
    .prepare("SELECT * FROM time_sessions WHERE id = ?")
    .bind(id)
    .first<SessionRow>();
  return row ? rowToSession(row) : null;
}

async function materializeExpiredTimer(db: D1Database, nowMs: number): Promise<void> {
  await db
    .prepare(
      `UPDATE time_sessions
       SET status = 'awaiting_description', ended_at_ms = deadline_at_ms,
           updated_at_ms = ?, version = version + 1
       -- Keep the partial one-open index eligible even though the second condition is narrower.
       WHERE status IN ('running', 'awaiting_description')
         AND status = 'running' AND mode = 'timer' AND deadline_at_ms <= ?`,
    )
    .bind(nowMs, nowMs)
    .run();
}

/** Resolve a timer deadline on demand; no background Worker or per-second writes. */
export async function getCurrentSession(
  db: D1Database,
  nowMs: number,
): Promise<TokiSession | null> {
  requireNow(nowMs);
  await materializeExpiredTimer(db, nowMs);
  const row = await db
    .prepare(
      "SELECT * FROM time_sessions WHERE status IN ('running', 'awaiting_description') LIMIT 1",
    )
    .first<SessionRow>();
  return row ? rowToSession(row) : null;
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
  const current = await getCurrentSession(db, nowMs);
  const existing = await db
    .prepare("SELECT * FROM time_sessions WHERE client_request_id = ?")
    .bind(input.clientRequestId)
    .first<SessionRow>();
  if (existing) {
    if (existing.mode !== input.mode || existing.timer_seconds !== (input.timerSeconds ?? null)) {
      throw new TokiDataError("conflict", "Request ID was used with different settings");
    }
    return rowToSession(existing);
  }

  if (current) {
    throw new TokiDataError("conflict", "An unfinished session already exists", current);
  }

  const id = crypto.randomUUID();
  const timerSeconds = input.timerSeconds ?? null;
  const deadlineAtMs = timerSeconds === null ? null : nowMs + timerSeconds * 1000;
  await db
    .prepare(
      `INSERT OR IGNORE INTO time_sessions
       (id, client_request_id, mode, status, started_at_ms, timer_seconds,
        deadline_at_ms, ended_at_ms, description, version, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, 'running', ?, ?, ?, NULL, NULL, 1, ?, ?)`,
    )
    .bind(id, input.clientRequestId, input.mode, nowMs, timerSeconds, deadlineAtMs, nowMs, nowMs)
    .run();

  const result = await db
    .prepare("SELECT * FROM time_sessions WHERE client_request_id = ?")
    .bind(input.clientRequestId)
    .first<SessionRow>();
  if (result) {
    if (result.mode !== input.mode || result.timer_seconds !== timerSeconds) {
      throw new TokiDataError("conflict", "Request ID was used with different settings");
    }
    return rowToSession(result);
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
  await db
    .prepare(
      `UPDATE time_sessions
       SET status = 'awaiting_description', ended_at_ms = ?, updated_at_ms = ?, version = version + 1
       WHERE id = ? AND status = 'running' AND version = ?`,
    )
    .bind(endedAtMs, nowMs, id, session.version)
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
): Promise<TokiSession> {
  const description = normalizeDescription(descriptionInput);
  const session = await getSession(db, id, nowMs);
  if (!session) throw new TokiDataError("not_found", "Session not found");
  if (session.status === "saved" && session.description === description) return session;
  if (session.status !== "awaiting_description" || session.endedAtMs === null) {
    throw new TokiDataError("conflict", "Session is not awaiting a description");
  }
  requireInterval(session.startedAtMs, session.endedAtMs);
  await db
    .prepare(
      `UPDATE time_sessions
       SET status = 'saved', description = ?, updated_at_ms = ?, version = version + 1
       WHERE id = ? AND status = 'awaiting_description' AND version = ?`,
    )
    .bind(description, nowMs, id, session.version)
    .run();
  const result = await selectById(db, id);
  if (!result) throw new TokiDataError("not_found", "Session not found");
  if (result.status === "saved" && result.description === description) return result;
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
  await db
    .prepare(
      `UPDATE time_sessions
       SET status = 'discarded', updated_at_ms = ?, version = version + 1
       WHERE id = ? AND status = 'awaiting_description' AND version = ?`,
    )
    .bind(nowMs, id, session.version)
    .run();
  const result = await selectById(db, id);
  if (!result) throw new TokiDataError("not_found", "Session not found");
  if (result.status === "discarded") return result;
  throw new TokiDataError("conflict", "Session state changed");
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
  const update = await db
    .prepare(
      `UPDATE time_sessions
       SET started_at_ms = ?, ended_at_ms = ?, description = ?,
           updated_at_ms = ?, version = version + 1
       WHERE id = ? AND status = 'saved' AND version = ?`,
    )
    .bind(input.startedAtMs, input.endedAtMs, description, nowMs, id, input.expectedVersion)
    .run();
  const result = await selectById(db, id);
  if (!result) throw new TokiDataError("not_found", "Record not found");
  if (update.meta.changes !== 1 || result.status !== "saved") {
    throw new TokiDataError("conflict", "Record was changed by another request");
  }
  return result;
}

/** Half-open [start,end) range: records ending exactly at start are excluded. */
export async function listSavedRecords(
  db: D1Database,
  startMs: number,
  endMs: number,
): Promise<TokiSession[]> {
  requireInterval(startMs, endMs);
  const rows = await db
    .prepare(
      `SELECT * FROM time_sessions
       WHERE status = 'saved' AND started_at_ms < ? AND ended_at_ms > ?
       ORDER BY started_at_ms ASC, id ASC`,
    )
    .bind(endMs, startMs)
    .all<SessionRow>();
  return rows.results.map(rowToSession);
}
