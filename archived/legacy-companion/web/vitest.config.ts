import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      // vite-plugin-pwa provides this virtual module at build time.
      // During tests, vi.mock() handles it, but Vite's import analysis
      // runs first and fails if the module can't be resolved.
      // This stub file lets the import resolve so vi.mock() can take over.
      "virtual:pwa-register": resolve(__dirname, "src/__mocks__/virtual-pwa-register.ts"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      // The coverage-gate CI workflow reads json-summary to enforce
      // that new / changed files have ≥ 80 % line coverage.
    },
    include: ["server/**/*.test.ts", "src/**/*.test.ts", "src/**/*.test.tsx"],
    environmentMatchGlobs: [
      ["src/**/*.test.ts", "jsdom"],
      ["src/**/*.test.tsx", "jsdom"],
    ],
    setupFiles: ["src/test-setup.ts"],
    // React 19.2+ only exports `act` in the development CJS build.
    // Without this, jsdom tests load react.production.js which breaks
    // @testing-library/react's act() calls.
    env: { NODE_ENV: "test" },
  },
});
