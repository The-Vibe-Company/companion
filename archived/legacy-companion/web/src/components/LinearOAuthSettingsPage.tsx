import { useEffect, useState, useCallback } from "react";
import { api, type LinearOAuthConnectionSummary, type AgentInfo } from "../api.js";
import { navigateHome, navigateToSession } from "../utils/routing.js";
import { useStore } from "../store.js";
import { LinearLogo } from "./LinearLogo.js";

interface LinearOAuthSettingsPageProps {
  embedded?: boolean;
}

export function LinearOAuthSettingsPage({ embedded = false }: LinearOAuthSettingsPageProps) {
  // ---- Connection list state ------------------------------------------------
  const [connections, setConnections] = useState<LinearOAuthConnectionSummary[]>([]);
  const [loadingConnections, setLoadingConnections] = useState(true);
  const [connectionsError, setConnectionsError] = useState("");

  // ---- Add connection form state --------------------------------------------
  const [showAddForm, setShowAddForm] = useState(false);
  const [newName, setNewName] = useState("");
  const [newClientId, setNewClientId] = useState("");
  const [newClientSecret, setNewClientSecret] = useState("");
  const [newWebhookSecret, setNewWebhookSecret] = useState("");
  const [addingConnection, setAddingConnection] = useState(false);
  const [addError, setAddError] = useState("");

  // ---- Delete confirmation --------------------------------------------------
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState("");

  // ---- Install in-progress tracking -----------------------------------------
  const [installingId, setInstallingId] = useState<string | null>(null);

  // ---- Agents using each connection -----------------------------------------
  const [agents, setAgents] = useState<AgentInfo[]>([]);

  // ---- OAuth return banner --------------------------------------------------
  const [oauthBanner, setOauthBanner] = useState<{ type: "success" | "error"; message: string } | null>(null);

  // ---- Load connections -----------------------------------------------------
  const loadConnections = useCallback(async () => {
    try {
      const result = await api.listLinearOAuthConnections();
      setConnections(result.connections);
    } catch (e: unknown) {
      setConnectionsError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingConnections(false);
    }
  }, []);

  // ---- Load agents ----------------------------------------------------------
  const loadAgents = useCallback(async () => {
    try {
      const result = await api.listAgents();
      setAgents(result);
    } catch {
      // Silently fail -- agents list is supplemental info
    }
  }, []);

  useEffect(() => {
    loadConnections();
    loadAgents();

    // Check for OAuth callback success/error in URL hash
    let timerId: ReturnType<typeof setTimeout> | undefined;
    const hash = window.location.hash;
    if (hash.includes("oauth_success=true")) {
      setOauthBanner({ type: "success", message: "OAuth app connected to workspace successfully!" });
      window.location.hash = "#/integrations/linear-oauth";
      timerId = setTimeout(() => setOauthBanner(null), 5000);
    } else if (hash.includes("oauth_error=")) {
      const match = hash.match(/oauth_error=([^&]*)/);
      let errorMsg: string;
      try {
        errorMsg = decodeURIComponent(match?.[1] || "OAuth failed");
      } catch {
        errorMsg = match?.[1] || "OAuth failed";
      }
      setOauthBanner({ type: "error", message: errorMsg });
      window.location.hash = "#/integrations/linear-oauth";
    }

    return () => {
      if (timerId) clearTimeout(timerId);
    };
  }, [loadConnections, loadAgents]);

  // ---- Add connection -------------------------------------------------------
  async function onAddConnection(e: React.FormEvent) {
    e.preventDefault();
    const trimmedName = newName.trim();
    const trimmedClientId = newClientId.trim();
    const trimmedClientSecret = newClientSecret.trim();
    const trimmedWebhookSecret = newWebhookSecret.trim();

    if (!trimmedName || !trimmedClientId || !trimmedClientSecret || !trimmedWebhookSecret) {
      setAddError("All fields are required.");
      return;
    }

    setAddingConnection(true);
    setAddError("");
    try {
      await api.createLinearOAuthConnection({
        name: trimmedName,
        oauthClientId: trimmedClientId,
        oauthClientSecret: trimmedClientSecret,
        webhookSecret: trimmedWebhookSecret,
      });
      setNewName("");
      setNewClientId("");
      setNewClientSecret("");
      setNewWebhookSecret("");
      setShowAddForm(false);
      await loadConnections();
    } catch (e: unknown) {
      setAddError(e instanceof Error ? e.message : String(e));
    } finally {
      setAddingConnection(false);
    }
  }

  // ---- Delete connection ----------------------------------------------------
  async function onDelete(id: string) {
    if (confirmDeleteId !== id) {
      setConfirmDeleteId(id);
      setDeleteError("");
      return;
    }
    setDeletingId(id);
    setConfirmDeleteId(null);
    try {
      await api.deleteLinearOAuthConnection(id);
      setDeleteError("");
      await loadConnections();
    } catch (e: unknown) {
      setDeleteError(e instanceof Error ? e.message : String(e));
      await loadConnections();
    } finally {
      setDeletingId(null);
    }
  }

  // ---- Install to workspace -------------------------------------------------
  async function onInstall(id: string) {
    setInstallingId(id);
    try {
      const result = await api.getLinearOAuthConnectionAuthorizeUrl(id, "/#/integrations/linear-oauth");
      window.open(result.url, "_self");
    } catch (e: unknown) {
      setOauthBanner({ type: "error", message: e instanceof Error ? e.message : String(e) });
      setInstallingId(null);
    }
  }

  // ---- Helpers --------------------------------------------------------------
  function truncateId(id: string, maxLen = 16): string {
    if (id.length <= maxLen) return id;
    return id.slice(0, maxLen) + "...";
  }

  function getAgentsForConnection(connectionId: string): AgentInfo[] {
    return agents.filter(
      (a) => a.triggers?.linear?.oauthConnectionId === connectionId,
    );
  }

  const connectedCount = connections.filter((c) => c.status === "connected").length;

  return (
    <div className={`${embedded ? "h-full" : "h-[100dvh]"} bg-cc-bg text-cc-fg font-sans-ui antialiased overflow-y-auto`}>
      <div className="max-w-5xl mx-auto px-4 sm:px-8 py-6 sm:py-10 pb-safe">
        {/* ---- Header ---- */}
        <div className="flex items-start justify-between gap-3 mb-6">
          <div>
            <h1 className="text-xl font-semibold text-cc-fg">Linear OAuth Apps</h1>
            <p className="mt-1 text-sm text-cc-muted">
              Manage OAuth app connections for Linear agent integrations.
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

        {/* ---- Link to ticket integration ---- */}
        <div className="mb-4 px-3 py-2 rounded-lg bg-cc-hover/60 border border-cc-border text-sm text-cc-muted">
          Looking for ticket integration?{" "}
          <a href="#/settings/linear" className="text-cc-primary underline cursor-pointer">
            Linear Tickets Settings
          </a>
        </div>

        {/* ---- OAuth return banner ---- */}
        {oauthBanner && (
          <div
            className={`mb-4 px-3 py-2 rounded-lg text-xs border ${
              oauthBanner.type === "success"
                ? "bg-cc-success/10 border-cc-success/20 text-cc-success"
                : "bg-cc-error/10 border-cc-error/20 text-cc-error"
            }`}
          >
            {oauthBanner.message}
          </div>
        )}

        {/* ---- Hero banner ---- */}
        <section className="relative overflow-hidden bg-cc-card border border-cc-border rounded-xl p-4 sm:p-6 mb-4">
          <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_top_right,rgba(124,58,237,0.1),transparent_45%)]" />
          <div className="relative flex items-start justify-between gap-4 flex-wrap">
            <div className="min-w-0">
              <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full border border-cc-border bg-cc-hover/60 text-xs text-cc-muted">
                <LinearLogo className="w-3.5 h-3.5 text-cc-fg" />
                <span>Linear OAuth</span>
              </div>
              <h2 className="mt-3 text-lg sm:text-xl font-semibold text-cc-fg">
                OAuth app connections for agent workflows
              </h2>
              <p className="mt-1.5 text-sm text-cc-muted max-w-2xl">
                Each connection represents a Linear OAuth app. Agents reference these connections to receive @mentions and interact with Linear issues.
              </p>
            </div>
            <div className="shrink-0 rounded-xl border border-cc-border bg-cc-bg px-3 py-2 text-right min-w-[170px]">
              <p className="text-[11px] text-cc-muted uppercase tracking-wide">Status</p>
              <p className={`mt-1 text-sm font-medium ${connectedCount > 0 ? "text-cc-success" : "text-cc-muted"}`}>
                {connectedCount > 0
                  ? `${connectedCount} connected`
                  : "Not connected"}
              </p>
              <p className="mt-0.5 text-[11px] text-cc-muted truncate">
                {connections.length > 0
                  ? `${connections.length} connection${connections.length !== 1 ? "s" : ""} configured`
                  : "No connections yet"}
              </p>
            </div>
          </div>
        </section>

        {/* ---- Connections section ---- */}
        <div className="bg-cc-card border border-cc-border rounded-xl p-4 sm:p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-cc-fg flex items-center gap-2">
              <LinearLogo className="w-4 h-4 text-cc-fg" />
              <span>OAuth Connections</span>
            </h2>
            <button
              type="button"
              onClick={() => {
                setShowAddForm(!showAddForm);
                setAddError("");
                setDeleteError("");
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

          {deleteError && (
            <div className="px-3 py-2 rounded-lg bg-cc-error/10 border border-cc-error/20 text-xs text-cc-error">
              {deleteError}
            </div>
          )}

          {/* ---- Add connection form ---- */}
          {showAddForm && (
            <form onSubmit={onAddConnection} className="border border-cc-border rounded-lg p-4 space-y-3 bg-cc-bg">
              <div>
                <label className="block text-sm font-medium mb-1.5" htmlFor="new-oauth-name">
                  Connection Name
                </label>
                <input
                  id="new-oauth-name"
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder='e.g. "Production App", "Dev App"'
                  className="w-full px-3 py-2.5 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/60"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5" htmlFor="new-oauth-client-id">
                  OAuth Client ID
                </label>
                <input
                  id="new-oauth-client-id"
                  type="text"
                  value={newClientId}
                  onChange={(e) => setNewClientId(e.target.value)}
                  placeholder="OAuth app client ID from Linear"
                  className="w-full px-3 py-2.5 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/60"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5" htmlFor="new-oauth-client-secret">
                  OAuth Client Secret
                </label>
                <input
                  id="new-oauth-client-secret"
                  type="password"
                  value={newClientSecret}
                  onChange={(e) => setNewClientSecret(e.target.value)}
                  placeholder="OAuth app client secret"
                  className="w-full px-3 py-2.5 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/60"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5" htmlFor="new-oauth-webhook-secret">
                  Webhook Secret
                </label>
                <input
                  id="new-oauth-webhook-secret"
                  type="password"
                  value={newWebhookSecret}
                  onChange={(e) => setNewWebhookSecret(e.target.value)}
                  placeholder="Webhook signing secret from Linear"
                  className="w-full px-3 py-2.5 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/60"
                />
              </div>

              {addError && (
                <div className="px-3 py-2 rounded-lg bg-cc-error/10 border border-cc-error/20 text-xs text-cc-error">
                  {addError}
                </div>
              )}

              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={
                    addingConnection ||
                    !newName.trim() ||
                    !newClientId.trim() ||
                    !newClientSecret.trim() ||
                    !newWebhookSecret.trim()
                  }
                  className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                    addingConnection ||
                    !newName.trim() ||
                    !newClientId.trim() ||
                    !newClientSecret.trim() ||
                    !newWebhookSecret.trim()
                      ? "bg-cc-hover text-cc-muted cursor-not-allowed"
                      : "bg-cc-primary hover:bg-cc-primary-hover text-white cursor-pointer"
                  }`}
                >
                  {addingConnection ? "Saving..." : "Save"}
                </button>
              </div>
            </form>
          )}

          {/* ---- Connection list ---- */}
          {loadingConnections ? (
            <p className="text-sm text-cc-muted">Loading connections...</p>
          ) : connections.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-sm text-cc-muted">No OAuth connections yet.</p>
              <p className="mt-1 text-xs text-cc-muted">
                Add your first OAuth app connection to enable Linear agent integrations.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {connections.map((conn) => {
                const connAgents = getAgentsForConnection(conn.id);
                return (
                  <div key={conn.id} className="border border-cc-border rounded-lg overflow-hidden">
                    {/* Connection card header */}
                    <div className="p-4 flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium text-cc-fg">{conn.name}</span>
                          <span
                            className={`px-2 py-0.5 text-[10px] rounded-full border ${
                              conn.status === "connected"
                                ? "bg-cc-success/10 text-cc-success border-cc-success/20"
                                : "bg-cc-hover text-cc-muted border-cc-border"
                            }`}
                          >
                            {conn.status === "connected" ? "Connected" : "Disconnected"}
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-cc-muted truncate">
                          Client ID: {truncateId(conn.oauthClientId)}
                        </p>
                        <p className="mt-1 text-xs text-cc-muted">
                          {conn.status === "connected"
                            ? "Ready to receive @mentions and post updates back to Linear."
                            : "This app may already be installed in Linear, but Companion no longer has a valid OAuth token. Reconnect it to restore agent replies."}
                        </p>

                        {/* Agents using this connection */}
                        {connAgents.length > 0 && (
                          <div className="mt-1.5 flex flex-wrap gap-1.5">
                            {connAgents.map((agent) => (
                              <span
                                key={agent.id}
                                className="px-2 py-0.5 text-[10px] rounded-md bg-cc-hover text-cc-muted"
                              >
                                Agent: {agent.name}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => onInstall(conn.id)}
                          disabled={installingId === conn.id}
                          aria-label={conn.status === "connected" ? `Manage ${conn.name}` : `Reconnect ${conn.name}`}
                          className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                            installingId === conn.id
                              ? "bg-cc-hover text-cc-muted cursor-not-allowed"
                              : "bg-violet-600 hover:bg-violet-700 text-white cursor-pointer"
                          }`}
                        >
                          {installingId === conn.id
                            ? "Redirecting..."
                            : conn.status === "connected"
                              ? "Manage in Linear"
                              : "Reconnect to Workspace"}
                        </button>
                        <button
                          type="button"
                          onClick={() => onDelete(conn.id)}
                          disabled={deletingId === conn.id}
                          className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                            deletingId === conn.id
                              ? "bg-cc-hover text-cc-muted cursor-not-allowed"
                              : confirmDeleteId === conn.id
                                ? "bg-cc-error hover:bg-cc-error/90 text-white cursor-pointer"
                                : "bg-cc-error/10 hover:bg-cc-error/20 text-cc-error cursor-pointer"
                          }`}
                        >
                          {deletingId === conn.id
                            ? "Deleting..."
                            : confirmDeleteId === conn.id
                              ? "Confirm Delete"
                              : "Delete"}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
