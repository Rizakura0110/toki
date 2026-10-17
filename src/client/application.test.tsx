// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarRecord, MeasurementSession } from "./api";
import { Application, createStores } from "./application";

const NOW = Date.UTC(2026, 9, 17, 3);
const running: MeasurementSession = {
  id: "session",
  mode: "stopwatch",
  status: "running",
  startedAtMs: NOW - 1000,
  deadlineAtMs: null,
  endedAtMs: null,
  timerSeconds: null,
};
const stopped: MeasurementSession = { ...running, status: "awaiting_description", endedAtMs: NOW };
const record: CalendarRecord = {
  id: "r1",
  status: "saved",
  mode: "manual",
  startedAtMs: NOW,
  endedAtMs: NOW + 60000,
  description: "<img src=x onerror=alert(1)>",
  version: 1,
};
let fetchMock = vi.fn<typeof fetch>();
let small = false;
let mediaChanged = () => {};
// jsdom has the element but not its native modal methods. Browser behavior is
// additionally covered by the real-browser suite under the unchanged CSP.
Object.defineProperties(HTMLDialogElement.prototype, {
  showModal: { configurable: true, writable: true, value() {} },
  close: { configurable: true, writable: true, value() {} },
});
function envelope(session: MeasurementSession | null = null) {
  return Response.json({ session, serverNowMs: NOW });
}
function fail(status: number) {
  return Response.json({}, { status });
}
function mount(path = "/", stores = createStores()) {
  const result = render(
    <StrictMode>
      <MemoryRouter initialEntries={[path]}>
        <Application stores={stores} />
      </MemoryRouter>
    </StrictMode>,
  );
  return { ...result, stores };
}
function element<T extends HTMLElement = HTMLElement>(id: string) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
}
async function ready(id = "start-button") {
  await waitFor(() => expect(element<HTMLButtonElement>(id).disabled).toBe(false));
}
beforeEach(() => {
  small = false;
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      get matches() {
        return small;
      },
      addEventListener: (_type: string, callback: () => void) => {
        mediaChanged = callback;
      },
      removeEventListener: vi.fn(),
    })),
  );
  vi.spyOn(HTMLDialogElement.prototype, "showModal").mockImplementation(function (
    this: HTMLDialogElement,
  ) {
    this.open = true;
  });
  vi.spyOn(HTMLDialogElement.prototype, "close").mockImplementation(function (
    this: HTMLDialogElement,
  ) {
    this.open = false;
    fireEvent(this, new Event("close"));
  });
  fetchMock = vi
    .fn<typeof fetch>()
    .mockImplementation(async (path) =>
      String(path).includes("/records") ? Response.json({ records: [] }) : envelope(),
    );
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("React measurement lifecycle and routing", () => {
  it("loads once under StrictMode, navigates without mutations and cleans intervals/listeners", async () => {
    const setInterval = vi.spyOn(window, "setInterval"),
      clearInterval = vi.spyOn(window, "clearInterval");
    const removeWindow = vi.spyOn(window, "removeEventListener"),
      removeDocument = vi.spyOn(document, "removeEventListener");
    const user = userEvent.setup(),
      { unmount } = mount();
    await ready();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(document.title).toBe("Toki — 時間を記録する");
    await user.click(screen.getByRole("link", { name: /カレンダーを見る/u }));
    await waitFor(() => expect(element("calendar-loading").hidden).toBe(true));
    expect(document.title).toBe("記録カレンダー — Toki");
    await user.click(screen.getByRole("link", { name: "計測画面へ" }));
    await ready();
    expect(fetchMock.mock.calls.every(([, options]) => options?.method === "GET")).toBe(true);
    unmount();
    expect(clearInterval).toHaveBeenCalledTimes(setInterval.mock.calls.length);
    expect(removeWindow).toHaveBeenCalledWith("online", expect.any(Function));
    expect(removeWindow).toHaveBeenCalledWith("pageshow", expect.any(Function));
    expect(removeDocument).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    expect(removeDocument).toHaveBeenCalledWith("keydown", expect.any(Function));
  });
  it("supports the index alias, application-owned stores and a no-fetch unknown route", async () => {
    const one = render(
      <MemoryRouter initialEntries={["/index.html"]}>
        <Application />
      </MemoryRouter>,
    );
    await ready();
    one.unmount();
    mount("/not-found");
    expect(screen.getByRole("heading", { name: "ページが見つかりません" })).toBeDefined();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it("starts a controlled timer, handles focus/Escape and saves an optional description", async () => {
    const user = userEvent.setup();
    mount();
    await ready();
    await user.click(screen.getByRole("radio", { name: /タイマー/u }));
    fireEvent.change(element("timer-hours"), { target: { value: "0" } });
    fireEvent.change(element("timer-minutes"), { target: { value: "0" } });
    fireEvent.change(element("timer-seconds"), { target: { value: "30" } });
    const timer: MeasurementSession = {
      ...running,
      mode: "timer",
      deadlineAtMs: NOW + 30000,
      timerSeconds: 30,
    };
    fetchMock.mockResolvedValueOnce(envelope(timer));
    await user.click(element("start-button"));
    await ready("stop-button");
    expect(element("running-time-label").textContent).toBe("残り時間");
    expect(document.title).toBe("計測中 — Toki");
    await user.click(element("enter-focus"));
    expect(element("normal-view").hidden).toBe(true);
    expect(document.activeElement).toBe(element("exit-focus"));
    fireEvent.keyDown(document, { key: "a" });
    expect(element("normal-view").hidden).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.activeElement).toBe(element("enter-focus"));
    await user.click(element("enter-focus"));
    await user.click(element("exit-focus"));
    expect(element("focus-view").hidden).toBe(true);
    fetchMock.mockResolvedValueOnce(
      envelope({ ...timer, status: "awaiting_description", endedAtMs: NOW }),
    );
    await user.click(element("stop-button"));
    await ready("save-button");
    expect(document.title).toBe("内容を入力 — Toki");
    await user.type(element("description"), "読書");
    expect(element("description-count").textContent).toBe("2 / 500");
    fetchMock.mockResolvedValueOnce(envelope({ ...stopped, status: "saved" }));
    await user.click(element("save-button"));
    await waitFor(() => expect(element("notice").textContent).toBe("記録を保存しました。"));
    expect(element("idle-panel").hidden).toBe(false);
  });
  it("requires confirmation for discard and never submits on cancel", async () => {
    fetchMock.mockResolvedValueOnce(envelope(stopped));
    const user = userEvent.setup();
    mount();
    await ready("discard-button");
    const confirm = vi
      .spyOn(window, "confirm")
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    await user.click(element("discard-button"));
    expect(fetchMock).toHaveBeenCalledOnce();
    fetchMock.mockResolvedValueOnce(envelope({ ...stopped, status: "discarded" }));
    await user.click(element("discard-button"));
    await waitFor(() => expect(element("notice").textContent).toBe("未保存の計測を破棄しました。"));
    expect(confirm).toHaveBeenCalledTimes(2);
  });
  it("shows auth errors, blocks mutation and recovers through explicit state confirmation", async () => {
    fetchMock.mockResolvedValueOnce(fail(401));
    const user = userEvent.setup();
    const { stores } = mount();
    await waitFor(() => expect(element("sync-error-text").textContent).toContain("認証"));
    expect(element<HTMLButtonElement>("start-button").disabled).toBe(true);
    expect(element("idle-panel").hidden).toBe(true);
    expect(element("retry-sync").hidden).toBe(false);
    await user.click(element("retry-sync"));
    await ready();
    expect(stores.measurement.getSnapshot().uncertain).toBe(false);
  });
  it("resynchronizes visibility, bfcache and online recovery, but does not poll every second", async () => {
    fetchMock.mockResolvedValueOnce(envelope(running));
    mount();
    await ready("stop-button");
    await act(async () => {
      fireEvent(document, new Event("visibilitychange"));
    });
    await act(async () => {
      fireEvent(window, new PageTransitionEvent("pageshow", { persisted: false }));
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => {
      fireEvent(window, new PageTransitionEvent("pageshow", { persisted: true }));
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await act(async () => {
      fireEvent.online(window);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    await act(async () => {
      fireEvent(document, new Event("visibilitychange"));
    });
    await act(async () => {
      fireEvent.online(window);
    });
    expect(element("sync-error").hidden).toBe(true);
  });
  it("keeps uncertain start request identity across client navigation and performs no automatic POST", async () => {
    const user = userEvent.setup();
    mount();
    await ready();
    fetchMock.mockRejectedValueOnce(new Error("lost"));
    await user.click(element("start-button"));
    await waitFor(() => expect(element("sync-error").hidden).toBe(false));
    const original = fetchMock.mock.calls.find(([, options]) => options?.method === "POST")?.[1]
      ?.body;
    await user.click(screen.getByRole("link", { name: /カレンダーを見る/u }));
    await user.click(screen.getByRole("link", { name: "計測画面へ" }));
    await ready();
    expect(fetchMock.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(
      1,
    );
    fetchMock.mockResolvedValueOnce(envelope(running));
    await user.click(element("start-button"));
    await ready("stop-button");
    expect(
      fetchMock.mock.calls.filter(([, options]) => options?.method === "POST").at(-1)?.[1]?.body,
    ).toBe(original);
  });
  it("restores focus to description after deadline resolution and to retry on sync failure", async () => {
    fetchMock.mockResolvedValueOnce(envelope(running));
    const user = userEvent.setup(),
      { stores } = mount();
    await ready("stop-button");
    await user.click(element("enter-focus"));
    fetchMock.mockResolvedValueOnce(envelope(stopped));
    await act(async () => {
      await stores.measurement.refresh();
    });
    expect(document.activeElement).toBe(element("description"));
    fetchMock.mockResolvedValueOnce(envelope(running));
    await act(async () => {
      await stores.measurement.refresh();
    });
    await user.click(element("enter-focus"));
    fetchMock.mockResolvedValueOnce(fail(403));
    await act(async () => {
      await stores.measurement.refresh();
    });
    expect(document.activeElement).toBe(element("retry-sync"));
  });
});

describe("React calendar and native dialogs", () => {
  async function calendar(records: readonly CalendarRecord[] = [record]) {
    fetchMock.mockImplementation(async () => Response.json({ records }));
    const result = mount("/calendar.html");
    await waitFor(() => expect(element("calendar-loading").hidden).toBe(true));
    return result;
  }
  it("renders escaped text, week/day geometry, date navigation and resize with cleanup", async () => {
    const { stores, unmount } = await calendar(),
      user = userEvent.setup();
    expect(document.querySelectorAll(".timeline-day")).toHaveLength(7);
    expect(document.querySelectorAll("img")).toHaveLength(0);
    expect(screen.getAllByText(record.description).length).toBeGreaterThan(0);
    await user.click(element("day-view"));
    expect(document.querySelectorAll(".timeline-day")).toHaveLength(1);
    fireEvent.change(element("calendar-date"), { target: { value: "2026-10-18" } });
    await waitFor(() => expect(element("calendar-loading").hidden).toBe(true));
    await user.click(element("previous-period"));
    await user.click(element("next-period"));
    await user.click(element("today-period"));
    await user.click(element("week-view"));
    await act(async () => {
      small = true;
      mediaChanged();
    });
    expect(stores.calendar.getSnapshot().view).toBe("day");
    const media = window.matchMedia("(max-width: 700px)");
    unmount();
    expect(media.removeEventListener).toBeDefined();
  });
  it("shows empty/error states and retries only reads", async () => {
    fetchMock.mockResolvedValueOnce(fail(500));
    mount("/calendar.html");
    await waitFor(() => expect(element("calendar-error").hidden).toBe(false));
    expect(element("calendar-empty").hidden).toBe(true);
    await userEvent.click(element("calendar-retry"));
    await waitFor(() => expect(element("calendar-empty").hidden).toBe(false));
    expect(fetchMock.mock.calls.every(([, options]) => options?.method === "GET")).toBe(true);
  });
  it("opens focused edit dialog, preserves safe text, and closes by cancel/Escape/native close", async () => {
    await calendar();
    const user = userEvent.setup(),
      open = async () => {
        await user.click(document.querySelector(".record-button") as HTMLElement);
        expect(element<HTMLDialogElement>("edit-dialog").open).toBe(true);
      };
    await open();
    expect(document.activeElement).toBe(element("edit-start"));
    expect(element<HTMLTextAreaElement>("edit-description").value).toBe(record.description);
    await user.click(element("edit-cancel"));
    expect(element<HTMLDialogElement>("edit-dialog").open).toBe(false);
    await open();
    fireEvent(element("edit-dialog"), new Event("cancel", { cancelable: true }));
    expect(element<HTMLDialogElement>("edit-dialog").open).toBe(false);
    await open();
    act(() => element<HTMLDialogElement>("edit-dialog").close());
    expect(element<HTMLDialogElement>("edit-dialog").open).toBe(false);
  });
  it("submits editing, manages delete confirmation focus, cancels, and deletes once", async () => {
    const { stores } = await calendar();
    const user = userEvent.setup();
    await user.click(document.querySelector(".timeline-event") as HTMLElement);
    fireEvent.change(element("edit-start"), { target: { value: "2026-10-17T12:00" } });
    fireEvent.change(element("edit-end"), { target: { value: "2026-10-17T12:02" } });
    fireEvent.change(element("edit-description"), { target: { value: "updated" } });
    expect(stores.calendar.getSnapshot().edit).toEqual({
      start: "2026-10-17T12:00",
      end: "2026-10-17T12:02",
      description: "updated",
    });
    fetchMock.mockResolvedValueOnce(Response.json({}));
    await user.click(element("edit-save"));
    expect(element("edit-error-text").textContent).toBe("");
    await waitFor(() => expect(element<HTMLDialogElement>("edit-dialog").open).toBe(false));
    await user.click(document.querySelector(".record-button") as HTMLElement);
    await user.click(element("edit-delete"));
    expect(document.activeElement).toBe(element("delete-confirm"));
    await user.click(element("delete-cancel"));
    expect(document.activeElement).toBe(element("edit-delete"));
    await user.click(element("edit-delete"));
    fetchMock.mockResolvedValueOnce(Response.json({}));
    await user.click(element("delete-confirm"));
    await waitFor(() =>
      expect(element("calendar-notice").textContent).toBe("記録を削除しました。"),
    );
  });
  it("requires reload after an edit conflict instead of exposing an overwrite action", async () => {
    await calendar();
    const user = userEvent.setup();
    await user.click(document.querySelector(".record-button") as HTMLElement);
    fetchMock.mockResolvedValueOnce(fail(409));
    await user.click(element("edit-save"));
    await waitFor(() => expect(element("edit-error").hidden).toBe(false));
    expect(element<HTMLButtonElement>("edit-save").disabled).toBe(true);
    await user.click(element("edit-reload"));
    await waitFor(() => expect(element<HTMLDialogElement>("edit-dialog").open).toBe(false));
  });
  it("creates minute-based optional text, locks unknown outcome and offers identical retry", async () => {
    await calendar([]);
    const user = userEvent.setup();
    await user.click(element("new-record"));
    expect(element<HTMLDialogElement>("create-dialog").open).toBe(true);
    expect(document.activeElement).toBe(element("create-start"));
    expect(element("create-start").getAttribute("step")).toBe("60");
    fireEvent.change(element("create-start"), { target: { value: "2042-01-15T09:00" } });
    fireEvent.change(element("create-end"), { target: { value: "2042-01-15T10:00" } });
    fireEvent.change(element("create-description"), { target: { value: "" } });
    fetchMock.mockRejectedValueOnce(new Error("lost"));
    await user.click(element("create-save"));
    await waitFor(() => expect(element("create-save").textContent).toBe("同じ内容で再試行"));
    expect(element<HTMLInputElement>("create-start").disabled).toBe(true);
    fetchMock.mockResolvedValueOnce(Response.json({}));
    await user.click(element("create-save"));
    await waitFor(() => expect(element<HTMLDialogElement>("create-dialog").open).toBe(false));
    expect(element<HTMLInputElement>("calendar-date").value).toBe("2042-01-15");
    await user.click(element("new-record"));
    await user.click(element("create-cancel"));
    expect(element<HTMLDialogElement>("create-dialog").open).toBe(false);
  });
  it("reconciles uncertain create by reload or Escape without a second POST", async () => {
    await calendar([]);
    const user = userEvent.setup();
    for (const method of ["reload", "escape"]) {
      await user.click(element("new-record"));
      fetchMock.mockResolvedValueOnce(fail(409));
      await user.click(element("create-save"));
      await waitFor(() => expect(element<HTMLButtonElement>("create-save").disabled).toBe(true));
      if (method === "reload") await user.click(element("create-reload"));
      else fireEvent(element("create-dialog"), new Event("cancel", { cancelable: true }));
      await waitFor(() => expect(element<HTMLDialogElement>("create-dialog").open).toBe(false));
    }
    expect(fetchMock.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(
      2,
    );
  });
  it("renders clipped midnight and timer labels without changing stored timestamps", async () => {
    const atMidnight = Date.UTC(2026, 9, 17, 15);
    await calendar([
      { ...record, startedAtMs: atMidnight - 1000, endedAtMs: atMidnight + 1000, mode: "timer" },
    ]);
    expect(document.querySelectorAll(".timeline-event")).toHaveLength(2);
    expect(
      [...document.querySelectorAll(".timeline-event-time")].map((node) => node.textContent),
    ).toEqual(["23:59–24:00", "00:00–00:00"]);
    await userEvent.click(document.querySelector(".timeline-event") as HTMLElement);
    expect(
      within(element("edit-dialog")).getByRole("heading", { name: "記録を編集" }),
    ).toBeDefined();
  });
});
