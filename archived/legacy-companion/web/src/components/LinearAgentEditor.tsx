import { useState, useEffect, useRef } from "react";
import { getModelsForBackend, getDefaultModel, getAgentModesForBackend, getDefaultAgentMode } from "../utils/backends.js";
import { FolderPicker } from "./FolderPicker.js";
import { LinearLogo } from "./LinearLogo.js";
import type { AgentFormData } from "./AgentEditor.js";

// --- Props ---

interface LinearAgentEditorProps {
  form: AgentFormData;
  setForm: (f: AgentFormData | ((prev: AgentFormData) => AgentFormData)) => void;
  editingId: string;
  error: string;
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
  onOpenGenericEditor: () => void;
}

// --- Component ---

export function LinearAgentEditor({
  form,
  setForm,
  editingId,
  error,
  saving,
  onSave,
  onCancel,
  onOpenGenericEditor,
}: LinearAgentEditorProps) {
  const [showFolderPicker, setShowFolderPicker] = useState(false);
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [showModeDropdown, setShowModeDropdown] = useState(false);
  const modelDropdownRef = useRef<HTMLDivElement>(null);
  const modeDropdownRef = useRef<HTMLDivElement>(null);

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

  // Click-outside handlers for dropdowns
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(e.target as Node)) {
        setShowModelDropdown(false);
      }
      if (modeDropdownRef.current && !modeDropdownRef.current.contains(e.target as Node)) {
        setShowModeDropdown(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Derive labels
  const models = getModelsForBackend(form.backendType);
  const modes = getAgentModesForBackend(form.backendType);
  const selectedModel = models.find((m) => m.value === form.model) || models[0];
  const selectedMode = modes.find((m) => m.value === form.permissionMode) || modes[0];
  const folderLabel = form.cwd ? form.cwd.split("/").pop() || form.cwd : "temp";

  // Common pill classes
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
            <LinearLogo className="w-5 h-5 text-cc-fg" />
            <div>
              <h1 className="text-lg font-semibold text-cc-fg">
                Edit Linear Agent
              </h1>
              <p className="text-[10px] text-cc-muted font-mono-code">
                ID: {editingId}
              </p>
            </div>
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
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-4 px-3 py-2 rounded-lg bg-cc-error/10 border border-cc-error/30 text-cc-error text-xs">
            {error}
          </div>
        )}

        <div className="space-y-5">
          {/* Name */}
          <input
            value={form.name}
            onChange={(e) => updateField("name", e.target.value)}
            placeholder="Agent name *"
            className="w-full px-3 py-2 rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg text-sm focus:outline-none focus:ring-1 focus:ring-cc-primary"
          />

          {/* Description */}
          <input
            value={form.description}
            onChange={(e) => updateField("description", e.target.value)}
            placeholder="Short description (optional)"
            className="w-full px-3 py-1.5 rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg text-xs focus:outline-none focus:ring-1 focus:ring-cc-primary"
          />

          {/* Prompt */}
          <div>
            <textarea
              value={form.prompt}
              onChange={(e) => updateField("prompt", e.target.value)}
              placeholder={"System prompt *\nWrite the agent\u2019s instructions here.\nUse {{input}} as a placeholder for trigger-provided input."}
              className="w-full px-3 py-2 rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg text-sm resize-none h-40 font-mono-code focus:outline-none focus:ring-1 focus:ring-cc-primary"
            />
            <p className="text-[10px] text-cc-muted mt-1">
              Use <code className="px-1 py-0.5 rounded bg-cc-hover">{"{{input}}"}</code> where trigger input should be inserted.
            </p>
          </div>

          {/* Controls Row */}
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
                onClick={() => { setShowModelDropdown(!showModelDropdown); setShowModeDropdown(false); }}
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
                onClick={() => { setShowModeDropdown(!showModeDropdown); setShowModelDropdown(false); }}
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

          {/* Linear info panel */}
          <section className="rounded-lg border border-cc-success/30 bg-cc-success/5 p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-cc-success/10 text-cc-success border border-cc-success/20">
                  Linear Agent trigger enabled
                </span>
              </div>
              <button onClick={onOpenGenericEditor} className="text-xs text-cc-muted hover:text-cc-fg transition-colors cursor-pointer">
                {"Open in full editor \u2192"}
              </button>
            </div>
            <p className="text-[10px] text-cc-muted mt-2">
              This agent responds to @mentions in Linear.{" "}
              <a href="#/integrations/linear-oauth" className="text-cc-primary underline">Manage OAuth connections</a>.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
