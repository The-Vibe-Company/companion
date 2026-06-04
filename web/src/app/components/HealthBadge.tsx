/**
 * HealthBadge — maps a fleet health string to a toned Badge with a status dot.
 *
 * The health values come from `internal/status` (ok / degraded / down /
 * unknown). An empty/unknown value renders a muted "unknown" pill so a row
 * without snapshot enrichment still reads cleanly.
 */

import { Badge, type BadgeTone } from "./Badge";

export interface HealthBadgeProps {
  health?: string;
  className?: string;
}

interface HealthView {
  tone: BadgeTone;
  label: string;
}

function viewFor(health: string | undefined): HealthView {
  switch ((health ?? "").toLowerCase()) {
    case "ok":
    case "healthy":
      return { tone: "ok", label: "Healthy" };
    case "degraded":
      return { tone: "warn", label: "Degraded" };
    case "down":
      return { tone: "danger", label: "Down" };
    default:
      return { tone: "neutral", label: "Unknown" };
  }
}

export function HealthBadge({ health, className }: HealthBadgeProps) {
  const { tone, label } = viewFor(health);
  return (
    <Badge tone={tone} dot className={className}>
      {label}
    </Badge>
  );
}
