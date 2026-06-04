/**
 * Data-fetching hooks for the console.
 *
 * `usePolling` is the generic primitive: it calls an async function on an
 * interval, exposes `{ data, error, loading, refresh }`, and guards against
 * setting state after unmount or out of order (a slower earlier request never
 * clobbers a newer result). `useStatus` and `useOperation` build on it.
 *
 * `useOperation` stops polling once the operation reaches a terminal state
 * (`succeeded` / `failed`), so callers can render live apply progress without an
 * infinite poll loop.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { getOperation, getStatus } from "../api/client";
import type { OperationStatus, StatusSnapshot } from "../api/types";

/** The shape returned by every polling hook. */
export interface PollingState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  /** Triggers an immediate out-of-band refresh and resets the interval. */
  refresh: () => void;
}

/**
 * Polls `fn` every `intervalMs` milliseconds, plus once immediately on mount and
 * whenever `deps` change. A non-positive interval disables the repeat timer
 * (single fetch + manual `refresh`). State updates after unmount are dropped.
 *
 * `deps` are spread into the effect dependency list; callers pass primitives
 * (e.g. an id) that should restart polling when they change. `fn` is captured
 * per render but only re-subscribed when `deps`/`intervalMs` change, so an
 * inline lambda is fine.
 */
export function usePolling<T>(
  fn: () => Promise<T>,
  intervalMs: number,
  deps: ReadonlyArray<unknown> = [],
): PollingState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  // Bump this to force the effect to re-run for a manual refresh.
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  // Keep the latest fn in a ref so the polling effect does not resubscribe on
  // every render (callers commonly pass an inline closure).
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    let cancelled = false;
    // Monotonic guard: only the most recently *started* request may write state.
    let latest = 0;

    const tick = async () => {
      const seq = ++latest;
      try {
        const result = await fnRef.current();
        if (cancelled || seq !== latest) return;
        setData(result);
        setError(null);
      } catch (err) {
        if (cancelled || seq !== latest) return;
        setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        if (!cancelled && seq === latest) {
          setLoading(false);
        }
      }
    };

    setLoading(true);
    void tick();

    if (intervalMs <= 0) {
      return () => {
        cancelled = true;
      };
    }
    const handle = setInterval(() => {
      void tick();
    }, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, nonce, ...deps]);

  return { data, error, loading, refresh };
}

/** Polls the fleet status snapshot. Defaults to a 5s interval. */
export function useStatus(intervalMs = 5000): PollingState<StatusSnapshot> {
  return usePolling<StatusSnapshot>(() => getStatus(), intervalMs, []);
}

/** True once an operation has reached a terminal state. */
function isTerminal(state: string | undefined): boolean {
  return state === "succeeded" || state === "failed";
}

/**
 * Polls a single apply operation until it reaches a terminal state, then stops.
 * Passing `id === null` disables polling entirely (used before an apply is
 * started). Defaults to a 1.5s interval while running.
 *
 * The hook reads `data.state` each tick; once terminal, it clears its own timer
 * so no further requests are made even though the component stays mounted.
 */
export function useOperation(
  id: string | null,
  intervalMs = 1500,
): PollingState<OperationStatus> {
  const [data, setData] = useState<OperationStatus | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState<boolean>(id != null);

  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (id == null) {
      // Idle: no operation to track. Clear any prior result/loading.
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    let handle: ReturnType<typeof setInterval> | null = null;

    const stop = () => {
      if (handle !== null) {
        clearInterval(handle);
        handle = null;
      }
    };

    const tick = async () => {
      try {
        const result = await getOperation(id);
        if (cancelled) return;
        setData(result);
        setError(null);
        if (isTerminal(result.state)) {
          // Terminal: stop the timer so we never poll a finished operation.
          stop();
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    setLoading(true);
    void tick();

    if (intervalMs > 0) {
      handle = setInterval(() => {
        void tick();
      }, intervalMs);
    }
    return () => {
      cancelled = true;
      stop();
    };
  }, [id, intervalMs, nonce]);

  return { data, error, loading, refresh };
}
