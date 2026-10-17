import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
export const baselineCommit = "bab03ef5084b980c481b8126fd34b18604c84249";

export async function verifyBaseline() {
  const directory = join(root, "tests/fixtures/phase48");
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  assert.equal(manifest.commit, baselineCommit);
  assert.equal(Object.keys(manifest.files).length, 14);
  for (const [path, expected] of Object.entries(manifest.files)) {
    assert.match(path, /^(?:src|public)\/[\w./-]+$/u);
    assert.ok(!path.includes(".."));
    const actual = createHash("sha256")
      .update(await readFile(join(directory, path)))
      .digest("hex");
    assert.equal(actual, expected, `Fixed Phase 48 fixture changed: ${path}`);
  }
  const unchanged = JSON.parse(await readFile(join(directory, "unchanged.json"), "utf8"));
  assert.equal(Object.keys(unchanged).length, 9);
  for (const [path, expected] of Object.entries(unchanged)) {
    assert.match(path, /^(?:migrations|public)\/[\w./-]+$/u);
    assert.ok(!path.includes(".."));
    assert.equal(
      createHash("sha256")
        .update(await readFile(join(root, path)))
        .digest("hex"),
      expected,
      `Migration/PWA identity changed since Phase 48: ${path}`,
    );
  }
  return directory;
}

/** @param {string} destination */
export async function prepareLegacyAssets(destination) {
  const directory = await verifyBaseline();
  await cp(join(directory, "public"), destination, { recursive: true, errorOnExist: true });
  // Icons and the PWA identity are unchanged by the migration (also checked in Git review).
  await cp(join(root, "public/icons"), join(destination, "icons"), { recursive: true });
  assert.deepEqual(
    await readFile(join(root, "public/manifest.webmanifest")),
    await readFile(join(destination, "manifest.webmanifest")),
  );
}
