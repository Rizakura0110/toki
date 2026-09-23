import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const publicFile = (name: string): URL => new URL(`../../public/${name}`, import.meta.url);

describe("Toki's separate PWA identity", () => {
  it("opens at the protected Toki root and declares launcher icons", () => {
    const manifest = JSON.parse(readFileSync(publicFile("manifest.webmanifest"), "utf8"));
    expect(manifest).toMatchObject({
      id: "/",
      start_url: "/",
      scope: "/",
      display: "standalone",
      short_name: "Toki",
      lang: "ja",
    });
    expect(manifest.icons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ src: "/icons/toki-192.png", sizes: "192x192" }),
        expect.objectContaining({ src: "/icons/toki-512.png", sizes: "512x512" }),
        expect.objectContaining({
          src: "/icons/toki-maskable-512.png",
          sizes: "512x512",
          purpose: "maskable",
        }),
      ]),
    );
  });

  it.each([
    ["toki-180.png", 180],
    ["toki-192.png", 192],
    ["toki-512.png", 512],
    ["toki-maskable-512.png", 512],
  ])("ships a real %s at %i pixels", (name, size) => {
    const bytes = readFileSync(publicFile(`icons/${name}`));
    expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(bytes.toString("ascii", 12, 16)).toBe("IHDR");
    expect(bytes.readUInt32BE(16)).toBe(size);
    expect(bytes.readUInt32BE(20)).toBe(size);
  });

  it.each(["index.html", "calendar.html"])("links the same PWA from %s", (name) => {
    const html = readFileSync(publicFile(name), "utf8");
    expect(html).toContain(
      'rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials"',
    );
    expect(html).toContain('rel="icon" type="image/svg+xml" href="/icons/toki.svg"');
    expect(html).toContain('rel="apple-touch-icon" sizes="180x180" href="/icons/toki-180.png"');
    expect(html).toContain('name="apple-mobile-web-app-title" content="Toki"');
    expect(html).toContain('name="application-name" content="Toki"');
    expect(html).toContain('name="apple-mobile-web-app-status-bar-style" content="default"');
  });
});
