import { useEffect, useRef, useCallback } from "react";

/** Statuses that indicate the instance has reached a final state. */
const SETTLED_STATUSES = new Set(["started", "running", "stopped"]);

/** Default polling interval in milliseconds. */
const DEFAULT_INTERVAL_MS = 4_000;

/**
 * Polls loadInstances() periodically when any instance is in a transitional
 * (non-settled) state. Stops polling once all instances are settled or the
 * instances list is empty.
 */
export function useInstancePolling(
  instances: Array<{ machineStatus?: string }>,
  loadInstances: () => Promise<void> | void,
  intervalMs: number = DEFAULT_INTERVAL_MS,
) {
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const hasTransitional =
    instances.length > 0 &&
    instances.some((inst) => !SETTLED_STATUSES.has(inst.machineStatus ?? ""));

  const clearPolling = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (hasTransitional) {
      if (intervalRef.current === null) {
        intervalRef.current = setInterval(() => {
          void loadInstances();
        }, intervalMs);
      }
    } else {
      clearPolling();
    }

    return clearPolling;
  }, [hasTransitional, loadInstances, intervalMs, clearPolling]);

  return { isPolling: hasTransitional };
}
