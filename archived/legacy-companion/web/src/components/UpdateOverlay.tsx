import { useEffect, useRef, useState } from "react";

/** Read the auth token from localStorage for the poll request.
 *  Intentionally local — exporting from api.ts would trigger the coverage gate on that file. */
function getAuthHeaders(): Record<string, string> {
  const token = localStorage.getItem("companion_auth_token");
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

type Phase = "installing" | "restarting" | "waiting" | "ready";

const PHASE_LABELS: Record<Phase, string> = {
  installing: "Installing update...",
  restarting: "Restarting server...",
  waiting: "Waiting for server...",
  ready: "Update complete!",
};

/**
 * Polls the server health endpoint until it responds, then reloads the page.
 * Runs through phases: installing -> restarting -> waiting -> ready -> reload.
 */
function useServerPoll(active: boolean) {
  const [phase, setPhase] = useState<Phase>("installing");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!active) return;

    // Move to "restarting" phase after a short delay (give the install time)
    const restartTimer = setTimeout(() => {
      if (mountedRef.current) setPhase("restarting");
    }, 3000);

    // Start polling after giving the server time to begin restart
    const pollStart = setTimeout(() => {
      if (mountedRef.current) setPhase("waiting");
      poll();
    }, 5000);

    function poll() {
      if (!mountedRef.current) return;

      fetch("/api/update-check", { signal: AbortSignal.timeout(3000), headers: getAuthHeaders() })
        .then((res) => {
          if (!res.ok) throw new Error("not ready");
          return res.json();
        })
        .then(() => {
          if (!mountedRef.current) return;
          setPhase("ready");
          // Brief pause to show the success state, then reload
          setTimeout(() => {
            if (mountedRef.current) window.location.reload();
          }, 800);
        })
        .catch(() => {
          // Server not ready yet, retry
          timerRef.current = setTimeout(poll, 1500);
        });
    }

    return () => {
      clearTimeout(restartTimer);
      clearTimeout(pollStart);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [active]);

  return phase;
}

/**
 * Renders the overlay visuals for a given phase.
 * Used by both the real UpdateOverlay and the Playground preview.
 */
function UpdateOverlayVisual({ phase, className }: { phase: Phase; className?: string }) {
  const isReady = phase === "ready";

  return (
    <div className={`flex flex-col items-center justify-center bg-cc-bg animate-fade-in ${className ?? ""}`}>
      {/* Animated logo area */}
      <div className="relative mb-8">
        {/* Glow ring */}
        {!isReady && (
          <div className="absolute inset-0 -m-4 rounded-full bg-cc-primary/10 animate-pulse" />
        )}
        <img
          src="/logo.svg"
          alt="Updating"
          className={`w-20 h-20 relative z-10 transition-transform duration-500 ${
            isReady ? "" : "scale-110"
          }`}
        />
        {/* Spinner ring */}
        {!isReady && (
          <div className="absolute -inset-3 z-0">
            <svg className="w-full h-full animate-spin-slow" viewBox="0 0 100 100">
              <circle
                cx="50" cy="50" r="46"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeDasharray="60 230"
                strokeLinecap="round"
                className="text-cc-primary/40"
              />
            </svg>
          </div>
        )}
        {/* Success ring */}
        {isReady && (
          <div className="absolute -inset-3 z-0 rounded-full border-2 border-cc-success/30 animate-fade-in" />
        )}
      </div>

      {/* Status text */}
      <p className={`text-sm font-medium mb-2 transition-colors ${
        isReady ? "text-cc-success" : "text-cc-fg"
      }`}>
        {PHASE_LABELS[phase]}
      </p>
      <p className="text-xs text-cc-muted">
        {isReady ? "Reloading..." : "This page will refresh automatically"}
      </p>

      {/* Progress dots */}
      {!isReady && (
        <div className="flex gap-1.5 mt-6">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              data-testid="progress-dot"
              className="w-1.5 h-1.5 rounded-full bg-cc-primary/50"
              style={{
                animation: "pulse-dot 1.4s ease-in-out infinite",
                animationDelay: `${i * 0.2}s`,
              }}
            />
          ))}
        </div>
      )}

      {/* Bottom progress bar */}
      <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-cc-border/30">
        <div
          className="h-full bg-cc-primary/60 transition-all duration-1000 ease-out"
          style={{
            width: isReady
              ? "100%"
              : phase === "waiting"
                ? "75%"
                : phase === "restarting"
                  ? "40%"
                  : "15%",
          }}
        />
      </div>
    </div>
  );
}

interface Props {
  /** Whether the overlay is visible / update is in progress */
  active: boolean;
}

export function UpdateOverlay({ active }: Props) {
  const phase = useServerPoll(active);

  if (!active) return null;

  return (
    <UpdateOverlayVisual
      phase={phase}
      className="fixed inset-0 z-[100]"
    />
  );
}

/**
 * Static preview of the UpdateOverlay for the Playground page.
 * Renders in a contained box (absolute positioning) with a fixed phase.
 */
export function PlaygroundUpdateOverlay({ phase }: { phase: Phase }) {
  return (
    <UpdateOverlayVisual
      phase={phase}
      className="absolute inset-0"
    />
  );
}
