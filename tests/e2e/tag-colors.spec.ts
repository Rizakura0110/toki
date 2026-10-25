import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { addDays, dayRange } from "../../src/client/calendar-core";
import type { TimeTag } from "../../src/contracts/tags";

const ORIGIN = "http://127.0.0.1:8791";
const headers = { Origin: ORIGIN, "X-Toki-Client": "web" };
const palette = [
  { tag: "work", label: "仕事", description: "計画", background: "#dceafc", hover: "#c9defb" },
  {
    tag: "housework",
    label: "家事",
    description: "掃除",
    background: "#dceee4",
    hover: "#c8e5d5",
  },
  {
    tag: "self_development",
    label: "自己研鑽",
    description: "読書",
    background: "#eee1f8",
    hover: "#e1cdf1",
  },
  { tag: "chores", label: "雑務", description: "事務", background: "#fff0c5", hover: "#f9e3a3" },
  {
    tag: "hobby",
    label: "趣味の時間",
    description: "趣味",
    background: "#fce0eb",
    hover: "#f7cbdc",
  },
  {
    tag: "relaxation",
    label: "だらけた時間",
    description: "休息",
    background: "#d9f0f4",
    hover: "#bfe5ed",
  },
  { tag: null, label: null, description: "記録", background: "#e8ebee", hover: "#d9dfe5" },
] as const satisfies readonly {
  tag: TimeTag | null;
  label: string | null;
  description: string;
  background: string;
  hover: string;
}[];

interface LocalRecord {
  id: string;
  description: string;
  startedAtMs: number;
  endedAtMs: number;
  version: number;
  tag: TimeTag | null;
}

function rgb(hex: string): string {
  return `rgb(${[1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)).join(", ")})`;
}

function luminance(color: string): number {
  const channels = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(color);
  if (channels === null) throw new Error(`Expected an opaque RGB color: ${color}`);
  const linear = channels.slice(1).map((value) => {
    const channel = Number(value) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
}

function contrast(foreground: string, background: string): number {
  const levels = [luminance(foreground), luminance(background)];
  return (Math.max(...levels) + 0.05) / (Math.min(...levels) + 0.05);
}

async function recordsForDay(request: APIRequestContext, date: string): Promise<LocalRecord[]> {
  const { startMs, endMs } = dayRange(date);
  const response = await request.get(`/api/v1/records?startMs=${startMs}&endMs=${endMs}`);
  expect(response.status()).toBe(200);
  return ((await response.json()) as { records: LocalRecord[] }).records;
}

async function showCalendar(page: Page, date: string, view: "day" | "week") {
  await page.goto("/calendar.html");
  const button = page.getByRole("button", { name: view === "week" ? "週" : "日", exact: true });
  if (await button.isVisible()) await button.click();
  await page.locator("#calendar-date").fill(date);
  await page.locator("#calendar-date").dispatchEvent("change");
  await expect(page.locator("#calendar-loading")).toBeHidden();
  await expect(page.locator(".timeline-day")).toHaveCount(view === "week" ? 7 : 1);
  await expect(page.locator(".timeline-event")).toHaveCount(palette.length);
}

async function clearInteractionState(page: Page) {
  // Save returns focus to the record; inspect the normal palette separately
  // from the intentionally darker hover/focus-visible palette.
  await page.locator("#calendar-date").focus();
  await page.mouse.move(0, 0);
}

const cases = [
  { name: "desktop day", view: "day", mobile: false, date: "2053-01-13" },
  { name: "desktop week", view: "week", mobile: false, date: "2053-01-20" },
  { name: "320px day", view: "day", mobile: true, date: "2053-01-27" },
] as const;

for (const scenario of cases) {
  test.describe(`calendar tag colors ${scenario.name}`, () => {
    test.use({
      viewport: scenario.mobile ? { width: 320, height: 740 } : { width: 1280, height: 800 },
      isMobile: scenario.mobile,
      hasTouch: scenario.mobile,
    });

    test("colors all seven short-record boxes and persists tag changes and clearing", async ({
      page,
      request,
      baseURL,
    }, testInfo) => {
      // Never seed or clean up a remote application, even if a runner is misconfigured.
      expect(baseURL).toBe(ORIGIN);
      const date = addDays(scenario.date, testInfo.repeatEachIndex * 28);
      const { startMs } = dayRange(date);
      const createdIds = new Set<string>();
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      try {
        for (const [index, item] of palette.entries()) {
          const startedAtMs = startMs + (9 * 60 + index * 30) * 60_000;
          const response = await request.post("/api/v1/records", {
            data: {
              clientRequestId: crypto.randomUUID(),
              description: item.description,
              tag: item.tag,
              startedAtMs,
              endedAtMs: startedAtMs + 1_000,
            },
            headers,
          });
          expect(response.status()).toBe(201);
          const record = ((await response.json()) as { record: LocalRecord }).record;
          createdIds.add(record.id);
        }
        const initial = await recordsForDay(request, date);
        await showCalendar(page, date, scenario.view);
        await clearInteractionState(page);
        const backgrounds: string[] = [];
        const hoverBackgrounds: string[] = [];
        for (const item of palette) {
          const event = page.locator(".timeline-event").filter({
            has: page.locator(".timeline-event-title", { hasText: item.description }),
          });
          await expect(event).toHaveClass(new RegExp(`timeline-event-${item.tag ?? "none"}`));
          await expect(event.locator(".timeline-event-title")).toHaveText(item.description);
          if (item.label === null) await expect(event.locator(".time-tag")).toHaveCount(0);
          else {
            await expect(event.locator(".time-tag")).toHaveText(item.label);
            await expect(event).toHaveAccessibleName(new RegExp(`タグ：${item.label}`, "u"));
          }
          await expect(event).toHaveCSS("background-color", rgb(item.background));
          const rendered = await event.evaluate((button) => {
            const title = button.querySelector(".timeline-event-title");
            if (!(title instanceof HTMLElement)) throw new Error("Missing record title");
            const box = button.getBoundingClientRect();
            const titleBox = title.getBoundingClientRect();
            const titleStyle = getComputedStyle(title);
            return {
              background: getComputedStyle(button).backgroundColor,
              foreground: titleStyle.color,
              height: box.height,
              titleHeight: titleBox.height,
              lineHeight: Number.parseFloat(titleStyle.lineHeight),
              titleInside: titleBox.top >= box.top && titleBox.bottom <= box.bottom,
              titleFirst: button.firstElementChild === title,
              titleNoWrap: titleStyle.whiteSpace === "nowrap",
              titleWidth: titleBox.width,
            };
          });
          backgrounds.push(rendered.background);
          expect(rendered.height).toBeGreaterThanOrEqual(43.9);
          expect(rendered.titleHeight).toBeGreaterThanOrEqual(rendered.lineHeight - 0.1);
          expect(rendered.titleHeight).toBeLessThanOrEqual(rendered.lineHeight + 0.1);
          expect(rendered.titleWidth).toBeGreaterThanOrEqual(22);
          expect(rendered.titleInside && rendered.titleFirst && rendered.titleNoWrap).toBe(true);
          expect(contrast(rendered.foreground, rendered.background)).toBeGreaterThanOrEqual(4.5);

          if (!scenario.mobile) {
            await event.hover();
            await expect(event).toHaveCSS("background-color", rgb(item.hover));
            const hover = await event.evaluate(
              (button) => getComputedStyle(button).backgroundColor,
            );
            hoverBackgrounds.push(hover);
            expect(contrast(rendered.foreground, hover)).toBeGreaterThanOrEqual(4.5);
            await page.mouse.move(0, 0);
            await page.keyboard.press("Tab");
            await event.focus();
            expect(await event.evaluate((button) => button.matches(":focus-visible"))).toBe(true);
            await expect(event).toHaveCSS("background-color", rgb(item.hover));
            await clearInteractionState(page);
          }
        }
        expect(new Set(backgrounds).size).toBe(7);
        if (!scenario.mobile) expect(new Set(hoverBackgrounds).size).toBe(7);
        expect(await recordsForDay(request, date)).toEqual(initial);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );

        const edited = page.locator(".timeline-event").filter({
          has: page.locator(".timeline-event-title", { hasText: "計画" }),
        });
        await edited.scrollIntoViewIfNeeded();
        await edited.evaluate((button) =>
          window.scrollBy(0, button.getBoundingClientRect().top - 100),
        );
        await page.screenshot({ path: testInfo.outputPath("seven-calendar-tag-colors.png") });

        for (const change of [
          { tag: "housework", label: "家事", color: "#dceee4" },
          { tag: "", label: null, color: "#e8ebee" },
        ] as const) {
          await edited.click();
          await page.locator("#edit-tag").selectOption(change.tag);
          await page.locator("#edit-save").click();
          await expect(page.locator("#edit-dialog")).toBeHidden();
          await clearInteractionState(page);
          await expect(edited).toHaveCSS("background-color", rgb(change.color));
          // A fresh document must read the persisted tag, not just reuse optimistic UI state.
          await showCalendar(page, date, scenario.view);
          await clearInteractionState(page);
          await expect(edited).toHaveCSS("background-color", rgb(change.color));
          if (change.label === null) await expect(edited.locator(".time-tag")).toHaveCount(0);
          else await expect(edited.locator(".time-tag")).toHaveText(change.label);
          const current = await recordsForDay(request, date);
          const changed = current.find((record) => record.description === "計画");
          expect(changed).toMatchObject({ tag: change.tag || null });
          expect(current.filter((record) => record.description !== "計画")).toEqual(
            initial.filter((record) => record.description !== "計画"),
          );
          expect(changed?.startedAtMs).toBe(startMs + 9 * 3_600_000);
          expect(changed?.endedAtMs).toBe(startMs + 9 * 3_600_000 + 1_000);
        }
        expect(pageErrors).toEqual([]);
      } finally {
        // The API and its optimistic version checks clean up only this test's synthetic IDs.
        for (const record of await recordsForDay(request, date)) {
          if (!createdIds.has(record.id)) continue;
          const deleted = await request.delete(`/api/v1/records/${record.id}`, {
            data: { expectedVersion: record.version },
            headers,
          });
          expect(deleted.status()).toBe(200);
        }
      }
    });
  });
}
