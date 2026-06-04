import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The console dev UI runs on :5173. The Go console (started with
// `companion console --workspace examples/minimal --dev-ui http://127.0.0.1:5173`)
// reverse-proxies `/` and `/assets` here, while this dev server proxies the API
// (`/api`) and health (`/healthz`) back to the Go console on :8788. That keeps the
// browser on a single origin and lets the dev-only token endpoint
// (`GET /api/console/session`) resolve the session token.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:8788",
      "/healthz": "http://127.0.0.1:8788",
    },
  },
  build: {
    outDir: "dist",
    // Keep %%CONSOLE_TOKEN%% sentinels verbatim in the emitted index.html so the
    // Go server can inject the per-process session token at serve time.
    emptyOutDir: true,
  },
});
