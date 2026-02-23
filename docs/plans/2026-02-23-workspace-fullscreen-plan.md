# Workspace Fullscreen Document Browser Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a fullscreen workspace overlay with file tree (left), Markdown viewer (center), auto-generated TOC (right), toolbar (top), and status bar (bottom).

**Architecture:** New `WorkspaceFullscreen` component as a fixed overlay triggered from `WorkspaceSection`. Six sub-components with clear SRP boundaries. Click .md files directly opens fullscreen. Non-md files show plain text. TOC auto-generated from Markdown headings with scroll sync via IntersectionObserver.

**Tech Stack:** React 19, Tailwind CSS v4, react-markdown + remark-gfm (existing), react-arborist (existing). No new dependencies.

---

### Task 1: Create `WorkspaceFullscreen` overlay container

**Files:**
- Create: `web/src/components/WorkspaceFullscreen.tsx`

**Step 1: Create the fullscreen overlay shell**

This is the main container: a fixed overlay with 5-zone layout (toolbar, file tree, viewer, TOC, status bar). It accepts the sessionId and initial file path, manages which file is selected, and coordinates all sub-components.

Key implementation details:
- Fixed overlay with z-50, covers entire viewport
- ESC key handler to close
- File content loading via `api.readFile`
- Coordinates TOC state between MarkdownViewer and TableOfContents
- Shows plain text for non-.md files, hides TOC sidebar
- Both sidebars are collapsible

**Step 2: Verify TypeScript compiles (will fail until sub-components exist)**

Run: `cd web && bun run typecheck`
Expected: Errors for missing sub-component imports (this is expected — they are created in Tasks 2-6)

---

### Task 2: Create `ViewerToolbar` component

**Files:**
- Create: `web/src/components/workspace/ViewerToolbar.tsx`

**Step 1: Create the toolbar**

Top bar (h-11) with:
- File name display (truncated, with full path tooltip)
- Download button: calls `api.downloadFile(path)`
- Share link button: copies `{origin}{pathname}#/preview?path={encodedPath}` to clipboard, shows "Copied!" feedback for 2 seconds
- Close button (X icon, title "Close fullscreen (Esc)")

Style: `border-b border-cc-border bg-cc-card`, consistent with existing section headers.

---

### Task 3: Create `FileTreePanel` component

**Files:**
- Create: `web/src/components/workspace/FileTreePanel.tsx`

**Step 1: Create the file tree panel**

Left sidebar (w-[240px]) wrapping react-arborist Tree. Logic extracted from `WorkspaceSection.tsx` but adapted:
- Full-height (uses ResizeObserver to measure container for tree height)
- Highlights selected file with `bg-cc-primary/15 text-cc-primary`
- Clicks ANY file type (not just .md) — calls `onFileSelect(path)`
- Show hidden toggle, refresh button, collapse button
- Collapsed state: shows a narrow strip (w-10) with expand icon
- Same FileNode renderer pattern as existing `WorkspaceSection.tsx:52-134`

---

### Task 4: Create `MarkdownViewer` component

**Files:**
- Create: `web/src/components/workspace/MarkdownViewer.tsx`

**Step 1: Create the Markdown viewer with heading ID injection and TOC extraction**

Reuses the same react-markdown + remark-gfm config from `WorkspaceSection.tsx:202-302` but enhanced:
- Larger font (14px vs 12px) since this is fullscreen
- Centered content with `max-w-4xl mx-auto px-8 py-6`
- Heading components (h1-h6) inject `id` attribute (slugified text) for anchor jumping
- Heading components collect `TocItem[]` during render via a ref
- After render, emits collected TOC items via `onTocExtracted` callback
- IntersectionObserver watches heading elements, calls `onActiveHeadingChange` with the topmost visible heading id
- Supports images with `max-w-full h-auto rounded` styling
- `slugify()` helper: lowercase, strip non-word chars, replace spaces with dashes
- `extractText()` helper: recursively extracts plain text from React children for slugification

---

### Task 5: Create `TableOfContents` component

**Files:**
- Create: `web/src/components/workspace/TableOfContents.tsx`

**Step 1: Create the TOC sidebar**

Right sidebar (w-[200px]) showing auto-generated nested heading outline:
- Exports `TocItem` interface: `{ id: string; text: string; level: number }`
- Header: "Outline" label with collapse button
- Items rendered as buttons with indentation based on heading level (normalized to min level)
- Active item highlighted with `text-cc-primary bg-cc-primary/10 font-medium`
- Click handler calls `onItemClick(id)` for scroll-to-heading
- Collapsed state: narrow strip (w-10) with list icon
- Empty state: "No headings found"

---

### Task 6: Create `ViewerStatusBar` component

**Files:**
- Create: `web/src/components/workspace/ViewerStatusBar.tsx`

**Step 1: Create the status bar**

Bottom bar (h-7) showing document statistics:
- Word count: split by whitespace + count CJK characters individually
- Line count: `content.split("\n").length`
- File size: computed from `TextEncoder.encode(content).length`, formatted as B/KB/MB
- Empty state: just the bar background with no text
- Style: `border-t border-cc-border bg-cc-card text-[11px] text-cc-muted`

---

### Task 7: Wire fullscreen trigger into `WorkspaceSection`

**Files:**
- Modify: `web/src/components/WorkspaceSection.tsx`

**Step 1: Add fullscreen state and trigger**

Changes:
1. Import `createPortal` from `react-dom` and `WorkspaceFullscreen`
2. Add `fullscreenOpen` state
3. Modify `handleActivate`: clicking .md files sets `previewFile` AND opens fullscreen
4. Add expand button (fullscreen icon) in the header bar next to refresh button
5. Remove inline `MarkdownPreview` render block (lines 415-424) — fullscreen handles it now
6. Render `WorkspaceFullscreen` via `createPortal(el, document.body)` when `fullscreenOpen` is true

The existing `MarkdownPreview` component and `previewFile` state remain — `previewFile` is passed as `initialFile` to `WorkspaceFullscreen`.

---

### Task 8: Handle `#/preview?path=...` route for shared links

**Files:**
- Modify: `web/src/utils/routing.ts` — add `preview` page type with `path` param
- Modify: `web/src/App.tsx` — render standalone preview for the route

**Step 1: Add preview route parsing**

In `routing.ts`, add parsing for `#/preview?path=...`:
- New route page type: `"preview"`
- Extract `path` query param from hash

**Step 2: Add preview route to App.tsx**

In `App.tsx`, add a route case for `isPreviewPage`:
- Renders `WorkspaceFullscreen` without a session (file tree still works for browsing)
- `initialFile` set from the URL path param
- `onClose` navigates back to home

---

### Task 9: Write tests for `WorkspaceFullscreen`

**Files:**
- Create: `web/src/components/WorkspaceFullscreen.test.tsx`

**Step 1: Write tests**

Tests should cover:
1. Renders the fullscreen overlay with toolbar, file tree, and status bar
2. Clicking a .md file loads content and shows markdown preview
3. Clicking a non-.md file shows plain text
4. TOC is generated from markdown headings and displayed
5. TOC items are clickable
6. ESC key closes the overlay
7. Close button closes the overlay
8. Download button calls api.downloadFile
9. Share button copies URL to clipboard
10. Left sidebar collapse/expand toggle
11. Right sidebar collapse/expand toggle
12. Accessibility: axe scan passes

**Step 2: Run tests**

Run: `cd web && bun run test -- WorkspaceFullscreen`
Expected: All tests pass

---

### Task 10: Update existing `WorkspaceSection` tests

**Files:**
- Modify: `web/src/components/WorkspaceSection.test.tsx`

**Step 1: Update tests for fullscreen behavior**

- Update "opens markdown preview when clicking a .md file" test: now it should verify fullscreen opens
- Add test: fullscreen expand button is visible and functional
- Verify existing tests still pass

**Step 2: Run all tests**

Run: `cd web && bun run test`
Expected: No new failures

---

### Task 11: Final verification

**Step 1: Run typecheck**

Run: `cd web && bun run typecheck`
Expected: No errors

**Step 2: Run all tests**

Run: `cd web && bun run test`
Expected: All pass (except pre-existing `claude-protocol-drift` failures)

**Step 3: Manual testing checklist**

1. Open Companion at http://localhost:5174
2. Open a session with a project directory
3. In the task panel Workspace section, click the fullscreen button → overlay opens
4. Click a .md file in the left tree → rendered in center with TOC on right
5. Click TOC items → smooth scroll to heading
6. Scroll content → TOC highlights active heading
7. Click Download → file downloads
8. Click Share → URL copied to clipboard
9. Press ESC → overlay closes
10. Click a non-.md file → plain text shown, no TOC sidebar
11. Collapse/expand left and right sidebars
