import { createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey, SignJWT } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  type AccessAuthBindings,
  type AccessAuthDependencies,
  type AccessAuthError,
  authenticateAccessRequest,
} from "./access";

const ISSUER = "https://test.cloudflareaccess.com";
const AUDIENCE = "toki-test-audience";
const OWNER = "owner@example.test";
const SUBJECT = "owner-subject";
const BINDINGS: AccessAuthBindings = {
  TEAM_DOMAIN: ISSUER,
  POLICY_AUD: AUDIENCE,
  ALLOWED_EMAIL: OWNER,
};

let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let dependencies: AccessAuthDependencies;

beforeAll(async () => {
  const keyPair = await generateKeyPair("RS256");
  privateKey = keyPair.privateKey;
  const publicJwk = await exportJWK(keyPair.publicKey);
  const getJwks: JWTVerifyGetKey = createLocalJWKSet({
    keys: [{ ...publicJwk, kid: "local-test-key", alg: "RS256", use: "sig" }],
  });
  dependencies = { getJwks: vi.fn(() => getJwks) };
});

function request(token?: string): Request {
  const url = "https://toki.example.test/api/session";
  return token === undefined
    ? new Request(url)
    : new Request(url, { headers: { "Cf-Access-Jwt-Assertion": token } });
}

async function signedToken(
  options: {
    issuer?: string;
    audience?: string;
    email?: string | null;
    subject?: string | null;
    expiration?: number | null;
  } = {},
): Promise<string> {
  const claims: Record<string, unknown> = {};
  if (options.email !== null) claims.email = options.email ?? OWNER;
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "local-test-key" })
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? AUDIENCE)
    .setIssuedAt(1_700_000_000);
  if (options.subject !== null) jwt.setSubject(options.subject ?? SUBJECT);
  if (options.expiration !== null) jwt.setExpirationTime(options.expiration ?? 4_102_444_800);
  return jwt.sign(privateKey);
}

async function expectAuthError(promise: Promise<unknown>, status: 401 | 403): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    name: "AccessAuthError",
    status,
    code: status === 403 ? "FORBIDDEN" : "UNAUTHORIZED",
  } satisfies Partial<AccessAuthError>);
}

describe("Toki Cloudflare Access authentication", () => {
  it("accepts a valid RS256 token only for the exact owner, issuer and audience", async () => {
    const principal = await authenticateAccessRequest(
      request(await signedToken()),
      BINDINGS,
      dependencies,
    );

    expect(principal).toEqual({
      subject: SUBJECT,
      email: OWNER,
      provider: "cloudflare-access",
    });
    expect(dependencies.getJwks).toHaveBeenCalledWith(ISSUER);
  });

  it.each([
    { label: "team domain", override: { TEAM_DOMAIN: undefined } },
    { label: "audience", override: { POLICY_AUD: " " } },
    { label: "owner email", override: { ALLOWED_EMAIL: undefined } },
    { label: "non-HTTPS issuer", override: { TEAM_DOMAIN: "http://test.cloudflareaccess.com" } },
    {
      label: "lookalike issuer",
      override: { TEAM_DOMAIN: "https://test.cloudflareaccess.com.evil.test" },
    },
    { label: "issuer URL with a path", override: { TEAM_DOMAIN: `${ISSUER}/foo` } },
  ])("fails closed for missing or invalid $label configuration", async ({ override }) => {
    await expectAuthError(
      authenticateAccessRequest(
        request(await signedToken()),
        { ...BINDINGS, ...override },
        dependencies,
      ),
      403,
    );
  });

  it("requires the Access assertion header", async () => {
    await expectAuthError(authenticateAccessRequest(request(), BINDINGS, dependencies), 401);
    await expectAuthError(authenticateAccessRequest(request("  "), BINDINGS, dependencies), 401);
  });

  it.each([
    { label: "wrong issuer", options: { issuer: "https://other.cloudflareaccess.com" } },
    { label: "wrong audience", options: { audience: "another-application" } },
    { label: "wrong owner", options: { email: "someone-else@example.test" } },
    { label: "different owner case", options: { email: "OWNER@example.test" } },
    { label: "missing email", options: { email: null } },
    { label: "missing subject", options: { subject: null } },
    { label: "empty subject", options: { subject: "" } },
    { label: "missing expiration", options: { expiration: null } },
    { label: "expired", options: { expiration: 1_700_000_001 } },
  ])("rejects a signed token with $label", async ({ options }) => {
    await expectAuthError(
      authenticateAccessRequest(request(await signedToken(options)), BINDINGS, dependencies),
      401,
    );
  });

  it("rejects malformed tokens and JWKS lookup failures without exposing details", async () => {
    await expectAuthError(
      authenticateAccessRequest(request("not-a-jwt"), BINDINGS, dependencies),
      401,
    );
    await expectAuthError(
      authenticateAccessRequest(request(await signedToken()), BINDINGS, {
        getJwks: () => {
          throw new Error("private JWKS failure");
        },
      }),
      401,
    );
  });

  it("rejects a token signed by a different RSA key", async () => {
    const attackerKey = await generateKeyPair("RS256");
    const forged = await new SignJWT({ email: OWNER })
      .setProtectedHeader({ alg: "RS256", kid: "local-test-key" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(SUBJECT)
      .setExpirationTime(4_102_444_800)
      .sign(attackerKey.privateKey);

    await expectAuthError(authenticateAccessRequest(request(forged), BINDINGS, dependencies), 401);
  });

  it("rejects a token using a different signing algorithm", async () => {
    const token = await new SignJWT({ email: OWNER })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(SUBJECT)
      .setExpirationTime(4_102_444_800)
      .sign(new TextEncoder().encode("a local-only test signing key with enough length"));

    await expectAuthError(authenticateAccessRequest(request(token), BINDINGS, dependencies), 401);
  });
});
