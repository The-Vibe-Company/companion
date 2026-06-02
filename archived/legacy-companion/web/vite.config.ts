import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // Use existing public/manifest.json — do not generate one
      manifest: false,
      srcDir: "src",
      filename: "sw.ts",
      registerType: "autoUpdate",
      strategies: "injectManifest",
      injectManifest: {
        // Precache all build output: JS chunks (incl. lazy-loaded), CSS, HTML,
        // icons, SVGs, and the two terminal Nerd Font woff2 files (~2.4MB total)
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
        // Main bundle exceeds default 2 MiB — raise to 5 MiB
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    host: "0.0.0.0",
    port: 5174,
    strictPort: false,
    proxy: {
      "/api": "http://localhost:3457",
      "/ws": {
        target: "ws://localhost:3457",
        ws: true,
      },
    },
  },
});
