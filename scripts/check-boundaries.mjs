import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceDir = join(repositoryRoot, "src");
function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && /\.(?:[cm]?[jt]sx?|html|css)$/u.test(entry.name) ? [path] : [];
  });
}

const checkedFiles = [
  ...sourceFiles(sourceDir),
  ...sourceFiles(join(repositoryRoot, "public")),
  join(repositoryRoot, "package.json"),
];

for (const path of checkedFiles) {
  const contents = readFileSync(path, "utf8");
  if (/@rizakura-hontai\/|modules\/(?:daymark|tech-inbox)|database_id/u.test(contents)) {
    throw new Error(`Toki independence boundary failed: ${path}`);
  }
}

const wrangler = JSON.parse(readFileSync(join(repositoryRoot, "wrangler.jsonc"), "utf8"));
if (
  /(?:TEAM_DOMAIN|POLICY_AUD|ALLOWED_EMAIL|LOCAL_AUTH_BYPASS|database_id)/u.test(
    readFileSync(join(repositoryRoot, "wrangler.jsonc"), "utf8"),
  )
) {
  throw new Error("Toki Worker configuration must not contain auth values or a remote D1 ID.");
}
if (wrangler.workers_dev !== false || wrangler.preview_urls !== false) {
  throw new Error("Phase 36 Worker must have no public workers.dev or preview URL.");
}
if (
  wrangler.assets?.directory !== "./public" ||
  wrangler.assets?.binding !== "ASSETS" ||
  wrangler.assets?.run_worker_first !== true ||
  wrangler.assets?.not_found_handling !== "none"
) {
  throw new Error("Toki static assets must always pass through the Worker Access gate.");
}
if (wrangler.d1_databases?.length !== 1 || wrangler.d1_databases[0]?.binding !== "DB") {
  throw new Error("Phase 36 must define exactly one Toki-only local D1 binding.");
}
if (wrangler.d1_databases[0]?.remote !== false) {
  throw new Error("Phase 36 D1 binding must be local-only.");
}

console.log("Toki repository and local-only Cloudflare boundaries passed.");
