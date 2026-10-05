import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const execute = promisify(execFile);
const buildCheckScript =
  'import { assertBuild } from "./scripts/check-build.mjs"; console.log(JSON.stringify(await assertBuild(process.argv[1])));';
async function assertBuild(fixtureRoot: string): Promise<{
  files: number;
  javascriptBytes: number;
  cssBytes: number;
  workerBytes: number;
}> {
  const childEnvironment = { ...process.env };
  for (const key of [
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
    "ALLOWED_EMAIL",
    "TEAM_DOMAIN",
    "POLICY_AUD",
  ]) {
    delete childEnvironment[key];
  }
  const result = await execute(
    process.execPath,
    ["--input-type=module", "--eval", buildCheckScript, fixtureRoot],
    {
      cwd: root,
      env: childEnvironment,
    },
  );
  return JSON.parse(result.stdout);
}
const icons = [
  "toki.svg",
  "toki-maskable.svg",
  "toki-180.png",
  "toki-192.png",
  "toki-512.png",
  "toki-maskable-512.png",
];
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

function html(entry: "measurement" | "calendar") {
  return `<!doctype html><html lang="ja"><head>
    <link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials">
    <link rel="stylesheet" href="/assets/styles-abcdefgh.css">
    <script type="module" src="/assets/${entry}-abcdefgh.js"></script>
    </head><body><a href="/calendar.html">カレンダー</a></body></html>`;
}

describe("Vite client artifact boundary gate", () => {
  let fixtureRoot: string;

  async function writeFixture(path: string, content: string) {
    await writeFile(join(fixtureRoot, path), content);
  }

  beforeEach(async () => {
    await mkdir(join(root, ".tmp"), { recursive: true });
    fixtureRoot = await mkdtemp(join(root, ".tmp/phase51-build-test-"));
    for (const directory of [
      "dist/toki",
      "dist/client/assets",
      "dist/client/icons",
      "public/icons",
    ]) {
      await mkdir(join(fixtureRoot, directory), { recursive: true });
    }
    const files: Record<string, string> = {
      "dist/toki/index.js": "export default { fetch() {} };",
      "dist/toki/wrangler.json": JSON.stringify(buildConfig),
      "dist/client/.assetsignore": "wrangler.json\n.dev.vars\n",
      "dist/client/index.html": html("measurement"),
      "dist/client/calendar.html": html("calendar"),
      "dist/client/assets/measurement-abcdefgh.js": 'import "./shared-abcdefgh.js"; export {};',
      "dist/client/assets/calendar-abcdefgh.js": "export {};",
      "dist/client/assets/shared-abcdefgh.js": "export const example = 1;",
      "dist/client/assets/styles-abcdefgh.css": "body { color: black; }",
    };
    const immutableFiles = {
      "manifest.webmanifest": '{"id":"/","start_url":"/","scope":"/"}',
      ...Object.fromEntries(icons.map((name) => [`icons/${name}`, "synthetic icon fixture"])),
    };
    for (const [name, contents] of Object.entries(immutableFiles)) {
      files[`dist/client/${name}`] = contents;
      files[`public/${name}`] = contents;
    }
    await Promise.all(Object.entries(files).map(([path, content]) => writeFixture(path, content)));
  });

  afterEach(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it("accepts a synthetic build and reachable shared chunk without a prior real build", async () => {
    const result = await assertBuild(fixtureRoot);
    expect(result).toEqual({
      files: 14,
      javascriptBytes: expect.any(Number),
      cssBytes: expect.any(Number),
      workerBytes: expect.any(Number),
    });
    expect(result.javascriptBytes).toBeGreaterThan(0);
    expect(result.cssBytes).toBeGreaterThan(0);
    expect(result.workerBytes).toBeGreaterThan(0);
  });

  it.each(["private.json", "worker.js", "assets/measurement-abcdefgh.js.map"])(
    "rejects an extra browser file: %s",
    async (path) => {
      await writeFixture(`dist/client/${path}`, "unexpected output");
      await expect(assertBuild(fixtureRoot)).rejects.toThrow(/Unexpected browser artifact/u);
    },
  );

  it.each(["manifest.webmanifest", "icons/toki-192.png"])(
    "rejects changed PWA bytes: %s",
    async (path) => {
      await writeFixture(`dist/client/${path}`, "modified during bundling");
      await expect(assertBuild(fixtureRoot)).rejects.toThrow(/PWA identity\/icon changed/u);
    },
  );

  it.each([
    '<script type="module">globalThis.example = 1;</script>',
    '<div onclick="globalThis.example = 1">inline event</div>',
    "<style>body { color: red; }</style>",
    '<div style="color: red">inline style</div>',
  ])("rejects inline HTML code or styling", async (fragment) => {
    await writeFixture(
      "dist/client/index.html",
      html("measurement").replace("</body>", `${fragment}</body>`),
    );
    await expect(assertBuild(fixtureRoot)).rejects.toThrow();
  });

  it.each([
    'import "https://example.test/external.js";',
    'import "node:fs";',
    'import "/src/browser/app.js";',
    'import "./missing-abcdefgh.js";',
    "import(name);",
    'export * from "https://example.test/external.js";',
  ])("rejects unreviewed or missing JavaScript imports: %s", async (source) => {
    await writeFixture("dist/client/assets/measurement-abcdefgh.js", source);
    await expect(assertBuild(fixtureRoot)).rejects.toThrow();
  });

  it("rejects a bundle not reachable from either HTML entry", async () => {
    await writeFixture("dist/client/assets/orphan-abcdefgh.js", "export {};");
    await expect(assertBuild(fixtureRoot)).rejects.toThrow(/Unreachable output/u);
  });

  it("rejects browser bundles containing server identity settings", async () => {
    await writeFixture(
      "dist/client/assets/shared-abcdefgh.js",
      'export const TEAM_DOMAIN = "example.test";',
    );
    await expect(assertBuild(fixtureRoot)).rejects.toThrow(/Server-only configuration/u);
  });

  it.each([
    '@import "https://example.test/style.css";',
    'body { background: url("https://example.test/image.png"); }',
  ])("rejects CSS resource loading", async (source) => {
    await writeFixture("dist/client/assets/styles-abcdefgh.css", source);
    await expect(assertBuild(fixtureRoot)).rejects.toThrow(/Unreviewed CSS resource/u);
  });

  it("rejects source-map links in browser bundles", async () => {
    await writeFixture(
      "dist/client/assets/shared-abcdefgh.js",
      "export {};\n//# sourceMappingURL=shared.js.map",
    );
    await expect(assertBuild(fixtureRoot)).rejects.toThrow(/Source map reference/u);
  });
});

describe("local database persistence across Vite rebuilds", () => {
  it("pins dev and local D1 commands to the same repository-relative state path", async () => {
    const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    for (const name of ["dev", "db:migrate:local", "db:verify:local"]) {
      const script = packageJson.scripts[name];
      expect(script).toBeDefined();
      expect(script).toMatch(/(?:^|\s)--persist-to \.wrangler\/state(?:\s|$)/u);
      expect(script).toMatch(/(?:^|\s)--local(?:\s|$)/u);
    }
    expect(packageJson.scripts.dev).toContain("--config dist/toki/wrangler.json");
    for (const name of ["db:migrate:local", "db:verify:local"]) {
      expect(packageJson.scripts[name]).toContain("--config wrangler.jsonc");
    }
  });
});
