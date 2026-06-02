import { useState, useEffect, useRef, useCallback } from "react";
import { useStore } from "../store.js";
import type { TaskItem, BackgroundAgentItem } from "../types.js";

const EMPTY_TASKS: TaskItem[] = [];
const EMPTY_AGENTS: BackgroundAgentItem[] = [];
const PANEL_ID = "activity-tray-panel";

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatElapsed(startedAt: number, completedAt?: number): string {
  const elapsed = Math.round(((completedAt || Date.now()) - startedAt) / 1000);
  if (elapsed < 60) return `${elapsed}s`;
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  return `${mins}m${secs > 0 ? ` ${secs}s` : ""}`;
}

/** Auto-hide: returns true when all tasks completed + all agents done, after delay */
function useAutoHide(
  tasks: TaskItem[],
  agents: BackgroundAgentItem[],
  delayMs = 4000,
): boolean {
  const [hidden, setHidden] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const totalCount = tasks.length + agents.length;

  const allResolved =
    totalCount > 0 &&
    tasks.every((t) => t.status === "completed") &&
    agents.every((a) => a.status !== "running");

  useEffect(() => {
    clearTimeout(timerRef.current);
    if (allResolved) {
      timerRef.current = setTimeout(() => setHidden(true), delayMs);
    } else {
      setHidden(false);
    }
    return () => clearTimeout(timerRef.current);
  }, [allResolved, delayMs]);

  // Reset when new entries arrive
  useEffect(() => {
    setHidden(false);
  }, [totalCount]);

  return hidden;
}

/** Single shared 1s tick for all elapsed timers */
function useSecondTick(hasRunning: boolean) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!hasRunning) return;
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, [hasRunning]);
  return tick;
}

// ─── Status Indicators ──────────────────────────────────────────────────────

function StatusDot({ status }: { status: "running" | "completed" | "failed" | "pending" | "in_progress" }) {
  if (status === "running" || status === "in_progress") {
    return (
      <span className="relative flex h-1.5 w-1.5 shrink-0">
        <span className="absolute inline-flex h-full w-full rounded-full bg-cc-warning opacity-75 animate-ping" />
        <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-cc-warning" />
      </span>
    );
  }
  if (status === "completed") {
    return <span className="h-1.5 w-1.5 rounded-full bg-cc-success shrink-0" />;
  }
  if (status === "failed") {
    return <span className="h-1.5 w-1.5 rounded-full bg-cc-error shrink-0" />;
  }
  return <span className="h-1.5 w-1.5 rounded-full bg-cc-muted/30 shrink-0" />;
}

// ─── Agent Row ──────────────────────────────────────────────────────────────

function AgentRow({ agent, tick: _tick }: { agent: BackgroundAgentItem; tick: number }) {
  const [expanded, setExpanded] = useState(false);
  const isComplete = agent.status !== "running";
  const hasDetail = !!agent.summary;

  const row = (
    <>
      <StatusDot status={agent.status} />
      <span className="text-[11px] text-cc-fg/80 truncate flex-1 font-medium">
        {agent.name}
      </span>
      {agent.agentType && (
        <span className="text-[9px] text-cc-muted/50 uppercase tracking-wider shrink-0">
          {agent.agentType}
        </span>
      )}
      <span className="text-[10px] text-cc-muted/50 tabular-nums font-mono-code">
        {formatElapsed(agent.startedAt, agent.completedAt)}
      </span>
    </>
  );

  return (
    <div className={`transition-opacity duration-300 ${isComplete ? "opacity-60" : ""}`}>
      {hasDetail ? (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          className="w-full flex items-center gap-2 px-2.5 min-h-[36px] text-left hover:bg-cc-hover/50 rounded-md transition-colors cursor-pointer"
        >
          {row}
        </button>
      ) : (
        <div className="flex items-center gap-2 px-2.5 min-h-[36px]">
          {row}
        </div>
      )}
      {expanded && agent.summary && (
        <p className="px-2.5 pb-1.5 ml-4 text-[10px] text-cc-muted/60 leading-relaxed line-clamp-3 font-mono-code">
          {agent.summary}
        </p>
      )}
    </div>
  );
}

// ─── Task Row ───────────────────────────────────────────────────────────────

function TrayTaskRow({ task }: { task: TaskItem }) {
  const isCompleted = task.status === "completed";
  const isInProgress = task.status === "in_progress";

  return (
    <div className={`flex items-center gap-2 px-2.5 min-h-[32px] transition-opacity duration-300 ${isCompleted ? "opacity-40" : ""}`}>
      <span className="shrink-0 flex items-center justify-center w-3.5 h-3.5">
        {isInProgress ? (
          <svg className="w-3.5 h-3.5 text-cc-primary animate-spin" viewBox="0 0 16 16" fill="none" aria-hidden>
            <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" strokeDasharray="28" strokeDashoffset="8" strokeLinecap="round" />
          </svg>
        ) : isCompleted ? (
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-cc-success" aria-hidden>
            <path fillRule="evenodd" d="M8 15A7 7 0 108 1a7 7 0 000 14zm3.354-9.354a.5.5 0 00-.708-.708L7 8.586 5.354 6.94a.5.5 0 10-.708.708l2 2a.5.5 0 00.708 0l4-4z" clipRule="evenodd" />
          </svg>
        ) : (
          <svg viewBox="0 0 16 16" fill="none" className="w-3.5 h-3.5 text-cc-muted/40" aria-hidden>
            <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        )}
      </span>

      <span className={`text-[11px] leading-snug flex-1 truncate ${isCompleted ? "text-cc-muted line-through" : "text-cc-fg/80"}`}>
        {task.subject}
      </span>

      {isInProgress && task.activeForm && (
        <span className="text-[10px] text-cc-muted/50 italic truncate max-w-[120px] shrink-0">
          {task.activeForm}
        </span>
      )}
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────

export function ActivityTray({ sessionId }: { sessionId: string }) {
  const [expanded, setExpanded] = useState(false);
  const trayRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const tasks = useStore((s) => s.sessionTasks.get(sessionId) ?? EMPTY_TASKS);
  const bgAgents = useStore((s) => s.sessionBackgroundAgents.get(sessionId) ?? EMPTY_AGENTS);

  const shouldHide = useAutoHide(tasks, bgAgents);

  // Shared tick for all running elapsed timers (M4 optimization)
  const hasRunningAgents = bgAgents.some((a) => a.status === "running");
  const tick = useSecondTick(hasRunningAgents);

  // Stats for the pill
  const runningAgents = bgAgents.filter((a) => a.status === "running").length;
  const totalTasks = tasks.length;
  const completedTasks = tasks.filter((t) => t.status === "completed").length;
  const inProgressTasks = tasks.filter((t) => t.status === "in_progress").length;
  const hasActivity = tasks.length > 0 || bgAgents.length > 0;
  const hasRunningWork = runningAgents > 0 || inProgressTasks > 0;

  const close = useCallback(() => setExpanded(false), []);

  // Escape key to close (C1 fix)
  useEffect(() => {
    if (!expanded) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [expanded, close]);

  // Close tray when clicking outside
  useEffect(() => {
    if (!expanded) return;
    const handleClick = (e: MouseEvent) => {
      if (trayRef.current && !trayRef.current.contains(e.target as Node)) {
        close();
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [expanded, close]);

  // Focus the panel when it opens (keyboard accessibility)
  useEffect(() => {
    if (expanded && panelRef.current) {
      panelRef.current.focus();
    }
  }, [expanded]);

  // Fade-out: shouldHide triggers the CSS opacity transition;
  // dismissed becomes true only after the transition ends, unmounting the component.
  const [dismissed, setDismissed] = useState(false);

  // Reset dismissed when new items arrive
  useEffect(() => {
    if (hasActivity) setDismissed(false);
  }, [hasActivity, tasks.length, bgAgents.length]);

  // Don't render when empty or after fade-out transition completed
  if (!hasActivity) return null;
  if (dismissed) return null;

  return (
    <div
      ref={trayRef}
      className={`absolute bottom-3 right-3 z-20 transition-opacity duration-500 ${
        shouldHide ? "opacity-0 pointer-events-none" : "opacity-100"
      }`}
      style={!shouldHide ? { animation: "fadeSlideIn 0.3s ease-out" } : undefined}
      onTransitionEnd={() => {
        if (shouldHide) setDismissed(true);
      }}
    >
      {/* Expanded panel */}
      {expanded && (
        <div
          ref={panelRef}
          id={PANEL_ID}
          role="dialog"
          aria-label="Activity panel"
          tabIndex={-1}
          className="mb-1.5 w-72 max-w-[calc(100vw-2rem)] max-h-64 overflow-y-auto rounded-xl border border-cc-border/60 bg-cc-surface/95 backdrop-blur-xl shadow-lg shadow-black/20 outline-none"
          style={{ animation: "fadeSlideIn 0.2s ease-out" }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-cc-border/40">
            <span className="text-[11px] font-semibold text-cc-fg/70 uppercase tracking-wider" role="heading" aria-level={3}>
              Activity
            </span>
            <button
              type="button"
              onClick={close}
              className="flex items-center justify-center w-7 h-7 -mr-1 rounded-md text-cc-muted/40 hover:text-cc-muted/70 hover:bg-cc-hover/50 transition-colors cursor-pointer"
              aria-label="Close activity tray"
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                <path d="M4.646 4.646a.5.5 0 01.708 0L8 7.293l2.646-2.647a.5.5 0 01.708.708L8.707 8l2.647 2.646a.5.5 0 01-.708.708L8 8.707l-2.646 2.647a.5.5 0 01-.708-.708L7.293 8 4.646 5.354a.5.5 0 010-.708z" />
              </svg>
            </button>
          </div>

          {/* Background agents section */}
          {bgAgents.length > 0 && (
            <div className="py-1">
              <div className="px-3 py-1" role="heading" aria-level={4}>
                <span className="text-[9px] text-cc-muted/40 uppercase tracking-widest font-semibold">
                  Agents
                </span>
              </div>
              {bgAgents.map((agent) => (
                <AgentRow key={agent.toolUseId} agent={agent} tick={tick} />
              ))}
            </div>
          )}

          {/* Separator */}
          {bgAgents.length > 0 && tasks.length > 0 && (
            <div className="border-t border-cc-border/30 mx-2" role="separator" />
          )}

          {/* Tasks section */}
          {tasks.length > 0 && (
            <div className="py-1">
              <div className="px-3 py-1" role="heading" aria-level={4}>
                <span className="text-[9px] text-cc-muted/40 uppercase tracking-widest font-semibold">
                  Tasks
                </span>
              </div>
              {tasks.map((task) => (
                <TrayTaskRow key={task.id} task={task} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Pill trigger */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        aria-controls={PANEL_ID}
        className={`
          flex items-center gap-2 px-3 min-h-[36px] rounded-full
          border border-cc-border/50 bg-cc-surface/90 backdrop-blur-lg
          shadow-md shadow-black/15
          hover:bg-cc-hover/80 hover:border-cc-border/70
          transition-all duration-200 cursor-pointer
          ${expanded ? "ring-1 ring-cc-primary/30" : ""}
        `}
        aria-label={`Activity: ${runningAgents} agents running, ${completedTasks}/${totalTasks} tasks`}
      >
        {/* Animated indicator */}
        {hasRunningWork ? (
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full rounded-full bg-cc-warning opacity-75 animate-ping" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-cc-warning" />
          </span>
        ) : (
          <span className="h-2 w-2 rounded-full bg-cc-success" />
        )}

        {/* Agents count */}
        {bgAgents.length > 0 && (
          <span className="text-[11px] text-cc-fg/70 font-medium tabular-nums">
            {runningAgents > 0
              ? `${runningAgents} agent${runningAgents !== 1 ? "s" : ""}`
              : `${bgAgents.length} done`}
          </span>
        )}

        {/* Separator dot */}
        {bgAgents.length > 0 && tasks.length > 0 && (
          <span className="w-0.5 h-0.5 rounded-full bg-cc-muted/30" />
        )}

        {/* Tasks count */}
        {tasks.length > 0 && (
          <span className="text-[11px] text-cc-fg/70 tabular-nums">
            {completedTasks}/{totalTasks}
          </span>
        )}

        {/* Chevron */}
        <svg
          viewBox="0 0 16 16"
          fill="currentColor"
          className={`w-2.5 h-2.5 text-cc-muted/40 transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}
          aria-hidden
        >
          <path d="M4 6l4 4 4-4" />
        </svg>
      </button>
    </div>
  );
}
