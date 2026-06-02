import { useEffect, useState } from "react";
import { api, type TailscaleStatus } from "../api.js";
import { navigateHome, navigateToSession } from "../utils/routing.js";
import { useStore } from "../store.js";

interface TailscalePageProps {
  embedded?: boolean;
}

export function TailscalePage({ embedded = false }: TailscalePageProps) {
  const [status, setStatus] = useState<TailscaleStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api.getTailscaleStatus()
      .then(setStatus)
      .catch(() => setStatus(null))
      .finally(() => setLoading(false));
  }, []);

  /** Re-fetch status so the UI reflects the actual backend state after errors. */
  async function refreshStatus() {
    const fresh = await api.getTailscaleStatus().catch(() => null);
    if (fresh) setStatus(fresh);
  }

  async function onEnableFunnel() {
    setActionLoading(true);
    try {
      const result = await api.startTailscaleFunnel();
      setStatus(result);
      if (result.funnelUrl && !result.error && !result.warning) {
        useStore.getState().setPublicUrl(result.funnelUrl);
      }
    } catch (err: unknown) {
      // Network-level failure — re-fetch to stay consistent
      await refreshStatus();
      setStatus((prev) =>
        prev ? { ...prev, error: err instanceof Error ? err.message : String(err) } : null,
      );
    } finally {
      setActionLoading(false);
    }
  }

  async function onDisableFunnel() {
    setActionLoading(true);
    try {
      const result = await api.stopTailscaleFunnel();
      setStatus(result);
      // Only clear store publicUrl if it matched the funnel URL (backend does the
      // same check for the persisted setting — mirror it here to stay in sync)
      const currentStoreUrl = useStore.getState().publicUrl;
      if (!currentStoreUrl || currentStoreUrl === status?.funnelUrl) {
        useStore.getState().setPublicUrl("");
      }
    } catch (err: unknown) {
      await refreshStatus();
      setStatus((prev) =>
        prev ? { ...prev, error: err instanceof Error ? err.message : String(err) } : null,
      );
    } finally {
      setActionLoading(false);
    }
  }

  function copyUrl() {
    if (!status?.funnelUrl) return;
    navigator.clipboard.writeText(status.funnelUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }).catch(() => {});
  }

  const statusLabel = !status
    ? "Loading..."
    : !status.installed
      ? "Not installed"
      : !status.connected
        ? "Not connected"
        : status.funnelActive
          ? "Funnel active"
          : "Ready";

  const statusColor = !status
    ? "text-cc-muted"
    : !status.installed || !status.connected
      ? "text-cc-muted"
      : status.funnelActive
        ? "text-cc-success"
        : "text-amber-500";

  return (
    <div className={`${embedded ? "h-full" : "h-[100dvh]"} bg-cc-bg text-cc-fg font-sans-ui antialiased overflow-y-auto`}>
      <div className="max-w-5xl mx-auto px-4 sm:px-8 py-6 sm:py-10 pb-safe">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 mb-6">
          <div>
            <h1 className="text-xl font-semibold text-cc-fg">Tailscale Settings</h1>
            <p className="mt-1 text-sm text-cc-muted">
              Expose your Companion over HTTPS with Tailscale Funnel.
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

        {/* Hero card */}
        <section className="relative overflow-hidden bg-cc-card border border-cc-border rounded-xl p-4 sm:p-6 mb-4">
          <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_top_right,rgba(6,182,212,0.1),transparent_45%)]" />
          <div className="relative flex items-start justify-between gap-4 flex-wrap">
            <div className="min-w-0">
              <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full border border-cc-border bg-cc-hover/60 text-xs text-cc-muted">
                <svg className="w-3.5 h-3.5 text-cc-fg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                </svg>
                <span>Tailscale Integration</span>
              </div>
              <h2 className="mt-3 text-lg sm:text-xl font-semibold text-cc-fg">
                HTTPS access in one click
              </h2>
              <p className="mt-1.5 text-sm text-cc-muted max-w-2xl">
                Tailscale Funnel exposes your Companion to the internet over HTTPS with automatic TLS certificates. No configuration needed.
              </p>
              <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
                <span className="px-2 py-1 rounded-md bg-cc-hover text-cc-muted">Automatic TLS</span>
                <span className="px-2 py-1 rounded-md bg-cc-hover text-cc-muted">Stable *.ts.net domain</span>
                <span className="px-2 py-1 rounded-md bg-cc-hover text-cc-muted">No API keys needed</span>
              </div>
            </div>
            <div className="shrink-0 rounded-xl border border-cc-border bg-cc-bg px-3 py-2 text-right min-w-[170px]">
              <p className="text-[11px] text-cc-muted uppercase tracking-wide">Status</p>
              <p className={`mt-1 text-sm font-medium ${statusColor}`}>
                {statusLabel}
              </p>
              <p className="mt-0.5 text-[11px] text-cc-muted truncate">
                {status?.dnsName || "No machine name"}
              </p>
            </div>
          </div>
        </section>

        {/* Main control section */}
        <div className="bg-cc-card border border-cc-border rounded-xl p-4 sm:p-5 space-y-4">
          <h2 className="text-sm font-semibold text-cc-fg flex items-center gap-2">
            <svg className="w-4 h-4 text-cc-fg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
            <span>Tailscale Funnel</span>
          </h2>

          {loading && (
            <p className="text-sm text-cc-muted">Checking Tailscale status...</p>
          )}

          {!loading && !status && (
            <p className="text-sm text-cc-muted">Could not check Tailscale status.</p>
          )}

          {!loading && status && !status.installed && (
            <div className="space-y-3">
              <p className="text-sm text-cc-muted">
                Tailscale is not installed on this machine. Install it to enable one-click HTTPS.
              </p>
              <a
                href="https://tailscale.com/download"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-4 py-2.5 min-h-[44px] rounded-lg text-sm font-medium bg-cc-hover hover:bg-cc-active text-cc-fg transition-colors"
              >
                Install Tailscale
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
                  <polyline points="15 3 21 3 21 9" />
                  <line x1="10" y1="14" x2="21" y2="3" />
                </svg>
              </a>
            </div>
          )}

          {!loading && status && status.installed && !status.connected && (
            <div className="space-y-3">
              <p className="text-sm text-cc-muted">
                Tailscale is installed but not connected to a tailnet.
              </p>
              <div className="px-3 py-2 rounded-lg bg-cc-hover text-xs text-cc-fg font-mono-code">
                tailscale up
              </div>
              <p className="text-xs text-cc-muted">
                Run this command to connect to your Tailscale network.
              </p>
            </div>
          )}

          {!loading && status && status.installed && status.connected && !status.funnelActive && (
            <div className="space-y-3">
              <p className="text-sm text-cc-muted">
                Tailscale is connected as <span className="font-medium text-cc-fg">{status.dnsName}</span>.
                Enable Funnel to expose your Companion over HTTPS.
              </p>

              {status.needsOperatorMode && !status.error && (
                <div className="space-y-2 px-3 py-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
                  <p className="text-xs text-amber-500 font-medium">
                    Setup needed: Tailscale operator mode
                  </p>
                  <p className="text-xs text-cc-muted">
                    On Linux, Tailscale requires operator mode to manage Funnel. Run this command first:
                  </p>
                  <div className="px-3 py-2 rounded-lg bg-cc-hover text-xs text-cc-fg font-mono-code">
                    sudo tailscale set --operator=$USER
                  </div>
                </div>
              )}

              <button
                type="button"
                onClick={onEnableFunnel}
                disabled={actionLoading}
                className={`px-4 py-2.5 min-h-[44px] rounded-lg text-sm font-medium transition-colors ${
                  actionLoading
                    ? "bg-cc-hover text-cc-muted cursor-not-allowed"
                    : "bg-cc-primary hover:bg-cc-primary-hover text-white cursor-pointer"
                }`}
              >
                {actionLoading ? "Starting..." : "Enable HTTPS via Tailscale Funnel"}
              </button>
            </div>
          )}

          {!loading && status && status.installed && status.connected && status.funnelActive && (
            <div className="space-y-3">
              <p className="text-sm text-cc-muted">
                Funnel is active. Your Companion is accessible at:
              </p>
              <div className="flex items-center gap-2">
                <a
                  href={status.funnelUrl || "#"}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex-1 px-3 py-2.5 min-h-[44px] text-sm bg-cc-bg rounded-lg border border-cc-border text-cc-primary font-mono-code truncate flex items-center hover:underline"
                >
                  {status.funnelUrl}
                </a>
                <button
                  type="button"
                  onClick={copyUrl}
                  className="px-3 py-2.5 min-h-[44px] rounded-lg text-sm bg-cc-hover hover:bg-cc-active text-cc-fg transition-colors cursor-pointer"
                >
                  {copied ? "Copied!" : "Copy"}
                </button>
              </div>
              <p className="text-xs text-cc-muted">
                This URL has been automatically set as your Public URL in Settings.
              </p>
              <button
                type="button"
                onClick={onDisableFunnel}
                disabled={actionLoading}
                className={`px-4 py-2.5 min-h-[44px] rounded-lg text-sm font-medium transition-colors ${
                  actionLoading
                    ? "bg-cc-hover text-cc-muted cursor-not-allowed"
                    : "bg-cc-error/10 hover:bg-cc-error/20 text-cc-error cursor-pointer"
                }`}
              >
                {actionLoading ? "Stopping..." : "Disable Funnel"}
              </button>
            </div>
          )}

          {/* Structured permission error panel */}
          {status?.error && status.needsOperatorMode && (
            <div className="space-y-3 px-3 py-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
              <p className="text-sm font-medium text-amber-500">
                Operator mode required
              </p>
              <p className="text-xs text-cc-muted">
                On Linux, Tailscale requires operator mode to manage Funnel without sudo.
                Run this command once in your terminal:
              </p>
              <div className="px-3 py-2 rounded-lg bg-cc-hover text-xs text-cc-fg font-mono-code">
                sudo tailscale set --operator=$USER
              </div>
              <p className="text-xs text-cc-muted">
                After running the command, click Retry to enable Funnel.
              </p>
              <button
                type="button"
                onClick={onEnableFunnel}
                disabled={actionLoading}
                className={`px-4 py-2.5 min-h-[44px] rounded-lg text-sm font-medium transition-colors ${
                  actionLoading
                    ? "bg-cc-hover text-cc-muted cursor-not-allowed"
                    : "bg-cc-primary hover:bg-cc-primary-hover text-white cursor-pointer"
                }`}
              >
                {actionLoading ? "Retrying..." : "Retry"}
              </button>
            </div>
          )}

          {/* DNS / reachability warning (non-blocking — funnel is active) */}
          {status?.warning && (
            <div className="space-y-2 px-3 py-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
              <p className="text-sm font-medium text-amber-500">
                URL may not be publicly accessible
              </p>
              <p className="text-xs text-cc-muted">
                {status.warning}
              </p>
              <a
                href="https://login.tailscale.com/admin/acls"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs text-cc-primary hover:underline"
              >
                Open Tailscale admin console
                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
                  <polyline points="15 3 21 3 21 9" />
                  <line x1="10" y1="14" x2="21" y2="3" />
                </svg>
              </a>
            </div>
          )}

          {/* Generic error (non-permission) */}
          {status?.error && !status.needsOperatorMode && (
            <div className="px-3 py-2 rounded-lg bg-cc-error/10 border border-cc-error/20 text-xs text-cc-error">
              {status.error}
            </div>
          )}
        </div>

        {/* How it works cards */}
        <section className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="bg-cc-card border border-cc-border rounded-xl p-4">
            <p className="text-[11px] uppercase tracking-wide text-cc-muted">1. Install</p>
            <p className="mt-1 text-sm text-cc-fg">Install Tailscale on your machine and sign in.</p>
          </div>
          <div className="bg-cc-card border border-cc-border rounded-xl p-4">
            <p className="text-[11px] uppercase tracking-wide text-cc-muted">2. Enable</p>
            <p className="mt-1 text-sm text-cc-fg">One click to get an HTTPS URL with automatic TLS.</p>
          </div>
          <div className="bg-cc-card border border-cc-border rounded-xl p-4">
            <p className="text-[11px] uppercase tracking-wide text-cc-muted">3. Done</p>
            <p className="mt-1 text-sm text-cc-fg">Webhooks and remote access just work.</p>
          </div>
        </section>
      </div>
    </div>
  );
}
