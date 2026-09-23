import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceDir = join(repositoryRoot, "src");
const sourceFiles = readdirSync(sourceDir).filter((name) => name.endsWith(".ts"));
const checkedFiles = [
  ...sourceFiles.map((name) => join(sourceDir, name)),
  join(repositoryRoot, "package.json"),
  join(repositoryRoot, "wrangler.jsonc"),
];

for (const path of checkedFiles) {
  const contents = readFileSync(path, "utf8");
  if (
    /@rizakura-hontai\/|modules\/(?:daymark|tech-inbox)|database_id|APP_ORIGIN|POLICY_AUD|ALLOWED_EMAIL/u.test(
      contents,
    )
  ) {
    throw new Error(`Toki independence or non-sensitive config boundary failed: ${path}`);
  }
}

const wrangler = JSON.parse(readFileSync(join(repositoryRoot, "wrangler.jsonc"), "utf8"));
if (wrangler.workers_dev !== false || wrangler.preview_urls !== false) {
  throw new Error("Phase 36 Worker must have no public workers.dev or preview URL.");
}
if (wrangler.d1_databases?.length !== 1 || wrangler.d1_databases[0]?.binding !== "DB") {
  throw new Error("Phase 36 must define exactly one Toki-only local D1 binding.");
}
if (wrangler.d1_databases[0]?.remote !== false) {
  throw new Error("Phase 36 D1 binding must be local-only.");
}

console.log("Toki repository and local-only Cloudflare boundaries passed.");
