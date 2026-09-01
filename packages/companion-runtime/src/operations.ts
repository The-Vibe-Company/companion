/* oxlint-disable anti-slop/no-conditional-empty-object-spread, anti-slop/no-known-value-widening, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- Existing lifecycle orchestration predates the incremental anti-slop gate. */

import { COMPANION_BUDGETS_BASE } from "@companion/contracts";

import { AmbiguousExternalEffectError, RuntimeInvariantError } from "./errors";
import { mustAbandonRuntimeExecution } from "./executionControl";
import { runtimeSucceeded, type RuntimeWorkDisposition } from "./handler";
import type { LeaseSession } from "./leaseSession";
import { describeThrownError } from "./logging";
import type {
  BoxCreateResult,
  GenerationBox,
  GenerationBoxDiscovery,
  RuntimeEngineDependencies,
} from "./ports";
import {
  isRetryableProviderError,
  retryIdempotentLifecycle,
  type IdempotentLifecycleCall,
} from "./retry";
import {
  activateRuntimeSettings,
  type StagedRuntimeSettings,
} from "./settingsActivation";
import type {
  DuplicateCleanup,
  OperationRuntimeClaim,
  RuntimeAuthorization,
} from "./types";

export const BOX_WARM_TTL_SECONDS = COMPANION_BUDGETS_BASE.boxWarmTtlSeconds;
const PROVIDER_POLL_INTERVAL_MS = 1_000;
// Waiting for a Box to leave provisioning is the one poll where every interval lands directly on
// the member's send-to-ack latency, and a ready GET is cheap, so this loop polls four times as
// often as the conservative default used for absence confirmation and archival waits.
const READY_POLL_INTERVAL_MS = 250;
const ABSENCE_CONFIRMATION_INTERVAL_MS = 30_000;
const PROVIDER_CALL_DEADLINE_MS = COMPANION_BUDGETS_BASE.boxRequestTimeoutMs;
const OPERATION_DEADLINE_MS = COMPANION_BUDGETS_BASE.operationDeadlineMs;

interface OperationContext {
  claim: OperationRuntimeClaim;
  session: LeaseSession;
  deps: RuntimeEngineDependencies;
}

function isProviderNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { status?: unknown }).status === 404);
}

function requiredAuthorization(session: LeaseSession): RuntimeAuthorization {
  const authorization = session.authorization;
  if (!authorization?.authorized || authorization.runtimeGeneration === null) {
    throw new RuntimeInvariantError({
      code: "runtime_authorization_missing",
      message: "Runtime authorization was unavailable at an execution checkpoint.",
      action: "none",
    });
  }
  return authorization;
}

function requiredBoxId(session: LeaseSession): string {
  const boxId = requiredAuthorization(session).boxId;
  if (!boxId) {
    throw new RuntimeInvariantError({
      code: "box_unavailable",
      message: "The Companion Box is unavailable.",
      action: "restart_box",
    });
  }
  return boxId;
}

function workDeadline(context: OperationContext): Date {
  const operationDeadline = new Date(
    context.claim.operationStartedAt.getTime() + OPERATION_DEADLINE_MS,
  );
  const authorization = requiredAuthorization(context.session);
  // A protocol-7 recovery claim is one bounded cleanup cycle, not a replay of the source turn.
  // The turn's cold/absolute deadlines are historical by definition and must never prevent the
  // first provider observation or exact Pi termination in this fresh cycle.
  if (
    authorization.operationKind === "restart_pi"
    && authorization.operationTrigger === "recovery"
  ) return operationDeadline;
  const durable = authorization.coldStartDeadlineAt ?? authorization.absoluteDeadlineAt;
  return durable && durable < operationDeadline ? durable : operationDeadline;
}

function providerCallDeadline(context: OperationContext): Date {
  const local = new Date(context.deps.clock.now().getTime() + PROVIDER_CALL_DEADLINE_MS);
  const durable = workDeadline(context);
  return durable < local ? durable : local;
}

function requirePollingBudget(context: OperationContext, code: string, message: string): void {
  if (context.deps.clock.now().getTime() >= workDeadline(context).getTime()) {
    throw new RuntimeInvariantError({ code, message, action: "retry" });
  }
}

async function lifecycle<T>(
  context: OperationContext,
  call: IdempotentLifecycleCall,
  effect: (input: { signal: AbortSignal; authorization: RuntimeAuthorization }) => Promise<T>,
): Promise<T> {
  return await retryIdempotentLifecycle({
    call,
    clock: context.deps.clock,
    jitter: context.deps.jitter,
    signal: context.session.signal,
    deadlineAt: workDeadline(context),
    operation: async () => await context.session.external(async (signal) => await effect({
      signal,
      authorization: requiredAuthorization(context.session),
    })),
  });
}

async function observe(
  context: OperationContext,
  observation: Omit<Parameters<LeaseSession["observe"]>[0], "runtimeGeneration" | "observedAt">,
): Promise<void> {
  await context.session.observe({
    runtimeGeneration: context.claim.runtimeGeneration,
    observedAt: context.deps.clock.now(),
    ...observation,
  });
}

function exactGenerationName(claim: OperationRuntimeClaim): string {
  return `Companion ${claim.companionId} g${claim.runtimeGeneration.toString()}`;
}

function normalizedDiscovery(
  claim: OperationRuntimeClaim,
  discovery: GenerationBoxDiscovery,
  preferredBoxId: string | null,
): { canonical: GenerationBox | null; duplicates: GenerationBox[] } {
  if (discovery.name !== exactGenerationName(claim)) {
    throw new RuntimeInvariantError({
      code: "box_discovery_contract_invalid",
      message: "Box discovery returned an unexpected generation name.",
      action: "none",
    });
  }
  const boxes = new Map<string, GenerationBox>();
  for (const box of [discovery.canonical, ...discovery.duplicates]) {
    if (!box) continue;
    if (box.name !== discovery.name) {
      throw new RuntimeInvariantError({
        code: "box_discovery_contract_invalid",
        message: "Box discovery returned a non-matching resource.",
        action: "none",
      });
    }
    boxes.set(box.id, box);
  }
  const ordered = [...boxes.values()].sort((left, right) => left.id.localeCompare(right.id));
  const canonical = preferredBoxId
    ? boxes.get(preferredBoxId) ?? null
    : ordered[0] ?? null;
  if (preferredBoxId && !canonical) {
    throw new RuntimeInvariantError({
      code: "box_identity_conflict",
      message: "Provider discovery did not contain the recorded Companion Box.",
      action: "none",
    });
  }
  return {
    canonical,
    duplicates: ordered.filter((box) => box.id !== canonical?.id),
  };
}

async function discover(
  context: OperationContext,
  preferredBoxId = requiredAuthorization(context.session).boxId,
): Promise<{
  canonical: GenerationBox | null;
  duplicates: GenerationBox[];
}> {
  const result = await lifecycle(context, "list_boxes", async ({ signal }) =>
    await context.deps.box.findGenerationBoxes({
      companionId: context.claim.companionId,
      generation: context.claim.runtimeGeneration,
      deadlineAt: providerCallDeadline(context),
      signal,
    }));
  return normalizedDiscovery(context.claim, result, preferredBoxId);
}

async function updateDuplicate(
  context: OperationContext,
  cleanup: DuplicateCleanup,
  nextStatus: DuplicateCleanup["status"],
  providerOperationId?: string,
): Promise<DuplicateCleanup> {
  return await context.session.fencedMutation(async () =>
    await context.deps.store.checkpointDuplicateCleanup(context.session.fence, {
      boxId: cleanup.boxId,
      expectedSequence: cleanup.checkpointSequence,
      nextStatus,
      ...(providerOperationId ? { providerOperationId } : {}),
    }));
}

async function deleteDuplicate(context: OperationContext, initial: DuplicateCleanup): Promise<void> {
  let cleanup = initial;
  if (cleanup.status === "pending") {
    let requested;
    try {
      requested = await lifecycle(context, "request_delete", async ({ signal }) =>
        await context.deps.box.requestPermanentDeletion({ boxId: cleanup.boxId, signal }));
    } catch (error) {
      if (!isProviderNotFound(error)) throw error;
      requested = { outcome: "absent" } as const;
    }
    cleanup = requested.outcome === "absent"
      ? await updateDuplicate(context, cleanup, "already_deleted")
      : await updateDuplicate(context, cleanup, "delete_requested", requested.operationId);
  }
  if (cleanup.status === "delete_requested") {
    cleanup = await updateDuplicate(
      context,
      cleanup,
      "waiting_deleted",
      cleanup.providerOperationId ?? undefined,
    );
  }
  while (cleanup.status === "waiting_deleted") {
    requirePollingBudget(
      context,
      "duplicate_box_delete_deadline_exceeded",
      "A duplicate Box did not finish deleting before its deadline.",
    );
    const operationId = cleanup.providerOperationId;
    if (!operationId) {
      throw new RuntimeInvariantError({
        code: "duplicate_delete_operation_missing",
        message: "Duplicate Box deletion lost its provider operation id.",
        action: "none",
      });
    }
    let result;
    try {
      result = await lifecycle(context, "poll_delete", async ({ signal }) =>
        await context.deps.box.pollPermanentDeletion({
          boxId: cleanup.boxId,
          operationId,
          signal,
        }));
    } catch (error) {
      if (!isProviderNotFound(error)) throw error;
      cleanup = await updateDuplicate(context, cleanup, "already_deleted", operationId);
      break;
    }
    if (result.status === "completed") {
      cleanup = await updateDuplicate(context, cleanup, "deleted", operationId);
      break;
    }
    // `blocked` is an in-progress provider status: poll until `completed` or the deadline.
    await context.deps.clock.sleep(PROVIDER_POLL_INTERVAL_MS, context.session.signal);
  }
  // SQL treats persisted duplicate-cleanup `blocked` as terminal (completed_at set, no resume
  // transition). New polls no longer write that status; this guard only covers leftover rows.
  if (cleanup.status === "blocked") {
    throw new RuntimeInvariantError({
      code: "duplicate_box_delete_blocked",
      message: "A duplicate generation Box could not be permanently deleted.",
      action: "none",
    });
  }
}

async function cleanDuplicates(context: OperationContext, duplicates: GenerationBox[]): Promise<void> {
  const cleanups = await context.session.fencedMutation(async () =>
    await context.deps.store.registerDuplicateCleanups(
      context.session.fence,
      duplicates.map((box) => box.id),
    ));
  for (const cleanup of cleanups) await deleteDuplicate(context, cleanup);
}

async function boxStatus(context: OperationContext, boxId: string): Promise<GenerationBox["state"]> {
  try {
    return (await lifecycle(context, "get_status", async ({ signal }) =>
      await context.deps.box.getStatus({
        boxId,
        companionId: context.claim.companionId,
        generation: context.claim.runtimeGeneration,
        signal,
      }))).state;
  } catch (error) {
    if (isProviderNotFound(error)) return "absent";
    throw error;
  }
}

async function observeKnownBoxState(
  context: OperationContext,
  authorization: RuntimeAuthorization,
): Promise<GenerationBox["state"]> {
  if (!authorization.boxId) return "absent";
  const state = await boxStatus(context, authorization.boxId);
  await observe(context, {
    boxId: authorization.boxId,
    boxState: state,
    ...((state === "absent" || state === "archived") ? { piState: "absent" as const } : {}),
  });
  return state;
}

function isReady(state: GenerationBox["state"]): boolean {
  return state === "ready" || state === "idle" || state === "running";
}

function logStageTiming(
  context: OperationContext,
  stage: "waiting_ready" | "installing_layout" | "starting_pi",
  startedAt: number,
  detail: Record<string, unknown> = {},
): void {
  context.deps.log?.info({
    ts: context.deps.clock.now().toISOString(),
    event: "runtime.operation.stage",
    stage,
    durationMs: Math.max(0, context.deps.clock.now().getTime() - startedAt),
    companionId: context.claim.companionId,
    operationKind: context.claim.operationKind,
    boxId: context.session.authorization?.boxId ?? null,
    ...detail,
  });
}

async function waitForReadyBox(context: OperationContext): Promise<void> {
  const startedAt = context.deps.clock.now().getTime();
  const boxId = requiredBoxId(context.session);
  for (;;) {
    requirePollingBudget(
      context,
      "box_start_deadline_exceeded",
      "The Companion Box did not become ready before its deadline.",
    );
    const state = await boxStatus(context, boxId);
    await observe(context, { boxId, boxState: state ?? "unknown" });
    if (isReady(state)) {
      logStageTiming(context, "waiting_ready", startedAt);
      context.deps.log?.info({
        ts: context.deps.clock.now().toISOString(),
        event: "runtime.box.provider_ready",
        companionId: context.claim.companionId,
        operationKind: context.claim.operationKind,
        boxId,
      });
      return;
    }
    if (state === "absent" || state === "archived" || state === "error") {
      throw new RuntimeInvariantError({
        code: "box_start_failed",
        message: "The Companion Box did not become ready.",
        action: "restart_box",
      });
    }
    await context.deps.clock.sleep(READY_POLL_INTERVAL_MS, context.session.signal);
  }
}

async function stageCapturedResources(
  context: OperationContext,
  options: { preserveInstalledSkills?: boolean } = {},
): Promise<StagedRuntimeSettings> {
  const startedAt = context.deps.clock.now().getTime();
  const authorization = requiredAuthorization(context.session);
  if (
    authorization.clientSurface === null
    || authorization.desiredSettingsRevision === null
    || authorization.skillsRevision === null
  ) {
    throw new RuntimeInvariantError({
      code: "runtime_resource_snapshot_missing",
      message: "The captured runtime resource snapshot is incomplete.",
      action: "none",
    });
  }
  const clientSurface = authorization.clientSurface;
  const targetSettingsRevision = authorization.desiredSettingsRevision;
  const targetSkillsRevision = authorization.skillsRevision;
  const material = await context.session.fencedLookup(async () =>
    await context.deps.materialProvider.getMaterial({
      store: context.deps.store,
      fence: context.session.fence,
      signal: context.session.signal,
    }));
  const staged = await context.session.external(async (signal) =>
    await context.deps.resourceStager.stageExistingBox({
      orgId: context.claim.orgId,
      companionId: context.claim.companionId,
      boxId: requiredBoxId(context.session),
      allowBoxCreate: false,
      authorization: requiredAuthorization(context.session),
      material,
      clientSurface,
      targetSettingsRevision,
      targetSkillsRevision,
      preserveInstalledSkills: options.preserveInstalledSkills,
      signal,
    }));
  if (!options.preserveInstalledSkills && staged.appliedSkillsRevision !== null && staged.skillsDigest) {
    const committed = await context.session.fencedMutation(async () =>
      await context.deps.store.commitSkillUpdate(context.session.fence, {
        targetSkillsRevision: staged.appliedSkillsRevision!,
        requiredSkillsRevision: staged.appliedSkillsRevision!,
        selectedSkillIds: authorization.skillRefs.map((ref) => ref.skill_id),
        skillRefs: authorization.skillRefs,
        skillMaterial: material.skillMaterial,
        skillsDigest: staged.skillsDigest!,
      }));
    if (!committed) throw new Error("Skill snapshot fence was lost");
  }
  await context.session.fencedMutation(async () =>
    await context.deps.store.recordMaterialSnapshot(context.session.fence, {
      clientSurface,
      materialExpiresAt: staged.materialExpiresAt,
      agentEndpoint: staged.agentEndpoint ?? null,
    }));
  logStageTiming(context, "installing_layout", startedAt, {
    stagingMode: staged.stagingMode ?? "skills",
    skillBytesTransferred: staged.skillBytesTransferred ?? 0,
  });
  return staged;
}

async function applyCapturedSkillUpdate(context: OperationContext): Promise<void> {
  const authorization = requiredAuthorization(context.session);
  if (
    authorization.targetSkillsRevision === null
    || (authorization.appliedSkillsRevision ?? 0) >= authorization.targetSkillsRevision
  ) return;
  const material = await context.session.fencedMutation(async () =>
    await context.deps.store.getSkillUpdateMaterial(context.session.fence, 30));
  const blocking = material !== null
    && (authorization.appliedSkillsRevision ?? 0) < material.requiredSkillsRevision;
  if (!material) {
    await context.session.fencedMutation(async () =>
      await context.deps.store.recordSkillUpdateError(context.session.fence, {
        code: "skill_auto_update_unauthorized",
        message: "The pending Skill update is no longer authorized and will be retried later.",
      }));
    return;
  }
  try {
    const staged = await context.session.external(async (signal) =>
      await context.deps.resourceStager.stageSkillTree({
        orgId: context.claim.orgId,
        companionId: context.claim.companionId,
        boxId: requiredBoxId(context.session),
        authorization,
        material,
        signal,
      }));
    const committed = await context.session.fencedMutation(async () =>
      await context.deps.store.commitSkillUpdate(context.session.fence, {
        ...material,
        skillsDigest: staged.skillsDigest,
      }));
    if (!committed) throw new Error("Skill update fence was lost");
  } catch (error) {
    if (mustAbandonRuntimeExecution(error)) throw error;
    context.deps.log?.warn({
      ts: context.deps.clock.now().toISOString(),
      event: "runtime.skills.auto_update_failed",
      companionId: context.claim.companionId,
      operationKind: context.claim.operationKind,
      blocking,
      error: describeThrownError(error),
    });
    await context.session.fencedMutation(async () =>
      await context.deps.store.recordSkillUpdateError(context.session.fence, {
        code: blocking ? "skill_update_failed" : "skill_auto_update_failed",
        message: blocking
          ? "The required Skill selection could not be installed."
          : "The automatic Skill update failed and will be retried at the next Pi stop or restart.",
      }));
    if (blocking) throw error;
  }
}

async function publishStagedResources(
  context: OperationContext,
  piInvocationId: string,
): Promise<void> {
  await context.session.fencedMutation(async () =>
    await context.deps.store.publishMaterialSnapshot(context.session.fence, { piInvocationId }));
}

async function observeStagedResources(
  context: OperationContext,
  staged: StagedRuntimeSettings,
): Promise<void> {
  await observe(context, {
    diskLayoutVersion: staged.diskLayoutVersion,
    appliedSettingsRevision: staged.appliedSettingsRevision,
    ...(staged.appliedSkillsRevision === null
      ? {}
      : { appliedSkillsRevision: staged.appliedSkillsRevision }),
  });
}

async function startAndObservePi(context: OperationContext): Promise<void> {
  const startedAt = context.deps.clock.now().getTime();
  const previousInvocationId = requiredAuthorization(context.session).piInvocationId;
  const result = await lifecycle(context, "start_pi", async ({ signal }) =>
    await context.deps.pi.restartPiDaemon({ boxId: requiredBoxId(context.session), signal }));
  if (
    result.state !== "idle"
    || !result.invocationId
    || (previousInvocationId !== null && result.invocationId === previousInvocationId)
  ) {
    throw new RuntimeInvariantError({
      code: "pi_start_failed",
      message: "Pi did not expose a new idle invocation after start.",
      action: "restart_pi",
    });
  }
  await observe(context, { piState: "idle", piInvocationId: result.invocationId });
  logStageTiming(context, "starting_pi", startedAt);
}

async function handleStart(context: OperationContext): Promise<RuntimeWorkDisposition> {
  for (;;) {
    const authorization = await context.session.reauthorize();
    switch (authorization.workCheckpoint) {
      case "pending":
        await context.session.checkpoint({ nextCheckpoint: "resolving_box" });
        break;
      case "resolving_box": {
        const knownBoxId = authorization.boxId;
        if (knownBoxId) {
          const state = await boxStatus(context, knownBoxId);
          if (state !== "absent") {
            await observe(context, { boxId: knownBoxId, boxState: state ?? "unknown" });
            break;
          }
        }
        // An absent durable id can still be the aftermath of an ambiguous replacement. Only this
        // fallback (and the no-id path) pays for a full account listing.
        const discovery = await discover(context, null);
        await cleanDuplicates(context, discovery.duplicates);
        if (!discovery.canonical) {
          await observe(context, { boxState: "absent" });
          break;
        }
        const state = discovery.canonical.state
          ?? await boxStatus(context, discovery.canonical.id)
          ?? "unknown";
        await observe(context, {
          boxId: discovery.canonical.id,
          boxState: state,
        });
        break;
      }
      case "box_absence_observed":
        await context.session.checkpoint({ nextCheckpoint: "creating_box" });
        break;
      case "creating_box": {
        // A takeover may reconcile the deterministic name, but it must never resend the POST.
        if (context.claim.checkpoint === "creating_box") {
          const discovery = await discover(context);
          await cleanDuplicates(context, discovery.duplicates);
          if (!discovery.canonical) throw new AmbiguousExternalEffectError("box_create_ambiguous");
          await lifecycle(context, "apply_box_settings", async ({ signal }) =>
            await context.deps.box.applyGenerationBoxSettings({
              boxId: discovery.canonical!.id,
              companionId: context.claim.companionId,
              generation: context.claim.runtimeGeneration,
              ttlSeconds: BOX_WARM_TTL_SECONDS,
              deadlineAt: providerCallDeadline(context),
              signal,
            }));
          await observe(context, {
            boxId: discovery.canonical.id,
            boxState: discovery.canonical.state ?? "unknown",
          });
          break;
        }
        let result: BoxCreateResult;
        let providerCallStarted = false;
        try {
          result = await context.session.external(async (signal) => {
            const deadlineAt = providerCallDeadline(context);
            providerCallStarted = true;
            return await context.deps.box.createGenerationBox({
              companionId: context.claim.companionId,
              generation: context.claim.runtimeGeneration,
              ttlSeconds: BOX_WARM_TTL_SECONDS,
              deadlineAt,
              // The snapshot wait is bounded by the whole operation's cold-start budget, not the
              // single-call `deadlineAt`, so a ready image is worth waiting for before cold install.
              imageWaitDeadlineAt: workDeadline(context),
              signal,
            });
          });
        } catch (error) {
          // A RuntimeInvariantError here is a deliberate pre-POST refusal (strict-image mode), never
          // an ambiguous provider effect, so it must surface with its own stable code, not as
          // box_create_ambiguous.
          if (
            !providerCallStarted
            || mustAbandonRuntimeExecution(error)
            || error instanceof RuntimeInvariantError
          ) throw error;
          throw new AmbiguousExternalEffectError("box_create_ambiguous");
        }
        let boxId = result.boxId;
        if (result.outcome === "recovered") {
          const recovered = normalizedDiscovery(context.claim, result, result.boxId);
          await cleanDuplicates(context, recovered.duplicates);
          if (!recovered.canonical) {
            throw new AmbiguousExternalEffectError("box_create_ambiguous");
          }
          boxId = recovered.canonical.id;
        } else if (result.name !== exactGenerationName(context.claim)) {
          throw new AmbiguousExternalEffectError("box_create_ambiguous");
        }
        await observe(context, { boxId, boxState: "unknown" });
        break;
      }
      case "box_resolved":
      case "box_created": {
        const boxId = requiredBoxId(context.session);
        if (authorization.workCheckpoint === "box_resolved") {
          if (authorization.boxState === "archived") {
            await lifecycle(context, "resume_box", async ({ signal }) =>
              await context.deps.box.resumeExistingBox({ boxId, signal }));
          }
        } else {
          await lifecycle(context, "apply_box_settings", async ({ signal }) =>
            await context.deps.box.applyGenerationBoxSettings({
              boxId,
              companionId: context.claim.companionId,
              generation: context.claim.runtimeGeneration,
              ttlSeconds: BOX_WARM_TTL_SECONDS,
              deadlineAt: providerCallDeadline(context),
              signal,
            }));
          // Naming is the create idempotency boundary. Re-list once after the PATCH so a
          // concurrent create is recorded in the durable child ledger before work advances.
          const namedDiscovery = await discover(context);
          if (namedDiscovery.canonical?.id !== boxId) {
            throw new RuntimeInvariantError({
              code: "box_identity_conflict",
              message: "Provider discovery did not preserve the recorded Companion Box.",
              action: "none",
            });
          }
          await cleanDuplicates(context, namedDiscovery.duplicates);
        }
        await context.session.checkpoint({ nextCheckpoint: "waiting_ready" });
        break;
      }
      case "waiting_ready":
        await waitForReadyBox(context);
        break;
      case "box_ready_observed":
        await context.session.checkpoint({ nextCheckpoint: "installing_layout" });
        break;
      case "installing_layout":
        await observeStagedResources(context, await stageCapturedResources(context));
        await context.session.checkpoint({ nextCheckpoint: "starting_pi" });
        break;
      case "starting_pi":
        await startAndObservePi(context);
        break;
      case "pi_observed":
        await publishStagedResources(context, requiredAuthorization(context.session).piInvocationId!);
        await context.session.checkpoint({ nextCheckpoint: "pi_ready" });
        break;
      case "pi_ready":
        return runtimeSucceeded;
      default:
        throw new RuntimeInvariantError({
          code: "operation_checkpoint_invalid",
          message: "The start operation reached an unsupported checkpoint.",
          action: "none",
        });
    }
  }
}

async function handleStop(context: OperationContext): Promise<RuntimeWorkDisposition> {
  for (;;) {
    const authorization = await context.session.reauthorize();
    switch (authorization.workCheckpoint) {
      case "pending":
        await context.session.checkpoint({ nextCheckpoint: "stopping_pi" });
        break;
      case "stopping_pi":
        if (authorization.boxId) {
          await lifecycle(context, "stop_pi", async ({ signal }) =>
            await context.deps.pi.stopPiDaemon({ boxId: requiredBoxId(context.session), signal }));
          await applyCapturedSkillUpdate(context);
        }
        await context.session.checkpoint({ nextCheckpoint: "provider_stop_requested" });
        break;
      case "provider_stop_requested":
        if (authorization.boxId) {
          await lifecycle(context, "stop_box", async ({ signal }) =>
            await context.deps.box.stopExistingBox({ boxId: requiredBoxId(context.session), signal }));
        }
        await context.session.checkpoint({ nextCheckpoint: "waiting_archived" });
        break;
      case "waiting_archived": {
        if (!authorization.boxId) {
          throw new RuntimeInvariantError({
            code: "box_unavailable",
            message: "The Companion Box identity is unavailable for stop.",
            action: "none",
          });
        }
        requirePollingBudget(
          context,
          "box_stop_deadline_exceeded",
          "The Companion Box did not archive before its deadline.",
        );
        const state = await boxStatus(context, authorization.boxId);
        await observe(context, { boxId: authorization.boxId, boxState: state ?? "unknown" });
        if (state === "absent" || state === "error") {
          throw new RuntimeInvariantError({
            code: "box_stop_failed",
            message: "The Companion Box could not be observed as archived.",
            action: "retry",
          });
        }
        if (state !== "archived") {
          requirePollingBudget(
            context,
            "box_stop_deadline_exceeded",
            "The Companion Box did not archive before its deadline.",
          );
          await context.deps.clock.sleep(PROVIDER_POLL_INTERVAL_MS, context.session.signal);
        }
        break;
      }
      case "box_archived":
        return runtimeSucceeded;
      default:
        throw new RuntimeInvariantError({
          code: "operation_checkpoint_invalid",
          message: "The stop operation reached an unsupported checkpoint.",
          action: "none",
        });
    }
  }
}

async function handleRestartPi(context: OperationContext): Promise<RuntimeWorkDisposition> {
  for (;;) {
    const authorization = await context.session.reauthorize();
    switch (authorization.workCheckpoint) {
      case "pending":
        await lifecycle(context, "stop_pi", async ({ signal }) =>
          await context.deps.pi.stopPiDaemon({ boxId: requiredBoxId(context.session), signal }));
        await applyCapturedSkillUpdate(context);
        await stageCapturedResources(context, { preserveInstalledSkills: true });
        await context.session.checkpoint({ nextCheckpoint: "restarting_pi" });
        break;
      case "restarting_pi":
        await lifecycle(context, "restart_pi", async ({ signal }) =>
          await context.deps.pi.restartPiDaemon({ boxId: requiredBoxId(context.session), signal }));
        await context.session.checkpoint({ nextCheckpoint: "starting_pi" });
        break;
      case "starting_pi": {
        const result = await lifecycle(context, "get_status", async ({ signal }) =>
          await context.deps.pi.piDaemonStatus({ boxId: requiredBoxId(context.session), signal }));
        if (result.state === "error" || result.state === "absent") {
          throw new RuntimeInvariantError({
            code: "pi_start_failed",
            message: "Pi failed while restarting.",
            action: "restart_pi",
          });
        }
        if (
          result.state !== "idle"
          || !result.invocationId
          || result.invocationId === authorization.piInvocationId
        ) {
          requirePollingBudget(
            context,
            "pi_restart_deadline_exceeded",
            "Pi did not expose a new idle invocation before the restart deadline.",
          );
          await context.deps.clock.sleep(PROVIDER_POLL_INTERVAL_MS, context.session.signal);
          break;
        }
        await observe(context, { piState: "idle", piInvocationId: result.invocationId });
        break;
      }
      case "pi_observed":
        await publishStagedResources(context, requiredAuthorization(context.session).piInvocationId!);
        await context.session.checkpoint({ nextCheckpoint: "pi_ready" });
        break;
      case "pi_ready":
        return runtimeSucceeded;
      default:
        throw new RuntimeInvariantError({
          code: "operation_checkpoint_invalid",
          message: "The Pi restart operation reached an unsupported checkpoint.",
          action: "none",
        });
    }
  }
}

function recoveryHadPossiblePiWrite(authorization: RuntimeAuthorization): boolean {
  return authorization.sourceDispatchState === "write_intent"
    || authorization.sourceDispatchState === "accepted"
    || authorization.sourceDispatchState === "ambiguous";
}

/**
 * Resolve one interrupted turn without replaying it or rebuilding the Companion runtime.
 *
 * This path deliberately has no material-provider, resource-stager, Skill, MCP, model, provider
 * token, Pi start, or Box lifecycle call. Its only permitted external effects are a Box GET and
 * termination of the exact Pi invocation captured with the interrupted dispatch.
 */
async function handleRecoveryCleanup(context: OperationContext): Promise<RuntimeWorkDisposition> {
  const authorization = await context.session.reauthorize();
  if (authorization.workCheckpoint === "cleanup_complete"
    || authorization.workCheckpoint === "pi_ready") return runtimeSucceeded;
  if (
    authorization.operationKind !== "restart_pi"
    || authorization.operationTrigger !== "recovery"
    || authorization.operationLane === null
    || authorization.turnId === null
    || authorization.turnStatus !== "interrupted"
    || !["pending", "restarting_pi", "starting_pi", "pi_observed"].includes(
      authorization.workCheckpoint,
    )
  ) {
    throw new RuntimeInvariantError({
      code: "recovery_cleanup_contract_invalid",
      message: "The interrupted turn cleanup identity is incomplete.",
      action: "none",
    });
  }

  // Pending/rejected dispatch is durable negative proof: no Pi prompt could be running.
  if (!recoveryHadPossiblePiWrite(authorization)) {
    await context.session.checkpoint({ nextCheckpoint: "cleanup_complete" });
    return runtimeSucceeded;
  }

  // A missing durable Box id and a provider-observed absent/archived Box are both terminal proof
  // that the captured Pi invocation no longer exists. Never resume the Box to perform cleanup.
  if (
    !authorization.boxId
    || authorization.boxState === "absent"
    || authorization.boxState === "archived"
  ) {
    await context.session.checkpoint({ nextCheckpoint: "cleanup_complete" });
    return runtimeSucceeded;
  }
  const boxState = await observeKnownBoxState(context, authorization);
  if (boxState === "absent" || boxState === "archived") {
    const observed = await context.session.reauthorize();
    if (observed.workCheckpoint !== "pi_ready") {
      await context.session.checkpoint({ nextCheckpoint: "cleanup_complete" });
    }
    return runtimeSucceeded;
  }

  const expectedInvocationId = authorization.sourcePiInvocationId;
  if (!expectedInvocationId) {
    throw new RuntimeInvariantError({
      code: "recovery_invocation_missing",
      message: "The interrupted turn cleanup lacks its exact Pi invocation.",
      action: "none",
    });
  }

  if (authorization.operationLane === "routine") {
    const routine = context.deps.pi.routineSession;
    if (!routine) {
      throw new RuntimeInvariantError({
        code: "routine_session_unavailable",
        message: "The isolated routine session control is unavailable.",
        action: "retry",
      });
    }
    if (!expectedInvocationId.startsWith(`routine:${authorization.turnId}:`)) {
      throw new RuntimeInvariantError({
        code: "routine_session_invocation_mismatch",
        message: "The recovery routine identity did not match its interrupted run.",
        action: "none",
      });
    }
    await lifecycle(context, "terminate_pi_invocation", async ({ signal }) =>
      await routine.terminate({
        boxId: authorization.boxId!,
        runId: authorization.turnId!,
        expectedInvocationId,
        signal,
      }));
  } else {
    const result = await lifecycle(context, "terminate_pi_invocation", async ({ signal }) =>
      await context.deps.pi.terminatePiInvocation({
        boxId: authorization.boxId!,
        expectedInvocationId,
        signal,
      }));
    if (result.outcome !== "superseded") {
      await observe(context, { piState: "absent" });
    }
  }
  await context.session.checkpoint({ nextCheckpoint: "cleanup_complete" });
  return runtimeSucceeded;
}

async function handleIsolatedRoutineRetry(
  context: OperationContext,
): Promise<RuntimeWorkDisposition | null> {
  if (context.claim.turnId === null) return null;
  const authorization = await context.session.reauthorize();
  if (authorization.workCheckpoint === "pi_ready") return runtimeSucceeded;
  if (authorization.workCheckpoint !== "pending") {
    throw new RuntimeInvariantError({
      code: "operation_checkpoint_invalid",
      message: "The isolated routine retry reached an unsupported checkpoint.",
      action: "none",
    });
  }
  const material = await context.session.fencedLookup(async () =>
    await context.deps.materialProvider.getMaterial({
      store: context.deps.store,
      fence: context.session.fence,
      signal: context.session.signal,
    }));
  if (material === null) {
    throw new RuntimeInvariantError({
      code: "runtime_resource_snapshot_missing",
      message: "The retry resource snapshot is unavailable.",
      action: "retry",
    });
  }
  if (material.routineId === null) return null;
  if (!material.routineIsolated) return null;
  const runId = context.claim.turnId;
  const routine = context.deps.pi.routineSession;
  if (!routine) {
    throw new RuntimeInvariantError({
      code: "routine_session_unavailable",
      message: "The isolated routine session control is unavailable.",
      action: "retry",
    });
  }
  const invocationId = requiredAuthorization(context.session).commandPiInvocationId;
  if (invocationId === null) {
    await context.session.checkpoint({ nextCheckpoint: "pi_ready" });
    return runtimeSucceeded;
  }
  if (!invocationId.startsWith(`routine:${runId}:`)) {
    throw new RuntimeInvariantError({
      code: "routine_session_invocation_mismatch",
      message: "The isolated routine retry identity did not match its run.",
      action: "retry",
    });
  }
  await lifecycle(context, "stop_pi", async ({ signal }) =>
    await routine.terminate({
      boxId: requiredBoxId(context.session),
      runId,
      expectedInvocationId: invocationId,
      signal,
    }));
  await context.session.checkpoint({ nextCheckpoint: "pi_ready" });
  return runtimeSucceeded;
}

/**
 * Permanent deletion and an explicit full-Box restart may preempt an isolated routine. The claim
 * transaction stores the routine turn as the lifecycle source, and v2 authorization resolves
 * that turn to the exact attempt-bound invocation. Keep the identity check here as the last local
 * guard before the run-scoped terminate call; a routine id or invocation from another run must
 * never be sent to Pi.
 */
async function terminateCapturedRoutineForLifecycle(
  context: OperationContext,
  authorization: RuntimeAuthorization,
): Promise<void> {
  const runId = authorization.turnId;
  const invocationId = authorization.commandPiInvocationId;
  if (!runId || !invocationId) return;

  const routine = context.deps.pi.routineSession;
  if (!routine) {
    throw new RuntimeInvariantError({
      code: "routine_session_unavailable",
      message: "The isolated routine session control is unavailable.",
      action: "retry",
    });
  }
  if (!invocationId.startsWith(`routine:${runId}:`)) {
    throw new RuntimeInvariantError({
      code: "routine_session_invocation_mismatch",
      message: "The lifecycle routine identity did not match its run.",
      action: "retry",
    });
  }

  await lifecycle(context, "stop_pi", async ({ signal }) =>
    await routine.terminate({
      boxId: requiredBoxId(context.session),
      runId,
      expectedInvocationId: invocationId,
      signal,
    }));
}

async function handleRestartBox(context: OperationContext): Promise<RuntimeWorkDisposition> {
  for (;;) {
    const authorization = await context.session.reauthorize();
    switch (authorization.workCheckpoint) {
      case "pending": {
        const state = await observeKnownBoxState(context, authorization);
        if (state === "absent") {
          throw new RuntimeInvariantError({
            code: "box_unavailable",
            message: "The Companion Box is unavailable for restart.",
            action: "restart_box",
          });
        }
        if (state !== "archived") {
          await terminateCapturedRoutineForLifecycle(context, authorization);
          await lifecycle(context, "stop_pi", async ({ signal }) =>
            await context.deps.pi.stopPiDaemon({ boxId: requiredBoxId(context.session), signal }));
          await applyCapturedSkillUpdate(context);
        }
        await context.session.checkpoint({ nextCheckpoint: "skills_updated" });
        break;
      }
      case "skills_updated":
        await context.session.checkpoint({ nextCheckpoint: "restarting_box" });
        break;
      case "restarting_box": {
        if (authorization.boxState !== "archived") {
          await lifecycle(context, "stop_box", async ({ signal }) =>
            await context.deps.box.stopExistingBox({ boxId: requiredBoxId(context.session), signal }));
          for (;;) {
            requirePollingBudget(
              context,
              "box_restart_deadline_exceeded",
              "The Companion Box did not archive before restart deadline.",
            );
            const state = await boxStatus(context, requiredBoxId(context.session));
            if (state === "archived") break;
            if (state === "absent" || state === "error") {
              throw new RuntimeInvariantError({
                code: "box_restart_failed",
                message: "The Companion Box could not be archived for restart.",
                action: "restart_box",
              });
            }
            await context.deps.clock.sleep(PROVIDER_POLL_INTERVAL_MS, context.session.signal);
          }
        }
        await lifecycle(context, "resume_box", async ({ signal }) =>
          await context.deps.box.resumeExistingBox({ boxId: requiredBoxId(context.session), signal }));
        await context.session.checkpoint({ nextCheckpoint: "waiting_ready" });
        break;
      }
      case "waiting_ready":
        await waitForReadyBox(context);
        break;
      case "box_ready_observed":
        await context.session.checkpoint({ nextCheckpoint: "installing_layout" });
        break;
      case "installing_layout":
        await applyCapturedSkillUpdate(context);
        await observeStagedResources(
          context,
          await stageCapturedResources(context, { preserveInstalledSkills: true }),
        );
        await context.session.checkpoint({ nextCheckpoint: "starting_pi" });
        break;
      case "starting_pi":
        await startAndObservePi(context);
        break;
      case "pi_observed":
        await publishStagedResources(context, requiredAuthorization(context.session).piInvocationId!);
        await context.session.checkpoint({ nextCheckpoint: "pi_ready" });
        break;
      case "pi_ready":
        return runtimeSucceeded;
      default:
        throw new RuntimeInvariantError({
          code: "operation_checkpoint_invalid",
          message: "The Box restart operation reached an unsupported checkpoint.",
          action: "none",
        });
    }
  }
}

async function handleApplySettings(context: OperationContext): Promise<RuntimeWorkDisposition> {
  for (;;) {
    const authorization = await context.session.reauthorize();
    switch (authorization.workCheckpoint) {
      case "pending":
        await lifecycle(context, "stop_pi", async ({ signal }) =>
          await context.deps.pi.stopPiDaemon({ boxId: requiredBoxId(context.session), signal }));
        await applyCapturedSkillUpdate(context);
        await context.session.checkpoint({ nextCheckpoint: "applying_settings" });
        break;
      case "applying_settings": {
        if (authorization.targetSettingsRevision === null) {
          throw new RuntimeInvariantError({
            code: "runtime_resource_snapshot_missing",
            message: "The captured runtime resource snapshot is incomplete.",
            action: "none",
          });
        }
        const activated = await activateRuntimeSettings({
          expectedSettingsRevision: authorization.targetSettingsRevision,
          expectedSkillsRevision: authorization.appliedSkillsRevision,
          previousPiInvocationId: authorization.piInvocationId,
          deadlineAt: workDeadline(context),
          clock: context.deps.clock,
          signal: context.session.signal,
          stage: async () => await stageCapturedResources(context, { preserveInstalledSkills: true }),
          restartPi: async () => await lifecycle(context, "restart_pi", async ({ signal }) =>
            await context.deps.pi.restartPiDaemon({
              boxId: requiredBoxId(context.session),
              signal,
            })),
          observePi: async () => await lifecycle(context, "get_status", async ({ signal }) =>
            await context.deps.pi.piDaemonStatus({
              boxId: requiredBoxId(context.session),
              signal,
            })),
        });
        // Pi activation atomically moves the staged provider environment into user-runtime tmpfs.
        // Publish the revisions only together with proof of the new idle invocation; a takeover
        // before this observation safely repeats the idempotent stage + Pi restart sequence.
        await observe(context, {
          piState: activated.piState,
          piInvocationId: activated.piInvocationId,
          appliedSettingsRevision: activated.appliedSettingsRevision,
          ...(activated.appliedSkillsRevision === null
            ? {}
            : { appliedSkillsRevision: activated.appliedSkillsRevision }),
        });
        await publishStagedResources(context, activated.piInvocationId);
        return runtimeSucceeded;
      }
      case "settings_applied":
        await publishStagedResources(context, requiredAuthorization(context.session).piInvocationId!);
        return runtimeSucceeded;
      default:
        throw new RuntimeInvariantError({
          code: "operation_checkpoint_invalid",
          message: "The settings operation reached an unsupported checkpoint.",
          action: "none",
        });
    }
  }
}

async function handleDelete(context: OperationContext): Promise<RuntimeWorkDisposition> {
  let routineTerminationComplete = false;
  for (;;) {
    const authorization = await context.session.reauthorize();
    switch (authorization.workCheckpoint) {
      case "pending": {
        if (!routineTerminationComplete) {
          await terminateCapturedRoutineForLifecycle(context, authorization);
          routineTerminationComplete = true;
        }
        let boxId = authorization.boxId;
        if (!boxId) {
          const discovery = await discover(context);
          if (discovery.duplicates.length > 0) {
            throw new RuntimeInvariantError({
              code: "box_identity_conflict",
              message: "Deletion found multiple generation Boxes without a canonical identity.",
              action: "none",
            });
          }
          if (!discovery.canonical) {
            await observe(context, { boxState: "absent" });
            break;
          }
          boxId = discovery.canonical.id;
          await observe(context, {
            boxId,
            boxState: discovery.canonical.state ?? "unknown",
          });
          break;
        }
        const request = await requestPermanentDelete(context, boxId);
        if (request.outcome === "absent") {
          await observe(context, { boxState: "absent" });
          break;
        }
        await context.session.checkpoint({
          nextCheckpoint: "provider_delete_requested",
          providerOperationId: request.operationId,
        });
        break;
      }
      case "box_absence_observed": {
        if (!routineTerminationComplete) {
          await terminateCapturedRoutineForLifecycle(context, authorization);
          routineTerminationComplete = true;
        }
        requirePollingBudget(
          context,
          "box_delete_deadline_exceeded",
          "Box absence could not be confirmed before the delete deadline.",
        );
        await context.deps.clock.sleep(ABSENCE_CONFIRMATION_INTERVAL_MS, context.session.signal);
        const discovery = await discover(context);
        if (discovery.canonical) {
          await cleanDuplicates(context, discovery.duplicates);
          await observe(context, {
            boxId: discovery.canonical.id,
            boxState: discovery.canonical.state ?? "unknown",
          });
          const request = await requestPermanentDelete(context, discovery.canonical.id);
          if (request.outcome === "absent") {
            await observe(context, { boxState: "absent" });
            break;
          }
          await context.session.checkpoint({
            nextCheckpoint: "provider_delete_requested",
            providerOperationId: request.operationId,
          });
        } else {
          await observe(context, { boxState: "absent" });
        }
        break;
      }
      case "provider_delete_requested":
        await context.session.checkpoint({
          nextCheckpoint: "waiting_deleted",
          ...(authorization.providerOperationId
            ? { providerOperationId: authorization.providerOperationId }
            : {}),
        });
        break;
      case "waiting_deleted": {
        const boxId = requiredBoxId(context.session);
        const operationId = authorization.providerOperationId;
        if (!operationId) {
          throw new RuntimeInvariantError({
            code: "box_delete_operation_missing",
            message: "Permanent Box deletion lost its provider operation id.",
            action: "none",
          });
        }
        let poll;
        try {
          // An accepted delete is resumed one provider read at a time. PostgreSQL schedules the
          // next claim, so no runtime slot remains occupied and the DELETE is never replayed.
          poll = await context.session.external(async (signal) =>
            await context.deps.box.pollPermanentDeletion({ boxId, operationId, signal }));
        } catch (error) {
          if (isProviderNotFound(error)) {
            poll = { status: "completed" } as const;
          } else if (isRetryableProviderError(Object(error))) {
            return { kind: "defer_delete" };
          } else {
            throw error;
          }
        }
        if (poll.status === "completed") {
          await observe(context, { boxState: "absent" });
        } else {
          return { kind: "defer_delete" };
        }
        break;
      }
      case "box_absent":
      case "provider_deleted":
        return runtimeSucceeded;
      default:
        throw new RuntimeInvariantError({
          code: "operation_checkpoint_invalid",
          message: "The delete operation reached an unsupported checkpoint.",
          action: "none",
        });
    }
  }
}

async function requestPermanentDelete(
  context: OperationContext,
  boxId: string,
): Promise<Awaited<ReturnType<RuntimeEngineDependencies["box"]["requestPermanentDeletion"]>>> {
  try {
    return await lifecycle(context, "request_delete", async ({ signal }) =>
      await context.deps.box.requestPermanentDeletion({ boxId, signal }));
  } catch (error) {
    if (!isProviderNotFound(error)) throw error;
    return { outcome: "absent" };
  }
}

export async function handleOperation(
  context: OperationContext,
): Promise<RuntimeWorkDisposition> {
  context.deps.log?.info({
    ts: context.deps.clock.now().toISOString(),
    event: "runtime.operation.claimed",
    companionId: context.claim.companionId,
    operationKind: context.claim.operationKind,
    checkpoint: context.claim.checkpoint,
  });
  switch (context.claim.operationKind) {
    case "start": {
      const isTurnDerivedStart = context.claim.turnId !== null
        && requiredAuthorization(context.session).operationTrigger === "turn";
      try {
        return await handleStart(context);
      } catch (error) {
        const exhaustedStartBudget = error instanceof RuntimeInvariantError
          && error.stableCode === "box_start_deadline_exceeded";
        const transientProviderFailure = error !== null
          && typeof error === "object"
          && isRetryableProviderError(error);
        if (isTurnDerivedStart && (exhaustedStartBudget || transientProviderFailure)) {
          // A turn-derived Start is only a prerequisite for the queued prompt. Exhausting this
          // cycle proves neither that the prompt failed nor that replay is required; protocol 7
          // re-arms the same operation with a fresh, fixed budget.
          throw new RuntimeInvariantError({
            code: "cold_start_deadline_exceeded",
            message: "The Companion did not start before its deadline.",
            action: "retry",
          });
        }
        throw error;
      }
    }
    case "stop":
      return await handleStop(context);
    case "restart_pi": {
      if (requiredAuthorization(context.session).operationTrigger === "recovery") {
        return await handleRecoveryCleanup(context);
      }
      return await handleIsolatedRoutineRetry(context) ?? await handleRestartPi(context);
    }
    case "restart_box":
      return await handleRestartBox(context);
    case "apply_settings":
      return await handleApplySettings(context);
    case "delete":
      return await handleDelete(context);
  }
}
