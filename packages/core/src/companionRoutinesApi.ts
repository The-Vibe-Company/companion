import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";

import type {
  CompanionRoutine,
  CompanionRoutineRunDetail,
  CompanionRoutineRunList,
} from "@companion/contracts";
import {
  COMPANION_ROUTINE_RUN_ENTRY_PAGE_DEFAULT,
  COMPANION_ROUTINE_MIN_INTERVAL_MS,
  companionRecoveryStatusSchema,
  companionRoutineDraftSchema,
  companionRoutineProposalSchema,
  companionRoutineRunDetailSchema,
  companionRoutineRunSummarySchema,
  companionRoutineSchema,
} from "@companion/contracts";
import type { Db } from "@companion/db";

import {
  CompanionDecisionConflictError,
  CompanionDecisionNotFoundError,
} from "./companions";
import { getCompanionDecision } from "./companionRuntimeApi";
import {
  computeNextFireAt,
  validateRoutineSchedule,
} from "./companionRoutines";

function rows<T>(result: Iterable<T>): T[] {
  return Array.from(result);
}

const databaseErrorSchema = z.object({
  code: z.string().optional(),
  cause: z.instanceof(Error).optional(),
}).passthrough();

function hasDatabaseErrorCode(error: Error, expected: string): boolean {
  const seen = new Set<Error>();
  let current: Error | undefined = error;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    const parsed = databaseErrorSchema.safeParse(current);
    if (!parsed.success) return false;
    if (parsed.data.code === expected) return true;
    current = parsed.data.cause;
  }
  return false;
}

function databaseErrorCode(error: Error): string | null {
  const seen = new Set<Error>();
  let current: Error | undefined = error;
  while (current !== undefined && !seen.has(current)) {
    const parsed = databaseErrorSchema.safeParse(current);
    if (!parsed.success) return null;
    seen.add(current);
    if (parsed.data.code) return parsed.data.code;
    current = parsed.data.cause;
  }
  return null;
}

/** Validation errors contain no SQL diagnostics and retain their ordinary public shape. */
function isRoutineDecisionDomainError(error: Error): boolean {
  return error instanceof z.ZodError
    || error instanceof CompanionDecisionConflictError
    || error instanceof CompanionDecisionNotFoundError
    || error instanceof CompanionRoutineInvalidError;
}

export class CompanionRoutineDecisionUpdateError extends Error {
  readonly code = "routine_update_failed" as const;
  readonly httpStatus: 400 | 403 | 404 | 409 | 500;

  constructor(options?: {
    cause?: unknown;
    httpStatus?: 400 | 403 | 404 | 409 | 500;
  }) {
    super("Unable to apply the routine proposal. Please try again.", options);
    this.name = "CompanionRoutineDecisionUpdateError";
    this.httpStatus = options?.httpStatus ?? 500;
  }
}

function routineDecisionError(error: Error): Error {
  if (isRoutineDecisionDomainError(error)
      || error instanceof CompanionRoutineDecisionUpdateError) {
    return error instanceof Error ? error : new Error(String(error));
  }
  const code = databaseErrorCode(error);
  const httpStatus = code === "42501"
    ? 403
    : code === "P0002" || code === "02000"
      ? 404
      : code === "23505" || code === "40001" || code === "55000"
        ? 409
        : code === "22023" || code === "P0001"
          ? 400
          : 500;
  return new CompanionRoutineDecisionUpdateError({ cause: error, httpStatus });
}

export class CompanionRoutineNotFoundError extends Error {
  constructor() {
    super("companion routine not found");
    this.name = "CompanionRoutineNotFoundError";
  }
}

export class CompanionRoutineRunNotFoundError extends Error {
  constructor() {
    super("companion routine run not found");
    this.name = "CompanionRoutineRunNotFoundError";
  }
}

export class CompanionRoutineInvalidError extends Error {
  readonly code: "invalid_cron" | "invalid_timezone" | "interval_too_short";

  constructor(code: CompanionRoutineInvalidError["code"]) {
    super(
      code === "invalid_timezone"
        ? "Timezone must be a valid IANA name."
        : code === "interval_too_short"
          ? "Routines must fire at least five minutes apart."
          : "The cron expression is not valid.",
    );
    this.name = "CompanionRoutineInvalidError";
    this.code = code;
  }
}

/**
 * The driver refuses a bare `Date` bind, so every instant crosses as an ISO-8601 string. That is
 * also the exact precision `companion_routines.next_fire_at` stores, which keeps the claim/fire
 * fence comparable after the worker's round trip through JavaScript.
 */
function instant(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function scheduleNextFire(cron: string, timezone: string, enabled: boolean, after = new Date()): Date | null {
  if (!enabled) return null;
  const validated = validateRoutineSchedule({ cron, timezone, after });
  if (!validated.ok) throw new CompanionRoutineInvalidError(validated.code);
  return validated.nextFireAt;
}

export async function listCompanionRoutines(input: {
  orgId: string;
  companionId: string;
  database: Db;
}): Promise<CompanionRoutine[]> {
  const result = await input.database.execute<{ routine: unknown }>(sql`
    select routine from public.companion_api_list_routines(
      ${input.orgId}::uuid,
      ${input.companionId}::uuid
    )
  `);
  return rows(result).map((row) => companionRoutineSchema.parse(row.routine));
}

/** PostgreSQL-only routine history read; this never contacts or wakes the Companion Box. */
export async function listCompanionRoutineRuns(input: {
  orgId: string;
  companionId: string;
  routineId: string;
  limit?: number;
  cursor?: string;
  database: Db;
}): Promise<CompanionRoutineRunList> {
  const limit = input.limit ?? 50;
  const result = await input.database.execute<{ run: unknown; recovery_status: unknown }>(sql`
    select routine_run.run,
      public.companion_api_turn_recovery_status(
        ${input.orgId}::uuid,
        ${input.companionId}::uuid,
        NULLIF(routine_run.run->>'run_id', '')::uuid
      ) as recovery_status
    from public.companion_api_list_routine_runs(
      ${input.orgId}::uuid,
      ${input.companionId}::uuid,
      ${input.routineId}::uuid,
      ${input.cursor ?? null}::uuid,
      ${limit + 1}::integer
    ) routine_run
  `);
  const parsed = rows(result).map((row) => companionRoutineRunSummarySchema.parse({
    ...companionRoutineRunSummarySchema.parse(row.run),
    recovery_status: companionRecoveryStatusSchema.nullable().catch(null)
      .parse(row.recovery_status),
  }));
  const hasMore = parsed.length > limit;
  const runs = hasMore ? parsed.slice(0, limit) : parsed;
  return {
    runs,
    next_cursor: hasMore ? runs.at(-1)?.run_id ?? null : null,
  };
}

/** Read one run by its durable turn id, including only its private routine-session transcript. */
export async function getCompanionRoutineRun(input: {
  orgId: string;
  companionId: string;
  runId: string;
  entryLimit?: number;
  entryCursor?: number;
  database: Db;
}): Promise<CompanionRoutineRunDetail> {
  const entryLimit = input.entryLimit ?? COMPANION_ROUTINE_RUN_ENTRY_PAGE_DEFAULT;
  const result = await input.database.execute<{ run: unknown; recovery_status: unknown }>(sql`
    select routine_run.run,
      public.companion_api_turn_recovery_status(
        ${input.orgId}::uuid,
        ${input.companionId}::uuid,
        NULLIF(routine_run.run->>'run_id', '')::uuid
      ) as recovery_status
    from public.companion_api_get_routine_run(
      ${input.orgId}::uuid,
      ${input.companionId}::uuid,
      ${input.runId}::uuid,
      ${input.entryCursor ?? null}::integer,
      ${entryLimit}::integer
    ) routine_run
  `);
  const [row] = rows(result);
  if (!row) throw new CompanionRoutineRunNotFoundError();
  return companionRoutineRunDetailSchema.parse({
    ...companionRoutineRunDetailSchema.parse(row.run),
    recovery_status: companionRecoveryStatusSchema.nullable().catch(null)
      .parse(row.recovery_status),
  });
}

export async function createCompanionRoutine(input: {
  orgId: string;
  companionId: string;
  id?: string;
  name: string;
  prompt: string;
  cron: string;
  timezone: string;
  enabled?: boolean;
  database: Db;
}): Promise<CompanionRoutine> {
  const draft = companionRoutineDraftSchema.parse({
    name: input.name,
    prompt: input.prompt,
    cron: input.cron,
    timezone: input.timezone,
    enabled: input.enabled ?? true,
  });
  const nextFireAt = scheduleNextFire(draft.cron, draft.timezone, draft.enabled);
  const result = await input.database.execute<{ routine: unknown }>(sql`
    select public.companion_api_create_routine(
      ${input.orgId}::uuid,
      ${input.companionId}::uuid,
      ${input.id ?? randomUUID()}::uuid,
      ${draft.name},
      ${draft.prompt},
      ${draft.cron},
      ${draft.timezone},
      ${draft.enabled},
      ${instant(nextFireAt)}::timestamptz
    ) as routine
  `);
  const [row] = rows(result);
  if (!row) throw new Error("failed to create Companion routine");
  return companionRoutineSchema.parse(row.routine);
}

export async function updateCompanionRoutine(input: {
  orgId: string;
  companionId: string;
  routineId: string;
  name?: string;
  prompt?: string;
  cron?: string;
  timezone?: string;
  enabled?: boolean;
  database: Db;
}): Promise<CompanionRoutine> {
  const routines = await listCompanionRoutines(input);
  const current = routines.find((routine) => routine.id === input.routineId);
  if (!current) throw new CompanionRoutineNotFoundError();
  const draft = companionRoutineDraftSchema.parse({
    name: input.name ?? current.name,
    prompt: input.prompt ?? current.prompt,
    cron: input.cron ?? current.cron,
    timezone: input.timezone ?? current.timezone,
    enabled: input.enabled ?? current.enabled,
  });
  const nextFireAt = scheduleNextFire(draft.cron, draft.timezone, draft.enabled);
  try {
    const result = await input.database.execute<{ routine: unknown }>(sql`
      select public.companion_api_update_routine(
        ${input.orgId}::uuid,
        ${input.companionId}::uuid,
        ${input.routineId}::uuid,
        ${draft.name},
        ${draft.prompt},
        ${draft.cron},
        ${draft.timezone},
        ${draft.enabled},
        ${instant(nextFireAt)}::timestamptz
      ) as routine
    `);
    const [row] = rows(result);
    if (!row) throw new Error("failed to update Companion routine");
    return companionRoutineSchema.parse(row.routine);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (hasDatabaseErrorCode(error, "P0002")) throw new CompanionRoutineNotFoundError();
    throw error;
  }
}

export async function deleteCompanionRoutine(input: {
  orgId: string;
  companionId: string;
  routineId: string;
  database: Db;
}): Promise<void> {
  try {
    await input.database.execute(sql`
      select public.companion_api_delete_routine(
        ${input.orgId}::uuid,
        ${input.companionId}::uuid,
        ${input.routineId}::uuid
      )
    `);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (hasDatabaseErrorCode(error, "P0002")) throw new CompanionRoutineNotFoundError();
    throw error;
  }
}

export async function answerCompanionRoutineDecision(input: {
  orgId: string;
  companionId: string;
  requestId: string;
  decision: "allow" | "deny";
  database: Db;
}): Promise<CompanionRoutine | null> {
  let routineId: string | null = null;
  let nextFireAt: Date | null = null;
  if (input.decision === "allow") {
    let pending: Awaited<ReturnType<typeof getCompanionDecision>>;
    try {
      pending = await getCompanionDecision({
        orgId: input.orgId,
        companionId: input.companionId,
        requestId: input.requestId,
        database: input.database,
      });
    } catch (error) {
      throw routineDecisionError(
        error instanceof Error ? error : new Error("Companion routine decision failed"),
      );
    }
    const proposal = companionRoutineProposalSchema.parse(pending.proposal);
    nextFireAt = scheduleNextFire(proposal.cron, proposal.timezone, true);
    routineId = randomUUID();
  }
  try {
    const result = await input.database.execute<{ routine: unknown }>(sql`
      select * from public.companion_api_answer_routine_decision(
        ${input.orgId}::uuid,
        ${input.companionId}::uuid,
        ${input.requestId},
        ${input.decision},
        ${routineId}::uuid,
        ${instant(nextFireAt)}::timestamptz
      )
    `);
    const [row] = rows<{ routine: unknown }>(result);
    return row?.routine == null ? null : companionRoutineSchema.parse(row.routine);
  } catch (error) {
    throw routineDecisionError(
      error instanceof Error ? error : new Error("Companion routine decision failed"),
    );
  }
}

export async function claimDueCompanionRoutines(input: {
  workerId: string;
  limit?: number;
  leaseSeconds?: number;
  database: Db;
}): Promise<Array<{
  orgId: string;
  companionId: string;
  routineId: string;
  name: string;
  prompt: string;
  cron: string;
  timezone: string;
  scheduledFor: Date;
}>> {
  const result = await input.database.execute<{
    org_id: string;
    companion_id: string;
    routine_id: string;
    name: string;
    prompt: string;
    cron: string;
    timezone: string;
    scheduled_for: Date | string;
  }>(sql`
    select * from public.companion_claim_due_routines(
      ${input.workerId},
      ${input.limit ?? 25},
      ${input.leaseSeconds ?? 60}
    )
  `);
  return rows(result).map((row) => ({
    orgId: String(row.org_id),
    companionId: String(row.companion_id),
    routineId: String(row.routine_id),
    name: row.name,
    prompt: row.prompt,
    cron: row.cron,
    timezone: row.timezone,
    scheduledFor: row.scheduled_for instanceof Date
      ? row.scheduled_for
      : new Date(row.scheduled_for),
  }));
}

export async function fireCompanionRoutine(input: {
  workerId: string;
  orgId: string;
  routineId: string;
  clientMessageId: string;
  scheduledFor: Date;
  nextFireAt: Date;
  database: Db;
}): Promise<{ outcome: string; replayed: boolean }> {
  const result = await input.database.execute<{ outcome: string; replayed: boolean }>(sql`
    select * from public.companion_fire_routine(
      ${input.workerId},
      ${input.orgId}::uuid,
      ${input.routineId}::uuid,
      ${input.clientMessageId}::uuid,
      ${instant(input.scheduledFor)}::timestamptz,
      ${instant(input.nextFireAt)}::timestamptz
    )
  `);
  const [row] = rows(result);
  if (!row) throw new Error("Companion routine fire returned no row");
  return { outcome: row.outcome, replayed: row.replayed };
}

export async function failCompanionRoutineFire(input: {
  workerId: string;
  orgId: string;
  routineId: string;
  errorCode: string;
  errorMessage: string;
  nextFireAt: Date | null;
  database: Db;
}): Promise<void> {
  await input.database.execute(sql`
    select public.companion_fail_routine_fire(
      ${input.workerId},
      ${input.orgId}::uuid,
      ${input.routineId}::uuid,
      ${input.errorCode},
      ${input.errorMessage},
      ${instant(input.nextFireAt)}::timestamptz
    )
  `);
}

export function nextRoutineFireAt(input: {
  cron: string;
  timezone: string;
  after: Date;
  now?: Date;
}): Date {
  const now = input.now ?? new Date();
  const computed = computeNextFireAt(input.cron, input.timezone, input.after);
  const floor = new Date(now.getTime() + COMPANION_ROUTINE_MIN_INTERVAL_MS);
  return computed.getTime() >= floor.getTime() ? computed : floor;
}
