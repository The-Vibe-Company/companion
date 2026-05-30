import { useMemo, useState, useCallback, useRef, useEffect, useLayoutEffect } from "react";
import { useStore } from "../store.js";
import { api } from "../api.js";
import { captureException } from "../analytics.js";
import { MessageFeed } from "./MessageFeed.js";
import { Composer } from "./Composer.js";
import { PermissionBanner } from "./PermissionBanner.js";
import { AiValidationBadge } from "./AiValidationBadge.js";
import { ActivityTray } from "./ActivityTray.js";
import { IdePicker } from "./IdePicker.js";
import { IdeDisconnectBanner } from "./IdeDisconnectBanner.js";
import type { IdeBinding } from "../types.js";

/**
 * Stable identifier for an IDE binding — used to keep the BIND-05 banner
 * dismissal state keyed to this specific disconnect. A new bind+disconnect
 * cycle produces a different id, so the banner re-shows.
 */
function bindingId(b: IdeBinding): string {
  return `${b.lockfilePath}|${b.port}|${b.boundAt}`;
}

export function ChatView({ sessionId }: { sessionId: string }) {
  const sessionPerms = useStore((s) => s.pendingPermissions.get(sessionId));
  const aiResolved = useStore((s) => s.aiResolvedPermissions.get(sessionId));
  const clearAiResolvedPermissions = useStore((s) => s.clearAiResolvedPermissions);
  const connStatus = useStore(
    (s) => s.connectionStatus.get(sessionId) ?? "disconnected"
  );
  const cliConnected = useStore((s) => s.cliConnected.get(sessionId) ?? false);
  const cliReconnecting = useStore(
    (s) => s.cliReconnecting.get(sessionId) ?? false
  );
  const setCliReconnecting = useStore((s) => s.setCliReconnecting);
  // Session record — needed for current `cwd` (passed to IdePicker for
  // best-match ranking) and the live `ideBinding`.
  const sessionRecord = useStore((s) => s.sessions.get(sessionId));
  const ideBinding = sessionRecord?.ideBinding ?? null;
  const sessionCwd = sessionRecord?.cwd;

  const [reconnectError, setReconnectError] = useState<string | null>(null);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // ── UI-03: IdePicker open/close state (parent owns modal visibility) ──
  const [idePickerOpen, setIdePickerOpen] = useState(false);
  const openIdePicker = useCallback(() => setIdePickerOpen(true), []);
  const closeIdePicker = useCallback(() => setIdePickerOpen(false), []);

  // ── BIND-05: disconnect banner plumbing ──────────────────────────────
  // Track the most recent non-null binding we saw for this session so we
  // can detect a non-null → null transition and surface the banner.
  // Per-session/per-binding dismissal: we record the `bindingId` that was
  // dismissed. A new disconnect yields a different id and re-shows the banner.
  const previousIdeBindingRef = useRef<IdeBinding | null>(null);
  const [disconnectedBindingId, setDisconnectedBindingId] = useState<
    string | null
  >(null);
  const [dismissedForBinding, setDismissedForBinding] = useState<string | null>(
    null
  );

  // Detect transitions. Non-null → null surfaces the banner (unless the user
  // has already dismissed *this exact* disconnect); a new non-null updates
  // the ref AND clears any in-flight banner state so a rebind removes the
  // "IDE disconnected" message even if the user never dismissed it.
  //
  // BIND-09 (cubic PR #652 round-3 P2): without clearing
  // `disconnectedBindingId` on the null → non-null transition, the banner
  // persists across a rebind — stale state drives `showIdeDisconnectBanner`
  // to true even though the session is bound again. Clear both that and
  // `dismissedForBinding` so the state machine resets cleanly.
  useEffect(() => {
    const prev = previousIdeBindingRef.current;
    if (ideBinding) {
      previousIdeBindingRef.current = ideBinding;
      // Rebind resets the banner state — user has a working binding again.
      setDisconnectedBindingId(null);
      setDismissedForBinding(null);
    } else if (prev) {
      const id = bindingId(prev);
      setDisconnectedBindingId(id);
      // Clear any prior dismissal so BIND-05's re-show semantics hold.
      setDismissedForBinding(null);
      previousIdeBindingRef.current = null;
    }
  }, [ideBinding]);

  // Switching sessions must reset the banner state — the ref belongs to
  // *this* session only, and we don't want stale banners leaking across tabs.
  // Issue #6: also close any open IdePicker — leaving the modal open across
  // a session switch re-targets its bind at the wrong session.
  //
  // Issue #6 refinement (codex adversarial review): use useLayoutEffect so
  // the idePickerOpen reset happens BEFORE the new session's first render
  // paint. Plain useEffect fires post-commit, which on slow rerenders can
  // briefly render the IdePicker with the NEW sessionId while idePickerOpen
  // is still true from the OLD session — creating a single-frame window
  // where a bind dispatched via Enter targets the wrong session.
  useLayoutEffect(() => {
    previousIdeBindingRef.current = null;
    setDisconnectedBindingId(null);
    setDismissedForBinding(null);
    setIdePickerOpen(false);
    // Seed the ref with the current binding (if any) so a later disconnect
    // within this session still triggers the banner.
    if (ideBinding) previousIdeBindingRef.current = ideBinding;
    // We deliberately do NOT include ideBinding in the dep list: it's handled
    // by the transition effect above. sessionId is the only driver here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const showIdeDisconnectBanner =
    disconnectedBindingId !== null &&
    disconnectedBindingId !== dismissedForBinding;
  const dismissIdeDisconnectBanner = useCallback(() => {
    setDismissedForBinding(disconnectedBindingId);
  }, [disconnectedBindingId]);

  // Clear stale error when switching sessions or when CLI reconnects
  useEffect(() => {
    setReconnectError(null);
    clearTimeout(errorTimerRef.current);
  }, [sessionId, cliConnected]);

  // Clean up error auto-clear timer on unmount
  useEffect(() => () => clearTimeout(errorTimerRef.current), []);

  const handleReconnect = useCallback(async () => {
    setReconnectError(null);
    clearTimeout(errorTimerRef.current);
    setCliReconnecting(sessionId, true);
    try {
      await api.relaunchSession(sessionId);
    } catch (err) {
      captureException(err);
      setCliReconnecting(sessionId, false);
      const msg =
        err instanceof Error ? err.message : "Reconnection failed";
      setReconnectError(msg);
      errorTimerRef.current = setTimeout(() => setReconnectError(null), 4000);
    }
  }, [sessionId, setCliReconnecting]);

  const perms = useMemo(
    () => (sessionPerms ? Array.from(sessionPerms.values()) : []),
    [sessionPerms]
  );

  const showCliBanner = connStatus === "connected" && !cliConnected;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* CLI disconnected / reconnecting / error banner */}
      {showCliBanner && (
        <div className="px-4 py-2.5 bg-gradient-to-r from-cc-warning/8 to-cc-warning/4 border-b border-cc-warning/15 flex items-center justify-center gap-3 animate-[fadeSlideIn_0.3s_ease-out]">
          {reconnectError ? (
            <>
              <span className="w-1.5 h-1.5 rounded-full bg-cc-error shrink-0" />
              <span className="text-xs text-cc-error font-medium">
                {reconnectError}
              </span>
              <button
                onClick={handleReconnect}
                className="text-xs font-medium px-3 py-1.5 rounded-lg bg-cc-error/12 hover:bg-cc-error/20 text-cc-error transition-all cursor-pointer"
              >
                Retry
              </button>
            </>
          ) : cliReconnecting ? (
            <>
              <span className="w-3 h-3 rounded-full border-2 border-cc-warning/30 border-t-cc-warning animate-spin" />
              <span className="text-xs text-cc-warning font-medium">
                Reconnecting&hellip;
              </span>
            </>
          ) : (
            <>
              <span className="w-1.5 h-1.5 rounded-full bg-cc-warning animate-[pulse-dot_1.5s_ease-in-out_infinite] shrink-0" />
              <span className="text-xs text-cc-warning font-medium">
                CLI disconnected
              </span>
              <button
                onClick={handleReconnect}
                className="text-xs font-medium px-3 py-1.5 rounded-lg bg-cc-warning/15 hover:bg-cc-warning/25 text-cc-warning transition-all cursor-pointer"
              >
                Reconnect
              </button>
            </>
          )}
        </div>
      )}

      {/* WebSocket disconnected banner */}
      {connStatus === "disconnected" && (
        <div className="px-4 py-2.5 bg-gradient-to-r from-cc-warning/8 to-cc-warning/4 border-b border-cc-warning/15 flex items-center justify-center gap-2 animate-[fadeSlideIn_0.3s_ease-out]">
          <span className="w-3 h-3 rounded-full border-2 border-cc-warning/30 border-t-cc-warning animate-spin" />
          <span className="text-xs text-cc-warning font-medium">
            Reconnecting to session...
          </span>
        </div>
      )}

      {/* Message feed + Activity tray */}
      <div className="flex-1 flex flex-col min-h-0 relative">
        <MessageFeed sessionId={sessionId} />
        <ActivityTray sessionId={sessionId} />
      </div>

      {/* AI auto-resolved notification (most recent only) */}
      {aiResolved && aiResolved.length > 0 && (
        <div className="shrink-0 border-t border-cc-border bg-cc-card">
          <AiValidationBadge
            entry={aiResolved[aiResolved.length - 1]}
            onDismiss={() => clearAiResolvedPermissions(sessionId)}
          />
        </div>
      )}

      {/* Permission banners */}
      {perms.length > 0 && (
        <div className="shrink-0 max-h-[60dvh] overflow-y-auto border-t border-cc-border bg-cc-card">
          {perms.map((p) => (
            <PermissionBanner key={p.request_id} permission={p} sessionId={sessionId} />
          ))}
        </div>
      )}

      {/* BIND-05: IDE disconnected banner (non-null → null transition) */}
      {showIdeDisconnectBanner && (
        <IdeDisconnectBanner onDismiss={dismissIdeDisconnectBanner} />
      )}

      {/* Composer */}
      <Composer sessionId={sessionId} onOpenIdePicker={openIdePicker} />

      {/* UI-03: IdePicker modal — parent-owned visibility */}
      {idePickerOpen && (
        <IdePicker
          sessionId={sessionId}
          cwd={sessionCwd}
          currentBinding={ideBinding}
          onClose={closeIdePicker}
        />
      )}
    </div>
  );
}
