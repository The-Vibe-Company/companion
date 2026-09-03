import { z } from "zod";

export const companionRuntimeErrorActionSchema = z.enum([
  "retry",
  "cancel",
  "restart_pi",
  "restart_box",
  "switch_model",
  "reconnect_provider",
  "none",
]);
export type CompanionRuntimeErrorAction = z.infer<typeof companionRuntimeErrorActionSchema>;

/** The complete error shape allowed to cross the Runtime v2 projection boundary. */
export const companionRuntimeSafeErrorSchema = z.object({
  code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  message: z.string().min(1)
    .refine(
      (value) => [...value].length <= 500,
      "Runtime error messages must be at most 500 Unicode code points",
    )
    .refine(
      (value) => !/[\r\n\0]/.test(value),
      "Runtime error messages must be a single line",
    ),
  action: companionRuntimeErrorActionSchema,
}).strict();
export type CompanionRuntimeSafeError = z.infer<typeof companionRuntimeSafeErrorSchema>;

export const companionTurnStatusSchema = z.enum([
  "queued",
  "admitted",
  "starting",
  "dispatching",
  "running",
  "needs_input",
  "succeeded",
  "failed",
  "interrupted",
  "cancelled",
]);
export type CompanionTurnStatus = z.infer<typeof companionTurnStatusSchema>;

/** Exact per-turn state of protocol-7 automatic cleanup. Optional during rolling deploys. */
export const companionRecoveryStatusSchema = z.enum(["pending", "running", "completed"]);
export type CompanionRecoveryStatus = z.infer<typeof companionRecoveryStatusSchema>;

export const companionTurnAttemptStatusSchema = z.enum([
  "starting",
  "dispatching",
  "running",
  "needs_input",
  "succeeded",
  "failed",
  "interrupted",
  "cancelled",
]);
export type CompanionTurnAttemptStatus = z.infer<typeof companionTurnAttemptStatusSchema>;

export const companionTurnDispatchStateSchema = z.enum([
  "pending",
  "write_intent",
  "accepted",
  "rejected",
  "ambiguous",
]);
export type CompanionTurnDispatchState = z.infer<typeof companionTurnDispatchStateSchema>;

const terminalTurnStatuses = new Set<CompanionTurnStatus>([
  "succeeded",
  "failed",
  "interrupted",
  "cancelled",
]);

const terminalAttemptStatuses = new Set<CompanionTurnAttemptStatus>([
  "succeeded",
  "failed",
  "interrupted",
  "cancelled",
]);

/** PostgreSQL JSON renders `timestamptz` with an explicit UTC offset rather than always `Z`. */
const companionRuntimeTimestampSchema = z.string().datetime({ offset: true });

function validateTerminalSettlement(
  value: {
    status: string;
    settled_at: string | null;
    error: CompanionRuntimeSafeError | null;
  },
  terminalStatuses: ReadonlySet<string>,
  context: z.RefinementCtx,
): void {
  const terminal = terminalStatuses.has(value.status);
  if (terminal !== (value.settled_at !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["settled_at"],
      message: "settled_at must be present exactly when runtime work is terminal",
    });
  }
  const failed = value.status === "failed" || value.status === "interrupted";
  if (failed !== (value.error !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["error"],
      message: "only failed or interrupted runtime work carries a safe error",
    });
  }
}

export const companionTurnAttemptSchema = z.object({
  id: z.string().uuid(),
  turn_id: z.string().uuid(),
  attempt_number: z.number().int().positive(),
  retry_id: z.string().uuid().nullable(),
  status: companionTurnAttemptStatusSchema,
  dispatch_state: companionTurnDispatchStateSchema,
  pi_invocation_id: z.string().min(1).max(200).nullable(),
  dispatch_accepted_at: companionRuntimeTimestampSchema.nullable(),
  error: companionRuntimeSafeErrorSchema.nullable(),
  started_at: companionRuntimeTimestampSchema,
  settled_at: companionRuntimeTimestampSchema.nullable(),
}).strict().superRefine((attempt, context) => {
  validateTerminalSettlement(attempt, terminalAttemptStatuses, context);
  if ((attempt.dispatch_state === "accepted") !== (attempt.dispatch_accepted_at !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["dispatch_accepted_at"],
      message: "dispatch_accepted_at must be present exactly after a positive Pi ACK",
    });
  }
});
export type CompanionTurnAttempt = z.infer<typeof companionTurnAttemptSchema>;

export const companionTurnSchema = z.object({
  id: z.string().uuid(),
  companion_id: z.string().uuid(),
  client_message_id: z.string().uuid(),
  status: companionTurnStatusSchema,
  /** Optional across rolling deploys; null means no automatic terminal cleanup proof yet. */
  resolution: z.literal("auto_abandoned").nullable().optional(),
  /** Automatic cleanup for this exact occurrence; never inferred from Companion-wide lifecycle. */
  recovery_status: companionRecoveryStatusSchema.nullable().catch(null).optional(),
  queue_sequence: z.number().int().positive(),
  latest_attempt: companionTurnAttemptSchema.nullable(),
  /** Runtime v3 owns Pi admission on the Turn itself and deliberately has no attempt row. */
  admission_state: z.enum(["pending", "accepted", "ambiguous"]).optional(),
  /** Present exactly after Runtime v3 has durably recorded a positive or ambiguous admission. */
  admitted_at: companionRuntimeTimestampSchema.nullable().optional(),
  /** Server-computed durable replying fact. Clients must not infer it from transcript tails. */
  replying: z.boolean(),
  error: companionRuntimeSafeErrorSchema.nullable(),
  external_block: z.object({
    classification: z.enum(["box", "model", "plugin_provider", "authority"]),
    source: z.enum(["main", "routine", "trigger", "delegation"]),
    message: z.string().min(1).max(500),
  }).strict().nullable().optional(),
  state_changed_at: companionRuntimeTimestampSchema,
  settled_at: companionRuntimeTimestampSchema.nullable(),
  created_at: companionRuntimeTimestampSchema,
  updated_at: companionRuntimeTimestampSchema,
}).strict().superRefine((turn, context) => {
  validateTerminalSettlement(turn, terminalTurnStatuses, context);
  const attempt = turn.latest_attempt;
  const v3Admission = turn.admission_state;
  if (
    v3Admission !== undefined
    && ((v3Admission === "pending") !== (turn.admitted_at == null))
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["admitted_at"],
      message: "Runtime v3 admitted_at is present exactly after Pi admission",
    });
  }
  if (turn.status === "admitted" && v3Admission !== "accepted") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["admission_state"],
      message: "admitted status requires positive Runtime v3 Pi admission",
    });
  }
  if (turn.resolution === "auto_abandoned" && turn.status !== "interrupted") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["resolution"],
      message: "auto_abandoned is valid only for an interrupted turn",
    });
  }
  if (turn.recovery_status === "completed" && turn.resolution !== "auto_abandoned") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["recovery_status"],
      message: "completed recovery requires an auto_abandoned interruption",
    });
  }
  if (
    (turn.recovery_status === "pending" || turn.recovery_status === "running")
    && (turn.status !== "interrupted" || turn.resolution === "auto_abandoned")
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["recovery_status"],
      message: "active recovery requires an unresolved interrupted turn",
    });
  }
  if (attempt !== null && attempt.turn_id !== turn.id) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["latest_attempt", "turn_id"],
      message: "latest_attempt must belong to its turn",
    });
  }
  const replyIsDurablyAccepted = turn.status === "running"
    && attempt?.status === "running"
    && attempt.dispatch_state === "accepted"
    && attempt.dispatch_accepted_at !== null;
  const v3ReplyIsDurablyAccepted = attempt === null
    && v3Admission === "accepted"
    && (turn.status === "admitted" || turn.status === "running")
    && turn.admitted_at != null;
  if (turn.replying && !replyIsDurablyAccepted && !v3ReplyIsDurablyAccepted) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["replying"],
      message: "replying requires a running turn with a positively acknowledged running attempt",
    });
  }
});
export type CompanionTurn = z.infer<typeof companionTurnSchema>;

const activeTurnStatuses = new Set<CompanionTurnStatus>([
  "admitted",
  "starting",
  "dispatching",
  "running",
  "needs_input",
]);

export const companionActiveTurnSchema = companionTurnSchema.refine(
  (turn) => activeTurnStatuses.has(turn.status),
  { path: ["status"], message: "active_turn must carry an active turn status" },
);
export type CompanionActiveTurn = z.infer<typeof companionActiveTurnSchema>;

export const companionQueuedTurnSchema = companionTurnSchema.refine(
  (turn) => turn.status === "queued",
  { path: ["status"], message: "queued turn must carry queued status" },
);
export type CompanionQueuedTurn = z.infer<typeof companionQueuedTurnSchema>;

export const companionInterruptedTurnSchema = companionTurnSchema.refine(
  (turn) => turn.status === "interrupted",
  { path: ["status"], message: "interrupted_turn must carry interrupted status" },
);
export type CompanionInterruptedTurn = z.infer<typeof companionInterruptedTurnSchema>;

export const companionOperationKindSchema = z.enum([
  "delete",
  "stop",
  "restart_pi",
  "restart_box",
  "start",
  "apply_settings",
]);
export type CompanionOperationKind = z.infer<typeof companionOperationKindSchema>;

export const companionOperationStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "interrupted",
  "cancelled",
]);
export type CompanionOperationStatus = z.infer<typeof companionOperationStatusSchema>;

export const companionOperationTriggerSchema = z.enum([
  "turn",
  "user",
  "settings",
  "recovery",
  "kill_switch",
]);
export type CompanionOperationTrigger = z.infer<typeof companionOperationTriggerSchema>;

const terminalOperationStatuses = new Set<CompanionOperationStatus>([
  "succeeded",
  "failed",
  "interrupted",
  "cancelled",
]);

export const companionOperationSchema = z.object({
  id: z.string().uuid(),
  companion_id: z.string().uuid(),
  request_id: z.string().uuid().nullable(),
  source_turn_id: z.string().uuid().nullable(),
  kind: companionOperationKindSchema,
  trigger: companionOperationTriggerSchema,
  status: companionOperationStatusSchema,
  queue_sequence: z.number().int().positive(),
  checkpoint: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  attempt_count: z.number().int().nonnegative(),
  error: companionRuntimeSafeErrorSchema.nullable(),
  created_at: companionRuntimeTimestampSchema,
  started_at: companionRuntimeTimestampSchema.nullable(),
  settled_at: companionRuntimeTimestampSchema.nullable(),
}).strict().superRefine((operation, context) => {
  validateTerminalSettlement(operation, terminalOperationStatuses, context);
});
export type CompanionOperation = z.infer<typeof companionOperationSchema>;

/**
 * Bounded lifecycle projection carried by ordinary Companion reads. The control plane exposes only
 * what a client needs to restore durable operation UI; provider checkpoints and request metadata do
 * not belong on the roster/thread read model.
 */
export const companionLatestOperationSchema = z.object({
  id: z.string().uuid(),
  source_turn_id: z.string().uuid().nullable(),
  kind: companionOperationKindSchema,
  status: companionOperationStatusSchema,
  error: companionRuntimeSafeErrorSchema.nullable(),
}).strict();
export type CompanionLatestOperation = z.infer<typeof companionLatestOperationSchema>;

export const companionOperationAcceptedResponseSchema = z.object({
  operation: companionOperationSchema,
}).strict();
export type CompanionOperationAcceptedResponse = z.infer<
  typeof companionOperationAcceptedResponseSchema
>;

/**
 * UUID carried by every explicit lifecycle request. Clients retain it until they receive the
 * accepted operation, so a lost `202` cannot enqueue the same destructive intent twice.
 */
export const COMPANION_OPERATION_IDEMPOTENCY_HEADER = "Idempotency-Key";
export const companionOperationRequestIdSchema = z.string().uuid();

export const retryCompanionTurnInputSchema = z.object({
  retry_id: z.string().uuid(),
}).strict();
export type RetryCompanionTurnInput = z.infer<typeof retryCompanionTurnInputSchema>;

/** Compatibility Retry observes or re-enqueues the same cleanup; it never creates an attempt. */
export const retryCompanionTurnAcceptedResponseSchema = companionOperationAcceptedResponseSchema;
export type RetryCompanionTurnAcceptedResponse = z.infer<
  typeof retryCompanionTurnAcceptedResponseSchema
>;

export const cancelCompanionTurnInputSchema = z.object({}).strict();
export type CancelCompanionTurnInput = z.infer<typeof cancelCompanionTurnInputSchema>;

/**
 * The two operator restart scopes exposed by Companion settings. `pi` recycles only the daemon in
 * an already-running Box; `box` restarts the whole machine. A continuation repeats an
 * already-accepted full-Box restart with the same idempotency header, without turning a delayed
 * client retry into a second restart.
 */
export const restartCompanionRuntimeInputSchema = z.discriminatedUnion("target", [
  z.object({ target: z.literal("pi") }).strict(),
  z.object({
    target: z.literal("box"),
    continuation: z.literal(true).optional(),
  }).strict(),
]);
export type RestartCompanionRuntimeInput = z.infer<typeof restartCompanionRuntimeInputSchema>;
