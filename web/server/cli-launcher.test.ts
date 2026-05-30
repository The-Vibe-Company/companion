import { vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── Hoisted mocks ──────────────────────────────────────────────────────────

// Mock randomUUID so session IDs are deterministic
vi.mock("node:crypto", () => ({ randomUUID: () => "test-session-id" }));

// Mock path-resolver for binary resolution
const mockResolveBinary = vi.hoisted(() => vi.fn((_name: string): string | null => "/usr/bin/claude"));
const mockGetEnrichedPath = vi.hoisted(() => vi.fn(() => "/usr/bin:/usr/local/bin"));
vi.mock("./path-resolver.js", () => ({ resolveBinary: mockResolveBinary, getEnrichedPath: mockGetEnrichedPath }));

// Mock container-manager for container validation in relaunch
const mockIsContainerAlive = vi.hoisted(() => vi.fn((): "running" | "stopped" | "missing" => "running"));
const mockHasBinaryInContainer = vi.hoisted(() => vi.fn((): boolean => true));
const mockStartContainer = vi.hoisted(() => vi.fn());
const mockGetContainerById = vi.hoisted(() => vi.fn((_containerId: string) => undefined as any));
vi.mock("./container-manager.js", () => ({
  containerManager: {
    isContainerAlive: mockIsContainerAlive,
    hasBinaryInContainer: mockHasBinaryInContainer,
    startContainer: mockStartContainer,
    getContainerById: mockGetContainerById,
  },
}));

// Mock fs operations for worktree guardrails (CLAUDE.md in .claude dirs)
const mockMkdirSync = vi.hoisted(() => vi.fn());
const mockExistsSync = vi.hoisted(() => vi.fn((..._args: any[]) => false));
const mockReadFileSync = vi.hoisted(() => vi.fn((..._args: any[]) => ""));
const mockWriteFileSync = vi.hoisted(() => vi.fn());
const isMockedPath = vi.hoisted(() => (path: string): boolean => {
  return path.includes(".claude") || path.startsWith("/tmp/worktrees/") || path.startsWith("/tmp/main-repo");
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    mkdirSync: (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockMkdirSync(...args);
      }
      return actual.mkdirSync(...args);
    },
    existsSync: (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockExistsSync(...args);
      }
      return actual.existsSync(...args);
    },
    readFileSync: (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockReadFileSync(...args);
      }
      return actual.readFileSync(...args);
    },
    writeFileSync: (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockWriteFileSync(...args);
      }
      return actual.writeFileSync(...args);
    },
  };
});

// ─── Imports (after mocks) ───────────────────────────────────────────────────

import { SessionStore } from "./session-store.js";
import { CliLauncher } from "./cli-launcher.js";
import { companionBus } from "./event-bus.js";

// ─── Bun.spawn mock ─────────────────────────────────────────────────────────

let exitResolve: (code: number) => void;

function createMockProc(pid = 12345) {
  let resolve: (code: number) => void;
  const exitedPromise = new Promise<number>((r) => {
    resolve = r;
  });
  exitResolve = resolve!;
  return {
    pid,
    kill: vi.fn(),
    exited: exitedPromise,
    stdout: null,
    stderr: null,
  };
}

function createMockCodexProc(pid = 12345) {
  let resolve: (code: number) => void;
  const exitedPromise = new Promise<number>((r) => {
    resolve = r;
  });
  exitResolve = resolve!;
  return {
    pid,
    kill: vi.fn(),
    exited: exitedPromise,
    stdin: new WritableStream<Uint8Array>(),
    stdout: new ReadableStream<Uint8Array>(),
    stderr: new ReadableStream<Uint8Array>(),
  };
}

function createPendingCodexWsProxyProc(pid = 12345) {
  let resolve: (code: number) => void;
  const exitedPromise = new Promise<number>((r) => {
    resolve = r;
  });

  // Keep stdout open so CodexAdapter can wait for JSON-RPC responses without
  // immediately failing initialization in tests that only care about launcher lifecycle.
  const stdout = new ReadableStream<Uint8Array>({ start() {} });
  const stderr = new ReadableStream<Uint8Array>({ start() {} });

  return {
    proc: {
      pid,
      kill: vi.fn(),
      exited: exitedPromise,
      stdin: new WritableStream<Uint8Array>(),
      stdout,
      stderr,
    },
    resolveExit: resolve!,
  };
}

const mockSpawn = vi.fn();
const mockListen = vi.hoisted(() => vi.fn(() => ({ stop: vi.fn() })));
vi.stubGlobal("Bun", { spawn: mockSpawn, listen: mockListen });

// ─── Test setup ──────────────────────────────────────────────────────────────

let tempDir: string;
let store: SessionStore;
let launcher: CliLauncher;

beforeEach(() => {
  vi.clearAllMocks();
  companionBus.clear();
  delete process.env.COMPANION_CONTAINER_SDK_HOST;
  // Default to stdio for most tests; WS launcher behavior is covered explicitly below.
  process.env.COMPANION_CODEX_TRANSPORT = "stdio";
  tempDir = mkdtempSync(join(tmpdir(), "launcher-test-"));
  store = new SessionStore(tempDir);
  launcher = new CliLauncher(3456);
  launcher.setStore(store);
  mockSpawn.mockReturnValue(createMockProc());
  mockListen.mockImplementation(() => ({ stop: vi.fn() }));
  mockResolveBinary.mockReturnValue("/usr/bin/claude");
  mockGetContainerById.mockReturnValue(undefined);
});

afterEach(() => {
  delete process.env.COMPANION_CODEX_TRANSPORT;
  delete process.env.COMPANION_CODEX_WS_CONNECT_TIMEOUT_MS;
  delete process.env.COMPANION_CODEX_PONG_TIMEOUT_MS;
  rmSync(tempDir, { recursive: true, force: true });
});

// ─── launch ──────────────────────────────────────────────────────────────────

describe("launch", () => {
  it("creates a session with a UUID and starting state", () => {
    const info = launcher.launch({ cwd: "/tmp/project" });

    expect(info.sessionId).toBe("test-session-id");
    expect(info.state).toBe("starting");
    expect(info.cwd).toBe("/tmp/project");
    expect(info.createdAt).toBeGreaterThan(0);
  });

  it("spawns CLI with correct --sdk-url and flags", () => {
    launcher.launch({ cwd: "/tmp/project" });

    expect(mockSpawn).toHaveBeenCalledOnce();
    const [cmdAndArgs, options] = mockSpawn.mock.calls[0];

    // Binary should be resolved via execSync
    expect(cmdAndArgs[0]).toBe("/usr/bin/claude");

    // Core required flags
    expect(cmdAndArgs).toContain("--sdk-url");
    expect(cmdAndArgs).toContain("ws://localhost:3456/ws/cli/test-session-id");
    expect(cmdAndArgs).toContain("--print");
    expect(cmdAndArgs).toContain("--output-format");
    expect(cmdAndArgs).toContain("stream-json");
    expect(cmdAndArgs).toContain("--input-format");
    expect(cmdAndArgs).toContain("--include-partial-messages");
    expect(cmdAndArgs).toContain("--verbose");

    // Headless prompt
    expect(cmdAndArgs).toContain("-p");
    expect(cmdAndArgs).toContain("");

    // Spawn options
    expect(options.cwd).toBe("/tmp/project");
    expect(options.stdout).toBe("pipe");
    expect(options.stderr).toBe("pipe");
  });

  it("passes --model when provided", () => {
    launcher.launch({ model: "claude-opus-4-7", cwd: "/tmp" });

    const [cmdAndArgs] = mockSpawn.mock.calls[0];
    const modelIdx = cmdAndArgs.indexOf("--model");
    expect(modelIdx).toBeGreaterThan(-1);
    expect(cmdAndArgs[modelIdx + 1]).toBe("claude-opus-4-7");
  });

  it("passes --permission-mode when provided", () => {
    // Allow bypassPermissions through even when tests run as root
    process.env.COMPANION_FORCE_BYPASS_AS_ROOT = "1";
    try {
      launcher.launch({ permissionMode: "bypassPermissions", cwd: "/tmp" });

      const [cmdAndArgs] = mockSpawn.mock.calls[0];
      const modeIdx = cmdAndArgs.indexOf("--permission-mode");
      expect(modeIdx).toBeGreaterThan(-1);
      expect(cmdAndArgs[modeIdx + 1]).toBe("bypassPermissions");
    } finally {
      delete process.env.COMPANION_FORCE_BYPASS_AS_ROOT;
    }
  });

  it("preserves bypassPermissions for containerized sessions (container IS the sandbox)", () => {
    launcher.launch({
      cwd: "/tmp/project",
      permissionMode: "bypassPermissions",
      containerId: "abc123def456",
      containerName: "companion-test",
    });

    const [cmdAndArgs] = mockSpawn.mock.calls[0];
    // With bash -lc wrapping, CLI args are in the last element as a single string
    const bashCmd = cmdAndArgs[cmdAndArgs.length - 1];
    expect(bashCmd).toContain("--permission-mode");
    expect(bashCmd).toContain("bypassPermissions");
  });

  it("downgrades bypassPermissions to acceptEdits when host launcher runs as root", () => {
    const originalGetuid = process.getuid;
    Object.defineProperty(process, "getuid", {
      value: () => 0,
      configurable: true,
    });

    try {
      launcher.launch({
        cwd: "/tmp/project",
        permissionMode: "bypassPermissions",
      });

      const [cmdAndArgs] = mockSpawn.mock.calls[0];
      const modeIdx = cmdAndArgs.indexOf("--permission-mode");
      expect(modeIdx).toBeGreaterThan(-1);
      expect(cmdAndArgs[modeIdx + 1]).toBe("acceptEdits");
    } finally {
      Object.defineProperty(process, "getuid", {
        value: originalGetuid,
        configurable: true,
      });
    }
  });

  it("uses COMPANION_CONTAINER_SDK_HOST for containerized sdk-url when set", () => {
    process.env.COMPANION_CONTAINER_SDK_HOST = "172.17.0.1";
    launcher.launch({
      cwd: "/tmp/project",
      containerId: "abc123def456",
      containerName: "companion-test",
    });

    const [cmdAndArgs] = mockSpawn.mock.calls[0];
    // With bash -lc wrapping, CLI args are in the last element as a single string
    const bashCmd = cmdAndArgs[cmdAndArgs.length - 1];
    expect(bashCmd).toContain("--sdk-url");
    expect(bashCmd).toContain("ws://172.17.0.1:3456/ws/cli/test-session-id");
  });

  it("passes --allowedTools for each tool", () => {
    launcher.launch({
      allowedTools: ["Read", "Write", "Bash"],
      cwd: "/tmp",
    });

    const [cmdAndArgs] = mockSpawn.mock.calls[0];
    // Each tool gets its own --allowedTools flag
    const toolFlags = cmdAndArgs.reduce(
      (acc: string[], arg: string, i: number) => {
        if (arg === "--allowedTools") acc.push(cmdAndArgs[i + 1]);
        return acc;
      },
      [],
    );
    expect(toolFlags).toEqual(["Read", "Write", "Bash"]);
  });

  it("passes branching flags when resumeSessionAt/forkSession are provided", () => {
    // These flags enable starting a new branch of work from a prior session point.
    launcher.launch({
      cwd: "/tmp",
      resumeSessionAt: "prior-session-123",
      forkSession: true,
    });

    const [cmdAndArgs] = mockSpawn.mock.calls[0];
    const resumeAtIdx = cmdAndArgs.indexOf("--resume-session-at");
    expect(resumeAtIdx).toBeGreaterThan(-1);
    expect(cmdAndArgs[resumeAtIdx + 1]).toBe("prior-session-123");
    expect(cmdAndArgs).toContain("--fork-session");
  });

  it("resolves binary path via resolveBinary when not absolute", () => {
    mockResolveBinary.mockReturnValue("/usr/local/bin/claude-dev");
    launcher.launch({ claudeBinary: "claude-dev", cwd: "/tmp" });

    expect(mockResolveBinary).toHaveBeenCalledWith("claude-dev");
    const [cmdAndArgs] = mockSpawn.mock.calls[0];
    expect(cmdAndArgs[0]).toBe("/usr/local/bin/claude-dev");
  });

  it("passes absolute binary path directly to resolveBinary", () => {
    mockResolveBinary.mockReturnValue("/opt/bin/claude");
    launcher.launch({
      claudeBinary: "/opt/bin/claude",
      cwd: "/tmp",
    });

    expect(mockResolveBinary).toHaveBeenCalledWith("/opt/bin/claude");
    const [cmdAndArgs] = mockSpawn.mock.calls[0];
    expect(cmdAndArgs[0]).toBe("/opt/bin/claude");
  });

  it("sets state=exited and exitCode=127 when claude binary not found", () => {
    mockResolveBinary.mockReturnValue(null);

    const info = launcher.launch({ cwd: "/tmp" });

    expect(info.state).toBe("exited");
    expect(info.exitCode).toBe(127);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("stores container metadata when containerId provided", () => {
    const info = launcher.launch({
      cwd: "/tmp/project",
      containerId: "abc123def456",
      containerName: "companion-session-1",
      containerImage: "ubuntu:22.04",
    });

    expect(info.containerId).toBe("abc123def456");
    expect(info.containerName).toBe("companion-session-1");
    expect(info.containerImage).toBe("ubuntu:22.04");
    expect(info.containerCwd).toBe("/workspace");
  });

  it("stores explicit containerCwd when provided", () => {
    mockSpawn.mockReturnValueOnce(createMockCodexProc());
    const info = launcher.launch({
      cwd: "/tmp/project",
      backendType: "codex",
      containerId: "abc123def456",
      containerName: "companion-session-1",
      containerImage: "ubuntu:22.04",
      containerCwd: "/workspace/repo",
    });

    expect(info.containerCwd).toBe("/workspace/repo");
  });

  it("uses docker exec -i with bash -lc for containerized Claude sessions", () => {
    // bash -lc ensures ~/.bashrc is sourced so nvm-installed CLIs are on PATH
    launcher.launch({
      cwd: "/tmp/project",
      containerId: "abc123def456",
      containerName: "companion-session-1",
    });

    const [cmdAndArgs] = mockSpawn.mock.calls[0];
    expect(cmdAndArgs[0]).toBe("docker");
    expect(cmdAndArgs[1]).toBe("exec");
    expect(cmdAndArgs[2]).toBe("-i");
    // Should wrap the CLI command in bash -lc for login shell PATH
    expect(cmdAndArgs).toContain("bash");
    expect(cmdAndArgs).toContain("-lc");
  });

  it("sets session pid from spawned process", () => {
    mockSpawn.mockReturnValue(createMockProc(99999));
    const info = launcher.launch({ cwd: "/tmp" });
    expect(info.pid).toBe(99999);
  });

  it("unsets CLAUDECODE to avoid CLI nesting guard", () => {
    launcher.launch({ cwd: "/tmp" });

    const [, options] = mockSpawn.mock.calls[0];
    expect(options.env.CLAUDECODE).toBeUndefined();
  });

  it("merges custom env variables", () => {
    launcher.launch({
      cwd: "/tmp",
      env: { MY_VAR: "hello" },
    });

    const [, options] = mockSpawn.mock.calls[0];
    expect(options.env.MY_VAR).toBe("hello");
    expect(options.env.CLAUDECODE).toBeUndefined();
  });

  it("enables Codex web search when codexInternetAccess=true", () => {
    // Use a fake path where no sibling `node` exists, so the spawn uses
    // the codex binary directly (the explicit-node path is tested separately).
    mockResolveBinary.mockReturnValue("/opt/fake/codex");
    mockSpawn.mockReturnValueOnce(createMockCodexProc());

    launcher.launch({
      backendType: "codex",
      cwd: "/tmp/project",
      codexInternetAccess: true,
      codexSandbox: "danger-full-access",
    });

    const [cmdAndArgs, options] = mockSpawn.mock.calls[0];
    expect(cmdAndArgs[0]).toBe("/opt/fake/codex");
    expect(cmdAndArgs).toContain("app-server");
    expect(cmdAndArgs).toContain("--enable");
    expect(cmdAndArgs).toContain("multi_agent");
    expect(cmdAndArgs).toContain("-c");
    expect(cmdAndArgs).toContain("tools.webSearch=true");
    expect(options.cwd).toBe("/tmp/project");
  });

  it("disables Codex web search when codexInternetAccess=false", () => {
    mockResolveBinary.mockReturnValue("/opt/fake/codex");
    mockSpawn.mockReturnValueOnce(createMockCodexProc());

    launcher.launch({
      backendType: "codex",
      cwd: "/tmp/project",
      codexInternetAccess: false,
      codexSandbox: "workspace-write",
    });

    const [cmdAndArgs] = mockSpawn.mock.calls[0];
    expect(cmdAndArgs).toContain("app-server");
    expect(cmdAndArgs).toContain("--enable");
    expect(cmdAndArgs).toContain("multi_agent");
    expect(cmdAndArgs).toContain("-c");
    expect(cmdAndArgs).toContain("tools.webSearch=false");
  });

  it("spawns codex via sibling node binary to bypass shebang issues", () => {
    // When a `node` binary exists next to the resolved `codex`, the launcher
    // should invoke `node <codex-script>` directly instead of relying on
    // the #!/usr/bin/env node shebang (which may resolve to system Node v12).
    // Create a temp dir with both `codex` and `node` files to simulate nvm layout.
    const tmpBinDir = mkdtempSync(join(tmpdir(), "codex-test-"));
    const fakeCodex = join(tmpBinDir, "codex");
    const fakeNode = join(tmpBinDir, "node");
    const { writeFileSync: realWriteFileSync } = require("node:fs");
    realWriteFileSync(fakeCodex, "#!/usr/bin/env node\n");
    realWriteFileSync(fakeNode, "#!/bin/sh\n");

    mockResolveBinary.mockReturnValue(fakeCodex);
    mockSpawn.mockReturnValueOnce(createMockCodexProc());

    launcher.launch({
      backendType: "codex",
      cwd: "/tmp/project",
      codexSandbox: "workspace-write",
    });

    const [cmdAndArgs] = mockSpawn.mock.calls[0];
    // Sibling node exists, so it should use explicit node invocation
    expect(cmdAndArgs[0]).toBe(fakeNode);
    // The codex script path should be arg 1
    expect(cmdAndArgs[1]).toContain("codex");
    expect(cmdAndArgs).toContain("app-server");
    expect(cmdAndArgs).toContain("--enable");
    expect(cmdAndArgs).toContain("multi_agent");

    // Cleanup
    rmSync(tmpBinDir, { recursive: true, force: true });
  });

  it("sets state=exited and exitCode=127 when codex binary not found", () => {
    mockResolveBinary.mockReturnValue(null);

    const info = launcher.launch({
      backendType: "codex",
      cwd: "/tmp/project",
      codexSandbox: "workspace-write",
    });

    expect(info.state).toBe("exited");
    expect(info.exitCode).toBe(127);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

});

// ─── state management ────────────────────────────────────────────────────────

describe("state management", () => {
  describe("markConnected", () => {
    it("sets state to connected", () => {
      launcher.launch({ cwd: "/tmp" });
      launcher.markConnected("test-session-id");

      const session = launcher.getSession("test-session-id");
      expect(session?.state).toBe("connected");
    });

    it("does nothing for unknown session", () => {
      // Should not throw
      launcher.markConnected("nonexistent");
    });
  });

  describe("setCLISessionId", () => {
    it("stores the CLI session ID", () => {
      launcher.launch({ cwd: "/tmp" });
      launcher.setCLISessionId("test-session-id", "cli-internal-abc");

      const session = launcher.getSession("test-session-id");
      expect(session?.cliSessionId).toBe("cli-internal-abc");
    });

    it("does nothing for unknown session", () => {
      // Should not throw
      launcher.setCLISessionId("nonexistent", "cli-id");
    });
  });

  describe("isAlive", () => {
    it("returns true for non-exited session", () => {
      launcher.launch({ cwd: "/tmp" });
      expect(launcher.isAlive("test-session-id")).toBe(true);
    });

    it("returns false for exited session", async () => {
      launcher.launch({ cwd: "/tmp" });

      // Simulate process exit
      exitResolve(0);
      // Allow the .then callback in spawnCLI to run
      await new Promise((r) => setTimeout(r, 10));

      expect(launcher.isAlive("test-session-id")).toBe(false);
    });

    it("returns false for unknown session", () => {
      expect(launcher.isAlive("nonexistent")).toBe(false);
    });
  });

  describe("listSessions", () => {
    it("returns all sessions", () => {
      // Because randomUUID is mocked to always return the same value,
      // we need to test with a single launch. But we can verify the list.
      launcher.launch({ cwd: "/tmp" });
      const sessions = launcher.listSessions();

      expect(sessions).toHaveLength(1);
      expect(sessions[0].sessionId).toBe("test-session-id");
    });

    it("returns empty array when no sessions exist", () => {
      expect(launcher.listSessions()).toEqual([]);
    });
  });

  describe("getSession", () => {
    it("returns a specific session", () => {
      launcher.launch({ cwd: "/tmp/myproject" });

      const session = launcher.getSession("test-session-id");
      expect(session).toBeDefined();
      expect(session?.cwd).toBe("/tmp/myproject");
    });

    it("returns undefined for unknown session", () => {
      expect(launcher.getSession("nonexistent")).toBeUndefined();
    });
  });

  describe("pruneExited", () => {
    it("removes exited sessions and returns count", async () => {
      launcher.launch({ cwd: "/tmp" });

      // Simulate process exit
      exitResolve(0);
      await new Promise((r) => setTimeout(r, 10));

      expect(launcher.getSession("test-session-id")?.state).toBe("exited");

      const pruned = launcher.pruneExited();
      expect(pruned).toBe(1);
      expect(launcher.listSessions()).toHaveLength(0);
    });

    it("returns 0 when no sessions are exited", () => {
      launcher.launch({ cwd: "/tmp" });
      const pruned = launcher.pruneExited();
      expect(pruned).toBe(0);
      expect(launcher.listSessions()).toHaveLength(1);
    });
  });

  describe("setArchived", () => {
    it("sets the archived flag on a session", () => {
      launcher.launch({ cwd: "/tmp" });
      launcher.setArchived("test-session-id", true);

      const session = launcher.getSession("test-session-id");
      expect(session?.archived).toBe(true);
    });

    it("can unset the archived flag", () => {
      launcher.launch({ cwd: "/tmp" });
      launcher.setArchived("test-session-id", true);
      launcher.setArchived("test-session-id", false);

      const session = launcher.getSession("test-session-id");
      expect(session?.archived).toBe(false);
    });

    it("does nothing for unknown session", () => {
      // Should not throw
      launcher.setArchived("nonexistent", true);
    });
  });

  describe("removeSession", () => {
    it("deletes session from internal maps", () => {
      launcher.launch({ cwd: "/tmp" });
      expect(launcher.getSession("test-session-id")).toBeDefined();

      launcher.removeSession("test-session-id");
      expect(launcher.getSession("test-session-id")).toBeUndefined();
      expect(launcher.listSessions()).toHaveLength(0);
    });

    it("does nothing for unknown session", () => {
      // Should not throw
      launcher.removeSession("nonexistent");
    });
  });
});

// ─── kill ────────────────────────────────────────────────────────────────────

describe("kill", () => {
  it("sends SIGTERM via proc.kill", async () => {
    launcher.launch({ cwd: "/tmp" });

    // Grab the mock proc
    const mockProc = mockSpawn.mock.results[0].value;

    // Resolve the exit promise so kill() doesn't wait on the timeout
    setTimeout(() => exitResolve(0), 5);

    const result = await launcher.kill("test-session-id");

    expect(result).toBe(true);
    expect(mockProc.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("marks session as exited", async () => {
    launcher.launch({ cwd: "/tmp" });

    setTimeout(() => exitResolve(0), 5);
    await launcher.kill("test-session-id");

    const session = launcher.getSession("test-session-id");
    expect(session?.state).toBe("exited");
    expect(session?.exitCode).toBe(-1);
  });

  it("returns false for unknown session", async () => {
    const result = await launcher.kill("nonexistent");
    expect(result).toBe(false);
  });
});

// ─── relaunch ────────────────────────────────────────────────────────────────

describe("relaunch", () => {
  it("kills old process and spawns new one with --resume", async () => {
    // Create first proc whose exit resolves immediately when killed
    let resolveFirst: (code: number) => void;
    const firstProc = {
      pid: 12345,
      kill: vi.fn(() => { resolveFirst(0); }),
      exited: new Promise<number>((r) => { resolveFirst = r; }),
      stdout: null,
      stderr: null,
    };
    mockSpawn.mockReturnValueOnce(firstProc);

    launcher.launch({ cwd: "/tmp/project", model: "claude-sonnet-4-6" });
    launcher.setCLISessionId("test-session-id", "cli-resume-id");

    // Second proc for the relaunch — never exits during test
    const secondProc = createMockProc(54321);
    mockSpawn.mockReturnValueOnce(secondProc);

    const result = await launcher.relaunch("test-session-id");
    expect(result).toEqual({ ok: true });

    // Old process should have been killed
    expect(firstProc.kill).toHaveBeenCalledWith("SIGTERM");

    // New process should be spawned with --resume
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    const [cmdAndArgs] = mockSpawn.mock.calls[1];
    expect(cmdAndArgs).toContain("--resume");
    expect(cmdAndArgs).toContain("cli-resume-id");

    // Session state should be reset to starting (set by relaunch before spawnCLI)
    // Allow microtask queue to flush
    await new Promise((r) => setTimeout(r, 10));
    const session = launcher.getSession("test-session-id");
    expect(session?.state).toBe("starting");
  });

  it("reuses launch env variables during relaunch", async () => {
    let resolveFirst: (code: number) => void;
    const firstProc = {
      pid: 12345,
      kill: vi.fn(() => { resolveFirst(0); }),
      exited: new Promise<number>((r) => { resolveFirst = r; }),
      stdout: null,
      stderr: null,
    };
    mockSpawn.mockReturnValueOnce(firstProc);

    launcher.launch({
      cwd: "/tmp/project",
      containerId: "abc123def456",
      containerName: "companion-test",
      env: { CLAUDE_CODE_OAUTH_TOKEN: "tok-test" },
    });

    const secondProc = createMockProc(54321);
    mockSpawn.mockReturnValueOnce(secondProc);

    const result = await launcher.relaunch("test-session-id");
    expect(result).toEqual({ ok: true });

    const [relaunchCmd] = mockSpawn.mock.calls[1];
    expect(relaunchCmd).toContain("-e");
    expect(relaunchCmd).toContain("CLAUDE_CODE_OAUTH_TOKEN=tok-test");
  });

  it("returns error for unknown session", async () => {
    const result = await launcher.relaunch("nonexistent");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Session not found");
  });

  it("returns error when container was removed externally", async () => {
    // Launch a containerized session
    launcher.launch({
      cwd: "/tmp/project",
      containerId: "abc123def456",
      containerName: "companion-gone",
    });

    // Simulate container being removed
    mockIsContainerAlive.mockReturnValueOnce("missing");

    const result = await launcher.relaunch("test-session-id");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("companion-gone");
    expect(result.error).toContain("removed externally");

    // Session should be marked as exited
    const session = launcher.getSession("test-session-id");
    expect(session?.state).toBe("exited");
    expect(session?.exitCode).toBe(1);

    // Should NOT have spawned a new process
    expect(mockSpawn).toHaveBeenCalledTimes(1); // only the initial launch
  });

  it("restarts stopped container before spawning CLI", async () => {
    // Create initial proc that exits immediately when killed
    let resolveFirst: (code: number) => void;
    const firstProc = {
      pid: 12345,
      kill: vi.fn(() => { resolveFirst(0); }),
      exited: new Promise<number>((r) => { resolveFirst = r; }),
      stdout: null,
      stderr: null,
    };
    mockSpawn.mockReturnValueOnce(firstProc);

    launcher.launch({
      cwd: "/tmp/project",
      containerId: "abc123def456",
      containerName: "companion-stopped",
    });

    // Container is stopped but can be restarted
    mockIsContainerAlive.mockReturnValueOnce("stopped");
    mockHasBinaryInContainer.mockReturnValueOnce(true);

    const secondProc = createMockProc(54321);
    mockSpawn.mockReturnValueOnce(secondProc);

    const result = await launcher.relaunch("test-session-id");
    expect(result).toEqual({ ok: true });
    expect(mockStartContainer).toHaveBeenCalledWith("abc123def456");
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it("returns error when stopped container cannot be restarted", async () => {
    launcher.launch({
      cwd: "/tmp/project",
      containerId: "abc123def456",
      containerName: "companion-dead",
    });

    mockIsContainerAlive.mockReturnValueOnce("stopped");
    mockStartContainer.mockImplementationOnce(() => { throw new Error("container start failed"); });

    const result = await launcher.relaunch("test-session-id");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("companion-dead");
    expect(result.error).toContain("stopped");
    expect(result.error).toContain("container start failed");
  });

  it("returns error when CLI binary not found in container", async () => {
    launcher.launch({
      cwd: "/tmp/project",
      containerId: "abc123def456",
      containerName: "companion-nobin",
    });

    mockIsContainerAlive.mockReturnValueOnce("running");
    mockHasBinaryInContainer.mockReturnValueOnce(false);

    const result = await launcher.relaunch("test-session-id");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("claude");
    expect(result.error).toContain("not found");
    expect(result.error).toContain("companion-nobin");

    const session = launcher.getSession("test-session-id");
    expect(session?.state).toBe("exited");
    expect(session?.exitCode).toBe(127);
  });

  it("skips container validation for non-containerized sessions", async () => {
    // Create initial proc that exits when killed
    let resolveFirst: (code: number) => void;
    const firstProc = {
      pid: 12345,
      kill: vi.fn(() => { resolveFirst(0); }),
      exited: new Promise<number>((r) => { resolveFirst = r; }),
      stdout: null,
      stderr: null,
    };
    mockSpawn.mockReturnValueOnce(firstProc);

    launcher.launch({ cwd: "/tmp/project" });

    const secondProc = createMockProc(54321);
    mockSpawn.mockReturnValueOnce(secondProc);

    const result = await launcher.relaunch("test-session-id");
    expect(result).toEqual({ ok: true });

    // Container validation methods should NOT have been called
    expect(mockIsContainerAlive).not.toHaveBeenCalled();
    expect(mockHasBinaryInContainer).not.toHaveBeenCalled();
  });
});

// ─── codex websocket launcher ────────────────────────────────────────────────

describe("codex websocket launcher", () => {
  it("spawns codex app-server and a node ws proxy, then attaches a CodexAdapter", async () => {
    // Verify the WS transport path launches two subprocesses:
    // 1) codex app-server --listen ...
    // 2) a Node sidecar proxy that bridges stdio <-> WebSocket
    process.env.COMPANION_CODEX_TRANSPORT = "ws";
    mockResolveBinary.mockReturnValue("/opt/fake/codex");

    const codexProc = createMockProc(2001);
    const { proc: proxyProc } = createPendingCodexWsProxyProc(2002);
    mockSpawn.mockReturnValueOnce(codexProc).mockReturnValueOnce(proxyProc);

    const onAdapter = vi.fn();
    companionBus.on("backend:codex-adapter-created", ({ sessionId, adapter }) => onAdapter(sessionId, adapter));

    launcher.launch({
      backendType: "codex",
      cwd: "/tmp/project",
      codexSandbox: "workspace-write",
    });

    await new Promise((r) => setTimeout(r, 0));

    expect(mockListen).toHaveBeenCalled();
    expect(mockSpawn).toHaveBeenCalledTimes(2);

    const [codexCmd] = mockSpawn.mock.calls[0];
    expect(codexCmd[0]).toBe("/opt/fake/codex");
    expect(codexCmd).toContain("app-server");
    expect(codexCmd).toContain("--enable");
    expect(codexCmd).toContain("multi_agent");
    expect(codexCmd).toContain("--listen");
    expect(codexCmd).toContain("ws://127.0.0.1:4500");

    const [proxyCmd, proxyOpts] = mockSpawn.mock.calls[1];
    expect(proxyCmd[0]).toBe("node");
    expect(proxyCmd[1]).toContain("codex-ws-proxy.cjs");
    expect(proxyCmd[2]).toBe("ws://127.0.0.1:4500");
    // Default connect timeout (30s) and pong timeout (30s) passed to proxy
    expect(proxyCmd[3]).toBe("30000");
    expect(proxyCmd[4]).toBe("30000");
    expect(proxyOpts.stdin).toBe("pipe");
    expect(proxyOpts.stdout).toBe("pipe");
    expect(proxyOpts.stderr).toBe("pipe");

    expect(onAdapter).toHaveBeenCalledTimes(1);
    expect(onAdapter.mock.calls[0][0]).toBe("test-session-id");
  });

  it("skips already-claimed ws ports when selecting Codex host listen port", async () => {
    process.env.COMPANION_CODEX_TRANSPORT = "ws";
    mockResolveBinary.mockReturnValue("/opt/fake/codex");
    (launcher as any).claimedCodexWsPorts.add(4500);

    const codexProc = createMockProc(2101);
    const { proc: proxyProc } = createPendingCodexWsProxyProc(2102);
    mockSpawn.mockReturnValueOnce(codexProc).mockReturnValueOnce(proxyProc);

    launcher.launch({
      backendType: "codex",
      cwd: "/tmp/project",
      codexSandbox: "workspace-write",
    });

    await new Promise((r) => setTimeout(r, 0));

    const [codexCmd] = mockSpawn.mock.calls[0];
    expect(codexCmd).toContain("ws://127.0.0.1:4501");
  });

  it("passes custom connect and pong timeouts from env vars to the ws proxy", async () => {
    // When COMPANION_CODEX_WS_CONNECT_TIMEOUT_MS and COMPANION_CODEX_PONG_TIMEOUT_MS
    // are set, those values should be forwarded as argv[3] and argv[4] to the proxy.
    process.env.COMPANION_CODEX_TRANSPORT = "ws";
    process.env.COMPANION_CODEX_WS_CONNECT_TIMEOUT_MS = "60000";
    process.env.COMPANION_CODEX_PONG_TIMEOUT_MS = "45000";
    mockResolveBinary.mockReturnValue("/opt/fake/codex");

    const codexProc = createMockProc(5001);
    const { proc: proxyProc } = createPendingCodexWsProxyProc(5002);
    mockSpawn.mockReturnValueOnce(codexProc).mockReturnValueOnce(proxyProc);

    companionBus.on("backend:codex-adapter-created", vi.fn());
    launcher.launch({
      backendType: "codex",
      cwd: "/tmp/project",
      codexSandbox: "workspace-write",
    });

    await new Promise((r) => setTimeout(r, 0));

    const [proxyCmd] = mockSpawn.mock.calls[1];
    expect(proxyCmd[3]).toBe("60000");
    expect(proxyCmd[4]).toBe("45000");
  });

  it("relaunch kills the old codex process and ws proxy before spawning replacements", async () => {
    // Verify the WS sidecar is treated as part of session lifecycle during relaunch.
    process.env.COMPANION_CODEX_TRANSPORT = "ws";
    mockResolveBinary.mockReturnValue("/opt/fake/codex");

    let resolveCodex1!: (code: number) => void;
    const codexProc1 = {
      pid: 3001,
      kill: vi.fn(() => resolveCodex1(0)),
      exited: new Promise<number>((r) => { resolveCodex1 = r; }),
      stdout: null,
      stderr: null,
    };
    const proxy1 = createPendingCodexWsProxyProc(3002);
    proxy1.proc.kill.mockImplementation(() => proxy1.resolveExit(0));

    const codexProc2 = createMockProc(3003);
    const proxy2 = createPendingCodexWsProxyProc(3004);

    mockSpawn
      .mockReturnValueOnce(codexProc1 as any)
      .mockReturnValueOnce(proxy1.proc as any)
      .mockReturnValueOnce(codexProc2 as any)
      .mockReturnValueOnce(proxy2.proc as any);

    launcher.launch({
      backendType: "codex",
      cwd: "/tmp/project",
      codexSandbox: "workspace-write",
    });

    await new Promise((r) => setTimeout(r, 0));

    const result = await launcher.relaunch("test-session-id");
    expect(result).toEqual({ ok: true });
    expect(codexProc1.kill).toHaveBeenCalledWith("SIGTERM");
    expect(proxy1.proc.kill).toHaveBeenCalledWith("SIGTERM");
    expect(mockSpawn).toHaveBeenCalledTimes(4);
  });

  it("kill() returns true and kills the proxy when only a ws proxy remains", async () => {
    // Exercise the proxy-only branch introduced for WS cleanup robustness.
    launcher.launch({ cwd: "/tmp/project" });
    const proxyOnly = createPendingCodexWsProxyProc(4001);

    (launcher as any).processes.delete("test-session-id");
    (launcher as any).codexWsProxies.set("test-session-id", proxyOnly.proc);

    const result = await launcher.kill("test-session-id");
    expect(result).toBe(true);
    expect(proxyOnly.proc.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("containerized codex ws mode ignores detached launcher exit and uses proxy exit for session liveness", async () => {
    // In container WS mode, docker exec -d exits immediately after launching Codex.
    // The session must remain alive until the proxy (actual transport) exits.
    process.env.COMPANION_CODEX_TRANSPORT = "ws";
    mockGetContainerById.mockReturnValue({
      containerId: "abc123def456",
      name: "companion-codex",
      image: "the-companion:latest",
      portMappings: [{ containerPort: 4502, hostPort: 55021 }],
      hostCwd: "/tmp/project",
      containerCwd: "/workspace",
      state: "running",
    });

    let resolveLauncherProc!: (code: number) => void;
    const detachedLauncherProc = {
      pid: 5001,
      kill: vi.fn(),
      exited: new Promise<number>((r) => { resolveLauncherProc = r; }),
      stdout: null,
      stderr: null,
    };
    const proxy = createPendingCodexWsProxyProc(5002);

    mockSpawn
      .mockReturnValueOnce(detachedLauncherProc as any)
      .mockReturnValueOnce(proxy.proc as any);

    launcher.launch({
      backendType: "codex",
      cwd: "/tmp/project",
      codexSandbox: "workspace-write",
      containerId: "abc123def456",
      containerName: "companion-codex",
    });

    await new Promise((r) => setTimeout(r, 0));

    const [codexCmd] = mockSpawn.mock.calls[0];
    const codexBashCmd = codexCmd[codexCmd.length - 1];
    expect(codexBashCmd).toContain("--enable");
    expect(codexBashCmd).toContain("multi_agent");
    expect(codexBashCmd).toContain("--listen");
    expect(codexBashCmd).toContain("ws://0.0.0.0:4502");

    const [proxyCmd] = mockSpawn.mock.calls[1];
    expect(proxyCmd[2]).toBe("ws://127.0.0.1:55021");

    resolveLauncherProc(0);
    await new Promise((r) => setTimeout(r, 0));

    expect(launcher.getSession("test-session-id")?.state).not.toBe("exited");

    proxy.resolveExit(7);
    await new Promise((r) => setTimeout(r, 0));

    const session = launcher.getSession("test-session-id");
    expect(session?.state).toBe("exited");
    expect(session?.exitCode).toBe(7);
  });
});

// ─── persistence ─────────────────────────────────────────────────────────────

describe("persistence", () => {
  describe("restoreFromDisk", () => {
    it("recovers sessions from the store", () => {
      // Manually write launcher data to disk to simulate a previous run
      const savedSessions = [
        {
          sessionId: "restored-1",
          pid: 99999,
          state: "connected" as const,
          cwd: "/tmp/project",
          createdAt: Date.now(),
          cliSessionId: "cli-abc",
        },
      ];
      store.saveLauncher(savedSessions);

      // Mock process.kill(pid, 0) to succeed (process is alive)
      const origKill = process.kill;
      const killSpy = vi.spyOn(process, "kill").mockImplementation(((
        pid: number,
        signal?: string | number,
      ) => {
        if (signal === 0) return true;
        return origKill.call(process, pid, signal as any);
      }) as any);

      const newLauncher = new CliLauncher(3456);
      newLauncher.setStore(store);
      const recovered = newLauncher.restoreFromDisk();

      expect(recovered).toBe(1);

      const session = newLauncher.getSession("restored-1");
      expect(session).toBeDefined();
      // Live PIDs get state reset to "starting" awaiting WS reconnect
      expect(session?.state).toBe("starting");
      expect(session?.cliSessionId).toBe("cli-abc");

      killSpy.mockRestore();
    });

    it("marks dead PIDs as exited", () => {
      const savedSessions = [
        {
          sessionId: "dead-1",
          pid: 11111,
          state: "connected" as const,
          cwd: "/tmp/project",
          createdAt: Date.now(),
        },
      ];
      store.saveLauncher(savedSessions);

      // Mock process.kill(pid, 0) to throw (process is dead)
      const killSpy = vi.spyOn(process, "kill").mockImplementation(((
        _pid: number,
        signal?: string | number,
      ) => {
        if (signal === 0) throw new Error("ESRCH");
        return true;
      }) as any);

      const newLauncher = new CliLauncher(3456);
      newLauncher.setStore(store);
      const recovered = newLauncher.restoreFromDisk();

      // Dead sessions don't count as recovered
      expect(recovered).toBe(0);

      const session = newLauncher.getSession("dead-1");
      expect(session).toBeDefined();
      expect(session?.state).toBe("exited");
      expect(session?.exitCode).toBe(-1);

      killSpy.mockRestore();
    });

    it("returns 0 when no store is set", () => {
      const newLauncher = new CliLauncher(3456);
      // No setStore call
      expect(newLauncher.restoreFromDisk()).toBe(0);
    });

    it("returns 0 when store has no launcher data", () => {
      const newLauncher = new CliLauncher(3456);
      newLauncher.setStore(store);
      // Store is empty, no launcher.json file
      expect(newLauncher.restoreFromDisk()).toBe(0);
    });

    it("recovers Docker WS sessions using container liveness instead of PID", () => {
      // Docker WS mode sessions have containerId + codexWsPort.
      // The stored PID is from `docker exec -d` which exits immediately,
      // so container liveness must be checked instead.
      const savedSessions = [
        {
          sessionId: "docker-ws-1",
          pid: 55555,
          state: "connected" as const,
          cwd: "/tmp/project",
          createdAt: Date.now(),
          containerId: "abc123",
          codexWsPort: 32819,
        },
      ];
      store.saveLauncher(savedSessions);

      mockIsContainerAlive.mockReturnValueOnce("running");

      const newLauncher = new CliLauncher(3456);
      newLauncher.setStore(store);
      const recovered = newLauncher.restoreFromDisk();

      expect(recovered).toBe(1);
      expect(mockIsContainerAlive).toHaveBeenCalledWith("abc123");

      const session = newLauncher.getSession("docker-ws-1");
      expect(session).toBeDefined();
      expect(session?.state).toBe("starting");
    });

    it("marks Docker WS sessions as exited when container is stopped", () => {
      const savedSessions = [
        {
          sessionId: "docker-ws-dead",
          pid: 66666,
          state: "connected" as const,
          cwd: "/tmp/project",
          createdAt: Date.now(),
          containerId: "dead-container",
          codexWsPort: 32820,
        },
      ];
      store.saveLauncher(savedSessions);

      mockIsContainerAlive.mockReturnValueOnce("stopped");

      const newLauncher = new CliLauncher(3456);
      newLauncher.setStore(store);
      const recovered = newLauncher.restoreFromDisk();

      expect(recovered).toBe(0);
      expect(mockIsContainerAlive).toHaveBeenCalledWith("dead-container");

      const session = newLauncher.getSession("docker-ws-dead");
      expect(session).toBeDefined();
      expect(session?.state).toBe("exited");
      expect(session?.exitCode).toBe(-1);
    });

    it("preserves already-exited sessions from disk", () => {
      const savedSessions = [
        {
          sessionId: "already-exited",
          pid: 22222,
          state: "exited" as const,
          exitCode: 0,
          cwd: "/tmp/project",
          createdAt: Date.now(),
        },
      ];
      store.saveLauncher(savedSessions);

      const newLauncher = new CliLauncher(3456);
      newLauncher.setStore(store);
      const recovered = newLauncher.restoreFromDisk();

      // Already-exited sessions are loaded but not "recovered"
      expect(recovered).toBe(0);
      const session = newLauncher.getSession("already-exited");
      expect(session).toBeDefined();
      expect(session?.state).toBe("exited");
    });
  });
});

// ─── getStartingSessions ─────────────────────────────────────────────────────

describe("getStartingSessions", () => {
  it("returns only sessions in starting state", () => {
    launcher.launch({ cwd: "/tmp" });

    const starting = launcher.getStartingSessions();
    expect(starting).toHaveLength(1);
    expect(starting[0].state).toBe("starting");
  });

  it("excludes sessions that have been connected", () => {
    launcher.launch({ cwd: "/tmp" });
    launcher.markConnected("test-session-id");

    const starting = launcher.getStartingSessions();
    expect(starting).toHaveLength(0);
  });

  it("returns empty array when no sessions exist", () => {
    expect(launcher.getStartingSessions()).toEqual([]);
  });
});

// ─── isCmdScript platform guard ───────────────────────────────────────────────

describe("isCmdScript platform guard", () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  it("wraps .cmd binary with cmd.exe /c on win32", () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    mockResolveBinary.mockReturnValue("C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd");

    launcher.launch({ cwd: "/tmp" });

    const [cmdAndArgs] = mockSpawn.mock.calls[0];
    // On Windows, .cmd files should be spawned via cmd.exe /c
    expect(cmdAndArgs[0]).toBe("cmd.exe");
    expect(cmdAndArgs[1]).toBe("/c");
    expect(cmdAndArgs[2]).toBe("C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd");
  });

  it("does not wrap .cmd binary with cmd.exe on non-Windows", () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    mockResolveBinary.mockReturnValue("/usr/local/bin/claude.cmd");

    launcher.launch({ cwd: "/tmp" });

    const [cmdAndArgs] = mockSpawn.mock.calls[0];
    // On non-Windows, .cmd files should be spawned directly (no cmd.exe wrapping)
    expect(cmdAndArgs[0]).toBe("/usr/local/bin/claude.cmd");
    expect(cmdAndArgs[0]).not.toBe("cmd.exe");
  });
});
