import { expect, test } from "@playwright/test";
import { dayRange } from "../../src/client/calendar-core";

const ORIGIN = "http://127.0.0.1:8791";
for (const mobile of [false, true]) {
  test.describe(`React navigation and retries ${mobile ? "mobile" : "desktop"}`, () => {
    test.use({
      viewport: mobile ? { width: 320, height: 740 } : { width: 1280, height: 800 },
      isMobile: mobile,
      hasTouch: mobile,
    });
    test("keeps one measurement and draft through client navigation, and reconciles an unknown save", async ({
      page,
      request,
    }, info) => {
      const mutations: string[] = [],
        errors: string[] = [];
      page.on("request", (outgoing) => {
        if (outgoing.method() !== "GET") mutations.push(new URL(outgoing.url()).pathname);
      });
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto("/");
      await expect(page.locator("#start-button")).toBeEnabled();
      await page.screenshot({ path: info.outputPath("measurement-idle.png"), fullPage: true });
      await page.evaluate(() => {
        Object.defineProperty(window, "tokiNavigationSentinel", { value: true });
        const button = document.querySelector<HTMLButtonElement>("#start-button");
        button?.click();
        button?.click();
      });
      await expect(page.locator("#running-panel")).toBeVisible();
      expect(mutations).toEqual(["/api/v1/session"]);
      await page.screenshot({ path: info.outputPath("measurement-running.png"), fullPage: true });
      await page.locator("#enter-focus").click();
      await expect(page.locator("#exit-focus")).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(page.locator("#enter-focus")).toBeFocused();
      await page.locator("#stop-button").click();
      await expect(page.locator("#description-panel")).toBeVisible();
      await page.locator("#description").fill("Phase54 actual synthetic activity");
      const before = [...mutations];
      await page.getByRole("link", { name: /カレンダーを見る/u }).click();
      await expect(page).toHaveURL(`${ORIGIN}/calendar.html`);
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
      await page.getByRole("link", { name: "計測画面へ", exact: true }).click();
      await expect(page.locator("#description")).toHaveValue("Phase54 actual synthetic activity");
      expect(await page.evaluate(() => Object.hasOwn(window, "tokiNavigationSentinel"))).toBe(true);
      expect(mutations).toEqual(before);
      const session = (await (await request.get("/api/v1/session")).json()).session;
      await page.route("**/api/v1/session/*/save", async (route) => {
        await route.fetch();
        await route.abort("failed");
      });
      await page.evaluate(() => {
        const button = document.querySelector<HTMLButtonElement>("#save-button");
        button?.click();
        button?.click();
      });
      await expect(page.locator("#retry-sync")).toBeVisible();
      await expect(page.locator("#save-button")).toBeDisabled();
      await page.locator("#retry-sync").click();
      await expect(page.locator("#sync-error-text")).toContainText(
        "直前の保存結果は確認できません",
      );
      expect(mutations.filter((path) => path.endsWith("/save"))).toHaveLength(1);
      const range = dayRange(
        new Intl.DateTimeFormat("en-CA", {
          timeZone: "Asia/Tokyo",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date(session.startedAtMs)),
      );
      const records = (
        await (
          await request.get(`/api/v1/records?startMs=${range.startMs}&endMs=${range.endMs}`)
        ).json()
      ).records;
      expect(records.filter((record: { id: string }) => record.id === session.id)).toHaveLength(1);
      expect(errors).toEqual([]);
    });
    test("locks uncertain manual input, retries identically and confirms a single deletion", async ({
      page,
      request,
    }, info) => {
      const date = mobile ? "2044-02-02" : "2044-02-01",
        payloads: string[] = [],
        deletes: string[] = [];
      let loseReply = true;
      await page.route("**/api/v1/records", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        payloads.push(route.request().postData() ?? "");
        if (loseReply) {
          loseReply = false;
          await route.fetch();
          await route.abort("failed");
        } else await route.continue();
      });
      page.on("request", (outgoing) => {
        if (outgoing.method() === "DELETE") deletes.push(outgoing.url());
      });
      await page.goto("/calendar.html");
      await page.locator("#new-record").click();
      await expect(page.locator("#create-start")).toBeFocused();
      await page.locator("#create-start").fill(`${date}T09:01`);
      await page.locator("#create-end").fill(`${date}T09:02`);
      await page.evaluate(() => {
        const button = document.querySelector<HTMLButtonElement>("#create-save");
        button?.click();
        button?.click();
      });
      await expect(page.locator("#create-save")).toHaveText("同じ内容で再試行");
      await expect(page.locator("#create-start")).toBeDisabled();
      await expect(page.locator("#create-description")).toBeDisabled();
      await page.screenshot({ path: info.outputPath("manual-uncertain.png"), fullPage: true });
      await page.locator("#create-save").click();
      await expect(page.locator("#create-dialog")).not.toBeVisible();
      expect(payloads).toHaveLength(2);
      expect(payloads[0]).toBe(payloads[1]);
      const range = dayRange(date),
        url = `/api/v1/records?startMs=${range.startMs}&endMs=${range.endMs}`;
      const records = (await (await request.get(url)).json()).records;
      expect(records).toHaveLength(1);
      expect(records[0].description).toBe("無題");
      expect(records[0].startedAtMs % 60000).toBe(0);
      await page.locator(".record-button").click();
      await page.locator("#edit-delete").click();
      await expect(page.locator("#delete-confirm")).toBeFocused();
      await page.locator("#delete-cancel").click();
      await expect(page.locator("#edit-delete")).toBeFocused();
      expect(deletes).toHaveLength(0);
      await page.locator("#edit-delete").click();
      await page.evaluate(() => {
        const button = document.querySelector<HTMLButtonElement>("#delete-confirm");
        button?.click();
        button?.click();
      });
      await expect(page.locator("#edit-dialog")).not.toBeVisible();
      expect(deletes).toHaveLength(1);
      expect((await (await request.get(url)).json()).records).toEqual([]);
    });
  });
}
