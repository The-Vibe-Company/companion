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

type DerivedStatus = "awaiting" | "running" | "idle" | "exited";

function deriveStatus(s: SessionItemType): DerivedStatus {
  if (s.permCount > 0) return "awaiting";
  if ((s.status === "running" || s.status === "compacting") && s.isConnected) return "running";
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
    case "idle":
      return <span className="w-2 h-2 rounded-full bg-cc-muted/40 shrink-0" />;
    case "exited":
      return <span className="w-2 h-2 rounded-full border border-cc-muted/25 shrink-0" />;
  }
}

function BackendBadge({ type }: { type: "claude" | "codex" | "copilot" }) {
  if (type === "codex") {
    return (
      <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-500 leading-none">
        CX
      </span>
    );
  }
  if (type === "copilot") {
    return (
      <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-[#6e40c9]/15 text-[#6e40c9] leading-none">
        CP
      </span>
    );
  }
  return (
    <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-[#5BA8A0]/15 text-[#5BA8A0] leading-none">
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

  const derivedStatus = archived ? ("exited" as DerivedStatus) : deriveStatus(s);

  // Show the full cwd path below the session name
  const cwdTail = s.cwd || "";

  // Close menu on click outside or Escape
  useEffect(() => {
    if (!menuOpen) return;
    function handleClickOutside(e: MouseEvent | TouchEvent) {
      if (
        menuRef.current && !menuRef.current.contains(e.target as Node) &&
        menuBtnRef.current && !menuBtnRef.current.contains(e.target as Node)
      ) {
        setMenuOpen(false);
      }
    }
    function handleEscape(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("touchstart", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("touchstart", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
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
        className={`w-full flex items-center gap-1.5 py-2 pl-1 pr-12 min-h-[44px] rounded-lg transition-colors duration-100 cursor-pointer ${
          isActive
            ? "bg-cc-active"
            : "hover:bg-cc-hover"
        }`}
      >
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
            className="text-[13px] font-medium flex-1 min-w-0 text-cc-fg bg-transparent border border-cc-border rounded px-1.5 py-0.5 outline-none focus:border-cc-primary/50 focus:ring-1 focus:ring-cc-primary/20"
          />
        ) : (
          <div className="flex-1 min-w-0">
            <span
              className={`text-[13px] font-medium truncate text-cc-fg leading-snug block ${
                isRecentlyRenamed ? "animate-name-appear" : ""
              }`}
              onAnimationEnd={() => onClearRecentlyRenamed(s.id)}
            >
              {label}
            </span>
            {cwdTail && (
              <span className="text-[10px] text-cc-muted truncate block leading-tight">
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
              <span className="flex items-center px-1 py-0.5 rounded bg-violet-400/10" title="Scheduled">
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-2.5 h-2.5 text-violet-400">
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
          className="absolute right-0 top-full mt-1 w-36 py-1 bg-cc-card border border-cc-border rounded-lg shadow-lg z-10 animate-[menu-appear_150ms_ease-out]"
        >
          {!archived && (
            <button
              onClick={() => handleMenuAction(() => onStartRename(s.id, label))}
              className="w-full px-3 py-1.5 text-[12px] text-left text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
            >
              Rename
            </button>
          )}
          {archived ? (
            <>
              <button
                onClick={(e) => handleMenuAction(() => onUnarchive(e, s.id))}
                className="w-full px-3 py-1.5 text-[12px] text-left text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
              >
                Restore
              </button>
              <button
                onClick={(e) => handleMenuAction(() => onDelete(e, s.id))}
                className="w-full px-3 py-1.5 text-[12px] text-left text-red-400 hover:bg-cc-hover transition-colors cursor-pointer"
              >
                Delete
              </button>
            </>
          ) : (
            <button
              onClick={(e) => handleMenuAction(() => onArchive(e, s.id))}
              className="w-full px-3 py-1.5 text-[12px] text-left text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
            >
              Archive
            </button>
          )}
        </div>
      )}
    </div>
  );
}
