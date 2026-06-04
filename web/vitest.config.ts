import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["src/test-setup.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // React 19.2+ only exports `act` from its development build. Forcing
    // NODE_ENV=test makes jsdom load react.development so @testing-library's
    // act() wrapping works.
    env: { NODE_ENV: "test" },
  },
});
