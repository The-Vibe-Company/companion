import { resolve } from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
      "@server": resolve(__dirname, "server"),
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
    env: { NODE_ENV: "test" },
  },
});
