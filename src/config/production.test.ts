import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertBuiltArtifacts,
  assertProductionConfig,
  buildProductionConfig,
  productionConfigPath,
} from "../../scripts/prepare-production-config.mjs";

const DATABASE_ID = "01234567-89ab-cdef-0123-456789abcdef";
const DATABASE_ID_KEY = ["database", "id"].join("_");
const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));

describe("Toki production Wrangler config preparation", () => {
  it.each([
    ["stage", false],
    ["live", true],
  ])("uses the explicit %s mode without changing the local config", (mode, workersDev) => {
    const config = buildProductionConfig(mode, DATABASE_ID);
    expect(config.name).toBe("toki");
    expect(config.workers_dev).toBe(workersDev);
    expect(config.preview_urls).toBe(false);
    expect(config.no_bundle).toBe(true);
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
    expect(resolve(configDirectory, config.main)).toBe(
      resolve(REPOSITORY_ROOT, "dist/toki/index.js"),
    );
    expect(resolve(configDirectory, config.assets.directory)).toBe(
      resolve(REPOSITORY_ROOT, "dist/client"),
    );
    expect(resolve(configDirectory, config.d1_databases[0]?.migrations_dir ?? "")).toBe(
      resolve(REPOSITORY_ROOT, "migrations"),
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
    ["source Worker", { main: "../src/worker.ts" }],
    ["rebundling", { no_bundle: false }],
    ["different D1", { d1_databases: [{ binding: "DB", database_name: "other" }] }],
  ])("rejects a config with %s", (_name, changes) => {
    const config = buildProductionConfig("stage", DATABASE_ID);
    const modified = { ...config, ...changes };
    expect(() => assertProductionConfig(modified, "stage", DATABASE_ID)).toThrow();
  });
});

describe("Toki Vite build artifact validation", () => {
  let fixtureRoot: string;
  const buildConfig = {
    name: "toki",
    main: "index.js",
    no_bundle: true,
    workers_dev: false,
    preview_urls: false,
    d1_databases: [
      {
        binding: "DB",
        database_name: "toki-local",
        remote: false,
        migrations_dir: "../../migrations",
      },
    ],
    assets: {
      directory: "../client",
      binding: "ASSETS",
      html_handling: "none",
      not_found_handling: "none",
      run_worker_first: true,
    },
  };
  const html =
    '<link rel="stylesheet" href="/assets/style-Abcd1234.css"><script type="module" src="/assets/app-Zyxw9876.js"></script>';

  beforeEach(async () => {
    const temporaryRoot = join(REPOSITORY_ROOT, ".tmp");
    await mkdir(temporaryRoot, { recursive: true });
    fixtureRoot = await mkdtemp(join(temporaryRoot, "phase51-artifacts-"));
    for (const directory of ["dist/toki", "dist/client/assets", "dist/client/icons"]) {
      await mkdir(join(fixtureRoot, directory), { recursive: true });
    }
    const files: Record<string, string> = {
      "dist/toki/index.js": "export default { fetch() {} };",
      "dist/toki/wrangler.json": JSON.stringify(buildConfig),
      "dist/client/index.html": html,
      "dist/client/calendar.html": html,
      "dist/client/assets/style-Abcd1234.css": "body { color: black; }",
      "dist/client/assets/app-Zyxw9876.js": "export {};",
      "dist/client/manifest.webmanifest": '{"id":"/","start_url":"/","scope":"/"}',
    };
    for (const icon of [
      "toki.svg",
      "toki-maskable.svg",
      "toki-180.png",
      "toki-192.png",
      "toki-512.png",
      "toki-maskable-512.png",
    ]) {
      files[`dist/client/icons/${icon}`] = "synthetic icon fixture";
    }
    await Promise.all(
      Object.entries(files).map(([path, contents]) => writeFile(join(fixtureRoot, path), contents)),
    );
  });

  afterEach(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it("accepts the bundled Worker, both legacy HTML entries and their hashed assets", async () => {
    await expect(assertBuiltArtifacts(fixtureRoot)).resolves.toBe(true);
  });

  it.each([
    "dist/toki/index.js",
    "dist/toki/wrangler.json",
    "dist/client/calendar.html",
    "dist/client/assets/app-Zyxw9876.js",
    "dist/client/assets/style-Abcd1234.css",
    "dist/client/manifest.webmanifest",
    "dist/client/icons/toki-192.png",
  ])("rejects a missing %s", async (path) => {
    await rm(join(fixtureRoot, path));
    await expect(assertBuiltArtifacts(fixtureRoot)).rejects.toThrow();
  });

  it("rejects an empty Worker bundle", async () => {
    await writeFile(join(fixtureRoot, "dist/toki/index.js"), "");
    await expect(assertBuiltArtifacts(fixtureRoot)).rejects.toThrow(/non-empty regular files/u);
  });

  it.each([
    { main: "../../src/worker.ts" },
    { no_bundle: false },
    { workers_dev: true },
    { preview_urls: true },
    { vars: { LOCAL_AUTH_BYPASS: "enabled" } },
    { vars: { ALLOWED_EMAIL: "owner@example.test" } },
    { env: { production: { workers_dev: true } } },
    { definedEnvironments: ["production"] },
    { d1_databases: [] },
    { d1_databases: [{ ...buildConfig.d1_databases[0], remote: true }] },
    { d1_databases: [{ ...buildConfig.d1_databases[0], [DATABASE_ID_KEY]: DATABASE_ID }] },
    { d1_databases: [{ ...buildConfig.d1_databases[0], migrations_dir: "../migrations" }] },
    { assets: { ...buildConfig.assets, directory: "../../public" } },
    { assets: { ...buildConfig.assets, run_worker_first: false } },
    { assets: { ...buildConfig.assets, not_found_handling: "single-page-application" } },
  ])("rejects unsafe or non-built Wrangler config: %j", async (change) => {
    await writeFile(
      join(fixtureRoot, "dist/toki/wrangler.json"),
      JSON.stringify({ ...buildConfig, ...change }),
    );
    await expect(assertBuiltArtifacts(fixtureRoot)).rejects.toThrow();
  });

  it.each([
    html.replace("/assets/app-Zyxw9876.js", "/app.js"),
    html.replace("/assets/style-Abcd1234.css", "/assets/../../private.css"),
    '<script type="module" src="/src/browser/app.ts"></script>',
    "<h1>Incomplete build</h1>",
  ])("rejects source or missing bundle references", async (source) => {
    await writeFile(join(fixtureRoot, "dist/client/index.html"), source);
    await expect(assertBuiltArtifacts(fixtureRoot)).rejects.toThrow();
  });

  it("rejects a symlinked artifact", async () => {
    const path = join(fixtureRoot, "dist/client/assets/app-Zyxw9876.js");
    await rm(path);
    await symlink(join(fixtureRoot, "dist/toki/index.js"), path);
    await expect(assertBuiltArtifacts(fixtureRoot)).rejects.toThrow(/regular files/u);
  });

  it("rejects a symlinked asset directory", async () => {
    const path = join(fixtureRoot, "dist/client/assets");
    await rm(path, { recursive: true });
    await symlink(join(fixtureRoot, "dist/toki"), path, "dir");
    await expect(assertBuiltArtifacts(fixtureRoot)).rejects.toThrow(/symlinks/u);
  });
});
