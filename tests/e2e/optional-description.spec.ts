import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { dayRange, tokyoDateKey } from "../../public/calendar-core.js";

type SavedRecord = {
  id: string;
  description: string;
  startedAtMs: number;
  endedAtMs: number;
  version: number;
};

async function records(request: APIRequestContext, date: string): Promise<SavedRecord[]> {
  const { startMs, endMs } = dayRange(date);
  const response = await request.get(`/api/v1/records?startMs=${startMs}&endMs=${endMs}`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { records: SavedRecord[] }).records;
}

async function showDay(page: Page, date: string) {
  await page.goto("/calendar.html");
  const dayButton = page.getByRole("button", { name: "日", exact: true });
  if (await dayButton.isVisible()) await dayButton.click();
  await page.locator("#calendar-date").fill(date);
  await page.locator("#calendar-date").dispatchEvent("change");
  await expect(page.locator("#calendar-loading")).toBeHidden();
}

// The suite runs only against disposable local D1. Clean up a failed measurement
// so that it cannot prevent a later test from starting its own session.
test.afterEach(async ({ request }) => {
  const current = await request.get("/api/v1/session");
  if (!current.ok()) return;
  const { session } = (await current.json()) as {
    session: { id: string; status: string } | null;
  };
  if (session === null) return;
  const headers = { Origin: "http://127.0.0.1:8791", "X-Toki-Client": "web" };
  if (session.status === "running") {
    await request.post(`/api/v1/session/${session.id}/stop`, { data: {}, headers });
  }
  await request.post(`/api/v1/session/${session.id}/discard`, { data: {}, headers });
});

for (const mobile of [false, true]) {
  test.describe(`optional manual content ${mobile ? "mobile" : "desktop"}`, () => {
    test.use({
      viewport: mobile ? { width: 320, height: 740 } : { width: 1280, height: 800 },
      isMobile: mobile,
      hasTouch: mobile,
    });

    test("creates a minute-aligned untitled record, reloads and edits its optional content", async ({
      page,
      request,
    }, testInfo) => {
      const date = mobile ? "2043-05-17" : "2043-05-16";
      const startMs = dayRange(date).startMs;
      await showDay(page, date);
      await page.locator("#new-record").click();
      await expect(page.locator("#create-start")).toHaveAttribute("step", "60");
      await expect(page.locator("#create-end")).toHaveAttribute("step", "60");
      await expect(page.locator("#create-start")).toHaveValue(`${date}T09:00`);
      await expect(page.locator("#create-end")).toHaveValue(`${date}T10:00`);
      await expect(page.locator("#create-description")).not.toHaveAttribute("required");
      await page.locator("#create-start").fill(`${date}T10:12`);
      await page.locator("#create-end").fill(`${date}T10:12`);
      await page.locator("#create-save").click();
      await expect(page.locator("#create-error-text")).toContainText("終了は開始より後");
      expect(await records(request, date)).toEqual([]);
      await page.locator("#create-end").fill(`${date}T10:14`);
      if (mobile) await page.locator("#create-description").fill(" \n　");
      await page.screenshot({ path: testInfo.outputPath("manual-minute-form.png") });
      await page.locator("#create-save").click();
      await expect(page.locator("#create-dialog")).toBeHidden();
      await expect(page.locator(".timeline-event-title")).toHaveText(["無題"]);
      await expect(page.locator(".record-description")).toHaveText(["無題"]);
      const [saved] = await records(request, date);
      if (saved === undefined) throw new Error("Manual record missing");
      expect(saved).toMatchObject({
        description: "無題",
        startedAtMs: startMs + (10 * 60 + 12) * 60_000,
        endedAtMs: startMs + (10 * 60 + 14) * 60_000,
      });
      await showDay(page, date);
      await page.locator(".timeline-event").click();
      await expect(page.locator("#edit-description")).toHaveValue("無題");
      await page.locator("#edit-description").fill("後で付けた名前");
      await page.locator("#edit-save").click();
      await expect(page.locator("#edit-dialog")).toBeHidden();
      await expect(page.locator(".timeline-event-title")).toHaveText(["後で付けた名前"]);
      await page.locator(".timeline-event").click();
      await page.locator("#edit-description").fill("");
      await page.locator("#edit-save").click();
      await expect(page.locator("#edit-dialog")).toBeHidden();
      await expect(page.locator(".timeline-event-title")).toHaveText(["無題"]);
      await showDay(page, date);
      await expect(page.locator(".timeline-event-title")).toHaveText(["無題"]);
      const reloaded = await records(request, date);
      expect(reloaded).toHaveLength(1);
      expect(reloaded[0]).toMatchObject({
        id: saved.id,
        description: "無題",
        startedAtMs: saved.startedAtMs,
        endedAtMs: saved.endedAtMs,
        version: saved.version + 2,
      });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    });
  });
}

for (const mode of ["stopwatch", "timer"] as const) {
  test(`saves an empty ${mode} result as untitled while preserving its measured instants`, async ({
    page,
    request,
  }) => {
    await page.goto("/");
    await expect(page.locator("#idle-panel")).toBeVisible();
    if (mode === "timer") {
      await page.getByRole("radio", { name: /タイマー/u }).check();
      await page.locator("#timer-hours").fill("0");
      await page.locator("#timer-minutes").fill("0");
      await page.locator("#timer-seconds").fill("1");
    }
    await page.locator("#start-button").click();
    if (mode === "stopwatch") await page.locator("#stop-button").click();
    await expect(page.locator("#description-panel")).toBeVisible();
    const current = await request.get("/api/v1/session");
    expect(current.ok()).toBe(true);
    const { session } = (await current.json()) as { session: SavedRecord };
    await expect(page.locator("#description")).toHaveValue("");
    await expect(page.locator("#description")).not.toHaveAttribute("required");
    await page.locator("#save-button").click();
    await expect(page.locator("#idle-panel")).toBeVisible();
    const date = tokyoDateKey(session.startedAtMs);
    const saved = (await records(request, date)).find((record) => record.id === session.id);
    expect(saved).toMatchObject({
      description: "無題",
      startedAtMs: session.startedAtMs,
      endedAtMs: session.endedAtMs,
    });
    if (saved === undefined) throw new Error("Measured record missing");
    await showDay(page, date);
    const event = page
      .getByRole("button", { name: /^無題、.*編集する$/u })
      .filter({ has: page.locator(".timeline-event-title") })
      .last();
    await expect(event).toBeVisible();
    await event.click();
    await expect(page.locator("#edit-start")).toHaveAttribute("step", "1");
    const renamed = `${mode}計測後に付けた名前`;
    await page.locator("#edit-description").fill(renamed);
    await page.locator("#edit-save").click();
    await expect(page.locator("#edit-dialog")).toBeHidden();
    await expect(page.locator(".timeline-event-title").filter({ hasText: renamed })).toBeVisible();
    expect((await records(request, date)).find((record) => record.id === saved.id)).toMatchObject({
      id: saved.id,
      startedAtMs: saved.startedAtMs,
      endedAtMs: saved.endedAtMs,
      description: renamed,
      version: saved.version + 1,
    });
  });
}
