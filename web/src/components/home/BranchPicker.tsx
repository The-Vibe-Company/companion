import { useState, useEffect, useRef } from "react";
import { api, type GitRepoInfo, type GitBranchInfo } from "../../api.js";

interface BranchPickerProps {
  cwd: string;
  gitRepoInfo: GitRepoInfo | null;
  selectedBranch: string;
  isNewBranch: boolean;
  useWorktree: boolean;
  onBranchChange: (branch: string, isNew: boolean) => void;
  onWorktreeChange: (useWorktree: boolean) => void;
  /** Expose branches + pull check to parent for session creation */
  onBranchesLoaded: (branches: GitBranchInfo[]) => void;
}

export function BranchPicker({
  cwd,
  gitRepoInfo,
  selectedBranch,
  isNewBranch,
  useWorktree,
  onBranchChange,
  onWorktreeChange,
  onBranchesLoaded,
}: BranchPickerProps) {
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [showBranchDropdown, setShowBranchDropdown] = useState(false);
  const [branchFilter, setBranchFilter] = useState("");

  const branchDropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (branchDropdownRef.current && !branchDropdownRef.current.contains(e.target as Node)) {
        setShowBranchDropdown(false);
      }
    }
    document.addEventListener("pointerdown", handleClick);
    return () => document.removeEventListener("pointerdown", handleClick);
  }, []);

  // Fetch branches when git repo changes
  useEffect(() => {
    if (gitRepoInfo) {
      api.listBranches(gitRepoInfo.repoRoot).then((b) => {
        setBranches(b);
        onBranchesLoaded(b);
      }).catch(() => {
        setBranches([]);
        onBranchesLoaded([]);
      });
    } else {
      setBranches([]);
      onBranchesLoaded([]);
    }
  }, [gitRepoInfo]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!gitRepoInfo) return null;

  return (
    <>
      {/* Branch picker */}
      <div className="relative" ref={branchDropdownRef}>
        <button
          aria-expanded={showBranchDropdown}
          onClick={() => {
            if (!showBranchDropdown && gitRepoInfo) {
              api.gitFetch(gitRepoInfo.repoRoot)
                .catch(() => {})
                .finally(() => {
                  api.listBranches(gitRepoInfo.repoRoot).then((b) => {
                    setBranches(b);
                    onBranchesLoaded(b);
                  }).catch(() => {
                    setBranches([]);
                    onBranchesLoaded([]);
                  });
                });
            }
            setShowBranchDropdown(!showBranchDropdown);
            setBranchFilter("");
          }}
          className="flex items-center gap-1.5 px-2 py-1 text-xs rounded-md transition-colors cursor-pointer text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
        >
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 opacity-60">
            <path d="M5 3.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm0 2.122a2.25 2.25 0 10-1.5 0v.378A2.5 2.5 0 007.5 8h1a1 1 0 010 2h-1A2.5 2.5 0 005 12.5v.128a2.25 2.25 0 101.5 0V12.5a1 1 0 011-1h1a2.5 2.5 0 000-5h-1a1 1 0 01-1-1V5.372zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5z" />
          </svg>
          <span className="max-w-[100px] sm:max-w-[160px] truncate font-mono-code">
            {selectedBranch || gitRepoInfo.currentBranch}
          </span>
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 opacity-50">
            <path d="M4 6l4 4 4-4" />
          </svg>
        </button>
        {showBranchDropdown && (
          <div className="absolute left-0 bottom-full mb-1 w-72 max-w-[calc(100%-2rem)] bg-cc-card border border-cc-border rounded-[10px] shadow-lg z-10 overflow-hidden">
            {/* Search/filter input */}
            <div className="px-2 py-2 border-b border-cc-border">
              <input
                type="text"
                value={branchFilter}
                onChange={(e) => setBranchFilter(e.target.value)}
                placeholder="Filter or create branch..."
                className="w-full px-2 py-1 text-base sm:text-xs bg-cc-input-bg border border-cc-border rounded-md text-cc-fg font-mono-code placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/50"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setShowBranchDropdown(false);
                  }
                }}
              />
            </div>
            {/* Branch list */}
            <div className="max-h-[240px] overflow-y-auto py-1">
              {(() => {
                const filter = branchFilter.toLowerCase().trim();
                const localBranches = branches.filter((b) => !b.isRemote && (!filter || b.name.toLowerCase().includes(filter)));
                const remoteBranches = branches.filter((b) => b.isRemote && (!filter || b.name.toLowerCase().includes(filter)));
                const exactMatch = branches.some((b) => b.name.toLowerCase() === filter);
                const hasResults = localBranches.length > 0 || remoteBranches.length > 0;

                return (
                  <>
                    {/* Local branches */}
                    {localBranches.length > 0 && (
                      <>
                        <div className="px-3 py-1 text-[10px] text-cc-muted uppercase tracking-wider">Local</div>
                        {localBranches.map((b) => (
                          <button
                            key={b.name}
                            onClick={() => {
                              onBranchChange(b.name, false);
                              setShowBranchDropdown(false);
                            }}
                            className={`w-full px-3 py-1.5 text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer flex items-center gap-2 ${
                              b.name === selectedBranch ? "text-cc-primary font-medium" : "text-cc-fg"
                            }`}
                          >
                            <span className="truncate font-mono-code">{b.name}</span>
                            <span className="ml-auto flex items-center gap-1.5 shrink-0">
                              {b.ahead > 0 && (
                                <span className="text-[9px] text-green-500">{b.ahead}&#8593;</span>
                              )}
                              {b.behind > 0 && (
                                <span className="text-[9px] text-amber-500">{b.behind}&#8595;</span>
                              )}
                              {b.worktreePath && (
                                <span className="text-[9px] px-1 py-0.5 rounded bg-blue-500/15 text-blue-600 dark:text-blue-400">wt</span>
                              )}
                              {b.isCurrent && (
                                <span className="text-[9px] px-1 py-0.5 rounded bg-green-500/15 text-green-600 dark:text-green-400">current</span>
                              )}
                            </span>
                          </button>
                        ))}
                      </>
                    )}
                    {/* Remote branches */}
                    {remoteBranches.length > 0 && (
                      <>
                        <div className="px-3 py-1 text-[10px] text-cc-muted uppercase tracking-wider mt-1">Remote</div>
                        {remoteBranches.map((b) => (
                          <button
                            key={`remote-${b.name}`}
                            onClick={() => {
                              onBranchChange(b.name, false);
                              setShowBranchDropdown(false);
                            }}
                            className={`w-full px-3 py-1.5 text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer flex items-center gap-2 ${
                              b.name === selectedBranch ? "text-cc-primary font-medium" : "text-cc-fg"
                            }`}
                          >
                            <span className="truncate font-mono-code">{b.name}</span>
                            <span className="text-[9px] px-1 py-0.5 rounded bg-cc-hover text-cc-muted ml-auto shrink-0">remote</span>
                          </button>
                        ))}
                      </>
                    )}
                    {/* No results */}
                    {!hasResults && filter && (
                      <div className="px-3 py-2 text-xs text-cc-muted text-center">No matching branches</div>
                    )}
                    {/* Create new branch option */}
                    {filter && !exactMatch && (
                      <div className="border-t border-cc-border mt-1 pt-1">
                        <button
                          onClick={() => {
                            onBranchChange(branchFilter.trim(), true);
                            setShowBranchDropdown(false);
                          }}
                          className="w-full px-3 py-1.5 text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer flex items-center gap-2 text-cc-primary"
                        >
                          <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 shrink-0">
                            <path d="M8 2a.75.75 0 01.75.75v4.5h4.5a.75.75 0 010 1.5h-4.5v4.5a.75.75 0 01-1.5 0v-4.5h-4.5a.75.75 0 010-1.5h4.5v-4.5A.75.75 0 018 2z" />
                          </svg>
                          <span>Create <span className="font-mono-code font-medium">{branchFilter.trim()}</span></span>
                        </button>
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
          </div>
        )}
      </div>

      {/* Worktree toggle */}
      <button
        onClick={() => onWorktreeChange(!useWorktree)}
        className={`flex items-center gap-1.5 px-2 py-1 text-xs rounded-md transition-colors cursor-pointer ${
          useWorktree
            ? "bg-cc-primary/15 text-cc-primary font-medium"
            : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
        }`}
        title="Create an isolated worktree for this session"
      >
        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 opacity-70">
          <path d="M5 3.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm0 2.122a2.25 2.25 0 10-1.5 0v5.256a2.25 2.25 0 101.5 0V5.372zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5zm7.5-9.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122V7A2.5 2.5 0 0010 9.5H6a1 1 0 000 2h4a2.5 2.5 0 012.5 2.5v.628a2.25 2.25 0 11-1.5 0V14a1 1 0 00-1-1H6a2.5 2.5 0 01-2.5-2.5V10a2.5 2.5 0 012.5-2.5h4a1 1 0 001-1V5.372a2.25 2.25 0 01-1.5-2.122z" />
        </svg>
        <span>Worktree</span>
      </button>
    </>
  );
}
