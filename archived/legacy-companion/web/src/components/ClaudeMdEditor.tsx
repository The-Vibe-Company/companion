import { useState, useEffect, useCallback } from "react";
import { api } from "../api.js";

interface ClaudeMdFile {
  path: string;
  content: string;
}

interface ClaudeMdEditorProps {
  cwd: string;
  open: boolean;
  onClose: () => void;
}

export function ClaudeMdEditor({ cwd, open, onClose }: ClaudeMdEditorProps) {
  const [files, setFiles] = useState<ClaudeMdFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [editContent, setEditContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createMode, setCreateMode] = useState<null | string>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api
      .getClaudeMdFiles(cwd)
      .then((res) => {
        setFiles(res.files);
        if (res.files.length > 0) {
          setSelectedIdx(0);
          setEditContent(res.files[0].content);
          setCreateMode(null);
        } else {
          setCreateMode(null);
        }
        setDirty(false);
        setLoading(false);
      })
      .catch((e) => {
        setError(e.message);
        setLoading(false);
      });
  }, [cwd]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  const handleSelect = (idx: number) => {
    if (dirty && !confirm("Discard unsaved changes?")) return;
    setSelectedIdx(idx);
    setEditContent(files[idx].content);
    setDirty(false);
    setCreateMode(null);
  };

  const handleSave = async () => {
    const path = createMode || files[selectedIdx]?.path;
    if (!path) return;
    setSaving(true);
    setError(null);
    try {
      await api.saveClaudeMd(path, editContent);
      setDirty(false);
      // Reload to pick up new file
      if (createMode) {
        load();
      } else {
        setFiles((prev) =>
          prev.map((f, i) =>
            i === selectedIdx ? { ...f, content: editContent } : f,
          ),
        );
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const handleCreate = (location: "root" | "dotclaude") => {
    const path =
      location === "root" ? `${cwd}/CLAUDE.md` : `${cwd}/.claude/CLAUDE.md`;
    setCreateMode(path);
    setEditContent("# CLAUDE.md\n\n");
    setDirty(true);
  };

  const handleClose = () => {
    if (dirty && !confirm("Discard unsaved changes?")) return;
    onClose();
  };

  if (!open) return null;

  const relPath = (p: string) =>
    p.startsWith(cwd + "/") ? p.slice(cwd.length + 1) : p;

  // Check which locations already have files
  const hasRoot = files.some((f) => f.path === `${cwd}/CLAUDE.md`);
  const hasDotClaude = files.some(
    (f) => f.path === `${cwd}/.claude/CLAUDE.md`,
  );

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/40 z-50"
        onClick={handleClose}
      />

      {/* Modal */}
      <div className="fixed inset-4 sm:inset-8 md:inset-x-[10%] md:inset-y-[5%] z-50 flex flex-col bg-cc-bg border border-cc-border rounded-2xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="shrink-0 flex items-center justify-between px-4 sm:px-5 py-3 bg-cc-card border-b border-cc-border">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-cc-primary/10 flex items-center justify-center">
              <svg
                viewBox="0 0 16 16"
                fill="currentColor"
                className="w-3.5 h-3.5 text-cc-primary"
              >
                <path d="M4 1.5a.5.5 0 01.5-.5h7a.5.5 0 01.354.146l2 2A.5.5 0 0114 3.5v11a.5.5 0 01-.5.5h-11a.5.5 0 01-.5-.5v-13zm1 .5v12h8V4h-1.5a.5.5 0 01-.5-.5V2H5zm6 0v1h1l-1-1z" />
              </svg>
            </div>
            <div>
              <h2 className="text-sm font-semibold text-cc-fg">CLAUDE.md</h2>
              <p className="text-[11px] text-cc-muted">
                Project instructions for Claude Code
              </p>
            </div>
          </div>
          <button
            onClick={handleClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
          >
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="w-4 h-4"
            >
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 flex min-h-0">
          {loading ? (
            <div className="flex-1 flex items-center justify-center">
              <div className="w-5 h-5 border-2 border-cc-primary border-t-transparent rounded-full animate-spin" />
            </div>
          ) : (
            <>
              {/* File tabs sidebar */}
              <div className="shrink-0 w-[180px] sm:w-[200px] border-r border-cc-border bg-cc-sidebar flex flex-col">
                <div className="px-3 py-2 text-[10px] font-semibold text-cc-muted uppercase tracking-wider border-b border-cc-border">
                  Files
                </div>
                <div className="flex-1 overflow-y-auto py-1">
                  {files.map((f, i) => (
                    <button
                      key={f.path}
                      onClick={() => handleSelect(i)}
                      className={`flex items-center gap-2 w-full px-3 py-2 text-left text-[12px] transition-colors cursor-pointer ${
                        !createMode && selectedIdx === i
                          ? "bg-cc-active text-cc-fg"
                          : "text-cc-fg/70 hover:bg-cc-hover"
                      }`}
                    >
                      <svg
                        viewBox="0 0 16 16"
                        fill="currentColor"
                        className="w-3 h-3 text-cc-primary shrink-0"
                      >
                        <path d="M4 1.5a.5.5 0 01.5-.5h7a.5.5 0 01.354.146l2 2A.5.5 0 0114 3.5v11a.5.5 0 01-.5.5h-11a.5.5 0 01-.5-.5v-13z" />
                      </svg>
                      <span className="truncate font-mono-code">
                        {relPath(f.path)}
                      </span>
                    </button>
                  ))}
                  {createMode && (
                    <div className="flex items-center gap-2 w-full px-3 py-2 text-[12px] bg-cc-active text-cc-fg">
                      <svg
                        viewBox="0 0 16 16"
                        fill="currentColor"
                        className="w-3 h-3 text-cc-success shrink-0"
                      >
                        <path d="M8 2a.5.5 0 01.5.5v5h5a.5.5 0 010 1h-5v5a.5.5 0 01-1 0v-5h-5a.5.5 0 010-1h5v-5A.5.5 0 018 2z" />
                      </svg>
                      <span className="truncate font-mono-code">
                        {relPath(createMode)}
                      </span>
                    </div>
                  )}
                </div>

                {/* Create new file button */}
                {(!hasRoot || !hasDotClaude) && !createMode && (
                  <div className="shrink-0 border-t border-cc-border p-2">
                    <div className="text-[10px] text-cc-muted uppercase tracking-wider px-1 mb-1">
                      Create new
                    </div>
                    {!hasRoot && (
                      <button
                        onClick={() => handleCreate("root")}
                        className="flex items-center gap-1.5 w-full px-2 py-1.5 text-[11px] text-cc-fg/70 hover:bg-cc-hover rounded-md transition-colors cursor-pointer"
                      >
                        <svg
                          viewBox="0 0 16 16"
                          fill="currentColor"
                          className="w-3 h-3 text-cc-success shrink-0"
                        >
                          <path d="M8 2a.5.5 0 01.5.5v5h5a.5.5 0 010 1h-5v5a.5.5 0 01-1 0v-5h-5a.5.5 0 010-1h5v-5A.5.5 0 018 2z" />
                        </svg>
                        <span className="font-mono-code">CLAUDE.md</span>
                      </button>
                    )}
                    {!hasDotClaude && (
                      <button
                        onClick={() => handleCreate("dotclaude")}
                        className="flex items-center gap-1.5 w-full px-2 py-1.5 text-[11px] text-cc-fg/70 hover:bg-cc-hover rounded-md transition-colors cursor-pointer"
                      >
                        <svg
                          viewBox="0 0 16 16"
                          fill="currentColor"
                          className="w-3 h-3 text-cc-success shrink-0"
                        >
                          <path d="M8 2a.5.5 0 01.5.5v5h5a.5.5 0 010 1h-5v5a.5.5 0 01-1 0v-5h-5a.5.5 0 010-1h5v-5A.5.5 0 018 2z" />
                        </svg>
                        <span className="font-mono-code">
                          .claude/CLAUDE.md
                        </span>
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* Editor area */}
              <div className="flex-1 flex flex-col min-w-0">
                {files.length === 0 && !createMode ? (
                  <div className="flex-1 flex flex-col items-center justify-center gap-4 px-6">
                    <div className="w-14 h-14 rounded-2xl bg-cc-card border border-cc-border flex items-center justify-center">
                      <svg
                        viewBox="0 0 16 16"
                        fill="currentColor"
                        className="w-6 h-6 text-cc-muted"
                      >
                        <path d="M4 1.5a.5.5 0 01.5-.5h7a.5.5 0 01.354.146l2 2A.5.5 0 0114 3.5v11a.5.5 0 01-.5.5h-11a.5.5 0 01-.5-.5v-13z" />
                      </svg>
                    </div>
                    <div className="text-center">
                      <p className="text-sm text-cc-fg font-medium mb-1">
                        No CLAUDE.md found
                      </p>
                      <p className="text-xs text-cc-muted leading-relaxed max-w-[280px]">
                        Create a CLAUDE.md file to give Claude Code project-specific instructions, coding conventions, and context.
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleCreate("root")}
                        className="px-3 py-1.5 text-xs font-medium rounded-lg bg-cc-primary text-white hover:bg-cc-primary/90 transition-colors cursor-pointer"
                      >
                        Create CLAUDE.md
                      </button>
                      <button
                        onClick={() => handleCreate("dotclaude")}
                        className="px-3 py-1.5 text-xs font-medium rounded-lg bg-cc-hover text-cc-fg border border-cc-border hover:bg-cc-active transition-colors cursor-pointer"
                      >
                        Create .claude/CLAUDE.md
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    {/* File path bar */}
                    <div className="shrink-0 flex items-center justify-between px-4 py-2 bg-cc-card border-b border-cc-border">
                      <span className="text-[12px] text-cc-muted font-mono-code truncate">
                        {createMode
                          ? relPath(createMode)
                          : relPath(files[selectedIdx]?.path ?? "")}
                      </span>
                      <div className="flex items-center gap-2">
                        {dirty && (
                          <span className="text-[10px] text-cc-warning font-medium">
                            Unsaved
                          </span>
                        )}
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
                      value={editContent}
                      onChange={(e) => {
                        setEditContent(e.target.value);
                        setDirty(true);
                      }}
                      spellCheck={false}
                      className="flex-1 w-full p-4 bg-cc-bg text-cc-fg text-[13px] font-mono-code leading-relaxed resize-none focus:outline-none"
                      placeholder="Write your project instructions here..."
                    />
                  </>
                )}

                {/* Error bar */}
                {error && (
                  <div className="shrink-0 px-4 py-2 bg-cc-error/10 border-t border-cc-error/20 text-xs text-cc-error">
                    {error}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
