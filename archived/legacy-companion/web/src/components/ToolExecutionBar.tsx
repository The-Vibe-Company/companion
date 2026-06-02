import { getToolLabel, ToolIcon, getToolIcon } from "./ToolBlock.js";

/**
 * ToolExecutionBar — compact live indicator shown during tool execution.
 * Replaces the plain breathing-dot progress indicator in MessageFeed.
 * Shows each running tool with its icon, label, and live elapsed counter.
 */
export function ToolExecutionBar({
  tools,
}: {
  tools: Array<{ toolName: string; elapsedSeconds: number }>;
}) {
  if (tools.length === 0) return null;

  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-mono-code pl-10 py-1.5 animate-[fadeSlideIn_0.3s_ease-out]"
      role="status"
      aria-label={`${tools.length} tool${tools.length > 1 ? "s" : ""} running`}
    >
      {tools.map((tool, i) => (
        <span key={i} className="inline-flex items-center gap-1.5">
          <span className="relative flex items-center justify-center w-3.5 h-3.5">
            <ToolIcon type={getToolIcon(tool.toolName)} />
            {/* Pulsing ring behind the icon */}
            <span className="absolute inset-0 rounded-full bg-cc-primary/20 animate-[typing-breathe_1.5s_ease-in-out_infinite]" />
          </span>
          <span className="text-cc-fg/70">{getToolLabel(tool.toolName)}</span>
          <span className="text-cc-muted/50 tabular-nums">{tool.elapsedSeconds}s</span>
        </span>
      ))}
    </div>
  );
}
