import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { dayRange, tokyoDateKey } from "../../src/client/calendar-core";

const headers = { Origin: "http://127.0.0.1:8791", "X-Toki-Client": "web" };

async function openSession(request: APIRequestContext) {
  const response = await request.get("/api/v1/session");
  expect(response.status()).toBe(200);
  return (await response.json()).session as {
    id: string;
    status: string;
    startedAtMs: number;
    draftDescription: string | null;
    tag: string | null;
  } | null;
}

async function showDay(page: Page, date: string) {
  await page.goto("/calendar.html");
  const day = page.getByRole("button", { name: "日", exact: true });
  if (await day.isVisible()) await day.click();
  await page.locator("#calendar-date").fill(date);
  await page.locator("#calendar-date").dispatchEvent("change");
  await expect(page.locator("#calendar-loading")).toBeHidden();
}

test.afterEach(async ({ request }) => {
  const session = await openSession(request);
  if (session === null) return;
  if (session.status === "running") {
    await request.post(`/api/v1/session/${session.id}/stop`, { data: {}, headers });
  }
  await request.post(`/api/v1/session/${session.id}/discard`, { data: {}, headers });
});

for (const mobile of [false, true]) {
  test.describe(`content and fixed tags ${mobile ? "mobile" : "desktop"}`, () => {
    test.use({
      viewport: mobile ? { width: 320, height: 740 } : { width: 1280, height: 800 },
      isMobile: mobile,
      hasTouch: mobile,
    });

    for (const mode of ["stopwatch", "timer"] as const) {
      test(`${mode} restores initial content and tag, permits final changes and clears the next draft`, async ({
        page,
        request,
      }, testInfo) => {
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto("/");
        await expect(page.locator("#idle-panel")).toBeVisible();
        await expect(page.locator("#start-description")).not.toHaveAttribute("required");
        await expect(page.locator("#start-tag option")).toHaveText([
          "タグなし",
          "仕事",
          "家事",
          "自己研鑽",
          "雑務",
          "趣味の時間",
          "だらけた時間",
        ]);
        await page.locator("#start-description").fill("開始前の予定");
        await page.locator("#start-tag").selectOption("work");
        if (mode === "timer") {
          await page.getByRole("radio", { name: /タイマー/u }).check();
          await page.locator("#timer-hours").fill("0");
          await page.locator("#timer-minutes").fill("0");
          // Avoid Wrangler's local proxy keep-alive race at exactly 5 seconds
          // (workers-sdk#14641/#15452). Expiry/retention is still tested through
          // real HTTP; the D1 regression also covers the five-second deadline.
          await page.locator("#timer-seconds").fill("6");
        }
        await page.screenshot({ path: testInfo.outputPath("before-start.png") });
        await page.locator("#start-button").click();
        await expect(page.locator("#running-panel")).toBeVisible();
        const session = await openSession(request);
        if (session === null) throw new Error("Missing started session");
        expect(session).toMatchObject({ draftDescription: "開始前の予定", tag: "work" });
        await page.locator("#enter-focus").click();
        await expect(page.locator("#focus-view")).toBeVisible();
        await expect(page.locator("#focus-view")).not.toContainText("開始前の予定");
        await expect(page.locator("#focus-view .time-tag")).toHaveCount(0);
        await page.reload();
        if (mode === "stopwatch") await page.locator("#stop-button").click();
        await expect(page.locator("#description-panel")).toBeVisible();
        await expect(page.locator("#description")).toHaveValue("開始前の予定");
        await expect(page.locator("#description-tag")).toHaveValue("work");
        await page.reload();
        await expect(page.locator("#description")).toHaveValue("開始前の予定");
        await expect(page.locator("#description-tag")).toHaveValue("work");
        const finalDescription = `${mobile ? "スマホ" : "PC"}${mode}の実績${testInfo.repeatEachIndex}`;
        await page.locator("#description").fill(finalDescription);
        await page.locator("#description-tag").selectOption("self_development");
        // A recovery refresh must not overwrite the user's unsaved final changes.
        await Promise.all([
          page.waitForResponse(
            (response) =>
              response.url().endsWith("/api/v1/session") &&
              response.request().method() === "GET" &&
              response.status() === 200,
          ),
          page.evaluate(() =>
            window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })),
          ),
        ]);
        await expect(page.locator("#description")).toHaveValue(finalDescription);
        await expect(page.locator("#description-tag")).toHaveValue("self_development");
        await page.locator("#save-button").click();
        await expect(page.locator("#idle-panel")).toBeVisible();
        await expect(page.locator("#start-description")).toHaveValue("");
        await expect(page.locator("#start-tag")).toHaveValue("");
        const date = tokyoDateKey(session.startedAtMs);
        await showDay(page, date);
        const event = page.locator(".timeline-event").filter({ hasText: finalDescription });
        await expect(event.locator(".timeline-event-title")).toHaveText(finalDescription);
        await expect(event.locator(".time-tag")).toHaveText("自己研鑽");
        await event.scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath("calendar-tag.png") });
        await event.click();
        await expect(page.locator("#edit-description")).toHaveValue(finalDescription);
        await expect(page.locator("#edit-tag")).toHaveValue("self_development");
        await page.locator("#edit-cancel").click();
        await expect(page.locator("#edit-dialog")).toBeHidden();
        expect(errors).toEqual([]);
      });
    }

    test("manual untitled records support every fixed tag, persisted changes and explicit clearing", async ({
      page,
      request,
    }, testInfo) => {
      const date = mobile ? "2048-03-22" : "2048-03-21";
      await showDay(page, date);
      await page.locator("#new-record").click();
      await page.locator("#create-start").fill(`${date}T09:00`);
      await page.locator("#create-end").fill(`${date}T09:01`);
      await page.locator("#create-tag").selectOption("housework");
      await page.locator("#create-save").click();
      await expect(page.locator("#create-dialog")).toBeHidden();
      const event = page.locator(".timeline-event");
      await expect(event.locator(".timeline-event-title")).toHaveText("無題");
      await expect(event.locator(".time-tag")).toHaveText("家事");
      await showDay(page, date);
      for (const [tag, label] of [
        ["chores", "雑務"],
        ["hobby", "趣味の時間"],
        ["relaxation", "だらけた時間"],
      ] as const) {
        await event.click();
        await page.locator("#edit-tag").selectOption(tag);
        await page.locator("#edit-save").click();
        await expect(page.locator("#edit-dialog")).toBeHidden();
        await expect(event.locator(".time-tag")).toHaveText(label);
      }
      await event.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath("short-untitled-tag.png") });
      await event.click();
      await page.locator("#edit-tag").selectOption("");
      await page.locator("#edit-save").click();
      await expect(page.locator("#edit-dialog")).toBeHidden();
      await showDay(page, date);
      await expect(event.locator(".timeline-event-title")).toHaveText("無題");
      await expect(event.locator(".time-tag")).toHaveCount(0);
      const { startMs, endMs } = dayRange(date);
      const response = await request.get(`/api/v1/records?startMs=${startMs}&endMs=${endMs}`);
      expect(response.status()).toBe(200);
      expect((await response.json()).records).toMatchObject([
        { description: "無題", tag: null, startedAtMs: startMs + 9 * 3_600_000 },
      ]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    });
  });
}
