import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  getAvailableIdes,
  bindIde,
  unbindIde,
  api,
  type AvailableIde,
} from "../api.js";
import type { IdeBinding } from "../types.js";

/**
 * IdePicker — modal list picker for Claude Code IDE integration (Task 10, UI-02/UI-03).
 *
 * Contract:
 *   - Fetches `GET /api/ide/available?cwd=...` on open; the server returns
 *     candidates ordered best-match first for the supplied cwd.
 *   - Pressing Enter (or clicking an option) POSTs `/api/sessions/:id/ide`
 *     via `bindIde`. On success → `onClose()`. On {ok:false} → inline error
 *     + Retry (no close, no toast).
 *   - `D` disconnects when `currentBinding` is non-null via `unbindIde`.
 *   - Escape and the × close button are pure dismissals — they never touch
 *     the API.
 *
 * State discipline:
 *   - IdePicker DOES NOT mutate the Zustand store. `session_update`
 *     broadcasts from the server are the single source of truth for
 *     `ideBinding`. Keeping the picker store-free avoids split-brain
 *     when concurrent binds race.
 *
 * Accessibility:
 *   - role="dialog" + aria-modal="true" + aria-labelledby → title.
 *   - List uses role="listbox"; items role="option" with aria-selected.
 *   - Focus is trapped inside the panel on open; the panel receives
 *     autofocus so keyboard shortcuts are immediately active.
 */

interface IdePickerProps {
  sessionId: string;
  /** Optional — used to rank the list (server-side longest-prefix match). */
  cwd?: string;
  /** If non-null, the picker renders the "currently bound" banner + Disconnect. */
  currentBinding?: IdeBinding | null;
  onClose: () => void;
}

/** Abbreviate an absolute path to `~/…` when it lives under `home`. */
function shortenPath(abs: string, home: string | null): string {
  if (!abs) return "";
  if (home && (abs === home || abs.startsWith(home + "/"))) {
    return "~" + abs.slice(home.length);
  }
  return abs;
}

function firstWorkspace(ide: { workspaceFolders: string[] }): string {
  return ide.workspaceFolders[0] ?? "";
}

export function IdePicker({
  sessionId,
  cwd,
  currentBinding = null,
  onClose,
}: IdePickerProps) {
  const [ides, setIdes] = useState<AvailableIde[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [home, setHome] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [bindError, setBindError] = useState<string | null>(null);
  const [lastPickedPort, setLastPickedPort] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  // Issue #8 refinement (codex adversarial review): `busy` in useState is a
  // stale closure across same-tick dispatches (Enter+D before rerender).
  // A ref flipped BEFORE the async await is the only guard that prevents a
  // second concurrent op from slipping past the React render cycle.
  const busyRef = useRef(false);
  // Issue #9: bind and disconnect both surface via the same "Retry" affordance.
  // Without tracking which op failed, Retry would always retry bind — the
  // opposite of what the user asked for when a disconnect fails. Track the
  // last failed operation so Retry dispatches to the correct handler.
  const [lastFailedOp, setLastFailedOp] = useState<"bind" | "disconnect" | null>(
    null,
  );

  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useRef(
    `ide-picker-title-${Math.random().toString(36).slice(2, 9)}`,
  );

  // ── Fetch IDE list on mount ────────────────────────────────────────────
  //
  // cubic-ai review (PR #652): concurrent loadList calls can resolve out of
  // order. When `companion:ide-list-changed` fires rapidly, two requests
  // are in flight and a slow FIRST call can land AFTER a fast SECOND call,
  // clobbering the newer state. An epoch counter drops stale responses:
  // each call increments the ref and captures its token; the resolver
  // only commits state when the token still matches the latest.
  const loadEpochRef = useRef(0);
  // Codex adversarial review (BRITTLE 1): the epoch ref prevents post-unmount
  // setState, but the underlying HTTP request keeps running. An AbortController
  // per call lets us (a) cancel superseded in-flight requests when a newer
  // loadList() starts and (b) cancel the mount-time request on unmount. The
  // epoch guard remains as a second layer for requests that resolve between
  // `fetch()` returning and our `.catch(AbortError)` branch executing.
  const loadControllerRef = useRef<AbortController | null>(null);
  const loadList = useCallback(async () => {
    const token = ++loadEpochRef.current;
    // Abort any prior in-flight request before issuing a new one.
    loadControllerRef.current?.abort();
    const controller = new AbortController();
    loadControllerRef.current = controller;
    setLoading(true);
    setLoadError(null);
    try {
      const list = await getAvailableIdes(cwd, controller.signal);
      if (loadEpochRef.current !== token) return; // stale — newer load in flight or done
      setIdes(list);
      setSelectedIndex(list.length > 0 ? 0 : -1);
    } catch (e) {
      if (loadEpochRef.current !== token) return;
      // AbortError is expected (supersede or unmount) — never surface it.
      const isAbort =
        (e instanceof DOMException && e.name === "AbortError") ||
        (e instanceof Error && e.name === "AbortError");
      if (isAbort) return;
      setLoadError(e instanceof Error ? e.message : "Failed to load IDEs");
      setIdes([]);
    } finally {
      if (loadEpochRef.current === token) setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    loadList();
    // Codex adversarial review (BRITTLE 2): bump the epoch on unmount so any
    // in-flight `loadList` resolution that lands AFTER unmount sees a stale
    // token and early-returns before calling setIdes / setLoading / setLoadError.
    // Without this, React warns "setState on unmounted component" whenever the
    // picker closes while a fetch is pending. The loadEpochRef comparison
    // inside loadList already handles stale races — we just invalidate all
    // tokens on teardown.
    // BRITTLE 1: also abort the in-flight controller so the HTTP request
    // itself is cancelled (not just its setState branch suppressed).
    return () => {
      loadEpochRef.current++;
      loadControllerRef.current?.abort();
    };
  }, [loadList]);

  // ── Live refresh on ide_list_changed (Task 12, DISC-03 UX side) ─────────
  //
  // ws.ts dispatches a window-level CustomEvent("companion:ide-list-changed")
  // whenever the server broadcasts `{type: "ide_list_changed"}` — which fires
  // on ide:added / ide:removed / ide:changed. Refetching through the same
  // `loadList` the mount effect uses keeps server ordering intact and avoids
  // introducing a second code path. No debouncing: discovery is already
  // rate-limited by fs.watch, and the authenticated REST endpoint is cheap.
  useEffect(() => {
    const handler = () => {
      void loadList();
    };
    window.addEventListener("companion:ide-list-changed", handler);
    return () => {
      window.removeEventListener("companion:ide-list-changed", handler);
    };
  }, [loadList]);

  // Fetch home once — best-effort; used only for display formatting.
  useEffect(() => {
    let cancelled = false;
    api
      .getHome()
      .then((res) => {
        if (!cancelled) setHome(res.home);
      })
      .catch(() => {
        /* fall back to absolute paths */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Focus trap on open ─────────────────────────────────────────────────
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    // Autofocus the panel so keyboard shortcuts register.
    const timer = setTimeout(() => {
      panel.focus();
    }, 0);

    function handleTab(e: KeyboardEvent) {
      if (e.key !== "Tab") return;
      const focusable = panel!.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleTab);
    return () => {
      document.removeEventListener("keydown", handleTab);
      clearTimeout(timer);
      // Return focus to the opener on close.
      previouslyFocused?.focus?.();
    };
  }, []);

  // ── Pick handler (shared between Enter and click) ──────────────────────
  const pick = useCallback(
    async (port: number) => {
      // Ref-first guard (Issue #8): set BEFORE any await so same-tick
      // concurrent dispatches see the flipped ref and early-return.
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setBindError(null);
      setLastPickedPort(port);
      try {
        const res = await bindIde(sessionId, port);
        if (res.ok) {
          onClose();
        } else {
          setBindError(res.error || "Bind failed");
          setLastFailedOp("bind");
        }
      } catch (e) {
        setBindError(e instanceof Error ? e.message : "Bind failed");
        setLastFailedOp("bind");
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [sessionId, onClose],
  );

  const disconnect = useCallback(async () => {
    // Issue #4 (cubic-ai PR #652): When a disconnect fails and the IDE
    // asynchronously disconnects (currentBinding -> null via session_update),
    // clicking Retry calls disconnect() which would early-return here because
    // currentBinding is now null. Allow the call through when we are retrying
    // a previous disconnect failure (lastFailedOp === "disconnect").
    if (!currentBinding && lastFailedOp !== "disconnect") return;
    // Same ref-first guard as pick() — prevents a same-tick Enter+D from
    // shipping both bind AND disconnect concurrently.
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setBindError(null);
    try {
      await unbindIde(sessionId);
      onClose();
    } catch (e) {
      // Surface as an inline error + Retry (same UX as bind failure).
      setBindError(e instanceof Error ? e.message : "Disconnect failed");
      setLastFailedOp("disconnect");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [currentBinding, lastFailedOp, sessionId, onClose]);

  // ── Global keyboard: arrows / enter / escape / D ───────────────────────
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Allow typing in any text input inside the dialog to keep normal
      // keystroke behavior (none today, but defensive).
      const target = e.target as HTMLElement | null;
      const isTextInput =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          (target as HTMLElement).isContentEditable);

      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }

      if (isTextInput) return;

      // Issue #7 (widened per codex adversarial review): ANY interactive
      // element inside the dialog panel (not just <button>) should receive
      // its native activation on Enter/Space. Previously the guard matched
      // only HTMLButtonElement, so an <a>/<input>/[role=button] inside the
      // panel would both fire its own activation AND dispatch the global
      // pick/disconnect handler (split-brain).
      //
      // We now check whether the event TARGET (not just activeElement) is
      // contained by the dialog panel. If it is AND the target is
      // interactive (button/link/input/select/[role=button]), we defer to
      // native behavior and early-return from our global handler.
      // The focus trap + aria-modal guarantee that targets are practically
      // always inside the panel while the dialog is open; the check is
      // defensive against portal-mounted dialogs where that invariant can
      // break under Tab/shift-Tab across boundaries.
      const targetInsideDialog =
        !!target && !!panelRef.current && panelRef.current.contains(target);
      const interactiveFocusedInDialog =
        targetInsideDialog &&
        (target instanceof HTMLButtonElement ||
          target instanceof HTMLAnchorElement ||
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          target instanceof HTMLSelectElement ||
          (target instanceof HTMLElement &&
            target.getAttribute("role") === "button"));

      if (e.key === "ArrowDown") {
        if (ides.length === 0) return;
        e.preventDefault();
        setSelectedIndex((i) => (i + 1) % ides.length);
      } else if (e.key === "ArrowUp") {
        if (ides.length === 0) return;
        e.preventDefault();
        setSelectedIndex((i) => (i <= 0 ? ides.length - 1 : i - 1));
      } else if (e.key === "Enter") {
        if (interactiveFocusedInDialog) return; // Issue #7
        if (busy) return; // Issue #8: guard against Enter-spam during in-flight bind.
        if (ides.length === 0 || selectedIndex < 0) return;
        e.preventDefault();
        const entry = ides[selectedIndex];
        if (entry) void pick(entry.port);
      } else if (e.key === "d" || e.key === "D") {
        if (!currentBinding) return;
        if (interactiveFocusedInDialog) return; // Issue #7 (same reasoning as Enter)
        if (busy) return; // Issue #8 — keyboard path must honor busy too.
        e.preventDefault();
        void disconnect();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [ides, selectedIndex, currentBinding, pick, disconnect, onClose, busy]);

  // ── Retry the last failed operation (bind OR disconnect) ───────────────
  // Issue #9: when disconnect fails, Retry must re-attempt disconnect — not
  // silently switch to bind. Dispatch based on which op failed.
  const retry = useCallback(() => {
    if (lastFailedOp === "disconnect") {
      void disconnect();
      return;
    }
    if (lastPickedPort == null) return;
    void pick(lastPickedPort);
  }, [lastFailedOp, lastPickedPort, pick, disconnect]);

  const items = useMemo(
    () =>
      ides.map((ide) => ({
        ide,
        shortPath: shortenPath(firstWorkspace(ide), home),
      })),
    [ides, home],
  );

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center"
      style={{ backgroundColor: "rgba(0,0,0,0.5)", backdropFilter: "blur(4px)" }}
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId.current}
        tabIndex={-1}
        className="w-full max-w-lg h-[min(520px,90dvh)] mx-0 sm:mx-4 flex flex-col bg-cc-bg border border-cc-border rounded-t-[14px] sm:rounded-[14px] shadow-2xl overflow-hidden focus:outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ─── Header ───────────────────────────────────────────────── */}
        <div className="flex items-center justify-between px-4 sm:px-5 py-3 sm:py-4 border-b border-cc-border shrink-0">
          <h2
            id={titleId.current}
            className="text-sm font-semibold text-cc-fg font-sans-ui"
          >
            Select IDE
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="w-6 h-6 flex items-center justify-center rounded-md text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
          >
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="w-3.5 h-3.5"
              aria-hidden="true"
            >
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* ─── Currently-bound banner ───────────────────────────────── */}
        {currentBinding && (
          <div
            className="px-4 py-2 border-b border-cc-border shrink-0 flex items-center gap-2 bg-cc-hover/40"
            role="group"
            aria-label="Current IDE binding"
          >
            <span className="text-xs text-cc-fg font-medium">
              {currentBinding.ideName}
            </span>
            <span className="text-[11px] text-cc-muted font-mono-code truncate">
              {shortenPath(firstWorkspace(currentBinding), home)}
            </span>
            <button
              type="button"
              onClick={disconnect}
              disabled={busy}
              aria-label={`Disconnect ${currentBinding.ideName}`}
              className="ml-auto shrink-0 px-2 py-1 text-[11px] rounded-md text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer disabled:opacity-50"
            >
              Disconnect
            </button>
          </div>
        )}

        {/* ─── Inline bind error ────────────────────────────────────── */}
        {bindError && (
          <div
            className="px-4 py-2 border-b border-cc-border shrink-0 flex items-center gap-2 bg-cc-error/10"
            role="alert"
          >
            <span className="text-xs text-cc-error flex-1">{bindError}</span>
            <button
              type="button"
              onClick={retry}
              disabled={busy}
              className="shrink-0 px-2 py-1 text-[11px] font-medium rounded-md bg-cc-primary text-white hover:bg-cc-primary-hover transition-colors cursor-pointer disabled:opacity-50"
            >
              Retry
            </button>
          </div>
        )}

        {/* ─── List ─────────────────────────────────────────────────── */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {loading ? (
            <div
              className="px-4 py-8 text-center text-xs text-cc-muted"
              aria-busy="true"
              aria-label="Loading IDEs"
            >
              Loading…
            </div>
          ) : loadError ? (
            <div className="px-4 py-8 flex flex-col items-center gap-2 text-center">
              <p className="text-xs text-cc-muted">{loadError}</p>
              <button
                type="button"
                onClick={loadList}
                className="mt-1 text-xs text-cc-primary hover:text-cc-primary-hover transition-colors cursor-pointer font-medium"
              >
                Retry
              </button>
            </div>
          ) : items.length === 0 ? (
            <div className="px-4 py-8 text-center">
              <p className="text-xs text-cc-muted">
                No IDE detected. Start one and try again.
              </p>
              {/*
                cubic P2: the previous "How to connect an IDE" anchor was a
                dead interactive control — focusable and clickable but did
                nothing (href="#" + preventDefault). Until we have a real
                docs URL to link, render plain helper text so keyboard users
                don't land on a button that does nothing.
              */}
              <p className="mt-2 text-[11px] text-cc-muted">
                Open Claude Code or Codex in your IDE to make it discoverable.
              </p>
            </div>
          ) : (
            <ul role="listbox" aria-label="Available IDEs" className="list-none m-0 p-0">
              {items.map(({ ide, shortPath }, i) => {
                const selected = i === selectedIndex;
                const isBestMatch = i === 0 && !!cwd;
                return (
                  <li
                    key={`${ide.port}-${ide.lockfilePath}`}
                    role="option"
                    aria-selected={selected}
                    onClick={() => {
                      setSelectedIndex(i);
                      void pick(ide.port);
                    }}
                    className={`flex items-center gap-2 px-4 py-2 cursor-pointer transition-colors ${
                      selected ? "bg-cc-hover" : "hover:bg-cc-hover/60"
                    }`}
                  >
                    <span className="text-xs font-medium text-cc-fg truncate">
                      {ide.ideName}
                    </span>
                    <span
                      className="text-[11px] text-cc-muted font-mono-code truncate"
                      aria-hidden="true"
                    >
                      · {shortPath}
                    </span>
                    {isBestMatch && (
                      <span className="ml-auto shrink-0 text-[10px] text-cc-primary font-medium uppercase tracking-wider">
                        matches cwd
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* ─── Keyboard hint bar ────────────────────────────────────── */}
        <div className="px-4 py-1.5 border-t border-cc-border shrink-0 flex items-center gap-3 text-[10px] text-cc-muted select-none">
          <span>
            <kbd className="px-1 py-0.5 rounded bg-cc-hover text-cc-muted font-mono-code text-[9px]">
              &uarr;&darr;
            </kbd>{" "}
            navigate
          </span>
          <span>
            <kbd className="px-1 py-0.5 rounded bg-cc-hover text-cc-muted font-mono-code text-[9px]">
              &crarr;
            </kbd>{" "}
            select
          </span>
          {currentBinding && (
            <span>
              <kbd className="px-1 py-0.5 rounded bg-cc-hover text-cc-muted font-mono-code text-[9px]">
                D
              </kbd>{" "}
              disconnect
            </span>
          )}
          <span className="ml-auto">
            <kbd className="px-1 py-0.5 rounded bg-cc-hover text-cc-muted font-mono-code text-[9px]">
              esc
            </kbd>{" "}
            close
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
