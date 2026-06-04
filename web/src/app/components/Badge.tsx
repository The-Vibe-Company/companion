/**
 * Badge — a small, calm status pill. Tones map to the semantic theme colors;
 * the default `neutral` tone is used for lifecycle/metadata labels. A leading
 * dot is optional for status-like badges.
 */

import type { ReactNode } from "react";

export type BadgeTone = "neutral" | "accent" | "ok" | "warn" | "danger";

export interface BadgeProps {
  tone?: BadgeTone;
  /** Shows a small leading status dot in the tone color. */
  dot?: boolean;
  className?: string;
  children: ReactNode;
}

const tones: Record<BadgeTone, { pill: string; dot: string }> = {
  neutral: {
    pill: "border-line bg-surface-raised text-muted",
    dot: "bg-faint",
  },
  accent: {
    pill: "border-accent-muted/40 bg-accent-muted/15 text-accent",
    dot: "bg-accent",
  },
  ok: {
    pill: "border-ok/30 bg-ok/12 text-ok",
    dot: "bg-ok",
  },
  warn: {
    pill: "border-warn/30 bg-warn/12 text-warn",
    dot: "bg-warn",
  },
  danger: {
    pill: "border-danger/30 bg-danger/12 text-danger",
    dot: "bg-danger",
  },
};

export function Badge({
  tone = "neutral",
  dot = false,
  className = "",
  children,
}: BadgeProps) {
  const t = tones[tone];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium ${t.pill} ${className}`}
    >
      {dot && (
        <span
          aria-hidden="true"
          className={`size-1.5 rounded-full ${t.dot}`}
        />
      )}
      {children}
    </span>
  );
}
