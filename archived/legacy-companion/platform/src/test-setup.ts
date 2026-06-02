// Setup file for jsdom-based tests
import { expect } from "vitest";

// Register vitest-axe matchers (toHaveNoViolations) in jsdom environments.
if (typeof window !== "undefined") {
  const matchers = await import("vitest-axe/matchers") as any;
  expect.extend({ toHaveNoViolations: matchers.toHaveNoViolations });
}

if (typeof window !== "undefined") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

export {};
