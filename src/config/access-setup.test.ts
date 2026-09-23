import { describe, expect, it } from "vitest";
import { configureTokiAccess } from "../../scripts/configure-access.mjs";

const accountId = "a".repeat(32);
const workerId = "b".repeat(32);
const otherWorkerId = "c".repeat(32);
const zoneId = "d".repeat(32);
const databaseId = "11111111-2222-3333-4444-555555555555";
const token = "mock-token-never-log";
const ownerEmail = "owner@example.test";
const teamDomain = "private.cloudflareaccess.com";
const audience = "mock-audience-never-log";
const env = {
  CLOUDFLARE_ACCOUNT_ID: accountId,
  CLOUDFLARE_API_TOKEN: token,
  TECH_INBOX_ALLOWED_EMAIL: ownerEmail,
  TOKI_ACCESS_SETUP_CONFIRM: "toki",
};
const accountPath = `/accounts/${accountId}`;

type Application = {
  id: string;
  name: string;
  aud?: string;
  type?: string;
  session_duration?: string;
  app_launcher_visible?: boolean;
  destinations?: Array<{ type: string; worker_id?: string; uri?: string }>;
  domain?: string;
};
type Policy = {
  decision: string;
  include: unknown[];
  exclude?: unknown[];
  require?: unknown[];
};
type MockOptions = {
  applications?: Application[];
  applicationDetail?: Application;
  policies?: Policy[];
  returnedAccountId?: string;
  tokenStatus?: string;
  teamDomain?: string;
  subdomain?: string;
  workerNames?: Array<{ id: string; tag?: string }>;
  workerSubdomain?: { enabled: boolean; previews_enabled: boolean };
  databases?: Array<{ name: string; uuid: string }>;
  bindings?: Array<{ name: string; type: string; id?: string }>;
  domains?: Array<{ service: string }>;
  zones?: Array<{ id: string; account: { id: string } }>;
  routes?: Array<{ script: string }>;
  missingPagination?: boolean;
  missingPolicyPagination?: boolean;
  failMethod?: string;
  failPath?: string;
  failStatus?: number;
};
type Call = { method: string; path: string; body?: Record<string, unknown> };

function exactApplication(): Application {
  return {
    id: "toki-app-id",
    name: "toki",
    aud: audience,
    type: "self_hosted",
    session_duration: "168h",
    app_launcher_visible: false,
    destinations: [{ type: "worker", worker_id: workerId }],
  };
}

function exactPolicy(): Policy {
  return { decision: "allow", include: [{ email: { email: ownerEmail } }] };
}

function mockCloudflare(options: MockOptions = {}) {
  const calls: Call[] = [];
  let applications = options.applications ?? [
    {
      id: "other-app-id",
      name: "rizakura-hontai",
      destinations: [{ type: "worker", worker_id: otherWorkerId }],
    },
  ];
  const detail = options.applicationDetail ?? exactApplication();
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input.toString());
    const path = url.pathname.replace("/client/v4", "");
    const method = init?.method ?? "GET";
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : undefined;
    calls.push({ method, path: `${path}${url.search}`, ...(body ? { body } : {}) });
    expect(url.origin).toBe("https://api.cloudflare.com");
    expect(init?.headers).toMatchObject({ Authorization: `Bearer ${token}` });

    if (method === options.failMethod && path === options.failPath) {
      return Response.json(
        {
          success: false,
          errors: [{ message: `${token} ${accountId} ${ownerEmail} ${teamDomain} ${audience}` }],
        },
        { status: options.failStatus ?? 403 },
      );
    }

    let result: unknown;
    let resultInfo: unknown;
    if (method === "GET" && path === `${accountPath}/tokens/verify`) {
      result = { status: options.tokenStatus ?? "active" };
    } else if (method === "GET" && path === accountPath) {
      result = { id: options.returnedAccountId ?? accountId };
    } else if (method === "GET" && path === `${accountPath}/access/organizations`) {
      result = { auth_domain: options.teamDomain ?? teamDomain };
    } else if (method === "GET" && path === `${accountPath}/workers/subdomain`) {
      result = { subdomain: options.subdomain ?? "sx7k2p9q" };
    } else if (method === "GET" && path === `${accountPath}/workers/scripts`) {
      result = options.workerNames ?? [
        { id: "rizakura-hontai", tag: otherWorkerId },
        { id: "toki", tag: workerId },
      ];
    } else if (method === "GET" && path === `${accountPath}/workers/scripts/toki/subdomain`) {
      result = options.workerSubdomain ?? { enabled: false, previews_enabled: false };
    } else if (method === "GET" && path === `${accountPath}/d1/database`) {
      const databases = options.databases ?? [{ name: "toki", uuid: databaseId }];
      const page = Number(url.searchParams.get("page"));
      const perPage = Number(url.searchParams.get("per_page"));
      result = databases.slice((page - 1) * perPage, page * perPage);
      resultInfo = {
        page,
        per_page: perPage,
        count: (result as unknown[]).length,
        total_count: databases.length,
      };
    } else if (method === "GET" && path === `${accountPath}/workers/scripts/toki/settings`) {
      result = {
        bindings: options.bindings ?? [
          { name: "DB", type: "d1", id: databaseId },
          { name: "ASSETS", type: "assets" },
        ],
      };
    } else if (method === "GET" && path === `${accountPath}/workers/domains`) {
      expect(url.searchParams.get("service")).toBe("toki");
      result = options.domains ?? [];
      resultInfo = { count: (result as unknown[]).length };
    } else if (method === "GET" && path === "/zones") {
      expect(url.searchParams.get("account.id")).toBe(accountId);
      const zones = options.zones ?? [];
      const page = Number(url.searchParams.get("page"));
      const perPage = Number(url.searchParams.get("per_page"));
      result = zones.slice((page - 1) * perPage, page * perPage);
      resultInfo = {
        page,
        per_page: perPage,
        count: (result as unknown[]).length,
        total_count: zones.length,
      };
    } else if (method === "GET" && path === `/zones/${zoneId}/workers/routes`) {
      result = options.routes ?? [];
    } else if (method === "GET" && path === `${accountPath}/access/apps`) {
      const page = Number(url.searchParams.get("page"));
      const perPage = Number(url.searchParams.get("per_page"));
      result = applications.slice((page - 1) * perPage, page * perPage);
      resultInfo = {
        page,
        per_page: perPage,
        count: (result as Application[]).length,
        total_count: applications.length,
      };
    } else if (method === "POST" && path === `${accountPath}/access/apps`) {
      applications = [...applications, detail];
      result = detail;
    } else if (method === "GET" && path === `${accountPath}/access/apps/toki-app-id`) {
      result = detail;
    } else if (method === "GET" && path === `${accountPath}/access/apps/toki-app-id/policies`) {
      result = options.policies ?? [exactPolicy()];
      resultInfo = {
        page: 1,
        per_page: 100,
        count: (result as unknown[]).length,
        total_count: (result as unknown[]).length,
      };
    } else if (method === "GET" && path.startsWith(`${accountPath}/access/apps/`)) {
      const applicationId = path.slice(`${accountPath}/access/apps/`.length);
      result = applications.find((application) => application.id === applicationId);
    } else if (method === "PUT" && path === `${accountPath}/workers/scripts/toki/secrets`) {
      result = { name: body?.name };
    } else {
      throw new Error(`Unexpected mocked endpoint: ${method} ${path}`);
    }

    return Response.json({
      success: true,
      result,
      ...((path === `${accountPath}/access/apps` && !options.missingPagination) ||
      path === `${accountPath}/d1/database` ||
      path === `${accountPath}/workers/domains` ||
      path === "/zones" ||
      (path === `${accountPath}/access/apps/toki-app-id/policies` &&
        !options.missingPolicyPagination)
        ? { result_info: resultInfo }
        : {}),
    });
  };
  return { fetchImpl, calls };
}

function mutations(calls: Call[]) {
  return calls.filter(({ method }) => method !== "GET");
}

describe("Toki Access setup", () => {
  it("is GET-only by default and reports an absent Access app without creating it", async () => {
    const mock = mockCloudflare();
    await expect(configureTokiAccess({ env, fetchImpl: mock.fetchImpl })).resolves.toEqual({
      mode: "dry-run",
      application: "absent",
      secretsConfigured: false,
      routeAttestationUsed: false,
    });
    expect(mutations(mock.calls)).toEqual([]);
    expect(mock.calls).toContainEqual({
      method: "GET",
      path: `${accountPath}/access/apps?page=1&per_page=100`,
    });
  });

  it("requires explicit apply mode and a second confirmation before any HTTP call", async () => {
    const mock = mockCloudflare();
    await expect(
      configureTokiAccess({
        env: { ...env, TOKI_ACCESS_SETUP_CONFIRM: "" },
        fetchImpl: mock.fetchImpl,
        mode: "apply",
      }),
    ).rejects.toThrow("TOKI_ACCESS_SETUP_CONFIRM");
    await expect(
      configureTokiAccess({ env, fetchImpl: mock.fetchImpl, mode: "unsafe" as "apply" }),
    ).rejects.toThrow("Unknown");
    expect(mock.calls).toEqual([]);
  });

  it("creates only the owner-only Toki Worker Access app, verifies it, then sets three secrets", async () => {
    const mock = mockCloudflare();
    await expect(
      configureTokiAccess({ env, fetchImpl: mock.fetchImpl, mode: "apply" }),
    ).resolves.toEqual({
      mode: "apply",
      application: "created",
      secretsConfigured: true,
      routeAttestationUsed: false,
    });

    const writes = mutations(mock.calls);
    expect(writes.map(({ method, path }) => `${method} ${path}`)).toEqual([
      `POST ${accountPath}/access/apps`,
      `PUT ${accountPath}/workers/scripts/toki/secrets`,
      `PUT ${accountPath}/workers/scripts/toki/secrets`,
      `PUT ${accountPath}/workers/scripts/toki/secrets`,
    ]);
    expect(writes[0]?.body).toEqual({
      app_launcher_visible: false,
      destinations: [{ type: "worker", worker_id: workerId }],
      name: "toki",
      policies: [
        {
          decision: "allow",
          include: [{ email: { email: ownerEmail } }],
          name: "Allow owner email",
          precedence: 1,
        },
      ],
      session_duration: "168h",
      type: "self_hosted",
    });
    expect(writes.slice(1).map(({ body }) => body)).toEqual([
      { name: "TEAM_DOMAIN", text: `https://${teamDomain}`, type: "secret_text" },
      { name: "POLICY_AUD", text: audience, type: "secret_text" },
      { name: "ALLOWED_EMAIL", text: ownerEmail, type: "secret_text" },
    ]);
    const detailIndex = mock.calls.findIndex(
      ({ path }) => path === `${accountPath}/access/apps/toki-app-id`,
    );
    const policyIndex = mock.calls.findIndex(({ path }) =>
      path.startsWith(`${accountPath}/access/apps/toki-app-id/policies`),
    );
    const firstSecretIndex = mock.calls.findIndex(
      ({ path }) => path === `${accountPath}/workers/scripts/toki/secrets`,
    );
    expect(detailIndex).toBeGreaterThan(-1);
    expect(policyIndex).toBeGreaterThan(detailIndex);
    expect(firstSecretIndex).toBeGreaterThan(policyIndex);
  });

  it("does not recreate an existing exact app and writes secrets only in apply mode", async () => {
    const existing = exactApplication();
    const mock = mockCloudflare({ applications: [existing] });
    await expect(configureTokiAccess({ env, fetchImpl: mock.fetchImpl })).resolves.toEqual({
      mode: "dry-run",
      application: "verified",
      secretsConfigured: false,
      routeAttestationUsed: false,
    });
    expect(mutations(mock.calls)).toEqual([]);
    await expect(
      configureTokiAccess({ env, fetchImpl: mock.fetchImpl, mode: "apply" }),
    ).resolves.toEqual({
      mode: "apply",
      application: "verified",
      secretsConfigured: true,
      routeAttestationUsed: false,
    });
    expect(mutations(mock.calls).every(({ method }) => method === "PUT")).toBe(true);
    expect(mutations(mock.calls)).toHaveLength(3);
  });

  it("rejects missing, malformed, or multiple-owner credentials before HTTP", async () => {
    const mock = mockCloudflare();
    for (const badEnv of [
      {},
      { ...env, CLOUDFLARE_API_TOKEN: ` ${token}` },
      { ...env, CLOUDFLARE_ACCOUNT_ID: `${accountId}\u001b[D` },
      { ...env, TECH_INBOX_ALLOWED_EMAIL: "a@example.test,b@example.test" },
      { ...env, TECH_INBOX_ALLOWED_EMAIL: "" },
    ]) {
      await expect(
        configureTokiAccess({ env: badEnv, fetchImpl: mock.fetchImpl, mode: "apply" }),
      ).rejects.toThrow();
    }
    expect(mock.calls).toEqual([]);
  });

  it.each([
    ["inactive token", { tokenStatus: "disabled" }],
    ["wrong account", { returnedAccountId: "d".repeat(32) }],
    ["wrong team domain", { teamDomain: "evil.invalid" }],
    ["wrong workers.dev subdomain", { subdomain: "other" }],
    ["missing Worker", { workerNames: [{ id: "other", tag: workerId }] }],
    ["invalid immutable ID", { workerNames: [{ id: "toki", tag: "bad" }] }],
    ["public Worker URL", { workerSubdomain: { enabled: true, previews_enabled: false } }],
    ["preview URL", { workerSubdomain: { enabled: false, previews_enabled: true } }],
    ["missing dedicated D1", { databases: [] }],
    ["malformed dedicated D1 ID", { databases: [{ name: "toki", uuid: "not-a-uuid" }] }],
    [
      "wrong D1 binding",
      {
        bindings: [
          { name: "DB", type: "d1", id: "other" },
          { name: "ASSETS", type: "assets" },
        ],
      },
    ],
    ["missing assets binding", { bindings: [{ name: "DB", type: "d1", id: databaseId }] }],
    [
      "production auth bypass binding",
      {
        bindings: [
          { name: "DB", type: "d1", id: databaseId },
          { name: "ASSETS", type: "assets" },
          { name: "LOCAL_AUTH_BYPASS", type: "secret_text" },
        ],
      },
    ],
    [
      "duplicate binding name",
      {
        bindings: [
          { name: "DB", type: "d1", id: databaseId },
          { name: "ASSETS", type: "assets" },
          { name: "ASSETS", type: "assets" },
        ],
      },
    ],
    ["custom domain", { domains: [{ service: "toki" }] }],
    [
      "existing Worker route",
      { zones: [{ id: zoneId, account: { id: accountId } }], routes: [{ script: "toki" }] },
    ],
    [
      "route inventory belongs to another account",
      { zones: [{ id: zoneId, account: { id: otherWorkerId } }] },
    ],
  ])("fails closed on %s", async (_label, options) => {
    const mock = mockCloudflare(options);
    await expect(
      configureTokiAccess({ env, fetchImpl: mock.fetchImpl, mode: "apply" }),
    ).rejects.toThrow();
    expect(mutations(mock.calls)).toEqual([]);
  });

  it("checks zone routes and accepts only the dedicated D1, assets and known auth secrets", async () => {
    const mock = mockCloudflare({
      zones: [{ id: zoneId, account: { id: accountId } }],
      routes: [{ script: "another-worker" }],
      bindings: [
        { name: "DB", type: "d1", id: databaseId },
        { name: "ASSETS", type: "assets" },
        { name: "TEAM_DOMAIN", type: "secret_text" },
        { name: "POLICY_AUD", type: "secret_text" },
        { name: "ALLOWED_EMAIL", type: "secret_text" },
      ],
    });
    await expect(configureTokiAccess({ env, fetchImpl: mock.fetchImpl })).resolves.toMatchObject({
      application: "absent",
    });
    expect(mock.calls).toContainEqual({
      method: "GET",
      path: `/zones/${zoneId}/workers/routes`,
    });
    expect(mutations(mock.calls)).toEqual([]);
  });

  it("fails closed if route-read permission is missing", async () => {
    const mock = mockCloudflare({
      zones: [{ id: zoneId, account: { id: accountId } }],
      failMethod: "GET",
      failPath: `/zones/${zoneId}/workers/routes`,
    });
    await expect(
      configureTokiAccess({ env, fetchImpl: mock.fetchImpl, mode: "apply" }),
    ).rejects.toThrow("Worker route verification failed (HTTP 403)");
    expect(mutations(mock.calls)).toEqual([]);
  });

  it("uses exact owner dashboard attestation only after a route API HTTP 403", async () => {
    const mock = mockCloudflare({
      zones: [{ id: zoneId, account: { id: accountId } }],
      failMethod: "GET",
      failPath: `/zones/${zoneId}/workers/routes`,
    });
    const attestedEnv = { ...env, TOKI_ROUTES_DASHBOARD_VERIFIED: "toki" };
    await expect(
      configureTokiAccess({ env: attestedEnv, fetchImpl: mock.fetchImpl }),
    ).resolves.toEqual({
      mode: "dry-run",
      application: "absent",
      secretsConfigured: false,
      routeAttestationUsed: true,
    });
    expect(mutations(mock.calls)).toEqual([]);

    await expect(
      configureTokiAccess({ env: attestedEnv, fetchImpl: mock.fetchImpl, mode: "apply" }),
    ).resolves.toEqual({
      mode: "apply",
      application: "created",
      secretsConfigured: true,
      routeAttestationUsed: true,
    });
    expect(mutations(mock.calls).map(({ method }) => method)).toEqual([
      "POST",
      "PUT",
      "PUT",
      "PUT",
    ]);
  });

  it.each([
    ["wrong attestation value", "wrong", 403, `/zones/${zoneId}/workers/routes`],
    ["route API server error", "toki", 500, `/zones/${zoneId}/workers/routes`],
    ["different API permission error", "toki", 403, `${accountPath}/workers/domains`],
  ])("does not bypass %s", async (_label, attestation, status, path) => {
    const mock = mockCloudflare({
      zones: [{ id: zoneId, account: { id: accountId } }],
      failMethod: "GET",
      failPath: path,
      failStatus: status,
    });
    await expect(
      configureTokiAccess({
        env: { ...env, TOKI_ROUTES_DASHBOARD_VERIFIED: attestation },
        fetchImpl: mock.fetchImpl,
        mode: "apply",
      }),
    ).rejects.toThrow(`HTTP ${status}`);
    expect(mutations(mock.calls)).toEqual([]);
  });

  it("does not bypass a real Toki route or unrelated Worker binding with dashboard attestation", async () => {
    const attestedEnv = { ...env, TOKI_ROUTES_DASHBOARD_VERIFIED: "toki" };
    for (const options of [
      {
        zones: [{ id: zoneId, account: { id: accountId } }],
        routes: [{ script: "toki" }],
      },
      {
        bindings: [
          { name: "DB", type: "d1", id: databaseId },
          { name: "ASSETS", type: "assets" },
          { name: "LOCAL_AUTH_BYPASS", type: "secret_text" },
        ],
      },
    ]) {
      const mock = mockCloudflare(options);
      await expect(
        configureTokiAccess({ env: attestedEnv, fetchImpl: mock.fetchImpl, mode: "apply" }),
      ).rejects.toThrow();
      expect(mutations(mock.calls)).toEqual([]);
    }
  });

  it.each([
    [
      "another Access app targets the immutable Worker ID",
      {
        applications: [
          {
            id: "renamed",
            name: "old-toki",
            destinations: [{ type: "worker", worker_id: workerId }],
          },
        ],
      },
    ],
    [
      "another Access app owns the hostname",
      {
        applications: [
          {
            id: "old",
            name: "old-toki",
            destinations: [],
            domain: "toki.sx7k2p9q.workers.dev",
          },
        ],
      },
    ],
    [
      "another Access app owns a matching wildcard hostname",
      {
        applications: [
          {
            id: "old",
            name: "old-toki",
            destinations: [],
            domain: "*.sx7k2p9q.workers.dev",
          },
        ],
      },
    ],
    [
      "another Access app returns no destinations",
      { applications: [{ id: "old", name: "old-toki" }] },
    ],
    [
      "duplicate Toki app names",
      { applications: [exactApplication(), { ...exactApplication(), id: "duplicate" }] },
    ],
  ])("does not mutate when %s", async (_label, options) => {
    const mock = mockCloudflare(options);
    await expect(
      configureTokiAccess({ env, fetchImpl: mock.fetchImpl, mode: "apply" }),
    ).rejects.toThrow();
    expect(mutations(mock.calls)).toEqual([]);
  });

  it.each([
    [
      "wrong destination",
      {
        applicationDetail: {
          ...exactApplication(),
          destinations: [{ type: "worker", worker_id: otherWorkerId }],
        },
      },
    ],
    ["wrong audience", { applicationDetail: { ...exactApplication(), aud: "" } }],
    [
      "visible launcher",
      { applicationDetail: { ...exactApplication(), app_launcher_visible: true } },
    ],
    ["wrong session", { applicationDetail: { ...exactApplication(), session_duration: "24h" } }],
    ["extra policy", { policies: [exactPolicy(), exactPolicy()] }],
    ["missing policy pagination", { missingPolicyPagination: true }],
    [
      "extra hostname",
      { applicationDetail: { ...exactApplication(), domain: "other.example.test" } },
    ],
    [
      "additional identity",
      {
        policies: [
          { decision: "allow", include: [{ email: { email: ownerEmail } }, { everyone: {} }] },
        ],
      },
    ],
    [
      "additional requirement",
      { policies: [{ ...exactPolicy(), require: [{ country: { country_code: "JP" } }] }] },
    ],
  ])("does not write secrets when a created app has %s", async (_label, options) => {
    const mock = mockCloudflare(options);
    await expect(
      configureTokiAccess({ env, fetchImpl: mock.fetchImpl, mode: "apply" }),
    ).rejects.toThrow();
    expect(mutations(mock.calls).map(({ method }) => method)).toEqual(["POST"]);
  });

  it("does not mutate an existing app with a changed policy", async () => {
    const mock = mockCloudflare({
      applications: [exactApplication()],
      policies: [{ decision: "allow", include: [{ everyone: {} }] }],
    });
    await expect(
      configureTokiAccess({ env, fetchImpl: mock.fetchImpl, mode: "apply" }),
    ).rejects.toThrow("only the configured owner");
    expect(mutations(mock.calls)).toEqual([]);
  });

  it("checks every page and fails closed when inventory pagination is incomplete", async () => {
    const otherApps = Array.from({ length: 100 }, (_, index) => ({
      id: `other-${index}`,
      name: `other-${index}`,
      destinations: [{ type: "worker", worker_id: otherWorkerId }],
    }));
    const mock = mockCloudflare({
      applications: [
        ...otherApps,
        {
          id: "conflict",
          name: "renamed",
          destinations: [{ type: "worker", worker_id: workerId }],
        },
      ],
    });
    await expect(
      configureTokiAccess({ env, fetchImpl: mock.fetchImpl, mode: "apply" }),
    ).rejects.toThrow("Another Access application");
    expect(mock.calls).toContainEqual({
      method: "GET",
      path: `${accountPath}/access/apps?page=2&per_page=100`,
    });
    expect(mutations(mock.calls)).toEqual([]);

    const incomplete = mockCloudflare({ missingPagination: true });
    await expect(
      configureTokiAccess({ env, fetchImpl: incomplete.fetchImpl, mode: "apply" }),
    ).rejects.toThrow("pagination metadata");
    expect(mutations(incomplete.calls)).toEqual([]);
  });

  it("redacts Cloudflare errors containing credentials, account ID and owner details", async () => {
    const mock = mockCloudflare({
      failMethod: "GET",
      failPath: `${accountPath}/access/organizations`,
    });
    let message = "";
    try {
      await configureTokiAccess({ env, fetchImpl: mock.fetchImpl, mode: "apply" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("HTTP 403");
    for (const sensitive of [token, accountId, ownerEmail, teamDomain, audience]) {
      expect(message).not.toContain(sensitive);
    }
    expect(mutations(mock.calls)).toEqual([]);
  });
});
