import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useStore } from "../store.js";
import { parseHash } from "../utils/routing.js";
import { AiValidationToggle } from "./AiValidationToggle.js";

type WorkspaceTab = "chat" | "diff" | "terminal" | "processes" | "editor" | "browser";

export function TopBar() {
  const hash = useSyncExternalStore(
    (cb) => {
      window.addEventListener("hashchange", cb);
      return () => window.removeEventListener("hashchange", cb);
    },
    () => window.location.hash,
  );
  const route = useMemo(() => parseHash(hash), [hash]);
  const isSessionView = route.page === "session" || route.page === "home";
  const currentSessionId = useStore((s) => s.currentSessionId);
  const cliConnected = useStore((s) => s.cliConnected);
  const sessionStatus = useStore((s) => s.sessionStatus);
  const sessionNames = useStore((s) => s.sessionNames);
  const sdkSessions = useStore((s) => s.sdkSessions);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const setSidebarOpen = useStore((s) => s.setSidebarOpen);
  const taskPanelOpen = useStore((s) => s.taskPanelOpen);
  const setTaskPanelOpen = useStore((s) => s.setTaskPanelOpen);
  const activeTab = useStore((s) => s.activeTab);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const markChatTabReentry = useStore((s) => s.markChatTabReentry);
  const quickTerminalOpen = useStore((s) => s.quickTerminalOpen);
  const quickTerminalTabs = useStore((s) => s.quickTerminalTabs);
  const openQuickTerminal = useStore((s) => s.openQuickTerminal);
  const resetQuickTerminal = useStore((s) => s.resetQuickTerminal);
  const changedFilesCount = useStore((s) =>
    currentSessionId ? (s.gitChangedFilesCount.get(currentSessionId) ?? 0) : 0
  );

  const runningProcessCount = useStore((s) => {
    if (!currentSessionId) return 0;
    const processes = s.sessionProcesses.get(currentSessionId);
    if (!processes) return 0;
    return processes.filter((p) => p.status === "running").length;
  });

  const cwd = useStore((s) => {
    if (!currentSessionId) return null;
    return (
      s.sessions.get(currentSessionId)?.cwd ||
      s.sdkSessions.find((sdk) => sdk.sessionId === currentSessionId)?.cwd ||
      null
    );
  });
  const sdkSession = useStore((s) => {
    if (!currentSessionId) return null;
    return s.sdkSessions.find((sdk) => sdk.sessionId === currentSessionId) || null;
  });
  const bridgeSession = useStore((s) => {
    if (!currentSessionId) return null;
    return s.sessions.get(currentSessionId) || null;
  });
  const defaultTerminalOpts = useMemo(() => {
    if (sdkSession?.containerId) {
      return { target: "docker" as const, cwd: "/workspace", containerId: sdkSession.containerId };
    }
    return { target: "host" as const, cwd: cwd || "" };
  }, [cwd, sdkSession?.containerId]);
  const terminalButtonTitle = !cwd
    ? "Terminal unavailable while session is reconnecting"
    : sdkSession?.containerId || bridgeSession?.is_containerized
      ? "Open terminal in session container (Ctrl/Cmd+J)"
      : "Quick terminal (Ctrl/Cmd+J)";
  const status = currentSessionId ? (sessionStatus.get(currentSessionId) ?? null) : null;
  const isConnected = currentSessionId ? (cliConnected.get(currentSessionId) ?? false) : false;
  const sessionName = currentSessionId
    ? (sessionNames?.get(currentSessionId) ||
      sdkSessions.find((s) => s.sessionId === currentSessionId)?.name ||
      `Session ${currentSessionId.slice(0, 8)}`)
    : null;
  const showWorkspaceControls = !!(currentSessionId && isSessionView);
  const showContextToggle = route.page === "session" && !!currentSessionId;
  const workspaceTabs: WorkspaceTab[] = ["chat", "diff", "terminal", "processes", "editor", "browser"];

  const activateWorkspaceTab = (tab: WorkspaceTab) => {
    if (tab === "terminal") {
      if (!cwd) return;
      if (!quickTerminalOpen || quickTerminalTabs.length === 0) {
        openQuickTerminal({ ...defaultTerminalOpts, reuseIfExists: true });
      }
      setActiveTab("terminal");
      return;
    }

    if (tab === "editor") {
      if (!cwd) return;
      setActiveTab("editor");
      return;
    }

    if (tab === "browser") {
      setActiveTab("browser");
      return;
    }

    if (tab === "chat" && activeTab !== "chat" && currentSessionId) {
      markChatTabReentry(currentSessionId);
    }
    setActiveTab(tab);
  };

  useEffect(() => {
    if (!currentSessionId) {
      resetQuickTerminal();
    }
  }, [currentSessionId, resetQuickTerminal]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "j") return;
      if (!showWorkspaceControls) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable)) {
        return;
      }
      event.preventDefault();
      const currentIndex = Math.max(0, workspaceTabs.indexOf(activeTab as WorkspaceTab));
      const direction = event.shiftKey ? -1 : 1;
      const nextIndex = (currentIndex + direction + workspaceTabs.length) % workspaceTabs.length;
      activateWorkspaceTab(workspaceTabs[nextIndex]);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [showWorkspaceControls, workspaceTabs, activeTab, cwd, quickTerminalOpen, quickTerminalTabs.length, openQuickTerminal, defaultTerminalOpts, setActiveTab, markChatTabReentry, currentSessionId]);

  return (
    <header className="relative shrink-0 h-12 px-3.5 bg-cc-bg/90 backdrop-blur-sm border-b border-cc-border/70">
      <div className="h-full flex items-center gap-0.5 min-w-0">
        <button
          onClick={() => setSidebarOpen(!sidebarOpen)}
          className={`flex items-center justify-center w-8 h-8 rounded-md transition-colors cursor-pointer shrink-0 ${
            sidebarOpen
              ? "text-cc-primary bg-cc-active"
              : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
          }`}
          aria-label="Toggle sidebar"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-[15px] h-[15px]">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 3h18v18H3V3z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 3v18" />
          </svg>
        </button>

        {showWorkspaceControls && (
          <div className="flex-1 flex items-center justify-start md:justify-center gap-0.5 min-w-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <button
                onClick={() => activateWorkspaceTab("chat")}
                className={`h-7 px-2.5 text-[11.5px] font-medium transition-colors cursor-pointer flex items-center gap-1.5 border rounded-md shrink-0 ${
                  activeTab === "chat"
                    ? "text-cc-fg border-cc-primary/40 bg-cc-card shadow-[0_1px_0_rgba(0,0,0,0.03)]"
                    : "text-cc-muted/90 hover:text-cc-fg border-transparent hover:bg-cc-hover"
                }`}
                title={sessionName || "Session"}
                aria-label="Session tab"
              >
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                    !isConnected
                      ? "bg-cc-muted opacity-45"
                      : status === "running"
                        ? "bg-cc-primary"
                        : status === "compacting"
                          ? "bg-cc-warning"
                          : "bg-cc-success"
                  }`} />
                  Session
              </button>
              <button
                onClick={() => activateWorkspaceTab("diff")}
                className={`h-7 px-2.5 text-[11.5px] font-medium transition-colors cursor-pointer flex items-center gap-1.5 border rounded-md shrink-0 ${
                  activeTab === "diff"
                    ? "text-cc-fg border-cc-primary/40 bg-cc-card shadow-[0_1px_0_rgba(0,0,0,0.03)]"
                    : "text-cc-muted/90 hover:text-cc-fg border-transparent hover:bg-cc-hover"
                }`}
                aria-label="Diffs tab"
              >
                Diffs
                {changedFilesCount > 0 && (
                  <span className="text-[9px] rounded-full min-w-[15px] h-[15px] px-1 flex items-center justify-center font-semibold leading-none bg-amber-100 text-amber-700 dark:bg-amber-900/60 dark:text-amber-300">
                    {changedFilesCount}
                  </span>
                )}
              </button>
              <button
                onClick={() => activateWorkspaceTab("terminal")}
                disabled={!cwd}
                className={`h-7 px-2.5 text-[11.5px] font-medium transition-colors flex items-center border rounded-md shrink-0 ${
                  !cwd
                    ? "text-cc-muted/50 border-transparent cursor-not-allowed"
                    : activeTab === "terminal"
                      ? "text-cc-fg border-cc-primary/40 bg-cc-card shadow-[0_1px_0_rgba(0,0,0,0.03)] cursor-pointer"
                      : "text-cc-muted/90 hover:text-cc-fg border-transparent hover:bg-cc-hover cursor-pointer"
                }`}
                title={terminalButtonTitle}
                aria-label="Shell tab"
              >
                Shell
              </button>
              <button
                onClick={() => activateWorkspaceTab("processes")}
                className={`h-7 px-2.5 text-[11.5px] font-medium transition-colors cursor-pointer flex items-center gap-1.5 border rounded-md shrink-0 ${
                  activeTab === "processes"
                    ? "text-cc-fg border-cc-primary/40 bg-cc-card shadow-[0_1px_0_rgba(0,0,0,0.03)]"
                    : "text-cc-muted/90 hover:text-cc-fg border-transparent hover:bg-cc-hover"
                }`}
                aria-label="Processes tab"
              >
                Processes
                {runningProcessCount > 0 && (
                  <span className="text-[9px] rounded-full min-w-[15px] h-[15px] px-1 flex items-center justify-center font-semibold leading-none bg-blue-100 text-blue-700 dark:bg-blue-900/60 dark:text-blue-300">
                    {runningProcessCount}
                  </span>
                )}
              </button>
              <button
                onClick={() => activateWorkspaceTab("editor")}
                disabled={!cwd}
                className={`h-7 px-2.5 text-[11.5px] font-medium transition-colors flex items-center border rounded-md shrink-0 ${
                  !cwd
                    ? "text-cc-muted/50 border-transparent cursor-not-allowed"
                    : activeTab === "editor"
                      ? "text-cc-fg border-cc-primary/40 bg-cc-card shadow-[0_1px_0_rgba(0,0,0,0.03)] cursor-pointer"
                      : "text-cc-muted/90 hover:text-cc-fg border-transparent hover:bg-cc-hover cursor-pointer"
                }`}
                title={!cwd ? "Editor unavailable while session is reconnecting" : "Editor"}
                aria-label="Editor tab"
              >
                Editor
              </button>
              <button
                onClick={() => activateWorkspaceTab("browser")}
                className={`h-7 px-2.5 text-[11.5px] font-medium transition-colors cursor-pointer flex items-center border rounded-md shrink-0 ${
                  activeTab === "browser"
                    ? "text-cc-fg border-cc-primary/40 bg-cc-card shadow-[0_1px_0_rgba(0,0,0,0.03)]"
                    : "text-cc-muted/90 hover:text-cc-fg border-transparent hover:bg-cc-hover"
                }`}
                title="Browser preview"
                aria-label="Browser tab"
              >
                Browser
              </button>
          </div>
        )}

        <div className="flex items-center gap-0.5 shrink-0">
          {showWorkspaceControls && currentSessionId && (
            <AiValidationToggle sessionId={currentSessionId} />
          )}
          <ThemeToggle />
          {showContextToggle && (
            <button
              onClick={() => setTaskPanelOpen(!taskPanelOpen)}
              className={`flex items-center justify-center w-8 h-8 rounded-md transition-colors cursor-pointer ${
                taskPanelOpen
                  ? "text-cc-primary bg-cc-active"
                  : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
              }`}
              title="Toggle context panel"
              aria-label="Toggle context panel"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-[15px] h-[15px]">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 3h18v18H3V3z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 3v18" />
              </svg>
            </button>
          )}
        </div>
      </div>

    </header>
  );
}

function ThemeToggle() {
  const darkMode = useStore((s) => s.darkMode);
  const toggle = useCallback(() => useStore.getState().toggleDarkMode(), []);

  return (
    <button
      onClick={toggle}
      className="flex items-center justify-center w-8 h-8 rounded-md text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
      title={darkMode ? "Switch to light mode" : "Switch to dark mode"}
      aria-label={darkMode ? "Switch to light mode" : "Switch to dark mode"}
    >
      {darkMode ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-[15px] h-[15px]">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32l1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41m11.32-11.32l1.41-1.41" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-[15px] h-[15px]">
          <path d="M21 12.79A9 9 0 1111.21 3a7 7 0 009.79 9.79z" />
        </svg>
      )}
    </button>
  );
}
