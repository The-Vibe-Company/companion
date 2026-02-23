import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { api, type DirEntry } from "../api.js";
import { getRecentDirs, addRecentDir } from "../utils/recent-dirs.js";

interface FolderPickerProps {
  initialPath: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}

export function FolderPicker({ initialPath, onSelect, onClose }: FolderPickerProps) {
  const [browsePath, setBrowsePath] = useState("");
  const [browseDirs, setBrowseDirs] = useState<DirEntry[]>([]);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [dirInput, setDirInput] = useState("");
  const [showDirInput, setShowDirInput] = useState(false);
  const [showHidden, setShowHidden] = useState(() => localStorage.getItem("cc-show-hidden") === "1");
  const [recentDirs] = useState<string[]>(() => getRecentDirs());

  const loadDirs = useCallback(async (path?: string, hidden?: boolean) => {
    setBrowseLoading(true);
    const useHidden = hidden ?? showHidden;
    try {
      const result = await api.listDirs(path, { showHidden: useHidden });
      setBrowsePath(result.path);
      setBrowseDirs(result.dirs);
    } catch {
      setBrowseDirs([]);
    } finally {
      setBrowseLoading(false);
    }
  }, [showHidden]);

  useEffect(() => {
    loadDirs(initialPath || undefined);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Escape to close (unless in manual input mode)
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !showDirInput) onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, showDirInput]);

  function selectDir(path: string) {
    addRecentDir(path);
    onSelect(path);
    onClose();
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-full max-w-lg h-[min(480px,90dvh)] mx-0 sm:mx-4 flex flex-col bg-cc-bg border border-cc-border rounded-t-[14px] sm:rounded-[14px] shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 sm:px-5 py-3 sm:py-4 border-b border-cc-border shrink-0">
          <h2 className="text-sm font-semibold text-cc-fg">Select Folder</h2>
          <button
            onClick={onClose}
            className="w-6 h-6 flex items-center justify-center rounded-md text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Recent directories */}
        {recentDirs.length > 0 && (
          <div className="border-b border-cc-border shrink-0">
            <div className="px-4 pt-2.5 pb-1 text-[10px] text-cc-muted uppercase tracking-wider">Recent</div>
            {recentDirs.map((dir) => (
              <button
                key={dir}
                onClick={() => selectDir(dir)}
                className="w-full px-4 py-2 sm:py-1.5 text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer flex items-center gap-2 text-cc-fg"
              >
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 opacity-30 shrink-0">
                  <path d="M8 3.5a.5.5 0 00-1 0V8a.5.5 0 00.252.434l3.5 2a.5.5 0 00.496-.868L8 7.71V3.5z" />
                  <path fillRule="evenodd" d="M8 16A8 8 0 108 0a8 8 0 000 16zm7-8A7 7 0 111 8a7 7 0 0114 0z" />
                </svg>
                <span className="font-medium truncate">{dir.split("/").pop() || dir}</span>
                <span className="text-cc-muted font-mono-code text-[10px] truncate ml-auto">{dir}</span>
              </button>
            ))}
          </div>
        )}

        {/* Path bar */}
        <div className="px-4 py-2.5 border-b border-cc-border flex items-center gap-2 shrink-0">
          {showDirInput ? (
            <input
              type="text"
              value={dirInput}
              onChange={(e) => setDirInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && dirInput.trim()) {
                  selectDir(dirInput.trim());
                }
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setShowDirInput(false);
                }
              }}
              placeholder="/path/to/project"
              className="flex-1 px-2 py-1 text-base sm:text-xs bg-cc-input-bg border border-cc-border rounded-md text-cc-fg font-mono-code placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/50"
              autoFocus
            />
          ) : (
            <>
              {/* Go up button */}
              {browsePath && browsePath !== "/" && (
                <button
                  onClick={() => {
                    const parent = browsePath.split("/").slice(0, -1).join("/") || "/";
                    loadDirs(parent);
                  }}
                  className="w-6 h-6 flex items-center justify-center rounded-md text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer shrink-0"
                  title="Go to parent directory"
                >
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                    <path d="M8 12l-4-4h2.5V4h3v4H12L8 12z" transform="rotate(180 8 8)" />
                  </svg>
                </button>
              )}
              <span className="text-[11px] text-cc-muted font-mono-code truncate flex-1">{browsePath}</span>
              <button
                onClick={() => { setShowDirInput(true); setDirInput(browsePath); }}
                className="w-6 h-6 flex items-center justify-center rounded-md text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer shrink-0"
                title="Type path manually"
              >
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                  <path d="M11.013 1.427a1.75 1.75 0 012.474 0l1.086 1.086a1.75 1.75 0 010 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 01-.927-.928l.929-3.25a1.75 1.75 0 01.445-.758l8.61-8.61zm1.414 1.06a.25.25 0 00-.354 0L3.463 11.098a.25.25 0 00-.064.108l-.563 1.97 1.971-.564a.25.25 0 00.108-.064l8.61-8.61a.25.25 0 000-.354l-1.098-1.097z" />
                </svg>
              </button>
            </>
          )}
        </div>

        {/* Options bar: show hidden + new folder */}
        <div className="px-4 py-1.5 border-b border-cc-border flex items-center gap-3 shrink-0">
          <label className="flex items-center gap-1.5 text-[11px] text-cc-muted cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showHidden}
              onChange={(e) => {
                const val = e.target.checked;
                setShowHidden(val);
                localStorage.setItem("cc-show-hidden", val ? "1" : "0");
                loadDirs(browsePath, val);
              }}
              className="accent-cc-primary w-3 h-3"
            />
            Show hidden
          </label>
          <button
            onClick={async () => {
              const name = prompt("New folder name:");
              if (!name?.trim()) return;
              const newPath = `${browsePath}/${name.trim()}`;
              try {
                await api.createDir(newPath);
                loadDirs(newPath);
              } catch {
                loadDirs(browsePath);
              }
            }}
            className="ml-auto text-[11px] text-cc-primary hover:text-cc-fg transition-colors cursor-pointer"
          >
            + New Folder
          </button>
        </div>

        {/* Directory browser */}
        {!showDirInput && (
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            {/* Select current directory */}
            <button
              onClick={() => selectDir(browsePath)}
              className="w-full px-4 py-2 text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer flex items-center gap-2 text-cc-primary font-medium border-b border-cc-border shrink-0"
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 shrink-0">
                <path d="M12.416 3.376a.75.75 0 01.208 1.04l-5 7.5a.75.75 0 01-1.154.114l-3-3a.75.75 0 011.06-1.06l2.353 2.353 4.493-6.74a.75.75 0 011.04-.207z" />
              </svg>
              <span className="truncate font-mono-code">Select: {browsePath.split("/").pop() || "/"}</span>
            </button>

            {/* Subdirectories */}
            <div className="flex-1 min-h-0 overflow-y-auto">
              {browseLoading ? (
                <div className="px-4 py-6 text-xs text-cc-muted text-center">Loading...</div>
              ) : browseDirs.length === 0 ? (
                <div className="px-4 py-6 text-xs text-cc-muted text-center">No subdirectories</div>
              ) : (
                browseDirs.map((d) => (
                  <div
                    key={d.path}
                    className="flex items-center hover:bg-cc-hover transition-colors"
                  >
                    <button
                      onClick={() => loadDirs(d.path)}
                      onDoubleClick={() => selectDir(d.path)}
                      className="flex-1 min-w-0 px-4 py-2 sm:py-1.5 text-xs text-left cursor-pointer font-mono-code flex items-center gap-2 text-cc-fg"
                      title={d.path}
                    >
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 opacity-40 shrink-0">
                        <path d="M1 3.5A1.5 1.5 0 012.5 2h3.379a1.5 1.5 0 011.06.44l.622.621a.5.5 0 00.353.146H13.5A1.5 1.5 0 0115 4.707V12.5a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12.5v-9z" />
                      </svg>
                      <span className="truncate">{d.name}</span>
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 opacity-30 shrink-0 ml-auto">
                        <path d="M6 4l4 4-4 4" />
                      </svg>
                    </button>
                    <button
                      onClick={() => selectDir(d.path)}
                      className="shrink-0 w-8 h-8 sm:w-6 sm:h-6 mr-2 flex items-center justify-center rounded-md text-cc-muted hover:text-cc-primary hover:bg-cc-primary/10 transition-colors cursor-pointer"
                      title={`Select ${d.name}`}
                    >
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                        <path d="M12.416 3.376a.75.75 0 01.208 1.04l-5 7.5a.75.75 0 01-1.154.114l-3-3a.75.75 0 011.06-1.06l2.353 2.353 4.493-6.74a.75.75 0 011.04-.207z" />
                      </svg>
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
