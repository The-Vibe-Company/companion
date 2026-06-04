/**
 * OperationProgress — live view of an async apply operation.
 *
 * Polls the operation via `useOperation` until it reaches a terminal state, then
 * fires `onDone(status)` exactly once. Shows the current state, a spinner while
 * running, the list of changed resource addresses, and any error. This is the
 * first-class "what is happening right now" surface for an apply.
 */

import { useEffect, useRef } from "react";
import { useOperation } from "../hooks";
import type { OperationStatus } from "../../api/types";
import { Badge, type BadgeTone } from "./Badge";
import { Spinner } from "./Spinner";
import { ErrorBanner } from "./ErrorBanner";

export interface OperationProgressProps {
  /** The operation id to track, or null when no apply is active. */
  operationId: string | null;
  /** Called once when the operation reaches a terminal state. */
  onDone?: (status: OperationStatus) => void;
  className?: string;
}

const STATE_TONE: Record<string, BadgeTone> = {
  pending: "neutral",
  running: "accent",
  succeeded: "ok",
  failed: "danger",
};

function isTerminal(state: string | undefined): boolean {
  return state === "succeeded" || state === "failed";
}

export function OperationProgress({
  operationId,
  onDone,
  className = "",
}: OperationProgressProps) {
  const { data, error } = useOperation(operationId, 1500);

  // Fire onDone exactly once per operation id, when it first goes terminal.
  const notifiedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!data || !operationId) return;
    if (isTerminal(data.state) && notifiedFor.current !== operationId) {
      notifiedFor.current = operationId;
      onDone?.(data);
    }
  }, [data, operationId, onDone]);

  if (!operationId) return null;

  const state = data?.state ?? "pending";
  const running = state === "pending" || state === "running";
  const changed = data?.changed_resources ?? [];

  return (
    <div
      className={`space-y-3 rounded-md border border-line bg-surface p-4 ${className}`}
      aria-live="polite"
    >
      <div className="flex items-center gap-3">
        {running && <Spinner label="Applying" />}
        <span className="text-sm font-medium text-fg">Apply</span>
        <Badge tone={STATE_TONE[state] ?? "neutral"} dot className="ml-auto">
          {state}
        </Badge>
      </div>

      {error && <ErrorBanner error={error} title="Could not read operation status" />}

      {data?.error && (
        <ErrorBanner error={data.error} title="Apply failed" />
      )}

      {changed.length > 0 ? (
        <div>
          <p className="mb-1.5 text-xs font-medium text-muted">
            Changed resources ({changed.length})
          </p>
          <ul className="space-y-1">
            {changed.map((addr) => (
              <li
                key={addr}
                className="font-mono text-xs text-fg"
              >
                {addr}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        state === "succeeded" && (
          <p className="text-xs text-muted">
            Apply completed with no resource changes.
          </p>
        )
      )}
    </div>
  );
}
