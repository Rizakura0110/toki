import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";

export type AccessPrincipal = {
  readonly subject: string;
  readonly email: string;
  readonly provider: "cloudflare-access";
};

export type AccessAuthBindings = {
  readonly TEAM_DOMAIN?: string | undefined;
  readonly POLICY_AUD?: string | undefined;
  readonly ALLOWED_EMAIL?: string | undefined;
};

export type AccessAuthDependencies = {
  readonly getJwks: (issuer: string) => JWTVerifyGetKey;
};

export class AccessAuthError extends Error {
  constructor(
    readonly status: 401 | 403,
    readonly code: "UNAUTHORIZED" | "FORBIDDEN",
  ) {
    super(
      status === 403 ? "Access authentication is unavailable." : "Access authentication failed.",
    );
    this.name = "AccessAuthError";
  }
}

const jwksByIssuer = new Map<string, JWTVerifyGetKey>();

function requiredConfig(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === "" ? undefined : trimmed;
}

function normalizeIssuer(value: string | undefined): string | undefined {
  const configured = requiredConfig(value);
  if (configured === undefined) return undefined;

  try {
    const url = new URL(configured);
    const teamName = url.hostname.slice(0, -".cloudflareaccess.com".length);
    if (
      url.protocol !== "https:" ||
      !url.hostname.endsWith(".cloudflareaccess.com") ||
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(teamName) ||
      url.username !== "" ||
      url.password !== "" ||
      url.port !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return undefined;
    }

    return url.origin;
  } catch {
    return undefined;
  }
}

function remoteJwks(issuer: string): JWTVerifyGetKey {
  const cached = jwksByIssuer.get(issuer);
  if (cached !== undefined) return cached;

  const jwks = createRemoteJWKSet(new URL("/cdn-cgi/access/certs", issuer));
  jwksByIssuer.set(issuer, jwks);
  return jwks;
}

const defaultDependencies: AccessAuthDependencies = { getJwks: remoteJwks };

/** Verify Access independently inside the Toki Worker, even when Access guards the route. */
export async function authenticateAccessRequest(
  request: Request,
  bindings: AccessAuthBindings,
  dependencies: AccessAuthDependencies = defaultDependencies,
): Promise<AccessPrincipal> {
  const issuer = normalizeIssuer(bindings.TEAM_DOMAIN);
  const audience = requiredConfig(bindings.POLICY_AUD);
  const allowedEmail = requiredConfig(bindings.ALLOWED_EMAIL);
  if (issuer === undefined || audience === undefined || allowedEmail === undefined) {
    throw new AccessAuthError(403, "FORBIDDEN");
  }

  const token = request.headers.get("Cf-Access-Jwt-Assertion")?.trim();
  if (token === undefined || token === "") {
    throw new AccessAuthError(401, "UNAUTHORIZED");
  }

  try {
    const { payload } = await jwtVerify(token, dependencies.getJwks(issuer), {
      algorithms: ["RS256"],
      issuer,
      audience,
    });
    if (
      typeof payload.exp !== "number" ||
      typeof payload.sub !== "string" ||
      payload.sub === "" ||
      typeof payload.email !== "string" ||
      payload.email !== allowedEmail
    ) {
      throw new Error("Access claims did not match the owner policy.");
    }

    return { subject: payload.sub, email: payload.email, provider: "cloudflare-access" };
  } catch {
    throw new AccessAuthError(401, "UNAUTHORIZED");
  }
}
