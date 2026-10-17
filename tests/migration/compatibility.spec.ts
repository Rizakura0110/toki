import { type APIRequestContext, expect, test } from "@playwright/test";
import { dayRange, tokyoDateKey } from "../../src/client/calendar-core";

type RecordData = {
  id: string;
  clientRequestId: string;
  startedAtMs: number;
  endedAtMs: number;
  description: string;
  version: number;
};

function headers(baseURL: string | undefined) {
  if (!baseURL) throw new Error("Explicit local matrix origin required.");
  return { Origin: baseURL, "X-Toki-Client": "web" };
}

async function current(request: APIRequestContext) {
  const response = await request.get("/api/v1/session");
  expect(response.status()).toBe(200);
  return (await response.json()).session as { id: string; status: string } | null;
}

test.afterEach(async ({ request, baseURL }) => {
  const session = await current(request);
  if (!session) return;
  if (session.status === "running") {
    expect(
      (
        await request.post(`/api/v1/session/${session.id}/stop`, {
          data: {},
          headers: headers(baseURL),
        })
      ).status(),
    ).toBe(200);
  }
  expect(
    (
      await request.post(`/api/v1/session/${session.id}/discard`, {
        data: {},
        headers: headers(baseURL),
      })
    ).status(),
  ).toBe(200);
});

for (const mobile of [false, true]) {
  test.describe(mobile ? "mobile 320" : "desktop 1280", () => {
    test.use({
      viewport: mobile ? { width: 320, height: 740 } : { width: 1280, height: 800 },
      isMobile: mobile,
      hasTouch: mobile,
    });

    test("manual blank/minute input, second preservation, stale edit and confirmed deletion", async ({
      page,
      request,
      baseURL,
    }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const date = mobile ? "2045-06-12" : "2045-06-11";
      await page.goto("/calendar.html");
      if (!mobile) await page.getByRole("button", { name: "日", exact: true }).click();
      await page.locator("#calendar-date").fill(date);
      await page.locator("#calendar-date").dispatchEvent("change");
      await expect(page.locator("#calendar-loading")).toBeHidden();
      await page.locator("#new-record").click();
      await expect(page.locator("#create-start")).toHaveAttribute("step", "60");
      await page.locator("#create-start").fill(`${date}T09:00`);
      await page.locator("#create-end").fill(`${date}T09:01`);
      await page.locator("#create-description").fill("");
      await page.locator("#create-save").click();
      await expect(page.locator("#create-dialog")).toBeHidden();
      await expect(page.locator("#records-list")).toContainText("無題");

      const range = dayRange(date);
      const response = await request.get(
        `/api/v1/records?startMs=${range.startMs}&endMs=${range.endMs}`,
      );
      const { records } = (await response.json()) as { records: RecordData[] };
      const manual = records.find((record) => record.description === "無題");
      if (!manual) throw new Error("Missing manual record.");
      expect(manual.startedAtMs % 60_000).toBe(0);
      expect(manual.endedAtMs % 60_000).toBe(0);

      await page.reload();
      await page.locator("#calendar-date").fill(date);
      await page.locator("#calendar-date").dispatchEvent("change");
      await page.locator("#records-list button").filter({ hasText: "無題" }).click();
      const changed = await request.patch(`/api/v1/records/${manual.id}`, {
        headers: headers(baseURL),
        data: {
          ...manual,
          expectedVersion: manual.version,
          description: "別画面の更新",
          startedAtMs: manual.startedAtMs + 123,
          endedAtMs: manual.endedAtMs + 456,
        },
      });
      // The API contract is strict: do not send response-only fields as input.
      expect(changed.status()).toBe(400);
      const patch = await request.patch(`/api/v1/records/${manual.id}`, {
        headers: headers(baseURL),
        data: {
          expectedVersion: manual.version,
          description: "別画面の更新",
          startedAtMs: manual.startedAtMs + 123,
          endedAtMs: manual.endedAtMs + 456,
        },
      });
      expect(patch.status()).toBe(200);
      await page.locator("#edit-description").fill("古い変更");
      await page.locator("#edit-save").click();
      await expect(page.locator("#edit-error-text")).toContainText(
        "ほかの画面で記録が更新されました",
      );
      await page.locator("#edit-reload").click();
      await expect(page.locator("#edit-dialog")).toBeHidden();
      await page.locator("#records-list button").filter({ hasText: "別画面の更新" }).click();
      await expect(page.locator("#edit-description")).toHaveValue("別画面の更新");
      await page.locator("#edit-description").fill("秒とミリ秒を維持");
      await page.locator("#edit-save").click();
      await expect(page.locator("#edit-dialog")).toBeHidden();
      const after = await request.get(
        `/api/v1/records?startMs=${range.startMs}&endMs=${range.endMs}`,
      );
      const edited = ((await after.json()).records as RecordData[]).find(
        (record) => record.id === manual.id,
      );
      expect(edited).toMatchObject({
        startedAtMs: manual.startedAtMs + 123,
        endedAtMs: manual.endedAtMs + 456,
      });
      await page.locator("#records-list button").filter({ hasText: "秒とミリ秒を維持" }).click();
      await page.locator("#edit-delete").click();
      await expect(page.locator("#delete-confirmation")).toBeVisible();
      await page.locator("#delete-cancel").click();
      await expect(page.locator("#delete-confirmation")).toBeHidden();
      await page.locator("#edit-delete").click();
      await page.locator("#delete-confirm").click();
      await expect(page.locator("#edit-dialog")).toBeHidden();
      const replay = await request.post("/api/v1/records", {
        data: {
          clientRequestId: manual.clientRequestId,
          startedAtMs: manual.startedAtMs,
          endedAtMs: manual.endedAtMs,
          description: "",
        },
        headers: headers(baseURL),
      });
      expect(replay.status()).toBe(409);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect(errors).toEqual([]);
    });

    test("stopwatch survives focus and reload, saves blank text and preserves PWA identity", async ({
      page,
      request,
    }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto("/");
      await expect(page.locator("#idle-panel")).toBeVisible();
      await page.locator("#start-button").click();
      await expect(page.locator("#running-panel")).toBeVisible();
      const before = await current(request);
      await page.locator("#enter-focus").click();
      await expect(page.locator("#focus-view")).toBeVisible();
      await page.reload();
      await expect(page.locator("#running-panel")).toBeVisible();
      expect(await current(request)).toEqual(before);
      await page.locator("#stop-button").click();
      await expect(page.locator("#description-panel")).toBeVisible();
      await page.locator("#description").fill("");
      await page.locator("#save-button").click();
      await expect(page.locator("#idle-panel")).toBeVisible();
      await page.goto("/calendar.html");
      if (!mobile) await page.getByRole("button", { name: "日", exact: true }).click();
      await page.locator("#calendar-date").fill(tokyoDateKey(Date.now()));
      await page.locator("#calendar-date").dispatchEvent("change");
      await expect(page.locator("#records-list")).toContainText("無題");
      const manifest = await request.get("/manifest.webmanifest");
      expect(manifest.status()).toBe(200);
      expect(await manifest.json()).toMatchObject({
        id: "/",
        start_url: "/",
        scope: "/",
        display: "standalone",
      });
      expect(manifest.headers()["cache-control"]).toBe("no-store");
      for (const icon of [
        "toki-180.png",
        "toki-192.png",
        "toki-512.png",
        "toki-maskable-512.png",
      ]) {
        expect((await request.get(`/icons/${icon}`)).status()).toBe(200);
      }
      expect(
        await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length),
      ).toBe(0);
      expect(errors).toEqual([]);
    });

    test("timer deadline survives reload and can be discarded without a saved record", async ({
      page,
      request,
    }) => {
      await page.goto("/");
      await expect(page.locator("#idle-panel")).toBeVisible();
      await page.locator('input[name="mode"][value="timer"]').check();
      await page.locator("#timer-hours").fill("0");
      await page.locator("#timer-minutes").fill("0");
      await page.locator("#timer-seconds").fill("3");
      await page.locator("#start-button").click();
      await expect(page.locator("#running-panel")).toBeVisible();
      await page.locator("#enter-focus").click();
      await expect(page.locator("#focus-view")).toBeVisible();
      const before = await current(request);
      await page.reload();
      await expect(page.locator("#description-panel")).toBeVisible();
      expect((await current(request))?.id).toBe(before?.id);
      page.once("dialog", (dialog) => dialog.accept());
      await page.locator("#discard-button").click();
      await expect(page.locator("#idle-panel")).toBeVisible();
      await page.reload();
      await expect(page.locator("#idle-panel")).toBeVisible();
      expect(await current(request)).toBeNull();
    });
  });
}
