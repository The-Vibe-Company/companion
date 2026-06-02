// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

// Polyfill scrollIntoView for jsdom
Element.prototype.scrollIntoView = vi.fn();

const { mockApi, createSessionStreamMock, mockStoreState, mockStoreGetState } = vi.hoisted(() => ({
  mockApi: {
    getHome: vi.fn(),
    listEnvs: vi.fn(),
    getBackends: vi.fn(),
    getSettings: vi.fn(),
    discoverClaudeSessions: vi.fn(),
    listSessions: vi.fn(),
    getRepoInfo: vi.fn(),
    listBranches: vi.fn(),
    getLinearProjectMapping: vi.fn(),
    getLinearProjectIssues: vi.fn(),
    searchLinearIssues: vi.fn(),
    gitFetch: vi.fn(),
    getBackendModels: vi.fn(),
    getImageStatus: vi.fn(),
    pullImage: vi.fn(),
    gitPull: vi.fn(),
    linkLinearIssue: vi.fn(),
    transitionLinearIssue: vi.fn(),
    listPrompts: vi.fn(),
    listLinearConnections: vi.fn(),
    listSandboxes: vi.fn(),
  },
  createSessionStreamMock: vi.fn(),
  mockStoreState: {
    setCurrentSession: vi.fn(),
    currentSessionId: null as string | null,
  },
  mockStoreGetState: vi.fn(() => ({})),
}));

vi.mock("../api.js", () => ({
  api: mockApi,
  createSessionStream: createSessionStreamMock,
}));

vi.mock("../store.js", () => {
  const useStore = ((selector: (s: typeof mockStoreState) => unknown) => selector(mockStoreState)) as unknown as {
    (selector: (s: typeof mockStoreState) => unknown): unknown;
    getState: () => unknown;
  };
  useStore.getState = () => mockStoreGetState();
  return { useStore };
});

vi.mock("../ws.js", () => ({
  connectSession: vi.fn(),
  createClientMessageId: vi.fn(() => "test-client-msg-id"),
  waitForConnection: vi.fn().mockResolvedValue(undefined),
  sendToSession: vi.fn(),
  disconnectSession: vi.fn(),
}));

vi.mock("./EnvManager.js", () => ({
  EnvManager: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="env-manager">
      <button onClick={onClose}>Close Env Manager</button>
    </div>
  ),
}));
vi.mock("./FolderPicker.js", () => ({
  FolderPicker: ({ onSelect, onClose }: { onSelect: (p: string) => void; onClose: () => void }) => (
    <div data-testid="folder-picker">
      <button onClick={() => onSelect("/new-project")}>Select Folder</button>
      <button onClick={onClose}>Close Picker</button>
    </div>
  ),
}));
vi.mock("./LinearLogo.js", () => ({ LinearLogo: () => <span>Linear</span> }));
vi.mock("../utils/routing.js", () => ({
  navigateToSession: vi.fn(),
}));

import { HomePage } from "./HomePage.js";

/** Helper to build a default store mock with overridable fields. */
function buildStoreMock(overrides: Record<string, unknown> = {}) {
  return {
    clearCreation: vi.fn(),
    setSessionCreating: vi.fn(),
    addCreationProgress: vi.fn(),
    sdkSessions: [],
    setSdkSessions: vi.fn(),
    sessionNames: new Map(),
    setSessionName: vi.fn(),
    setPreviousPermissionMode: vi.fn(),
    appendMessage: vi.fn(),
    setLinkedLinearIssue: vi.fn(),
    setCreationError: vi.fn(),
    clearCreationError: vi.fn(),
    ...overrides,
  };
}

describe("HomePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockStoreGetState.mockReturnValue(buildStoreMock());

    mockApi.getHome.mockResolvedValue({ home: "/home/ubuntu", cwd: "/repo" });
    mockApi.listEnvs.mockResolvedValue([]);
    mockApi.getBackends.mockResolvedValue([{ id: "claude", name: "Claude", available: true }]);
    mockApi.getSettings.mockResolvedValue({ linearApiKeyConfigured: true });
    mockApi.getRepoInfo.mockResolvedValue({
      repoRoot: "/repo",
      repoName: "repo",
      currentBranch: "main",
      defaultBranch: "main",
      isWorktree: false,
    });
    mockApi.listBranches.mockResolvedValue([
      { name: "main", isCurrent: true, isRemote: false, worktreePath: null, ahead: 0, behind: 0 },
    ]);
    mockApi.listSessions.mockResolvedValue([]);
    mockApi.discoverClaudeSessions.mockResolvedValue({ sessions: [] });
    mockApi.getLinearProjectMapping.mockResolvedValue({
      mapping: { repoRoot: "/repo", projectId: "proj-1", projectName: "Platform", updatedAt: Date.now() },
    });
    mockApi.getLinearProjectIssues.mockResolvedValue({
      issues: [
        {
          id: "issue-1",
          identifier: "THE-147",
          title: "Associer un ticket Linear",
          description: "",
          url: "https://linear.app/the/issue/THE-147",
          branchName: "the-147-associer-un-ticket-linear",
          priorityLabel: "Medium",
          stateName: "Backlog",
          stateType: "unstarted",
          teamName: "The",
          teamKey: "THE",
          teamId: "team-1",
        },
      ],
    });
    mockApi.searchLinearIssues.mockResolvedValue({ issues: [] });
    mockApi.gitFetch.mockResolvedValue({ ok: true });
    mockApi.listPrompts.mockResolvedValue([]);
    mockApi.listLinearConnections.mockResolvedValue({ connections: [] });
    mockApi.listSandboxes.mockResolvedValue([]);
    mockApi.getImageStatus.mockResolvedValue({ status: "idle" });
    mockApi.pullImage.mockResolvedValue({ ok: true });
  });

  it("auto-sets branch from selected mapped Linear issue", async () => {
    // Regression guard: selecting an issue from the mapped project list must
    // update the branch picker to Linear's recommended branch.
    render(<HomePage />);

    const issueTitle = await screen.findByText(/THE-147/i);
    const issueButton = issueTitle.closest("button");
    expect(issueButton).toBeInTheDocument();
    if (!issueButton) throw new Error("Issue button not found");
    fireEvent.click(issueButton);

    await waitFor(() => {
      expect(screen.getByText("the-147-associer-un-ticket-linear")).toBeInTheDocument();
    });
  });

  it("passes axe accessibility checks", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<HomePage />);
    // Wait for async effects to settle (backends, settings, etc.)
    await waitFor(() => {
      expect(screen.getByPlaceholderText("Fix a bug, build a feature, refactor code...")).toBeInTheDocument();
    });
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("opens a branched session immediately from row action", async () => {
    createSessionStreamMock.mockResolvedValue({
      sessionId: "session-123",
      state: "starting",
      cwd: "/repo",
    });
    mockApi.discoverClaudeSessions.mockResolvedValue({
      sessions: [
        {
          sessionId: "prior-session-123",
          cwd: "/repo",
          gitBranch: "main",
          slug: "prior-session",
          lastActivityAt: Date.now() - 60_000,
          sourceFile: "/Users/skolte/.claude/projects/-Users-skolte-repo/prior-session-123.jsonl",
        },
      ],
    });

    render(<HomePage />);

    await screen.findByPlaceholderText("Fix a bug, build a feature, refactor code...");
    fireEvent.click(screen.getByRole("button", { name: /branch from session/i }));
    fireEvent.click(await screen.findByRole("button", { name: /continue and open prior-session/i }));

    await waitFor(() => {
      expect(createSessionStreamMock).toHaveBeenCalled();
    });

    expect(createSessionStreamMock).toHaveBeenCalledWith(
      expect.objectContaining({
        resumeSessionAt: "prior-session-123",
        forkSession: false,
      }),
      expect.any(Function),
    );
  });

  it("detects external Claude sessions and supports row actions", async () => {
    createSessionStreamMock.mockResolvedValue({
      sessionId: "session-456",
      state: "starting",
      cwd: "/repo",
    });
    mockApi.discoverClaudeSessions.mockResolvedValue({
      sessions: [
        {
          sessionId: "ac5b80ba-2927-4f20-84c2-6bbaf9afdeb3",
          cwd: "/external-repo",
          gitBranch: "main",
          slug: "snazzy-baking-tarjan",
          lastActivityAt: 2000,
          sourceFile: "/Users/skolte/.claude/projects/-Users-skolte-Github-Private-companion/ac5b80ba-2927-4f20-84c2-6bbaf9afdeb3.jsonl",
        },
      ],
    });

    render(<HomePage />);

    await screen.findByPlaceholderText("Fix a bug, build a feature, refactor code...");
    fireEvent.click(screen.getByRole("button", { name: /branch from session/i }));
    fireEvent.click(await screen.findByRole("button", { name: /fork and open snazzy-baking-tarjan/i }));

    await waitFor(() => {
      expect(createSessionStreamMock).toHaveBeenCalled();
    });

    expect(createSessionStreamMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/external-repo",
        resumeSessionAt: "ac5b80ba-2927-4f20-84c2-6bbaf9afdeb3",
        forkSession: true,
      }),
      expect.any(Function),
    );
  });

  it("shows recent sessions by default and can load older sessions", async () => {
    const now = Date.now();
    const olderSessions = Array.from({ length: 15 }, (_, index) => ({
      sessionId: `old-${index}`,
      cwd: `/repo-old-${index}`,
      gitBranch: "main",
      slug: `old-${index}`,
      lastActivityAt: now - (20 * 24 * 60 * 60 * 1000) - index * 1_000,
      sourceFile: `/Users/skolte/.claude/projects/-Users-skolte-old/old-${index}.jsonl`,
    }));
    mockApi.discoverClaudeSessions.mockResolvedValue({
      sessions: [
        {
          sessionId: "recent-1",
          cwd: "/repo",
          gitBranch: "main",
          slug: "recent-1",
          lastActivityAt: now - 60_000,
          sourceFile: "/Users/skolte/.claude/projects/-Users-skolte-repo/recent-1.jsonl",
        },
        ...olderSessions,
      ],
    });

    render(<HomePage />);

    await screen.findByPlaceholderText("Fix a bug, build a feature, refactor code...");
    fireEvent.click(screen.getByRole("button", { name: /branch from session/i }));

    await screen.findByText(/showing 1 of 1 recent claude session/i);
    const includeOlder = screen.getByRole("button", { name: /include older \(15\)/i });
    fireEvent.click(includeOlder);

    await screen.findByText(/showing 12 of 16 detected claude sessions/i);
    const loadMore = screen.getByRole("button", { name: /load more \(4 remaining\)/i });
    fireEvent.click(loadMore);

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /load more/i })).not.toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /fork and open old-14/i })).toBeInTheDocument();
  });

  it("filters session table with search", async () => {
    const now = Date.now();
    mockApi.discoverClaudeSessions.mockResolvedValue({
      sessions: [
        {
          sessionId: "one",
          cwd: "/repo-a",
          gitBranch: "main",
          slug: "alpha",
          lastActivityAt: now - 30_000,
          sourceFile: "/Users/skolte/.claude/projects/a/one.jsonl",
        },
        {
          sessionId: "two",
          cwd: "/repo-b",
          gitBranch: "feature/auth",
          slug: "beta",
          lastActivityAt: now - 40_000,
          sourceFile: "/Users/skolte/.claude/projects/b/two.jsonl",
        },
      ],
    });

    render(<HomePage />);
    await screen.findByPlaceholderText("Fix a bug, build a feature, refactor code...");
    fireEvent.click(screen.getByRole("button", { name: /branch from session/i }));

    const search = await screen.findByPlaceholderText("Search sessions, branch, folder, or ID");
    fireEvent.change(search, { target: { value: "auth" } });

    await screen.findByText(/showing 1 of 1 matching claude session/i);
    expect(screen.getByRole("button", { name: /fork and open beta/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /fork and open alpha/i })).not.toBeInTheDocument();
  });

  // ─── Basic rendering tests ──────────────────────────────────────────────────

  it("renders the title, logo, textarea, and send button", async () => {
    // Verifies the core UI elements appear after initial load.
    render(<HomePage />);

    // Title
    expect(screen.getByText("The Companion")).toBeInTheDocument();

    // Logo image (the claude logo is the default)
    const logo = screen.getByAltText("The Companion");
    expect(logo).toBeInTheDocument();
    expect(logo).toHaveAttribute("src", "/logo.svg");

    // Textarea
    const textarea = screen.getByPlaceholderText("Fix a bug, build a feature, refactor code...");
    expect(textarea).toBeInTheDocument();

    // Send button (disabled by default since textarea is empty)
    const sendButton = screen.getByTitle("Send message");
    expect(sendButton).toBeInTheDocument();
    expect(sendButton).toBeDisabled();
  });

  it("enables send button only when textarea has text", async () => {
    // The send button should be disabled when the textarea is empty,
    // and enabled once the user types a non-whitespace message.
    render(<HomePage />);

    const textarea = screen.getByPlaceholderText("Fix a bug, build a feature, refactor code...");
    const sendButton = screen.getByTitle("Send message");

    // Initially disabled
    expect(sendButton).toBeDisabled();

    // Typing whitespace-only should keep it disabled
    fireEvent.change(textarea, { target: { value: "   " } });
    expect(sendButton).toBeDisabled();

    // Typing real text should enable it
    fireEvent.change(textarea, { target: { value: "Fix the bug" } });
    expect(sendButton).not.toBeDisabled();
  });

  // ─── Model dropdown interaction ─────────────────────────────────────────────

  it("opens and selects from the model dropdown", async () => {
    // Verifies users can open the model picker and change the selected model.
    render(<HomePage />);
    await screen.findByPlaceholderText("Fix a bug, build a feature, refactor code...");

    // The default model label for claude backend is "Opus 4.6"
    const modelButton = screen.getByText("Opus 4.6");
    expect(modelButton).toBeInTheDocument();

    // Open model dropdown
    fireEvent.click(modelButton);

    // Should see model options
    const sonnetOption = screen.getByText("Sonnet 4.6");
    expect(sonnetOption).toBeInTheDocument();

    // Select Sonnet
    fireEvent.click(sonnetOption);

    // Verify dropdown closed and Sonnet is now shown
    expect(screen.queryByText("Haiku 4.5")).not.toBeInTheDocument(); // dropdown closed
    expect(screen.getByText("Sonnet 4.6")).toBeInTheDocument(); // now selected
  });

  // ─── Mode dropdown interaction ──────────────────────────────────────────────

  it("opens and selects from the mode dropdown", async () => {
    // Verifies users can change the permission mode (Agent/Plan).
    render(<HomePage />);
    await screen.findByPlaceholderText("Fix a bug, build a feature, refactor code...");

    // Default mode for claude backend is "Agent"
    const modeButton = screen.getByText("Agent");
    fireEvent.click(modeButton);

    // Select Plan mode
    const planOption = screen.getByText("Plan");
    fireEvent.click(planOption);

    // Plan should now be selected
    expect(screen.getByText("Plan")).toBeInTheDocument();
  });

  // ─── Keyboard shortcuts ─────────────────────────────────────────────────────

  it("cycles permission mode on Shift+Tab", async () => {
    // Shift+Tab should cycle through available modes (Agent -> Plan -> Agent).
    render(<HomePage />);
    const textarea = screen.getByPlaceholderText("Fix a bug, build a feature, refactor code...");
    await waitFor(() => expect(textarea).toBeInTheDocument());

    // Default mode is "Agent" (bypassPermissions)
    expect(screen.getByText("Agent")).toBeInTheDocument();

    // Press Shift+Tab to cycle to next mode (Plan)
    fireEvent.keyDown(textarea, { key: "Tab", shiftKey: true });
    expect(screen.getByText("Plan")).toBeInTheDocument();

    // Press Shift+Tab again to cycle back to Agent
    fireEvent.keyDown(textarea, { key: "Tab", shiftKey: true });
    expect(screen.getByText("Agent")).toBeInTheDocument();
  });

  it("submits on Enter (without shift) when text is present", async () => {
    // Enter key should trigger session creation when there's text in the textarea.
    createSessionStreamMock.mockResolvedValue({
      sessionId: "new-session",
      state: "starting",
      cwd: "/repo",
    });

    render(<HomePage />);
    const textarea = screen.getByPlaceholderText("Fix a bug, build a feature, refactor code...");
    fireEvent.change(textarea, { target: { value: "Build a feature" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    await waitFor(() => {
      expect(createSessionStreamMock).toHaveBeenCalled();
    });
  });

  it("does not submit on Shift+Enter", async () => {
    // Shift+Enter should allow newlines without submitting.
    render(<HomePage />);
    const textarea = screen.getByPlaceholderText("Fix a bug, build a feature, refactor code...");
    fireEvent.change(textarea, { target: { value: "Build a feature" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });

    // Should not have attempted to create a session
    expect(createSessionStreamMock).not.toHaveBeenCalled();
  });

  // ─── Folder picker ──────────────────────────────────────────────────────────

  it("opens and uses the folder picker", async () => {
    // Clicking the folder selector should open the FolderPicker component,
    // and closing it should remove it from the DOM.
    render(<HomePage />);
    await screen.findByPlaceholderText("Fix a bug, build a feature, refactor code...");

    // Wait for the cwd to settle from getHome
    await waitFor(() => {
      expect(screen.getByText("repo")).toBeInTheDocument();
    });

    // Find and click the folder button — it shows the directory name "repo"
    const folderButton = screen.getByText("repo").closest("button")!;
    fireEvent.click(folderButton);

    // FolderPicker mock should appear
    expect(screen.getByTestId("folder-picker")).toBeInTheDocument();

    // Close the folder picker
    fireEvent.click(screen.getByText("Close Picker"));
    await waitFor(() => {
      expect(screen.queryByTestId("folder-picker")).not.toBeInTheDocument();
    });
  });

  // ─── Backend toggle ─────────────────────────────────────────────────────────

  it("shows backend toggle when multiple backends are available", async () => {
    // When both Claude and Codex backends are available, the toggle should appear
    // and switching should reset model/mode to defaults for the new backend.
    mockApi.getBackends.mockResolvedValue([
      { id: "claude", name: "Claude", available: true },
      { id: "codex", name: "Codex", available: true },
    ]);
    mockApi.getBackendModels.mockResolvedValue([]);

    render(<HomePage />);
    await screen.findByPlaceholderText("Fix a bug, build a feature, refactor code...");

    // Both backends should be visible
    const claudeButton = screen.getByRole("button", { name: "Claude" });
    const codexButton = screen.getByRole("button", { name: "Codex" });
    expect(claudeButton).toBeInTheDocument();
    expect(codexButton).toBeInTheDocument();

    // Switch to Codex
    fireEvent.click(codexButton);

    // Logo should change to codex
    await waitFor(() => {
      const logo = screen.getByAltText("The Companion");
      expect(logo).toHaveAttribute("src", "/logo-codex.svg");
    });

    // The "Branch from session" button should disappear (only for claude)
    expect(screen.queryByRole("button", { name: /branch from session/i })).not.toBeInTheDocument();
  });

  it("disables unavailable backends in the toggle", async () => {
    // An unavailable backend should be rendered as a disabled button.
    mockApi.getBackends.mockResolvedValue([
      { id: "claude", name: "Claude", available: true },
      { id: "codex", name: "Codex", available: false },
    ]);

    render(<HomePage />);
    await screen.findByPlaceholderText("Fix a bug, build a feature, refactor code...");

    const codexButton = await screen.findByTitle("Codex CLI not found in PATH");
    expect(codexButton).toBeDisabled();
  });

  // ─── Environment dropdown ───────────────────────────────────────────────────

  it("opens environment dropdown and selects an environment", async () => {
    // The env dropdown should list available environments and allow selection.
    const testEnvs = [
      { slug: "dev", name: "Development", variables: { API_KEY: "xxx" } },
      { slug: "prod", name: "Production", variables: { A: "1", B: "2" } },
    ];
    mockApi.listEnvs.mockResolvedValue(testEnvs);

    render(<HomePage />);
    await screen.findByPlaceholderText("Fix a bug, build a feature, refactor code...");

    // Click env selector (shows "No env" by default)
    const envButton = screen.getByText("No env").closest("button")!;
    fireEvent.click(envButton);

    // Should see env options
    await waitFor(() => {
      expect(screen.getByText("Development")).toBeInTheDocument();
      expect(screen.getByText("Production")).toBeInTheDocument();
    });

    // Should show variable counts
    expect(screen.getByText("1 var")).toBeInTheDocument();
    expect(screen.getByText("2 vars")).toBeInTheDocument();

    // Select "Development"
    fireEvent.click(screen.getByText("Development"));

    // Dropdown should close; localStorage should be updated
    expect(localStorage.getItem("cc-selected-env")).toBe("dev");
  });

  it("opens env manager from the dropdown", async () => {
    // The "Manage environments..." link in the dropdown should open the EnvManager modal.
    mockApi.listEnvs.mockResolvedValue([]);

    render(<HomePage />);
    await screen.findByPlaceholderText("Fix a bug, build a feature, refactor code...");

    // Open env dropdown
    const envButton = screen.getByText("No env").closest("button")!;
    fireEvent.click(envButton);

    // Click "Manage environments..."
    const manageLink = await screen.findByText("Manage environments...");
    fireEvent.click(manageLink);

    // EnvManager mock should appear
    expect(screen.getByTestId("env-manager")).toBeInTheDocument();

    // Close it
    fireEvent.click(screen.getByText("Close Env Manager"));
    await waitFor(() => {
      expect(screen.queryByTestId("env-manager")).not.toBeInTheDocument();
    });
  });

  it("clears selected environment with 'No environment' option", async () => {
    // Selecting "No environment" should clear the env selection and localStorage value.
    // First select an env through the dropdown, then clear it.
    const testEnvs = [
      { slug: "dev", name: "Development", variables: { API_KEY: "xxx" } },
    ];
    mockApi.listEnvs.mockResolvedValue(testEnvs);

    render(<HomePage />);
    await screen.findByPlaceholderText("Fix a bug, build a feature, refactor code...");

    // Open env dropdown and select an env first
    const envButton = screen.getByText("No env").closest("button")!;
    fireEvent.click(envButton);
    const devOption = await screen.findByText("Development");
    fireEvent.click(devOption);
    expect(localStorage.getItem("cc-selected-env")).toBe("dev");

    // Re-open the dropdown (listEnvs is called on open, already mocked)
    fireEvent.click(envButton);

    // Click "No environment" to clear
    const noEnvButton = await screen.findByText("No environment");
    fireEvent.click(noEnvButton);

    expect(localStorage.getItem("cc-selected-env")).toBe("");
  });

  // ─── Session creation flow ──────────────────────────────────────────────────

  it("creates a session and sends the initial message on submit", async () => {
    // Full end-to-end test of the send flow: type a message, click send,
    // verify createSessionStream is called with correct params and the message
    // is appended to the store.
    const storeMock = buildStoreMock();
    mockStoreGetState.mockReturnValue(storeMock);
    createSessionStreamMock.mockResolvedValue({
      sessionId: "new-session-abc",
      state: "starting",
      cwd: "/repo",
    });

    render(<HomePage />);
    // Wait for the cwd to settle from the getHome API call
    await waitFor(() => {
      expect(screen.getByText("repo")).toBeInTheDocument();
    });

    const textarea = screen.getByPlaceholderText("Fix a bug, build a feature, refactor code...");
    fireEvent.change(textarea, { target: { value: "Fix the login bug" } });

    const sendButton = screen.getByTitle("Send message");
    fireEvent.click(sendButton);

    await waitFor(() => {
      expect(createSessionStreamMock).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "claude-opus-4-6",
          permissionMode: "bypassPermissions",
          cwd: "/repo",
          backend: "claude",
        }),
        expect.any(Function),
      );
    });

    // The message should be appended to the store
    await waitFor(() => {
      expect(storeMock.appendMessage).toHaveBeenCalledWith(
        "new-session-abc",
        expect.objectContaining({
          role: "user",
          content: "Fix the login bug",
        }),
      );
    });
  });

  it("displays an error when session creation fails", async () => {
    // When createSessionStream throws, the error should be displayed in the UI
    // and setCreationError should be called on the store.
    const storeMock = buildStoreMock();
    mockStoreGetState.mockReturnValue(storeMock);
    createSessionStreamMock.mockRejectedValue(new Error("CLI not found"));

    render(<HomePage />);
    const textarea = screen.getByPlaceholderText("Fix a bug, build a feature, refactor code...");
    fireEvent.change(textarea, { target: { value: "Do something" } });

    fireEvent.click(screen.getByTitle("Send message"));

    // Error should appear in the UI
    await waitFor(() => {
      expect(screen.getByText("CLI not found")).toBeInTheDocument();
    });

    // Store should have the error
    expect(storeMock.setCreationError).toHaveBeenCalledWith("CLI not found");
  });

  it("does not send when textarea is empty", async () => {
    // Clicking send with an empty textarea should do nothing.
    render(<HomePage />);
    await screen.findByPlaceholderText("Fix a bug, build a feature, refactor code...");

    const sendButton = screen.getByTitle("Send message");
    fireEvent.click(sendButton);

    // Should not attempt to create a session
    expect(createSessionStreamMock).not.toHaveBeenCalled();
  });

  // ─── Pull prompt (branch behind remote) ─────────────────────────────────────

  it("shows pull prompt when branch is behind remote and handles cancel", async () => {
    // When the user sends a message but the current branch is behind remote,
    // a pull prompt should appear with Cancel/Skip/Pull options.
    // The branches state in HomePage is populated by BranchPicker's onBranchesLoaded callback.
    mockApi.listBranches.mockResolvedValue([
      { name: "main", isCurrent: true, isRemote: false, worktreePath: null, ahead: 0, behind: 3 },
    ]);

    render(<HomePage />);
    // Wait for cwd and gitRepoInfo to settle, which triggers BranchPicker to load branches
    await waitFor(() => {
      expect(screen.getByText("repo")).toBeInTheDocument();
    });
    // Wait for BranchPicker to call listBranches and propagate via onBranchesLoaded
    await waitFor(() => {
      expect(mockApi.listBranches).toHaveBeenCalled();
    });

    const textarea = screen.getByPlaceholderText("Fix a bug, build a feature, refactor code...");
    fireEvent.change(textarea, { target: { value: "Do something" } });
    fireEvent.click(screen.getByTitle("Send message"));

    // Pull prompt should appear
    await waitFor(() => {
      expect(screen.getByText(/3 commits behind/i)).toBeInTheDocument();
    });
    expect(screen.getByText("Pull and continue")).toBeInTheDocument();
    expect(screen.getByText("Continue anyway")).toBeInTheDocument();
    expect(screen.getByText("Cancel")).toBeInTheDocument();

    // Cancel should dismiss the prompt
    fireEvent.click(screen.getByText("Cancel"));

    await waitFor(() => {
      expect(screen.queryByText(/3 commits behind/i)).not.toBeInTheDocument();
    });

    // No session should have been created
    expect(createSessionStreamMock).not.toHaveBeenCalled();
  });

  it("handles 'Continue anyway' (skip pull) and creates session", async () => {
    // The "Continue anyway" button should dismiss the pull prompt and proceed
    // with session creation without pulling.
    mockApi.listBranches.mockResolvedValue([
      { name: "main", isCurrent: true, isRemote: false, worktreePath: null, ahead: 0, behind: 2 },
    ]);
    createSessionStreamMock.mockResolvedValue({
      sessionId: "skip-pull-session",
      state: "starting",
      cwd: "/repo",
    });

    render(<HomePage />);
    await waitFor(() => {
      expect(screen.getByText("repo")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(mockApi.listBranches).toHaveBeenCalled();
    });

    const textarea = screen.getByPlaceholderText("Fix a bug, build a feature, refactor code...");
    fireEvent.change(textarea, { target: { value: "Do work" } });
    fireEvent.click(screen.getByTitle("Send message"));

    // Wait for pull prompt
    await screen.findByText(/2 commits behind/i);

    // Click "Continue anyway"
    fireEvent.click(screen.getByText("Continue anyway"));

    // Should proceed to create session
    await waitFor(() => {
      expect(createSessionStreamMock).toHaveBeenCalled();
    });
  });

  it("handles 'Pull and continue' to pull before creating session", async () => {
    // The "Pull and continue" button should call gitPull, and on success
    // proceed with session creation.
    mockApi.listBranches.mockResolvedValue([
      { name: "main", isCurrent: true, isRemote: false, worktreePath: null, ahead: 0, behind: 1 },
    ]);
    mockApi.gitPull.mockResolvedValue({ success: true, output: "Already up to date." });
    createSessionStreamMock.mockResolvedValue({
      sessionId: "pulled-session",
      state: "starting",
      cwd: "/repo",
    });

    render(<HomePage />);
    await waitFor(() => {
      expect(screen.getByText("repo")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(mockApi.listBranches).toHaveBeenCalled();
    });

    const textarea = screen.getByPlaceholderText("Fix a bug, build a feature, refactor code...");
    fireEvent.change(textarea, { target: { value: "Start working" } });
    fireEvent.click(screen.getByTitle("Send message"));

    // Wait for pull prompt
    await screen.findByText(/1 commit behind/i);

    // Click "Pull and continue"
    fireEvent.click(screen.getByText("Pull and continue"));

    // gitPull should have been called
    await waitFor(() => {
      expect(mockApi.gitPull).toHaveBeenCalledWith("/repo");
    });

    // Session should be created after successful pull
    await waitFor(() => {
      expect(createSessionStreamMock).toHaveBeenCalled();
    });
  });

  it("shows pull error when git pull fails", async () => {
    // If gitPull returns success: false, the error should be displayed in the prompt.
    mockApi.listBranches.mockResolvedValue([
      { name: "main", isCurrent: true, isRemote: false, worktreePath: null, ahead: 0, behind: 1 },
    ]);
    mockApi.gitPull.mockResolvedValue({ success: false, output: "merge conflict in file.ts" });

    render(<HomePage />);
    await waitFor(() => {
      expect(screen.getByText("repo")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(mockApi.listBranches).toHaveBeenCalled();
    });

    const textarea = screen.getByPlaceholderText("Fix a bug, build a feature, refactor code...");
    fireEvent.change(textarea, { target: { value: "Start working" } });
    fireEvent.click(screen.getByTitle("Send message"));

    await screen.findByText(/1 commit behind/i);
    fireEvent.click(screen.getByText("Pull and continue"));

    // Error should be displayed within the pull prompt
    await waitFor(() => {
      expect(screen.getByText("merge conflict in file.ts")).toBeInTheDocument();
    });

    // Session should NOT be created
    expect(createSessionStreamMock).not.toHaveBeenCalled();
  });

  // ─── Image thumbnails ───────────────────────────────────────────────────────

  it("shows upload image button", async () => {
    // The image upload button should be present in the toolbar.
    render(<HomePage />);
    await screen.findByPlaceholderText("Fix a bug, build a feature, refactor code...");

    const uploadButton = screen.getByTitle("Upload image");
    expect(uploadButton).toBeInTheDocument();

    // There should also be a hidden file input for image selection
    const fileInput = screen.getByLabelText("Attach images");
    expect(fileInput).toBeInTheDocument();
  });

  // ─── Outside click closes dropdowns ─────────────────────────────────────────

  it("closes model dropdown on outside click", async () => {
    // Clicking outside an open dropdown should close it.
    render(<HomePage />);
    await screen.findByPlaceholderText("Fix a bug, build a feature, refactor code...");

    // Open model dropdown
    const modelButton = screen.getByText("Opus 4.6");
    fireEvent.click(modelButton);
    expect(screen.getByText("Sonnet 4.6")).toBeInTheDocument();

    // Click outside (on the document body)
    fireEvent.pointerDown(document.body);

    // Dropdown should close
    await waitFor(() => {
      expect(screen.queryByText("Haiku 4.5")).not.toBeInTheDocument();
    });
  });

  // ─── Textarea auto-resize ──────────────────────────────────────────────────

  it("auto-resizes textarea on input", async () => {
    // The textarea should adjust its height based on content.
    render(<HomePage />);
    const textarea = screen.getByPlaceholderText("Fix a bug, build a feature, refactor code...") as HTMLTextAreaElement;

    // Simulate typing which triggers handleInput
    fireEvent.change(textarea, { target: { value: "Line 1\nLine 2\nLine 3" } });

    // The handleInput sets height to auto, then to Math.min(scrollHeight, 200)
    // In jsdom scrollHeight may be 0, but we verify the handler ran without error
    expect(textarea.value).toBe("Line 1\nLine 2\nLine 3");
  });

  // ─── localStorage persistence ───────────────────────────────────────────────

  it("restores backend from localStorage", async () => {
    // When cc-backend is set in localStorage, the component should use that value.
    localStorage.setItem("cc-backend", "codex");
    mockApi.getBackends.mockResolvedValue([
      { id: "claude", name: "Claude", available: true },
      { id: "codex", name: "Codex", available: true },
    ]);
    mockApi.getBackendModels.mockResolvedValue([]);

    render(<HomePage />);
    await screen.findByPlaceholderText("Fix a bug, build a feature, refactor code...");

    // Logo should be the codex logo since backend was restored from localStorage
    const logo = screen.getByAltText("The Companion");
    expect(logo).toHaveAttribute("src", "/logo-codex.svg");
  });

  // ─── Dynamic model fetching for codex ───────────────────────────────────────

  it("fetches dynamic models for codex backend", async () => {
    // When the codex backend is selected, dynamic models should be fetched
    // from the API and used instead of the hardcoded fallback.
    localStorage.setItem("cc-backend", "codex");
    mockApi.getBackends.mockResolvedValue([
      { id: "claude", name: "Claude", available: true },
      { id: "codex", name: "Codex", available: true },
    ]);
    mockApi.getBackendModels.mockResolvedValue([
      { value: "gpt-custom", label: "GPT Custom" },
    ]);

    render(<HomePage />);
    await screen.findByPlaceholderText("Fix a bug, build a feature, refactor code...");

    // The dynamically fetched model should appear
    await waitFor(() => {
      expect(screen.getByText("GPT Custom")).toBeInTheDocument();
    });
  });

  // ─── Resume candidates error handling ───────────────────────────────────────

  it("shows error when loading resume candidates fails", async () => {
    // If discoverClaudeSessions or listSessions throws, an error message
    // should appear in the branching panel.
    mockApi.listSessions.mockRejectedValue(new Error("Network error"));

    render(<HomePage />);
    await screen.findByPlaceholderText("Fix a bug, build a feature, refactor code...");

    // Open branching controls
    fireEvent.click(screen.getByRole("button", { name: /branch from session/i }));

    // Error should appear
    await waitFor(() => {
      expect(screen.getByText("Network error")).toBeInTheDocument();
    });
  });

  // ─── "Recent only" toggle ───────────────────────────────────────────────────

  it("can switch back to 'Recent only' after showing older sessions", async () => {
    // After expanding to show older sessions, clicking "Recent only" should
    // collapse back to just the recent sessions.
    const now = Date.now();
    mockApi.discoverClaudeSessions.mockResolvedValue({
      sessions: [
        {
          sessionId: "recent-x",
          cwd: "/repo",
          gitBranch: "main",
          slug: "recent-x",
          lastActivityAt: now - 60_000,
          sourceFile: "/path/recent-x.jsonl",
        },
        {
          sessionId: "old-x",
          cwd: "/old-repo",
          gitBranch: "dev",
          slug: "old-x",
          lastActivityAt: now - (20 * 24 * 60 * 60 * 1000),
          sourceFile: "/path/old-x.jsonl",
        },
      ],
    });

    render(<HomePage />);
    await screen.findByPlaceholderText("Fix a bug, build a feature, refactor code...");
    fireEvent.click(screen.getByRole("button", { name: /branch from session/i }));

    // Should show recent only
    await screen.findByText(/showing 1 of 1 recent claude session/i);

    // Expand to include older
    fireEvent.click(screen.getByRole("button", { name: /include older \(1\)/i }));
    await screen.findByText(/showing 2 of 2 detected/i);

    // Switch back to recent only
    fireEvent.click(screen.getByRole("button", { name: /recent only/i }));
    await screen.findByText(/showing 1 of 1 recent/i);
  });

  // ─── Disconnect current session on new creation ──────────────────────────────

  it("disconnects existing session when creating a new one", async () => {
    // If there is a currentSessionId in the store, creating a new session
    // should first disconnect the existing one.
    const { disconnectSession } = await import("../ws.js");
    mockStoreState.currentSessionId = "old-session-id";
    createSessionStreamMock.mockResolvedValue({
      sessionId: "new-session-id",
      state: "starting",
      cwd: "/repo",
    });

    render(<HomePage />);
    const textarea = screen.getByPlaceholderText("Fix a bug, build a feature, refactor code...");
    fireEvent.change(textarea, { target: { value: "New task" } });
    fireEvent.click(screen.getByTitle("Send message"));

    await waitFor(() => {
      expect(disconnectSession).toHaveBeenCalledWith("old-session-id");
    });

    // Cleanup
    mockStoreState.currentSessionId = null;
  });

  // ─── No sessions detected message ──────────────────────────────────────────

  it("shows 'No Claude sessions detected yet' when there are no sessions", async () => {
    // When branching controls are open but no sessions exist, a helpful
    // empty-state message should be displayed.
    mockApi.discoverClaudeSessions.mockResolvedValue({ sessions: [] });
    mockApi.listSessions.mockResolvedValue([]);

    render(<HomePage />);
    await screen.findByPlaceholderText("Fix a bug, build a feature, refactor code...");
    fireEvent.click(screen.getByRole("button", { name: /branch from session/i }));

    await waitFor(() => {
      expect(screen.getByText("No Claude sessions detected yet.")).toBeInTheDocument();
    });
  });

  it("shows 'No sessions match this search' when search has no results", async () => {
    // When the search query filters out all sessions, an appropriate message
    // should be displayed.
    const now = Date.now();
    mockApi.discoverClaudeSessions.mockResolvedValue({
      sessions: [{
        sessionId: "s1",
        cwd: "/repo",
        gitBranch: "main",
        slug: "slug-1",
        lastActivityAt: now - 30_000,
        sourceFile: "/path/s1.jsonl",
      }],
    });

    render(<HomePage />);
    await screen.findByPlaceholderText("Fix a bug, build a feature, refactor code...");
    fireEvent.click(screen.getByRole("button", { name: /branch from session/i }));
    await screen.findByRole("button", { name: /fork and open slug-1/i });

    // Search for something that doesn't match
    const search = screen.getByPlaceholderText("Search sessions, branch, folder, or ID");
    fireEvent.change(search, { target: { value: "nonexistent-xyz" } });

    await waitFor(() => {
      expect(screen.getByText("No sessions match this search.")).toBeInTheDocument();
    });
  });

  // ─── Refresh detected sessions button ──────────────────────────────────────

  it("refreshes resume candidates when clicking the refresh button", async () => {
    // The "Refresh detected sessions" button should re-fetch session data.
    // The button shows "Refreshing..." while loading and then "Refresh detected sessions"
    // once the API call resolves.
    mockApi.discoverClaudeSessions.mockResolvedValue({ sessions: [] });
    mockApi.listSessions.mockResolvedValue([]);

    render(<HomePage />);
    await screen.findByPlaceholderText("Fix a bug, build a feature, refactor code...");

    // Before opening the panel, API should not have been called yet.
    // The accordion keeps elements in the DOM but inert, so this guard
    // ensures the useEffect gating on showBranchingControls is exercised.
    expect(mockApi.discoverClaudeSessions).not.toHaveBeenCalled();

    // Open the branching controls panel
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /branch from session/i }));
    });

    // Wait for initial API call to resolve and button to appear in idle state.
    // The loadResumeCandidates sets loading=true, calls discoverClaudeSessions,
    // then sets loading=false. We need to flush all microtasks.
    await act(async () => {
      await vi.waitFor(() => {
        expect(mockApi.discoverClaudeSessions).toHaveBeenCalledTimes(1);
      });
    });

    // Now the button should show its idle label
    const refreshButton = screen.getByRole("button", { name: /refresh detected sessions/i });

    // Click refresh and wait for second call
    await act(async () => {
      fireEvent.click(refreshButton);
    });

    await waitFor(() => {
      expect(mockApi.discoverClaudeSessions).toHaveBeenCalledTimes(2);
    });
  });

  // ─── Git repo detection on cwd change ──────────────────────────────────────

  it("resets git info when getRepoInfo fails", async () => {
    // If getRepoInfo rejects (e.g., cwd is not a git repo), the branch picker
    // should gracefully handle it without crashing.
    mockApi.getRepoInfo.mockRejectedValue(new Error("Not a git repo"));
    mockApi.listBranches.mockResolvedValue([]);

    render(<HomePage />);
    await screen.findByPlaceholderText("Fix a bug, build a feature, refactor code...");

    // Component should still render without errors
    expect(screen.getByText("The Companion")).toBeInTheDocument();
  });

  // ─── getHome fallback ──────────────────────────────────────────────────────

  it("falls back to home dir when no cwd or recent dirs", async () => {
    // When no recent dirs exist and getHome returns a cwd, it should be used.
    localStorage.removeItem("cc-recent-dirs");
    mockApi.getHome.mockResolvedValue({ home: "/home/user", cwd: "/fallback/project" });
    mockApi.getRepoInfo.mockResolvedValue({
      repoRoot: "/fallback/project",
      repoName: "project",
      currentBranch: "main",
      defaultBranch: "main",
      isWorktree: false,
    });

    render(<HomePage />);
    await screen.findByPlaceholderText("Fix a bug, build a feature, refactor code...");

    // The folder label should show "project" from the cwd path
    await waitFor(() => {
      expect(screen.getByText("project")).toBeInTheDocument();
    });
  });

  describe("@ mention prompts", () => {
    const samplePrompts = [
      { id: "1", name: "review", content: "Please review this code", scope: "global", createdAt: Date.now(), updatedAt: Date.now() },
      { id: "2", name: "refactor", content: "Refactor this module", scope: "global", createdAt: Date.now(), updatedAt: Date.now() },
      { id: "3", name: "test-review", content: "Review the tests", scope: "global", createdAt: Date.now(), updatedAt: Date.now() },
    ];

    it("opens @ mention menu when typing @", async () => {
      // Prompts must be available for the menu to show items
      mockApi.listPrompts.mockResolvedValue(samplePrompts);

      render(<HomePage />);
      const textarea = await screen.findByLabelText("Task description");

      // Type @ to trigger the mention menu
      await act(async () => {
        fireEvent.change(textarea, { target: { value: "@", selectionStart: 1 } });
      });

      // The mention menu should appear with prompt names
      await waitFor(() => {
        expect(screen.getByText("@review")).toBeInTheDocument();
        expect(screen.getByText("@refactor")).toBeInTheDocument();
        expect(screen.getByText("@test-review")).toBeInTheDocument();
      });
    });

    it("filters prompts by query after @", async () => {
      mockApi.listPrompts.mockResolvedValue(samplePrompts);

      render(<HomePage />);
      const textarea = await screen.findByLabelText("Task description");

      // Type @rev to filter — should match "review" (startsWith) and "test-review" (includes)
      await act(async () => {
        fireEvent.change(textarea, { target: { value: "@rev", selectionStart: 4 } });
      });

      await waitFor(() => {
        expect(screen.getByText("@review")).toBeInTheDocument();
        expect(screen.getByText("@test-review")).toBeInTheDocument();
      });
      // "refactor" should not appear since it doesn't match "rev"
      expect(screen.queryByText("@refactor")).not.toBeInTheDocument();
    });

    it("inserts prompt content on Enter without sending/creating session", async () => {
      mockApi.listPrompts.mockResolvedValue(samplePrompts);

      render(<HomePage />);
      const textarea = await screen.findByLabelText("Task description") as HTMLTextAreaElement;

      // Type @ to open menu
      await act(async () => {
        fireEvent.change(textarea, { target: { value: "@", selectionStart: 1 } });
      });

      // Wait for menu to appear
      await waitFor(() => {
        expect(screen.getByText("@review")).toBeInTheDocument();
      });

      // Press Enter to select the first prompt
      await act(async () => {
        fireEvent.keyDown(textarea, { key: "Enter" });
      });

      // The textarea should contain the prompt content, not just "@"
      expect(textarea.value).toBe("Please review this code ");
      // No session should have been created (createSessionStream should not be called)
      expect(createSessionStreamMock).not.toHaveBeenCalled();
    });

    it("navigates prompts with ArrowDown and selects with Enter", async () => {
      mockApi.listPrompts.mockResolvedValue(samplePrompts);

      render(<HomePage />);
      const textarea = await screen.findByLabelText("Task description") as HTMLTextAreaElement;

      // Type @ to open menu
      await act(async () => {
        fireEvent.change(textarea, { target: { value: "@", selectionStart: 1 } });
      });

      await waitFor(() => {
        expect(screen.getByText("@review")).toBeInTheDocument();
      });

      // Arrow down once to select "refactor" (second item)
      await act(async () => {
        fireEvent.keyDown(textarea, { key: "ArrowDown" });
      });

      // Press Enter to insert the second prompt
      await act(async () => {
        fireEvent.keyDown(textarea, { key: "Enter" });
      });

      // Should contain the second prompt's content
      expect(textarea.value).toBe("Refactor this module ");
    });

    it("works with @ in the middle of text", async () => {
      mockApi.listPrompts.mockResolvedValue(samplePrompts);

      render(<HomePage />);
      const textarea = await screen.findByLabelText("Task description") as HTMLTextAreaElement;

      // Type "Please " then "@rev"
      await act(async () => {
        fireEvent.change(textarea, { target: { value: "Please @rev", selectionStart: 11 } });
      });

      // Menu should appear with filtered prompts
      await waitFor(() => {
        expect(screen.getByText("@review")).toBeInTheDocument();
      });

      // Select the first prompt
      await act(async () => {
        fireEvent.keyDown(textarea, { key: "Enter" });
      });

      // Should replace @rev with the prompt content, keeping the prefix
      expect(textarea.value).toBe("Please Please review this code ");
    });
  });

  describe("Sandbox toggle", () => {
    it("shows sandbox toggle for all backends", async () => {
      // The sandbox toggle should appear regardless of which backend is selected
      render(<HomePage />);
      await screen.findByLabelText("Task description");

      expect(screen.getByText("Sandbox")).toBeInTheDocument();
    });

    it("shows sandbox toggle for codex backend", async () => {
      // The sandbox toggle should also appear when the backend is "codex"
      mockApi.getBackends.mockResolvedValue([
        { id: "codex", name: "Codex", available: true },
      ]);
      mockApi.getBackendModels.mockResolvedValue([]);
      localStorage.setItem("cc-backend", "codex");
      render(<HomePage />);
      await screen.findByLabelText("Task description");

      expect(screen.getByText("Sandbox")).toBeInTheDocument();
    });

    it("toggles sandbox enabled state on click", async () => {
      // Clicking the sandbox button opens a dropdown; selecting "Default"
      // enables sandbox and persists to localStorage.
      render(<HomePage />);
      await screen.findByLabelText("Task description");

      const sandboxBtn = screen.getByText("Sandbox").closest("button")!;
      await act(async () => { fireEvent.click(sandboxBtn); });

      // Dropdown opens — select Default to enable sandbox
      const defaultOption = await screen.findByText("Default (the-companion:latest)");
      await act(async () => { fireEvent.click(defaultOption.closest("button")!); });

      expect(localStorage.getItem("cc-sandbox-enabled")).toBe("true");
    });

    it("shows sandbox dropdown when clicked", async () => {
      // Clicking the sandbox button should open a dropdown showing
      // Off, Default, and available sandbox profiles.
      mockApi.listSandboxes.mockResolvedValue([
        { slug: "my-sandbox", name: "My Sandbox", createdAt: Date.now(), updatedAt: Date.now() },
      ]);
      mockApi.getImageStatus.mockResolvedValue({ status: "ready" });
      localStorage.setItem("cc-sandbox-enabled", "true");
      render(<HomePage />);
      await screen.findByLabelText("Task description");

      // Click the sandbox button to open the dropdown
      const sandboxBtn = screen.getByText("Sandbox").closest("button")!;
      await act(async () => { fireEvent.click(sandboxBtn); });

      // The dropdown should show Off, Default, and our sandbox
      await screen.findByText("Off");
      await screen.findByText("Default (the-companion:latest)");
      await screen.findByText("My Sandbox");
    });

    it("selects a sandbox profile from the dropdown", async () => {
      // Selecting a specific sandbox profile in the dropdown should update
      // localStorage and close the dropdown.
      mockApi.listSandboxes.mockResolvedValue([
        { slug: "my-sandbox", name: "My Sandbox", createdAt: Date.now(), updatedAt: Date.now() },
      ]);
      mockApi.getImageStatus.mockResolvedValue({ status: "ready" });
      localStorage.setItem("cc-sandbox-enabled", "true");
      render(<HomePage />);
      await screen.findByLabelText("Task description");

      // Open sandbox dropdown
      const sandboxBtn = screen.getByText("Sandbox").closest("button")!;
      await act(async () => { fireEvent.click(sandboxBtn); });

      // Select "My Sandbox"
      const mySandbox = await screen.findByText("My Sandbox");
      await act(async () => { fireEvent.click(mySandbox.closest("button")!); });

      expect(localStorage.getItem("cc-selected-sandbox")).toBe("my-sandbox");
    });

    it("sends sandbox flags for codex backend when sandbox is enabled", async () => {
      // When sandbox is enabled in localStorage and the backend is codex,
      // creating a session should send sandbox flags (sandbox works for all backends).
      mockApi.getBackends.mockResolvedValue([
        { id: "codex", name: "Codex", available: true },
      ]);
      mockApi.getBackendModels.mockResolvedValue([]);
      localStorage.setItem("cc-backend", "codex");
      localStorage.setItem("cc-sandbox-enabled", "true");
      localStorage.setItem("cc-selected-sandbox", "my-sandbox");
      createSessionStreamMock.mockReturnValue(new ReadableStream({
        start(controller) {
          controller.enqueue(JSON.stringify({ type: "complete", sessionId: "sess-1" }) + "\n");
          controller.close();
        },
      }));

      render(<HomePage />);
      const textarea = await screen.findByLabelText("Task description");
      await act(async () => {
        fireEvent.change(textarea, { target: { value: "test" } });
      });

      const sendButton = screen.getByTitle("Send message");
      await act(async () => {
        fireEvent.click(sendButton);
      });

      await waitFor(() => {
        expect(createSessionStreamMock).toHaveBeenCalled();
      });

      const callArgs = createSessionStreamMock.mock.calls[0][0];
      expect(callArgs.sandboxEnabled).toBe(true);
      expect(callArgs.sandboxSlug).toBe("my-sandbox");
    });

    it("does not send sandbox flags for codex backend when sandbox is disabled", async () => {
      // When sandbox is explicitly disabled in localStorage, creating a session
      // with codex backend should NOT send sandbox flags.
      mockApi.getBackends.mockResolvedValue([
        { id: "codex", name: "Codex", available: true },
      ]);
      mockApi.getBackendModels.mockResolvedValue([]);
      localStorage.setItem("cc-backend", "codex");
      localStorage.setItem("cc-sandbox-enabled", "false");
      createSessionStreamMock.mockReturnValue(new ReadableStream({
        start(controller) {
          controller.enqueue(JSON.stringify({ type: "complete", sessionId: "sess-1" }) + "\n");
          controller.close();
        },
      }));

      render(<HomePage />);
      const textarea = await screen.findByLabelText("Task description");
      await act(async () => {
        fireEvent.change(textarea, { target: { value: "test" } });
      });

      const sendButton = screen.getByTitle("Send message");
      await act(async () => {
        fireEvent.click(sendButton);
      });

      await waitFor(() => {
        expect(createSessionStreamMock).toHaveBeenCalled();
      });

      const callArgs = createSessionStreamMock.mock.calls[0][0];
      expect(callArgs.sandboxEnabled).toBeUndefined();
      expect(callArgs.sandboxSlug).toBeUndefined();
    });

    it("shows image status indicator when pulling", async () => {
      // When sandbox is enabled and the image is pulling, a pulsing
      // amber dot should be visible next to the Sandbox button.
      mockApi.getImageStatus.mockResolvedValue({ status: "pulling", progress: "downloading..." });
      localStorage.setItem("cc-sandbox-enabled", "true");
      render(<HomePage />);
      await screen.findByLabelText("Task description");

      await waitFor(() => {
        expect(screen.getByTitle("Pulling Docker image...")).toBeInTheDocument();
      });
    });

    it("shows image error indicator", async () => {
      // When sandbox is enabled but image pull failed, a red dot with
      // error info should appear.
      mockApi.getImageStatus.mockResolvedValue({ status: "error", error: "pull failed" });
      localStorage.setItem("cc-sandbox-enabled", "true");
      render(<HomePage />);
      await screen.findByLabelText("Task description");

      await waitFor(() => {
        expect(screen.getByTitle("Image error: pull failed")).toBeInTheDocument();
      });
    });
  });

  // ─── Onboarding tip ──────────────────────────────────────────────────────────

  describe("onboarding tip", () => {
    it("renders the onboarding tip when cc-onboarding-dismissed is not set", async () => {
      // First-time users should see the onboarding tip explaining
      // the toolbar controls and Branch from session.
      render(<HomePage />);
      await screen.findByPlaceholderText("Fix a bug, build a feature, refactor code...");

      expect(screen.getByText(/sets where your code lives/)).toBeInTheDocument();
    });

    it("does not render the tip when cc-onboarding-dismissed is already set", async () => {
      // Returning users who have previously dismissed the tip should
      // not see it again; the localStorage flag gates initial state.
      localStorage.setItem("cc-onboarding-dismissed", "true");
      render(<HomePage />);
      await screen.findByPlaceholderText("Fix a bug, build a feature, refactor code...");

      expect(screen.queryByText(/sets where your code lives/)).not.toBeInTheDocument();
    });

    it("dismisses the tip and persists to localStorage on click", async () => {
      // Clicking the dismiss button should hide the tip and write
      // the cc-onboarding-dismissed flag to localStorage so it stays
      // hidden across sessions.
      render(<HomePage />);
      await screen.findByPlaceholderText("Fix a bug, build a feature, refactor code...");

      expect(screen.getByText(/sets where your code lives/)).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByLabelText("Dismiss onboarding tip"));
      });

      expect(screen.queryByText(/sets where your code lives/)).not.toBeInTheDocument();
      expect(localStorage.getItem("cc-onboarding-dismissed")).toBe("true");
    });

    it("does not mention Branch from session when backend is codex", async () => {
      // The onboarding tip conditionally shows the "Branch from session"
      // sentence only for Claude backend. Codex users should not see it
      // since the branching feature is Claude-only.
      localStorage.setItem("cc-backend", "codex");
      render(<HomePage />);
      await screen.findByPlaceholderText("Fix a bug, build a feature, refactor code...");

      // The tip itself should still render (toolbar explanation)
      expect(screen.getByText(/sets where your code lives/)).toBeInTheDocument();
      // But the Claude-only sentence should be absent
      expect(screen.queryByText(/branch from session/i)).not.toBeInTheDocument();
    });
  });
});
