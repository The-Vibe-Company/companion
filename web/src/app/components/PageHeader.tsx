/**
 * PageHeader — the title block at the top of every page. Renders the page's
 * primary heading plus optional description and right-aligned actions. Each
 * page owns exactly one of these so there is a single h1-level landmark.
 */

import type { ReactNode } from "react";

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** Optional element rendered above the title (e.g. a back link / eyebrow). */
  eyebrow?: ReactNode;
}

export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
}: PageHeaderProps) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow != null && <div className="mb-1">{eyebrow}</div>}
        <h1 className="text-lg font-semibold tracking-tight text-fg">{title}</h1>
        {description != null && (
          <p className="mt-1 max-w-prose text-sm text-muted">{description}</p>
        )}
      </div>
      {actions != null && (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      )}
    </div>
  );
}
