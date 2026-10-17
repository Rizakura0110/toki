import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { assertBuiltArtifacts } from "./prepare-production-config.mjs";

// Project regression budgets, not Cloudflare plan limits. Raw and gzip are both guarded.
export const budgets = Object.freeze({
  worker: { raw: 512 * 1024, gzip: 128 * 1024 },
  javascript: { raw: 320 * 1024, gzip: 110 * 1024 },
  stylesheet: { raw: 32 * 1024, gzip: 10 * 1024 },
});

/** @param {string} kind @param {{ raw: number, gzip: number }} sizes */
export function assertBudget(kind, sizes) {
  assert.ok(Object.hasOwn(budgets, kind), "Unknown artifact budget.");
  const limit = budgets[/** @type {keyof typeof budgets} */ (kind)];
  for (const metric of /** @type {const} */ (["raw", "gzip"])) {
    assert.ok(Number.isSafeInteger(sizes[metric]) && sizes[metric] > 0);
    assert.ok(sizes[metric] <= limit[metric], `${kind} ${metric} budget exceeded.`);
  }
}

export async function checkArtifactBudgets(root = fileURLToPath(new URL("../", import.meta.url))) {
  await assertBuiltArtifacts(root);
  const assets = join(root, "dist/client/assets");
  const files = await readdir(assets);
  assert.ok(files.length > 0 && files.length <= 8, "Unexpected number of client artifacts.");
  assert.ok(
    files.every((path) => /\.(?:js|css)$/u.test(path)),
    "Unexpected client artifact.",
  );
  const groups = {
    worker: [join(root, "dist/toki/index.js")],
    javascript: files.filter((path) => path.endsWith(".js")).map((path) => join(assets, path)),
    stylesheet: files.filter((path) => path.endsWith(".css")).map((path) => join(assets, path)),
  };
  const report = /** @type {Record<string, { raw: number, gzip: number }>} */ ({});
  for (const [kind, paths] of Object.entries(groups)) {
    const sizes = { raw: 0, gzip: 0 };
    for (const path of paths) {
      const contents = await readFile(path);
      sizes.raw += contents.length;
      sizes.gzip += gzipSync(contents).length;
    }
    assertBudget(kind, sizes);
    report[kind] = sizes;
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await checkArtifactBudgets(), null, 2));
}
