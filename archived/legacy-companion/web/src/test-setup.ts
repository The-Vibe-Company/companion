// Setup file for jsdom-based tests
// Polyfills that must be available before any module import

// Register vitest-axe matchers (toHaveNoViolations) in jsdom environments.
// The vitest-axe/extend-expect entry is an empty file in some builds, so we
// manually import the matcher and extend expect ourselves.
if (typeof window !== "undefined") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

  // Node.js 22+ ships native localStorage that requires --localstorage-file.
  // Vitest may provide an invalid path, leaving a broken global that shadows
  // jsdom's working implementation. Polyfill when getItem is missing.
  if (
    typeof globalThis.localStorage === "undefined" ||
    typeof globalThis.localStorage.getItem !== "function"
  ) {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, String(value)); },
      removeItem: (key: string) => { store.delete(key); },
      clear: () => { store.clear(); },
      get length() { return store.size; },
      key: (index: number) => [...store.keys()][index] ?? null,
    };
    Object.defineProperty(globalThis, "localStorage", {
      value: storage,
      writable: true,
      configurable: true,
    });
  }
}

export {};
