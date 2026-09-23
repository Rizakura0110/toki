import { expect, test, type APIRequestContext } from "@playwright/test";
import { addDays, dayRange, tokyoDateKey } from "../../public/calendar-core.js";

const ORIGIN = "http://127.0.0.1:8791";
const CLOSED_ORIGIN = "http://127.0.0.1:8792";

type Session = {
  id: string;
  status: "running" | "awaiting_description" | "saved" | "discarded";
  startedAtMs: number;
  version: number;
};
type Record = {
  id: string;
  startedAtMs: number;
  endedAtMs: number;
  description: string;
  version: number;
};

async function post(request: APIRequestContext, path: string, body: object): Promise<Session> {
  const response = await request.post(path, {
    data: body,
    headers: { Origin: ORIGIN, "X-Toki-Client": "web" },
  });
  expect(response.ok(), `${path}: ${response.status()} ${await response.text()}`).toBe(true);
  const payload = (await response.json()) as { session: Session };
  return payload.session;
}

async function patch(
  request: APIRequestContext,
  record: Record,
  description: string,
): Promise<Record> {
  const response = await request.patch(`/api/v1/records/${record.id}`, {
    data: {
      startedAtMs: record.startedAtMs,
      endedAtMs: record.endedAtMs,
      description,
      expectedVersion: record.version,
    },
    headers: { Origin: ORIGIN, "X-Toki-Client": "web" },
  });
  expect(response.ok(), `PATCH record: ${response.status()} ${await response.text()}`).toBe(true);
  const payload = (await response.json()) as { record: Record };
  return payload.record;
}

async function recordsForDay(request: APIRequestContext, dateKey: string): Promise<Record[]> {
  const range = dayRange(dateKey);
  const response = await request.get(
    `/api/v1/records?startMs=${range.startMs}&endMs=${range.endMs}`,
  );
  expect(response.ok()).toBe(true);
  const payload = (await response.json()) as { records: Record[] };
  return payload.records;
}

async function seedOverlappingRecord(
  request: APIRequestContext,
  startMs: number,
  endMs: number,
): Promise<Record> {
  const started = await post(request, "/api/v1/session", {
    mode: "stopwatch",
    clientRequestId: crypto.randomUUID(),
  });
  await post(request, `/api/v1/session/${started.id}/stop`, {});
  const saved = await post(request, `/api/v1/session/${started.id}/save`, {
    description: "Phase42 overlap",
  });
  const response = await request.patch(`/api/v1/records/${started.id}`, {
    data: {
      startedAtMs: startMs,
      endedAtMs: endMs,
      description: "Phase42 overlap",
      expectedVersion: saved.version,
    },
    headers: { Origin: ORIGIN, "X-Toki-Client": "web" },
  });
  expect(response.ok(), `PATCH overlap: ${response.status()} ${await response.text()}`).toBe(true);
  const payload = (await response.json()) as { record: Record };
  return payload.record;
}

test.afterEach(async ({ request }) => {
  // Each suite run uses disposable D1, and a failed test must not block the next start.
  const response = await request.get("/api/v1/session");
  if (!response.ok()) return;
  const payload = (await response.json()) as { session: Session | null };
  if (payload.session === null) return;
  if (payload.session.status === "running") {
    await post(request, `/api/v1/session/${payload.session.id}/stop`, {});
  }
  await post(request, `/api/v1/session/${payload.session.id}/discard`, {});
});

test("desktop stopwatch survives reload, saves a cross-midnight record and rejects stale edits", async ({
  page,
  request,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/");
  await expect(page.locator("#idle-panel")).toBeVisible();
  await page.locator("#start-button").click();
  await expect(page.locator("#running-panel")).toBeVisible();

  const current = await request.get("/api/v1/session");
  const { session } = (await current.json()) as { session: Session };
  const dateKey = tokyoDateKey(session.startedAtMs);
  const nextDate = addDays(dateKey, 1);
  await page.locator("#enter-focus").click();
  await expect(page.locator("#focus-view")).toBeVisible();
  await expect(page.locator("#normal-view")).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(page.locator("#normal-view")).toBeVisible();
  await page.reload();
  await expect(page.locator("#running-panel")).toBeVisible();
  await page.locator("#stop-button").click();
  await expect(page.locator("#description-panel")).toBeVisible();
  await page.locator("#description").fill("Phase42 stopwatch");
  await page.locator("#save-button").click();
  await expect(page.locator("#idle-panel")).toBeVisible();

  await page.getByRole("link", { name: /カレンダーを見る/u }).click();
  await page.locator("#calendar-date").fill(dateKey);
  await page.locator("#calendar-date").dispatchEvent("change");
  await expect(page.getByText("Phase42 stopwatch").first()).toBeVisible();
  await expect(page.locator(".timeline-day")).toHaveCount(7);
  await page.getByRole("button", { name: "日", exact: true }).click();
  await expect(page.locator(".timeline-day")).toHaveCount(1);

  await page
    .getByRole("button", { name: /Phase42 stopwatch.*編集する/u })
    .last()
    .click();
  await page.locator("#edit-start").fill(`${dateKey}T23:30`);
  await page.locator("#edit-end").fill(`${nextDate}T00:30`);
  await page.locator("#edit-description").fill("Phase42 cross midnight");
  await page.locator("#edit-save").click();
  await expect(page.getByText("Phase42 cross midnight").first()).toBeVisible();
  await page.locator("#calendar-date").fill(nextDate);
  await page.locator("#calendar-date").dispatchEvent("change");
  await expect(page.getByText("Phase42 cross midnight").first()).toBeVisible();

  const record = (await recordsForDay(request, nextDate)).find(
    (item) => item.description === "Phase42 cross midnight",
  );
  expect(record).toBeDefined();
  if (record === undefined) throw new Error("Edited record was not returned by the local D1 API.");
  await page
    .getByRole("button", { name: /Phase42 cross midnight.*編集する/u })
    .last()
    .click();
  await patch(request, record, "Phase42 other tab");
  await page.locator("#edit-description").fill("Phase42 stale overwrite");
  await page.locator("#edit-save").click();
  await expect(page.locator("#edit-error-text")).toContainText("ほかの画面で記録が更新されました");
  await expect(page.locator("#edit-save")).toBeDisabled();
  await page.locator("#edit-reload").click();
  await expect(page.getByText("Phase42 other tab").first()).toBeVisible();

  const nextRange = dayRange(nextDate);
  await seedOverlappingRecord(
    request,
    nextRange.startMs + 15 * 60_000,
    nextRange.startMs + 45 * 60_000,
  );
  await page.reload();
  await page.getByRole("button", { name: "日", exact: true }).click();
  await page.locator("#calendar-date").fill(nextDate);
  await page.locator("#calendar-date").dispatchEvent("change");
  await expect(page.getByText("Phase42 overlap").first()).toBeVisible();
  await expect(page.locator(".timeline-day .timeline-event")).toHaveCount(2);
  expect(pageErrors).toEqual([]);
});

test.describe("320px mobile", () => {
  test.use({
    viewport: { width: 320, height: 740 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });

  test("timer enters focus mode, expires by server time and appears on the day calendar", async ({
    page,
    request,
  }) => {
    test.setTimeout(60_000);
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto("/");
    await expect(page.locator("#idle-panel")).toBeVisible();
    await page.getByRole("radio", { name: /タイマー/u }).check();
    await page.locator("#timer-hours").fill("0");
    await page.locator("#timer-minutes").fill("0");
    await page.locator("#timer-seconds").fill("20");
    await page.locator("#start-button").click();
    await expect(page.locator("#running-panel")).toBeVisible();
    await expect(page.locator("#running-time-label")).toHaveText("残り時間");
    const current = await request.get("/api/v1/session");
    const { session } = (await current.json()) as { session: Session };
    const dateKey = tokyoDateKey(session.startedAtMs);
    await page.locator("#enter-focus").click();
    await expect(page.locator("#focus-view")).toBeVisible();
    await expect(page.locator("#normal-view")).toBeHidden();
    await expect(page.locator("#description-panel")).toBeVisible({ timeout: 35_000 });
    await expect(page.locator("#focus-view")).toBeHidden();
    await page.locator("#description").fill("Phase42 timer");
    await page.locator("#save-button").click();
    await expect(page.locator("#idle-panel")).toBeVisible();
    await page.getByRole("link", { name: /カレンダーを見る/u }).click();
    await page.locator("#calendar-date").fill(dateKey);
    await page.locator("#calendar-date").dispatchEvent("change");
    await expect(page.getByText("Phase42 timer").first()).toBeVisible();
    await expect(page.locator(".timeline-day")).toHaveCount(1);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.reload();
    await expect(page.getByText("Phase42 timer").first()).toBeVisible();
    expect(pageErrors).toEqual([]);
  });
});

test("PWA assets are protected and anonymous pages, assets and API fail closed", async ({
  page,
  request,
}) => {
  const pageResponse = await page.goto("/");
  expect(pageResponse?.status()).toBe(200);
  expect(pageResponse?.headers()["content-security-policy"]).toContain("worker-src 'none'");
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    "href",
    "/manifest.webmanifest",
  );
  const manifestResponse = await request.get("/manifest.webmanifest");
  expect(manifestResponse.status()).toBe(200);
  const manifest = (await manifestResponse.json()) as {
    id: string;
    start_url: string;
    scope: string;
  };
  expect(manifest).toMatchObject({ id: "/", start_url: "/", scope: "/" });
  for (const path of ["/icons/toki-180.png", "/icons/toki-192.png", "/icons/toki-512.png"]) {
    const icon = await request.get(path);
    expect(icon.status()).toBe(200);
    expect(icon.headers()["content-type"]).toContain("image/png");
  }
  expect(
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length),
  ).toBe(0);

  for (const path of [
    "/",
    "/calendar.html",
    "/manifest.webmanifest",
    "/icons/toki-192.png",
    "/api/v1/session",
  ]) {
    const denied = await request.get(`${CLOSED_ORIGIN}${path}`);
    expect(denied.status(), path).toBe(403);
    expect(await denied.text()).not.toContain("Phase42");
  }
  const unsafe = await request.post("/api/v1/session", {
    data: { mode: "stopwatch", clientRequestId: crypto.randomUUID() },
    headers: { "X-Toki-Client": "web" },
  });
  expect(unsafe.status()).toBe(403);
});
