/**
 * Format a token count with k/M suffixes for compact display.
 */
export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * Format an elapsed duration in milliseconds as "Xs" or "Xm Ys".
 */
export function formatElapsed(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return `${mins}m ${secs % 60}s`;
}

/**
 * Format a countdown from a future ISO-8601 timestamp to a compact "Xd Yh Zm" string.
 * Returns "now" if the timestamp is in the past.
 */
export function formatResetTime(resetsAt: string): string {
  try {
    const diffMs = new Date(resetsAt).getTime() - Date.now();
    if (!Number.isFinite(diffMs)) return "N/A";
    if (diffMs <= 0) return "now";
    return formatCountdownMs(diffMs);
  } catch {
    return "N/A";
  }
}

/**
 * Format a countdown from a future epoch-ms timestamp to a compact "Xd Yh" / "XhYm" / "Xm" string.
 * Returns "now" if the timestamp is in the past.
 */
export function formatCodexResetTime(resetsAtMs: number): string {
  const normalized = resetsAtMs > 0 && resetsAtMs < 1_000_000_000_000 ? resetsAtMs * 1000 : resetsAtMs;
  const diffMs = normalized - Date.now();
  if (diffMs <= 0) return "now";
  const days = Math.floor(diffMs / 86_400_000);
  const hours = Math.floor((diffMs % 86_400_000) / 3_600_000);
  const minutes = Math.floor((diffMs % 3_600_000) / 60_000);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h${minutes}m`;
  return `${minutes}m`;
}

/**
 * Format a window duration in minutes as "Xd" / "Xh" / "Xm".
 */
export function formatWindowDuration(mins: number): string {
  if (mins >= 1440) return `${Math.round(mins / 1440)}d`;
  if (mins >= 60) return `${Math.round(mins / 60)}h`;
  return `${mins}m`;
}

function formatCountdownMs(diffMs: number): string {
  const days = Math.floor(diffMs / 86_400_000);
  const hours = Math.floor((diffMs % 86_400_000) / 3_600_000);
  const minutes = Math.floor((diffMs % 3_600_000) / 60_000);
  if (days > 0) return `${days}d ${hours}h${minutes}m`;
  if (hours > 0) return `${hours}h${minutes}m`;
  return `${minutes}m`;
}
