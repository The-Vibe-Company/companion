import { vi, describe, it, expect, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be declared before any imports that reference them
// ---------------------------------------------------------------------------

// Mock env-manager
vi.mock("./env-manager.js", () => ({
  getEnv: vi.fn(() => null),
  listEnvs: vi.fn(() => []),
}));

// Mock sandbox-manager
vi.mock("./sandbox-manager.js", () => ({
  getSandbox: vi.fn(() => null),
  listSandboxes: vi.fn(() => []),
}));

// Mock git-utils
vi.mock("./git-utils.js", () => ({
  getRepoInfo: vi.fn(() => null),
  gitFetch: vi.fn(() => ({ success: true, output: "" })),
  gitPull: vi.fn(() => ({ success: true, output: "" })),
  ensureWorktree: vi.fn(() => ({
    worktreePath: "/tmp/worktree",
    actualBranch: "feature-branch",
  })),
  checkoutOrCreateBranch: vi.fn(() => ({ created: false })),
}));

// Mock container-manager
vi.mock("./container-manager.js", () => ({
  containerManager: {
    createContainer: vi.fn(() => ({
      containerId: "abc123",
      name: "test-container",
      image: "test-image",
      portMappings: [],
      hostCwd: "/workspace",
      containerCwd: "/workspace",
      state: "running",
    })),
    copyWorkspaceToContainer: vi.fn(async () => {}),
    reseedGitAuth: vi.fn(),
    gitOpsInContainer: vi.fn(() => ({
      fetchOk: true,
      checkoutOk: true,
      pullOk: true,
      errors: [],
    })),
    execInContainerAsync: vi.fn(async () => ({
      exitCode: 0,
      output: "ok",
    })),
    removeContainer: vi.fn(),
    retrack: vi.fn(),
  },
}));

// Mock claude-container-auth
vi.mock("./claude-container-auth.js", () => ({
  hasContainerClaudeAuth: vi.fn(() => true),
}));

// Mock codex-container-auth
vi.mock("./codex-container-auth.js", () => ({
  hasContainerCodexAuth: vi.fn(() => true),
}));

// Mock image-pull-manager
vi.mock("./image-pull-manager.js", () => ({
  imagePullManager: {
    isReady: vi.fn(() => true),
    getState: vi.fn(() => ({ status: "ready" })),
    ensureImage: vi.fn(),
    waitForReady: vi.fn(async () => true),
    onProgress: vi.fn(() => vi.fn()),
  },
}));

// Mock linear-connections
vi.mock("./linear-connections.js", () => ({
  getConnection: vi.fn(() => null),
}));

// Mock linear-prompt-builder
vi.mock("./linear-prompt-builder.js", () => ({
  buildLinearSystemPrompt: vi.fn(() => "linear prompt"),
}));

// Mock commands-discovery
vi.mock("./commands-discovery.js", () => ({
  discoverCommandsAndSkills: vi.fn(async () => ({
    slash_commands: [],
    skills: [],
  })),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  executeSessionCreation,
  SessionCreationError,
  type SessionCreationDeps,
  type ProgressCallback,
} from "./session-creation-service.js";
import * as envManager from "./env-manager.js";
import * as sandboxManager from "./sandbox-manager.js";
import * as gitUtils from "./git-utils.js";
import { containerManager } from "./container-manager.js";
import { hasContainerClaudeAuth } from "./claude-container-auth.js";
import { hasContainerCodexAuth } from "./codex-container-auth.js";
import { imagePullManager } from "./image-pull-manager.js";
import { getConnection } from "./linear-connections.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal mock deps that satisfy SessionCreationDeps */
function makeDeps(): SessionCreationDeps {
  return {
    launcher: {
      launch: vi.fn(() => ({
        sessionId: "sess-1",
        state: "starting",
        cwd: "/workspace",
        backendType: "claude",
        createdAt: Date.now(),
      })),
    } as unknown as SessionCreationDeps["launcher"],
    wsBridge: {
      markContainerized: vi.fn(),
      injectSystemPrompt: vi.fn(),
      prePopulateCommands: vi.fn(),
    } as unknown as SessionCreationDeps["wsBridge"],
    worktreeTracker: {
      addMapping: vi.fn(),
    } as unknown as SessionCreationDeps["worktreeTracker"],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("executeSessionCreation", () => {
  let deps: SessionCreationDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = makeDeps();
  });

  // -- Happy path: minimal body creates a session --
  it("creates a session with minimal body (defaults to claude backend)", async () => {
    const result = await executeSessionCreation({ cwd: "/workspace" }, deps);

    expect(result.session.sessionId).toBe("sess-1");
    expect(result.session.state).toBe("starting");
    expect(result.session.cwd).toBe("/workspace");
    expect(deps.launcher.launch).toHaveBeenCalledOnce();
  });

  // -- Backend validation --
  it("throws SessionCreationError for invalid backend", async () => {
    await expect(
      executeSessionCreation({ backend: "invalid" }, deps),
    ).rejects.toThrow(SessionCreationError);

    try {
      await executeSessionCreation({ backend: "invalid" }, deps);
    } catch (e) {
      expect(e).toBeInstanceOf(SessionCreationError);
      expect((e as SessionCreationError).statusCode).toBe(400);
    }
  });

  // -- Environment resolution --
  it("injects environment variables from envSlug", async () => {
    vi.mocked(envManager.getEnv).mockReturnValueOnce({
      slug: "test-env",
      name: "Test Env",
      variables: { MY_KEY: "my_value" },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await executeSessionCreation(
      { cwd: "/workspace", envSlug: "test-env" },
      deps,
    );

    expect(deps.launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({ MY_KEY: "my_value" }),
      }),
    );
  });

  // -- Sandbox resolution --
  it("throws 404 for missing sandbox when sandboxEnabled", async () => {
    try {
      await executeSessionCreation(
        { cwd: "/workspace", sandboxEnabled: true, sandboxSlug: "missing" },
        deps,
      );
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SessionCreationError);
      expect((e as SessionCreationError).statusCode).toBe(404);
      expect((e as SessionCreationError).step).toBe("resolving_env");
    }
  });

  // -- Branch validation --
  it("rejects invalid branch names", async () => {
    try {
      await executeSessionCreation(
        { cwd: "/workspace", branch: "my branch; rm -rf /" },
        deps,
      );
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SessionCreationError);
      expect((e as SessionCreationError).statusCode).toBe(400);
      expect((e as SessionCreationError).step).toBe("checkout_branch");
    }
  });

  // -- Git operations: worktree path --
  it("creates a worktree when useWorktree is true", async () => {
    vi.mocked(gitUtils.getRepoInfo).mockReturnValue({
      repoRoot: "/workspace",
      defaultBranch: "main",
      currentBranch: "main",
      repoName: "workspace",
      isWorktree: false,
    });

    await executeSessionCreation(
      { cwd: "/workspace", branch: "feature", useWorktree: true },
      deps,
    );

    expect(gitUtils.ensureWorktree).toHaveBeenCalledWith(
      "/workspace",
      "feature",
      expect.objectContaining({ forceNew: true }),
    );
  });

  // -- Git operations: checkout path --
  it("checks out branch when useWorktree is false", async () => {
    vi.mocked(gitUtils.getRepoInfo).mockReturnValue({
      repoRoot: "/workspace",
      defaultBranch: "main",
      currentBranch: "main",
      repoName: "workspace",
      isWorktree: false,
    });

    await executeSessionCreation(
      { cwd: "/workspace", branch: "feature" },
      deps,
    );

    expect(gitUtils.checkoutOrCreateBranch).toHaveBeenCalledWith(
      "/workspace",
      "feature",
      expect.objectContaining({ defaultBranch: "main" }),
    );
    expect(gitUtils.gitPull).toHaveBeenCalled();
  });

  // -- Container auth check: Claude --
  it("throws 400 when containerized Claude has no auth", async () => {
    vi.mocked(hasContainerClaudeAuth).mockReturnValueOnce(false);

    try {
      await executeSessionCreation(
        { cwd: "/workspace", container: { image: "test:latest" } },
        deps,
      );
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SessionCreationError);
      expect((e as SessionCreationError).statusCode).toBe(400);
      expect((e as SessionCreationError).message).toContain("ANTHROPIC_API_KEY");
    }
  });

  // -- Container auth check: Codex --
  it("throws 400 when containerized Codex has no auth", async () => {
    vi.mocked(hasContainerCodexAuth).mockReturnValueOnce(false);

    try {
      await executeSessionCreation(
        { cwd: "/workspace", backend: "codex", container: { image: "test:latest" } },
        deps,
      );
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SessionCreationError);
      expect((e as SessionCreationError).statusCode).toBe(400);
      expect((e as SessionCreationError).message).toContain("OPENAI_API_KEY");
    }
  });

  // -- Image pull failure --
  it("throws 503 when image pull fails", async () => {
    vi.mocked(imagePullManager.isReady).mockReturnValueOnce(false);
    vi.mocked(imagePullManager.waitForReady).mockResolvedValueOnce(false);
    vi.mocked(imagePullManager.getState).mockReturnValueOnce({
      status: "error",
      error: "pull failed",
    } as any);

    try {
      await executeSessionCreation(
        { cwd: "/workspace", container: { image: "broken:latest" } },
        deps,
      );
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SessionCreationError);
      expect((e as SessionCreationError).statusCode).toBe(503);
      expect((e as SessionCreationError).step).toBe("pulling_image");
    }
  });

  // -- Container create failure --
  it("throws 503 when container creation fails", async () => {
    vi.mocked(containerManager.createContainer).mockImplementationOnce(() => {
      throw new Error("docker not found");
    });

    try {
      await executeSessionCreation(
        { cwd: "/workspace", container: { image: "test:latest" } },
        deps,
      );
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SessionCreationError);
      expect((e as SessionCreationError).statusCode).toBe(503);
      expect((e as SessionCreationError).step).toBe("creating_container");
    }
  });

  // -- Workspace copy failure triggers cleanup --
  it("removes container when workspace copy fails", async () => {
    vi.mocked(containerManager.copyWorkspaceToContainer).mockRejectedValueOnce(
      new Error("copy failed"),
    );

    try {
      await executeSessionCreation(
        { cwd: "/workspace", container: { image: "test:latest" } },
        deps,
      );
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SessionCreationError);
      expect((e as SessionCreationError).statusCode).toBe(503);
      expect((e as SessionCreationError).step).toBe("copying_workspace");
      // Verify cleanup happened
      expect(containerManager.removeContainer).toHaveBeenCalled();
    }
  });

  // -- Container git checkout failure triggers cleanup --
  it("removes container when in-container git checkout fails", async () => {
    vi.mocked(containerManager.gitOpsInContainer).mockReturnValueOnce({
      fetchOk: true,
      checkoutOk: false,
      pullOk: false,
      errors: ["checkout error"],
    } as any);

    try {
      await executeSessionCreation(
        { cwd: "/workspace", container: { image: "test:latest" }, branch: "feature" },
        deps,
      );
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SessionCreationError);
      expect((e as SessionCreationError).statusCode).toBe(400);
      expect((e as SessionCreationError).step).toBe("checkout_branch");
      expect(containerManager.removeContainer).toHaveBeenCalled();
    }
  });

  // -- Progress callback is invoked in order --
  it("calls onProgress at each step in correct order", async () => {
    const steps: string[] = [];
    const onProgress: ProgressCallback = async (step, _label, status) => {
      steps.push(`${step}:${status}`);
    };

    await executeSessionCreation({ cwd: "/workspace" }, deps, onProgress);

    // Should have resolving_env (in_progress, done) and launching_cli (in_progress, done)
    expect(steps).toContain("resolving_env:in_progress");
    expect(steps).toContain("resolving_env:done");
    expect(steps).toContain("launching_cli:in_progress");
    expect(steps).toContain("launching_cli:done");

    // resolving_env should come before launching_cli
    const envIdx = steps.indexOf("resolving_env:in_progress");
    const launchIdx = steps.indexOf("launching_cli:in_progress");
    expect(envIdx).toBeLessThan(launchIdx);
  });

  // -- No progress callback does not throw --
  it("works without progress callback (REST mode)", async () => {
    const result = await executeSessionCreation({ cwd: "/workspace" }, deps);
    expect(result.session.sessionId).toBe("sess-1");
  });

  // -- Linear connection injection --
  it("injects LINEAR_API_KEY and system prompt when connection exists", async () => {
    vi.mocked(getConnection).mockReturnValueOnce({
      id: "conn-1",
      name: "Test",
      apiKey: "lin_api_test",
    } as any);

    await executeSessionCreation(
      { cwd: "/workspace", linearConnectionId: "conn-1" },
      deps,
    );

    expect(deps.launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({ LINEAR_API_KEY: "lin_api_test" }),
      }),
    );
    // For claude backend, injectSystemPrompt should be called
    expect(deps.wsBridge.injectSystemPrompt).toHaveBeenCalledWith(
      "sess-1",
      expect.any(String),
    );
  });

  // -- Post-launch: container retracking --
  it("retracks container and marks session as containerized after launch", async () => {
    await executeSessionCreation(
      { cwd: "/workspace", container: { image: "test:latest" } },
      deps,
    );

    expect(containerManager.retrack).toHaveBeenCalledWith("abc123", "sess-1");
    expect(deps.wsBridge.markContainerized).toHaveBeenCalledWith("sess-1", "/workspace");
  });

  // -- Post-launch: worktree tracking --
  it("tracks worktree mapping after launch", async () => {
    vi.mocked(gitUtils.getRepoInfo).mockReturnValue({
      repoRoot: "/workspace",
      defaultBranch: "main",
      currentBranch: "main",
      repoName: "workspace",
      isWorktree: false,
    });

    await executeSessionCreation(
      { cwd: "/workspace", branch: "feature", useWorktree: true },
      deps,
    );

    expect(deps.worktreeTracker.addMapping).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-1",
        branch: "feature",
      }),
    );
  });

  // -- Post-launch: slash commands discovery --
  it("pre-populates slash commands after launch", async () => {
    await executeSessionCreation({ cwd: "/workspace" }, deps);

    expect(deps.wsBridge.prePopulateCommands).toHaveBeenCalledWith(
      "sess-1",
      expect.any(Array),
      expect.any(Array),
    );
  });

  // -- Resume session --
  it("passes resumeSessionAt and forkSession to launcher", async () => {
    await executeSessionCreation(
      { cwd: "/workspace", resumeSessionAt: "sess-old", forkSession: true },
      deps,
    );

    expect(deps.launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        resumeSessionAt: "sess-old",
        forkSession: true,
      }),
    );
  });

  // -- Codex backend --
  it("sets codex-specific launch options for codex backend", async () => {
    await executeSessionCreation(
      { cwd: "/workspace", backend: "codex" },
      deps,
    );

    expect(deps.launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        backendType: "codex",
        codexInternetAccess: true,
        codexSandbox: "danger-full-access",
      }),
    );
  });

  // -- Init script: success --
  it("runs init script when sandbox has one configured", async () => {
    vi.mocked(sandboxManager.getSandbox).mockReturnValueOnce({
      slug: "test-sandbox",
      name: "Test Sandbox",
      initScript: "echo hello",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as any);

    await executeSessionCreation(
      { cwd: "/workspace", sandboxEnabled: true, sandboxSlug: "test-sandbox" },
      deps,
    );

    // Init script should have been executed via execInContainerAsync
    expect(containerManager.execInContainerAsync).toHaveBeenCalledWith(
      "abc123",
      ["sh", "-lc", "echo hello"],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    expect(deps.launcher.launch).toHaveBeenCalled();
  });

  // -- Init script: non-zero exit triggers cleanup --
  it("cleans up container when init script fails with non-zero exit", async () => {
    vi.mocked(sandboxManager.getSandbox).mockReturnValueOnce({
      slug: "test-sandbox",
      name: "Test Sandbox",
      initScript: "exit 1",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as any);
    vi.mocked(containerManager.execInContainerAsync).mockResolvedValueOnce({
      exitCode: 1,
      output: "script failed",
    });

    try {
      await executeSessionCreation(
        { cwd: "/workspace", sandboxEnabled: true, sandboxSlug: "test-sandbox" },
        deps,
      );
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SessionCreationError);
      expect((e as SessionCreationError).statusCode).toBe(503);
      expect((e as SessionCreationError).step).toBe("running_init_script");
      expect(containerManager.removeContainer).toHaveBeenCalled();
    }
  });

  // -- Init script: exception triggers cleanup --
  it("cleans up container when init script throws", async () => {
    vi.mocked(sandboxManager.getSandbox).mockReturnValueOnce({
      slug: "test-sandbox",
      name: "Test Sandbox",
      initScript: "echo boom",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as any);
    vi.mocked(containerManager.execInContainerAsync).mockRejectedValueOnce(
      new Error("exec timeout"),
    );

    try {
      await executeSessionCreation(
        { cwd: "/workspace", sandboxEnabled: true, sandboxSlug: "test-sandbox" },
        deps,
      );
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SessionCreationError);
      expect((e as SessionCreationError).statusCode).toBe(503);
      expect((e as SessionCreationError).step).toBe("running_init_script");
      expect(containerManager.removeContainer).toHaveBeenCalled();
    }
  });


  // -- launcher.launch() failure cleans up container --
  it("cleans up container when launcher.launch() throws", async () => {
    // Set up a containerized session via container.image (triggers effectiveImage)
    vi.mocked(hasContainerClaudeAuth).mockReturnValueOnce(true);

    // Make launcher.launch() throw
    deps.launcher.launch = vi.fn(() => {
      throw new Error("spawn failed");
    });

    try {
      await executeSessionCreation(
        { backend: "claude", cwd: "/workspace", container: { image: "test:latest" } },
        deps,
      );
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SessionCreationError);
      expect((e as SessionCreationError).statusCode).toBe(503);
      expect((e as SessionCreationError).step).toBe("launching_cli");
      expect((e as SessionCreationError).message).toContain("spawn failed");
      // Verify container cleanup
      expect(containerManager.removeContainer).toHaveBeenCalled();
    }
  });

  // -- cwd validation for containerized sessions --
  it("throws 400 when cwd is missing for containerized session", async () => {
    try {
      await executeSessionCreation(
        { container: { image: "test:latest" } },
        deps,
      );
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SessionCreationError);
      expect((e as SessionCreationError).statusCode).toBe(400);
      expect((e as SessionCreationError).message).toContain("cwd");
    }
  });
});

describe("SessionCreationError", () => {
  it("carries statusCode and step", () => {
    const err = new SessionCreationError("test error", 404, "resolving_env");
    expect(err.message).toBe("test error");
    expect(err.statusCode).toBe(404);
    expect(err.step).toBe("resolving_env");
    expect(err.name).toBe("SessionCreationError");
  });

  it("defaults statusCode to 500", () => {
    const err = new SessionCreationError("server error");
    expect(err.statusCode).toBe(500);
    expect(err.step).toBeUndefined();
  });
});
