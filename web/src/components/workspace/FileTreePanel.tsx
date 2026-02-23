/**
 * FileTreePanel — Full-height file tree sidebar for the fullscreen workspace overlay.
 *
 * Adapted from WorkspaceSection.tsx file tree logic, but designed for a
 * dedicated sidebar layout with collapse/expand, ResizeObserver-based height,
 * and selection highlighting for any file type.
 */
import {
  useState,
  useCallback,
  useEffect,
  useRef,
} from "react";
import { Tree, type NodeRendererProps } from "react-arborist";
import { api, type FileEntry } from "../../api.js";

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

// ─── Props ────────────────────────────────────────────────────────────────────

export interface FileTreePanelProps {
  sessionId: string;
  sessionCwd: string;
  selectedFile: string | null;
  onFileSelect: (path: string) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
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

/**
 * FileNode with selectedFile awareness.
 *
 * We pass the extra context (selectedFile, onFileSelect) via a closure-based
 * component factory so react-arborist can use it as a standard NodeRenderer.
 */
function createFileNodeRenderer(
  selectedFile: string | null,
  onFileSelect: (path: string) => void,
) {
  return function FileNode({ node, style }: NodeRendererProps<FileTreeNode>) {
    const [hovered, setHovered] = useState(false);
    const data = node.data;
    const isDir = data.type === "directory";
    const isMd = !isDir && data.name.endsWith(".md");
    const isSelected = !isDir && data.id === selectedFile;

    return (
      <div
        style={style}
        className={`flex items-center gap-1 px-1 cursor-pointer rounded text-[12px] leading-tight transition-colors ${
          isSelected
            ? "bg-cc-primary/15 text-cc-primary"
            : "hover:bg-cc-hover/50"
        }`}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={(e) => {
          e.stopPropagation();
          if (isDir) {
            node.toggle();
          } else {
            onFileSelect(data.id);
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
        <span
          className={`truncate flex-1 ${isSelected ? "text-cc-primary font-medium" : "text-cc-fg"}`}
          title={data.name}
        >
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
  };
}

// ─── FileTreePanel ────────────────────────────────────────────────────────────

export function FileTreePanel({
  sessionId: _sessionId,
  sessionCwd,
  selectedFile,
  onFileSelect,
  collapsed,
  onToggleCollapse,
}: FileTreePanelProps) {
  const [treeData, setTreeData] = useState<FileTreeNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);

  // Track which directories have already been fetched to avoid re-fetching
  const fetchedDirsRef = useRef<Set<string>>(new Set());

  // Container ref for ResizeObserver-based tree height
  const containerRef = useRef<HTMLDivElement>(null);
  const [treeHeight, setTreeHeight] = useState(400);

  // ── ResizeObserver for dynamic tree height ──────────────────────────────

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const h = entry.contentRect.height;
        if (h > 0) {
          setTreeHeight(h);
        }
      }
    });

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // ── Load root entries ─────────────────────────────────────────────────

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

  // ── Lazy load directory children on toggle ────────────────────────────

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

  // ── Stable FileNode renderer (recreated when selectedFile changes) ────

  const FileNodeRenderer = useCallback(
    (props: NodeRendererProps<FileTreeNode>) => {
      const Renderer = createFileNodeRenderer(selectedFile, onFileSelect);
      return <Renderer {...props} />;
    },
    [selectedFile, onFileSelect],
  );

  // ── Collapsed state: narrow strip with expand icon ────────────────────

  if (collapsed) {
    return (
      <div className="w-10 shrink-0 flex flex-col items-center border-r border-cc-border bg-cc-bg">
        <button
          onClick={onToggleCollapse}
          className="mt-2 p-1.5 rounded hover:bg-cc-hover/50 text-cc-muted hover:text-cc-fg transition-colors cursor-pointer"
          title="Expand file tree"
        >
          {/* Chevron right (expand) icon */}
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
            <path
              fillRule="evenodd"
              d="M4.646 1.646a.5.5 0 01.708 0l6 6a.5.5 0 010 .708l-6 6a.5.5 0 01-.708-.708L10.293 8 4.646 2.354a.5.5 0 010-.708z"
              clipRule="evenodd"
            />
          </svg>
        </button>
        {/* Vertical "Files" label */}
        <span
          className="mt-3 text-[10px] text-cc-muted uppercase tracking-wider"
          style={{ writingMode: "vertical-rl", textOrientation: "mixed" }}
        >
          Files
        </span>
      </div>
    );
  }

  // ── Expanded state: full sidebar ──────────────────────────────────────

  return (
    <div className="w-[240px] shrink-0 flex flex-col border-r border-cc-border bg-cc-bg overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-cc-border shrink-0">
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

          {/* Collapse */}
          <button
            onClick={onToggleCollapse}
            className="text-cc-muted hover:text-cc-fg transition-colors cursor-pointer"
            title="Collapse file tree"
          >
            {/* Chevron left (collapse) icon */}
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
              <path
                fillRule="evenodd"
                d="M11.354 1.646a.5.5 0 010 .708L5.707 8l5.647 5.646a.5.5 0 01-.708.708l-6-6a.5.5 0 010-.708l6-6a.5.5 0 01.708 0z"
                clipRule="evenodd"
              />
            </svg>
          </button>
        </div>
      </div>

      {/* Tree content — flex-1 with ResizeObserver */}
      <div ref={containerRef} className="flex-1 overflow-hidden px-1 py-1">
        {loading && treeData.length === 0 ? (
          <p className="text-xs text-cc-muted text-center py-8">Loading...</p>
        ) : error ? (
          <p className="text-xs text-cc-error text-center py-4">{error}</p>
        ) : treeData.length === 0 ? (
          <p className="text-xs text-cc-muted text-center py-4">
            No files found
          </p>
        ) : (
          <Tree<FileTreeNode>
            data={treeData}
            openByDefault={false}
            width={230}
            height={treeHeight}
            rowHeight={28}
            indent={16}
            onToggle={handleToggle}
            disableDrag
            disableDrop
            disableEdit
            disableMultiSelection
          >
            {FileNodeRenderer}
          </Tree>
        )}
      </div>
    </div>
  );
}
