import assert from "node:assert/strict";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const temporaryRoot = join(repositoryRoot, ".tmp");
const modes = Object.freeze({ stage: false, live: true });
const databaseIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const builtAssetPath = /^\/assets\/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8}\.(?:js|css)$/u;

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
    main: "../dist/toki/index.js",
    no_bundle: true,
    compatibility_date: "2026-08-15",
    workers_dev: modes[/** @type {ProductionMode} */ (mode)],
    preview_urls: false,
    assets: {
      directory: "../dist/client",
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
  assert.equal(resolve(dirname(path), expected.main), join(repositoryRoot, "dist/toki/index.js"));
  assert.equal(
    resolve(dirname(path), expected.assets.directory),
    join(repositoryRoot, "dist/client"),
  );
  assert.equal(resolve(dirname(path), database.migrations_dir), join(repositoryRoot, "migrations"));
  return true;
}

/** @param {string} path */
async function assertRegularArtifact(path) {
  const status = await lstat(path);
  assert.ok(
    status.isFile() && !status.isSymbolicLink() && status.size > 0,
    "Build artifacts must be non-empty regular files.",
  );
}

/**
 * Validate the Vite output, never silently fall back to source or public/.
 * A synthetic root is supported for local tests; the writer always uses this repository.
 * This checks artifact shape, not release approval or build provenance.
 * @param {string} root
 */
export async function assertBuiltArtifacts(root = repositoryRoot) {
  const workerDirectory = join(root, "dist/toki");
  const clientDirectory = join(root, "dist/client");
  for (const directory of [
    "dist",
    "dist/toki",
    "dist/client",
    "dist/client/assets",
    "dist/client/icons",
  ]) {
    const status = await lstat(join(root, directory));
    assert.ok(
      status.isDirectory() && !status.isSymbolicLink(),
      "Build directories must not be symlinks.",
    );
  }
  await assertRegularArtifact(join(workerDirectory, "index.js"));
  await assertRegularArtifact(join(workerDirectory, "wrangler.json"));
  const config = JSON.parse(await readFile(join(workerDirectory, "wrangler.json"), "utf8"));
  assert.equal(config.name, "toki");
  assert.equal(config.main, "index.js");
  assert.equal(config.no_bundle, true);
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.deepStrictEqual(
    config.vars ?? {},
    {},
    "Build config must not include auth or bypass variables.",
  );
  assert.deepStrictEqual(
    config.env ?? {},
    {},
    "Build config must not include alternate environments.",
  );
  assert.deepStrictEqual(
    config.definedEnvironments ?? [],
    [],
    "Build config must not include alternate environments.",
  );
  assert.ok(Array.isArray(config.d1_databases) && config.d1_databases.length === 1);
  const database = config.d1_databases[0];
  assert.equal(database.binding, "DB");
  assert.equal(database.database_name, "toki-local");
  assert.equal(database.remote, false);
  assert.equal(Object.hasOwn(database, "database_id"), false);
  assert.equal(typeof database.migrations_dir, "string");
  assert.equal(resolve(workerDirectory, database.migrations_dir), resolve(root, "migrations"));
  assert.deepStrictEqual(config.assets, {
    directory: "../client",
    binding: "ASSETS",
    html_handling: "none",
    not_found_handling: "none",
    run_worker_first: true,
  });

  for (const html of ["index.html", "calendar.html"]) {
    await assertRegularArtifact(join(clientDirectory, html));
    const source = await readFile(join(clientDirectory, html), "utf8");
    const references = [...source.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="([^"]+)"[^>]*>/gu)]
      .map((match) => match[1])
      .filter((path) => path !== undefined && /\.(?:js|css)$/u.test(path));
    assert.ok(
      references.some((path) => path?.endsWith(".js")),
      "Built HTML must reference a JavaScript bundle.",
    );
    assert.ok(
      references.some((path) => path?.endsWith(".css")),
      "Built HTML must reference a CSS bundle.",
    );
    for (const path of references) {
      assert.ok(
        path && builtAssetPath.test(path),
        "HTML must reference only hashed Vite JS/CSS assets.",
      );
      await assertRegularArtifact(join(clientDirectory, path));
    }
  }
  for (const file of [
    "manifest.webmanifest",
    "icons/toki.svg",
    "icons/toki-maskable.svg",
    "icons/toki-180.png",
    "icons/toki-192.png",
    "icons/toki-512.png",
    "icons/toki-maskable-512.png",
  ]) {
    await assertRegularArtifact(join(clientDirectory, file));
  }
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
  await assertBuiltArtifacts();
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
