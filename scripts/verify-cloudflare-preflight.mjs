import { pathToFileURL } from "node:url";

const apiOrigin = "https://api.cloudflare.com";
const apiPrefix = "/client/v4";
const workerName = "toki";
const databaseName = "toki";
const accessApplicationName = "toki";
const expectedWorkersSubdomain = "sx7k2p9q";
const pageSize = 100;

// These are pre-creation safety bounds, not a substitute for checking the
// account's actual plan, usage and billing state in the Cloudflare dashboard.
const freeCapacity = { workers: 100, databases: 10, accessApplications: 500 };

/** @param {string} message
 * @returns {never}
 */
function fail(message) {
  throw new Error(message);
}

/** @param {NodeJS.ProcessEnv} env */
function credentialsFromEnvironment(env) {
  const token = env.CLOUDFLARE_API_TOKEN;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  if (typeof token !== "string" || !token || !/^[!-~]+$/.test(token)) {
    fail("CLOUDFLARE_API_TOKEN must be set as printable non-space ASCII text.");
  }
  if (typeof accountId !== "string" || !/^[0-9a-f]{32}$/i.test(accountId)) {
    fail("CLOUDFLARE_ACCOUNT_ID must be exactly 32 hexadecimal characters.");
  }
  return { token, accountId };
}

/** @param {string} token
 * @param {typeof fetch} fetchImpl
 */
function apiClient(token, fetchImpl) {
  /** @param {string} path
   * @param {string} label
   */
  return async (path, label) => {
    let response;
    let payload;
    try {
      response = await fetchImpl(new URL(`${apiPrefix}${path}`, apiOrigin), {
        method: "GET",
        headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      });
      payload = await response.json();
    } catch {
      fail(`${label} could not be read. No changes were made.`);
    }
    // Cloudflare error payloads can contain account data. Never include one in
    // an exception or CLI output.
    if (!response.ok || payload?.success !== true) {
      fail(`${label} failed (HTTP ${response.status}). No changes were made.`);
    }
    return payload;
  };
}

/** @param {ReturnType<typeof apiClient>} get
 * @param {string} path
 * @param {string} label
 * @param {string} nameProperty
 * @param {boolean} [metadataOptional]
 * @returns {Promise<Set<string>>}
 */
async function listAll(get, path, label, nameProperty, metadataOptional = false) {
  const names = new Set();
  let expectedTotal;
  let metadataMode;
  for (let page = 1; page <= 100; page += 1) {
    const query = new URLSearchParams({ page: String(page), per_page: String(pageSize) });
    const payload = await get(`${path}?${query}`, label);
    const info = payload?.result_info;
    const mode = info === undefined ? "absent" : "provided";
    if (metadataMode !== undefined && metadataMode !== mode) {
      fail(`${label} changed pagination format. No changes were made.`);
    }
    metadataMode = mode;
    if (!Array.isArray(payload?.result) || payload.result.length > pageSize) {
      fail(`${label} returned an invalid resource page. No changes were made.`);
    }
    if (mode === "absent" && !metadataOptional) {
      fail(`${label} returned incomplete pagination metadata. No changes were made.`);
    }
    if (
      mode === "provided" &&
      (info.page !== page ||
        info.per_page !== pageSize ||
        !Number.isSafeInteger(info.total_count) ||
        info.total_count < 0 ||
        (info.count !== undefined && info.count !== payload.result.length))
    ) {
      fail(`${label} returned incomplete pagination metadata. No changes were made.`);
    }
    if (mode === "provided") {
      if (expectedTotal === undefined) expectedTotal = info.total_count;
      if (expectedTotal !== info.total_count) {
        fail(`${label} changed during pagination. No changes were made.`);
      }
    }
    for (const resource of payload.result) {
      const name = resource?.[nameProperty];
      if (typeof name !== "string" || !name || names.has(name)) {
        fail(`${label} returned an incomplete or duplicate resource. No changes were made.`);
      }
      names.add(name);
    }
    if (mode === "provided" && names.size > expectedTotal) {
      fail(`${label} returned inconsistent resource counts. No changes were made.`);
    }
    if (mode === "provided" && names.size === expectedTotal) return names;
    if (mode === "absent" && payload.result.length < pageSize) return names;
    if (payload.result.length === 0) {
      fail(`${label} ended before all resources were listed. No changes were made.`);
    }
  }
  fail(`${label} has too many pages to verify safely. No changes were made.`);
}

/** @param {Set<string>} names
 * @param {string} name
 * @param {number} limit
 * @param {string} label
 */
function assertAvailable(names, name, limit, label) {
  if (names.has(name))
    fail(`An exact-name ${label} already exists. Stop and inspect it before continuing.`);
  if (names.size >= limit)
    fail(`${label} has no remaining Free-plan capacity. Stop before creating resources.`);
}

export async function verifyTokiCloudflarePreflight({ env = process.env, fetchImpl = fetch } = {}) {
  const { token, accountId } = credentialsFromEnvironment(env);
  const get = apiClient(token, fetchImpl);
  const accountPath = `/accounts/${accountId}`;

  const tokenResponse = await get(`${accountPath}/tokens/verify`, "API token verification");
  if (tokenResponse.result?.status !== "active") fail("API token is not active.");

  const accountResponse = await get(accountPath, "Account verification");
  if (accountResponse.result?.id !== accountId)
    fail("API token did not verify the selected account.");

  const subdomainResponse = await get(
    `${accountPath}/workers/subdomain`,
    "Workers subdomain verification",
  );
  if (subdomainResponse.result?.subdomain !== expectedWorkersSubdomain) {
    fail("Workers subdomain is not the expected deployment destination.");
  }

  const organizationResponse = await get(
    `${accountPath}/access/organizations`,
    "Zero Trust organization verification",
  );
  if (
    !/^[a-z0-9][a-z0-9-]*\.cloudflareaccess\.com$/i.test(
      organizationResponse.result?.auth_domain ?? "",
    )
  ) {
    fail("A valid Zero Trust team domain is not configured for this account.");
  }

  // Workers /scripts is a single-page API. /scripts-search is its documented
  // paginated counterpart and is intentionally called without a name filter.
  const [workers, databases, accessApplications] = await Promise.all([
    listAll(get, `${accountPath}/workers/scripts-search`, "Workers list", "script_name", true),
    listAll(get, `${accountPath}/d1/database`, "D1 list", "name"),
    listAll(get, `${accountPath}/access/apps`, "Access applications list", "name"),
  ]);

  assertAvailable(workers, workerName, freeCapacity.workers, "Worker");
  assertAvailable(databases, databaseName, freeCapacity.databases, "D1 database");
  assertAvailable(
    accessApplications,
    accessApplicationName,
    freeCapacity.accessApplications,
    "Access application",
  );

  return {
    workers: workers.size,
    databases: databases.size,
    accessApplications: accessApplications.size,
    expectedOrigin: `https://${workerName}.${expectedWorkersSubdomain}.workers.dev`,
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  verifyTokiCloudflarePreflight()
    .then(({ workers, databases, accessApplications }) => {
      console.info("Toki Cloudflare read-only preflight passed; no resources were changed.");
      console.info(
        `Current resource counts: Workers ${workers}, D1 ${databases}, Access apps ${accessApplications}.`,
      );
      console.info(
        "Before creation, the owner must confirm the Free plan, current billable usage and expected costs in the Cloudflare dashboard.",
      );
    })
    .catch((error) => {
      console.error(`Toki Cloudflare preflight stopped: ${error.message}`);
      process.exitCode = 1;
    });
}
