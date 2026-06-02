import { useEffect, useState, useCallback } from "react";
import { api, type LinearWorkflowState, type LinearTeamStates, type LinearConnectionSummary } from "../api.js";
import { navigateHome, navigateToSession } from "../utils/routing.js";
import { useStore } from "../store.js";
import { LinearLogo } from "./LinearLogo.js";

interface LinearSettingsPageProps {
  embedded?: boolean;
}

/**
 * Per-connection editing state: tracks the UI for editing auto-transition
 * and archive-transition settings on an individual connection.
 */
interface ConnectionEditState {
  /** Which connection is being edited (expanded) */
  connectionId: string;
  /** Teams fetched from the Linear API for this connection */
  teams: LinearTeamStates[];
  loadingStates: boolean;

  // Auto-transition
  autoTransition: boolean;
  autoTransitionTeamId: string;
  autoTransitionStateId: string;
  autoTransitionStateName: string;
  autoTransitionWorkflowStates: LinearWorkflowState[];

  // Archive transition
  archiveTransition: boolean;
  archiveTransitionTeamId: string;
  archiveTransitionStateId: string;
  archiveTransitionStateName: string;
  archiveTransitionWorkflowStates: LinearWorkflowState[];

  saving: boolean;
  saved: boolean;
  error: string;
}

export function LinearSettingsPage({ embedded = false }: LinearSettingsPageProps) {
  // ─── Connection list state ──────────────────────────────────────────
  const [connections, setConnections] = useState<LinearConnectionSummary[]>([]);
  const [loadingConnections, setLoadingConnections] = useState(true);
  const [connectionsError, setConnectionsError] = useState("");

  // ─── Add connection form state ──────────────────────────────────────
  const [showAddForm, setShowAddForm] = useState(false);
  const [newName, setNewName] = useState("");
  const [newApiKey, setNewApiKey] = useState("");
  const [addingConnection, setAddingConnection] = useState(false);
  const [addError, setAddError] = useState("");

  // ─── Per-connection edit state (null = none expanded) ───────────────
  const [editState, setEditState] = useState<ConnectionEditState | null>(null);

  // ─── Verify / delete in-progress tracking ──────────────────────────
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // ─── Load connections ──────────────────────────────────────────────
  const loadConnections = useCallback(async () => {
    try {
      const result = await api.listLinearConnections();
      setConnections(result.connections);
    } catch (e: unknown) {
      setConnectionsError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingConnections(false);
    }
  }, []);

  useEffect(() => {
    loadConnections();

  }, [loadConnections]);

  // ─── Add connection ────────────────────────────────────────────────
  async function onAddConnection(e: React.FormEvent) {
    e.preventDefault();
    const trimmedName = newName.trim();
    const trimmedKey = newApiKey.trim();
    if (!trimmedName || !trimmedKey) {
      setAddError("Name and API key are required.");
      return;
    }

    setAddingConnection(true);
    setAddError("");
    try {
      const result = await api.createLinearConnection({ name: trimmedName, apiKey: trimmedKey });
      if (result.error) {
        setAddError(result.error);
      } else {
        setNewName("");
        setNewApiKey("");
        setShowAddForm(false);
        await loadConnections();
      }
    } catch (e: unknown) {
      setAddError(e instanceof Error ? e.message : String(e));
    } finally {
      setAddingConnection(false);
    }
  }

  // ─── Verify a connection ──────────────────────────────────────────
  async function onVerify(id: string) {
    setVerifyingId(id);
    try {
      await api.verifyLinearConnection(id);
      await loadConnections();
    } catch {
      // Reload to reflect any state changes
      await loadConnections();
    } finally {
      setVerifyingId(null);
    }
  }

  // ─── Delete a connection ──────────────────────────────────────────
  async function onDelete(id: string) {
    setDeletingId(id);
    try {
      await api.deleteLinearConnection(id);
      if (editState?.connectionId === id) {
        setEditState(null);
      }
      await loadConnections();
    } catch {
      await loadConnections();
    } finally {
      setDeletingId(null);
    }
  }

  // ─── Open edit panel for a connection ─────────────────────────────
  async function onEdit(conn: LinearConnectionSummary) {
    if (editState?.connectionId === conn.id) {
      // Toggle off
      setEditState(null);
      return;
    }

    const newEditState: ConnectionEditState = {
      connectionId: conn.id,
      teams: [],
      loadingStates: true,
      autoTransition: conn.autoTransition,
      autoTransitionTeamId: "",
      autoTransitionStateId: conn.autoTransitionStateId,
      autoTransitionStateName: conn.autoTransitionStateName,
      autoTransitionWorkflowStates: [],
      archiveTransition: conn.archiveTransition,
      archiveTransitionTeamId: "",
      archiveTransitionStateId: conn.archiveTransitionStateId,
      archiveTransitionStateName: conn.archiveTransitionStateName,
      archiveTransitionWorkflowStates: [],
      saving: false,
      saved: false,
      error: "",
    };
    setEditState(newEditState);

    // Fetch workflow states for this connection
    try {
      const result = await api.getLinearStates(conn.id);
      const teams = result.teams;
      const firstTeam = teams[0];

      // Figure out auto-transition team and states
      let autoTeamId = "";
      let autoStates: LinearWorkflowState[] = [];
      let autoStateId = conn.autoTransitionStateId;
      if (conn.autoTransitionStateName && teams.length > 0) {
        // Try to find the team that contains the saved state
        for (const team of teams) {
          const match = team.states.find((s) => s.name === conn.autoTransitionStateName);
          if (match) {
            autoTeamId = team.id;
            autoStates = team.states;
            autoStateId = match.id;
            break;
          }
        }
      }
      if (!autoTeamId && firstTeam) {
        autoTeamId = firstTeam.id;
        autoStates = firstTeam.states;
      }

      // Figure out archive-transition team and states
      let archiveTeamId = "";
      let archiveStates: LinearWorkflowState[] = [];
      let archiveStateId = conn.archiveTransitionStateId;
      if (conn.archiveTransitionStateName && teams.length > 0) {
        for (const team of teams) {
          const match = team.states.find((s) => s.name === conn.archiveTransitionStateName);
          if (match) {
            archiveTeamId = team.id;
            archiveStates = team.states;
            archiveStateId = match.id;
            break;
          }
        }
      }
      if (!archiveTeamId && firstTeam) {
        archiveTeamId = firstTeam.id;
        archiveStates = firstTeam.states;
      }

      setEditState((prev) => prev && prev.connectionId === conn.id ? {
        ...prev,
        teams,
        loadingStates: false,
        autoTransitionTeamId: autoTeamId,
        autoTransitionStateId: autoStateId,
        autoTransitionWorkflowStates: autoStates,
        archiveTransitionTeamId: archiveTeamId,
        archiveTransitionStateId: archiveStateId,
        archiveTransitionWorkflowStates: archiveStates,
      } : prev);
    } catch {
      setEditState((prev) => prev && prev.connectionId === conn.id ? {
        ...prev,
        loadingStates: false,
      } : prev);
    }
  }

  // ─── Save connection settings (auto-transition + archive) ─────────
  async function onSaveConnectionSettings() {
    if (!editState) return;
    setEditState((prev) => prev ? { ...prev, saving: true, saved: false, error: "" } : prev);
    try {
      await api.updateLinearConnection(editState.connectionId, {
        autoTransition: editState.autoTransition,
        autoTransitionStateId: editState.autoTransitionStateId,
        autoTransitionStateName: editState.autoTransitionStateName,
        archiveTransition: editState.archiveTransition,
        archiveTransitionStateId: editState.archiveTransitionStateId,
        archiveTransitionStateName: editState.archiveTransitionStateName,
      });
      setEditState((prev) => prev ? { ...prev, saving: false, saved: true } : prev);
      setTimeout(() => setEditState((prev) => prev ? { ...prev, saved: false } : prev), 1800);
      await loadConnections();
    } catch (e: unknown) {
      setEditState((prev) => prev ? {
        ...prev,
        saving: false,
        error: e instanceof Error ? e.message : String(e),
      } : prev);
    }
  }

  // ─── Derived counts ───────────────────────────────────────────────
  const connectedCount = connections.filter((c) => c.connected).length;
  const hasAnyConnection = connections.length > 0;

  return (
    <div className={`${embedded ? "h-full" : "h-[100dvh]"} bg-cc-bg text-cc-fg font-sans-ui antialiased overflow-y-auto`}>
      <div className="max-w-5xl mx-auto px-4 sm:px-8 py-6 sm:py-10 pb-safe">
        <div className="flex items-start justify-between gap-3 mb-6">
          <div>
            <h1 className="text-xl font-semibold text-cc-fg">Linear Settings</h1>
            <p className="mt-1 text-sm text-cc-muted">
              Connect Linear for issue context injection and agent @mentions via the Agent SDK.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                window.location.hash = "#/integrations";
              }}
              className="px-3 py-2.5 min-h-[44px] rounded-lg text-sm text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
            >
              Integrations
            </button>
            {!embedded && (
              <button
                onClick={() => {
                  const sessionId = useStore.getState().currentSessionId;
                  if (sessionId) {
                    navigateToSession(sessionId);
                  } else {
                    navigateHome();
                  }
                }}
                className="px-3 py-2.5 min-h-[44px] rounded-lg text-sm text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
              >
                Back
              </button>
            )}
          </div>
        </div>

        {/* ── Hero banner ── */}
        <section className="relative overflow-hidden bg-cc-card border border-cc-border rounded-xl p-4 sm:p-6 mb-4">
          <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_top_right,rgba(124,58,237,0.1),transparent_45%)]" />
          <div className="relative flex items-start justify-between gap-4 flex-wrap">
            <div className="min-w-0">
              <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full border border-cc-border bg-cc-hover/60 text-xs text-cc-muted">
                <LinearLogo className="w-3.5 h-3.5 text-cc-fg" />
                <span>Linear Integration</span>
              </div>
              <h2 className="mt-3 text-lg sm:text-xl font-semibold text-cc-fg">
                Turn issues into concrete session context
              </h2>
              <p className="mt-1.5 text-sm text-cc-muted max-w-2xl">
                Search and attach the right Linear issue before the first prompt, so the companion starts with scope, state, and links.
              </p>
              <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
                <span className="px-2 py-1 rounded-md bg-cc-hover text-cc-muted">Issue lookup on Home</span>
                <span className="px-2 py-1 rounded-md bg-cc-hover text-cc-muted">Context injection on start</span>
                <span className="px-2 py-1 rounded-md bg-cc-hover text-cc-muted">No key exposure in API responses</span>
              </div>
            </div>
            <div className="shrink-0 rounded-xl border border-cc-border bg-cc-bg px-3 py-2 text-right min-w-[170px]">
              <p className="text-[11px] text-cc-muted uppercase tracking-wide">Status</p>
              <p className={`mt-1 text-sm font-medium ${connectedCount > 0 ? "text-cc-success" : "text-cc-muted"}`}>
                {connectedCount > 0
                  ? `${connectedCount} connected`
                  : "Not connected"}
              </p>
              <p className="mt-0.5 text-[11px] text-cc-muted truncate">
                {hasAnyConnection
                  ? `${connections.length} connection${connections.length !== 1 ? "s" : ""} configured`
                  : "No connections yet"}
              </p>
            </div>
          </div>
        </section>

        {/* ── Connections section ── */}
        <div className="bg-cc-card border border-cc-border rounded-xl p-4 sm:p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-cc-fg flex items-center gap-2">
              <LinearLogo className="w-4 h-4 text-cc-fg" />
              <span>Linear Connections</span>
            </h2>
            <button
              type="button"
              onClick={() => {
                setShowAddForm(!showAddForm);
                setAddError("");
              }}
              className="px-3 py-2 rounded-lg text-sm font-medium transition-colors bg-cc-primary hover:bg-cc-primary-hover text-white cursor-pointer"
            >
              {showAddForm ? "Cancel" : "Add Connection"}
            </button>
          </div>

          {connectionsError && (
            <div className="px-3 py-2 rounded-lg bg-cc-error/10 border border-cc-error/20 text-xs text-cc-error">
              {connectionsError}
            </div>
          )}

          {/* ── Add connection form ── */}
          {showAddForm && (
            <form onSubmit={onAddConnection} className="border border-cc-border rounded-lg p-4 space-y-3 bg-cc-bg">
              <div>
                <label className="block text-sm font-medium mb-1.5" htmlFor="new-conn-name">
                  Connection Name
                </label>
                <input
                  id="new-conn-name"
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder='e.g. "Work", "Personal"'
                  className="w-full px-3 py-2.5 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/60"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5" htmlFor="new-conn-key">
                  API Key
                </label>
                <input
                  id="new-conn-key"
                  type="password"
                  value={newApiKey}
                  onChange={(e) => setNewApiKey(e.target.value)}
                  placeholder="lin_api_..."
                  className="w-full px-3 py-2.5 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/60"
                />
                <p className="mt-1.5 text-xs text-cc-muted">
                  The key is verified automatically when saved.
                </p>
              </div>

              {addError && (
                <div className="px-3 py-2 rounded-lg bg-cc-error/10 border border-cc-error/20 text-xs text-cc-error">
                  {addError}
                </div>
              )}

              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={addingConnection || !newName.trim() || !newApiKey.trim()}
                  className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                    addingConnection || !newName.trim() || !newApiKey.trim()
                      ? "bg-cc-hover text-cc-muted cursor-not-allowed"
                      : "bg-cc-primary hover:bg-cc-primary-hover text-white cursor-pointer"
                  }`}
                >
                  {addingConnection ? "Saving..." : "Save"}
                </button>
              </div>
            </form>
          )}

          {/* ── Connection list ── */}
          {loadingConnections ? (
            <p className="text-sm text-cc-muted">Loading connections...</p>
          ) : connections.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-sm text-cc-muted">No Linear connections yet.</p>
              <p className="mt-1 text-xs text-cc-muted">
                Add your first connection to search and attach Linear issues to sessions.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {connections.map((conn) => (
                <div key={conn.id} className="border border-cc-border rounded-lg overflow-hidden">
                  {/* Connection card header */}
                  <div className="p-4 flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-cc-fg">{conn.name}</span>
                        <span
                          className={`px-2 py-0.5 text-[10px] rounded-full border ${
                            conn.connected
                              ? "bg-cc-success/10 text-cc-success border-cc-success/20"
                              : "bg-cc-error/10 text-cc-error border-cc-error/20"
                          }`}
                        >
                          {conn.connected ? "Connected" : "Not connected"}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-cc-muted truncate">
                        {conn.workspaceName && conn.viewerName
                          ? `${conn.viewerName} -- ${conn.workspaceName}`
                          : conn.workspaceName || conn.viewerName || "Unverified"}
                        {" "}&middot; Key ending in ...{conn.apiKeyLast4}
                      </p>
                      {/* Show active settings summary */}
                      {(conn.autoTransition || conn.archiveTransition) && (
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {conn.autoTransition && conn.autoTransitionStateName && (
                            <span className="px-2 py-0.5 text-[10px] rounded-md bg-cc-hover text-cc-muted">
                              Auto-transition: {conn.autoTransitionStateName}
                            </span>
                          )}
                          {conn.archiveTransition && conn.archiveTransitionStateName && (
                            <span className="px-2 py-0.5 text-[10px] rounded-md bg-cc-hover text-cc-muted">
                              On archive: {conn.archiveTransitionStateName}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => onEdit(conn)}
                        disabled={!conn.connected}
                        className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                          !conn.connected
                            ? "bg-cc-hover text-cc-muted cursor-not-allowed"
                            : editState?.connectionId === conn.id
                              ? "bg-cc-active text-cc-fg cursor-pointer"
                              : "bg-cc-hover hover:bg-cc-active text-cc-fg cursor-pointer"
                        }`}
                      >
                        {editState?.connectionId === conn.id ? "Close" : "Edit"}
                      </button>
                      <button
                        type="button"
                        onClick={() => onVerify(conn.id)}
                        disabled={verifyingId === conn.id}
                        className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                          verifyingId === conn.id
                            ? "bg-cc-hover text-cc-muted cursor-not-allowed"
                            : "bg-cc-hover hover:bg-cc-active text-cc-fg cursor-pointer"
                        }`}
                      >
                        {verifyingId === conn.id ? "Checking..." : "Verify"}
                      </button>
                      <button
                        type="button"
                        onClick={() => onDelete(conn.id)}
                        disabled={deletingId === conn.id}
                        className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                          deletingId === conn.id
                            ? "bg-cc-hover text-cc-muted cursor-not-allowed"
                            : "bg-cc-error/10 hover:bg-cc-error/20 text-cc-error cursor-pointer"
                        }`}
                      >
                        {deletingId === conn.id ? "Deleting..." : "Delete"}
                      </button>
                    </div>
                  </div>

                  {/* Expanded edit panel for per-connection settings */}
                  {editState?.connectionId === conn.id && (
                    <div className="border-t border-cc-border p-4 space-y-5 bg-cc-bg/50">
                      {/* Auto-transition settings */}
                      <div className="space-y-3">
                        <h3 className="text-sm font-semibold text-cc-fg">Auto-transition</h3>
                        <p className="text-xs text-cc-muted">
                          Automatically move the linked issue to a chosen status when starting a session.
                        </p>

                        <div className="flex items-center gap-3">
                          <button
                            type="button"
                            role="switch"
                            aria-checked={editState.autoTransition}
                            onClick={() =>
                              setEditState((prev) => prev ? { ...prev, autoTransition: !prev.autoTransition } : prev)
                            }
                            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                              editState.autoTransition ? "bg-cc-primary" : "bg-cc-hover"
                            }`}
                          >
                            <span
                              className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${
                                editState.autoTransition ? "translate-x-4" : "translate-x-0"
                              }`}
                            />
                          </button>
                          <span className="text-sm text-cc-fg">
                            {editState.autoTransition ? "Enabled" : "Disabled"}
                          </span>
                        </div>

                        {editState.autoTransition && editState.teams.length > 1 && (
                          <div>
                            <label className="block text-sm font-medium mb-1.5" htmlFor={`auto-team-${conn.id}`}>
                              Team
                            </label>
                            <select
                              id={`auto-team-${conn.id}`}
                              value={editState.autoTransitionTeamId}
                              onChange={(e) => {
                                const teamId = e.target.value;
                                const team = editState.teams.find((t) => t.id === teamId);
                                setEditState((prev) => prev ? {
                                  ...prev,
                                  autoTransitionTeamId: teamId,
                                  autoTransitionWorkflowStates: team?.states || [],
                                  autoTransitionStateId: "",
                                  autoTransitionStateName: "",
                                } : prev);
                              }}
                              className="w-full px-3 py-2.5 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg focus:outline-none focus:border-cc-primary/60"
                            >
                              {editState.teams.map((team) => (
                                <option key={team.id} value={team.id}>
                                  {team.name} ({team.key})
                                </option>
                              ))}
                            </select>
                          </div>
                        )}

                        {editState.autoTransition && (
                          <div>
                            <label className="block text-sm font-medium mb-1.5" htmlFor={`auto-state-${conn.id}`}>
                              Target status
                            </label>
                            {editState.loadingStates ? (
                              <p className="text-xs text-cc-muted">Loading workflow states...</p>
                            ) : editState.autoTransitionWorkflowStates.length === 0 ? (
                              <p className="text-xs text-cc-muted">No workflow states found.</p>
                            ) : (
                              <select
                                id={`auto-state-${conn.id}`}
                                value={editState.autoTransitionStateId}
                                onChange={(e) => {
                                  const state = editState.autoTransitionWorkflowStates.find((s) => s.id === e.target.value);
                                  setEditState((prev) => prev ? {
                                    ...prev,
                                    autoTransitionStateId: e.target.value,
                                    autoTransitionStateName: state?.name || "",
                                  } : prev);
                                }}
                                className="w-full px-3 py-2.5 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg focus:outline-none focus:border-cc-primary/60"
                              >
                                <option value="">Select a status...</option>
                                {editState.autoTransitionWorkflowStates.map((state) => (
                                  <option key={state.id} value={state.id}>
                                    {state.name}
                                  </option>
                                ))}
                              </select>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Divider between auto-transition and archive-transition */}
                      <div className="border-t border-cc-border" />

                      {/* Archive transition settings */}
                      <div className="space-y-3">
                        <h3 className="text-sm font-semibold text-cc-fg">On session archive</h3>
                        <p className="text-xs text-cc-muted">
                          When archiving a session linked to a Linear issue that is not done, optionally move it to a chosen status.
                        </p>

                        <div className="flex items-center gap-3">
                          <button
                            type="button"
                            role="switch"
                            aria-checked={editState.archiveTransition}
                            onClick={() =>
                              setEditState((prev) => prev ? { ...prev, archiveTransition: !prev.archiveTransition } : prev)
                            }
                            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                              editState.archiveTransition ? "bg-cc-primary" : "bg-cc-hover"
                            }`}
                          >
                            <span
                              className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${
                                editState.archiveTransition ? "translate-x-4" : "translate-x-0"
                              }`}
                            />
                          </button>
                          <span className="text-sm text-cc-fg">
                            {editState.archiveTransition ? "Enabled" : "Disabled"}
                          </span>
                        </div>

                        {editState.archiveTransition && editState.teams.length > 1 && (
                          <div>
                            <label className="block text-sm font-medium mb-1.5" htmlFor={`archive-team-${conn.id}`}>
                              Team
                            </label>
                            <select
                              id={`archive-team-${conn.id}`}
                              value={editState.archiveTransitionTeamId}
                              onChange={(e) => {
                                const teamId = e.target.value;
                                const team = editState.teams.find((t) => t.id === teamId);
                                setEditState((prev) => prev ? {
                                  ...prev,
                                  archiveTransitionTeamId: teamId,
                                  archiveTransitionWorkflowStates: team?.states || [],
                                  archiveTransitionStateId: "",
                                  archiveTransitionStateName: "",
                                } : prev);
                              }}
                              className="w-full px-3 py-2.5 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg focus:outline-none focus:border-cc-primary/60"
                            >
                              {editState.teams.map((team) => (
                                <option key={team.id} value={team.id}>
                                  {team.name} ({team.key})
                                </option>
                              ))}
                            </select>
                          </div>
                        )}

                        {editState.archiveTransition && (
                          <div>
                            <label className="block text-sm font-medium mb-1.5" htmlFor={`archive-state-${conn.id}`}>
                              Target status
                            </label>
                            {editState.loadingStates ? (
                              <p className="text-xs text-cc-muted">Loading workflow states...</p>
                            ) : editState.archiveTransitionWorkflowStates.length === 0 ? (
                              <p className="text-xs text-cc-muted">No workflow states found.</p>
                            ) : (
                              <select
                                id={`archive-state-${conn.id}`}
                                value={editState.archiveTransitionStateId}
                                onChange={(e) => {
                                  const state = editState.archiveTransitionWorkflowStates.find((s) => s.id === e.target.value);
                                  setEditState((prev) => prev ? {
                                    ...prev,
                                    archiveTransitionStateId: e.target.value,
                                    archiveTransitionStateName: state?.name || "",
                                  } : prev);
                                }}
                                className="w-full px-3 py-2.5 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg focus:outline-none focus:border-cc-primary/60"
                              >
                                <option value="">Select a status...</option>
                                {editState.archiveTransitionWorkflowStates.map((state) => (
                                  <option key={state.id} value={state.id}>
                                    {state.name}
                                  </option>
                                ))}
                              </select>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Save button and feedback */}
                      {editState.error && (
                        <div className="px-3 py-2 rounded-lg bg-cc-error/10 border border-cc-error/20 text-xs text-cc-error">
                          {editState.error}
                        </div>
                      )}

                      {editState.saved && (
                        <div className="px-3 py-2 rounded-lg bg-cc-success/10 border border-cc-success/20 text-xs text-cc-success">
                          Connection settings saved.
                        </div>
                      )}

                      {(() => {
                        const saveDisabled = editState.saving || (editState.autoTransition && !editState.autoTransitionStateId) || (editState.archiveTransition && !editState.archiveTransitionStateId);
                        return (
                          <div className="flex justify-end">
                            <button
                              type="button"
                              onClick={onSaveConnectionSettings}
                              disabled={saveDisabled}
                              className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                                saveDisabled
                                  ? "bg-cc-hover text-cc-muted cursor-not-allowed"
                                  : "bg-cc-primary hover:bg-cc-primary-hover text-white cursor-pointer"
                              }`}
                            >
                              {editState.saving ? "Saving..." : "Save Settings"}
                            </button>
                          </div>
                        );
                      })()}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Link to OAuth settings ── */}
        <div className="mt-4 px-3 py-3 rounded-xl bg-cc-card border border-cc-border text-sm text-cc-muted">
          Looking for OAuth app settings for agent triggers?{" "}
          <a href="#/integrations/linear-oauth" className="text-cc-primary underline cursor-pointer">
            Linear OAuth Apps
          </a>
        </div>

        <section className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="bg-cc-card border border-cc-border rounded-xl p-4">
            <p className="text-[11px] uppercase tracking-wide text-cc-muted">1. Configure</p>
            <p className="mt-1 text-sm text-cc-fg">Add a Linear API key and verify the connection.</p>
          </div>
          <div className="bg-cc-card border border-cc-border rounded-xl p-4">
            <p className="text-[11px] uppercase tracking-wide text-cc-muted">2. Select</p>
            <p className="mt-1 text-sm text-cc-fg">From Home, search an issue by key or title in one click.</p>
          </div>
          <div className="bg-cc-card border border-cc-border rounded-xl p-4">
            <p className="text-[11px] uppercase tracking-wide text-cc-muted">3. Start</p>
            <p className="mt-1 text-sm text-cc-fg">The issue details are injected as startup context.</p>
          </div>
        </section>
      </div>
    </div>
  );
}
