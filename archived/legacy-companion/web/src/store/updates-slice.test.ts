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
import type { CreationProgressEvent } from "../api.js";

beforeEach(() => {
  useStore.getState().reset();
  localStorage.clear();
});

// ─── Creation progress ───────────────────────────────────────────────────────

describe("Creation progress", () => {
  it("addCreationProgress: appends a new step when creationProgress is null", () => {
    // clearCreation ensures no residual creation state from prior tests
    // (reset() does not clear creationProgress)
    useStore.getState().clearCreation();

    const step: CreationProgressEvent = {
      step: "spawn",
      label: "Spawning CLI",
      status: "in_progress",
    };
    useStore.getState().addCreationProgress(step);

    const state = useStore.getState();
    expect(state.creationProgress).toHaveLength(1);
    expect(state.creationProgress![0]).toEqual(step);
  });

  it("addCreationProgress: appends a second step to existing progress", () => {
    useStore.getState().clearCreation();

    const step1: CreationProgressEvent = { step: "spawn", label: "Spawning CLI", status: "done" };
    const step2: CreationProgressEvent = { step: "connect", label: "Connecting", status: "in_progress" };
    useStore.getState().addCreationProgress(step1);
    useStore.getState().addCreationProgress(step2);

    expect(useStore.getState().creationProgress).toHaveLength(2);
  });

  it("addCreationProgress: updates existing step when same step name is used", () => {
    // clearCreation ensures we start from null creationProgress, since
    // reset() does not clear this field
    useStore.getState().clearCreation();

    // Simulates a step transitioning from in_progress to done
    const stepInProgress: CreationProgressEvent = { step: "spawn", label: "Spawning", status: "in_progress" };
    const stepDone: CreationProgressEvent = { step: "spawn", label: "Spawned", status: "done" };

    useStore.getState().addCreationProgress(stepInProgress);
    useStore.getState().addCreationProgress(stepDone);

    const progress = useStore.getState().creationProgress!;
    expect(progress).toHaveLength(1);
    expect(progress[0].status).toBe("done");
    expect(progress[0].label).toBe("Spawned");
  });

  it("clearCreation: resets all creation-related state", () => {
    useStore.getState().addCreationProgress({ step: "spawn", label: "x", status: "done" });
    useStore.getState().setCreationError("something failed");
    useStore.getState().setSessionCreating(true, "claude");

    useStore.getState().clearCreation();

    const state = useStore.getState();
    expect(state.creationProgress).toBeNull();
    expect(state.creationError).toBeNull();
    expect(state.sessionCreating).toBe(false);
    expect(state.sessionCreatingBackend).toBeNull();
  });

  it("setSessionCreating: sets creating state and optional backend", () => {
    useStore.getState().setSessionCreating(true, "codex");
    expect(useStore.getState().sessionCreating).toBe(true);
    expect(useStore.getState().sessionCreatingBackend).toBe("codex");

    // Without backend argument, defaults to null
    useStore.getState().setSessionCreating(false);
    expect(useStore.getState().sessionCreating).toBe(false);
    expect(useStore.getState().sessionCreatingBackend).toBeNull();
  });

  it("setCreationError: sets and clears the error message", () => {
    useStore.getState().setCreationError("CLI failed to start");
    expect(useStore.getState().creationError).toBe("CLI failed to start");

    useStore.getState().setCreationError(null);
    expect(useStore.getState().creationError).toBeNull();
  });
});

// ─── Update info ─────────────────────────────────────────────────────────────

describe("Update info", () => {
  it("setUpdateInfo: stores update info", () => {
    const info = {
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      updateAvailable: true,
      isServiceMode: false,
      updateInProgress: false,
      lastChecked: Date.now(),
      channel: "stable" as const,
    };
    useStore.getState().setUpdateInfo(info);
    expect(useStore.getState().updateInfo).toEqual(info);
  });

  it("setUpdateInfo(null): clears update info", () => {
    useStore.getState().setUpdateInfo({
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      updateAvailable: true,
      isServiceMode: false,
      updateInProgress: false,
      lastChecked: Date.now(),
      channel: "stable",
    });
    useStore.getState().setUpdateInfo(null);
    expect(useStore.getState().updateInfo).toBeNull();
  });

  it("dismissUpdate: persists dismissed version to localStorage", () => {
    useStore.getState().dismissUpdate("1.1.0");
    expect(useStore.getState().updateDismissedVersion).toBe("1.1.0");
    expect(localStorage.getItem("cc-update-dismissed")).toBe("1.1.0");
  });

  it("setUpdateOverlayActive: sets the overlay active state", () => {
    useStore.getState().setUpdateOverlayActive(true);
    expect(useStore.getState().updateOverlayActive).toBe(true);

    useStore.getState().setUpdateOverlayActive(false);
    expect(useStore.getState().updateOverlayActive).toBe(false);
  });
});
