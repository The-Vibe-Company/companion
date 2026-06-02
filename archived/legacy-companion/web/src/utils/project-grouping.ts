export interface SessionItem {
  id: string;
  model: string;
  cwd: string;
  gitBranch: string;
  isContainerized: boolean;
  gitAhead: number;
  gitBehind: number;
  linesAdded: number;
  linesRemoved: number;
  isConnected: boolean;
  isReconnecting: boolean;
  status: "idle" | "running" | "compacting" | null;
  sdkState: "starting" | "connected" | "running" | "exited" | null;
  createdAt: number;
  archived: boolean;
  backendType: "claude" | "codex";
  repoRoot: string;
  permCount: number;
  cronJobId?: string;
  cronJobName?: string;
  agentId?: string;
  agentName?: string;
}

export interface ProjectGroup {
  key: string;
  label: string;
  sessions: SessionItem[];
  runningCount: number;
  permCount: number;
  mostRecentActivity: number;
}

/**
 * Extracts a project key from a cwd path.
 * Uses repoRoot when available (normalizes to the parent repo).
 */
export function extractProjectKey(
  cwd: string,
  repoRoot?: string,
  isContainerized = false,
): string {
  // Defensive fallback: container git state may transiently report /workspace*
  // even when the host cwd is the real project location.
  const containerWorkspaceRoot =
    isContainerized && !!repoRoot && (repoRoot === "/workspace" || repoRoot.startsWith("/workspace/"));
  const basePath = containerWorkspaceRoot ? cwd : (repoRoot || cwd);
  return basePath.replace(/\/+$/, "") || "/";
}

/**
 * Extracts a display label from a project key (last path component).
 */
export function extractProjectLabel(projectKey: string): string {
  if (projectKey === "/") return "/";
  const parts = projectKey.split("/").filter(Boolean);
  if (parts.length === 0) return "/";
  return parts[parts.length - 1];
}

/**
 * Groups sessions by project directory, sorts groups by most recent activity,
 * and sorts sessions within each group (running first, then by createdAt desc).
 */
export function groupSessionsByProject(
  sessions: SessionItem[],
): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();

  for (const session of sessions) {
    const key = extractProjectKey(
      session.cwd,
      session.repoRoot || undefined,
      session.isContainerized,
    );
    const label = extractProjectLabel(key);

    if (!groups.has(key)) {
      groups.set(key, {
        key,
        label,
        sessions: [],
        runningCount: 0,
        permCount: 0,
        mostRecentActivity: 0,
      });
    }

    const group = groups.get(key)!;
    group.sessions.push(session);
    if (session.status === "running") group.runningCount++;
    group.permCount += session.permCount;
    group.mostRecentActivity = Math.max(group.mostRecentActivity, session.createdAt);
  }

  // Sort groups alphabetically by label (stable, predictable order)
  const sorted = Array.from(groups.values()).sort(
    (a, b) => a.label.localeCompare(b.label),
  );

  // Within each group, sort sessions by createdAt desc (stable order, no reordering on status change)
  for (const group of sorted) {
    group.sessions.sort((a, b) => b.createdAt - a.createdAt);
  }

  return sorted;
}
