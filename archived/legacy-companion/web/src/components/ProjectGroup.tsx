import type { RefObject } from "react";
import type { ProjectGroup as ProjectGroupType } from "../utils/project-grouping.js";
import { SessionItem } from "./SessionItem.js";

interface ProjectGroupProps {
  group: ProjectGroupType;
  isCollapsed: boolean;
  onToggleCollapse: (projectKey: string) => void;
  currentSessionId: string | null;
  sessionNames: Map<string, string>;
  pendingPermissions: Map<string, Map<string, unknown>>;
  recentlyRenamed: Set<string>;
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
  isFirst: boolean;
}

export function ProjectGroup({
  group,
  isCollapsed,
  onToggleCollapse,
  currentSessionId,
  sessionNames,
  pendingPermissions,
  recentlyRenamed,
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
  isFirst,
}: ProjectGroupProps) {
  // Build collapsed preview: first 2 session names
  const collapsedPreview = isCollapsed
    ? group.sessions
        .slice(0, 2)
        .map((s) => sessionNames.get(s.id) || s.model || s.id.slice(0, 8))
        .join(", ") + (group.sessions.length > 2 ? ", ..." : "")
    : "";

  return (
    <div className={!isFirst ? "mt-3 pt-3 border-t border-cc-separator" : ""}>
      {/* Group header */}
      <button
        onClick={() => onToggleCollapse(group.key)}
        aria-expanded={!isCollapsed}
        className="w-full px-2 py-1 flex items-center gap-1.5 hover:bg-cc-hover rounded-md transition-colors cursor-pointer group/header"
      >
        <svg
          viewBox="0 0 16 16"
          fill="currentColor"
          className={`w-2 h-2 text-cc-muted/50 transition-transform duration-150 ${isCollapsed ? "" : "rotate-90"}`}
        >
          <path d="M6 4l4 4-4 4" />
        </svg>
        <span className="text-[11px] font-semibold text-cc-fg/60 truncate uppercase tracking-wide">
          {group.label}
        </span>

        {/* Status dots */}
        <span className="flex items-center gap-1 ml-auto shrink-0">
          {group.runningCount > 0 && (
            <span className="w-1 h-1 rounded-full bg-cc-success" title={`${group.runningCount} running`} />
          )}
          {group.permCount > 0 && (
            <span className="w-1 h-1 rounded-full bg-cc-warning" title={`${group.permCount} waiting`} />
          )}
        </span>

        {/* Count badge */}
        <span className="text-[10px] text-cc-muted/50 tabular-nums shrink-0">
          {group.sessions.length}
        </span>
      </button>

      {/* Collapsed preview */}
      {isCollapsed && collapsedPreview && (
        <div className="text-[10px] text-cc-muted/70 truncate pl-5 pb-0.5">
          {collapsedPreview}
        </div>
      )}

      {/* Session list */}
      {!isCollapsed && (
        <div className="mt-0.5">
          {group.sessions.map((s) => {
            const permCount = pendingPermissions.get(s.id)?.size ?? 0;
            return (
              <SessionItem
                key={s.id}
                session={s}
                isActive={currentSessionId === s.id}
                sessionName={sessionNames.get(s.id)}
                permCount={permCount}
                isRecentlyRenamed={recentlyRenamed.has(s.id)}
                onSelect={onSelect}
                onStartRename={onStartRename}
                onArchive={onArchive}
                onUnarchive={onUnarchive}
                onDelete={onDelete}
                onClearRecentlyRenamed={onClearRecentlyRenamed}
                editingSessionId={editingSessionId}
                editingName={editingName}
                setEditingName={setEditingName}
                onConfirmRename={onConfirmRename}
                onCancelRename={onCancelRename}
                editInputRef={editInputRef}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
