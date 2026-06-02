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

// ─── UI state ───────────────────────────────────────────────────────────────

describe("UI state", () => {
  it("setDarkMode: sets the value explicitly and persists to localStorage", () => {
    useStore.getState().setDarkMode(true);
    expect(useStore.getState().darkMode).toBe(true);
    expect(localStorage.getItem("cc-dark-mode")).toBe("true");

    useStore.getState().setDarkMode(false);
    expect(useStore.getState().darkMode).toBe(false);
    expect(localStorage.getItem("cc-dark-mode")).toBe("false");
  });

  it("toggleDarkMode: flips the value and persists to localStorage", () => {
    const initial = useStore.getState().darkMode;
    useStore.getState().toggleDarkMode();

    expect(useStore.getState().darkMode).toBe(!initial);
    expect(localStorage.getItem("cc-dark-mode")).toBe(String(!initial));

    useStore.getState().toggleDarkMode();
    expect(useStore.getState().darkMode).toBe(initial);
    expect(localStorage.getItem("cc-dark-mode")).toBe(String(initial));
  });

  it("newSession: clears currentSessionId and increments homeResetKey", () => {
    useStore.getState().setCurrentSession("s1");
    const keyBefore = useStore.getState().homeResetKey;

    useStore.getState().newSession();

    expect(useStore.getState().currentSessionId).toBeNull();
    expect(useStore.getState().homeResetKey).toBe(keyBefore + 1);
    expect(localStorage.getItem("cc-current-session")).toBeNull();
  });
});

// ─── Notification settings ───────────────────────────────────────────────────

describe("Notification settings", () => {
  it("setNotificationSound: persists value to localStorage", () => {
    useStore.getState().setNotificationSound(false);
    expect(useStore.getState().notificationSound).toBe(false);
    expect(localStorage.getItem("cc-notification-sound")).toBe("false");

    useStore.getState().setNotificationSound(true);
    expect(useStore.getState().notificationSound).toBe(true);
    expect(localStorage.getItem("cc-notification-sound")).toBe("true");
  });

  it("toggleNotificationSound: flips value and persists to localStorage", () => {
    // Start with default (true after reset)
    useStore.getState().setNotificationSound(true);
    const initial = useStore.getState().notificationSound;

    useStore.getState().toggleNotificationSound();
    expect(useStore.getState().notificationSound).toBe(!initial);
    expect(localStorage.getItem("cc-notification-sound")).toBe(String(!initial));

    useStore.getState().toggleNotificationSound();
    expect(useStore.getState().notificationSound).toBe(initial);
  });

  it("setNotificationDesktop: persists value to localStorage", () => {
    useStore.getState().setNotificationDesktop(true);
    expect(useStore.getState().notificationDesktop).toBe(true);
    expect(localStorage.getItem("cc-notification-desktop")).toBe("true");

    useStore.getState().setNotificationDesktop(false);
    expect(useStore.getState().notificationDesktop).toBe(false);
    expect(localStorage.getItem("cc-notification-desktop")).toBe("false");
  });

  it("toggleNotificationDesktop: flips value and persists to localStorage", () => {
    useStore.getState().setNotificationDesktop(false);

    useStore.getState().toggleNotificationDesktop();
    expect(useStore.getState().notificationDesktop).toBe(true);
    expect(localStorage.getItem("cc-notification-desktop")).toBe("true");

    useStore.getState().toggleNotificationDesktop();
    expect(useStore.getState().notificationDesktop).toBe(false);
    expect(localStorage.getItem("cc-notification-desktop")).toBe("false");
  });
});

// ─── Sidebar & task panel configuration ──────────────────────────────────────

describe("Sidebar & task panel configuration", () => {
  it("setSidebarOpen: sets the sidebar open state", () => {
    useStore.getState().setSidebarOpen(false);
    expect(useStore.getState().sidebarOpen).toBe(false);

    useStore.getState().setSidebarOpen(true);
    expect(useStore.getState().sidebarOpen).toBe(true);
  });

  it("setTaskPanelOpen: sets the task panel open state", () => {
    useStore.getState().setTaskPanelOpen(false);
    expect(useStore.getState().taskPanelOpen).toBe(false);

    useStore.getState().setTaskPanelOpen(true);
    expect(useStore.getState().taskPanelOpen).toBe(true);
  });

  it("setTaskPanelConfigMode: toggles config mode on and off", () => {
    useStore.getState().setTaskPanelConfigMode(true);
    expect(useStore.getState().taskPanelConfigMode).toBe(true);

    useStore.getState().setTaskPanelConfigMode(false);
    expect(useStore.getState().taskPanelConfigMode).toBe(false);
  });

  it("toggleSectionEnabled: flips the enabled state for a section and persists config", () => {
    // Sections start enabled by default
    const sectionId = "tasks";
    const initialEnabled = useStore.getState().taskPanelConfig.enabled[sectionId];
    expect(initialEnabled).toBe(true);

    useStore.getState().toggleSectionEnabled(sectionId);
    expect(useStore.getState().taskPanelConfig.enabled[sectionId]).toBe(false);

    // Verify persistence to localStorage
    const stored = JSON.parse(localStorage.getItem("cc-task-panel-config") || "{}");
    expect(stored.enabled[sectionId]).toBe(false);

    // Toggle back
    useStore.getState().toggleSectionEnabled(sectionId);
    expect(useStore.getState().taskPanelConfig.enabled[sectionId]).toBe(true);
  });

  it("moveSectionUp: swaps section with the one above it", () => {
    const order = useStore.getState().taskPanelConfig.order;
    // Move the second section up
    const secondId = order[1];
    const firstId = order[0];

    useStore.getState().moveSectionUp(secondId);

    const newOrder = useStore.getState().taskPanelConfig.order;
    expect(newOrder[0]).toBe(secondId);
    expect(newOrder[1]).toBe(firstId);

    // Verify persistence
    const stored = JSON.parse(localStorage.getItem("cc-task-panel-config") || "{}");
    expect(stored.order[0]).toBe(secondId);
  });

  it("moveSectionUp: no-op when section is already at the top", () => {
    const orderBefore = [...useStore.getState().taskPanelConfig.order];
    const firstId = orderBefore[0];

    useStore.getState().moveSectionUp(firstId);

    // Order should remain unchanged
    expect(useStore.getState().taskPanelConfig.order).toEqual(orderBefore);
  });

  it("moveSectionDown: swaps section with the one below it", () => {
    const order = useStore.getState().taskPanelConfig.order;
    const firstId = order[0];
    const secondId = order[1];

    useStore.getState().moveSectionDown(firstId);

    const newOrder = useStore.getState().taskPanelConfig.order;
    expect(newOrder[0]).toBe(secondId);
    expect(newOrder[1]).toBe(firstId);

    // Verify persistence
    const stored = JSON.parse(localStorage.getItem("cc-task-panel-config") || "{}");
    expect(stored.order[0]).toBe(secondId);
  });

  it("moveSectionDown: no-op when section is already at the bottom", () => {
    const orderBefore = [...useStore.getState().taskPanelConfig.order];
    const lastId = orderBefore[orderBefore.length - 1];

    useStore.getState().moveSectionDown(lastId);

    expect(useStore.getState().taskPanelConfig.order).toEqual(orderBefore);
  });

  it("resetTaskPanelConfig: restores default config and persists", () => {
    // First, modify the config
    useStore.getState().toggleSectionEnabled("tasks");
    const orderBefore = useStore.getState().taskPanelConfig.order;
    useStore.getState().moveSectionDown(orderBefore[0]);

    // Reset
    useStore.getState().resetTaskPanelConfig();

    const config = useStore.getState().taskPanelConfig;
    // All sections should be enabled
    for (const key of Object.keys(config.enabled)) {
      expect(config.enabled[key]).toBe(true);
    }

    // Verify persistence
    const stored = JSON.parse(localStorage.getItem("cc-task-panel-config") || "{}");
    expect(stored.order).toBeDefined();
    expect(stored.enabled).toBeDefined();
  });
});

// ─── Active tab & diff panel ─────────────────────────────────────────────────

describe("Active tab & diff panel", () => {
  it("setActiveTab: sets the active workspace tab", () => {
    useStore.getState().setActiveTab("diff");
    expect(useStore.getState().activeTab).toBe("diff");

    useStore.getState().setActiveTab("chat");
    expect(useStore.getState().activeTab).toBe("chat");
  });

  it("markChatTabReentry: increments tick per session", () => {
    useStore.getState().markChatTabReentry("s1");
    expect(useStore.getState().chatTabReentryTickBySession.get("s1")).toBe(1);

    useStore.getState().markChatTabReentry("s1");
    expect(useStore.getState().chatTabReentryTickBySession.get("s1")).toBe(2);

    // Different session starts at 1
    useStore.getState().markChatTabReentry("s2");
    expect(useStore.getState().chatTabReentryTickBySession.get("s2")).toBe(1);
  });

  it("setDiffPanelSelectedFile: stores file path for a session", () => {
    useStore.getState().setDiffPanelSelectedFile("s1", "src/main.ts");
    expect(useStore.getState().diffPanelSelectedFile.get("s1")).toBe("src/main.ts");
  });

  it("setDiffPanelSelectedFile(null): removes the selection for a session", () => {
    useStore.getState().setDiffPanelSelectedFile("s1", "src/main.ts");
    useStore.getState().setDiffPanelSelectedFile("s1", null);
    expect(useStore.getState().diffPanelSelectedFile.has("s1")).toBe(false);
  });
});

// ─── Diff base setting ───────────────────────────────────────────────────────

describe("Diff base", () => {
  it("setDiffBase: persists diff base to localStorage", () => {
    useStore.getState().setDiffBase("default-branch");
    expect(useStore.getState().diffBase).toBe("default-branch");
    expect(localStorage.getItem("cc-diff-base")).toBe("default-branch");

    useStore.getState().setDiffBase("last-commit");
    expect(useStore.getState().diffBase).toBe("last-commit");
    expect(localStorage.getItem("cc-diff-base")).toBe("last-commit");
  });
});
