import { useState, useEffect, useCallback, useRef } from "react";
import { api, type AgentInfo, type AgentExport, type AgentExecution, type McpServerConfigAgent, type CompanionEnv } from "../api.js";
import { getModelsForBackend, getDefaultModel, getAgentModesForBackend, getDefaultAgentMode } from "../utils/backends.js";
import { FolderPicker } from "./FolderPicker.js";
import { timeAgo } from "../utils/time-ago.js";
import type { Route } from "../utils/routing.js";

// ─── Types ──────────────────────────────────────────────────────────────────

interface Props {
  route: Route;
}

interface McpServerFormEntry {
  type: "stdio" | "sse" | "http";
  command: string;
  args: string;
  url: string;
  env: string;
}

interface AgentFormData {
  name: string;
  description: string;
  icon: string;
  backendType: "claude" | "codex";
  model: string;
  permissionMode: string;
  cwd: string;
  prompt: string;
  envSlug: string;
  // Environment variables (key-value pairs)
  env: { key: string; value: string }[];
  // Codex internet access
  codexInternetAccess: boolean;
  // Git
  branch: string;
  createBranch: boolean;
  useWorktree: boolean;
  // MCP Servers
  mcpServers: Record<string, McpServerConfigAgent>;
  // Skills
  skills: string[];
  // Allowed tools
  allowedTools: string[];
  // Triggers
  webhookEnabled: boolean;
  linearEnabled: boolean;
  linearRequireMention: boolean;
  linearMention: string;
  githubEnabled: boolean;
  githubRequireMention: boolean;
  githubMention: string;
  githubOnPullRequest: boolean;
  githubOnComment: boolean;
  triggerSecurityMode: "simple" | "recommended" | "flexible";
  scheduleEnabled: boolean;
  scheduleExpression: string;
  scheduleRecurring: boolean;
}

type QuickTemplate = "manual" | "webhook" | "event-adapter";

const EMPTY_FORM: AgentFormData = {
  name: "",
  description: "",
  icon: "",
  backendType: "claude",
  model: getDefaultModel("claude"),
  permissionMode: getDefaultAgentMode("claude"),
  cwd: "",
  prompt: "",
  envSlug: "",
  env: [],
  codexInternetAccess: false,
  branch: "",
  createBranch: false,
  useWorktree: false,
  mcpServers: {},
  skills: [],
  allowedTools: [],
  webhookEnabled: false,
  linearEnabled: false,
  linearRequireMention: true,
  linearMention: "",
  githubEnabled: false,
  githubRequireMention: true,
  githubMention: "",
  githubOnPullRequest: true,
  githubOnComment: true,
  triggerSecurityMode: "recommended",
  scheduleEnabled: false,
  scheduleExpression: "0 8 * * *",
  scheduleRecurring: true,
};

const CRON_PRESETS: { label: string; value: string }[] = [
  { label: "Every hour", value: "0 * * * *" },
  { label: "Every day at 8am", value: "0 8 * * *" },
  { label: "Every day at noon", value: "0 12 * * *" },
  { label: "Weekdays at 9am", value: "0 9 * * 1-5" },
  { label: "Every Monday at 8am", value: "0 8 * * 1" },
  { label: "Every 30 minutes", value: "*/30 * * * *" },
];

// SVG agent icon definitions — each value is a key used by <AgentIcon>
const AGENT_ICON_OPTIONS = [
  "bot", "terminal", "pencil", "search", "shield", "chart", "flask",
  "rocket", "wrench", "clipboard", "lightbulb", "code", "globe", "zap",
  "database", "git-branch", "mail", "cpu",
] as const;

/** Renders an SVG icon for agent cards and the picker */
function AgentIcon({ icon, className = "w-5 h-5" }: { icon: string; className?: string }) {
  const cls = `${className} shrink-0`;
  const props = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, className: cls, role: "img" as const, "aria-label": icon || "bot" };

  switch (icon) {
    case "bot":
      return <svg {...props}><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="9" cy="16" r="1"/><circle cx="15" cy="16" r="1"/><path d="M12 2v4"/><path d="M8 7h8"/><circle cx="12" cy="2" r="1"/></svg>;
    case "terminal":
      return <svg {...props}><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>;
    case "pencil":
      return <svg {...props}><path d="M17 3a2.83 2.83 0 114 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>;
    case "search":
      return <svg {...props}><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>;
    case "shield":
      return <svg {...props}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>;
    case "chart":
      return <svg {...props}><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>;
    case "flask":
      return <svg {...props}><path d="M9 3h6V8l5 10a1 1 0 01-.9 1.4H4.9A1 1 0 014 18L9 8V3z"/><line x1="9" y1="3" x2="15" y2="3"/></svg>;
    case "rocket":
      return <svg {...props}><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 00-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 012-3.95A12.88 12.88 0 0122 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 01-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></svg>;
    case "wrench":
      return <svg {...props}><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/></svg>;
    case "clipboard":
      return <svg {...props}><path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/></svg>;
    case "lightbulb":
      return <svg {...props}><path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 00-3 13.33V17h6v-1.67A7 7 0 0012 2z"/></svg>;
    case "code":
      return <svg {...props}><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>;
    case "globe":
      return <svg {...props}><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>;
    case "zap":
      return <svg {...props}><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>;
    case "database":
      return <svg {...props}><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>;
    case "git-branch":
      return <svg {...props}><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 01-9 9"/></svg>;
    case "mail":
      return <svg {...props}><rect x="2" y="4" width="20" height="16" rx="2"/><polyline points="22 7 12 13 2 7"/></svg>;
    case "cpu":
      return <svg {...props}><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></svg>;
    default:
      // Fallback for legacy emoji values — render as text
      if (icon) return <span className={className}>{icon}</span>;
      return <svg {...props}><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="9" cy="16" r="1"/><circle cx="15" cy="16" r="1"/><path d="M12 2v4"/><path d="M8 7h8"/><circle cx="12" cy="2" r="1"/></svg>;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function humanizeSchedule(expression: string, recurring: boolean): string {
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

function getWebhookUrl(agent: AgentInfo): string {
  const base = window.location.origin;
  return `${base}/api/agents/${encodeURIComponent(agent.id)}/webhook/${agent.triggers?.webhook?.secret || ""}`;
}

function getLinearHookUrl(agent: AgentInfo): string {
  const base = window.location.origin;
  return `${base}/api/agent-hooks/linear/${encodeURIComponent(agent.id)}/${agent.triggers?.linear?.secret || ""}`;
}

function getGithubHookUrl(agent: AgentInfo): string {
  const base = window.location.origin;
  return `${base}/api/agent-hooks/github/${encodeURIComponent(agent.id)}/${agent.triggers?.github?.secret || ""}`;
}

function getTriggerSecurityLabel(agent: AgentInfo): string {
  const mode = agent.triggers?.webhook?.authMode ?? "url_secret";
  const hmac = agent.triggers?.webhook?.requireHmac ?? false;
  if (mode === "url_secret" && !hmac) return "Simple";
  if (mode === "header_token" && hmac) return "Recommended";
  if (mode === "either" && hmac) return "Flexible";
  return "Custom";
}

function inferSecurityMode(agent: AgentInfo): "simple" | "recommended" | "flexible" {
  const webhook = agent.triggers?.webhook;
  if (!webhook) return "recommended";
  const authMode = webhook.authMode ?? "url_secret";
  const hmac = webhook.requireHmac ?? false;
  if (authMode === "url_secret" && !hmac) return "simple";
  if (authMode === "header_token" && hmac) return "recommended";
  return "flexible";
}

function securityFromMode(mode: "simple" | "recommended" | "flexible"): {
  authMode: "url_secret" | "header_token" | "either";
  requireHmac: boolean;
} {
  if (mode === "simple") return { authMode: "url_secret", requireHmac: false };
  if (mode === "recommended") return { authMode: "header_token", requireHmac: true };
  return { authMode: "either", requireHmac: true };
}

/** Count how many advanced features are configured */
function countAdvancedFeatures(form: AgentFormData): number {
  let count = 0;
  if (Object.keys(form.mcpServers).length > 0) count++;
  if (form.skills.length > 0) count++;
  if (form.allowedTools.length > 0) count++;
  if (form.env.length > 0) count++;
  return count;
}

// ─── Component ──────────────────────────────────────────────────────────────

export function AgentsPage({ route }: Props) {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<"list" | "edit">("list");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<AgentFormData>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [runInputAgent, setRunInputAgent] = useState<AgentInfo | null>(null);
  const [runInput, setRunInput] = useState("");
  const [copiedTriggerValue, setCopiedTriggerValue] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load agents
  const loadAgents = useCallback(async () => {
    try {
      const list = await api.listAgents();
      setAgents(list);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAgents();
  }, [loadAgents]);

  // Handle route-based navigation to agent detail
  useEffect(() => {
    if (route.page === "agent-detail" && "agentId" in route) {
      const agent = agents.find((a) => a.id === route.agentId);
      if (agent) {
        startEdit(agent);
      }
    }
  }, [route, agents]);

  // ── Form helpers ──

  function startCreate() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setError("");
    setView("edit");
  }

  function startCreateFromTemplate(template: QuickTemplate) {
    setEditingId(null);
    if (template === "manual") {
      setForm({
        ...EMPTY_FORM,
        name: "New Manual Agent",
        triggerSecurityMode: "recommended",
      });
    } else if (template === "webhook") {
      setForm({
        ...EMPTY_FORM,
        name: "New Webhook Agent",
        webhookEnabled: true,
        triggerSecurityMode: "recommended",
        prompt: "You are an autonomous agent.\n\nTask:\n{{input}}",
      });
    } else {
      setForm({
        ...EMPTY_FORM,
        name: "New Event Agent",
        webhookEnabled: true,
        linearEnabled: true,
        githubEnabled: true,
        triggerSecurityMode: "recommended",
        prompt: "You are an autonomous agent reacting to events.\n\nEvent context:\n{{input}}",
      });
    }
    setError("");
    setView("edit");
  }

  function startEdit(agent: AgentInfo) {
    setEditingId(agent.id);
    setForm({
      name: agent.name,
      description: agent.description,
      icon: agent.icon || "",
      backendType: agent.backendType,
      model: agent.model,
      permissionMode: agent.permissionMode,
      cwd: agent.cwd === "temp" ? "" : agent.cwd,
      prompt: agent.prompt,
      envSlug: agent.envSlug || "",
      env: agent.env
        ? Object.entries(agent.env).map(([key, value]) => ({ key, value }))
        : [],
      codexInternetAccess: agent.codexInternetAccess ?? false,
      branch: agent.branch || "",
      createBranch: agent.createBranch ?? false,
      useWorktree: agent.useWorktree ?? false,
      mcpServers: agent.mcpServers || {},
      skills: agent.skills || [],
      allowedTools: agent.allowedTools || [],
      webhookEnabled: agent.triggers?.webhook?.enabled ?? false,
      linearEnabled: agent.triggers?.linear?.enabled ?? false,
      linearRequireMention: agent.triggers?.linear?.requireMention ?? true,
      linearMention: agent.triggers?.linear?.mention || "",
      githubEnabled: agent.triggers?.github?.enabled ?? false,
      githubRequireMention: agent.triggers?.github?.requireMention ?? true,
      githubMention: agent.triggers?.github?.mention || "",
      githubOnPullRequest: (agent.triggers?.github?.events ?? ["pull_request", "issue_comment", "pull_request_review_comment"])
        .includes("pull_request"),
      githubOnComment: (agent.triggers?.github?.events ?? ["pull_request", "issue_comment", "pull_request_review_comment"])
        .includes("issue_comment"),
      triggerSecurityMode: inferSecurityMode(agent),
      scheduleEnabled: agent.triggers?.schedule?.enabled ?? false,
      scheduleExpression: agent.triggers?.schedule?.expression || "0 8 * * *",
      scheduleRecurring: agent.triggers?.schedule?.recurring ?? true,
    });
    setError("");
    setView("edit");
  }

  function cancelEdit() {
    setView("list");
    setEditingId(null);
    setError("");
    window.location.hash = "#/agents";
  }

  async function handleSave() {
    setSaving(true);
    setError("");
    try {
      // Build env record from key-value pairs, omitting empty keys
      const envRecord: Record<string, string> = {};
      for (const { key, value } of form.env) {
        if (key.trim()) envRecord[key.trim()] = value;
      }

      const security = securityFromMode(form.triggerSecurityMode);
      const data: Partial<AgentInfo> = {
        version: 1,
        name: form.name,
        description: form.description,
        icon: form.icon || undefined,
        backendType: form.backendType,
        model: form.model,
        permissionMode: form.permissionMode,
        cwd: form.cwd || "temp",
        prompt: form.prompt,
        envSlug: form.envSlug || undefined,
        env: Object.keys(envRecord).length > 0 ? envRecord : undefined,
        codexInternetAccess: form.backendType === "codex" ? form.codexInternetAccess : undefined,
        branch: form.branch || undefined,
        createBranch: form.branch ? form.createBranch : undefined,
        useWorktree: form.branch ? form.useWorktree : undefined,
        mcpServers: Object.keys(form.mcpServers).length > 0 ? form.mcpServers : undefined,
        skills: form.skills.length > 0 ? form.skills : undefined,
        allowedTools: form.allowedTools.length > 0 ? form.allowedTools : undefined,
        enabled: true,
        triggers: {
          webhook: {
            enabled: form.webhookEnabled,
            secret: "",
            authMode: security.authMode,
            requireHmac: security.requireHmac,
          },
          linear: {
            enabled: form.linearEnabled,
            secret: "",
            authMode: security.authMode,
            requireHmac: security.requireHmac,
            requireMention: form.linearRequireMention,
            mention: form.linearMention.trim() || undefined,
          },
          github: {
            enabled: form.githubEnabled,
            secret: "",
            authMode: security.authMode,
            requireHmac: security.requireHmac,
            requireMention: form.githubRequireMention,
            mention: form.githubMention.trim() || undefined,
            events: [
              form.githubOnPullRequest ? "pull_request" : null,
              form.githubOnComment ? "issue_comment" : null,
              form.githubOnComment ? "pull_request_review_comment" : null,
            ].filter(Boolean) as Array<"pull_request" | "issue_comment" | "pull_request_review_comment">,
          },
          schedule: {
            enabled: form.scheduleEnabled,
            expression: form.scheduleExpression,
            recurring: form.scheduleRecurring,
          },
        },
      };

      if (editingId) {
        await api.updateAgent(editingId, data);
      } else {
        await api.createAgent(data);
      }

      await loadAgents();
      setView("list");
      setEditingId(null);
      window.location.hash = "#/agents";
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this agent?")) return;
    try {
      await api.deleteAgent(id);
      await loadAgents();
    } catch {
      // ignore
    }
  }

  async function handleToggle(id: string) {
    try {
      await api.toggleAgent(id);
      await loadAgents();
    } catch {
      // ignore
    }
  }

  async function handleRun(agent: AgentInfo, input?: string) {
    try {
      await api.runAgent(agent.id, input);
      setRunInputAgent(null);
      setRunInput("");
      await loadAgents();
    } catch {
      // ignore
    }
  }

  function handleRunClick(agent: AgentInfo) {
    if (agent.prompt.includes("{{input}}")) {
      setRunInputAgent(agent);
      setRunInput("");
    } else {
      handleRun(agent);
    }
  }

  async function handleExport(agent: AgentInfo) {
    try {
      const exported = await api.exportAgent(agent.id);
      const blob = new Blob([JSON.stringify(exported, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${agent.id}.agent.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      // ignore
    }
  }

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text) as AgentExport;
      await api.importAgent(data);
      await loadAgents();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to import agent");
    }
    // Reset file input
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function copyTriggerUrl(agent: AgentInfo, provider: "webhook" | "linear" | "github") {
    const url = provider === "webhook"
      ? getWebhookUrl(agent)
      : provider === "linear"
        ? getLinearHookUrl(agent)
        : getGithubHookUrl(agent);
    navigator.clipboard.writeText(url).then(() => {
      setCopiedTriggerValue(`${agent.id}:${provider}:url`);
      setTimeout(() => setCopiedTriggerValue(null), 2000);
    });
  }

  function copyTriggerHeader(agent: AgentInfo, provider: "webhook" | "linear" | "github") {
    const token = provider === "webhook"
      ? agent.triggers?.webhook?.token
      : provider === "linear"
        ? agent.triggers?.linear?.token
        : agent.triggers?.github?.token;
    if (!token) return;
    navigator.clipboard.writeText(`Authorization: Bearer ${token}`).then(() => {
      setCopiedTriggerValue(`${agent.id}:${provider}:header`);
      setTimeout(() => setCopiedTriggerValue(null), 2000);
    });
  }

  async function handleRegenerateSecret(id: string) {
    if (!confirm("Regenerate trigger secret(s)? Existing webhook URLs will stop working.")) return;
    try {
      const agent = agents.find((a) => a.id === id);
      if (!agent) return;
      const providers: Array<"webhook" | "linear" | "github"> = [];
      if (agent.triggers?.webhook?.enabled) providers.push("webhook");
      if (agent.triggers?.linear?.enabled) providers.push("linear");
      if (agent.triggers?.github?.enabled) providers.push("github");

      if (providers.length === 0) {
        await api.regenerateAgentWebhookSecret(id);
      } else {
        for (const provider of providers) {
          await api.regenerateAgentTriggerSecret(id, provider);
          const authMode = provider === "webhook"
            ? agent.triggers?.webhook?.authMode
            : provider === "linear"
              ? agent.triggers?.linear?.authMode
              : agent.triggers?.github?.authMode;
          if (authMode === "header_token" || authMode === "either") {
            await api.regenerateAgentTriggerToken(id, provider);
          }
        }
      }
      await loadAgents();
    } catch {
      // ignore
    }
  }

  // ── Render ──

  if (view === "edit") {
    return <AgentEditor
      form={form}
      setForm={setForm}
      editingId={editingId}
      error={error}
      saving={saving}
      onSave={handleSave}
      onCancel={cancelEdit}
    />;
  }

  return (
    <div className="h-full overflow-y-auto bg-cc-bg">
      <div className="max-w-4xl mx-auto p-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-lg font-semibold text-cc-fg">Agency</h1>
            <p className="text-xs text-cc-muted mt-0.5">Create autonomous companions with manual runs, public webhooks, and optional event-source adapters.</p>
          </div>
          <div className="flex gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".json"
              onChange={handleImport}
              className="hidden"
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              className="px-3 py-1.5 text-xs rounded-lg border border-cc-border text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
            >
              Import
            </button>
            <button
              onClick={startCreate}
              className="px-3 py-1.5 text-xs rounded-lg bg-cc-primary text-white hover:bg-cc-primary-hover transition-colors cursor-pointer"
            >
              + New Agent
            </button>
          </div>
        </div>

        <div className="mb-6 rounded-xl border border-cc-border bg-cc-card p-4">
          <p className="text-xs text-cc-muted mb-3">Quick Setup</p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <button
              onClick={() => startCreateFromTemplate("manual")}
              className="text-left rounded-lg border border-cc-border px-3 py-2 hover:border-cc-primary/50 hover:bg-cc-hover transition-colors cursor-pointer"
            >
              <p className="text-xs text-cc-fg">1. Manual Agent</p>
              <p className="text-[10px] text-cc-muted mt-0.5">Run from UI only</p>
            </button>
            <button
              onClick={() => startCreateFromTemplate("webhook")}
              className="text-left rounded-lg border border-cc-border px-3 py-2 hover:border-cc-primary/50 hover:bg-cc-hover transition-colors cursor-pointer"
            >
              <p className="text-xs text-cc-fg">2. Public Webhook</p>
              <p className="text-[10px] text-cc-muted mt-0.5">Bearer + HMAC preset</p>
            </button>
            <button
              onClick={() => startCreateFromTemplate("event-adapter")}
              className="text-left rounded-lg border border-cc-border px-3 py-2 hover:border-cc-primary/50 hover:bg-cc-hover transition-colors cursor-pointer"
            >
              <p className="text-xs text-cc-fg">3. Event Adapter</p>
              <p className="text-[10px] text-cc-muted mt-0.5">Linear/GitHub examples on</p>
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-4 px-3 py-2 rounded-lg bg-cc-error/10 border border-cc-error/30 text-cc-error text-xs">
            {error}
          </div>
        )}

        {/* Agent Cards */}
        {loading ? (
          <div className="text-sm text-cc-muted">Loading...</div>
        ) : agents.length === 0 ? (
          <div className="text-center py-16">
            <div className="mb-3 flex justify-center text-cc-muted">
              <AgentIcon icon="bot" className="w-8 h-8" />
            </div>
            <p className="text-sm text-cc-muted">No agents yet</p>
            <p className="text-xs text-cc-muted mt-1">Create an agent to get started, or import a shared JSON config.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {agents.map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                onEdit={() => startEdit(agent)}
                onDelete={() => handleDelete(agent.id)}
                onToggle={() => handleToggle(agent.id)}
                onRun={() => handleRunClick(agent)}
                onExport={() => handleExport(agent)}
                onCopyWebhook={() => copyTriggerUrl(agent, "webhook")}
                onCopyLinear={() => copyTriggerUrl(agent, "linear")}
                onCopyGithub={() => copyTriggerUrl(agent, "github")}
                onCopyWebhookHeader={() => copyTriggerHeader(agent, "webhook")}
                onCopyLinearHeader={() => copyTriggerHeader(agent, "linear")}
                onCopyGithubHeader={() => copyTriggerHeader(agent, "github")}
                onRegenerateSecret={() => handleRegenerateSecret(agent.id)}
                copiedWebhook={copiedTriggerValue === `${agent.id}:webhook:url`}
                copiedLinear={copiedTriggerValue === `${agent.id}:linear:url`}
                copiedGithub={copiedTriggerValue === `${agent.id}:github:url`}
                copiedWebhookHeader={copiedTriggerValue === `${agent.id}:webhook:header`}
                copiedLinearHeader={copiedTriggerValue === `${agent.id}:linear:header`}
                copiedGithubHeader={copiedTriggerValue === `${agent.id}:github:header`}
              />
            ))}
          </div>
        )}
      </div>

      {/* Run Input Modal */}
      {runInputAgent && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => setRunInputAgent(null)}
        >
          <div
            className="bg-cc-card rounded-[14px] shadow-2xl p-6 w-full max-w-lg border border-cc-border"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-medium text-cc-fg mb-1">Run {runInputAgent.name}</h3>
            <p className="text-xs text-cc-muted mb-3">This agent's prompt uses {"{{input}}"} — provide the input below.</p>
            <textarea
              value={runInput}
              onChange={(e) => setRunInput(e.target.value)}
              placeholder="Enter input for the agent..."
              className="w-full px-3 py-2 rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg text-sm resize-none h-24 focus:outline-none focus:ring-1 focus:ring-cc-primary"
              autoFocus
            />
            <div className="flex justify-end gap-2 mt-3">
              <button
                onClick={() => setRunInputAgent(null)}
                className="px-3 py-1.5 text-xs rounded-lg border border-cc-border text-cc-muted hover:text-cc-fg transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={() => handleRun(runInputAgent, runInput)}
                className="px-3 py-1.5 text-xs rounded-lg bg-cc-primary text-white hover:bg-cc-primary-hover transition-colors cursor-pointer"
              >
                Run
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Agent Card ─────────────────────────────────────────────────────────────

function AgentCard({
  agent,
  onEdit,
  onDelete,
  onToggle,
  onRun,
  onExport,
  onCopyWebhook,
  onCopyLinear,
  onCopyGithub,
  onCopyWebhookHeader,
  onCopyLinearHeader,
  onCopyGithubHeader,
  onRegenerateSecret,
  copiedWebhook,
  copiedLinear,
  copiedGithub,
  copiedWebhookHeader,
  copiedLinearHeader,
  copiedGithubHeader,
}: {
  agent: AgentInfo;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: () => void;
  onRun: () => void;
  onExport: () => void;
  onCopyWebhook: () => void;
  onCopyLinear: () => void;
  onCopyGithub: () => void;
  onCopyWebhookHeader: () => void;
  onCopyLinearHeader: () => void;
  onCopyGithubHeader: () => void;
  onRegenerateSecret: () => void;
  copiedWebhook: boolean;
  copiedLinear: boolean;
  copiedGithub: boolean;
  copiedWebhookHeader: boolean;
  copiedLinearHeader: boolean;
  copiedGithubHeader: boolean;
}) {
  const triggers: string[] = ["Manual"];
  if (agent.triggers?.webhook?.enabled) triggers.push("Webhook");
  if (agent.triggers?.linear?.enabled) triggers.push("Linear");
  if (agent.triggers?.github?.enabled) triggers.push("GitHub");
  if (agent.triggers?.schedule?.enabled) {
    triggers.push(humanizeSchedule(
      agent.triggers.schedule.expression,
      agent.triggers.schedule.recurring,
    ));
  }

  return (
    <div className="rounded-xl border border-cc-border bg-cc-card p-4 hover:border-cc-primary/30 transition-colors">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex-shrink-0 text-cc-primary">
            <AgentIcon icon={agent.icon || "bot"} className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-medium text-cc-fg truncate">{agent.name}</h3>
              <span className={`px-1.5 py-0.5 text-[10px] rounded-full font-medium ${agent.enabled ? "bg-cc-success/15 text-cc-success" : "bg-cc-muted/15 text-cc-muted"}`}>
                {agent.enabled ? "Enabled" : "Disabled"}
              </span>
              <span className="px-1.5 py-0.5 text-[10px] rounded-full bg-cc-hover text-cc-muted">
                {agent.backendType === "codex" ? "Codex" : "Claude"}
              </span>
            </div>
            {agent.description && (
              <p className="text-xs text-cc-muted mt-0.5 truncate">{agent.description}</p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1.5 flex-shrink-0 ml-3">
          <button
            onClick={onRun}
            className="px-2.5 py-1 text-xs rounded-lg bg-cc-primary text-white hover:bg-cc-primary-hover transition-colors cursor-pointer"
            title="Run agent"
          >
            Run
          </button>
          <button
            onClick={onEdit}
            className="p-1.5 rounded-lg text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
            title="Edit"
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
              <path d="M11.013 1.427a1.75 1.75 0 012.474 0l1.086 1.086a1.75 1.75 0 010 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 01-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61z" />
            </svg>
          </button>
          <button
            onClick={onExport}
            className="p-1.5 rounded-lg text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
            title="Export JSON"
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
              <path d="M3.5 13a.5.5 0 01-.5-.5V11h1v1h8v-1h1v1.5a.5.5 0 01-.5.5h-9zM8 2a.5.5 0 01.5.5v6.793l2.146-2.147a.5.5 0 01.708.708l-3 3a.5.5 0 01-.708 0l-3-3a.5.5 0 01.708-.708L7.5 9.293V2.5A.5.5 0 018 2z" />
            </svg>
          </button>
          <button
            onClick={onToggle}
            className="p-1.5 rounded-lg text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
            title={agent.enabled ? "Disable" : "Enable"}
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
              {agent.enabled ? (
                <path d="M5 3a5 5 0 000 10h6a5 5 0 000-10H5zm6 3a2 2 0 110 4 2 2 0 010-4z" />
              ) : (
                <path d="M11 3a5 5 0 010 10H5A5 5 0 015 3h6zM5 6a2 2 0 100 4 2 2 0 000-4z" />
              )}
            </svg>
          </button>
          <button
            onClick={onDelete}
            className="p-1.5 rounded-lg text-cc-muted hover:text-cc-error hover:bg-cc-error/10 transition-colors cursor-pointer"
            title="Delete"
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
              <path d="M5.5 5.5a.5.5 0 01.5.5v6a.5.5 0 01-1 0V6a.5.5 0 01.5-.5zm5 0a.5.5 0 01.5.5v6a.5.5 0 01-1 0V6a.5.5 0 01.5-.5zm-7-3A1.5 1.5 0 015 1h6a1.5 1.5 0 011.5 1.5H14a.5.5 0 010 1h-.554L12.2 14.118A1.5 1.5 0 0110.706 15H5.294a1.5 1.5 0 01-1.494-.882L2.554 3.5H2a.5.5 0 010-1h1.5z" />
            </svg>
          </button>
        </div>
      </div>

      {/* Trigger badges + stats */}
      <div className="flex items-center justify-between mt-3 pt-3 border-t border-cc-border/50">
        <div className="flex items-center gap-1.5 flex-wrap">
          {triggers.map((t, i) => (
            <span key={i} className="px-2 py-0.5 text-[10px] rounded-full bg-cc-hover text-cc-muted">
              {t}
            </span>
          ))}
          {agent.triggers?.webhook?.enabled && (
            <button
              onClick={onCopyWebhook}
              className="px-2 py-0.5 text-[10px] rounded-full bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 transition-colors cursor-pointer"
              title="Copy webhook URL"
            >
              {copiedWebhook ? "Copied!" : "Copy URL"}
            </button>
          )}
          {!!agent.triggers?.webhook?.token && (
            <button
              onClick={onCopyWebhookHeader}
              className="px-2 py-0.5 text-[10px] rounded-full bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 transition-colors cursor-pointer"
              title="Copy webhook auth header"
            >
              {copiedWebhookHeader ? "Copied!" : "Auth Header"}
            </button>
          )}
          {agent.triggers?.linear?.enabled && (
            <button
              onClick={onCopyLinear}
              className="px-2 py-0.5 text-[10px] rounded-full bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-colors cursor-pointer"
              title="Copy Linear hook URL"
            >
              {copiedLinear ? "Copied!" : "Linear URL"}
            </button>
          )}
          {!!agent.triggers?.linear?.token && (
            <button
              onClick={onCopyLinearHeader}
              className="px-2 py-0.5 text-[10px] rounded-full bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-colors cursor-pointer"
              title="Copy Linear auth header"
            >
              {copiedLinearHeader ? "Copied!" : "Linear Auth"}
            </button>
          )}
          {agent.triggers?.github?.enabled && (
            <button
              onClick={onCopyGithub}
              className="px-2 py-0.5 text-[10px] rounded-full bg-orange-500/10 text-orange-400 hover:bg-orange-500/20 transition-colors cursor-pointer"
              title="Copy GitHub hook URL"
            >
              {copiedGithub ? "Copied!" : "GitHub URL"}
            </button>
          )}
          {!!agent.triggers?.github?.token && (
            <button
              onClick={onCopyGithubHeader}
              className="px-2 py-0.5 text-[10px] rounded-full bg-orange-500/10 text-orange-400 hover:bg-orange-500/20 transition-colors cursor-pointer"
              title="Copy GitHub auth header"
            >
              {copiedGithubHeader ? "Copied!" : "GitHub Auth"}
            </button>
          )}
          {(agent.triggers?.webhook?.enabled || agent.triggers?.linear?.enabled || agent.triggers?.github?.enabled) && (
            <button
              onClick={onRegenerateSecret}
              className="px-2 py-0.5 text-[10px] rounded-full bg-cc-hover text-cc-muted hover:text-cc-fg transition-colors cursor-pointer"
              title="Regenerate trigger secret"
            >
              Rotate secret
            </button>
          )}
          <span className="px-2 py-0.5 text-[10px] rounded-full bg-cc-hover text-cc-muted">
            Security: {getTriggerSecurityLabel(agent)}
          </span>
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

// ─── Agent Editor ───────────────────────────────────────────────────────────

function AgentEditor({
  form,
  setForm,
  editingId,
  error,
  saving,
  onSave,
  onCancel,
}: {
  form: AgentFormData;
  setForm: (f: AgentFormData | ((prev: AgentFormData) => AgentFormData)) => void;
  editingId: string | null;
  error: string;
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  const models = getModelsForBackend(form.backendType);
  const modes = getAgentModesForBackend(form.backendType);
  const [showFolderPicker, setShowFolderPicker] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(() => countAdvancedFeatures(form) > 0);
  const [showMcpForm, setShowMcpForm] = useState(false);
  const [mcpFormName, setMcpFormName] = useState("");
  const [mcpFormData, setMcpFormData] = useState<McpServerFormEntry>({
    type: "stdio",
    command: "",
    args: "",
    url: "",
    env: "",
  });
  const [availableSkills, setAvailableSkills] = useState<{ slug: string; name: string; description: string }[]>([]);
  const [envProfiles, setEnvProfiles] = useState<CompanionEnv[]>([]);
  const [allowedToolInput, setAllowedToolInput] = useState("");
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [showModeDropdown, setShowModeDropdown] = useState(false);
  const [showEnvDropdown, setShowEnvDropdown] = useState(false);
  const [showBranchInput, setShowBranchInput] = useState(!!form.branch);
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const iconPickerRef = useRef<HTMLDivElement>(null);
  const modelDropdownRef = useRef<HTMLDivElement>(null);
  const modeDropdownRef = useRef<HTMLDivElement>(null);
  const envDropdownRef = useRef<HTMLDivElement>(null);

  // Fetch skills and env profiles on mount
  useEffect(() => {
    api.listSkills().then(setAvailableSkills).catch(() => {});
    api.listEnvs().then(setEnvProfiles).catch(() => {});
  }, []);

  function updateField<K extends keyof AgentFormData>(key: K, value: AgentFormData[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function handleBackendChange(backend: "claude" | "codex") {
    setForm((prev) => ({
      ...prev,
      backendType: backend,
      model: getDefaultModel(backend),
      permissionMode: getDefaultAgentMode(backend),
    }));
  }

  // ── Env vars helpers ──
  function addEnvVar() {
    setForm((prev) => ({ ...prev, env: [...prev.env, { key: "", value: "" }] }));
  }
  function updateEnvVar(index: number, field: "key" | "value", val: string) {
    setForm((prev) => {
      const updated = [...prev.env];
      updated[index] = { ...updated[index], [field]: val };
      return { ...prev, env: updated };
    });
  }
  function removeEnvVar(index: number) {
    setForm((prev) => ({ ...prev, env: prev.env.filter((_, i) => i !== index) }));
  }

  // ── MCP server helpers ──
  function addMcpServer() {
    if (!mcpFormName.trim()) return;
    const entry: McpServerConfigAgent = { type: mcpFormData.type };
    if (mcpFormData.type === "stdio") {
      entry.command = mcpFormData.command;
      entry.args = mcpFormData.args ? mcpFormData.args.split(" ").filter(Boolean) : undefined;
    } else {
      entry.url = mcpFormData.url;
    }
    if (mcpFormData.env.trim()) {
      try {
        entry.env = JSON.parse(mcpFormData.env);
      } catch { /* ignore parse errors */ }
    }
    setForm((prev) => ({
      ...prev,
      mcpServers: { ...prev.mcpServers, [mcpFormName.trim()]: entry },
    }));
    setMcpFormName("");
    setMcpFormData({ type: "stdio", command: "", args: "", url: "", env: "" });
    setShowMcpForm(false);
  }
  function removeMcpServer(name: string) {
    setForm((prev) => {
      const updated = { ...prev.mcpServers };
      delete updated[name];
      return { ...prev, mcpServers: updated };
    });
  }

  // ── Skills toggle ──
  function toggleSkill(slug: string) {
    setForm((prev) => ({
      ...prev,
      skills: prev.skills.includes(slug)
        ? prev.skills.filter((s) => s !== slug)
        : [...prev.skills, slug],
    }));
  }

  // ── Allowed tools helpers ──
  function addAllowedTool(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && allowedToolInput.trim()) {
      e.preventDefault();
      const tool = allowedToolInput.trim();
      if (!form.allowedTools.includes(tool)) {
        updateField("allowedTools", [...form.allowedTools, tool]);
      }
      setAllowedToolInput("");
    }
  }
  function removeAllowedTool(tool: string) {
    updateField("allowedTools", form.allowedTools.filter((t) => t !== tool));
  }

  // ── Click-outside handlers for dropdowns ──
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(e.target as Node)) {
        setShowModelDropdown(false);
      }
      if (modeDropdownRef.current && !modeDropdownRef.current.contains(e.target as Node)) {
        setShowModeDropdown(false);
      }
      if (envDropdownRef.current && !envDropdownRef.current.contains(e.target as Node)) {
        setShowEnvDropdown(false);
      }
      if (iconPickerRef.current && !iconPickerRef.current.contains(e.target as Node)) {
        setIconPickerOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Derive labels for pills
  const selectedModel = models.find((m) => m.value === form.model) || models[0];
  const selectedMode = modes.find((m) => m.value === form.permissionMode) || modes[0];
  const selectedEnv = envProfiles.find((e) => e.slug === form.envSlug);
  const folderLabel = form.cwd ? form.cwd.split("/").pop() || form.cwd : "temp";

  // Common pill class
  const pill = "flex items-center gap-1.5 px-2 py-1 text-xs rounded-md transition-colors cursor-pointer";
  const pillDefault = `${pill} text-cc-muted hover:text-cc-fg hover:bg-cc-hover`;
  const pillActive = `${pill} text-cc-primary bg-cc-primary/10 hover:bg-cc-primary/15`;

  return (
    <div className="h-full overflow-y-auto bg-cc-bg">
      <div className="max-w-3xl mx-auto p-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <button
              onClick={onCancel}
              className="p-1.5 rounded-lg text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                <path d="M11 2L5 8l6 6" stroke="currentColor" strokeWidth="2" fill="none" />
              </svg>
            </button>
            <h1 className="text-lg font-semibold text-cc-fg">
              {editingId ? "Edit Agent" : "New Agent"}
            </h1>
          </div>
          <div className="flex gap-2">
            <button
              onClick={onCancel}
              className="px-3 py-1.5 text-xs rounded-lg border border-cc-border text-cc-muted hover:text-cc-fg transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={onSave}
              disabled={saving || !form.name.trim() || !form.prompt.trim()}
              className="px-3 py-1.5 text-xs rounded-lg bg-cc-primary text-white hover:bg-cc-primary-hover transition-colors disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
            >
              {saving ? "Saving..." : editingId ? "Save" : "Create"}
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-4 px-3 py-2 rounded-lg bg-cc-error/10 border border-cc-error/30 text-cc-error text-xs">
            {error}
          </div>
        )}

        <div className="space-y-5">
          {/* ── Identity ── */}
          <div className="flex gap-3 items-start">
            {/* Icon picker popover */}
            <div ref={iconPickerRef} className="relative flex-shrink-0">
              <button
                type="button"
                onClick={() => setIconPickerOpen(!iconPickerOpen)}
                className="w-10 h-10 rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg flex items-center justify-center hover:border-cc-primary/50 focus:outline-none focus:ring-1 focus:ring-cc-primary transition-colors"
                aria-label="Choose agent icon"
              >
                <AgentIcon icon={form.icon || "bot"} className="w-5 h-5" />
              </button>
              {iconPickerOpen && (
                <div className="absolute top-12 left-0 z-50 bg-cc-card border border-cc-border rounded-lg shadow-lg p-2 grid grid-cols-6 gap-1 w-[216px]">
                  {AGENT_ICON_OPTIONS.map((ic) => (
                    <button
                      key={ic}
                      type="button"
                      onClick={() => { updateField("icon", ic); setIconPickerOpen(false); }}
                      className={`w-8 h-8 rounded-md flex items-center justify-center transition-colors ${
                        form.icon === ic ? "bg-cc-primary/20 ring-1 ring-cc-primary" : "hover:bg-cc-hover"
                      }`}
                      title={ic}
                    >
                      <AgentIcon icon={ic} className="w-4 h-4 text-cc-fg" />
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="flex-1 space-y-2">
              <input
                value={form.name}
                onChange={(e) => updateField("name", e.target.value)}
                placeholder="Agent name *"
                className="w-full px-3 py-2 rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg text-sm focus:outline-none focus:ring-1 focus:ring-cc-primary"
              />
              <input
                value={form.description}
                onChange={(e) => updateField("description", e.target.value)}
                placeholder="Short description (optional)"
                className="w-full px-3 py-1.5 rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg text-xs focus:outline-none focus:ring-1 focus:ring-cc-primary"
              />
            </div>
          </div>

          {/* ── Prompt ── */}
          <div>
            <textarea
              value={form.prompt}
              onChange={(e) => updateField("prompt", e.target.value)}
              placeholder={"System prompt *\nWrite the agent's instructions here.\nUse {{input}} as a placeholder for trigger-provided input."}
              className="w-full px-3 py-2 rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg text-sm resize-none h-40 font-mono-code focus:outline-none focus:ring-1 focus:ring-cc-primary"
            />
            <p className="text-[10px] text-cc-muted mt-1">
              Use <code className="px-1 py-0.5 rounded bg-cc-hover">{"{{input}}"}</code> where trigger input should be inserted.
            </p>
          </div>

          {/* ── Controls Row ── */}
          <div className="flex items-center gap-1 sm:gap-2 flex-wrap" data-testid="controls-row">
            {/* Backend toggle */}
            <div className="flex items-center bg-cc-hover/50 rounded-lg p-0.5">
              <button
                onClick={() => handleBackendChange("claude")}
                className={`flex items-center gap-1 px-2 py-1 text-xs rounded-md transition-colors cursor-pointer ${form.backendType === "claude" ? "bg-cc-card text-cc-fg font-medium shadow-sm" : "text-cc-muted hover:text-cc-fg"}`}
              >
                Claude
              </button>
              <button
                onClick={() => handleBackendChange("codex")}
                className={`flex items-center gap-1 px-2 py-1 text-xs rounded-md transition-colors cursor-pointer ${form.backendType === "codex" ? "bg-cc-card text-cc-fg font-medium shadow-sm" : "text-cc-muted hover:text-cc-fg"}`}
              >
                Codex
              </button>
            </div>

            {/* Model dropdown pill */}
            <div className="relative" ref={modelDropdownRef}>
              <button
                onClick={() => { setShowModelDropdown(!showModelDropdown); setShowModeDropdown(false); setShowEnvDropdown(false); }}
                aria-expanded={showModelDropdown}
                className={pillDefault}
              >
                <span>{selectedModel?.icon}</span>
                <span>{selectedModel?.label}</span>
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 opacity-50"><path d="M4 6l4 4 4-4" /></svg>
              </button>
              {showModelDropdown && (
                <div className="absolute left-0 top-full mt-1 w-48 bg-cc-card border border-cc-border rounded-[10px] shadow-lg z-10 py-1">
                  {models.map((m) => (
                    <button
                      key={m.value}
                      onClick={() => { updateField("model", m.value); setShowModelDropdown(false); }}
                      className={`w-full px-3 py-2 text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer flex items-center gap-2 ${m.value === form.model ? "text-cc-primary font-medium" : "text-cc-fg"}`}
                    >
                      <span>{m.icon}</span>
                      {m.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Mode dropdown pill */}
            <div className="relative" ref={modeDropdownRef}>
              <button
                onClick={() => { setShowModeDropdown(!showModeDropdown); setShowModelDropdown(false); setShowEnvDropdown(false); }}
                aria-expanded={showModeDropdown}
                className={pillDefault}
              >
                <span>{selectedMode?.label}</span>
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 opacity-50"><path d="M4 6l4 4 4-4" /></svg>
              </button>
              {showModeDropdown && (
                <div className="absolute left-0 top-full mt-1 w-48 bg-cc-card border border-cc-border rounded-[10px] shadow-lg z-10 py-1">
                  {modes.map((m) => (
                    <button
                      key={m.value}
                      onClick={() => { updateField("permissionMode", m.value); setShowModeDropdown(false); }}
                      className={`w-full px-3 py-2 text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer flex items-center gap-2 ${m.value === form.permissionMode ? "text-cc-primary font-medium" : "text-cc-fg"}`}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Folder pill */}
            <button
              onClick={() => setShowFolderPicker(true)}
              className={form.cwd ? pillActive : pillDefault}
              title={form.cwd || "Temporary directory"}
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 opacity-60">
                <path d="M1 3.5A1.5 1.5 0 012.5 2h3.879a1.5 1.5 0 011.06.44l1.122 1.12A1.5 1.5 0 009.62 4H13.5A1.5 1.5 0 0115 5.5v7a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12.5v-9z" />
              </svg>
              <span className="max-w-[120px] sm:max-w-[200px] truncate font-mono-code">{folderLabel}</span>
              {form.cwd && (
                <svg
                  viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 opacity-50 hover:opacity-100"
                  onClick={(e) => { e.stopPropagation(); updateField("cwd", ""); }}
                >
                  <path d="M4.646 4.646a.5.5 0 01.708 0L8 7.293l2.646-2.647a.5.5 0 01.708.708L8.707 8l2.647 2.646a.5.5 0 01-.708.708L8 8.707l-2.646 2.647a.5.5 0 01-.708-.708L7.293 8 4.646 5.354a.5.5 0 010-.708z" />
                </svg>
              )}
            </button>

            {/* Branch pill — only visible when folder is set */}
            {form.cwd && (
              showBranchInput ? (
                <div className="flex items-center gap-1">
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-cc-muted opacity-60">
                    <path d="M9.5 3.25a2.25 2.25 0 113 2.122V6.5A2.5 2.5 0 0110 9H6a1 1 0 00-1 1v1.128a2.251 2.251 0 11-1.5 0V5.372a2.25 2.25 0 111.5 0v1.836A2.492 2.492 0 016 7h4a1 1 0 001-1v-.878A2.25 2.25 0 019.5 3.25z" />
                  </svg>
                  <input
                    value={form.branch}
                    onChange={(e) => updateField("branch", e.target.value)}
                    placeholder="branch name"
                    className="w-28 px-1.5 py-1 text-xs rounded-md bg-cc-input-bg border border-cc-border text-cc-fg font-mono-code focus:outline-none focus:ring-1 focus:ring-cc-primary"
                    autoFocus
                    onBlur={() => { if (!form.branch) setShowBranchInput(false); }}
                  />
                  {form.branch && (
                    <>
                      <label className="flex items-center gap-1 text-[10px] text-cc-muted cursor-pointer" title="Create branch if it doesn't exist">
                        <input
                          type="checkbox"
                          checked={form.createBranch}
                          onChange={(e) => updateField("createBranch", e.target.checked)}
                          className="rounded w-3 h-3"
                        />
                        create
                      </label>
                      <label className="flex items-center gap-1 text-[10px] text-cc-muted cursor-pointer" title="Use git worktree">
                        <input
                          type="checkbox"
                          checked={form.useWorktree}
                          onChange={(e) => updateField("useWorktree", e.target.checked)}
                          className="rounded w-3 h-3"
                        />
                        worktree
                      </label>
                    </>
                  )}
                </div>
              ) : (
                <button
                  onClick={() => setShowBranchInput(true)}
                  className={pillDefault}
                  title="Set a git branch"
                >
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 opacity-60">
                    <path d="M9.5 3.25a2.25 2.25 0 113 2.122V6.5A2.5 2.5 0 0110 9H6a1 1 0 00-1 1v1.128a2.251 2.251 0 11-1.5 0V5.372a2.25 2.25 0 111.5 0v1.836A2.492 2.492 0 016 7h4a1 1 0 001-1v-.878A2.25 2.25 0 019.5 3.25z" />
                  </svg>
                  <span>branch</span>
                </button>
              )
            )}

            {/* Env profile pill */}
            <div className="relative" ref={envDropdownRef}>
              <button
                onClick={() => { setShowEnvDropdown(!showEnvDropdown); setShowModelDropdown(false); setShowModeDropdown(false); }}
                aria-expanded={showEnvDropdown}
                className={form.envSlug ? pillActive : pillDefault}
              >
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 opacity-60">
                  <path d="M8 1a2 2 0 012 2v4H6V3a2 2 0 012-2zm3.5 6V3a3.5 3.5 0 10-7 0v4A1.5 1.5 0 003 8.5v5A1.5 1.5 0 004.5 15h7a1.5 1.5 0 001.5-1.5v-5A1.5 1.5 0 0011.5 7z" />
                </svg>
                <span>{selectedEnv?.name || "None"}</span>
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 opacity-50"><path d="M4 6l4 4 4-4" /></svg>
              </button>
              {showEnvDropdown && (
                <div className="absolute left-0 top-full mt-1 w-48 bg-cc-card border border-cc-border rounded-[10px] shadow-lg z-10 py-1">
                  <button
                    onClick={() => { updateField("envSlug", ""); setShowEnvDropdown(false); }}
                    className={`w-full px-3 py-2 text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer ${!form.envSlug ? "text-cc-primary font-medium" : "text-cc-fg"}`}
                  >
                    None
                  </button>
                  {envProfiles.map((env) => (
                    <button
                      key={env.slug}
                      onClick={() => { updateField("envSlug", env.slug); setShowEnvDropdown(false); }}
                      className={`w-full px-3 py-2 text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer ${form.envSlug === env.slug ? "text-cc-primary font-medium" : "text-cc-fg"}`}
                    >
                      {env.name}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Internet pill — codex only */}
            {form.backendType === "codex" && (
              <button
                onClick={() => updateField("codexInternetAccess", !form.codexInternetAccess)}
                className={form.codexInternetAccess ? pillActive : pillDefault}
                title="Allow internet access (Codex)"
              >
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 opacity-60">
                  <path d="M0 8a8 8 0 1116 0A8 8 0 010 8zm7.5-6.923c-.67.204-1.335.82-1.887 1.855A7.97 7.97 0 005.145 4H7.5V1.077zM4.09 4a9.267 9.267 0 01.64-1.539 6.7 6.7 0 01.597-.933A6.504 6.504 0 002.536 4H4.09zm-.582 3.5c.03-.877.138-1.718.312-2.5H1.674a6.51 6.51 0 00-.656 2.5h2.49zM4.847 5a12.5 12.5 0 00-.338 2.5H7.5V5H4.847zM8.5 5v2.5h2.99a12.495 12.495 0 00-.337-2.5H8.5zM4.51 8.5a12.5 12.5 0 00.337 2.5H7.5V8.5H4.51zm3.99 0V11h2.653c.187-.765.306-1.608.338-2.5H8.5zM5.145 12c.138.386.295.744.468 1.068.552 1.035 1.218 1.65 1.887 1.855V12H5.145zm.182 2.472a6.696 6.696 0 01-.597-.933A9.268 9.268 0 014.09 12H2.536a6.504 6.504 0 002.79 2.472zM3.82 11a13.652 13.652 0 01-.312-2.5h-2.49c.062.89.291 1.733.656 2.5H3.82zm6.853 3.472A6.504 6.504 0 0013.464 12H11.91a9.27 9.27 0 01-.64 1.539 6.688 6.688 0 01-.597.933zM8.5 14.923c.67-.204 1.335-.82 1.887-1.855.173-.324.33-.682.468-1.068H8.5v2.923zm3.68-3.923c.174-.782.282-1.623.312-2.5H15c-.094.89-.323 1.733-.656 2.5h-2.163zM12.18 8.5c-.03-.877-.138-1.718-.312-2.5h2.158c.365.767.594 1.61.656 2.5H12.18zm-1.508-4.5h2.792a6.504 6.504 0 00-2.79-2.472c.218.284.418.598.597.933.226.423.424.896.59 1.539z" />
                </svg>
                <span>Internet</span>
              </button>
            )}
          </div>

          {showFolderPicker && (
            <FolderPicker
              initialPath={form.cwd || ""}
              onSelect={(path) => {
                updateField("cwd", path);
                setShowFolderPicker(false);
              }}
              onClose={() => setShowFolderPicker(false)}
            />
          )}

          {/* ── Triggers ── */}
          <section>
            <h2 className="text-xs text-cc-muted mb-2">Triggers</h2>
            <div className="flex items-center gap-2 flex-wrap">
              {/* Webhook toggle pill */}
              <button
                onClick={() => updateField("webhookEnabled", !form.webhookEnabled)}
                className={form.webhookEnabled ? pillActive : pillDefault}
              >
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 opacity-60">
                  <path d="M8.543 2.232a.75.75 0 00-1.085 0l-5.25 5.5A.75.75 0 002.75 9H4v4a1 1 0 001 1h6a1 1 0 001-1V9h1.25a.75.75 0 00.543-1.268l-5.25-5.5z" />
                </svg>
                Webhook
              </button>

              {/* Schedule toggle pill */}
              <button
                onClick={() => updateField("scheduleEnabled", !form.scheduleEnabled)}
                className={form.scheduleEnabled ? pillActive : pillDefault}
              >
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 opacity-60">
                  <path d="M8 3.5a.5.5 0 00-1 0V8a.5.5 0 00.252.434l3.5 2a.5.5 0 00.496-.868L8 7.71V3.5z" />
                  <path d="M8 16A8 8 0 108 0a8 8 0 000 16zm7-8A7 7 0 111 8a7 7 0 0114 0z" />
                </svg>
                Schedule
              </button>

              <button
                onClick={() => updateField("linearEnabled", !form.linearEnabled)}
                className={form.linearEnabled ? pillActive : pillDefault}
              >
                Linear (adapter)
              </button>

              <button
                onClick={() => updateField("githubEnabled", !form.githubEnabled)}
                className={form.githubEnabled ? pillActive : pillDefault}
              >
                GitHub (adapter)
              </button>
            </div>

            <div className="mt-3 rounded-lg border border-cc-border/70 bg-cc-card p-3">
              <p className="text-[11px] font-medium text-cc-fg mb-2">Trigger Security</p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <button
                  onClick={() => updateField("triggerSecurityMode", "simple")}
                  className={`text-left px-2.5 py-2 rounded-lg border transition-colors cursor-pointer ${
                    form.triggerSecurityMode === "simple"
                      ? "border-cc-primary bg-cc-primary/10"
                      : "border-cc-border hover:border-cc-primary/40"
                  }`}
                >
                  <p className="text-xs text-cc-fg">Simple</p>
                  <p className="text-[10px] text-cc-muted mt-0.5">URL secret only</p>
                </button>
                <button
                  onClick={() => updateField("triggerSecurityMode", "recommended")}
                  className={`text-left px-2.5 py-2 rounded-lg border transition-colors cursor-pointer ${
                    form.triggerSecurityMode === "recommended"
                      ? "border-cc-primary bg-cc-primary/10"
                      : "border-cc-border hover:border-cc-primary/40"
                  }`}
                >
                  <p className="text-xs text-cc-fg">Recommended</p>
                  <p className="text-[10px] text-cc-muted mt-0.5">Bearer token + HMAC</p>
                </button>
                <button
                  onClick={() => updateField("triggerSecurityMode", "flexible")}
                  className={`text-left px-2.5 py-2 rounded-lg border transition-colors cursor-pointer ${
                    form.triggerSecurityMode === "flexible"
                      ? "border-cc-primary bg-cc-primary/10"
                      : "border-cc-border hover:border-cc-primary/40"
                  }`}
                >
                  <p className="text-xs text-cc-fg">Flexible</p>
                  <p className="text-[10px] text-cc-muted mt-0.5">URL or Bearer + HMAC</p>
                </button>
              </div>
            </div>

            {/* Webhook helper */}
            {form.webhookEnabled && (
              <p className="text-[10px] text-cc-muted mt-2">
                A unique URL will be generated after saving. POST to it with <code className="px-1 py-0.5 rounded bg-cc-hover">{`{"input": "..."}`}</code>.
              </p>
            )}

            {form.linearEnabled && (
              <div className="mt-3 rounded-lg border border-cc-border/70 bg-cc-card p-3 space-y-2">
                <p className="text-[11px] text-cc-muted">
                  Event-source adapter example: Linear webhook. Useful for "@agent" in comments.
                </p>
                <label className="flex items-center gap-2 text-xs text-cc-muted cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.linearRequireMention}
                    onChange={(e) => updateField("linearRequireMention", e.target.checked)}
                    className="rounded w-3 h-3"
                  />
                  Trigger only on mention
                </label>
                <input
                  value={form.linearMention}
                  onChange={(e) => updateField("linearMention", e.target.value)}
                  placeholder="Mention alias (optional, default: agent id)"
                  className="w-full px-3 py-1.5 rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg text-xs focus:outline-none focus:ring-1 focus:ring-cc-primary"
                />
              </div>
            )}

            {form.githubEnabled && (
              <div className="mt-3 rounded-lg border border-cc-border/70 bg-cc-card p-3 space-y-2">
                <p className="text-[11px] text-cc-muted">
                  Event-source adapter example: GitHub webhook (PR + comments).
                </p>
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-1.5 text-xs text-cc-muted cursor-pointer">
                    <input
                      type="checkbox"
                      checked={form.githubOnPullRequest}
                      onChange={(e) => updateField("githubOnPullRequest", e.target.checked)}
                      className="rounded w-3 h-3"
                    />
                    PR events
                  </label>
                  <label className="flex items-center gap-1.5 text-xs text-cc-muted cursor-pointer">
                    <input
                      type="checkbox"
                      checked={form.githubOnComment}
                      onChange={(e) => updateField("githubOnComment", e.target.checked)}
                      className="rounded w-3 h-3"
                    />
                    Comment events
                  </label>
                </div>
                <label className="flex items-center gap-2 text-xs text-cc-muted cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.githubRequireMention}
                    onChange={(e) => updateField("githubRequireMention", e.target.checked)}
                    className="rounded w-3 h-3"
                  />
                  Trigger only on mention
                </label>
                <input
                  value={form.githubMention}
                  onChange={(e) => updateField("githubMention", e.target.value)}
                  placeholder="Mention alias (optional, default: agent id)"
                  className="w-full px-3 py-1.5 rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg text-xs focus:outline-none focus:ring-1 focus:ring-cc-primary"
                />
              </div>
            )}

            {/* Schedule config */}
            {form.scheduleEnabled && (
              <div className="mt-3 space-y-2">
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-1.5 text-xs text-cc-muted cursor-pointer">
                    <input
                      type="radio"
                      checked={form.scheduleRecurring}
                      onChange={() => updateField("scheduleRecurring", true)}
                    />
                    Recurring
                  </label>
                  <label className="flex items-center gap-1.5 text-xs text-cc-muted cursor-pointer">
                    <input
                      type="radio"
                      checked={!form.scheduleRecurring}
                      onChange={() => updateField("scheduleRecurring", false)}
                    />
                    One-time
                  </label>
                </div>
                {form.scheduleRecurring ? (
                  <div className="space-y-2">
                    <div className="flex flex-wrap gap-1">
                      {CRON_PRESETS.map((p) => (
                        <button
                          key={p.value}
                          onClick={() => updateField("scheduleExpression", p.value)}
                          className={`px-2 py-1 text-[10px] rounded-lg border transition-colors cursor-pointer ${form.scheduleExpression === p.value ? "border-cc-primary text-cc-primary" : "border-cc-border text-cc-muted hover:text-cc-fg"}`}
                        >
                          {p.label}
                        </button>
                      ))}
                    </div>
                    <input
                      value={form.scheduleExpression}
                      onChange={(e) => updateField("scheduleExpression", e.target.value)}
                      placeholder="Cron expression (e.g. 0 8 * * *)"
                      className="w-full px-3 py-2 rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg text-sm font-mono-code focus:outline-none focus:ring-1 focus:ring-cc-primary"
                    />
                  </div>
                ) : (
                  <input
                    type="datetime-local"
                    value={form.scheduleExpression}
                    onChange={(e) => updateField("scheduleExpression", e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg text-sm focus:outline-none focus:ring-1 focus:ring-cc-primary"
                  />
                )}
              </div>
            )}
          </section>

          {/* ── Advanced (collapsible) ── */}
          <section>
            <button
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex items-center gap-2 text-xs text-cc-muted cursor-pointer hover:text-cc-fg transition-colors w-full"
            >
              <svg
                viewBox="0 0 16 16"
                fill="currentColor"
                className={`w-3 h-3 transition-transform ${showAdvanced ? "rotate-90" : ""}`}
              >
                <path d="M6 3l5 5-5 5V3z" />
              </svg>
              Advanced
              {countAdvancedFeatures(form) > 0 && (
                <span className="px-1.5 py-0.5 text-[10px] rounded-full bg-cc-primary/15 text-cc-primary font-normal">
                  {countAdvancedFeatures(form)}
                </span>
              )}
            </button>

            {showAdvanced && (
              <div className="mt-4 space-y-6 pl-5 border-l-2 border-cc-border/30">
                {/* ── MCP Servers ── */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-xs font-medium text-cc-muted">MCP Servers</h3>
                    <button
                      onClick={() => setShowMcpForm(!showMcpForm)}
                      className="text-[10px] text-cc-muted hover:text-cc-fg transition-colors cursor-pointer"
                    >
                      {showMcpForm ? "Cancel" : "+ Add Server"}
                    </button>
                  </div>

                  {Object.keys(form.mcpServers).length === 0 && !showMcpForm && (
                    <p className="text-[10px] text-cc-muted">No MCP servers configured.</p>
                  )}
                  {Object.entries(form.mcpServers).map(([name, config]) => (
                    <div key={name} className="flex items-center justify-between py-1.5 px-2 rounded-lg bg-cc-hover/50 mb-1.5">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-cc-fg font-mono-code">{name}</span>
                        <span className="px-1.5 py-0.5 text-[10px] rounded bg-cc-border text-cc-muted">{config.type}</span>
                      </div>
                      <button
                        onClick={() => removeMcpServer(name)}
                        className="text-cc-muted hover:text-cc-error transition-colors cursor-pointer p-0.5"
                        title="Remove server"
                      >
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                          <path d="M4.646 4.646a.5.5 0 01.708 0L8 7.293l2.646-2.647a.5.5 0 01.708.708L8.707 8l2.647 2.646a.5.5 0 01-.708.708L8 8.707l-2.646 2.647a.5.5 0 01-.708-.708L7.293 8 4.646 5.354a.5.5 0 010-.708z" />
                        </svg>
                      </button>
                    </div>
                  ))}

                  {showMcpForm && (
                    <div className="rounded-lg border border-cc-border p-3 mt-2 space-y-2">
                      <div>
                        <label className="block text-[10px] text-cc-muted mb-0.5">Server Name</label>
                        <input
                          value={mcpFormName}
                          onChange={(e) => setMcpFormName(e.target.value)}
                          placeholder="e.g., my-server"
                          className="w-full px-2 py-1.5 rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg text-xs font-mono-code focus:outline-none focus:ring-1 focus:ring-cc-primary"
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] text-cc-muted mb-0.5">Type</label>
                        <div className="flex rounded-lg border border-cc-border overflow-hidden">
                          {(["stdio", "sse", "http"] as const).map((t) => (
                            <button
                              key={t}
                              onClick={() => setMcpFormData((prev) => ({ ...prev, type: t }))}
                              className={`flex-1 px-2 py-1 text-[10px] transition-colors cursor-pointer ${mcpFormData.type === t ? "bg-cc-primary text-white" : "bg-cc-input-bg text-cc-muted hover:text-cc-fg"}`}
                            >
                              {t}
                            </button>
                          ))}
                        </div>
                      </div>
                      {mcpFormData.type === "stdio" ? (
                        <>
                          <div>
                            <label className="block text-[10px] text-cc-muted mb-0.5">Command</label>
                            <input
                              value={mcpFormData.command}
                              onChange={(e) => setMcpFormData((prev) => ({ ...prev, command: e.target.value }))}
                              placeholder="e.g., npx -y @some/mcp-server"
                              className="w-full px-2 py-1.5 rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg text-xs font-mono-code focus:outline-none focus:ring-1 focus:ring-cc-primary"
                            />
                          </div>
                          <div>
                            <label className="block text-[10px] text-cc-muted mb-0.5">Args (space-separated)</label>
                            <input
                              value={mcpFormData.args}
                              onChange={(e) => setMcpFormData((prev) => ({ ...prev, args: e.target.value }))}
                              placeholder="--port 3000"
                              className="w-full px-2 py-1.5 rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg text-xs font-mono-code focus:outline-none focus:ring-1 focus:ring-cc-primary"
                            />
                          </div>
                        </>
                      ) : (
                        <div>
                          <label className="block text-[10px] text-cc-muted mb-0.5">URL</label>
                          <input
                            value={mcpFormData.url}
                            onChange={(e) => setMcpFormData((prev) => ({ ...prev, url: e.target.value }))}
                            placeholder="https://example.com/mcp"
                            className="w-full px-2 py-1.5 rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg text-xs font-mono-code focus:outline-none focus:ring-1 focus:ring-cc-primary"
                          />
                        </div>
                      )}
                      <button
                        onClick={addMcpServer}
                        disabled={!mcpFormName.trim()}
                        className="px-3 py-1.5 text-xs rounded-lg bg-cc-primary text-white hover:bg-cc-primary-hover transition-colors disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
                      >
                        Add Server
                      </button>
                    </div>
                  )}
                </div>

                {/* ── Skills ── */}
                <div>
                  <h3 className="text-xs font-medium text-cc-muted mb-2">Skills</h3>
                  {availableSkills.length === 0 ? (
                    <p className="text-[10px] text-cc-muted">No skills found in ~/.claude/skills/</p>
                  ) : (
                    <div className="space-y-1.5">
                      {availableSkills.map((skill) => (
                        <label
                          key={skill.slug}
                          className="flex items-start gap-2 text-sm text-cc-fg cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            checked={form.skills.includes(skill.slug)}
                            onChange={() => toggleSkill(skill.slug)}
                            className="rounded mt-0.5"
                          />
                          <div>
                            <span className="text-xs">{skill.name}</span>
                            {skill.description && (
                              <p className="text-[10px] text-cc-muted">{skill.description}</p>
                            )}
                          </div>
                        </label>
                      ))}
                    </div>
                  )}
                </div>

                {/* ── Allowed Tools ── */}
                <div>
                  <h3 className="text-xs font-medium text-cc-muted mb-2">Allowed Tools</h3>
                  <div className="space-y-2">
                    {form.allowedTools.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {form.allowedTools.map((tool) => (
                          <span key={tool} className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-mono-code rounded-lg bg-cc-hover text-cc-fg">
                            {tool}
                            <button
                              onClick={() => removeAllowedTool(tool)}
                              className="text-cc-muted hover:text-cc-error transition-colors cursor-pointer"
                            >
                              <svg viewBox="0 0 16 16" fill="currentColor" className="w-2.5 h-2.5">
                                <path d="M4.646 4.646a.5.5 0 01.708 0L8 7.293l2.646-2.647a.5.5 0 01.708.708L8.707 8l2.647 2.646a.5.5 0 01-.708.708L8 8.707l-2.646 2.647a.5.5 0 01-.708-.708L7.293 8 4.646 5.354a.5.5 0 010-.708z" />
                              </svg>
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                    <input
                      value={allowedToolInput}
                      onChange={(e) => setAllowedToolInput(e.target.value)}
                      onKeyDown={addAllowedTool}
                      placeholder="Type tool name and press Enter"
                      className="w-full px-2 py-1.5 rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg text-xs font-mono-code focus:outline-none focus:ring-1 focus:ring-cc-primary"
                    />
                    <p className="text-[10px] text-cc-muted">Leave empty to allow all tools.</p>
                  </div>
                </div>

                {/* ── Environment Variables ── */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-xs font-medium text-cc-muted">Environment Variables</h3>
                    <button
                      onClick={addEnvVar}
                      className="text-[10px] text-cc-muted hover:text-cc-fg transition-colors cursor-pointer"
                    >
                      + Add Variable
                    </button>
                  </div>
                  {form.env.length === 0 ? (
                    <p className="text-[10px] text-cc-muted">No extra variables set.</p>
                  ) : (
                    <div className="space-y-1.5">
                      {form.env.map((entry, i) => (
                        <div key={i} className="flex gap-2 items-center">
                          <input
                            value={entry.key}
                            onChange={(e) => updateEnvVar(i, "key", e.target.value)}
                            placeholder="KEY"
                            className="w-1/3 px-2 py-1.5 rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg text-xs font-mono-code focus:outline-none focus:ring-1 focus:ring-cc-primary"
                          />
                          <input
                            value={entry.value}
                            onChange={(e) => updateEnvVar(i, "value", e.target.value)}
                            placeholder="value"
                            className="flex-1 px-2 py-1.5 rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg text-xs font-mono-code focus:outline-none focus:ring-1 focus:ring-cc-primary"
                          />
                          <button
                            onClick={() => removeEnvVar(i)}
                            className="text-cc-muted hover:text-cc-error transition-colors cursor-pointer p-1"
                            title="Remove variable"
                          >
                            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                              <path d="M4.646 4.646a.5.5 0 01.708 0L8 7.293l2.646-2.647a.5.5 0 01.708.708L8.707 8l2.647 2.646a.5.5 0 01-.708.708L8 8.707l-2.646 2.647a.5.5 0 01-.708-.708L7.293 8 4.646 5.354a.5.5 0 010-.708z" />
                            </svg>
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
