import { Hono } from "hono";
import {
  createRecordSchema,
  deleteRecordSchema,
  editRecordSchema,
  recordIdSchema,
  recordsQuerySchema,
  saveSessionSchema,
  sessionIdSchema,
  startSessionSchema,
} from "../contracts/api";
import {
  createManualRecord,
  deleteSavedRecord,
  discardSession,
  editSavedRecord,
  getCurrentSession,
  listSavedRecords,
  saveSession,
  startSession,
  stopSession,
  TokiDataError,
} from "../data/records";
import { AccessAuthError } from "../security/access";
import { authorizeRequest, type RequestAuthBindings } from "../security/request";

export type ApiBindings = RequestAuthBindings & {
  readonly DB?: D1Database;
};

const JSON_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
};
const SESSION_PATH = "/api/v1/session";
const RECORDS_PATH = "/api/v1/records";
const SESSION_ACTION_PATH = "/api/v1/session/:id{[0-9a-f-]{36}}/:action{stop|save|discard}";
const RECORD_ACTION_PATH = "/api/v1/records/:id{[0-9a-f-]{36}}";
const MAX_BODY_BYTES = 4096;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function error(status: number, code: string): Response {
  return json(status, { error: { code } });
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

function dataError(cause: unknown): Response {
  if (cause instanceof TokiDataError) {
    const status = cause.code === "validation" ? 400 : cause.code === "not_found" ? 404 : 409;
    return error(status, cause.code.toUpperCase());
  }
  return error(500, "INTERNAL_ERROR");
}

type ApiEnvironment = {
  Bindings: ApiBindings;
  Variables: { db: D1Database; nowMs: number; url: URL; recordId: string };
};

const api = new Hono<ApiEnvironment>({
  strict: true,
  // Do not decode encoded IDs or normalize trailing slashes into valid routes.
  getPath: (request) => new URL(request.url).pathname,
});

api.notFound(() => error(404, "NOT_FOUND"));
api.onError(dataError);

// These guards also run for unknown routes; keep their existing rejection order.
api.use("*", async (context, next) => {
  const request = context.req.raw;
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/v1/")) return error(404, "NOT_FOUND");
  try {
    await authorizeRequest(request, context.env);
  } catch (cause) {
    if (cause instanceof AccessAuthError) return error(cause.status, cause.code);
    return error(401, "UNAUTHORIZED");
  }
  const db = context.env.DB;
  if (db === undefined) return error(503, "UNAVAILABLE");
  if (isMutation(request) && !hasSafeMutationHeaders(request, url)) {
    return error(403, "UNSAFE_REQUEST");
  }
  context.set("db", db);
  context.set("url", url);
  context.set("nowMs", Date.now());
  try {
    await next();
  } catch (cause) {
    // Hono's onError handles Error instances. Preserve sanitization of other thrown values too.
    return dataError(cause);
  }
});

api.get(SESSION_PATH, async (context) => {
  // Hono routes HEAD through GET. It must not resolve an expired timer or query D1.
  if (context.req.raw.method === "HEAD") return error(405, "METHOD_NOT_ALLOWED");
  if (context.get("url").search !== "") return error(400, "INVALID_QUERY");
  const nowMs = context.get("nowMs");
  const session = await getCurrentSession(context.get("db"), nowMs);
  return json(200, { session, serverNowMs: nowMs });
});
api.post(SESSION_PATH, async (context) => {
  if (context.get("url").search !== "") return error(400, "INVALID_QUERY");
  const parsed = startSessionSchema.safeParse(await parseJson(context.req.raw));
  if (!parsed.success) return error(400, "INVALID_INPUT");
  const nowMs = context.get("nowMs");
  const session = await startSession(context.get("db"), parsed.data, nowMs);
  return json(201, { session, serverNowMs: nowMs });
});
api.all(SESSION_PATH, () => error(405, "METHOD_NOT_ALLOWED"));

api.post(SESSION_ACTION_PATH, async (context) => {
  if (context.get("url").search !== "") return error(400, "INVALID_QUERY");
  const id = context.req.param("id");
  const action = context.req.param("action");
  if (!sessionIdSchema.safeParse(id).success) return error(404, "NOT_FOUND");
  const db = context.get("db");
  const nowMs = context.get("nowMs");
  if (action === "save") {
    const parsed = saveSessionSchema.safeParse(await parseJson(context.req.raw));
    if (!parsed.success) return error(400, "INVALID_INPUT");
    const session = await saveSession(db, id, parsed.data.description, nowMs);
    return json(200, { session, serverNowMs: nowMs });
  }
  const parsed = await parseJson(context.req.raw);
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
});
// Session actions historically check method before query and UUID validity.
api.all(SESSION_ACTION_PATH, () => error(405, "METHOD_NOT_ALLOWED"));

api.get(RECORDS_PATH, async (context) => {
  if (context.req.raw.method === "HEAD") return error(405, "METHOD_NOT_ALLOWED");
  const parsed = recordsQuerySchema.safeParse(queryInput(context.get("url")));
  if (!parsed.success) return error(400, "INVALID_QUERY");
  const records = await listSavedRecords(context.get("db"), parsed.data.startMs, parsed.data.endMs);
  return json(200, { records, serverNowMs: context.get("nowMs") });
});
api.post(RECORDS_PATH, async (context) => {
  if (context.get("url").search !== "") return error(400, "INVALID_QUERY");
  const parsed = createRecordSchema.safeParse(await parseJson(context.req.raw));
  if (!parsed.success) return error(400, "INVALID_INPUT");
  const nowMs = context.get("nowMs");
  const record = await createManualRecord(context.get("db"), parsed.data, nowMs);
  return json(201, { record, serverNowMs: nowMs });
});
api.all(RECORDS_PATH, () => error(405, "METHOD_NOT_ALLOWED"));

// Record actions historically check query and UUID validity before method.
api.use(RECORD_ACTION_PATH, async (context, next) => {
  if (context.get("url").search !== "") return error(400, "INVALID_QUERY");
  const id = context.req.param("id");
  if (!recordIdSchema.safeParse(id).success) return error(404, "NOT_FOUND");
  context.set("recordId", id);
  await next();
});
api.patch(RECORD_ACTION_PATH, async (context) => {
  const parsed = editRecordSchema.safeParse(await parseJson(context.req.raw));
  if (!parsed.success) return error(400, "INVALID_INPUT");
  const nowMs = context.get("nowMs");
  const record = await editSavedRecord(
    context.get("db"),
    context.get("recordId"),
    parsed.data,
    nowMs,
  );
  return json(200, { record, serverNowMs: nowMs });
});
api.delete(RECORD_ACTION_PATH, async (context) => {
  const parsed = deleteRecordSchema.safeParse(await parseJson(context.req.raw));
  if (!parsed.success) return error(400, "INVALID_INPUT");
  const id = context.get("recordId");
  await deleteSavedRecord(context.get("db"), id, parsed.data.expectedVersion);
  return json(200, { deletedRecordId: id, serverNowMs: context.get("nowMs") });
});
api.all(RECORD_ACTION_PATH, () => error(405, "METHOD_NOT_ALLOWED"));

/** Each API request passes the Worker-side gate, including unknown paths and methods. */
export async function handleApiRequest(request: Request, bindings: ApiBindings): Promise<Response> {
  return api.fetch(request, bindings);
}
