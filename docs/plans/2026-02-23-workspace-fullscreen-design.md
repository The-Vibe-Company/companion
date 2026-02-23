# Workspace Fullscreen Document Browser Design

## Overview

Enhance the WorkspaceSection with a fullscreen overlay that provides a complete document browsing experience: file tree on the left, Markdown preview in the center, auto-generated table of contents on the right, toolbar on top, and status bar at the bottom.

## Layout

```
┌─────────────────────────────────────────────────────┐
│  Toolbar:  ← Back | filename  |  📥Download 🔗Share ✕ │
├──────────┬──────────────────────────┬────────────────┤
│          │                          │  TOC (auto)     │
│  File    │   Markdown Rendered      │  h1             │
│  Tree    │   / Plain text preview   │   ├ h2          │
│  (left)  │   (center)               │   │ ├ h3        │
│          │                          │   ├ h2          │
│  240px   │                          │  200px          │
│  collap. │                          │  collapsible    │
├──────────┴──────────────────────────┴────────────────┤
│  StatusBar:  Words: 1,234  |  Lines: 56  |  Size: 4KB │
└─────────────────────────────────────────────────────┘
```

## Architecture: Independent Component (Plan A)

New standalone `WorkspaceFullscreen` component. Existing `WorkspaceSection` only adds a fullscreen trigger button.

### Components

| Component | Responsibility |
|-----------|---------------|
| `WorkspaceFullscreen` | Fullscreen overlay container, 3-column layout, state coordination |
| `FileTreePanel` | Left file tree panel (extracted/reused from WorkspaceSection) |
| `MarkdownViewer` | Center Markdown rendering with heading ID injection |
| `TableOfContents` | Right sidebar, auto-extracted from Markdown headings |
| `ViewerToolbar` | Top bar: back, filename, download, share link, close |
| `ViewerStatusBar` | Bottom bar: word count, line count, file size |

### Interactions

1. **Enter fullscreen**: Button in WorkspaceSection header → opens fullscreen overlay
2. **Exit fullscreen**: ESC key / close button
3. **File switching**: Click .md in left tree → center preview + right TOC update
4. **TOC navigation**: Click TOC item → smooth scroll to heading
5. **Scroll sync**: IntersectionObserver highlights current visible heading in TOC
6. **Share link**: Copy `http://host/#/preview?path=...` URL to clipboard, toast notification
7. **Download**: Calls existing `api.downloadFile()`
8. **Non-MD files**: Center shows plain text, right TOC panel auto-hides

### Technical Details

- **TOC extraction**: Collect h1-h6 during react-markdown rendering, build nested tree
- **Heading anchors**: Inject `id` attribute (slugified) on each heading for jump links
- **Scroll highlight**: IntersectionObserver on heading elements, update TOC active state
- **Sidebar collapse**: Both left/right sidebars support toggle collapse
- **Overlay**: React Portal + fixed positioning, high z-index

### Dependencies

- `react-markdown` (existing) — Markdown rendering
- `remark-gfm` (existing) — GFM support
- `react-arborist` (existing) — File tree
- No new dependencies required
