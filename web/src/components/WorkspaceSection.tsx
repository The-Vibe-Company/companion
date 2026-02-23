/**
 * WorkspaceSection — file tree browser + Markdown preview for the TaskPanel sidebar.
 *
 * Renders a react-arborist file tree with lazy-loaded directory children,
 * inline download buttons, and a Markdown preview pane for .md files.
 */
import { useState, useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Tree, type NodeRendererProps } from "react-arborist";
import { useStore } from "../store.js";
import { api, type FileEntry } from "../api.js";
import { WorkspaceFullscreen } from "./WorkspaceFullscreen.js";

// ─── Types ────────────────────────────────────────────────────────────────────

interface FileTreeNode {
  /** Full path as unique ID */
  id: string;
  name: string;
  type: "file" | "directory";
  size?: number;
  mtime?: string;
  /** undefined for files, [] for unexpanded dirs, populated after fetch */
  children?: FileTreeNode[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Human-readable file size */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} M`;
}

/** Convert API FileEntry list into FileTreeNode[] rooted at `basePath` */
function entriesToNodes(basePath: string, entries: FileEntry[]): FileTreeNode[] {
  const sep = basePath.endsWith("/") ? "" : "/";
  return entries.map((e) => ({
    id: `${basePath}${sep}${e.name}`,
    name: e.name,
    type: e.type,
    size: e.size,
    mtime: e.mtime,
    // directories start with empty children (placeholder) so arborist treats them as internal
    children: e.type === "directory" ? [] : undefined,
  }));
}

// ─── Node Renderer ────────────────────────────────────────────────────────────

function FileNode({ node, style }: NodeRendererProps<FileTreeNode>) {
  const [hovered, setHovered] = useState(false);
  const data = node.data;
  const isDir = data.type === "directory";
  const isMd = !isDir && data.name.endsWith(".md");

  return (
    <div
      style={style}
      className={`flex items-center gap-1 px-1 cursor-pointer rounded text-[12px] leading-tight hover:bg-cc-hover/50 ${
        node.isSelected ? "bg-cc-hover" : ""
      }`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={(e) => {
        e.stopPropagation();
        if (isDir) {
          node.toggle();
        } else {
          node.activate();
        }
      }}
    >
      {/* Chevron for dirs / dot for files */}
      <span className="shrink-0 w-4 h-4 flex items-center justify-center text-cc-muted">
        {isDir ? (
          <svg
            viewBox="0 0 16 16"
            fill="currentColor"
            className={`w-3 h-3 transition-transform ${node.isOpen ? "rotate-90" : ""}`}
          >
            <path d="M6 4l4 4-4 4z" />
          </svg>
        ) : (
          <span className="block w-1 h-1 rounded-full bg-cc-muted/40" />
        )}
      </span>

      {/* Icon */}
      <span className="shrink-0 text-[13px]">
        {isDir
          ? node.isOpen
            ? "\uD83D\uDCC2"
            : "\uD83D\uDCC1"
          : isMd
            ? "\uD83D\uDCDD"
            : "\uD83D\uDCC4"}
      </span>

      {/* Name */}
      <span className="truncate flex-1 text-cc-fg" title={data.name}>
        {data.name}
      </span>

      {/* Right side: size or download */}
      {hovered ? (
        <button
          className="shrink-0 text-cc-muted hover:text-cc-primary transition-colors cursor-pointer"
          title={isDir ? "Download as ZIP" : "Download file"}
          onClick={(e) => {
            e.stopPropagation();
            if (isDir) {
              api.downloadZip(data.id);
            } else {
              api.downloadFile(data.id);
            }
          }}
        >
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
            <path d="M8 1a.5.5 0 01.5.5v8.793l2.146-2.147a.5.5 0 01.708.708l-3 3a.5.5 0 01-.708 0l-3-3a.5.5 0 11.708-.708L7.5 10.293V1.5A.5.5 0 018 1zM2 13.5a.5.5 0 01.5-.5h11a.5.5 0 010 1h-11a.5.5 0 01-.5-.5z" />
          </svg>
        </button>
      ) : (
        !isDir &&
        data.size != null && (
          <span className="shrink-0 text-[10px] text-cc-muted tabular-nums">
            {formatSize(data.size)}
          </span>
        )
      )}
    </div>
  );
}

// ─── WorkspaceSection ─────────────────────────────────────────────────────────

export function WorkspaceSection({ sessionId }: { sessionId: string }) {
  const sessionCwd = useStore((s) => {
    const session = s.sessions.get(sessionId);
    if (session?.cwd) return session.cwd;
    const sdk = s.sdkSessions.find((ses) => ses.sessionId === sessionId);
    return sdk?.cwd || null;
  });

  const [treeData, setTreeData] = useState<FileTreeNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [previewFile, setPreviewFile] = useState<string | null>(null);
  const [fullscreenOpen, setFullscreenOpen] = useState(false);

  // Track which directories have already been fetched to avoid re-fetching
  const fetchedDirsRef = useRef<Set<string>>(new Set());

  // ── Load root entries ───────────────────────────────────────────────────

  const loadRoot = useCallback(
    async (hidden: boolean) => {
      if (!sessionCwd) return;
      setLoading(true);
      setError(null);
      fetchedDirsRef.current.clear();
      try {
        const res = await api.listEntries(sessionCwd, { showHidden: hidden });
        setTreeData(entriesToNodes(sessionCwd, res.entries));
        fetchedDirsRef.current.add(sessionCwd);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Failed to load files");
        setTreeData([]);
      } finally {
        setLoading(false);
      }
    },
    [sessionCwd],
  );

  useEffect(() => {
    loadRoot(showHidden);
  }, [loadRoot, showHidden]);

  // ── Lazy load directory children on toggle ──────────────────────────────

  const handleToggle = useCallback(
    async (id: string) => {
      // Only fetch if not already fetched
      if (fetchedDirsRef.current.has(id)) return;

      try {
        const res = await api.listEntries(id, { showHidden });
        const childNodes = entriesToNodes(id, res.entries);
        fetchedDirsRef.current.add(id);

        setTreeData((prev) => {
          // Recursively find and update the matching directory node
          function updateChildren(nodes: FileTreeNode[]): FileTreeNode[] {
            return nodes.map((n) => {
              if (n.id === id) {
                return { ...n, children: childNodes };
              }
              if (n.children) {
                return { ...n, children: updateChildren(n.children) };
              }
              return n;
            });
          }
          return updateChildren(prev);
        });
      } catch {
        // silent — directory stays collapsed
      }
    },
    [showHidden],
  );

  // ── Handle file activation (click) ──────────────────────────────────────

  const handleActivate = useCallback(
    (node: { data: FileTreeNode }) => {
      const data = node.data;
      if (data.type === "file" && data.name.endsWith(".md")) {
        setPreviewFile(data.id);
        setFullscreenOpen(true);
      }
    },
    [],
  );

  // ── No session cwd ─────────────────────────────────────────────────────

  if (!sessionCwd) {
    return (
      <div className="shrink-0 px-4 py-3 border-b border-cc-border">
        <p className="text-xs text-cc-muted text-center py-4">
          No workspace directory available
        </p>
      </div>
    );
  }

  // ── File tree mode ─────────────────────────────────────────────────────

  return (
    <div className="shrink-0 border-b border-cc-border">
      {/* Section header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-cc-border">
        <span className="text-[11px] text-cc-muted uppercase tracking-wider">
          Files
        </span>
        <div className="flex items-center gap-1">
          {/* Show hidden toggle */}
          <button
            onClick={() => setShowHidden((h) => !h)}
            className={`text-[10px] px-1.5 py-0.5 rounded transition-colors cursor-pointer ${
              showHidden
                ? "text-cc-primary bg-cc-primary/10"
                : "text-cc-muted hover:text-cc-fg"
            }`}
            title={showHidden ? "Hide hidden files" : "Show hidden files"}
          >
            .*
          </button>

          {/* Refresh */}
          <button
            onClick={() => {
              fetchedDirsRef.current.clear();
              loadRoot(showHidden);
            }}
            className="text-cc-muted hover:text-cc-fg transition-colors cursor-pointer"
            title="Refresh file tree"
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
              <path d="M11.534 7h3.932a.25.25 0 01.192.41l-1.966 2.36a.25.25 0 01-.384 0l-1.966-2.36a.25.25 0 01.192-.41zm-7.068 2H.534a.25.25 0 00-.192.41l1.966 2.36a.25.25 0 00.384 0l1.966-2.36A.25.25 0 004.466 9z" />
              <path
                fillRule="evenodd"
                d="M8 3a5 5 0 11-4.546 2.914.5.5 0 00-.908-.418A6 6 0 108 2v1z"
                clipRule="evenodd"
              />
            </svg>
          </button>

          {/* Fullscreen expand */}
          <button
            onClick={() => setFullscreenOpen(true)}
            className="text-cc-muted hover:text-cc-fg transition-colors cursor-pointer"
            title="Open fullscreen workspace"
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
              <path d="M2.5 2h3a.5.5 0 010 1H3v2.5a.5.5 0 01-1 0v-3a.5.5 0 01.5-.5zm11 0h-3a.5.5 0 010 1H13v2.5a.5.5 0 001 0v-3a.5.5 0 00-.5-.5zM2.5 14h3a.5.5 0 000-1H3v-2.5a.5.5 0 00-1 0v3a.5.5 0 00.5.5zm11 0h-3a.5.5 0 010-1H13v-2.5a.5.5 0 011 0v3a.5.5 0 01-.5.5z" />
            </svg>
          </button>
        </div>
      </div>

      {/* Tree content */}
      <div className="px-1 py-1">
        {loading && treeData.length === 0 ? (
          <p className="text-xs text-cc-muted text-center py-8">Loading...</p>
        ) : error ? (
          <p className="text-xs text-cc-error text-center py-4">{error}</p>
        ) : treeData.length === 0 ? (
          <p className="text-xs text-cc-muted text-center py-4">
            No files found
          </p>
        ) : (
          <div style={{ maxHeight: 400, overflow: "auto" }}>
            <Tree<FileTreeNode>
              data={treeData}
              openByDefault={false}
              width={300}
              height={Math.min(treeData.length * 28 + 8, 400)}
              rowHeight={28}
              indent={16}
              onToggle={handleToggle}
              onActivate={handleActivate}
              disableDrag
              disableDrop
              disableEdit
              disableMultiSelection
            >
              {FileNode}
            </Tree>
          </div>
        )}
      </div>

      {fullscreenOpen && sessionCwd && createPortal(
        <WorkspaceFullscreen
          sessionId={sessionId}
          initialFile={previewFile}
          onClose={() => setFullscreenOpen(false)}
        />,
        document.body,
      )}
    </div>
  );
}
