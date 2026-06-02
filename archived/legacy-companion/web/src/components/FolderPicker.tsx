import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { api, type DirEntry } from "../api.js";
import { getRecentDirs, addRecentDir } from "../utils/recent-dirs.js";

interface FolderPickerProps {
  initialPath: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}

/** Split an absolute path into clickable breadcrumb segments.
 *  e.g. "/Users/me/projects" → ["/", "Users", "me", "projects"]
 *  Each entry carries the full path up to that segment. */
function pathSegments(p: string): { label: string; path: string }[] {
  if (!p) return [];
  const parts = p.split("/").filter(Boolean);
  const segs: { label: string; path: string }[] = [{ label: "/", path: "/" }];
  let acc = "";
  for (const part of parts) {
    acc += "/" + part;
    segs.push({ label: part, path: acc });
  }
  return segs;
}

export function FolderPicker({ initialPath, onSelect, onClose }: FolderPickerProps) {
  const [browsePath, setBrowsePath] = useState("");
  const [browseDirs, setBrowseDirs] = useState<DirEntry[]>([]);
  const [browseLoading, setBrowseLoading] = useState(true);
  const [browseError, setBrowseError] = useState("");
  const [dirInput, setDirInput] = useState("");
  const [showDirInput, setShowDirInput] = useState(false);
  const [filter, setFilter] = useState("");
  const [focusIndex, setFocusIndex] = useState(-1);
  const [closing, setClosing] = useState(false);
  const [recentDirs, setRecentDirs] = useState<string[]>(() => getRecentDirs());

  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<Map<number, HTMLButtonElement>>(new Map());

  const filteredDirs = useMemo(() => {
    if (!filter) return browseDirs;
    const q = filter.toLowerCase();
    return browseDirs.filter((d) => d.name.toLowerCase().includes(q));
  }, [browseDirs, filter]);

  const loadDirs = useCallback(async (path?: string) => {
    setBrowseLoading(true);
    setBrowseError("");
    setFilter("");
    setFocusIndex(-1);
    try {
      const result = await api.listDirs(path);
      setBrowsePath(result.path);
      setBrowseDirs(result.dirs);
    } catch {
      setBrowseError("Could not load directory");
      setBrowseDirs([]);
    } finally {
      setBrowseLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDirs(initialPath || undefined);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Focus trap ──────────────────────────────────────────────────────────
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;

    function handleTab(e: KeyboardEvent) {
      if (e.key !== "Tab") return;
      const focusable = panel!.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleTab);
    // Auto-focus the filter input or first focusable on open
    const timer = setTimeout(() => {
      filterRef.current?.focus();
    }, 80);
    return () => {
      document.removeEventListener("keydown", handleTab);
      clearTimeout(timer);
    };
  }, []);

  const animateClose = useCallback(() => {
    if (closing) return;
    setClosing(true);
    setTimeout(onClose, 150);
  }, [onClose, closing]);

  // ── Global keyboard shortcuts ───────────────────────────────────────────
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (showDirInput) {
          // Let the input's own Escape handler fire first
          return;
        }
        animateClose();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [showDirInput, animateClose]);

  // ── Arrow-key navigation in directory list ──────────────────────────────
  useEffect(() => {
    function handleNav(e: KeyboardEvent) {
      if (showDirInput) return;

      // Backspace: go to parent directory (works even with empty dir list)
      if (e.key === "Backspace" && document.activeElement !== filterRef.current) {
        if (browsePath && browsePath !== "/") {
          e.preventDefault();
          const parent = browsePath.split("/").slice(0, -1).join("/") || "/";
          loadDirs(parent);
        }
        return;
      }

      // Arrow keys require items in the list
      const len = filteredDirs.length;
      if (len === 0) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        const next = focusIndex < len - 1 ? focusIndex + 1 : 0;
        setFocusIndex(next);
        itemRefs.current.get(next)?.focus();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const prev = focusIndex > 0 ? focusIndex - 1 : len - 1;
        setFocusIndex(prev);
        itemRefs.current.get(prev)?.focus();
      }
    }
    document.addEventListener("keydown", handleNav);
    return () => document.removeEventListener("keydown", handleNav);
  }, [showDirInput, filteredDirs.length, focusIndex, browsePath, loadDirs]);

  // Scroll focused item into view
  useEffect(() => {
    if (focusIndex >= 0) {
      itemRefs.current.get(focusIndex)?.scrollIntoView({ block: "nearest" });
    }
  }, [focusIndex]);

  function selectDir(path: string) {
    addRecentDir(path);
    setRecentDirs(getRecentDirs());
    onSelect(path);
    // Close immediately — no exit animation on selection (instant feedback)
    onClose();
  }

  const segments = pathSegments(browsePath);
  const currentDirName = browsePath.split("/").pop() || "/";

  return createPortal(
    <div
      className={`fixed inset-0 z-50 flex items-end sm:items-center justify-center transition-opacity duration-150 ${
        closing ? "opacity-0" : "opacity-100"
      }`}
      style={{ backgroundColor: "rgba(0,0,0,0.5)", backdropFilter: "blur(4px)" }}
      onClick={animateClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Select folder"
        className={`w-full max-w-lg h-[min(520px,90dvh)] mx-0 sm:mx-4 flex flex-col bg-cc-bg border border-cc-border rounded-t-[14px] sm:rounded-[14px] shadow-2xl overflow-hidden transition-transform duration-150 ${
          closing
            ? "translate-y-4 sm:translate-y-2 opacity-0"
            : "translate-y-0 opacity-100"
        }`}
        style={{ animation: "fadeSlideIn 200ms ease-out" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ─── Header ─────────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between px-4 sm:px-5 py-3 sm:py-4 border-b border-cc-border shrink-0">
          <h2 className="text-sm font-semibold text-cc-fg font-sans-ui">Select Folder</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={animateClose}
            className="w-6 h-6 flex items-center justify-center rounded-md text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* ─── Recent directories ─────────────────────────────────────────── */}
        {recentDirs.length > 0 && (
          <div className="border-b border-cc-border shrink-0" role="group" aria-label="Recent directories">
            <div className="px-4 pt-2.5 pb-1 text-[10px] text-cc-muted uppercase tracking-wider font-sans-ui select-none">
              Recent
            </div>
            <ul className="list-none m-0 p-0">
              {recentDirs.map((dir) => (
                <li key={dir}>
                  <button
                    type="button"
                    onClick={() => selectDir(dir)}
                    className="w-full px-4 py-2 sm:py-1.5 text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer flex items-center gap-2 text-cc-fg group"
                  >
                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 text-cc-muted opacity-50 group-hover:opacity-80 transition-opacity shrink-0">
                      <path d="M8 3.5a.5.5 0 00-1 0V8a.5.5 0 00.252.434l3.5 2a.5.5 0 00.496-.868L8 7.71V3.5z" />
                      <path fillRule="evenodd" d="M8 16A8 8 0 108 0a8 8 0 000 16zm7-8A7 7 0 111 8a7 7 0 0114 0z" />
                    </svg>
                    <span className="font-medium truncate">{dir.split("/").pop() || dir}</span>
                    <span className="text-cc-muted font-mono-code text-[10px] truncate ml-auto">{dir}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* ─── Breadcrumb / manual input bar ──────────────────────────────── */}
        <div className="px-4 py-2 border-b border-cc-border flex items-center gap-1.5 shrink-0 min-h-[40px]">
          {showDirInput ? (
            <input
              type="text"
              aria-label="Type a directory path"
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
              {/* Clickable breadcrumb segments */}
              <nav aria-label="Directory breadcrumb" className="flex-1 min-w-0 flex items-center gap-0.5 overflow-x-auto">
                {segments.map((seg, i) => {
                  const isLast = i === segments.length - 1;
                  return (
                    <span key={seg.path} className="flex items-center gap-0.5 shrink-0">
                      {i > 0 && (
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-2.5 h-2.5 text-cc-muted opacity-40 shrink-0">
                          <path d="M6 4l4 4-4 4" />
                        </svg>
                      )}
                      <button
                        type="button"
                        onClick={() => { if (!isLast) loadDirs(seg.path); }}
                        className={`text-[11px] font-mono-code px-1 py-0.5 rounded transition-colors whitespace-nowrap ${
                          isLast
                            ? "text-cc-fg font-medium cursor-default"
                            : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover cursor-pointer"
                        }`}
                        aria-current={isLast ? "location" : undefined}
                        tabIndex={isLast ? -1 : 0}
                      >
                        {seg.label}
                      </button>
                    </span>
                  );
                })}
              </nav>
              <button
                type="button"
                aria-label="Type path manually"
                onClick={() => { setShowDirInput(true); setDirInput(browsePath); }}
                className="w-6 h-6 flex items-center justify-center rounded-md text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer shrink-0"
              >
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                  <path d="M11.013 1.427a1.75 1.75 0 012.474 0l1.086 1.086a1.75 1.75 0 010 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 01-.927-.928l.929-3.25a1.75 1.75 0 01.445-.758l8.61-8.61zm1.414 1.06a.25.25 0 00-.354 0L3.463 11.098a.25.25 0 00-.064.108l-.563 1.97 1.971-.564a.25.25 0 00.108-.064l8.61-8.61a.25.25 0 000-.354l-1.098-1.097z" />
                </svg>
              </button>
            </>
          )}
        </div>

        {/* ─── Directory browser ──────────────────────────────────────────── */}
        {!showDirInput && (
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            {/* Filter + select current */}
            <div className="flex items-center gap-2 px-4 py-2 border-b border-cc-border shrink-0">
              <div className="flex-1 min-w-0 relative">
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 text-cc-muted absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none">
                  <path d="M11.5 7a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0zm-.82 4.74a6 6 0 111.06-1.06l3.04 3.04a.75.75 0 11-1.06 1.06l-3.04-3.04z" />
                </svg>
                <input
                  ref={filterRef}
                  type="text"
                  aria-label="Filter directories"
                  value={filter}
                  onChange={(e) => { setFilter(e.target.value); setFocusIndex(-1); }}
                  placeholder="Filter..."
                  className="w-full pl-7 pr-2 py-1.5 text-base sm:text-xs bg-transparent text-cc-fg font-mono-code placeholder:text-cc-muted/60 focus:outline-none rounded-md border border-transparent focus:border-cc-border transition-colors"
                />
              </div>
              <button
                type="button"
                onClick={() => selectDir(browsePath)}
                aria-label={`Select ${currentDirName}`}
                className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-cc-primary text-white hover:bg-cc-primary-hover transition-colors cursor-pointer"
              >
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 shrink-0" aria-hidden="true">
                  <path d="M12.416 3.376a.75.75 0 01.208 1.04l-5 7.5a.75.75 0 01-1.154.114l-3-3a.75.75 0 011.06-1.06l2.353 2.353 4.493-6.74a.75.75 0 011.04-.207z" />
                </svg>
                <span className="hidden sm:inline" aria-hidden="true">Select</span>
                <span className="font-mono-code max-w-[100px] truncate" aria-hidden="true">{currentDirName}</span>
              </button>
            </div>

            {/* Subdirectories list */}
            <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto" aria-label="Subdirectories">
              {browseLoading ? (
                /* Skeleton loading */
                <div className="px-4 py-2 space-y-1" aria-busy="true" aria-label="Loading directories">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <div key={i} className="flex items-center gap-2 py-1.5">
                      <div
                        className="w-3 h-3 rounded-sm bg-cc-hover shrink-0"
                        style={{
                          background: "linear-gradient(90deg, var(--color-cc-hover) 25%, var(--color-cc-active) 50%, var(--color-cc-hover) 75%)",
                          backgroundSize: "200% 100%",
                          animation: "shimmer 1.5s ease-in-out infinite",
                        }}
                      />
                      <div
                        className="h-3 rounded-sm flex-1"
                        style={{
                          maxWidth: `${50 + (i * 17) % 40}%`,
                          background: "linear-gradient(90deg, var(--color-cc-hover) 25%, var(--color-cc-active) 50%, var(--color-cc-hover) 75%)",
                          backgroundSize: "200% 100%",
                          animation: `shimmer 1.5s ease-in-out ${i * 0.1}s infinite`,
                        }}
                      />
                    </div>
                  ))}
                </div>
              ) : browseError ? (
                /* Error state */
                <div className="px-4 py-8 flex flex-col items-center gap-2 text-center">
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-5 h-5 text-cc-error/70">
                    <path d="M8.982 1.566a1.13 1.13 0 00-1.96 0L.165 13.233c-.457.778.091 1.767.98 1.767h13.713c.889 0 1.438-.99.98-1.767L8.982 1.566zM8 5c.535 0 .954.462.9.995l-.35 3.507a.552.552 0 01-1.1 0L7.1 5.995A.905.905 0 018 5zm.002 6a1 1 0 110 2 1 1 0 010-2z" />
                  </svg>
                  <p className="text-xs text-cc-muted">{browseError}</p>
                  <button
                    type="button"
                    onClick={() => loadDirs(browsePath || undefined)}
                    className="mt-1 text-xs text-cc-primary hover:text-cc-primary-hover transition-colors cursor-pointer font-medium"
                  >
                    Retry
                  </button>
                </div>
              ) : filteredDirs.length === 0 ? (
                <div className="px-4 py-8 text-center">
                  <p className="text-xs text-cc-muted">
                    {filter ? "No matching directories" : "No subdirectories"}
                  </p>
                  {filter && (
                    <button
                      type="button"
                      onClick={() => setFilter("")}
                      className="mt-1 text-xs text-cc-primary hover:text-cc-primary-hover transition-colors cursor-pointer font-medium"
                    >
                      Clear filter
                    </button>
                  )}
                </div>
              ) : (
                <ul className="list-none m-0 p-0">
                  {filteredDirs.map((d, i) => (
                    <li
                      key={d.path}
                      className={`flex items-center transition-colors ${
                        focusIndex === i ? "bg-cc-hover" : "hover:bg-cc-hover"
                      }`}
                    >
                      <button
                        type="button"
                        ref={(el) => { if (el) itemRefs.current.set(i, el); else itemRefs.current.delete(i); }}
                        onClick={() => loadDirs(d.path)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            selectDir(d.path);
                          }
                        }}
                        className="flex-1 min-w-0 px-4 py-2 sm:py-1.5 text-xs text-left cursor-pointer font-mono-code flex items-center gap-2 text-cc-fg focus:outline-none"
                        title={d.path}
                        aria-label={`Navigate into ${d.name}`}
                      >
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 opacity-40 shrink-0">
                          <path d="M1 3.5A1.5 1.5 0 012.5 2h3.379a1.5 1.5 0 011.06.44l.622.621a.5.5 0 00.353.146H13.5A1.5 1.5 0 0115 4.707V12.5a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12.5v-9z" />
                        </svg>
                        <span className="truncate">{d.name}</span>
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 opacity-25 shrink-0 ml-auto">
                          <path d="M6 4l4 4-4 4" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        onClick={() => selectDir(d.path)}
                        className="shrink-0 w-8 h-8 sm:w-6 sm:h-6 mr-2 flex items-center justify-center rounded-md text-cc-muted hover:text-cc-primary hover:bg-cc-primary/10 transition-colors cursor-pointer"
                        aria-label={`Select ${d.name}`}
                      >
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                          <path d="M12.416 3.376a.75.75 0 01.208 1.04l-5 7.5a.75.75 0 01-1.154.114l-3-3a.75.75 0 011.06-1.06l2.353 2.353 4.493-6.74a.75.75 0 011.04-.207z" />
                        </svg>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Keyboard hint bar */}
            <div className="px-4 py-1.5 border-t border-cc-border shrink-0 flex items-center gap-3 text-[10px] text-cc-muted select-none">
              <span><kbd className="px-1 py-0.5 rounded bg-cc-hover text-cc-muted font-mono-code text-[9px]">&uarr;&darr;</kbd> navigate</span>
              <span><kbd className="px-1 py-0.5 rounded bg-cc-hover text-cc-muted font-mono-code text-[9px]">&crarr;</kbd> select</span>
              <span><kbd className="px-1 py-0.5 rounded bg-cc-hover text-cc-muted font-mono-code text-[9px]">&lArr;</kbd> parent</span>
              <span className="ml-auto"><kbd className="px-1 py-0.5 rounded bg-cc-hover text-cc-muted font-mono-code text-[9px]">esc</kbd> close</span>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
