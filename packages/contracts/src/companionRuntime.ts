import { z } from "zod";

export const companionRuntimeErrorActionSchema = z.enum([
  "retry",
  "cancel",
  "restart_pi",
  "switch_model",
  "reconnect_provider",
  "none",
]);
export type CompanionRuntimeErrorAction = z.infer<typeof companionRuntimeErrorActionSchema>;

/** The complete error shape allowed to cross the Runtime v3 projection boundary. */
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
  "running",
  "needs_input",
  "succeeded",
  "failed",
  "interrupted",
  "cancelled",
]);
export type CompanionTurnStatus = z.infer<typeof companionTurnStatusSchema>;

/** Exact per-Turn state of fenced Pi recycle recovery. Optional during rolling deploys. */
export const companionRecoveryStatusSchema = z.enum(["pending", "running", "completed"]);
export type CompanionRecoveryStatus = z.infer<typeof companionRecoveryStatusSchema>;

const terminalTurnStatuses = new Set<CompanionTurnStatus>([
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
  const replyIsDurablyAccepted = v3Admission === "accepted"
    && (turn.status === "admitted" || turn.status === "running")
    && turn.admitted_at != null;
  if (turn.replying && !replyIsDurablyAccepted) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["replying"],
      message: "replying requires a Turn with positively acknowledged Pi admission",
    });
  }
});
export type CompanionTurn = z.infer<typeof companionTurnSchema>;

const activeTurnStatuses = new Set<CompanionTurnStatus>([
  "admitted",
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

/**
 * UUID carried by every explicit lifecycle request. Clients retain it until they receive the
 * accepted revision, so a lost `202` cannot enqueue the same destructive intent twice.
 */
export const COMPANION_LIFECYCLE_IDEMPOTENCY_HEADER = "Idempotency-Key";
export const companionLifecycleRequestIdSchema = z.string().uuid();

export const cancelCompanionTurnInputSchema = z.object({}).strict();
export type CancelCompanionTurnInput = z.infer<typeof cancelCompanionTurnInputSchema>;

/** Temporary rollout failsafe. Restart always means an asynchronous Pi-only recycle. */
export const restartCompanionRuntimeInputSchema = z.object({
  target: z.literal("pi"),
}).strict();
export type RestartCompanionRuntimeInput = z.infer<typeof restartCompanionRuntimeInputSchema>;

export const companionLifecycleIntentSchema = z.enum(["archive", "recycle_pi", "delete"]);
export type CompanionLifecycleIntent = z.infer<typeof companionLifecycleIntentSchema>;
export const companionLifecycleAcceptedSchema = z.object({
  intent: companionLifecycleIntentSchema,
  revision: z.string().regex(/^\d+$/),
}).strict();
export type CompanionLifecycleAccepted = z.infer<typeof companionLifecycleAcceptedSchema>;
