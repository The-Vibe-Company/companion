/**
 * Card — a hairline-bordered surface container with optional title/actions
 * header. Used to group related content (agent detail sections, plan output,
 * settings panels) on the canvas.
 */

import type { ReactNode } from "react";

export interface CardProps {
  /** Optional heading shown in the card header row. */
  title?: ReactNode;
  /** Optional secondary text under the title. */
  description?: ReactNode;
  /** Optional actions rendered at the right of the header row. */
  actions?: ReactNode;
  /** Removes inner padding from the body (for full-bleed content like tables). */
  bare?: boolean;
  className?: string;
  children?: ReactNode;
}

export function Card({
  title,
  description,
  actions,
  bare = false,
  className = "",
  children,
}: CardProps) {
  const hasHeader = title != null || actions != null || description != null;
  return (
    <section
      className={`rounded-md border border-line bg-surface ${className}`}
    >
      {hasHeader && (
        <header className="flex items-start justify-between gap-4 border-b border-line px-4 py-3">
          <div className="min-w-0">
            {title != null && (
              <h2 className="truncate text-sm font-semibold text-fg">{title}</h2>
            )}
            {description != null && (
              <p className="mt-0.5 text-xs text-muted">{description}</p>
            )}
          </div>
          {actions != null && (
            <div className="flex shrink-0 items-center gap-2">{actions}</div>
          )}
        </header>
      )}
      <div className={bare ? "" : "p-4"}>{children}</div>
    </section>
  );
}
