import { z } from "zod";

import { COMPANION_BUDGETS_BASE } from "./companionBudgets";

import {
  companionActiveTurnSchema,
  companionInterruptedTurnSchema,
  companionLatestOperationSchema,
  companionRuntimeSafeErrorSchema,
  companionTurnStatusSchema,
  companionTurnSchema,
} from "./companionRuntime";
import { sniffCommentImageMime } from "./skill";
import type { TokenScope } from "./token";

export const companionRuntimeStateSchema = z.enum([
  "not_created",
  "provisioning",
  "running",
  "stopping",
  "stopped",
  "error",
]);
export type CompanionRuntimeState = z.infer<typeof companionRuntimeStateSchema>;

export const companionDaemonStateSchema = z.enum(["unknown", "starting", "running", "stopped", "error"]);
export type CompanionDaemonState = z.infer<typeof companionDaemonStateSchema>;

export const companionAccessSchema = z.enum(["owner", "editor", "viewer"]);
export type CompanionAccess = z.infer<typeof companionAccessSchema>;
export const companionShareRoleSchema = z.enum(["editor", "viewer"]);
export type CompanionShareRole = z.infer<typeof companionShareRoleSchema>;

export const companionProviderIdSchema = z.string().trim().regex(/^[a-z][a-z0-9-]{0,62}$/);
export type CompanionProviderId = z.infer<typeof companionProviderIdSchema>;

export const companionProviderAuthMethodSchema = z.enum(["api_key", "subscription"]);
export type CompanionProviderAuthMethod = z.infer<typeof companionProviderAuthMethodSchema>;

export const companionModelIdSchema = z.string().trim().min(1).max(200).refine(
  (value) => !/[\r\n\0]/.test(value),
  "Model id must be a single line",
);
export type CompanionModelId = z.infer<typeof companionModelIdSchema>;

/** Input modalities reported by Pi's model catalog. */
export const companionModelInputSchema = z.enum(["text", "image"]);
export type CompanionModelInput = z.infer<typeof companionModelInputSchema>;

export const COMPANION_PROVIDER_CATALOG = [
  {
    id: "anthropic",
    name: "Claude",
    auth_methods: ["api_key", "subscription"],
    description: "Anthropic API key or Claude Pro/Max browser authentication.",
    models: [
      { id: "claude-opus-4-8", name: "Claude Opus 4.8", default: true },
      { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
      { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
    ],
  },
  {
    id: "openai-codex",
    name: "Codex",
    auth_methods: ["subscription"],
    description: "ChatGPT Plus/Pro device authentication.",
    models: [
      { id: "gpt-5.5", name: "GPT-5.5", default: true },
      { id: "gpt-5.4", name: "GPT-5.4" },
      { id: "gpt-5.4-mini", name: "GPT-5.4 mini" },
    ],
  },
  {
    id: "kimi-coding",
    name: "Kimi",
    auth_methods: ["api_key"],
    description: "Kimi For Coding API key.",
    models: [
      { id: "kimi-for-coding", name: "Kimi K2.7 Code", default: true },
      { id: "kimi-for-coding-highspeed", name: "Kimi For Coding HighSpeed" },
    ],
  },
  {
    id: "moonshotai",
    name: "Moonshot",
    auth_methods: ["api_key"],
    description: "Moonshot AI API key.",
    models: [
      { id: "kimi-k2.6", name: "Kimi K2.6", default: true },
      { id: "kimi-k2.7-code", name: "Kimi K2.7 Code" },
      { id: "kimi-k2.7-code-highspeed", name: "Kimi K2.7 Code HighSpeed" },
    ],
  },
  {
    id: "zai",
    name: "z.ai",
    auth_methods: ["api_key"],
    description: "z.ai API key, including Coding Plan keys.",
    models: [
      { id: "glm-4.7", name: "GLM-4.7", default: true },
      { id: "glm-5-turbo", name: "GLM-5-Turbo" },
      { id: "glm-5.3-flash", name: "GLM 5.3 Flash", input: ["text", "image"] },
    ],
  },
  {
    id: "openai",
    name: "OpenAI API",
    auth_methods: ["api_key"],
    description: "OpenAI API key.",
    models: [
      { id: "gpt-5.5", name: "GPT-5.5", default: true },
      { id: "gpt-5.4", name: "GPT-5.4" },
      { id: "gpt-5.4-mini", name: "GPT-5.4 mini" },
    ],
  },
  {
    id: "google",
    name: "Google Gemini",
    auth_methods: ["api_key"],
    description: "Google Gemini API key.",
    models: [
      { id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro Preview", default: true },
      { id: "gemini-3.1-flash-lite", name: "Gemini 3.1 Flash Lite" },
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    ],
  },
] as const satisfies ReadonlyArray<{
  id: string;
  name: string;
  auth_methods: readonly CompanionProviderAuthMethod[];
  description: string;
  models: ReadonlyArray<{
    id: string;
    name: string;
    default?: true;
    input?: readonly CompanionModelInput[];
  }>;
}>;

type CompanionProviderCatalogModel = {
  id: string;
  name: string;
  default?: true;
  input?: CompanionModelInput[];
};

/**
 * Curated stopgaps for models a supported provider has released before Pi publishes them.
 * Keep capabilities conservative here; a same-id Pi entry replaces this metadata during merge.
 */
export const COMPANION_PROVIDER_SUPPLEMENTARY_MODELS = {
  zai: [
    { id: "glm-5.3-flash", name: "GLM 5.3 Flash", input: ["text", "image"] },
  ],
} as const satisfies Partial<Record<
  (typeof COMPANION_PROVIDER_CATALOG)[number]["id"],
  ReadonlyArray<{
    id: string;
    name: string;
    default?: true;
    input?: readonly CompanionModelInput[];
  }>
>>;

/** Curated models fill catalog gaps; a same-id source entry remains authoritative. */
export function supplementCompanionProviderModels(
  providerId: string,
  models: ReadonlyArray<{
    id: string;
    name: string;
    default?: true;
    input?: readonly CompanionModelInput[];
  }>,
): CompanionProviderCatalogModel[] {
  const supplementary: ReadonlyArray<{
    id: string;
    name: string;
    default?: true;
    input?: readonly CompanionModelInput[];
  }> = Object.entries(COMPANION_PROVIDER_SUPPLEMENTARY_MODELS)
    .find(([candidateId]) => candidateId === providerId)?.[1] ?? [];
  const merged = new Map<string, CompanionProviderCatalogModel>();
  for (const model of [...supplementary, ...models]) {
    const clone: CompanionProviderCatalogModel = {
      id: model.id,
      name: model.name,
    };
    if (model.default !== undefined) clone.default = model.default;
    if (model.input !== undefined) clone.input = [...model.input];
    merged.set(model.id, clone);
  }
  return [...merged.values()];
}

export function companionProviderDefaultModel(providerId: string): string | undefined {
  return COMPANION_PROVIDER_CATALOG
    .find((provider) => provider.id === providerId)
    ?.models.find((model) => "default" in model && model.default)?.id;
}

export function companionProviderHasModel(providerId: string, modelId: string): boolean {
  return COMPANION_PROVIDER_CATALOG
    .find((provider) => provider.id === providerId)
    ?.models.some((model) => model.id === modelId) ?? false;
}

export const companionProviderDefinitionSchema = z.object({
  id: companionProviderIdSchema,
  name: z.string(),
  auth_methods: z.array(companionProviderAuthMethodSchema),
  description: z.string(),
  models: z.array(z.object({
    id: companionModelIdSchema,
    name: z.string(),
    default: z.literal(true).optional(),
    input: z.array(companionModelInputSchema).max(2).optional(),
  }).strict()).min(1),
});
export type CompanionProviderDefinition = z.infer<typeof companionProviderDefinitionSchema>;

export const companionProviderConnectionSchema = z.object({
  provider_id: companionProviderIdSchema,
  auth_method: companionProviderAuthMethodSchema,
  connected_by: z.string().nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type CompanionProviderConnection = z.infer<typeof companionProviderConnectionSchema>;

export const companionProvidersResponseSchema = z.object({
  catalog: z.array(companionProviderDefinitionSchema),
  connections: z.array(companionProviderConnectionSchema),
  default_provider_id: companionProviderIdSchema.nullable(),
  can_manage: z.boolean(),
});
export type CompanionProvidersResponse = z.infer<typeof companionProvidersResponseSchema>;

export const companionPersonaSchema = z.string().trim().max(280);

/**
 * Cosmetic Companion icon (THE-382). Four small indexes into fixed client-side catalogs: a blob
 * shape, a mouth, an accessory, and a color. Purely presentational — never sent to Pi, never part
 * of an operation snapshot — so changing it must not wake or restart anything.
 */
/* oxlint-disable anti-slop/no-shape-in-symbol-names -- Icon catalogs are literally geometric shapes; "shape" is the domain term here. */
export const COMPANION_ICON_SHAPE_COUNT = 8;
export const COMPANION_ICON_MOUTH_COUNT = 5;
export const COMPANION_ICON_ACCESSORY_COUNT = 7;
export const COMPANION_ICON_COLOR_COUNT = 11;

const companionIconIndex = (max: number) => z.number().int().min(0).max(max - 1);

export const companionIconSchema = z.object({
  shape: companionIconIndex(COMPANION_ICON_SHAPE_COUNT),
  mouth: companionIconIndex(COMPANION_ICON_MOUTH_COUNT),
  accessory: companionIconIndex(COMPANION_ICON_ACCESSORY_COUNT),
  color: companionIconIndex(COMPANION_ICON_COLOR_COUNT),
}).strict();
export type CompanionIcon = z.infer<typeof companionIconSchema>;

export const companionIconPatchSchema = z.object({
  shape: companionIconIndex(COMPANION_ICON_SHAPE_COUNT).optional(),
  mouth: companionIconIndex(COMPANION_ICON_MOUTH_COUNT).optional(),
  accessory: companionIconIndex(COMPANION_ICON_ACCESSORY_COUNT).optional(),
  color: companionIconIndex(COMPANION_ICON_COLOR_COUNT).optional(),
}).strict().refine(
  (icon) => icon.shape !== undefined || icon.mouth !== undefined
    || icon.accessory !== undefined || icon.color !== undefined,
  { message: "at least one icon field is required" },
);
export type CompanionIconPatch = z.infer<typeof companionIconPatchSchema>;

export const COMPANION_SECTION_NAME_MAX_CHARACTERS = 80;

export const companionSectionSchema = z.object({
  id: z.string().uuid(),
  org_id: z.string().uuid(),
  owner_id: z.string(),
  name: z.string().trim().min(1).max(COMPANION_SECTION_NAME_MAX_CHARACTERS),
  position: z.number().int().nonnegative(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
}).strict();
export type CompanionSection = z.infer<typeof companionSectionSchema>;

export const createCompanionSectionInputSchema = z.object({
  name: z.string().trim().min(1).max(COMPANION_SECTION_NAME_MAX_CHARACTERS),
}).strict();

export const updateCompanionSectionInputSchema = createCompanionSectionInputSchema;

export const reorderCompanionSectionsInputSchema = z.object({
  section_ids: z.array(z.string().uuid()).max(100).refine(
    (ids) => new Set(ids).size === ids.length,
    "section_ids must not contain duplicates",
  ),
}).strict();

export const assignCompanionSectionInputSchema = z.object({
  section_id: z.string().uuid().nullable(),
}).strict();

/** Exact Skills Hub skill ids a Companion may stage onto its Box. Empty = no library skills. */
export const companionSelectedSkillIdsSchema = z.array(z.string().uuid()).max(100);

/**
 * Exact already-connected MCP account ids a Companion may stage onto its Box.
 * Empty = no extra member MCP pins (adapter binary only).
 */
export const companionSelectedMcpAccountIdsSchema = z.array(z.string().uuid()).max(50);

/** How much of the newest chat line a conversation list carries. One line, cut to fit a row. */
export const COMPANION_LAST_MESSAGE_PREVIEW_MAX_CHARACTERS = 140;

/** Upper bounds for a Companion routine. Cron is validated in TypeScript, never in SQL. */
export const COMPANION_ROUTINE_NAME_MAX_CHARACTERS = 80;
export const COMPANION_ROUTINE_PROMPT_MAX_CHARACTERS = 16_384;
export const COMPANION_ROUTINE_CRON_MAX_CHARACTERS = 120;
export const COMPANION_ROUTINE_TIMEZONE_MAX_CHARACTERS = 64;
export const COMPANION_ROUTINE_MAX_PER_COMPANION = 10;
export const COMPANION_ROUTINE_MIN_INTERVAL_MS = 5 * 60 * 1000;
export const COMPANION_ROUTINE_MISSED_GRACE_MS = 10 * 60 * 1000;
export const COMPANION_ROUTINE_MAX_CONSECUTIVE_FAILURES = 5;

/**
 * A routine fire is represented by its ordinary Companion turn. Keeping this status contract in
 * the shared package means list/detail readers can describe the same ordered lifecycle as the main
 * thread without making a client know about the executor's private tables.
 */
export const companionRoutineRunStatusSchema = companionTurnStatusSchema;
export type CompanionRoutineRunStatus = z.infer<typeof companionRoutineRunStatusSchema>;

/**
 * Outcome of the routine's private execution and terminal surface protocol. `no_output` is an
 * explicit non-surfaced outcome; it must never be presented as a successful terminal return. The
 * executor uses `surfaced` only after the normalized return row and its main-thread entry commit.
 */
export const companionRoutineRunOutcomeSchema = z.enum([
  "pending",
  "no_output",
  "surfaced",
  "error",
]);
export type CompanionRoutineRunOutcome = z.infer<typeof companionRoutineRunOutcomeSchema>;

/** The only terminal surface modes a routine may return to its main Companion thread. */
export const companionRoutineSurfaceModeSchema = z.enum(["relay", "notify"]);
export type CompanionRoutineSurfaceMode = z.infer<typeof companionRoutineSurfaceModeSchema>;

/** Routine history is keyset-paginated so one long Pi transcript cannot exhaust an API/client. */
export const COMPANION_ROUTINE_RUN_ENTRY_PAGE_DEFAULT = 50;
export const COMPANION_ROUTINE_RUN_ENTRY_PAGE_MAX = 100;

/** Immutable routine identity carried by a run so history remains readable after deletion/rename. */
export const companionRoutineIdentitySnapshotSchema = z.object({
  id: z.string().uuid().nullable(),
  name: z.string().trim().min(1).max(COMPANION_ROUTINE_NAME_MAX_CHARACTERS),
}).strict();
export type CompanionRoutineIdentitySnapshot = z.infer<
  typeof companionRoutineIdentitySnapshotSchema
>;

/** A bounded entry from the routine-only transcript; main-thread surface payloads are not copied. */
export const companionRoutineRunEntrySchema = z.object({
  event_id: z.string().min(1).max(200),
  ordinal: z.number().int().nonnegative(),
  role: z.enum(["user", "assistant", "system", "tool", "decision"]),
  content: z.string().max(1_048_576),
  reasoning: z.string().max(16_000).nullable().default(null),
  tool: z.lazy(() => companionToolRunSchema).nullable().default(null),
  decision: z.lazy(() => companionDecisionSchema).nullable().default(null),
  created_at: z.string().datetime({ offset: true }),
}).strict().superRefine((entry, context) => {
  if ((entry.role === "tool") !== (entry.tool !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["tool"],
      message: "a routine tool entry carries a tool run and no other role may",
    });
  }
  if ((entry.role === "decision") !== (entry.decision !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["decision"],
      message: "a routine decision entry carries a decision and no other role may",
    });
  }
  if (entry.reasoning !== null && entry.role !== "assistant") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reasoning"],
      message: "only a routine assistant entry carries reasoning",
    });
  }
});
export type CompanionRoutineRunEntry = z.infer<typeof companionRoutineRunEntrySchema>;

const companionRoutineRunTimestamps = {
  created_at: z.string().datetime({ offset: true }),
  started_at: z.string().datetime({ offset: true }).nullable(),
  settled_at: z.string().datetime({ offset: true }).nullable(),
} as const;

/** Fields common to the bounded newest-first list and the full run detail. */
const companionRoutineRunFields = {
  run_id: z.string().uuid(),
  companion_id: z.string().uuid(),
  routine: companionRoutineIdentitySnapshotSchema,
  status: companionRoutineRunStatusSchema,
  outcome: companionRoutineRunOutcomeSchema,
  surface_mode: companionRoutineSurfaceModeSchema.nullable(),
  main_entry_event_id: z.string().min(1).max(200).nullable(),
  relay_turn_id: z.string().uuid().nullable(),
  ...companionRoutineRunTimestamps,
  error: companionRuntimeSafeErrorSchema.nullable(),
} as const;

function validateCompanionRoutineRunResult(
  run: {
    status: CompanionRoutineRunStatus;
    outcome: CompanionRoutineRunOutcome;
    surface_mode: CompanionRoutineSurfaceMode | null;
    main_entry_event_id: string | null;
    relay_turn_id: string | null;
  },
  context: z.RefinementCtx,
): void {
  const surfaced = run.outcome === "surfaced";
  if (
    surfaced !== (run.surface_mode !== null)
    || surfaced !== (run.main_entry_event_id !== null)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["surface_mode"],
      message: "a surfaced run carries exactly one terminal mode and main-thread entry reference",
    });
  }
  if ((run.surface_mode === "relay") !== (run.relay_turn_id !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["relay_turn_id"],
      message: "only relay mode creates a main-Pi turn",
    });
  }
  if (run.outcome === "no_output" && run.status !== "succeeded") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["outcome"],
      message: "no_output is a successful routine completion without a terminal return",
    });
  }
  if (run.outcome === "error" && !["failed", "interrupted", "cancelled"].includes(run.status)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["outcome"],
      message: "error outcome requires a failed, interrupted, or cancelled run",
    });
  }
}

export const companionRoutineRunSummarySchema = z.object(companionRoutineRunFields).strict()
  .superRefine(validateCompanionRoutineRunResult);
export type CompanionRoutineRunSummary = z.infer<typeof companionRoutineRunSummarySchema>;

export const companionRoutineRunDetailSchema = z.object({
  ...companionRoutineRunFields,
  /** One bounded page of internal Pi history; surfaced payloads remain main-thread references. */
  internal_entries: z.array(companionRoutineRunEntrySchema)
    .max(COMPANION_ROUTINE_RUN_ENTRY_PAGE_MAX),
  next_entry_cursor: z.number().int().nonnegative().nullable(),
}).strict().superRefine(validateCompanionRoutineRunResult);
export type CompanionRoutineRunDetail = z.infer<typeof companionRoutineRunDetailSchema>;

export const companionRoutineRunListSchema = z.object({
  runs: z.array(companionRoutineRunSummarySchema),
  next_cursor: z.string().uuid().nullable(),
}).strict();
export type CompanionRoutineRunList = z.infer<typeof companionRoutineRunListSchema>;

/** Bounded query input for the read-only routine history list. */
export const companionRoutineRunListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().uuid().optional(),
}).strict();
export type CompanionRoutineRunListQuery = z.infer<typeof companionRoutineRunListQuerySchema>;

/** Bounded keyset input for one routine run's private transcript page. */
export const companionRoutineRunDetailQuerySchema = z.object({
  entry_limit: z.coerce.number().int().min(1).max(COMPANION_ROUTINE_RUN_ENTRY_PAGE_MAX)
    .default(COMPANION_ROUTINE_RUN_ENTRY_PAGE_DEFAULT),
  entry_cursor: z.coerce.number().int().nonnegative().optional(),
}).strict();
export type CompanionRoutineRunDetailQuery = z.infer<
  typeof companionRoutineRunDetailQuerySchema
>;

/**
 * Upper bounds for a Companion trigger — the event-driven sibling of a routine. A trigger is a
 * named prompt an external webhook fires; the provider label only picks the UI mark and the
 * delivery-id header, never an authentication scheme.
 */
export const COMPANION_TRIGGER_NAME_MAX_CHARACTERS = 80;
export const COMPANION_TRIGGER_PROMPT_MAX_CHARACTERS = 16_384;
export const COMPANION_TRIGGER_MAX_PER_COMPANION = 10;
export const COMPANION_TRIGGER_MIN_INTERVAL_MS = 60 * 1000;
export const COMPANION_TRIGGER_MAX_CONSECUTIVE_FAILURES = 5;
export const COMPANION_TRIGGER_PAYLOAD_EXCERPT_MAX_CHARACTERS = 4_096;
export const COMPANION_TRIGGER_PROVIDERS = ["webhook", "linear", "github", "sentry", "custom"] as const;
export const companionTriggerProviderSchema = z.enum(COMPANION_TRIGGER_PROVIDERS);
export type CompanionTriggerProvider = z.infer<typeof companionTriggerProviderSchema>;

/**
 * Legacy provider labels retained as delivery hints for clients that still render provider marks.
 * They do not grant, require, or imply any external account or runtime capability.
 */
export const COMPANION_PLUGIN_TRIGGER_PROVIDERS = ["linear", "github", "sentry"] as const;


/**
 * The newest chat line on a Companion's thread, projected onto reads so a conversation list can say
 * who spoke last without opening every thread.
 *
 * Only a member message or a Pi reply qualifies. Tool runs and permission cards are deliberately not
 * projected: a list is read by everyone who can see the Companion, and a tool title is a command, a
 * path, or a URL, while a pending decision is a question nobody has answered yet. Neither belongs in
 * a preview line that is shown outside the thread it was written in. A scheduled routine's prompt is
 * hidden for the same reason: nobody wrote it in the thread, so the list names the routine instead.
 */
export const companionLastMessageSchema = z.object({
  /** First line of the message, collapsed and truncated; never the whole body. Empty when a routine wrote it. */
  preview: z.string().max(COMPANION_LAST_MESSAGE_PREVIEW_MAX_CHARACTERS),
  role: z.enum(["user", "assistant"]),
  /** Member who wrote it, so a reader can tell their own last word from someone else's. Null for Pi. */
  author_id: z.string().nullable(),
  author_name: z.string().nullable(),
  /**
   * Name of the routine that enqueued this message, when one did. The client shows the routine
   * rather than the preview, exactly as the thread does; the prompt itself never leaves the thread.
   */
  routine_name: z.string().max(COMPANION_ROUTINE_NAME_MAX_CHARACTERS).nullable().default(null),
  /**
   * Name of the trigger whose webhook enqueued this message, when one did. Masked exactly like a
   * routine: the list names the trigger and the composed prompt never leaves the thread.
   */
  trigger_name: z.string().max(COMPANION_TRIGGER_NAME_MAX_CHARACTERS).nullable().default(null),
  created_at: z.string().datetime(),
}).strict();
export type CompanionLastMessage = z.infer<typeof companionLastMessageSchema>;

/**
 * Every hosted Companion may use the whole Skills Hub API. There is no per-Companion grant and no
 * toggle to get wrong: the runtime mints a short-lived token carrying exactly these scopes on every
 * staging, acting as the member whose settings staged the Box, and each request re-checks that the
 * Companion still exists and that member still belongs to the organization.
 */
export const COMPANION_HUB_TOKEN_SCOPES: readonly TokenScope[] = [
  "skills:read",
  "skills:write",
  "secrets:read",
  "database:read",
  "database:write",
];

export const companionSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  /** One short line describing what this Companion is for; shown under the name in the list. */
  persona: z.string().nullable(),
  /**
   * Cosmetic blob icon shown wherever the Companion appears; never interpreted by the runtime.
   * Optional on reads so pre-THE-382 clients keep parsing; every current writer projects it.
   */
  icon: companionIconSchema.optional(),
  /** Null only for legacy rows created before a provider was selected. */
  model_id: companionModelIdSchema.nullable(),
  /**
   * Skills Hub packages this Companion is allowed to receive on its Box. The bundled Companion
   * agent skill is staged separately when the Box needs Skills Hub access and is not listed here.
   */
  selected_skill_ids: companionSelectedSkillIdsSchema,
  /**
   * Legacy THE-360 flag, always true now that Skills Hub access is unconditional. Kept on reads so
   * a surface that still displays it agrees with the token the Box actually receives.
   */
  can_write_skills: z.boolean(),
  /**
   * Already-connected member MCP accounts this Companion may receive on its Box. Detach never
   * disconnects the workspace/member plugin; credentials stay write-only at connect time.
   */
  selected_mcp_account_ids: companionSelectedMcpAccountIdsSchema,
  owner_id: z.string(),
  /** Owner-managed roster grouping. Null is the built-in Unassigned section. */
  section_id: z.string().uuid().nullable().optional(),
  access: companionAccessSchema,
  /**
   * Member-private list flags (THE-351). Pin/hide/unread belong to the reader, so Viewer and Owner
   * each keep their own roster order and badges. Hide never archives the Companion.
   */
  pinned: z.boolean(),
  hidden: z.boolean(),
  /** Optional during rolling deploys; current servers always project a concrete Boolean. */
  muted: z.boolean().optional(),
  unread: z.boolean(),
  /**
   * Newest chat line, or null when the thread is empty. Read paths project it; a mutation answers
   * about the settings it just wrote and carries null, so a surface that keeps a list merges this
   * field instead of replacing the row wholesale.
   */
  last_message: companionLastMessageSchema.nullable().default(null),
  runtime: z.object({
    /** Positive runtime identity generation. It is non-secret and safe in control-plane reads. */
    generation: z.number().int().positive(),
    state: companionRuntimeStateSchema,
    daemon_state: companionDaemonStateSchema,
    /**
     * The Pi-acknowledged replying fact from this Companion's active turn, so a roster surface can
     * animate without a thread read. False in every other state — `queued`, `starting`, and
     * `dispatching` never count as replying.
     */
    replying: z.boolean().default(false),
    box_id: z.string().nullable(),
    provider_ids: z.array(z.string()),
    provider_credential_generation: z.string().uuid().nullable(),
    disk_layout_version: z.number().int().nonnegative(),
    desktop_available: z.boolean(),
    /**
     * One sanitized line explaining an `error` state, so the surface never shows a bare status
     * word. Null in every other state. A Viewer receives a generic line instead of the operator
     * detail, and no configuration or credential material appears here for anyone.
     */
    last_error: z.string().nullable(),
    /**
     * Skill-list sync marker (THE-360 follow-up): `skills_applied_revision < skills_revision`
     * means the saved selection has not been staged onto the Box yet (it applies on the next
     * start; settings never wake a sleeping Box). `skills_last_error` carries one sanitized line
     * when a background restage failed; a Viewer receives a generic line instead.
     */
    skills_revision: z.number().int().positive(),
    skills_applied_revision: z.number().int().nonnegative(),
    skills_applied_at: z.string().datetime().nullable(),
    skills_last_error: z.string().nullable(),
    last_observed_at: z.string().datetime().nullable(),
    last_started_at: z.string().datetime().nullable(),
    last_stopped_at: z.string().datetime().nullable(),
    /** Latest durable lifecycle intent, sufficient to restore operation UI after navigation/reload. */
    latest_operation: companionLatestOperationSchema.nullable(),
  }),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type Companion = z.infer<typeof companionSchema>;

/**
 * Companion sharing is workspace-only: access is `private` (no row), `viewer`, or `editor` for the
 * whole organization. There are no per-member grants and no email invites — those were cut in
 * THE-329. Personal workspaces hide sharing entirely because the owner is the only member.
 */
export const companionSharesSchema = z.object({
  companion_id: z.string().uuid(),
  workspace_role: companionShareRoleSchema.nullable(),
});
export type CompanionShares = z.infer<typeof companionSharesSchema>;

export const setCompanionWorkspaceShareInputSchema = z.object({
  role: companionShareRoleSchema.nullable(),
}).strict();

/**
 * What one tool run touched, so a chip can name it in a word and pick its icon. `computer` is the
 * Box desktop Lux drives; `subagent` is a child agent the Companion delegated a piece of its work
 * to, which is the one kind a reader wants named rather than counted; `tool` is the honest fallback
 * for a name this catalog does not recognize, because a chip that guesses wrong is worse than one
 * that only says a run happened.
 */
export const companionToolRunKindSchema = z.enum([
  "shell",
  "file",
  "browse",
  "computer",
  "subagent",
  "tool",
]);
export type CompanionToolRunKind = z.infer<typeof companionToolRunKindSchema>;

/** A run is `running` until Pi reports its result; the chip spins until then. */
export const companionToolRunStatusSchema = z.enum(["running", "ok", "error", "timeout"]);
export type CompanionToolRunStatus = z.infer<typeof companionToolRunStatusSchema>;

/**
 * The longest one Pi tool may leave its transcript chip open without reporting a result. This is
 * deliberately shorter than the two-minute failure seen in production: the staged Pi extension
 * aborts the active turn while the control plane closes the chip without changing Box lifecycle.
 */
export const COMPANION_TOOL_RUN_TIMEOUT_MS = COMPANION_BUDGETS_BASE.toolRunTimeoutMs;

/**
 * Shell runs and delegated subagent runs get their own ceiling: a legitimate build, install, or test
 * sweep routinely outlives the 90-second default, a child agent working through a task of its own
 * always does, and killing either mid-flight loses real work. Both the staged Pi extension and the
 * control-plane settlement classify by the run's `kind`, so the two deadlines agree.
 */
export const COMPANION_EXEC_TOOL_RUN_TIMEOUT_MS = COMPANION_BUDGETS_BASE.execToolRunTimeoutMs;

/**
 * How much of a Box frame a transcript will carry. One downscaled JPEG per visual run stays inside
 * the row it belongs to, so it is read by exactly the readers who may read the thread and is removed
 * with the Companion; anything larger is dropped rather than stored.
 */
export const COMPANION_TOOL_RUN_SCREENSHOT_MAX_CHARACTERS = 196_608;

/**
 * A `data:` image URL and nothing else. The transcript hands this string straight to an `img`, so
 * the shape is enforced here rather than trusted: no remote origin, no `javascript:`, no SVG.
 */
const COMPANION_TOOL_RUN_SCREENSHOT_PATTERN = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/**
 * One tool run Pi performed inside a turn, projected from its RPC log. The chip reports the run; the
 * detail carries the arguments and the result excerpt behind a disclosure, and a visual run also
 * carries one frame of the Box desktop as it stood when the run ended.
 */
export const companionToolRunSchema = z.object({
  /** Pi's own id for the call, so the result that closes it finds the chip it belongs to. */
  call_id: z.string().min(1).max(200).nullable(),
  /**
   * A stored kind this build has never heard of reads as the generic one rather than failing.
   * The whole transcript is parsed as one array, so a strict enum would turn a single card written
   * by a newer runtime — during a rolling deploy, or after an API-only rollback — into a thread
   * nobody can open at all. Widening the catalog must never be able to do that.
   */
  kind: companionToolRunKindSchema.catch("tool"),
  /** Pi's tool name, verbatim, so an unrecognized tool still reports what actually ran. */
  name: z.string().min(1).max(120),
  /** One line naming what the run did: the command, the path, the URL. */
  title: z.string().max(300),
  status: companionToolRunStatusSchema,
  /** The disclosed body: arguments and the result excerpt, already truncated. */
  detail: z.string().max(16_000).nullable(),
  screenshot: z
    .string()
    .max(COMPANION_TOOL_RUN_SCREENSHOT_MAX_CHARACTERS)
    .regex(COMPANION_TOOL_RUN_SCREENSHOT_PATTERN)
    .nullable(),
}).strict();
export type CompanionToolRun = z.infer<typeof companionToolRunSchema>;

/**
 * What a permission card is asking about. Shell and file edits need Allow / Deny; a question needs
 * an answer; a config proposal needs Owner/Editor confirmation. Browse and computer stay ungated —
 * they already surface through THE-352 chips and the Computer panel rather than a broker card.
 */
export const companionDecisionKindSchema = z.enum([
  "shell",
  "file",
  "question",
  "config",
  "routine",
  "trigger",
  "control",
]);
export type CompanionDecisionKind = z.infer<typeof companionDecisionKindSchema>;

/** A card is pending until answered, expired, or cancelled by lifecycle/newer-message progress. */
export const companionDecisionStatusSchema = z.enum([
  "pending",
  "allowed",
  "denied",
  "answered",
  "expired",
  "cancelled",
]);
export type CompanionDecisionStatus = z.infer<typeof companionDecisionStatusSchema>;

/** Upper bound stored on `companion_decision_deliveries.proposal` and enforced before projection. */
export const COMPANION_CONFIG_PROPOSAL_MAX_BYTES = 16_384;
/**
 * Control requests wrap routine and trigger drafts whose prompt alone may contain 16,384
 * characters. JSON escaping can expand one character to six bytes, so keep a separate bounded
 * envelope large enough for the complete maximum-length draft.
 */
export const COMPANION_CONTROL_PROPOSAL_MAX_BYTES = 128 * 1_024;
/** Each add/remove/attach/detach list is a bounded set of already-known resource ids. */
export const COMPANION_CONFIG_PROPOSAL_MAX_IDS = 20;
/** Human-readable confirm copy Pi puts next to the structured proposal. */
export const COMPANION_CONFIG_PROPOSAL_SUMMARY_MAX_CHARACTERS = 300;
export const COMPANION_CONFIG_PROPOSAL_CONNECT_PROVIDERS = [
  "linear",
  "github",
  "notion",
  "conductor",
  "slack",
  "gmail",
  "sentry",
] as const;
export const companionConfigProposalConnectProviderSchema = z.enum(
  COMPANION_CONFIG_PROPOSAL_CONNECT_PROVIDERS,
);
export type CompanionConfigProposalConnectProvider =
  z.infer<typeof companionConfigProposalConnectProviderSchema>;

const companionConfigProposalIdListSchema = z.array(z.string().uuid()).max(
  COMPANION_CONFIG_PROPOSAL_MAX_IDS,
);

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * Structured Companion settings Pi may propose. `.strict()` refuses `can_write_skills`, `name`, and
 * `provider_id`. `connect_plugin` is exclusive of every other mutation field.
 */
export const companionConfigProposalSchema = z.object({
  kind: z.literal("config"),
  add_skill_ids: companionConfigProposalIdListSchema.optional(),
  remove_skill_ids: companionConfigProposalIdListSchema.optional(),
  attach_plugin_ids: companionConfigProposalIdListSchema.optional(),
  detach_plugin_ids: companionConfigProposalIdListSchema.optional(),
  model_id: companionModelIdSchema.optional(),
  persona: companionPersonaSchema.optional(),
  connect_plugin: z.object({
    server_name: companionConfigProposalConnectProviderSchema,
    reason: z.string().trim().min(1).max(280).optional(),
  }).strict().optional(),
}).strict().superRefine((proposal, context) => {
  if (utf8ByteLength(JSON.stringify(proposal)) > COMPANION_CONFIG_PROPOSAL_MAX_BYTES) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "config proposal exceeds 16 KiB",
    });
  }
  const mutationKeys = [
    "add_skill_ids",
    "remove_skill_ids",
    "attach_plugin_ids",
    "detach_plugin_ids",
    "model_id",
    "persona",
  ] as const;
  const hasMutation = mutationKeys.some((key) => proposal[key] !== undefined);
  if (proposal.connect_plugin !== undefined && hasMutation) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["connect_plugin"],
      message: "a plugin connection request cannot be mixed with other config changes",
    });
  }
  if (!hasMutation && proposal.connect_plugin === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "a config proposal must include at least one change",
    });
  }
});
export type CompanionConfigProposal = z.infer<typeof companionConfigProposalSchema>;

/** Pi `extension_ui_request` message for `companion:config:<op>`: confirm copy plus the proposal. */
export const companionConfigProposalMessageSchema = z.object({
  summary: z.string().trim().min(1).max(COMPANION_CONFIG_PROPOSAL_SUMMARY_MAX_CHARACTERS),
  proposal: companionConfigProposalSchema,
}).strict();
export type CompanionConfigProposalMessage = z.infer<typeof companionConfigProposalMessageSchema>;

export const companionRoutineNameSchema = z.string().trim().min(1).max(
  COMPANION_ROUTINE_NAME_MAX_CHARACTERS,
);
export const companionRoutinePromptSchema = z.string().trim().min(1).max(
  COMPANION_ROUTINE_PROMPT_MAX_CHARACTERS,
);
export const companionRoutineCronSchema = z.string().trim().min(1).max(
  COMPANION_ROUTINE_CRON_MAX_CHARACTERS,
);
export const companionRoutineTimezoneSchema = z.string().trim().min(1).max(
  COMPANION_ROUTINE_TIMEZONE_MAX_CHARACTERS,
);

export const companionRoutineSchema = z.object({
  id: z.string().uuid(),
  companion_id: z.string().uuid(),
  name: companionRoutineNameSchema,
  prompt: companionRoutinePromptSchema,
  cron: companionRoutineCronSchema,
  timezone: companionRoutineTimezoneSchema,
  enabled: z.boolean(),
  next_fire_at: z.string().datetime().nullable(),
  last_fired_at: z.string().datetime().nullable(),
  last_error_code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).nullable(),
  last_error_message: z.string().max(500).nullable(),
  last_error_at: z.string().datetime().nullable(),
  consecutive_failures: z.number().int().nonnegative(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
}).strict();
export type CompanionRoutine = z.infer<typeof companionRoutineSchema>;

/** Create/update payload. Cron and timezone are re-validated in TypeScript before SQL. */
export const companionRoutineDraftSchema = z.object({
  name: companionRoutineNameSchema,
  prompt: companionRoutinePromptSchema,
  cron: companionRoutineCronSchema,
  timezone: companionRoutineTimezoneSchema,
  enabled: z.boolean().default(true),
}).strict();
export type CompanionRoutineDraft = z.infer<typeof companionRoutineDraftSchema>;

export const createCompanionRoutineInputSchema = companionRoutineDraftSchema.extend({
  id: z.string().uuid(),
}).strict();
export type CreateCompanionRoutineInput = z.infer<typeof createCompanionRoutineInputSchema>;

export const updateCompanionRoutineInputSchema = companionRoutineDraftSchema.partial().strict();
export type UpdateCompanionRoutineInput = z.infer<typeof updateCompanionRoutineInputSchema>;

/**
 * Structured routine Pi may propose. `.strict()` refuses extra fields. Cron is stored as text;
 * the control plane parses it before create.
 */
export const companionRoutineProposalSchema = z.object({
  kind: z.literal("routine"),
  name: companionRoutineNameSchema,
  prompt: companionRoutinePromptSchema,
  cron: companionRoutineCronSchema,
  timezone: companionRoutineTimezoneSchema,
}).strict().superRefine((proposal, context) => {
  if (utf8ByteLength(JSON.stringify(proposal)) > COMPANION_CONFIG_PROPOSAL_MAX_BYTES) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "routine proposal exceeds 16 KiB",
    });
  }
});
export type CompanionRoutineProposal = z.infer<typeof companionRoutineProposalSchema>;

/** Pi `extension_ui_request` message for `companion:routine:<name>`: confirm copy plus the proposal. */
export const companionRoutineProposalMessageSchema = z.object({
  summary: z.string().trim().min(1).max(COMPANION_CONFIG_PROPOSAL_SUMMARY_MAX_CHARACTERS),
  proposal: companionRoutineProposalSchema,
}).strict();
export type CompanionRoutineProposalMessage = z.infer<typeof companionRoutineProposalMessageSchema>;

export const companionTriggerNameSchema = z.string().trim().min(1).max(
  COMPANION_TRIGGER_NAME_MAX_CHARACTERS,
);
export const companionTriggerPromptSchema = z.string().trim().min(1).max(
  COMPANION_TRIGGER_PROMPT_MAX_CHARACTERS,
);
export const companionTriggerModeSchema = z.enum(["notify", "relay"]);
export type CompanionTriggerMode = z.infer<typeof companionTriggerModeSchema>;

export const companionTriggerRegistrationStatusSchema = z.enum([
  "manual",
  "unregistered",
  "registered",
  "failed",
]);
export type CompanionTriggerRegistrationStatus = z.infer<
  typeof companionTriggerRegistrationStatusSchema
>;

export const COMPANION_TRIGGER_PROVIDER_ACCOUNT_PROVIDERS = ["github", "linear", "sentry"] as const;
export const companionTriggerProviderAccountProviderSchema = z.enum(
  COMPANION_TRIGGER_PROVIDER_ACCOUNT_PROVIDERS,
);
export const companionTriggerProviderAccountStatusSchema = z.enum(["connected", "disconnected"]);
export const companionTriggerProviderCredentialSourceSchema = z.enum(["mcp_oauth", "api_key"]);

/** Member-scoped authority to register provider webhooks; never attached to one Companion. */
export const companionTriggerProviderAccountSchema = z.object({
  id: z.string().uuid(),
  provider: companionTriggerProviderAccountProviderSchema,
  label: z.string().trim().min(1).max(40),
  credential_source: companionTriggerProviderCredentialSourceSchema,
  mcp_account_id: z.string().uuid().nullable(),
  status: companionTriggerProviderAccountStatusSchema,
  dependent_trigger_count: z.number().int().nonnegative(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
}).strict();
export type CompanionTriggerProviderAccount = z.infer<typeof companionTriggerProviderAccountSchema>;

export const createCompanionTriggerProviderAccountInputSchema = z.object({
  provider: companionTriggerProviderAccountProviderSchema,
  label: z.string().trim().min(1).max(40),
  credential: z.string().min(1).max(512).refine(
    (value) => !/[\r\n\0]/.test(value),
    "credential must be a single line",
  ),
}).strict();
export type CreateCompanionTriggerProviderAccountInput = z.infer<
  typeof createCompanionTriggerProviderAccountInputSchema
>;

/** Bounded legacy delivery metadata a trigger may carry. */
export const COMPANION_TRIGGER_MAX_EVENTS = 30;

export const companionTriggerTargetSchema = z.object({
  /** Repository hint as "owner/repo" for providers that support repository delivery. */
  repo: z.string().trim().max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+$/).optional(),
  /** Sentry organization/project slugs for project service-hook registration. */
  organization: z.string().trim().max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).optional(),
  project: z.string().trim().max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).optional(),
  /**
   * Provider webhook event names; "*" requests every event where supported. The provider has the
   * final word: an unknown name fails registration, never the trigger definition.
   */
  events: z.array(z.string().trim().regex(/^\*$|^[a-z_]{1,64}$/))
    .min(1)
    .max(COMPANION_TRIGGER_MAX_EVENTS)
    .optional(),
}).strict();
export type CompanionTriggerTarget = z.infer<typeof companionTriggerTargetSchema>;

/** Normalize optional legacy target metadata without coupling it to a provider or account. */
export function parseCompanionTriggerTarget(
  _provider: CompanionTriggerProvider,
  target: CompanionTriggerTarget | null | undefined,
): CompanionTriggerTarget | null {
  return target ?? null;
}

export const companionTriggerSchema = z.object({
  id: z.string().uuid(),
  companion_id: z.string().uuid(),
  name: companionTriggerNameSchema,
  prompt: companionTriggerPromptSchema,
  /** Older rows omit mode; readers treat those rows as relay. */
  mode: companionTriggerModeSchema.default("relay"),
  provider: companionTriggerProviderSchema.default("webhook"),
  /** Member-scoped trigger-provider authority. It is not attached to this Companion. */
  provider_account_id: z.string().uuid().nullable().default(null),
  /**
   * Legacy provider-side delivery metadata. A registration adapter may use it when supported.
   */
  target: z.lazy(() => companionTriggerTargetSchema).nullable().default(null),
  registration_status: companionTriggerRegistrationStatusSchema.default("manual"),
  enabled: z.boolean().default(true),
  /** Provider account used for the current remote registration, if any. */
  remote_hook_account_id: z.string().uuid().nullable().default(null),
  /** Provider-side hook identifier, if registration succeeded. */
  remote_hook_id: z.string().max(200).nullable().default(null),
  /** Bounded provider registration diagnostic; never a raw provider payload. */
  last_registration_error: z.string().max(500).nullable().default(null),
  /** Full URL an external service posts to. Null for Viewers. */
  webhook_url: z.string().url().nullable(),
  last_fired_at: z.string().datetime().nullable(),
  last_error_code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).nullable(),
  last_error_message: z.string().max(500).nullable(),
  last_error_at: z.string().datetime().nullable(),
  consecutive_failures: z.number().int().nonnegative(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
}).strict();
export type CompanionTrigger = z.infer<typeof companionTriggerSchema>;

/** Control/audit projections never expose the signed webhook endpoint. */
export function redactCompanionControlTrigger(trigger: CompanionTrigger): CompanionTrigger {
  return { ...trigger, webhook_url: null };
}

/** Create/update payload. The secret is always generated server-side, never client-supplied. */
export const companionTriggerDraftSchema = z.object({
  name: companionTriggerNameSchema,
  prompt: companionTriggerPromptSchema,
  mode: companionTriggerModeSchema.default("relay"),
  provider: companionTriggerProviderSchema.default("webhook"),
  /** Legacy broker field retained so already-pending proposals remain answerable after rollout. */
  provider_account_id: z.string().uuid().nullable().optional(),
  target: z.lazy(() => companionTriggerTargetSchema).nullable().optional(),
  enabled: z.boolean().default(true),
}).strict();
export type CompanionTriggerDraft = z.infer<typeof companionTriggerDraftSchema>;

export const createCompanionTriggerInputSchema = companionTriggerDraftSchema.extend({
  id: z.string().uuid().optional(),
}).strict();
export type CreateCompanionTriggerInput = z.infer<typeof createCompanionTriggerInputSchema>;

export const updateCompanionTriggerInputSchema = companionTriggerDraftSchema.partial().strict();
export type UpdateCompanionTriggerInput = z.infer<typeof updateCompanionTriggerInputSchema>;

/**
 * Structured trigger Pi may propose. `.strict()` refuses extra fields; the webhook secret does not
 * exist yet — approval generates it server-side.
 */
export const companionTriggerProposalSchema = z.object({
  kind: z.literal("trigger"),
  name: companionTriggerNameSchema,
  prompt: companionTriggerPromptSchema,
  mode: companionTriggerModeSchema.default("relay"),
  provider: companionTriggerProviderSchema.default("webhook"),
  provider_account_id: z.string().uuid().nullable().optional(),
  target: z.lazy(() => companionTriggerTargetSchema).optional(),
}).strict().superRefine((proposal, context) => {
  if (utf8ByteLength(JSON.stringify(proposal)) > COMPANION_CONFIG_PROPOSAL_MAX_BYTES) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "trigger proposal exceeds 16 KiB",
    });
  }
});
export type CompanionTriggerProposal = z.infer<typeof companionTriggerProposalSchema>;

/** Pi `extension_ui_request` message for `companion:trigger:<name>`: confirm copy plus the proposal. */
export const companionTriggerProposalMessageSchema = z.object({
  summary: z.string().trim().min(1).max(COMPANION_CONFIG_PROPOSAL_SUMMARY_MAX_CHARACTERS),
  proposal: companionTriggerProposalSchema,
}).strict();
export type CompanionTriggerProposalMessage = z.infer<typeof companionTriggerProposalMessageSchema>;

/** Product-owned mutations requested through the always-on Companion control MCP. */
export const companionControlRequestKindSchema = z.enum([
  "model_change",
  "plugin_connection",
  "routine_change",
  "trigger_change",
  "peer_access",
]);
export type CompanionControlRequestKind = z.infer<typeof companionControlRequestKindSchema>;

export const companionControlRequestStatusSchema = z.enum([
  "pending",
  "applying",
  "applied",
  "denied",
  "expired",
  "cancelled",
  "failed",
]);
export type CompanionControlRequestStatus = z.infer<typeof companionControlRequestStatusSchema>;

export type CompanionControlJsonValue =
  | null
  | boolean
  | number
  | string
  | CompanionControlJsonValue[]
  | { [key: string]: CompanionControlJsonValue };
export const companionControlJsonValueSchema: z.ZodType<CompanionControlJsonValue> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string(),
  z.array(companionControlJsonValueSchema),
  z.record(companionControlJsonValueSchema),
]));
export const companionControlJsonObjectSchema = z.record(companionControlJsonValueSchema);

export const companionControlProposalSchema = z.object({
  kind: z.literal("control"),
  request_kind: companionControlRequestKindSchema,
  action: z.string().trim().min(1).max(80).regex(/^[a-z][a-z0-9_]*$/),
  summary: z.string().trim().min(1).max(COMPANION_CONFIG_PROPOSAL_SUMMARY_MAX_CHARACTERS),
  payload: companionControlJsonObjectSchema,
}).strict().superRefine((proposal, context) => {
  if (utf8ByteLength(JSON.stringify(proposal)) > COMPANION_CONTROL_PROPOSAL_MAX_BYTES) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "control proposal exceeds 128 KiB",
    });
  }
});
export type CompanionControlProposal = z.infer<typeof companionControlProposalSchema>;

export const companionControlRequestSchema = z.object({
  id: z.string().uuid(),
  companion_id: z.string().uuid(),
  kind: companionControlRequestKindSchema,
  action: z.string().trim().min(1).max(80),
  summary: z.string().trim().min(1).max(COMPANION_CONFIG_PROPOSAL_SUMMARY_MAX_CHARACTERS),
  payload: companionControlJsonObjectSchema,
  status: companionControlRequestStatusSchema,
  requested_by_id: z.string(),
  decided_by_id: z.string().nullable(),
  result: companionControlJsonObjectSchema.nullable(),
  error_code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).nullable(),
  error_message: z.string().max(500).nullable(),
  expires_at: z.string().datetime(),
  decided_at: z.string().datetime().nullable(),
  applied_at: z.string().datetime().nullable(),
  continuation_turn_id: z.string().uuid().nullable().optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
}).strict();
export type CompanionControlRequest = z.infer<typeof companionControlRequestSchema>;

export const companionPeerGrantSchema = z.object({
  id: z.string().uuid(),
  source_companion_id: z.string().uuid(),
  target_companion_id: z.string().uuid(),
  target_name: z.string().min(1).max(120),
  granted_by_id: z.string(),
  created_at: z.string().datetime(),
  revoked_at: z.string().datetime().nullable(),
}).strict();
export type CompanionPeerGrant = z.infer<typeof companionPeerGrantSchema>;

export const companionDelegationResponseModeSchema = z.enum(["relay", "notify"]);
export type CompanionDelegationResponseMode = z.infer<
  typeof companionDelegationResponseModeSchema
>;
export const companionDelegationDeliveryStatusSchema = z.enum([
  "pending",
  "delivered",
  "failed",
]);
export const companionDelegationSchema = z.object({
  id: z.string().uuid(),
  source_companion_id: z.string().uuid().nullable(),
  source_companion_name: z.string().min(1).max(120),
  target_companion_id: z.string().uuid().nullable(),
  target_companion_name: z.string().min(1).max(120),
  source_turn_id: z.string().uuid(),
  target_turn_id: z.string().uuid(),
  root_turn_id: z.string().uuid(),
  parent_delegation_id: z.string().uuid().nullable(),
  depth: z.number().int().min(1).max(4),
  response_mode: companionDelegationResponseModeSchema,
  status: companionTurnStatusSchema,
  delivery_status: companionDelegationDeliveryStatusSchema,
  created_at: z.string().datetime(),
  settled_at: z.string().datetime().nullable(),
}).strict();
export type CompanionDelegation = z.infer<typeof companionDelegationSchema>;

export const companionDelegationListSchema = z.object({
  delegations: z.array(companionDelegationSchema),
  next_cursor: z.string().uuid().nullable(),
}).strict();

export const companionControlRoutineActionSchema = z.enum([
  "create", "update", "enable", "disable", "delete",
]);
export const companionControlTriggerActionSchema = z.enum([
  "create", "update", "enable", "disable", "delete", "rotate_secret",
]);

export const companionRequestRoutineChangeInputSchema = z.object({
  action: companionControlRoutineActionSchema,
  routine_id: z.string().uuid().optional(),
  draft: companionRoutineDraftSchema.partial().optional(),
}).strict().superRefine((value, context) => {
  if (value.action !== "create" && value.routine_id === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["routine_id"],
      message: "routine_id is required for an existing routine",
    });
  }
  if (value.action === "create" && !companionRoutineDraftSchema.safeParse(value.draft).success) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["draft"],
      message: "a complete routine draft is required for create",
    });
  }
  if (value.action === "update" && value.draft === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["draft"],
      message: "draft is required for update",
    });
  }
});
export const companionRequestTriggerChangeInputSchema = z.object({
  action: companionControlTriggerActionSchema,
  trigger_id: z.string().uuid().optional(),
  draft: companionTriggerDraftSchema.partial().optional(),
}).strict().superRefine((value, context) => {
  if (value.action !== "create" && value.trigger_id === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["trigger_id"],
      message: "trigger_id is required for an existing trigger",
    });
  }
  if (value.action === "create" && !companionTriggerDraftSchema.safeParse(value.draft).success) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["draft"],
      message: "a complete trigger draft is required for create",
    });
  }
  if (value.action === "update" && value.draft === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["draft"],
      message: "draft is required for update",
    });
  }
});
export const companionSendPeerMessageInputSchema = z.object({
  target_companion_id: z.string().uuid(),
  content: z.string().trim().min(1).max(16_384),
  response_mode: companionDelegationResponseModeSchema.default("relay"),
}).strict();

/**
 * Trigger history follows the same durable turn lifecycle as routine history. The trigger snapshot
 * keeps a deleted or renamed definition readable, while the outcome names the one user-visible
 * terminal surface (or an explicit no-output completion).
 */
export const companionTriggerRunStatusSchema = companionTurnStatusSchema;
export type CompanionTriggerRunStatus = z.infer<typeof companionTriggerRunStatusSchema>;

export const companionTriggerRunOutcomeSchema = z.enum([
  "pending",
  "no_output",
  "surfaced",
  "error",
]);
export type CompanionTriggerRunOutcome = z.infer<typeof companionTriggerRunOutcomeSchema>;

export const COMPANION_TRIGGER_RUN_ENTRY_PAGE_DEFAULT = 50;
export const COMPANION_TRIGGER_RUN_ENTRY_PAGE_MAX = 100;

/** Immutable trigger identity carried by each history row. */
export const companionTriggerIdentitySnapshotSchema = z.object({
  id: z.string().uuid().nullable(),
  name: companionTriggerNameSchema,
}).strict();
export type CompanionTriggerIdentitySnapshot = z.infer<
  typeof companionTriggerIdentitySnapshotSchema
>;

/** A bounded entry from the trigger-only transcript; surfaced payloads remain in the main thread. */
export const companionTriggerRunEntrySchema = z.object({
  event_id: z.string().min(1).max(200),
  ordinal: z.number().int().nonnegative(),
  role: z.enum(["user", "assistant", "system", "tool", "decision"]),
  content: z.string().max(1_048_576),
  reasoning: z.string().max(16_000).nullable().default(null),
  tool: z.lazy(() => companionToolRunSchema).nullable().default(null),
  decision: z.lazy(() => companionDecisionSchema).nullable().default(null),
  created_at: z.string().datetime({ offset: true }),
}).strict().superRefine((entry, context) => {
  if ((entry.role === "tool") !== (entry.tool !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["tool"],
      message: "a trigger tool entry carries a tool run and no other role may",
    });
  }
  if ((entry.role === "decision") !== (entry.decision !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["decision"],
      message: "a trigger decision entry carries a decision and no other role may",
    });
  }
  if (entry.reasoning !== null && entry.role !== "assistant") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reasoning"],
      message: "only a trigger assistant entry carries reasoning",
    });
  }
});
export type CompanionTriggerRunEntry = z.infer<typeof companionTriggerRunEntrySchema>;

const companionTriggerRunFields = {
  run_id: z.string().uuid(),
  companion_id: z.string().uuid(),
  trigger: companionTriggerIdentitySnapshotSchema,
  status: companionTriggerRunStatusSchema,
  mode: companionTriggerModeSchema,
  outcome: companionTriggerRunOutcomeSchema,
  surface_mode: companionTriggerModeSchema.nullable(),
  /** Present when notify or relay produced a main-thread entry. */
  main_entry_event_id: z.string().min(1).max(200).nullable(),
  /** Present only for a relay outcome that creates a main-Pi turn. */
  relay_turn_id: z.string().uuid().nullable(),
  created_at: z.string().datetime({ offset: true }),
  started_at: z.string().datetime({ offset: true }).nullable(),
  settled_at: z.string().datetime({ offset: true }).nullable(),
  error: companionRuntimeSafeErrorSchema.nullable(),
} as const;

function validateCompanionTriggerRunResult(
  run: {
    status: CompanionTriggerRunStatus;
    outcome: CompanionTriggerRunOutcome;
    surface_mode: CompanionTriggerMode | null;
    main_entry_event_id: string | null;
    relay_turn_id: string | null;
  },
  context: z.RefinementCtx,
): void {
  const surfaced = run.outcome === "surfaced";
  if (surfaced !== (run.surface_mode !== null)
      || surfaced !== (run.main_entry_event_id !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["surface_mode"],
      message: "a surfaced trigger run carries one terminal mode and main-thread entry",
    });
  }
  if ((run.surface_mode === "relay") !== (run.relay_turn_id !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["relay_turn_id"],
      message: "only relay mode creates a main-Pi turn",
    });
  }
  if (run.outcome === "no_output" && run.status !== "succeeded") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["outcome"],
      message: "no_output is a successful trigger completion without a terminal return",
    });
  }
  if (run.outcome === "no_output"
      && (run.main_entry_event_id !== null || run.relay_turn_id !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["outcome"],
      message: "no_output carries no main-thread entry or relay turn",
    });
  }
  if (run.outcome === "error" && !["failed", "interrupted", "cancelled"].includes(run.status)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["outcome"],
      message: "error outcome requires a failed, interrupted, or cancelled run",
    });
  }
}

export const companionTriggerRunSummarySchema = z.object(companionTriggerRunFields).strict()
  .superRefine(validateCompanionTriggerRunResult);
export type CompanionTriggerRunSummary = z.infer<typeof companionTriggerRunSummarySchema>;

export const companionTriggerRunDetailSchema = z.object({
  ...companionTriggerRunFields,
  internal_entries: z.array(companionTriggerRunEntrySchema)
    .max(COMPANION_TRIGGER_RUN_ENTRY_PAGE_MAX),
  next_entry_cursor: z.number().int().nonnegative().nullable(),
}).strict().superRefine(validateCompanionTriggerRunResult);
export type CompanionTriggerRunDetail = z.infer<typeof companionTriggerRunDetailSchema>;

export const companionTriggerRunListSchema = z.object({
  runs: z.array(companionTriggerRunSummarySchema),
  next_cursor: z.string().uuid().nullable(),
}).strict();
export type CompanionTriggerRunList = z.infer<typeof companionTriggerRunListSchema>;

/** Bounded query input for the read-only trigger history list. */
export const companionTriggerRunListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().uuid().optional(),
}).strict();
export type CompanionTriggerRunListQuery = z.infer<typeof companionTriggerRunListQuerySchema>;

/** Bounded keyset input for one trigger run's private transcript page. */
export const companionTriggerRunDetailQuerySchema = z.object({
  entry_limit: z.coerce.number().int().min(1).max(COMPANION_TRIGGER_RUN_ENTRY_PAGE_MAX)
    .default(COMPANION_TRIGGER_RUN_ENTRY_PAGE_DEFAULT),
  entry_cursor: z.coerce.number().int().nonnegative().optional(),
}).strict();
export type CompanionTriggerRunDetailQuery = z.infer<
  typeof companionTriggerRunDetailQuerySchema
>;

export const companionDecisionProposalSchema = z.union([
  companionConfigProposalSchema,
  companionRoutineProposalSchema,
  companionTriggerProposalSchema,
  companionControlProposalSchema,
]);
export type CompanionDecisionProposal = z.infer<typeof companionDecisionProposalSchema>;

/**
 * One permission request Pi blocked on, projected from an `extension_ui_request` in the RPC log.
 * The transcript keeps the decision after refresh and for Viewers; only Owner/Editor may act while
 * the card is still pending.
 */
export const companionDecisionSchema = z.object({
  /** Pi's extension UI request id — also the key the FIFO response must echo. */
  request_id: z.string().min(1).max(200),
  kind: companionDecisionKindSchema,
  /** Tool name Pi was about to run, or `ask_user` for a question. */
  name: z.string().min(1).max(120),
  /** One line naming what was requested: the command, the path, or the question. */
  title: z.string().max(300),
  detail: z.string().max(16_000).nullable(),
  status: companionDecisionStatusSchema,
  /** Free-form answer when `kind` is `question` and the card was answered. */
  answer: z.string().max(8_000).nullable(),
  decided_by_id: z.string().nullable(),
  decided_by_name: z.string().nullable(),
  decided_at: z.string().datetime().nullable(),
  expires_at: z.string().datetime(),
  /** Minimum Companion ACL allowed to answer this card. */
  required_access: z.enum(["owner", "editor"]).optional(),
  /** Asynchronous product-control state; absent on Pi's blocking permission cards. */
  control_status: companionControlRequestStatusSchema.nullable().optional(),
  /** Present on `config`, `routine`, and `trigger` cards; null on shell, file, and question. */
  proposal: companionDecisionProposalSchema.nullable().default(null),
}).strict().superRefine((decision, context) => {
  if (decision.kind === "config") {
    if (decision.proposal === null || decision.proposal.kind !== "config") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["proposal"],
        message: "a config card carries the proposed settings",
      });
    }
  } else if (decision.kind === "routine") {
    if (decision.proposal === null || decision.proposal.kind !== "routine") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["proposal"],
        message: "a routine card carries the proposed schedule",
      });
    }
  } else if (decision.kind === "trigger") {
    if (decision.proposal === null || decision.proposal.kind !== "trigger") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["proposal"],
        message: "a trigger card carries the proposed webhook trigger",
      });
    }
  } else if (decision.kind === "control") {
    if (decision.proposal === null || decision.proposal.kind !== "control") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["proposal"],
        message: "a control card carries the requested Companion mutation",
      });
    }
  } else if (decision.proposal !== null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["proposal"],
      message: "only a config, routine, trigger, or control card may carry a proposal",
    });
  }
});
export type CompanionDecision = z.infer<typeof companionDecisionSchema>;

/** Owner/Editor answer to a pending permission card. Viewers are refused before this is parsed. */
export const decideCompanionDecisionInputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("allow") }).strict(),
  z.object({ action: z.literal("deny") }).strict(),
  z.object({
    action: z.literal("answer"),
    answer: z.string().trim().min(1).max(8_000),
  }).strict(),
]);
export type DecideCompanionDecisionInput = z.infer<typeof decideCompanionDecisionInputSchema>;

/**
 * How much of a turn's thinking a transcript will carry. Reasoning is disclosure, not the reply: it
 * is kept long enough to read why Pi did something and short enough that a thread of them stays a
 * cheap read for every poll.
 */
export const COMPANION_REASONING_MAX_CHARACTERS = 16_000;

/**
 * Where one transcript attachment came from. `user_upload` is a file a member sent with a message and
 * the runtime stages read-only on the Box; `pi_output` is an image Pi produced and left in its outbox
 * during a turn. The two kinds are stored in one table and separated by this discriminator, because a
 * reader must never be able to mistake something Pi wrote for something a member vouched for.
 */
export const companionAttachmentKindSchema = z.enum(["user_upload", "pi_output"]);
export type CompanionAttachmentKind = z.infer<typeof companionAttachmentKindSchema>;

/** How many files one send may carry, and how large each may be. */
export const COMPANION_MESSAGE_ATTACHMENT_MAX_COUNT = 5;
export const COMPANION_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

/**
 * How much Pi may hand back from one turn. Harvesting is bounded before any transfer starts, so a Box
 * that fills its outbox cannot turn one reply into an unbounded read: at most ten files, each within
 * the per-file ceiling.
 *
 * The total below is the product of those two, so it is a restatement rather than an independent
 * third bound — today no set that satisfies both can exceed it. It is enforced anyway, in TypeScript
 * and in SQL, because the count and the per-file ceiling are the numbers people raise, and the total
 * is the one anybody sizing a process or a bucket reasons about. Keep the SQL literals in
 * `0098`/`0099` in step with it.
 */
export const COMPANION_OUTPUT_ATTACHMENT_MAX_COUNT = 10;
export const COMPANION_OUTPUT_ATTACHMENT_TOTAL_MAX_BYTES = COMPANION_OUTPUT_ATTACHMENT_MAX_COUNT
  * COMPANION_ATTACHMENT_MAX_BYTES;

/** Images a member may send and the only types Pi may hand back. */
export const COMPANION_ATTACHMENT_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

/**
 * Documents a member may send. Pi reads these off the Box disk, so the list is exactly the formats a
 * coding agent can open without a converter, and every one of them is either magic-byte identifiable
 * (PDF) or required to be valid UTF-8 text.
 */
export const COMPANION_ATTACHMENT_DOCUMENT_MIME_TYPES = [
  "application/pdf",
  "text/csv",
  "text/plain",
  "text/markdown",
  "application/json",
] as const;

export const COMPANION_ATTACHMENT_MIME_TYPES = [
  ...COMPANION_ATTACHMENT_IMAGE_MIME_TYPES,
  ...COMPANION_ATTACHMENT_DOCUMENT_MIME_TYPES,
] as const;

export const companionAttachmentContentTypeSchema = z.enum(COMPANION_ATTACHMENT_MIME_TYPES);
export type CompanionAttachmentContentType = z.infer<typeof companionAttachmentContentTypeSchema>;

export function isCompanionAttachmentImage(contentType: string): boolean {
  // SAFETY: every member of the const MIME tuple is a string; this cast only widens it for includes().
  return (COMPANION_ATTACHMENT_IMAGE_MIME_TYPES as readonly string[]).includes(contentType);
}

const COMPANION_ATTACHMENT_EXTENSION_TO_MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".json": "application/json",
} satisfies Record<string, CompanionAttachmentContentType>;

/**
 * The type a client claims for one part, used only to refuse an obviously unsupported file before its
 * bytes are read. The stored type always comes from `sniffCompanionAttachmentMime` instead, so a
 * declared type is never what gets persisted or served back.
 */
export function declaredCompanionAttachmentContentType(
  file: { type: string; name: string },
): CompanionAttachmentContentType | null {
  const declared = file.type.split(";")[0]?.trim().toLowerCase() ?? "";
  // SAFETY: every member of the const MIME tuple is a string; this cast only widens it for includes().
  if ((COMPANION_ATTACHMENT_MIME_TYPES as readonly string[]).includes(declared)) {
    // SAFETY: includes() above confirmed `declared` is one of the MIME tuple members.
    return declared as CompanionAttachmentContentType;
  }
  const extension = file.name.toLowerCase().match(/\.[^.]+$/)?.[0];
  if (extension && extension in COMPANION_ATTACHMENT_EXTENSION_TO_MIME) {
    // SAFETY: the `in` check above guarantees extension is one of this table's literal keys.
    return COMPANION_ATTACHMENT_EXTENSION_TO_MIME[
      extension as keyof typeof COMPANION_ATTACHMENT_EXTENSION_TO_MIME
    ]!;
  }
  return null;
}

/**
 * True when the bytes are well-formed UTF-8 carrying no control character a text file has any business
 * containing (tab, newline, and carriage return are the exceptions). A disguised binary therefore
 * cannot be stored as `text/plain` and staged for Pi to read, and a document that does reach the Box
 * is one Pi can open as text.
 *
 * This walks the bytes rather than decoding them: the package is a dependency-free contract shared by
 * the API, the runtime, and the browser bundle, so it may not assume a `TextDecoder`.
 */
export function isUtf8TextAttachment(bytes: Uint8Array): boolean {
  for (let index = 0; index < bytes.length;) {
    const byte = bytes[index]!;
    if (byte < 0x80) {
      if (byte === 0x7f) return false;
      if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) return false;
      index += 1;
      continue;
    }
    // Sequence length plus the smallest code point it may legally encode, so overlong forms,
    // surrogates, and truncated tails are all refused instead of silently replaced.
    let length: number;
    let codePoint: number;
    if (byte >= 0xc2 && byte <= 0xdf) {
      length = 2;
      codePoint = byte & 0x1f;
    } else if (byte >= 0xe0 && byte <= 0xef) {
      length = 3;
      codePoint = byte & 0x0f;
    } else if (byte >= 0xf0 && byte <= 0xf4) {
      length = 4;
      codePoint = byte & 0x07;
    } else {
      return false;
    }
    if (index + length > bytes.length) return false;
    for (let offset = 1; offset < length; offset += 1) {
      const continuation = bytes[index + offset]!;
      if ((continuation & 0xc0) !== 0x80) return false;
      codePoint = (codePoint << 6) | (continuation & 0x3f);
    }
    const minimum = length === 2 ? 0x80 : length === 3 ? 0x800 : 0x10000;
    if (codePoint < minimum || codePoint > 0x10ffff) return false;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) return false;
    index += length;
  }
  return true;
}

/**
 * Resolve the type one attachment will be stored and served as, from its bytes alone.
 *
 * Images and PDFs are identified by magic numbers, so a fake extension cannot smuggle a different
 * format past the allowlist. The text formats have no magic number to check, so the declared type is
 * honored only for bytes that are well-formed UTF-8 text. `null` means the bytes are not one of the
 * supported attachment formats and must be refused before anything is stored.
 */
export function sniffCompanionAttachmentMime(
  bytes: Uint8Array,
  declared: CompanionAttachmentContentType | null,
): CompanionAttachmentContentType | null {
  const image = sniffCommentImageMime(bytes);
  if (image) return image;
  // PDF: "%PDF-"
  if (
    bytes.length >= 5
    && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46
    && bytes[4] === 0x2d
  ) return "application/pdf";
  if (declared === null || declared === "application/pdf" || isCompanionAttachmentImage(declared)) {
    return null;
  }
  return isUtf8TextAttachment(bytes) ? declared : null;
}

/** The longest stored filename. Long enough to stay recognizable, short enough to name in a prompt. */
export const COMPANION_ATTACHMENT_FILENAME_MAX_CHARACTERS = 80;

/**
 * The exact charset a stored attachment filename may use. It is enforced here, in a database CHECK,
 * and by the sanitizer below, because the name is interpolated into a Box path and into the prompt
 * suffix that tells Pi where the file is: a charset this narrow leaves nothing to quote or escape.
 */
export const COMPANION_ATTACHMENT_FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

/**
 * Reduce a client-supplied filename to the stored one, once, at upload. Everything downstream — the
 * Box path, the prompt suffix, the read route's `Content-Disposition` — uses this result verbatim
 * rather than sanitizing again, so there is one rule and one place it is applied.
 */
export function sanitizeCompanionAttachmentFilename(input: {
  filename: string;
  position: number;
  contentType: CompanionAttachmentContentType;
}): string {
  const normalized = input.filename.normalize("NFC").replaceAll(/[^A-Za-z0-9._-]/g, "_")
    // A leading dot would stage a dotfile Pi's own tooling hides from an ordinary listing.
    .replace(/^[.\-_]+/, "")
    .slice(0, COMPANION_ATTACHMENT_FILENAME_MAX_CHARACTERS);
  if (COMPANION_ATTACHMENT_FILENAME_PATTERN.test(normalized)) return normalized;
  const extension = Object.entries(COMPANION_ATTACHMENT_EXTENSION_TO_MIME)
    .find(([, mime]) => mime === input.contentType)?.[0] ?? "";
  return `file-${input.position}${extension}`;
}

/**
 * One file carried by a transcript entry. The payload is deliberately metadata only: the storage key
 * and any URL that could reach object storage directly stay server-side, and a reader fetches bytes
 * through the attachment route, which re-authorizes on every single request.
 */
export const companionAttachmentSchema = z.object({
  id: z.string().uuid(),
  kind: companionAttachmentKindSchema,
  content_type: companionAttachmentContentTypeSchema,
  byte_size: z.number().int().positive().max(COMPANION_ATTACHMENT_MAX_BYTES),
  filename: z.string().regex(COMPANION_ATTACHMENT_FILENAME_PATTERN),
  /** Stable order within its entry, so a re-read renders the same files in the same places. */
  position: z.number().int().nonnegative(),
}).strict();
export type CompanionAttachment = z.infer<typeof companionAttachmentSchema>;

/**
 * One already-stored attachment as the control plane hands it to the durable enqueue. This never
 * crosses the wire to a browser: it carries the storage key and the content digest the idempotent
 * replay compares, both of which stay server-side.
 */
export const companionAttachmentUploadSchema = z.object({
  storage_key: z.string().min(1).max(512).refine((value) => !/[\r\n]/.test(value), {
    message: "storage key must be a single line",
  }),
  content_type: companionAttachmentContentTypeSchema,
  byte_size: z.number().int().positive().max(COMPANION_ATTACHMENT_MAX_BYTES),
  /** Lowercase hex sha256 of the exact stored bytes; also the tail of the content-addressed key. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  filename: z.string().regex(COMPANION_ATTACHMENT_FILENAME_PATTERN),
  position: z.number().int().nonnegative().max(COMPANION_OUTPUT_ATTACHMENT_MAX_COUNT - 1),
}).strict();
export type CompanionAttachmentUpload = z.infer<typeof companionAttachmentUploadSchema>;

const companionTranscriptEntryObjectSchema = z.object({
  event_id: z.string().min(1).max(200),
  ordinal: z.number().int().nonnegative(),
  role: z.enum(["user", "assistant", "system", "tool", "decision"]),
  content: z.string(),
  /**
   * What Pi thought before it answered, shown behind a collapsed disclosure above the reply. It is a
   * field on the reply rather than an entry of its own so the thinking cannot outlive, reorder ahead
   * of, or be read without the turn it belongs to. Null on every entry that is not a reply, and on a
   * reply whose thinking is already its content because the turn produced no text.
   */
  reasoning: z.string().max(COMPANION_REASONING_MAX_CHARACTERS).nullable().default(null),
  /**
   * Member who sent a user message. A shared thread has several writers, so the reader compares
   * this against `viewer_id` instead of assuming every user message is its own. Null for Pi.
   */
  author_id: z.string().nullable(),
  author_name: z.string().nullable(),
  /** Set on exactly the `tool` entries; every other role carries null. */
  tool: companionToolRunSchema.nullable().default(null),
  /** Set on exactly the `decision` entries; every other role carries null. */
  decision: companionDecisionSchema.nullable().default(null),
  /**
   * Present on a user entry that was produced by a scheduled routine fire. The prompt is still in
   * `content`; the UI hides that bubble and shows this header instead. Null on every other role,
   * and on ordinary member messages.
   */
  routine: z.object({
    id: z.string().uuid().nullable(),
    name: companionRoutineNameSchema,
    /** Stable id of the routine-origin turn that represents this fire. Optional for old rows. */
    run_id: z.string().uuid().nullable().optional(),
  }).nullable().default(null),
  /**
   * Present on a user entry that was enqueued by a trigger's webhook. Masked exactly like a
   * routine fire: the composed prompt stays in `content` and the UI shows this header instead.
   */
  trigger: z.object({
    id: z.string().uuid().nullable(),
    name: companionTriggerNameSchema,
  }).nullable().default(null),
  /** Trusted origin/result marker for a Companion-to-Companion delegation. */
  delegation: z.object({
    id: z.string().uuid(),
    direction: z.enum(["request", "response"]),
    companion_id: z.string().uuid().nullable(),
    companion_name: z.string().min(1).max(120),
    response_mode: companionDelegationResponseModeSchema,
    status: companionTurnStatusSchema,
  }).strict().nullable().optional(),
  /**
   * The durable turn this user message created, so a queued follow-up can be cancelled by id.
   * Null on every other role, and on a message the composer is still sending.
   */
  turn_id: z.string().uuid().nullable().default(null),
  /**
   * True while this user message is saved and ordered behind other work. The composer can keep
   * sending; these are the lines that have not reached Pi yet. Default keeps older projections
   * parseable.
   */
  queued: z.boolean().default(false),
  /**
   * Files this entry carries, in stable order. A member message carries what was sent with it; the
   * assistant outputs entry carries what Pi left in its outbox during that turn. Every other entry
   * carries an empty list, and the default keeps older projections parseable.
   */
  attachments: z.array(companionAttachmentSchema).default([]),
  created_at: z.string().datetime(),
});

function validateCompanionTranscriptEntry(
  entry: z.infer<typeof companionTranscriptEntryObjectSchema>,
  ctx: z.RefinementCtx,
) {
  if ((entry.role === "tool") !== (entry.tool !== null)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["tool"],
      message: "a tool entry carries a tool run and no other role may",
    });
  }
  if ((entry.role === "decision") !== (entry.decision !== null)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["decision"],
      message: "a decision entry carries a permission card and no other role may",
    });
  }
  if (entry.routine !== null && entry.role !== "user") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["routine"],
      message: "only a user message may carry a routine origin",
    });
  }
  if (entry.trigger !== null && entry.role !== "user") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["trigger"],
      message: "only a user message may carry a trigger origin",
    });
  }
  if (entry.routine !== null && entry.trigger !== null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["trigger"],
      message: "a message has one origin: routine or trigger, never both",
    });
  }
  if (entry.delegation != null && !["user", "assistant", "system"].includes(entry.role)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["delegation"],
      message: "delegation metadata belongs to a request or surfaced response",
    });
  }
  if ((entry.turn_id !== null || entry.queued) && entry.role !== "user") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: entry.queued ? ["queued"] : ["turn_id"],
      message: "only a user message may be queued or name its turn",
    });
  }
  if (entry.reasoning !== null && entry.role !== "assistant") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reasoning"],
      message: "only a reply carries reasoning",
    });
  }
  const expectedAttachmentKind = entry.role === "user"
    ? "user_upload"
    : entry.role === "assistant"
      ? "pi_output"
      : null;
  if (entry.attachments.some((attachment) => attachment.kind !== expectedAttachmentKind)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["attachments"],
      message: "a member message carries uploads and a reply carries Pi outputs; no other role may",
    });
  }
  if (
    entry.attachments.some((attachment, index) => attachment.position !== index)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["attachments"],
      message: "attachment positions must be dense and ordered from zero",
    });
  }
}

/**
 * Earlier marker/update pairs hidden behind the latest routine notification. They deliberately use
 * the ungrouped entry shape: a projection is one flat deterministic group and can never nest a
 * second disclosure that each client would have to interpret recursively.
 */
const companionRoutineNotifyGroupSchema = z.object({
  routine_name: companionRoutineNameSchema,
  total_count: z.number().int().min(2),
  hidden_entries: z.array(
    companionTranscriptEntryObjectSchema.superRefine(validateCompanionTranscriptEntry),
  ).min(2),
}).strict().superRefine((group, ctx) => {
  const hiddenUpdates = group.hidden_entries.filter((entry) => entry.role === "assistant").length;
  if (hiddenUpdates + 1 !== group.total_count) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["total_count"],
      message: "the total includes every hidden routine update plus the visible latest update",
    });
  }
});

export const companionTranscriptEntrySchema = companionTranscriptEntryObjectSchema.extend({
  /**
   * Present only on the latest assistant entry in consecutive same-routine `notify` returns. The
   * API, not a client, chooses membership and preserves every hidden durable entry in exact order.
   */
  routine_notify_group: companionRoutineNotifyGroupSchema.nullable().optional(),
}).superRefine((entry, ctx) => {
  validateCompanionTranscriptEntry(entry, ctx);
  if (entry.routine_notify_group !== undefined
    && entry.routine_notify_group !== null
    && entry.role !== "assistant") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["routine_notify_group"],
      message: "only the latest visible assistant update may carry a routine notify group",
    });
  }
});
export type CompanionTranscriptEntry = z.infer<typeof companionTranscriptEntrySchema>;
export type CompanionTranscriptRole = CompanionTranscriptEntry["role"];

/**
 * One Companion owns exactly one chat thread. The payload is the control-plane read model, so a
 * Viewer reads it without any Box contact; `can_send` reflects the Owner/Editor run boundary.
 */
export const companionThreadSchema = z.object({
  companion_id: z.string().uuid(),
  /** The reader this payload was built for; entries authored by them render as their own. */
  viewer_id: z.string(),
  access: companionAccessSchema,
  read_only: z.boolean(),
  can_send: z.boolean(),
  /** API-projected deployment capability; absent on older servers and false when unconfigured. */
  transcription_available: z.boolean().optional(),
  entries: z.array(companionTranscriptEntrySchema),
  /** The one non-terminal turn currently owning Pi, if any. */
  active_turn: companionActiveTurnSchema.nullable(),
  /** Exact number of later turns still ordered in PostgreSQL. */
  queued_count: z.number().int().nonnegative(),
  /** The queue-blocking ambiguous turn that requires explicit Retry or Cancel, if any. */
  interrupted_turn: companionInterruptedTurnSchema.nullable(),
  last_message_at: z.string().datetime().nullable(),
  /**
   * This reader's own unread watermark (THE-351) as it stood *before* opening advanced it, so the
   * transcript can draw one divider where they left off. It is carried by the read that opens a
   * thread; an accepted write answers about what it just wrote and carries null, as does a reader
   * who has never opened this thread. Null means "no divider", which is what a first visit looks like.
   */
  last_read_ordinal: z.number().int().nonnegative().nullable().default(null),
});
export type CompanionThread = z.infer<typeof companionThreadSchema>;

/**
 * Stateless delta cursors are intentionally small, opaque snapshots rather than database offsets.
 * The server can therefore detect edits and deletions even when a client was offline, while a
 * bounded cursor keeps an untrusted query parameter from becoming an unbounded request body.
 */
export const COMPANION_SYNC_CURSOR_VERSION = 1 as const;
export const COMPANION_SYNC_CURSOR_MAX_CHARACTERS = 256 * 1024;
export const COMPANION_SYNC_CURSOR_MAX_RECORDS = 20_000;
/** Exact thread records retained after the historical prefix digest. */
export const COMPANION_THREAD_SYNC_CURSOR_TAIL_RECORDS = 6;

export const companionSyncQuerySchema = z.object({
  cursor: z.string().min(1).max(COMPANION_SYNC_CURSOR_MAX_CHARACTERS).optional(),
}).strict();
export type CompanionSyncQuery = z.infer<typeof companionSyncQuerySchema>;

export const companionSyncCursorSchema = z.string()
  .min(1)
  .max(COMPANION_SYNC_CURSOR_MAX_CHARACTERS);

export const companionRosterSyncResponseSchema = z.object({
  cursor: companionSyncCursorSchema,
  changed_companions: z.array(companionSchema),
  deleted_companion_ids: z.array(z.string().uuid()),
  /** Full current order lets a client reposition unchanged rows after an activity/reorder event. */
  companion_ids: z.array(z.string().uuid()),
  changed_sections: z.array(companionSectionSchema),
  deleted_section_ids: z.array(z.string().uuid()),
  /** Full current section order has the same property as `companion_ids`. */
  section_ids: z.array(z.string().uuid()),
}).strict();
export type CompanionRosterSyncResponse = z.infer<typeof companionRosterSyncResponseSchema>;

/** Thread metadata is sent on every delta so state changes are never hidden behind entry polling. */
export const companionThreadMetadataSchema = companionThreadSchema.omit({ entries: true });
export type CompanionThreadMetadata = z.infer<typeof companionThreadMetadataSchema>;

export const companionThreadDeltaResponseSchema = z.object({
  cursor: companionSyncCursorSchema,
  /** True when the bounded cursor detected an edit/delete outside its retained digest tail. */
  reset_entries: z.boolean(),
  changed_entries: z.array(companionTranscriptEntrySchema),
  deleted_event_ids: z.array(z.string().min(1).max(200)),
  thread: companionThreadMetadataSchema,
}).strict();
export type CompanionThreadDeltaResponse = z.infer<typeof companionThreadDeltaResponseSchema>;

/**
 * One send, one turn. The sender names the message it is creating, and the control plane stores that
 * name as the transcript event id, so a request that arrives twice — a retried fetch, a proxy replay,
 * a client that resent the same submission — persists the same turn instead of a second one.
 */
export const companionClientMessageIdSchema = z.string().uuid();

/**
 * The transcript event id one client message id owns. Sent messages and projected Pi events keep
 * separate id namespaces, so a sender can never name an entry the Pi log will claim later, and the
 * message a composer shows before the control plane answers already carries its final id.
 */
export function companionMessageEventId(clientMessageId: string): string {
  return `msg:${clientMessageId}`;
}

export const companionClientSurfaceSchema = z.enum(["web", "mobile_web", "native_mobile"]);
export type CompanionClientSurface = z.infer<typeof companionClientSurfaceSchema>;

/**
 * The fixed model behind first-party dictation. It is deliberately separate from the selectable
 * Companion provider catalog and never changes the Companion's runtime configuration.
 */
export const COMPANION_TRANSCRIPTION_MODEL = "gemini-3.7-flash" as const;

/**
 * Compatibility model returned only by the deprecated live-session endpoint. Keep this contract
 * until the last first-party client that depended on live dictation is outside the support window.
 */
export const COMPANION_LEGACY_TRANSCRIPTION_MODEL = "gemini-3.5-transcribe-live" as const;

/** The deprecated live-session request never accepts caller-controlled provider settings. */
export const createCompanionTranscriptionSessionInputSchema = z.object({}).strict();
export type CreateCompanionTranscriptionSessionInput = z.infer<
  typeof createCompanionTranscriptionSessionInputSchema
>;

/** Compatibility response for first-party clients released before contextual transcription. */
export const companionTranscriptionSessionSchema = z.object({
  token: z.string().trim().min(1),
  expires_at: z.string().datetime(),
  model: z.literal(COMPANION_LEGACY_TRANSCRIPTION_MODEL),
}).strict();
export type CompanionTranscriptionSession = z.infer<typeof companionTranscriptionSessionSchema>;

/**
 * Compressed audio ceiling for one contextual transcription. Base64 expansion plus the bounded
 * conversation context still keeps the provider request comfortably below its 20 MB limit.
 */
export const COMPANION_TRANSCRIPTION_AUDIO_MAX_BYTES = 8 * 1024 * 1024;
export const COMPANION_TRANSCRIPTION_AUDIO_CONTENT_TYPE = "audio/mp4" as const;

/** Only the final transcript crosses back to a first-party client. */
export const companionTranscriptionSchema = z.object({
  transcript: z.string().trim().min(1).max(16_384),
}).strict();
export type CompanionTranscription = z.infer<typeof companionTranscriptionSchema>;

export const sendCompanionMessageInputSchema = z.object({
  content: z.string().trim().min(1).max(16_384),
  client_message_id: companionClientMessageIdSchema,
  client_surface: companionClientSurfaceSchema.default("web"),
}).strict();
export type SendCompanionMessageInput = z.infer<typeof sendCompanionMessageInputSchema>;

export const sendCompanionMessageAcceptedResponseSchema = z.object({
  turn: companionTurnSchema,
}).strict();
export type SendCompanionMessageAcceptedResponse = z.infer<
  typeof sendCompanionMessageAcceptedResponseSchema
>;

export const cancelCompanionTurnAcceptedResponseSchema = z.object({
  turn: companionTurnSchema,
  thread: companionThreadSchema,
}).strict();
export type CancelCompanionTurnAcceptedResponse = z.infer<
  typeof cancelCompanionTurnAcceptedResponseSchema
>;

export const createCompanionInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  persona: companionPersonaSchema.optional(),
  provider_id: companionProviderIdSchema.optional(),
  model_id: companionModelIdSchema.optional(),
  selected_skill_ids: companionSelectedSkillIdsSchema.optional(),
  selected_mcp_account_ids: companionSelectedMcpAccountIdsSchema.optional(),
  icon: companionIconPatchSchema.optional(),
}).strict();
export type CreateCompanionInput = z.infer<typeof createCompanionInputSchema>;

/**
 * Per-member Companions list preferences. Omitting a field leaves it unchanged. `unread: true`
 * marks the thread unread; `unread: false` clears the badge the same way opening the thread does.
 * Muting suppresses future push-notification deliveries for this member and Companion.
 */
export const updateCompanionMemberStateInputSchema = z.object({
  pinned: z.boolean().optional(),
  hidden: z.boolean().optional(),
  muted: z.boolean().optional(),
  unread: z.boolean().optional(),
}).strict().refine(
  (body) => body.pinned !== undefined || body.hidden !== undefined
    || body.muted !== undefined || body.unread !== undefined,
  { message: "at least one of pinned, hidden, muted, or unread is required" },
);
export type UpdateCompanionMemberStateInput = z.infer<typeof updateCompanionMemberStateInputSchema>;

export const updateCompanionInputSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  persona: companionPersonaSchema.nullable().optional(),
  provider_id: companionProviderIdSchema.optional(),
  model_id: companionModelIdSchema.optional(),
  selected_skill_ids: companionSelectedSkillIdsSchema.optional(),
  selected_mcp_account_ids: companionSelectedMcpAccountIdsSchema.optional(),
  icon: companionIconPatchSchema.optional(),
}).strict().refine(
  (input) =>
    input.name !== undefined
    || input.persona !== undefined
    || input.provider_id !== undefined
    || input.model_id !== undefined
    || input.selected_skill_ids !== undefined
    || input.selected_mcp_account_ids !== undefined
    || input.icon !== undefined,
  "At least one Companion setting is required",
);
export type UpdateCompanionInput = z.infer<typeof updateCompanionInputSchema>;

export const setCompanionProviderInputSchema = z.object({
  provider_id: companionProviderIdSchema,
}).strict();
export type SetCompanionProviderInput = z.infer<typeof setCompanionProviderInputSchema>;

const apiKeyProviderAuthInputSchema = z.object({
  auth_method: z.literal("api_key"),
  credential: z.string().min(1).max(32_768).refine((value) => !/[\r\n\0]/.test(value), {
    message: "API key must be a single line",
  }),
}).strict();

/**
 * The public credential write accepts API keys only. Subscription credentials are minted by the
 * server-side OAuth broker, so a browser can never submit or receive a Pi auth.json entry.
 */
export const saveCompanionProviderInputSchema = apiKeyProviderAuthInputSchema;
export type SaveCompanionProviderInput = z.infer<typeof saveCompanionProviderInputSchema>;

export const setDefaultCompanionProviderInputSchema = z.object({
  provider_id: companionProviderIdSchema,
}).strict();

export const companionProviderOAuthStartInputSchema = z.object({
  provider_id: z.enum(["anthropic", "openai-codex"]),
}).strict();
export type CompanionProviderOAuthStartInput = z.infer<
  typeof companionProviderOAuthStartInputSchema
>;

export const companionProviderOAuthStartResponseSchema = z.discriminatedUnion("flow", [
  z.object({
    flow: z.literal("authorization_code"),
    provider_id: z.literal("anthropic"),
    authorization_url: z.string().url(),
  }).strict(),
  z.object({
    flow: z.literal("device_code"),
    provider_id: z.literal("openai-codex"),
    verification_url: z.string().url(),
    user_code: z.string().min(1).max(128),
    poll_interval_seconds: z.number().int().min(1).max(60),
    expires_at: z.string().datetime(),
  }).strict(),
]);
export type CompanionProviderOAuthStartResponse = z.infer<
  typeof companionProviderOAuthStartResponseSchema
>;

export const companionProviderOAuthCompleteInputSchema = z.object({
  authorization_code: z.string().trim().min(1).max(4_096).refine(
    (value) => !/[\r\n\0]/.test(value),
    "authorization code must be a single line",
  ),
}).strict();

/**
 * Runtime environment value for a labeled MCP account. Model-provider authentication is resolved
 * from the encrypted workspace connection instead and never travels in a start request.
 */
export const companionMcpCredentialSchema = z.object({
  env_key: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/),
  value: z.string().min(1).max(32_768).refine((value) => !/[\r\n\0]/.test(value), {
    message: "credential value must be a single line",
  }),
}).strict();
export type CompanionMcpCredential = z.infer<typeof companionMcpCredentialSchema>;

const mcpRuntimeEnvKeySchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/);
const mcpEnvironmentBindingsSchema = z.record(
  z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
  mcpRuntimeEnvKeySchema,
).default({});
const mcpHeaderBindingsSchema = z.record(
  z.string().trim().min(1).max(128).refine((value) => !/[\r\n:]/.test(value), {
    message: "header names must not contain control characters or a colon",
  }),
  mcpRuntimeEnvKeySchema,
).default({});

const companionMcpAccountBaseSchema = z.object({
  id: z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
  label: z.string().trim().min(1).max(80),
  lifecycle: z.enum(["lazy", "eager", "keep-alive", "lazy-keep-alive"]).default("lazy"),
  direct_tools: z.union([z.boolean(), z.array(z.string().trim().min(1).max(128)).max(50)])
    .default(false),
});

export const companionMcpAccountSchema = z.discriminatedUnion("transport", [
  companionMcpAccountBaseSchema.extend({
    transport: z.literal("stdio"),
    command: z.string().trim().min(1).max(1_024).refine((value) => !/[\r\n\0]/.test(value), {
      message: "command must be a single line",
    }),
    args: z.array(z.string().max(8_192).refine((value) => !value.includes("\0"), {
      message: "arguments must not contain null bytes",
    })).max(100).default([]),
    env: mcpEnvironmentBindingsSchema,
  }).strict(),
  companionMcpAccountBaseSchema.extend({
    transport: z.literal("http"),
    url: z.string().url().max(4_096).refine(
      (value) => /^https?:\/\//i.test(value),
      { message: "MCP URL must use http or https" },
    ),
    headers: mcpHeaderBindingsSchema,
  }).strict(),
]);
export type CompanionMcpAccount = z.infer<typeof companionMcpAccountSchema>;

export const companionPluginTransportSchema = z.enum(["http", "stdio"]);

/**
 * One member-owned MCP connection. Authentication is deliberately write-only: ordinary reads
 * expose the provider, account label, and transport metadata, never the connector credential.
 */
export const companionPluginAccountSchema = z.object({
  id: z.string().uuid(),
  provider: z.string(),
  label: z.string(),
  transport: companionPluginTransportSchema,
  endpoint: z.string(),
  connected: z.literal(true),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
}).strict();
export type CompanionPluginAccount = z.infer<typeof companionPluginAccountSchema>;

export const companionPluginsResponseSchema = z.object({
  accounts: z.array(companionPluginAccountSchema),
}).strict();
export type CompanionPluginsResponse = z.infer<typeof companionPluginsResponseSchema>;

/**
 * The compact Plugins form supports the adapter's HTTP and stdio transports while keeping secret
 * values separate from durable transport metadata. `credential_name` is a header for HTTP and an
 * environment variable for stdio.
 */
export const saveCompanionPluginInputSchema = z.object({
  provider: z.string().trim().regex(/^[a-z][a-z0-9-]{0,62}$/),
  label: z.string().trim().min(1).max(40),
  transport: companionPluginTransportSchema,
  url: z.string().trim().url().max(4_096).refine(
    (value) => /^https?:\/\//i.test(value),
    { message: "MCP URL must use http or https" },
  ).optional(),
  command: z.string().trim().min(1).max(1_024).refine(
    (value) => !/[\r\n\0]/.test(value),
    { message: "command must be a single line" },
  ).optional(),
  args: z.array(z.string().max(8_192).refine((value) => !value.includes("\0"), {
    message: "arguments must not contain null bytes",
  })).max(100).default([]),
  credential_name: z.string().trim().min(1).max(128).refine(
    (value) => /^[A-Za-z_][A-Za-z0-9_-]{0,127}$/.test(value),
    { message: "credential name must be a header or environment variable name" },
  ).optional(),
  credential_value: z.string().min(1).max(32_768).refine(
    (value) => !/[\r\n\0]/.test(value),
    { message: "credential value must be a single line" },
  ).optional(),
}).strict().superRefine((input, context) => {
  if (input.transport === "http" && !input.url) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["url"], message: "HTTP MCP needs a URL" });
  }
  if (input.transport === "stdio" && !input.command) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["command"],
      message: "stdio MCP needs a command",
    });
  }
  if (Boolean(input.credential_name) !== Boolean(input.credential_value)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: [input.credential_name ? "credential_value" : "credential_name"],
      message: "credential name and value must be supplied together",
    });
  }
  if (
    input.transport === "stdio"
    && input.credential_name
    && !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(input.credential_name)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["credential_name"],
      message: "stdio credential names must be environment variable names",
    });
  }
});
export type SaveCompanionPluginInput = z.infer<typeof saveCompanionPluginInputSchema>;

export const startCompanionRuntimeInputSchema = z.object({
  client_surface: companionClientSurfaceSchema.default("web"),
}).strict();
export type StartCompanionRuntimeInput = z.infer<typeof startCompanionRuntimeInputSchema>;

export const companionProviderErrorSchema = z.object({
  code: z.enum([
    "provider_not_configured",
    "provider_model_invalid",
    "provider_auth_invalid",
    "provider_auth_expired",
    "provider_unavailable",
  ]),
  provider_id: companionProviderIdSchema.nullable(),
  message: z.string(),
});
export type CompanionProviderError = z.infer<typeof companionProviderErrorSchema>;

/**
 * How the minted desktop URL carries the screen. VNC is a plain WebSocket stream that survives
 * networks which block peer-to-peer traffic, so it is asked for first; `webrtc` is the fallback Box
 * offers when a Box has no VNC stream to give.
 */
export const companionDesktopTransportSchema = z.enum(["vnc", "webrtc"]);
export type CompanionDesktopTransport = z.infer<typeof companionDesktopTransportSchema>;

/**
 * Owner/Editor handoff to the Box desktop. Computer use is that desktop driven by Lux and nothing
 * else, so the payload names the automation instead of leaving the surface to pick one. The URL is
 * secret-bearing and belongs to the authorized caller alone: it is never stored or logged, and it
 * is null while Box is still provisioning the desktop of a Box that is already running.
 *
 * Every request mints a fresh URL. Box rotates the stream token on each state change, so a stored
 * one is a URL that has already stopped working, and `transport` names which stream this mint got
 * rather than leaving the surface to guess at the one it was handed.
 */
export const companionDesktopSchema = z.object({
  desktop_url: z.string().url().nullable(),
  provisioning: z.boolean(),
  automation: z.literal("lux"),
  transport: companionDesktopTransportSchema.nullable(),
}).strict();
export type CompanionDesktop = z.infer<typeof companionDesktopSchema>;
