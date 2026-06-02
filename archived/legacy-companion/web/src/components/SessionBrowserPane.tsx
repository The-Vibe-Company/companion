import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api.js";

interface SessionBrowserPaneProps {
  sessionId: string;
}

export function SessionBrowserPane({ sessionId }: SessionBrowserPaneProps) {
  const [loading, setLoading] = useState(true);
  const [browserUrl, setBrowserUrl] = useState<string | null>(null);
  const [browserMode, setBrowserMode] = useState<"host" | "container" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [navUrl, setNavUrl] = useState("http://localhost:3000");
  const [navError, setNavError] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Call browser/start to determine mode and (for container sessions) start the display stack
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setBrowserMode(null);

    api.startBrowser(sessionId).then((result) => {
      if (cancelled) return;
      if (result.mode === "host") {
        // Host mode — no VNC, just proxy-based iframe
        setBrowserMode("host");
        setLoading(false);
      } else if (result.available && result.url) {
        // Container mode — inject auth token into noVNC WebSocket path
        const token = localStorage.getItem("companion_auth_token") || "";
        const url = new URL(result.url, window.location.origin);
        const wsPath = url.searchParams.get("path");
        if (wsPath && token) {
          url.searchParams.set("path", `${wsPath}?token=${encodeURIComponent(token)}`);
        }
        setBrowserUrl(url.pathname + url.search);
        setBrowserMode("container");
      } else {
        setError(result.message || "Browser preview unavailable.");
      }
    }).catch((err) => {
      if (cancelled) return;
      setError(err instanceof Error ? err.message : "Failed to start browser preview");
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });

    return () => { cancelled = true; };
  }, [sessionId]);

  const handleNavigate = useCallback(() => {
    if (!navUrl.trim()) return;
    setNavError(null);

    if (browserMode === "host") {
      // Host mode: construct proxy URL and set iframe src directly
      try {
        const parsed = new URL(navUrl.trim());
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          setNavError("Only http:// and https:// URLs are supported");
          return;
        }
        if (parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
          setNavError("Host mode only supports localhost URLs (e.g. http://localhost:3000)");
          return;
        }
        const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
        const subPath = parsed.pathname.replace(/^\//, "");
        const proxyUrl = `/api/sessions/${encodeURIComponent(sessionId)}/browser/host-proxy/${port}/${subPath}${parsed.search}`;
        setBrowserUrl(proxyUrl);
      } catch {
        setNavError("Invalid URL");
      }
    } else {
      // Container mode: navigate via xdotool
      api.navigateBrowser(sessionId, navUrl.trim()).catch((err) => {
        setNavError(err instanceof Error ? err.message : "Navigation failed");
      });
    }
  }, [sessionId, navUrl, browserMode]);

  const handleReload = useCallback(() => {
    if (iframeRef.current && browserUrl) {
      iframeRef.current.src = browserUrl;
    }
  }, [browserUrl]);

  if (loading) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 p-4">
        <div className="w-5 h-5 border-2 border-cc-primary border-t-transparent rounded-full animate-spin" />
        <div className="text-sm text-cc-muted">Starting browser preview...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full flex items-center justify-center p-4">
        <div className="px-4 py-3 rounded-lg bg-cc-error/10 border border-cc-error/30 text-sm text-cc-error max-w-md text-center">
          {error}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-cc-bg">
      {/* Toolbar */}
      <div className="shrink-0 px-3 py-2 border-b border-cc-border flex items-center gap-2">
        <button
          type="button"
          onClick={handleReload}
          className="flex items-center justify-center w-7 h-7 rounded text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
          aria-label="Reload browser"
          title="Reload"
        >
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
            <path d="M13.65 2.35a1 1 0 0 0-1.3 0L11 3.7A5.99 5.99 0 0 0 2 8a1 1 0 1 0 2 0 4 4 0 0 1 6.29-3.29L8.65 6.35a1 1 0 0 0 .7 1.7H13a1 1 0 0 0 1-1V3.4a1 1 0 0 0-.35-.7z M14 8a1 1 0 1 0-2 0 4 4 0 0 1-6.29 3.29l1.64-1.64a1 1 0 0 0-.7-1.7H3.05a1 1 0 0 0-1 1v3.65a1 1 0 0 0 1.7.7L5 11.7A5.99 5.99 0 0 0 14 8z" />
          </svg>
        </button>
        <input
          type="text"
          value={navUrl}
          onChange={(e) => setNavUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleNavigate(); }}
          placeholder="http://localhost:3000"
          className="flex-1 px-2 py-1 text-xs rounded bg-cc-bg border border-cc-border text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary"
          aria-label="Navigate URL"
        />
        <button
          type="button"
          onClick={handleNavigate}
          className="px-3 py-1 rounded text-xs font-medium bg-cc-primary text-white hover:bg-cc-primary-hover transition-colors cursor-pointer"
        >
          Go
        </button>
      </div>

      {/* Navigation error banner */}
      {navError && (
        <div className="shrink-0 px-3 py-1.5 bg-cc-error/10 border-b border-cc-error/30 text-xs text-cc-error flex items-center justify-between">
          <span>{navError}</span>
          <button type="button" onClick={() => setNavError(null)} className="ml-2 hover:underline cursor-pointer">Dismiss</button>
        </div>
      )}

      {/* Browser iframe */}
      <div className="flex-1 min-h-0">
        {browserUrl ? (
          <iframe
            ref={iframeRef}
            src={browserUrl}
            className="w-full h-full border-0"
            title="Browser preview"
            // Container mode needs allow-same-origin for noVNC WebSocket connections.
            // This is intentional: noVNC content is trusted (our own server in the container).
            // Host mode omits allow-same-origin to isolate proxied third-party content.
            sandbox={browserMode === "container" ? "allow-scripts allow-same-origin allow-forms allow-popups" : "allow-scripts allow-forms allow-popups"}
          />
        ) : browserMode === "host" ? (
          <div className="h-full flex items-center justify-center p-4 text-sm text-cc-muted">
            Enter a URL and click Go to preview.
          </div>
        ) : null}
      </div>
    </div>
  );
}
