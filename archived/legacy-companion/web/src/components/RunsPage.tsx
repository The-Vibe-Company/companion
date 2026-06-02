import { useState, useEffect, useCallback } from "react";
import { api, type AgentExecution, type AgentInfo, type ExecutionListResult } from "../api.js";
import { timeAgo } from "../utils/time-ago.js";

// ─── Types ──────────────────────────────────────────────────────────────────

type TriggerFilter = "all" | "manual" | "webhook" | "schedule" | "linear";
type StatusFilter = "all" | "running" | "success" | "error";

// ─── Helpers ────────────────────────────────────────────────────────────────

function triggerLabel(type: string): string {
  switch (type) {
    case "manual": return "Manual";
    case "webhook": return "Webhook";
    case "schedule": return "Schedule";
    case "linear": return "Linear";
    default: return type;
  }
}

function triggerColor(type: string): string {
  switch (type) {
    case "manual": return "bg-blue-500/10 text-blue-600 dark:text-blue-400";
    case "webhook": return "bg-purple-500/10 text-purple-600 dark:text-purple-400";
    case "schedule": return "bg-amber-500/10 text-amber-600 dark:text-amber-400";
    case "linear": return "bg-violet-500/10 text-violet-600 dark:text-violet-400";
    default: return "bg-cc-hover text-cc-muted";
  }
}

function statusIndicator(exec: AgentExecution): { label: string; color: string } {
  if (exec.error) return { label: "Error", color: "text-cc-error" };
  if (exec.success) return { label: "Success", color: "text-cc-success" };
  if (!exec.completedAt) return { label: "Running", color: "text-cc-warning" };
  return { label: "Unknown", color: "text-cc-muted" };
}

function formatDuration(startedAt: number, completedAt?: number): string {
  const end = completedAt || Date.now();
  const ms = end - startedAt;
  if (ms < 1000) return "<1s";
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.round((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

// ─── Component ──────────────────────────────────────────────────────────────

export function RunsPage() {
  const [executions, setExecutions] = useState<AgentExecution[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [triggerFilter, setTriggerFilter] = useState<TriggerFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [agentFilter, setAgentFilter] = useState<string>("");
  const [selectedExec, setSelectedExec] = useState<AgentExecution | null>(null);

  const fetchExecutions = useCallback(async () => {
    try {
      const opts: Record<string, string | number> = { limit: 100 };
      if (triggerFilter !== "all") opts.triggerType = triggerFilter;
      if (statusFilter !== "all") opts.status = statusFilter;
      if (agentFilter) opts.agentId = agentFilter;

      const result: ExecutionListResult = await api.listExecutions(opts);
      setExecutions(result.executions);
      setTotal(result.total);
    } catch (err) {
      console.error("[runs] Failed to fetch executions:", err);
    } finally {
      setLoading(false);
    }
  }, [triggerFilter, statusFilter, agentFilter]);

  const fetchAgents = useCallback(async () => {
    try {
      const list = await api.listAgents();
      setAgents(list);
    } catch (err) {
      console.error("[runs] Failed to fetch agents:", err);
    }
  }, []);

  useEffect(() => {
    fetchAgents();
  }, [fetchAgents]);

  useEffect(() => {
    fetchExecutions();
    // Auto-refresh every 5 seconds
    const interval = setInterval(fetchExecutions, 5000);
    return () => clearInterval(interval);
  }, [fetchExecutions]);

  const agentName = (agentId: string) => {
    const agent = agents.find((a) => a.id === agentId);
    return agent?.name || agentId;
  };

  return (
    <div className="h-full flex flex-col bg-cc-bg">
      {/* Header */}
      <div className="shrink-0 border-b border-cc-border px-6 py-4">
        <h1 className="text-lg font-semibold text-cc-fg">Runs</h1>
        <p className="text-sm text-cc-muted mt-1">
          Monitor agent executions across all triggers
        </p>
      </div>

      {/* Filters */}
      <div className="shrink-0 border-b border-cc-border px-6 py-3 flex items-center gap-4 flex-wrap">
        {/* Agent filter */}
        <select
          value={agentFilter}
          onChange={(e) => setAgentFilter(e.target.value)}
          className="text-sm rounded-md border border-cc-border bg-cc-input-bg text-cc-fg px-2 py-1"
          aria-label="Filter by agent"
        >
          <option value="">All agents</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>

        {/* Trigger filter pills */}
        <div className="flex items-center gap-1">
          {(["all", "manual", "webhook", "schedule", "linear"] as TriggerFilter[]).map((t) => (
            <button
              key={t}
              onClick={() => setTriggerFilter(t)}
              className={`text-xs px-2.5 py-1 rounded-full transition-colors ${
                triggerFilter === t
                  ? "bg-cc-fg text-cc-bg"
                  : "bg-cc-hover text-cc-muted hover:text-cc-fg"
              }`}
            >
              {t === "all" ? "All triggers" : triggerLabel(t)}
            </button>
          ))}
        </div>

        {/* Status filter pills */}
        <div className="flex items-center gap-1">
          {(["all", "running", "success", "error"] as StatusFilter[]).map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`text-xs px-2.5 py-1 rounded-full transition-colors ${
                statusFilter === s
                  ? "bg-cc-fg text-cc-bg"
                  : "bg-cc-hover text-cc-muted hover:text-cc-fg"
              }`}
            >
              {s === "all" ? "All statuses" : s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>

        <span className="text-xs text-cc-muted ml-auto">
          {total} total
        </span>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="text-sm text-cc-muted text-center py-12">Loading...</div>
        ) : executions.length === 0 ? (
          <div className="text-center py-16">
            <div className="mb-3 flex justify-center text-cc-muted">
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-8 h-8">
                <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm-.75 3.5a.75.75 0 011.5 0v3.19l2.03 2.03a.75.75 0 01-1.06 1.06l-2.25-2.25A.75.75 0 017.25 8V4.5z" />
              </svg>
            </div>
            <p className="text-sm text-cc-muted">No executions found</p>
            <p className="text-xs text-cc-muted mt-1">Run an agent to see executions here</p>
          </div>
        ) : (
          <table className="w-full text-sm" role="table">
            <thead className="sticky top-0 bg-cc-card backdrop-blur">
              <tr className="text-left text-xs text-cc-muted uppercase tracking-wider">
                <th className="px-6 py-2 font-medium">Agent</th>
                <th className="px-4 py-2 font-medium">Trigger</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Started</th>
                <th className="px-4 py-2 font-medium">Duration</th>
                <th className="px-4 py-2 font-medium">Session</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-cc-border/50">
              {executions.map((exec) => {
                const status = statusIndicator(exec);
                const isSelected = selectedExec?.sessionId === exec.sessionId;
                return (
                  <tr
                    key={`${exec.sessionId}-${exec.startedAt}`}
                    onClick={() => setSelectedExec(isSelected ? null : exec)}
                    className={`cursor-pointer transition-colors ${
                      isSelected
                        ? "bg-cc-active"
                        : "hover:bg-cc-hover"
                    }`}
                  >
                    <td className="px-6 py-3">
                      <div className="flex items-center gap-2">
                        <span className="text-cc-fg font-medium">
                          {agentName(exec.agentId)}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${triggerColor(exec.triggerType)}`}>
                        {triggerLabel(exec.triggerType)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`font-medium ${status.color}`}>
                        {!exec.completedAt && !exec.error && (
                          <span className="inline-block w-1.5 h-1.5 rounded-full bg-cc-warning mr-1.5 animate-pulse" />
                        )}
                        {status.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-cc-muted">
                      {timeAgo(exec.startedAt)}
                    </td>
                    <td className="px-4 py-3 text-cc-muted font-mono text-xs">
                      {formatDuration(exec.startedAt, exec.completedAt)}
                    </td>
                    <td className="px-4 py-3">
                      {exec.sessionId && (
                        <a
                          href={`#/session/${exec.sessionId}`}
                          onClick={(e) => e.stopPropagation()}
                          className="text-cc-primary hover:text-cc-primary-hover text-xs font-mono underline"
                        >
                          Open
                        </a>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Detail panel (slide up from bottom when a row is selected) */}
      {selectedExec && (
        <div className="shrink-0 border-t border-cc-border bg-cc-card px-6 py-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold text-cc-fg">
              Execution Details
            </h3>
            <button
              onClick={() => setSelectedExec(null)}
              className="text-cc-muted hover:text-cc-fg text-sm transition-colors"
              aria-label="Close details"
            >
              Close
            </button>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <span className="text-cc-muted">Agent</span>
              <p className="text-cc-fg font-medium">{agentName(selectedExec.agentId)}</p>
            </div>
            <div>
              <span className="text-cc-muted">Trigger</span>
              <p className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${triggerColor(selectedExec.triggerType)}`}>
                {triggerLabel(selectedExec.triggerType)}
              </p>
            </div>
            <div>
              <span className="text-cc-muted">Started</span>
              <p className="text-cc-fg">{new Date(selectedExec.startedAt).toLocaleString()}</p>
            </div>
            <div>
              <span className="text-cc-muted">Duration</span>
              <p className="text-cc-fg font-mono">{formatDuration(selectedExec.startedAt, selectedExec.completedAt)}</p>
            </div>
          </div>
          {selectedExec.error && (
            <div className="mt-3 p-2 bg-cc-error/10 rounded text-sm text-cc-error font-mono whitespace-pre-wrap">
              {selectedExec.error}
            </div>
          )}
          {selectedExec.sessionId && (
            <a
              href={`#/session/${selectedExec.sessionId}`}
              className="mt-3 inline-flex items-center gap-1 text-sm text-cc-primary hover:text-cc-primary-hover"
            >
              Open session to view live output
            </a>
          )}
        </div>
      )}
    </div>
  );
}
