import { AgentIcon } from "./AgentIcon.js";
import { AgentCardMenu } from "./AgentCardMenu.js";
import { LinearLogo } from "./LinearLogo.js";
import type { AgentInfo } from "../api.js";
import { timeAgo } from "../utils/time-ago.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

export function humanizeSchedule(expression: string, recurring: boolean): string {
  if (!recurring) return "One-time";
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return expression;
  const [minute, hour, , , dayOfWeek] = parts;
  if (expression === "* * * * *") return "Every minute";
  if (hour === "*" && minute.startsWith("*/")) {
    const n = parseInt(minute.slice(2), 10);
    return n === 1 ? "Every minute" : `Every ${n} minutes`;
  }
  if (minute === "0" && hour === "*") return "Every hour";
  if (minute === "0" && hour.startsWith("*/")) {
    const n = parseInt(hour.slice(2), 10);
    return n === 1 ? "Every hour" : `Every ${n} hours`;
  }
  if (minute !== "*" && hour !== "*" && !hour.includes("/") && !hour.includes(",")) {
    const h = parseInt(hour, 10);
    const m = parseInt(minute, 10);
    if (!isNaN(h) && !isNaN(m)) {
      const period = h >= 12 ? "PM" : "AM";
      const displayHour = h === 0 ? 12 : h > 12 ? h - 12 : h;
      const displayMin = m.toString().padStart(2, "0");
      const timeStr = `${displayHour}:${displayMin} ${period}`;
      if (dayOfWeek === "*") return `Daily at ${timeStr}`;
      if (dayOfWeek === "1-5") return `Weekdays at ${timeStr}`;
    }
  }
  return expression;
}

export function getWebhookUrl(agent: AgentInfo, publicUrl: string): string {
  const base = publicUrl || window.location.origin;
  return `${base}/api/agents/${encodeURIComponent(agent.id)}/webhook/${agent.triggers?.webhook?.secret || ""}`;
}

// ─── Agent Card ─────────────────────────────────────────────────────────────

export function AgentCard({
  agent,
  publicUrl: _publicUrl,
  onEdit,
  onDelete,
  onToggle,
  onRun,
  onExport,
  onCopyWebhook,
  onRegenerateSecret,
  copiedWebhook,
}: {
  agent: AgentInfo;
  publicUrl: string;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: () => void;
  onRun: () => void;
  onExport: () => void;
  onCopyWebhook: () => void;
  onRegenerateSecret: () => void;
  copiedWebhook: string | null;
}) {
  const triggers: string[] = ["Manual"];
  if (agent.triggers?.webhook?.enabled) triggers.push("Webhook");
  if (agent.triggers?.schedule?.enabled) {
    triggers.push(humanizeSchedule(
      agent.triggers.schedule.expression,
      agent.triggers.schedule.recurring,
    ));
  }
  if (agent.triggers?.linear?.enabled) triggers.push("Linear Agent");

  const isLinear = agent.triggers?.linear?.enabled;

  return (
    <div className={`
      group relative rounded-xl border bg-cc-card p-4
      transition-all duration-150
      ${agent.enabled
        ? "border-cc-border hover:border-cc-primary/30 hover:shadow-[0_2px_12px_rgba(217,119,87,0.06)]"
        : "border-cc-border/60 opacity-75 hover:opacity-100"
      }
    `}>
      {/* Top row: icon + info + actions */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          {/* Agent icon with status indicator */}
          <div className="relative flex-shrink-0">
            <div className={`${agent.enabled ? "text-cc-primary" : "text-cc-muted"} transition-colors`}>
              <AgentIcon icon={agent.icon || "bot"} className="w-5 h-5" />
            </div>
            {/* Status dot — bottom-right of icon */}
            <span
              className={`absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full ring-2 ring-cc-card ${
                agent.enabled ? "bg-cc-success" : "bg-cc-muted/50"
              }`}
              title={agent.enabled ? "Enabled" : "Disabled"}
              data-testid="status-dot"
            />
          </div>

          {/* Name + badges + description */}
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <h3 className="text-sm font-medium text-cc-fg truncate">{agent.name}</h3>
              <span className="px-1.5 py-0.5 text-[10px] rounded-full bg-cc-hover text-cc-muted font-medium leading-none">
                {agent.backendType === "codex" ? "Codex" : "Claude"}
              </span>
              {isLinear && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded-full bg-violet-500/10 text-violet-400 font-medium leading-none">
                  <LinearLogo className="w-2.5 h-2.5" />
                  Linear
                </span>
              )}
            </div>
            {agent.description && (
              <p className="text-xs text-cc-muted mt-0.5 truncate max-w-md">{agent.description}</p>
            )}
          </div>
        </div>

        {/* Actions — always visible Run + overflow menu */}
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={onRun}
            className="px-2.5 py-1 text-xs font-medium rounded-lg bg-cc-primary text-white hover:bg-cc-primary-hover transition-colors cursor-pointer"
            title="Run agent"
          >
            Run
          </button>
          <AgentCardMenu
            agent={agent}
            copiedWebhook={copiedWebhook}
            onEdit={onEdit}
            onDelete={onDelete}
            onToggle={onToggle}
            onExport={onExport}
            onCopyWebhook={onCopyWebhook}
            onRegenerateSecret={onRegenerateSecret}
          />
        </div>
      </div>

      {/* Footer: trigger badges + stats */}
      <div className="flex items-center justify-between mt-3 pt-3 border-t border-cc-border/40">
        <div className="flex items-center gap-1.5 flex-wrap">
          {triggers.map((t, i) => (
            <span key={i} className="px-2 py-0.5 text-[10px] rounded-full bg-cc-hover text-cc-muted">
              {t}
            </span>
          ))}
        </div>
        <div className="flex items-center gap-3 text-[10px] text-cc-muted">
          {agent.totalRuns > 0 && <span>{agent.totalRuns} run{agent.totalRuns !== 1 ? "s" : ""}</span>}
          {agent.lastRunAt && <span>Last: {timeAgo(agent.lastRunAt)}</span>}
          {agent.nextRunAt && <span>Next: {timeAgo(agent.nextRunAt)}</span>}
        </div>
      </div>
    </div>
  );
}
