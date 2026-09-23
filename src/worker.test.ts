import { describe, expect, it, vi } from "vitest";
import { handleRequest, type LocalBindings } from "./worker";

const LOCAL_URL = "http://127.0.0.1:8787/__local/db";

function bindings(value: 1 | 0 | null = 1) {
  const firstCall = vi.fn();
  const first = async <Row>(): Promise<Row | null> => {
    firstCall();
    return value === null ? null : ({ ready: value } as Row);
  };
  const prepare = vi.fn((_sql: string) => ({ first }));
  const env: LocalBindings = { LOCAL_STUB_MODE: "enabled", DB: { prepare } };
  return { env, firstCall, prepare };
}

describe("Phase 36 local D1 connectivity stub", () => {
  it("reads exactly one local D1 probe and returns no business data", async () => {
    const { env, firstCall, prepare } = bindings();
    const response = await handleRequest(new Request(LOCAL_URL), env);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("OK");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(prepare).toHaveBeenCalledExactlyOnceWith("SELECT 1 AS ready");
    expect(firstCall).toHaveBeenCalledOnce();
  });

  it.each([
    ["the explicit local flag is absent", LOCAL_URL, undefined],
    ["the explicit local flag is wrong", LOCAL_URL, "off"],
    ["the hostname is remote", "https://toki.example/__local/db", "enabled"],
    ["the protocol is HTTPS", "https://localhost/__local/db", "enabled"],
    [
      "the hostname only starts with localhost",
      "http://localhost.evil.example/__local/db",
      "enabled",
    ],
    ["the path is not the exact probe path", "http://localhost:8787/no-probe", "enabled"],
  ])("fails closed when %s", async (_description, url, flag) => {
    const { prepare } = bindings();
    const testBindings: LocalBindings =
      flag === undefined ? { DB: { prepare } } : { DB: { prepare }, LOCAL_STUB_MODE: flag };
    const response = await handleRequest(new Request(url), testBindings);

    expect(response.status).toBe(url.endsWith("/no-probe") ? 403 : 503);
    expect(await response.text()).toBe("Unavailable");
    expect(prepare).not.toHaveBeenCalled();
  });

  it("does not expose a mutation route", async () => {
    const { env, prepare } = bindings();
    const response = await handleRequest(new Request(LOCAL_URL, { method: "POST" }), env);

    expect(response.status).toBe(503);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("fails closed when D1 is unbound or returns an unexpected row", async () => {
    const missing = await handleRequest(new Request(LOCAL_URL), { LOCAL_STUB_MODE: "enabled" });
    const { env } = bindings(0);
    const unexpected = await handleRequest(new Request(LOCAL_URL), env);
    const { env: nullEnv } = bindings(null);
    const empty = await handleRequest(new Request(LOCAL_URL), nullEnv);

    expect([missing.status, unexpected.status, empty.status]).toEqual([503, 503, 503]);
  });

  it("does not leak D1 failures to the caller", async () => {
    const env: LocalBindings = {
      LOCAL_STUB_MODE: "enabled",
      DB: {
        prepare: () => ({
          first: async () => {
            throw new Error("private SQL detail");
          },
        }),
      },
    };
    const response = await handleRequest(new Request(LOCAL_URL), env);

    expect(response.status).toBe(503);
    expect(await response.text()).toBe("Unavailable");
  });
});

describe("Phase 38 static screen perimeter", () => {
  const localPage = "http://127.0.0.1:8787/";

  it("serves a local-only authenticated screen with security headers", async () => {
    const fetch = vi.fn(
      async () => new Response("<html>Toki</html>", { headers: { "Content-Type": "text/html" } }),
    );
    const response = await handleRequest(new Request(localPage), {
      LOCAL_AUTH_BYPASS: "enabled",
      ASSETS: { fetch },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Toki");
    expect(response.headers.get("Content-Security-Policy")).toContain("script-src 'self'");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("denies an anonymous page and never delegates it to the asset worker", async () => {
    const fetch = vi.fn(async () => new Response("<html>Toki</html>"));
    const response = await handleRequest(new Request("https://toki.example/"), {
      ASSETS: { fetch },
    });
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("Toki");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("never applies the loopback bypass to a remote or HTTPS origin", async () => {
    const fetch = vi.fn(async () => new Response("secret"));
    const remote = await handleRequest(new Request("https://toki.example/app.js"), {
      LOCAL_AUTH_BYPASS: "enabled",
      ASSETS: { fetch },
    });
    const httpsLocal = await handleRequest(new Request("https://localhost/app.js"), {
      LOCAL_AUTH_BYPASS: "enabled",
      ASSETS: { fetch },
    });
    expect([remote.status, httpsLocal.status]).toEqual([403, 403]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns 404 for unrecognized assets and 503 when the asset binding is absent", async () => {
    const fetch = vi.fn(async () => new Response("fallback"));
    const unknown = await handleRequest(new Request(`${localPage}unknown`), {
      LOCAL_AUTH_BYPASS: "enabled",
      ASSETS: { fetch },
    });
    const missing = await handleRequest(new Request(localPage), { LOCAL_AUTH_BYPASS: "enabled" });
    expect([unknown.status, missing.status]).toEqual([404, 503]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not serve a page for a mutation and always routes API before assets", async () => {
    const fetch = vi.fn(async () => new Response("fallback"));
    const bindings = { LOCAL_AUTH_BYPASS: "enabled", ASSETS: { fetch } };
    const mutation = await handleRequest(new Request(localPage, { method: "POST" }), bindings);
    const api = await handleRequest(new Request(`${localPage}api/v1/session`), bindings);
    expect([mutation.status, api.status]).toEqual([405, 503]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
