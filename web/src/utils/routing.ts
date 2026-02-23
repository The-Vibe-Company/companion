export type Route =
  | { page: "home" }
  | { page: "session"; sessionId: string }
  | { page: "settings" }
  | { page: "integrations" }
  | { page: "integration-linear" }
  | { page: "prompts" }
  | { page: "terminal" }
  | { page: "environments" }
  | { page: "scheduled" }
  | { page: "playground" }
  | { page: "preview"; filePath: string };

const SESSION_PREFIX = "#/session/";
const PREVIEW_PREFIX = "#/preview";

/**
 * Parse a window.location.hash string into a typed Route.
 */
export function parseHash(hash: string): Route {
  if (hash === "#/settings") return { page: "settings" };
  if (hash === "#/integrations") return { page: "integrations" };
  if (hash === "#/integrations/linear") return { page: "integration-linear" };
  if (hash === "#/prompts") return { page: "prompts" };
  if (hash === "#/terminal") return { page: "terminal" };
  if (hash === "#/environments") return { page: "environments" };
  if (hash === "#/scheduled") return { page: "scheduled" };
  if (hash === "#/playground") return { page: "playground" };

  // #/preview?path=/some/file.md
  if (hash.startsWith(PREVIEW_PREFIX)) {
    const qIndex = hash.indexOf("?");
    if (qIndex !== -1) {
      const params = new URLSearchParams(hash.slice(qIndex + 1));
      const filePath = params.get("path");
      if (filePath) return { page: "preview", filePath };
    }
  }

  if (hash.startsWith(SESSION_PREFIX)) {
    const sessionId = hash.slice(SESSION_PREFIX.length);
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
  if (replace) {
    history.replaceState(null, "", window.location.pathname + window.location.search);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else {
    window.location.hash = "";
  }
}
