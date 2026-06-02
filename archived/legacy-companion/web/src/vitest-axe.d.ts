import type { AxeResults } from "axe-core";

// Augment vitest's Assertion interface with vitest-axe matchers.
// The vitest-axe/extend-expect types target the deprecated Vi namespace,
// so we manually augment @vitest/expect for vitest 4.x.
declare module "@vitest/expect" {
  interface Assertion<T> {
    toHaveNoViolations(): void;
  }
}
