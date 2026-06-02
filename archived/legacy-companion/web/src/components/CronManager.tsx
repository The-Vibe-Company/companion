import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { api, type CronJobInfo } from "../api.js";
import { getModelsForBackend, getDefaultModel, toModelOptions, type ModelOption } from "../utils/backends.js";
import { FolderPicker } from "./FolderPicker.js";
import { timeAgo } from "../utils/time-ago.js";
import { useClickOutside } from "../utils/use-click-outside.js";

interface Props {
  onClose?: () => void;
  embedded?: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function timeUntil(ts: number): string {
  const diff = ts - Date.now();
  if (diff <= 0) return "now";
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `in ${hours}h`;
  const days = Math.floor(hours / 24);
  return `in ${days}d`;
}

function humanizeSchedule(schedule: string, recurring: boolean): string {
  if (!recurring) return "One-time";

  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return schedule;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  // Every minute
  if (schedule === "* * * * *") return "Every minute";

  // Every N minutes
  if (hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    if (minute.startsWith("*/")) {
      const n = parseInt(minute.slice(2), 10);
      if (n === 1) return "Every minute";
      return `Every ${n} minutes`;
    }
  }

  // Every N hours
  if (minute === "0" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    if (hour === "*") return "Every hour";
    if (hour.startsWith("*/")) {
      const n = parseInt(hour.slice(2), 10);
      if (n === 1) return "Every hour";
      return `Every ${n} hours`;
    }
  }

  // Specific hour patterns
  if (dayOfMonth === "*" && month === "*" && minute !== "*" && hour !== "*" && !hour.includes("/") && !hour.includes(",")) {
    const h = parseInt(hour, 10);
    const m = parseInt(minute, 10);
    if (!isNaN(h) && !isNaN(m)) {
      const period = h >= 12 ? "PM" : "AM";
      const displayHour = h === 0 ? 12 : h > 12 ? h - 12 : h;
      const displayMin = m.toString().padStart(2, "0");
      const timeStr = `${displayHour}:${displayMin} ${period}`;

      if (dayOfWeek === "*") return `Every day at ${timeStr}`;
      if (dayOfWeek === "1-5") return `Weekdays at ${timeStr}`;
      if (dayOfWeek === "0,6") return `Weekends at ${timeStr}`;
    }
  }

  return schedule;
}

interface JobFormData {
  name: string;
  prompt: string;
  recurring: boolean;
  schedule: string;
  oneTimeDate: string;
  backendType: "claude" | "codex";
  model: string;
  cwd: string;
}

const EMPTY_FORM: JobFormData = {
  name: "",
  prompt: "",
  recurring: true,
  schedule: "0 8 * * *",
  oneTimeDate: "",
  backendType: "claude",
  model: getDefaultModel("claude"),
  cwd: "",
};

const CRON_PRESETS: { label: string; value: string }[] = [
  { label: "Every hour", value: "0 * * * *" },
  { label: "Every day at 8am", value: "0 8 * * *" },
  { label: "Every 2 hours", value: "0 */2 * * *" },
  { label: "Weekdays at 9am", value: "0 9 * * 1-5" },
];

// ─── Component ───────────────────────────────────────────────────────────────

export function CronManager({ onClose, embedded = false }: Props) {
  const [jobs, setJobs] = useState<CronJobInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<JobFormData>(EMPTY_FORM);
  const [formData, setFormData] = useState<JobFormData>(EMPTY_FORM);
  const [creating, setCreating] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set());

  const refresh = useCallback(() => {
    api.listCronJobs().then(setJobs).catch(() => {}).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 10_000);
    return () => clearInterval(interval);
  }, [refresh]);

  // ─── Create ──────────────────────────────────────────────────────────

  async function handleCreate() {
    const name = formData.name.trim();
    const prompt = formData.prompt.trim();
    if (!name || !prompt) return;

    setCreating(true);
    setError("");

    let schedule = formData.schedule;
    if (!formData.recurring && formData.oneTimeDate) {
      schedule = new Date(formData.oneTimeDate).toISOString();
    }

    try {
      await api.createCronJob({
        name,
        prompt,
        schedule,
        recurring: formData.recurring,
        backendType: formData.backendType,
        model: formData.model.trim() || undefined,
        cwd: formData.cwd.trim() || undefined,
      } as Partial<CronJobInfo>);
      setFormData(EMPTY_FORM);
      setShowCreate(false);
      refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  // ─── Edit ────────────────────────────────────────────────────────────

  function startEdit(job: CronJobInfo) {
    setEditingId(job.id);
    setEditForm({
      name: job.name,
      prompt: job.prompt,
      recurring: job.recurring,
      schedule: job.schedule,
      oneTimeDate: "",
      backendType: job.backendType,
      model: job.model,
      cwd: job.cwd,
    });
    setError("");
  }

  function cancelEdit() {
    setEditingId(null);
    setError("");
  }

  async function saveEdit() {
    if (!editingId) return;
    const name = editForm.name.trim();
    const prompt = editForm.prompt.trim();
    if (!name || !prompt) return;

    let schedule = editForm.schedule;
    if (!editForm.recurring && editForm.oneTimeDate) {
      schedule = new Date(editForm.oneTimeDate).toISOString();
    }

    try {
      await api.updateCronJob(editingId, {
        name,
        prompt,
        schedule,
        recurring: editForm.recurring,
        backendType: editForm.backendType,
        model: editForm.model.trim() || undefined,
        cwd: editForm.cwd.trim() || undefined,
      } as Partial<CronJobInfo>);
      setEditingId(null);
      setError("");
      refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  // ─── Actions ─────────────────────────────────────────────────────────

  async function handleDelete(id: string) {
    try {
      await api.deleteCronJob(id);
      if (editingId === id) setEditingId(null);
      refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleToggle(id: string) {
    try {
      await api.toggleCronJob(id);
      refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleRunNow(id: string) {
    setRunningIds((prev) => new Set(prev).add(id));
    try {
      await api.runCronJob(id);
      refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunningIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  // ─── Embedded layout ───────────────────────────────────────────────

  if (embedded) {
    return (
      <div className="h-full bg-cc-bg text-cc-fg font-sans-ui antialiased overflow-y-auto">
        <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6 sm:py-10 pb-safe">
          {/* Header */}
          <div className="flex items-start justify-between gap-3 mb-2">
            <div className="min-w-0">
              <h1 className="text-lg font-semibold text-cc-fg">Scheduled Tasks</h1>
              <p className="mt-0.5 text-[13px] text-cc-muted leading-relaxed">
                Run autonomous Claude Code or Codex sessions on a schedule.
              </p>
            </div>
          </div>

          {/* Toolbar */}
          <div className="flex items-center gap-2 mt-4 mb-5">
            <div className="flex-1" />
            <button
              onClick={() => setShowCreate(!showCreate)}
              className={`flex items-center gap-1.5 px-3.5 py-2.5 min-h-[44px] rounded-lg text-sm font-medium transition-colors cursor-pointer shrink-0 ${
                showCreate
                  ? "bg-cc-active text-cc-fg"
                  : "bg-cc-primary hover:bg-cc-primary-hover text-white"
              }`}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
                {showCreate ? <path d="M18 6 6 18M6 6l12 12" /> : <path d="M12 5v14M5 12h14" />}
              </svg>
              <span className="hidden sm:inline">{showCreate ? "Cancel" : "New Task"}</span>
            </button>
          </div>

          {/* Inline create form */}
          {showCreate && (
            <div
              className="mb-6 rounded-xl bg-cc-card p-4 sm:p-5 space-y-3"
              style={{ animation: "fadeSlideIn 150ms ease-out" }}
            >
              <JobForm form={formData} onChange={setFormData} />
              <p className="text-[10px] text-cc-muted">
                Scheduled tasks run with full autonomy (bypassPermissions)
              </p>

              {error && showCreate && (
                <div className="px-3 py-2 rounded-lg bg-cc-error/10 text-xs text-cc-error">{error}</div>
              )}

              <div className="flex items-center justify-end pt-1">
                <button
                  onClick={handleCreate}
                  disabled={!formData.name.trim() || !formData.prompt.trim() || creating}
                  className={`px-4 py-2.5 min-h-[44px] rounded-lg text-sm font-medium transition-colors ${
                    formData.name.trim() && formData.prompt.trim() && !creating
                      ? "bg-cc-primary hover:bg-cc-primary-hover text-white cursor-pointer"
                      : "bg-cc-hover text-cc-muted cursor-not-allowed"
                  }`}
                >
                  {creating ? "Creating..." : "Create"}
                </button>
              </div>
            </div>
          )}

          {/* Stats */}
          <div className="flex items-center gap-2 mb-3 text-[12px] text-cc-muted">
            <span>{jobs.length} task{jobs.length !== 1 ? "s" : ""}</span>
            {jobs.filter((j) => j.enabled).length > 0 && (
              <>
                <span className="text-cc-border">·</span>
                <span>{jobs.filter((j) => j.enabled).length} active</span>
              </>
            )}
          </div>

          {/* Job list */}
          {loading ? (
            <div className="py-12 text-center text-sm text-cc-muted">Loading scheduled tasks...</div>
          ) : jobs.length === 0 ? (
            <div className="py-12 text-center text-sm text-cc-muted">No scheduled tasks yet.</div>
          ) : (
            <div className="space-y-1">
              {jobs.map((job) => {
                if (editingId === job.id) {
                  return (
                    <div
                      key={job.id}
                      className="rounded-xl bg-cc-card p-4 space-y-3"
                      style={{ animation: "fadeSlideIn 150ms ease-out" }}
                    >
                      <JobForm form={editForm} onChange={setEditForm} />
                      <div className="flex justify-end gap-2">
                        <button
                          onClick={cancelEdit}
                          className="px-3 py-2.5 min-h-[44px] text-sm rounded-lg text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={() => void saveEdit()}
                          className="px-4 py-2.5 min-h-[44px] text-sm rounded-lg font-medium bg-cc-primary hover:bg-cc-primary-hover text-white transition-colors cursor-pointer"
                        >
                          Save
                        </button>
                      </div>
                    </div>
                  );
                }

                return (
                  <CronJobRow
                    key={job.id}
                    job={job}
                    isRunning={runningIds.has(job.id)}
                    onStartEdit={() => startEdit(job)}
                    onDelete={() => void handleDelete(job.id)}
                    onToggle={() => void handleToggle(job.id)}
                    onRunNow={() => void handleRunNow(job.id)}
                  />
                );
              })}
            </div>
          )}

          {/* Error banner (when not inside create form) */}
          {error && !showCreate && (
            <div className="mt-4 px-3 py-2 rounded-lg bg-cc-error/10 text-xs text-cc-error">{error}</div>
          )}
        </div>
      </div>
    );
  }

  // ─── Modal layout ──────────────────────────────────────────────────

  const errorBanner = error && (
    <div className="px-3 py-2 rounded-lg bg-cc-error/10 text-xs text-cc-error">{error}</div>
  );

  const jobsList = loading ? (
    <div className="text-sm text-cc-muted text-center py-6">Loading scheduled tasks...</div>
  ) : jobs.length === 0 ? (
    <div className="text-sm text-cc-muted text-center py-6">
      No scheduled tasks yet.
    </div>
  ) : (
    <div className="space-y-3">
      {jobs.map((job) => (
        <div key={job.id} className="rounded-xl bg-cc-card overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2.5">
            <span className="text-sm font-medium text-cc-fg flex-1 truncate">{job.name}</span>
            <span
              className={`text-[9px] font-medium px-1.5 rounded-full leading-[16px] shrink-0 ${
                job.backendType === "codex"
                  ? "text-blue-500 bg-blue-500/10"
                  : "text-[#5BA8A0] bg-[#5BA8A0]/10"
              }`}
            >
              {job.backendType === "codex" ? "Codex" : "Claude"}
            </span>
            {job.consecutiveFailures > 0 && (
              <span className="text-[9px] font-medium px-1.5 rounded-full leading-[16px] shrink-0 text-cc-error bg-cc-error/10">
                {job.consecutiveFailures} fail{job.consecutiveFailures !== 1 ? "s" : ""}
              </span>
            )}
            <button
              onClick={() => handleToggle(job.id)}
              className={`relative w-10 h-6 rounded-full transition-colors cursor-pointer shrink-0 ${
                job.enabled ? "bg-cc-primary" : "bg-cc-border"
              }`}
              title={job.enabled ? "Disable" : "Enable"}
            >
              <span className={`absolute top-[3px] w-[18px] h-[18px] rounded-full bg-white transition-transform ${job.enabled ? "left-[19px]" : "left-[3px]"}`} />
            </button>
            {editingId === job.id ? (
              <button onClick={cancelEdit} className="text-xs px-2 py-1.5 min-h-[44px] text-cc-muted hover:text-cc-fg cursor-pointer">Cancel</button>
            ) : (
              <>
                <button onClick={() => handleRunNow(job.id)} disabled={runningIds.has(job.id)} className={`text-xs px-2 py-1.5 min-h-[44px] cursor-pointer ${runningIds.has(job.id) ? "text-cc-muted cursor-not-allowed" : "text-cc-primary hover:text-cc-primary-hover"}`}>
                  {runningIds.has(job.id) ? "Running..." : "Run Now"}
                </button>
                <button onClick={() => startEdit(job)} className="text-xs px-2 py-1.5 min-h-[44px] text-cc-muted hover:text-cc-fg cursor-pointer">Edit</button>
                <button onClick={() => handleDelete(job.id)} className="text-xs px-2 py-1.5 min-h-[44px] text-cc-muted hover:text-cc-error cursor-pointer">Delete</button>
              </>
            )}
          </div>

          {editingId === job.id && (
            <div className="px-3 py-3 space-y-2.5">
              <JobForm form={editForm} onChange={setEditForm} />
              <div className="flex items-center gap-2">
                <button onClick={saveEdit} className="px-4 py-2.5 min-h-[44px] text-sm font-medium bg-cc-primary hover:bg-cc-primary-hover text-white rounded-lg transition-colors cursor-pointer">Save</button>
                <button onClick={cancelEdit} className="px-3 py-2.5 min-h-[44px] text-sm font-medium text-cc-muted hover:text-cc-fg rounded-lg transition-colors cursor-pointer">Cancel</button>
              </div>
            </div>
          )}

          {editingId !== job.id && (
            <div className="px-3 py-2.5 space-y-1.5">
              <div className="text-xs text-cc-muted truncate" title={job.prompt}>{job.prompt}</div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-cc-muted">
                <span>{humanizeSchedule(job.schedule, job.recurring)}</span>
                {job.nextRunAt != null && job.enabled && <span>Next: {timeUntil(job.nextRunAt)}</span>}
                {job.lastRunAt != null && (
                  <span className="flex items-center gap-1">
                    Last: {timeAgo(job.lastRunAt)}
                    {job.consecutiveFailures === 0 ? (
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 text-cc-success"><path d="M12.207 4.793a1 1 0 010 1.414l-5 5a1 1 0 01-1.414 0l-2.5-2.5a1 1 0 011.414-1.414L6.5 9.086l4.293-4.293a1 1 0 011.414 0z" /></svg>
                    ) : (
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 text-cc-error"><path d="M4.646 4.646a.5.5 0 01.708 0L8 7.293l2.646-2.647a.5.5 0 01.708.708L8.707 8l2.647 2.646a.5.5 0 01-.708.708L8 8.707l-2.646 2.647a.5.5 0 01-.708-.708L7.293 8 4.646 5.354a.5.5 0 010-.708z" /></svg>
                    )}
                  </span>
                )}
                {job.totalRuns > 0 && <span>{job.totalRuns} run{job.totalRuns !== 1 ? "s" : ""}</span>}
                {job.cwd && <span className="font-mono-code truncate max-w-[200px]" title={job.cwd}>{job.cwd}</span>}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );

  const createSection = (
    <div className="rounded-xl bg-cc-card overflow-hidden">
      <button
        onClick={() => setShowCreate(!showCreate)}
        className="w-full flex items-center gap-2 px-3 py-2.5 cursor-pointer hover:bg-cc-hover transition-colors"
      >
        <svg
          viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"
          className={`w-3 h-3 text-cc-muted transition-transform ${showCreate ? "rotate-90" : ""}`}
        >
          <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="text-sm font-medium text-cc-fg">New Scheduled Task</span>
      </button>
      {showCreate && (
        <div className="px-3 py-3 space-y-2.5">
          <JobForm form={formData} onChange={setFormData} />
          <div className="text-[10px] text-cc-muted">
            Scheduled tasks run with full autonomy (bypassPermissions)
          </div>
          <button
            onClick={handleCreate}
            disabled={!formData.name.trim() || !formData.prompt.trim() || creating}
            className={`px-4 py-2.5 min-h-[44px] text-sm font-medium rounded-lg transition-colors ${
              formData.name.trim() && formData.prompt.trim() && !creating
                ? "bg-cc-primary hover:bg-cc-primary-hover text-white cursor-pointer"
                : "bg-cc-hover text-cc-muted cursor-not-allowed"
            }`}
          >
            {creating ? "Creating..." : "Create"}
          </button>
        </div>
      )}
    </div>
  );

  const panel = (
    <div
      className="w-full max-w-2xl max-h-[90dvh] sm:max-h-[80dvh] mx-0 sm:mx-4 flex flex-col bg-cc-bg rounded-t-[14px] sm:rounded-[14px] shadow-2xl overflow-hidden"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between px-4 sm:px-5 py-3 sm:py-4">
        <div>
          <h2 className="text-sm font-semibold text-cc-fg">Scheduled Tasks</h2>
          <p className="text-xs text-cc-muted mt-0.5">
            Run autonomous Claude Code or Codex sessions on a schedule
          </p>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-md text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto px-3 sm:px-5 py-3 sm:py-4 pb-safe space-y-4">
        {errorBanner}
        {jobsList}
        {createSection}
      </div>
    </div>
  );

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50" onClick={onClose}>
      {panel}
    </div>,
    document.body,
  );
}

// ─── Job Row (embedded display only) ──────────────────────────────────────────

interface CronJobRowProps {
  job: CronJobInfo;
  isRunning: boolean;
  onStartEdit: () => void;
  onDelete: () => void;
  onToggle: () => void;
  onRunNow: () => void;
}

function CronJobRow({ job, isRunning, onStartEdit, onDelete, onToggle, onRunNow }: CronJobRowProps) {
  return (
    <div className="group flex items-start gap-3 px-3 py-3 min-h-[44px] rounded-lg hover:bg-cc-hover/60 transition-colors">
      {/* Icon */}
      <div className="shrink-0 mt-0.5 w-7 h-7 rounded-md bg-cc-primary/10 flex items-center justify-center">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5 text-cc-primary">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 6v6l4 2" />
        </svg>
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-cc-fg truncate">{job.name}</span>
          <span
            className={`text-[9px] font-medium px-1.5 rounded-full leading-[16px] shrink-0 ${
              job.backendType === "codex"
                ? "text-blue-500 bg-blue-500/10"
                : "text-[#5BA8A0] bg-[#5BA8A0]/10"
            }`}
          >
            {job.backendType === "codex" ? "Codex" : "Claude"}
          </span>
          {job.consecutiveFailures > 0 && (
            <span className="text-[9px] font-medium px-1.5 rounded-full leading-[16px] shrink-0 text-cc-error bg-cc-error/10">
              {job.consecutiveFailures} fail{job.consecutiveFailures !== 1 ? "s" : ""}
            </span>
          )}
          {!job.enabled && (
            <span className="text-[9px] font-medium px-1.5 rounded-full leading-[16px] shrink-0 text-cc-muted bg-cc-hover">
              Paused
            </span>
          )}
        </div>
        <p className="mt-0.5 text-xs text-cc-muted line-clamp-1 leading-relaxed">{job.prompt}</p>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-1 text-[11px] text-cc-muted">
          <span>{humanizeSchedule(job.schedule, job.recurring)}</span>
          {job.nextRunAt != null && job.enabled && (
            <>
              <span className="text-cc-border">·</span>
              <span>Next {timeUntil(job.nextRunAt)}</span>
            </>
          )}
          {job.lastRunAt != null && (
            <>
              <span className="text-cc-border">·</span>
              <span className="flex items-center gap-0.5">
                Last {timeAgo(job.lastRunAt)}
                {job.consecutiveFailures === 0 ? (
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-2.5 h-2.5 text-cc-success">
                    <path d="M12.207 4.793a1 1 0 010 1.414l-5 5a1 1 0 01-1.414 0l-2.5-2.5a1 1 0 011.414-1.414L6.5 9.086l4.293-4.293a1 1 0 011.414 0z" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-2.5 h-2.5 text-cc-error">
                    <path d="M4.646 4.646a.5.5 0 01.708 0L8 7.293l2.646-2.647a.5.5 0 01.708.708L8.707 8l2.647 2.646a.5.5 0 01-.708.708L8 8.707l-2.646 2.647a.5.5 0 01-.708-.708L7.293 8 4.646 5.354a.5.5 0 010-.708z" />
                  </svg>
                )}
              </span>
            </>
          )}
          {job.totalRuns > 0 && (
            <>
              <span className="text-cc-border">·</span>
              <span>{job.totalRuns} run{job.totalRuns !== 1 ? "s" : ""}</span>
            </>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="shrink-0 flex items-center gap-0.5 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
        {/* Toggle */}
        <button
          onClick={onToggle}
          className={`relative w-9 h-5 rounded-full transition-colors cursor-pointer shrink-0 ${
            job.enabled ? "bg-cc-primary" : "bg-cc-border"
          }`}
          title={job.enabled ? "Disable" : "Enable"}
        >
          <span className={`absolute top-[2px] w-4 h-4 rounded-full bg-white transition-transform ${job.enabled ? "left-[17px]" : "left-[2px]"}`} />
        </button>
        {/* Run now */}
        <button
          onClick={onRunNow}
          disabled={isRunning}
          className={`p-2 min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 sm:p-1.5 rounded-md transition-colors cursor-pointer ${
            isRunning ? "text-cc-muted cursor-not-allowed" : "text-cc-primary hover:bg-cc-primary/10"
          }`}
          aria-label="Run now"
          title={isRunning ? "Running..." : "Run now"}
        >
          <svg viewBox="0 0 24 24" fill="currentColor" className="w-3.5 h-3.5">
            <path d="M8 5v14l11-7z" />
          </svg>
        </button>
        {/* Edit */}
        <button
          onClick={onStartEdit}
          className="p-2 min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 sm:p-1.5 rounded-md text-cc-muted hover:text-cc-fg hover:bg-cc-active transition-colors cursor-pointer"
          aria-label="Edit"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5Z" />
          </svg>
        </button>
        {/* Delete */}
        <button
          onClick={onDelete}
          className="p-2 min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 sm:p-1.5 rounded-md text-cc-muted hover:text-cc-error hover:bg-cc-error/10 transition-colors cursor-pointer"
          aria-label="Delete"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
            <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14Z" />
          </svg>
        </button>
      </div>
    </div>
  );
}

// ─── Shared Job Form ─────────────────────────────────────────────────────────

function JobForm({
  form,
  onChange,
}: {
  form: JobFormData;
  onChange: (form: JobFormData) => void;
}) {
  const update = (partial: Partial<JobFormData>) =>
    onChange({ ...form, ...partial });

  // ─── Dynamic model fetching (same pattern as HomePage) ──────────
  const [dynamicModels, setDynamicModels] = useState<ModelOption[] | null>(null);
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const modelDropdownRef = useRef<HTMLDivElement>(null);
  const [showFolderPicker, setShowFolderPicker] = useState(false);
  const [showBackendDropdown, setShowBackendDropdown] = useState(false);
  const backendDropdownRef = useRef<HTMLDivElement>(null);

  const models = dynamicModels || getModelsForBackend(form.backendType);
  const selectedModel = models.find((m) => m.value === form.model) || models[0];

  // Fetch dynamic models when backend changes
  useEffect(() => {
    setDynamicModels(null);
    if (form.backendType !== "codex") return;
    api.getBackendModels(form.backendType).then((fetched) => {
      if (fetched.length > 0) {
        const options = toModelOptions(fetched);
        setDynamicModels(options);
        if (!options.some((m) => m.value === form.model)) {
          update({ model: options[0].value });
        }
      }
    }).catch(() => {
      // Fall back to hardcoded models silently
    });
  }, [form.backendType]); // eslint-disable-line react-hooks/exhaustive-deps

  // Set default model if empty
  useEffect(() => {
    if (!form.model) {
      update({ model: getDefaultModel(form.backendType) });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Close dropdowns on outside click
  const modelDropdownRefs = useMemo(() => [modelDropdownRef], []);
  const closeModelDropdown = useCallback(() => setShowModelDropdown(false), []);
  useClickOutside(modelDropdownRefs, closeModelDropdown, showModelDropdown);

  const backendDropdownRefs = useMemo(() => [backendDropdownRef], []);
  const closeBackendDropdown = useCallback(() => setShowBackendDropdown(false), []);
  useClickOutside(backendDropdownRefs, closeBackendDropdown, showBackendDropdown);

  // Folder display label
  const dirLabel = form.cwd
    ? form.cwd.split("/").pop() || form.cwd
    : "Select folder";

  return (
    <div className="space-y-2.5">
      {/* Name */}
      <input
        type="text"
        value={form.name}
        onChange={(e) => update({ name: e.target.value })}
        placeholder="Task name (e.g. Daily test suite)"
        className="w-full px-3 py-2.5 min-h-[44px] text-sm bg-cc-bg rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:ring-1 focus:ring-cc-primary/40 transition-shadow"
      />

      {/* Prompt */}
      <textarea
        value={form.prompt}
        onChange={(e) => update({ prompt: e.target.value })}
        placeholder="Prompt for the session (e.g. Run the test suite and fix any failures)"
        rows={4}
        className="w-full px-3 py-2.5 text-sm bg-cc-bg rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:ring-1 focus:ring-cc-primary/40 resize-y transition-shadow"
        style={{ minHeight: "100px" }}
      />

      {/* Schedule type toggle */}
      <div className="space-y-2">
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => update({ recurring: true })}
            className={`px-2.5 py-2 min-h-[44px] text-xs font-medium rounded-lg transition-colors cursor-pointer ${
              form.recurring
                ? "bg-cc-primary text-white"
                : "bg-cc-hover text-cc-muted hover:text-cc-fg"
            }`}
          >
            Recurring
          </button>
          <button
            onClick={() => update({ recurring: false })}
            className={`px-2.5 py-2 min-h-[44px] text-xs font-medium rounded-lg transition-colors cursor-pointer ${
              !form.recurring
                ? "bg-cc-primary text-white"
                : "bg-cc-hover text-cc-muted hover:text-cc-fg"
            }`}
          >
            One-time
          </button>
        </div>

        {form.recurring ? (
          <div className="space-y-1.5">
            {/* Cron presets */}
            <div className="flex flex-wrap gap-1.5">
              {CRON_PRESETS.map((preset) => (
                <button
                  key={preset.value}
                  onClick={() => update({ schedule: preset.value })}
                  className={`px-2.5 py-2 min-h-[44px] text-xs font-medium rounded-md transition-colors cursor-pointer ${
                    form.schedule === preset.value
                      ? "bg-cc-primary/20 text-cc-primary"
                      : "bg-cc-hover text-cc-muted hover:text-cc-fg"
                  }`}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            {/* Cron expression input */}
            <input
              type="text"
              value={form.schedule}
              onChange={(e) => update({ schedule: e.target.value })}
              placeholder="Cron expression (e.g. 0 8 * * *)"
              className="w-full px-3 py-2.5 min-h-[44px] text-sm font-mono-code bg-cc-bg rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:ring-1 focus:ring-cc-primary/40 transition-shadow"
            />
            <div className="text-[10px] text-cc-muted">
              {humanizeSchedule(form.schedule, true)}
            </div>
          </div>
        ) : (
          <input
            type="datetime-local"
            value={form.oneTimeDate}
            onChange={(e) => update({ oneTimeDate: e.target.value })}
            className="w-full px-3 py-2.5 min-h-[44px] text-sm bg-cc-bg rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:ring-1 focus:ring-cc-primary/40 transition-shadow"
          />
        )}
      </div>

      {/* Backend + Model + Folder row */}
      <div className="flex flex-wrap items-center gap-1.5">
        {/* Backend selector */}
        <div className="relative" ref={backendDropdownRef}>
          <button
            onClick={() => setShowBackendDropdown(!showBackendDropdown)}
            className="flex items-center gap-1.5 px-2.5 py-2 min-h-[44px] text-xs font-medium text-cc-fg rounded-lg hover:bg-cc-hover transition-colors cursor-pointer"
          >
            <span>{form.backendType === "codex" ? "Codex" : "Claude Code"}</span>
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 opacity-50">
              <path d="M4 6l4 4 4-4" />
            </svg>
          </button>
          {showBackendDropdown && (
            <div className="absolute left-0 bottom-full mb-1 w-40 bg-cc-card rounded-xl shadow-lg z-10 py-1">
              {(
                [
                  { value: "claude", label: "Claude Code" },
                  { value: "codex", label: "Codex" },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => {
                    update({ backendType: opt.value, model: getDefaultModel(opt.value) });
                    setShowBackendDropdown(false);
                  }}
                  className={`w-full px-3 py-2.5 min-h-[44px] text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer ${
                    opt.value === form.backendType ? "text-cc-primary font-medium" : "text-cc-fg"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Model dropdown */}
        <div className="relative" ref={modelDropdownRef}>
          <button
            onClick={() => setShowModelDropdown(!showModelDropdown)}
            className="flex items-center gap-1.5 px-2.5 py-2 min-h-[44px] text-xs text-cc-muted hover:text-cc-fg rounded-lg hover:bg-cc-hover transition-colors cursor-pointer"
          >
            <span>{selectedModel?.icon}</span>
            <span>{selectedModel?.label}</span>
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 opacity-50">
              <path d="M4 6l4 4 4-4" />
            </svg>
          </button>
          {showModelDropdown && (
            <div className="absolute left-0 bottom-full mb-1 w-52 bg-cc-card rounded-xl shadow-lg z-10 py-1">
              {models.map((m) => (
                <button
                  key={m.value}
                  onClick={() => {
                    update({ model: m.value });
                    setShowModelDropdown(false);
                  }}
                  className={`w-full px-3 py-2.5 min-h-[44px] text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer flex items-center gap-2 ${
                    m.value === form.model ? "text-cc-primary font-medium" : "text-cc-fg"
                  }`}
                >
                  <span>{m.icon}</span>
                  {m.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Folder picker */}
        <button
          onClick={() => setShowFolderPicker(true)}
          className="flex items-center gap-1.5 px-2.5 py-2 min-h-[44px] text-xs text-cc-muted hover:text-cc-fg rounded-lg hover:bg-cc-hover transition-colors cursor-pointer"
        >
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 opacity-60">
            <path d="M1 3.5A1.5 1.5 0 012.5 2h3.379a1.5 1.5 0 011.06.44l.622.621a.5.5 0 00.353.146H13.5A1.5 1.5 0 0115 4.707V12.5a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12.5v-9z" />
          </svg>
          <span className="max-w-[200px] truncate font-mono-code">{dirLabel}</span>
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 opacity-50">
            <path d="M4 6l4 4 4-4" />
          </svg>
        </button>
        {showFolderPicker && (
          <FolderPicker
            initialPath={form.cwd || ""}
            onSelect={(path) => update({ cwd: path })}
            onClose={() => setShowFolderPicker(false)}
          />
        )}
      </div>
    </div>
  );
}
