import { handleApiRequest, type ApiBindings } from "./api/router";
import { AccessAuthError } from "./security/access";
import { authorizeRequest } from "./security/request";

type D1Probe = {
  prepare(sql: string): {
    first<Row>(): Promise<Row | null>;
  };
};

export type LocalBindings = {
  readonly DB?: D1Probe;
  readonly LOCAL_STUB_MODE?: string;
  readonly ASSETS?: { fetch(request: Request): Promise<Response> };
} & Omit<ApiBindings, "DB">;

const PROBE_PATH = "/__local/db";
const PROBE_SQL = "SELECT 1 AS ready";
const RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "text/plain; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
};
const STATIC_PATHS = new Set(["/", "/index.html", "/app.js", "/styles.css"]);
const STATIC_SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

function unavailable(): Response {
  return new Response("Unavailable", { status: 503, headers: RESPONSE_HEADERS });
}

function isLoopback(url: URL): boolean {
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

async function handleStatic(request: Request, bindings: LocalBindings): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: RESPONSE_HEADERS });
  }
  try {
    await authorizeRequest(request, bindings);
  } catch (cause) {
    const status = cause instanceof AccessAuthError ? cause.status : 401;
    return new Response("Unavailable", { status, headers: RESPONSE_HEADERS });
  }
  const url = new URL(request.url);
  if (!STATIC_PATHS.has(url.pathname)) {
    return new Response("Not found", { status: 404, headers: RESPONSE_HEADERS });
  }
  if (bindings.ASSETS === undefined) return unavailable();

  try {
    const asset = await bindings.ASSETS.fetch(request);
    if (!asset.ok) return new Response("Not found", { status: 404, headers: RESPONSE_HEADERS });
    const headers = new Headers(asset.headers);
    for (const [name, value] of Object.entries(STATIC_SECURITY_HEADERS)) {
      headers.set(name, value);
    }
    if (url.protocol === "https:") {
      headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    return new Response(asset.body, { status: asset.status, headers });
  } catch {
    return unavailable();
  }
}

export async function handleRequest(request: Request, bindings: LocalBindings): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/v1/")) {
    return handleApiRequest(request, bindings as ApiBindings);
  }
  if (url.pathname === PROBE_PATH) {
    if (bindings.LOCAL_STUB_MODE !== "enabled" || !isLoopback(url) || request.method !== "GET") {
      return unavailable();
    }
    try {
      const row = await bindings.DB?.prepare(PROBE_SQL).first<{ ready: number }>();
      if (row?.ready !== 1) return unavailable();
    } catch {
      return unavailable();
    }
    return new Response("OK", { status: 200, headers: RESPONSE_HEADERS });
  }
  return handleStatic(request, bindings);
}

export default { fetch: handleRequest };
