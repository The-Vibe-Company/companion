// @vitest-environment jsdom

// vi.hoisted runs before any imports, ensuring browser globals are available when store.ts initializes.
vi.hoisted(() => {
  // jsdom does not implement matchMedia
  Object.defineProperty(globalThis.window, "matchMedia", {
    writable: true,
    configurable: true,
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

  // Node.js 22+ native localStorage may be broken (invalid --localstorage-file).
  // Polyfill before store.ts import triggers getInitialSessionId().
  if (
    typeof globalThis.localStorage === "undefined" ||
    typeof globalThis.localStorage.getItem !== "function"
  ) {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      value: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => { store.set(key, String(value)); },
        removeItem: (key: string) => { store.delete(key); },
        clear: () => { store.clear(); },
        get length() { return store.size; },
        key: (index: number) => [...store.keys()][index] ?? null,
      },
      writable: true,
      configurable: true,
    });
  }
});

import { useStore } from "../store.js";
import type { PermissionRequest } from "../types.js";

function makePermission(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    request_id: crypto.randomUUID(),
    tool_name: "Bash",
    input: { command: "ls" },
    timestamp: Date.now(),
    tool_use_id: crypto.randomUUID(),
    ...overrides,
  };
}

beforeEach(() => {
  useStore.getState().reset();
  localStorage.clear();
});

// ─── Permissions ────────────────────────────────────────────────────────────

describe("Permissions", () => {
  it("addPermission: adds to nested map", () => {
    const perm = makePermission({ request_id: "r1", tool_name: "Bash" });
    useStore.getState().addPermission("s1", perm);

    const sessionPerms = useStore.getState().pendingPermissions.get("s1")!;
    expect(sessionPerms.get("r1")).toEqual(perm);
  });

  it("addPermission: accumulates multiple permissions", () => {
    const perm1 = makePermission({ request_id: "r1" });
    const perm2 = makePermission({ request_id: "r2" });
    useStore.getState().addPermission("s1", perm1);
    useStore.getState().addPermission("s1", perm2);

    const sessionPerms = useStore.getState().pendingPermissions.get("s1")!;
    expect(sessionPerms.size).toBe(2);
  });

  it("removePermission: removes specific request", () => {
    const perm1 = makePermission({ request_id: "r1" });
    const perm2 = makePermission({ request_id: "r2" });
    useStore.getState().addPermission("s1", perm1);
    useStore.getState().addPermission("s1", perm2);

    useStore.getState().removePermission("s1", "r1");

    const sessionPerms = useStore.getState().pendingPermissions.get("s1")!;
    expect(sessionPerms.has("r1")).toBe(false);
    expect(sessionPerms.has("r2")).toBe(true);
  });
});

// ─── AI Resolved Permissions ────────────────────────────────────────────────

describe("AI Resolved Permissions", () => {
  it("clearAiResolvedPermissions: clears AI-resolved entries for a session", () => {
    const entry = {
      request: makePermission({ request_id: "r1", tool_name: "Read" }),
      behavior: "allow" as const,
      reason: "read-only",
      timestamp: Date.now(),
    };
    useStore.getState().addAiResolvedPermission("s1", entry);
    expect(useStore.getState().aiResolvedPermissions.get("s1")).toHaveLength(1);

    // Clear should remove the session key entirely
    useStore.getState().clearAiResolvedPermissions("s1");
    expect(useStore.getState().aiResolvedPermissions.get("s1")).toBeUndefined();
  });

  it("clearAiResolvedPermissions: no-op when session has no entries", () => {
    // Should not throw when clearing a session with no AI-resolved permissions
    useStore.getState().clearAiResolvedPermissions("nonexistent");
    expect(useStore.getState().aiResolvedPermissions.has("nonexistent")).toBe(false);
  });
});

// ─── removePermission edge case ──────────────────────────────────────────────

describe("removePermission edge cases", () => {
  it("removePermission: no-op when session has no permissions", () => {
    // Should not throw when removing from a session with no pending permissions
    useStore.getState().removePermission("s1", "nonexistent");
    expect(useStore.getState().pendingPermissions.has("s1")).toBe(false);
  });
});
