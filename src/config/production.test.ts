import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertProductionConfig,
  buildProductionConfig,
  productionConfigPath,
} from "../../scripts/prepare-production-config.mjs";

const DATABASE_ID = "01234567-89ab-cdef-0123-456789abcdef";
const DATABASE_ID_KEY = ["database", "id"].join("_");

describe("Toki production Wrangler config preparation", () => {
  it.each([
    ["stage", false],
    ["live", true],
  ])("uses the explicit %s mode without changing the local config", (mode, workersDev) => {
    const config = buildProductionConfig(mode, DATABASE_ID);
    expect(config.name).toBe("toki");
    expect(config.workers_dev).toBe(workersDev);
    expect(config.preview_urls).toBe(false);
    expect(config.assets).toMatchObject({
      binding: "ASSETS",
      html_handling: "none",
      not_found_handling: "none",
      run_worker_first: true,
    });
    expect(config.d1_databases).toEqual([
      {
        binding: "DB",
        database_name: "toki",
        [DATABASE_ID_KEY]: DATABASE_ID,
        migrations_dir: "../migrations",
      },
    ]);
    expect(assertProductionConfig(config, mode, DATABASE_ID)).toBe(true);

    const configDirectory = dirname(productionConfigPath(mode));
    expect(resolve(configDirectory, config.main)).toMatch(/\/products\/toki\/src\/worker\.ts$/u);
    expect(resolve(configDirectory, config.assets.directory)).toMatch(/\/products\/toki\/public$/u);
    expect(resolve(configDirectory, config.d1_databases[0]?.migrations_dir ?? "")).toMatch(
      /\/products\/toki\/migrations$/u,
    );
  });

  it("rejects missing, malformed and ambiguous input before writing", () => {
    for (const invalid of [
      undefined,
      "",
      DATABASE_ID.replaceAll("-", ""),
      "0".repeat(35),
      "g".repeat(36),
      `${DATABASE_ID}-extra`,
    ]) {
      expect(() => buildProductionConfig("stage", invalid)).toThrow(/canonical D1 UUID/u);
    }
    for (const mode of ["", "production", "STAGE", "live --force"]) {
      expect(() => buildProductionConfig(mode, DATABASE_ID)).toThrow(/stage or live/u);
    }
  });

  it("normalizes the confirmed database ID to lowercase", () => {
    const config = buildProductionConfig("stage", DATABASE_ID.toUpperCase());
    expect(config.d1_databases[0]).toHaveProperty(DATABASE_ID_KEY, DATABASE_ID);
    expect(assertProductionConfig(config, "stage", DATABASE_ID.toUpperCase())).toBe(true);
  });

  it.each([
    ["preview URL", { preview_urls: true }],
    ["extra route", { routes: [{ pattern: "example.com/*" }] }],
    ["custom domain", { custom_domain: true }],
    ["local bypass", { vars: { LOCAL_AUTH_BYPASS: "enabled" } }],
    ["authentication plaintext", { vars: { ALLOWED_EMAIL: "owner@example.test" } }],
    ["asset-first routing", { assets: { run_worker_first: false } }],
    ["different asset path", { assets: { directory: "../../" } }],
    ["different Worker name", { name: "rizakura-hontai" }],
    ["different D1", { d1_databases: [{ binding: "DB", database_name: "other" }] }],
  ])("rejects a config with %s", (_name, changes) => {
    const config = buildProductionConfig("stage", DATABASE_ID);
    const modified = { ...config, ...changes };
    expect(() => assertProductionConfig(modified, "stage", DATABASE_ID)).toThrow();
  });
});
