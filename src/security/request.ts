import { type AccessAuthBindings, type AccessPrincipal, authenticateAccessRequest } from "./access";

export type RequestAuthBindings = AccessAuthBindings & {
  readonly LOCAL_AUTH_BYPASS?: string;
};

function isLoopbackHttp(url: URL): boolean {
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

/** The development bypass is deliberately absent from Wrangler's deploy configuration. */
export async function authorizeRequest(
  request: Request,
  bindings: RequestAuthBindings,
): Promise<AccessPrincipal | null> {
  if (bindings.LOCAL_AUTH_BYPASS === "enabled" && isLoopbackHttp(new URL(request.url))) {
    return null;
  }
  return authenticateAccessRequest(request, bindings);
}
