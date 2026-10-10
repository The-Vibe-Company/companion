import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

/**
 * Tests for TerminalManager — manages PTY terminal instances spawned via
 * Bun.spawn with terminal option. Tests mock Bun.spawn and verify the
 * manager's state tracking, socket management, and lifecycle methods.
 *
 * External dependencies mocked:
 * - Bun.spawn — PTY process spawning
 * - node:fs existsSync — shell detection
 * - node:crypto randomUUID — deterministic IDs
 * - ServerWebSocket — browser socket interactions
 */

// ── Mocks (hoisted) ──────────────────────────────────────────────────────────

const { mockExistsSync, mockRandomUUID } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(() => true),
  mockRandomUUID: vi.fn(() => "test-terminal-uuid-1"),
}));

vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
}));

vi.mock("node:crypto", () => ({
  randomUUID: mockRandomUUID,
}));

// ── Mock Bun.spawn ────────────────────────────────────────────────────────────

interface MockTerminal {
  write: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

interface MockProc {
  pid: number;
  exitCode: number | null;
  terminal: MockTerminal;
  exited: Promise<number>;
  kill: ReturnType<typeof vi.fn>;
  _resolveExited?: (code: number) => void;
}

let lastMockProc: MockProc;

function createMockProc(): MockProc {
  let resolveExited: (code: number) => void;
  const exitedPromise = new Promise<number>((resolve) => {
    resolveExited = resolve;
  });

  const terminal: MockTerminal = {
    write: vi.fn(),
    resize: vi.fn(),
    close: vi.fn(),
  };

  const proc: MockProc = {
    pid: 12345,
    exitCode: null,
    terminal,
    exited: exitedPromise,
    kill: vi.fn(),
    _resolveExited: resolveExited!,
  };

  lastMockProc = proc;
  return proc;
}

// Replace Bun.spawn globally for tests
const originalBunSpawn = globalThis.Bun?.spawn;

import type { ServerWebSocket } from "bun";
import type { SocketData } from "./ws-bridge.js";
import { TerminalManager } from "./terminal-manager.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTerminalWs(terminalId: string): ServerWebSocket<SocketData> {
  return {
    send: vi.fn(),
    sendBinary: vi.fn(),
    data: { kind: "terminal" as const, terminalId },
  } as unknown as ServerWebSocket<SocketData>;
}

function makeBrowserWs(sessionId: string): ServerWebSocket<SocketData> {
  return {
    send: vi.fn(),
    data: { kind: "browser" as const, sessionId },
  } as unknown as ServerWebSocket<SocketData>;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

let manager: TerminalManager;

beforeEach(() => {
  manager = new TerminalManager();
  mockExistsSync.mockReturnValue(true);
  mockRandomUUID.mockReturnValue("test-terminal-uuid-1");

  // Mock Bun.spawn to return our controlled mock process
  (globalThis as any).Bun = {
    ...globalThis.Bun,
    spawn: vi.fn(() => {
      const proc = createMockProc();
      return proc;
    }),
  };

  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  if (originalBunSpawn) {
    (globalThis as any).Bun.spawn = originalBunSpawn;
  }
  vi.restoreAllMocks();
});

describe("TerminalManager", () => {
  // ── getInfo() ─────────────────────────────────────────────────────────────

  describe("getInfo", () => {
    it("should_return_null_when_no_terminals_exist", () => {
      expect(manager.getInfo()).toBeNull();
    });

    it("should_return_null_when_specific_terminal_not_found", () => {
      expect(manager.getInfo("nonexistent-id")).toBeNull();
    });

    it("should_return_terminal_info_when_terminal_spawned", () => {
      const id = manager.spawn("/tmp/test");
      const info = manager.getInfo(id);
      expect(info).toEqual({
        id: "test-terminal-uuid-1",
        cwd: "/tmp/test",
        containerId: undefined,
      });
    });

    it("should_return_first_terminal_when_no_id_specified", () => {
      manager.spawn("/tmp/first");
      const info = manager.getInfo();
      expect(info).not.toBeNull();
      expect(info!.cwd).toBe("/tmp/first");
    });

    it("should_include_containerId_when_spawned_in_container", () => {
      const id = manager.spawn("/app", 80, 24, { containerId: "abc123def" });
      const info = manager.getInfo(id);
      expect(info!.containerId).toBe("abc123def");
    });
  });

  // ── spawn() ───────────────────────────────────────────────────────────────

  describe("spawn", () => {
    it("should_return_uuid_when_terminal_spawned", () => {
      const id = manager.spawn("/tmp/test");
      expect(id).toBe("test-terminal-uuid-1");
    });

    it("should_call_bun_spawn_with_shell_and_terminal_options", () => {
      manager.spawn("/tmp/test", 120, 40);
      expect(Bun.spawn).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          cwd: "/tmp/test",
          terminal: expect.objectContaining({
            cols: 120,
            rows: 40,
          }),
        }),
      );
    });

    it("should_use_docker_exec_when_containerId_provided", () => {
      manager.spawn("/app", 80, 24, { containerId: "container123" });
      const spawnCall = (Bun.spawn as any).mock.calls[0];
      const cmd = spawnCall[0];
      expect(cmd[0]).toBe("docker");
      expect(cmd[1]).toBe("exec");
      expect(cmd).toContain("container123");
      // cwd should be undefined for container spawns (Docker handles it)
      expect(spawnCall[1].cwd).toBeUndefined();
    });

    it("should_use_default_cols_and_rows_when_not_specified", () => {
      manager.spawn("/tmp/test");
      expect(Bun.spawn).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          terminal: expect.objectContaining({
            cols: 80,
            rows: 24,
          }),
        }),
      );
    });

    it("should_trim_containerId_whitespace", () => {
      manager.spawn("/app", 80, 24, { containerId: "  abc  " });
      const info = manager.getInfo("test-terminal-uuid-1");
      expect(info!.containerId).toBe("abc");
    });

    it("should_treat_empty_containerId_as_undefined", () => {
      manager.spawn("/app", 80, 24, { containerId: "   " });
      const info = manager.getInfo("test-terminal-uuid-1");
      expect(info!.containerId).toBeUndefined();
    });
  });

  // ── resize() ──────────────────────────────────────────────────────────────

  describe("resize", () => {
    it("should_resize_terminal_when_valid_id_provided", () => {
      const id = manager.spawn("/tmp/test");
      manager.resize(id, 200, 50);
      expect(lastMockProc.terminal.resize).toHaveBeenCalledWith(200, 50);
    });

    it("should_noop_when_terminal_not_found", () => {
      // Should not throw
      manager.resize("nonexistent", 100, 50);
    });

    it("should_handle_resize_failure_gracefully", () => {
      const id = manager.spawn("/tmp/test");
      lastMockProc.terminal.resize.mockImplementation(() => {
        throw new Error("resize failed");
      });
      // Should not throw
      manager.resize(id, 100, 50);
    });
  });

  // ── handleBrowserMessage() ────────────────────────────────────────────────

  describe("handleBrowserMessage", () => {
    it("should_write_to_terminal_when_input_message_received", () => {
      const id = manager.spawn("/tmp/test");
      const ws = makeTerminalWs(id);
      manager.addBrowserSocket(ws);

      manager.handleBrowserMessage(ws, JSON.stringify({ type: "input", data: "ls -la\n" }));

      expect(lastMockProc.terminal.write).toHaveBeenCalledWith("ls -la\n");
    });

    it("should_resize_terminal_when_resize_message_received", () => {
      const id = manager.spawn("/tmp/test");
      const ws = makeTerminalWs(id);
      manager.addBrowserSocket(ws);

      manager.handleBrowserMessage(ws, JSON.stringify({ type: "resize", cols: 150, rows: 35 }));

      expect(lastMockProc.terminal.resize).toHaveBeenCalledWith(150, 35);
    });

    it("should_ignore_malformed_json_messages", () => {
      const id = manager.spawn("/tmp/test");
      const ws = makeTerminalWs(id);
      manager.addBrowserSocket(ws);

      // Should not throw on invalid JSON
      manager.handleBrowserMessage(ws, "not-valid-json");
      expect(lastMockProc.terminal.write).not.toHaveBeenCalled();
    });

    it("should_noop_when_socket_is_not_terminal_kind", () => {
      manager.spawn("/tmp/test");
      const ws = makeBrowserWs("session-1");

      // Browser socket (not terminal) — should be ignored
      manager.handleBrowserMessage(ws, JSON.stringify({ type: "input", data: "x" }));
      expect(lastMockProc.terminal.write).not.toHaveBeenCalled();
    });

    it("should_noop_when_terminal_not_found_for_socket", () => {
      const ws = makeTerminalWs("nonexistent-terminal");
      // Should not throw
      manager.handleBrowserMessage(ws, JSON.stringify({ type: "input", data: "x" }));
    });

    it("should_ignore_input_message_with_non_string_data", () => {
      const id = manager.spawn("/tmp/test");
      const ws = makeTerminalWs(id);
      manager.addBrowserSocket(ws);

      manager.handleBrowserMessage(ws, JSON.stringify({ type: "input", data: 123 }));
      expect(lastMockProc.terminal.write).not.toHaveBeenCalled();
    });
  });

  // ── addBrowserSocket / removeBrowserSocket ────────────────────────────────

  describe("addBrowserSocket / removeBrowserSocket", () => {
    it("should_add_browser_socket_to_terminal_instance", () => {
      const id = manager.spawn("/tmp/test");
      const ws = makeTerminalWs(id);
      manager.addBrowserSocket(ws);

      // Verify it works by sending a message through
      manager.handleBrowserMessage(ws, JSON.stringify({ type: "input", data: "test" }));
      expect(lastMockProc.terminal.write).toHaveBeenCalledWith("test");
    });

    it("should_noop_when_adding_socket_for_nonexistent_terminal", () => {
      const ws = makeTerminalWs("ghost");
      // Should not throw
      manager.addBrowserSocket(ws);
    });

    it("should_noop_when_removing_socket_for_nonexistent_terminal", () => {
      const ws = makeTerminalWs("ghost");
      // Should not throw
      manager.removeBrowserSocket(ws);
    });

    it("should_start_orphan_timer_when_last_browser_disconnects", () => {
      vi.useFakeTimers();
      const id = manager.spawn("/tmp/test");
      const ws = makeTerminalWs(id);
      manager.addBrowserSocket(ws);
      manager.removeBrowserSocket(ws);

      // Terminal should still exist before grace period
      expect(manager.getInfo(id)).not.toBeNull();

      // After 5s grace period, orphaned terminal should be killed
      vi.advanceTimersByTime(5000);
      expect(manager.getInfo(id)).toBeNull();

      vi.useRealTimers();
    });

    it("should_cancel_orphan_timer_when_new_browser_connects", () => {
      vi.useFakeTimers();
      const id = manager.spawn("/tmp/test");
      const ws1 = makeTerminalWs(id);
      const ws2 = makeTerminalWs(id);

      manager.addBrowserSocket(ws1);
      manager.removeBrowserSocket(ws1);

      // Before timer fires, add another browser
      vi.advanceTimersByTime(2000);
      manager.addBrowserSocket(ws2);

      // Original timer fires but terminal should still exist
      vi.advanceTimersByTime(5000);
      expect(manager.getInfo(id)).not.toBeNull();

      vi.useRealTimers();
    });
  });

  // ── kill() ────────────────────────────────────────────────────────────────

  describe("kill", () => {
    it("should_kill_process_and_remove_instance", () => {
      const id = manager.spawn("/tmp/test");
      manager.kill(id);

      expect(lastMockProc.kill).toHaveBeenCalled();
      expect(manager.getInfo(id)).toBeNull();
    });

    it("should_noop_when_killing_nonexistent_terminal", () => {
      // Should not throw
      manager.kill("nonexistent");
    });

    it("should_handle_kill_failure_gracefully", () => {
      const id = manager.spawn("/tmp/test");
      lastMockProc.kill.mockImplementation(() => {
        throw new Error("process already exited");
      });
      // Should not throw
      manager.kill(id);
      expect(manager.getInfo(id)).toBeNull();
    });
  });
});
