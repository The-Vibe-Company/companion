# Workspace File Tree Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a workspace file tree section to the right sidebar (TaskPanel) with Markdown preview and file/folder download support.

**Architecture:** New `WorkspaceSection` component registered as a TaskPanel section, using `react-arborist` for the tree UI. Backend gets three new endpoints: `/fs/list-entries` (directory listing with files), `/fs/download` (single file), and `/fs/download-zip` (directory as zip). Component-local state only — no Zustand store changes.

**Tech Stack:** React 19, react-arborist, react-markdown + remark-gfm, Hono, Bun, TypeScript

**Design doc:** `docs/plans/2026-02-23-workspace-file-tree-design.md`

**Security note:** Backend code follows existing `fs-routes.ts` patterns — uses `execSync` + `shellEscapeArg()` for shell argument escaping, and `resolve()` for path traversal prevention.

---

### Task 1: Backend — `/fs/list-entries` endpoint

**Files:**
- Modify: `web/server/routes/fs-routes.ts` (add after line 76, after the existing `/fs/list` handler)

**Step 1: Add the list-entries endpoint**

Add this endpoint inside `registerFsRoutes()`, after the existing `/fs/list` handler. Note: uses existing `shellEscapeArg()` helper (line 7-9) and existing imports (`readdir`, `stat`, `join`, `resolve`, `execSync`).

```typescript
api.get("/fs/list-entries", async (c) => {
  const rawPath = c.req.query("path");
  if (!rawPath) return c.json({ error: "path required" }, 400);
  const basePath = resolve(rawPath);
  const showHidden = c.req.query("showHidden") === "true";
  const showIgnored = c.req.query("showIgnored") === "true";

  try {
    const dirEntries = await readdir(basePath, { withFileTypes: true });

    // Build set of git-ignored files if in a git repo and showIgnored is false
    const ignoredFiles = new Set<string>();
    if (!showIgnored) {
      try {
        const repoRoot = execSync("git rev-parse --show-toplevel", {
          cwd: basePath,
          encoding: "utf-8",
          timeout: 3000,
        }).trim();

        // Get list of ignored files in this directory using shellEscapeArg for safety
        const gitIgnored = execSync(
          `git -C ${shellEscapeArg(repoRoot)} ls-files --others --ignored --exclude-standard --directory ${shellEscapeArg(basePath + "/")}`,
          { encoding: "utf-8", timeout: 5000 },
        ).trim();
        for (const line of gitIgnored.split("\n")) {
          if (line.trim()) {
            const name = line.trim().replace(/\/$/, "").split("/").pop();
            if (name) ignoredFiles.add(name);
          }
        }
      } catch {
        // Not a git repo or git not available — skip ignore filtering
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
      // Always skip .git
      if (entry.name === ".git") continue;
      // Skip hidden files unless showHidden
      if (!showHidden && entry.name.startsWith(".")) continue;
      // Skip git-ignored entries
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

    // Sort: directories first, then files, each alphabetically
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return c.json({ path: basePath, entries });
  } catch {
    return c.json({ error: "Cannot read directory", path: basePath, entries: [] }, 400);
  }
});
```

**Step 2: Verify**

Run: `cd web && bun run typecheck`
Expected: No errors

---

### Task 2: Backend — `/fs/download` endpoint

**Files:**
- Modify: `web/server/routes/fs-routes.ts` (add after list-entries)

**Step 1: Add the download endpoint**

```typescript
api.get("/fs/download", async (c) => {
  const filePath = c.req.query("path");
  if (!filePath) return c.json({ error: "path required" }, 400);
  const absPath = resolve(filePath);

  try {
    const info = await stat(absPath);
    if (!info.isFile()) {
      return c.json({ error: "Not a file" }, 400);
    }

    const file = Bun.file(absPath);
    const fileName = absPath.split("/").pop() || "download";

    return new Response(file.stream(), {
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "Content-Disposition": `attachment; filename="${fileName}"`,
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
```

**Step 2: Verify**

Run: `cd web && bun run typecheck`
Expected: No errors

---

### Task 3: Backend — `/fs/download-zip` endpoint

**Files:**
- Modify: `web/server/routes/fs-routes.ts` (add after download endpoint)

**Step 1: Add the download-zip endpoint**

Uses `Bun.spawnSync` (not `exec`) for subprocess calls, and `shellEscapeArg` for path arguments:

```typescript
api.get("/fs/download-zip", async (c) => {
  const dirPath = c.req.query("path");
  if (!dirPath) return c.json({ error: "path required" }, 400);
  const absPath = resolve(dirPath);

  try {
    const info = await stat(absPath);
    if (!info.isDirectory()) {
      return c.json({ error: "Not a directory" }, 400);
    }

    const dirName = absPath.split("/").pop() || "archive";

    // Use git archive if in a git repo (respects .gitignore), else fall back to zip
    let zipBuffer: Buffer;
    try {
      const repoRoot = execSync("git rev-parse --show-toplevel", {
        cwd: absPath,
        encoding: "utf-8",
        timeout: 3000,
      }).trim();

      // Get relative path from repo root
      const relPath = absPath.startsWith(repoRoot)
        ? absPath.slice(repoRoot.length + 1) || "."
        : ".";

      // Use git archive for .gitignore-aware zip — uses array args (no shell injection)
      const result = Bun.spawnSync(
        ["git", "archive", "--format=zip", `--prefix=${dirName}/`, "HEAD", relPath],
        { cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
      );

      if (result.exitCode === 0 && result.stdout.length > 0) {
        zipBuffer = Buffer.from(result.stdout);
      } else {
        throw new Error("git archive failed");
      }
    } catch {
      // Fallback: use system zip command — uses array args (no shell injection)
      const result = Bun.spawnSync(
        ["zip", "-r", "-", ".", "-x", ".git/*", "-x", "node_modules/*"],
        { cwd: absPath, stdout: "pipe", stderr: "pipe" },
      );

      if (result.exitCode !== 0) {
        return c.json({ error: "Failed to create zip archive" }, 500);
      }
      zipBuffer = Buffer.from(result.stdout);
    }

    // Size limit check (100MB)
    if (zipBuffer.length > 100 * 1024 * 1024) {
      return c.json({ error: "Archive too large (>100MB)" }, 413);
    }

    return new Response(zipBuffer, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${dirName}.zip"`,
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
```

**Step 2: Verify**

Run: `cd web && bun run typecheck`
Expected: No errors

---

### Task 4: Client API — Add new endpoint wrappers

**Files:**
- Modify: `web/src/api.ts`

**Step 1: Add FileEntry type**

Add after the existing `TreeNode` interface (~line 318):

```typescript
export interface FileEntry {
  name: string;
  type: "file" | "directory";
  size?: number;
  mtime?: string;
}
```

**Step 2: Add API methods**

Add inside the `api` object, after `listDirs` (~line 629):

```typescript
listEntries: (path: string, opts?: { showHidden?: boolean; showIgnored?: boolean }) => {
  const params = new URLSearchParams({ path });
  if (opts?.showHidden) params.set("showHidden", "true");
  if (opts?.showIgnored) params.set("showIgnored", "true");
  return get<{ path: string; entries: FileEntry[] }>(`/fs/list-entries?${params}`);
},

downloadFile: (path: string) => {
  // Direct browser download — open in new tab
  window.open(`${BASE}/fs/download?path=${encodeURIComponent(path)}`, "_blank");
},

downloadZip: (path: string) => {
  window.open(`${BASE}/fs/download-zip?path=${encodeURIComponent(path)}`, "_blank");
},
```

**Step 3: Verify**

Run: `cd web && bun run typecheck`
Expected: No errors

---

### Task 5: Register workspace section

**Files:**
- Modify: `web/src/components/task-panel-sections.ts` (~line 63, before the closing `]`)
- Modify: `web/src/components/TaskPanel.tsx` (~line 5 for import, ~line 878 for component map)

**Step 1: Add section definition**

In `task-panel-sections.ts`, add before the closing `]` of `SECTION_DEFINITIONS` array:

```typescript
{
  id: "workspace",
  label: "Workspace",
  description: "Browse project files and preview Markdown",
  backends: null,
},
```

**Step 2: Import and register component in TaskPanel**

In `TaskPanel.tsx`, add import at the top (after line 12):

```typescript
import { WorkspaceSection } from "./WorkspaceSection.js";
```

In the `SECTION_COMPONENTS` map (~line 873), add entry:

```typescript
"workspace": WorkspaceSection,
```

**Step 3: Verify**

Run: `cd web && bun run typecheck`
Expected: Error because `WorkspaceSection` doesn't exist yet — this is expected and will be resolved in Task 6.

---

### Task 6: WorkspaceSection component — File tree view

**Files:**
- Create: `web/src/components/WorkspaceSection.tsx`

**Step 1: Create the WorkspaceSection component**

Create `web/src/components/WorkspaceSection.tsx` with the full component. See the design doc (`docs/plans/2026-02-23-workspace-file-tree-design.md`) for architecture details.

Key implementation notes:
- Renders as a TaskPanel section (receives `{ sessionId: string }` prop)
- Gets `sessionCwd` from Zustand store via `useStore`
- Two-state view: file tree (default) and Markdown preview
- Uses `react-arborist` `<Tree>` for the file tree with custom `NodeRenderer`
- Lazy loads children via `api.listEntries()` on directory expand (`onToggle`)
- Clicks on `.md` files load content via `api.readFile()` and show in `MarkdownPreview`
- Download buttons on hover (file: `api.downloadFile()`, directory: `api.downloadZip()`)
- Markdown preview reuses `react-markdown` + `remark-gfm` with components styled like `MessageBubble.tsx:147-244`
- Section header with refresh button and show-hidden toggle
- All state is component-local (no Zustand additions)

Important: Check `react-arborist` API before implementation — the `onToggle` callback signature and `onActivate` may need adjustment based on the actual library version (3.4.3). Read `node_modules/react-arborist/dist/types` if needed.

```tsx
// Full implementation in the component file — see design doc for structure
// Key exports: WorkspaceSection (named export)
```

**Step 2: Verify**

Run: `cd web && bun run typecheck`
Expected: PASS

---

### Task 7: Tests — WorkspaceSection

**Files:**
- Create: `web/src/components/WorkspaceSection.test.tsx`

**Step 1: Create test file**

Required test coverage:
1. **Render test** — section header renders with "Workspace" label
2. **Accessibility** — axe scan passes (`toHaveNoViolations()`)
3. **File tree loads** — `api.listEntries` called with session cwd
4. **Markdown preview** — clicking `.md` file shows rendered content
5. **Back navigation** — clicking back returns to file tree
6. **No cwd** — shows "No workspace directory" when session has no cwd
7. **Refresh** — clicking refresh reloads tree data
8. **Hidden files toggle** — toggles `showHidden` parameter

Mock strategy (follows existing test patterns):
- `vi.mock("react-markdown")` — simple div renderer (same as `MessageBubble.test.tsx:5-8`)
- `vi.mock("remark-gfm")` — noop
- `vi.mock("react-arborist")` — minimal Tree that renders node names with click handlers
- `vi.mock("../store.js")` — return session with cwd
- `vi.mock("../api.js")` — mock `listEntries`, `readFile`, `downloadFile`, `downloadZip`

**Step 2: Run tests**

Run: `cd web && bun run test -- WorkspaceSection`
Expected: All tests pass

---

### Task 8: Update Playground with WorkspaceSection mock

**Files:**
- Modify: `web/src/components/Playground.tsx`

**Step 1: Add a workspace section example**

Find the Playground component and add a static representation of the WorkspaceSection alongside existing component mocks. Show both states: file tree view and Markdown preview view.

**Step 2: Verify**

Run: `cd web && bun run typecheck`
Expected: PASS

---

### Task 9: Final verification

**Step 1: Run full test suite**

Run: `cd web && bun run test`
Expected: All tests pass

**Step 2: Type check**

Run: `cd web && bun run typecheck`
Expected: No errors

**Step 3: Manual integration test (dev server)**

Run: `cd web && bun run dev`

Test checklist:
- [ ] Open the app, select a session
- [ ] Open right sidebar (Context panel)
- [ ] "Workspace" section visible in the panel
- [ ] File tree loads with project files
- [ ] Expand a directory — children load lazily
- [ ] Click a `.md` file — preview opens with rendered Markdown
- [ ] Click "← Back" — returns to file tree
- [ ] Hover a file — download button appears
- [ ] Click download button — file downloads
- [ ] Toggle hidden files — hidden files appear/disappear
- [ ] Click refresh — tree reloads
- [ ] Customize panel → workspace section can be enabled/disabled and reordered
