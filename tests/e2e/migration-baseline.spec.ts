import { type APIRequestContext, expect, type Page, test } from "@playwright/test";

const ORIGIN = "http://127.0.0.1:8791";
const CLOSED_ORIGIN = "http://127.0.0.1:8792";
const WRITE_HEADERS = { Origin: ORIGIN, "X-Toki-Client": "web" };

type OpenSession = {
  id: string;
  status: "running" | "awaiting_description";
};

async function openSession(request: APIRequestContext): Promise<OpenSession | null> {
  const response = await request.get("/api/v1/session");
  expect(response.status()).toBe(200);
  return ((await response.json()) as { session: OpenSession | null }).session;
}

async function measurementIsRunning(page: Page) {
  await expect(page.getByRole("heading", { name: "計測中", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "計測を終了", exact: true })).toBeEnabled();
}

function secondsFromDisplay(value: string | null): number {
  expect(value).toMatch(/^\d+:\d{2}:\d{2}$/u);
  return (value ?? "").split(":").reduce((total, part) => total * 60 + Number(part), 0);
}

// This suite shares only disposable local D1 with the other E2E suites. Failed
// tests must not leave an open measurement blocking the next synthetic scenario.
test.afterEach(async ({ request }) => {
  const session = await openSession(request);
  if (session === null) return;
  if (session.status === "running") {
    const stopped = await request.post(`/api/v1/session/${session.id}/stop`, {
      data: {},
      headers: WRITE_HEADERS,
    });
    expect(stopped.ok()).toBe(true);
  }
  const discarded = await request.post(`/api/v1/session/${session.id}/discard`, {
    data: {},
    headers: WRITE_HEADERS,
  });
  expect(discarded.ok()).toBe(true);
});

for (const mobile of [false, true]) {
  test.describe(`migration URL compatibility ${mobile ? "mobile" : "desktop"}`, () => {
    test.use({
      viewport: mobile ? { width: 320, height: 740 } : { width: 1280, height: 800 },
      isMobile: mobile,
      hasTouch: mobile,
    });

    test("keeps a measurement through legacy URLs, browser history and reloads", async ({
      page,
      request,
    }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const response = await page.goto("/index.html");
      expect(response?.status()).toBe(200);
      await expect(page).toHaveURL(`${ORIGIN}/index.html`);
      await page.getByRole("button", { name: "計測を始める", exact: true }).click();
      await measurementIsRunning(page);
      const started = await openSession(request);
      expect(started?.status).toBe("running");

      await page.getByRole("link", { name: "カレンダーを見る", exact: true }).click();
      await expect(page).toHaveURL(`${ORIGIN}/calendar.html`);
      await expect(page.getByRole("heading", { name: "時間の記録", exact: true })).toBeVisible();
      await page.goBack();
      await expect(page).toHaveURL(`${ORIGIN}/index.html`);
      await measurementIsRunning(page);
      await page.goForward();
      await expect(page).toHaveURL(`${ORIGIN}/calendar.html`);
      await page.reload();
      await expect(page.getByRole("heading", { name: "時間の記録", exact: true })).toBeVisible();
      await page.getByRole("link", { name: "計測画面へ", exact: true }).click();
      await expect(page).toHaveURL(`${ORIGIN}/`);
      await measurementIsRunning(page);
      expect((await openSession(request))?.id).toBe(started?.id);

      await page.getByRole("button", { name: "計測を終了", exact: true }).click();
      await expect(page.getByRole("heading", { name: "何をしていましたか？" })).toBeVisible();
      await page.reload();
      await expect(page.getByRole("heading", { name: "何をしていましたか？" })).toBeVisible();
      await page.goto("/index.html");
      await expect(page.getByRole("heading", { name: "何をしていましたか？" })).toBeVisible();
      expect(await openSession(request)).toMatchObject({
        id: started?.id,
        status: "awaiting_description",
      });
      page.once("dialog", async (dialog) => {
        expect(dialog.type()).toBe("confirm");
        expect(dialog.message()).toBe("この計測を保存せずに破棄しますか？");
        await dialog.accept();
      });
      await page.getByRole("button", { name: "保存せず破棄", exact: true }).click();
      await expect(page.getByRole("button", { name: "計測を始める", exact: true })).toBeEnabled();
      expect(await openSession(request)).toBeNull();
      expect(errors).toEqual([]);
    });
  });
}

for (const mode of ["stopwatch", "timer"] as const) {
  test(`${mode} advances locally in normal and focus views without per-second API requests`, async ({
    page,
    request,
  }) => {
    await page.clock.install();
    const apiRequests: string[] = [];
    page.on("request", (outgoing) => {
      const url = new URL(outgoing.url());
      if (url.pathname.startsWith("/api/v1/")) {
        apiRequests.push(`${outgoing.method()} ${url.pathname}`);
      }
    });
    await page.goto("/");
    if (mode === "timer") {
      await page.getByRole("radio", { name: /タイマー/u }).check();
      await page.getByLabel("時間", { exact: true }).fill("0");
      await page.getByLabel("分", { exact: true }).fill("2");
      await page.getByLabel("秒", { exact: true }).fill("0");
    }
    await page.getByRole("button", { name: "計測を始める", exact: true }).click();
    await measurementIsRunning(page);
    const initialRequests = [...apiRequests];
    const initialSession = await openSession(request);
    const timer = page.getByRole("timer");
    const initialSeconds = secondsFromDisplay(await timer.textContent());

    await page.clock.runFor(6_000);
    const normalSeconds = secondsFromDisplay(await timer.textContent());
    expect(
      mode === "stopwatch" ? normalSeconds - initialSeconds : initialSeconds - normalSeconds,
    ).toBeGreaterThanOrEqual(5);
    expect(apiRequests).toEqual(initialRequests);

    await page.getByRole("button", { name: "時間だけ表示", exact: true }).click();
    await expect(page.getByRole("heading", { name: "計測中", exact: true })).toBeHidden();
    await expect(timer).toHaveCount(1);
    await page.clock.runFor(6_000);
    const focusSeconds = secondsFromDisplay(await timer.textContent());
    expect(
      mode === "stopwatch" ? focusSeconds - normalSeconds : normalSeconds - focusSeconds,
    ).toBeGreaterThanOrEqual(5);
    await page.keyboard.press("Escape");
    await measurementIsRunning(page);
    expect(apiRequests).toEqual(initialRequests);
    // Animating the browser clock must not write a duration or create another session.
    expect(await openSession(request)).toEqual(initialSession);
  });
}

test("legacy documents protect built hashed assets and source or unknown URLs stay 404", async ({
  page,
  request,
}) => {
  const paths = new Set(["/", "/index.html", "/calendar.html"]);
  const browserModules = new Set<string>();
  page.on("request", (outgoing) => {
    const url = new URL(outgoing.url());
    if (url.pathname.startsWith("/assets/")) {
      expect(url.origin).toBe(ORIGIN);
      browserModules.add(url.pathname);
    }
  });
  for (const path of ["/index.html", "/calendar.html"]) {
    const document = await page.goto(path);
    expect(document?.status()).toBe(200);
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
      "href",
      "/manifest.webmanifest",
    );
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
      "crossorigin",
      "use-credentials",
    );
    // Discover the actual Vite outputs rather than pinning generated hashes.
    // Include shared module-preload chunks as well as page entrypoints.
    const linkedPaths = await page
      .locator(
        'script[src], link[rel="stylesheet"], link[rel="modulepreload"], link[rel="manifest"], link[rel="icon"], link[rel="apple-touch-icon"]',
      )
      .evaluateAll((elements) =>
        elements.map((element) => {
          const url = new URL(
            element.getAttribute("src") ?? element.getAttribute("href") ?? "",
            location.href,
          );
          if (url.origin !== location.origin) throw new Error("Unexpected external asset");
          return url.pathname;
        }),
      );
    for (const linkedPath of linkedPaths) paths.add(linkedPath);
  }
  expect(browserModules.size).toBeGreaterThanOrEqual(3);
  for (const path of browserModules) paths.add(path);
  for (const path of paths) {
    if (path.endsWith(".js") || path.endsWith(".css")) {
      expect(path).toMatch(/^\/assets\/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8}\.(?:js|css)$/u);
    }
  }
  for (const path of paths) {
    const allowed = await request.get(path);
    expect(allowed.status(), path).toBe(200);
    expect(allowed.headers()["cache-control"], path).toBe("no-store");
    expect(allowed.headers()["x-content-type-options"], path).toBe("nosniff");
    expect(allowed.headers()["content-security-policy"], path).toContain("worker-src 'none'");
    const denied = await request.get(`${CLOSED_ORIGIN}${path}`);
    expect(denied.status(), path).toBe(403);
    expect(await denied.text(), path).toBe("Unavailable");
    const head = await request.head(path);
    expect(head.status(), path).toBe(200);
    expect(head.headers()["cache-control"], path).toBe("no-store");
    expect(await head.body(), path).toHaveLength(0);
  }
  for (const path of [
    "/not-a-toki-page",
    "/not-a-toki-page.html",
    "/assets/missing.js",
    "/assets/missing-Abcd1234.js",
    "/app.js",
    "/styles.css",
    "/calendar.js",
    "/calendar.css",
    "/calendar-core.js",
    "/src/client/app.js",
    "/src/worker.ts",
    "/.vite/manifest.json",
    "/.assetsignore",
    "/wrangler.jsonc",
    "/@vite/client",
    "/@react-refresh",
    ...[...browserModules].map((path) => `${path}.map`),
  ]) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(404);
    expect(response.headers()["cache-control"], path).toBe("no-store");
    expect(await response.text(), path).toBe("Not found");
    const denied = await request.get(`${CLOSED_ORIGIN}${path}`);
    expect(denied.status(), path).toBe(403);
    expect(await denied.text(), path).toBe("Unavailable");
  }
  const head = await request.head("/api/v1/session");
  expect(head.status()).toBe(405);
  expect(head.headers()["cache-control"]).toBe("no-store");
  expect(head.headers()["content-type"]).toBe("application/json; charset=utf-8");
  expect(await head.body()).toHaveLength(0);
});

test("HTTP routing preserves JSON errors, exact paths and explicit HEAD rejection", async ({
  request,
}) => {
  const id = "123e4567-e89b-42d3-a456-426614174000";
  const invalidId = "------------------------------------";
  for (const [path, method, status, code] of [
    ["/api/v1/session", "HEAD", 405, "METHOD_NOT_ALLOWED"],
    ["/api/v1/records?startMs=1&endMs=2", "HEAD", 405, "METHOD_NOT_ALLOWED"],
    [`/api/v1/session/${invalidId}/stop?extra=1`, "GET", 405, "METHOD_NOT_ALLOWED"],
    [`/api/v1/session/${invalidId}/stop?extra=1`, "POST", 400, "INVALID_QUERY"],
    [`/api/v1/records/${invalidId}?extra=1`, "GET", 400, "INVALID_QUERY"],
    [`/api/v1/records/${invalidId}`, "GET", 404, "NOT_FOUND"],
    [`/api/v1/records/${id}?extra=1`, "HEAD", 400, "INVALID_QUERY"],
    [`/api/v1/session/%31${id.slice(1)}/stop`, "POST", 404, "NOT_FOUND"],
    [`/api/v1/records/${id.toUpperCase()}`, "PATCH", 404, "NOT_FOUND"],
    ["/api/v1/session/", "GET", 404, "NOT_FOUND"],
    ["/api/v1/Session", "GET", 404, "NOT_FOUND"],
    ["/api/v1/unknown", "POST", 404, "NOT_FOUND"],
  ] as const) {
    const response = await request.fetch(path, {
      method,
      headers: { ...WRITE_HEADERS, "Content-Type": "application/json" },
    });
    expect(response.status(), `${method} ${path}`).toBe(status);
    expect(response.headers()["content-type"]).toBe("application/json; charset=utf-8");
    expect(response.headers()["cache-control"]).toBe("no-store");
    expect(response.headers()["x-content-type-options"]).toBe("nosniff");
    expect(response.headers().allow).toBeUndefined();
    if (method === "HEAD") expect(await response.body()).toHaveLength(0);
    else expect(await response.json()).toEqual({ error: { code } });
  }
  const unsafeUnknown = await request.post("/api/v1/unknown");
  expect(unsafeUnknown.status()).toBe(403);
  expect(await unsafeUnknown.json()).toEqual({ error: { code: "UNSAFE_REQUEST" } });
  const unauthorizedUnknown = await request.post(`${CLOSED_ORIGIN}/api/v1/unknown`);
  expect(unauthorizedUnknown.status()).toBe(403);
  expect(await unauthorizedUnknown.json()).toEqual({ error: { code: "FORBIDDEN" } });
});
