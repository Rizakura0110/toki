import { describe, expect, it } from "vitest";
import { assertBudget, budgets } from "../../scripts/check-artifact-budgets.mjs";
import { verifyBaseline } from "../../scripts/release-baseline.mjs";
import matrixWorker from "../../tests/migration/worker";
import { handleRequest as oldWorker } from "../../tests/fixtures/phase48/src/worker";
import { handleRequest as newWorker } from "../worker";

describe("fixed production-source compatibility baseline", () => {
  it("matches all 14 files against the Phase 48 commit's SHA-256 manifest", async () => {
    expect(await verifyBaseline()).toMatch(/tests\/fixtures\/phase48$/u);
  });

  it.each([oldWorker, newWorker])(
    "keeps pages, assets and API closed without identity",
    async (worker) => {
      for (const path of [
        "/",
        "/calendar.html",
        "/manifest.webmanifest",
        "/icons/toki-192.png",
        "/api/v1/session",
      ]) {
        const response = await worker(new Request(`https://example.test${path}`), {});
        expect(response.status).toBe(403);
        expect(response.headers.get("Cache-Control")).toBe("no-store");
      }
    },
  );

  it.each([
    ["https://127.0.0.1/", "enabled", "old-new"],
    ["http://example.test/", "enabled", "new-old"],
    ["http://127.0.0.1/", undefined, "rollback"],
    ["http://127.0.0.1/", "enabled", "unknown"],
  ])(
    "rejects the hybrid test entry outside its explicit local environment",
    async (url, stub, mode) => {
      expect(
        (
          await matrixWorker.fetch(new Request(url ?? ""), {
            ...(stub === undefined ? {} : { LOCAL_STUB_MODE: stub }),
            MATRIX_MODE: mode,
          })
        ).status,
      ).toBe(503);
    },
  );
});

describe("artifact regression budgets", () => {
  for (const [kind, limit] of Object.entries(budgets)) {
    it(`${kind} accepts its exact limit and rejects oversized or invalid measurements`, () => {
      expect(() => assertBudget(kind, limit)).not.toThrow();
      for (const metric of ["raw", "gzip"]) {
        for (const invalid of [
          limit[metric as keyof typeof limit] + 1,
          NaN,
          Infinity,
          -1,
          0,
          0.5,
        ]) {
          expect(() => assertBudget(kind, { ...limit, [metric]: invalid })).toThrow();
        }
      }
    });
  }
  it("rejects unknown artifact groups", () => {
    expect(() => assertBudget("other", { raw: 1, gzip: 1 })).toThrow();
  });
});
