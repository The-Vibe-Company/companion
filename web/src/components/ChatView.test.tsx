// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "vitest-axe/extend-expect";

// Polyfill scrollIntoView for jsdom
Element.prototype.scrollIntoView = vi.fn();

const mockRelaunchSession = vi.fn();
const mockSetCliReconnecting = vi.fn();

let mockStoreState: Record<string, unknown> = {};

vi.mock("../store.js", () => {
  const useStore = (selector: (state: Record<string, unknown>) => unknown) => {
    return selector(mockStoreState);
  };
  useStore.getState = () => mockStoreState;
  return { useStore };
});

vi.mock("../api.js", () => ({
  api: {
    relaunchSession: (...args: unknown[]) => mockRelaunchSession(...args),
  },
}));

vi.mock("../analytics.js", () => ({
  captureException: vi.fn(),
}));

// Stub child components to isolate ChatView logic
vi.mock("./MessageFeed.js", () => ({
  MessageFeed: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="message-feed">{sessionId}</div>
  ),
}));

// Composer stub exposes the `onOpenIdePicker` prop via a button so we can
// assert that ChatView wires open/close state through to Composer (UI-03).
vi.mock("./Composer.js", () => ({
  Composer: ({
    sessionId,
    onOpenIdePicker,
  }: {
    sessionId: string;
    onOpenIdePicker?: () => void;
  }) => (
    <div data-testid="composer">
      {sessionId}
      <button
        type="button"
        data-testid="composer-open-ide"
        onClick={() => onOpenIdePicker?.()}
      >
        open-ide
      </button>
    </div>
  ),
}));

// IdePicker stub — ChatView mounts it when idePickerOpen=true. We render a
// visible element with role="dialog" to assert the mount, and surface the
// props so tests can verify currentBinding / cwd wiring.
vi.mock("./IdePicker.js", () => ({
  IdePicker: ({
    sessionId,
    cwd,
    currentBinding,
    onClose,
  }: {
    sessionId: string;
    cwd?: string;
    currentBinding?: unknown;
    onClose: () => void;
  }) => (
    <div role="dialog" aria-label="ide-picker-stub" data-testid="ide-picker">
      <span data-testid="ide-picker-session">{sessionId}</span>
      <span data-testid="ide-picker-cwd">{cwd ?? ""}</span>
      <span data-testid="ide-picker-binding">
        {currentBinding ? "bound" : "unbound"}
      </span>
      <button type="button" onClick={onClose}>
        close-picker
      </button>
    </div>
  ),
}));

vi.mock("./PermissionBanner.js", () => ({
  PermissionBanner: () => <div data-testid="permission-banner" />,
}));

vi.mock("./AiValidationBadge.js", () => ({
  AiValidationBadge: () => <div data-testid="ai-validation-badge" />,
}));

vi.mock("./ActivityTray.js", () => ({
  ActivityTray: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="activity-tray">{sessionId}</div>
  ),
}));

import { ChatView } from "./ChatView.js";

// Minimal shape for a stored session — only the fields ChatView reads.
type SessionStub = {
  session_id: string;
  cwd?: string;
  ideBinding?: unknown;
};

function setupStore(overrides: {
  connectionStatus?: "connecting" | "connected" | "disconnected";
  cliConnected?: boolean;
  cliReconnecting?: boolean;
  hasPendingPerms?: boolean;
  hasAiResolved?: boolean;
  session?: SessionStub | null;
} = {}) {
  const {
    connectionStatus = "connected",
    cliConnected = true,
    cliReconnecting = false,
    hasPendingPerms = false,
    hasAiResolved = false,
    session = { session_id: "s1", cwd: "/Users/me/proj", ideBinding: null },
  } = overrides;

  const connMap = new Map<string, string>();
  connMap.set("s1", connectionStatus);

  const cliMap = new Map<string, boolean>();
  cliMap.set("s1", cliConnected);

  const reconnMap = new Map<string, boolean>();
  if (cliReconnecting) reconnMap.set("s1", true);

  const pendingPerms = new Map();
  if (hasPendingPerms) {
    const permsForSession = new Map();
    permsForSession.set("perm1", { request_id: "perm1", tool: "Bash", command: "ls" });
    pendingPerms.set("s1", permsForSession);
  }

  const aiResolved = new Map();
  if (hasAiResolved) {
    aiResolved.set("s1", [{ tool: "Read", decision: "approved" }]);
  }

  const sessions = new Map<string, SessionStub>();
  if (session) sessions.set(session.session_id, session);

  mockStoreState = {
    connectionStatus: connMap,
    cliConnected: cliMap,
    cliReconnecting: reconnMap,
    pendingPermissions: pendingPerms,
    aiResolvedPermissions: aiResolved,
    sessions,
    clearAiResolvedPermissions: vi.fn(),
    setCliReconnecting: mockSetCliReconnecting,
  };
}

/**
 * Mutate just the session record + bump the selector cache — simulates the
 * server broadcasting a `session_update` that flips `ideBinding` without
 * tearing down the ChatView.
 */
function updateSessionInStore(next: SessionStub) {
  const sessions = mockStoreState.sessions as Map<string, SessionStub>;
  // Clone map so React's identity check (if any) triggers — not strictly
  // required with the mocked selector, but matches the real store semantics.
  const nextMap = new Map(sessions);
  nextMap.set(next.session_id, next);
  mockStoreState = { ...mockStoreState, sessions: nextMap };
}

// Representative binding used by BIND-05 transition tests.
const NVIM_BINDING = {
  port: 38630,
  ideName: "Neovim",
  workspaceFolders: ["/Users/me/proj"],
  transport: "ws-ide" as const,
  boundAt: 1700000000000,
  lockfilePath: "/Users/me/.claude/ide/38630.lock",
};

const NVIM_BINDING_2 = {
  port: 42424,
  ideName: "Neovim",
  workspaceFolders: ["/Users/me/proj"],
  transport: "ws-ide" as const,
  // Different boundAt + lockfilePath → different bindingId → banner re-shows.
  boundAt: 1700000999999,
  lockfilePath: "/Users/me/.claude/ide/42424.lock",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  setupStore();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ChatView", () => {
  // Renders core children (MessageFeed + Composer)
  it("renders MessageFeed and Composer", () => {
    render(<ChatView sessionId="s1" />);
    expect(screen.getByTestId("message-feed")).toBeTruthy();
    expect(screen.getByTestId("composer")).toBeTruthy();
  });

  // Accessibility scan — needs real timers for async axe import
  it("has no axe violations", { timeout: 15000 }, async () => {
    vi.useRealTimers();
    const { axe } = await import("vitest-axe");
    const { container } = render(<ChatView sessionId="s1" />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  // Banner visibility: no banner when CLI is connected
  it("does not show CLI banner when cliConnected=true", () => {
    setupStore({ cliConnected: true });
    render(<ChatView sessionId="s1" />);
    expect(screen.queryByText("CLI disconnected")).toBeNull();
    expect(screen.queryByText(/Reconnecting/)).toBeNull();
  });

  // Banner: shows disconnected state with Reconnect button
  it("shows 'CLI disconnected' banner with Reconnect button when CLI is disconnected", () => {
    setupStore({ cliConnected: false });
    render(<ChatView sessionId="s1" />);
    expect(screen.getByText("CLI disconnected")).toBeTruthy();
    expect(screen.getByText("Reconnect")).toBeTruthy();
  });

  // Banner: shows reconnecting state with spinner, no button
  it("shows spinner and 'Reconnecting' text when cliReconnecting=true", () => {
    setupStore({ cliConnected: false, cliReconnecting: true });
    render(<ChatView sessionId="s1" />);
    // Should show reconnecting text (uses &hellip; entity, rendered as "Reconnecting…")
    expect(screen.getByText(/Reconnecting/)).toBeTruthy();
    // The Reconnect button should NOT be visible during reconnecting
    expect(screen.queryByText("Reconnect")).toBeNull();
    // Spinner element should be present (identified by animate-spin class)
    const spinner = document.querySelector(".animate-spin");
    expect(spinner).toBeTruthy();
  });

  // Click handler: calls api.relaunchSession and sets reconnecting state
  it("calls api.relaunchSession and sets reconnecting state on click", async () => {
    setupStore({ cliConnected: false });
    mockRelaunchSession.mockResolvedValue({ ok: true });

    render(<ChatView sessionId="s1" />);
    fireEvent.click(screen.getByText("Reconnect"));

    // Should set reconnecting state immediately
    expect(mockSetCliReconnecting).toHaveBeenCalledWith("s1", true);
    // Should call the API
    expect(mockRelaunchSession).toHaveBeenCalledWith("s1");
  });

  // Error: shows error message when relaunch fails
  it("shows error message and Retry button when relaunch fails", async () => {
    vi.useRealTimers();
    setupStore({ cliConnected: false });
    mockRelaunchSession.mockRejectedValue(new Error("Server error"));

    render(<ChatView sessionId="s1" />);
    fireEvent.click(screen.getByText("Reconnect"));

    // Wait for the error to appear
    await waitFor(() => {
      expect(screen.getByText("Server error")).toBeTruthy();
    });
    // Should show Retry button
    expect(screen.getByText("Retry")).toBeTruthy();
    // Should have cleared reconnecting state
    expect(mockSetCliReconnecting).toHaveBeenCalledWith("s1", false);
  });

  // Error auto-clears after 4 seconds
  it("auto-clears error after 4 seconds", async () => {
    setupStore({ cliConnected: false });
    mockRelaunchSession.mockRejectedValue(new Error("Timeout"));

    render(<ChatView sessionId="s1" />);
    fireEvent.click(screen.getByText("Reconnect"));

    // Wait for error to show up
    await vi.waitFor(() => {
      expect(screen.getByText("Timeout")).toBeTruthy();
    });

    // Advance timers past the 4-second auto-clear
    vi.advanceTimersByTime(4100);

    // Error should be cleared, back to disconnected state
    await vi.waitFor(() => {
      expect(screen.queryByText("Timeout")).toBeNull();
      expect(screen.getByText("CLI disconnected")).toBeTruthy();
    });
  });

  // WebSocket disconnected banner
  it("shows 'Reconnecting to session...' when browser WS is disconnected", () => {
    setupStore({ connectionStatus: "disconnected", cliConnected: false });
    render(<ChatView sessionId="s1" />);
    expect(screen.getByText("Reconnecting to session...")).toBeTruthy();
  });

  // Permission banners render when present
  it("renders permission banners when pending permissions exist", () => {
    setupStore({ hasPendingPerms: true });
    render(<ChatView sessionId="s1" />);
    expect(screen.getByTestId("permission-banner")).toBeTruthy();
  });

  // AI validation badge renders when present
  it("renders AI validation badge when ai-resolved permissions exist", () => {
    setupStore({ hasAiResolved: true });
    render(<ChatView sessionId="s1" />);
    expect(screen.getByTestId("ai-validation-badge")).toBeTruthy();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // UI-03 + BIND-05 — IdePicker integration + disconnect banner
  // ─────────────────────────────────────────────────────────────────────────

  // UI-03: Composer's onOpenIdePicker prop mounts IdePicker (role="dialog").
  // This is the production path when a user types /ide in the composer.
  it("UI-03: onOpenIdePicker mounts IdePicker with role=dialog", () => {
    setupStore();
    render(<ChatView sessionId="s1" />);
    // Initially closed.
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByTestId("composer-open-ide"));
    // Dialog mounts — our stub asserts the picker rendered.
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByTestId("ide-picker-session").textContent).toBe("s1");
    expect(screen.getByTestId("ide-picker-cwd").textContent).toBe(
      "/Users/me/proj"
    );
    // No binding on this session → stub reports "unbound".
    expect(screen.getByTestId("ide-picker-binding").textContent).toBe("unbound");
  });

  // UI-03: close callback unmounts the picker (dialog gone).
  it("UI-03: picker closes when onClose fires", () => {
    setupStore();
    render(<ChatView sessionId="s1" />);
    fireEvent.click(screen.getByTestId("composer-open-ide"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByText("close-picker"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  // Issue #6: switching sessions while the IdePicker is open must CLOSE the
  // picker. Otherwise the modal state leaks across sessions: user opens /ide
  // on session A, clicks session B in the sidebar, and sees the picker still
  // open — but it's now bound to session B (wrong cwd, wrong binding, wrong
  // bind target). Reset idePickerOpen whenever sessionId changes.
  it("resets idePickerOpen when sessionId prop changes", () => {
    // Two sessions in the store so ChatView can render either.
    const connMap = new Map<string, string>();
    connMap.set("s1", "connected");
    connMap.set("s2", "connected");
    const cliMap = new Map<string, boolean>();
    cliMap.set("s1", true);
    cliMap.set("s2", true);
    const sessions = new Map<string, SessionStub>();
    sessions.set("s1", { session_id: "s1", cwd: "/Users/me/proj-a", ideBinding: null });
    sessions.set("s2", { session_id: "s2", cwd: "/Users/me/proj-b", ideBinding: null });
    mockStoreState = {
      connectionStatus: connMap,
      cliConnected: cliMap,
      cliReconnecting: new Map(),
      pendingPermissions: new Map(),
      aiResolvedPermissions: new Map(),
      sessions,
      clearAiResolvedPermissions: vi.fn(),
      setCliReconnecting: mockSetCliReconnecting,
    };

    const { rerender } = render(<ChatView sessionId="s1" />);
    // Open picker on session s1.
    fireEvent.click(screen.getByTestId("composer-open-ide"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByTestId("ide-picker-session").textContent).toBe("s1");

    // Switch sessions — real app fires this when the user clicks another
    // session in the sidebar. The picker must NOT remain open with the new
    // sessionId; if it did, binds against s2 would use whatever port was
    // selected under s1 and the picker would show the wrong cwd/binding.
    rerender(<ChatView sessionId="s2" />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  // UI-03: currentBinding is forwarded to IdePicker so the picker can render
  // the "currently bound" affordance (Disconnect button, highlight, etc.).
  it("UI-03: forwards currentBinding to IdePicker when session has one", () => {
    setupStore({
      session: {
        session_id: "s1",
        cwd: "/Users/me/proj",
        ideBinding: NVIM_BINDING,
      },
    });
    render(<ChatView sessionId="s1" />);
    fireEvent.click(screen.getByTestId("composer-open-ide"));
    expect(screen.getByTestId("ide-picker-binding").textContent).toBe("bound");
  });

  // BIND-05: transition non-null → null renders banner with exact spec copy.
  // The copy is pinned by SPEC — test asserts the literal string including
  // the em-dash (\u2014). A future drift (hyphen, minus, typo) fails here.
  it("BIND-05: non-null → null transition shows banner with exact copy", () => {
    setupStore({
      session: {
        session_id: "s1",
        cwd: "/Users/me/proj",
        ideBinding: NVIM_BINDING,
      },
    });
    const { rerender } = render(<ChatView sessionId="s1" />);
    // Before disconnect: no banner.
    expect(
      screen.queryByText("IDE disconnected \u2014 rebind via /ide")
    ).toBeNull();

    // Simulate server session_update setting ideBinding: null.
    updateSessionInStore({
      session_id: "s1",
      cwd: "/Users/me/proj",
      ideBinding: null,
    });
    rerender(<ChatView sessionId="s1" />);

    // Banner appears with the EXACT literal copy.
    expect(
      screen.getByText("IDE disconnected \u2014 rebind via /ide")
    ).toBeTruthy();
    expect(screen.getByRole("status")).toBeTruthy();
  });

  // BIND-05: dismiss button removes the banner for this disconnect only.
  it("BIND-05: dismiss button removes the banner", () => {
    setupStore({
      session: {
        session_id: "s1",
        cwd: "/Users/me/proj",
        ideBinding: NVIM_BINDING,
      },
    });
    const { rerender } = render(<ChatView sessionId="s1" />);
    updateSessionInStore({
      session_id: "s1",
      cwd: "/Users/me/proj",
      ideBinding: null,
    });
    rerender(<ChatView sessionId="s1" />);
    expect(screen.getByTestId("ide-disconnect-banner")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(screen.queryByTestId("ide-disconnect-banner")).toBeNull();
  });

  // BIND-05: a SECOND disconnect (new bindingId) must re-show the banner
  // even if the prior disconnect was dismissed. Dismissal is per-binding.
  it("BIND-05: a second disconnect re-shows the banner after prior dismissal", () => {
    setupStore({
      session: {
        session_id: "s1",
        cwd: "/Users/me/proj",
        ideBinding: NVIM_BINDING,
      },
    });
    const { rerender } = render(<ChatView sessionId="s1" />);

    // First disconnect → banner → dismiss.
    updateSessionInStore({
      session_id: "s1",
      cwd: "/Users/me/proj",
      ideBinding: null,
    });
    rerender(<ChatView sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(screen.queryByTestId("ide-disconnect-banner")).toBeNull();

    // Rebind to a DIFFERENT binding (new bindingId).
    updateSessionInStore({
      session_id: "s1",
      cwd: "/Users/me/proj",
      ideBinding: NVIM_BINDING_2,
    });
    rerender(<ChatView sessionId="s1" />);
    // No banner while bound.
    expect(screen.queryByTestId("ide-disconnect-banner")).toBeNull();

    // Second disconnect — banner reappears because dismissal was scoped to
    // the prior bindingId, not "any disconnect on this session".
    updateSessionInStore({
      session_id: "s1",
      cwd: "/Users/me/proj",
      ideBinding: null,
    });
    rerender(<ChatView sessionId="s1" />);
    expect(screen.getByTestId("ide-disconnect-banner")).toBeTruthy();
  });

  // BIND-05: no toast / modal API involvement. We spy on the module-level
  // `api` object to confirm ChatView does NOT call anything that looks like
  // a toast or modal on the disconnect transition. (The mocked api only
  // exposes relaunchSession; assertion is on call count across the full
  // interaction.)
  it("BIND-05: no toast/modal API is invoked during the transition", () => {
    mockRelaunchSession.mockClear();
    setupStore({
      session: {
        session_id: "s1",
        cwd: "/Users/me/proj",
        ideBinding: NVIM_BINDING,
      },
    });
    const { rerender } = render(<ChatView sessionId="s1" />);
    updateSessionInStore({
      session_id: "s1",
      cwd: "/Users/me/proj",
      ideBinding: null,
    });
    rerender(<ChatView sessionId="s1" />);

    // Banner is an in-chat role=status element — not a dialog, not a toast.
    expect(screen.getByRole("status")).toBeTruthy();
    // No dialog (modal) appears as a result of the transition. Only the
    // explicit UI-03 openIdePicker path mounts a dialog.
    expect(screen.queryByRole("dialog")).toBeNull();
    // No API calls happened (we only mock relaunchSession, and the
    // transition must not trigger anything network-y).
    expect(mockRelaunchSession).not.toHaveBeenCalled();
  });

  // ─── BIND-09 (cubic PR #652 round-3 P2): rebind clears the disconnect banner ─
  //
  // Context: the transition effect handles non-null → null (show banner) and
  // seeds `previousIdeBindingRef` on non-null. But it previously did NOT clear
  // `disconnectedBindingId` / `dismissedForBinding` when the user rebound an
  // IDE after a disconnect. Sequence that broke:
  //   1. User bound an IDE, it disconnected → banner shown.
  //   2. User rebound via /ide → session record now has a non-null binding.
  //   3. Banner STILL visible (stale disconnectedBindingId was never cleared).
  //
  // Fix: when `ideBinding` transitions to non-null, clear both
  // `disconnectedBindingId` and `dismissedForBinding` so the banner unmounts.
  //
  // This test pins: bind → disconnect → banner → rebind → banner GONE.
  it("BIND-09: rebinding after a disconnect clears the disconnect banner", () => {
    // Start bound — seeds the ref on mount via useLayoutEffect.
    setupStore({
      session: {
        session_id: "s1",
        cwd: "/Users/me/proj",
        ideBinding: NVIM_BINDING,
      },
    });
    const { rerender } = render(<ChatView sessionId="s1" />);
    // No banner while bound.
    expect(screen.queryByTestId("ide-disconnect-banner")).toBeNull();

    // Simulate the server broadcasting ideBinding: null — banner must show.
    updateSessionInStore({
      session_id: "s1",
      cwd: "/Users/me/proj",
      ideBinding: null,
    });
    rerender(<ChatView sessionId="s1" />);
    expect(screen.getByTestId("ide-disconnect-banner")).toBeTruthy();

    // Rebind via /ide — new non-null binding. Without the fix, the banner
    // lingers because disconnectedBindingId is still set to the prior
    // bindingId, and dismissedForBinding is null, so showIdeDisconnectBanner
    // remains true.
    updateSessionInStore({
      session_id: "s1",
      cwd: "/Users/me/proj",
      ideBinding: NVIM_BINDING_2,
    });
    rerender(<ChatView sessionId="s1" />);

    // Banner is gone — the transition effect must have cleared
    // disconnectedBindingId on the null → non-null transition.
    expect(screen.queryByTestId("ide-disconnect-banner")).toBeNull();
  });

  // Defensive: a session that was NEVER bound must not render the banner
  // on an undefined/null ideBinding — banners only fire on a transition.
  it("BIND-05: never-bound sessions do not show the banner", () => {
    setupStore({
      session: {
        session_id: "s1",
        cwd: "/Users/me/proj",
        ideBinding: null,
      },
    });
    render(<ChatView sessionId="s1" />);
    expect(screen.queryByTestId("ide-disconnect-banner")).toBeNull();
  });
});
