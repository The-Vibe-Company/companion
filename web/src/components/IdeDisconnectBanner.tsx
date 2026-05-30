/**
 * IdeDisconnectBanner — BIND-05 in-chat banner.
 *
 * Rendered when a session's IDE binding transitions non-null → null.
 * SPEC pins the exact copy: "IDE disconnected — rebind via /ide" (em-dash).
 *
 * Constraints (BIND-05):
 *   - dismissible (per-session, per-disconnect — a new disconnect re-shows).
 *   - no toast, no modal — an in-chat `<div role="status">` element.
 *
 * Dismiss tracking lives in the parent (ChatView) so state is keyed by
 * session + binding identity. This component is pure presentational.
 */
export const IDE_DISCONNECT_BANNER_TEXT =
  "IDE disconnected \u2014 rebind via /ide";

interface IdeDisconnectBannerProps {
  onDismiss: () => void;
}

export function IdeDisconnectBanner({ onDismiss }: IdeDisconnectBannerProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="ide-disconnect-banner"
      className="px-4 py-2.5 bg-gradient-to-r from-cc-warning/8 to-cc-warning/4 border-b border-cc-warning/15 flex items-center justify-center gap-3 animate-[fadeSlideIn_0.3s_ease-out]"
    >
      <span className="w-1.5 h-1.5 rounded-full bg-cc-warning shrink-0" />
      <span className="text-xs text-cc-warning font-medium">
        {IDE_DISCONNECT_BANNER_TEXT}
      </span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss IDE disconnected notice"
        className="text-xs font-medium px-2 py-1 rounded-md text-cc-warning hover:bg-cc-warning/15 transition-colors cursor-pointer"
      >
        Dismiss
      </button>
    </div>
  );
}
