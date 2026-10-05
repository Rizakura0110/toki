// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, MemoryRouter, Route, Routes } from "react-router";
import { afterEach, expect, it } from "vitest";

afterEach(cleanup);

it("supports React JSX, Router and Testing Library without mounting over legacy screens", async () => {
  const user = userEvent.setup();
  render(
    <MemoryRouter>
      <Routes>
        <Route path="/" element={<Link to="/calendar.html">カレンダーを見る</Link>} />
        <Route path="/calendar.html" element={<h1>記録カレンダー</h1>} />
      </Routes>
    </MemoryRouter>,
  );
  await user.click(screen.getByRole("link", { name: "カレンダーを見る" }));
  expect(screen.getByRole("heading", { name: "記録カレンダー" })).toBeDefined();
});
