// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

vi.mock("./TerminalView.js", () => ({
  TerminalView: ({ title, cwd }: { title?: string; cwd: string }) => (
    <div data-testid="terminal-view">{title || cwd}</div>
  ),
}));

interface MockStoreState {
  currentSessionId: string | null;
  quickTerminalOpen: boolean;
  quickTerminalTabs: { id: string; label: string; cwd: string; containerId?: string }[];
  activeQuickTerminalTabId: string | null;
  quickTerminalPlacement: "top" | "right" | "bottom" | "left";
  setQuickTerminalOpen: ReturnType<typeof vi.fn>;
  openQuickTerminal: ReturnType<typeof vi.fn>;
  closeQuickTerminalTab: ReturnType<typeof vi.fn>;
  setActiveQuickTerminalTabId: ReturnType<typeof vi.fn>;
  sessions: Map<string, { cwd?: string; is_containerized?: boolean }>;
  sdkSessions: { sessionId: string; cwd?: string; containerId?: string }[];
}

let storeState: MockStoreState;

function resetStore(overrides: Partial<MockStoreState> = {}) {
  storeState = {
    currentSessionId: "s1",
    quickTerminalOpen: true,
    quickTerminalTabs: [{ id: "t1", label: "Terminal", cwd: "/repo" }],
    activeQuickTerminalTabId: "t1",
    quickTerminalPlacement: "left",
    setQuickTerminalOpen: vi.fn(),
    openQuickTerminal: vi.fn(),
    closeQuickTerminalTab: vi.fn(),
    setActiveQuickTerminalTabId: vi.fn(),
    sessions: new Map([["s1", { cwd: "/repo" }]]),
    sdkSessions: [],
    ...overrides,
  };
}

vi.mock("../store.js", () => ({
  useStore: (selector: (s: MockStoreState) => unknown) => selector(storeState),
}));

import { SessionTerminalDock } from "./SessionTerminalDock.js";

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
});

describe("SessionTerminalDock", () => {
  it("renders only session content when terminal dock is closed", () => {
    // Ensures chat/diff layout remains untouched when no terminal tab is active.
    resetStore({ quickTerminalOpen: false, quickTerminalTabs: [] });

    render(
      <SessionTerminalDock sessionId="s1">
        <div>Session content</div>
      </SessionTerminalDock>,
    );

    expect(screen.getByText("Session content")).toBeInTheDocument();
    expect(screen.queryByTestId("terminal-view")).not.toBeInTheDocument();
  });

  it("renders docked terminal panel inside the session layout", () => {
    // Verifies terminal is embedded in the same session container and can be closed via toolbar.
    render(
      <SessionTerminalDock sessionId="s1">
        <div>Session content</div>
      </SessionTerminalDock>,
    );

    expect(screen.getByText("Session content")).toBeInTheDocument();
    expect(screen.getByText("Terminal")).toBeInTheDocument();
    expect(screen.getByTestId("terminal-view")).toHaveTextContent("/repo");

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(storeState.setQuickTerminalOpen).toHaveBeenCalledWith(false);
  });

  it("keeps terminal mounted when panel is suppressed", () => {
    // Ensures tab switches can hide the panel without unmounting TerminalView (which would kill PTY).
    render(
      <SessionTerminalDock sessionId="s1" suppressPanel>
        <div>Session content</div>
      </SessionTerminalDock>,
    );

    expect(screen.getByText("Session content")).toBeInTheDocument();
    expect(screen.getByTestId("terminal-view")).toBeInTheDocument();
  });

  it("opens host terminal from + Terminal in non-container sessions", () => {
    render(
      <SessionTerminalDock sessionId="s1">
        <div>Session content</div>
      </SessionTerminalDock>,
    );

    fireEvent.click(screen.getByRole("button", { name: "+ Terminal" }));
    expect(storeState.openQuickTerminal).toHaveBeenCalledWith({ target: "host", cwd: "/repo" });
  });

  it("opens docker terminal from + Terminal in container sessions", () => {
    resetStore({
      sdkSessions: [{ sessionId: "s1", cwd: "/repo", containerId: "ctr-1" }],
    });

    render(
      <SessionTerminalDock sessionId="s1">
        <div>Session content</div>
      </SessionTerminalDock>,
    );

    fireEvent.click(screen.getByRole("button", { name: "+ Terminal" }));
    expect(storeState.openQuickTerminal).toHaveBeenCalledWith({
      target: "docker",
      cwd: "/workspace",
      containerId: "ctr-1",
    });
  });
});
