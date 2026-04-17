import { useStore } from "../store.js";

function barColor(pct: number): string {
  if (pct > 80) return "bg-cc-error";
  if (pct > 50) return "bg-cc-warning";
  return "bg-cc-primary";
}

function barLevel(pct: number): string {
  if (pct > 80) return "critical";
  if (pct > 50) return "elevated";
  return "normal";
}

export function ContextWindowBar({ sessionId }: { sessionId: string }) {
  const contextPct = useStore((s) => s.sessions.get(sessionId)?.context_used_percent ?? 0);

  if (contextPct <= 0) return null;

  const pctClamped = Math.min(contextPct, 100);
  const pctRounded = Math.round(pctClamped);

  return (
    <div
      className="flex items-center gap-1.5 shrink-0"
      title={`Context window: ${pctRounded}% used`}
    >
      <div
        role="meter"
        aria-label={`Context window usage — ${barLevel(pctClamped)}`}
        aria-valuenow={pctRounded}
        aria-valuemin={0}
        aria-valuemax={100}
        className="w-16 h-1.5 rounded-full bg-cc-hover overflow-hidden"
      >
        <div
          className={`h-full rounded-full transition-all duration-500 ${barColor(pctClamped)}`}
          style={{ width: `${pctClamped}%` }}
        />
      </div>
      <span className="text-[10px] text-cc-muted tabular-nums whitespace-nowrap">
        {pctRounded}%
      </span>
    </div>
  );
}
