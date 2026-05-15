#!/usr/bin/env bun
/**
 * memory-preview — local-only HTML viewer for AgentHangar memory files.
 *
 * Aggregates three memory sources into one browsable index:
 *   1. In-repo `.memory/*.md` (the canonical project memory, git-excluded)
 *   2. Repo-root `CLAUDE.md` (the local-only pointer file)
 *   3. User-level Claude auto-memory for this project
 *      (~/.claude/projects/-<encoded>/memory/*.md)
 *
 * Markdown is rendered client-side via the `marked` CDN script so the server
 * stays a tiny single-file Bun script with no new dependencies. The server
 * binds to 127.0.0.1 only because memory files contain personal context that
 * must not leak onto the LAN.
 *
 * Usage:
 *   bun scripts/memory-preview.ts            # default port 6062
 *   MEMORY_PREVIEW_PORT=7777 bun scripts/...  # override
 *
 * Open http://127.0.0.1:6062/ in your browser.
 */

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const PORT = Number(process.env.MEMORY_PREVIEW_PORT) || 6062;
const REPO_ROOT = resolve(import.meta.dir, "..");
const REPO_MEMORY_DIR = join(REPO_ROOT, ".memory");
const REPO_CLAUDE_MD = join(REPO_ROOT, "CLAUDE.md");
const USER_MEMORY_DIR = join(
  homedir(),
  ".claude",
  "projects",
  "-home-ubuntu-my-workspace-yajingithub-companion",
  "memory",
);

// ─── Path safety ─────────────────────────────────────────────────────────────
// Every file we serve must be under one of these roots. Prevents
// `?file=/etc/passwd` style abuse even though we bind to localhost.
const ALLOWED_ROOTS = [REPO_MEMORY_DIR, REPO_CLAUDE_MD, USER_MEMORY_DIR];

function isAllowed(absPath: string): boolean {
  for (const root of ALLOWED_ROOTS) {
    if (absPath === root) return true;
    if (absPath.startsWith(root + "/")) return true;
  }
  return false;
}

// ─── File discovery ──────────────────────────────────────────────────────────

interface MemoryFile {
  /** Display label. */
  label: string;
  /** Absolute filesystem path (server use, never echoed back to the URL raw). */
  absPath: string;
  /** Group heading on the index page. */
  group: string;
  /** Size in bytes for the index display. */
  size: number;
  /** Last modified timestamp (ms). */
  mtime: number;
}

function discoverMarkdown(dir: string, group: string): MemoryFile[] {
  if (!existsSync(dir)) return [];
  const out: MemoryFile[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".md")) continue;
    const abs = join(dir, name);
    try {
      const st = statSync(abs);
      out.push({
        label: name,
        absPath: abs,
        group,
        size: st.size,
        mtime: st.mtimeMs,
      });
    } catch {
      // skip unreadable entries
    }
  }
  return out;
}

function discoverSingleFile(path: string, group: string, label: string): MemoryFile[] {
  if (!existsSync(path)) return [];
  try {
    const st = statSync(path);
    return [{ label, absPath: path, group, size: st.size, mtime: st.mtimeMs }];
  } catch {
    return [];
  }
}

function allFiles(): MemoryFile[] {
  return [
    ...discoverMarkdown(REPO_MEMORY_DIR, "Repo .memory/ (project canonical, git-excluded)"),
    ...discoverSingleFile(REPO_CLAUDE_MD, "Repo root pointer", "CLAUDE.md"),
    ...discoverMarkdown(USER_MEMORY_DIR, "Claude user-level memory (cross-session)"),
  ];
}

// ─── HTML rendering ──────────────────────────────────────────────────────────

const STYLE = `
  :root {
    color-scheme: light dark;
    --bg: #ffffff;
    --fg: #1f2328;
    --muted: #656d76;
    --border: #d0d7de;
    --code-bg: #f6f8fa;
    --accent: #0969da;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0d1117;
      --fg: #e6edf3;
      --muted: #8d96a0;
      --border: #30363d;
      --code-bg: #161b22;
      --accent: #58a6ff;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    background: var(--bg);
    color: var(--fg);
    line-height: 1.55;
  }
  header {
    border-bottom: 1px solid var(--border);
    padding: 16px 32px;
    position: sticky;
    top: 0;
    background: var(--bg);
    z-index: 10;
  }
  header h1 { margin: 0; font-size: 18px; font-weight: 600; }
  header a { color: var(--accent); text-decoration: none; margin-right: 16px; font-size: 14px; }
  header a:hover { text-decoration: underline; }
  main { max-width: 900px; margin: 0 auto; padding: 32px; }
  h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin: 32px 0 8px; }
  ul.file-list { list-style: none; padding: 0; margin: 0; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  ul.file-list li { padding: 0; border-bottom: 1px solid var(--border); }
  ul.file-list li:last-child { border-bottom: none; }
  ul.file-list a { display: block; padding: 12px 16px; color: var(--fg); text-decoration: none; }
  ul.file-list a:hover { background: var(--code-bg); }
  ul.file-list .label { font-weight: 500; }
  ul.file-list .meta { font-size: 12px; color: var(--muted); margin-top: 2px; }
  article {
    max-width: 800px;
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 32px;
    background: var(--bg);
  }
  article h1 { margin-top: 0; font-size: 28px; border-bottom: 1px solid var(--border); padding-bottom: 8px; }
  article h2 { font-size: 22px; text-transform: none; letter-spacing: 0; color: var(--fg); border-bottom: 1px solid var(--border); padding-bottom: 6px; margin-top: 32px; }
  article h3 { font-size: 18px; margin-top: 24px; }
  article code { background: var(--code-bg); padding: 2px 6px; border-radius: 4px; font-size: 90%; font-family: "SF Mono", "Menlo", "Monaco", "Cascadia Mono", monospace; }
  article pre { background: var(--code-bg); padding: 14px; border-radius: 6px; overflow-x: auto; }
  article pre code { background: transparent; padding: 0; }
  article table { border-collapse: collapse; width: 100%; margin: 16px 0; }
  article th, article td { border: 1px solid var(--border); padding: 8px 12px; text-align: left; }
  article th { background: var(--code-bg); font-weight: 600; }
  article a { color: var(--accent); }
  article blockquote { border-left: 4px solid var(--border); margin: 0; padding: 4px 16px; color: var(--muted); }
  .source-path { font-family: "SF Mono", "Menlo", "Monaco", monospace; font-size: 12px; color: var(--muted); margin-bottom: 16px; word-break: break-all; }
`;

function htmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]!),
  );
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function formatTime(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

function renderIndex(): string {
  const files = allFiles();
  const groups = new Map<string, MemoryFile[]>();
  for (const f of files) {
    const arr = groups.get(f.group) ?? [];
    arr.push(f);
    groups.set(f.group, arr);
  }

  let body = "";
  if (files.length === 0) {
    body = "<p>No memory files found in any of the known locations.</p>";
  } else {
    for (const [group, entries] of groups) {
      body += `<h2>${htmlEscape(group)}</h2>\n<ul class="file-list">`;
      for (const e of entries) {
        const q = encodeURIComponent(e.absPath);
        body += `
          <li><a href="/view?file=${q}">
            <div class="label">${htmlEscape(e.label)}</div>
            <div class="meta">${formatSize(e.size)} · ${formatTime(e.mtime)} · <code>${htmlEscape(e.absPath)}</code></div>
          </a></li>`;
      }
      body += "</ul>";
    }
  }

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AgentHangar Memory Preview</title>
<style>${STYLE}</style>
</head><body>
<header><h1>AgentHangar Memory Preview</h1></header>
<main>${body}</main>
</body></html>`;
}

function renderFile(absPath: string, raw: string): string {
  // Embed the raw markdown into a hidden <script type="text/markdown"> so the
  // browser-side marked.js can render it without any server-side parsing
  // dependency. textContent is XSS-safe; we still escape `</script>` defensively.
  const safeRaw = raw.replace(/<\/script/gi, "<\\/script");
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${htmlEscape(absPath.split("/").pop() || "memory")} — AgentHangar Memory Preview</title>
<style>${STYLE}</style>
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js" defer></script>
</head><body>
<header><h1>AgentHangar Memory Preview</h1><a href="/">← back to index</a></header>
<main>
  <div class="source-path">${htmlEscape(absPath)}</div>
  <article id="content">Loading…</article>
  <script type="text/markdown" id="raw">${safeRaw}</script>
  <script>
    document.addEventListener("DOMContentLoaded", () => {
      const raw = document.getElementById("raw").textContent;
      if (window.marked) {
        marked.setOptions({ gfm: true, breaks: false });
        document.getElementById("content").innerHTML = marked.parse(raw);
      } else {
        // marked failed to load (offline?) — show raw markdown in a <pre>
        const pre = document.createElement("pre");
        pre.textContent = raw;
        document.getElementById("content").replaceWith(pre);
      }
    });
  </script>
</main>
</body></html>`;
}

// ─── Server ──────────────────────────────────────────────────────────────────

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  fetch(req): Response {
    const url = new URL(req.url);

    if (url.pathname === "/") {
      return new Response(renderIndex(), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (url.pathname === "/view") {
      const file = url.searchParams.get("file");
      if (!file) return new Response("Missing ?file=", { status: 400 });
      const abs = resolve(file);
      if (!isAllowed(abs)) {
        return new Response("Refused: path outside allowed memory directories", { status: 403 });
      }
      if (!existsSync(abs)) {
        return new Response("File not found", { status: 404 });
      }
      let raw: string;
      try {
        raw = readFileSync(abs, "utf-8");
      } catch (err) {
        return new Response(`Read failed: ${(err as Error).message}`, { status: 500 });
      }
      return new Response(renderFile(abs, raw), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`memory-preview listening on http://${server.hostname}:${server.port}`);
console.log("Sources:");
console.log(`  - ${REPO_MEMORY_DIR}`);
console.log(`  - ${REPO_CLAUDE_MD}`);
console.log(`  - ${USER_MEMORY_DIR}`);
console.log("Press Ctrl-C to stop.");
