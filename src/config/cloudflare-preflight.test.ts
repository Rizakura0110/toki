import { describe, expect, it } from "vitest";
import { verifyTokiCloudflarePreflight } from "../../scripts/verify-cloudflare-preflight.mjs";

const accountId = "a".repeat(32);
const token = "test-token-do-not-log";
const env = { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: token };

type MockOptions = {
  workers?: string[];
  databases?: string[];
  accessApplications?: string[];
  tokenStatus?: string;
  returnedAccountId?: string;
  subdomain?: string;
  authDomain?: string;
  missingPaginationFor?: string;
  failPath?: string;
  failBody?: string;
};

function mockCloudflare(options: MockOptions = {}) {
  const paths: string[] = [];
  const workers = options.workers ?? ["rizakura-hontai", "tech-inbox-metadata-fetcher"];
  const databases = options.databases ?? ["rizakura-hontai"];
  const accessApplications = options.accessApplications ?? ["rizakura-hontai"];

  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input.toString());
    const path = url.pathname.replace("/client/v4", "");
    paths.push(`${path}${url.search}`);
    expect(url.origin).toBe("https://api.cloudflare.com");
    expect(init?.method).toBe("GET");
    expect(init?.headers).toMatchObject({ Authorization: `Bearer ${token}` });
    if (path === options.failPath) {
      return Response.json(
        { success: false, errors: [{ message: options.failBody ?? "private server detail" }] },
        { status: 401 },
      );
    }

    let result: unknown;
    let resultInfo: unknown;
    if (path === `/accounts/${accountId}/tokens/verify`) {
      result = { status: options.tokenStatus ?? "active" };
    } else if (path === `/accounts/${accountId}`) {
      result = { id: options.returnedAccountId ?? accountId };
    } else if (path === `/accounts/${accountId}/workers/subdomain`) {
      result = { subdomain: options.subdomain ?? "sx7k2p9q" };
    } else if (path === `/accounts/${accountId}/access/organizations`) {
      result = { auth_domain: options.authDomain ?? "example.cloudflareaccess.com" };
    } else {
      const resources = path.endsWith("/workers/scripts-search")
        ? workers.map((script_name) => ({ script_name }))
        : path.endsWith("/d1/database")
          ? databases.map((name) => ({ name }))
          : path.endsWith("/access/apps")
            ? accessApplications.map((name) => ({ name }))
            : undefined;
      if (!resources) throw new Error("Unexpected mocked API endpoint");
      const page = Number(url.searchParams.get("page"));
      const perPage = Number(url.searchParams.get("per_page"));
      result = resources.slice((page - 1) * perPage, page * perPage);
      resultInfo = {
        page,
        per_page: perPage,
        count: (result as unknown[]).length,
        total_count: resources.length,
      };
    }
    return Response.json({
      success: true,
      result,
      ...(path === options.missingPaginationFor ? {} : { result_info: resultInfo }),
    });
  };

  return { fetchImpl, paths };
}

describe("Toki Cloudflare read-only preflight", () => {
  it("checks account, destination, organization and all three resource inventories without writing", async () => {
    const mock = mockCloudflare();
    await expect(
      verifyTokiCloudflarePreflight({ env, fetchImpl: mock.fetchImpl }),
    ).resolves.toEqual({
      workers: 2,
      databases: 1,
      accessApplications: 1,
      expectedOrigin: "https://toki.sx7k2p9q.workers.dev",
    });
    expect(mock.paths).toContain(
      `/accounts/${accountId}/workers/scripts-search?page=1&per_page=100`,
    );
    expect(mock.paths).toContain(`/accounts/${accountId}/d1/database?page=1&per_page=100`);
    expect(mock.paths).toContain(`/accounts/${accountId}/access/apps?page=1&per_page=100`);
    expect(mock.paths.every((path) => !path.includes("/workers/scripts?"))).toBe(true);
  });

  it("rejects missing or malformed credentials before making requests", async () => {
    const mock = mockCloudflare();
    for (const badEnv of [
      {},
      { ...env, CLOUDFLARE_API_TOKEN: "" },
      { ...env, CLOUDFLARE_API_TOKEN: ` ${token}` },
      { ...env, CLOUDFLARE_ACCOUNT_ID: `${accountId}\u001b[D` },
      { ...env, CLOUDFLARE_ACCOUNT_ID: "not-an-id" },
    ]) {
      await expect(
        verifyTokiCloudflarePreflight({ env: badEnv, fetchImpl: mock.fetchImpl }),
      ).rejects.toThrow();
    }
    expect(mock.paths).toEqual([]);
  });

  it.each([
    ["inactive token", { tokenStatus: "disabled" }],
    ["different account", { returnedAccountId: "b".repeat(32) }],
    ["different Worker subdomain", { subdomain: "different" }],
    ["missing team domain", { authDomain: "" }],
  ])("stops on %s", async (_label, options) => {
    const mock = mockCloudflare(options);
    await expect(
      verifyTokiCloudflarePreflight({ env, fetchImpl: mock.fetchImpl }),
    ).rejects.toThrow();
    expect(mock.paths.some((path) => path.includes("scripts-search"))).toBe(false);
  });

  it.each([
    ["Worker", { workers: ["toki"] }],
    ["D1 database", { databases: ["toki"] }],
    ["Access application", { accessApplications: ["toki"] }],
  ])("stops if an exact-name %s already exists", async (_label, options) => {
    const mock = mockCloudflare(options);
    await expect(verifyTokiCloudflarePreflight({ env, fetchImpl: mock.fetchImpl })).rejects.toThrow(
      "already exists",
    );
  });

  it.each([
    ["Worker", { workers: Array.from({ length: 100 }, (_, i) => `other-${i}`) }],
    ["D1 database", { databases: Array.from({ length: 10 }, (_, i) => `other-${i}`) }],
    [
      "Access application",
      { accessApplications: Array.from({ length: 500 }, (_, i) => `other-${i}`) },
    ],
  ])("stops when the %s Free capacity has no remaining slot", async (_label, options) => {
    const mock = mockCloudflare(options);
    await expect(verifyTokiCloudflarePreflight({ env, fetchImpl: mock.fetchImpl })).rejects.toThrow(
      "Free-plan capacity",
    );
  });

  it("reads later Access pages and detects a collision outside page one", async () => {
    const names = [...Array.from({ length: 100 }, (_, i) => `other-${i}`), "toki"];
    const mock = mockCloudflare({ accessApplications: names });
    await expect(verifyTokiCloudflarePreflight({ env, fetchImpl: mock.fetchImpl })).rejects.toThrow(
      "already exists",
    );
    expect(mock.paths).toContain(`/accounts/${accountId}/access/apps?page=2&per_page=100`);
  });

  it("fails closed on missing pagination metadata", async () => {
    const mock = mockCloudflare({ missingPaginationFor: `/accounts/${accountId}/d1/database` });
    await expect(verifyTokiCloudflarePreflight({ env, fetchImpl: mock.fetchImpl })).rejects.toThrow(
      "pagination metadata",
    );
  });

  it("accepts a short Workers page when Cloudflare omits optional result_info", async () => {
    const mock = mockCloudflare({
      missingPaginationFor: `/accounts/${accountId}/workers/scripts-search`,
    });
    await expect(
      verifyTokiCloudflarePreflight({ env, fetchImpl: mock.fetchImpl }),
    ).resolves.toMatchObject({ workers: 2 });
  });

  it("never includes API errors, credentials, account ID or team domain in a failure", async () => {
    const mock = mockCloudflare({
      failPath: `/accounts/${accountId}/access/organizations`,
      failBody: `${token} ${accountId} secret@example.com`,
    });
    let message = "";
    try {
      await verifyTokiCloudflarePreflight({ env, fetchImpl: mock.fetchImpl });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("HTTP 401");
    for (const sensitive of [token, accountId, "secret@example.com"])
      expect(message).not.toContain(sensitive);
  });
});
