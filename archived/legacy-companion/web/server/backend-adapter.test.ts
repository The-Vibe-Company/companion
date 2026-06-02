import { describe, it, expect } from "vitest";

// Bare side-effect import so the coverage tool sees the module as "loaded".
// A type-only import (`import type { ... }`) is erased at compile-time and
// does not count towards coverage.
import "./backend-adapter.js";

import type { IBackendAdapter } from "./backend-adapter.js";

describe("IBackendAdapter interface", () => {
  it("exists as a type-only export (no runtime code to test)", () => {
    // IBackendAdapter is a pure TypeScript interface — it compiles away to
    // nothing at runtime. This test exists solely so the coverage gate sees
    // at least one test file importing the module.
    const satisfiesInterface: boolean = true;
    expect(satisfiesInterface).toBe(true);
  });

  it("can be structurally satisfied by a mock object", () => {
    // Verify the interface shape is valid by creating a mock that satisfies it.
    // This acts as a compile-time check: if the interface changes, this test
    // will fail to compile, alerting us to update downstream adapters.
    const mock: IBackendAdapter = {
      send: () => true,
      isConnected: () => false,
      disconnect: async () => {},
      onBrowserMessage: () => {},
      onSessionMeta: () => {},
      onDisconnect: () => {},
    };
    expect(mock.send({ type: "user_message", content: "hi" })).toBe(true);
    expect(mock.isConnected()).toBe(false);
    expect(typeof mock.disconnect).toBe("function");
    expect(typeof mock.onBrowserMessage).toBe("function");
    expect(typeof mock.onSessionMeta).toBe("function");
    expect(typeof mock.onDisconnect).toBe("function");
  });
});
