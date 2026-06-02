import { useState, useEffect, useRef, useCallback } from "react";
import { api, type LinearIssue, type LinearProject, type LinearProjectMapping, type GitRepoInfo, type LinearConnectionSummary } from "../../api.js";
import { resolveLinearBranch } from "../../utils/linear-branch.js";
import { LinearLogo } from "../LinearLogo.js";
import { CreateIssueModal } from "./CreateIssueModal.js";

interface LinearSectionProps {
  cwd: string;
  gitRepoInfo: GitRepoInfo | null;
  linearConfigured: boolean;
  selectedLinearIssue: LinearIssue | null;
  onIssueSelect: (issue: LinearIssue | null) => void;
  /** Called when a Linear issue selection sets a new branch (for session creation) */
  onBranchFromIssue: (branch: string, isNew: boolean) => void;
  /** Called when a Linear connection is selected (or auto-selected) */
  onConnectionSelect: (connectionId: string | null) => void;
}

export function LinearSection({
  cwd,
  gitRepoInfo,
  linearConfigured,
  selectedLinearIssue,
  onIssueSelect,
  onBranchFromIssue,
  onConnectionSelect,
}: LinearSectionProps) {
  // Linear connection selector state
  const [connections, setConnections] = useState<LinearConnectionSummary[]>([]);
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
  const [connectionsLoaded, setConnectionsLoaded] = useState(false);

  // Linear issue search state
  const [linearQuery, setLinearQuery] = useState("");
  const [linearIssues, setLinearIssues] = useState<LinearIssue[]>([]);
  const [showLinearDropdown, setShowLinearDropdown] = useState(false);
  const [linearSearching, setLinearSearching] = useState(false);
  const [linearSearchError, setLinearSearchError] = useState("");
  const [showLinearStartWarning, setShowLinearStartWarning] = useState(false);

  // Linear project mapping state
  const [linearMapping, setLinearMapping] = useState<LinearProjectMapping | null>(null);
  const [recentIssues, setRecentIssues] = useState<LinearIssue[]>([]);
  const [recentIssuesLoading, setRecentIssuesLoading] = useState(false);
  const [recentIssuesError, setRecentIssuesError] = useState("");
  const [showAttachProjectDropdown, setShowAttachProjectDropdown] = useState(false);
  const [availableProjects, setAvailableProjects] = useState<LinearProject[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectSearchQuery, setProjectSearchQuery] = useState("");
  const [searchAllProjects, setSearchAllProjects] = useState(false);
  const [globalSearchResults, setGlobalSearchResults] = useState<LinearIssue[]>([]);
  const [globalSearching, setGlobalSearching] = useState(false);
  const [showCreateIssueModal, setShowCreateIssueModal] = useState(false);

  const linearDropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdowns on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (linearDropdownRef.current && !linearDropdownRef.current.contains(e.target as Node)) {
        setShowLinearDropdown(false);
        setShowAttachProjectDropdown(false);
      }
    }
    document.addEventListener("pointerdown", handleClick);
    return () => document.removeEventListener("pointerdown", handleClick);
  }, []);

  // Fetch Linear connections on mount (when configured)
  useEffect(() => {
    if (!linearConfigured) {
      setConnections([]);
      setSelectedConnectionId(null);
      setConnectionsLoaded(false);
      onConnectionSelect(null);
      return;
    }

    let active = true;
    api.listLinearConnections()
      .then(({ connections: conns }) => {
        if (!active) return;
        setConnections(conns);
        setConnectionsLoaded(true);
        if (conns.length > 0) {
          // Auto-select first connection
          setSelectedConnectionId(conns[0].id);
          onConnectionSelect(conns[0].id);
        } else {
          setSelectedConnectionId(null);
          onConnectionSelect(null);
        }
      })
      .catch(() => {
        if (!active) return;
        setConnectionsLoaded(true);
      });

    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linearConfigured]);

  // Handle connection change: clear state and re-fetch
  const handleConnectionChange = useCallback((connectionId: string) => {
    setSelectedConnectionId(connectionId);
    onConnectionSelect(connectionId);
    // Clear selected issue since it belongs to a different workspace
    onIssueSelect(null);
    // Clear current search results
    setLinearIssues([]);
    setLinearQuery("");
    setLinearSearchError("");
    setGlobalSearchResults([]);
    setProjectSearchQuery("");
    // Clear available projects so they're re-fetched for the new connection
    setAvailableProjects([]);
    // Re-fetch project issues if a mapping exists
    if (linearMapping) {
      setRecentIssuesLoading(true);
      setRecentIssuesError("");
      api.getLinearProjectIssues(linearMapping.projectId, 10, connectionId)
        .then(({ issues }) => {
          setRecentIssues(issues);
        })
        .catch((e: unknown) => {
          setRecentIssuesError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          setRecentIssuesLoading(false);
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linearMapping, onConnectionSelect, onIssueSelect]);

  // When gitRepoInfo changes, check for Linear project mapping and fetch recent issues
  useEffect(() => {
    if (!gitRepoInfo || !linearConfigured) {
      setLinearMapping(null);
      setRecentIssues([]);
      return;
    }

    let active = true;
    setRecentIssuesLoading(true);
    setRecentIssuesError("");

    (async () => {
      try {
        const { mapping } = await api.getLinearProjectMapping(gitRepoInfo.repoRoot);
        if (!active) return;
        setLinearMapping(mapping);
        if (mapping) {
          const { issues } = await api.getLinearProjectIssues(mapping.projectId, 10, selectedConnectionId ?? undefined);
          if (!active) return;
          setRecentIssues(issues);
        } else {
          setRecentIssues([]);
        }
      } catch (e: unknown) {
        if (!active) return;
        setRecentIssuesError(e instanceof Error ? e.message : String(e));
      } finally {
        if (active) setRecentIssuesLoading(false);
      }
    })();

    return () => { active = false; };
  }, [gitRepoInfo, linearConfigured, selectedConnectionId]);

  // Linear issue search effect
  useEffect(() => {
    if (!linearConfigured) return;
    const query = linearQuery.trim();
    if (query.length < 2) {
      setLinearIssues([]);
      setLinearSearchError("");
      setLinearSearching(false);
      return;
    }

    let active = true;
    setLinearSearching(true);
    setLinearSearchError("");
    const timer = setTimeout(() => {
      api.searchLinearIssues(query, 8, selectedConnectionId ?? undefined).then((res) => {
        if (!active) return;
        setLinearIssues(res.issues);
      }).catch((e: unknown) => {
        if (!active) return;
        setLinearIssues([]);
        setLinearSearchError(e instanceof Error ? e.message : String(e));
      }).finally(() => {
        if (!active) return;
        setLinearSearching(false);
      });
    }, 400);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [linearConfigured, linearQuery, selectedConnectionId]);

  // Global search effect — triggers when "Search all projects" is enabled and projectSearchQuery has 2+ chars
  useEffect(() => {
    if (!linearConfigured || !searchAllProjects) {
      setGlobalSearchResults([]);
      setGlobalSearching(false);
      return;
    }
    const query = projectSearchQuery.trim();
    if (query.length < 2) {
      setGlobalSearchResults([]);
      setGlobalSearching(false);
      return;
    }

    let active = true;
    setGlobalSearching(true);
    const timer = setTimeout(() => {
      api.searchLinearIssues(query, 10, selectedConnectionId ?? undefined).then((res) => {
        if (!active) return;
        setGlobalSearchResults(res.issues);
      }).catch(() => {
        if (!active) return;
        setGlobalSearchResults([]);
      }).finally(() => {
        if (!active) return;
        setGlobalSearching(false);
      });
    }, 400);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [linearConfigured, searchAllProjects, projectSearchQuery, selectedConnectionId]);

  function handleSelectLinearIssue(issue: LinearIssue, closeDropdown = false) {
    onIssueSelect(issue);
    setLinearQuery(`${issue.identifier} - ${issue.title}`);
    const branch = resolveLinearBranch(issue);
    onBranchFromIssue(branch, true);
    if (closeDropdown) {
      setShowLinearDropdown(false);
    }
  }

  function handleClearIssue() {
    onIssueSelect(null);
    setLinearQuery("");
    setLinearIssues([]);
    setLinearSearchError("");
  }

  async function handleAttachProject(project: LinearProject) {
    if (!gitRepoInfo) return;
    try {
      const { mapping } = await api.upsertLinearProjectMapping({
        repoRoot: gitRepoInfo.repoRoot,
        projectId: project.id,
        projectName: project.name,
      });
      setLinearMapping(mapping);
      setShowAttachProjectDropdown(false);
      setRecentIssuesLoading(true);
      setRecentIssuesError("");
      const { issues } = await api.getLinearProjectIssues(project.id, 10, selectedConnectionId ?? undefined);
      setRecentIssues(issues);
    } catch (e: unknown) {
      setRecentIssuesError(e instanceof Error ? e.message : String(e));
    } finally {
      setRecentIssuesLoading(false);
    }
  }

  async function handleDetachProject() {
    if (!gitRepoInfo) return;
    try {
      await api.removeLinearProjectMapping(gitRepoInfo.repoRoot);
    } catch {
      // ignore
    }
    setLinearMapping(null);
    setRecentIssues([]);
    onIssueSelect(null);
    setLinearQuery("");
  }

  function handleOpenAttachDropdown() {
    if (!linearConfigured) {
      window.location.hash = "#/integrations/linear";
      return;
    }
    setShowAttachProjectDropdown(true);
    if (availableProjects.length === 0) {
      setProjectsLoading(true);
      api.listLinearProjects(selectedConnectionId ?? undefined)
        .then(({ projects }) => setAvailableProjects(projects))
        .catch(() => {})
        .finally(() => setProjectsLoading(false));
    }
  }

  function handleIssueCreated(issue: LinearIssue) {
    setShowCreateIssueModal(false);
    handleSelectLinearIssue(issue);
    // Refresh the recent issues list if a project is attached
    if (linearMapping) {
      setRecentIssuesLoading(true);
      api.getLinearProjectIssues(linearMapping.projectId, 10, selectedConnectionId ?? undefined)
        .then(({ issues }) => setRecentIssues(issues))
        .catch(() => {})
        .finally(() => setRecentIssuesLoading(false));
    }
  }

  if (!linearConfigured) return null;

  return (
    <aside className="space-y-2 mt-0.5" ref={linearDropdownRef}>
      <div
        className="relative rounded-[12px] border border-cc-border bg-cc-card/90 px-2.5 py-2"
        title={`Repo: ${cwd}`}
      >
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[11px] uppercase tracking-wide text-cc-muted">Context</span>

          {/* Connection picker — only shown when multiple connections exist */}
          {connectionsLoaded && connections.length > 1 && (
            <select
              value={selectedConnectionId ?? ""}
              onChange={(e) => handleConnectionChange(e.target.value)}
              className="px-1.5 py-1 rounded-md text-[11px] bg-cc-input-bg border border-cc-border text-cc-fg focus:outline-none focus:border-cc-primary/60 cursor-pointer max-w-[140px] truncate"
              title="Select Linear workspace"
            >
              {connections.map((conn) => (
                <option key={conn.id} value={conn.id}>
                  {conn.workspaceName || conn.name}
                </option>
              ))}
            </select>
          )}

          {/* When a project is attached, show project badge */}
          {linearMapping ? (
            <>
              <div className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border border-cc-primary/35 bg-cc-primary/10 text-cc-primary">
                <LinearLogo className="w-3.5 h-3.5" />
                <span>{linearMapping.projectName}</span>
                <button
                  type="button"
                  onClick={handleDetachProject}
                  className="ml-0.5 hover:text-cc-error transition-colors cursor-pointer"
                  title="Detach Linear project"
                >
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                    <path d="M4.646 4.646a.5.5 0 01.708 0L8 7.293l2.646-2.647a.5.5 0 01.708.708L8.707 8l2.647 2.646a.5.5 0 01-.708.708L8 8.707l-2.646 2.647a.5.5 0 01-.708-.708L7.293 8 4.646 5.354a.5.5 0 010-.708z" />
                  </svg>
                </button>
              </div>
              <button
                type="button"
                onClick={() => setShowCreateIssueModal(true)}
                className="inline-flex items-center gap-1 px-2 py-1.5 rounded-lg text-[11px] border border-dashed border-cc-border text-cc-muted hover:text-cc-fg hover:border-cc-primary/40 transition-colors cursor-pointer"
              >
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                  <path d="M8 2a.5.5 0 01.5.5v5h5a.5.5 0 010 1h-5v5a.5.5 0 01-1 0v-5h-5a.5.5 0 010-1h5v-5A.5.5 0 018 2z" />
                </svg>
                <span>Create issue</span>
              </button>
            </>
          ) : (
            <>
              {/* Linear button — search or configure */}
              <button
                type="button"
                aria-expanded={showLinearDropdown}
                onClick={() => {
                  if (!linearConfigured) {
                    window.location.hash = "#/integrations/linear";
                    return;
                  }
                  setShowLinearDropdown(!showLinearDropdown);
                }}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border transition-colors cursor-pointer ${
                  selectedLinearIssue
                    ? "border-cc-primary/35 bg-cc-primary/10 text-cc-primary"
                    : linearConfigured
                      ? "border-cc-border bg-cc-hover/70 text-cc-fg hover:bg-cc-hover"
                      : "border-amber-500/25 bg-amber-500/10 text-amber-600 dark:text-amber-300"
                }`}
              >
                <LinearLogo className="w-3.5 h-3.5" />
                <span>Linear</span>
              </button>

              {/* Attach project button (only when Linear is configured and in a git repo) */}
              {linearConfigured && gitRepoInfo && (
                <button
                  type="button"
                  onClick={handleOpenAttachDropdown}
                  className="inline-flex items-center gap-1 px-2 py-1.5 rounded-lg text-[11px] border border-dashed border-cc-border text-cc-muted hover:text-cc-fg hover:border-cc-primary/40 transition-colors cursor-pointer"
                >
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                    <path d="M8 2a.5.5 0 01.5.5v5h5a.5.5 0 010 1h-5v5a.5.5 0 01-1 0v-5h-5a.5.5 0 010-1h5v-5A.5.5 0 018 2z" />
                  </svg>
                  <span>Attach project</span>
                </button>
              )}

              {/* Create issue button */}
              {linearConfigured && (
                <button
                  type="button"
                  onClick={() => setShowCreateIssueModal(true)}
                  className="inline-flex items-center gap-1 px-2 py-1.5 rounded-lg text-[11px] border border-dashed border-cc-border text-cc-muted hover:text-cc-fg hover:border-cc-primary/40 transition-colors cursor-pointer"
                >
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                    <path d="M8 2a.5.5 0 01.5.5v5h5a.5.5 0 010 1h-5v5a.5.5 0 01-1 0v-5h-5a.5.5 0 010-1h5v-5A.5.5 0 018 2z" />
                  </svg>
                  <span>Create issue</span>
                </button>
              )}

              {!linearConfigured && (
                <span className="text-[11px] text-amber-600 dark:text-amber-300">
                  Configure Linear to attach an issue.
                </span>
              )}
            </>
          )}
        </div>

        {/* Issue browser with inline search (when project is attached) */}
        {linearMapping && (() => {
          const query = projectSearchQuery.trim().toLowerCase();
          const filteredIssues = !searchAllProjects && query
            ? recentIssues.filter((i) =>
                i.identifier.toLowerCase().includes(query) ||
                i.title.toLowerCase().includes(query))
            : searchAllProjects ? [] : recentIssues;
          const displayIssues = searchAllProjects ? globalSearchResults : filteredIssues;

          return (
            <div className="mt-2">
              {/* Selected issue badge */}
              {selectedLinearIssue && (
                <div className="flex items-center gap-2 mb-2">
                  <div className="flex-1 min-w-0 text-xs text-cc-primary truncate">
                    <span className="font-mono-code">{selectedLinearIssue.identifier}</span> - {selectedLinearIssue.title}
                  </div>
                  <button
                    type="button"
                    onClick={handleClearIssue}
                    className="text-cc-muted hover:text-cc-fg transition-colors cursor-pointer shrink-0"
                    title="Remove issue"
                  >
                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                      <path d="M4.646 4.646a.5.5 0 01.708 0L8 7.293l2.646-2.647a.5.5 0 01.708.708L8.707 8l2.647 2.646a.5.5 0 01-.708.708L8 8.707l-2.646 2.647a.5.5 0 01-.708-.708L7.293 8 4.646 5.354a.5.5 0 010-.708z" />
                    </svg>
                  </button>
                </div>
              )}

              {/* Inline search input */}
              <input
                type="text"
                value={projectSearchQuery}
                onChange={(e) => setProjectSearchQuery(e.target.value)}
                placeholder={searchAllProjects ? "Search all projects..." : "Filter issues..."}
                className="w-full px-2 py-1.5 text-xs bg-cc-input-bg border border-cc-border rounded-md text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/60"
              />

              {/* Issue list */}
              {recentIssuesLoading ? (
                <div className="px-1 py-1.5 text-xs text-cc-muted">Loading recent issues...</div>
              ) : recentIssuesError ? (
                <div className="px-1 py-1.5 text-xs text-cc-error">{recentIssuesError}</div>
              ) : globalSearching ? (
                <div className="px-1 py-1.5 text-xs text-cc-muted">Searching...</div>
              ) : searchAllProjects && query.length < 2 ? (
                <div className="px-1 py-1.5 text-xs text-cc-muted">Type at least 2 characters to search all projects...</div>
              ) : displayIssues.length === 0 ? (
                <div className="px-1 py-1.5 text-xs text-cc-muted">
                  {query ? "No matching issues" : "No active issues found"}
                </div>
              ) : (
                <div className="max-h-56 overflow-y-auto -mx-0.5 mt-1">
                  {displayIssues.map((issue) => (
                    <button
                      key={issue.id}
                      type="button"
                      onClick={() => handleSelectLinearIssue(issue)}
                      className={`w-full px-2 py-1.5 text-left rounded-md transition-colors cursor-pointer ${
                        selectedLinearIssue?.id === issue.id
                          ? "bg-cc-primary/10 border border-cc-primary/30"
                          : "hover:bg-cc-hover"
                      }`}
                    >
                      <div className="text-xs text-cc-fg truncate">
                        <span className="font-mono-code">{issue.identifier}</span> {issue.title}
                      </div>
                      <div className="text-[10px] text-cc-muted truncate">
                        {[issue.stateName, issue.priorityLabel].filter(Boolean).join(" - ")}
                      </div>
                    </button>
                  ))}
                </div>
              )}

              {/* Search all projects toggle */}
              <label className="mt-1.5 flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={searchAllProjects}
                  onChange={(e) => {
                    setSearchAllProjects(e.target.checked);
                    if (!e.target.checked) {
                      setGlobalSearchResults([]);
                    }
                  }}
                  className="rounded border-cc-border text-cc-primary focus:ring-cc-primary/30 cursor-pointer"
                />
                <span className="text-[11px] text-cc-muted">Search all projects</span>
              </label>
            </div>
          );
        })()}

        {/* Attach project dropdown */}
        {showAttachProjectDropdown && (
          <div className="absolute left-2.5 right-2.5 top-[44px] bg-cc-card border border-cc-border rounded-[10px] shadow-lg z-20 overflow-hidden">
            <div className="p-2 border-b border-cc-border">
              <div className="flex items-center justify-between">
                <span className="text-xs text-cc-fg font-medium">Attach a Linear project to this repo</span>
                <button
                  type="button"
                  onClick={() => setShowAttachProjectDropdown(false)}
                  className="px-2 py-1 rounded-md text-xs bg-cc-hover text-cc-muted hover:text-cc-fg transition-colors cursor-pointer"
                >
                  Close
                </button>
              </div>
            </div>
            {projectsLoading ? (
              <div className="px-3 py-2 text-xs text-cc-muted">Loading projects...</div>
            ) : availableProjects.length === 0 ? (
              <div className="px-3 py-2 text-xs text-cc-muted">No projects found</div>
            ) : (
              <div className="max-h-48 overflow-y-auto">
                {availableProjects.map((project) => (
                  <button
                    key={project.id}
                    type="button"
                    onClick={() => handleAttachProject(project)}
                    className="w-full px-3 py-2 text-left hover:bg-cc-hover transition-colors cursor-pointer"
                  >
                    <div className="text-xs text-cc-fg">{project.name}</div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Search dropdown (used as fallback when mapping exists, or primary when no mapping) */}
        {showLinearDropdown && linearConfigured && (
          <div className="absolute left-2.5 right-2.5 top-[44px] bg-cc-card border border-cc-border rounded-[10px] shadow-lg z-20 overflow-hidden">
            <div className="p-2 border-b border-cc-border">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={linearQuery}
                  onChange={(e) => {
                    setLinearQuery(e.target.value);
                  }}
                  onFocus={() => setShowLinearDropdown(true)}
                  autoFocus
                  placeholder="ENG-123 or issue title"
                  className="w-full px-2.5 py-2 text-sm bg-cc-input-bg border border-cc-border rounded-md text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/60"
                />
                <button
                  type="button"
                  onClick={() => {
                    setShowLinearDropdown(false);
                  }}
                  className="px-2 py-2 rounded-md text-xs bg-cc-hover text-cc-muted hover:text-cc-fg transition-colors cursor-pointer"
                >
                  Close
                </button>
              </div>
              <div className="mt-1.5 flex items-center justify-between text-[11px] text-cc-muted">
                <span>Attach an issue to this draft</span>
                <button
                  type="button"
                  onClick={() => {
                    window.location.hash = "#/integrations/linear";
                  }}
                  className="hover:text-cc-fg underline underline-offset-2 cursor-pointer"
                >
                  Settings
                </button>
              </div>
            </div>

            {linearQuery.trim().length < 2 && (
              <div className="px-3 py-2 text-xs text-cc-muted">Type at least 2 characters…</div>
            )}
            {linearQuery.trim().length >= 2 && linearSearching && (
              <div className="px-3 py-2 text-xs text-cc-muted">Searching Linear...</div>
            )}
            {linearQuery.trim().length >= 2 && !linearSearching && linearSearchError && (
              <div className="px-3 py-2 text-xs text-cc-error">{linearSearchError}</div>
            )}
            {linearQuery.trim().length >= 2 && !linearSearching && !linearSearchError && linearIssues.length === 0 && (
              <div className="px-3 py-2 text-xs text-cc-muted">No matching issues</div>
            )}
            {linearQuery.trim().length >= 2 && !linearSearching && !linearSearchError && (
              <div className="max-h-56 overflow-y-auto">
                {linearIssues.map((issue) => (
                  <button
                    key={issue.id}
                    type="button"
                    onClick={() => handleSelectLinearIssue(issue, true)}
                    className="w-full px-3 py-2 text-left hover:bg-cc-hover transition-colors cursor-pointer"
                  >
                    <div className="text-xs text-cc-fg truncate">
                      <span className="font-mono-code">{issue.identifier}</span> - {issue.title}
                    </div>
                    <div className="text-[10px] text-cc-muted truncate">
                      {[issue.stateName, issue.teamName].filter(Boolean).join(" • ")}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <button
          type="button"
          onClick={() => {
            window.location.hash = "#/integrations/linear";
          }}
          className="absolute top-2 right-2 inline-flex h-7 w-7 items-center justify-center rounded-md text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
          title="Linear settings"
        >
          <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
            <path fillRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.53 1.53 0 01-2.29.95c-1.35-.8-2.92.77-2.12 2.12.54.9.07 2.04-.95 2.29-1.56.38-1.56 2.6 0 2.98 1.02.25 1.49 1.39.95 2.29-.8 1.35.77 2.92 2.12 2.12.9-.54 2.04-.07 2.29.95.38 1.56 2.6 1.56 2.98 0 .25-1.02 1.39-1.49 2.29-.95 1.35.8 2.92-.77 2.12-2.12-.54-.9-.07-2.04.95-2.29 1.56-.38 1.56-2.6 0-2.98-1.02-.25-1.49-1.39-.95-2.29.8-1.35-.77-2.92-2.12-2.12-.9.54-2.04.07-2.29-.95zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
          </svg>
        </button>
      </div>

      {showLinearStartWarning && (
        <div className="p-3 rounded-[10px] bg-amber-500/10 border border-amber-500/20">
          <p className="text-xs text-amber-700 dark:text-amber-300 leading-snug">
            Warning: Linear is not configured. Continue anyway?
          </p>
          <div className="flex gap-2 mt-2.5">
            <button
              type="button"
              onClick={() => {
                setShowLinearStartWarning(false);
                window.location.hash = "#/integrations/linear";
              }}
              className="px-2.5 py-1 text-[11px] font-medium rounded-md bg-cc-hover text-cc-fg hover:bg-cc-active transition-colors cursor-pointer"
            >
              Configurer Linear
            </button>
          </div>
        </div>
      )}

      {showCreateIssueModal && (
        <CreateIssueModal
          defaultProjectId={linearMapping?.projectId}
          connectionId={selectedConnectionId ?? undefined}
          onCreated={handleIssueCreated}
          onClose={() => setShowCreateIssueModal(false)}
        />
      )}
    </aside>
  );
}
