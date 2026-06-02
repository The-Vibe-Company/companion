import { useState, useMemo } from "react";
import type { ToolActivityEntry } from "../store/tasks-slice.js";
import { getToolLabel, ToolIcon, getToolIcon } from "./ToolBlock.js";

/**
 * ToolTurnSummary — compact inline strip summarising tool calls from a turn.
 * Shows total tool count, total time, and optional per-tool breakdown bars.
 * Collapsed by default; click to expand the execution details.
 */
export function ToolTurnSummary({
  entries,
}: {
  entries: ToolActivityEntry[];
}) {
  const [expanded, setExpanded] = useState(false);

  const stats = useMemo(() => {
    const totalTime = entries.reduce((sum, e) => sum + e.elapsedSeconds, 0);
    const maxTime = Math.max(...entries.map((e) => e.elapsedSeconds), 0.1);
    const errorCount = entries.filter((e) => e.isError).length;
    const running = entries.filter((e) => !e.completedAt).length;
    return { totalTime, maxTime, errorCount, running };
  }, [entries]);

  if (entries.length === 0) return null;

  return (
    <div className="pl-10 pr-4 animate-[fadeSlideIn_0.3s_ease-out]">
      <button
        onClick={() => setExpanded(!expanded)}
        className="group flex items-center gap-2 text-[11px] text-cc-muted hover:text-cc-fg/80 transition-colors cursor-pointer py-1 w-full"
        aria-expanded={expanded}
        aria-label={`${entries.length} tools executed in ${stats.totalTime.toFixed(1)}s`}
      >
        {/* Chevron */}
        <svg
          viewBox="0 0 16 16"
          fill="currentColor"
          className={`w-2.5 h-2.5 transition-transform duration-200 shrink-0 ${expanded ? "rotate-90" : ""}`}
        >
          <path d="M6 4l4 4-4 4" />
        </svg>

        {/* Summary line */}
        <span className="font-mono-code flex items-center gap-1.5">
          <span className="text-cc-fg/60 font-medium">
            {entries.length} tool{entries.length > 1 ? "s" : ""}
          </span>
          <span className="text-cc-muted/40">&middot;</span>
          <span className="tabular-nums">{stats.totalTime.toFixed(1)}s</span>
          {stats.errorCount > 0 && (
            <>
              <span className="text-cc-muted/40">&middot;</span>
              <span className="text-cc-error">{stats.errorCount} error{stats.errorCount > 1 ? "s" : ""}</span>
            </>
          )}
          {stats.running > 0 && (
            <>
              <span className="text-cc-muted/40">&middot;</span>
              <span className="text-cc-primary">{stats.running} running</span>
            </>
          )}
        </span>

        {/* Mini inline bar preview (collapsed only) */}
        {!expanded && entries.length > 1 && (
          <span className="hidden sm:flex items-center gap-px ml-auto flex-shrink-0 h-1.5 max-w-[120px]">
            {entries.map((e) => (
              <span
                key={e.toolUseId}
                className={`h-full rounded-full ${
                  e.isError
                    ? "bg-cc-error/40"
                    : e.completedAt
                      ? "bg-cc-success/30"
                      : "bg-cc-primary/40 animate-[typing-breathe_1.5s_ease-in-out_infinite]"
                }`}
                style={{
                  width: `${Math.max(4, (e.elapsedSeconds / stats.maxTime) * 100)}%`,
                  minWidth: "3px",
                }}
                title={`${getToolLabel(e.toolName)} ${e.elapsedSeconds}s`}
              />
            ))}
          </span>
        )}
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="mt-1 mb-2 space-y-1 animate-[fadeSlideIn_0.2s_ease-out]">
          {entries.map((entry) => (
            <ToolActivityRow key={entry.toolUseId} entry={entry} maxTime={stats.maxTime} />
          ))}
        </div>
      )}
    </div>
  );
}

function ToolActivityRow({
  entry,
  maxTime,
}: {
  entry: ToolActivityEntry;
  maxTime: number;
}) {
  const barWidth = Math.max(3, (entry.elapsedSeconds / maxTime) * 100);
  const isRunning = !entry.completedAt;

  return (
    <div className="flex items-center gap-2 text-[11px] font-mono-code group">
      {/* Status dot */}
      <span
        className={`w-1.5 h-1.5 rounded-full shrink-0 ${
          entry.isError
            ? "bg-cc-error"
            : isRunning
              ? "bg-cc-primary animate-[typing-breathe_1.5s_ease-in-out_infinite]"
              : "bg-cc-success/60"
        }`}
      />

      {/* Icon + label */}
      <span className="flex items-center gap-1 shrink-0 w-[100px]">
        <ToolIcon type={getToolIcon(entry.toolName)} />
        <span className="text-cc-fg/70 truncate">{getToolLabel(entry.toolName)}</span>
      </span>

      {/* Duration bar */}
      <span className="flex-1 h-1 bg-cc-border/30 rounded-full overflow-hidden min-w-[40px]">
        <span
          className={`block h-full rounded-full transition-all duration-500 ${
            entry.isError
              ? "bg-cc-error/50"
              : isRunning
                ? "bg-cc-primary/50 animate-[typing-breathe_1.5s_ease-in-out_infinite]"
                : "bg-cc-success/30"
          }`}
          style={{ width: `${barWidth}%` }}
        />
      </span>

      {/* Time */}
      <span className="text-cc-muted/60 tabular-nums shrink-0 w-[40px] text-right">
        {entry.elapsedSeconds.toFixed(1)}s
      </span>

      {/* Preview */}
      {entry.preview && (
        <span className="text-cc-muted/40 truncate max-w-[200px] hidden lg:inline">
          {entry.preview}
        </span>
      )}
    </div>
  );
}
