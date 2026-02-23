/**
 * WorkspaceSection — file tree browser + Markdown preview for the TaskPanel sidebar.
 *
 * Renders a react-arborist file tree with lazy-loaded directory children,
 * inline download buttons, and a Markdown preview pane for .md files.
 */
import { useState, useCallback, useEffect, useRef, type ComponentProps } from "react";
import { Tree, type NodeRendererProps } from "react-arborist";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useStore } from "../store.js";
import { api, type FileEntry } from "../api.js";

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

// ─── Markdown Preview ─────────────────────────────────────────────────────────

function MarkdownPreview({
  filePath,
  onBack,
}: {
  filePath: string;
  onBack: () => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .readFile(filePath)
      .then((res) => {
        if (!cancelled) setContent(res.content);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || "Failed to load file");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  const fileName = filePath.split("/").pop() || filePath;

  return (
    <div className="flex flex-col">
      {/* Header with back button + file path */}
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-cc-border">
        <button
          onClick={onBack}
          className="shrink-0 flex items-center gap-1 text-[11px] text-cc-muted hover:text-cc-fg transition-colors cursor-pointer"
        >
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
            <path
              fillRule="evenodd"
              d="M11.354 1.646a.5.5 0 010 .708L5.707 8l5.647 5.646a.5.5 0 01-.708.708l-6-6a.5.5 0 010-.708l6-6a.5.5 0 01.708 0z"
              clipRule="evenodd"
            />
          </svg>
          Back
        </button>
        <span className="text-[11px] text-cc-muted truncate flex-1" title={filePath}>
          {fileName}
        </span>
      </div>

      {/* Content */}
      <div className="px-3 py-2 overflow-y-auto" style={{ maxHeight: 400 }}>
        {loading && (
          <p className="text-xs text-cc-muted text-center py-8">Loading...</p>
        )}
        {error && (
          <p className="text-xs text-cc-error text-center py-8">{error}</p>
        )}
        {!loading && !error && content !== null && (
          <div className="markdown-body text-[12px] text-cc-fg leading-relaxed overflow-hidden">
            <Markdown
              remarkPlugins={[remarkGfm]}
              components={{
                p: ({ children }) => (
                  <p className="mb-2 last:mb-0">{children}</p>
                ),
                strong: ({ children }) => (
                  <strong className="font-semibold text-cc-fg">{children}</strong>
                ),
                em: ({ children }) => <em className="italic">{children}</em>,
                h1: ({ children }) => (
                  <h1 className="text-base font-bold text-cc-fg mt-3 mb-1.5">
                    {children}
                  </h1>
                ),
                h2: ({ children }) => (
                  <h2 className="text-sm font-bold text-cc-fg mt-2.5 mb-1">
                    {children}
                  </h2>
                ),
                h3: ({ children }) => (
                  <h3 className="text-[13px] font-semibold text-cc-fg mt-2 mb-1">
                    {children}
                  </h3>
                ),
                ul: ({ children }) => (
                  <ul className="list-disc pl-4 mb-2 space-y-0.5">{children}</ul>
                ),
                ol: ({ children }) => (
                  <ol className="list-decimal pl-4 mb-2 space-y-0.5">{children}</ol>
                ),
                li: ({ children }) => <li className="text-cc-fg">{children}</li>,
                a: ({ href, children }) => (
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-cc-primary hover:underline"
                  >
                    {children}
                  </a>
                ),
                blockquote: ({ children }) => (
                  <blockquote className="border-l-2 border-cc-primary/30 pl-2 my-1.5 text-cc-muted italic">
                    {children}
                  </blockquote>
                ),
                hr: () => <hr className="border-cc-border my-3" />,
                code: (props: ComponentProps<"code">) => {
                  const { children, className } = props;
                  const match = /language-(\w+)/.exec(className || "");
                  const isBlock =
                    match ||
                    (typeof children === "string" && children.includes("\n"));
                  if (isBlock) {
                    const lang = match?.[1] || "";
                    return (
                      <div className="my-1.5 rounded-lg overflow-hidden border border-cc-border">
                        {lang && (
                          <div className="px-2 py-1 bg-cc-code-bg/80 border-b border-cc-border text-[9px] text-cc-muted font-mono-code uppercase tracking-wider">
                            {lang}
                          </div>
                        )}
                        <pre className="px-2 py-1.5 bg-cc-code-bg text-cc-code-fg text-[11px] font-mono-code leading-relaxed overflow-x-auto">
                          <code>{children}</code>
                        </pre>
                      </div>
                    );
                  }
                  return (
                    <code className="px-1 py-0.5 rounded-md bg-cc-fg/[0.06] text-[11px] font-mono-code text-cc-fg/80">
                      {children}
                    </code>
                  );
                },
                pre: ({ children }) => <>{children}</>,
                table: ({ children }) => (
                  <div className="overflow-x-auto my-1.5">
                    <table className="min-w-full text-[11px] border border-cc-border rounded-lg overflow-hidden">
                      {children}
                    </table>
                  </div>
                ),
                thead: ({ children }) => (
                  <thead className="bg-cc-code-bg/50">{children}</thead>
                ),
                th: ({ children }) => (
                  <th className="px-2 py-1 text-left text-[10px] font-semibold text-cc-fg border-b border-cc-border">
                    {children}
                  </th>
                ),
                td: ({ children }) => (
                  <td className="px-2 py-1 text-[10px] text-cc-fg border-b border-cc-border">
                    {children}
                  </td>
                ),
              }}
            >
              {content}
            </Markdown>
          </div>
        )}
      </div>
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

  // ── Markdown preview mode ──────────────────────────────────────────────

  if (previewFile) {
    return (
      <div className="shrink-0 border-b border-cc-border">
        <MarkdownPreview
          filePath={previewFile}
          onBack={() => setPreviewFile(null)}
        />
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
    </div>
  );
}
