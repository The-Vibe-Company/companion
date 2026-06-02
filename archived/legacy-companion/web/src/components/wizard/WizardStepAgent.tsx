import { useState } from "react";
import { api } from "../../api.js";
import { getDefaultModel } from "../../utils/backends.js";
import { FolderPicker } from "../FolderPicker.js";

interface WizardStepAgentProps {
  onNext: (agentId: string, agentName: string) => void;
  onBack: () => void;
  /** OAuth connection ID to link to the agent */
  oauthConnectionId: string | null;
  /** @deprecated Staging slot ID for credentials (legacy per-wizard flow) */
  stagingId?: string | null;
  /** @deprecated Clone credentials from this agent instead of using staging */
  cloneFromAgentId?: string | null;
  /** When set, the wizard edits an existing agent instead of creating one */
  existingAgent?: {
    id: string;
    name: string;
    prompt: string;
    backendType: "claude" | "codex";
    model: string;
    cwd: string;
  };
}

const DEFAULT_PROMPT = `You are an AI agent responding to a Linear issue. The issue context will be provided when you are @mentioned.

Read the issue details carefully, then complete the requested task. When done, summarize what you did.

{{input}}`;

export function WizardStepAgent({ onNext, onBack, oauthConnectionId, stagingId, cloneFromAgentId, existingAgent }: WizardStepAgentProps) {
  const isEditing = !!existingAgent;

  const [name, setName] = useState(existingAgent?.name ?? "Linear Agent");
  const [prompt, setPrompt] = useState(existingAgent?.prompt ?? DEFAULT_PROMPT);
  const [backend, setBackend] = useState<"claude" | "codex">(existingAgent?.backendType ?? "claude");
  const [model, setModel] = useState(existingAgent?.model ?? "");
  const [cwd, setCwd] = useState(existingAgent?.cwd ?? "");
  const [showFolderPicker, setShowFolderPicker] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const folderLabel = cwd
    ? cwd.split("/").pop() || cwd
    : "Temp directory";

  async function handleCreate() {
    if (!name.trim()) {
      setError("Agent name is required.");
      return;
    }
    if (!prompt.trim()) {
      setError("Agent prompt is required.");
      return;
    }

    setSaving(true);
    setError("");

    try {
      const data = {
        version: 1 as const,
        name: name.trim(),
        description: "Linear Agent created via setup wizard",
        backendType: backend,
        model: model || getDefaultModel(backend),
        permissionMode: "bypassPermissions" as const,
        cwd: cwd || "",
        prompt: prompt.trim(),
        triggers: {
          webhook: { enabled: false, secret: "" },
          schedule: { enabled: false, expression: "", recurring: true },
          linear: {
            enabled: true,
            ...(oauthConnectionId ? { oauthConnectionId } : {}),
          },
        },
        enabled: true,
      };

      if (isEditing) {
        await api.updateAgent(existingAgent.id, data);
        onNext(existingAgent.id, name.trim());
      } else {
        const agent = await api.createAgent({
          ...data,
          // Legacy support: staging slot or clone from agent
          ...(stagingId ? { stagingId } : {}),
          ...(cloneFromAgentId ? { cloneFromAgentId } : {}),
        });
        onNext(agent.id, agent.name);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const inputClass = "w-full px-3 py-2.5 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/60";

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-cc-fg">
          {isEditing ? "Edit Linear Agent" : "Configure Your Agent"}
        </h2>
        <p className="mt-1 text-sm text-cc-muted">
          {isEditing
            ? "Update the agent settings. These can be customized further in the Agents page."
            : "Set up the agent that will respond to @mentions in Linear. You can customize it further in the Agents page later."}
        </p>
      </div>

      <div className="space-y-4">
        {/* Agent name */}
        <div>
          <label className="block text-sm font-medium text-cc-fg mb-1.5" htmlFor="wizard-agent-name">
            Agent Name
          </label>
          <input
            id="wizard-agent-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My Linear Agent"
            className={inputClass}
          />
        </div>

        {/* Backend toggle */}
        <div>
          <label className="block text-sm font-medium text-cc-fg mb-1.5">Backend</label>
          <div className="flex gap-2">
            <button
              onClick={() => { setBackend("claude"); setModel(""); }}
              className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium border transition-colors cursor-pointer ${
                backend === "claude"
                  ? "border-cc-primary bg-cc-primary/10 text-cc-primary"
                  : "border-cc-border text-cc-muted hover:text-cc-fg"
              }`}
            >
              Claude Code
            </button>
            <button
              onClick={() => { setBackend("codex"); setModel(""); }}
              className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium border transition-colors cursor-pointer ${
                backend === "codex"
                  ? "border-cc-primary bg-cc-primary/10 text-cc-primary"
                  : "border-cc-border text-cc-muted hover:text-cc-fg"
              }`}
            >
              Codex
            </button>
          </div>
        </div>

        {/* Model */}
        <div>
          <label className="block text-sm font-medium text-cc-fg mb-1.5" htmlFor="wizard-agent-model">
            Model <span className="text-cc-muted font-normal">(optional)</span>
          </label>
          <input
            id="wizard-agent-model"
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={`${getDefaultModel(backend)} (default)`}
            className={inputClass}
          />
        </div>

        {/* Working directory */}
        <div>
          <label className="block text-sm font-medium text-cc-fg mb-1.5">Working Directory</label>
          <button
            onClick={() => setShowFolderPicker(true)}
            className="flex items-center gap-2 px-3 py-2.5 rounded-lg border border-cc-border bg-cc-input-bg text-sm text-cc-fg hover:border-cc-primary/40 transition-colors cursor-pointer w-full text-left"
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 text-cc-muted flex-shrink-0">
              <path d="M1 3.5A1.5 1.5 0 012.5 2h3.879a1.5 1.5 0 011.06.44l1.122 1.12A1.5 1.5 0 009.62 4H13.5A1.5 1.5 0 0115 5.5v7a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12.5v-9z" />
            </svg>
            <span className="truncate font-mono-code text-cc-muted">{folderLabel}</span>
            {cwd && (
              <svg
                viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 text-cc-muted hover:text-cc-fg flex-shrink-0 ml-auto"
                onClick={(e) => { e.stopPropagation(); setCwd(""); }}
              >
                <path d="M4.646 4.646a.5.5 0 01.708 0L8 7.293l2.646-2.647a.5.5 0 01.708.708L8.707 8l2.647 2.646a.5.5 0 01-.708.708L8 8.707l-2.646 2.647a.5.5 0 01-.708-.708L7.293 8 4.646 5.354a.5.5 0 010-.708z" />
              </svg>
            )}
          </button>
          <p className="text-[10px] text-cc-muted mt-1">
            Leave empty to use a temporary directory for each run.
          </p>
        </div>

        {/* Prompt */}
        <div>
          <label className="block text-sm font-medium text-cc-fg mb-1.5" htmlFor="wizard-agent-prompt">
            Prompt
          </label>
          <textarea
            id="wizard-agent-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={6}
            placeholder="Instructions for your agent..."
            className={`${inputClass} font-mono-code text-xs leading-relaxed resize-y`}
          />
          <p className="text-[10px] text-cc-muted mt-1">
            Use <code className="px-1 py-0.5 rounded bg-cc-hover">{"{{input}}"}</code> as a placeholder for the trigger-provided context.
          </p>
        </div>

        {/* Linear trigger badge (non-editable) */}
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-xs font-medium bg-cc-success/10 text-cc-success border border-cc-success/20">
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
              <path d="M3 1a1 1 0 00-1 1v12a1 1 0 001 1h10a1 1 0 001-1V2a1 1 0 00-1-1H3zm1 2h8v2H4V3zm0 4h5v2H4V7zm0 4h8v2H4v-2z" />
            </svg>
            Linear Agent trigger enabled
          </span>
        </div>
      </div>

      {error && (
        <div className="px-3 py-2 rounded-lg bg-cc-error/10 border border-cc-error/20 text-xs text-cc-error">
          {error}
        </div>
      )}

      <div className="flex justify-between">
        <button
          onClick={onBack}
          className="px-4 py-2.5 rounded-lg text-sm font-medium text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
        >
          Back
        </button>
        <button
          onClick={handleCreate}
          disabled={saving}
          className={`px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${
            saving
              ? "bg-cc-hover text-cc-muted cursor-not-allowed"
              : "bg-cc-primary hover:bg-cc-primary-hover text-white cursor-pointer"
          }`}
        >
          {saving
            ? (isEditing ? "Saving..." : "Creating...")
            : (isEditing ? "Save Agent" : "Create Agent")}
        </button>
      </div>

      {showFolderPicker && (
        <FolderPicker
          initialPath={cwd || "/"}
          onSelect={(path) => {
            setCwd(path);
            setShowFolderPicker(false);
          }}
          onClose={() => setShowFolderPicker(false)}
        />
      )}
    </div>
  );
}
