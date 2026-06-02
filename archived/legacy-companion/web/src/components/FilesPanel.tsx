import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { EditorView } from "@codemirror/view";
import { api, type TreeNode } from "../api.js";
import { useStore } from "../store.js";
import { isImageFile, langForPath, relPath } from "./file-view-utils.js";

interface FilesPanelProps {
  sessionId: string;
}

interface TreeEntryProps {
  node: TreeNode;
  depth: number;
  cwd: string;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}

function TreeEntry({ node, depth, cwd, selectedPath, onSelect }: TreeEntryProps) {
  const [open, setOpen] = useState(false);

  if (node.type === "directory") {
    return (
      <div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="w-full flex items-center gap-1.5 py-2 pr-2 text-left text-xs text-cc-muted hover:text-cc-fg hover:bg-cc-hover rounded cursor-pointer"
          style={{ paddingLeft: `${8 + depth * 12}px` }}
          aria-label={`Toggle ${relPath(cwd, node.path)}`}
        >
          <span className="w-3 inline-flex justify-center">{open ? "\u25BE" : "\u25B8"}</span>
          <span className="truncate">{node.name}</span>
        </button>
        {open && node.children?.map((child) => (
          <TreeEntry
            key={child.path}
            node={child}
            depth={depth + 1}
            cwd={cwd}
            selectedPath={selectedPath}
            onSelect={onSelect}
          />
        ))}
      </div>
    );
  }

  const selected = selectedPath === node.path;
  return (
    <button
      type="button"
      onClick={() => onSelect(node.path)}
      className={`w-full py-2 pr-2 text-left text-xs rounded truncate cursor-pointer ${
        selected ? "bg-cc-active text-cc-fg" : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
      }`}
      style={{ paddingLeft: `${26 + depth * 12}px` }}
      title={relPath(cwd, node.path)}
    >
      {node.name}
    </button>
  );
}

function FileContentViewer({ content, filePath, darkMode }: { content: string; filePath: string; darkMode: boolean }) {
  const extensions = useMemo(() => {
    const exts = [
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({ "aria-label": "File content" }),
    ];
    const lang = langForPath(filePath);
    if (lang) exts.push(lang as never);
    return exts;
  }, [filePath]);

  return (
    <CodeMirror
      value={content}
      readOnly
      editable={false}
      extensions={extensions}
      theme={darkMode ? "dark" : "light"}
      basicSetup={{
        lineNumbers: true,
        foldGutter: true,
        highlightActiveLineGutter: false,
        highlightActiveLine: false,
        dropCursor: false,
        allowMultipleSelections: false,
      }}
      className="h-full text-sm"
      height="100%"
    />
  );
}

export function FilesPanel({ sessionId }: FilesPanelProps) {
  const darkMode = useStore((s) => s.darkMode);
  const cwd = useStore((s) =>
    s.sessions.get(sessionId)?.cwd
    || s.sdkSessions.find((sdk) => sdk.sessionId === sessionId)?.cwd
    || null,
  );

  const [tree, setTree] = useState<TreeNode[]>([]);
  const [loadingTree, setLoadingTree] = useState(true);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string>("");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const imageUrlRef = useRef<string | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keep ref in sync so unmount cleanup can access current value
  useEffect(() => { imageUrlRef.current = imageUrl; }, [imageUrl]);

  // Revoke object URL on component unmount to prevent memory leaks
  useEffect(() => {
    return () => {
      if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
    };
  }, []);

  // Load the file tree when cwd changes
  useEffect(() => {
    if (!cwd) {
      setLoadingTree(false);
      return;
    }
    let cancelled = false;
    setLoadingTree(true);
    setError(null);
    api.getFileTree(cwd).then((res) => {
      if (cancelled) return;
      setTree(res.tree);
    }).catch((err) => {
      if (cancelled) return;
      setError(err instanceof Error ? err.message : "Failed to load file tree");
      setTree([]);
    }).finally(() => {
      if (!cancelled) setLoadingTree(false);
    });
    return () => { cancelled = true; };
  }, [cwd]);

  // Load file content (or image blob) when a file is selected
  useEffect(() => {
    if (!selectedFilePath) {
      setFileContent("");
      setImageUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return null; });
      return;
    }
    let cancelled = false;
    setLoadingFile(true);
    setError(null);

    if (isImageFile(selectedFilePath)) {
      setFileContent("");
      api.getFileBlob(selectedFilePath).then((url) => {
        if (cancelled) { URL.revokeObjectURL(url); return; }
        setImageUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return url; });
      }).catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load image");
        setImageUrl(null);
      }).finally(() => {
        if (!cancelled) setLoadingFile(false);
      });
    } else {
      setImageUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return null; });
      api.readFile(selectedFilePath).then((res) => {
        if (cancelled) return;
        setFileContent(res.content);
      }).catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to read file");
        setFileContent("");
      }).finally(() => {
        if (!cancelled) setLoadingFile(false);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [selectedFilePath]);

  const handleBack = useCallback(() => {
    setSelectedFilePath(null);
    setFileContent("");
    setImageUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return null; });
    setError(null);
  }, []);

  const handleRefresh = useCallback(() => {
    if (!cwd) return;
    setLoadingTree(true);
    setError(null);
    setSelectedFilePath(null);
    setFileContent("");
    setImageUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return null; });
    api.getFileTree(cwd).then((res) => {
      setTree(res.tree);
    }).catch((err) => {
      setError(err instanceof Error ? err.message : "Failed to load file tree");
      setTree([]);
    }).finally(() => {
      setLoadingTree(false);
    });
  }, [cwd]);

  // No cwd — waiting for session
  if (!cwd) {
    return (
      <div className="h-full flex items-center justify-center p-4 text-sm text-cc-muted">
        Waiting for session to connect...
      </div>
    );
  }

  // ── Desktop layout: side-by-side ──
  // ── Mobile layout: master/detail (tree OR file viewer) ──

  const treePanel = (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="shrink-0 px-3 py-2 border-b border-cc-border flex items-center justify-between">
        <span className="text-xs text-cc-muted font-medium">Files</span>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={loadingTree}
          className="text-[11px] px-2 py-1.5 text-cc-muted hover:text-cc-fg disabled:opacity-50 transition-colors cursor-pointer"
          aria-label="Refresh file tree"
        >
          {loadingTree ? "..." : "Refresh"}
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto p-1.5">
        {loadingTree && <div className="px-2 py-2 text-xs text-cc-muted">Loading files...</div>}
        {!loadingTree && tree.length === 0 && !error && (
          <div className="px-2 py-2 text-xs text-cc-muted">No files found.</div>
        )}
        {!loadingTree && error && !selectedFilePath && (
          <div className="m-2 px-3 py-2 rounded-lg bg-cc-error/10 border border-cc-error/30 text-xs text-cc-error">
            {error}
            <button
              type="button"
              onClick={handleRefresh}
              className="ml-2 underline hover:no-underline cursor-pointer"
            >
              Retry
            </button>
          </div>
        )}
        {!loadingTree && tree.map((node) => (
          <TreeEntry
            key={node.path}
            node={node}
            depth={0}
            cwd={cwd}
            selectedPath={selectedFilePath}
            onSelect={setSelectedFilePath}
          />
        ))}
      </div>
    </div>
  );

  const fileViewer = selectedFilePath ? (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="shrink-0 px-3 py-2 border-b border-cc-border flex items-center gap-2">
        {/* Back button — always visible on mobile, hidden on desktop */}
        <button
          type="button"
          onClick={handleBack}
          className="sm:hidden flex items-center justify-center w-8 h-8 rounded text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer shrink-0"
          aria-label="Back to file tree"
        >
          <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
            <path fillRule="evenodd" d="M12.79 5.23a.75.75 0 01-.02 1.06L8.832 10l3.938 3.71a.75.75 0 11-1.04 1.08l-4.5-4.25a.75.75 0 010-1.08l4.5-4.25a.75.75 0 011.06.02z" clipRule="evenodd" />
          </svg>
        </button>
        <p className="text-[11px] text-cc-muted truncate min-w-0">{relPath(cwd, selectedFilePath)}</p>
      </div>
      {error && (
        <div className="m-3 px-3 py-2 rounded-lg bg-cc-error/10 border border-cc-error/30 text-xs text-cc-error">
          {error}
        </div>
      )}
      <div className="flex-1 min-h-0">
        {loadingFile ? (
          <div className="h-full flex items-center justify-center text-sm text-cc-muted">Loading file...</div>
        ) : imageUrl ? (
          <div className="h-full flex items-center justify-center p-4 bg-cc-bg overflow-auto">
            <img
              src={imageUrl}
              alt={relPath(cwd, selectedFilePath)}
              className="max-w-full max-h-full object-contain rounded"
            />
          </div>
        ) : (
          <FileContentViewer content={fileContent} filePath={selectedFilePath} darkMode={darkMode} />
        )}
      </div>
    </div>
  ) : null;

  return (
    <div className="h-full min-h-0 flex bg-cc-bg">
      {/* Desktop: side-by-side */}
      <aside className="hidden sm:flex w-[240px] shrink-0 border-r border-cc-border bg-cc-sidebar/60 flex-col min-h-0">
        {treePanel}
      </aside>
      <div className="hidden sm:flex flex-1 min-h-0 flex-col">
        {fileViewer || (
          <div className="h-full flex items-center justify-center text-sm text-cc-muted">
            Select a file to view its contents.
          </div>
        )}
      </div>

      {/* Mobile: master/detail */}
      <div className="flex sm:hidden flex-1 min-h-0 flex-col">
        {selectedFilePath ? fileViewer : treePanel}
      </div>
    </div>
  );
}
