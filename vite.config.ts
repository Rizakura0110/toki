import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  appType: "mpa",
  plugins: [react(), tailwindcss(), cloudflare()],
  environments: {
    client: {
      build: {
        sourcemap: false,
        rolldownOptions: {
          input: {
            measurement: fileURLToPath(new URL("./index.html", import.meta.url)),
            calendar: fileURLToPath(new URL("./calendar.html", import.meta.url)),
          },
          output: {
            entryFileNames: "assets/[name]-[hash:8].js",
            chunkFileNames: "assets/[name]-[hash:8].js",
            assetFileNames: "assets/[name]-[hash:8][extname]",
          },
        },
      },
    },
  },
});
