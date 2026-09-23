type D1Probe = {
  prepare(sql: string): {
    first<Row>(): Promise<Row | null>;
  };
};

export type LocalBindings = {
  readonly DB?: D1Probe;
  readonly LOCAL_STUB_MODE?: string;
};

const PROBE_PATH = "/__local/db";
const PROBE_SQL = "SELECT 1 AS ready";
const RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "text/plain; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
};

function unavailable(): Response {
  return new Response("Unavailable", { status: 503, headers: RESPONSE_HEADERS });
}

function isLoopback(url: URL): boolean {
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

export async function handleRequest(request: Request, bindings: LocalBindings): Promise<Response> {
  const url = new URL(request.url);
  if (
    bindings.LOCAL_STUB_MODE !== "enabled" ||
    !isLoopback(url) ||
    request.method !== "GET" ||
    url.pathname !== PROBE_PATH
  ) {
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

export default { fetch: handleRequest };
