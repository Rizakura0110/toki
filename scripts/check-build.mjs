import assert from "node:assert/strict";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import { parseSync } from "vite";
import { assertBuiltArtifacts } from "./prepare-production-config.mjs";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const origin = "https://toki-build.example";
const portal = "https://rizakura-hontai.sx7k2p9q.workers.dev/";
const hashedAsset = /^\/assets\/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8}\.(?:js|css)$/u;
const immutablePublicFiles = [
  "manifest.webmanifest",
  "icons/toki.svg",
  "icons/toki-maskable.svg",
  "icons/toki-180.png",
  "icons/toki-192.png",
  "icons/toki-512.png",
  "icons/toki-maskable-512.png",
];
const documents = new Map([
  ["index.html", "measurement"],
  ["calendar.html", "calendar"],
]);
const serverOnlyNames = new Set([
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "TOKI_D1_DATABASE_ID",
  "TEAM_DOMAIN",
  "POLICY_AUD",
  "ALLOWED_EMAIL",
  "LOCAL_AUTH_BYPASS",
  "LOCAL_STUB_MODE",
]);

async function artifactFiles(directory, prefix = "") {
  const status = await lstat(directory);
  assert.ok(status.isDirectory() && !status.isSymbolicLink(), "Artifact directories must be real.");
  const result = [];
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    const relativePath = `${prefix}${name}`;
    const entry = await lstat(path);
    assert.ok(!entry.isSymbolicLink(), `Artifact symlink is forbidden: ${relativePath}`);
    if (entry.isDirectory()) {
      assert.ok(
        ["assets", "icons"].includes(relativePath),
        `Unexpected artifact directory: ${relativePath}`,
      );
      result.push(...(await artifactFiles(path, `${relativePath}/`)));
    } else {
      assert.ok(entry.isFile() && entry.size > 0, `Invalid artifact: ${relativePath}`);
      result.push(relativePath);
    }
  }
  return result.sort();
}

function resolveClientReference(reference, parent, files) {
  assert.ok(typeof reference === "string" && reference.length > 0, "Asset reference is required.");
  const url = new URL(reference, new URL(parent, origin));
  assert.equal(url.origin, origin, `External asset is forbidden: ${reference}`);
  assert.ok(!url.search && !url.hash, `Asset queries or fragments are unexpected: ${reference}`);
  assert.ok(files.has(url.pathname.slice(1)), `Referenced artifact is missing: ${reference}`);
  assert.notEqual(url.pathname, "/.assetsignore", "Build metadata is not a browser resource.");
  return url.pathname;
}

function verifyHtml(source, name, entryName, files) {
  // No scripts or resource loading are enabled while parsing the generated HTML.
  const dom = new JSDOM(source);
  try {
    const document = dom.window.document;
    assert.equal(document.querySelectorAll("style, base, iframe, object, embed").length, 0);
    const references = new Set();
    const entries = [];
    for (const element of document.querySelectorAll("*")) {
      for (const attribute of element.attributes) {
        assert.ok(
          attribute.name !== "style" && !attribute.name.startsWith("on"),
          `Inline styles and event handlers are forbidden in ${name}.`,
        );
        assert.ok(
          !["srcset", "imagesrcset", "poster", "action", "formaction"].includes(attribute.name),
          `Unreviewed resource attribute ${attribute.name} in ${name}.`,
        );
      }
      if (element.tagName === "A") {
        assert.ok(
          ["/", "/index.html", "/calendar.html", portal].includes(element.getAttribute("href")),
          `Unexpected navigation destination in ${name}.`,
        );
      }
      if (element.tagName === "SCRIPT") {
        assert.equal(element.getAttribute("type"), "module");
        assert.equal(element.textContent.trim(), "", `Inline script in ${name}.`);
        const path = resolveClientReference(element.getAttribute("src"), `/${name}`, files);
        assert.match(path, hashedAsset);
        assert.match(path, new RegExp(`^/assets/${entryName}-[A-Za-z0-9_-]{8}\\.js$`, "u"));
        entries.push(path);
        references.add(path);
      } else if (element.hasAttribute("src")) {
        references.add(resolveClientReference(element.getAttribute("src"), `/${name}`, files));
      }
      if (element.tagName === "LINK") {
        const path = resolveClientReference(element.getAttribute("href"), `/${name}`, files);
        const relation = element.getAttribute("rel");
        assert.ok(
          ["stylesheet", "modulepreload", "manifest", "icon", "apple-touch-icon"].includes(
            relation,
          ),
        );
        if (relation === "stylesheet" || relation === "modulepreload") {
          assert.match(path, hashedAsset);
          assert.ok(path.endsWith(relation === "stylesheet" ? ".css" : ".js"));
        }
        if (relation === "manifest") {
          assert.equal(path, "/manifest.webmanifest");
          assert.equal(element.getAttribute("crossorigin"), "use-credentials");
        }
        references.add(path);
      }
      if (element.hasAttribute("href")) {
        assert.ok(["A", "LINK"].includes(element.tagName), `Unreviewed href in ${name}.`);
      }
    }
    assert.equal(entries.length, 1, `${name} must have exactly one expected module entry.`);
    assert.equal(document.querySelectorAll('link[rel="manifest"]').length, 1);
    assert.ok(
      [...references].some((path) => path.endsWith(".css")),
      `${name} needs built CSS.`,
    );
    return references;
  } finally {
    dom.window.close();
  }
}

function verifyJavaScript(source, path, files) {
  const parsed = parseSync(path, source, { sourceType: "module" });
  assert.equal(parsed.errors.length, 0, `Invalid generated JavaScript: ${path}`);
  const references = new Set();
  const stack = [parsed.program];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== "object") continue;
    const name =
      node.type === "Identifier"
        ? node.name
        : node.type === "Literal"
          ? node.value
          : node.type === "TemplateElement"
            ? node.value.cooked
            : null;
    assert.ok(!serverOnlyNames.has(name), `Server-only configuration leaked into ${path}.`);
    if (typeof name === "string") {
      assert.doesNotMatch(
        name,
        /^(?:node:|\/?(?:src|tests|node_modules)\/|\/@(?:vite|fs|id)\/|\/@react-refresh)/u,
      );
    }
    if (
      [
        "ImportDeclaration",
        "ImportExpression",
        "ExportAllDeclaration",
        "ExportNamedDeclaration",
      ].includes(node.type) &&
      node.source !== null &&
      node.source !== undefined
    ) {
      assert.equal(node.source.type, "Literal", `Unverifiable dynamic import in ${path}.`);
      const specifier = node.source.value;
      assert.equal(typeof specifier, "string");
      assert.match(specifier, /^\.\/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8}\.js$/u);
      const target = resolveClientReference(specifier, path, files);
      assert.match(target, hashedAsset);
      references.add(target);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) stack.push(...value);
      else if (value !== null && typeof value === "object") stack.push(value);
    }
  }
  return references;
}

/** Verify local build boundaries only; this never grants production deployment approval. */
export async function assertBuild(root = repositoryRoot) {
  await assertBuiltArtifacts(root);
  const clientDirectory = join(root, "dist/client");
  const files = new Set(await artifactFiles(clientDirectory));
  const fixedFiles = new Set([...documents.keys(), ...immutablePublicFiles, ".assetsignore"]);
  for (const file of files) {
    assert.ok(
      fixedFiles.has(file) || hashedAsset.test(`/${file}`),
      `Unexpected browser artifact: ${file}`,
    );
  }
  for (const file of fixedFiles) assert.ok(files.has(file), `Missing browser artifact: ${file}`);
  assert.equal(
    await readFile(join(clientDirectory, ".assetsignore"), "utf8"),
    "wrangler.json\n.dev.vars\n",
  );
  for (const file of immutablePublicFiles) {
    assert.deepEqual(
      await readFile(join(clientDirectory, file)),
      await readFile(join(root, "public", file)),
      `PWA identity/icon changed during build: ${file}`,
    );
  }

  const referenced = new Set();
  for (const [name, entryName] of documents) {
    const source = await readFile(join(clientDirectory, name), "utf8");
    for (const path of verifyHtml(source, name, entryName, files)) referenced.add(path);
  }
  const graph = new Map();
  let javascriptBytes = 0;
  let cssBytes = 0;
  for (const file of files) {
    if (!hashedAsset.test(`/${file}`)) continue;
    const source = await readFile(join(clientDirectory, file), "utf8");
    assert.doesNotMatch(
      source,
      /[#@]\s*source(?:Mapping)?URL\s*=/u,
      `Source map reference in ${file}.`,
    );
    if (file.endsWith(".js")) {
      javascriptBytes += Buffer.byteLength(source);
      graph.set(`/${file}`, verifyJavaScript(source, `/${file}`, files));
    } else {
      cssBytes += Buffer.byteLength(source);
      // Phase 51 has no remote fonts or CSS resources; Vite must inline all CSS imports.
      assert.doesNotMatch(source, /@import\b|\burl\s*\(/iu, `Unreviewed CSS resource in ${file}.`);
    }
  }
  const pending = [...referenced];
  while (pending.length > 0) {
    for (const dependency of graph.get(pending.pop()) ?? []) {
      if (referenced.has(dependency)) continue;
      referenced.add(dependency);
      pending.push(dependency);
    }
  }
  for (const file of files) {
    if (hashedAsset.test(`/${file}`))
      assert.ok(referenced.has(`/${file}`), `Unreachable output: ${file}`);
  }
  const workerBytes = (await lstat(join(root, "dist/toki/index.js"))).size;
  return { files: files.size, javascriptBytes, cssBytes, workerBytes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await assertBuild();
  console.log(
    `Toki build boundaries passed: ${result.files} client files; raw JS ${result.javascriptBytes} bytes, CSS ${result.cssBytes} bytes, Worker ${result.workerBytes} bytes.`,
  );
}
