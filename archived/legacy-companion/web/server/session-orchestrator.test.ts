import { vi, describe, it, expect, beforeEach } from "vitest";

// ── Module mocks ────────────────────────────────────────────────────────────
// Must be declared before any imports that reference them.

vi.mock("./env-manager.js", () => ({
  getEnv: vi.fn(() => null),
}));

vi.mock("./sandbox-manager.js", () => ({
  getSandbox: vi.fn(() => null),
}));

vi.mock("./git-utils.js", () => ({
  getRepoInfo: vi.fn(() => null),
  gitFetch: vi.fn(() => ({ success: true, output: "" })),
  gitPull: vi.fn(() => ({ success: true, output: "" })),
  checkoutOrCreateBranch: vi.fn(() => ({ created: false })),
  ensureWorktree: vi.fn(() => ({ worktreePath: "/wt/feat", actualBranch: "feat", isNew: true })),
  isWorktreeDirty: vi.fn(() => false),
  removeWorktree: vi.fn(() => ({ removed: true })),
}));

vi.mock("./session-names.js", () => ({
  getName: vi.fn(() => undefined),
  setName: vi.fn(),
  getAllNames: vi.fn(() => ({})),
  removeName: vi.fn(),
}));

vi.mock("./session-linear-issues.js", () => ({
  getLinearIssue: vi.fn(() => undefined),
  setLinearIssue: vi.fn(),
  removeLinearIssue: vi.fn(),
  getAllLinearIssues: vi.fn(() => ({})),
}));

vi.mock("./settings-manager.js", () => ({
  getSettings: vi.fn(() => ({
    anthropicApiKey: "",
    anthropicModel: "claude-sonnet-4-6",
    linearApiKey: "",
    linearAutoTransition: false,
    linearAutoTransitionStateId: "",
    linearAutoTransitionStateName: "",
    linearArchiveTransition: false,
    linearArchiveTransitionStateId: "",
    linearArchiveTransitionStateName: "",
    claudeCodeOAuthToken: "",
    openaiApiKey: "",
    onboardingCompleted: false,
  })),
}));

vi.mock("./linear-connections.js", () => ({
  getConnection: vi.fn(() => null),
  resolveApiKey: vi.fn(() => null),
}));

vi.mock("./linear-prompt-builder.js", () => ({
  buildLinearSystemPrompt: vi.fn(() => ""),
}));

vi.mock("./routes/linear-routes.js", () => ({
  transitionLinearIssue: vi.fn(async () => ({ ok: true })),
  fetchLinearTeamStates: vi.fn(async () => []),
}));

vi.mock("./claude-container-auth.js", () => ({
  hasContainerClaudeAuth: vi.fn(() => true),
}));

vi.mock("./codex-container-auth.js", () => ({
  hasContainerCodexAuth: vi.fn(() => true),
}));

vi.mock("./commands-discovery.js", () => ({
  discoverCommandsAndSkills: vi.fn(async () => ({ slash_commands: [], skills: [] })),
}));

vi.mock("./auto-namer.js", () => ({
  generateSessionTitle: vi.fn(async () => "Test Title"),
}));

const mockImagePullIsReady = vi.hoisted(() => vi.fn(() => true));
const mockImagePullGetState = vi.hoisted(() => vi.fn(() => ({ image: "", status: "ready", progress: [] })));
const mockImagePullEnsureImage = vi.hoisted(() => vi.fn());
const mockImagePullWaitForReady = vi.hoisted(() => vi.fn(async () => true));
const mockImagePullOnProgress = vi.hoisted(() => vi.fn(() => () => {}));

vi.mock("./image-pull-manager.js", () => ({
  imagePullManager: {
    isReady: mockImagePullIsReady,
    getState: mockImagePullGetState,
    ensureImage: mockImagePullEnsureImage,
    waitForReady: mockImagePullWaitForReady,
    onProgress: mockImagePullOnProgress,
  },
}));

vi.mock("./container-manager.js", () => ({
  containerManager: {
    removeContainer: vi.fn(),
    createContainer: vi.fn(() => ({
      containerId: "cid-1",
      name: "companion-1",
      image: "the-companion:latest",
      portMappings: [],
      hostCwd: "/test",
      containerCwd: "/workspace",
      state: "running",
    })),
    imageExists: vi.fn(() => true),
    retrack: vi.fn(),
    copyWorkspaceToContainer: vi.fn(async () => {}),
    reseedGitAuth: vi.fn(),
    gitOpsInContainer: vi.fn(() => ({
      fetchOk: true,
      checkoutOk: true,
      pullOk: true,
      errors: [],
    })),
    execInContainerAsync: vi.fn(async () => ({ exitCode: 0, output: "ok" })),
    isContainerAlive: vi.fn(() => "not_found"),
  },
}));

// ── Imports (after mocks) ───────────────────────────────────────────────────

import { SessionOrchestrator } from "./session-orchestrator.js";
import type { SessionOrchestratorDeps } from "./session-orchestrator.js";
import { containerManager } from "./container-manager.js";
import * as envManager from "./env-manager.js";
import * as sandboxManager from "./sandbox-manager.js";
import * as gitUtils from "./git-utils.js";
import * as sessionNames from "./session-names.js";
import * as sessionLinearIssues from "./session-linear-issues.js";
import * as settingsManager from "./settings-manager.js";
import { resolveApiKey } from "./linear-connections.js";
import { transitionLinearIssue, fetchLinearTeamStates } from "./routes/linear-routes.js";
import { hasContainerClaudeAuth } from "./claude-container-auth.js";
import { hasContainerCodexAuth } from "./codex-container-auth.js";
import { generateSessionTitle } from "./auto-namer.js";
import { companionBus } from "./event-bus.js";

// ── Mock factories ──────────────────────────────────────────────────────────

function createMockLauncher() {
  return {
    launch: vi.fn(() => ({
      sessionId: "session-1",
      state: "starting",
      cwd: "/test",
      createdAt: Date.now(),
    })),
    kill: vi.fn(async () => true),
    relaunch: vi.fn(async () => ({ ok: true })),
    listSessions: vi.fn(() => []),
    getSession: vi.fn(() => undefined),
    setArchived: vi.fn(),
    removeSession: vi.fn(),
    setCLISessionId: vi.fn(),
    getStartingSessions: vi.fn(() => []),
  } as any;
}

function createMockBridge() {
  return {
    closeSession: vi.fn(),
    isCliConnected: vi.fn(() => false),
    getSession: vi.fn(() => null),
    getAllSessions: vi.fn(() => []),
    markContainerized: vi.fn(),
    prePopulateCommands: vi.fn(),
    broadcastNameUpdate: vi.fn(),
    broadcastToSession: vi.fn(),
    injectSystemPrompt: vi.fn(),
    attachBackendAdapter: vi.fn(),
    cancelDisconnectTimer: vi.fn(() => false),
  } as any;
}

function createMockStore() {
  return {
    setArchived: vi.fn(() => true),
  } as any;
}

function createMockTracker() {
  return {
    addMapping: vi.fn(),
    getBySession: vi.fn(() => null),
    removeBySession: vi.fn(),
    isWorktreeInUse: vi.fn(() => false),
  } as any;
}

function createDeps(overrides?: Partial<SessionOrchestratorDeps>) {
  const launcher = createMockLauncher();
  const wsBridge = createMockBridge();
  const sessionStore = createMockStore();
  const worktreeTracker = createMockTracker();
  const prPoller = { watch: vi.fn(), unwatch: vi.fn() };
  const agentExecutor = { handleSessionExited: vi.fn() } as any;
  return {
    launcher,
    wsBridge,
    sessionStore,
    worktreeTracker,
    prPoller,
    agentExecutor,
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("SessionOrchestrator", () => {
  let deps: ReturnType<typeof createDeps>;
  let orchestrator: SessionOrchestrator;

  beforeEach(() => {
    vi.clearAllMocks();
    companionBus.clear();
    mockImagePullIsReady.mockReturnValue(true);
    // Re-establish mocks that may have been overridden by mockImplementation in
    // previous tests (clearAllMocks resets calls/results but NOT implementations).
    vi.mocked(hasContainerClaudeAuth).mockReturnValue(true);
    vi.mocked(hasContainerCodexAuth).mockReturnValue(true);
    vi.mocked(containerManager.createContainer).mockReturnValue({
      containerId: "cid-1",
      name: "companion-1",
      image: "the-companion:latest",
      portMappings: [],
      hostCwd: "/test",
      containerCwd: "/workspace",
      state: "running",
    } as any);
    vi.mocked(containerManager.gitOpsInContainer).mockReturnValue({
      fetchOk: true,
      checkoutOk: true,
      pullOk: true,
      errors: [],
    } as any);
    vi.mocked(containerManager.execInContainerAsync).mockResolvedValue({ exitCode: 0, output: "ok" });
    deps = createDeps();
    orchestrator = new SessionOrchestrator(deps);
  });

  // ── Initialization / Event wiring ─────────────────────────────────────────

  describe("initialize()", () => {
    it("registers all expected event listeners on companionBus", () => {
      // Verifies that initialize() wires up all event handlers on the bus
      orchestrator.initialize();

      expect(companionBus.listenerCount("session:cli-id-received")).toBeGreaterThan(0);
      expect(companionBus.listenerCount("backend:codex-adapter-created")).toBeGreaterThan(0);
      expect(companionBus.listenerCount("session:exited")).toBeGreaterThan(0);
      expect(companionBus.listenerCount("session:git-info-ready")).toBeGreaterThan(0);
      expect(companionBus.listenerCount("session:relaunch-needed")).toBeGreaterThan(0);
      expect(companionBus.listenerCount("session:idle-kill")).toBeGreaterThan(0);
      expect(companionBus.listenerCount("session:first-turn-completed")).toBeGreaterThan(0);
    });

    it("CLI session ID callback delegates to launcher.setCLISessionId", () => {
      orchestrator.initialize();

      // Emit event on the bus instead of extracting callback
      companionBus.emit("session:cli-id-received", { sessionId: "s1", cliSessionId: "cli-id-123" });

      expect(deps.launcher.setCLISessionId).toHaveBeenCalledWith("s1", "cli-id-123");
    });

    it("session exit callback notifies agentExecutor", () => {
      orchestrator.initialize();

      companionBus.emit("session:exited", { sessionId: "s1", exitCode: 0 });

      expect(deps.agentExecutor.handleSessionExited).toHaveBeenCalledWith("s1", 0);
    });

    it("git info ready callback starts PR polling", () => {
      orchestrator.initialize();

      companionBus.emit("session:git-info-ready", { sessionId: "s1", cwd: "/repo", branch: "main" });

      expect(deps.prPoller.watch).toHaveBeenCalledWith("s1", "/repo", "main");
    });

    it("idle kill callback does not kill archived sessions", async () => {
      deps.launcher.getSession.mockReturnValue({ archived: true });
      orchestrator.initialize();

      companionBus.emit("session:idle-kill", { sessionId: "s1" });
      await new Promise(r => setTimeout(r, 0));

      // Should not kill because session is archived
      expect(deps.launcher.kill).not.toHaveBeenCalled();
    });

    it("idle kill callback kills CLI but preserves container", async () => {
      deps.launcher.getSession.mockReturnValue({ archived: false });
      orchestrator.initialize();

      companionBus.emit("session:idle-kill", { sessionId: "s1" });
      await new Promise(r => setTimeout(r, 0));

      expect(deps.launcher.kill).toHaveBeenCalledWith("s1");
      // Container must NOT be removed — idle-kill only stops the CLI process
      // so the container can be reused on relaunch.
      expect(containerManager.removeContainer).not.toHaveBeenCalled();
    });

    it("after idle-kill, relaunch reuses preserved container without creating a new one", async () => {
      // End-to-end scenario: idle-kill fires, container survives, browser
      // reconnects, and the CLI is relaunched into the existing container.
      vi.useFakeTimers();
      deps.launcher.getSession.mockReturnValue({
        archived: false,
        state: "exited",
        containerId: "cid-preserved",
        pid: undefined,
      } as any);
      deps.wsBridge.isCliConnected.mockReturnValue(false);
      deps.launcher.relaunch.mockResolvedValue({ ok: true });
      orchestrator.initialize();

      // 1. Idle-kill fires — CLI killed, container preserved
      companionBus.emit("session:idle-kill", { sessionId: "s1" });
      await vi.advanceTimersByTimeAsync(0);
      expect(deps.launcher.kill).toHaveBeenCalledWith("s1");
      expect(containerManager.removeContainer).not.toHaveBeenCalled();

      // 2. Browser reconnects — triggers auto-relaunch
      companionBus.emit("session:relaunch-needed", { sessionId: "s1" });
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.advanceTimersByTimeAsync(0);

      // 3. Relaunch succeeds using the preserved container — no new container created
      expect(deps.launcher.relaunch).toHaveBeenCalledWith("s1");
      expect(containerManager.createContainer).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("idle kill clears auto-relaunch counter so session can be fully relaunched later", async () => {
      // After idle-kill, the auto-relaunch counter must be reset. Without this,
      // a session that previously had failed relaunch attempts would be stuck at
      // max and never relaunch when the user returns.
      vi.useFakeTimers();
      deps.launcher.getSession.mockReturnValue({ archived: false, state: "exited", pid: undefined } as any);
      deps.wsBridge.isCliConnected.mockReturnValue(false);
      deps.launcher.relaunch.mockResolvedValue({ ok: false, error: "failed" });
      orchestrator.initialize();

      // Exhaust 2 of 3 relaunch attempts
      for (let i = 0; i < 2; i++) {
        companionBus.emit("session:relaunch-needed", { sessionId: "s1" });
        await vi.advanceTimersByTimeAsync(15_000);
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(deps.launcher.relaunch).toHaveBeenCalledTimes(2);

      // Now idle-kill the session — this should clear the counter
      companionBus.emit("session:idle-kill", { sessionId: "s1" });
      await vi.advanceTimersByTimeAsync(0);

      // After idle-kill, we should get a fresh budget of 3 relaunch attempts.
      // Reset the mock to track new calls.
      deps.launcher.relaunch.mockClear();
      deps.launcher.relaunch.mockResolvedValue({ ok: false, error: "failed" });

      for (let i = 0; i < 3; i++) {
        companionBus.emit("session:relaunch-needed", { sessionId: "s1" });
        await vi.advanceTimersByTimeAsync(15_000);
        await vi.advanceTimersByTimeAsync(0);
      }

      // All 3 attempts should succeed (not blocked by previous count)
      expect(deps.launcher.relaunch).toHaveBeenCalledTimes(3);
      vi.useRealTimers();
    });

    it("is idempotent — calling initialize() twice does not double-register listeners", () => {
      // Guards against accidental re-initialization which would cause
      // all event handlers to fire multiple times per event.
      orchestrator.initialize();
      const countsAfterFirst = {
        cliId: companionBus.listenerCount("session:cli-id-received"),
        codex: companionBus.listenerCount("backend:codex-adapter-created"),
        exited: companionBus.listenerCount("session:exited"),
        relaunch: companionBus.listenerCount("session:relaunch-needed"),
        idleKill: companionBus.listenerCount("session:idle-kill"),
        firstTurn: companionBus.listenerCount("session:first-turn-completed"),
      };

      orchestrator.initialize();

      // Listener counts should not have doubled after the second initialize()
      expect(companionBus.listenerCount("session:cli-id-received")).toBe(countsAfterFirst.cliId);
      expect(companionBus.listenerCount("backend:codex-adapter-created")).toBe(countsAfterFirst.codex);
      expect(companionBus.listenerCount("session:exited")).toBe(countsAfterFirst.exited);
      expect(companionBus.listenerCount("session:relaunch-needed")).toBe(countsAfterFirst.relaunch);
      expect(companionBus.listenerCount("session:idle-kill")).toBe(countsAfterFirst.idleKill);
      expect(companionBus.listenerCount("session:first-turn-completed")).toBe(countsAfterFirst.firstTurn);
    });
  });

  // ── Session Creation ──────────────────────────────────────────────────────

  describe("createSession()", () => {
    it("creates a basic session with defaults", async () => {
      const result = await orchestrator.createSession({ cwd: "/test" });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.session.sessionId).toBe("session-1");
      }
      expect(deps.launcher.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: "/test",
          backendType: "claude",
        }),
      );
    });

    it("returns 400 for invalid backend", async () => {
      const result = await orchestrator.createSession({ cwd: "/test", backend: "invalid" });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Invalid backend");
        expect(result.status).toBe(400);
      }
    });

    it("resolves environment variables from envSlug", async () => {
      vi.mocked(envManager.getEnv).mockReturnValue({
        name: "Production",
        slug: "production",
        variables: { API_KEY: "secret", DB_HOST: "db.example.com" },
        createdAt: 1000,
        updatedAt: 1000,
      });

      const result = await orchestrator.createSession({ cwd: "/test", envSlug: "production" });

      expect(result.ok).toBe(true);
      expect(envManager.getEnv).toHaveBeenCalledWith("production");
      expect(deps.launcher.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          env: expect.objectContaining({ API_KEY: "secret", DB_HOST: "db.example.com" }),
        }),
      );
    });

    // ── Global token injection from settings ───────────────────────────

    // Verifies that CLAUDE_CODE_OAUTH_TOKEN is injected from global settings
    // when the session backend is "claude" and no token is already set
    it("injects CLAUDE_CODE_OAUTH_TOKEN from global settings for claude backend", async () => {
      vi.mocked(settingsManager.getSettings).mockReturnValue({
        ...settingsManager.getSettings(),
        claudeCodeOAuthToken: "global-oauth-token",
      });

      await orchestrator.createSession({ cwd: "/test", backend: "claude" });

      expect(deps.launcher.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          env: expect.objectContaining({ CLAUDE_CODE_OAUTH_TOKEN: "global-oauth-token" }),
        }),
      );
    });

    // Verifies that OPENAI_API_KEY is injected from global settings
    // when the session backend is "codex" and no key is already set
    it("injects OPENAI_API_KEY from global settings for codex backend", async () => {
      vi.mocked(settingsManager.getSettings).mockReturnValue({
        ...settingsManager.getSettings(),
        openaiApiKey: "sk-global-key",
      });

      await orchestrator.createSession({ cwd: "/test", backend: "codex" });

      expect(deps.launcher.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          env: expect.objectContaining({ OPENAI_API_KEY: "sk-global-key" }),
        }),
      );
    });

    // Verifies that env-profile tokens take precedence over global settings
    it("does not overwrite CLAUDE_CODE_OAUTH_TOKEN when already set by env profile", async () => {
      vi.mocked(settingsManager.getSettings).mockReturnValue({
        ...settingsManager.getSettings(),
        claudeCodeOAuthToken: "global-token",
      });
      vi.mocked(envManager.getEnv).mockReturnValue({
        name: "Custom",
        slug: "custom",
        variables: { CLAUDE_CODE_OAUTH_TOKEN: "env-profile-token" },
        createdAt: 1000,
        updatedAt: 1000,
      });

      await orchestrator.createSession({ cwd: "/test", backend: "claude", envSlug: "custom" });

      expect(deps.launcher.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          env: expect.objectContaining({ CLAUDE_CODE_OAUTH_TOKEN: "env-profile-token" }),
        }),
      );
    });

    // Verifies that no token is injected when global settings have empty values
    it("does not inject token when global setting is empty", async () => {
      vi.mocked(settingsManager.getSettings).mockReturnValue({
        ...settingsManager.getSettings(),
        claudeCodeOAuthToken: "",
        openaiApiKey: "",
      });

      await orchestrator.createSession({ cwd: "/test", backend: "claude" });

      const launchCall = vi.mocked(deps.launcher.launch).mock.calls[0][0];
      expect(launchCall.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    });

    it("validates branch name to prevent injection", async () => {
      const result = await orchestrator.createSession({ cwd: "/test", branch: "bad branch name!" });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Invalid branch name");
        expect(result.status).toBe(400);
      }
    });

    it("performs git fetch, checkout, and pull for non-docker branch", async () => {
      vi.mocked(gitUtils.getRepoInfo).mockReturnValue({
        repoRoot: "/repo",
        repoName: "my-repo",
        currentBranch: "develop",
        defaultBranch: "main",
        isWorktree: false,
      });

      const result = await orchestrator.createSession({ cwd: "/repo", branch: "main" });

      expect(result.ok).toBe(true);
      expect(gitUtils.gitFetch).toHaveBeenCalledWith("/repo");
      expect(gitUtils.checkoutOrCreateBranch).toHaveBeenCalledWith("/repo", "main", {
        createBranch: undefined,
        defaultBranch: "main",
      });
      expect(gitUtils.gitPull).toHaveBeenCalledWith("/repo");
    });

    it("skips checkout when branch matches current branch", async () => {
      vi.mocked(gitUtils.getRepoInfo).mockReturnValue({
        repoRoot: "/repo",
        repoName: "my-repo",
        currentBranch: "main",
        defaultBranch: "main",
        isWorktree: false,
      });

      await orchestrator.createSession({ cwd: "/repo", branch: "main" });

      expect(gitUtils.gitFetch).toHaveBeenCalled();
      expect(gitUtils.checkoutOrCreateBranch).not.toHaveBeenCalled();
      expect(gitUtils.gitPull).toHaveBeenCalled();
    });

    it("creates worktree when useWorktree is true", async () => {
      vi.mocked(gitUtils.getRepoInfo).mockReturnValue({
        repoRoot: "/repo",
        repoName: "my-repo",
        currentBranch: "main",
        defaultBranch: "main",
        isWorktree: false,
      });
      vi.mocked(gitUtils.ensureWorktree).mockReturnValue({
        worktreePath: "/wt/feat",
        branch: "feat",
        actualBranch: "feat",
        isNew: true,
      } as any);

      const result = await orchestrator.createSession({ cwd: "/repo", branch: "feat", useWorktree: true });

      expect(result.ok).toBe(true);
      expect(gitUtils.ensureWorktree).toHaveBeenCalledWith("/repo", "feat", {
        baseBranch: "main",
        createBranch: undefined,
        forceNew: true,
      });
      // Launch should use worktree path as cwd
      expect(deps.launcher.launch).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: "/wt/feat" }),
      );
      // Should track the worktree mapping
      expect(deps.worktreeTracker.addMapping).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "session-1",
          repoRoot: "/repo",
          branch: "feat",
          worktreePath: "/wt/feat",
        }),
      );
    });

    it("proceeds when git fetch fails (non-fatal)", async () => {
      vi.mocked(gitUtils.getRepoInfo).mockReturnValue({
        repoRoot: "/repo",
        repoName: "my-repo",
        currentBranch: "main",
        defaultBranch: "main",
        isWorktree: false,
      });
      vi.mocked(gitUtils.gitFetch).mockReturnValue({ success: false, output: "network error" });

      const result = await orchestrator.createSession({ cwd: "/repo", branch: "main" });

      expect(result.ok).toBe(true);
      expect(deps.launcher.launch).toHaveBeenCalled();
    });

    it("returns 400 when containerized Claude lacks auth", async () => {
      vi.mocked(hasContainerClaudeAuth).mockReturnValue(false);
      vi.mocked(envManager.getEnv).mockReturnValue({
        name: "E",
        slug: "e",
        variables: {},
        createdAt: 1,
        updatedAt: 1,
      } as any);

      const result = await orchestrator.createSession({
        cwd: "/test",
        sandboxEnabled: true,
        envSlug: "e",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Containerized Claude requires auth");
        expect(result.status).toBe(400);
      }
    });

    it("returns 400 when containerized Codex lacks auth", async () => {
      vi.mocked(hasContainerCodexAuth).mockReturnValue(false);
      vi.mocked(envManager.getEnv).mockReturnValue({
        name: "E",
        slug: "e",
        variables: {},
        createdAt: 1,
        updatedAt: 1,
      } as any);

      const result = await orchestrator.createSession({
        cwd: "/test",
        backend: "codex",
        sandboxEnabled: true,
        envSlug: "e",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Containerized Codex requires auth");
        expect(result.status).toBe(400);
      }
    });

    it("creates container for sandboxed sessions", async () => {
      vi.mocked(envManager.getEnv).mockReturnValue({
        name: "Docker",
        slug: "docker",
        variables: { CLAUDE_CODE_OAUTH_TOKEN: "token" },
        createdAt: 1,
        updatedAt: 1,
      } as any);
      vi.mocked(sandboxManager.getSandbox).mockReturnValue({
        name: "Docker",
        slug: "docker",
        createdAt: 1,
        updatedAt: 1,
      });

      const result = await orchestrator.createSession({
        cwd: "/test",
        envSlug: "docker",
        sandboxEnabled: true,
        sandboxSlug: "docker",
      });

      expect(result.ok).toBe(true);
      expect(containerManager.createContainer).toHaveBeenCalled();
      expect(containerManager.copyWorkspaceToContainer).toHaveBeenCalled();
      expect(containerManager.retrack).toHaveBeenCalledWith("cid-1", "session-1");
      expect(deps.wsBridge.markContainerized).toHaveBeenCalledWith("session-1", "/test");
    });

    it("returns 503 when container creation fails", async () => {
      vi.mocked(envManager.getEnv).mockReturnValue({
        name: "E",
        slug: "e",
        variables: { CLAUDE_CODE_OAUTH_TOKEN: "token" },
        createdAt: 1,
        updatedAt: 1,
      } as any);
      vi.mocked(containerManager.createContainer).mockImplementation(() => {
        throw new Error("docker daemon timeout");
      });

      const result = await orchestrator.createSession({
        cwd: "/test",
        sandboxEnabled: true,
        envSlug: "e",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("container startup failed");
        expect(result.status).toBe(503);
      }
    });

    it("runs init script for sandbox sessions", async () => {
      vi.mocked(envManager.getEnv).mockReturnValue({
        name: "E",
        slug: "e",
        variables: { CLAUDE_CODE_OAUTH_TOKEN: "token" },
        createdAt: 1,
        updatedAt: 1,
      } as any);
      vi.mocked(sandboxManager.getSandbox).mockReturnValue({
        name: "E",
        slug: "e",
        initScript: "npm install",
        createdAt: 1,
        updatedAt: 1,
      });

      const result = await orchestrator.createSession({
        cwd: "/test",
        sandboxEnabled: true,
        sandboxSlug: "e",
        envSlug: "e",
      });

      expect(result.ok).toBe(true);
      expect(containerManager.execInContainerAsync).toHaveBeenCalledWith(
        "cid-1",
        ["sh", "-lc", "npm install"],
        expect.objectContaining({ timeout: expect.any(Number) }),
      );
    });

    it("returns 503 when init script fails", async () => {
      vi.mocked(envManager.getEnv).mockReturnValue({
        name: "E",
        slug: "e",
        variables: { CLAUDE_CODE_OAUTH_TOKEN: "token" },
        createdAt: 1,
        updatedAt: 1,
      } as any);
      vi.mocked(sandboxManager.getSandbox).mockReturnValue({
        name: "E",
        slug: "e",
        initScript: "exit 1",
        createdAt: 1,
        updatedAt: 1,
      });
      vi.mocked(containerManager.execInContainerAsync).mockResolvedValue({ exitCode: 1, output: "npm ERR!" });

      const result = await orchestrator.createSession({
        cwd: "/test",
        sandboxEnabled: true,
        sandboxSlug: "e",
        envSlug: "e",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Init script failed");
        expect(result.status).toBe(503);
        // Container should be cleaned up
        expect(containerManager.removeContainer).toHaveBeenCalled();
      }
    });

    it("runs git ops inside container for Docker sessions with branch", async () => {
      vi.mocked(gitUtils.getRepoInfo).mockReturnValue({
        repoRoot: "/repo",
        repoName: "my-repo",
        currentBranch: "main",
        defaultBranch: "main",
        isWorktree: false,
      } as any);
      vi.mocked(envManager.getEnv).mockReturnValue({
        name: "Docker",
        slug: "docker",
        variables: { CLAUDE_CODE_OAUTH_TOKEN: "token" },
        createdAt: 1,
        updatedAt: 1,
      } as any);
      vi.mocked(sandboxManager.getSandbox).mockReturnValue({
        name: "Docker",
        slug: "docker",
        createdAt: 1,
        updatedAt: 1,
      });

      const result = await orchestrator.createSession({
        cwd: "/repo",
        branch: "feat/new",
        envSlug: "docker",
        sandboxEnabled: true,
        sandboxSlug: "docker",
      });

      expect(result.ok).toBe(true);
      // Host git ops should NOT have been called
      expect(gitUtils.gitFetch).not.toHaveBeenCalled();
      expect(gitUtils.checkoutOrCreateBranch).not.toHaveBeenCalled();
      expect(gitUtils.gitPull).not.toHaveBeenCalled();
      // In-container git ops SHOULD have been called
      expect(containerManager.gitOpsInContainer).toHaveBeenCalledWith(
        "cid-1",
        expect.objectContaining({ branch: "feat/new", currentBranch: "main" }),
      );
    });

    it("returns 400 when in-container checkout fails", async () => {
      vi.mocked(gitUtils.getRepoInfo).mockReturnValue({
        repoRoot: "/repo",
        repoName: "my-repo",
        currentBranch: "main",
        defaultBranch: "main",
        isWorktree: false,
      } as any);
      vi.mocked(envManager.getEnv).mockReturnValue({
        name: "E",
        slug: "e",
        variables: { CLAUDE_CODE_OAUTH_TOKEN: "token" },
        createdAt: 1,
        updatedAt: 1,
      } as any);
      vi.mocked(sandboxManager.getSandbox).mockReturnValue({
        name: "E",
        slug: "e",
        createdAt: 1,
        updatedAt: 1,
      });
      vi.mocked(containerManager.gitOpsInContainer).mockReturnValue({
        fetchOk: true,
        checkoutOk: false,
        pullOk: false,
        errors: ['branch "nonexistent" does not exist'],
      });

      const result = await orchestrator.createSession({
        cwd: "/repo",
        branch: "nonexistent",
        sandboxEnabled: true,
        sandboxSlug: "e",
        envSlug: "e",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Failed to checkout branch");
        expect(result.status).toBe(400);
        expect(containerManager.removeContainer).toHaveBeenCalled();
      }
    });

    it("passes resumeSessionAt and forkSession to launcher", async () => {
      const result = await orchestrator.createSession({
        cwd: "/test",
        resumeSessionAt: "  existing-session-id  ",
        forkSession: true,
      });

      expect(result.ok).toBe(true);
      expect(deps.launcher.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          resumeSessionAt: "existing-session-id",
          forkSession: true,
        }),
      );
    });

    it("passes backendType codex to launcher", async () => {
      const result = await orchestrator.createSession({
        cwd: "/test",
        backend: "codex",
        model: "gpt-5",
      });

      expect(result.ok).toBe(true);
      expect(deps.launcher.launch).toHaveBeenCalledWith(
        expect.objectContaining({ backendType: "codex", model: "gpt-5" }),
      );
    });

    it("catches thrown errors from launcher.launch and returns 503", async () => {
      deps.launcher.launch.mockImplementation(() => {
        throw new Error("CLI binary not found");
      });

      const result = await orchestrator.createSession({ cwd: "/test" });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("CLI binary not found");
        expect(result.status).toBe(503);
      }
    });

    it("cleans up container when launcher.launch throws after container creation", async () => {
      // If a container was created but launcher.launch throws, the container
      // should be cleaned up to avoid leaking Docker resources.
      vi.mocked(envManager.getEnv).mockReturnValue({
        name: "E",
        slug: "e",
        variables: { CLAUDE_CODE_OAUTH_TOKEN: "token" },
        createdAt: 1,
        updatedAt: 1,
      } as any);
      deps.launcher.launch.mockImplementation(() => {
        throw new Error("Binary not found");
      });

      const result = await orchestrator.createSession({
        cwd: "/test",
        sandboxEnabled: true,
        envSlug: "e",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Failed to launch CLI");
        expect(result.status).toBe(503);
      }
      // Container should be cleaned up after launch failure
      expect(containerManager.removeContainer).toHaveBeenCalled();
    });
  });

  // ── Streaming Session Creation ────────────────────────────────────────────

  describe("createSessionStreaming()", () => {
    it("calls progress callback during creation", async () => {
      const onProgress = vi.fn();
      const result = await orchestrator.createSessionStreaming({ cwd: "/test" }, onProgress);

      expect(result.ok).toBe(true);
      // Should have at least resolving_env and launching_cli progress events
      expect(onProgress).toHaveBeenCalledWith("resolving_env", expect.any(String), "in_progress");
      expect(onProgress).toHaveBeenCalledWith("resolving_env", expect.any(String), "done");
      expect(onProgress).toHaveBeenCalledWith("launching_cli", expect.any(String), "in_progress");
      expect(onProgress).toHaveBeenCalledWith("launching_cli", expect.any(String), "done");
    });

    it("emits correct label for codex backend", async () => {
      const onProgress = vi.fn();
      await orchestrator.createSessionStreaming({ cwd: "/test", backend: "codex" }, onProgress);

      expect(onProgress).toHaveBeenCalledWith("launching_cli", "Launching Codex...", "in_progress");
    });

    it("emits correct label for claude backend", async () => {
      const onProgress = vi.fn();
      await orchestrator.createSessionStreaming({ cwd: "/test" }, onProgress);

      expect(onProgress).toHaveBeenCalledWith("launching_cli", "Launching Claude Code...", "in_progress");
    });
  });

  // ── Kill ───────────────────────────────────────────────────────────────────

  describe("killSession()", () => {
    it("kills launcher and removes container", async () => {
      deps.launcher.kill.mockResolvedValue(true);
      const result = await orchestrator.killSession("s1");

      expect(result.ok).toBe(true);
      expect(deps.launcher.kill).toHaveBeenCalledWith("s1");
      expect(containerManager.removeContainer).toHaveBeenCalledWith("s1");
    });

    it("returns ok=false and does not remove container when session not found", async () => {
      // When launcher.kill returns false (session not found), removeContainer
      // should NOT be called to preserve the original behavior from routes.ts.
      deps.launcher.kill.mockResolvedValue(false);
      const result = await orchestrator.killSession("s1");

      expect(result.ok).toBe(false);
      expect(containerManager.removeContainer).not.toHaveBeenCalled();
    });
  });

  // ── Relaunch ──────────────────────────────────────────────────────────────

  describe("relaunchSession()", () => {
    it("delegates to launcher.relaunch", async () => {
      const result = await orchestrator.relaunchSession("s1");

      expect(result.ok).toBe(true);
      expect(deps.launcher.relaunch).toHaveBeenCalledWith("s1");
    });

    it("rejects relaunching archived sessions", async () => {
      deps.launcher.getSession.mockReturnValue({ archived: true });

      const result = await orchestrator.relaunchSession("s1");

      expect(result.ok).toBe(false);
      expect(result.error).toContain("archived");
      expect(deps.launcher.relaunch).not.toHaveBeenCalled();
    });

    it("propagates error from launcher.relaunch", async () => {
      deps.launcher.relaunch.mockResolvedValue({ ok: false, error: "Container removed externally" });

      const result = await orchestrator.relaunchSession("s1");

      expect(result.ok).toBe(false);
      expect(result.error).toContain("Container removed externally");
    });
  });

  // ── Archive ───────────────────────────────────────────────────────────────

  describe("archiveSession()", () => {
    it("kills, removes container, unwatches PR, and marks archived", async () => {
      const result = await orchestrator.archiveSession("s1");

      expect(result.ok).toBe(true);
      expect(deps.launcher.kill).toHaveBeenCalledWith("s1");
      expect(containerManager.removeContainer).toHaveBeenCalledWith("s1");
      expect(deps.prPoller.unwatch).toHaveBeenCalledWith("s1");
      expect(deps.launcher.setArchived).toHaveBeenCalledWith("s1", true);
      expect(deps.sessionStore.setArchived).toHaveBeenCalledWith("s1", true);
    });

    it("performs Linear transition when linearTransition=backlog", async () => {
      // Set up linked issue
      vi.mocked(sessionLinearIssues.getLinearIssue).mockReturnValue({
        id: "issue-1",
        identifier: "ENG-42",
        teamId: "team-1",
        connectionId: "conn-1",
      } as any);
      vi.mocked(resolveApiKey).mockReturnValue({ apiKey: "lin_api_123", connectionId: "conn-1" });
      vi.mocked(fetchLinearTeamStates).mockResolvedValue([
        {
          id: "team-1",
          key: "ENG",
          name: "Engineering",
          states: [
            { id: "state-backlog", name: "Backlog", type: "backlog" },
            { id: "state-done", name: "Done", type: "completed" },
          ],
        },
      ]);
      vi.mocked(transitionLinearIssue).mockResolvedValue({
        ok: true,
        issue: { id: "issue-1", identifier: "ENG-42", stateName: "Backlog", stateType: "backlog" },
      } as any);

      const result = await orchestrator.archiveSession("s1", { linearTransition: "backlog" });

      expect(result.ok).toBe(true);
      expect(fetchLinearTeamStates).toHaveBeenCalledWith("lin_api_123");
      expect(transitionLinearIssue).toHaveBeenCalledWith("issue-1", "state-backlog", "lin_api_123", "conn-1");
      // Session should still be archived even with transition
      expect(deps.launcher.setArchived).toHaveBeenCalledWith("s1", true);
    });

    it("archives even when Linear transition fails", async () => {
      vi.mocked(sessionLinearIssues.getLinearIssue).mockReturnValue({
        id: "issue-1",
        identifier: "ENG-42",
        teamId: "team-1",
        connectionId: "conn-1",
      } as any);
      vi.mocked(resolveApiKey).mockReturnValue({ apiKey: "lin_api_123", connectionId: "conn-1" });
      vi.mocked(fetchLinearTeamStates).mockResolvedValue([{
        id: "team-1",
        key: "ENG",
        name: "Engineering",
        states: [{ id: "state-backlog", name: "Backlog", type: "backlog" }],
      }]);
      vi.mocked(transitionLinearIssue).mockResolvedValue({ ok: false, error: "API error" });

      const result = await orchestrator.archiveSession("s1", { linearTransition: "backlog" });

      expect(result.ok).toBe(true);
      expect(result.linearTransition?.ok).toBe(false);
      expect(deps.launcher.setArchived).toHaveBeenCalledWith("s1", true);
    });

    it("catches thrown transition errors and still archives", async () => {
      // When transitionLinearIssue throws, archiveSession should catch it
      // and continue with the archive operation.
      vi.mocked(sessionLinearIssues.getLinearIssue).mockReturnValue({
        id: "issue-1",
        identifier: "ENG-42",
        teamId: "team-1",
        connectionId: "conn-1",
      } as any);
      vi.mocked(resolveApiKey).mockReturnValue({ apiKey: "lin_api_123", connectionId: "conn-1" });
      vi.mocked(fetchLinearTeamStates).mockResolvedValue([{
        id: "team-1",
        key: "ENG",
        name: "Engineering",
        states: [{ id: "state-backlog", name: "Backlog", type: "backlog" }],
      }]);
      vi.mocked(transitionLinearIssue).mockRejectedValue(new Error("Network error"));

      const result = await orchestrator.archiveSession("s1", { linearTransition: "backlog" });

      expect(result.ok).toBe(true);
      expect(result.linearTransition).toEqual({ ok: false, error: "Transition failed unexpectedly" });
      expect(deps.launcher.setArchived).toHaveBeenCalledWith("s1", true);
    });

    it("skips transition when no target state found", async () => {
      // When the target state cannot be found (e.g., team has no backlog state),
      // linearTransition should be marked as skipped.
      vi.mocked(sessionLinearIssues.getLinearIssue).mockReturnValue({
        id: "issue-1",
        identifier: "ENG-42",
        teamId: "team-1",
        connectionId: "conn-1",
      } as any);
      vi.mocked(resolveApiKey).mockReturnValue({ apiKey: "lin_api_123", connectionId: "conn-1" });
      vi.mocked(fetchLinearTeamStates).mockResolvedValue([{
        id: "team-1",
        key: "ENG",
        name: "Engineering",
        states: [{ id: "state-done", name: "Done", type: "completed" }],
        // No backlog state
      }]);

      const result = await orchestrator.archiveSession("s1", { linearTransition: "backlog" });

      expect(result.ok).toBe(true);
      expect(result.linearTransition).toEqual({ ok: true, skipped: true });
    });

    it("cleans up worktree during archive", async () => {
      deps.worktreeTracker.getBySession.mockReturnValue({
        sessionId: "s1",
        repoRoot: "/repo",
        branch: "feat",
        worktreePath: "/wt/feat",
        createdAt: 1000,
      });

      const result = await orchestrator.archiveSession("s1");

      expect(result.ok).toBe(true);
      expect(result.worktree).toMatchObject({ cleaned: true, path: "/wt/feat" });
      expect(gitUtils.removeWorktree).toHaveBeenCalledWith("/repo", "/wt/feat", {
        force: false,
        branchToDelete: undefined,
      });
    });
  });

  // ── Delete ────────────────────────────────────────────────────────────────

  describe("deleteSession()", () => {
    it("performs full cleanup: kill, container, worktree, PR, Linear, bridge", async () => {
      const result = await orchestrator.deleteSession("s1");

      expect(result.ok).toBe(true);
      expect(deps.launcher.kill).toHaveBeenCalledWith("s1");
      expect(containerManager.removeContainer).toHaveBeenCalledWith("s1");
      expect(deps.prPoller.unwatch).toHaveBeenCalledWith("s1");
      expect(sessionLinearIssues.removeLinearIssue).toHaveBeenCalledWith("s1");
      expect(deps.launcher.removeSession).toHaveBeenCalledWith("s1");
      expect(deps.wsBridge.closeSession).toHaveBeenCalledWith("s1");
    });

    it("returns worktree cleanup info", async () => {
      deps.worktreeTracker.getBySession.mockReturnValue({
        sessionId: "s1",
        repoRoot: "/repo",
        branch: "feat",
        worktreePath: "/wt/feat",
        createdAt: 1000,
      });

      const result = await orchestrator.deleteSession("s1");

      expect(result.ok).toBe(true);
      expect(result.worktree).toMatchObject({ cleaned: true, path: "/wt/feat" });
    });

    it("passes branchToDelete when actualBranch differs from branch", async () => {
      // When actualBranch differs from branch, the worktree-unique branch should be deleted.
      // force=true in deleteSession means "skip dirty check", but removeWorktree gets
      // force: dirty (isWorktreeDirty() result), which is false by default.
      deps.worktreeTracker.getBySession.mockReturnValue({
        sessionId: "s1",
        repoRoot: "/repo",
        branch: "feat",
        actualBranch: "feat-wt-1234",
        worktreePath: "/wt/feat",
        createdAt: 1000,
      });

      await orchestrator.deleteSession("s1");

      expect(gitUtils.removeWorktree).toHaveBeenCalledWith("/repo", "/wt/feat", {
        force: false,
        branchToDelete: "feat-wt-1234",
      });
    });

    it("removes container unconditionally during delete (unlike kill)", async () => {
      // deleteSession always removes the container, even if kill reports no process found,
      // because we're permanently removing the session and must clean up all resources.
      deps.launcher.kill.mockResolvedValue(false);

      await orchestrator.deleteSession("s1");

      expect(containerManager.removeContainer).toHaveBeenCalledWith("s1");
    });
  });

  // ── Unarchive ─────────────────────────────────────────────────────────────

  describe("unarchiveSession()", () => {
    it("unsets archived flag on launcher and store", () => {
      const result = orchestrator.unarchiveSession("s1");

      expect(result.ok).toBe(true);
      expect(deps.launcher.setArchived).toHaveBeenCalledWith("s1", false);
      expect(deps.sessionStore.setArchived).toHaveBeenCalledWith("s1", false);
    });
  });

  // ── Auto-naming ───────────────────────────────────────────────────────────

  describe("handleAutoNaming (via initialize)", () => {
    it("generates title when anthropicApiKey is set and no name exists", async () => {
      vi.mocked(settingsManager.getSettings).mockReturnValue({
        anthropicApiKey: "sk-ant-123",
      } as any);
      vi.mocked(sessionNames.getName).mockReturnValue(undefined);
      deps.launcher.getSession.mockReturnValue({ model: "claude-sonnet-4-6" });
      vi.mocked(generateSessionTitle).mockResolvedValue("Test Title");

      orchestrator.initialize();
      companionBus.emit("session:first-turn-completed", { sessionId: "s1", firstUserMessage: "Hello world" });
      await new Promise(r => setTimeout(r, 0));

      expect(generateSessionTitle).toHaveBeenCalledWith("Hello world", "claude-sonnet-4-6");
      expect(sessionNames.setName).toHaveBeenCalledWith("s1", "Test Title");
      expect(deps.wsBridge.broadcastNameUpdate).toHaveBeenCalledWith("s1", "Test Title");
    });

    it("skips naming when session already has a name", async () => {
      vi.mocked(settingsManager.getSettings).mockReturnValue({ anthropicApiKey: "sk-ant-123" } as any);
      vi.mocked(sessionNames.getName).mockReturnValue("Existing Name");

      orchestrator.initialize();
      companionBus.emit("session:first-turn-completed", { sessionId: "s1", firstUserMessage: "Hello" });
      await new Promise(r => setTimeout(r, 0));

      expect(generateSessionTitle).not.toHaveBeenCalled();
    });

    it("skips naming when no API key is configured", async () => {
      vi.mocked(settingsManager.getSettings).mockReturnValue({ anthropicApiKey: "" } as any);

      orchestrator.initialize();
      companionBus.emit("session:first-turn-completed", { sessionId: "s1", firstUserMessage: "Hello" });
      await new Promise(r => setTimeout(r, 0));

      expect(generateSessionTitle).not.toHaveBeenCalled();
    });
  });

  // ── Reconnection watchdog ─────────────────────────────────────────────────

  describe("startReconnectionWatchdog (via initialize)", () => {
    it("does nothing when no sessions are starting", () => {
      deps.launcher.getStartingSessions.mockReturnValue([]);
      orchestrator.initialize();

      // No error thrown, no relaunch called
      expect(deps.launcher.getStartingSessions).toHaveBeenCalled();
    });

    it("schedules relaunch for stale starting sessions", async () => {
      vi.useFakeTimers();
      try {
        deps.launcher.getStartingSessions
          .mockReturnValueOnce([{ sessionId: "s1", state: "starting" }])
          .mockReturnValueOnce([{ sessionId: "s1", state: "starting" }]);

        orchestrator.initialize();

        // Advance past the reconnect grace period (default 30s)
        await vi.advanceTimersByTimeAsync(30_000);

        expect(deps.launcher.relaunch).toHaveBeenCalledWith("s1");
      } finally {
        vi.useRealTimers();
      }
    });

    it("skips archived sessions during reconnection watchdog", async () => {
      vi.useFakeTimers();
      try {
        deps.launcher.getStartingSessions
          .mockReturnValueOnce([{ sessionId: "s1", state: "starting" }])
          .mockReturnValueOnce([{ sessionId: "s1", state: "starting", archived: true }]);

        orchestrator.initialize();
        await vi.advanceTimersByTimeAsync(30_000);

        // Should NOT relaunch archived session
        expect(deps.launcher.relaunch).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ── Worktree cleanup ──────────────────────────────────────────────────────

  describe("cleanupWorktree (via deleteSession/archiveSession)", () => {
    it("returns undefined when session has no worktree mapping", async () => {
      deps.worktreeTracker.getBySession.mockReturnValue(null);

      const result = await orchestrator.deleteSession("s1");

      expect(result.worktree).toBeUndefined();
    });

    it("does not remove worktree in use by another session", async () => {
      deps.worktreeTracker.getBySession.mockReturnValue({
        sessionId: "s1",
        repoRoot: "/repo",
        branch: "feat",
        worktreePath: "/wt/feat",
        createdAt: 1000,
      });
      deps.worktreeTracker.isWorktreeInUse.mockReturnValue(true);

      const result = await orchestrator.deleteSession("s1");

      expect(result.worktree).toMatchObject({ cleaned: false, path: "/wt/feat" });
      expect(gitUtils.removeWorktree).not.toHaveBeenCalled();
    });

    it("does not remove dirty worktree unless forced", async () => {
      deps.worktreeTracker.getBySession.mockReturnValue({
        sessionId: "s1",
        repoRoot: "/repo",
        branch: "feat",
        worktreePath: "/wt/feat",
        createdAt: 1000,
      });
      vi.mocked(gitUtils.isWorktreeDirty).mockReturnValue(true);

      // Archive without force
      const result = await orchestrator.archiveSession("s1");

      expect(result.worktree).toMatchObject({ cleaned: false, dirty: true, path: "/wt/feat" });
      expect(gitUtils.removeWorktree).not.toHaveBeenCalled();
    });

    it("force-removes dirty worktree when force=true", async () => {
      deps.worktreeTracker.getBySession.mockReturnValue({
        sessionId: "s1",
        repoRoot: "/repo",
        branch: "feat",
        worktreePath: "/wt/feat",
        createdAt: 1000,
      });
      vi.mocked(gitUtils.isWorktreeDirty).mockReturnValue(true);

      const result = await orchestrator.archiveSession("s1", { force: true });

      expect(result.worktree).toMatchObject({ cleaned: true, path: "/wt/feat" });
      expect(gitUtils.removeWorktree).toHaveBeenCalledWith("/repo", "/wt/feat", {
        force: true,
        branchToDelete: undefined,
      });
    });
  });

  // ── getSession ────────────────────────────────────────────────────────────

  describe("getSession()", () => {
    it("delegates to launcher.getSession", () => {
      const mockSession = { sessionId: "s1", state: "connected" };
      deps.launcher.getSession.mockReturnValue(mockSession);

      const result = orchestrator.getSession("s1");

      expect(result).toBe(mockSession);
      expect(deps.launcher.getSession).toHaveBeenCalledWith("s1");
    });

    it("returns undefined for unknown session", () => {
      deps.launcher.getSession.mockReturnValue(undefined);

      const result = orchestrator.getSession("unknown");

      expect(result).toBeUndefined();
    });
  });

  // ── Auto-relaunch ──────────────────────────────────────────────────────────

  describe("handleAutoRelaunch (via initialize)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("skips relaunch for archived sessions", async () => {
      // Archived sessions should not be auto-relaunched.
      deps.launcher.getSession.mockReturnValue({ archived: true } as any);
      orchestrator.initialize();

      companionBus.emit("session:relaunch-needed", { sessionId: "s1" });
      // Advance past the grace period and flush microtasks for the async handler
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(deps.launcher.relaunch).not.toHaveBeenCalled();
    });

    it("skips relaunch when CLI reconnects during grace period", async () => {
      // During the grace period, if CLI reconnects, relaunch should be skipped.
      deps.launcher.getSession.mockReturnValue({ archived: false } as any);
      deps.wsBridge.isCliConnected.mockReturnValue(true);
      orchestrator.initialize();

      companionBus.emit("session:relaunch-needed", { sessionId: "s1" });
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(deps.launcher.relaunch).not.toHaveBeenCalled();
    });

    it("skips relaunch when session state is 'connected' after grace", async () => {
      // If the session reconnects (state=connected) during grace, skip relaunch.
      deps.launcher.getSession
        .mockReturnValueOnce({ archived: false } as any) // check archived
        .mockReturnValueOnce({ state: "connected" } as any); // after grace
      deps.wsBridge.isCliConnected.mockReturnValue(false);
      orchestrator.initialize();

      companionBus.emit("session:relaunch-needed", { sessionId: "s1" });
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(deps.launcher.relaunch).not.toHaveBeenCalled();
    });

    it("skips relaunch when session is still starting", async () => {
      // A session in "starting" state should not be relaunched — it's still
      // initializing. The starting guard at line 771 prevents this.
      deps.launcher.getSession
        .mockReturnValueOnce({ archived: false } as any) // check archived
        .mockReturnValueOnce({ state: "starting", pid: process.pid } as any); // after grace: still starting
      deps.wsBridge.isCliConnected.mockReturnValue(false);
      orchestrator.initialize();

      companionBus.emit("session:relaunch-needed", { sessionId: "s1" });
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(deps.launcher.relaunch).not.toHaveBeenCalled();
    });

    it("relaunches exited session even when PID was recycled to a live process", async () => {
      // After idle-kill, the session state is "exited" but the PID field stays
      // set. If the kernel recycles the PID to a different process, we must NOT
      // let the PID check prevent relaunch. The fix skips PID liveness for
      // exited sessions entirely.
      deps.launcher.getSession
        .mockReturnValueOnce({ archived: false } as any) // check archived
        .mockReturnValueOnce({ state: "exited", pid: process.pid } as any); // after grace: PID is alive (recycled!)
      deps.wsBridge.isCliConnected.mockReturnValue(false);
      orchestrator.initialize();

      companionBus.emit("session:relaunch-needed", { sessionId: "s1" });
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.advanceTimersByTimeAsync(0);

      // Should relaunch despite the PID being alive — exited sessions skip PID check
      expect(deps.launcher.relaunch).toHaveBeenCalledWith("s1");
    });

    it("skips relaunch for containerized session when container is still running", async () => {
      // For non-exited containerized sessions, use container liveness instead
      // of PID check. If the container is running, skip relaunch to let the
      // CLI reconnect on its own. Use state "starting" to bypass the earlier
      // connected/running guard and actually exercise the container check path.
      vi.mocked(containerManager.isContainerAlive).mockReturnValue("running" as any);
      deps.launcher.getSession
        .mockReturnValueOnce({ archived: false } as any) // check archived
        .mockReturnValueOnce({ state: "starting", containerId: "cid-abc", pid: 99999 } as any); // after grace
      deps.wsBridge.isCliConnected.mockReturnValue(false);
      orchestrator.initialize();

      companionBus.emit("session:relaunch-needed", { sessionId: "s1" });
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(containerManager.isContainerAlive).toHaveBeenCalledWith("cid-abc");
      expect(deps.launcher.relaunch).not.toHaveBeenCalled();
    });

    it("relaunches exited containerized session even when container was removed", async () => {
      // If a container was removed externally (e.g. docker prune), the session
      // state becomes "exited". The fix skips PID/container checks for exited
      // sessions entirely, so relaunch proceeds.
      vi.mocked(containerManager.isContainerAlive).mockReturnValue("not_found" as any);
      deps.launcher.getSession
        .mockReturnValueOnce({ archived: false } as any) // check archived
        .mockReturnValueOnce({ state: "exited", containerId: "cid-dead", pid: 99999 } as any); // after grace
      deps.wsBridge.isCliConnected.mockReturnValue(false);
      orchestrator.initialize();

      companionBus.emit("session:relaunch-needed", { sessionId: "s1" });
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.advanceTimersByTimeAsync(0);

      // Exited sessions skip the container/PID check entirely, so relaunch proceeds
      expect(deps.launcher.relaunch).toHaveBeenCalledWith("s1");
    });

    it("relaunches when CLI does not reconnect after grace period", async () => {
      // When CLI disconnects and doesn't reconnect, the session should be relaunched.
      deps.launcher.getSession
        .mockReturnValueOnce({ archived: false } as any) // First call: check archived
        .mockReturnValueOnce({ state: "exited", pid: undefined } as any); // Second call: after grace
      deps.wsBridge.isCliConnected.mockReturnValue(false);
      orchestrator.initialize();

      companionBus.emit("session:relaunch-needed", { sessionId: "s1" });
      // Advance past grace (10s) + cooldown (5s) and flush microtasks
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(deps.launcher.relaunch).toHaveBeenCalledWith("s1");
    });

    it("preserves retry budget when relaunch returns ok:false without error", async () => {
      // A silent failure (ok:false, no error string) should NOT reset the auto-relaunch
      // count. This prevents unlimited retries when the launcher silently fails.
      deps.launcher.getSession.mockReturnValue({ archived: false, state: "exited", pid: undefined } as any);
      deps.wsBridge.isCliConnected.mockReturnValue(false);
      deps.launcher.relaunch.mockResolvedValue({ ok: false }); // no error string
      orchestrator.initialize();

      // Trigger 3 silent-failure relaunches (the max)
      for (let i = 0; i < 3; i++) {
        companionBus.emit("session:relaunch-needed", { sessionId: "s1" });
        await vi.advanceTimersByTimeAsync(15_000);
        await vi.advanceTimersByTimeAsync(0);
      }

      // 4th attempt should hit the MAX_AUTO_RELAUNCHES limit
      companionBus.emit("session:relaunch-needed", { sessionId: "s1" });
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.advanceTimersByTimeAsync(0);

      // Only 3 relaunch calls, 4th was rejected at the limit
      expect(deps.launcher.relaunch).toHaveBeenCalledTimes(3);
    });

    it("stops after MAX_AUTO_RELAUNCHES attempts", async () => {
      // After reaching the max auto-relaunch count, give up and notify the user.
      // Mock relaunch to return an error so the count doesn't get cleared
      // (successful relaunch clears the count, simulating recovery).
      deps.launcher.getSession.mockReturnValue({ archived: false, state: "exited", pid: undefined } as any);
      deps.wsBridge.isCliConnected.mockReturnValue(false);
      deps.launcher.relaunch.mockResolvedValue({ ok: false, error: "crashed again" });
      orchestrator.initialize();

      // Trigger 3 relaunches (the max). Each needs the relaunchingSet cooldown
      // to clear before the next attempt can proceed.
      for (let i = 0; i < 3; i++) {
        companionBus.emit("session:relaunch-needed", { sessionId: "s1" });
        await vi.advanceTimersByTimeAsync(15_000);
        await vi.advanceTimersByTimeAsync(0);
      }

      // 4th attempt should be rejected since count reached MAX_AUTO_RELAUNCHES
      companionBus.emit("session:relaunch-needed", { sessionId: "s1" });
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.advanceTimersByTimeAsync(0);

      // relaunch should have been called 3 times, not 4
      expect(deps.launcher.relaunch).toHaveBeenCalledTimes(3);
      // Should broadcast error message to session
      expect(deps.wsBridge.broadcastToSession).toHaveBeenCalledWith("s1", expect.objectContaining({
        type: "error",
        message: expect.stringContaining("keeps crashing"),
      }));
    });
  });

  // ── Proactive keepalive ───────────────────────────────────────────────────

  describe("proactive keepalive (auto-relaunch on exit without browser)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("schedules relaunch when CLI exits unexpectedly", async () => {
      // When a CLI process exits (crash) and is not an intentional kill,
      // the orchestrator should proactively relaunch it after a short delay
      // even if no browsers are connected.
      deps.launcher.getSession.mockReturnValue({
        archived: false,
        state: "exited",
        pid: undefined,
      } as any);
      deps.wsBridge.isCliConnected.mockReturnValue(false);
      orchestrator.initialize();

      // Simulate CLI exit
      companionBus.emit("session:exited", { sessionId: "s1", exitCode: 1 });

      // Advance past keepalive delay (3s) + relaunch grace (10s) + cooldown
      await vi.advanceTimersByTimeAsync(3_000);
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(deps.launcher.relaunch).toHaveBeenCalledWith("s1");
    });

    it("does NOT proactively relaunch after idle-kill (intentional kill)", async () => {
      // Idle-kill is intentional — the proactive keepalive should NOT trigger.
      // The debounce timer in ws-bridge is also cancelled by the idle-kill
      // handler (via cancelDisconnectTimer), so session:relaunch-needed never
      // fires from the debounce path. A browser reconnect CAN still relaunch.
      deps.launcher.getSession.mockReturnValue({
        archived: false,
        state: "exited",
        pid: undefined,
      } as any);
      deps.wsBridge.isCliConnected.mockReturnValue(false);
      orchestrator.initialize();

      // Simulate idle-kill followed by session exit
      companionBus.emit("session:idle-kill", { sessionId: "s1" });
      companionBus.emit("session:exited", { sessionId: "s1", exitCode: 0 });

      // Advance well past any possible keepalive delay
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(0);

      // Proactive keepalive should NOT have relaunched
      expect(deps.launcher.relaunch).not.toHaveBeenCalled();
      // Disconnect debounce timer should have been cancelled
      expect(deps.wsBridge.cancelDisconnectTimer).toHaveBeenCalledWith("s1");
    });

    it("does NOT relaunch archived sessions", async () => {
      // Archived sessions should not be relaunched proactively.
      deps.launcher.getSession.mockReturnValue({
        archived: true,
        state: "exited",
        pid: undefined,
      } as any);
      orchestrator.initialize();

      companionBus.emit("session:exited", { sessionId: "s1", exitCode: 1 });

      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(deps.launcher.relaunch).not.toHaveBeenCalled();
    });

    it("uses exponential backoff on repeated crashes (3s → 6s → 12s)", async () => {
      // Each crash should increase the delay before the keepalive timer fires.
      let relaunchCount = 0;
      deps.launcher.getSession.mockReturnValue({
        archived: false,
        state: "exited",
        pid: undefined,
      } as any);
      deps.wsBridge.isCliConnected.mockReturnValue(false);
      // Simulate repeated failures so the auto-relaunch count increments
      deps.launcher.relaunch.mockImplementation(async () => {
        relaunchCount++;
        return { ok: false, error: "crashed" };
      });
      orchestrator.initialize();

      // ── 1st crash: 3s keepalive delay ──
      companionBus.emit("session:exited", { sessionId: "s1", exitCode: 1 });

      // At 2s: nothing yet (3s delay not elapsed)
      await vi.advanceTimersByTimeAsync(2_000);
      expect(relaunchCount).toBe(0);

      // At 3s: keepalive fires → handleAutoRelaunch with 10s grace
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(relaunchCount).toBe(1);

      // ── 2nd crash: 6s keepalive delay ──
      companionBus.emit("session:exited", { sessionId: "s1", exitCode: 1 });

      // At 5s: nothing yet (6s delay not elapsed)
      await vi.advanceTimersByTimeAsync(5_000);
      expect(relaunchCount).toBe(1);

      // At 6s: keepalive fires → handleAutoRelaunch with 10s grace
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(relaunchCount).toBe(2);

      // ── 3rd crash: 12s keepalive delay ──
      companionBus.emit("session:exited", { sessionId: "s1", exitCode: 1 });

      // At 11s: nothing yet (12s delay not elapsed)
      await vi.advanceTimersByTimeAsync(11_000);
      expect(relaunchCount).toBe(2);

      // At 12s: keepalive fires → handleAutoRelaunch with 10s grace
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(relaunchCount).toBe(3);
    });

    it("cancels keepalive timer on session delete", async () => {
      // If user deletes a session while a keepalive timer is pending,
      // the timer should be cancelled and no relaunch should occur.
      deps.launcher.getSession.mockReturnValue({
        archived: false,
        state: "exited",
        pid: undefined,
      } as any);
      deps.wsBridge.isCliConnected.mockReturnValue(false);
      orchestrator.initialize();

      // Simulate CLI exit
      companionBus.emit("session:exited", { sessionId: "s1", exitCode: 1 });

      // Delete the session before the keepalive timer fires
      await orchestrator.deleteSession("s1");

      // Advance past all delays
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(0);

      // kill() is called by deleteSession, but relaunch should NOT be
      expect(deps.launcher.relaunch).not.toHaveBeenCalled();
    });
  });
});
