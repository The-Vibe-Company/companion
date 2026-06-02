import { useMemo } from "react";
import { useStore, type QuickTerminalPlacement } from "../store.js";
import { TerminalView } from "./TerminalView.js";
interface SessionTerminalDockProps {
  sessionId: string;
  children?: React.ReactNode;
  terminalOnly?: boolean;
  onClosePanel?: () => void;
  suppressPanel?: boolean;
}

function placementLayout(placement: QuickTerminalPlacement) {
  if (placement === "left") {
    return {
      shellClass: "flex-row",
      terminalWrapClass: "w-[42%] min-w-[300px] max-w-[70%] border-r border-cc-border order-1",
      contentWrapClass: "flex-1 min-w-0 order-2",
    };
  }
  if (placement === "right") {
    return {
      shellClass: "flex-row",
      terminalWrapClass: "w-[42%] min-w-[300px] max-w-[70%] border-l border-cc-border order-2",
      contentWrapClass: "flex-1 min-w-0 order-1",
    };
  }
  if (placement === "top") {
    return {
      shellClass: "flex-col",
      terminalWrapClass: "h-[38%] min-h-[220px] max-h-[70%] border-b border-cc-border order-1",
      contentWrapClass: "flex-1 min-h-0 order-2",
    };
  }
  return {
    shellClass: "flex-col",
    terminalWrapClass: "h-[38%] min-h-[220px] max-h-[70%] border-t border-cc-border order-2",
    contentWrapClass: "flex-1 min-h-0 order-1",
  };
}

export function SessionTerminalDock({
  sessionId,
  children,
  terminalOnly = false,
  onClosePanel,
  suppressPanel = false,
}: SessionTerminalDockProps) {
  const currentSessionId = useStore((s) => s.currentSessionId);
  const quickTerminalOpen = useStore((s) => s.quickTerminalOpen);
  const quickTerminalTabs = useStore((s) => s.quickTerminalTabs);
  const activeQuickTerminalTabId = useStore((s) => s.activeQuickTerminalTabId);
  const quickTerminalPlacement = useStore((s) => s.quickTerminalPlacement);
  const setQuickTerminalOpen = useStore((s) => s.setQuickTerminalOpen);
  const openQuickTerminal = useStore((s) => s.openQuickTerminal);
  const closeQuickTerminalTab = useStore((s) => s.closeQuickTerminalTab);
  const setActiveQuickTerminalTabId = useStore((s) => s.setActiveQuickTerminalTabId);

  const cwd = useStore((s) => {
    if (!currentSessionId) return null;
    return (
      s.sessions.get(currentSessionId)?.cwd
      || s.sdkSessions.find((sdk) => sdk.sessionId === currentSessionId)?.cwd
      || null
    );
  });
  const sdkSession = useStore((s) => {
    if (!currentSessionId) return null;
    return s.sdkSessions.find((sdk) => sdk.sessionId === currentSessionId) || null;
  });
  const defaultNewTerminalOpts = sdkSession?.containerId
    ? { target: "docker" as const, cwd: "/workspace", containerId: sdkSession.containerId }
    : (cwd ? { target: "host" as const, cwd } : null);

  const hasPanel = currentSessionId === sessionId && quickTerminalOpen && quickTerminalTabs.length > 0;
  const layout = useMemo(
    () => placementLayout(quickTerminalPlacement),
    [quickTerminalPlacement],
  );

  const closeDock = () => {
    setQuickTerminalOpen(false);
    onClosePanel?.();
  };

  if (!hasPanel) {
    if (terminalOnly) {
      return (
        <div className="h-full min-h-0 flex items-center justify-center bg-cc-bg">
          <div className="w-full max-w-md mx-4 rounded-xl border border-cc-border bg-cc-card p-5 text-center">
            <h3 className="text-sm font-semibold text-cc-fg">Terminal ready</h3>
            <p className="mt-1.5 text-xs text-cc-muted">
              Open a terminal tab to work directly in this session workspace.
            </p>
            {defaultNewTerminalOpts && (
              <button
                type="button"
                onClick={() => openQuickTerminal(defaultNewTerminalOpts)}
                className="mt-4 inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-cc-primary hover:bg-cc-primary-hover text-white text-xs font-semibold transition-colors cursor-pointer"
              >
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                  <path d="M2 3.5A1.5 1.5 0 013.5 2h9A1.5 1.5 0 0114 3.5v9a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 12.5v-9zm3.2 2.2a.7.7 0 00-.99.99L5.82 8.3 4.21 9.91a.7.7 0 00.99.99l2.1-2.1a.7.7 0 000-.99L5.2 5.7zm3.6 4.1h2.4a.7.7 0 000-1.4H8.8a.7.7 0 000 1.4z" />
                </svg>
                Open terminal
              </button>
            )}
          </div>
        </div>
      );
    }
    return <>{children}</>;
  }

  const closeLabel = terminalOnly ? "Back to chat" : "Close";

  const terminalPanel = (
    <div className="h-full min-h-0 flex flex-col">
      <div className="px-2 py-1.5 border-b border-cc-border bg-cc-sidebar flex items-center gap-2">
        <div className="flex-1 min-w-0 overflow-x-auto">
          <div className="flex items-center gap-1.5 min-w-max">
            {quickTerminalTabs.map((tab) => (
              <div
                key={tab.id}
                onClick={() => setActiveQuickTerminalTabId(tab.id)}
                className={`group inline-flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-md text-[11px] font-medium border transition-colors cursor-pointer ${
                  activeQuickTerminalTabId === tab.id
                    ? "text-cc-fg bg-cc-card border-cc-border"
                    : "text-cc-muted bg-transparent border-transparent hover:text-cc-fg hover:bg-cc-hover"
                }`}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setActiveQuickTerminalTabId(tab.id);
                  }
                }}
              >
                <span>{tab.label}</span>
                <button
                  type="button"
                  aria-label={`Close ${tab.label} terminal tab`}
                  onClick={(e) => {
                    e.stopPropagation();
                    closeQuickTerminalTab(tab.id);
                  }}
                  className="w-4 h-4 rounded-sm flex items-center justify-center text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="shrink-0 flex items-center gap-1">
          {cwd && (
            <button
              onClick={() => defaultNewTerminalOpts && openQuickTerminal(defaultNewTerminalOpts)}
              className="px-2 py-1 rounded-md text-[11px] text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
              title={sdkSession?.containerId ? "Open terminal in session container" : "Open terminal on host machine"}
            >
              + Terminal
            </button>
          )}
          <button
            onClick={closeDock}
            className="ml-1 px-2 py-1 rounded-md text-[11px] text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
          >
            {closeLabel}
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0" style={{ background: "var(--terminal-bg, #141413)" }}>
        {quickTerminalTabs.map((tab) => (
          <div key={tab.id} className={activeQuickTerminalTabId === tab.id ? "h-full" : "hidden"}>
            <TerminalView
              cwd={tab.cwd}
              containerId={tab.containerId}
              title={tab.containerId ? `docker:${tab.cwd}` : tab.cwd}
              embedded
              visible={activeQuickTerminalTabId === tab.id}
              hideHeader
            />
          </div>
        ))}
      </div>
    </div>
  );

  const contentArea = terminalOnly ? null : (
    <div className={suppressPanel ? "h-full min-h-0" : layout.contentWrapClass}>{children}</div>
  );

  const terminalAreaClass = terminalOnly
    ? "h-full min-h-0 bg-cc-card"
    : suppressPanel
      ? "absolute inset-0 opacity-0 pointer-events-none"
      : `min-h-0 shrink-0 bg-cc-card ${layout.terminalWrapClass}`;

  if (terminalOnly) {
    return (
      <div className="h-full min-h-0 bg-cc-card">
        {terminalPanel}
      </div>
    );
  }

  return (
    <div className={`h-full min-h-0 ${suppressPanel ? "relative" : `flex ${layout.shellClass}`}`}>
      {contentArea}
      <div className={terminalAreaClass} aria-hidden={suppressPanel ? "true" : undefined}>
        {terminalPanel}
      </div>
    </div>
  );
}
