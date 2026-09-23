import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";

const apiOrigin = "https://api.cloudflare.com";
const apiPrefix = "/client/v4";
const workerName = "toki";
const applicationName = "toki";
const expectedWorkersSubdomain = "sx7k2p9q";
const pageSize = 100;
const zonesPageSize = 50;

class SafeSetupError extends Error {}

class SafeApiError extends SafeSetupError {
  /** @param {string} label
   * @param {number} status
   */
  constructor(label, status) {
    super(`${label} failed (HTTP ${status}); inspect remote state before retrying.`);
    this.label = label;
    this.status = status;
  }
}

/** @param {string} message
 * @returns {never}
 */
function fail(message) {
  throw new SafeSetupError(message);
}

/** @param {NodeJS.ProcessEnv} env */
function readEnvironment(env) {
  const token = env.CLOUDFLARE_API_TOKEN;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const ownerEmail = env.TECH_INBOX_ALLOWED_EMAIL;
  if (typeof token !== "string" || !/^[!-~]+$/.test(token)) {
    fail("CLOUDFLARE_API_TOKEN must be set as printable non-space ASCII text.");
  }
  if (typeof accountId !== "string" || !/^[0-9a-f]{32}$/i.test(accountId)) {
    fail("CLOUDFLARE_ACCOUNT_ID must be exactly 32 hexadecimal characters.");
  }
  if (typeof ownerEmail !== "string" || !/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(ownerEmail)) {
    fail("TECH_INBOX_ALLOWED_EMAIL must contain exactly one owner email address.");
  }
  return { token, accountId, ownerEmail };
}

/** @param {string} token
 * @param {typeof fetch} fetchImpl
 */
function apiClient(token, fetchImpl) {
  /** @param {"GET" | "POST" | "PUT"} method
   * @param {string} path
   * @param {string} label
   * @param {unknown} [body]
   */
  return async (method, path, label, body) => {
    /** @type {Response | undefined} */
    let response;
    let payload;
    try {
      response = await fetchImpl(new URL(`${apiPrefix}${path}`, apiOrigin), {
        method,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15_000),
      });
      payload = await response.json();
    } catch {
      // A network/Cloudflare error can contain credentials or the account URL.
      fail(`${label} could not be completed; inspect remote state before retrying.`);
    }
    if (!response) fail(`${label} returned no response; inspect remote state before retrying.`);
    if (!response.ok) throw new SafeApiError(label, response.status);
    if (payload?.success !== true) {
      fail(`${label} failed (HTTP ${response.status}); inspect remote state before retrying.`);
    }
    return payload;
  };
}

/** @param {ReturnType<typeof apiClient>} request
 * @param {string} accountPath
 */
async function listAccessApplications(request, accountPath) {
  /** @type {any[]} */
  const applications = [];
  const ids = new Set();
  let expectedTotal;
  for (let page = 1; page <= 100; page += 1) {
    const query = new URLSearchParams({ page: String(page), per_page: String(pageSize) });
    const payload = await request(
      "GET",
      `${accountPath}/access/apps?${query}`,
      "Access application inventory",
    );
    const info = payload?.result_info;
    if (
      !Array.isArray(payload?.result) ||
      !info ||
      info.page !== page ||
      info.per_page !== pageSize ||
      !Number.isSafeInteger(info.total_count) ||
      info.total_count < 0 ||
      (info.count !== undefined && info.count !== payload.result.length)
    ) {
      fail("Access application inventory returned incomplete pagination metadata.");
    }
    if (expectedTotal === undefined) expectedTotal = info.total_count;
    if (info.total_count !== expectedTotal || payload.result.length > pageSize) {
      fail("Access application inventory changed during pagination.");
    }
    for (const application of payload.result) {
      if (
        typeof application?.id !== "string" ||
        !application.id ||
        typeof application.name !== "string" ||
        ids.has(application.id)
      ) {
        fail("Access application inventory contains an invalid or duplicate entry.");
      }
      ids.add(application.id);
      applications.push(application);
    }
    if (applications.length > expectedTotal) {
      fail("Access application inventory has inconsistent counts.");
    }
    if (applications.length === expectedTotal) return applications;
    if (payload.result.length === 0) {
      fail("Access application inventory ended before all entries were returned.");
    }
  }
  fail("Access application inventory has too many pages to verify safely.");
}

/** @param {ReturnType<typeof apiClient>} request
 * @param {string} accountPath
 * @returns {Promise<string>}
 */
async function findTokiDatabaseId(request, accountPath) {
  /** @type {string | undefined} */
  let databaseId;
  let expectedTotal;
  let seen = 0;
  for (let page = 1; page <= 100; page += 1) {
    const query = new URLSearchParams({ page: String(page), per_page: String(pageSize) });
    const payload = await request(
      "GET",
      `${accountPath}/d1/database?${query}`,
      "Toki D1 inventory",
    );
    const info = payload?.result_info;
    if (
      !Array.isArray(payload?.result) ||
      payload.result.length > pageSize ||
      !info ||
      info.page !== page ||
      info.per_page !== pageSize ||
      !Number.isSafeInteger(info.total_count) ||
      info.total_count < 0 ||
      (info.count !== undefined && info.count !== payload.result.length)
    ) {
      fail("Toki D1 inventory returned incomplete pagination metadata.");
    }
    if (expectedTotal === undefined) expectedTotal = info.total_count;
    if (info.total_count !== expectedTotal || seen + payload.result.length > expectedTotal) {
      fail("Toki D1 inventory changed during pagination.");
    }
    for (const database of payload.result) {
      if (database?.name === workerName) {
        if (
          databaseId !== undefined ||
          typeof database.uuid !== "string" ||
          !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(database.uuid)
        ) {
          fail("Exactly one Toki D1 database must exist.");
        }
        databaseId = database.uuid;
      }
    }
    seen += payload.result.length;
    if (seen === expectedTotal) {
      if (!databaseId) fail("The dedicated Toki D1 database is missing.");
      return databaseId;
    }
    if (payload.result.length === 0) fail("Toki D1 inventory ended unexpectedly.");
  }
  fail("Toki D1 inventory has too many pages to verify safely.");
}

/** @param {ReturnType<typeof apiClient>} request
 * @param {string} accountPath
 * @param {string} databaseId
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<boolean>}
 */
async function assertPrivateWorkerConfiguration(request, accountPath, databaseId, env) {
  const settingsResult = await request(
    "GET",
    `${accountPath}/workers/scripts/${workerName}/settings`,
    "Toki Worker settings verification",
  );
  const bindings = settingsResult.result?.bindings;
  if (!Array.isArray(bindings)) fail("Toki Worker bindings are missing.");
  const databaseBindings = bindings.filter((binding) => binding?.type === "d1");
  const assetBindings = bindings.filter((binding) => binding?.type === "assets");
  const bindingNames = bindings.map((binding) => binding?.name);
  if (
    new Set(bindingNames).size !== bindingNames.length ||
    databaseBindings.length !== 1 ||
    databaseBindings[0].name !== "DB" ||
    databaseBindings[0].id !== databaseId ||
    assetBindings.length !== 1 ||
    assetBindings[0].name !== "ASSETS" ||
    bindings.some(
      (binding) =>
        !(
          (binding?.type === "d1" && binding.name === "DB") ||
          (binding?.type === "assets" && binding.name === "ASSETS") ||
          (binding?.type === "secret_text" &&
            ["TEAM_DOMAIN", "POLICY_AUD", "ALLOWED_EMAIL"].includes(binding.name))
        ),
    )
  ) {
    fail("Toki Worker bindings do not match the dedicated database and protected assets.");
  }

  const domainsResult = await request(
    "GET",
    `${accountPath}/workers/domains?service=${workerName}`,
    "Toki Worker custom domain verification",
  );
  if (
    !Array.isArray(domainsResult.result) ||
    domainsResult.result.length !== 0 ||
    (domainsResult.result_info !== undefined && domainsResult.result_info.count !== 0)
  ) {
    fail("Toki Worker must have no custom domains before Access setup.");
  }

  // Routes are zone-scoped, so every zone belonging to this account must be
  // inspected. Only an exact owner dashboard attestation may cover a route
  // endpoint's HTTP 403; other API errors and all other checks still fail.
  let routeAttestationUsed = false;
  let expectedZones;
  let seenZones = 0;
  for (let page = 1; page <= 100; page += 1) {
    const query = new URLSearchParams({
      "account.id": accountPath.slice("/accounts/".length),
      page: String(page),
      per_page: String(zonesPageSize),
    });
    const zonesResult = await request("GET", `/zones?${query}`, "Account zone inventory");
    const zones = zonesResult.result;
    const info = zonesResult.result_info;
    if (
      !Array.isArray(zones) ||
      zones.length > zonesPageSize ||
      !info ||
      info.page !== page ||
      info.per_page !== zonesPageSize ||
      !Number.isSafeInteger(info.total_count) ||
      info.total_count < 0 ||
      (info.count !== undefined && info.count !== zones.length)
    ) {
      fail("Account zone inventory returned incomplete pagination metadata.");
    }
    if (expectedZones === undefined) expectedZones = info.total_count;
    if (info.total_count !== expectedZones || seenZones + zones.length > expectedZones) {
      fail("Account zone inventory changed during pagination.");
    }
    for (const zone of zones) {
      if (
        typeof zone?.id !== "string" ||
        !/^[0-9a-f]{32}$/i.test(zone.id) ||
        zone.account?.id !== accountPath.slice("/accounts/".length)
      ) {
        fail("Account zone inventory contains an unexpected zone.");
      }
      let routesResult;
      try {
        routesResult = await request(
          "GET",
          `/zones/${zone.id}/workers/routes`,
          "Toki Worker route verification",
        );
      } catch (error) {
        if (
          error instanceof SafeApiError &&
          error.label === "Toki Worker route verification" &&
          error.status === 403 &&
          env.TOKI_ROUTES_DASHBOARD_VERIFIED === workerName
        ) {
          routeAttestationUsed = true;
          continue;
        }
        throw error;
      }
      if (!Array.isArray(routesResult.result)) fail("Worker route inventory is incomplete.");
      if (
        routesResult.result.some(
          /** @param {{script?: string}} route */ (route) => route?.script === workerName,
        )
      ) {
        fail("Toki Worker must have no routes before Access setup.");
      }
    }
    seenZones += zones.length;
    if (seenZones === expectedZones) return routeAttestationUsed;
    if (zones.length === 0) fail("Account zone inventory ended unexpectedly.");
  }
  fail("Account zone inventory has too many pages to verify safely.");
}

/** @param {unknown} value
 * @param {string} expectedHost
 * @returns {boolean}
 */
function claimsHostname(value, expectedHost) {
  if (typeof value === "string") {
    const candidate = value
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .split(/[/?#:]/u)[0];
    return (
      candidate === expectedHost ||
      (candidate?.startsWith("*.") === true && expectedHost.endsWith(candidate.slice(1)))
    );
  }
  if (Array.isArray(value)) return value.some((entry) => claimsHostname(entry, expectedHost));
  if (value && typeof value === "object") {
    return Object.values(value).some((entry) => claimsHostname(entry, expectedHost));
  }
  return false;
}

/** @param {ReturnType<typeof apiClient>} request
 * @param {string} accountPath
 * @param {any[]} applications
 * @param {string} workerId
 */
async function findExistingApplication(request, accountPath, applications, workerId) {
  const expectedHost = `${workerName}.${expectedWorkersSubdomain}.workers.dev`;
  const named = applications.filter((application) => application.name === applicationName);
  if (named.length > 1) fail("More than one Toki Access application exists.");
  for (const listed of applications) {
    const detailResult = await request(
      "GET",
      `${accountPath}/access/apps/${listed.id}`,
      "Access application conflict verification",
    );
    const application = detailResult.result;
    if (
      application?.id !== listed.id ||
      application.name !== listed.name ||
      !Array.isArray(application.destinations)
    ) {
      fail("Access application details are incomplete or changed during verification.");
    }
    if (application.name === applicationName) continue;
    if (
      application.destinations.some(
        /** @param {{worker_id?: string}} destination */
        (destination) => destination?.worker_id === workerId,
      ) ||
      claimsHostname(application, expectedHost)
    ) {
      fail("Another Access application already targets the Toki Worker or hostname.");
    }
  }
  return named[0];
}

/** @param {any} application
 * @param {string} workerId
 * @param {string} expectedId
 */
function assertExactApplication(application, workerId, expectedId) {
  if (
    application?.id !== expectedId ||
    application.name !== applicationName ||
    typeof application.aud !== "string" ||
    !application.aud ||
    application.type !== "self_hosted" ||
    application.session_duration !== "168h" ||
    application.app_launcher_visible !== false ||
    !Array.isArray(application.destinations) ||
    application.destinations.length !== 1 ||
    (application.domain !== undefined &&
      application.domain !== null &&
      application.domain !== "") ||
    (application.self_hosted_domains !== undefined &&
      !isDeepStrictEqual(application.self_hosted_domains, [])) ||
    (application.hostname !== undefined &&
      application.hostname !== null &&
      application.hostname !== "") ||
    (application.path !== undefined && application.path !== null && application.path !== "")
  ) {
    fail("Toki Access application does not match the owner-only configuration.");
  }
  const destination = application.destinations[0];
  if (
    destination?.type !== "worker" ||
    destination.worker_id !== workerId ||
    (destination.uri !== undefined && destination.uri !== null)
  ) {
    fail("Toki Access application does not target only the expected Worker.");
  }
}

/** @param {any} policies
 * @param {string} ownerEmail
 */
function assertExactOwnerPolicy(policies, ownerEmail) {
  if (!Array.isArray(policies) || policies.length !== 1) {
    fail("Toki Access application must have exactly one policy.");
  }
  const [policy] = policies;
  if (
    policy?.decision !== "allow" ||
    !isDeepStrictEqual(policy.include, [{ email: { email: ownerEmail } }]) ||
    (policy.exclude !== undefined && !isDeepStrictEqual(policy.exclude, [])) ||
    (policy.require !== undefined && !isDeepStrictEqual(policy.require, []))
  ) {
    fail("Toki Access policy must allow only the configured owner email.");
  }
}

/**
 * Read-only by default. The apply mode may only create the Toki Access app and
 * set Toki Worker secrets after all existing account state has been checked.
 *
 * @param {{env?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch, mode?: "dry-run" | "apply"}} [options]
 */
export async function configureTokiAccess({
  env = process.env,
  fetchImpl = fetch,
  mode = "dry-run",
} = {}) {
  if (mode !== "dry-run" && mode !== "apply") fail("Unknown Toki Access setup mode.");
  if (mode === "apply" && env.TOKI_ACCESS_SETUP_CONFIRM !== workerName) {
    fail("Apply requires TOKI_ACCESS_SETUP_CONFIRM=toki as a second confirmation.");
  }
  const { token, accountId, ownerEmail } = readEnvironment(env);
  const request = apiClient(token, fetchImpl);
  const accountPath = `/accounts/${accountId}`;

  const tokenResult = await request(
    "GET",
    `${accountPath}/tokens/verify`,
    "API token verification",
  );
  if (tokenResult.result?.status !== "active") fail("API token is not active.");
  const accountResult = await request("GET", accountPath, "Account verification");
  if (accountResult.result?.id !== accountId)
    fail("API token did not verify the selected account.");

  const [organizationResult, accountSubdomainResult, workersResult, workerSubdomainResult] =
    await Promise.all([
      request("GET", `${accountPath}/access/organizations`, "Zero Trust organization lookup"),
      request("GET", `${accountPath}/workers/subdomain`, "Workers subdomain lookup"),
      request("GET", `${accountPath}/workers/scripts`, "Worker inventory"),
      request(
        "GET",
        `${accountPath}/workers/scripts/${workerName}/subdomain`,
        "Toki Worker exposure verification",
      ),
    ]);
  const teamDomain = organizationResult.result?.auth_domain;
  if (
    typeof teamDomain !== "string" ||
    !/^[a-z0-9][a-z0-9-]*\.cloudflareaccess\.com$/i.test(teamDomain)
  ) {
    fail("A valid Zero Trust team domain is required.");
  }
  if (accountSubdomainResult.result?.subdomain !== expectedWorkersSubdomain) {
    fail("Workers subdomain is not the approved Toki destination.");
  }
  if (!Array.isArray(workersResult.result)) fail("Worker inventory is incomplete.");
  const workers = /** @type {Array<{id?: string, tag?: string}>} */ (workersResult.result).filter(
    (worker) => worker?.id === workerName,
  );
  const workerId = workers[0]?.tag;
  if (workers.length !== 1 || typeof workerId !== "string" || !/^[0-9a-f]{32}$/i.test(workerId)) {
    fail("Exactly one Toki Worker with a valid immutable ID must exist.");
  }
  if (
    workerSubdomainResult.result?.enabled !== false ||
    workerSubdomainResult.result?.previews_enabled !== false
  ) {
    fail("Toki Worker public and preview URLs must both be disabled before Access setup.");
  }

  const databaseId = await findTokiDatabaseId(request, accountPath);
  const routeAttestationUsed = await assertPrivateWorkerConfiguration(
    request,
    accountPath,
    databaseId,
    env,
  );

  const applications = await listAccessApplications(request, accountPath);
  let application = await findExistingApplication(request, accountPath, applications, workerId);
  if (application === undefined && mode === "dry-run") {
    return { mode, application: "absent", secretsConfigured: false, routeAttestationUsed };
  }

  let created = false;
  if (application === undefined) {
    const createdResult = await request(
      "POST",
      `${accountPath}/access/apps`,
      "Toki Access application creation",
      {
        app_launcher_visible: false,
        destinations: [{ type: "worker", worker_id: workerId }],
        name: applicationName,
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
      },
    );
    application = createdResult.result;
    created = true;
  }
  const applicationId = application?.id;
  if (typeof applicationId !== "string" || !applicationId) {
    fail("Toki Access application has no ID; inspect remote state before retrying.");
  }
  const detailResult = await request(
    "GET",
    `${accountPath}/access/apps/${applicationId}`,
    "Toki Access application verification",
  );
  assertExactApplication(detailResult.result, workerId, applicationId);
  const policiesResult = await request(
    "GET",
    `${accountPath}/access/apps/${applicationId}/policies?per_page=100`,
    "Toki Access policy verification",
  );
  const policyInfo = policiesResult.result_info;
  if (
    policyInfo?.page !== 1 ||
    policyInfo.per_page !== 100 ||
    policyInfo.total_count !== 1 ||
    (policyInfo.count !== undefined && policyInfo.count !== 1)
  ) {
    fail("Toki Access policy inventory is incomplete or has more than one policy.");
  }
  assertExactOwnerPolicy(policiesResult.result, ownerEmail);
  if (mode === "dry-run") {
    return { mode, application: "verified", secretsConfigured: false, routeAttestationUsed };
  }

  const secrets = [
    { name: "TEAM_DOMAIN", text: `https://${teamDomain}` },
    { name: "POLICY_AUD", text: detailResult.result.aud },
    { name: "ALLOWED_EMAIL", text: ownerEmail },
  ];
  for (const secret of secrets) {
    await request(
      "PUT",
      `${accountPath}/workers/scripts/${workerName}/secrets`,
      `Toki Worker ${secret.name} secret update`,
      { ...secret, type: "secret_text" },
    );
  }
  return {
    mode,
    application: created ? "created" : "verified",
    secretsConfigured: true,
    routeAttestationUsed,
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--apply")) {
    console.error("Usage: node scripts/configure-access.mjs [--apply]");
    process.exitCode = 1;
  } else {
    configureTokiAccess({ mode: args[0] === "--apply" ? "apply" : "dry-run" })
      .then((result) => {
        console.info(
          result.mode === "dry-run"
            ? `Toki Access read-only check passed (${result.application}); no resources changed.`
            : `Toki Access configuration verified (${result.application}); three Worker secrets set.`,
        );
        console.info(
          result.routeAttestationUsed
            ? "Worker routes used the owner's dashboard attestation after route API HTTP 403."
            : "Worker routes were verified by API; no dashboard attestation was used.",
        );
        console.info("No credential, account ID, email, team domain, or audience was printed.");
      })
      .catch((error) => {
        console.error(
          `Toki Access setup stopped: ${
            error instanceof SafeSetupError
              ? error.message
              : "Unexpected failure; inspect remote state before retrying."
          }`,
        );
        process.exitCode = 1;
      });
  }
}
