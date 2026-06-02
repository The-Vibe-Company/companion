import { useState, useEffect, useRef } from "react";
import { api, type McpServerConfigAgent, type CompanionEnv, type LinearOAuthConnectionSummary } from "../api.js";
import { getModelsForBackend, getDefaultModel, getAgentModesForBackend, getDefaultAgentMode } from "../utils/backends.js";
import { FolderPicker } from "./FolderPicker.js";
import { AgentIcon, AGENT_ICON_OPTIONS } from "./AgentIcon.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface McpServerFormEntry {
  type: "stdio" | "sse" | "http";
  command: string;
  args: string;
  url: string;
  env: string;
}

export interface AgentFormData {
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
  scheduleEnabled: boolean;
  scheduleExpression: string;
  scheduleRecurring: boolean;
  // Linear Agent SDK trigger
  linearEnabled: boolean;
  linearOAuthConnectionId: string;
}

export const EMPTY_FORM: AgentFormData = {
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
  scheduleEnabled: false,
  scheduleExpression: "0 8 * * *",
  scheduleRecurring: true,
  linearEnabled: false,
  linearOAuthConnectionId: "",
};

const CRON_PRESETS: { label: string; value: string }[] = [
  { label: "Every hour", value: "0 * * * *" },
  { label: "Every day at 8am", value: "0 8 * * *" },
  { label: "Every day at noon", value: "0 12 * * *" },
  { label: "Weekdays at 9am", value: "0 9 * * 1-5" },
  { label: "Every Monday at 8am", value: "0 8 * * 1" },
  { label: "Every 30 minutes", value: "*/30 * * * *" },
];

/** Count how many advanced features are configured */
function countAdvancedFeatures(form: AgentFormData): number {
  let count = 0;
  if (Object.keys(form.mcpServers).length > 0) count++;
  if (form.skills.length > 0) count++;
  if (form.allowedTools.length > 0) count++;
  if (form.env.length > 0) count++;
  return count;
}

// ─── Agent Editor ───────────────────────────────────────────────────────────

export function AgentEditor({
  form,
  setForm,
  editingId,
  publicUrl,
  error,
  saving,
  onSave,
  onCancel,
  linearOAuthConfigured,
}: {
  form: AgentFormData;
  setForm: (f: AgentFormData | ((prev: AgentFormData) => AgentFormData)) => void;
  editingId: string | null;
  publicUrl: string;
  error: string;
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
  linearOAuthConfigured: boolean;
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
  const [linearConnections, setLinearConnections] = useState<LinearOAuthConnectionSummary[]>([]);
  const [linearConnectionsLoading, setLinearConnectionsLoading] = useState(false);
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

  // Fetch Linear OAuth connections when Linear trigger is enabled
  useEffect(() => {
    if (!form.linearEnabled) return;
    setLinearConnectionsLoading(true);
    api.listLinearOAuthConnections()
      .then(({ connections }) => {
        setLinearConnections(connections);
        // Auto-select if only one connection and none selected yet
        if (connections.length === 1 && !form.linearOAuthConnectionId) {
          updateField("linearOAuthConnectionId", connections[0].id);
        }
      })
      .catch(() => {})
      .finally(() => setLinearConnectionsLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.linearEnabled]);

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
  const webhookBaseUrl = publicUrl || (typeof window !== "undefined" ? window.location.origin : "");

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

              {/* Linear Agent SDK toggle pill (only shown when OAuth is configured) */}
              {linearOAuthConfigured && (
                <button
                  onClick={() => updateField("linearEnabled", !form.linearEnabled)}
                  className={form.linearEnabled ? pillActive : pillDefault}
                >
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 opacity-60">
                    <path d="M3 1a1 1 0 00-1 1v12a1 1 0 001 1h10a1 1 0 001-1V2a1 1 0 00-1-1H3zm1 2h8v2H4V3zm0 4h5v2H4V7zm0 4h8v2H4v-2z" />
                  </svg>
                  Linear Agent
                </button>
              )}

            </div>

            {/* Webhook helper */}
            {form.webhookEnabled && (
              <div className="mt-2 space-y-1">
                <p className="text-[10px] text-cc-muted">
                  A unique URL will be generated after saving. POST to it with <code className="px-1 py-0.5 rounded bg-cc-hover">{`{"input": "..."}`}</code>.
                </p>
                {webhookBaseUrl && (
                  <p className="text-[10px] text-cc-muted">
                    Base URL: <span className="font-mono-code">{webhookBaseUrl}</span>
                  </p>
                )}
              </div>
            )}

            {/* Linear OAuth connection picker */}
            {form.linearEnabled && (
              <div className="mt-3 space-y-2" data-testid="linear-connection-picker">
                {linearConnectionsLoading ? (
                  <p className="text-[10px] text-cc-muted">Loading connections...</p>
                ) : linearConnections.length === 0 ? (
                  <p className="text-[10px] text-cc-muted">
                    No OAuth connections found.{" "}
                    <a href="#/agents?setup=linear" className="text-cc-primary underline">
                      Set up a Linear OAuth app
                    </a>{" "}
                    first.
                  </p>
                ) : (
                  <>
                    <label className="block text-[10px] text-cc-muted mb-1">OAuth Connection</label>
                    <div className="space-y-1">
                      {linearConnections.map((conn) => (
                        <button
                          key={conn.id}
                          type="button"
                          onClick={() => updateField("linearOAuthConnectionId", conn.id)}
                          className={`w-full flex items-center justify-between px-3 py-2 rounded-lg border text-xs transition-colors cursor-pointer ${
                            form.linearOAuthConnectionId === conn.id
                              ? "border-cc-primary bg-cc-primary/10 text-cc-fg"
                              : "border-cc-border bg-cc-input-bg text-cc-muted hover:text-cc-fg hover:border-cc-primary/50"
                          }`}
                        >
                          <span className="font-medium">{conn.name}</span>
                          <span
                            className={`px-1.5 py-0.5 text-[10px] rounded-full ${
                              conn.status === "connected"
                                ? "bg-emerald-500/15 text-emerald-400"
                                : "bg-cc-muted/15 text-cc-muted"
                            }`}
                          >
                            {conn.status === "connected" ? "Connected" : "Not connected"}
                          </span>
                        </button>
                      ))}
                    </div>
                    <p className="text-[10px] text-cc-muted">
                      This agent will respond to @mentions in Linear.{" "}
                      <a href="#/agents?setup=linear" className="text-cc-primary underline">
                        Manage connections
                      </a>
                    </p>
                  </>
                )}
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
