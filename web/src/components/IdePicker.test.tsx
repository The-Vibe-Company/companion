// @vitest-environment jsdom
/**
 * Tests for IdePicker component (Task 10 — UI-02, UI-03).
 *
 * Validates:
 *  - Five render states: empty, single, many-with-best-match, currently-bound, bind-failed.
 *  - Accessibility (axe scan) across states; role="dialog", aria-modal, listbox semantics.
 *  - Keyboard navigation (ArrowUp/Down cycles; Enter picks; Escape closes; D disconnects).
 *  - REST boundary: picks call bindIde(sessionId, port); Esc does NOT call bindIde;
 *    "D" calls unbindIde only when currentBinding is present.
 *  - Bind-failure UX: inline error + Retry calls bindIde a second time (does NOT close).
 *
 * IdePicker NEVER touches the store — store updates flow via session_update.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

// ─── Mocks ──────────────────────────────────────────────────────────────────
//
// Mock the `../api.js` module. Task 9 already landed `getAvailableIdes`,
// `bindIde`, `unbindIde` as module-level exports AND the standard `api`
// namespace object; we mock both surfaces so the component code is free
// to import either way.
vi.mock("../api.js", () => {
  const fns = {
    getAvailableIdes: vi.fn(),
    bindIde: vi.fn(),
    unbindIde: vi.fn(),
    getHome: vi.fn(),
  };
  return {
    ...fns,
    api: fns,
  };
});

// Issue #11 (codex adversarial review): mock `../store.js` so that ANY call
// to `useStore` OR `useStore.setState` from IdePicker registers on a spy.
// The prior "tautology" test never mocked the store, so a component that
// mutated it via setState still passed the assertion. This mock surfaces
// every store interaction as a counted call; tests assert the count is 0.
const setStateSpy = vi.fn();
const getStateSpy = vi.fn(() => ({}));
const subscribeSpy = vi.fn(() => () => {});
const useStoreMock = vi.fn(() => ({}));
// zustand exposes setState/getState/subscribe as static methods on the hook
// function. We expose the same shape so an import of `useStore` in IdePicker
// would see the spy regardless of access pattern.
const useStoreWithStatics = Object.assign(useStoreMock, {
  setState: setStateSpy,
  getState: getStateSpy,
  subscribe: subscribeSpy,
});
vi.mock("../store.js", () => ({
  useStore: useStoreWithStatics,
}));

import * as apiModule from "../api.js";
import { IdePicker } from "./IdePicker.js";
import type { IdeBinding } from "../types.js";

const mockGetAvailableIdes = apiModule.getAvailableIdes as ReturnType<typeof vi.fn>;
const mockBindIde = apiModule.bindIde as ReturnType<typeof vi.fn>;
const mockUnbindIde = apiModule.unbindIde as ReturnType<typeof vi.fn>;
const mockGetHome = (apiModule.api as unknown as { getHome: ReturnType<typeof vi.fn> }).getHome;

// Sample IDE entries. Workspace paths under `/Users/me/...` so we can
// validate the `~/…` home-abbreviation rendering once the getHome mock
// resolves.
const idesMany = [
  {
    port: 50001,
    ideName: "Neovim",
    workspaceFolders: ["/Users/me/areas/secreg"],
    transport: "ws-ide" as const,
    lockfilePath: "/Users/me/.claude/ide/50001.lock",
    lockfileMtime: 1_700_000_000_000,
  },
  {
    port: 50002,
    ideName: "Visual Studio Code",
    workspaceFolders: ["/Users/me/areas"],
    transport: "ws-ide" as const,
    lockfilePath: "/Users/me/.claude/ide/50002.lock",
    lockfileMtime: 1_700_000_100_000,
  },
  {
    port: 50003,
    ideName: "Obsidian",
    workspaceFolders: ["/Users/me/notes"],
    transport: "sse-ide" as const,
    lockfilePath: "/Users/me/.claude/ide/50003.lock",
    lockfileMtime: 1_700_000_200_000,
  },
];

const sampleBinding: IdeBinding = {
  port: 50001,
  ideName: "Neovim",
  workspaceFolders: ["/Users/me/areas/secreg"],
  transport: "ws-ide",
  boundAt: 1_700_000_300_000,
  lockfilePath: "/Users/me/.claude/ide/50001.lock",
};

function setup(props: Partial<Parameters<typeof IdePicker>[0]> = {}) {
  const onClose = vi.fn();
  const result = render(
    <IdePicker
      sessionId="sess-A"
      cwd="/Users/me/areas/secreg"
      currentBinding={null}
      onClose={onClose}
      {...props}
    />,
  );
  return { onClose, ...result };
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  vi.clearAllMocks();
  // Default home lookup succeeds.
  mockGetHome.mockResolvedValue({ home: "/Users/me", cwd: "/Users/me" });
  // Default: return "many" list (best match first per server ordering by cwd prefix).
  mockGetAvailableIdes.mockResolvedValue(idesMany);
});

describe("IdePicker — render states", () => {
  it("renders the zero-state when no IDEs are discovered", async () => {
    // UI-02: empty state copy per spec — "No IDE detected. Start one and try again."
    mockGetAvailableIdes.mockResolvedValue([]);
    setup();

    await waitFor(() => {
      expect(screen.getByText(/No IDE detected/i)).toBeInTheDocument();
    });
    // Axe: empty state must pass.
    const { axe } = await import("vitest-axe");
    const dialog = screen.getByRole("dialog");
    const results = await axe(dialog);
    expect(results).toHaveNoViolations();
  });

  it("renders a single discovered IDE", async () => {
    // UI-02: single-match auto-highlighted.
    mockGetAvailableIdes.mockResolvedValue([idesMany[0]]);
    setup();

    await waitFor(() => {
      expect(screen.getByText("Neovim")).toBeInTheDocument();
    });
    // Axe scan.
    const { axe } = await import("vitest-axe");
    const dialog = screen.getByRole("dialog");
    const results = await axe(dialog);
    expect(results).toHaveNoViolations();
  });

  it("renders multiple IDEs and highlights the best match (first entry)", async () => {
    // UI-02: best match — the server returns entries ordered with best match first;
    // component must pre-select / highlight item index 0.
    setup();

    await waitFor(() => {
      expect(screen.getByText("Neovim")).toBeInTheDocument();
      expect(screen.getByText("Visual Studio Code")).toBeInTheDocument();
      expect(screen.getByText("Obsidian")).toBeInTheDocument();
    });

    // The first option is the best match and should be aria-selected.
    const options = screen.getAllByRole("option");
    expect(options.length).toBe(3);
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(options[1]).toHaveAttribute("aria-selected", "false");
  });

  it("renders a 'currently bound' state with a Disconnect affordance", async () => {
    // UI-03: when currentBinding is present, show current binding at top
    // with a visible Disconnect button. Listing still renders below.
    setup({ currentBinding: sampleBinding });

    await waitFor(() => {
      expect(screen.getByText("Neovim")).toBeInTheDocument();
    });
    // Disconnect button must have a discoverable accessible name.
    const disconnect = screen.getByRole("button", { name: /disconnect/i });
    expect(disconnect).toBeInTheDocument();
  });

  it("renders a bind-failed state with inline error + Retry", async () => {
    // UI-03: after a failed pick, component renders inline error and a Retry button;
    // it does NOT close, does NOT toast.
    mockBindIde.mockResolvedValue({ ok: false, error: "unknown port" });
    const { onClose } = setup();

    await waitFor(() => {
      expect(screen.getByText("Neovim")).toBeInTheDocument();
    });

    // Pick the best match (index 0) by pressing Enter.
    fireEvent.keyDown(document, { key: "Enter" });

    await waitFor(() => {
      expect(screen.getByText(/unknown port/)).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    // Does not close on failure.
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("IdePicker — interactions", () => {
  it("ArrowDown/ArrowUp cycles selection via aria-selected", async () => {
    // Keyboard nav contract: wraps around the list.
    setup();

    await waitFor(() => {
      expect(screen.getByText("Neovim")).toBeInTheDocument();
    });

    let options = screen.getAllByRole("option");
    expect(options[0]).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(document, { key: "ArrowDown" });
    options = screen.getAllByRole("option");
    expect(options[1]).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(document, { key: "ArrowDown" });
    options = screen.getAllByRole("option");
    expect(options[2]).toHaveAttribute("aria-selected", "true");

    // Wrap to first
    fireEvent.keyDown(document, { key: "ArrowDown" });
    options = screen.getAllByRole("option");
    expect(options[0]).toHaveAttribute("aria-selected", "true");

    // ArrowUp wraps back to last
    fireEvent.keyDown(document, { key: "ArrowUp" });
    options = screen.getAllByRole("option");
    expect(options[2]).toHaveAttribute("aria-selected", "true");
  });

  it("Enter triggers bindIde with the selected port, then onClose", async () => {
    // Enter on the best-match default selection should POST the bind and then close.
    mockBindIde.mockResolvedValue({ ok: true, binding: sampleBinding });
    const { onClose } = setup();

    await waitFor(() => {
      expect(screen.getByText("Neovim")).toBeInTheDocument();
    });

    fireEvent.keyDown(document, { key: "Enter" });

    await waitFor(() => {
      expect(mockBindIde).toHaveBeenCalledWith("sess-A", 50001);
    });
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });

  it("Escape closes the picker without calling bindIde", async () => {
    // Escape must be a pure dismissal — no side effects.
    const { onClose } = setup();

    await waitFor(() => {
      expect(screen.getByText("Neovim")).toBeInTheDocument();
    });

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    expect(mockBindIde).not.toHaveBeenCalled();
  });

  it("D disconnects when currentBinding is present (calls unbindIde then onClose)", async () => {
    // When a binding exists, the "D" shortcut is an explicit disconnect.
    mockUnbindIde.mockResolvedValue({ ok: true });
    const { onClose } = setup({ currentBinding: sampleBinding });

    await waitFor(() => {
      expect(screen.getByText("Neovim")).toBeInTheDocument();
    });

    fireEvent.keyDown(document, { key: "d" });

    await waitFor(() => {
      expect(mockUnbindIde).toHaveBeenCalledWith("sess-A");
    });
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });

  it("D is a no-op when no currentBinding is set", async () => {
    // Without a binding, D does nothing (unbindIde must not be called).
    setup({ currentBinding: null });

    await waitFor(() => {
      expect(screen.getByText("Neovim")).toBeInTheDocument();
    });

    fireEvent.keyDown(document, { key: "d" });
    // Give any async work a tick.
    await new Promise((r) => setTimeout(r, 10));
    expect(mockUnbindIde).not.toHaveBeenCalled();
  });

  it("Retry re-calls bindIde after a failed pick", async () => {
    // After failure, clicking Retry re-issues the bind with the same port.
    mockBindIde
      .mockResolvedValueOnce({ ok: false, error: "unknown port" })
      .mockResolvedValueOnce({ ok: true, binding: sampleBinding });
    const { onClose } = setup();

    await waitFor(() => {
      expect(screen.getByText("Neovim")).toBeInTheDocument();
    });

    // Fail first
    fireEvent.keyDown(document, { key: "Enter" });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /retry/i }));

    await waitFor(() => {
      expect(mockBindIde).toHaveBeenCalledTimes(2);
    });
    // Second call uses the same port.
    expect(mockBindIde.mock.calls[1]).toEqual(["sess-A", 50001]);
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });

  // Issue #11 (codex adversarial review): the prior test never mocked
  // `../store.js`, so a component that called bindIde AND ALSO mutated the
  // store via useStore.setState still passed. This version genuinely pins
  // the "IdePicker is store-free" contract by asserting on the mocked
  // store's setState / getState / subscribe / hook-call spies.
  it("does NOT touch the zustand store during a bind (store state flows only via session_update)", async () => {
    mockBindIde.mockResolvedValue({ ok: true, binding: sampleBinding });
    // Reset all store spies to make the assertion scoped to this test.
    setStateSpy.mockClear();
    getStateSpy.mockClear();
    subscribeSpy.mockClear();
    useStoreMock.mockClear();

    setup();
    await waitFor(() => {
      expect(screen.getByText("Neovim")).toBeInTheDocument();
    });

    // Trigger a bind via keyboard.
    fireEvent.keyDown(document, { key: "Enter" });
    await waitFor(() => {
      expect(mockBindIde).toHaveBeenCalledTimes(1);
    });

    // CRITICAL: none of the store surfaces should have been touched. If a
    // future refactor imports `useStore` in IdePicker and mutates via
    // setState (or even reads via a selector), one of these spies fires
    // and this test fails loudly. This is the real regression guard the
    // prior version lacked.
    expect(setStateSpy).not.toHaveBeenCalled();
    expect(getStateSpy).not.toHaveBeenCalled();
    expect(subscribeSpy).not.toHaveBeenCalled();
    expect(useStoreMock).not.toHaveBeenCalled();
  });

  // Issue #7 — the global Enter handler fires bindIde even when the user's
  // focus is on a button inside the dialog. Native button activation would
  // fire the button's onClick for Enter; the global handler should NOT
  // double-fire bindIde on top. Otherwise clicking Disconnect with keyboard
  // also triggers a bind against the currently-selected IDE — split-brain.
  //
  // We dispatch a real KeyboardEvent on `document` because that's where the
  // global listener in IdePicker is attached. The event.target is the
  // currently-focused element, which we simulate by setting
  // document.activeElement to the Disconnect button. On a correct guard the
  // handler early-returns; without the guard it calls pick() → bindIde.
  it("Enter while a <button> inside the dialog has focus does not trigger bindIde", async () => {
    mockBindIde.mockResolvedValue({ ok: true, binding: sampleBinding });
    mockUnbindIde.mockResolvedValue({ ok: true });
    setup({ currentBinding: sampleBinding });

    await waitFor(() => {
      expect(screen.getByText("Neovim")).toBeInTheDocument();
    });
    // Give effect-registered listeners and dep-re-registration a chance to
    // settle. Without this wait the test accidentally passes because the
    // global handler's latest ref hasn't re-attached.
    await new Promise((r) => setTimeout(r, 50));

    const disconnectBtn = screen.getByRole("button", {
      name: /disconnect/i,
    }) as HTMLButtonElement;
    disconnectBtn.focus();
    // Sanity check: jsdom actually moved focus (otherwise the test is moot).
    expect(document.activeElement).toBe(disconnectBtn);

    // Dispatch a native bubbling Enter at the focused button — in a real
    // browser this would (a) invoke the button's intrinsic click, AND
    // (b) hit the document-level keyhandler that IdePicker installs. The
    // BUG is that the document handler calls pick() → bindIde even though
    // the user's intent was to activate the button. The guard must
    // early-return when the focused target is a <button> inside the dialog.
    const ev = new KeyboardEvent("keydown", { key: "Enter", bubbles: true });
    disconnectBtn.dispatchEvent(ev);

    // Give async microtasks a chance to run.
    await new Promise((r) => setTimeout(r, 30));
    expect(mockBindIde).not.toHaveBeenCalled();
  });

  // Issue #8 (codex adversarial review refinement) — `busy` in setState is
  // a stale closure across same-tick dispatches. If the user taps Enter+D
  // within the same render tick, both callbacks observe busy=false because
  // React hasn't flushed the pending setBusy(true). Concurrent bind + disconnect
  // ship simultaneously. A useRef that flips BEFORE the async await is the
  // only reliable guard.
  it("Issue #8 (same-tick): Enter + D in the same tick do not fire both bindIde and unbindIde", async () => {
    // Hang both APIs so the first-in-tick op stays in-flight; if the guard
    // is stale-closure (setBusy only), the second dispatch will slip past.
    let _resolveBind: (v: unknown) => void = () => {};
    let _resolveUnbind: (v: unknown) => void = () => {};
    mockBindIde.mockImplementationOnce(() => new Promise((r) => { _resolveBind = r; }));
    mockUnbindIde.mockImplementationOnce(() => new Promise((r) => { _resolveUnbind = r; }));

    setup({ currentBinding: sampleBinding });

    await waitFor(() => {
      expect(screen.getByText("Neovim")).toBeInTheDocument();
    });

    // Fire Enter and D synchronously in the same tick — no await between.
    // In a stale-closure implementation, both handlers see busy=false.
    fireEvent.keyDown(document, { key: "Enter" });
    fireEvent.keyDown(document, { key: "d" });

    // Give microtasks a tick so the first-in-tick op has issued.
    await new Promise((r) => setTimeout(r, 10));

    // Exactly one of bindIde / unbindIde should have been called, NOT both.
    const totalCalls = mockBindIde.mock.calls.length + mockUnbindIde.mock.calls.length;
    expect(totalCalls, `expected exactly one of bind/unbind in the same tick, got ${totalCalls}`).toBe(1);

    // Clean up.
    _resolveBind({ ok: true, binding: sampleBinding });
    _resolveUnbind({ ok: true });
  });

  // Issue #8 — `busy` state is only checked on button onClick; the keyboard
  // handler bypasses it. If the user spams Enter while a bind is in-flight,
  // we issue multiple concurrent binds. Guard: keyboard Enter must early
  // return when `busy` is true.
  it("Enter is a no-op while a bind is in flight (busy-state guard applies to keyboard too)", async () => {
    // Make the first bindIde hang so `busy` stays true for the duration of
    // the test (we resolve it manually at the end).
    let resolveFirst: (v: unknown) => void = () => {};
    mockBindIde.mockImplementationOnce(
      () => new Promise((r) => { resolveFirst = r; }),
    );
    setup();

    await waitFor(() => {
      expect(screen.getByText("Neovim")).toBeInTheDocument();
    });

    // First Enter starts the bind (busy → true).
    fireEvent.keyDown(document, { key: "Enter" });
    await waitFor(() => {
      expect(mockBindIde).toHaveBeenCalledTimes(1);
    });

    // Second and third Enters while busy must be ignored.
    fireEvent.keyDown(document, { key: "Enter" });
    fireEvent.keyDown(document, { key: "Enter" });
    await new Promise((r) => setTimeout(r, 10));
    // Still only ONE bind in flight.
    expect(mockBindIde).toHaveBeenCalledTimes(1);

    // Clean up — resolve the pending bind so unmount doesn't leak.
    resolveFirst({ ok: true, binding: sampleBinding });
  });

  // Issue #9 — bind error and disconnect error share a single "Retry"
  // affordance whose onClick always calls the bind retry path. If a
  // disconnect fails and the user clicks Retry, the picker retries BIND
  // (not disconnect), which is the opposite of what the user asked for.
  // Fix: Retry must re-invoke the operation that failed.
  it("Retry after a failed disconnect re-calls unbindIde (not bindIde)", async () => {
    // First disconnect fails, second succeeds.
    mockUnbindIde
      .mockRejectedValueOnce(new Error("network error"))
      .mockResolvedValueOnce({ ok: true });
    const { onClose } = setup({ currentBinding: sampleBinding });

    await waitFor(() => {
      expect(screen.getByText("Neovim")).toBeInTheDocument();
    });

    // Trigger disconnect via D shortcut.
    fireEvent.keyDown(document, { key: "d" });

    // Wait for the failure to surface as an error/retry affordance.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    });

    // Clicking Retry must re-attempt the DISCONNECT, not a bind.
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /retry/i }));

    await waitFor(() => {
      expect(mockUnbindIde).toHaveBeenCalledTimes(2);
    });
    // Critically: bindIde must NOT have been called.
    expect(mockBindIde).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });

  // Issue #4 (cubic-ai PR #652 review): Retry after a disconnect failure
  // becomes a no-op when currentBinding turns null asynchronously. The
  // disconnect handler captures currentBinding in its useCallback closure.
  // When the IDE disconnects (causing currentBinding to become null via
  // session_update), the Retry button is still visible but clicking it
  // calls disconnect() which early-returns at `if (!currentBinding) return;`.
  // The user sees a persistent error with a non-functional Retry action.
  //
  // Fix: the retry handler for a disconnect must work even when
  // currentBinding has gone null between the failure and the retry click.
  it("Retry after a failed disconnect still works when currentBinding becomes null", async () => {
    // First disconnect fails.
    mockUnbindIde
      .mockRejectedValueOnce(new Error("network error"))
      .mockResolvedValueOnce({ ok: true });
    const { onClose, rerender } = setup({ currentBinding: sampleBinding });

    await waitFor(() => {
      expect(screen.getByText("Neovim")).toBeInTheDocument();
    });

    // Trigger disconnect via D shortcut.
    fireEvent.keyDown(document, { key: "d" });

    // Wait for the failure to surface as an error/retry affordance.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    });

    // Simulate the IDE disconnecting asynchronously: currentBinding becomes null.
    // This re-renders the component with currentBinding=null, updating the
    // disconnect callback's closure.
    rerender(
      <IdePicker
        sessionId="sess-A"
        cwd="/Users/me/areas/secreg"
        currentBinding={null}
        onClose={onClose}
      />,
    );

    // Clicking Retry must still re-attempt the DISCONNECT (unbindIde),
    // not silently no-op because currentBinding is now null.
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /retry/i }));

    await waitFor(() => {
      expect(mockUnbindIde).toHaveBeenCalledTimes(2);
    });
    // bindIde must NOT have been called.
    expect(mockBindIde).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });

  it("close button (×) triggers onClose without calling bindIde", async () => {
    // UX: an explicit close button is available for mouse users.
    const { onClose } = setup();

    await waitFor(() => {
      expect(screen.getByText("Neovim")).toBeInTheDocument();
    });
    const close = screen.getByRole("button", { name: /close/i });
    fireEvent.click(close);

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    expect(mockBindIde).not.toHaveBeenCalled();
  });

  it("clicking an option picks it (bindIde called with that option's port)", async () => {
    // Mouse users: clicking a non-default option should bind that port.
    mockBindIde.mockResolvedValue({ ok: true, binding: sampleBinding });
    setup();

    await waitFor(() => {
      expect(screen.getByText("Visual Studio Code")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    const options = screen.getAllByRole("option");
    await user.click(options[1]); // VS Code

    await waitFor(() => {
      expect(mockBindIde).toHaveBeenCalledWith("sess-A", 50002);
    });
  });
});

describe("IdePicker — accessibility across states", () => {
  // UI-02: unified axe scan across all five render states.
  // We parameterize to keep the contract concise — any state that fails axe
  // fails the suite.
  const states: Array<{
    name: string;
    setup: () => void;
    awaitText: RegExp | string;
  }> = [
    {
      name: "empty",
      setup: () => {
        mockGetAvailableIdes.mockResolvedValue([]);
        setup();
      },
      awaitText: /No IDE detected/i,
    },
    {
      name: "single",
      setup: () => {
        mockGetAvailableIdes.mockResolvedValue([idesMany[0]]);
        setup();
      },
      awaitText: "Neovim",
    },
    {
      name: "many with best match",
      setup: () => {
        setup();
      },
      awaitText: "Obsidian",
    },
    {
      name: "currently bound",
      setup: () => {
        setup({ currentBinding: sampleBinding });
      },
      awaitText: /disconnect/i,
    },
    {
      name: "bind failed",
      setup: () => {
        mockBindIde.mockResolvedValue({ ok: false, error: "unknown port" });
        setup();
      },
      awaitText: "Neovim",
    },
  ];

  for (const state of states) {
    it(`passes axe in the "${state.name}" state`, async () => {
      state.setup();
      await waitFor(() => {
        // waitFor wants a function that may throw; find / getBy does that.
        if (typeof state.awaitText === "string") {
          expect(screen.getByText(state.awaitText)).toBeInTheDocument();
        } else {
          expect(screen.getAllByText(state.awaitText).length).toBeGreaterThan(0);
        }
      });

      if (state.name === "bind failed") {
        // Trigger the failure path so the inline error is visible.
        fireEvent.keyDown(document, { key: "Enter" });
        await waitFor(() => {
          expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
        });
      }

      const { axe } = await import("vitest-axe");
      const dialog = screen.getByRole("dialog");
      const results = await axe(dialog);
      expect(results).toHaveNoViolations();
    });
  }
});

// ─── Task 12: live refresh on ide_list_changed ────────────────────────────────
//
// Contract: while an IdePicker is mounted, dispatching the global
// "companion:ide-list-changed" CustomEvent (emitted by ws.ts on receipt of
// `{type: "ide_list_changed"}` over the WS) must cause the component to
// refetch `getAvailableIdes(cwd)`. The subscription must be cleaned up on
// unmount — no refetch should occur after the picker closes.
describe("IdePicker — live refresh (Task 12)", () => {
  it("refetches the IDE list when a companion:ide-list-changed event fires", async () => {
    // Initial mount → one fetch. Dispatch the event → a second fetch.
    mockGetAvailableIdes.mockResolvedValue([idesMany[0]]);
    setup();

    await waitFor(() => {
      expect(mockGetAvailableIdes).toHaveBeenCalledTimes(1);
    });

    // Fire the event the way ws.ts does.
    window.dispatchEvent(new CustomEvent("companion:ide-list-changed"));

    await waitFor(() => {
      expect(mockGetAvailableIdes).toHaveBeenCalledTimes(2);
    });
    // Same cwd is passed on refetch. Second positional arg is the AbortSignal
    // threaded through per BRITTLE 1 — asserted separately in the
    // "aborts the prior in-flight request" test.
    const lastCall = mockGetAvailableIdes.mock.calls.at(-1)!;
    expect(lastCall[0]).toBe("/Users/me/areas/secreg");
  });

  // cubic-ai review (PR #652): concurrent loadList() calls can resolve out
  // of order. When `companion:ide-list-changed` fires rapidly (e.g. a batch
  // of fs.watch events), two fetches are in flight simultaneously. If the
  // FIRST (older, stale) request resolves AFTER the SECOND (newer, fresh)
  // request, the component state ends up displaying stale data.
  //
  // Fix: each loadList invocation captures an epoch token; a resolving
  // response only commits to state if its token still matches the latest.
  it("concurrent loadList: stale response is ignored when newer request has resolved", async () => {
    // Build two deferred promises so we can control resolution order.
    let resolveA!: (v: typeof idesMany) => void;
    let resolveB!: (v: typeof idesMany) => void;
    const promiseA = new Promise<typeof idesMany>((r) => {
      resolveA = r;
    });
    const promiseB = new Promise<typeof idesMany>((r) => {
      resolveB = r;
    });

    // Mount fires request A. Then fire the event to start request B.
    mockGetAvailableIdes.mockReturnValueOnce(promiseA);
    mockGetAvailableIdes.mockReturnValueOnce(promiseB);

    setup();
    await waitFor(() => {
      expect(mockGetAvailableIdes).toHaveBeenCalledTimes(1);
    });

    window.dispatchEvent(new CustomEvent("companion:ide-list-changed"));
    await waitFor(() => {
      expect(mockGetAvailableIdes).toHaveBeenCalledTimes(2);
    });

    // Resolve B (newer) first — it has only the Neovim entry.
    const bOnly = [idesMany[0]];
    resolveB(bOnly);
    await waitFor(() => {
      expect(screen.getByText("Neovim")).toBeInTheDocument();
    });
    // Sanity: the other entries from the "many" fixture are not yet
    // rendered — only B's single-item list is visible.
    expect(screen.queryByText("Visual Studio Code")).not.toBeInTheDocument();

    // Now resolve A (stale, older) with the larger list. Without the epoch
    // guard, A's state.setIdes would clobber B's already-committed state.
    resolveA(idesMany);

    // Give React a tick to react. The component must still render only
    // B's entry — A's response is dropped on the floor.
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByText("Neovim")).toBeInTheDocument();
    expect(screen.queryByText("Visual Studio Code")).not.toBeInTheDocument();
    expect(screen.queryByText("Obsidian")).not.toBeInTheDocument();
  });

  it("stale response doesn't overwrite newer state (explicit list count check)", async () => {
    // Inverse framing of the prior test: assert on list size rather than
    // specific labels so a future label change doesn't silently pass.
    let resolveA!: (v: typeof idesMany) => void;
    let resolveB!: (v: typeof idesMany) => void;
    const promiseA = new Promise<typeof idesMany>((r) => {
      resolveA = r;
    });
    const promiseB = new Promise<typeof idesMany>((r) => {
      resolveB = r;
    });

    mockGetAvailableIdes.mockReturnValueOnce(promiseA);
    mockGetAvailableIdes.mockReturnValueOnce(promiseB);

    setup();
    await waitFor(() => {
      expect(mockGetAvailableIdes).toHaveBeenCalledTimes(1);
    });
    window.dispatchEvent(new CustomEvent("companion:ide-list-changed"));
    await waitFor(() => {
      expect(mockGetAvailableIdes).toHaveBeenCalledTimes(2);
    });

    // B resolves with THREE entries (the full idesMany).
    resolveB(idesMany);
    await waitFor(() => {
      expect(screen.getAllByRole("option")).toHaveLength(3);
    });

    // A resolves with ONE entry. If stale-response handling were broken,
    // we'd see the listbox collapse to one option.
    resolveA([idesMany[0]]);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });

  it("stops listening after unmount — no refetch post-close", async () => {
    // Prevents a common subscription leak where stale pickers keep fetching.
    mockGetAvailableIdes.mockResolvedValue([idesMany[0]]);
    const { unmount } = setup();

    await waitFor(() => {
      expect(mockGetAvailableIdes).toHaveBeenCalledTimes(1);
    });

    unmount();
    window.dispatchEvent(new CustomEvent("companion:ide-list-changed"));

    // Give React a tick to do anything erroneous.
    await new Promise((r) => setTimeout(r, 20));
    expect(mockGetAvailableIdes).toHaveBeenCalledTimes(1);
  });

  // Codex adversarial review (BRITTLE 2): when the picker is closed while a
  // loadList request is still in flight, the epoch ref must be bumped during
  // cleanup so that the late-resolving response's token comparison fails and
  // no setState runs on the unmounted component. Without the bump, React logs
  // the "state update on unmounted component" warning and the rest of the
  // suite becomes noisy (and in strict mode, fails).
  //
  // Assertion strategy: spy on `console.error` and assert it's NOT called
  // with the React unmounted-setState warning after we resolve the pending
  // request post-unmount. This mirrors React's own test-suite pattern and
  // avoids fragile coupling to internal setState names.
  it("in-flight loadList response does not call setState after unmount (combined guard: aborted signal + no React warning)", async () => {
    // Build a deferred fetch so we can hold the mount-time request open,
    // unmount the component, THEN resolve — the classic unmount race.
    //
    // Codex adversarial review (BRITTLE 1 + BRITTLE 2): this test now pins
    // the invariant from TWO angles so it fails loudly if either layer
    // regresses:
    //   (a) The AbortController's signal passed to getAvailableIdes must be
    //       aborted after unmount — a direct behavioral assertion that the
    //       HTTP request is cancelled (BRITTLE 1). This assertion does NOT
    //       depend on React's warning machinery.
    //   (b) console.error must NOT be called with the React "setState on
    //       unmounted component" warning (BRITTLE 2 epoch-guard). Defensive
    //       second layer for responses that resolve between fetch() returning
    //       and the AbortError catch running.
    // Removing the `loadEpochRef.current++` cleanup OR the
    // `loadControllerRef.current?.abort()` cleanup will fail at least one of
    // these two assertions.
    let resolveFetch!: (v: typeof idesMany) => void;
    let capturedSignal: AbortSignal | undefined;
    const pendingFetch = new Promise<typeof idesMany>((r) => {
      resolveFetch = r;
    });
    mockGetAvailableIdes.mockImplementationOnce(
      (_cwd?: string, signal?: AbortSignal) => {
        capturedSignal = signal;
        return pendingFetch;
      },
    );

    // Spy BEFORE mount to capture any warnings the component emits.
    // React 18+ emits warnings via console.error.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { unmount } = setup();
    // Wait one tick so the mount-effect's loadList() is actually in-flight.
    await Promise.resolve();
    expect(mockGetAvailableIdes).toHaveBeenCalledTimes(1);
    // The api must receive a non-aborted AbortSignal pre-unmount.
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal?.aborted).toBe(false);

    // Unmount while the fetch is still pending. The cleanup MUST (a) abort
    // the controller AND (b) bump the epoch so any late resolver short-circuits.
    unmount();

    // Direct behavioral assertion (BRITTLE 1): the signal passed to the
    // api wrapper must now be aborted. This alone proves the HTTP request
    // was cancelled on unmount — no reliance on React warning text.
    expect(capturedSignal?.aborted).toBe(true);

    // Now resolve the long-hanging mount-time fetch. If the epoch guard is
    // missing, the resolver runs setIdes / setLoading on an unmounted
    // component and React logs a warning via console.error.
    resolveFetch(idesMany);
    // Give React microtasks + a macrotask to flush any pending warnings.
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 20));

    // Collect any React "unmounted component" warnings — format varies
    // slightly across versions, but all include the phrase "unmounted".
    const unmountedWarnings = errorSpy.mock.calls.filter((call) => {
      const msg = call.map((a) => String(a)).join(" ");
      return (
        msg.includes("unmounted component") ||
        msg.includes("Can't perform a React state update on an unmounted")
      );
    });
    try {
      expect(unmountedWarnings).toHaveLength(0);
    } finally {
      errorSpy.mockRestore();
    }
  });

  // Codex adversarial review (BRITTLE 1): a second loadList() must abort the
  // AbortController attached to the first. Without this, rapid
  // `companion:ide-list-changed` bursts spawn N concurrent HTTP requests,
  // only one of whose state updates is useful — the rest are dead weight on
  // the server and the client.
  it("concurrent loadList aborts the prior in-flight request's AbortSignal", async () => {
    // First call: capture its signal and hang.
    let firstSignal: AbortSignal | undefined;
    let resolveFirst!: (v: typeof idesMany) => void;
    const firstPending = new Promise<typeof idesMany>((r) => {
      resolveFirst = r;
    });
    // Second call: capture its signal and resolve normally.
    let secondSignal: AbortSignal | undefined;

    mockGetAvailableIdes.mockImplementationOnce(
      (_cwd?: string, signal?: AbortSignal) => {
        firstSignal = signal;
        return firstPending;
      },
    );
    mockGetAvailableIdes.mockImplementationOnce(
      (_cwd?: string, signal?: AbortSignal) => {
        secondSignal = signal;
        return Promise.resolve(idesMany);
      },
    );

    setup();
    await waitFor(() => {
      expect(mockGetAvailableIdes).toHaveBeenCalledTimes(1);
    });
    expect(firstSignal?.aborted).toBe(false);

    // Trigger a second loadList while the first is still pending.
    window.dispatchEvent(new CustomEvent("companion:ide-list-changed"));
    await waitFor(() => {
      expect(mockGetAvailableIdes).toHaveBeenCalledTimes(2);
    });

    // The prior (stale) request's signal must now be aborted — a brand-new
    // controller was created for the second call.
    expect(firstSignal?.aborted).toBe(true);
    // The second call's signal is fresh and still live.
    expect(secondSignal).toBeInstanceOf(AbortSignal);
    expect(secondSignal?.aborted).toBe(false);

    // Clean up: resolve the first so it doesn't leak. Its resolution is
    // harmless because the epoch guard + aborted signal both short-circuit.
    resolveFirst(idesMany);
  });
});
