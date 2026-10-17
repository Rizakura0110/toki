import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertBuiltArtifacts } from "./prepare-production-config.mjs";
import { prepareLegacyAssets } from "./release-baseline.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const modes = { "old-new": 8793, "new-old": 8794, rollback: 8795 };
const mode = process.argv[2];
if (!Object.hasOwn(modes, mode)) throw new Error("Explicit local migration matrix mode required.");
await assertBuiltArtifacts();
await mkdir(join(root, ".tmp"), { recursive: true });
const directory = await mkdtemp(join(root, ".tmp/phase55-matrix-"));
const config = join(directory, "wrangler.json");
const env = { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" };
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
const wrangler = join(root, "node_modules/wrangler/bin/wrangler.js");
let active;
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    stopping = true;
    active?.kill(signal);
  });
}
function command(args) {
  if (stopping) throw new Error("Local matrix server stopped before startup.");
  active = spawn(process.execPath, [wrangler, ...args], {
    // Never load the real repository's .dev.vars or .env into the test worker.
    cwd: directory,
    env,
    stdio: "inherit",
  });
  return new Promise((resolve, reject) => {
    active.once("error", reject);
    active.once("exit", (code, signal) => {
      if (code === 0 || (signal && stopping)) resolve();
      else reject(new Error(`Local matrix command exited with ${code ?? signal}.`));
    });
  });
}
try {
  const assets = mode === "new-old" ? join(root, "dist/client") : join(directory, "assets");
  if (mode !== "new-old") await prepareLegacyAssets(assets);
  await writeFile(
    config,
    JSON.stringify({
      name: `toki-matrix-${mode}`,
      main: join(root, "tests/migration/worker.ts"),
      compatibility_date: "2026-08-15",
      workers_dev: false,
      preview_urls: false,
      assets: {
        directory: assets,
        binding: "ASSETS",
        run_worker_first: true,
        html_handling: "none",
        not_found_handling: "none",
      },
      d1_databases: [
        {
          binding: "DB",
          database_name: `matrix-${mode}`,
          remote: false,
          migrations_dir: join(root, "migrations"),
        },
      ],
      vars: { LOCAL_STUB_MODE: "enabled", LOCAL_AUTH_BYPASS: "enabled", MATRIX_MODE: mode },
    }),
    { flag: "wx", mode: 0o600 },
  );
  const state = join(directory, "state");
  await command([
    "d1",
    "migrations",
    "apply",
    "DB",
    "--config",
    config,
    "--local",
    "--persist-to",
    state,
  ]);
  await command([
    "dev",
    "--config",
    config,
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    String(modes[mode]),
    "--inspector-port",
    String(modes[mode] + 1000),
    "--persist-to",
    state,
  ]);
} finally {
  await rm(directory, { recursive: true, force: true });
}
