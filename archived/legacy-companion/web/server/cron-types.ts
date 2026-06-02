// ─── Cron Job Types ────────────────────────────────────────────────────────

export interface CronJob {
  /** Unique slug-based ID (derived from name) */
  id: string;
  /** Human-readable job name */
  name: string;
  /** The prompt to send when the job fires */
  prompt: string;
  /** Cron expression (e.g. "0 8 * * *") or ISO datetime string for one-shot */
  schedule: string;
  /** true = recurring cron, false = one-shot at a specific time */
  recurring: boolean;
  /** Backend to use */
  backendType: "claude" | "codex";
  /** Model to use (e.g. "claude-sonnet-4-6") */
  model: string;
  /** Working directory for the session */
  cwd: string;
  /** Optional environment slug (references ~/.companion/envs/) */
  envSlug?: string;
  /** Whether the job is currently enabled */
  enabled: boolean;
  /** Permission mode — defaults to "bypassPermissions" for autonomy */
  permissionMode: string;
  /** Codex-only: enable internet access */
  codexInternetAccess?: boolean;

  // ── Tracking ──
  createdAt: number;
  updatedAt: number;
  /** Last time this job was triggered */
  lastRunAt?: number;
  /** Session ID of the last execution */
  lastSessionId?: string;
  /** Number of consecutive failures */
  consecutiveFailures: number;
  /** Total number of runs */
  totalRuns: number;
}

export interface CronJobExecution {
  /** The session ID created for this execution */
  sessionId: string;
  /** The job ID that triggered this */
  jobId: string;
  /** When the execution started */
  startedAt: number;
  /** When the execution completed (result received) */
  completedAt?: number;
  /** Whether the execution succeeded */
  success?: boolean;
  /** Error message if it failed */
  error?: string;
  /** Cost in USD */
  costUsd?: number;
}

/** Input for creating a cron job (without auto-generated fields) */
export type CronJobCreateInput = Omit<
  CronJob,
  "id" | "createdAt" | "updatedAt" | "consecutiveFailures" | "totalRuns" | "lastRunAt" | "lastSessionId"
>;
