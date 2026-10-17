import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { checkArtifactBudgets } from "./check-artifact-budgets.mjs";
import { assertProductionConfig, buildProductionConfig } from "./prepare-production-config.mjs";
import { verifyBaseline } from "./release-baseline.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
await verifyBaseline();
console.log(JSON.stringify(await checkArtifactBudgets(root), null, 2));
const temporaryRoot = join(root, ".tmp");
const directory = await mkdtemp(join(temporaryRoot, "phase55-dry-run-"));
// Purely synthetic ID. No production config, credentials or remote state is read.
const syntheticId = "11111111-1111-4111-8111-111111111111";
const env = { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "true" };
for (const key of [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "TOKI_D1_DATABASE_ID",
  "ALLOWED_EMAIL",
  "TEAM_DOMAIN",
  "POLICY_AUD",
  "CLOUDFLARE_ENV",
])
  delete env[key];
const configs = [];
try {
  for (const mode of ["stage", "live"]) {
    const config = buildProductionConfig(mode, syntheticId);
    assertProductionConfig(config, mode, syntheticId);
    // Same directory depth as production configs, but never overwrite the real fixed paths.
    const path = join(temporaryRoot, `${directory.split("/").at(-1)}-${mode}.jsonc`);
    await writeFile(path, `${JSON.stringify(config)}\n`, { flag: "wx", mode: 0o600 });
    configs.push(path);
    const output = await promisify(execFile)(
      process.execPath,
      [
        join(root, "node_modules/wrangler/bin/wrangler.js"),
        "deploy",
        "--dry-run",
        "--config",
        path,
        "--outdir",
        join(directory, mode),
      ],
      { cwd: directory, env, timeout: 60_000, maxBuffer: 1024 * 1024 },
    );
    assert.match(output.stdout, /dry.run/iu);
    assert.deepEqual(
      await readFile(join(directory, mode, "index.js")),
      await readFile(join(root, "dist/toki/index.js")),
    );
    console.log(
      `${mode}: exact configuration and unchanged Worker dry-run passed (synthetic D1 only).`,
    );
  }
} finally {
  for (const path of configs) await rm(path, { force: true });
  await rm(directory, { recursive: true, force: true });
}
