import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../store.js";
import { api, type ClaudeConfigResponse } from "../api.js";
import { ClaudeMdEditor } from "./ClaudeMdEditor.js";

interface ConfigItem {
  label: string;
  path: string;
  kind: "claude-md" | "md" | "json";
  /** Override cwd for ClaudeMdEditor (e.g. ~/.claude for user-level CLAUDE.md) */
  editorCwd?: string;
}

// ─── Collapsible section header ──────────────────────────────────────────────

function SectionHeader({
  icon,
  title,
  expanded,
  onToggle,
}: {
  icon: "project" | "user";
  title: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      className="w-full flex items-center gap-2 px-4 py-2 text-left hover:bg-cc-hover/50 transition-colors cursor-pointer"
      aria-expanded={expanded}
    >
      {/* Chevron */}
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className={`w-3 h-3 text-cc-muted shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
      >
        <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {/* Icon */}
      <div className="w-4 h-4 flex items-center justify-center shrink-0">
        {icon === "project" ? (
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-cc-primary">
            <path d="M1.5 2A1.5 1.5 0 000 3.5v2A1.5 1.5 0 001.5 7h1v5.5A1.5 1.5 0 004 14h8a1.5 1.5 0 001.5-1.5V7h1A1.5 1.5 0 0016 5.5v-2A1.5 1.5 0 0014.5 2h-13zM4 7h8v5.5a.5.5 0 01-.5.5h-7a.5.5 0 01-.5-.5V7zm10-1H2V3.5a.5.5 0 01.5-.5h11a.5.5 0 01.5.5V6z" />
          </svg>
        ) : (
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-cc-primary">
            <path d="M8.354 1.146a.5.5 0 00-.708 0l-6 6A.5.5 0 002 7.5V14a1 1 0 001 1h3.5a.5.5 0 00.5-.5V11a.5.5 0 01.5-.5h1a.5.5 0 01.5.5v3.5a.5.5 0 00.5.5H13a1 1 0 001-1V7.5a.5.5 0 00-.146-.354l-6-6z" />
          </svg>
        )}
      </div>
      <span className="text-[11px] font-semibold text-cc-muted uppercase tracking-wider flex-1">
        {title}
      </span>
    </button>
  );
}

// ─── Individual config item row ──────────────────────────────────────────────

function ConfigItemRow({
  label,
  sublabel,
  count,
  onClick,
}: {
  label: string;
  sublabel?: string;
  count?: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2 px-4 pl-10 py-1.5 text-left hover:bg-cc-hover/50 transition-colors cursor-pointer"
    >
      <span className="text-[12px] text-cc-fg truncate flex-1">
        {label}
        {count !== undefined && count > 0 && (
          <span className="ml-1 text-[10px] text-cc-muted">({count})</span>
        )}
      </span>
      {sublabel && (
        <span className="text-[10px] text-cc-muted shrink-0">{sublabel}</span>
      )}
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className="w-3 h-3 text-cc-muted shrink-0"
      >
        <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

// ─── JSON Viewer Modal ───────────────────────────────────────────────────────

function JsonViewer({
  path,
  content,
  onClose,
}: {
  path: string;
  content: string;
  onClose: () => void;
}) {
  let formatted: string;
  try {
    formatted = JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    formatted = content;
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-50" onClick={onClose} />
      <div className="fixed inset-4 sm:inset-8 md:inset-x-[10%] md:inset-y-[5%] z-50 flex flex-col bg-cc-bg border border-cc-border rounded-2xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="shrink-0 flex items-center justify-between px-4 sm:px-5 py-3 bg-cc-card border-b border-cc-border">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-cc-primary/10 flex items-center justify-center">
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-cc-primary">
                <path d="M2 4a2 2 0 012-2h3.17a2 2 0 011.415.586l.828.828A2 2 0 0010.83 4H12a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V4z" />
              </svg>
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-cc-fg truncate">{path.split("/").pop()}</h2>
              <p className="text-[11px] text-cc-muted truncate">{path}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
            aria-label="Close"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        {/* Content */}
        <div className="flex-1 overflow-auto p-4">
          <pre className="text-[13px] font-mono-code text-cc-fg leading-relaxed whitespace-pre-wrap break-words">
            {formatted}
          </pre>
        </div>
        <div className="shrink-0 px-4 py-2 bg-cc-card border-t border-cc-border">
          <span className="text-[10px] text-cc-muted">Read-only</span>
        </div>
      </div>
    </>
  );
}

// ─── Generic Markdown File Editor ────────────────────────────────────────────

function MarkdownFileEditor({
  path,
  label,
  onClose,
}: {
  path: string;
  label: string;
  onClose: () => void;
}) {
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.readFile(path).then((res) => {
      setContent(res.content);
      setLoading(false);
    }).catch((e) => {
      setError(e instanceof Error ? e.message : "Failed to read file");
      setLoading(false);
    });
  }, [path]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.writeFile(path, content);
      setDirty(false);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const handleClose = () => {
    if (dirty && !confirm("Discard unsaved changes?")) return;
    onClose();
  };

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-50" onClick={handleClose} />
      <div className="fixed inset-4 sm:inset-8 md:inset-x-[10%] md:inset-y-[5%] z-50 flex flex-col bg-cc-bg border border-cc-border rounded-2xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="shrink-0 flex items-center justify-between px-4 sm:px-5 py-3 bg-cc-card border-b border-cc-border">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-cc-primary/10 flex items-center justify-center">
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-cc-primary">
                <path d="M4 1.5a.5.5 0 01.5-.5h7a.5.5 0 01.354.146l2 2A.5.5 0 0114 3.5v11a.5.5 0 01-.5.5h-11a.5.5 0 01-.5-.5v-13zm1 .5v12h8V4h-1.5a.5.5 0 01-.5-.5V2H5zm6 0v1h1l-1-1z" />
              </svg>
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-cc-fg truncate">{label}</h2>
              <p className="text-[11px] text-cc-muted truncate">{path}</p>
            </div>
          </div>
          <button
            onClick={handleClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
            aria-label="Close"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {loading ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="w-5 h-5 border-2 border-cc-primary border-t-transparent rounded-full animate-spin" />
          </div>
        ) : (
          <>
            {/* Save bar */}
            <div className="shrink-0 flex items-center justify-between px-4 py-2 bg-cc-card border-b border-cc-border">
              <span className="text-[12px] text-cc-muted font-mono-code truncate">{path.split("/").pop()}</span>
              <div className="flex items-center gap-2">
                {dirty && <span className="text-[10px] text-cc-warning font-medium">Unsaved</span>}
                <button
                  onClick={handleSave}
                  disabled={!dirty || saving}
                  className={`px-3 py-1 text-[11px] font-medium rounded-md transition-colors cursor-pointer ${
                    dirty && !saving
                      ? "bg-cc-primary text-white hover:bg-cc-primary/90"
                      : "bg-cc-hover text-cc-muted cursor-not-allowed"
                  }`}
                >
                  {saving ? "Saving..." : "Save"}
                </button>
              </div>
            </div>

            {/* Textarea */}
            <textarea
              value={content}
              onChange={(e) => { setContent(e.target.value); setDirty(true); }}
              spellCheck={false}
              className="flex-1 w-full p-4 bg-cc-bg text-cc-fg text-[13px] font-mono-code leading-relaxed resize-none focus:outline-none"
              placeholder="File contents..."
            />
          </>
        )}

        {error && (
          <div className="shrink-0 px-4 py-2 bg-cc-error/10 border-t border-cc-error/20 text-xs text-cc-error">
            {error}
          </div>
        )}
      </div>
    </>
  );
}

// ─── File Editor Portal ─────────────────────────────────────────────────────

function FileEditorPortal({
  item,
  cwd,
  onClose,
}: {
  item: ConfigItem;
  cwd: string;
  onClose: () => void;
}) {
  if (item.kind === "json") {
    const [content, setContent] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
      api.readFile(item.path).then((res) => {
        setContent(res.content);
        setLoading(false);
      }).catch(() => {
        setContent("Failed to read file");
        setLoading(false);
      });
    }, [item.path]);

    if (loading) return null;
    return <JsonViewer path={item.path} content={content || ""} onClose={onClose} />;
  }

  // CLAUDE.md files use the specialized ClaudeMdEditor (multi-file, walk-up)
  if (item.kind === "claude-md") {
    return <ClaudeMdEditor cwd={item.editorCwd || cwd} open onClose={onClose} />;
  }

  // All other .md files (skills, agents, commands) use the generic editor
  return <MarkdownFileEditor path={item.path} label={item.label} onClose={onClose} />;
}

// ─── Main component ──────────────────────────────────────────────────────────

export function ClaudeConfigBrowser({ sessionId }: { sessionId: string }) {
  const session = useStore((s) => s.sessions.get(sessionId));
  const sdk = useStore((s) => s.sdkSessions.find((x) => x.sessionId === sessionId));
  const cwd = session?.repo_root || session?.cwd || sdk?.cwd;

  const [config, setConfig] = useState<ClaudeConfigResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [projectExpanded, setProjectExpanded] = useState(false);
  const [userExpanded, setUserExpanded] = useState(false);
  const [activeItem, setActiveItem] = useState<ConfigItem | null>(null);

  const fetchConfig = useCallback(async () => {
    if (!cwd) return;
    try {
      const data = await api.getClaudeConfig(cwd);
      setConfig(data);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  if (!cwd) return null;

  if (loading) {
    return (
      <div className="shrink-0 px-4 py-2.5">
        <span className="text-[11px] text-cc-muted">Loading config...</span>
      </div>
    );
  }

  if (!config) return null;

  const projectItemCount =
    config.project.claudeMd.length +
    (config.project.settings ? 1 : 0) +
    (config.project.settingsLocal ? 1 : 0) +
    config.project.commands.length;

  const userItemCount =
    (config.user.claudeMd ? 1 : 0) +
    config.user.skills.length +
    config.user.agents.length +
    (config.user.settings ? 1 : 0) +
    config.user.commands.length;

  return (
    <div className="shrink-0" data-testid="claude-config-browser">
      {/* ── Project section ──────────────────────────────────────────── */}
      <SectionHeader
        icon="project"
        title={`Project (${projectItemCount})`}
        expanded={projectExpanded}
        onToggle={() => setProjectExpanded((p) => !p)}
      />
      {projectExpanded && (
        <div className="pb-1">
          {config.project.claudeMd.map((f) => (
            <ConfigItemRow
              key={f.path}
              label={f.path.includes(".claude/") ? ".claude/CLAUDE.md" : "CLAUDE.md"}
              onClick={() => setActiveItem({ label: "CLAUDE.md", path: f.path, kind: "claude-md" })}
            />
          ))}
          {config.project.settings && (
            <ConfigItemRow
              label="settings.json"
              onClick={() => setActiveItem({ label: "settings.json", path: config.project.settings!.path, kind: "json" })}
            />
          )}
          {config.project.settingsLocal && (
            <ConfigItemRow
              label="settings.local.json"
              onClick={() => setActiveItem({ label: "settings.local.json", path: config.project.settingsLocal!.path, kind: "json" })}
            />
          )}
          {config.project.commands.length > 0 && (
            <>
              <div className="px-4 pl-10 py-1 text-[10px] text-cc-muted uppercase tracking-wider">
                Commands ({config.project.commands.length})
              </div>
              {config.project.commands.map((cmd) => (
                <ConfigItemRow
                  key={cmd.path}
                  label={`/${cmd.name}`}
                  onClick={() => setActiveItem({ label: cmd.name, path: cmd.path, kind: "md" })}
                />
              ))}
            </>
          )}
          {projectItemCount === 0 && (
            <p className="px-4 pl-10 py-1.5 text-[11px] text-cc-muted">No .claude config found</p>
          )}
        </div>
      )}

      {/* ── User section ─────────────────────────────────────────────── */}
      <SectionHeader
        icon="user"
        title={`User (${userItemCount})`}
        expanded={userExpanded}
        onToggle={() => setUserExpanded((p) => !p)}
      />
      {userExpanded && (
        <div className="pb-1">
          {config.user.claudeMd && (
            <ConfigItemRow
              label="CLAUDE.md"
              onClick={() => setActiveItem({ label: "CLAUDE.md", path: config.user.claudeMd!.path, kind: "claude-md", editorCwd: config.user.root })}
            />
          )}
          {config.user.skills.length > 0 && (
            <>
              <div className="px-4 pl-10 py-1 text-[10px] text-cc-muted uppercase tracking-wider">
                Skills ({config.user.skills.length})
              </div>
              {config.user.skills.map((skill) => (
                <ConfigItemRow
                  key={skill.path}
                  label={skill.name}
                  sublabel={skill.description ? skill.description.slice(0, 40) : undefined}
                  onClick={() => setActiveItem({ label: skill.name, path: skill.path, kind: "md" })}
                />
              ))}
            </>
          )}
          {config.user.agents.length > 0 && (
            <>
              <div className="px-4 pl-10 py-1 text-[10px] text-cc-muted uppercase tracking-wider">
                Agents ({config.user.agents.length})
              </div>
              {config.user.agents.map((agent) => (
                <ConfigItemRow
                  key={agent.path}
                  label={agent.name}
                  onClick={() => setActiveItem({ label: agent.name, path: agent.path, kind: "md" })}
                />
              ))}
            </>
          )}
          {config.user.settings && (
            <ConfigItemRow
              label="settings.json"
              onClick={() => setActiveItem({ label: "settings.json", path: config.user.settings!.path, kind: "json" })}
            />
          )}
          {config.user.commands.length > 0 && (
            <>
              <div className="px-4 pl-10 py-1 text-[10px] text-cc-muted uppercase tracking-wider">
                Commands ({config.user.commands.length})
              </div>
              {config.user.commands.map((cmd) => (
                <ConfigItemRow
                  key={cmd.path}
                  label={`/${cmd.name}`}
                  onClick={() => setActiveItem({ label: cmd.name, path: cmd.path, kind: "md" })}
                />
              ))}
            </>
          )}
          {userItemCount === 0 && (
            <p className="px-4 pl-10 py-1.5 text-[11px] text-cc-muted">No user config found</p>
          )}
        </div>
      )}

      {/* ── File viewer portal ───────────────────────────────────────── */}
      {activeItem && createPortal(
        <FileEditorPortal
          item={activeItem}
          cwd={cwd}
          onClose={() => setActiveItem(null)}
        />,
        document.body,
      )}
    </div>
  );
}
