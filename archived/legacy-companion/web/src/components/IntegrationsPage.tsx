import { useEffect, useState } from "react";
import { api, type TailscaleStatus, type AgentInfo, type LinearOAuthConnectionSummary } from "../api.js";
import { navigateHome, navigateToSession } from "../utils/routing.js";
import { useStore } from "../store.js";
import { LinearLogo } from "./LinearLogo.js";

interface IntegrationsPageProps {
  embedded?: boolean;
}

export function IntegrationsPage({ embedded = false }: IntegrationsPageProps) {
  const [linearConnected, setLinearConnected] = useState(false);
  const [linearViewerLabel, setLinearViewerLabel] = useState("");
  const [error, setError] = useState("");
  const [tailscaleStatus, setTailscaleStatus] = useState<TailscaleStatus | null>(null);
  const [oauthConnections, setOauthConnections] = useState<LinearOAuthConnectionSummary[]>([]);
  const [linearAgents, setLinearAgents] = useState<AgentInfo[]>([]);

  useEffect(() => {
    // Load Tailscale status (non-blocking)
    api.getTailscaleStatus().then(setTailscaleStatus).catch(() => setTailscaleStatus({
      installed: false, binaryPath: null, connected: false, dnsName: null,
      funnelActive: false, funnelUrl: null, error: "Could not reach Tailscale status endpoint",
    }));

    // Load Linear integration status
    api.getSettings()
      .then((settings) => {
        if (!settings.linearApiKeyConfigured) return;
        return api.getLinearConnection().then((info) => {
          setLinearConnected(info.connected);
          const label = info.viewerName || info.viewerEmail || "Connected account";
          const team = info.teamName ? ` \u2022 ${info.teamName}` : "";
          setLinearViewerLabel(`${label}${team}`);
        });
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));

    // Load OAuth connections
    api.listLinearOAuthConnections()
      .then((result) => setOauthConnections(result.connections))
      .catch(() => {});

    // Load Linear agents
    api.listAgents()
      .then((agents) => {
        setLinearAgents(agents.filter(a => a.triggers?.linear?.enabled));
      })
      .catch(() => {});
  }, []);

  const oauthConnectedCount = oauthConnections.filter(c => c.status === "connected").length;
  return (
    <div className={`${embedded ? "h-full" : "h-[100dvh]"} bg-cc-bg text-cc-fg font-sans-ui antialiased overflow-y-auto`}>
      <div className="max-w-5xl mx-auto px-4 sm:px-8 py-6 sm:py-10 pb-safe">
        <div className="flex items-start justify-between gap-3 mb-6">
          <div>
            <h1 className="text-xl font-semibold text-cc-fg">Integrations</h1>
            <p className="mt-1 text-sm text-cc-muted">
              Connect tools and open their dedicated settings page.
            </p>
          </div>
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

        {error && (
          <div className="mb-4 px-3 py-2 rounded-lg bg-cc-error/10 border border-cc-error/20 text-xs text-cc-error">
            {error}
          </div>
        )}

        {/* Card 1: Linear Tickets */}
        <section className="group relative overflow-hidden rounded-3xl border border-cc-border/80 bg-cc-card p-5 pb-16 sm:p-7 sm:pb-7 transition-all duration-300 hover:border-cc-primary/35 hover:shadow-[0_18px_44px_rgba(0,0,0,0.18)]">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(80%_140%_at_100%_0%,rgba(251,146,60,0.18),transparent_52%)]" />
          <div className="pointer-events-none absolute inset-0 opacity-30 bg-[linear-gradient(120deg,transparent_0%,rgba(255,255,255,0.04)_35%,transparent_62%)]" />
          <div className="relative min-w-0">
            <div className="min-w-0">
              <div className="inline-flex items-center gap-2 rounded-full border border-cc-border bg-cc-hover/55 px-3 py-1.5 text-xs tracking-wide text-cc-muted">
                <LinearLogo className="h-3.5 w-3.5 text-cc-fg" />
                <span>Linear Tickets</span>
                {linearConnected && (
                  <span
                    className="inline-block h-1.5 w-1.5 rounded-full bg-cc-success shadow-[0_0_0_3px_rgba(34,197,94,0.15)]"
                    aria-label="Connected"
                    title="Connected"
                  />
                )}
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-2.5">
                <h2 className="text-[clamp(1.45rem,2.6vw,2rem)] font-semibold leading-[1.12] tracking-tight text-cc-fg">
                  Issue context before first prompt
                </h2>
              </div>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-cc-muted sm:text-[15px]">
                Connect your workspace, search an issue from Home, and inject scope automatically when a session starts.
              </p>
              <div className="mt-4 inline-flex max-w-full items-center rounded-lg border border-cc-border/80 bg-black/10 px-3 py-1.5 text-xs text-cc-muted/95">
                <span className="truncate">{linearViewerLabel || "No workspace linked yet"}</span>
              </div>
            </div>
            <div className="absolute bottom-0 right-0 sm:bottom-0 sm:right-0 flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  window.location.hash = "#/integrations/linear";
                }}
                aria-label="Open Linear Tickets settings"
                title="Open Linear Tickets settings"
                className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-cc-primary/28 bg-cc-primary/12 text-cc-fg transition-colors hover:border-cc-primary/50 hover:bg-cc-primary/20 focus:outline-none focus:ring-2 focus:ring-cc-primary/35 cursor-pointer"
              >
                <svg viewBox="0 0 24 24" className="h-4.5 w-4.5" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                  <path d="M9.67 4.53 10 2h4l.33 2.53a7.9 7.9 0 0 1 1.7.7l2.03-1.55 2.83 2.83-1.55 2.03c.28.54.51 1.1.7 1.7L22 10v4l-2.53.33a7.9 7.9 0 0 1-.7 1.7l1.55 2.03-2.83 2.83-2.03-1.55c-.54.28-1.1.51-1.7.7L14 22h-4l-.33-2.53a7.9 7.9 0 0 1-1.7-.7l-2.03 1.55-2.83-2.83 1.55-2.03a7.9 7.9 0 0 1-.7-1.7L2 14v-4l2.53-.33c.19-.6.42-1.16.7-1.7L3.68 5.94 6.5 3.1l2.03 1.55c.54-.28 1.1-.51 1.7-.7Z" />
                  <circle cx="12" cy="12" r="3.2" />
                </svg>
              </button>
            </div>
          </div>
        </section>

        {/* Card 2: Linear OAuth Apps */}
        <section className="group relative mt-6 overflow-hidden rounded-3xl border border-cc-border/80 bg-cc-card p-5 pb-16 sm:p-7 sm:pb-7 transition-all duration-300 hover:border-cc-primary/35 hover:shadow-[0_18px_44px_rgba(0,0,0,0.18)]">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(80%_140%_at_100%_0%,rgba(124,58,237,0.18),transparent_52%)]" />
          <div className="pointer-events-none absolute inset-0 opacity-30 bg-[linear-gradient(120deg,transparent_0%,rgba(255,255,255,0.04)_35%,transparent_62%)]" />
          <div className="relative min-w-0">
            <div className="min-w-0">
              <div className="inline-flex items-center gap-2 rounded-full border border-cc-border bg-cc-hover/55 px-3 py-1.5 text-xs tracking-wide text-cc-muted">
                <LinearLogo className="h-3.5 w-3.5 text-cc-fg" />
                <span>Linear OAuth Apps</span>
                {oauthConnectedCount > 0 && (
                  <span
                    className="inline-block h-1.5 w-1.5 rounded-full bg-cc-success shadow-[0_0_0_3px_rgba(34,197,94,0.15)]"
                    aria-label="Connected"
                    title="Connected"
                  />
                )}
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-2.5">
                <h2 className="text-[clamp(1.45rem,2.6vw,2rem)] font-semibold leading-[1.12] tracking-tight text-cc-fg">
                  Agent triggers via Linear
                </h2>
              </div>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-cc-muted sm:text-[15px]">
                Create OAuth apps to trigger agents from @mentions in Linear issues. Each app can connect to a different workspace.
              </p>
              <div className="mt-4 inline-flex max-w-full items-center rounded-lg border border-cc-border/80 bg-black/10 px-3 py-1.5 text-xs text-cc-muted/95">
                <span className="truncate">
                  {oauthConnections.length === 0
                    ? "No OAuth apps configured"
                    : `${oauthConnections.length} app${oauthConnections.length !== 1 ? "s" : ""}, ${oauthConnectedCount} connected`}
                  {linearAgents.length > 0 && ` \u00b7 ${linearAgents.length} agent${linearAgents.length !== 1 ? "s" : ""}`}
                </span>
              </div>
            </div>
            <div className="absolute bottom-0 right-0 sm:bottom-0 sm:right-0 flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  window.location.hash = "#/agents?setup=linear";
                }}
                aria-label="Set up Linear Agent"
                title="Set up Linear Agent"
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-full border border-violet-500/28 bg-violet-500/12 text-xs font-medium text-cc-fg transition-colors hover:border-violet-500/50 hover:bg-violet-500/20 focus:outline-none focus:ring-2 focus:ring-violet-500/35 cursor-pointer"
              >
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 opacity-60" aria-hidden="true">
                  <path d="M8 1.5a2.5 2.5 0 00-2.5 2.5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5S9.38 1.5 8 1.5zM4 8a4 4 0 00-4 4v1.5a.5.5 0 00.5.5h15a.5.5 0 00.5-.5V12a4 4 0 00-4-4H4z" />
                </svg>
                Setup Agent
              </button>
              <button
                type="button"
                onClick={() => {
                  window.location.hash = "#/integrations/linear-oauth";
                }}
                aria-label="Open Linear OAuth settings"
                title="Open Linear OAuth settings"
                className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-violet-500/28 bg-violet-500/12 text-cc-fg transition-colors hover:border-violet-500/50 hover:bg-violet-500/20 focus:outline-none focus:ring-2 focus:ring-violet-500/35 cursor-pointer"
              >
                <svg viewBox="0 0 24 24" className="h-4.5 w-4.5" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                  <path d="M9.67 4.53 10 2h4l.33 2.53a7.9 7.9 0 0 1 1.7.7l2.03-1.55 2.83 2.83-1.55 2.03c.28.54.51 1.1.7 1.7L22 10v4l-2.53.33a7.9 7.9 0 0 1-.7 1.7l1.55 2.03-2.83 2.83-2.03-1.55c-.54.28-1.1.51-1.7.7L14 22h-4l-.33-2.53a7.9 7.9 0 0 1-1.7-.7l-2.03 1.55-2.83-2.83 1.55-2.03a7.9 7.9 0 0 1-.7-1.7L2 14v-4l2.53-.33c.19-.6.42-1.16.7-1.7L3.68 5.94 6.5 3.1l2.03 1.55c.54-.28 1.1-.51 1.7-.7Z" />
                  <circle cx="12" cy="12" r="3.2" />
                </svg>
              </button>
            </div>
          </div>
        </section>

        {/* Tailscale card */}
        <section className="group relative mt-6 overflow-hidden rounded-3xl border border-cc-border/80 bg-cc-card p-5 pb-16 sm:p-7 sm:pb-7 transition-all duration-300 hover:border-cc-primary/35 hover:shadow-[0_18px_44px_rgba(0,0,0,0.18)]">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(80%_140%_at_100%_0%,rgba(6,182,212,0.18),transparent_52%)]" />
          <div className="pointer-events-none absolute inset-0 opacity-30 bg-[linear-gradient(120deg,transparent_0%,rgba(255,255,255,0.04)_35%,transparent_62%)]" />
          <div className="relative min-w-0">
            <div className="min-w-0">
              <div className="inline-flex items-center gap-2 rounded-full border border-cc-border bg-cc-hover/55 px-3 py-1.5 text-xs tracking-wide text-cc-muted">
                <svg className="h-3.5 w-3.5 text-cc-fg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                </svg>
                <span>Tailscale</span>
                {tailscaleStatus?.funnelActive && (
                  <span
                    className="inline-block h-1.5 w-1.5 rounded-full bg-cc-success shadow-[0_0_0_3px_rgba(34,197,94,0.15)]"
                    aria-label="Funnel active"
                    title="Funnel active"
                  />
                )}
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-2.5">
                <h2 className="text-[clamp(1.45rem,2.6vw,2rem)] font-semibold leading-[1.12] tracking-tight text-cc-fg">
                  HTTPS access in one click
                </h2>
              </div>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-cc-muted sm:text-[15px]">
                Use Tailscale Funnel to expose your Companion over HTTPS with automatic TLS certificates.
              </p>
              <div className="mt-4 inline-flex max-w-full items-center rounded-lg border border-cc-border/80 bg-black/10 px-3 py-1.5 text-xs text-cc-muted/95">
                <span className="truncate">
                  {tailscaleStatus === null
                    ? "Checking..."
                    : tailscaleStatus.funnelActive && tailscaleStatus.funnelUrl
                      ? tailscaleStatus.funnelUrl
                      : tailscaleStatus.connected
                        ? tailscaleStatus.dnsName || "Connected"
                        : tailscaleStatus.installed
                          ? "Not connected"
                          : "Not installed"}
                </span>
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                window.location.hash = "#/integrations/tailscale";
              }}
              aria-label="Open Tailscale settings"
              title="Open Tailscale settings"
              className="absolute bottom-0 right-0 sm:bottom-0 sm:right-0 inline-flex h-10 w-10 items-center justify-center rounded-full border border-cc-primary/28 bg-cc-primary/12 text-cc-fg transition-colors hover:border-cc-primary/50 hover:bg-cc-primary/20 focus:outline-none focus:ring-2 focus:ring-cc-primary/35 cursor-pointer"
            >
              <svg viewBox="0 0 24 24" className="h-4.5 w-4.5" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <path d="M9.67 4.53 10 2h4l.33 2.53a7.9 7.9 0 0 1 1.7.7l2.03-1.55 2.83 2.83-1.55 2.03c.28.54.51 1.1.7 1.7L22 10v4l-2.53.33a7.9 7.9 0 0 1-.7 1.7l1.55 2.03-2.83 2.83-2.03-1.55c-.54.28-1.1.51-1.7.7L14 22h-4l-.33-2.53a7.9 7.9 0 0 1-1.7-.7l-2.03 1.55-2.83-2.83 1.55-2.03a7.9 7.9 0 0 1-.7-1.7L2 14v-4l2.53-.33c.19-.6.42-1.16.7-1.7L3.68 5.94 6.5 3.1l2.03 1.55c.54-.28 1.1-.51 1.7-.7Z" />
                <circle cx="12" cy="12" r="3.2" />
              </svg>
            </button>
          </div>
        </section>

      </div>
    </div>
  );
}
