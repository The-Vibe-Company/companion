/**
 * PATH discovery and binary resolution for service environments.
 *
 * When The Companion runs as a macOS launchd or Linux systemd service, it inherits
 * a restricted PATH that omits directories from version managers (nvm, fnm, volta,
 * mise, etc.) and user-local installs (~/.local/bin, ~/.cargo/bin). This module
 * captures the user's real shell PATH at runtime and provides binary resolution
 * that works regardless of how the server was started.
 */

import { execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Capture the user's full interactive shell PATH by spawning a login shell.
 * This picks up all version manager initializations (nvm, fnm, volta, mise, etc.).
 * Falls back to probing common directories if shell sourcing fails.
 */
export function captureUserShellPath(): string {
  try {
    const shell = process.env.SHELL || "/bin/bash";
    const captured = execSync(
      `${shell} -lic 'echo "___PATH_START___$PATH___PATH_END___"'`,
      {
        encoding: "utf-8",
        timeout: 10_000,
        env: { HOME: homedir(), USER: process.env.USER, SHELL: shell },
      },
    );
    const match = captured.match(/___PATH_START___(.+)___PATH_END___/);
    if (match?.[1]) {
      return match[1];
    }
  } catch {
    // Shell sourcing failed (timeout, compinit prompt, etc.)
  }

  return buildFallbackPath();
}

/**
 * Build a PATH by probing common binary installation directories.
 * Used as fallback when shell-sourcing fails.
 */
export function buildFallbackPath(): string {
  const home = homedir();
  const candidates = [
    // Standard system paths
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    // Bun
    join(home, ".bun", "bin"),
    // Claude CLI / user-local installs
    join(home, ".local", "bin"),
    // Cargo / Rust
    join(home, ".cargo", "bin"),
    // Volta (Node version manager)
    join(home, ".volta", "bin"),
    // mise (formerly rtx)
    join(home, ".local", "share", "mise", "shims"),
    // pyenv
    join(home, ".pyenv", "bin"),
    join(home, ".pyenv", "shims"),
    // Go
    join(home, "go", "bin"),
    "/usr/local/go/bin",
    // Deno
    join(home, ".deno", "bin"),
  ];

  // Probe nvm-managed node versions
  const nvmDir = process.env.NVM_DIR || join(home, ".nvm");
  const nvmVersionsDir = join(nvmDir, "versions", "node");
  if (existsSync(nvmVersionsDir)) {
    try {
      for (const v of readdirSync(nvmVersionsDir)) {
        candidates.push(join(nvmVersionsDir, v, "bin"));
      }
    } catch { /* ignore */ }
  }

  // fnm (Fast Node Manager) — versions stored in fnm multishell or XDG data
  const fnmDir = join(home, "Library", "Application Support", "fnm", "node-versions");
  if (existsSync(fnmDir)) {
    try {
      for (const v of readdirSync(fnmDir)) {
        candidates.push(join(fnmDir, v, "installation", "bin"));
      }
    } catch { /* ignore */ }
  }

  const pathSep = process.platform === "win32" ? ";" : ":";
  return [...new Set(candidates.filter((dir) => existsSync(dir)))].join(pathSep);
}

// ─── Enriched PATH (cached) ───────────────────────────────────────────────────

let _cachedPath: string | null = null;

/**
 * Returns an enriched PATH that merges the user's shell PATH (or probed common
 * directories) with the current process PATH. Deduplicates entries.
 * Result is cached after the first call.
 */
export function getEnrichedPath(): string {
  if (_cachedPath) return _cachedPath;

  const currentPath = process.env.PATH || "";
  const userPath = captureUserShellPath();
  const pathSep = process.platform === "win32" ? ";" : ":";

  // Merge: user shell PATH first (takes precedence), then current process PATH
  const allDirs = [...userPath.split(pathSep), ...currentPath.split(pathSep)];
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const dir of allDirs) {
    if (dir && !seen.has(dir)) {
      seen.add(dir);
      deduped.push(dir);
    }
  }

  _cachedPath = deduped.join(pathSep);
  return _cachedPath;
}

/** Reset the cached PATH (for testing). */
export function _resetPathCache(): void {
  _cachedPath = null;
}

// ─── Binary resolution ────────────────────────────────────────────────────────

/**
 * Resolve a binary name to an absolute path using the enriched PATH.
 * Returns null if the binary is not found anywhere.
 */
export function resolveBinary(name: string): string | null {
  if (name.startsWith("/")) {
    return existsSync(name) ? name : null;
  }
  // On Windows, also accept absolute paths like C:\... or D:\...
  if (process.platform === "win32" && /^[a-zA-Z]:[/\\]/.test(name)) {
    return existsSync(name) ? name : null;
  }

  const sanitized = name.replace(/[^a-zA-Z0-9._@/-]/g, "");
  const enrichedPath = getEnrichedPath();

  // Try `where` first on Windows (returns native Win32 paths), then `which` as fallback
  const commands = process.platform === "win32" ? ["where", "which"] : ["which"];
  for (const cmd of commands) {
    try {
      const result = execSync(`${cmd} ${sanitized}`, {
        encoding: "utf-8",
        timeout: 5_000,
        env: { ...process.env, PATH: enrichedPath },
      }).trim();
      if (!result) continue;
      // `where` on Windows may return multiple lines; prefer .cmd for Bun.spawn compatibility
      if (cmd === "where") {
        const lines = result.split(/\r?\n/).filter(Boolean);
        return lines.find(l => l.endsWith(".cmd")) || lines[0];
      }
      return result;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Returns a PATH string suitable for embedding in service definitions
 * (plist/systemd unit). Captures the user's shell PATH at install time.
 */
export function getServicePath(): string {
  return getEnrichedPath();
}
