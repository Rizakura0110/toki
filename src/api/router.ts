import {
  editRecordSchema,
  recordIdSchema,
  recordsQuerySchema,
  saveSessionSchema,
  sessionIdSchema,
  startSessionSchema,
} from "../contracts/api";
import {
  discardSession,
  editSavedRecord,
  getCurrentSession,
  listSavedRecords,
  saveSession,
  startSession,
  stopSession,
  TokiDataError,
} from "../data/records";
import {
  AccessAuthError,
  type AccessAuthBindings,
  authenticateAccessRequest,
} from "../security/access";

export type ApiBindings = AccessAuthBindings & {
  readonly DB?: D1Database;
  readonly LOCAL_AUTH_BYPASS?: string;
};

const JSON_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
};
const SESSION_ACTION = /^\/api\/v1\/session\/([0-9a-f-]{36})\/(stop|save|discard)$/u;
const RECORD_ACTION = /^\/api\/v1\/records\/([0-9a-f-]{36})$/u;
const MAX_BODY_BYTES = 4096;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function error(status: number, code: string): Response {
  return json(status, { error: { code } });
}

function isLoopback(url: URL): boolean {
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

function isMutation(request: Request): boolean {
  return request.method !== "GET" && request.method !== "HEAD";
}

function hasSafeMutationHeaders(request: Request, url: URL): boolean {
  if (request.headers.get("Origin") !== url.origin) return false;
  if (request.headers.get("X-Toki-Client") !== "web") return false;
  return (
    request.headers.get("Content-Type")?.toLowerCase().split(";", 1)[0]?.trim() ===
    "application/json"
  );
}

async function parseJson(request: Request): Promise<unknown | undefined> {
  const statedSize = Number(request.headers.get("Content-Length") ?? 0);
  if (!Number.isFinite(statedSize) || statedSize > MAX_BODY_BYTES) return undefined;
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function queryInput(url: URL): Record<string, string> | undefined {
  const input: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (key in input) return undefined;
    input[key] = value;
  }
  return input;
}

/** Every route has an independent Worker-side Access gate; only explicit loopback dev can bypass it. */
export async function handleApiRequest(request: Request, bindings: ApiBindings): Promise<Response> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/v1/")) return error(404, "NOT_FOUND");

  try {
    if (!(bindings.LOCAL_AUTH_BYPASS === "enabled" && isLoopback(url))) {
      await authenticateAccessRequest(request, bindings);
    }
  } catch (cause) {
    if (cause instanceof AccessAuthError) return error(cause.status, cause.code);
    return error(401, "UNAUTHORIZED");
  }

  const db = bindings.DB;
  if (db === undefined) return error(503, "UNAVAILABLE");

  if (isMutation(request) && !hasSafeMutationHeaders(request, url)) {
    return error(403, "UNSAFE_REQUEST");
  }

  const nowMs = Date.now();
  try {
    if (url.pathname === "/api/v1/session") {
      if (request.method === "GET") {
        if (url.search !== "") return error(400, "INVALID_QUERY");
        const session = await getCurrentSession(db, nowMs);
        return json(200, { session, serverNowMs: nowMs });
      }
      if (request.method === "POST") {
        if (url.search !== "") return error(400, "INVALID_QUERY");
        const parsed = startSessionSchema.safeParse(await parseJson(request));
        if (!parsed.success) return error(400, "INVALID_INPUT");
        const session = await startSession(db, parsed.data, nowMs);
        return json(201, { session, serverNowMs: nowMs });
      }
      return error(405, "METHOD_NOT_ALLOWED");
    }

    const sessionAction = SESSION_ACTION.exec(url.pathname);
    if (sessionAction !== null) {
      if (request.method !== "POST") return error(405, "METHOD_NOT_ALLOWED");
      if (url.search !== "") return error(400, "INVALID_QUERY");
      const id = sessionAction[1];
      const action = sessionAction[2];
      if (id === undefined || action === undefined || !sessionIdSchema.safeParse(id).success) {
        return error(404, "NOT_FOUND");
      }
      if (action === "save") {
        const parsed = saveSessionSchema.safeParse(await parseJson(request));
        if (!parsed.success) return error(400, "INVALID_INPUT");
        const session = await saveSession(db, id, parsed.data.description, nowMs);
        return json(200, { session, serverNowMs: nowMs });
      }
      const parsed = await parseJson(request);
      if (
        parsed === undefined ||
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed) ||
        Object.keys(parsed).length !== 0
      ) {
        return error(400, "INVALID_INPUT");
      }
      const session =
        action === "stop" ? await stopSession(db, id, nowMs) : await discardSession(db, id, nowMs);
      return json(200, { session, serverNowMs: nowMs });
    }

    if (url.pathname === "/api/v1/records") {
      if (request.method !== "GET") return error(405, "METHOD_NOT_ALLOWED");
      const parsed = recordsQuerySchema.safeParse(queryInput(url));
      if (!parsed.success) return error(400, "INVALID_QUERY");
      const records = await listSavedRecords(db, parsed.data.startMs, parsed.data.endMs);
      return json(200, { records, serverNowMs: nowMs });
    }

    const recordAction = RECORD_ACTION.exec(url.pathname);
    if (recordAction !== null) {
      if (request.method !== "PATCH") return error(405, "METHOD_NOT_ALLOWED");
      if (url.search !== "") return error(400, "INVALID_QUERY");
      const id = recordAction[1];
      if (id === undefined || !recordIdSchema.safeParse(id).success) {
        return error(404, "NOT_FOUND");
      }
      const parsed = editRecordSchema.safeParse(await parseJson(request));
      if (!parsed.success) return error(400, "INVALID_INPUT");
      const record = await editSavedRecord(db, id, parsed.data, nowMs);
      return json(200, { record, serverNowMs: nowMs });
    }

    return error(404, "NOT_FOUND");
  } catch (cause) {
    if (cause instanceof TokiDataError) {
      const status = cause.code === "validation" ? 400 : cause.code === "not_found" ? 404 : 409;
      return error(status, cause.code.toUpperCase());
    }
    return error(500, "INTERNAL_ERROR");
  }
}
