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

beforeEach(() => {
  useStore.getState().reset();
  localStorage.clear();
});

// ─── Auth actions ────────────────────────────────────────────────────────────

describe("Auth actions", () => {
  it("setAuthToken: persists token to localStorage and sets isAuthenticated true", () => {
    useStore.getState().setAuthToken("my-secret-token");

    const state = useStore.getState();
    expect(state.authToken).toBe("my-secret-token");
    expect(state.isAuthenticated).toBe(true);
    expect(localStorage.getItem("companion_auth_token")).toBe("my-secret-token");
  });

  it("logout: removes token from localStorage and sets isAuthenticated false", () => {
    // First authenticate
    useStore.getState().setAuthToken("token-123");
    expect(useStore.getState().isAuthenticated).toBe(true);

    // Then logout
    useStore.getState().logout();

    const state = useStore.getState();
    expect(state.authToken).toBeNull();
    expect(state.isAuthenticated).toBe(false);
    expect(localStorage.getItem("companion_auth_token")).toBeNull();
  });
});
