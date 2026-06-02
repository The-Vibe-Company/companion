// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

const mockSendToSession = vi.fn();

vi.mock("../ws.js", () => ({
  sendToSession: (...args: unknown[]) => mockSendToSession(...args),
}));

interface MockStoreState {
  sdkSessions: { sessionId: string; model?: string; backendType?: string; cwd: string }[];
  cliConnected: Map<string, boolean>;
  sessions: Map<string, { model?: string; backend_type?: string }>;
}

let storeState: MockStoreState;

function resetStore(overrides: Partial<MockStoreState> = {}) {
  storeState = {
    sdkSessions: [
      { sessionId: "s1", model: "claude-opus-4-6", backendType: "claude", cwd: "/repo" },
    ],
    cliConnected: new Map([["s1", true]]),
    sessions: new Map([["s1", { model: "claude-opus-4-6" }]]),
    ...overrides,
  };
}

// Track setSdkSessions calls for optimistic update verification
const mockSetSdkSessions = vi.fn();

vi.mock("../store.js", () => ({
  useStore: Object.assign(
    (selector: (s: MockStoreState) => unknown) => selector(storeState),
    {
      getState: () => ({
        ...storeState,
        setSdkSessions: mockSetSdkSessions,
      }),
    },
  ),
}));

import { ModelSwitcher } from "./ModelSwitcher.js";

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
});

describe("ModelSwitcher", () => {
  it("renders current model icon and label", () => {
    render(<ModelSwitcher sessionId="s1" />);
    // Opus label with version
    expect(screen.getByText("Opus 4.6")).toBeInTheDocument();
    expect(screen.getByLabelText("Switch model")).toBeInTheDocument();
  });

  it("opens dropdown on click and shows all Claude models", () => {
    render(<ModelSwitcher sessionId="s1" />);
    fireEvent.click(screen.getByLabelText("Switch model"));

    // All three Claude models should appear as options
    expect(screen.getByRole("option", { name: /Opus/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Sonnet/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Haiku/ })).toBeInTheDocument();
  });

  it("marks the current model as selected", () => {
    render(<ModelSwitcher sessionId="s1" />);
    fireEvent.click(screen.getByLabelText("Switch model"));

    const opusOption = screen.getByRole("option", { name: /Opus/ });
    expect(opusOption).toHaveAttribute("aria-selected", "true");

    const sonnetOption = screen.getByRole("option", { name: /Sonnet/ });
    expect(sonnetOption).toHaveAttribute("aria-selected", "false");
  });

  it("sends set_model via WebSocket on selection", () => {
    render(<ModelSwitcher sessionId="s1" />);
    fireEvent.click(screen.getByLabelText("Switch model"));
    fireEvent.click(screen.getByRole("option", { name: /Sonnet/ }));

    expect(mockSendToSession).toHaveBeenCalledWith("s1", {
      type: "set_model",
      model: "claude-sonnet-4-6",
    });
  });

  it("optimistically updates the store after selection", () => {
    render(<ModelSwitcher sessionId="s1" />);
    fireEvent.click(screen.getByLabelText("Switch model"));
    fireEvent.click(screen.getByRole("option", { name: /Sonnet/ }));

    expect(mockSetSdkSessions).toHaveBeenCalledOnce();
    const updatedSessions = mockSetSdkSessions.mock.calls[0][0];
    expect(updatedSessions[0].model).toBe("claude-sonnet-4-6");
  });

  it("does not send when selecting the already-active model", () => {
    render(<ModelSwitcher sessionId="s1" />);
    fireEvent.click(screen.getByLabelText("Switch model"));
    fireEvent.click(screen.getByRole("option", { name: /Opus/ }));

    // Same model — no WS message, no store update
    expect(mockSendToSession).not.toHaveBeenCalled();
    expect(mockSetSdkSessions).not.toHaveBeenCalled();
  });

  it("closes dropdown on Escape key", () => {
    render(<ModelSwitcher sessionId="s1" />);
    fireEvent.click(screen.getByLabelText("Switch model"));
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("closes dropdown on click outside", () => {
    render(<ModelSwitcher sessionId="s1" />);
    fireEvent.click(screen.getByLabelText("Switch model"));
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    // Click outside the component
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("is hidden when backend is Codex", () => {
    // Codex does not support runtime model switching
    resetStore({
      sdkSessions: [
        { sessionId: "s1", model: "gpt-5.3-codex", backendType: "codex", cwd: "/repo" },
      ],
    });
    const { container } = render(<ModelSwitcher sessionId="s1" />);
    expect(container.innerHTML).toBe("");
  });

  it("is hidden when CLI is not connected", () => {
    // Can't switch model without a live CLI connection
    resetStore({ cliConnected: new Map([["s1", false]]) });
    const { container } = render(<ModelSwitcher sessionId="s1" />);
    expect(container.innerHTML).toBe("");
  });

  it("is hidden when session has no model set", () => {
    resetStore({
      sdkSessions: [{ sessionId: "s1", backendType: "claude", cwd: "/repo" }],
      sessions: new Map([["s1", {}]]),
    });
    const { container } = render(<ModelSwitcher sessionId="s1" />);
    expect(container.innerHTML).toBe("");
  });

  it("shows raw model string for unrecognized models", () => {
    // Custom/unknown model — should still render with a fallback
    resetStore({
      sdkSessions: [
        { sessionId: "s1", model: "claude-custom-model", backendType: "claude", cwd: "/repo" },
      ],
      sessions: new Map([["s1", { model: "claude-custom-model" }]]),
    });
    render(<ModelSwitcher sessionId="s1" />);
    expect(screen.getByText("claude-custom-model")).toBeInTheDocument();
  });

  it("passes axe accessibility checks", async () => {
    const { axe } = await import("vitest-axe");
    render(<ModelSwitcher sessionId="s1" />);
    const results = await axe(document.body);
    expect(results).toHaveNoViolations();
  });

  it("passes axe checks with dropdown open", async () => {
    // Scope axe to the component container to avoid the "region" landmark rule
    // which fires because the component renders outside a <main>/<header> in isolation.
    const { axe } = await import("vitest-axe");
    const { container } = render(<ModelSwitcher sessionId="s1" />);
    fireEvent.click(screen.getByLabelText("Switch model"));
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
