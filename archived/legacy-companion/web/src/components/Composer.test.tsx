// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SessionState } from "../../server/session-types.js";

// Polyfill scrollIntoView for jsdom
Element.prototype.scrollIntoView = vi.fn();

const mockSendToSession = vi.fn();
const mockListPrompts = vi.fn();
const mockCreatePrompt = vi.fn();

// Build a controllable mock store state
let mockStoreState: Record<string, unknown> = {};

const mockReadFileAsBase64 = vi.fn();

vi.mock("../utils/image.js", () => ({
  readFileAsBase64: (...args: unknown[]) => mockReadFileAsBase64(...args),
}));

vi.mock("../ws.js", () => ({
  sendToSession: (...args: unknown[]) => mockSendToSession(...args),
  createClientMessageId: () => "test-client-msg-id",
}));

vi.mock("../api.js", () => ({
  api: {
    gitPull: vi.fn().mockResolvedValue({ success: true, output: "", git_ahead: 0, git_behind: 0 }),
    listPrompts: (...args: unknown[]) => mockListPrompts(...args),
    createPrompt: (...args: unknown[]) => mockCreatePrompt(...args),
  },
}));

// Mock useStore as a function that takes a selector
const mockAppendMessage = vi.fn();
const mockUpdateSession = vi.fn();
const mockSetPreviousPermissionMode = vi.fn();
const mockClearPromptSuggestions = vi.fn();

vi.mock("../store.js", () => {
  // Create a mock store function that acts like zustand's useStore
  const useStore = (selector: (state: Record<string, unknown>) => unknown) => {
    return selector(mockStoreState);
  };
  // Add getState for imperative access (used by Composer for appendMessage)
  useStore.getState = () => mockStoreState;
  return { useStore };
});

import { Composer } from "./Composer.js";

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    session_id: "s1",
    model: "claude-sonnet-4-6",
    cwd: "/test",
    tools: [],
    permissionMode: "acceptEdits",
    claude_code_version: "1.0",
    mcp_servers: [],
    agents: [],
    slash_commands: [],
    skills: [],
    total_cost_usd: 0,
    num_turns: 0,
    context_used_percent: 0,
    is_compacting: false,
    git_branch: "",
    is_worktree: false,
    is_containerized: false,
    repo_root: "",
    git_ahead: 0,
    git_behind: 0,
    total_lines_added: 0,
    total_lines_removed: 0,
    ...overrides,
  };
}

function setupMockStore(overrides: {
  isConnected?: boolean;
  sessionStatus?: "idle" | "running" | "compacting" | null;
  session?: Partial<SessionState>;
} = {}) {
  const {
    isConnected = true,
    sessionStatus = "idle",
    session = {},
  } = overrides;

  const sessionsMap = new Map<string, SessionState>();
  sessionsMap.set("s1", makeSession(session));

  const cliConnectedMap = new Map<string, boolean>();
  cliConnectedMap.set("s1", isConnected);

  const sessionStatusMap = new Map<string, "idle" | "running" | "compacting" | null>();
  sessionStatusMap.set("s1", sessionStatus);

  const previousPermissionModeMap = new Map<string, string>();
  previousPermissionModeMap.set("s1", "acceptEdits");

  mockStoreState = {
    sessions: sessionsMap,
    cliConnected: cliConnectedMap,
    sessionStatus: sessionStatusMap,
    previousPermissionMode: previousPermissionModeMap,
    sdkSessions: [{ sessionId: "s1", model: "claude-sonnet-4-6", backendType: "claude", cwd: "/test" }],
    sessionNames: new Map<string, string>(),
    appendMessage: mockAppendMessage,
    updateSession: mockUpdateSession,
    setPreviousPermissionMode: mockSetPreviousPermissionMode,
    setSdkSessions: vi.fn(),
    promptSuggestions: new Map<string, string[]>(),
    clearPromptSuggestions: mockClearPromptSuggestions,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockListPrompts.mockResolvedValue([]);
  mockCreatePrompt.mockResolvedValue({
    id: "p-new",
    name: "New Prompt",
    content: "Text",
    scope: "project",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  setupMockStore();
});

// ─── Basic rendering ────────────────────────────────────────────────────────

describe("Composer basic rendering", () => {
  it("renders textarea and send button", () => {
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea");
    expect(textarea).toBeTruthy();
    // Send button (the round one with the arrow SVG) - identified by title
    const sendBtn = screen.getAllByTitle("Send message")[0];
    expect(sendBtn).toBeTruthy();
  });
});

// ─── Send button disabled state ──────────────────────────────────────────────

describe("Composer send button state", () => {
  it("send button is disabled when text is empty", () => {
    render(<Composer sessionId="s1" />);
    const sendBtn = screen.getAllByTitle("Send message")[0];
    expect(sendBtn.hasAttribute("disabled")).toBe(true);
  });

  it("send button is disabled when CLI is not connected", () => {
    setupMockStore({ isConnected: false });
    render(<Composer sessionId="s1" />);
    const sendBtn = screen.getAllByTitle("Send message")[0];
    expect(sendBtn.hasAttribute("disabled")).toBe(true);
  });

  it("typing text enables the send button", async () => {
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.change(textarea, { target: { value: "Hello world" } });

    const sendBtn = screen.getAllByTitle("Send message")[0];
    expect(sendBtn.hasAttribute("disabled")).toBe(false);
  });
});

// ─── Sending messages ────────────────────────────────────────────────────────

describe("Composer sending messages", () => {
  it("pressing Enter sends the message via sendToSession", () => {
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.change(textarea, { target: { value: "test message" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    expect(mockSendToSession).toHaveBeenCalledWith("s1", expect.objectContaining({
      type: "user_message",
      content: "test message",
      session_id: "s1",
    }));
  });

  it("pressing Shift+Enter does NOT send the message", () => {
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.change(textarea, { target: { value: "line 1" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });

    expect(mockSendToSession).not.toHaveBeenCalled();
  });

  it("clicking the send button sends the message", () => {
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.change(textarea, { target: { value: "click send" } });
    fireEvent.click(screen.getAllByTitle("Send message")[0]);

    expect(mockSendToSession).toHaveBeenCalledWith("s1", expect.objectContaining({
      type: "user_message",
      content: "click send",
    }));
  });

  it("textarea is cleared after sending", () => {
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")! as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "to be cleared" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    expect(textarea.value).toBe("");
  });
});

describe("Composer prompt suggestion chips", () => {
  it("renders suggestion chips when prompt suggestions exist", () => {
    setupMockStore();
    (mockStoreState.promptSuggestions as Map<string, string[]>).set("s1", [
      "Explain this stack trace",
      "Draft a fix plan",
    ]);

    render(<Composer sessionId="s1" />);

    expect(screen.getByText("Explain this stack trace")).toBeTruthy();
    expect(screen.getByText("Draft a fix plan")).toBeTruthy();
  });

  it("clicking a suggestion sends it, appends an optimistic message, and clears suggestions", () => {
    setupMockStore();
    (mockStoreState.promptSuggestions as Map<string, string[]>).set("s1", [
      "Explain this stack trace",
    ]);

    render(<Composer sessionId="s1" />);
    fireEvent.click(screen.getByText("Explain this stack trace"));

    expect(mockSendToSession).toHaveBeenCalledWith("s1", {
      type: "user_message",
      content: "Explain this stack trace",
      session_id: "s1",
      client_msg_id: "test-client-msg-id",
    });
    expect(mockAppendMessage).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({
        id: "test-client-msg-id",
        role: "user",
        content: "Explain this stack trace",
      }),
    );
    expect(mockClearPromptSuggestions).toHaveBeenCalledWith("s1");
  });

  it("does not render suggestion chips when prompt suggestions are empty", () => {
    render(<Composer sessionId="s1" />);

    expect(screen.queryByText("Explain this stack trace")).toBeNull();
    expect(screen.queryByText("Draft a fix plan")).toBeNull();
  });

  it("does not send a suggestion when the composer is unavailable", () => {
    setupMockStore({ isConnected: false });
    (mockStoreState.promptSuggestions as Map<string, string[]>).set("s1", [
      "Explain this stack trace",
    ]);

    render(<Composer sessionId="s1" />);
    const chip = screen.getByText("Explain this stack trace") as HTMLButtonElement;

    expect(chip.disabled).toBe(true);
    fireEvent.click(chip);

    expect(mockSendToSession).not.toHaveBeenCalled();
    expect(mockAppendMessage).not.toHaveBeenCalled();
    expect(mockClearPromptSuggestions).not.toHaveBeenCalled();
  });
});

// ─── Plan mode toggle ────────────────────────────────────────────────────────

describe("Composer plan mode toggle", () => {
  it("pressing Shift+Tab toggles plan mode", () => {
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.keyDown(textarea, { key: "Tab", shiftKey: true });

    // Should call sendToSession to set plan mode
    expect(mockSendToSession).toHaveBeenCalledWith("s1", {
      type: "set_permission_mode",
      mode: "plan",
    });
  });
});

// ─── Interrupt button ────────────────────────────────────────────────────────

describe("Composer interrupt button", () => {
  it("interrupt button appears when session is running", () => {
    setupMockStore({ sessionStatus: "running" });
    render(<Composer sessionId="s1" />);

    const stopBtn = screen.getAllByTitle("Stop generation")[0];
    expect(stopBtn).toBeTruthy();
    // Send button should not be present (both mobile and desktop show stop)
    expect(screen.queryAllByTitle("Send message")).toHaveLength(0);
  });

  it("interrupt button sends interrupt message", () => {
    setupMockStore({ sessionStatus: "running" });
    render(<Composer sessionId="s1" />);

    fireEvent.click(screen.getAllByTitle("Stop generation")[0]);

    expect(mockSendToSession).toHaveBeenCalledWith("s1", { type: "interrupt" });
  });

  it("send button appears when session is idle", () => {
    setupMockStore({ sessionStatus: "idle" });
    render(<Composer sessionId="s1" />);

    expect(screen.getAllByTitle("Send message")[0]).toBeTruthy();
    expect(screen.queryAllByTitle("Stop generation")).toHaveLength(0);
  });
});

// ─── Slash menu ──────────────────────────────────────────────────────────────

describe("Composer slash menu", () => {
  it("slash menu opens when typing /", () => {
    setupMockStore({
      session: {
        slash_commands: ["help", "clear"],
        skills: ["commit"],
      },
    });
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.change(textarea, { target: { value: "/" } });

    // Commands should appear in the menu
    expect(screen.getByText("/help")).toBeTruthy();
    expect(screen.getByText("/clear")).toBeTruthy();
    expect(screen.getByText("/commit")).toBeTruthy();
  });

  it("slash commands are filtered as user types", () => {
    setupMockStore({
      session: {
        slash_commands: ["help", "clear"],
        skills: ["commit"],
      },
    });
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.change(textarea, { target: { value: "/cl" } });

    expect(screen.getByText("/clear")).toBeTruthy();
    expect(screen.queryByText("/help")).toBeNull();
    // "commit" does not match "cl" so it should not appear either
    expect(screen.queryByText("/commit")).toBeNull();
  });

  it("slash menu does not open when there are no commands", () => {
    setupMockStore({
      session: {
        slash_commands: [],
        skills: [],
      },
    });
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.change(textarea, { target: { value: "/" } });

    // No command items should appear
    expect(screen.queryByText("/help")).toBeNull();
  });

  it("slash menu shows command types", () => {
    setupMockStore({
      session: {
        slash_commands: ["help"],
        skills: ["commit"],
      },
    });
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.change(textarea, { target: { value: "/" } });

    // Each command should display its type
    expect(screen.getByText("command")).toBeTruthy();
    expect(screen.getByText("skill")).toBeTruthy();
  });
});

// ─── Disabled state ──────────────────────────────────────────────────────────

describe("Composer disabled state", () => {
  it("textarea is disabled when CLI is not connected", () => {
    setupMockStore({ isConnected: false });
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")! as HTMLTextAreaElement;

    expect(textarea.disabled).toBe(true);
  });

  it("textarea shows correct placeholder when connected", () => {
    setupMockStore({ isConnected: true });
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")! as HTMLTextAreaElement;

    expect(textarea.placeholder).toContain("Type a message");
  });

  it("textarea shows waiting placeholder when not connected", () => {
    setupMockStore({ isConnected: false });
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")! as HTMLTextAreaElement;

    expect(textarea.placeholder).toContain("Waiting for CLI connection");
  });
});

describe("Composer @ prompts menu", () => {
  it("opens @ menu and inserts selected prompt with Enter", async () => {
    // Validates keyboard insertion from @ suggestions without sending the message.
    mockListPrompts.mockResolvedValue([
      {
        id: "p1",
        name: "review-pr",
        content: "Review this PR and list risks.",
        scope: "global",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]);
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.change(textarea, { target: { value: "@rev", selectionStart: 4 } });
    await screen.findByText("@review-pr");
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    expect((textarea as HTMLTextAreaElement).value).toContain("Review this PR and list risks.");
    expect(mockSendToSession).not.toHaveBeenCalled();
  });

  it("filters prompts by typed query", async () => {
    // Validates fuzzy filtering by prompt name while typing after @.
    mockListPrompts.mockResolvedValue([
      {
        id: "p1",
        name: "review-pr",
        content: "Review this PR",
        scope: "global",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      {
        id: "p2",
        name: "write-tests",
        content: "Write tests",
        scope: "project",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]);
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.change(textarea, { target: { value: "@wri", selectionStart: 4 } });
    await screen.findByText("@write-tests");

    expect(screen.getByText("@write-tests")).toBeTruthy();
    expect(screen.queryByText("@review-pr")).toBeNull();
  });

  it("does not refetch prompts on each @ query keystroke", async () => {
    // Validates prompt fetch remains stable while filtering happens client-side.
    mockListPrompts.mockResolvedValue([
      {
        id: "p1",
        name: "review-pr",
        content: "Review this PR",
        scope: "global",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]);
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    await waitFor(() => {
      expect(mockListPrompts).toHaveBeenCalledTimes(1);
    });

    fireEvent.change(textarea, { target: { value: "@r", selectionStart: 2 } });
    await screen.findByText("@review-pr");
    fireEvent.change(textarea, { target: { value: "@re", selectionStart: 3 } });
    await screen.findByText("@review-pr");
    fireEvent.change(textarea, { target: { value: "@rev", selectionStart: 4 } });
    await screen.findByText("@review-pr");

    expect(mockListPrompts).toHaveBeenCalledTimes(1);
  });
});

// ─── Keyboard navigation ────────────────────────────────────────────────────

describe("Composer keyboard navigation", () => {
  it("Escape in the slash menu does not send a message", () => {
    // Verifies pressing Escape while the slash menu is open does not trigger
    // a message send — the key event should be consumed by the menu handler.
    setupMockStore({
      session: {
        slash_commands: ["help", "clear"],
        skills: [],
      },
    });
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.change(textarea, { target: { value: "/" } });
    expect(screen.getByText("/help")).toBeTruthy();

    fireEvent.keyDown(textarea, { key: "Escape" });

    // Escape should NOT send any message
    expect(mockSendToSession).not.toHaveBeenCalled();
    // The text should still be "/" (not cleared)
    expect((textarea as HTMLTextAreaElement).value).toBe("/");
  });

  it("ArrowDown/ArrowUp cycles through slash menu items", () => {
    // Verifies keyboard arrow navigation within the slash command menu.
    setupMockStore({
      session: {
        slash_commands: ["help", "clear"],
        skills: [],
      },
    });
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.change(textarea, { target: { value: "/" } });
    // First item should be highlighted by default (index 0)
    const items = screen.getAllByRole("button").filter(
      (btn) => btn.textContent?.startsWith("/"),
    );
    expect(items.length).toBeGreaterThanOrEqual(2);

    // Arrow down should move selection — pressing Enter selects the item
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    fireEvent.keyDown(textarea, { key: "Enter" });

    // The selected command should replace the textarea content
    expect((textarea as HTMLTextAreaElement).value).toContain("/clear");
  });

  it("Enter selects the highlighted slash command", () => {
    // Verifies that pressing Enter in the slash menu selects the command
    // without sending it as a message.
    setupMockStore({
      session: {
        slash_commands: ["help"],
        skills: [],
      },
    });
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.change(textarea, { target: { value: "/" } });
    expect(screen.getByText("/help")).toBeTruthy();

    fireEvent.keyDown(textarea, { key: "Enter" });
    // Should NOT send a WebSocket message — it should just fill the command
    expect(mockSendToSession).not.toHaveBeenCalled();
  });
});

// ─── Layout & overflow ──────────────────────────────────────────────────────

describe("Composer layout", () => {
  it("textarea has overflow-y-auto to handle long content", () => {
    // Verifies the textarea scrolls vertically rather than expanding infinitely.
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;
    expect(textarea.className).toContain("overflow-y-auto");
  });

  it("send button has consistent dimensions", () => {
    // Verifies the send button has explicit sizing classes for consistent layout.
    // Both mobile (w-10 h-10) and desktop (w-9 h-9) send buttons exist in JSDOM.
    render(<Composer sessionId="s1" />);
    const sendBtns = screen.getAllByTitle("Send message");
    expect(sendBtns.length).toBeGreaterThanOrEqual(1);
    // At least one button should have explicit width/height classes
    const hasSize = sendBtns.some((btn) => btn.className.includes("w-"));
    expect(hasSize).toBe(true);
  });

  it("textarea is full-width within its container", () => {
    // Verifies the textarea stretches to fill the input area.
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;
    expect(textarea.className).toContain("w-full");
  });
});

describe("Composer save prompt", () => {
  it("shows save error when create prompt fails", async () => {
    // Validates API failures are visible to the user instead of being silently ignored.
    mockCreatePrompt.mockRejectedValue(new Error("Could not save prompt right now"));
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.change(textarea, { target: { value: "Prompt body text" } });
    // Mobile + desktop layouts render separate buttons; click the first visible one.
    fireEvent.click(screen.getAllByTitle("Save as prompt")[0]);
    const titleInput = screen.getByPlaceholderText("Prompt title");
    fireEvent.change(titleInput, { target: { value: "My Prompt" } });
    fireEvent.click(screen.getByText("Save"));

    expect(await screen.findByText("Could not save prompt right now")).toBeTruthy();
  });

  it("renders scope buttons in save prompt modal", async () => {
    // Validates the Global / This project scope selector is visible in the save prompt modal.
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;
    fireEvent.change(textarea, { target: { value: "Some text" } });
    fireEvent.click(screen.getAllByTitle("Save as prompt")[0]);

    expect(screen.getByText("Global")).toBeTruthy();
    expect(screen.getByText("This project")).toBeTruthy();
  });

  it("saves project-scoped prompt with session cwd", async () => {
    // Validates that selecting "This project" sends projectPaths with the session cwd.
    mockCreatePrompt.mockResolvedValue({ id: "p1", name: "test", content: "body", scope: "project", projectPaths: ["/test"] });
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;
    fireEvent.change(textarea, { target: { value: "Prompt body" } });
    fireEvent.click(screen.getAllByTitle("Save as prompt")[0]);
    fireEvent.change(screen.getByPlaceholderText("Prompt title"), { target: { value: "My Prompt" } });

    // Switch to project scope
    fireEvent.click(screen.getByText("This project"));
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => {
      expect(mockCreatePrompt).toHaveBeenCalledWith({
        name: "My Prompt",
        content: "Prompt body",
        scope: "project",
        projectPaths: ["/test"],
      });
    });
  });

  it("shows error when saving project-scoped prompt without cwd", async () => {
    // Validates that an informative error is shown when cwd is not available.
    setupMockStore({ isConnected: true, session: { cwd: "" } });
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;
    fireEvent.change(textarea, { target: { value: "Prompt body" } });
    fireEvent.click(screen.getAllByTitle("Save as prompt")[0]);
    fireEvent.change(screen.getByPlaceholderText("Prompt title"), { target: { value: "My Prompt" } });

    fireEvent.click(screen.getByText("This project"));
    fireEvent.click(screen.getByText("Save"));

    expect(await screen.findByText("No project folder available for this session")).toBeTruthy();
    expect(mockCreatePrompt).not.toHaveBeenCalled();
  });

  it("shows cwd path when project scope selected", () => {
    // Validates the cwd is displayed below the scope selector in project mode.
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;
    fireEvent.change(textarea, { target: { value: "Prompt body" } });
    fireEvent.click(screen.getAllByTitle("Save as prompt")[0]);
    fireEvent.click(screen.getByText("This project"));

    expect(screen.getByText("/test")).toBeTruthy();
  });

  it("cancel button closes save prompt modal and resets scope", () => {
    // Validates the cancel button resets state.
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;
    fireEvent.change(textarea, { target: { value: "Prompt body" } });
    fireEvent.click(screen.getAllByTitle("Save as prompt")[0]);
    fireEvent.click(screen.getByText("This project"));
    fireEvent.click(screen.getByText("Cancel"));

    // Modal should be closed
    expect(screen.queryByText("Save prompt")).toBeFalsy();
  });

  it("clears error when typing in prompt title", () => {
    // Validates that typing in the title input clears a previous error.
    setupMockStore({ isConnected: true, session: { cwd: "" } });
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;
    fireEvent.change(textarea, { target: { value: "body" } });
    fireEvent.click(screen.getAllByTitle("Save as prompt")[0]);
    fireEvent.change(screen.getByPlaceholderText("Prompt title"), { target: { value: "title" } });
    fireEvent.click(screen.getByText("This project"));
    fireEvent.click(screen.getByText("Save"));

    // Error should appear
    expect(screen.getByText("No project folder available for this session")).toBeTruthy();

    // Typing should clear the error
    fireEvent.change(screen.getByPlaceholderText("Prompt title"), { target: { value: "title2" } });
    expect(screen.queryByText("No project folder available for this session")).toBeFalsy();
  });

  it("can toggle scope back to global after selecting project", () => {
    // Validates clicking Global button after selecting "This project" resets scope.
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;
    fireEvent.change(textarea, { target: { value: "body" } });
    fireEvent.click(screen.getAllByTitle("Save as prompt")[0]);

    // Select project, then switch back to global
    fireEvent.click(screen.getByText("This project"));
    expect(screen.getByText("/test")).toBeTruthy();
    fireEvent.click(screen.getByText("Global"));

    // cwd should no longer be shown
    expect(screen.queryByText("/test")).toBeFalsy();
  });

  it("passes axe accessibility checks", async () => {
    const { axe } = await import("vitest-axe");
    setupMockStore({ isConnected: true });
    const { container } = render(<Composer sessionId="s1" />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});

// ─── Toolbar interactions ────────────────────────────────────────────────────

describe("Composer toolbar interactions", () => {
  it("mobile upload image button triggers file input", () => {
    // Validates the mobile upload image button opens the file picker via hidden input.
    const { container } = render(<Composer sessionId="s1" />);
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const clickSpy = vi.spyOn(fileInput, "click");
    // There are two upload image buttons (mobile + desktop); click the one titled "Upload image" (mobile)
    const uploadBtn = screen.getByTitle("Upload image");
    fireEvent.click(uploadBtn);
    expect(clickSpy).toHaveBeenCalled();
  });

  it("desktop attach image button triggers file input", () => {
    // Validates the desktop attach image button opens the file picker via hidden input.
    const { container } = render(<Composer sessionId="s1" />);
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const clickSpy = vi.spyOn(fileInput, "click");
    const attachBtn = screen.getByTitle("Attach image");
    fireEvent.click(attachBtn);
    expect(clickSpy).toHaveBeenCalled();
  });

  it("desktop save prompt button opens save modal with default name", () => {
    // Validates clicking the desktop bookmark icon opens save modal and pre-fills name.
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;
    fireEvent.change(textarea, { target: { value: "My prompt text" } });

    // The second "Save as prompt" button is the desktop one
    const saveButtons = screen.getAllByTitle("Save as prompt");
    fireEvent.click(saveButtons[saveButtons.length - 1]);

    expect(screen.getByText("Save prompt")).toBeTruthy();
    const titleInput = screen.getByPlaceholderText("Prompt title") as HTMLInputElement;
    expect(titleInput.value).toBe("My prompt text");
  });

  it("mode toggle button triggers plan mode on desktop", () => {
    // Validates clicking the mode toggle button on desktop activates plan mode.
    render(<Composer sessionId="s1" />);
    // Mode toggle buttons have title "Toggle mode (Shift+Tab)"
    const modeButtons = screen.getAllByTitle("Toggle mode (Shift+Tab)");
    // Click a mode button to enter plan mode
    fireEvent.click(modeButtons[0]);
    expect(mockSendToSession).toHaveBeenCalledWith("s1", { type: "set_permission_mode", mode: "plan" });
  });

  it("mode toggle restores previous mode when already in plan mode", () => {
    // Validates toggling off plan mode restores the previous permission mode.
    setupMockStore({ session: { permissionMode: "plan" } });
    render(<Composer sessionId="s1" />);
    const modeButtons = screen.getAllByTitle("Toggle mode (Shift+Tab)");
    fireEvent.click(modeButtons[0]);
    expect(mockSendToSession).toHaveBeenCalledWith("s1", { type: "set_permission_mode", mode: "acceptEdits" });
  });

  it("mobile send button dispatches message when text is entered", () => {
    // Validates the mobile send button (w-10 h-10) can send messages.
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;
    fireEvent.change(textarea, { target: { value: "Mobile message" } });

    // There are two send buttons; both should work. Click the first one (mobile).
    const sendBtns = screen.getAllByTitle("Send message");
    fireEvent.click(sendBtns[0]);
    expect(mockSendToSession).toHaveBeenCalledWith("s1", expect.objectContaining({
      type: "user_message",
      content: "Mobile message",
    }));
  });

  it("clicking a slash command item selects it", () => {
    // Validates clicking a command in the slash menu fills the textarea.
    setupMockStore({ session: { slash_commands: ["help", "clear"], skills: [] } });
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.change(textarea, { target: { value: "/" } });
    // Click the "/clear" button in the menu
    const clearBtn = screen.getByText("/clear").closest("button")!;
    fireEvent.click(clearBtn);
    expect((textarea as HTMLTextAreaElement).value).toContain("/clear");
  });

  it("slash menu closes when text no longer starts with /", () => {
    // Validates the slash menu auto-closes when text changes away from slash prefix.
    setupMockStore({ session: { slash_commands: ["help"], skills: [] } });
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.change(textarea, { target: { value: "/" } });
    expect(screen.getByText("/help")).toBeTruthy();

    // Change to non-slash text — menu should close
    fireEvent.change(textarea, { target: { value: "hello" } });
    expect(screen.queryByText("/help")).toBeFalsy();
  });
});

// ─── Image attachment ────────────────────────────────────────────────────────

describe("Composer image attachment", () => {
  it("file input adds image thumbnails and remove button works", async () => {
    // Validates the file select handler processes images and renders thumbnails.
    mockReadFileAsBase64.mockResolvedValue({ base64: "abc123", mediaType: "image/png" });
    const { container } = render(<Composer sessionId="s1" />);
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;

    // Simulate selecting an image file
    const file = new File(["img"], "test.png", { type: "image/png" });
    Object.defineProperty(fileInput, "files", { value: [file], writable: false });
    fireEvent.change(fileInput);

    // Wait for async readFileAsBase64 to complete
    await waitFor(() => {
      expect(screen.getByAltText("test.png")).toBeTruthy();
    });

    // Remove the image
    fireEvent.click(screen.getByLabelText("Remove image"));
    expect(screen.queryByAltText("test.png")).toBeFalsy();
  });
});
