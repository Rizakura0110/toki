import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertBuiltArtifacts } from "./prepare-production-config.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const wrangler = fileURLToPath(
  new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
);
const mode = process.argv[2];
if (mode !== "open" && mode !== "closed") {
  throw new Error("Expected the local E2E server mode: open or closed.");
}

const port = mode === "open" ? 8791 : 8792;
const buildConfig = join(root, "dist/toki/wrangler.json");
await assertBuiltArtifacts();
const tmpRoot = join(root, ".tmp");
await mkdir(tmpRoot, { recursive: true });
// Give each run its own D1 so simultaneous checks cannot delete each other's data.
const stateRoot = await mkdtemp(join(tmpRoot, `toki-e2e-${mode}-`));
const persistence = await mkdtemp(join(stateRoot, "state-"));
const localEnv = {
  ...process.env,
  CI: "true",
  WRANGLER_SEND_METRICS: "false",
};
// Local smoke tests never inherit production credentials or identity settings.
for (const key of [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "ALLOWED_EMAIL",
  "TEAM_DOMAIN",
  "POLICY_AUD",
]) {
  delete localEnv[key];
}

function command(args) {
  const child = spawn(process.execPath, [wrangler, ...args], {
    cwd: root,
    env: localEnv,
    stdio: "inherit",
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Local Wrangler command exited with ${code ?? "a signal"}.`));
    });
  });
}

try {
  if (mode === "open") {
    await command([
      "d1",
      "migrations",
      "apply",
      "DB",
      "--config",
      buildConfig,
      "--local",
      "--persist-to",
      persistence,
    ]);
  }

  const args = [
    "dev",
    "--config",
    buildConfig,
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--persist-to",
    persistence,
    "--var",
    `LOCAL_AUTH_BYPASS:${mode === "open" ? "enabled" : "disabled"}`,
    "--var",
    `LOCAL_STUB_MODE:${mode === "open" ? "enabled" : "disabled"}`,
  ];
  const server = spawn(process.execPath, [wrangler, ...args], {
    cwd: root,
    env: localEnv,
    stdio: "inherit",
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => server.kill(signal));
  }
  const code = await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.once("exit", resolve);
  });
  if (code !== 0 && code !== null) process.exitCode = code;
} finally {
  await rm(stateRoot, { recursive: true, force: true });
}
