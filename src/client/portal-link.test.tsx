// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { Header } from "./shared";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it.each([false, true])(
  "keeps the portal a plain external link (calendar=%s), without API integration",
  (calendar) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    render(
      <MemoryRouter>
        <Header calendar={calendar} />
      </MemoryRouter>,
    );
    const link = screen.getByRole("link", { name: /rizakura-hontaiへ戻る/u });
    expect(link.getAttribute("href")).toBe("https://rizakura-hontai.sx7k2p9q.workers.dev/");
    expect(link.getAttribute("target")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  },
);
it("preserves modified-click browser behavior while normal clicks use Router history", () => {
  render(
    <MemoryRouter>
      <Routes>
        <Route path="/" element={<Header calendar={false} />} />
        <Route path="/calendar.html" element={<h1>記録カレンダー</h1>} />
      </Routes>
    </MemoryRouter>,
  );
  const link = screen.getByRole("link", { name: /カレンダーを見る/u });
  expect(link.getAttribute("href")).toBe("/calendar.html");
  // Prevent jsdom's real navigation after checking Router did not intercept it.
  let prevented = false;
  link.addEventListener("click", (event) => {
    prevented = event.defaultPrevented;
    event.preventDefault();
  });
  fireEvent.click(link, { ctrlKey: true });
  expect(prevented).toBe(false);
  fireEvent.click(link);
  expect(screen.getByRole("heading", { name: "記録カレンダー" })).toBeDefined();
});
