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

// ─── Quick terminal (from UI state block) ────────────────────────────────────

describe("Quick terminal (from UI state)", () => {
  it("openQuickTerminal with reuseIfExists focuses existing tab instead of creating a new one", () => {
    useStore.getState().openQuickTerminal({ target: "host", cwd: "/repo" });
    const firstTabId = useStore.getState().activeQuickTerminalTabId;

    useStore.getState().openQuickTerminal({ target: "host", cwd: "/repo", reuseIfExists: true });
    const state = useStore.getState();
    expect(state.quickTerminalTabs).toHaveLength(1);
    expect(state.activeQuickTerminalTabId).toBe(firstTabId);
  });

  it("openQuickTerminal host labels stay monotonic after closing tabs", () => {
    const store = useStore.getState();
    store.openQuickTerminal({ target: "host", cwd: "/repo/a" });
    store.openQuickTerminal({ target: "host", cwd: "/repo/b" });
    store.openQuickTerminal({ target: "host", cwd: "/repo/c" });
    const secondId = useStore.getState().quickTerminalTabs[1]?.id;
    if (secondId) store.closeQuickTerminalTab(secondId);
    store.openQuickTerminal({ target: "host", cwd: "/repo/d" });

    const labels = useStore.getState().quickTerminalTabs.map((t) => t.label);
    expect(labels).toContain("Terminal");
    expect(labels).toContain("Terminal 3");
    expect(labels).toContain("Terminal 4");
  });
});

// ─── Quick terminal (additional tests) ───────────────────────────────────────

describe("Quick terminal", () => {
  it("setQuickTerminalOpen: sets the open state", () => {
    useStore.getState().setQuickTerminalOpen(true);
    expect(useStore.getState().quickTerminalOpen).toBe(true);

    useStore.getState().setQuickTerminalOpen(false);
    expect(useStore.getState().quickTerminalOpen).toBe(false);
  });

  it("openQuickTerminal: creates a docker tab with Docker label", () => {
    useStore.getState().openQuickTerminal({
      target: "docker",
      cwd: "/app",
      containerId: "abc123",
    });

    const state = useStore.getState();
    expect(state.quickTerminalOpen).toBe(true);
    expect(state.quickTerminalTabs).toHaveLength(1);
    expect(state.quickTerminalTabs[0].label).toBe("Docker 1");
    expect(state.quickTerminalTabs[0].cwd).toBe("/app");
    expect(state.quickTerminalTabs[0].containerId).toBe("abc123");
  });

  it("openQuickTerminal docker: increments docker index, not host index", () => {
    useStore.getState().openQuickTerminal({ target: "docker", cwd: "/a", containerId: "c1" });
    useStore.getState().openQuickTerminal({ target: "docker", cwd: "/b", containerId: "c2" });

    const tabs = useStore.getState().quickTerminalTabs;
    expect(tabs[0].label).toBe("Docker 1");
    expect(tabs[1].label).toBe("Docker 2");

    // Host index should still be 1
    expect(useStore.getState().quickTerminalNextHostIndex).toBe(1);
    expect(useStore.getState().quickTerminalNextDockerIndex).toBe(3);
  });

  it("openQuickTerminal with reuseIfExists: does not reuse if containerId differs", () => {
    useStore.getState().openQuickTerminal({ target: "docker", cwd: "/app", containerId: "c1" });
    useStore.getState().openQuickTerminal({
      target: "docker",
      cwd: "/app",
      containerId: "c2",
      reuseIfExists: true,
    });

    // Should have created a second tab since containerId differs
    expect(useStore.getState().quickTerminalTabs).toHaveLength(2);
  });

  it("closeQuickTerminalTab: closes terminal when last tab is removed", () => {
    useStore.getState().openQuickTerminal({ target: "host", cwd: "/repo" });
    const tabId = useStore.getState().quickTerminalTabs[0].id;

    useStore.getState().closeQuickTerminalTab(tabId);

    expect(useStore.getState().quickTerminalTabs).toHaveLength(0);
    expect(useStore.getState().activeQuickTerminalTabId).toBeNull();
    expect(useStore.getState().quickTerminalOpen).toBe(false);
  });

  it("closeQuickTerminalTab: selects first remaining tab when active tab is closed", () => {
    useStore.getState().openQuickTerminal({ target: "host", cwd: "/a" });
    useStore.getState().openQuickTerminal({ target: "host", cwd: "/b" });
    const tabs = useStore.getState().quickTerminalTabs;

    // Active should be the last opened tab (second one)
    expect(useStore.getState().activeQuickTerminalTabId).toBe(tabs[1].id);

    // Close the active (second) tab
    useStore.getState().closeQuickTerminalTab(tabs[1].id);

    // Should fall back to the first tab
    expect(useStore.getState().activeQuickTerminalTabId).toBe(tabs[0].id);
    expect(useStore.getState().quickTerminalOpen).toBe(true);
  });

  it("setActiveQuickTerminalTabId: sets the active tab", () => {
    useStore.getState().openQuickTerminal({ target: "host", cwd: "/a" });
    useStore.getState().openQuickTerminal({ target: "host", cwd: "/b" });
    const firstTabId = useStore.getState().quickTerminalTabs[0].id;

    useStore.getState().setActiveQuickTerminalTabId(firstTabId);
    expect(useStore.getState().activeQuickTerminalTabId).toBe(firstTabId);

    useStore.getState().setActiveQuickTerminalTabId(null);
    expect(useStore.getState().activeQuickTerminalTabId).toBeNull();
  });

  it("resetQuickTerminal: clears all terminal state and resets indices", () => {
    useStore.getState().openQuickTerminal({ target: "host", cwd: "/a" });
    useStore.getState().openQuickTerminal({ target: "docker", cwd: "/b", containerId: "c1" });

    useStore.getState().resetQuickTerminal();

    const state = useStore.getState();
    expect(state.quickTerminalOpen).toBe(false);
    expect(state.quickTerminalTabs).toEqual([]);
    expect(state.activeQuickTerminalTabId).toBeNull();
    expect(state.quickTerminalNextHostIndex).toBe(1);
    expect(state.quickTerminalNextDockerIndex).toBe(1);
  });
});

// ─── Terminal actions ────────────────────────────────────────────────────────

describe("Terminal actions", () => {
  it("setTerminalOpen: sets terminal open state", () => {
    useStore.getState().setTerminalOpen(true);
    expect(useStore.getState().terminalOpen).toBe(true);

    useStore.getState().setTerminalOpen(false);
    expect(useStore.getState().terminalOpen).toBe(false);
  });

  it("setTerminalCwd: sets the terminal working directory", () => {
    useStore.getState().setTerminalCwd("/home/user/project");
    expect(useStore.getState().terminalCwd).toBe("/home/user/project");

    useStore.getState().setTerminalCwd(null);
    expect(useStore.getState().terminalCwd).toBeNull();
  });

  it("setTerminalId: sets the terminal instance ID", () => {
    useStore.getState().setTerminalId("term-abc");
    expect(useStore.getState().terminalId).toBe("term-abc");

    useStore.getState().setTerminalId(null);
    expect(useStore.getState().terminalId).toBeNull();
  });

  it("openTerminal: sets open to true and cwd", () => {
    useStore.getState().openTerminal("/home/user/project");

    expect(useStore.getState().terminalOpen).toBe(true);
    expect(useStore.getState().terminalCwd).toBe("/home/user/project");
  });

  it("closeTerminal: resets all terminal state", () => {
    useStore.getState().openTerminal("/home/user/project");
    useStore.getState().setTerminalId("term-1");

    useStore.getState().closeTerminal();

    expect(useStore.getState().terminalOpen).toBe(false);
    expect(useStore.getState().terminalCwd).toBeNull();
    expect(useStore.getState().terminalId).toBeNull();
  });
});
