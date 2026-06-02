import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useStore } from "../store.js";
import { api, type ArchiveInfo } from "../api.js";
import { ArchiveLinearModal, type LinearTransitionChoice } from "./ArchiveLinearModal.js";
import { connectAllSessions, disconnectSession } from "../ws.js";
import { navigateToSession, navigateHome, parseHash } from "../utils/routing.js";
import { ProjectGroup } from "./ProjectGroup.js";
import { SessionItem } from "./SessionItem.js";
import { groupSessionsByProject, type SessionItem as SessionItemType } from "../utils/project-grouping.js";

interface NavItem {
  id: string;
  label: string;
  hash: string;
  viewBox: string;
  iconPath: string;
  activePages?: string[];
  fillRule?: "evenodd";
  clipRule?: "evenodd";
}

interface ExternalLink {
  label: string;
  url: string;
  viewBox: string;
  iconPath: string;
}

const EXTERNAL_LINKS: ExternalLink[] = [
  {
    label: "Documentation",
    url: "https://docs.thecompanion.sh",
    viewBox: "0 0 16 16",
    iconPath: "M1 2.828c.885-.37 2.154-.769 3.388-.893 1.33-.134 2.458.063 3.112.752v9.746c-.935-.53-2.12-.603-3.213-.493-1.18.12-2.37.461-3.287.811V2.828zm7.5-.141c.654-.689 1.782-.886 3.112-.752 1.234.124 2.503.523 3.388.893v9.923c-.918-.35-2.107-.692-3.287-.81-1.094-.111-2.278-.039-3.213.492V2.687zM8 1.783C7.015.936 5.587.81 4.287.94c-1.514.153-3.042.672-3.994 1.105A.5.5 0 000 2.5v11a.5.5 0 00.707.455c.882-.4 2.303-.881 3.68-1.02 1.409-.142 2.59.087 3.223.877a.5.5 0 00.78 0c.633-.79 1.814-1.019 3.222-.877 1.378.139 2.8.62 3.681 1.02A.5.5 0 0016 13.5v-11a.5.5 0 00-.293-.455c-.952-.433-2.48-.952-3.994-1.105C10.413.809 8.985.936 8 1.783z",
  },
  {
    label: "GitHub",
    url: "https://github.com/The-Vibe-Company/companion",
    viewBox: "0 0 16 16",
    iconPath: "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z",
  },
  {
    label: "Website",
    url: "https://thecompanion.sh",
    viewBox: "0 0 16 16",
    iconPath: "M0 8a8 8 0 1116 0A8 8 0 010 8zm7.5-6.923c-.67.204-1.335.82-1.887 1.855A7.97 7.97 0 005.145 4H7.5V1.077zM4.09 4a9.267 9.267 0 01.64-1.539 6.7 6.7 0 01.597-.933A7.025 7.025 0 002.255 4H4.09zm-.582 3.5c.03-.877.138-1.718.312-2.5H1.674a6.958 6.958 0 00-.656 2.5h2.49zM4.847 5a12.5 12.5 0 00-.338 2.5H7.5V5H4.847zM8.5 5v2.5h2.99a12.495 12.495 0 00-.337-2.5H8.5zM4.51 8.5a12.5 12.5 0 00.337 2.5H7.5V8.5H4.51zm3.99 0V11h2.653c.187-.765.306-1.608.338-2.5H8.5zM5.145 12c.138.386.295.744.468 1.068.552 1.035 1.218 1.65 1.887 1.855V12H5.145zm.182 2.472a6.696 6.696 0 01-.597-.933A9.268 9.268 0 014.09 12H2.255a7.024 7.024 0 003.072 2.472zM3.82 11a13.652 13.652 0 01-.312-2.5h-2.49c.062.89.291 1.733.656 2.5H3.82zm6.853 3.472A7.024 7.024 0 0013.745 12H11.91a9.27 9.27 0 01-.64 1.539 6.688 6.688 0 01-.597.933zM8.5 12v2.923c.67-.204 1.335-.82 1.887-1.855.173-.324.33-.682.468-1.068H8.5zm3.68-1h2.146c.365-.767.594-1.61.656-2.5h-2.49a13.65 13.65 0 01-.312 2.5zm2.802-3.5a6.959 6.959 0 00-.656-2.5H12.18c.174.782.282 1.623.312 2.5h2.49zM11.27 2.461c.247.464.462.98.64 1.539h1.835a7.024 7.024 0 00-3.072-2.472c.218.284.418.598.597.933zM10.855 4a7.966 7.966 0 00-.468-1.068C9.835 1.897 9.17 1.282 8.5 1.077V4h2.355z",
  },
];

const NAV_ITEMS: NavItem[] = [
  {
    id: "prompts",
    label: "Prompts",
    hash: "#/prompts",
    viewBox: "0 0 16 16",
    iconPath: "M3 2.5A1.5 1.5 0 014.5 1h5.879c.398 0 .779.158 1.06.44l1.621 1.62c.281.282.44.663.44 1.061V13.5A1.5 1.5 0 0112 15H4.5A1.5 1.5 0 013 13.5v-11zM4.5 2a.5.5 0 00-.5.5v11a.5.5 0 00.5.5H12a.5.5 0 00.5-.5V4.121a.5.5 0 00-.146-.353l-1.621-1.621A.5.5 0 0010.379 2H4.5zm1.25 4.25a.75.75 0 01.75-.75h3a.75.75 0 010 1.5h-3a.75.75 0 01-.75-.75zm0 3a.75.75 0 01.75-.75h3.5a.75.75 0 010 1.5H6.5a.75.75 0 01-.75-.75z",
  },
  {
    id: "integrations",
    label: "Integrations",
    hash: "#/integrations",
    activePages: ["integrations", "integration-linear", "integration-linear-oauth", "integration-tailscale"],
    viewBox: "0 0 16 16",
    iconPath: "M2.5 3A1.5 1.5 0 001 4.5v2A1.5 1.5 0 002.5 8h2A1.5 1.5 0 006 6.5v-2A1.5 1.5 0 004.5 3h-2zm0 1h2a.5.5 0 01.5.5v2a.5.5 0 01-.5.5h-2a.5.5 0 01-.5-.5v-2a.5.5 0 01.5-.5zm9 0A1.5 1.5 0 0010 5.5v2A1.5 1.5 0 0011.5 9h2A1.5 1.5 0 0015 7.5v-2A1.5 1.5 0 0013.5 4h-2zm0 1h2a.5.5 0 01.5.5v2a.5.5 0 01-.5.5h-2a.5.5 0 01-.5-.5v-2a.5.5 0 01.5-.5zM2.5 10A1.5 1.5 0 001 11.5v2A1.5 1.5 0 002.5 15h2A1.5 1.5 0 006 13.5v-2A1.5 1.5 0 004.5 10h-2zm0 1h2a.5.5 0 01.5.5v2a.5.5 0 01-.5.5h-2a.5.5 0 01-.5-.5v-2a.5.5 0 01.5-.5zM8.5 12a.5.5 0 100 1h5a.5.5 0 100-1h-5zm0-2a.5.5 0 100 1h2a.5.5 0 100-1h-2z",
  },
  {
    id: "environments",
    label: "Environments",
    hash: "#/environments",
    viewBox: "0 0 16 16",
    iconPath: "M8 1a2 2 0 012 2v1h2a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6a2 2 0 012-2h2V3a2 2 0 012-2zm0 1.5a.5.5 0 00-.5.5v1h1V3a.5.5 0 00-.5-.5zM4 5.5a.5.5 0 00-.5.5v6a.5.5 0 00.5.5h8a.5.5 0 00.5-.5V6a.5.5 0 00-.5-.5H4z",
    activePages: ["environments"],
  },
  {
    id: "sandboxes",
    label: "Sandboxes",
    hash: "#/sandboxes",
    viewBox: "0 0 16 16",
    iconPath: "M2 2a2 2 0 012-2h8a2 2 0 012 2v12a2 2 0 01-2 2H4a2 2 0 01-2-2V2zm2-.5a.5.5 0 00-.5.5v12a.5.5 0 00.5.5h8a.5.5 0 00.5-.5V2a.5.5 0 00-.5-.5H4zM6 4.5a.5.5 0 01.5-.5h3a.5.5 0 010 1h-3a.5.5 0 01-.5-.5zM6.5 7a.5.5 0 000 1h3a.5.5 0 000-1h-3z",
    activePages: ["sandboxes"],
  },
  {
    id: "agents",
    label: "Agents",
    hash: "#/agents",
    activePages: ["agents", "agent-detail"],
    viewBox: "0 0 16 16",
    iconPath: "M8 1.5a2.5 2.5 0 00-2.5 2.5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5S9.38 1.5 8 1.5zM4 8a4 4 0 00-4 4v1.5a.5.5 0 00.5.5h15a.5.5 0 00.5-.5V12a4 4 0 00-4-4H4z",
  },
  {
    id: "runs",
    label: "Runs",
    hash: "#/runs",
    viewBox: "0 0 16 16",
    iconPath: "M8 1a7 7 0 100 14A7 7 0 008 1zm-.75 3.5a.75.75 0 011.5 0v3.19l2.03 2.03a.75.75 0 01-1.06 1.06l-2.25-2.25A.75.75 0 017.25 8V4.5z",
  },
  {
    id: "settings",
    label: "Settings",
    hash: "#/settings",
    viewBox: "0 0 20 20",
    iconPath: "M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.53 1.53 0 01-2.29.95c-1.35-.8-2.92.77-2.12 2.12.54.9.07 2.04-.95 2.29-1.56.38-1.56 2.6 0 2.98 1.02.25 1.49 1.39.95 2.29-.8 1.35.77 2.92 2.12 2.12.9-.54 2.04-.07 2.29.95.38 1.56 2.6 1.56 2.98 0 .25-1.02 1.39-1.49 2.29-.95 1.35.8 2.92-.77 2.12-2.12-.54-.9-.07-2.04.95-2.29 1.56-.38 1.56-2.6 0-2.98-1.02-.25-1.49-1.39-.95-2.29.8-1.35-.77-2.92-2.12-2.12-.9.54-2.04.07-2.29-.95zM10 13a3 3 0 100-6 3 3 0 000 6z",
    fillRule: "evenodd",
    clipRule: "evenodd",
  },
];

const NAV_SECTIONS = [
  { id: "workbench", label: "Workbench", itemIds: ["prompts", "integrations"] },
  { id: "workspace", label: "Workspace", itemIds: ["environments", "sandboxes", "agents", "settings"] },
] as const;

const NAV_ITEMS_BY_ID = new Map(NAV_ITEMS.map((item) => [item.id, item]));

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
  const [hash, setHash] = useState(() => (typeof window !== "undefined" ? window.location.hash : ""));
  const editInputRef = useRef<HTMLInputElement>(null);
  const deleteModalRef = useRef<HTMLDivElement>(null);
  const sessions = useStore((s) => s.sessions);
  const sdkSessions = useStore((s) => s.sdkSessions);
  const currentSessionId = useStore((s) => s.currentSessionId);
  const cliConnected = useStore((s) => s.cliConnected);
  const cliReconnecting = useStore((s) => s.cliReconnecting);
  const sessionStatus = useStore((s) => s.sessionStatus);
  const removeSession = useStore((s) => s.removeSession);
  const sessionNames = useStore((s) => s.sessionNames);
  const recentlyRenamed = useStore((s) => s.recentlyRenamed);
  const clearRecentlyRenamed = useStore((s) => s.clearRecentlyRenamed);
  const pendingPermissions = useStore((s) => s.pendingPermissions);
  const linkedLinearIssues = useStore((s) => s.linkedLinearIssues);
  const collapsedProjects = useStore((s) => s.collapsedProjects);
  const toggleProjectCollapse = useStore((s) => s.toggleProjectCollapse);
  const route = parseHash(hash);

  // Poll for SDK sessions on mount
  useEffect(() => {
    let active = true;
    async function poll() {
      try {
        const list = await api.listSessions();
        if (active) {
          const store = useStore.getState();
          store.setSdkSessions(list);
          // Remove client-side sessions the server no longer knows about.
          // Re-read state AFTER setSdkSessions so we get the freshest snapshot —
          // a session_init WebSocket message may have arrived while listSessions()
          // was in-flight and added a new session to the store. Guard removal with
          // a connectionStatus check: a "connected" session arrived legitimately
          // via session_init and must not be evicted just because it was absent
          // from the (now-stale) server snapshot.
          const freshStore = useStore.getState();
          const serverIds = new Set(list.map((s) => s.sessionId));
          for (const id of freshStore.sessions.keys()) {
            if (!serverIds.has(id) && freshStore.connectionStatus.get(id) !== "connected") {
              freshStore.removeSession(id);
            }
          }
          // Connect all active sessions so we receive notifications for all of them
          connectAllSessions(list);
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

  useEffect(() => {
    const onHashChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  function handleSelectSession(sessionId: string) {
    // Navigate to session hash — App.tsx hash effect handles setCurrentSession + connectSession
    navigateToSession(sessionId);
    // Close sidebar on mobile
    if (window.innerWidth < 768) {
      useStore.getState().setSidebarOpen(false);
    }
  }

  function handleNewSession() {
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

  // Focus trap for delete confirmation modal
  useEffect(() => {
    if (!confirmDeleteId && !confirmDeleteAll) return;
    // Auto-focus the cancel button on open
    requestAnimationFrame(() => {
      deleteModalRef.current?.querySelector<HTMLElement>("button")?.focus();
    });
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        confirmDeleteAll ? cancelDeleteAll() : cancelDelete();
        return;
      }
      if (e.key !== "Tab") return;
      const focusable = deleteModalRef.current?.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable || focusable.length === 0) return;
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
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [confirmDeleteId, confirmDeleteAll, cancelDelete, cancelDeleteAll]);

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
      isReconnecting: cliReconnecting.get(id) ?? false,
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
  const currentSession = currentSessionId ? allSessionList.find((s) => s.id === currentSessionId) : null;
  const logoSrc = currentSession?.backendType === "codex" ? "/logo-codex.svg" : "/logo.svg";
  const [showCronSessions, setShowCronSessions] = useState(true);
  const [showAgentSessions, setShowAgentSessions] = useState(true);

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
    <aside aria-label="Session sidebar" className="w-full md:w-[260px] h-full flex flex-col bg-cc-sidebar">
      {/* Header */}
      <div className="p-3.5 pb-2">
        <div className="flex items-center gap-2.5">
          <img src={logoSrc} alt="" className="w-6 h-6" />
          <span className="text-[13px] font-semibold text-cc-fg tracking-tight">The Companion</span>
          <button
            onClick={handleNewSession}
            title="New Session"
            aria-label="New Session"
            className="ml-auto hidden md:flex w-8 h-8 rounded-lg bg-cc-primary hover:bg-cc-primary-hover text-white items-center justify-center transition-colors duration-150 cursor-pointer"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-3.5 h-3.5">
              <path d="M8 3v10M3 8h10" />
            </svg>
          </button>
          {/* Close button — mobile only (sidebar is full-width on mobile, so no backdrop to tap) */}
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

      {/* Container archive confirmation */}
      {confirmArchiveId && (
        <div className="mx-2 mb-1 p-2.5 rounded-[10px] bg-cc-warning/10 border border-cc-warning/20">
          <div className="flex items-start gap-2">
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 text-cc-warning shrink-0 mt-0.5">
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
                  className="px-2.5 py-1 text-[11px] font-medium rounded-md bg-cc-error/10 text-cc-error hover:bg-cc-error/20 transition-colors cursor-pointer"
                >
                  Archive
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Session list */}
      <div className="flex-1 overflow-y-auto px-2.5 pb-2">
        {activeSessions.length === 0 && cronSessions.length === 0 && archivedSessions.length === 0 ? (
          <p className="px-3 py-8 text-xs text-cc-muted text-center leading-relaxed">
            No sessions yet.
          </p>
        ) : (
          <>
            {projectGroups.map((group, i) => (
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
            ))}

            {cronSessions.length > 0 && (
              <div className="mt-3 pt-3 border-t border-cc-separator">
                <button
                  onClick={() => setShowCronSessions(!showCronSessions)}
                  aria-expanded={showCronSessions}
                  className="w-full px-2 py-1 text-[11px] font-semibold text-cc-fg/60 uppercase tracking-wide flex items-center gap-1.5 hover:bg-cc-hover rounded-md transition-colors cursor-pointer"
                >
                  <svg viewBox="0 0 16 16" fill="currentColor" className={`w-2 h-2 text-cc-muted/50 transition-transform duration-150 ${showCronSessions ? "rotate-90" : ""}`}>
                    <path d="M6 4l4 4-4 4" />
                  </svg>
                  Scheduled Runs ({cronSessions.length})
                </button>
                {showCronSessions && (
                  <div className="mt-0.5">
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
                )}
              </div>
            )}

            {agentSessions.length > 0 && (
              <div className="mt-3 pt-3 border-t border-cc-separator">
                <button
                  onClick={() => setShowAgentSessions(!showAgentSessions)}
                  aria-expanded={showAgentSessions}
                  className="w-full px-2 py-1 text-[11px] font-semibold text-cc-fg/60 uppercase tracking-wide flex items-center gap-1.5 hover:bg-cc-hover rounded-md transition-colors cursor-pointer"
                >
                  <svg viewBox="0 0 16 16" fill="currentColor" className={`w-2 h-2 text-cc-muted/50 transition-transform duration-150 ${showAgentSessions ? "rotate-90" : ""}`}>
                    <path d="M6 4l4 4-4 4" />
                  </svg>
                  Agent Runs ({agentSessions.length})
                </button>
                {showAgentSessions && (
                  <div className="mt-0.5">
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
                )}
              </div>
            )}

            {archivedSessions.length > 0 && (
              <div className="mt-3 pt-3 border-t border-cc-separator">
                <div className="flex items-center">
                  <button
                    onClick={() => setShowArchived(!showArchived)}
                    aria-expanded={showArchived}
                    className="flex-1 px-2 py-1 text-[11px] font-semibold text-cc-fg/60 uppercase tracking-wide flex items-center gap-1.5 hover:bg-cc-hover rounded-md transition-colors cursor-pointer"
                  >
                    <svg viewBox="0 0 16 16" fill="currentColor" className={`w-2 h-2 text-cc-muted/50 transition-transform duration-150 ${showArchived ? "rotate-90" : ""}`}>
                      <path d="M6 4l4 4-4 4" />
                    </svg>
                    Archived ({archivedSessions.length})
                  </button>
                  {showArchived && archivedSessions.length > 1 && (
                    <button
                      onClick={handleDeleteAllArchived}
                      className="px-2 py-0.5 mr-1 text-[10px] text-cc-error/80 hover:text-cc-error hover:bg-cc-error/5 rounded-md transition-colors cursor-pointer"
                      title="Delete all archived sessions"
                    >
                      Delete all
                    </button>
                  )}
                </div>
                {showArchived && (
                  <div className="mt-0.5">
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

      {/* Footer */}
      <div className="px-2 py-1.5 pb-safe bg-cc-sidebar-footer border-t border-cc-border/30">
        <nav className="flex flex-col gap-1.5" aria-label="Navigation">
          {NAV_SECTIONS.map((section) => (
            <section key={section.id} className="rounded-lg border border-cc-border/30 bg-cc-card/20 p-0.5">
              <span className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-cc-muted/75 block">
                {section.label}
              </span>
              <div className="flex flex-col">
                {section.itemIds.map((itemId) => {
                  const item = NAV_ITEMS_BY_ID.get(itemId);
                  if (!item) return null;
                  const isActive = item.activePages
                    ? item.activePages.some((p) => route.page === p)
                    : route.page === item.id;
                  return (
                    <button
                      key={item.id}
                      onClick={() => {
                        window.location.hash = item.hash;
                        // Close sidebar on mobile so the navigated page is visible
                        if (window.innerWidth < 768) {
                          useStore.getState().setSidebarOpen(false);
                        }
                      }}
                      title={item.label}
                      aria-current={isActive ? "page" : undefined}
                      className={`group flex min-h-[44px] md:min-h-[34px] w-full items-center gap-2 rounded-md px-2 py-1 md:py-0.5 text-left transition-colors duration-150 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cc-primary/60 ${
                        isActive
                          ? "bg-cc-active text-cc-fg"
                          : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
                      }`}
                    >
                      <span
                        aria-hidden
                        className={`h-4 w-0.5 shrink-0 rounded-full transition-colors ${
                          isActive ? "bg-cc-primary" : "bg-transparent group-hover:bg-cc-border"
                        }`}
                      />
                      <svg viewBox={item.viewBox} fill="currentColor" className="w-3.5 h-3.5 shrink-0">
                        <path d={item.iconPath} fillRule={item.fillRule} clipRule={item.clipRule} />
                      </svg>
                      <span className="min-w-0 flex-1 text-[12px] font-medium leading-tight">{item.label}</span>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </nav>
        <div className="mt-1.5 rounded-lg border border-cc-border/30 bg-cc-card/20 px-1.5 py-0.5">
          <div className="flex items-center justify-between">
            <span className="px-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-cc-muted/75">
              Resources
            </span>
            <div className="flex items-center gap-0.5">
              {EXTERNAL_LINKS.map((link) => (
                <a
                  key={link.label}
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={link.label}
                  aria-label={`Open ${link.label.toLowerCase()}`}
                  className="w-9 h-9 md:w-7 md:h-7 rounded-md flex items-center justify-center text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors"
                >
                  <svg viewBox={link.viewBox} fill="currentColor" className="w-3.5 h-3.5">
                    <path d={link.iconPath} />
                  </svg>
                </a>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Delete confirmation modal */}
      {(confirmDeleteId || confirmDeleteAll) && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm animate-[fadeIn_150ms_ease-out]"
          onClick={confirmDeleteAll ? cancelDeleteAll : cancelDelete}
        >
          <div
            ref={deleteModalRef}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-dialog-title"
            aria-describedby="delete-dialog-desc"
            className="mx-4 w-full max-w-[280px] bg-cc-card border border-cc-border rounded-xl shadow-2xl p-5 animate-[menu-appear_150ms_ease-out]"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Icon */}
            <div className="flex justify-center mb-3">
              <div className="w-10 h-10 rounded-full bg-cc-error/10 flex items-center justify-center">
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-5 h-5 text-cc-error">
                  <path d="M5.5 5.5A.5.5 0 016 6v6a.5.5 0 01-1 0V6a.5.5 0 01.5-.5zm2.5 0a.5.5 0 01.5.5v6a.5.5 0 01-1 0V6a.5.5 0 01.5-.5zm3 .5a.5.5 0 00-1 0v6a.5.5 0 001 0V6z" />
                  <path fillRule="evenodd" d="M14.5 3a1 1 0 01-1 1H13v9a2 2 0 01-2 2H5a2 2 0 01-2-2V4h-.5a1 1 0 010-2H6a1 1 0 011-1h2a1 1 0 011 1h3.5a1 1 0 011 1zM4.118 4L4 4.059V13a1 1 0 001 1h6a1 1 0 001-1V4.059L11.882 4H4.118zM6 2h4v1H6V2z" clipRule="evenodd" />
                </svg>
              </div>
            </div>

            {/* Text */}
            <p id="delete-dialog-title" className="text-[13px] font-semibold text-cc-fg text-center">
              {confirmDeleteAll ? "Delete all archived?" : "Delete session?"}
            </p>
            <p id="delete-dialog-desc" className="text-[12px] text-cc-muted text-center mt-1.5 leading-relaxed">
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
                className="flex-1 px-3 py-2 text-[12px] font-medium rounded-lg bg-cc-error/15 text-cc-error hover:bg-cc-error/25 transition-colors cursor-pointer"
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
