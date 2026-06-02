import { useEffect, useState, useCallback, useMemo } from "react";
import { useStore } from "../store.js";
import { api } from "../api.js";
import { DiffViewer } from "./DiffViewer.js";

type FileChangeStatus = "created" | "updated" | "deleted";

function FileStatusIcon({ status }: { status: FileChangeStatus }) {
  if (status === "created") {
    return (
      <span className="w-3.5 h-3.5 shrink-0 flex items-center justify-center rounded-sm text-[10px] font-bold leading-none bg-green-500/20 text-green-400">
        A
      </span>
    );
  }
  if (status === "deleted") {
    return (
      <span className="w-3.5 h-3.5 shrink-0 flex items-center justify-center rounded-sm text-[10px] font-bold leading-none bg-red-500/20 text-red-400">
        D
      </span>
    );
  }
  return (
    <span className="w-3.5 h-3.5 shrink-0 flex items-center justify-center rounded-sm text-[10px] font-bold leading-none bg-cc-warning/20 text-cc-warning">
      M
    </span>
  );
}

export function DiffPanel({ sessionId }: { sessionId: string }) {
  const session = useStore((s) => s.sessions.get(sessionId));
  const sdkSession = useStore((s) => s.sdkSessions.find((sdk) => sdk.sessionId === sessionId));
  const selectedFile = useStore((s) => s.diffPanelSelectedFile.get(sessionId) ?? null);
  const setSelectedFile = useStore((s) => s.setDiffPanelSelectedFile);
  const diffBase = useStore((s) => s.diffBase);
  const setDiffBase = useStore((s) => s.setDiffBase);
  // changedFilesTick used only as a refresh trigger (bumped when agent edits files)
  const changedFilesTick = useStore((s) => s.changedFilesTick.get(sessionId) ?? 0);

  const cwd = session?.cwd || sdkSession?.cwd;

  const [diffContent, setDiffContent] = useState<string>("");
  const [diffLoading, setDiffLoading] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth >= 640 : true,
  );
  const [gitFiles, setGitFiles] = useState<Array<{ abs: string; rel: string; status: FileChangeStatus }>>([]);

  const setGitChangedFilesCount = useStore((s) => s.setGitChangedFilesCount);

  // Fetch changed file list from git whenever cwd, base, or agent edits change
  useEffect(() => {
    if (!cwd) return;
    let cancelled = false;
    api.getChangedFiles(cwd, diffBase).then(({ files }) => {
      if (cancelled) return;
      const cwdPrefix = `${cwd}/`;
      const result = files
        .filter((f) => f.path === cwd || f.path.startsWith(cwdPrefix))
        .map((f) => ({
          abs: f.path,
          rel: f.path.startsWith(cwdPrefix) ? f.path.slice(cwdPrefix.length) : f.path,
          status: (f.status === "A" || f.status === "?" ? "created" : f.status === "D" ? "deleted" : "updated") as FileChangeStatus,
        }))
        .sort((a, b) => a.rel.localeCompare(b.rel));
      setGitFiles(result);
      setGitChangedFilesCount(sessionId, result.length);
    }).catch(() => { if (!cancelled) { setGitFiles([]); setGitChangedFilesCount(sessionId, 0); } });
    return () => { cancelled = true; };
  }, [cwd, diffBase, changedFilesTick, sessionId, setGitChangedFilesCount]);

  const relativeChangedFiles = gitFiles;

  // Auto-select first changed file if none selected
  useEffect(() => {
    if (!selectedFile && relativeChangedFiles.length > 0) {
      setSelectedFile(sessionId, relativeChangedFiles[0].abs);
    }
  }, [selectedFile, relativeChangedFiles, sessionId, setSelectedFile]);

  // If the selected file falls out of scope, clear or reselect.
  useEffect(() => {
    if (!selectedFile) return;
    if (relativeChangedFiles.some((f) => f.abs === selectedFile)) return;
    setSelectedFile(sessionId, relativeChangedFiles[0]?.abs ?? null);
  }, [selectedFile, relativeChangedFiles, sessionId, setSelectedFile]);

  // Fetch diff when selected file changes
  useEffect(() => {
    if (!selectedFile) {
      setDiffContent("");
      return;
    }
    let cancelled = false;
    setDiffLoading(true);
    api
      .getFileDiff(selectedFile, diffBase)
      .then((res) => {
        if (!cancelled) {
          setDiffContent(res.diff);
          setDiffLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDiffContent("");
          setDiffLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [selectedFile, diffBase]);

  const handleFileSelect = useCallback(
    (path: string) => {
      setSelectedFile(sessionId, path);
      if (typeof window !== "undefined" && window.innerWidth < 640) {
        setSidebarOpen(false);
      }
    },
    [sessionId, setSelectedFile],
  );

  const selectedRelPath = useMemo(() => {
    if (!selectedFile || !cwd) return selectedFile;
    return selectedFile.startsWith(cwd + "/") ? selectedFile.slice(cwd.length + 1) : selectedFile;
  }, [selectedFile, cwd]);

  if (!cwd) {
    return (
      <div className="flex-1 flex items-center justify-center h-full">
        <p className="text-cc-muted text-sm">Waiting for session to initialize...</p>
      </div>
    );
  }

  if (relativeChangedFiles.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-4 select-none px-6">
        <div className="w-14 h-14 rounded-2xl bg-cc-card border border-cc-border flex items-center justify-center">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-7 h-7 text-cc-muted">
            <path d="M12 3v18M3 12h18" strokeLinecap="round" />
          </svg>
        </div>
        <div className="text-center">
          <p className="text-sm text-cc-fg font-medium mb-1">No changes yet</p>
          <p className="text-xs text-cc-muted leading-relaxed">
            File changes compared to the base will appear here once the agent edits files.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex bg-cc-bg relative">
      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/30 z-20 sm:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Changed files sidebar */}
      <div
        className={`
          ${sidebarOpen ? "w-[220px] translate-x-0" : "w-0 -translate-x-full"}
          fixed sm:relative z-30 sm:z-auto
          ${sidebarOpen ? "sm:w-[220px]" : "sm:w-0 sm:-translate-x-full"}
          shrink-0 h-full flex flex-col bg-cc-sidebar border-r border-cc-border transition-all duration-200 overflow-hidden
        `}
      >
        <div className="w-[220px] px-4 py-3 text-[11px] font-semibold text-cc-fg uppercase tracking-wider border-b border-cc-border shrink-0 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-cc-warning" />
            <span>Changed ({relativeChangedFiles.length})</span>
          </div>
          <button
            onClick={() => setSidebarOpen(false)}
            className="w-8 h-8 flex items-center justify-center rounded-md text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer sm:hidden"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="w-3 h-3">
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto overflow-x-hidden py-1">
          {relativeChangedFiles.map(({ abs, rel, status }) => (
            <button
              key={abs}
              onClick={() => handleFileSelect(abs)}
              className={`flex items-center gap-2 w-full mx-1 px-2 py-2.5 text-[13px] rounded-[10px] hover:bg-cc-hover transition-colors cursor-pointer whitespace-nowrap ${
                abs === selectedFile ? "bg-cc-active text-cc-fg" : "text-cc-fg/70"
              }`}
              style={{ width: "calc(100% - 8px)" }}
            >
              <FileStatusIcon status={status} />
              <span className="truncate leading-snug">{rel}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Diff area */}
      <div className="flex-1 min-w-0 h-full flex flex-col">
        {/* Top bar */}
        {selectedFile && (
          <div className="shrink-0 flex items-center gap-2 sm:gap-2.5 px-2 sm:px-4 py-2.5 bg-cc-card border-b border-cc-border">
            {!sidebarOpen && (
              <button
                onClick={() => setSidebarOpen(true)}
                className="flex items-center justify-center w-8 h-8 rounded-md text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer shrink-0"
                title="Show file list"
              >
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                  <path d="M1 3.5A1.5 1.5 0 012.5 2h3.379a1.5 1.5 0 011.06.44l.622.621a.5.5 0 00.353.146H13.5A1.5 1.5 0 0115 4.707V12.5a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12.5v-9z" />
                </svg>
              </button>
            )}
            <div className="flex-1 min-w-0">
              <span className="text-cc-fg text-[13px] font-medium truncate block">
                {selectedRelPath?.split("/").pop()}
              </span>
              <span className="text-cc-muted truncate text-[11px] hidden sm:block font-mono-code">
                {selectedRelPath}
              </span>
            </div>
            <button
              onClick={() => setDiffBase(diffBase === "last-commit" ? "default-branch" : "last-commit")}
              className="text-cc-muted text-[11px] shrink-0 hidden sm:inline hover:text-cc-fg transition-colors cursor-pointer"
              title={`Switch to ${diffBase === "last-commit" ? "default branch" : "last commit"} comparison`}
            >
              {diffBase === "default-branch" ? "vs default branch" : "vs last commit"}
            </button>
          </div>
        )}

        {/* Diff content */}
        <div className="flex-1 overflow-auto">
          {diffLoading ? (
            <div className="h-full flex items-center justify-center">
              <div className="w-5 h-5 border-2 border-cc-primary border-t-transparent rounded-full animate-spin" />
            </div>
          ) : selectedFile ? (
            <div className="p-4">
              <DiffViewer unifiedDiff={diffContent} fileName={selectedRelPath || undefined} mode="full" />
            </div>
          ) : (
            <div className="h-full flex flex-col items-center justify-center">
              {!sidebarOpen && (
                <button
                  onClick={() => setSidebarOpen(true)}
                  className="mb-4 flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
                >
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                    <path d="M1 3.5A1.5 1.5 0 012.5 2h3.379a1.5 1.5 0 011.06.44l.622.621a.5.5 0 00.353.146H13.5A1.5 1.5 0 0115 4.707V12.5a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12.5v-9z" />
                  </svg>
                  Show file list
                </button>
              )}
              <p className="text-cc-muted text-sm">Select a file to view changes</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
