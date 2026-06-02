import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { api, type LinearIssue, type LinearTeamStates } from "../../api.js";

interface CreateIssueModalProps {
  /** Pre-selected project ID from the linearMapping, if available */
  defaultProjectId?: string;
  /** Which Linear connection to use (for multi-connection support) */
  connectionId?: string;
  /** Called on successful creation with the new issue */
  onCreated: (issue: LinearIssue) => void;
  /** Called when the modal is closed without creating */
  onClose: () => void;
}

export function CreateIssueModal({ defaultProjectId, connectionId, onCreated, onClose }: CreateIssueModalProps) {
  // Form fields
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [selectedTeamId, setSelectedTeamId] = useState("");
  const [priority, setPriority] = useState(0);
  const [assignToSelf, setAssignToSelf] = useState(true);

  // Data
  const [teams, setTeams] = useState<LinearTeamStates[]>([]);
  const [viewerId, setViewerId] = useState("");
  const [backlogStateId, setBacklogStateId] = useState("");
  const [loading, setLoading] = useState(true);

  // Submission
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  // Fetch teams and viewer info on mount
  useEffect(() => {
    let active = true;
    Promise.all([
      api.getLinearStates(connectionId),
      api.getLinearConnection(connectionId),
    ]).then(([statesRes, connRes]) => {
      if (!active) return;
      setTeams(statesRes.teams);
      setViewerId(connRes.viewerId);
      const initialTeamId = statesRes.teams[0]?.id || "";
      setSelectedTeamId(initialTeamId);
    }).catch((e: unknown) => {
      if (!active) return;
      setError(e instanceof Error ? e.message : "Failed to load teams");
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [connectionId]);

  // Derive backlog state ID when team changes
  useEffect(() => {
    if (!selectedTeamId || teams.length === 0) {
      setBacklogStateId("");
      return;
    }
    const team = teams.find((t) => t.id === selectedTeamId);
    const backlog = team?.states.find((s) => s.type === "backlog");
    setBacklogStateId(backlog?.id || "");
  }, [selectedTeamId, teams]);

  async function handleCreate() {
    if (!title.trim() || !selectedTeamId) return;
    setCreating(true);
    setError("");
    try {
      const result = await api.createLinearIssue({
        title: title.trim(),
        description: description.trim() || undefined,
        teamId: selectedTeamId,
        priority,
        projectId: defaultProjectId || undefined,
        assigneeId: assignToSelf && viewerId ? viewerId : undefined,
        stateId: backlogStateId || undefined,
        connectionId,
      });
      onCreated(result.issue);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to create issue");
    } finally {
      setCreating(false);
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="mx-4 w-full max-w-md bg-cc-card border border-cc-border rounded-xl shadow-2xl p-5"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-cc-fg">Create Linear Issue</h3>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-6 w-6 items-center justify-center rounded-md text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
              <path d="M4.646 4.646a.5.5 0 01.708 0L8 7.293l2.646-2.647a.5.5 0 01.708.708L8.707 8l2.647 2.646a.5.5 0 01-.708.708L8 8.707l-2.646 2.647a.5.5 0 01-.708-.708L7.293 8 4.646 5.354a.5.5 0 010-.708z" />
            </svg>
          </button>
        </div>

        {/* Error */}
        {error && (
          <div className="mb-3 px-2.5 py-2 text-xs text-cc-error bg-cc-error/10 border border-cc-error/20 rounded-lg">
            {error}
          </div>
        )}

        {loading ? (
          <div className="py-8 text-xs text-cc-muted text-center">Loading teams...</div>
        ) : (
          <div className="space-y-3">
            {/* Title */}
            <div>
              <label htmlFor="create-issue-title" className="text-xs text-cc-muted block mb-1">Title *</label>
              <input
                id="create-issue-title"
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && title.trim() && selectedTeamId && !creating) {
                    handleCreate();
                  }
                }}
                placeholder="Issue title"
                autoFocus
                className="w-full px-2.5 py-2 text-sm bg-cc-input-bg border border-cc-border rounded-md text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/60"
              />
            </div>

            {/* Description */}
            <div>
              <label htmlFor="create-issue-desc" className="text-xs text-cc-muted block mb-1">Description</label>
              <textarea
                id="create-issue-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Add details... (Markdown supported)"
                rows={3}
                className="w-full px-2.5 py-2 text-sm bg-cc-input-bg border border-cc-border rounded-md text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/60 resize-none"
              />
            </div>

            {/* Team selector */}
            <div>
              <label htmlFor="create-issue-team" className="text-xs text-cc-muted block mb-1">Team *</label>
              <select
                id="create-issue-team"
                value={selectedTeamId}
                onChange={(e) => setSelectedTeamId(e.target.value)}
                className="w-full px-2.5 py-2 text-sm bg-cc-input-bg border border-cc-border rounded-md text-cc-fg cursor-pointer"
              >
                {teams.map((team) => (
                  <option key={team.id} value={team.id}>
                    {team.name} ({team.key})
                  </option>
                ))}
              </select>
            </div>

            {/* Priority selector */}
            <div>
              <label htmlFor="create-issue-priority" className="text-xs text-cc-muted block mb-1">Priority</label>
              <select
                id="create-issue-priority"
                value={priority}
                onChange={(e) => setPriority(Number(e.target.value))}
                className="w-full px-2.5 py-2 text-sm bg-cc-input-bg border border-cc-border rounded-md text-cc-fg cursor-pointer"
              >
                <option value={0}>No priority</option>
                <option value={1}>Urgent</option>
                <option value={2}>High</option>
                <option value={3}>Medium</option>
                <option value={4}>Low</option>
              </select>
            </div>

            {/* Assign to self */}
            <label htmlFor="create-issue-assign" className="flex items-center gap-2 cursor-pointer">
              <input
                id="create-issue-assign"
                type="checkbox"
                checked={assignToSelf}
                onChange={(e) => setAssignToSelf(e.target.checked)}
                className="rounded border-cc-border text-cc-primary focus:ring-cc-primary/30 cursor-pointer"
              />
              <span className="text-xs text-cc-muted">Assign to me</span>
            </label>

            {/* Actions */}
            <div className="flex gap-2.5 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 px-3 py-2 text-xs font-medium rounded-lg bg-cc-hover text-cc-muted hover:text-cc-fg transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleCreate}
                disabled={!title.trim() || !selectedTeamId || creating}
                className="flex-1 px-3 py-2 text-xs font-medium rounded-lg bg-cc-primary text-white hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
              >
                {creating ? "Creating..." : "Create Issue"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
