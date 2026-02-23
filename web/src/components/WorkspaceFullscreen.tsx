/**
 * WorkspaceFullscreen -- fixed overlay for a fullscreen file browser / document viewer.
 *
 * Layout (5 zones):
 *   - Toolbar       (top)     -- file name, download, share, close
 *   - FileTreePanel (left)    -- collapsible sidebar file tree
 *   - Viewer        (center)  -- markdown or plain-text content
 *   - TableOfContents (right) -- collapsible TOC sidebar (markdown only)
 *   - StatusBar     (bottom)  -- word count, lines, size
 *
 * Closes on ESC. Loads file content via api.readFile when selection changes.
 */
import {
  useState,
  useEffect,
  useCallback,
  useRef,
} from "react";
import { useStore } from "../store.js";
import { api } from "../api.js";
import { ViewerToolbar } from "./workspace/ViewerToolbar.js";
import { FileTreePanel } from "./workspace/FileTreePanel.js";
import { MarkdownViewer } from "./workspace/MarkdownViewer.js";
import { TableOfContents, type TocItem } from "./workspace/TableOfContents.js";
import { ViewerStatusBar } from "./workspace/ViewerStatusBar.js";

// ---- Helpers ----------------------------------------------------------------

/** Check whether a file path points to a Markdown file. */
function isMarkdownFile(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".mdx") || lower.endsWith(".markdown");
}

// ---- Component --------------------------------------------------------------

export function WorkspaceFullscreen({
  sessionId,
  initialFile,
  onClose,
  cwd,
}: {
  sessionId: string;
  initialFile?: string | null;
  onClose: () => void;
  /** Optional override for the working directory. When provided, bypasses the store lookup. */
  cwd?: string | null;
}) {
  // ---- Session CWD from store (same pattern as WorkspaceSection) ------------
  const storeCwd = useStore((s) => {
    if (!sessionId) return null;
    const session = s.sessions.get(sessionId);
    if (session?.cwd) return session.cwd;
    const sdk = s.sdkSessions.find((ses) => ses.sessionId === sessionId);
    return sdk?.cwd || null;
  });
  const sessionCwd = cwd ?? storeCwd;

  // ---- State ----------------------------------------------------------------
  const [selectedFile, setSelectedFile] = useState<string | null>(initialFile ?? null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  const [tocItems, setTocItems] = useState<TocItem[]>([]);
  const [activeHeadingId, setActiveHeadingId] = useState<string | null>(null);

  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);

  const viewerRef = useRef<HTMLDivElement | null>(null);

  const isMd = selectedFile ? isMarkdownFile(selectedFile) : false;

  // ---- ESC key handler ------------------------------------------------------
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  // ---- Load file content when selectedFile changes --------------------------
  useEffect(() => {
    if (!selectedFile) {
      setFileContent(null);
      setFileError(null);
      setTocItems([]);
      setActiveHeadingId(null);
      return;
    }

    let cancelled = false;
    setFileLoading(true);
    setFileError(null);

    api
      .readFile(selectedFile)
      .then((res) => {
        if (!cancelled) {
          setFileContent(res.content);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setFileError(err instanceof Error ? err.message : "Failed to load file");
          setFileContent(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setFileLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedFile]);

  // ---- File select handler --------------------------------------------------
  const handleFileSelect = useCallback((path: string) => {
    setSelectedFile(path);
  }, []);

  // ---- TOC click: scroll to heading -----------------------------------------
  const handleTocClick = useCallback((id: string) => {
    const el = viewerRef.current?.querySelector(`#${CSS.escape(id)}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, []);

  // ---- Share link: copy to clipboard ----------------------------------------
  const handleShareLink = useCallback(() => {
    if (!selectedFile) return;
    const url = `${window.location.origin}${window.location.pathname}#/preview?path=${encodeURIComponent(selectedFile)}`;
    navigator.clipboard.writeText(url).catch(() => {
      // clipboard write may fail in some environments; silently ignore
    });
  }, [selectedFile]);

  // ---- Download file --------------------------------------------------------
  const handleDownload = useCallback(() => {
    if (!selectedFile) return;
    api.downloadFile(selectedFile);
  }, [selectedFile]);

  // ---- Render ---------------------------------------------------------------

  if (!sessionCwd) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-cc-bg">
      {/* ---- Toolbar (top) ---- */}
      <ViewerToolbar
        fileName={selectedFile}
        onClose={onClose}
        onDownload={handleDownload}
        onShareLink={handleShareLink}
      />

      {/* ---- Middle row: tree | viewer | toc ---- */}
      <div className="flex-1 flex min-h-0">
        {/* Left sidebar -- file tree */}
        <FileTreePanel
          sessionId={sessionId}
          sessionCwd={sessionCwd}
          selectedFile={selectedFile}
          onFileSelect={handleFileSelect}
          collapsed={leftCollapsed}
          onToggleCollapse={() => setLeftCollapsed((c) => !c)}
        />

        {/* Center -- viewer area */}
        <div
          ref={viewerRef}
          className="flex-1 overflow-y-auto min-w-0"
        >
          {/* Loading state */}
          {fileLoading && (
            <div className="flex items-center justify-center h-full">
              <span className="text-sm text-cc-muted">Loading...</span>
            </div>
          )}

          {/* Error state */}
          {!fileLoading && fileError && (
            <div className="flex items-center justify-center h-full">
              <span className="text-sm text-cc-error">{fileError}</span>
            </div>
          )}

          {/* Empty state -- no file selected */}
          {!fileLoading && !fileError && !selectedFile && (
            <div className="flex items-center justify-center h-full">
              <span className="text-sm text-cc-muted">Select a file to preview</span>
            </div>
          )}

          {/* Content: Markdown or plain text */}
          {!fileLoading && !fileError && selectedFile && fileContent != null && (
            isMd ? (
              <MarkdownViewer
                content={fileContent}
                onTocExtracted={setTocItems}
                onActiveHeadingChange={setActiveHeadingId}
                viewerRef={viewerRef}
              />
            ) : (
              <pre className="px-6 py-4 text-[13px] font-mono-code text-cc-fg whitespace-pre-wrap break-words leading-relaxed">
                {fileContent}
              </pre>
            )
          )}
        </div>

        {/* Right sidebar -- TOC (only shown for markdown files) */}
        {isMd && (
          <TableOfContents
            items={tocItems}
            activeId={activeHeadingId}
            onItemClick={handleTocClick}
            collapsed={rightCollapsed}
            onToggleCollapse={() => setRightCollapsed((c) => !c)}
          />
        )}
      </div>

      {/* ---- Status bar (bottom) ---- */}
      <ViewerStatusBar content={fileContent} filePath={selectedFile} />
    </div>
  );
}
