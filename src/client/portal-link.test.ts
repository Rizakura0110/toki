import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const publicFile = (name: string): string =>
  readFileSync(new URL(`../../public/${name}`, import.meta.url), "utf8");

const portalUrl = "https://rizakura-hontai.sx7k2p9q.workers.dev/";

describe("Toki's portal return route", () => {
  it.each(["index.html", "calendar.html"])("uses a normal link from %s", (name) => {
    const html = publicFile(name);
    expect(html).toContain(`class="portal-return" href="${portalUrl}"`);
    expect(html).toContain("rizakura-hontaiへ戻る");
    expect(html).not.toMatch(/<script[^>]+rizakura-hontai/u);
  });

  it("does not call the portal from Toki browser code", () => {
    for (const name of ["app.js", "calendar.js"]) {
      expect(publicFile(name)).not.toContain(portalUrl);
    }
  });
});
