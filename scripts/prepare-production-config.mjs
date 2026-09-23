import assert from "node:assert/strict";
import { lstat, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const temporaryRoot = join(repositoryRoot, ".tmp");
const modes = Object.freeze({ stage: false, live: true });
const databaseIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** @typedef {"stage" | "live"} ProductionMode */

/** @param {string} mode */
export function productionConfigPath(mode) {
  if (!Object.hasOwn(modes, mode)) {
    throw new Error("Choose the explicit stage or live production mode.");
  }
  return join(temporaryRoot, `toki-production-${mode}.jsonc`);
}

/**
 * @param {string} mode
 * @param {string | undefined} databaseId
 */
export function buildProductionConfig(mode, databaseId) {
  productionConfigPath(mode);
  if (databaseId === undefined || !databaseIdPattern.test(databaseId)) {
    throw new Error("TOKI_D1_DATABASE_ID must be a canonical D1 UUID (8-4-4-4-12 hexadecimal).");
  }

  return {
    $schema: "../node_modules/wrangler/config-schema.json",
    name: "toki",
    main: "../src/worker.ts",
    compatibility_date: "2026-08-15",
    workers_dev: modes[/** @type {ProductionMode} */ (mode)],
    preview_urls: false,
    assets: {
      directory: "../public",
      binding: "ASSETS",
      html_handling: "none",
      not_found_handling: "none",
      run_worker_first: true,
    },
    d1_databases: [
      {
        binding: "DB",
        database_name: "toki",
        database_id: databaseId.toLowerCase(),
        migrations_dir: "../migrations",
      },
    ],
  };
}

/**
 * The exact shape is intentional: no routes, custom domains, preview URLs,
 * local bypass flags, auth values, extra bindings, or plaintext secrets.
 * @param {unknown} config
 * @param {string} mode
 * @param {string} databaseId
 */
export function assertProductionConfig(config, mode, databaseId) {
  const path = productionConfigPath(mode);
  assert.deepStrictEqual(config, buildProductionConfig(mode, databaseId));
  const expected = /** @type {ReturnType<typeof buildProductionConfig>} */ (config);
  const database = expected.d1_databases[0];
  assert.ok(database);
  assert.equal(resolve(dirname(path), expected.main), join(repositoryRoot, "src/worker.ts"));
  assert.equal(resolve(dirname(path), expected.assets.directory), join(repositoryRoot, "public"));
  assert.equal(resolve(dirname(path), database.migrations_dir), join(repositoryRoot, "migrations"));
  return true;
}

async function ensurePrivateTemporaryRoot() {
  try {
    const status = await lstat(temporaryRoot);
    if (!status.isDirectory() || status.isSymbolicLink()) {
      throw new Error("The repository .tmp path must be a real directory.");
    }
  } catch (cause) {
    if (cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT") {
      await mkdir(temporaryRoot, { mode: 0o700 });
      return;
    }
    throw cause;
  }
}

/**
 * @param {string} mode
 * @param {string | undefined} databaseId
 */
export async function writeProductionConfig(mode, databaseId) {
  const config = buildProductionConfig(mode, databaseId);
  const confirmedDatabaseId = config.d1_databases[0]?.database_id;
  assert.ok(confirmedDatabaseId);
  assertProductionConfig(config, mode, confirmedDatabaseId);
  await ensurePrivateTemporaryRoot();

  const path = productionConfigPath(mode);
  const temporaryPath = join(temporaryRoot, `.toki-production-${mode}-${randomUUID()}.jsonc`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } catch (cause) {
    // A failed preparation must not leave a partial config for a later command.
    const { unlink } = await import("node:fs/promises");
    await unlink(temporaryPath).catch(() => undefined);
    throw cause;
  }
  return path;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const mode = process.argv[2];
  if (process.argv.length !== 3 || mode === undefined) {
    throw new Error("Usage: node scripts/prepare-production-config.mjs stage|live");
  }
  const output = await writeProductionConfig(mode, process.env.TOKI_D1_DATABASE_ID);
  console.log(`Prepared ignored ${mode} Wrangler config: ${output}`);
}
