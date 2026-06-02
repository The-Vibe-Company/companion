import { useState, useEffect, useCallback, useRef, type RefObject } from "react";
import type { SessionItem as SessionItemType } from "../utils/project-grouping.js";

interface SessionItemProps {
  session: SessionItemType;
  isActive: boolean;
  isArchived?: boolean;
  sessionName: string | undefined;
  permCount: number;
  isRecentlyRenamed: boolean;
  onSelect: (id: string) => void;
  onStartRename: (id: string, currentName: string) => void;
  onArchive: (e: React.MouseEvent, id: string) => void;
  onUnarchive: (e: React.MouseEvent, id: string) => void;
  onDelete: (e: React.MouseEvent, id: string) => void;
  onClearRecentlyRenamed: (id: string) => void;
  editingSessionId: string | null;
  editingName: string;
  setEditingName: (name: string) => void;
  onConfirmRename: () => void;
  onCancelRename: () => void;
  editInputRef: RefObject<HTMLInputElement | null>;
}

type DerivedStatus = "awaiting" | "running" | "reconnecting" | "idle" | "exited";

function deriveStatus(s: SessionItemType, permCount: number): DerivedStatus {
  if (permCount > 0) return "awaiting";
  if ((s.status === "running" || s.status === "compacting") && s.isConnected) return "running";
  if (s.isReconnecting) return "reconnecting";
  if (s.isConnected) return "idle";
  return "exited";
}

function StatusDot({ status }: { status: DerivedStatus }) {
  switch (status) {
    case "running":
      return (
        <span className="relative shrink-0 w-2 h-2">
          <span className="absolute inset-0 rounded-full bg-cc-success animate-[pulse-dot_1.5s_ease-in-out_infinite]" />
          <span className="w-2 h-2 rounded-full bg-cc-success block" />
        </span>
      );
    case "awaiting":
      return (
        <span className="relative shrink-0 w-2 h-2">
          <span className="w-2 h-2 rounded-full bg-cc-warning block animate-[ring-pulse_1.5s_ease-out_infinite]" />
        </span>
      );
    case "reconnecting":
      return (
        <span className="relative shrink-0 w-2 h-2">
          <span className="w-2 h-2 rounded-full border border-cc-warning/40 border-t-cc-warning block animate-spin" />
        </span>
      );
    case "idle":
      return <span className="w-2 h-2 rounded-full bg-cc-muted/40 shrink-0" />;
    case "exited":
      return <span className="w-2 h-2 rounded-full border border-cc-muted/25 shrink-0" />;
  }
}

function BackendBadge({ type }: { type: "claude" | "codex" }) {
  if (type === "codex") {
    return (
      <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-500 leading-none">
        CX
      </span>
    );
  }
  return (
    <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-cc-success/15 text-cc-success leading-none">
      CC
    </span>
  );
}

export function SessionItem({
  session: s,
  isActive,
  isArchived: archived,
  sessionName,
  permCount,
  isRecentlyRenamed,
  onSelect,
  onStartRename,
  onArchive,
  onUnarchive,
  onDelete,
  onClearRecentlyRenamed,
  editingSessionId,
  editingName,
  setEditingName,
  onConfirmRename,
  onCancelRename,
  editInputRef,
}: SessionItemProps) {
  const shortId = s.id.slice(0, 8);
  const label = sessionName || s.model || shortId;
  const isEditing = editingSessionId === s.id;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);

  const derivedStatus = archived ? ("exited" as DerivedStatus) : deriveStatus(s, permCount);

  // Show the full cwd path below the session name
  const cwdTail = s.cwd || "";

  // Close menu on click outside or Escape; arrow-key navigation between menu items
  useEffect(() => {
    if (!menuOpen) return;
    function handleClickOutside(e: MouseEvent | TouchEvent) {
      if (
        menuRef.current && !menuRef.current.contains(e.target as Node) &&
        menuBtnRef.current && !menuBtnRef.current.contains(e.target as Node)
      ) {
        setMenuOpen(false);
        menuBtnRef.current?.focus();
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setMenuOpen(false);
        menuBtnRef.current?.focus();
        return;
      }
      if (e.key === "Tab") {
        setMenuOpen(false);
        // Let native Tab move focus to the next element in sequence
        return;
      }
      // Arrow key navigation within menu — only when focus is inside menu
      if (
        (e.key === "ArrowDown" || e.key === "ArrowUp") &&
        (menuRef.current?.contains(document.activeElement) || menuBtnRef.current === document.activeElement)
      ) {
        e.preventDefault();
        const items = menuRef.current?.querySelectorAll<HTMLElement>("[role='menuitem']");
        if (!items || items.length === 0) return;
        const focused = document.activeElement as HTMLElement;
        const idx = Array.from(items).indexOf(focused);
        if (e.key === "ArrowDown") {
          items[idx < items.length - 1 ? idx + 1 : 0].focus();
        } else {
          items[idx > 0 ? idx - 1 : items.length - 1].focus();
        }
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("touchstart", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("touchstart", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen]);

  // Focus the first menu item when the menu opens
  useEffect(() => {
    if (menuOpen) {
      requestAnimationFrame(() => {
        menuRef.current?.querySelector<HTMLElement>("[role='menuitem']")?.focus();
      });
    }
  }, [menuOpen]);

  const handleMenuAction = useCallback((action: () => void) => {
    setMenuOpen(false);
    action();
  }, []);

  return (
    <div className="relative group">
      <button
        onClick={() => onSelect(s.id)}
        onDoubleClick={(e) => {
          e.preventDefault();
          onStartRename(s.id, label);
        }}
        onKeyDown={(e) => {
          if (e.key === "F2" && !isEditing) {
            e.preventDefault();
            onStartRename(s.id, label);
          }
        }}
        className={`w-full flex items-center gap-2 py-2 pl-2.5 pr-12 min-h-[44px] rounded-lg transition-all duration-100 cursor-pointer relative ${
          isActive
            ? "bg-cc-active"
            : "hover:bg-cc-hover"
        }`}
      >
        {/* Left accent edge for active state */}
        <span
          aria-hidden
          className={`absolute left-0 top-1/2 -translate-y-1/2 w-[3px] rounded-full transition-all duration-150 ${
            isActive ? "h-5 bg-cc-primary" : "h-0 bg-transparent"
          }`}
        />

        {/* Status dot */}
        {!isEditing && (
          <StatusDot status={derivedStatus} />
        )}

        {/* Session name / edit input */}
        {isEditing ? (
          <input
            ref={editInputRef}
            value={editingName}
            onChange={(e) => setEditingName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onConfirmRename();
              } else if (e.key === "Escape") {
                e.preventDefault();
                onCancelRename();
              }
              e.stopPropagation();
            }}
            onBlur={onConfirmRename}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            className="text-[12.5px] font-medium flex-1 min-w-0 text-cc-fg bg-transparent border border-cc-border rounded-md px-2 py-1 outline-none focus:border-cc-primary/50 focus:ring-1 focus:ring-cc-primary/20"
          />
        ) : (
          <div className="flex-1 min-w-0">
            <span
              className={`text-[12.5px] font-medium truncate block leading-snug ${
                isActive ? "text-cc-fg" : "text-cc-fg/90"
              } ${isRecentlyRenamed ? "animate-name-appear" : ""}`}
              onAnimationEnd={() => onClearRecentlyRenamed(s.id)}
            >
              {label}
            </span>
            {cwdTail && (
              <span className="text-[10px] text-cc-muted/70 truncate block leading-tight mt-px">
                {cwdTail}
              </span>
            )}
          </div>
        )}

        {/* Badges: backend type + Docker + Cron */}
        {!isEditing && (
          <span className="flex items-center gap-1 shrink-0">
            <BackendBadge type={s.backendType} />
            {s.isContainerized && (
              <span className="flex items-center px-1 py-0.5 rounded bg-blue-400/10" title="Docker">
                <img src="/logo-docker.svg" alt="Docker logo" className="w-3 h-3" />
              </span>
            )}
            {s.cronJobId && (
              <span className="flex items-center px-1 py-0.5 rounded bg-cc-primary/10" title="Scheduled">
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-2.5 h-2.5 text-cc-primary">
                  <path d="M8 2a6 6 0 100 12A6 6 0 008 2zM0 8a8 8 0 1116 0A8 8 0 010 8zm9-3a1 1 0 10-2 0v3a1 1 0 00.293.707l2 2a1 1 0 001.414-1.414L9 7.586V5z" />
                </svg>
              </span>
            )}
          </span>
        )}
      </button>

      {/* Archive button — hover reveal (desktop), always visible (mobile) */}
      {!archived && !isEditing && !menuOpen && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onArchive(e, s.id);
          }}
          className="absolute right-7 top-1/2 -translate-y-1/2 p-1 rounded-md opacity-0 pointer-events-none sm:group-hover:opacity-100 sm:group-hover:pointer-events-auto hover:bg-cc-border text-cc-muted hover:text-cc-fg transition-all cursor-pointer"
          title="Archive"
          aria-label="Archive session"
        >
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
            <path d="M2 4a1 1 0 011-1h10a1 1 0 011 1v1H2V4zm1 2h10v6a1 1 0 01-1 1H4a1 1 0 01-1-1V6zm3 2a.5.5 0 000 1h4a.5.5 0 000-1H6z" />
          </svg>
        </button>
      )}

      {/* Three-dot menu button */}
      <button
        ref={menuBtnRef}
        onClick={(e) => {
          e.stopPropagation();
          setMenuOpen(!menuOpen);
        }}
        className="absolute right-1 top-1/2 -translate-y-1/2 p-1 rounded-md opacity-100 pointer-events-auto sm:opacity-0 sm:pointer-events-none sm:group-hover:opacity-100 sm:group-hover:pointer-events-auto hover:bg-cc-border text-cc-muted hover:text-cc-fg transition-all cursor-pointer"
        title="Session actions"
        aria-label="Session actions"
        aria-haspopup="true"
        aria-expanded={menuOpen}
      >
        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
          <circle cx="8" cy="3" r="1.5" />
          <circle cx="8" cy="8" r="1.5" />
          <circle cx="8" cy="13" r="1.5" />
        </svg>
      </button>

      {/* Context menu */}
      {menuOpen && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Session actions"
          className="absolute right-0 top-full mt-1 w-40 py-1 bg-cc-card border border-cc-border/80 rounded-lg shadow-xl z-10 animate-[menu-appear_150ms_ease-out]"
        >
          {!archived && (
            <button
              role="menuitem"
              tabIndex={-1}
              onClick={() => handleMenuAction(() => onStartRename(s.id, label))}
              className="w-full px-3 py-1.5 text-[12px] text-left text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer flex items-center gap-2"
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 text-cc-muted">
                <path d="M12.146.854a.5.5 0 00-.707 0L3.714 8.579a.5.5 0 00-.138.242l-.777 3.11a.5.5 0 00.607.607l3.11-.777a.5.5 0 00.242-.138L14.573 3.854a.5.5 0 000-.708L12.146.854z" />
              </svg>
              Rename
            </button>
          )}
          {archived ? (
            <>
              <button
                role="menuitem"
                tabIndex={-1}
                onClick={(e) => handleMenuAction(() => onUnarchive(e, s.id))}
                className="w-full px-3 py-1.5 text-[12px] text-left text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer flex items-center gap-2"
              >
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 text-cc-muted">
                  <path d="M8 4a.5.5 0 01.5.5v3.793l1.854-1.853a.5.5 0 01.707.707l-2.828 2.828a.5.5 0 01-.707 0L4.697 7.147a.5.5 0 01.707-.707L7.5 8.293V4.5A.5.5 0 018 4z" />
                  <path d="M2 12.5A1.5 1.5 0 003.5 14h9a1.5 1.5 0 001.5-1.5v-2a.5.5 0 00-1 0v2a.5.5 0 01-.5.5h-9a.5.5 0 01-.5-.5v-2a.5.5 0 00-1 0v2z" />
                </svg>
                Restore
              </button>
              <div className="my-1 mx-2 border-t border-cc-border/50" />
              <button
                role="menuitem"
                tabIndex={-1}
                onClick={(e) => handleMenuAction(() => onDelete(e, s.id))}
                className="w-full px-3 py-1.5 text-[12px] text-left text-cc-error hover:bg-cc-error/5 transition-colors cursor-pointer flex items-center gap-2"
              >
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                  <path d="M5.5 5.5A.5.5 0 016 6v6a.5.5 0 01-1 0V6a.5.5 0 01.5-.5zm2.5 0a.5.5 0 01.5.5v6a.5.5 0 01-1 0V6a.5.5 0 01.5-.5zm3 .5a.5.5 0 00-1 0v6a.5.5 0 001 0V6z" />
                  <path fillRule="evenodd" d="M14.5 3a1 1 0 01-1 1H13v9a2 2 0 01-2 2H5a2 2 0 01-2-2V4h-.5a1 1 0 010-2H6a1 1 0 011-1h2a1 1 0 011 1h3.5a1 1 0 011 1zM4.118 4L4 4.059V13a1 1 0 001 1h6a1 1 0 001-1V4.059L11.882 4H4.118zM6 2h4v1H6V2z" clipRule="evenodd" />
                </svg>
                Delete
              </button>
            </>
          ) : (
            <button
              role="menuitem"
              tabIndex={-1}
              onClick={(e) => handleMenuAction(() => onArchive(e, s.id))}
              className="w-full px-3 py-1.5 text-[12px] text-left text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer flex items-center gap-2"
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 text-cc-muted">
                <path d="M2 4a1 1 0 011-1h10a1 1 0 011 1v1H2V4zm1 2h10v6a1 1 0 01-1 1H4a1 1 0 01-1-1V6zm3 2a.5.5 0 000 1h4a.5.5 0 000-1H6z" />
              </svg>
              Archive
            </button>
          )}
        </div>
      )}
    </div>
  );
}
