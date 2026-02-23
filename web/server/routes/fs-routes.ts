import { execSync } from "node:child_process";
import { readdir, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { Hono } from "hono";

function shellEscapeArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function execCaptureStdout(
  command: string,
  options: { cwd: string; encoding: "utf-8"; timeout: number },
): string {
  try {
    return execSync(command, options);
  } catch (err: unknown) {
    const maybe = err as { stdout?: Buffer | string };
    if (typeof maybe.stdout === "string") return maybe.stdout;
    if (maybe.stdout && Buffer.isBuffer(maybe.stdout)) {
      return maybe.stdout.toString("utf-8");
    }
    throw err;
  }
}

function resolveBranchDiffBases(repoRoot: string): string[] {
  const options = { cwd: repoRoot, encoding: "utf-8", timeout: 5000 } as const;

  try {
    const originHead = execSync("git symbolic-ref refs/remotes/origin/HEAD", options).trim();
    const match = originHead.match(/^refs\/remotes\/origin\/(.+)$/);
    if (match?.[1]) {
      return [`origin/${match[1]}`, match[1]];
    }
  } catch {
    // No remote HEAD ref available, fallback to common local defaults.
  }

  try {
    const branches = execSync("git branch --list main master", options).trim();
    if (branches.includes("main")) return ["main"];
    if (branches.includes("master")) return ["master"];
  } catch {
    // Ignore and use a conservative fallback below.
  }

  return ["main"];
}

/** Build a Content-Disposition header value safe for non-ASCII filenames (RFC 5987). */
function contentDisposition(fileName: string): string {
  // ASCII-only: use simple filename; otherwise add RFC 5987 filename* with UTF-8 encoding
  const isAscii = /^[\x20-\x7E]+$/.test(fileName);
  if (isAscii) return `attachment; filename="${fileName}"`;
  const encoded = encodeURIComponent(fileName).replace(/'/g, "%27");
  return `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`;
}

/** Ensure the resolved path is within the user's home directory to prevent path traversal. */
function assertWithinHome(absPath: string): void {
  const home = homedir();
  if (!absPath.startsWith(home + "/") && absPath !== home) {
    throw new Error("Path outside home directory");
  }
}

export function registerFsRoutes(api: Hono): void {
  api.get("/fs/list", async (c) => {
    const rawPath = c.req.query("path") || homedir();
    const basePath = resolve(rawPath);
    try {
      const entries = await readdir(basePath, { withFileTypes: true });
      const dirs: { name: string; path: string }[] = [];
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith(".")) {
          dirs.push({ name: entry.name, path: join(basePath, entry.name) });
        }
      }
      dirs.sort((a, b) => a.name.localeCompare(b.name));
      return c.json({ path: basePath, dirs, home: homedir() });
    } catch {
      return c.json(
        {
          error: "Cannot read directory",
          path: basePath,
          dirs: [],
          home: homedir(),
        },
        400,
      );
    }
  });

  // List files AND directories (unlike /fs/list which only lists directories)
  api.get("/fs/list-entries", async (c) => {
    const rawPath = c.req.query("path");
    if (!rawPath) return c.json({ error: "path required" }, 400);
    const basePath = resolve(rawPath);
    try { assertWithinHome(basePath); } catch {
      return c.json({ error: "Path outside home directory" }, 403);
    }
    const showHidden = c.req.query("showHidden") === "true";
    const showIgnored = c.req.query("showIgnored") === "true";

    try {
      const dirEntries = await readdir(basePath, { withFileTypes: true });

      // Build set of git-ignored files if in a git repo and showIgnored is false
      const ignoredFiles = new Set<string>();
      if (!showIgnored) {
        try {
          const revParseResult = Bun.spawnSync(
            ["git", "rev-parse", "--show-toplevel"],
            { cwd: basePath, stdout: "pipe", stderr: "pipe" },
          );
          if (revParseResult.exitCode !== 0) throw new Error("not a git repo");
          const repoRoot = revParseResult.stdout.toString().trim();
          const lsFilesResult = Bun.spawnSync(
            ["git", "-C", repoRoot, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", basePath + "/"],
            { stdout: "pipe", stderr: "pipe" },
          );
          const gitIgnored = (lsFilesResult.stdout?.toString() || "").trim();
          for (const line of gitIgnored.split("\n")) {
            if (line.trim()) {
              const name = line.trim().replace(/\/$/, "").split("/").pop();
              if (name) ignoredFiles.add(name);
            }
          }
        } catch {
          // Not a git repo — skip ignore filtering
        }
      }

      interface DirEntry {
        name: string;
        type: "file" | "directory";
        size?: number;
        mtime?: string;
      }
      const entries: DirEntry[] = [];

      for (const entry of dirEntries) {
        if (entry.name === ".git") continue;
        if (!showHidden && entry.name.startsWith(".")) continue;
        if (ignoredFiles.has(entry.name)) continue;

        if (entry.isDirectory()) {
          entries.push({ name: entry.name, type: "directory" });
        } else if (entry.isFile()) {
          try {
            const info = await stat(join(basePath, entry.name));
            entries.push({
              name: entry.name,
              type: "file",
              size: info.size,
              mtime: info.mtime.toISOString(),
            });
          } catch {
            entries.push({ name: entry.name, type: "file" });
          }
        }
      }

      entries.sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      return c.json({ path: basePath, entries });
    } catch {
      return c.json(
        { error: "Cannot read directory", path: basePath, entries: [] },
        400,
      );
    }
  });

  // Download a single file
  api.get("/fs/download", async (c) => {
    const filePath = c.req.query("path");
    if (!filePath) return c.json({ error: "path required" }, 400);
    const absPath = resolve(filePath);
    try { assertWithinHome(absPath); } catch {
      return c.json({ error: "Path outside home directory" }, 403);
    }
    try {
      const info = await stat(absPath);
      if (!info.isFile()) return c.json({ error: "Not a file" }, 400);
      const file = Bun.file(absPath);
      const fileName = basename(absPath) || "download";
      return new Response(file.stream(), {
        headers: {
          "Content-Type": file.type || "application/octet-stream",
          "Content-Disposition": contentDisposition(fileName),
          "Content-Length": String(info.size),
        },
      });
    } catch (e: unknown) {
      return c.json(
        { error: e instanceof Error ? e.message : "Cannot download file" },
        404,
      );
    }
  });

  // Download a directory as a zip archive
  api.get("/fs/download-zip", async (c) => {
    const dirPath = c.req.query("path");
    if (!dirPath) return c.json({ error: "path required" }, 400);
    const absPath = resolve(dirPath);
    try { assertWithinHome(absPath); } catch {
      return c.json({ error: "Path outside home directory" }, 403);
    }
    try {
      const info = await stat(absPath);
      if (!info.isDirectory()) return c.json({ error: "Not a directory" }, 400);
      const dirName = basename(absPath) || "archive";

      let zipBuffer: Buffer;
      try {
        const revParseResult = Bun.spawnSync(
          ["git", "rev-parse", "--show-toplevel"],
          { cwd: absPath, stdout: "pipe", stderr: "pipe" },
        );
        if (revParseResult.exitCode !== 0) throw new Error("not a git repo");
        const repoRoot = revParseResult.stdout.toString().trim();
        const relPath =
          absPath.startsWith(repoRoot)
            ? absPath.slice(repoRoot.length + 1) || "."
            : ".";
        const result = Bun.spawnSync(
          [
            "git",
            "archive",
            "--format=zip",
            `--prefix=${dirName}/`,
            "HEAD",
            relPath,
          ],
          { cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
        );
        if (result.exitCode === 0 && result.stdout.length > 0) {
          zipBuffer = Buffer.from(result.stdout);
        } else {
          throw new Error("git archive failed");
        }
      } catch {
        const result = Bun.spawnSync(
          ["zip", "-r", "-", ".", "-x", ".git/*", "-x", "node_modules/*"],
          { cwd: absPath, stdout: "pipe", stderr: "pipe" },
        );
        if (result.exitCode !== 0)
          return c.json({ error: "Failed to create zip archive" }, 500);
        zipBuffer = Buffer.from(result.stdout);
      }

      if (zipBuffer.length > 100 * 1024 * 1024) {
        return c.json({ error: "Archive too large (>100MB)" }, 413);
      }

      return new Response(new Uint8Array(zipBuffer), {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": contentDisposition(`${dirName}.zip`),
          "Content-Length": String(zipBuffer.length),
        },
      });
    } catch (e: unknown) {
      return c.json(
        { error: e instanceof Error ? e.message : "Cannot create archive" },
        500,
      );
    }
  });

  api.get("/fs/home", (c) => {
    const home = homedir();
    const cwd = process.cwd();
    // Only report cwd if the user launched companion from a real project directory
    // (not from the package root or the home directory itself)
    const packageRoot = process.env.__COMPANION_PACKAGE_ROOT;
    const isProjectDir =
      cwd !== home &&
      (!packageRoot || !cwd.startsWith(packageRoot));
    return c.json({ home, cwd: isProjectDir ? cwd : home });
  });

  api.get("/fs/tree", async (c) => {
    const rawPath = c.req.query("path");
    if (!rawPath) return c.json({ error: "path required" }, 400);
    const basePath = resolve(rawPath);

    interface TreeNode {
      name: string;
      path: string;
      type: "file" | "directory";
      children?: TreeNode[];
    }

    async function buildTree(dir: string, depth: number): Promise<TreeNode[]> {
      if (depth > 10) return [];
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        const nodes: TreeNode[] = [];
        for (const entry of entries) {
          if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory()) {
            const children = await buildTree(fullPath, depth + 1);
            nodes.push({
              name: entry.name,
              path: fullPath,
              type: "directory",
              children,
            });
          } else if (entry.isFile()) {
            nodes.push({ name: entry.name, path: fullPath, type: "file" });
          }
        }
        nodes.sort((a, b) => {
          if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        return nodes;
      } catch {
        return [];
      }
    }

    const tree = await buildTree(basePath, 0);
    return c.json({ path: basePath, tree });
  });

  api.get("/fs/read", async (c) => {
    const filePath = c.req.query("path");
    if (!filePath) return c.json({ error: "path required" }, 400);
    const absPath = resolve(filePath);
    try {
      const info = await stat(absPath);
      if (info.size > 2 * 1024 * 1024) {
        return c.json({ error: "File too large (>2MB)" }, 413);
      }
      const content = await readFile(absPath, "utf-8");
      return c.json({ path: absPath, content });
    } catch (e: unknown) {
      return c.json(
        { error: e instanceof Error ? e.message : "Cannot read file" },
        404,
      );
    }
  });

  api.put("/fs/write", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { path: filePath, content } = body;
    if (!filePath || typeof content !== "string") {
      return c.json({ error: "path and content required" }, 400);
    }
    const absPath = resolve(filePath);
    try {
      await writeFile(absPath, content, "utf-8");
      return c.json({ ok: true, path: absPath });
    } catch (e: unknown) {
      return c.json(
        { error: e instanceof Error ? e.message : "Cannot write file" },
        500,
      );
    }
  });

  api.get("/fs/diff", (c) => {
    const filePath = c.req.query("path");
    if (!filePath) return c.json({ error: "path required" }, 400);
    const base = c.req.query("base");
    const absPath = resolve(filePath);
    try {
      const repoRoot = execSync("git rev-parse --show-toplevel", {
        cwd: dirname(absPath),
        encoding: "utf-8",
        timeout: 5000,
      }).trim();
      const relPath = execSync(`git -C "${repoRoot}" ls-files --full-name -- "${absPath}"`, {
        encoding: "utf-8",
        timeout: 5000,
      }).trim() || absPath;

      let diff = "";

      if (base === "default-branch") {
        const diffBases = resolveBranchDiffBases(repoRoot);
        for (const b of diffBases) {
          try {
            diff = execCaptureStdout(`git diff ${b} -- "${relPath}"`, {
              cwd: repoRoot,
              encoding: "utf-8",
              timeout: 5000,
            });
            break;
          } catch {
            // If a base ref is unavailable, try the next candidate.
          }
        }
      } else {
        try {
          diff = execCaptureStdout(`git diff HEAD -- "${relPath}"`, {
            cwd: repoRoot,
            encoding: "utf-8",
            timeout: 5000,
          });
        } catch {
          // HEAD may not exist in a fresh repo with no commits; fall through to untracked handling.
        }
      }

      if (!diff.trim()) {
        const untracked = execSync(`git ls-files --others --exclude-standard -- "${relPath}"`, {
          cwd: repoRoot,
          encoding: "utf-8",
          timeout: 5000,
        }).trim();
        if (untracked) {
          diff = execCaptureStdout(`git diff --no-index -- /dev/null "${absPath}"`, {
            cwd: repoRoot,
            encoding: "utf-8",
            timeout: 5000,
          });
        }
      }

      return c.json({ path: absPath, diff });
    } catch {
      return c.json({ path: absPath, diff: "" });
    }
  });

  /** List all files changed vs git base (name-status), including untracked new files.
   *  base="default-branch" (default): comprehensive — committed changes on this branch vs origin
   *  plus uncommitted local changes.
   *  base="last-commit": only uncommitted changes vs HEAD plus untracked files. */
  api.get("/fs/changed-files", (c) => {
    const cwd = c.req.query("cwd");
    if (!cwd) return c.json({ error: "cwd required" }, 400);
    const base = c.req.query("base"); // "last-commit" | "default-branch" | undefined
    const resolvedCwd = resolve(cwd);
    try {
      const repoRoot = execSync("git rev-parse --show-toplevel", {
        cwd: resolvedCwd,
        encoding: "utf-8",
        timeout: 5000,
      }).trim();

      // Map from abs path → status ("A", "M", "D"). Later writes win, but "A" is preserved.
      const fileMap = new Map<string, string>();

      const applyNameStatus = (nameStatus: string) => {
        for (const line of nameStatus.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const parts = trimmed.split("\t");
          const statusChar = parts[0][0];
          if (statusChar === "R" && parts[2]) {
            if (!fileMap.has(join(repoRoot, parts[1]))) fileMap.set(join(repoRoot, parts[1]), "D");
            fileMap.set(join(repoRoot, parts[2]), "A");
          } else {
            const abs = join(repoRoot, parts[1] || "");
            if (!abs || abs === repoRoot) continue;
            // Preserve "A" — don't downgrade to "M"
            if (!(fileMap.get(abs) === "A" && statusChar === "M")) {
              fileMap.set(abs, statusChar);
            }
          }
        }
      };

      if (base !== "last-commit") {
        // default-branch (or unset): committed changes on this branch vs origin base
        const diffBases = resolveBranchDiffBases(repoRoot);
        for (const b of diffBases) {
          try {
            applyNameStatus(execCaptureStdout(`git diff ${shellEscapeArg(b)}...HEAD --name-status`, {
              cwd: repoRoot, encoding: "utf-8", timeout: 5000,
            }));
            break;
          } catch { /* try next */ }
        }
      }

      // Always include uncommitted changes (staged + unstaged vs HEAD)
      try {
        applyNameStatus(execCaptureStdout("git diff HEAD --name-status", {
          cwd: repoRoot, encoding: "utf-8", timeout: 5000,
        }));
      } catch { /* fresh repo */ }

      // Always include untracked files not yet staged
      try {
        const untracked = execSync("git ls-files --others --exclude-standard", {
          cwd: repoRoot, encoding: "utf-8", timeout: 5000,
        }).trim();
        for (const rel of untracked.split("\n")) {
          if (rel.trim()) {
            const abs = join(repoRoot, rel.trim());
            if (!fileMap.has(abs)) fileMap.set(abs, "A");
          }
        }
      } catch { /* ignore */ }

      const files = [...fileMap.entries()].map(([path, status]) => ({ path, status }));
      return c.json({ files });
    } catch {
      return c.json({ files: [] });
    }
  });

  /** Find CLAUDE.md files for a project (root + .claude/) */
  api.get("/fs/claude-md", async (c) => {
    const cwd = c.req.query("cwd");
    if (!cwd) return c.json({ error: "cwd required" }, 400);
    const resolvedCwd = resolve(cwd);

    // Find the git repo root so we can search upward from cwd.
    let repoRoot: string | null = null;
    try {
      repoRoot = execSync("git rev-parse --show-toplevel", {
        cwd: resolvedCwd,
        encoding: "utf-8",
        timeout: 3000,
      }).trim();
    } catch {
      // Not a git repo — only search the exact cwd
    }

    // Collect candidate directories: cwd, then each parent up to repo root.
    const searchDirs: string[] = [];
    let dir = resolvedCwd;
    const stop = repoRoot ? resolve(repoRoot) : resolvedCwd;
    while (true) {
      searchDirs.push(dir);
      if (dir === stop) break;
      const parent = dirname(dir);
      if (parent === dir) break; // filesystem root
      dir = parent;
    }

    // Check CLAUDE.md and .claude/CLAUDE.md in each directory.
    const seen = new Set<string>();
    const files: { path: string; content: string }[] = [];
    for (const d of searchDirs) {
      for (const rel of ["CLAUDE.md", join(".claude", "CLAUDE.md")]) {
        const p = join(d, rel);
        if (seen.has(p)) continue;
        seen.add(p);
        try {
          const content = await readFile(p, "utf-8");
          files.push({ path: p, content });
        } catch {
          // file doesn't exist — skip
        }
      }
    }

    return c.json({ cwd: resolvedCwd, files });
  });

  api.get("/fs/claude-config", async (c) => {
    const cwd = c.req.query("cwd");
    if (!cwd) return c.json({ error: "cwd required" }, 400);
    const resolvedCwd = resolve(cwd);

    // Find repo root
    let repoRoot: string | null = null;
    try {
      repoRoot = execSync("git rev-parse --show-toplevel", {
        cwd: resolvedCwd,
        encoding: "utf-8",
        timeout: 3000,
      }).trim();
    } catch {
      // Not a git repo
    }
    const projectRoot = repoRoot ? resolve(repoRoot) : resolvedCwd;

    // ── Project-level items ─────────────────────────────────────────────
    // CLAUDE.md files — reuse walk-up logic
    const searchDirs: string[] = [];
    let dir = resolvedCwd;
    const stop = projectRoot;
    while (true) {
      searchDirs.push(dir);
      if (dir === stop) break;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    const seen = new Set<string>();
    const projectClaudeMd: { path: string; content: string }[] = [];
    for (const d of searchDirs) {
      for (const rel of ["CLAUDE.md", join(".claude", "CLAUDE.md")]) {
        const p = join(d, rel);
        if (seen.has(p)) continue;
        seen.add(p);
        try {
          const content = await readFile(p, "utf-8");
          projectClaudeMd.push({ path: p, content });
        } catch {
          // file doesn't exist
        }
      }
    }

    // settings.json / settings.local.json
    const claudeDir = join(projectRoot, ".claude");
    let projectSettings: { path: string; content: string } | null = null;
    let projectSettingsLocal: { path: string; content: string } | null = null;
    try {
      const p = join(claudeDir, "settings.json");
      projectSettings = { path: p, content: await readFile(p, "utf-8") };
    } catch { /* missing */ }
    try {
      const p = join(claudeDir, "settings.local.json");
      projectSettingsLocal = { path: p, content: await readFile(p, "utf-8") };
    } catch { /* missing */ }

    // commands/*.md
    const projectCommands: { name: string; path: string }[] = [];
    try {
      const commandsDir = join(claudeDir, "commands");
      const entries = await readdir(commandsDir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isFile() && e.name.endsWith(".md")) {
          projectCommands.push({ name: e.name.replace(/\.md$/, ""), path: join(commandsDir, e.name) });
        }
      }
      projectCommands.sort((a, b) => a.name.localeCompare(b.name));
    } catch { /* missing dir */ }

    // ── User-level items ────────────────────────────────────────────────
    const userRoot = join(homedir(), ".claude");

    // User CLAUDE.md
    let userClaudeMd: { path: string; content: string } | null = null;
    try {
      const p = join(userRoot, "CLAUDE.md");
      userClaudeMd = { path: p, content: await readFile(p, "utf-8") };
    } catch { /* missing */ }

    // Skills
    const userSkills: { slug: string; name: string; description: string; path: string }[] = [];
    try {
      const skillsDir = join(userRoot, "skills");
      const entries = await readdir(skillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillMdPath = join(skillsDir, entry.name, "SKILL.md");
        try {
          const content = await readFile(skillMdPath, "utf-8");
          const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
          let name = entry.name;
          let description = "";
          if (fmMatch) {
            for (const line of fmMatch[1].split("\n")) {
              const nameMatch = line.match(/^name:\s*(.+)/);
              if (nameMatch) name = nameMatch[1].trim().replace(/^["']|["']$/g, "");
              const descMatch = line.match(/^description:\s*["']?(.+?)["']?\s*$/);
              if (descMatch) description = descMatch[1];
            }
          }
          userSkills.push({ slug: entry.name, name, description, path: skillMdPath });
        } catch { /* no SKILL.md */ }
      }
      userSkills.sort((a, b) => a.name.localeCompare(b.name));
    } catch { /* missing dir */ }

    // Agents
    const userAgents: { name: string; path: string }[] = [];
    try {
      const agentsDir = join(userRoot, "agents");
      const entries = await readdir(agentsDir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isFile() && e.name.endsWith(".md")) {
          userAgents.push({ name: e.name.replace(/\.md$/, ""), path: join(agentsDir, e.name) });
        }
      }
      userAgents.sort((a, b) => a.name.localeCompare(b.name));
    } catch { /* missing dir */ }

    // User settings.json
    let userSettings: { path: string; content: string } | null = null;
    try {
      const p = join(userRoot, "settings.json");
      userSettings = { path: p, content: await readFile(p, "utf-8") };
    } catch { /* missing */ }

    // User commands/*.md
    const userCommands: { name: string; path: string }[] = [];
    try {
      const commandsDir = join(userRoot, "commands");
      const entries = await readdir(commandsDir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isFile() && e.name.endsWith(".md")) {
          userCommands.push({ name: e.name.replace(/\.md$/, ""), path: join(commandsDir, e.name) });
        }
      }
      userCommands.sort((a, b) => a.name.localeCompare(b.name));
    } catch { /* missing dir */ }

    return c.json({
      project: {
        root: projectRoot,
        claudeMd: projectClaudeMd,
        settings: projectSettings,
        settingsLocal: projectSettingsLocal,
        commands: projectCommands,
      },
      user: {
        root: userRoot,
        claudeMd: userClaudeMd,
        skills: userSkills,
        agents: userAgents,
        settings: userSettings,
        commands: userCommands,
      },
    });
  });

  api.put("/fs/claude-md", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { path: filePath, content } = body;
    if (!filePath || typeof content !== "string") {
      return c.json({ error: "path and content required" }, 400);
    }
    const base = filePath.split("/").pop();
    if (base !== "CLAUDE.md") {
      return c.json({ error: "Can only write CLAUDE.md files" }, 400);
    }
    const absPath = resolve(filePath);
    if (!absPath.endsWith("/CLAUDE.md") && !absPath.endsWith("/.claude/CLAUDE.md")) {
      return c.json({ error: "Invalid CLAUDE.md path" }, 400);
    }
    try {
      await mkdir(dirname(absPath), { recursive: true });
      await writeFile(absPath, content, "utf-8");
      return c.json({ ok: true, path: absPath });
    } catch (e: unknown) {
      return c.json(
        { error: e instanceof Error ? e.message : "Cannot write file" },
        500,
      );
    }
  });
}
