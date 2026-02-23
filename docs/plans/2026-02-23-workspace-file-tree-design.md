# Workspace File Tree — Design Document

**Issue**: [#391](https://github.com/The-Vibe-Company/companion/issues/391)
**Date**: 2026-02-23
**Status**: Approved

## Summary

Add a workspace file tree to the right sidebar (TaskPanel) as a new configurable section, allowing users to browse project files and preview Markdown content directly within the Companion UI. Also supports file download and folder zip download.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Panel placement | New TaskPanel section | Reuses existing section config system (reorder, enable/disable). Minimal architecture change. |
| Preview location | Inline within section | Stays in the 320px sidebar. File tree collapses, preview expands. Back button to return. |
| Loading strategy | Lazy load on expand | Only root-level entries loaded initially. Children fetched on directory expand via `/fs/list-entries`. |
| Tree component | react-arborist | Already installed. Virtualized scrolling, keyboard navigation, accessibility built-in. |
| State management | Component-local useState | Temporary, session-scoped state. No global Zustand store additions needed. |

## Architecture

### Data Flow

```
User expands dir → GET /fs/list-entries?path=... → Update local tree state → react-arborist renders
User clicks .md  → GET /fs/read?path=...        → Switch to Markdown preview view
User clicks back → Return to file tree view
User clicks ⬇    → GET /fs/download?path=...    → Browser triggers file download
User clicks ⬇ (dir) → GET /fs/download-zip?path=... → Browser triggers zip download
```

### New Files

| File | Purpose |
|------|---------|
| `web/src/components/WorkspaceSection.tsx` | Main section component (tree + preview + download) |
| `web/src/components/WorkspaceSection.test.tsx` | Tests (render, a11y, interactions) |

### Modified Files

| File | Change |
|------|--------|
| `web/server/routes/fs-routes.ts` | Add `/fs/list-entries`, `/fs/download`, `/fs/download-zip` endpoints |
| `web/src/components/task-panel-sections.ts` | Register `workspace` section |
| `web/src/components/TaskPanel.tsx` | Import WorkspaceSection into section component map |
| `web/src/components/Playground.tsx` | Add workspace section mocks |
| `web/src/api.ts` | Add client methods for new endpoints |

## Backend API

### GET /fs/list-entries

Lists files and directories in a given path.

```typescript
// Request
GET /fs/list-entries?path=/project/src&showHidden=false&showIgnored=false

// Response
{
  entries: [
    { name: "components", type: "directory" },
    { name: "index.ts", type: "file", size: 1234, mtime: "2026-02-20T10:30:00Z" },
  ]
}
```

- Directories listed first, then files, each sorted alphabetically
- `.gitignore` respected by default (override with `showIgnored=true`)
- Hidden files (dot-prefixed) hidden by default (override with `showHidden=true`)
- Common directories always excluded: `.git`

### GET /fs/download

Downloads a single file.

```typescript
GET /fs/download?path=/project/README.md
// Response: file stream with Content-Disposition: attachment
```

### GET /fs/download-zip

Downloads a directory as a zip archive.

```typescript
GET /fs/download-zip?path=/project/src
// Response: zip stream with Content-Disposition: attachment; filename="src.zip"
```

- Respects `.gitignore`
- Size limit: 100MB (returns 413 if exceeded)
- Excludes `.git` directory

## Frontend Component

### WorkspaceSection

Two-state view switching within a single section:

```
┌─────────── WorkspaceSection ──────────┐
│  📁 Workspace           [⟳] [👁]     │  ← Header: refresh + show hidden toggle
│─────────────────────────────────────── │
│  STATE A: File Tree                    │
│  ├── 📁 src/              [⬇]        │  ← Download buttons on hover
│  │   ├── 📄 index.ts      [⬇]        │
│  │   └── 📄 utils.ts      [⬇]        │
│  ├── 📄 README.md ←click  [⬇]        │
│  └── 📁 docs/             [⬇]        │
│─────────────────────── OR ─────────── │
│  STATE B: Markdown Preview             │
│  [←] src/README.md                     │  ← Breadcrumb + back button
│  ─────────────────────────             │
│  # My Project                          │
│  A description of the project...       │
│                                        │
└───────────────────────────────────────┘
```

### Component State

```typescript
const [treeData, setTreeData] = useState<TreeNode[]>([]);
const [previewFile, setPreviewFile] = useState<string | null>(null);
const [previewContent, setPreviewContent] = useState<string>("");
const [showHidden, setShowHidden] = useState(false);
const [loading, setLoading] = useState(false);
```

### Tree Node Type

```typescript
interface FileTreeNode {
  id: string;       // Full path as unique ID
  name: string;     // Display name
  type: "file" | "directory";
  size?: number;     // File size in bytes
  mtime?: string;    // Last modified time
  children?: FileTreeNode[] | null; // null = not yet loaded
}
```

### Markdown Preview

- Reuses existing `react-markdown` + `remark-gfm` (already used in MessageBubble)
- Syntax highlighting for fenced code blocks (reuse existing approach)
- Read-only, scrollable within the section
- File path shown as breadcrumb header

### Download UI

- Download icon button appears on hover for each tree node
- Shows loading spinner during download
- Toast notification on failure
- For directories: generates and downloads .zip

## .gitignore Handling

Backend approach:
1. If in a git repo: use `git ls-files` / `git check-ignore` for accurate filtering
2. If not in git: fallback to reading `.gitignore` and manual glob matching
3. Always exclude: `.git` directory

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Directory doesn't exist | Show friendly message in section |
| File read fails | Show error message in preview area |
| Network error | Keep loaded tree, show toast |
| File > 2MB | Show "File too large to preview" |
| Zip > 100MB | Return 413, show toast |

## Testing

- **Render test**: Component renders file tree with section header
- **Accessibility**: axe scan passes (`toHaveNoViolations()`)
- **Interaction**: Expand directory, click file for preview, back navigation
- **Download**: Download button triggers correct API call
- **Edge cases**: Empty directory, loading states, error states

## Out of Scope (Future)

- Preview for non-Markdown files (code, images, JSON)
- File editing
- Search/filter within file tree
- Drag-and-drop files into chat
