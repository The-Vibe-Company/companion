/**
 * EmptyState — a calm placeholder for empty lists/sections, with an optional
 * call-to-action. Every list view renders one of these for its zero case so the
 * UI never shows a blank region.
 */

import type { ReactNode } from "react";

export interface EmptyStateProps {
  title: ReactNode;
  description?: ReactNode;
  /** Optional action (typically a Button or link) rendered below the text. */
  action?: ReactNode;
  /** Optional decorative icon element. */
  icon?: ReactNode;
  className?: string;
}

export function EmptyState({
  title,
  description,
  action,
  icon,
  className = "",
}: EmptyStateProps) {
  return (
    <div
      className={`flex flex-col items-center justify-center gap-3 rounded-md border border-dashed border-line px-6 py-12 text-center ${className}`}
    >
      {icon != null && (
        <div aria-hidden="true" className="text-faint">
          {icon}
        </div>
      )}
      <div className="space-y-1">
        <p className="text-sm font-medium text-fg">{title}</p>
        {description != null && (
          <p className="max-w-sm text-xs text-muted">{description}</p>
        )}
      </div>
      {action != null && <div className="mt-1">{action}</div>}
    </div>
  );
}
