/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-conditional-empty-object-spread -- Cleanup callbacks receive unknown thrown values by design; optional bake inputs are conditionally spread. */
import { COMPANION_BUDGETS_BASE } from "@companion/contracts";

import { BoxRuntimeAdapterError, type BoxRuntimeLifecycleClient } from "./boxMaintenanceClient";
import type { CompanionBoxRuntime } from "./boxCompanionRuntime";
import type { CompanionRuntimeSkill } from "./companionPiInjection";
import {
  isCompanionRuntimeImageName,
  type CompanionPiLayoutIdentity,
} from "./companionRuntimeImage";

// Create stays at the unnamed-orphan bound. The bake itself is longer: ready wait, layout, snapshot.
const BAKER_CREATE_TTL_SECONDS = COMPANION_BUDGETS_BASE.provisionalCreateTtlSeconds;
const BAKER_WORK_TTL_SECONDS = 3_600;
const READY_POLL_INTERVAL_MS = 1_000;
const SNAPSHOT_POLL_INTERVAL_MS = 2_000;
// Real providers take several minutes to move a fresh clone through provisioning to ready;
// the bake holds a durable registry lease, so waiting here is safe and cheaper than failing.
const BOX_READY_TIMEOUT_MS = 900_000;
const SNAPSHOT_READY_TIMEOUT_MS = 600_000;
// `provisioned` is a bootable disk: staging installs layout over SSH, so a bake may proceed
// without waiting for the provider's own boot handshake to reach its terminal ready state.
const READY_STATES = new Set(["ready", "idle", "running", "provisioned"]);

/**
 * One bake attempt: resolve an existing ready snapshot, otherwise bake (clone parent → layout →
 * skill warmup → save). Never retries; the caller owns retry policy. This is the unit the
 * registry-driven builder executes under its lease.
 */
export async function bakeCompanionRuntimeImageOnce(input: {
  identity: CompanionPiLayoutIdentity;
  lifecycle: BoxRuntimeLifecycleClient;
  runtime: Pick<
    CompanionBoxRuntime,
    "existingBoxStatus" | "refreshPiLayout" | "refreshTtl"
  > & Partial<Pick<CompanionBoxRuntime, "prepareRuntimeImage">>;
  bundledSkill?: CompanionRuntimeSkill;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  signal: AbortSignal;
  /** Persists the provider Box identity immediately after create, before layout side effects. */
  onBoxCreated?: (input: { boxId: string; parentImageName: string | null }) => Promise<void>;
  /** Revalidates the builder epoch immediately before the bounded provider snapshot write. */
  onBeforeSnapshotPublish?: (input: { boxId: string }) => Promise<void>;
  /** Persists irreversible-delete intent before the provider DELETE can be attempted. */
  onBoxDeletionIntentRecorded?: (input: { boxId: string }) => Promise<void>;
  /** Persists the accepted irreversible deletion before polling it. */
  onBoxDeletionRequested?: (input: { boxId: string; operationId: string }) => Promise<void>;
  /** Confirms durable cleanup ownership after the provider Box is gone. */
  onBoxDeleted?: (input: { boxId: string }) => Promise<void>;
  onCleanupError?: (error: unknown, cleanup: "baker_box_delete") => void;
}): Promise<{ name: string; ready: boolean; parentImageName: string | null }> {
  return await ensureImage({
    identity: input.identity,
    lifecycle: input.lifecycle,
    runtime: input.runtime,
    ...(input.bundledSkill ? { bundledSkill: input.bundledSkill } : {}),
    now: input.now ?? Date.now,
    sleep: input.sleep ?? defaultSleep,
    signal: input.signal,
    onBoxCreated: input.onBoxCreated,
    onBeforeSnapshotPublish: input.onBeforeSnapshotPublish,
    onBoxDeletionIntentRecorded: input.onBoxDeletionIntentRecorded,
    onBoxDeletionRequested: input.onBoxDeletionRequested,
    onBoxDeleted: input.onBoxDeleted,
    onCleanupError: input.onCleanupError,
  });
}

async function ensureImage(input: {
  identity: CompanionPiLayoutIdentity;
  lifecycle: BoxRuntimeLifecycleClient;
  runtime: Pick<CompanionBoxRuntime, "existingBoxStatus" | "refreshPiLayout" | "refreshTtl">
    & Partial<Pick<CompanionBoxRuntime, "prepareRuntimeImage">>;
  bundledSkill?: CompanionRuntimeSkill;
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  signal: AbortSignal;
  onBoxCreated?: (input: { boxId: string; parentImageName: string | null }) => Promise<void>;
  onBeforeSnapshotPublish?: (input: { boxId: string }) => Promise<void>;
  onBoxDeletionIntentRecorded?: (input: { boxId: string }) => Promise<void>;
  onBoxDeletionRequested?: (input: { boxId: string; operationId: string }) => Promise<void>;
  onBoxDeleted?: (input: { boxId: string }) => Promise<void>;
  onCleanupError?: (error: unknown, cleanup: "baker_box_delete") => void;
}): Promise<{ name: string; ready: boolean; baked: boolean; parentImageName: string | null }> {
  const current = await input.lifecycle.getNamedSnapshot({
    name: input.identity.imageName,
    signal: input.signal,
    deadlineAt: input.now() + 30_000,
  });
  if (current?.status === "ready") {
    return { name: input.identity.imageName, ready: true, baked: false, parentImageName: null };
  }
  if (current?.status === "saving") {
    const settled = await waitNamedSnapshot(input, input.identity.imageName);
    if (settled?.status === "ready") {
      return { name: input.identity.imageName, ready: true, baked: false, parentImageName: null };
    }
  }

  const parent = await selectParentSnapshot(input);
  let boxId: string | null = null;
  try {
    const created = await createBakerBox(input, parent);
    boxId = created.boxId;
    await input.onBoxCreated?.({ boxId, parentImageName: created.parentImageName });
    await input.runtime.refreshTtl({
      boxId,
      ttlSeconds: BAKER_WORK_TTL_SECONDS,
      signal: input.signal,
    });
    await waitBoxReady(input, boxId);
    await input.runtime.refreshPiLayout({ boxId, signal: input.signal });
    if (input.bundledSkill) {
      if (!input.runtime.prepareRuntimeImage) {
        throw new Error("The runtime image warmup adapter is unavailable.");
      }
      await input.runtime.prepareRuntimeImage({
        boxId,
        bundledSkill: input.bundledSkill,
        signal: input.signal,
      });
    }
    await input.onBeforeSnapshotPublish?.({ boxId });
    try {
      await input.lifecycle.saveNamedSnapshot({
        boxId,
        name: input.identity.imageName,
        deadlineAt: input.now() + 30_000,
        signal: input.signal,
      });
    } catch (error) {
      if (!isSnapshotSaveInFlight(error)) throw error;
    }
    const saved = await waitNamedSnapshot(input, input.identity.imageName);
    if (saved?.status !== "ready") {
      return {
        name: input.identity.imageName,
        ready: false,
        baked: false,
        parentImageName: created.parentImageName,
      };
    }
    return {
      name: input.identity.imageName,
      ready: true,
      baked: true,
      parentImageName: created.parentImageName,
    };
  } finally {
    if (boxId) {
      const cleanupBoxId = boxId;
      const cleanupController = new AbortController();
      const cleanupTimer = setTimeout(() => {
        cleanupController.abort(new Error("The runtime image baker cleanup exceeded its budget."));
      }, 120_000);
      await deleteCompanionRuntimeBakerBox({
        lifecycle: input.lifecycle,
        boxId: cleanupBoxId,
        deadlineAt: input.now() + 120_000,
        signal: cleanupController.signal,
        onDeletionIntentRecorded: input.onBoxDeletionIntentRecorded,
        onDeletionRequested: input.onBoxDeletionRequested,
      }).then(async () => {
        await input.onBoxDeleted?.({ boxId: cleanupBoxId });
      }).catch((error: unknown) => {
        input.onCleanupError?.(error, "baker_box_delete");
        throw error;
      }).finally(() => {
        clearTimeout(cleanupTimer);
      });
    }
  }
}

/**
 * Delete a baker Box without replaying a possibly accepted DELETE. Callers first persist intent,
 * then persist the returned operation before this helper polls. Takeover with intent but no
 * operation performs read-only absence reconciliation; it never guesses whether DELETE ran.
 */
export async function deleteCompanionRuntimeBakerBox(input: {
  lifecycle: BoxRuntimeLifecycleClient;
  boxId: string;
  deletionIntentRecorded?: boolean;
  operationId?: string | null;
  deadlineAt: number;
  signal: AbortSignal;
  onDeletionIntentRecorded?: (input: { boxId: string }) => Promise<void>;
  onDeletionRequested?: (input: { boxId: string; operationId: string }) => Promise<void>;
}): Promise<void> {
  let operationId = input.operationId ?? null;
  if (!operationId) {
    if (input.deletionIntentRecorded) {
      const boxes = await input.lifecycle.listAllBoxes({
        deadlineAt: input.deadlineAt,
        signal: input.signal,
      });
      if (!boxes.some((box) => box.id === input.boxId)) return;
      throw new BoxRuntimeAdapterError({
        stableCode: "box_deletion_deadline_exceeded",
        message: "The runtime image baker Box deletion has an ambiguous accepted outcome",
        status: 504,
        providerCode: "delete_blocked",
        retryable: true,
        outcomeUnknown: true,
      });
    }
    await input.onDeletionIntentRecorded?.({ boxId: input.boxId });
    const requested = await input.lifecycle.requestPermanentDeletion({
      boxId: input.boxId,
      deadlineAt: input.deadlineAt,
      signal: input.signal,
    });
    if (requested.outcome === "absent") return;
    operationId = requested.operation.id;
    await input.onDeletionRequested?.({ boxId: input.boxId, operationId });
  }
  const terminal = await input.lifecycle.deletePermanentlyAndWait({
    boxId: input.boxId,
    operationId,
    deadlineAt: input.deadlineAt,
    signal: input.signal,
  });
  if (terminal.outcome === "blocked") {
    throw new BoxRuntimeAdapterError({
      stableCode: "box_deletion_deadline_exceeded",
      message: "The runtime image baker Box deletion remains blocked",
      status: 504,
      providerCode: "delete_blocked",
      retryable: true,
      outcomeUnknown: false,
    });
  }
}

async function selectParentSnapshot(input: {
  identity: CompanionPiLayoutIdentity;
  lifecycle: BoxRuntimeLifecycleClient;
  signal: AbortSignal;
  now: () => number;
}): Promise<string | undefined> {
  const snapshots = await input.lifecycle.listNamedSnapshots({
    signal: input.signal,
    deadlineAt: input.now() + 30_000,
  });
  const parents = snapshots
    .filter((snapshot) => snapshot.status === "ready"
      && snapshot.name !== input.identity.imageName
      && isCompanionRuntimeImageName(snapshot.name))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return parents[0]?.name;
}

async function waitBoxReady(input: {
  runtime: Pick<CompanionBoxRuntime, "existingBoxStatus">;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  now: () => number;
  signal: AbortSignal;
}, boxId: string): Promise<void> {
  const deadline = input.now() + BOX_READY_TIMEOUT_MS;
  while (input.now() < deadline) {
    input.signal.throwIfAborted();
    const observed = await input.runtime.existingBoxStatus({ boxId, signal: input.signal });
    if (READY_STATES.has(observed.state)) return;
    if (observed.state === "error" || observed.state === "archived") {
      throw new Error("The runtime image baker Box did not become ready.");
    }
    await input.sleep(READY_POLL_INTERVAL_MS, input.signal);
  }
  throw new Error("The runtime image baker Box did not become ready before its deadline.");
}

async function waitNamedSnapshot(input: {
  identity: CompanionPiLayoutIdentity;
  lifecycle: BoxRuntimeLifecycleClient;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  now: () => number;
  signal: AbortSignal;
}, name: string) {
  const deadline = input.now() + SNAPSHOT_READY_TIMEOUT_MS;
  while (input.now() < deadline) {
    input.signal.throwIfAborted();
    const snapshot = await input.lifecycle.getNamedSnapshot({
      name,
      signal: input.signal,
      deadlineAt: input.now() + 30_000,
    });
    if (snapshot?.status === "ready" || snapshot?.status === "failed") return snapshot;
    await input.sleep(SNAPSHOT_POLL_INTERVAL_MS, input.signal);
  }
  return input.lifecycle.getNamedSnapshot({
    name,
    signal: input.signal,
    deadlineAt: input.now() + 30_000,
  });
}

async function createBakerBox(
  input: {
    lifecycle: BoxRuntimeLifecycleClient;
    signal: AbortSignal;
    now: () => number;
  },
  parent: string | undefined,
): Promise<{ boxId: string; parentImageName: string | null }> {
  try {
    const created = await input.lifecycle.createEphemeralBox({
      ttlSeconds: BAKER_CREATE_TTL_SECONDS,
      noEnv: true,
      deadlineAt: input.now() + 30_000,
      signal: input.signal,
      ...(parent ? { from: parent } : {}),
    });
    return { ...created, parentImageName: parent ?? null };
  } catch (error) {
    if (!parent || !isUnknownSnapshot(error)) throw error;
    const created = await input.lifecycle.createEphemeralBox({
      ttlSeconds: BAKER_CREATE_TTL_SECONDS,
      noEnv: true,
      deadlineAt: input.now() + 30_000,
      signal: input.signal,
    });
    return { ...created, parentImageName: null };
  }
}

function isUnknownSnapshot(error: unknown): boolean {
  if (!(error instanceof BoxRuntimeAdapterError)) return false;
  return error.providerCode === "unknown_snapshot" || error.stableCode === "box_not_found";
}

function isSnapshotSaveInFlight(error: unknown): boolean {
  return error instanceof BoxRuntimeAdapterError && error.providerCode === "save_in_progress";
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}
