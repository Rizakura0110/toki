import { defineConfig } from "@playwright/test";

const modes = ["old-new", "new-old", "rollback"] as const;
export default defineConfig({
  testDir: "./tests/migration",
  testMatch: "**/*.spec.ts",
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  expect: { timeout: 12_000 },
  reporter: [["list"]],
  outputDir: "test-results/migration",
  use: { browserName: "chromium", screenshot: "only-on-failure", trace: "retain-on-failure" },
  projects: modes.map((name, index) => ({
    name,
    use: { baseURL: `http://127.0.0.1:${8793 + index}` },
  })),
  webServer: modes.map((mode, index) => ({
    command: `node scripts/migration-local-server.mjs ${mode}`,
    url: `http://127.0.0.1:${8793 + index}/__local/db`,
    timeout: 60_000,
    reuseExistingServer: false,
  })),
});
