// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

const mockSendToSession = vi.fn();

vi.mock("../ws.js", () => ({
  sendToSession: (...args: unknown[]) => mockSendToSession(...args),
}));

// Mock api so the per-session dynamic-models fetch doesn't hit the network in
// jsdom. Default: returns [] (= "no proxy / probe failed", component falls back
// to the hardcoded picker). Tests that exercise the dynamic path override
// the resolved value before mount.
const mockGetSessionModels = vi.fn(
  async (_sessionId: string) => [] as Array<{ value: string; label: string }>,
);
vi.mock("../api.js", () => ({
  api: {
    getSessionModels: (sessionId: string) => mockGetSessionModels(sessionId),
  },
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

    // CLAUDE_MODELS has multiple Opus variants (4.7, 4.6, 4.6 (1M)) — use exact
    // labels so the assertion stays unambiguous as new models are added.
    expect(screen.getByRole("option", { name: "Opus 4.7" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Opus 4.6" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Sonnet/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Haiku/ })).toBeInTheDocument();
  });

  it("marks the current model as selected", () => {
    render(<ModelSwitcher sessionId="s1" />);
    fireEvent.click(screen.getByLabelText("Switch model"));

    // Fixture model is claude-opus-4-6 → "Opus 4.6" must be the selected option.
    const opusOption = screen.getByRole("option", { name: "Opus 4.6" });
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
    // Re-click the currently-active option (Opus 4.6 per the fixture).
    fireEvent.click(screen.getByRole("option", { name: "Opus 4.6" }));

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

  // Dynamic picker: when /api/sessions/:id/models returns a non-empty list
  // (proxy session), the dropdown shows that list instead of CLAUDE_MODELS.
  // Verifies the fetch is wired to sessionId, the list propagates into the
  // dropdown, and the hardcoded picker is replaced (not appended).
  it("uses the dynamic model list returned by /sessions/:id/models when non-empty", async () => {
    mockGetSessionModels.mockResolvedValueOnce([
      { value: "proxy-model-a", label: "Proxy Model A" },
      { value: "proxy-model-b", label: "Proxy Model B" },
    ]);
    render(<ModelSwitcher sessionId="s1" />);
    // Allow the useEffect promise to settle so dynamicModels state lands
    // before we open the dropdown.
    await new Promise((r) => setTimeout(r, 0));
    fireEvent.click(screen.getByLabelText("Switch model"));
    expect(screen.getByText("Proxy Model A")).toBeInTheDocument();
    expect(screen.getByText("Proxy Model B")).toBeInTheDocument();
    // Hardcoded "Sonnet 4.6" is not present — dynamic list replaced the static one.
    expect(screen.queryByText("Sonnet 4.6")).not.toBeInTheDocument();
    expect(mockGetSessionModels).toHaveBeenCalledWith("s1");
  });

  // Failure / empty list: picker must remain functional with the hardcoded list.
  it("falls back to CLAUDE_MODELS when /sessions/:id/models returns empty", async () => {
    mockGetSessionModels.mockResolvedValueOnce([]);
    render(<ModelSwitcher sessionId="s1" />);
    await new Promise((r) => setTimeout(r, 0));
    fireEvent.click(screen.getByLabelText("Switch model"));
    // Hardcoded list is back — Opus/Sonnet labels present.
    expect(screen.getByText("Sonnet 4.6")).toBeInTheDocument();
  });

  it("falls back to CLAUDE_MODELS on api fetch error", async () => {
    mockGetSessionModels.mockRejectedValueOnce(new Error("network"));
    render(<ModelSwitcher sessionId="s1" />);
    await new Promise((r) => setTimeout(r, 0));
    fireEvent.click(screen.getByLabelText("Switch model"));
    expect(screen.getByText("Sonnet 4.6")).toBeInTheDocument();
  });
});
