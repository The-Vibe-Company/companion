import { installClipboardWriteFallback } from "./clipboard.js";

export type Route =
  | { page: "home" }
  | { page: "session"; sessionId: string }
  | { page: "settings" }
  | { page: "integrations" }
  | { page: "integration-linear" }
  | { page: "integration-linear-oauth" }
  | { page: "integration-tailscale" }
  | { page: "prompts" }
  | { page: "environments" }
  | { page: "sandboxes" }
  | { page: "scheduled" }
  | { page: "agents" }
  | { page: "agent-detail"; agentId: string }
  | { page: "runs" }
  | { page: "playground" };

const SESSION_PREFIX = "#/session/";
const AGENT_PREFIX = "#/agents/";
let clipboardFallbackInitialized = false;

function ensureClipboardFallbackInstalled(): void {
  if (clipboardFallbackInitialized) return;
  installClipboardWriteFallback();
  clipboardFallbackInitialized = true;
}

/**
 * Parse a window.location.hash string into a typed Route.
 */
export function parseHash(hash: string): Route {
  ensureClipboardFallbackInstalled();

  // Strip query params from hash for matching (OAuth callbacks and deep links
  // append data such as ?oauth_success=true or ?section=providers).
  const hashPath = hash.split("?")[0];
  if (hashPath === "#/settings") return { page: "settings" };
  if (hashPath === "#/integrations") return { page: "integrations" };
  if (hashPath === "#/integrations/linear") return { page: "integration-linear" };
  if (hashPath === "#/integrations/linear-oauth") return { page: "integration-linear-oauth" };
  if (hashPath === "#/integrations/tailscale") return { page: "integration-tailscale" };
  if (hashPath === "#/prompts") return { page: "prompts" };
  if (hashPath === "#/environments") return { page: "environments" };
  if (hashPath === "#/sandboxes") return { page: "sandboxes" };
  // #/scheduled redirects to #/agents (cron absorbed into agents)
  if (hashPath === "#/scheduled") return { page: "agents" };
  if (hashPath === "#/runs") return { page: "runs" };
  if (hashPath === "#/playground") return { page: "playground" };
  if (hashPath === "#/agents") return { page: "agents" };

  if (hashPath.startsWith(AGENT_PREFIX)) {
    const agentId = hashPath.slice(AGENT_PREFIX.length);
    if (agentId) return { page: "agent-detail", agentId };
  }

  if (hashPath.startsWith(SESSION_PREFIX)) {
    const sessionId = hashPath.slice(SESSION_PREFIX.length);
    if (sessionId) return { page: "session", sessionId };
  }

  return { page: "home" };
}

/**
 * Build a hash string for a given session ID.
 */
export function sessionHash(sessionId: string): string {
  return `#/session/${sessionId}`;
}

/**
 * Navigate to a session by updating the URL hash.
 * When replace=true, uses replaceState to avoid creating a history entry.
 */
export function navigateToSession(sessionId: string, replace = false): void {
  ensureClipboardFallbackInstalled();

  const newHash = sessionHash(sessionId);
  if (replace) {
    history.replaceState(null, "", newHash);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else {
    window.location.hash = `/session/${sessionId}`;
  }
}

/**
 * Navigate to the home page (no session selected) by clearing the hash.
 * When replace=true, uses replaceState to avoid creating a history entry.
 */
export function navigateHome(replace = false): void {
  ensureClipboardFallbackInstalled();

  if (replace) {
    history.replaceState(null, "", window.location.pathname + window.location.search);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else {
    window.location.hash = "";
  }
}
