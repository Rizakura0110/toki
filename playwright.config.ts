import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  expect: { timeout: 12_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:8791",
    browserName: "chromium",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "node scripts/e2e-local-server.mjs open",
      url: "http://127.0.0.1:8791/__local/db",
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: "node scripts/e2e-local-server.mjs closed",
      url: "http://127.0.0.1:8792/",
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
