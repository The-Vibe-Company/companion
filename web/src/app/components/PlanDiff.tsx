/**
 * PlanDiff — renders a computed plan's changes as a legible, color-coded list.
 *
 * Each change kind has a distinct marker + color, mirroring the engine's
 * single-character markers:
 *   "+" create  → green
 *   "~" update  → amber
 *   "-" destroy → red
 *   "=" no-op    → muted
 *   "!" error/blocked → red
 *
 * Protected resources get an explicit, high-visibility badge so a destroy of a
 * protected resource is never mistaken for a routine change. Colour is never the
 * only signal: the marker glyph and an accessible label carry the meaning too.
 */

import type { PlanChange } from "../../api/types";
import { Badge } from "./Badge";
import { EmptyState } from "./EmptyState";

export interface PlanDiffProps {
  changes: PlanChange[];
  className?: string;
}

interface KindView {
  /** Accessible verb for screen readers. */
  label: string;
  /** Text/marker colour class. */
  color: string;
  /** Left rail accent. */
  rail: string;
}

function viewForKind(kind: string): KindView {
  switch (kind) {
    case "+":
      return { label: "create", color: "text-ok", rail: "bg-ok" };
    case "~":
      return { label: "update", color: "text-warn", rail: "bg-warn" };
    case "-":
      return { label: "destroy", color: "text-danger", rail: "bg-danger" };
    case "!":
      return { label: "blocked", color: "text-danger", rail: "bg-danger" };
    case "=":
    default:
      return { label: "no change", color: "text-faint", rail: "bg-line-strong" };
  }
}

export function PlanDiff({ changes, className = "" }: PlanDiffProps) {
  if (changes.length === 0) {
    return (
      <EmptyState
        title="No changes"
        description="The workspace matches the recorded state. Nothing to apply."
        className={className}
      />
    );
  }

  return (
    <ul
      aria-label="Planned changes"
      className={`divide-y divide-line overflow-hidden rounded-md border border-line ${className}`}
    >
      {changes.map((change, i) => {
        const view = viewForKind(change.kind);
        return (
          <li
            key={`${change.address}-${i}`}
            data-kind={change.kind}
            className="flex items-start gap-3 bg-surface px-3 py-2"
          >
            <span
              aria-hidden="true"
              className={`mt-0.5 w-3 shrink-0 self-stretch rounded-full ${view.rail}`}
            />
            <span
              aria-hidden="true"
              className={`mt-px w-3 shrink-0 text-center font-mono text-sm font-bold ${view.color}`}
            >
              {change.kind}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs text-fg">
                  {change.address}
                </span>
                <span className={`text-[11px] font-medium uppercase ${view.color}`}>
                  <span className="sr-only">Change type: </span>
                  {view.label}
                </span>
                {change.protected && (
                  <Badge tone="danger">protected</Badge>
                )}
              </div>
              {change.message && (
                <p className="mt-0.5 text-xs break-words text-muted">
                  {change.message}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
