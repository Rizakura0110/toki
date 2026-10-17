import { handleRequest as modern, type LocalBindings } from "../../src/worker";
import { handleRequest as legacy } from "../fixtures/phase48/src/worker";

// Test-only entry point. Never imported by src/, Vite or a production configuration.
export default {
  fetch(request: Request, bindings: LocalBindings & { MATRIX_MODE?: string }): Promise<Response> {
    const url = new URL(request.url);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      bindings.LOCAL_STUB_MODE !== "enabled" ||
      !["old-new", "new-old", "rollback"].includes(bindings.MATRIX_MODE ?? "")
    ) {
      return Promise.resolve(new Response("Local tests only", { status: 503 }));
    }
    const api = bindings.MATRIX_MODE === "old-new" ? modern : legacy;
    const assets = bindings.MATRIX_MODE === "new-old" ? modern : legacy;
    return (url.pathname.startsWith("/api/v1/") ? api : assets)(request, bindings);
  },
};
