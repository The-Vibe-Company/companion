import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type SavedPrompt } from "../api.js";
import { useStore } from "../store.js";
import { navigateHome, navigateToSession } from "../utils/routing.js";
import { FolderPicker } from "./FolderPicker.js";

interface PromptsPageProps {
  embedded?: boolean;
}

export function PromptsPage({ embedded = false }: PromptsPageProps) {
  const [prompts, setPrompts] = useState<SavedPrompt[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [createScope, setCreateScope] = useState<"global" | "project">("global");
  const [createFolders, setCreateFolders] = useState<string[]>([]);
  const [showFolderPicker, setShowFolderPicker] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editContent, setEditContent] = useState("");
  const [editScope, setEditScope] = useState<"global" | "project">("global");
  const [editFolders, setEditFolders] = useState<string[]>([]);
  const [showEditFolderPicker, setShowEditFolderPicker] = useState(false);
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);

  const currentSessionId = useStore((s) => s.currentSessionId);
  const cwd = useStore((s) => {
    if (!s.currentSessionId) return "";
    return s.sessions.get(s.currentSessionId)?.cwd
      || s.sdkSessions.find((sdk) => sdk.sessionId === s.currentSessionId)?.cwd
      || "";
  });

  const filteredPrompts = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return prompts;
    return prompts.filter((prompt) => {
      const haystack = `${prompt.name}\n${prompt.content}\n${prompt.scope}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [prompts, search]);
  const totalPrompts = prompts.length;
  const visiblePrompts = filteredPrompts.length;

  /** Group filtered prompts: global first, then by project folder */
  const groupedPrompts = useMemo(() => {
    const globalPrompts = filteredPrompts.filter((p) => p.scope === "global");
    const projectPrompts = filteredPrompts.filter((p) => p.scope === "project");

    // Group project prompts by their folder key (sorted joined paths)
    const folderGroups = new Map<string, { label: string; prompts: SavedPrompt[] }>();
    for (const p of projectPrompts) {
      const paths = p.projectPaths ?? (p.projectPath ? [p.projectPath] : []);
      const key = paths.length > 0 ? paths.slice().sort().join("\n") : "(no folder)";
      const label = paths.length > 0
        ? paths.map((fp) => fp.split("/").pop() || fp).join(", ")
        : "(no folder)";
      if (!folderGroups.has(key)) {
        folderGroups.set(key, { label, prompts: [] });
      }
      folderGroups.get(key)!.prompts.push(p);
    }

    return { globalPrompts, folderGroups };
  }, [filteredPrompts]);

  const loadPrompts = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      // Fetch all prompts regardless of session cwd
      const items = await api.listPrompts();
      setPrompts(items);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPrompts();
  }, [loadPrompts]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !content.trim()) return;
    if (createScope === "project" && createFolders.length === 0) {
      setError("Select at least one project folder");
      return;
    }

    setSaving(true);
    setError("");
    try {
      await api.createPrompt({
        name: name.trim(),
        content: content.trim(),
        scope: createScope,
        projectPaths: createScope === "project" ? createFolders : undefined,
      });
      setName("");
      setContent("");
      setCreateScope("global");
      setCreateFolders([]);
      setShowCreate(false);
      await loadPrompts();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    try {
      await api.deletePrompt(id);
      await loadPrompts();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleSaveEdit() {
    if (!editingId || !editName.trim() || !editContent.trim()) return;
    if (editScope === "project" && editFolders.length === 0) {
      setError("Select at least one project folder");
      return;
    }
    try {
      await api.updatePrompt(editingId, {
        name: editName.trim(),
        content: editContent.trim(),
        scope: editScope,
        projectPaths: editScope === "project" ? editFolders : undefined,
      });
      setEditingId(null);
      setEditName("");
      setEditContent("");
      setEditScope("global");
      setEditFolders([]);
      await loadPrompts();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className={`${embedded ? "h-full" : "h-[100dvh]"} bg-cc-bg text-cc-fg font-sans-ui antialiased overflow-y-auto`}>
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-10 pb-safe">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 mb-2">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-cc-fg">Saved Prompts</h1>
            <p className="mt-0.5 text-[13px] text-cc-muted leading-relaxed">
              Create reusable prompts — insert with <code className="text-cc-fg text-xs bg-cc-hover rounded px-1 py-0.5">@title</code> in the composer.
            </p>
          </div>
          {!embedded && (
            <button
              onClick={() => {
                if (currentSessionId) {
                  navigateToSession(currentSessionId);
                } else {
                  navigateHome();
                }
              }}
              className="px-3 py-2.5 min-h-[44px] rounded-lg text-sm text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer shrink-0"
            >
              Back
            </button>
          )}
        </div>

        {/* Toolbar: search + create CTA */}
        <div className="flex items-center gap-2 mt-4 mb-5">
          <div className="relative flex-1 min-w-0">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-cc-muted pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.35-4.35" />
            </svg>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by title or content..."
              className="w-full pl-9 pr-3 py-2.5 min-h-[44px] text-sm bg-cc-card rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:ring-1 focus:ring-cc-primary/40 transition-shadow"
            />
          </div>
          <button
            onClick={() => setShowCreate(!showCreate)}
            className={`flex items-center gap-1.5 px-3.5 py-2.5 min-h-[44px] rounded-lg text-sm font-medium transition-colors cursor-pointer shrink-0 ${
              showCreate
                ? "bg-cc-active text-cc-fg"
                : "bg-cc-primary hover:bg-cc-primary-hover text-white"
            }`}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
              {showCreate ? <path d="M18 6 6 18M6 6l12 12" /> : <path d="M12 5v14M5 12h14" />}
            </svg>
            <span className="hidden sm:inline">{showCreate ? "Cancel" : "New Prompt"}</span>
          </button>
        </div>

        {/* Inline create form */}
        {showCreate && (
          <form
            onSubmit={handleCreate}
            className="mb-6"
            style={{ animation: "fadeSlideIn 150ms ease-out" }}
          >
            <PromptEditorCard
              mode="create"
              name={name}
              content={content}
              scope={createScope}
              folders={createFolders}
              error={error}
              saving={saving}
              submitLabel={saving ? "Saving..." : "Create Prompt"}
              onNameChange={setName}
              onContentChange={setContent}
              onScopeChange={(s) => {
                setCreateScope(s);
                if (s === "project" && createFolders.length === 0 && cwd) {
                  setCreateFolders([cwd]);
                }
              }}
              onRemoveFolder={(path) => setCreateFolders((f) => f.filter((p) => p !== path))}
              onAddFolder={() => setShowFolderPicker(true)}
            />
          </form>
        )}

        {/* Stats */}
        <div className="flex items-center gap-2 mb-3 text-[12px] text-cc-muted">
          <span>{visiblePrompts === totalPrompts ? `${totalPrompts} prompt${totalPrompts !== 1 ? "s" : ""}` : `${visiblePrompts} of ${totalPrompts}`}</span>
        </div>

        {/* Prompt list — grouped by scope */}
        {loading ? (
          <div className="py-12 text-center text-sm text-cc-muted">Loading prompts...</div>
        ) : prompts.length === 0 ? (
          <div className="py-12 text-center text-sm text-cc-muted">No prompts yet.</div>
        ) : filteredPrompts.length === 0 ? (
          <div className="py-12 text-center text-sm text-cc-muted">No prompts match your search.</div>
        ) : (
          <div className="space-y-4">
            {/* Global section */}
            {groupedPrompts.globalPrompts.length > 0 && (
              <div>
                <h2 className="text-[11px] uppercase tracking-wider text-cc-muted font-semibold mb-1.5 px-1">Global</h2>
                <div className="space-y-1">
                  {groupedPrompts.globalPrompts.map((prompt) => (
                    <PromptRow
                      key={prompt.id}
                      prompt={prompt}
                      isEditing={editingId === prompt.id}
                      error={error}
                      editName={editName}
                      editContent={editContent}
                      editScope={editScope}
                      editFolders={editFolders}
                      cwd={cwd}
                      onEditNameChange={setEditName}
                      onEditContentChange={setEditContent}
                      onEditScopeChange={(s) => {
                        setEditScope(s);
                        if (s === "project" && editFolders.length === 0 && cwd) {
                          setEditFolders([cwd]);
                        }
                      }}
                      onEditRemoveFolder={(path) => setEditFolders((f) => f.filter((p) => p !== path))}
                      onEditAddFolder={() => setShowEditFolderPicker(true)}
                      onStartEdit={() => {
                        setEditingId(prompt.id);
                        setEditName(prompt.name);
                        setEditContent(prompt.content);
                        setEditScope(prompt.scope);
                        setEditFolders(prompt.projectPaths ?? (prompt.projectPath ? [prompt.projectPath] : []));
                      }}
                      onCancelEdit={() => {
                        setEditingId(null);
                        setEditName("");
                        setEditContent("");
                        setEditScope("global");
                        setEditFolders([]);
                      }}
                      onSaveEdit={() => void handleSaveEdit()}
                      onDelete={() => void handleDelete(prompt.id)}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Project folder sections */}
            {Array.from(groupedPrompts.folderGroups.entries()).map(([key, group]) => (
              <div key={key}>
                <h2 className="text-[11px] uppercase tracking-wider text-cc-muted font-semibold mb-1.5 px-1">{group.label}</h2>
                <div className="space-y-1">
                  {group.prompts.map((prompt) => (
                    <PromptRow
                      key={prompt.id}
                      prompt={prompt}
                      isEditing={editingId === prompt.id}
                      error={error}
                      editName={editName}
                      editContent={editContent}
                      editScope={editScope}
                      editFolders={editFolders}
                      cwd={cwd}
                      onEditNameChange={setEditName}
                      onEditContentChange={setEditContent}
                      onEditScopeChange={(s) => {
                        setEditScope(s);
                        if (s === "project" && editFolders.length === 0 && cwd) {
                          setEditFolders([cwd]);
                        }
                      }}
                      onEditRemoveFolder={(path) => setEditFolders((f) => f.filter((p) => p !== path))}
                      onEditAddFolder={() => setShowEditFolderPicker(true)}
                      onStartEdit={() => {
                        setEditingId(prompt.id);
                        setEditName(prompt.name);
                        setEditContent(prompt.content);
                        setEditScope(prompt.scope);
                        setEditFolders(prompt.projectPaths ?? (prompt.projectPath ? [prompt.projectPath] : []));
                      }}
                      onCancelEdit={() => {
                        setEditingId(null);
                        setEditName("");
                        setEditContent("");
                        setEditScope("global");
                        setEditFolders([]);
                      }}
                      onSaveEdit={() => void handleSaveEdit()}
                      onDelete={() => void handleDelete(prompt.id)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Folder picker for create */}
      {showFolderPicker && (
        <FolderPicker
          initialPath={cwd || "/"}
          onSelect={(path) => {
            setCreateFolders((prev) => prev.includes(path) ? prev : [...prev, path]);
            setShowFolderPicker(false);
          }}
          onClose={() => setShowFolderPicker(false)}
        />
      )}

      {/* Folder picker for edit */}
      {showEditFolderPicker && (
        <FolderPicker
          initialPath={cwd || "/"}
          onSelect={(path) => {
            setEditFolders((prev) => prev.includes(path) ? prev : [...prev, path]);
            setShowEditFolderPicker(false);
          }}
          onClose={() => setShowEditFolderPicker(false)}
        />
      )}
    </div>
  );
}

/* ─── Scope Selector ─────────────────────────────────────────────── */

interface ScopeSelectorProps {
  scope: "global" | "project";
  onScopeChange: (scope: "global" | "project") => void;
  folders: string[];
  onRemoveFolder: (path: string) => void;
  onAddFolder: () => void;
}

function ScopeSelector({ scope, onScopeChange, folders, onRemoveFolder, onAddFolder }: ScopeSelectorProps) {
  return (
    <div className="space-y-3">
      <div>
        <label className="block text-xs font-medium uppercase tracking-[0.24em] text-cc-muted">Scope</label>
        <p className="mt-1 text-xs text-cc-muted/80">
          Choose whether this prompt should be available everywhere or only inside specific repos.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-pressed={scope === "global"}
          onClick={() => onScopeChange("global")}
          className={`inline-flex min-h-[40px] items-center rounded-full border px-4 py-2 text-sm transition-colors cursor-pointer ${
            scope === "global"
              ? "border-cc-primary/40 text-cc-primary bg-cc-primary/10 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)]"
              : "border-cc-border text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
          }`}
        >
          Global
        </button>
        <button
          type="button"
          aria-pressed={scope === "project"}
          onClick={() => onScopeChange("project")}
          className={`inline-flex min-h-[40px] items-center rounded-full border px-4 py-2 text-sm transition-colors cursor-pointer ${
            scope === "project"
              ? "border-cc-primary/40 text-cc-primary bg-cc-primary/10 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)]"
              : "border-cc-border text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
          }`}
        >
          Project folders
        </button>
      </div>

      {scope === "project" && (
        <div className="rounded-2xl border border-cc-border/70 bg-cc-bg/60 p-3 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-cc-fg">Project folders</p>
              <p className="mt-1 text-xs text-cc-muted">
                Prompts scoped to folders only appear when the active session is inside one of those paths.
              </p>
            </div>
          </div>
          {folders.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {folders.map((folder) => (
                <span
                  key={folder}
                  className="inline-flex min-h-[32px] items-center gap-1.5 rounded-full border border-cc-border/80 bg-cc-hover px-3 py-1.5 text-xs font-mono-code text-cc-fg"
                >
                  <span className="truncate max-w-[200px]" title={folder}>
                    {folder.split("/").pop() || folder}
                  </span>
                  <button
                    type="button"
                    onClick={() => onRemoveFolder(folder)}
                    className="text-cc-muted hover:text-cc-error cursor-pointer shrink-0"
                    aria-label={`Remove folder ${folder}`}
                  >
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="w-3 h-3">
                      <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
                    </svg>
                  </button>
                </span>
              ))}
            </div>
          )}
          <button
            type="button"
            onClick={onAddFolder}
            className="inline-flex min-h-[40px] items-center gap-1.5 rounded-full border border-dashed border-cc-border px-3 py-2 text-sm text-cc-muted transition-colors cursor-pointer hover:text-cc-fg hover:bg-cc-hover"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3 h-3">
              <path d="M8 3v10M3 8h10" strokeLinecap="round" />
            </svg>
            Add folder
          </button>
        </div>
      )}
    </div>
  );
}

interface PromptEditorCardProps {
  mode: "create" | "edit";
  name: string;
  content: string;
  scope: "global" | "project";
  folders: string[];
  saving?: boolean;
  error?: string;
  submitLabel: string;
  cancelLabel?: string;
  onNameChange: (value: string) => void;
  onContentChange: (value: string) => void;
  onScopeChange: (scope: "global" | "project") => void;
  onRemoveFolder: (path: string) => void;
  onAddFolder: () => void;
  onSubmit?: () => void;
  onCancel?: () => void;
}

function PromptEditorCard({
  mode,
  name,
  content,
  scope,
  folders,
  saving = false,
  error,
  submitLabel,
  cancelLabel = "Cancel",
  onNameChange,
  onContentChange,
  onScopeChange,
  onRemoveFolder,
  onAddFolder,
  onSubmit,
  onCancel,
}: PromptEditorCardProps) {
  const isValid = Boolean(name.trim() && content.trim());
  const contentLines = content.split(/\r?\n/).length;
  const contentChars = content.length;

  return (
    <section className="overflow-hidden rounded-[28px] border border-cc-border/70 bg-cc-card shadow-[0_20px_60px_rgba(0,0,0,0.22)]">
      <div className="border-b border-cc-border/60 bg-[linear-gradient(135deg,rgba(255,255,255,0.04),rgba(255,255,255,0))] px-5 py-4 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-cc-primary/80">
              {mode === "create" ? "Prompt Studio" : "Edit Prompt"}
            </p>
            <h2 className="mt-1 text-xl font-semibold text-cc-fg">
              {mode === "create" ? "Write with room to think" : "Refine this saved prompt"}
            </h2>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-cc-muted">
              Structure the title, scope, and body separately so longer instructions stay easy to review before saving.
            </p>
          </div>
          <div className="flex flex-wrap gap-2 text-xs text-cc-muted">
            <span className="inline-flex min-h-[32px] items-center rounded-full border border-cc-border/70 bg-cc-bg/60 px-3">
              {contentLines} line{contentLines > 1 ? "s" : ""}
            </span>
            <span className="inline-flex min-h-[32px] items-center rounded-full border border-cc-border/70 bg-cc-bg/60 px-3">
              {contentChars} char{contentChars > 1 ? "s" : ""}
            </span>
          </div>
        </div>
      </div>

      <div className="grid gap-0 lg:grid-cols-[minmax(280px,340px)_minmax(0,1fr)]">
        <div className="border-b border-cc-border/60 p-5 sm:p-6 lg:border-b-0 lg:border-r">
          <div className="space-y-5">
            <div>
              <label className="mb-1.5 block text-xs font-medium uppercase tracking-[0.24em] text-cc-muted" htmlFor={mode === "create" ? "prompt-name" : undefined}>
                Title
              </label>
              <input
                id={mode === "create" ? "prompt-name" : undefined}
                type="text"
                value={name}
                onChange={(e) => onNameChange(e.target.value)}
                placeholder="review-pr"
                className="w-full rounded-2xl border border-cc-border/70 bg-cc-bg px-4 py-3 text-sm text-cc-fg placeholder:text-cc-muted focus:outline-none focus:ring-1 focus:ring-cc-primary/40 transition-shadow"
              />
              <p className="mt-2 text-xs leading-relaxed text-cc-muted">
                Use a short handle that is easy to insert with <code className="rounded bg-cc-hover px-1 py-0.5 text-[11px] text-cc-fg">@title</code>.
              </p>
            </div>

            <ScopeSelector
              scope={scope}
              onScopeChange={onScopeChange}
              folders={folders}
              onRemoveFolder={onRemoveFolder}
              onAddFolder={onAddFolder}
            />

            <div className="rounded-2xl border border-dashed border-cc-border/70 bg-cc-bg/40 p-4">
              <p className="text-xs font-medium uppercase tracking-[0.24em] text-cc-muted">Storage</p>
              <p className="mt-2 text-sm leading-relaxed text-cc-muted">
                Saved in <code className="text-[11px] text-cc-fg">~/.companion/prompts.json</code> and available from the composer autocomplete.
              </p>
            </div>
          </div>
        </div>

        <div className="p-5 sm:p-6">
          <div className="space-y-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <label className="mb-1.5 block text-xs font-medium uppercase tracking-[0.24em] text-cc-muted" htmlFor={mode === "create" ? "prompt-content" : undefined}>
                  Content
                </label>
                <p className="text-sm text-cc-muted">
                  Longer prompts stay readable here. Leave breathing room for detailed review flows, checklists, or operating instructions.
                </p>
              </div>
            </div>

            <textarea
              id={mode === "create" ? "prompt-content" : undefined}
              value={content}
              onChange={(e) => onContentChange(e.target.value)}
              placeholder="Review this PR and summarize risks, regressions, and missing tests."
              rows={mode === "create" ? 14 : 10}
              className="min-h-[320px] w-full resize-y rounded-[24px] border border-cc-border/70 bg-cc-bg px-4 py-4 text-sm leading-7 text-cc-fg placeholder:text-cc-muted focus:outline-none focus:ring-1 focus:ring-cc-primary/40 transition-shadow lg:min-h-[420px]"
            />

            {error && (
              <div className="rounded-2xl border border-cc-error/20 bg-cc-error/10 px-4 py-3 text-sm text-cc-error">
                {error}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-cc-border/60 pt-4">
              {onCancel && (
                <button
                  type="button"
                  onClick={onCancel}
                  className="min-h-[44px] rounded-full px-4 py-2.5 text-sm text-cc-muted transition-colors cursor-pointer hover:bg-cc-hover hover:text-cc-fg"
                >
                  {cancelLabel}
                </button>
              )}
              <button
                type={onSubmit ? "button" : "submit"}
                onClick={onSubmit}
                disabled={saving || !isValid}
                className={`min-h-[44px] rounded-full px-5 py-2.5 text-sm font-medium transition-colors ${
                  saving || !isValid
                    ? "bg-cc-hover text-cc-muted cursor-not-allowed"
                    : "bg-cc-primary text-white cursor-pointer hover:bg-cc-primary-hover"
                }`}
              >
                {submitLabel}
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ─── Scope Badge ────────────────────────────────────────────────── */

function ScopeBadge({ prompt }: { prompt: SavedPrompt }) {
  if (prompt.scope === "global") {
    return <span className="text-[10px] uppercase tracking-wider text-cc-muted opacity-60">global</span>;
  }
  const paths = prompt.projectPaths ?? (prompt.projectPath ? [prompt.projectPath] : []);
  if (paths.length === 0) return null;
  return (
    <span className="inline-flex items-center gap-1 flex-wrap">
      {paths.map((p) => (
        <span
          key={p}
          className="text-[10px] px-1.5 py-0.5 rounded bg-cc-primary/8 text-cc-primary/70 font-mono-code"
          title={p}
        >
          {p.split("/").pop() || p}
        </span>
      ))}
    </span>
  );
}

/* ─── Prompt Row ──────────────────────────────────────────────────── */

interface PromptRowProps {
  prompt: SavedPrompt;
  isEditing: boolean;
  editName: string;
  editContent: string;
  editScope: "global" | "project";
  editFolders: string[];
  error?: string;
  cwd: string;
  onEditNameChange: (v: string) => void;
  onEditContentChange: (v: string) => void;
  onEditScopeChange: (s: "global" | "project") => void;
  onEditRemoveFolder: (path: string) => void;
  onEditAddFolder: () => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: () => void;
  onDelete: () => void;
}

function PromptRow({
  prompt,
  isEditing,
  error,
  editName,
  editContent,
  editScope,
  editFolders,
  onEditNameChange,
  onEditContentChange,
  onEditScopeChange,
  onEditRemoveFolder,
  onEditAddFolder,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onDelete,
}: PromptRowProps) {
  if (isEditing) {
    return (
      <div
        className="rounded-2xl"
        style={{ animation: "fadeSlideIn 150ms ease-out" }}
      >
        <PromptEditorCard
          mode="edit"
          name={editName}
          content={editContent}
          scope={editScope}
          folders={editFolders}
          error={error}
          submitLabel="Save"
          onNameChange={onEditNameChange}
          onContentChange={onEditContentChange}
          onScopeChange={onEditScopeChange}
          onRemoveFolder={onEditRemoveFolder}
          onAddFolder={onEditAddFolder}
          onCancel={onCancelEdit}
          onSubmit={onSaveEdit}
        />
      </div>
    );
  }

  return (
    <div className="group flex items-start gap-3 px-3 py-3 min-h-[44px] rounded-lg hover:bg-cc-hover/60 transition-colors">
      {/* Icon */}
      <div className="shrink-0 mt-0.5 w-7 h-7 rounded-md bg-cc-primary/10 flex items-center justify-center">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5 text-cc-primary">
          <path d="M7 8h10M7 12h6M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H8l-4 4V5Z" />
        </svg>
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-cc-fg truncate">{prompt.name}</span>
          <ScopeBadge prompt={prompt} />
        </div>
        <p className="mt-0.5 text-xs text-cc-muted line-clamp-2 leading-relaxed">{prompt.content}</p>
      </div>

      {/* Actions — visible on hover (desktop) or always (mobile/touch) */}
      <div className="shrink-0 flex items-center gap-0.5 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
        <button
          onClick={onStartEdit}
          className="p-2 min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 sm:p-1.5 rounded-md text-cc-muted hover:text-cc-fg hover:bg-cc-active transition-colors cursor-pointer"
          aria-label="Edit"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5Z" />
          </svg>
        </button>
        <button
          onClick={onDelete}
          className="p-2 min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 sm:p-1.5 rounded-md text-cc-muted hover:text-cc-error hover:bg-cc-error/10 transition-colors cursor-pointer"
          aria-label="Delete"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
            <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14Z" />
          </svg>
        </button>
      </div>
    </div>
  );
}
