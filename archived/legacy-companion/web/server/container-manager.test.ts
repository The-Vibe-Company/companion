import { beforeEach, describe, expect, it, vi } from "vitest";

const mockExecSync = vi.hoisted(() => vi.fn((..._args: unknown[]) => ""));
const mockExistsSync = vi.hoisted(() => vi.fn((..._args: unknown[]) => false));
const mockWriteFileSync = vi.hoisted(() => vi.fn());
const mockReadFileSync = vi.hoisted(() => vi.fn((..._args: unknown[]) => ""));
const mockMkdirSync = vi.hoisted(() => vi.fn());
const mockRmSync = vi.hoisted(() => vi.fn());
const mockSpawn = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execSync: mockExecSync,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    existsSync: mockExistsSync,
    writeFileSync: mockWriteFileSync,
    readFileSync: mockReadFileSync,
    mkdirSync: mockMkdirSync,
    rmSync: mockRmSync,
  };
});

import { ContainerManager } from "./container-manager.js";

function createMockProc(exitCode: number, stderrText = "") {
  return {
    exited: Promise.resolve(exitCode),
    stderr: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(stderrText));
        controller.close();
      },
    }),
    kill: vi.fn(),
  };
}

vi.stubGlobal("Bun", { spawn: mockSpawn });

describe("ContainerManager git auth seeding", () => {
  beforeEach(() => {
    mockExecSync.mockReset();
    mockExistsSync.mockReset();
    // Default: existsSync returns false (no host files)
    mockExistsSync.mockReturnValue(false);
  });

  it("always configures gh as git credential helper when host token lookup fails", () => {
    // Regression guard: copied gh auth files in the container are still valid even
    // when `gh auth token` cannot read host keychain state.
    mockExecSync.mockImplementation((...args: unknown[]) => {
      const cmd = String(args[0] ?? "");
      if (cmd.includes("gh auth token")) throw new Error("host token unavailable");
      return "";
    });

    const manager = new ContainerManager();
    manager.reseedGitAuth("container123");

    const commands = mockExecSync.mock.calls.map((call) => String(call[0] ?? ""));
    expect(commands.some((cmd) => cmd.includes("gh auth setup-git"))).toBe(true);
    expect(commands.some((cmd) => cmd.includes("gh auth login --with-token"))).toBe(false);
  });

  it("logs in with host token before running gh auth setup-git when token exists", () => {
    // Ordering matters: authenticate first, then wire git credential helper.
    mockExecSync.mockImplementation((...args: unknown[]) => {
      const cmd = String(args[0] ?? "");
      if (cmd.includes("gh auth token")) return "ghp_test_token";
      return "";
    });

    const manager = new ContainerManager();
    manager.reseedGitAuth("container123");

    const commands = mockExecSync.mock.calls.map((call) => String(call[0] ?? ""));
    const loginIndex = commands.findIndex((cmd) => cmd.includes("gh auth login --with-token"));
    const setupGitIndex = commands.findIndex((cmd) => cmd.includes("gh auth setup-git"));

    expect(loginIndex).toBeGreaterThan(-1);
    expect(setupGitIndex).toBeGreaterThan(-1);
    expect(loginIndex).toBeLessThan(setupGitIndex);
  });
});

describe("ContainerManager git identity seeding from host .gitconfig", () => {
  beforeEach(() => {
    mockExecSync.mockReset();
    mockExistsSync.mockReset();
    mockExistsSync.mockReturnValue(false);
  });

  it("copies user.name and user.email from /companion-host-gitconfig into container global config", () => {
    // The host .gitconfig is mounted read-only at /companion-host-gitconfig.
    // seedGitAuth should read identity from that file and write it into the
    // container's writable /root/.gitconfig via git config --global.
    mockExecSync.mockImplementation((...args: unknown[]) => {
      const cmd = String(args[0] ?? "");
      if (cmd.includes("gh auth token")) throw new Error("no token");
      return "";
    });

    const manager = new ContainerManager();
    manager.reseedGitAuth("container123");

    const commands = mockExecSync.mock.calls.map((call) => String(call[0] ?? ""));
    // The seeding command should reference the staged host gitconfig path
    const identityCmd = commands.find((cmd) => cmd.includes("companion-host-gitconfig"));
    expect(identityCmd).toBeDefined();
    // It should use git config -f to read from the mounted file
    expect(identityCmd).toContain("git config -f /companion-host-gitconfig user.name");
    expect(identityCmd).toContain("git config -f /companion-host-gitconfig user.email");
    // It should write user.name and user.email via git config --global
    expect(identityCmd).toContain("git config --global user.name");
    expect(identityCmd).toContain("git config --global user.email");
  });

  it("disables gpgsign in writable global config (not the read-only mount)", () => {
    // With the host .gitconfig mounted at /companion-host-gitconfig instead
    // of /root/.gitconfig, git config --global writes succeed in the container.
    mockExecSync.mockImplementation((...args: unknown[]) => {
      const cmd = String(args[0] ?? "");
      if (cmd.includes("gh auth token")) throw new Error("no token");
      return "";
    });

    const manager = new ContainerManager();
    manager.reseedGitAuth("container123");

    const commands = mockExecSync.mock.calls.map((call) => String(call[0] ?? ""));
    expect(commands.some((cmd) => cmd.includes("git config --global commit.gpgsign false"))).toBe(true);
  });

  it("marks /workspace as a safe directory to avoid dubious ownership errors", () => {
    // The workspace volume may be owned by a different uid (e.g. ubuntu)
    // than the container user (root), triggering git's ownership check.
    mockExecSync.mockImplementation((...args: unknown[]) => {
      const cmd = String(args[0] ?? "");
      if (cmd.includes("gh auth token")) throw new Error("no token");
      return "";
    });

    const manager = new ContainerManager();
    manager.reseedGitAuth("container123");

    const commands = mockExecSync.mock.calls.map((call) => String(call[0] ?? ""));
    expect(commands.some((cmd) => cmd.includes("safe.directory /workspace"))).toBe(true);
  });
});

describe("ContainerManager Codex file seeding", () => {
  beforeEach(() => {
    mockExecSync.mockReset();
    mockExistsSync.mockReset();
    mockExistsSync.mockReturnValue(false);
  });

  it("seeds Codex auth files when /companion-host-codex is available", () => {
    // seedCodexFiles is called internally during createContainer and startContainer.
    // Since we can't call createContainer in a unit test (it needs docker), we
    // test the seeding indirectly via a restart (startContainer).
    // However startContainer also calls docker start, so we test via the public
    // reseedGitAuth path which triggers seedGitAuth but not seedCodexFiles.
    // Instead, verify the command is issued during a docker exec mock.
    mockExecSync.mockImplementation((..._args: unknown[]) => "");

    const manager = new ContainerManager();
    // Access private method via bracket notation for testing
    (manager as unknown as Record<string, (id: string) => void>)["seedCodexFiles"]("container456");

    const commands = mockExecSync.mock.calls.map((call) => String(call[0] ?? ""));
    // Should attempt to copy Codex files from bind mount
    expect(commands.some((cmd) =>
      cmd.includes("/companion-host-codex") && cmd.includes("/root/.codex"),
    )).toBe(true);
  });

  it("copies auth.json, config.toml, and directory seeds for Codex", () => {
    mockExecSync.mockImplementation((..._args: unknown[]) => "");

    const manager = new ContainerManager();
    (manager as unknown as Record<string, (id: string) => void>)["seedCodexFiles"]("container789");

    const commands = mockExecSync.mock.calls.map((call) => String(call[0] ?? ""));
    const seedCmd = commands.find((cmd) => cmd.includes("companion-host-codex"));
    expect(seedCmd).toBeDefined();
    // Verify it copies the expected files
    expect(seedCmd).toContain("auth.json");
    expect(seedCmd).toContain("config.toml");
    expect(seedCmd).toContain("models_cache.json");
    // Verify it copies directories
    expect(seedCmd).toContain("skills");
    expect(seedCmd).toContain("prompts");
    expect(seedCmd).toContain("rules");
  });

  it("does not fail when seedCodexFiles encounters an error", () => {
    // seedCodexFiles is best-effort and should not throw
    mockExecSync.mockImplementation(() => {
      throw new Error("container not running");
    });

    const manager = new ContainerManager();
    expect(() => {
      (manager as unknown as Record<string, (id: string) => void>)["seedCodexFiles"]("container999");
    }).not.toThrow();
  });
});

describe("ContainerManager workspace copy", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  it("uses tar stream + docker exec to copy workspace content", async () => {
    // Validates the fast path used for large workspaces (especially on macOS):
    // tar the host directory and stream directly into /workspace in-container.
    mockSpawn.mockReturnValue(createMockProc(0));

    const manager = new ContainerManager();
    await expect(manager.copyWorkspaceToContainer("container123", "/tmp/my-workspace")).resolves.toBeUndefined();

    expect(mockSpawn).toHaveBeenCalledOnce();
    const [args, options] = mockSpawn.mock.calls[0] as [string[], Record<string, unknown>];

    expect(args[0]).toBe("bash");
    expect(args[1]).toBe("-lc");
    expect(args[2]).toContain("set -o pipefail");
    expect(args[2]).toContain("COPYFILE_DISABLE=1 tar -C /tmp/my-workspace -cf - .");
    expect(args[2]).toContain("docker exec -i container123 tar -xf - -C /workspace");
    expect(options.stdout).toBe("pipe");
    expect(options.stderr).toBe("pipe");
  });

  it("throws a descriptive error when copy command fails", async () => {
    // Ensures stderr from the tar/docker pipeline is surfaced to users.
    mockSpawn.mockReturnValue(createMockProc(2, "tar: write error"));

    const manager = new ContainerManager();
    await expect(manager.copyWorkspaceToContainer("container123", "/tmp/my-workspace"))
      .rejects.toThrow("workspace copy failed (exit 2): tar: write error");
  });
});

describe("ContainerManager gitOpsInContainer", () => {
  beforeEach(() => {
    mockExecSync.mockReset();
  });

  it("runs fetch, checkout, and pull in sequence and reports success", () => {
    // All git commands succeed inside the container
    mockExecSync.mockReturnValue("");

    const manager = new ContainerManager();
    const result = manager.gitOpsInContainer("cid-123", {
      branch: "feat/new",
      currentBranch: "main",
      defaultBranch: "main",
    });

    expect(result.fetchOk).toBe(true);
    expect(result.checkoutOk).toBe(true);
    expect(result.pullOk).toBe(true);
    expect(result.errors).toHaveLength(0);

    // Verify commands were executed in the container
    const cmds = mockExecSync.mock.calls.map((c) => String(c[0] ?? ""));
    expect(cmds.some((c) => c.includes("git fetch --prune"))).toBe(true);
    expect(cmds.some((c) => c.includes("git checkout"))).toBe(true);
    expect(cmds.some((c) => c.includes("git pull"))).toBe(true);
  });

  it("treats fetch failure as non-fatal and continues with checkout/pull", () => {
    // git fetch fails but checkout and pull succeed
    mockExecSync.mockImplementation((...args: unknown[]) => {
      const cmd = String(args[0] ?? "");
      if (cmd.includes("git fetch")) throw new Error("network unreachable");
      return "";
    });

    const manager = new ContainerManager();
    const result = manager.gitOpsInContainer("cid-123", {
      branch: "feat/new",
      currentBranch: "main",
    });

    expect(result.fetchOk).toBe(false);
    expect(result.checkoutOk).toBe(true);
    expect(result.pullOk).toBe(true);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("fetch:");
  });

  it("reports checkout failure when branch does not exist and createBranch is false", () => {
    mockExecSync.mockImplementation((...args: unknown[]) => {
      const cmd = String(args[0] ?? "");
      if (cmd.includes("git checkout")) throw new Error("pathspec did not match");
      return "";
    });

    const manager = new ContainerManager();
    const result = manager.gitOpsInContainer("cid-123", {
      branch: "nonexistent",
      currentBranch: "main",
    });

    expect(result.checkoutOk).toBe(false);
    expect(result.errors.some((e) => e.includes("does not exist"))).toBe(true);
  });

  it("creates a new branch when checkout fails and createBranch is true", () => {
    // The simple checkout should fail, then the "checkout -b" fallback should succeed.
    mockExecSync.mockImplementation((...args: unknown[]) => {
      const cmd = String(args[0] ?? "");
      // Match simple checkout (no -b flag) — the -b flag follows "checkout" directly
      if (cmd.includes("git checkout") && !cmd.includes("checkout -b")) {
        throw new Error("pathspec did not match");
      }
      return "";
    });

    const manager = new ContainerManager();
    const result = manager.gitOpsInContainer("cid-123", {
      branch: "feat/new",
      currentBranch: "main",
      createBranch: true,
      defaultBranch: "main",
    });

    expect(result.checkoutOk).toBe(true);
    const cmds = mockExecSync.mock.calls.map((c) => String(c[0] ?? ""));
    expect(cmds.some((c) => c.includes("checkout -b"))).toBe(true);
  });

  it("treats pull failure as non-fatal", () => {
    mockExecSync.mockImplementation((...args: unknown[]) => {
      const cmd = String(args[0] ?? "");
      if (cmd.includes("git pull")) throw new Error("no tracking info");
      return "";
    });

    const manager = new ContainerManager();
    const result = manager.gitOpsInContainer("cid-123", {
      branch: "feat/new",
      currentBranch: "main",
    });

    expect(result.pullOk).toBe(false);
    expect(result.checkoutOk).toBe(true);
    expect(result.errors.some((e) => e.includes("pull:"))).toBe(true);
  });

  it("skips checkout when currentBranch matches requested branch", () => {
    mockExecSync.mockReturnValue("");

    const manager = new ContainerManager();
    const result = manager.gitOpsInContainer("cid-123", {
      branch: "main",
      currentBranch: "main",
    });

    expect(result.checkoutOk).toBe(true);
    const cmds = mockExecSync.mock.calls.map((c) => String(c[0] ?? ""));
    // Should not have any checkout command
    expect(cmds.some((c) => c.includes("git checkout"))).toBe(false);
    // But should still fetch and pull
    expect(cmds.some((c) => c.includes("git fetch"))).toBe(true);
    expect(cmds.some((c) => c.includes("git pull"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Docker daemon checks
// ---------------------------------------------------------------------------

describe("ContainerManager checkDocker", () => {
  beforeEach(() => {
    mockExecSync.mockReset();
  });

  it("returns true when docker info succeeds", () => {
    mockExecSync.mockReturnValue("24.0.7");
    const manager = new ContainerManager();
    expect(manager.checkDocker()).toBe(true);
  });

  it("returns false when docker info fails", () => {
    mockExecSync.mockImplementation(() => { throw new Error("not found"); });
    const manager = new ContainerManager();
    expect(manager.checkDocker()).toBe(false);
  });
});

describe("ContainerManager getDockerVersion", () => {
  beforeEach(() => {
    mockExecSync.mockReset();
  });

  it("returns version string on success", () => {
    mockExecSync.mockReturnValue("24.0.7");
    const manager = new ContainerManager();
    expect(manager.getDockerVersion()).toBe("24.0.7");
  });

  it("returns null on failure", () => {
    mockExecSync.mockImplementation(() => { throw new Error("not found"); });
    const manager = new ContainerManager();
    expect(manager.getDockerVersion()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Image operations
// ---------------------------------------------------------------------------

describe("ContainerManager listImages", () => {
  beforeEach(() => {
    mockExecSync.mockReset();
  });

  it("returns parsed image list", () => {
    mockExecSync.mockReturnValue("node:22\nubuntu:latest\npython:3.12");
    const manager = new ContainerManager();
    expect(manager.listImages()).toEqual(["node:22", "python:3.12", "ubuntu:latest"]);
  });

  it("filters out <none> entries", () => {
    mockExecSync.mockReturnValue("<none>:latest\nnode:22");
    const manager = new ContainerManager();
    expect(manager.listImages()).toEqual(["node:22"]);
  });

  it("returns empty array when docker command fails", () => {
    mockExecSync.mockImplementation(() => { throw new Error("fail"); });
    const manager = new ContainerManager();
    expect(manager.listImages()).toEqual([]);
  });

  it("returns empty array when output is empty", () => {
    mockExecSync.mockReturnValue("");
    const manager = new ContainerManager();
    expect(manager.listImages()).toEqual([]);
  });
});

describe("ContainerManager imageExists", () => {
  beforeEach(() => {
    mockExecSync.mockReset();
  });

  it("returns true when image inspect succeeds", () => {
    mockExecSync.mockReturnValue("[]");
    const manager = new ContainerManager();
    expect(manager.imageExists("node:22")).toBe(true);
  });

  it("returns false when image inspect fails", () => {
    mockExecSync.mockImplementation(() => { throw new Error("not found"); });
    const manager = new ContainerManager();
    expect(manager.imageExists("nonexistent:latest")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Container execution
// ---------------------------------------------------------------------------

describe("ContainerManager execInContainer", () => {
  beforeEach(() => {
    mockExecSync.mockReset();
  });

  it("runs docker exec with properly escaped args", () => {
    mockExecSync.mockReturnValue("hello world");
    const manager = new ContainerManager();
    const result = manager.execInContainer("abc123", ["sh", "-c", "echo hello"]);
    expect(result).toBe("hello world");
    const cmd = String(mockExecSync.mock.calls[0]?.[0] ?? "");
    expect(cmd).toContain("docker exec");
    expect(cmd).toContain("abc123");
  });

  it("throws on invalid container ID", () => {
    const manager = new ContainerManager();
    expect(() => manager.execInContainer("../evil", ["ls"])).toThrow("Invalid container ID");
  });

  it("throws on container ID starting with hyphen", () => {
    const manager = new ContainerManager();
    expect(() => manager.execInContainer("-bad", ["ls"])).toThrow("Invalid container ID");
  });
});

// ---------------------------------------------------------------------------
// Container tracking (retrack, getContainer, getContainerById, listContainers)
// ---------------------------------------------------------------------------

describe("ContainerManager tracking", () => {
  beforeEach(() => {
    mockExecSync.mockReset();
    mockExistsSync.mockReset();
    mockExistsSync.mockReturnValue(false);
  });

  it("retrack moves container to new session key", () => {
    // Manually set up a container in the manager's internal map via restoreContainer
    mockExecSync.mockReturnValue("true"); // docker inspect returns "true" (running)
    const manager = new ContainerManager();
    const info = {
      containerId: "abc123def456",
      name: "companion-abc123de",
      image: "node:22",
      portMappings: [],
      hostCwd: "/tmp",
      containerCwd: "/workspace",
      state: "running" as const,
    };
    manager.restoreContainer("old-session", info);
    expect(manager.getContainer("old-session")).toBeDefined();

    manager.retrack("abc123def456", "new-session");
    expect(manager.getContainer("old-session")).toBeUndefined();
    expect(manager.getContainer("new-session")).toBeDefined();
  });

  it("retrack is a no-op when containerId is not tracked", () => {
    const manager = new ContainerManager();
    // Should not throw
    manager.retrack("nonexistent", "new-session");
    expect(manager.listContainers()).toHaveLength(0);
  });

  it("getContainerById finds container by docker ID", () => {
    mockExecSync.mockReturnValue("true");
    const manager = new ContainerManager();
    const info = {
      containerId: "abc123def456",
      name: "companion-abc123de",
      image: "node:22",
      portMappings: [],
      hostCwd: "/tmp",
      containerCwd: "/workspace",
      state: "running" as const,
    };
    manager.restoreContainer("sess-1", info);
    expect(manager.getContainerById("abc123def456")).toBeDefined();
    expect(manager.getContainerById("nonexistent")).toBeUndefined();
  });

  it("listContainers returns all tracked containers", () => {
    mockExecSync.mockReturnValue("true");
    const manager = new ContainerManager();
    expect(manager.listContainers()).toHaveLength(0);

    manager.restoreContainer("s1", {
      containerId: "c1", name: "n1", image: "i1",
      portMappings: [], hostCwd: "/a", containerCwd: "/workspace", state: "running",
    });
    manager.restoreContainer("s2", {
      containerId: "c2", name: "n2", image: "i2",
      portMappings: [], hostCwd: "/b", containerCwd: "/workspace", state: "running",
    });
    expect(manager.listContainers()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// removeContainer
// ---------------------------------------------------------------------------

describe("ContainerManager removeContainer", () => {
  beforeEach(() => {
    mockExecSync.mockReset();
    mockExistsSync.mockReset();
    mockExistsSync.mockReturnValue(false);
  });

  it("removes container and volume from docker and internal map", () => {
    // Set up a tracked container
    mockExecSync.mockReturnValue("true");
    const manager = new ContainerManager();
    manager.restoreContainer("sess-1", {
      containerId: "abc123", name: "companion-abc", image: "node:22",
      portMappings: [], hostCwd: "/tmp", containerCwd: "/workspace",
      state: "running", volumeName: "companion-ws-abc",
    });
    expect(manager.getContainer("sess-1")).toBeDefined();

    // Reset so we can track removal calls
    mockExecSync.mockReset();
    mockExecSync.mockReturnValue("");
    manager.removeContainer("sess-1");

    expect(manager.getContainer("sess-1")).toBeUndefined();
    const cmds = mockExecSync.mock.calls.map((c) => String(c[0] ?? ""));
    expect(cmds.some((c) => c.includes("docker rm -f"))).toBe(true);
    expect(cmds.some((c) => c.includes("docker volume rm"))).toBe(true);
  });

  it("is a no-op when session is not tracked", () => {
    const manager = new ContainerManager();
    // Should not throw
    manager.removeContainer("nonexistent");
  });

  it("continues cleanup even when docker rm fails", () => {
    mockExecSync.mockReturnValue("true");
    const manager = new ContainerManager();
    manager.restoreContainer("sess-1", {
      containerId: "abc123", name: "companion-abc", image: "node:22",
      portMappings: [], hostCwd: "/tmp", containerCwd: "/workspace",
      state: "running", volumeName: "vol-1",
    });
    // Make docker rm fail but volume rm succeed
    mockExecSync.mockReset();
    mockExecSync.mockImplementation((...args: unknown[]) => {
      const cmd = String(args[0] ?? "");
      if (cmd.includes("docker rm")) throw new Error("rm failed");
      return "";
    });
    // Should not throw — removal is best-effort
    manager.removeContainer("sess-1");
    expect(manager.getContainer("sess-1")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// isContainerAlive
// ---------------------------------------------------------------------------

describe("ContainerManager isContainerAlive", () => {
  beforeEach(() => {
    mockExecSync.mockReset();
  });

  it("returns 'running' when docker inspect shows true", () => {
    mockExecSync.mockReturnValue("true");
    const manager = new ContainerManager();
    expect(manager.isContainerAlive("abc123")).toBe("running");
  });

  it("returns 'stopped' when docker inspect shows false", () => {
    mockExecSync.mockReturnValue("false");
    const manager = new ContainerManager();
    expect(manager.isContainerAlive("abc123")).toBe("stopped");
  });

  it("returns 'missing' when docker inspect throws", () => {
    mockExecSync.mockImplementation(() => { throw new Error("not found"); });
    const manager = new ContainerManager();
    expect(manager.isContainerAlive("abc123")).toBe("missing");
  });
});

// ---------------------------------------------------------------------------
// hasBinaryInContainer
// ---------------------------------------------------------------------------

describe("ContainerManager hasBinaryInContainer", () => {
  beforeEach(() => {
    mockExecSync.mockReset();
  });

  it("returns true when which finds the binary", () => {
    mockExecSync.mockReturnValue("/usr/bin/node");
    const manager = new ContainerManager();
    expect(manager.hasBinaryInContainer("abc123", "node")).toBe(true);
  });

  it("returns false when which fails", () => {
    mockExecSync.mockImplementation(() => { throw new Error("not found"); });
    const manager = new ContainerManager();
    expect(manager.hasBinaryInContainer("abc123", "nonexistent")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// startContainer
// ---------------------------------------------------------------------------

describe("ContainerManager startContainer", () => {
  beforeEach(() => {
    mockExecSync.mockReset();
    mockExistsSync.mockReset();
    mockExistsSync.mockReturnValue(false);
  });

  it("runs docker start and re-seeds auth files", () => {
    // startContainer calls docker start, seedAuthFiles, seedCodexFiles, seedGitAuth
    mockExecSync.mockReturnValue("");
    const manager = new ContainerManager();
    manager.startContainer("abc123");

    const cmds = mockExecSync.mock.calls.map((c) => String(c[0] ?? ""));
    expect(cmds[0]).toContain("docker start");
    // Should have multiple docker exec calls for seeding
    expect(cmds.length).toBeGreaterThan(1);
  });

  it("throws on invalid container ID", () => {
    const manager = new ContainerManager();
    expect(() => manager.startContainer("../evil")).toThrow("Invalid container ID");
  });
});

// ---------------------------------------------------------------------------
// restoreContainer
// ---------------------------------------------------------------------------

describe("ContainerManager restoreContainer", () => {
  beforeEach(() => {
    mockExecSync.mockReset();
  });

  it("tracks a running container", () => {
    mockExecSync.mockReturnValue("true");
    const manager = new ContainerManager();
    const info = {
      containerId: "abc123", name: "test", image: "node:22",
      portMappings: [], hostCwd: "/tmp", containerCwd: "/workspace",
      state: "stopped" as const,
    };
    const ok = manager.restoreContainer("sess-1", info);
    expect(ok).toBe(true);
    expect(info.state).toBe("running");
    expect(manager.getContainer("sess-1")).toBe(info);
  });

  it("tracks a stopped container", () => {
    mockExecSync.mockReturnValue("false");
    const manager = new ContainerManager();
    const info = {
      containerId: "abc123", name: "test", image: "node:22",
      portMappings: [], hostCwd: "/tmp", containerCwd: "/workspace",
      state: "running" as const,
    };
    const ok = manager.restoreContainer("sess-1", info);
    expect(ok).toBe(true);
    expect(info.state).toBe("stopped");
  });

  it("returns false when container no longer exists", () => {
    mockExecSync.mockImplementation(() => { throw new Error("not found"); });
    const manager = new ContainerManager();
    const info = {
      containerId: "abc123", name: "test", image: "node:22",
      portMappings: [], hostCwd: "/tmp", containerCwd: "/workspace",
      state: "running" as const,
    };
    const ok = manager.restoreContainer("sess-1", info);
    expect(ok).toBe(false);
    expect(manager.getContainer("sess-1")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// persistState / restoreState
// ---------------------------------------------------------------------------

describe("ContainerManager persistState", () => {
  beforeEach(() => {
    mockExecSync.mockReset();
    mockWriteFileSync.mockReset();
    mockExistsSync.mockReset();
    mockExistsSync.mockReturnValue(false);
  });

  it("writes tracked containers to disk as JSON", () => {
    mockExecSync.mockReturnValue("true");
    const manager = new ContainerManager();
    manager.restoreContainer("sess-1", {
      containerId: "c1", name: "n1", image: "i1",
      portMappings: [], hostCwd: "/a", containerCwd: "/workspace", state: "running",
    });

    manager.persistState("/tmp/state.json");

    expect(mockWriteFileSync).toHaveBeenCalledOnce();
    const [path, content] = mockWriteFileSync.mock.calls[0] as [string, string, string];
    expect(path).toBe("/tmp/state.json");
    const parsed = JSON.parse(content);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].sessionId).toBe("sess-1");
  });

  it("excludes removed containers from persisted state", () => {
    mockExecSync.mockReturnValue("true");
    const manager = new ContainerManager();
    manager.restoreContainer("sess-1", {
      containerId: "c1", name: "n1", image: "i1",
      portMappings: [], hostCwd: "/a", containerCwd: "/workspace", state: "running",
    });
    // Remove the container so state = "removed"
    mockExecSync.mockReset();
    mockExecSync.mockReturnValue("");
    manager.removeContainer("sess-1");

    mockWriteFileSync.mockReset();
    manager.persistState("/tmp/state.json");

    const [, content] = mockWriteFileSync.mock.calls[0] as [string, string, string];
    expect(JSON.parse(content)).toHaveLength(0);
  });

  it("does not throw when write fails", () => {
    mockWriteFileSync.mockImplementation(() => { throw new Error("EACCES"); });
    const manager = new ContainerManager();
    expect(() => manager.persistState("/tmp/state.json")).not.toThrow();
  });
});

describe("ContainerManager restoreState", () => {
  beforeEach(() => {
    mockExecSync.mockReset();
    mockReadFileSync.mockReset();
    mockExistsSync.mockReset();
  });

  it("returns 0 when file does not exist", () => {
    mockExistsSync.mockReturnValue(false);
    const manager = new ContainerManager();
    expect(manager.restoreState("/tmp/state.json")).toBe(0);
  });

  it("restores containers from disk", () => {
    mockExistsSync.mockReturnValue(true);
    mockExecSync.mockReturnValue("true"); // container is running
    mockReadFileSync.mockReturnValue(JSON.stringify([
      { sessionId: "s1", info: { containerId: "c1", name: "n1", image: "i1", portMappings: [], hostCwd: "/a", containerCwd: "/workspace", state: "running" } },
    ]));

    const manager = new ContainerManager();
    const count = manager.restoreState("/tmp/state.json");
    expect(count).toBe(1);
    expect(manager.getContainer("s1")).toBeDefined();
  });

  it("returns 0 when file is corrupt", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("not json");
    const manager = new ContainerManager();
    expect(manager.restoreState("/tmp/state.json")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// buildImage
// ---------------------------------------------------------------------------

describe("ContainerManager buildImage", () => {
  beforeEach(() => {
    mockExecSync.mockReset();
  });

  it("runs docker build and returns output", () => {
    mockExecSync.mockReturnValue("Successfully built abc123");
    const manager = new ContainerManager();
    const output = manager.buildImage("/tmp/Dockerfile", "test:latest");
    expect(output).toBe("Successfully built abc123");
    const cmd = String(mockExecSync.mock.calls[0]?.[0] ?? "");
    expect(cmd).toContain("docker build");
    expect(cmd).toContain("-t test:latest");
  });

  it("throws with descriptive error on build failure", () => {
    mockExecSync.mockImplementation(() => { throw new Error("build error"); });
    const manager = new ContainerManager();
    expect(() => manager.buildImage("/tmp/Dockerfile")).toThrow("Failed to build image");
  });
});

// ---------------------------------------------------------------------------
// getRegistryImage (static)
// ---------------------------------------------------------------------------

describe("ContainerManager.getRegistryImage", () => {
  it("returns registry path for the-companion:latest", () => {
    const result = ContainerManager.getRegistryImage("the-companion:latest");
    expect(result).toContain("stangirard/the-companion:latest");
  });

  it("returns null for non-default images", () => {
    expect(ContainerManager.getRegistryImage("node:22")).toBeNull();
    expect(ContainerManager.getRegistryImage("custom:v1")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// cleanupAll
// ---------------------------------------------------------------------------

describe("ContainerManager cleanupAll", () => {
  beforeEach(() => {
    mockExecSync.mockReset();
  });

  it("removes all tracked containers", () => {
    mockExecSync.mockReturnValue("true"); // for restoreContainer
    const manager = new ContainerManager();
    manager.restoreContainer("s1", {
      containerId: "c1", name: "n1", image: "i1",
      portMappings: [], hostCwd: "/a", containerCwd: "/workspace", state: "running",
    });
    manager.restoreContainer("s2", {
      containerId: "c2", name: "n2", image: "i2",
      portMappings: [], hostCwd: "/b", containerCwd: "/workspace", state: "running",
    });
    expect(manager.listContainers()).toHaveLength(2);

    mockExecSync.mockReset();
    mockExecSync.mockReturnValue("");
    manager.cleanupAll();
    expect(manager.listContainers()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// createContainer (full flow with mocked docker commands)
// ---------------------------------------------------------------------------

describe("ContainerManager createContainer", () => {
  beforeEach(() => {
    mockExecSync.mockReset();
    mockExistsSync.mockReset();
    mockExistsSync.mockReturnValue(false);
  });

  it("creates a container with volume, ports, and auth seeding", () => {
    // Mock the sequence of docker commands:
    // 1. docker volume create
    // 2. docker create → returns container ID
    // 3. docker start
    // 4-N. seedAuthFiles, seedCodexFiles, seedGitAuth (all docker exec)
    // last. docker port → returns port mapping
    let callCount = 0;
    mockExecSync.mockImplementation((...args: unknown[]) => {
      callCount++;
      const cmd = String(args[0] ?? "");
      if (cmd.includes("docker volume create")) return "companion-ws-test1234";
      if (cmd.startsWith("docker create") || cmd.startsWith("'docker' 'create'") || cmd.includes("docker create")) return "abcdef1234567890";
      if (cmd.includes("docker start")) return "";
      if (cmd.includes("docker port")) return "0.0.0.0:49152";
      if (cmd.includes("gh auth token")) throw new Error("no token");
      return "";
    });

    const manager = new ContainerManager();
    const info = manager.createContainer("test1234-5678-abcd", "/tmp/workspace", {
      image: "node:22",
      ports: [3000],
    });

    expect(info.containerId).toBe("abcdef1234567890");
    expect(info.state).toBe("running");
    expect(info.portMappings).toHaveLength(1);
    expect(info.portMappings[0].hostPort).toBe(49152);
    expect(info.portMappings[0].containerPort).toBe(3000);
    expect(info.volumeName).toBe("companion-ws-test1234");
  });

  it("rejects invalid port numbers", () => {
    const manager = new ContainerManager();
    expect(() => manager.createContainer("sess-1", "/tmp", {
      image: "node:22", ports: [0],
    })).toThrow("Invalid port number: 0");

    expect(() => manager.createContainer("sess-2", "/tmp", {
      image: "node:22", ports: [99999],
    })).toThrow("Invalid port number: 99999");
  });

  it("cleans up on creation failure", () => {
    mockExecSync.mockImplementation((...args: unknown[]) => {
      const cmd = String(args[0] ?? "");
      if (cmd.includes("docker volume create")) return "vol-123";
      if (cmd.includes("docker create")) throw new Error("image not found");
      return "";
    });

    const manager = new ContainerManager();
    expect(() => manager.createContainer("sess-1", "/tmp", {
      image: "nonexistent:v1", ports: [],
    })).toThrow("Failed to create container");
  });

  it("includes extra volumes and env vars in docker create args", () => {
    let createCmd = "";
    mockExecSync.mockImplementation((...args: unknown[]) => {
      const cmd = String(args[0] ?? "");
      if (cmd.includes("docker volume create")) return "vol-1";
      if (cmd.includes("docker create")) { createCmd = cmd; return "cid123"; }
      if (cmd.includes("docker start")) return "";
      if (cmd.includes("docker port")) return "0.0.0.0:8080";
      if (cmd.includes("gh auth token")) throw new Error("no");
      return "";
    });

    const manager = new ContainerManager();
    manager.createContainer("sess-1", "/tmp/ws", {
      image: "node:22",
      ports: [3000],
      volumes: ["/data:/data:ro"],
      env: { NODE_ENV: "production" },
    });

    expect(createCmd).toContain("/data:/data:ro");
    expect(createCmd).toContain("NODE_ENV=production");
  });

  it("mounts host .gitconfig when it exists", () => {
    let createCmd = "";
    mockExistsSync.mockImplementation((...args: unknown[]) => {
      const path = String(args[0] ?? "");
      return path.endsWith(".gitconfig");
    });
    mockExecSync.mockImplementation((...args: unknown[]) => {
      const cmd = String(args[0] ?? "");
      if (cmd.includes("docker volume create")) return "vol-1";
      if (cmd.includes("docker create")) { createCmd = cmd; return "cid123"; }
      if (cmd.includes("docker start")) return "";
      if (cmd.includes("docker port")) return "";
      if (cmd.includes("gh auth token")) throw new Error("no");
      return "";
    });

    const manager = new ContainerManager();
    manager.createContainer("sess-1", "/tmp", { image: "node:22", ports: [] });
    expect(createCmd).toContain("companion-host-gitconfig");
  });
});

// ---------------------------------------------------------------------------
// seedAuthFiles (private, tested via startContainer which calls it)
// ---------------------------------------------------------------------------

describe("ContainerManager seedAuthFiles via startContainer", () => {
  beforeEach(() => {
    mockExecSync.mockReset();
    mockExistsSync.mockReset();
    mockExistsSync.mockReturnValue(false);
  });

  it("copies auth files from /companion-host-claude to /root/.claude", () => {
    mockExecSync.mockReturnValue("");
    const manager = new ContainerManager();
    manager.startContainer("abc123");

    const cmds = mockExecSync.mock.calls.map((c) => String(c[0] ?? ""));
    // seedAuthFiles runs a docker exec with companion-host-claude
    expect(cmds.some((c) => c.includes("companion-host-claude") && c.includes("/root/.claude"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// copyWorkspaceToContainer — validates container ID
// ---------------------------------------------------------------------------

describe("ContainerManager copyWorkspaceToContainer validation", () => {
  it("rejects invalid container ID", async () => {
    const manager = new ContainerManager();
    await expect(manager.copyWorkspaceToContainer("../evil", "/tmp"))
      .rejects.toThrow("Invalid container ID");
  });
});

// ---------------------------------------------------------------------------
// pullImage
// ---------------------------------------------------------------------------

describe("ContainerManager pullImage", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
    mockExecSync.mockReset();
  });

  it("returns true and tags image on successful pull", async () => {
    // Mock Bun.spawn to return a successful process with readable streams
    const mockStdout = new ReadableStream<Uint8Array>({
      start(controller) { controller.close(); },
    });
    const mockStderr = new ReadableStream<Uint8Array>({
      start(controller) { controller.close(); },
    });
    mockSpawn.mockReturnValue({
      stdout: mockStdout,
      stderr: mockStderr,
      exited: Promise.resolve(0),
      kill: vi.fn(),
    });
    mockExecSync.mockReturnValue("");

    const manager = new ContainerManager();
    const result = await manager.pullImage("docker.io/stangirard/test:v1", "test:v1");
    expect(result).toBe(true);
    // Should tag the image
    const cmds = mockExecSync.mock.calls.map((c) => String(c[0] ?? ""));
    expect(cmds.some((c) => c.includes("docker tag"))).toBe(true);
  });

  it("returns false when pull fails with non-zero exit", async () => {
    const mockStdout = new ReadableStream<Uint8Array>({
      start(controller) { controller.close(); },
    });
    const mockStderr = new ReadableStream<Uint8Array>({
      start(controller) { controller.close(); },
    });
    mockSpawn.mockReturnValue({
      stdout: mockStdout,
      stderr: mockStderr,
      exited: Promise.resolve(1),
      kill: vi.fn(),
    });

    const manager = new ContainerManager();
    const result = await manager.pullImage("nonexistent:v1", "nonexistent:v1");
    expect(result).toBe(false);
  });

  it("skips tagging when remote and local names match", async () => {
    const mockStdout = new ReadableStream<Uint8Array>({
      start(controller) { controller.close(); },
    });
    const mockStderr = new ReadableStream<Uint8Array>({
      start(controller) { controller.close(); },
    });
    mockSpawn.mockReturnValue({
      stdout: mockStdout,
      stderr: mockStderr,
      exited: Promise.resolve(0),
      kill: vi.fn(),
    });

    const manager = new ContainerManager();
    await manager.pullImage("node:22", "node:22");
    // Should NOT call docker tag since names match
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// buildImageStreaming
// ---------------------------------------------------------------------------

describe("ContainerManager buildImageStreaming", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
    mockMkdirSync.mockReset();
    mockWriteFileSync.mockReset();
    mockRmSync.mockReset();
  });

  it("returns success when build succeeds", async () => {
    const mockStdout = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("Step 1/3\nStep 2/3\n"));
        controller.close();
      },
    });
    const mockStderr = new ReadableStream<Uint8Array>({
      start(controller) { controller.close(); },
    });
    mockSpawn.mockReturnValue({
      stdout: mockStdout,
      stderr: mockStderr,
      exited: Promise.resolve(0),
      kill: vi.fn(),
    });

    const lines: string[] = [];
    const manager = new ContainerManager();
    const result = await manager.buildImageStreaming(
      "FROM node:22\nRUN echo hi",
      "test:v1",
      (line) => lines.push(line),
    );
    expect(result.success).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
    // Should write Dockerfile to temp dir
    expect(mockMkdirSync).toHaveBeenCalled();
    expect(mockWriteFileSync).toHaveBeenCalled();
    // Should clean up temp dir
    expect(mockRmSync).toHaveBeenCalled();
  });

  it("returns failure when build fails", async () => {
    const mockStdout = new ReadableStream<Uint8Array>({
      start(controller) { controller.close(); },
    });
    const mockStderr = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("ERROR: invalid syntax\n"));
        controller.close();
      },
    });
    mockSpawn.mockReturnValue({
      stdout: mockStdout,
      stderr: mockStderr,
      exited: Promise.resolve(1),
      kill: vi.fn(),
    });

    const manager = new ContainerManager();
    const result = await manager.buildImageStreaming("INVALID", "test:v1");
    expect(result.success).toBe(false);
    expect(result.log).toContain("ERROR: invalid syntax");
  });
});
