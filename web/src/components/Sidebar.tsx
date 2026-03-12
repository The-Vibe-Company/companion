import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useStore } from "../store.js";
import { api, type ArchiveInfo } from "../api.js";
import { ArchiveLinearModal, type LinearTransitionChoice } from "./ArchiveLinearModal.js";
import { connectSession, connectAllSessions, disconnectSession } from "../ws.js";
import { navigateToSession, navigateHome } from "../utils/routing.js";
import { ProjectGroup } from "./ProjectGroup.js";
import { SessionItem } from "./SessionItem.js";
import { groupSessionsByProject, type SessionItem as SessionItemType } from "../utils/project-grouping.js";
import { EXTERNAL_LINKS } from "./SidebarMenu.js";

export function Sidebar() {
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [confirmArchiveId, setConfirmArchiveId] = useState<string | null>(null);
  const [archiveModalSessionId, setArchiveModalSessionId] = useState<string | null>(null);
  const [archiveModalInfo, setArchiveModalInfo] = useState<ArchiveInfo | null>(null);
  const [archiveModalContainerized, setArchiveModalContainerized] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const editInputRef = useRef<HTMLInputElement>(null);
  const sessions = useStore((s) => s.sessions);
  const sdkSessions = useStore((s) => s.sdkSessions);
  const currentSessionId = useStore((s) => s.currentSessionId);
  const cliConnected = useStore((s) => s.cliConnected);
  const sessionStatus = useStore((s) => s.sessionStatus);
  const removeSession = useStore((s) => s.removeSession);
  const sessionNames = useStore((s) => s.sessionNames);
  const recentlyRenamed = useStore((s) => s.recentlyRenamed);
  const clearRecentlyRenamed = useStore((s) => s.clearRecentlyRenamed);
  const pendingPermissions = useStore((s) => s.pendingPermissions);
  const linkedLinearIssues = useStore((s) => s.linkedLinearIssues);
  const sidebarGroupByProject = useStore((s) => s.sidebarGroupByProject);
  const setSidebarGroupByProject = useStore((s) => s.setSidebarGroupByProject);
  const collapsedProjects = useStore((s) => s.collapsedProjects);
  const toggleProjectCollapse = useStore((s) => s.toggleProjectCollapse);

  // Poll for SDK sessions on mount
  useEffect(() => {
    let active = true;
    async function poll() {
      try {
        const list = await api.listSessions();
        if (active) {
          useStore.getState().setSdkSessions(list);
          // Connect all active sessions so we receive notifications for all of them
          connectAllSessions(list);
          // Hydrate session names from server (server is source of truth for auto-generated names)
          const store = useStore.getState();
          for (const s of list) {
            if (s.name && (!store.sessionNames.has(s.sessionId) || /^[A-Z][a-z]+ [A-Z][a-z]+$/.test(store.sessionNames.get(s.sessionId)!))) {
              const currentStoreName = store.sessionNames.get(s.sessionId);
              const hadRandomName = !!currentStoreName && /^[A-Z][a-z]+ [A-Z][a-z]+$/.test(currentStoreName);
              if (currentStoreName !== s.name) {
                store.setSessionName(s.sessionId, s.name);
                if (hadRandomName) {
                  store.markRecentlyRenamed(s.sessionId);
                }
              }
            }
          }
        }
      } catch {
        // server not ready
      }
    }
    poll();
    const interval = setInterval(poll, 5000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);


  function handleSelectSession(sessionId: string) {
    useStore.getState().closeTerminal();
    // Navigate to session hash — App.tsx hash effect handles setCurrentSession + connectSession
    navigateToSession(sessionId);
    // Close sidebar on mobile
    if (window.innerWidth < 768) {
      useStore.getState().setSidebarOpen(false);
    }
  }

  function handleNewSession() {
    useStore.getState().closeTerminal();
    navigateHome();
    useStore.getState().newSession();
    if (window.innerWidth < 768) {
      useStore.getState().setSidebarOpen(false);
    }
  }

  // Focus edit input when entering edit mode
  useEffect(() => {
    if (editingSessionId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingSessionId]);

  function confirmRename() {
    if (editingSessionId && editingName.trim()) {
      useStore.getState().setSessionName(editingSessionId, editingName.trim());
      api.renameSession(editingSessionId, editingName.trim()).catch(() => {});
    }
    setEditingSessionId(null);
    setEditingName("");
  }

  function cancelRename() {
    setEditingSessionId(null);
    setEditingName("");
  }

  function handleStartRename(id: string, currentName: string) {
    setEditingSessionId(id);
    setEditingName(currentName);
  }

  const handleDeleteSession = useCallback((e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    setConfirmDeleteId(sessionId);
  }, []);

  const doDelete = useCallback(async (sessionId: string) => {
    try {
      disconnectSession(sessionId);
      await api.deleteSession(sessionId);
    } catch {
      // best-effort
    }
    if (useStore.getState().currentSessionId === sessionId) {
      navigateHome();
    }
    removeSession(sessionId);
  }, [removeSession]);

  const confirmDelete = useCallback(() => {
    if (confirmDeleteId) {
      doDelete(confirmDeleteId);
      setConfirmDeleteId(null);
    }
  }, [confirmDeleteId, doDelete]);

  const cancelDelete = useCallback(() => {
    setConfirmDeleteId(null);
  }, []);

  const handleDeleteAllArchived = useCallback(() => {
    setConfirmDeleteAll(true);
  }, []);

  const confirmDeleteAllArchived = useCallback(async () => {
    setConfirmDeleteAll(false);
    // Get fresh list of archived session IDs
    const store = useStore.getState();
    const allIds = new Set<string>();
    for (const id of store.sessions.keys()) allIds.add(id);
    for (const s of store.sdkSessions) allIds.add(s.sessionId);
    const archivedIds = Array.from(allIds).filter((id) => {
      const sdkInfo = store.sdkSessions.find((s) => s.sessionId === id);
      return sdkInfo?.archived ?? false;
    });
    for (const id of archivedIds) {
      await doDelete(id);
    }
  }, [doDelete]);

  const cancelDeleteAll = useCallback(() => {
    setConfirmDeleteAll(false);
  }, []);

  const handleArchiveSession = useCallback(async (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    const sdkInfo = sdkSessions.find((s) => s.sessionId === sessionId);
    const bridgeState = sessions.get(sessionId);
    const isContainerized = bridgeState?.is_containerized || !!sdkInfo?.containerId || false;

    // Check if session has a linked non-done Linear issue
    const linkedIssue = linkedLinearIssues.get(sessionId);
    const stateType = (linkedIssue?.stateType || "").toLowerCase();
    const isIssueDone = stateType === "completed" || stateType === "canceled" || stateType === "cancelled";

    if (linkedIssue && !isIssueDone) {
      // Fetch archive info (backlog availability, configured transition state)
      try {
        const info = await api.getArchiveInfo(sessionId);
        if (info.issueNotDone) {
          setArchiveModalSessionId(sessionId);
          setArchiveModalInfo(info);
          setArchiveModalContainerized(isContainerized);
          return;
        }
      } catch {
        // Fall through to normal archive flow on error
      }
    }

    // No linked non-done issue — use existing container-only confirmation or direct archive
    if (isContainerized) {
      setConfirmArchiveId(sessionId);
      return;
    }
    doArchive(sessionId);
  }, [sdkSessions, sessions, linkedLinearIssues]);

  const doArchive = useCallback(async (sessionId: string, force?: boolean, linearTransition?: LinearTransitionChoice) => {
    try {
      disconnectSession(sessionId);
      const opts: { force?: boolean; linearTransition?: LinearTransitionChoice } = {};
      if (force) opts.force = true;
      if (linearTransition && linearTransition !== "none") opts.linearTransition = linearTransition;
      await api.archiveSession(sessionId, Object.keys(opts).length > 0 ? opts : undefined);
    } catch {
      // best-effort
    }
    if (useStore.getState().currentSessionId === sessionId) {
      navigateHome();
      useStore.getState().newSession();
    }
    try {
      const list = await api.listSessions();
      useStore.getState().setSdkSessions(list);
    } catch {
      // best-effort
    }
  }, []);

  const confirmArchive = useCallback(() => {
    if (confirmArchiveId) {
      doArchive(confirmArchiveId, true);
      setConfirmArchiveId(null);
    }
  }, [confirmArchiveId, doArchive]);

  const cancelArchive = useCallback(() => {
    setConfirmArchiveId(null);
  }, []);

  const handleArchiveModalConfirm = useCallback((choice: LinearTransitionChoice, force?: boolean) => {
    if (archiveModalSessionId) {
      doArchive(archiveModalSessionId, force, choice);
      setArchiveModalSessionId(null);
      setArchiveModalInfo(null);
    }
  }, [archiveModalSessionId, doArchive]);

  const handleArchiveModalCancel = useCallback(() => {
    setArchiveModalSessionId(null);
    setArchiveModalInfo(null);
  }, []);

  const handleUnarchiveSession = useCallback(async (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    try {
      await api.unarchiveSession(sessionId);
    } catch {
      // best-effort
    }
    try {
      const list = await api.listSessions();
      useStore.getState().setSdkSessions(list);
    } catch {
      // best-effort
    }
  }, []);

  // Combine sessions from WsBridge state + SDK sessions list
  const allSessionIds = new Set<string>();
  for (const id of sessions.keys()) allSessionIds.add(id);
  for (const s of sdkSessions) allSessionIds.add(s.sessionId);

  const allSessionList: SessionItemType[] = Array.from(allSessionIds).map((id) => {
    const bridgeState = sessions.get(id);
    const sdkInfo = sdkSessions.find((s) => s.sessionId === id);
    return {
      id,
      model: bridgeState?.model || sdkInfo?.model || "",
      cwd: bridgeState?.cwd || sdkInfo?.cwd || "",
      gitBranch: bridgeState?.git_branch || sdkInfo?.gitBranch || "",
      isContainerized: bridgeState?.is_containerized || !!sdkInfo?.containerId || false,
      gitAhead: bridgeState?.git_ahead || sdkInfo?.gitAhead || 0,
      gitBehind: bridgeState?.git_behind || sdkInfo?.gitBehind || 0,
      linesAdded: bridgeState?.total_lines_added || sdkInfo?.totalLinesAdded || 0,
      linesRemoved: bridgeState?.total_lines_removed || sdkInfo?.totalLinesRemoved || 0,
      isConnected: cliConnected.get(id) ?? false,
      status: sessionStatus.get(id) ?? null,
      sdkState: sdkInfo?.state ?? null,
      createdAt: sdkInfo?.createdAt ?? 0,
      archived: sdkInfo?.archived ?? false,
      backendType: bridgeState?.backend_type || sdkInfo?.backendType || "claude",
      repoRoot: bridgeState?.repo_root || "",
      permCount: pendingPermissions.get(id)?.size ?? 0,
      cronJobId: bridgeState?.cronJobId || sdkInfo?.cronJobId,
      cronJobName: bridgeState?.cronJobName || sdkInfo?.cronJobName,
      agentId: bridgeState?.agentId || sdkInfo?.agentId,
      agentName: bridgeState?.agentName || sdkInfo?.agentName,
    };
  }).sort((a, b) => b.createdAt - a.createdAt);

  const activeSessions = allSessionList.filter((s) => !s.archived && !s.cronJobId && !s.agentId);
  const cronSessions = allSessionList.filter((s) => !s.archived && !!s.cronJobId);
  const agentSessions = allSessionList.filter((s) => !s.archived && !!s.agentId);
  const archivedSessions = allSessionList.filter((s) => s.archived);
  // Note: logoSrc removed from sidebar header (simplified design)

  // Group active sessions by project
  const projectGroups = useMemo(
    () => groupSessionsByProject(activeSessions),
    [activeSessions],
  );

  // Shared props for SessionItem / ProjectGroup
  const sessionItemProps = {
    onSelect: handleSelectSession,
    onStartRename: handleStartRename,
    onArchive: handleArchiveSession,
    onUnarchive: handleUnarchiveSession,
    onDelete: handleDeleteSession,
    onClearRecentlyRenamed: clearRecentlyRenamed,
    editingSessionId,
    editingName,
    setEditingName,
    onConfirmRename: confirmRename,
    onCancelRename: cancelRename,
    editInputRef,
  };

  return (
    <aside className="w-full md:w-[240px] h-full flex flex-col bg-cc-sidebar">
      {/* Header: logo + brand */}
      <div className="px-3 pt-3 pb-2">
        <div className="flex items-center gap-2">
          <img src="/logo.svg" alt="" className="w-5 h-5" />
          <span className="text-[13px] font-semibold text-cc-fg">The Companion</span>
          {/* Close button — mobile only */}
          <button
            onClick={() => useStore.getState().setSidebarOpen(false)}
            aria-label="Close sidebar"
            className="md:hidden ml-auto w-8 h-8 rounded-lg flex items-center justify-center text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
              <path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z" />
            </svg>
          </button>
        </div>
      </div>

      {/* Nav items: New Session + Settings */}
      <div className="px-2 pb-1.5">
        <button
          onClick={handleNewSession}
          title="New Session"
          aria-label="New Session"
          className="hidden md:flex w-full h-7 rounded-md items-center gap-2 px-2 text-[13px] text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
            <path d="M8 3v10M3 8h10" />
          </svg>
          <span>New Session</span>
        </button>
        <button
          onClick={() => { window.location.hash = "#/settings"; }}
          title="Settings"
          aria-label="Settings"
          className="hidden md:flex w-full h-7 rounded-md items-center gap-2 px-2 text-[13px] text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
        >
          <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
            <path fillRule="evenodd" clipRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.53 1.53 0 01-2.29.95c-1.35-.8-2.92.77-2.12 2.12.54.9.07 2.04-.95 2.29-1.56.38-1.56 2.6 0 2.98 1.02.25 1.49 1.39.95 2.29-.8 1.35.77 2.92 2.12 2.12.9-.54 2.04-.07 2.29.95.38 1.56 2.6 1.56 2.98 0 .25-1.02 1.39-1.49 2.29-.95 1.35.8 2.92-.77 2.12-2.12-.54-.9-.07-2.04.95-2.29 1.56-.38 1.56-2.6 0-2.98-1.02-.25-1.49-1.39-.95-2.29.8-1.35-.77-2.92-2.12-2.12-.9.54-2.04.07-2.29-.95zM10 13a3 3 0 100-6 3 3 0 000 6z" />
          </svg>
          <span>Settings</span>
        </button>
      </div>

      {/* Container archive confirmation */}
      {confirmArchiveId && (
        <div className="mx-2 mb-1 p-2.5 rounded-[10px] bg-amber-500/10 border border-amber-500/20">
          <div className="flex items-start gap-2">
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 text-amber-500 shrink-0 mt-0.5">
              <path d="M8.982 1.566a1.13 1.13 0 00-1.96 0L.165 13.233c-.457.778.091 1.767.98 1.767h13.713c.889 0 1.438-.99.98-1.767L8.982 1.566zM8 5c.535 0 .954.462.9.995l-.35 3.507a.552.552 0 01-1.1 0L7.1 5.995A.905.905 0 018 5zm.002 6a1 1 0 110 2 1 1 0 010-2z" />
            </svg>
            <div className="flex-1 min-w-0">
              <p className="text-[11px] text-cc-fg leading-snug">
                Archiving will <strong>remove the container</strong> and any uncommitted changes.
              </p>
              <div className="flex gap-2 mt-2">
                <button
                  onClick={cancelArchive}
                  className="px-2.5 py-1 text-[11px] font-medium rounded-md bg-cc-hover text-cc-muted hover:text-cc-fg transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  onClick={confirmArchive}
                  className="px-2.5 py-1 text-[11px] font-medium rounded-md bg-red-500/10 text-red-500 hover:bg-red-500/20 transition-colors cursor-pointer"
                >
                  Archive
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Sessions label + group toggle */}
      <div className="px-4 pt-2 pb-1 flex items-center justify-between">
        <span className="text-[11px] font-medium text-cc-muted uppercase tracking-wider">Sessions</span>
        <button
          onClick={() => setSidebarGroupByProject(!sidebarGroupByProject)}
          title={sidebarGroupByProject ? "Show flat list" : "Group by project"}
          aria-label={sidebarGroupByProject ? "Show flat list" : "Group by project"}
          className={`w-5 h-5 rounded flex items-center justify-center transition-colors cursor-pointer ${sidebarGroupByProject ? "text-cc-fg bg-cc-hover" : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"}`}
        >
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
            <path d="M1.5 2.5A1.5 1.5 0 013 1h1a1.5 1.5 0 011.5 1.5v1A1.5 1.5 0 014 5H3a1.5 1.5 0 01-1.5-1.5v-1zM1.5 9.5A1.5 1.5 0 013 8h1a1.5 1.5 0 011.5 1.5v1A1.5 1.5 0 014 12H3a1.5 1.5 0 01-1.5-1.5v-1zM7.5 2.75a.75.75 0 01.75-.75h6a.75.75 0 010 1.5h-6a.75.75 0 01-.75-.75zM7.5 9.75a.75.75 0 01.75-.75h6a.75.75 0 010 1.5h-6a.75.75 0 01-.75-.75z" />
          </svg>
        </button>
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto px-2.5 pb-2">
            {activeSessions.length === 0 && cronSessions.length === 0 && archivedSessions.length === 0 ? (
              <p className="px-3 py-8 text-xs text-cc-muted text-center leading-relaxed">
                No sessions yet.
              </p>
            ) : (
              <>
                {/* Active sessions — flat list (default) or project-grouped */}
                {sidebarGroupByProject ? (
                  projectGroups.map((group, i) => (
                    <ProjectGroup
                      key={group.key}
                      group={group}
                      isCollapsed={collapsedProjects.has(group.key)}
                      onToggleCollapse={toggleProjectCollapse}
                      currentSessionId={currentSessionId}
                      sessionNames={sessionNames}
                      pendingPermissions={pendingPermissions}
                      recentlyRenamed={recentlyRenamed}
                      isFirst={i === 0}
                      {...sessionItemProps}
                    />
                  ))
                ) : (
                  <div className="space-y-0.5">
                    {activeSessions.map((s) => (
                      <SessionItem
                        key={s.id}
                        session={s}
                        isActive={currentSessionId === s.id}
                        sessionName={sessionNames.get(s.id)}
                        permCount={pendingPermissions.get(s.id)?.size ?? 0}
                        isRecentlyRenamed={recentlyRenamed.has(s.id)}
                        {...sessionItemProps}
                      />
                    ))}
                  </div>
                )}

                {/* Scheduled runs — compact label */}
                {cronSessions.length > 0 && (
                  <div className="mt-1.5 pt-1.5 border-t border-cc-border/30">
                    <span className="px-3 text-[10px] font-medium text-violet-400/80 uppercase tracking-wider">
                      Scheduled ({cronSessions.length})
                    </span>
                    <div className="space-y-0.5 mt-1">
                      {cronSessions.map((s) => (
                        <SessionItem
                          key={s.id}
                          session={s}
                          isActive={currentSessionId === s.id}
                          sessionName={sessionNames.get(s.id)}
                          permCount={pendingPermissions.get(s.id)?.size ?? 0}
                          isRecentlyRenamed={recentlyRenamed.has(s.id)}
                          {...sessionItemProps}
                        />
                      ))}
                    </div>
                  </div>
                )}

                {/* Agent runs — compact label */}
                {agentSessions.length > 0 && (
                  <div className="mt-1.5 pt-1.5 border-t border-cc-border/30">
                    <span className="px-3 text-[10px] font-medium text-emerald-400/80 uppercase tracking-wider">
                      Agents ({agentSessions.length})
                    </span>
                    <div className="space-y-0.5 mt-1">
                      {agentSessions.map((s) => (
                        <SessionItem
                          key={s.id}
                          session={s}
                          isActive={currentSessionId === s.id}
                          sessionName={sessionNames.get(s.id)}
                          permCount={pendingPermissions.get(s.id)?.size ?? 0}
                          isRecentlyRenamed={recentlyRenamed.has(s.id)}
                          {...sessionItemProps}
                        />
                      ))}
                    </div>
                  </div>
                )}

                {/* Archived sessions — compact collapsible */}
                {archivedSessions.length > 0 && (
                  <div className="mt-1.5 pt-1.5 border-t border-cc-border/30">
                    <div className="flex items-center">
                      <button
                        onClick={() => setShowArchived(!showArchived)}
                        className="flex-1 px-3 py-1 text-[10px] font-medium text-cc-muted/70 uppercase tracking-wider flex items-center gap-1.5 hover:text-cc-fg transition-colors cursor-pointer"
                      >
                        <svg viewBox="0 0 16 16" fill="currentColor" className={`w-2.5 h-2.5 transition-transform ${showArchived ? "rotate-90" : ""}`}>
                          <path d="M6 4l4 4-4 4" />
                        </svg>
                        Archived ({archivedSessions.length})
                      </button>
                      {showArchived && archivedSessions.length > 1 && (
                        <button
                          onClick={handleDeleteAllArchived}
                          className="px-2 py-1 mr-1 text-[10px] text-red-400 hover:text-red-500 hover:bg-red-500/10 rounded-md transition-colors cursor-pointer"
                          title="Delete all archived sessions"
                        >
                          Delete all
                        </button>
                      )}
                    </div>
                    {showArchived && (
                      <div className="space-y-0.5 mt-1">
                        {archivedSessions.map((s) => (
                          <SessionItem
                            key={s.id}
                            session={s}
                            isActive={currentSessionId === s.id}
                            isArchived
                            sessionName={sessionNames.get(s.id)}
                            permCount={pendingPermissions.get(s.id)?.size ?? 0}
                            isRecentlyRenamed={recentlyRenamed.has(s.id)}
                            {...sessionItemProps}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
      </div>

      {/* External links footer */}
      <div className="shrink-0 px-2.5 pb-2 pt-1 border-t border-cc-border/30">
        <div className="flex items-center gap-3 px-2 py-1">
          {EXTERNAL_LINKS.map((link) => (
            <a
              key={link.label}
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              title={link.label}
              className="text-cc-muted/50 hover:text-cc-muted transition-colors"
            >
              <svg viewBox={link.viewBox} fill="currentColor" className="w-3.5 h-3.5">
                <path d={link.iconPath} />
              </svg>
            </a>
          ))}
        </div>
      </div>

      {/* Mobile FAB — New Session button in thumb zone */}
      <div className="md:hidden flex justify-end px-4 pb-2">
        <button
          onClick={handleNewSession}
          title="New Session"
          aria-label="New Session"
          className="w-12 h-12 rounded-full bg-cc-primary hover:bg-cc-primary-hover text-white flex items-center justify-center shadow-lg transition-colors duration-150 cursor-pointer"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-5 h-5">
            <path d="M8 3v10M3 8h10" />
          </svg>
        </button>
      </div>

      {/* Delete confirmation modal */}
      {(confirmDeleteId || confirmDeleteAll) && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm animate-[fadeIn_150ms_ease-out]"
          onClick={confirmDeleteAll ? cancelDeleteAll : cancelDelete}
        >
          <div
            className="mx-4 w-full max-w-[280px] bg-cc-card border border-cc-border rounded-xl shadow-2xl p-5 animate-[menu-appear_150ms_ease-out]"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Icon */}
            <div className="flex justify-center mb-3">
              <div className="w-10 h-10 rounded-full bg-red-500/10 flex items-center justify-center">
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-5 h-5 text-red-400">
                  <path d="M5.5 5.5A.5.5 0 016 6v6a.5.5 0 01-1 0V6a.5.5 0 01.5-.5zm2.5 0a.5.5 0 01.5.5v6a.5.5 0 01-1 0V6a.5.5 0 01.5-.5zm3 .5a.5.5 0 00-1 0v6a.5.5 0 001 0V6z" />
                  <path fillRule="evenodd" d="M14.5 3a1 1 0 01-1 1H13v9a2 2 0 01-2 2H5a2 2 0 01-2-2V4h-.5a1 1 0 010-2H6a1 1 0 011-1h2a1 1 0 011 1h3.5a1 1 0 011 1zM4.118 4L4 4.059V13a1 1 0 001 1h6a1 1 0 001-1V4.059L11.882 4H4.118zM6 2h4v1H6V2z" clipRule="evenodd" />
                </svg>
              </div>
            </div>

            {/* Text */}
            <h3 className="text-[13px] font-semibold text-cc-fg text-center">
              {confirmDeleteAll ? "Delete all archived?" : "Delete session?"}
            </h3>
            <p className="text-[12px] text-cc-muted text-center mt-1.5 leading-relaxed">
              {confirmDeleteAll
                ? `This will permanently delete ${archivedSessions.length} archived session${archivedSessions.length === 1 ? "" : "s"}. This cannot be undone.`
                : "This will permanently delete this session and its history. This cannot be undone."}
            </p>

            {/* Actions */}
            <div className="flex gap-2.5 mt-4">
              <button
                onClick={confirmDeleteAll ? cancelDeleteAll : cancelDelete}
                className="flex-1 px-3 py-2 text-[12px] font-medium rounded-lg bg-cc-hover text-cc-muted hover:text-cc-fg transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={confirmDeleteAll ? confirmDeleteAllArchived : confirmDelete}
                className="flex-1 px-3 py-2 text-[12px] font-medium rounded-lg bg-red-500/15 text-red-400 hover:bg-red-500/25 transition-colors cursor-pointer"
              >
                {confirmDeleteAll ? "Delete all" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Archive Linear transition modal */}
      {archiveModalSessionId && archiveModalInfo && (
        <ArchiveLinearModal
          issueIdentifier={archiveModalInfo.issue?.identifier || ""}
          issueStateName={archiveModalInfo.issue?.stateName || ""}
          isContainerized={archiveModalContainerized}
          archiveTransitionConfigured={archiveModalInfo.archiveTransitionConfigured || false}
          archiveTransitionStateName={archiveModalInfo.archiveTransitionStateName}
          hasBacklogState={archiveModalInfo.hasBacklogState || false}
          onConfirm={handleArchiveModalConfirm}
          onCancel={handleArchiveModalCancel}
        />
      )}
    </aside>
  );
}
