import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Hoisted mocks ──────────────────────────────────────────────────────────

const mockExecSync = vi.hoisted(() => vi.fn());
const mockExistsSync = vi.hoisted(() => vi.fn((_path: string) => false));
const mockReaddirSync = vi.hoisted(() => vi.fn((_path: string) => [] as string[]));
const mockHomedir = vi.hoisted(() => vi.fn(() => "/home/testuser"));

vi.mock("node:child_process", () => ({ execSync: mockExecSync }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: mockExistsSync,
    readdirSync: mockReaddirSync,
  };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: mockHomedir,
  };
});

// ─── Import after mocks ─────────────────────────────────────────────────────

import {
  captureUserShellPath,
  buildFallbackPath,
  getEnrichedPath,
  resolveBinary,
  getServicePath,
  _resetPathCache,
} from "./path-resolver.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  _resetPathCache();
  process.env = { ...originalEnv };
});

afterEach(() => {
  process.env = originalEnv;
});

// ─── captureUserShellPath ───────────────────────────────────────────────────

describe("captureUserShellPath", () => {
  it("extracts PATH from login shell output using sentinel markers", () => {
    mockExecSync.mockReturnValueOnce(
      "___PATH_START___/usr/bin:/home/testuser/.nvm/versions/node/v20/bin:/home/testuser/.cargo/bin___PATH_END___\n",
    );

    const result = captureUserShellPath();
    expect(result).toBe(
      "/usr/bin:/home/testuser/.nvm/versions/node/v20/bin:/home/testuser/.cargo/bin",
    );
  });

  it("handles noisy shell output (MOTD, warnings) before and after PATH", () => {
    mockExecSync.mockReturnValueOnce(
      "Last login: Mon Jan 1\nWelcome!\n___PATH_START___/usr/local/bin:/usr/bin___PATH_END___\nbye\n",
    );

    const result = captureUserShellPath();
    expect(result).toBe("/usr/local/bin:/usr/bin");
  });

  it("falls back to buildFallbackPath when shell sourcing fails", () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error("shell failed");
    });
    // buildFallbackPath needs existsSync to return true for some dirs
    mockExistsSync.mockImplementation((p: string) =>
      p === "/usr/bin" || p === "/bin",
    );

    const result = captureUserShellPath();
    expect(result).toContain("/usr/bin");
    expect(result).toContain("/bin");
  });

  it("falls back when shell output contains no sentinel markers", () => {
    mockExecSync.mockReturnValueOnce("some garbage output\n");
    mockExistsSync.mockImplementation((p: string) => p === "/usr/bin");

    const result = captureUserShellPath();
    // Should fall back to buildFallbackPath
    expect(result).toContain("/usr/bin");
  });

  it("uses $SHELL env var for the shell command", () => {
    process.env.SHELL = "/bin/zsh";
    mockExecSync.mockReturnValueOnce(
      "___PATH_START___/usr/bin___PATH_END___\n",
    );

    captureUserShellPath();

    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("/bin/zsh"),
      expect.any(Object),
    );
  });

  it("defaults to /bin/bash when $SHELL is not set", () => {
    delete process.env.SHELL;
    mockExecSync.mockReturnValueOnce(
      "___PATH_START___/usr/bin___PATH_END___\n",
    );

    captureUserShellPath();

    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("/bin/bash"),
      expect.any(Object),
    );
  });
});

// ─── buildFallbackPath ──────────────────────────────────────────────────────

describe("buildFallbackPath", () => {
  it("includes standard system paths when they exist", () => {
    mockExistsSync.mockImplementation((p: string) =>
      ["/usr/local/bin", "/usr/bin", "/bin"].includes(p as string),
    );

    const result = buildFallbackPath();
    expect(result).toContain("/usr/local/bin");
    expect(result).toContain("/usr/bin");
    expect(result).toContain("/bin");
  });

  it("includes ~/.local/bin for claude CLI", () => {
    mockExistsSync.mockImplementation((p: string) =>
      p === "/home/testuser/.local/bin" || p === "/usr/bin",
    );

    const result = buildFallbackPath();
    expect(result).toContain("/home/testuser/.local/bin");
  });

  it("includes ~/.bun/bin", () => {
    mockExistsSync.mockImplementation((p: string) =>
      p === "/home/testuser/.bun/bin" || p === "/usr/bin",
    );

    const result = buildFallbackPath();
    expect(result).toContain("/home/testuser/.bun/bin");
  });

  it("includes ~/.cargo/bin for Rust tools", () => {
    mockExistsSync.mockImplementation((p: string) =>
      p === "/home/testuser/.cargo/bin" || p === "/usr/bin",
    );

    const result = buildFallbackPath();
    expect(result).toContain("/home/testuser/.cargo/bin");
  });

  it("probes nvm versions directory and includes all version bins", () => {
    // Ensure NVM_DIR is not set so the code falls back to ~/.nvm
    delete process.env.NVM_DIR;
    mockExistsSync.mockImplementation((p: string) => {
      if (p === "/home/testuser/.nvm/versions/node") return true;
      if (p.includes(".nvm/versions/node/v") && p.endsWith("/bin")) return true;
      if (p === "/usr/bin") return true;
      return false;
    });
    mockReaddirSync.mockReturnValue(["v18.20.0", "v22.17.0"] as any);

    const result = buildFallbackPath();
    expect(result).toContain("/home/testuser/.nvm/versions/node/v18.20.0/bin");
    expect(result).toContain("/home/testuser/.nvm/versions/node/v22.17.0/bin");
  });

  it("uses NVM_DIR env var when set", () => {
    process.env.NVM_DIR = "/custom/nvm";
    mockExistsSync.mockImplementation((p: string) => {
      if (p === "/custom/nvm/versions/node") return true;
      if (p.includes("/custom/nvm/versions/node/v") && p.endsWith("/bin"))
        return true;
      return false;
    });
    mockReaddirSync.mockReturnValue(["v20.0.0"] as any);

    const result = buildFallbackPath();
    expect(result).toContain("/custom/nvm/versions/node/v20.0.0/bin");
  });

  it("excludes directories that don't exist", () => {
    mockExistsSync.mockReturnValue(false);

    const result = buildFallbackPath();
    expect(result).toBe("");
  });

  it("deduplicates PATH entries", () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([] as any);

    const result = buildFallbackPath();
    const dirs = result.split(":");
    expect(dirs.length).toBe(new Set(dirs).size);
  });

  describe("Windows support", () => {
    const originalPlatform = process.platform;

    beforeEach(() => {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    });

    afterEach(() => {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    });

    it("uses semicolon as PATH separator on win32", () => {
      mockExistsSync.mockImplementation((p: string) =>
        ["/usr/local/bin", "/usr/bin"].includes(p as string),
      );

      const result = buildFallbackPath();
      // Should use ; not : on Windows
      expect(result).toContain(";");
      expect(result).not.toContain(":");
    });
  });
});

// ─── getEnrichedPath ────────────────────────────────────────────────────────

describe("getEnrichedPath", () => {
  it("merges user shell PATH with current process PATH", () => {
    process.env.PATH = "/usr/bin:/bin";
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === "string" && cmd.includes("-lic")) {
        return "___PATH_START___/usr/bin:/home/testuser/.cargo/bin___PATH_END___\n";
      }
      return "";
    });

    const result = getEnrichedPath();
    expect(result).toContain("/home/testuser/.cargo/bin");
    expect(result).toContain("/usr/bin");
    expect(result).toContain("/bin");
  });

  it("deduplicates entries from both PATHs", () => {
    process.env.PATH = "/usr/bin:/bin:/usr/local/bin";
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === "string" && cmd.includes("-lic")) {
        return "___PATH_START___/usr/bin:/usr/local/bin:/home/testuser/.volta/bin___PATH_END___\n";
      }
      return "";
    });

    const result = getEnrichedPath();
    const dirs = result.split(":");
    expect(dirs.length).toBe(new Set(dirs).size);
    // /usr/bin should appear exactly once
    expect(dirs.filter((d) => d === "/usr/bin").length).toBe(1);
  });

  it("caches the result after first call", () => {
    process.env.PATH = "/usr/bin";
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === "string" && cmd.includes("-lic")) {
        return "___PATH_START___/usr/bin___PATH_END___\n";
      }
      return "";
    });

    const first = getEnrichedPath();
    mockExecSync.mockClear();
    const second = getEnrichedPath();

    expect(first).toBe(second);
    // execSync should NOT be called again (result was cached)
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it("gives user shell PATH precedence over process PATH", () => {
    // User's shell has /opt/homebrew/bin first, process PATH has /usr/bin first
    process.env.PATH = "/usr/bin:/bin";
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === "string" && cmd.includes("-lic")) {
        return "___PATH_START___/opt/homebrew/bin:/usr/bin___PATH_END___\n";
      }
      return "";
    });

    const result = getEnrichedPath();
    const dirs = result.split(":");
    expect(dirs.indexOf("/opt/homebrew/bin")).toBeLessThan(
      dirs.indexOf("/bin"),
    );
  });

  describe("Windows support", () => {
    const originalPlatform = process.platform;

    beforeEach(() => {
      _resetPathCache(); // ensure no cross-contamination from non-Windows tests
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    });

    afterEach(() => {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    });

    it("splits and joins PATH with semicolons on win32", () => {
      process.env.PATH = "C:\\Windows\\System32;C:\\Windows";
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.includes("-lic")) {
          return "___PATH_START___C:\\Users\\me\\AppData\\Roaming\\npm;C:\\Windows\\System32___PATH_END___\n";
        }
        return "";
      });

      const result = getEnrichedPath();
      // Should use ; as separator and contain all directories
      expect(result).toContain("C:\\Users\\me\\AppData\\Roaming\\npm");
      expect(result).toContain("C:\\Windows\\System32");
      expect(result).toContain("C:\\Windows");
      // Should be semicolon-separated
      const dirs = result.split(";");
      expect(dirs.length).toBeGreaterThanOrEqual(3);
      // C:\Windows\System32 should appear exactly once (deduplication)
      expect(dirs.filter((d) => d === "C:\\Windows\\System32").length).toBe(1);
    });
  });
});

// ─── resolveBinary ──────────────────────────────────────────────────────────

describe("resolveBinary", () => {
  beforeEach(() => {
    // Seed getEnrichedPath cache to avoid shell-sourcing side effects
    process.env.PATH = "/usr/bin:/bin";
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === "string" && cmd.includes("-lic")) {
        return "___PATH_START___/usr/bin:/usr/local/bin___PATH_END___\n";
      }
      throw new Error("not found");
    });
  });

  it("returns absolute path when binary is found via which", () => {
    _resetPathCache();
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === "string" && cmd.includes("-lic")) {
        return "___PATH_START___/usr/bin___PATH_END___\n";
      }
      if (typeof cmd === "string" && cmd.startsWith("which claude")) {
        return "/home/testuser/.local/bin/claude\n";
      }
      throw new Error("not found");
    });

    expect(resolveBinary("claude")).toBe("/home/testuser/.local/bin/claude");
  });

  it("returns null when binary is not found anywhere", () => {
    _resetPathCache();
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === "string" && cmd.includes("-lic")) {
        return "___PATH_START___/usr/bin___PATH_END___\n";
      }
      throw new Error("not found");
    });

    expect(resolveBinary("nonexistent")).toBeNull();
  });

  it("passes enriched PATH to which command", () => {
    _resetPathCache();
    mockExecSync.mockImplementation((cmd: string, opts?: any) => {
      if (typeof cmd === "string" && cmd.includes("-lic")) {
        return "___PATH_START___/usr/bin:/home/testuser/.special/bin___PATH_END___\n";
      }
      if (typeof cmd === "string" && cmd.startsWith("which")) {
        // Verify enriched PATH is passed in env
        expect(opts?.env?.PATH).toContain("/home/testuser/.special/bin");
        return "/home/testuser/.special/bin/mytool\n";
      }
      throw new Error("not found");
    });

    resolveBinary("mytool");
  });

  it("returns the path directly when given an absolute path that exists", () => {
    mockExistsSync.mockReturnValue(true);
    expect(resolveBinary("/opt/bin/claude")).toBe("/opt/bin/claude");
  });

  it("returns null when given an absolute path that does not exist", () => {
    mockExistsSync.mockReturnValue(false);
    expect(resolveBinary("/nonexistent/claude")).toBeNull();
  });

  describe("Windows support", () => {
    const originalPlatform = process.platform;

    beforeEach(() => {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    });

    afterEach(() => {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    });

    it("accepts Windows absolute paths like C:\\... on win32", () => {
      mockExistsSync.mockReturnValue(true);
      expect(resolveBinary("C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd")).toBe(
        "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd",
      );
    });

    it("returns null for a non-existent Windows absolute path", () => {
      mockExistsSync.mockReturnValue(false);
      expect(resolveBinary("D:\\nonexistent\\claude.cmd")).toBeNull();
    });

    it("prefers 'where' over 'which' on Windows when both succeed", () => {
      _resetPathCache();
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.includes("-lic")) {
          return "___PATH_START___/usr/bin___PATH_END___\n";
        }
        // 'where' succeeds with a native Win32 path
        if (typeof cmd === "string" && cmd.startsWith("where")) {
          return "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd\r\nC:\\Users\\me\\AppData\\Roaming\\npm\\claude\r\n";
        }
        // 'which' also succeeds but returns a POSIX-style path (Git Bash)
        if (typeof cmd === "string" && cmd.startsWith("which")) {
          return "/c/Users/me/AppData/Roaming/npm/claude";
        }
        throw new Error("not found");
      });

      // Should return the 'where' result (native Win32 path), not the 'which' POSIX path
      expect(resolveBinary("claude")).toBe("C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd");
    });

    it("falls back to 'which' when 'where' fails on Windows", () => {
      _resetPathCache();
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.includes("-lic")) {
          return "___PATH_START___/usr/bin___PATH_END___\n";
        }
        // 'where' fails
        if (typeof cmd === "string" && cmd.startsWith("where")) {
          throw new Error("not found");
        }
        // 'which' succeeds (Git Bash fallback)
        if (typeof cmd === "string" && cmd.startsWith("which")) {
          return "/c/Users/me/AppData/Roaming/npm/claude";
        }
        throw new Error("not found");
      });

      expect(resolveBinary("claude")).toBe("/c/Users/me/AppData/Roaming/npm/claude");
    });

    it("prefers .cmd result from 'where' output with multiple lines", () => {
      _resetPathCache();
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.includes("-lic")) {
          return "___PATH_START___/usr/bin___PATH_END___\n";
        }
        if (typeof cmd === "string" && cmd.startsWith("which")) {
          throw new Error("not found");
        }
        if (typeof cmd === "string" && cmd.startsWith("where")) {
          return "C:\\Program Files\\nodejs\\node\r\nC:\\Users\\me\\AppData\\Roaming\\npm\\node.cmd\r\n";
        }
        throw new Error("not found");
      });

      expect(resolveBinary("node")).toBe("C:\\Users\\me\\AppData\\Roaming\\npm\\node.cmd");
    });

    it("returns first line from 'where' when no .cmd match exists", () => {
      _resetPathCache();
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.includes("-lic")) {
          return "___PATH_START___/usr/bin___PATH_END___\n";
        }
        if (typeof cmd === "string" && cmd.startsWith("which")) {
          throw new Error("not found");
        }
        if (typeof cmd === "string" && cmd.startsWith("where")) {
          return "C:\\Program Files\\nodejs\\node.exe\r\n";
        }
        throw new Error("not found");
      });

      expect(resolveBinary("node")).toBe("C:\\Program Files\\nodejs\\node.exe");
    });
  });
});

// ─── getServicePath ─────────────────────────────────────────────────────────

describe("getServicePath", () => {
  it("returns the same value as getEnrichedPath", () => {
    process.env.PATH = "/usr/bin";
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === "string" && cmd.includes("-lic")) {
        return "___PATH_START___/usr/bin:/opt/homebrew/bin___PATH_END___\n";
      }
      return "";
    });

    expect(getServicePath()).toBe(getEnrichedPath());
  });
});

// ─── _resetPathCache ────────────────────────────────────────────────────────

describe("_resetPathCache", () => {
  it("clears the cached PATH so next call re-computes", () => {
    process.env.PATH = "/usr/bin";
    let callCount = 0;
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === "string" && cmd.includes("-lic")) {
        callCount++;
        return `___PATH_START___/usr/bin:/call-${callCount}___PATH_END___\n`;
      }
      return "";
    });

    const first = getEnrichedPath();
    _resetPathCache();
    const second = getEnrichedPath();

    expect(first).not.toBe(second);
    expect(first).toContain("/call-1");
    expect(second).toContain("/call-2");
  });
});
