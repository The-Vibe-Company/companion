import { useState, useEffect, useCallback, useRef } from "react";
import { api, type CompanionSandbox, type ImagePullState } from "../api.js";

interface Props {
  embedded?: boolean;
}

export function SandboxManager({ embedded = false }: Props) {
  const [sandboxes, setSandboxes] = useState<CompanionSandbox[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);

  // Docker availability
  const [dockerAvailable, setDockerAvailable] = useState<boolean | null>(null);

  // Base image state
  const [baseImageState, setBaseImageState] = useState<ImagePullState | null>(null);
  const baseImagePollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Create form
  const [newName, setNewName] = useState("");
  const [newInitScript, setNewInitScript] = useState("");

  // Edit form
  const [editingSlug, setEditingSlug] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editInitScript, setEditInitScript] = useState("");

  // Init script test state
  const [testingSlug, setTestingSlug] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ success: boolean; exitCode: number; output: string } | null>(null);
  // Cancellation token to prevent stale test results from surfacing after save/cancel
  const testTokenRef = useRef({});

  // Server cwd (for test-init)
  const [serverCwd, setServerCwd] = useState<string>("");

  const refresh = useCallback(() => {
    api.listSandboxes().then(setSandboxes).catch(() => {}).finally(() => setLoading(false));
  }, []);

  // On mount: load sandboxes, check Docker, check base image, get server cwd
  useEffect(() => {
    refresh();
    api.getContainerStatus()
      .then((s) => setDockerAvailable(s.available))
      .catch(() => setDockerAvailable(false));
    api.getImageStatus("the-companion:latest")
      .then((state) => setBaseImageState(state))
      .catch(() => {});
    api.getHome()
      .then(({ cwd }) => setServerCwd(cwd))
      .catch(() => {});
  }, [refresh]);

  // Poll base image if pulling (every 2s, stop when ready/error)
  useEffect(() => {
    if (!baseImageState || baseImageState.status !== "pulling") {
      if (baseImagePollRef.current) {
        clearInterval(baseImagePollRef.current);
        baseImagePollRef.current = null;
      }
      return;
    }

    if (!baseImagePollRef.current) {
      baseImagePollRef.current = setInterval(() => {
        api.getImageStatus("the-companion:latest")
          .then((state) => setBaseImageState(state))
          .catch(() => {});
      }, 2000);
    }

    return () => {
      if (baseImagePollRef.current) {
        clearInterval(baseImagePollRef.current);
        baseImagePollRef.current = null;
      }
    };
  }, [baseImageState]);

  function handlePullBaseImage() {
    api.pullImage("the-companion:latest")
      .then((res) => {
        if (res.state) setBaseImageState(res.state);
      })
      .catch(() => {});
  }

  async function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    try {
      await api.createSandbox(name, {
        initScript: newInitScript || undefined,
      });
      setNewName("");
      setNewInitScript("");
      setShowCreate(false);
      setError("");
      refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  function startEdit(sandbox: CompanionSandbox) {
    testTokenRef.current = {};
    setEditingSlug(sandbox.slug);
    setEditName(sandbox.name);
    setEditInitScript(sandbox.initScript || "");
    setTestResult(null);
    setError("");
  }

  function cancelEdit() {
    testTokenRef.current = {};
    setEditingSlug(null);
    setTestResult(null);
    setTestingSlug(null);
    setError("");
  }

  async function saveEdit() {
    if (!editingSlug) return;
    testTokenRef.current = {};
    setTestingSlug(null);
    try {
      await api.updateSandbox(editingSlug, {
        name: editName.trim() || undefined,
        initScript: editInitScript || undefined,
      });
      setEditingSlug(null);
      setTestResult(null);
      setError("");
      refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleDelete(slug: string) {
    try {
      await api.deleteSandbox(slug);
      if (editingSlug === slug) setEditingSlug(null);
      refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleTestInitScript(slug: string) {
    if (!serverCwd) return;
    const token = {};
    testTokenRef.current = token;
    setTestingSlug(slug);
    setTestResult(null);
    try {
      // Send the current (possibly unsaved) init script content directly
      // to the test endpoint — no save needed, so Cancel still discards edits.
      const result = await api.testInitScript(slug, serverCwd, editInitScript);
      if (testTokenRef.current !== token) return; // stale — form was saved/cancelled
      setTestResult(result);
    } catch (e: unknown) {
      if (testTokenRef.current !== token) return;
      setTestResult({
        success: false,
        exitCode: -1,
        output: e instanceof Error ? e.message : String(e),
      });
    } finally {
      if (testTokenRef.current === token) setTestingSlug(null);
    }
  }

  const dockerBadge =
    dockerAvailable === null ? null : dockerAvailable ? (
      <span className="text-[10px] px-2 py-1 rounded-md bg-green-500/10 text-green-500 font-medium">
        Docker
      </span>
    ) : (
      <span className="text-[10px] px-2 py-1 rounded-md bg-amber-500/10 text-amber-500 font-medium">
        No Docker
      </span>
    );

  /* ─── Base image status banner ───────────────────────────────────── */

  function renderBaseImageBanner() {
    if (!dockerAvailable) return null;

    const isPulling = baseImageState?.status === "pulling";

    return (
      <div className="rounded-xl bg-cc-card p-3 sm:p-4 mb-5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[11px] font-medium text-cc-muted">Base Image</span>
            <code className="text-[10px] font-mono-code text-cc-fg">the-companion:latest</code>
            {baseImageState?.status === "ready" && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/10 text-green-500">
                Ready
              </span>
            )}
            {baseImageState?.status === "pulling" && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-500 flex items-center gap-1">
                <span className="w-2.5 h-2.5 border border-amber-500/30 border-t-amber-500 rounded-full animate-spin" />
                Pulling...
              </span>
            )}
            {baseImageState?.status === "error" && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-cc-error/10 text-cc-error">
                Pull failed
              </span>
            )}
            {(!baseImageState || baseImageState.status === "idle") && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-cc-hover text-cc-muted">
                Not downloaded
              </span>
            )}
          </div>
          {baseImageState?.status !== "ready" && (
            <button
              onClick={handlePullBaseImage}
              disabled={isPulling}
              className={`text-xs px-3 py-2 min-h-[36px] rounded-lg transition-colors shrink-0 ${
                isPulling
                  ? "bg-cc-hover text-cc-muted cursor-not-allowed"
                  : "bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 cursor-pointer"
              }`}
            >
              {isPulling ? "Pulling..." : "Pull"}
            </button>
          )}
        </div>
        {isPulling && baseImageState?.progress && baseImageState.progress.length > 0 && (
          <pre className="mt-2 px-3 py-2 text-[10px] font-mono-code bg-cc-code-bg rounded-lg text-cc-muted max-h-[120px] overflow-auto whitespace-pre-wrap">
            {baseImageState.progress.slice(-20).join("\n")}
          </pre>
        )}
        {baseImageState?.status === "error" && baseImageState.error && (
          <p className="mt-2 text-[10px] text-cc-error">{baseImageState.error}</p>
        )}
      </div>
    );
  }

  /* ─── Embedded (full page) ───────────────────────────────────────── */

  if (embedded) {
    return (
      <div className="h-full bg-cc-bg text-cc-fg font-sans-ui antialiased overflow-y-auto overflow-x-hidden">
        <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6 sm:py-10 pb-safe">
          {/* Header */}
          <div className="flex items-start justify-between gap-3 mb-2">
            <div className="min-w-0">
              <h1 className="text-lg font-semibold text-cc-fg">Sandboxes</h1>
              <p className="mt-0.5 text-[13px] text-cc-muted leading-relaxed">
                Reusable sandbox configurations for containerized sessions.
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {dockerBadge}
            </div>
          </div>

          {/* Base image status banner */}
          {renderBaseImageBanner()}

          {/* Toolbar */}
          <div className="flex items-center gap-2 mt-4 mb-5">
            <div className="flex-1" />
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
              <span className="hidden sm:inline">{showCreate ? "Cancel" : "New Sandbox"}</span>
            </button>
          </div>

          {/* Inline create form */}
          {showCreate && (
            <div
              className="mb-6 rounded-xl bg-cc-card p-4 sm:p-5 space-y-3"
              style={{ animation: "fadeSlideIn 150ms ease-out" }}
            >
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Sandbox name (e.g. node-project)"
                className="w-full px-3 py-2.5 min-h-[44px] text-sm bg-cc-bg rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:ring-1 focus:ring-cc-primary/40 transition-shadow"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newName.trim()) handleCreate();
                }}
              />

              {/* Init Script */}
              <div>
                <label className="block text-[11px] font-medium text-cc-muted mb-1">Init Script (optional)</label>
                <textarea
                  value={newInitScript}
                  onChange={(e) => setNewInitScript(e.target.value)}
                  placeholder={"# Runs inside the container before Claude starts\n# Example:\nbun install\npip install -r requirements.txt"}
                  rows={5}
                  className="w-full px-3 py-2.5 text-[11px] font-mono-code bg-cc-bg rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:ring-1 focus:ring-cc-primary/40 resize-y transition-shadow"
                  style={{ minHeight: "80px" }}
                />
              </div>

              {error && showCreate && (
                <div className="px-3 py-2 rounded-lg bg-cc-error/10 text-xs text-cc-error">{error}</div>
              )}

              <div className="flex items-center justify-between pt-1">
                <p className="text-[11px] text-cc-muted">
                  Stored in <code className="text-[10px]">~/.companion/sandboxes/</code>
                </p>
                <button
                  onClick={handleCreate}
                  disabled={!newName.trim() || creating}
                  className={`px-4 py-2.5 min-h-[44px] rounded-lg text-sm font-medium transition-colors ${
                    newName.trim() && !creating
                      ? "bg-cc-primary hover:bg-cc-primary-hover text-white cursor-pointer"
                      : "bg-cc-hover text-cc-muted cursor-not-allowed"
                  }`}
                >
                  {creating ? "Creating..." : "Create"}
                </button>
              </div>
            </div>
          )}

          {/* Stats */}
          <div className="flex items-center gap-2 mb-3 text-[12px] text-cc-muted">
            <span>{sandboxes.length} sandbox{sandboxes.length !== 1 ? "es" : ""}</span>
          </div>

          {/* Sandbox list */}
          {loading ? (
            <div className="py-12 text-center text-sm text-cc-muted">Loading sandboxes...</div>
          ) : sandboxes.length === 0 ? (
            <div className="py-12 text-center text-sm text-cc-muted">No sandboxes yet.</div>
          ) : (
            <div className="space-y-1">
              {sandboxes.map((sandbox) => {
                const isEditing = editingSlug === sandbox.slug;

                if (isEditing) {
                  return (
                    <div
                      key={sandbox.slug}
                      className="rounded-xl bg-cc-card p-4 space-y-3"
                      style={{ animation: "fadeSlideIn 150ms ease-out" }}
                    >
                      <input
                        type="text"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        placeholder="Sandbox name"
                        className="w-full px-3 py-2.5 min-h-[44px] text-sm bg-cc-bg rounded-lg text-cc-fg focus:outline-none focus:ring-1 focus:ring-cc-primary/40 transition-shadow"
                      />

                      {/* Init Script */}
                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <div className="text-[11px] font-medium text-cc-muted">Init Script (optional)</div>
                        </div>
                        <textarea
                          value={editInitScript}
                          onChange={(e) => { setEditInitScript(e.target.value); setTestResult(null); }}
                          placeholder={"# Runs inside the container before Claude starts\n# Example:\nbun install\npip install -r requirements.txt"}
                          rows={5}
                          className="w-full px-3 py-2.5 text-[11px] font-mono-code bg-cc-bg rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:ring-1 focus:ring-cc-primary/40 resize-y transition-shadow"
                          style={{ minHeight: "80px" }}
                        />
                      </div>

                      {/* Test init script result */}
                      {testingSlug === sandbox.slug && (
                        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/10 text-xs text-amber-500">
                          <span className="w-3 h-3 border-2 border-amber-500/30 border-t-amber-500 rounded-full animate-spin" />
                          Testing init script...
                        </div>
                      )}
                      {testResult && testingSlug !== sandbox.slug && (
                        <div className="space-y-2">
                          <div className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs ${
                            testResult.success
                              ? "bg-green-500/10 text-green-500"
                              : "bg-cc-error/10 text-cc-error"
                          }`}>
                            {testResult.success ? "Test passed" : `Test failed (exit ${testResult.exitCode})`}
                          </div>
                          {testResult.output && (
                            <pre className="px-3 py-2 text-[10px] font-mono-code bg-cc-code-bg rounded-lg text-cc-muted max-h-[200px] overflow-auto whitespace-pre-wrap">
                              {testResult.output}
                            </pre>
                          )}
                        </div>
                      )}

                      <div className="flex justify-end gap-2">
                        {editInitScript.trim() && dockerAvailable && (
                          <button
                            onClick={() => void handleTestInitScript(sandbox.slug)}
                            disabled={testingSlug === sandbox.slug || !serverCwd}
                            className={`px-3 py-2.5 min-h-[44px] text-sm rounded-lg font-medium transition-colors ${
                              testingSlug === sandbox.slug || !serverCwd
                                ? "bg-cc-hover text-cc-muted cursor-not-allowed"
                                : "bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 cursor-pointer"
                            }`}
                          >
                            {testingSlug === sandbox.slug ? "Testing..." : "Test Init Script"}
                          </button>
                        )}
                        <button
                          onClick={cancelEdit}
                          className="px-3 py-2.5 min-h-[44px] text-sm rounded-lg text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={() => void saveEdit()}
                          className="px-4 py-2.5 min-h-[44px] text-sm rounded-lg font-medium bg-cc-primary hover:bg-cc-primary-hover text-white transition-colors cursor-pointer"
                        >
                          Save
                        </button>
                      </div>
                    </div>
                  );
                }

                return (
                  <SandboxRow
                    key={sandbox.slug}
                    sandbox={sandbox}
                    onStartEdit={() => startEdit(sandbox)}
                    onDelete={() => void handleDelete(sandbox.slug)}
                  />
                );
              })}
            </div>
          )}

          {/* Error banner (when not inside create form) */}
          {error && !showCreate && (
            <div className="mt-4 px-3 py-2 rounded-lg bg-cc-error/10 text-xs text-cc-error">{error}</div>
          )}
        </div>
      </div>
    );
  }

  /* ─── Non-embedded fallback (renders same as embedded) ────────── */

  return (
    <div className="h-full bg-cc-bg text-cc-fg font-sans-ui antialiased overflow-y-auto overflow-x-hidden">
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6 sm:py-10 pb-safe">
        <div className="py-12 text-center text-sm text-cc-muted">
          Use embedded mode to view sandboxes.
        </div>
      </div>
    </div>
  );
}

/* ─── Sandbox Row (display only) ──────────────────────────────────── */

interface SandboxRowProps {
  sandbox: CompanionSandbox;
  onStartEdit: () => void;
  onDelete: () => void;
}

function SandboxRow({ sandbox, onStartEdit, onDelete }: SandboxRowProps) {
  return (
    <div className="group flex items-start gap-3 px-3 py-3 min-h-[44px] rounded-lg hover:bg-cc-hover/60 transition-colors">
      {/* Icon */}
      <div className="shrink-0 mt-0.5 w-7 h-7 rounded-md bg-cc-primary/10 flex items-center justify-center">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5 text-cc-primary">
          <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
          <path d="M3.27 6.96 12 12.01l8.73-5.05M12 22.08V12" />
        </svg>
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-cc-fg truncate">{sandbox.name}</span>
        </div>
        <p className="mt-0.5 text-xs text-cc-muted">
          {sandbox.initScript ? "init script" : "no init script"}
        </p>
      </div>

      {/* Actions */}
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
