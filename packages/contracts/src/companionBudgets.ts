/**
 * Companion runtime budgets — the single source of truth for every timeout, deadline, TTL, and
 * cadence the Companions runtime spends. Phase 0 of the reliability plan: values here are exactly
 * the values that were previously scattered as per-file literals; nothing changes behavior. Later
 * phases retune numbers *here* (and in the paired SQL migration when a value is mirrored in a
 * `SECURITY DEFINER` function) so the invariant tests in
 * `packages/contracts/test/companionBudgets.test.ts` and the SQL consistency test in
 * `apps/api/test/integration/companionRuntimeBudgets.integration.test.ts` keep every consumer and
 * every `interval '...'` literal in agreement.
 *
 * This module is deliberately dependency-free: `@companion/contracts` is the only common ancestor
 * of `packages/companion-runtime`, `packages/box-runtime`, and `apps/runtime`.
 */

/** Hand-tuned base budgets. Derived values live in {@link deriveCompanionBudgets}. */
export interface CompanionBudgetsBase {
  /** Absolute wall-clock ceiling of one turn attempt. SQL twin: `interval '2 hours'`. */
  turnAbsoluteDeadlineMs: number;
  /**
   * A turn with no correlated Pi activity for this long is stalled. SQL twin:
   * `interval '10 minutes'`. The stall clock pauses on `needs_input` (the claim is released and the
   * deadline is cleared, then re-armed on resume), so human wait time does not spend this budget.
   */
  inactivityStallMs: number;
  /**
   * From durable send to Pi prompt acknowledgement on a cold Box. SQL twin: `interval '3 minutes'`
   * (`cold_start_deadline_at = created_at + 3 minutes`, fixed at enqueue and never moved —
   * `attempt.ts` recovers the send time by subtracting this same constant).
   */
  coldStartDeadlineMs: number;
  /**
   * Staging/dispatch reserve added on top of the absolute turn deadline when material is prepared,
   * so a snapshot minted at claim time outlives the longest legal turn.
   */
  materialStagingReserveMs: number;
  /** Box stays warm this long after successful Pi acceptance. SQL twin: `interval '6 hours'`. */
  boxWarmTtlSeconds: number;
  /** Runtime work lease. SQL leases and every `leaseSeconds` call site share this. */
  leaseSeconds: number;
  /** Claim-loop sweep cadence of the runtime scheduler. */
  sweepIntervalMs: number;
  /** Ceiling for one non-exec Pi tool run before its transcript chip times out. */
  toolRunTimeoutMs: number;
  /** Ceiling for one shell/subagent Pi tool run. Known to equal the stall today — see exceedances. */
  execToolRunTimeoutMs: number;
  /**
   * How long ask_user/propose_* wait for a human answer before returning control to Pi without an
   * approval. A newer member message also ends the wait early. The inactivity clock is paused in
   * needs_input so the decision delivery can resume Pi cleanly instead of racing a stall.
   */
  decisionTimeoutMs: number;
  /** One Box provider HTTP call (maintenance client, runtime adapters, lifecycle calls). */
  boxRequestTimeoutMs: number;
  /** Absolute ceiling of one runtime operation (start/stop/restart/settings/delete). */
  operationDeadlineMs: number;
  /** Budget for installing the Pi layout onto a Box during staging. */
  layoutInstallBudgetMs: number;
  /**
   * TTL a provisional Box create is given before runtime durably records the returned Box id;
   * bounds the irreducible POST-response/process-crash orphan (create has no idempotency key).
   */
  provisionalCreateTtlSeconds: number;
}

export const COMPANION_BUDGETS_BASE = {
  turnAbsoluteDeadlineMs: 2 * 60 * 60 * 1_000,
  // Current SQL value ('10 minutes'). The 12-minute retune is a later phase and lands here plus in
  // a migration of the four definer functions that mirror it — never as a drive-by edit.
  inactivityStallMs: 10 * 60 * 1_000,
  coldStartDeadlineMs: 3 * 60 * 1_000,
  materialStagingReserveMs: 5 * 60 * 1_000,
  boxWarmTtlSeconds: 21_600,
  leaseSeconds: 30,
  sweepIntervalMs: 2_000,
  toolRunTimeoutMs: 90_000,
  execToolRunTimeoutMs: 600_000,
  decisionTimeoutMs: 10 * 60 * 1_000,
  boxRequestTimeoutMs: 30_000,
  operationDeadlineMs: 10 * 60 * 1_000,
  layoutInstallBudgetMs: 300_000,
  provisionalCreateTtlSeconds: 300,
} as const satisfies CompanionBudgetsBase;

/** Base plus everything derivable from it. Consumers import values, never re-derive locally. */
export interface CompanionBudgets extends CompanionBudgetsBase {
  /** Lease renewal cadence: a third of the lease, so two renews may fail before authority lapses. */
  renewIntervalMs: number;
  /**
   * Graceful shutdown drain: the lease minus a five-second settle margin, so a drain that runs its
   * full course still finishes inside the authority of the lease it started under (25 s today).
   */
  shutdownDrainMs: number;
  /**
   * Minimum TTL of prepared turn material: the absolute turn deadline plus the staging reserve.
   * SQL twin: `interval '2 hours 5 minutes'`; TS twin: `COMPANION_RUNTIME_MATERIAL_MIN_TTL_MS`.
   */
  materialMinTtlMs: number;
  /** Hub token TTL matches the Box warm window. SQL twin: `interval '6 hours'`. */
  hubTokenTtlSeconds: number;
  /** Settings activation is one operation; it shares the operation deadline. */
  settingsActivationDeadlineMs: number;
}

/** Pure derivation — no clocks, no environment. Exists so tests can probe alternate bases. */
export function deriveCompanionBudgets(base: CompanionBudgetsBase): CompanionBudgets {
  return {
    ...base,
    renewIntervalMs: Math.floor((base.leaseSeconds * 1_000) / 3),
    shutdownDrainMs: base.leaseSeconds * 1_000 - 5_000,
    materialMinTtlMs: base.turnAbsoluteDeadlineMs + base.materialStagingReserveMs,
    hubTokenTtlSeconds: base.boxWarmTtlSeconds,
    settingsActivationDeadlineMs: base.operationDeadlineMs,
  };
}

export const COMPANION_BUDGETS: CompanionBudgets = deriveCompanionBudgets(COMPANION_BUDGETS_BASE);

/**
 * Parses the narrow `interval '...'` dialect used by this repo's migrations into milliseconds.
 * Supports only the unit words that actually appear; anything else throws so a new spelling is
 * registered deliberately.
 */
export function sqlIntervalToMs(literal: string): number {
  // oxlint-disable-next-line anti-slop/no-known-value-widening -- Fixed unit->ms conversion table indexed by a parsed interval unit; an explicit Record is the domain contract here, not widened I/O input.
  const UNIT_MS: Record<string, number> = {
    second: 1_000,
    seconds: 1_000,
    minute: 60_000,
    minutes: 60_000,
    hour: 3_600_000,
    hours: 3_600_000,
    day: 86_400_000,
    days: 86_400_000,
  };
  const parts = literal.trim().split(/\s+/);
  if (parts.length === 0 || parts.length % 2 !== 0) {
    throw new Error(`Unsupported SQL interval literal: '${literal}'`);
  }
  let total = 0;
  for (let index = 0; index < parts.length; index += 2) {
    const amount = Number(parts[index]);
    const unit = UNIT_MS[parts[index + 1]!];
    if (!Number.isFinite(amount) || unit === undefined) {
      throw new Error(`Unsupported SQL interval literal: '${literal}'`);
    }
    total += amount * unit;
  }
  return total;
}

/**
 * The expected `interval '...'` literal multiset of every Companions-runtime PostgreSQL function
 * that spends time. Keys are `pg_proc.proname` values in the *migrated* schema (rename chains
 * resolved: the claim-work function was renamed three times; the `'2 hours'` absolute deadline
 * lives in the innermost `companion_runtime_claim_work_without_material_guard`). The integration
 * test compares this map against `pg_get_functiondef` output in both directions, so adding,
 * removing, or changing a SQL timeout without updating this map fails the build.
 */
// oxlint-disable-next-line anti-slop/no-known-value-widening -- Named SQL-interval contract indexed by pg function name at test time; the explicit Record IS the owner contract.
export const COMPANION_SQL_BUDGET_CONTRACT: Readonly<Record<string, readonly string[]>> = {
  // Control request approval window.
  companion_api_create_control_request: ["24 hours"],
  // turnAbsoluteDeadlineMs.
  companion_runtime_claim_work_without_material_guard: ["2 hours"],
  // Accepted activity timestamp skew allowance + inactivityStallMs.
  companion_runtime_checkpoint: ["5 minutes", "10 minutes"],
  // Event retention window + inactivityStallMs re-arm.
  companion_runtime_project_event_batch: ["24 hours", "10 minutes"],
  // Routine-lane inactivityStallMs re-arm.
  companion_runtime_project_event_batch_v2: ["10 minutes"],
  // inactivityStallMs re-arm after outputs are recorded.
  companion_runtime_record_attempt_outputs: ["10 minutes"],
  // inactivityStallMs re-armed for both the resumed turn and its delivery bookkeeping.
  companion_runtime_resume_after_decision_delivery: ["10 minutes", "10 minutes"],
  // Prepare grace (x2), materialMinTtlMs (x2), coldStartDeadlineMs.
  companion_runtime_prepare_queued_turn_material: [
    "2 minutes",
    "2 hours 5 minutes",
    "2 minutes",
    "2 hours 5 minutes",
    "3 minutes",
  ],
  // Enqueue-time material grace + materialMinTtlMs.
  companion_api_enqueue_turn: ["2 minutes", "2 hours 5 minutes"],
  // materialMinTtlMs + snapshot retention.
  companion_runtime_record_material_snapshot: ["2 hours 5 minutes", "7 days"],
  // Runtime-staged credential TTLs.
  companion_runtime_mint_hub_token: ["6 hours"],
  companion_runtime_mint_mcp_broker_token: ["6 hours"],
  companion_runtime_mint_control_token: ["6 hours"],
  // Settlement lease/backoff windows.
  companion_runtime_settle: ["30 seconds", "30 seconds", "15 seconds"],
  // Health observation windows + coldStartDeadlineMs + leaseSeconds.
  companion_runtime_observe_instance: ["5 minutes", "3 minutes", "30 seconds"],
  // coldStartDeadlineMs for the initial operation intent and explicit retry refresh.
  companion_runtime_assign_operation_intent: ["3 minutes", "3 minutes"],
  // Deferred-delete retry ladder.
  companion_runtime_defer_delete: ["5 seconds", "15 seconds", "30 seconds", "60 seconds"],
  // COMPANION_ROUTINE_MISSED_GRACE_MS twin.
  companion_fire_routine: ["10 minutes"],
  companion_runtime_expire_queued_routine_turns: ["10 minutes"],
  // COMPANION_TRIGGER_MIN_INTERVAL_MS twin.
  companion_api_fire_trigger: ["60 seconds"],
};

/**
 * `companion%` functions that carry `interval` literals but belong to *other* subsystems (skill
 * runs, projects, GitHub mirrors, billing, notifications, tickets, tokens, desktop replay) — outside the
 * Companions-runtime budget contract. Listing them explicitly keeps the integration test's default
 * strict: a brand-new interval literal in any unlisted function fails until it is registered here
 * or in {@link COMPANION_SQL_BUDGET_CONTRACT}.
 */
export const COMPANION_SQL_UNTRACKED_INTERVAL_FUNCTIONS: readonly string[] = [
  "companion_claim_github_sync_destinations",
  "companion_issue_public_skill_transfer_ticket",
  "companion_list_billing_sync_candidates",
  "companion_lock_api_token_for_refresh",
  "companion_notification_enqueue",
  "companion_runtime_consume_desktop_request",
];

/**
 * One latent budget violation that exists in production today. Each entry pins the *current*
 * numbers so the invariant tests assert the violation still holds: fixing the underlying values in
 * a later phase without deleting the entry fails loudly, and deleting the entry re-enables the
 * healthy invariant. `kind: "exceeds"` means `actualMs > boundMs`; `kind: "no_margin"` means
 * `actualMs >= boundMs` where a strict `<` (with margin) is the healthy relation.
 */
export interface CompanionBudgetExceedance {
  id: string;
  /** What is wrong and where the numbers live, for the human deleting the entry. */
  summary: string;
  actualMs: number;
  boundMs: number;
  kind: "exceeds" | "no_margin";
}

export const KNOWN_EXCEEDANCES: readonly CompanionBudgetExceedance[] = [
  {
    id: "cold_start_nominal_exceeds_deadline",
    summary:
      "Nominal cold path box-ready wait (120s default, boxCompanionRuntime.ts COMPANION_BOX_READY_TIMEOUT_MS) "
      + "plus Pi daemon activation (180s, PI_DAEMON_ACTIVE_TIMEOUT_MS) exceeds the 3-minute cold "
      + "start deadline; a Box that uses its full nominal waits always times the turn out.",
    actualMs: 120_000 + 180_000,
    boundMs: COMPANION_BUDGETS_BASE.coldStartDeadlineMs,
    kind: "exceeds",
  },
  {
    id: "exec_tool_timeout_equals_stall",
    summary:
      "COMPANION_EXEC_TOOL_RUN_TIMEOUT_MS equals the SQL inactivity stall exactly (600s == 600s): "
      + "a shell run that uses its full budget leaves zero margin for the timeout event to reach "
      + "the projection before the turn is declared stalled.",
    actualMs: COMPANION_BUDGETS_BASE.execToolRunTimeoutMs,
    boundMs: COMPANION_BUDGETS_BASE.inactivityStallMs,
    kind: "no_margin",
  },
  {
    id: "baker_exceeds_image_attempt_budget",
    summary:
      "Baker box-ready wait (900s, companionRuntimeBaker.ts BOX_READY_TIMEOUT_MS) plus snapshot "
      + "wait (600s, SNAPSHOT_READY_TIMEOUT_MS) exceeds the image build attempt budget "
      + "(1200s, imageBuildWorker.ts IMAGE_BUILD_ATTEMPT_BUDGET_MS).",
    actualMs: 900_000 + 600_000,
    boundMs: 20 * 60_000,
    kind: "exceeds",
  },
];
