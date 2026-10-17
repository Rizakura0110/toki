import { defineConfig } from "drizzle-kit";

// Review output only. Existing SQL migrations (including triggers) stay in place.
// No credentials, remote driver, push/migrate script or automatic application.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/data/schema.ts",
  out: "./.tmp/drizzle-review",
  strict: true,
  verbose: true,
});
