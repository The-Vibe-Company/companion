/* oxlint-disable anti-slop/no-conditional-empty-object-spread, anti-slop/no-known-value-widening, anti-slop/no-unknown-parameters -- Optional lifecycle inputs are conditionally spread; cleanup callbacks receive unknown thrown values by design. */
import {
  observedBoxStateFromProvider,
  BoxRuntimeAdapterError,
  type BoxRuntimeLifecycleClient,
  type CompanionBoxRuntimeV2,
  type BoxState,
} from "@companion/box-runtime";
import { createHash } from "node:crypto";
import { COMPANION_BUDGETS_BASE } from "@companion/contracts";
import type {
  BrokerWriteOutcome,
  BrokerPromptWriteOutcome,
  RuntimeBoxControl,
  RuntimePiControl,
  RuntimeProcessLog,
} from "@companion/companion-runtime";

export type RuntimeImageAvailability =
  | "ready"
  | "missing"
  | "requested"
  | "building"
  | "stale"
  | "failed";

/** The durable image registry as seen by Box creation. Status is published in PostgreSQL. */
export interface RuntimeImageSource {
  expectedName(): string;
  /**
   * Reads readiness exactly once. Creation never waits for the independent builder: only a
   * currently published `ready` row is eligible as a clone source.
   */
  availability(signal: AbortSignal): Promise<RuntimeImageAvailability>;
}

export interface RuntimeBoxAdapterOptions {
  lifecycle: BoxRuntimeLifecycleClient;
  /** Fresh adapter per port call prevents one staging call's signal budget leaking into another. */
  runtime(): CompanionBoxRuntimeV2;
  /** Named snapshot source to clone when the baker has a ready layout image. */
  runtimeImage?: RuntimeImageSource;
  /** Structured create evidence: fromImage, fallback reason, and timings. Never secrets. */
  log?: RuntimeProcessLog;
  /** Each provider operation gets a bound even when delete/health work has no turn deadline. */
  providerDeadlineMs?: number;
  /** Invoked once per create that cold-installs despite a snapshot source, with its fallback reason. */
  onColdFallback?: (reason: string) => void;
  now?: () => number;
}

export function createRuntimeBoxControl(options: RuntimeBoxAdapterOptions): RuntimeBoxControl {
  const deadline = providerDeadlineFactory(options);
  const now = options.now ?? Date.now;
  return {
    async findGenerationBoxes(input) {
      const result = await options.lifecycle.findGenerationBoxes({
        companionId: input.companionId,
        generation: generationNumber(input.generation),
        deadlineAt: deadline(input.deadlineAt),
        signal: input.signal,
      });
      return normalizeDiscovery(result);
    },
    async createGenerationBox(input) {
      const startedAt = now();
      const image = options.runtimeImage;
      let from: string | undefined;
      let imageLookupMs = 0;
      let fallbackReason:
        | "image_missing" | "image_build_pending" | "image_build_stale"
        | "image_build_failed" | "image_registry_unavailable"
        | "unknown_snapshot_fallback" | undefined;
      if (image) {
        const lookupStartedAt = now();
        try {
          const availability = await image.availability(input.signal);
          if (availability === "ready") {
            from = image.expectedName();
          } else if (availability === "failed") {
            fallbackReason = "image_build_failed";
          } else if (availability === "stale") {
            fallbackReason = "image_build_stale";
          } else if (availability === "missing") {
            fallbackReason = "image_missing";
          } else {
            fallbackReason = "image_build_pending";
          }
        } catch (error) {
          if (input.signal.aborted) throw error;
          fallbackReason = "image_registry_unavailable";
        }
        imageLookupMs = now() - lookupStartedAt;
      }
      const create = (fromImage?: string, idempotencyKey = input.idempotencyKey) =>
        options.lifecycle.createGenerationBoxAfterObservedAbsence({
          companionId: input.companionId,
          generation: generationNumber(input.generation),
          ttlSeconds: input.ttlSeconds,
          ...(idempotencyKey ? { idempotencyKey } : {}),
          deadlineAt: deadline(input.deadlineAt),
          signal: input.signal,
          ...(fromImage ? { from: fromImage } : {}),
        });
      let created: Awaited<ReturnType<typeof create>>;
      try {
        created = await create(from);
      } catch (error) {
        if (!from || !isUnknownSnapshot(error)) throw error;
        fallbackReason = "unknown_snapshot_fallback";
        from = undefined;
        created = await create(undefined, input.idempotencyKey
          ? coldFallbackIdempotencyKey(input.idempotencyKey)
          : undefined);
      }
      const result = created;
      // A snapshot source that still ended without a clone name means this create cold-installed.
      // Count it so /healthz can surface a silently degraded launch path even while creates succeed.
      if (image && from === undefined) {
        options.onColdFallback?.(fallbackReason ?? "image_missing");
      }
      options.log?.info({
        ts: new Date(now()).toISOString(),
        event: "runtime.box.create",
        companionId: input.companionId,
        generation: generationNumber(input.generation),
        expectedImage: image?.expectedName() ?? null,
        fromImage: from ?? null,
        ...(fallbackReason ? { fallbackReason } : {}),
        imageLookupMs,
        durationMs: now() - startedAt,
        outcome: result.outcome,
      });
      return result;
    },
    async applyGenerationBoxSettings(input) {
      await options.lifecycle.applyGenerationBoxSettings({
        boxId: input.boxId,
        companionId: input.companionId,
        generation: generationNumber(input.generation),
        ttlSeconds: input.ttlSeconds,
        deadlineAt: deadline(input.deadlineAt),
        signal: input.signal,
      });
    },
    async getStatus(input) {
      const observed = await options.runtime().existingBoxStatus({
        boxId: input.boxId,
        ...(input.companionId !== undefined ? { companionId: input.companionId } : {}),
        ...(input.generation !== undefined
          ? { runtimeGeneration: generationNumber(input.generation) }
          : {}),
        signal: input.signal,
      });
      return { state: observedBoxStateFromProvider(observed.state) };
    },
    async setTtl(input) {
      await options.runtime().refreshTtl(input);
    },
    async stopExistingBox(input) {
      await options.runtime().archiveExistingBox(input);
    },
    async resumeExistingBox(input) {
      await options.runtime().resumeExistingBox(input);
    },
    async requestPermanentDeletion(input) {
      const result = await options.lifecycle.requestPermanentDeletion({
        ...input,
        deadlineAt: deadline(),
      });
      return result.outcome === "absent"
        ? { outcome: "absent" }
        : { outcome: "accepted", operationId: result.operation.id };
    },
    async pollPermanentDeletion(input) {
      const operation = await options.lifecycle.getDeletionOperation({
        ...input,
        deadlineAt: deadline(),
      });
      if (operation.status === "completed") return { status: "completed" };
      if (operation.status === "blocked") return { status: "blocked" };
      return { status: operation.status };
    },
  };
}

export function createRuntimePiControl(options: RuntimeBoxAdapterOptions): RuntimePiControl {
  return {
    async stopPiDaemon(input) {
      await options.runtime().stopPiDaemon(input);
    },
    async terminatePiInvocation(input) {
      return await options.runtime().terminatePiInvocation(input);
    },
    async startPiDaemon(input) {
      return await options.runtime().startPiDaemon(input);
    },
    async restartPiDaemon(input) {
      return await options.runtime().restartPiDaemon(input);
    },
    async piDaemonStatus(input) {
      return await options.runtime().piDaemonStatus(input);
    },
    async brokerState(input) {
      const runtime = options.runtime();
      return brokerState(
        await runtime.brokerState(input),
        runtime.layoutIdentity().fullMarker,
      );
    },
    async prompt(input) {
      input.signal.throwIfAborted();
      const runtime = options.runtime();
      const result = await runtime.dispatchPrompt({
        boxId: input.boxId,
        attemptId: input.attemptId,
        expectedInvocationId: input.expectedInvocationId,
        message: input.message,
        requestId: input.commandId,
        signal: input.signal,
      });
      return promptWriteOutcome(result);
    },
    async abort(input) {
      input.signal.throwIfAborted();
      const runtime = options.runtime();
      const result = await runtime.dispatchAbort({
        boxId: input.boxId,
        attemptId: input.attemptId,
        requestId: input.commandId,
        signal: input.signal,
      });
      return writeOutcome(result);
    },
    async readBrokerEvents(input) {
      return await options.runtime().readEvents({
        boxId: input.boxId,
        after: cursorNumber(input.after),
        signal: input.signal,
      });
    },
    async ackBrokerEvents(input) {
      const acknowledged = await options.runtime().ackEvents({
        boxId: input.boxId,
        through: cursorNumber(input.through),
        signal: input.signal,
      });
      return BigInt(acknowledged.acknowledgedCursor);
    },
    async respondExtensionUi(input) {
      input.signal.throwIfAborted();
      const runtime = options.runtime();
      const result = await runtime.dispatchExtensionUi({
        boxId: input.boxId,
        attemptId: input.attemptId,
        requestId: input.commandId,
        response: input.response,
        signal: input.signal,
      });
      return writeOutcome(result);
    },
    routineSession: {
      async start(input) {
        input.signal.throwIfAborted();
        return await options.runtime().startRoutineSession(input);
      },
      async state(input) {
        const runtime = options.runtime();
        return brokerState(
          await runtime.routineSessionState(input),
          runtime.layoutIdentity().fullMarker,
        );
      },
      async prompt(input) {
        input.signal.throwIfAborted();
        const result = await options.runtime().dispatchRoutinePrompt({
          boxId: input.boxId,
          runId: input.runId,
          attemptId: input.attemptId,
          expectedInvocationId: input.expectedInvocationId,
          message: input.message,
          requestId: input.commandId,
          signal: input.signal,
        });
        return promptWriteOutcome(result);
      },
      async read(input) {
        return await options.runtime().readRoutineEvents({
          boxId: input.boxId,
          runId: input.runId,
          after: cursorNumber(input.after),
          signal: input.signal,
        });
      },
      async ack(input) {
        const acknowledged = await options.runtime().ackRoutineEvents({
          boxId: input.boxId,
          runId: input.runId,
          through: cursorNumber(input.through),
          signal: input.signal,
        });
        return BigInt(acknowledged.acknowledgedCursor);
      },
      async abort(input) {
        input.signal.throwIfAborted();
        const result = await options.runtime().dispatchRoutineAbort({
          boxId: input.boxId,
          runId: input.runId,
          attemptId: input.attemptId,
          requestId: input.commandId,
          signal: input.signal,
        });
        return writeOutcome(result);
      },
      async terminate(input) {
        await options.runtime().terminateRoutineSession(input);
      },
    },
  };
}

function writeOutcome(
  result: Awaited<ReturnType<CompanionBoxRuntimeV2["dispatchAbort"]>>,
): BrokerWriteOutcome {
  if (result.outcome === "refused") return { outcome: "rejected", code: result.code };
  if (result.outcome === "ambiguous") return { outcome: "ambiguous", code: result.code };
  return {
    outcome: "accepted",
    invocationId: result.invocationId,
  };
}

function promptWriteOutcome(
  result: Awaited<ReturnType<CompanionBoxRuntimeV2["dispatchPrompt"]>>,
): BrokerPromptWriteOutcome {
  if (result.outcome === "refused") return { outcome: "rejected", code: result.code };
  if (result.outcome === "ambiguous") return { outcome: "ambiguous", code: result.code };
  return {
    outcome: "accepted",
    invocationId: result.invocationId,
    initialCursor: BigInt(result.initialCursor),
  };
}

function brokerState(
  state: Awaited<ReturnType<CompanionBoxRuntimeV2["brokerState"]>>,
  expectedLayoutMarker: string,
): Awaited<ReturnType<RuntimePiControl["brokerState"]>> {
  return {
    ...state,
    layoutCurrent: state.layoutMarker === expectedLayoutMarker,
    tailCursor: BigInt(state.tailCursor),
    acknowledgedCursor: BigInt(state.acknowledgedCursor),
  };
}

function normalizeDiscovery(input: {
  name: string;
  canonical: { id: string; name?: string; state?: BoxState } | null;
  duplicates: Array<{ id: string; name?: string; state?: BoxState }>;
}): {
  name: string;
  canonical: { id: string; name: string; state?: ReturnType<typeof observedBoxStateFromProvider> } | null;
  duplicates: Array<{ id: string; name: string; state?: ReturnType<typeof observedBoxStateFromProvider> }>;
} {
  const named = (box: { id: string; name?: string; state?: BoxState }) => ({
    id: box.id,
    name: box.name ?? input.name,
    ...(box.state ? { state: observedBoxStateFromProvider(box.state) } : {}),
  });
  return {
    name: input.name,
    canonical: input.canonical ? named(input.canonical) : null,
    duplicates: input.duplicates.map(named),
  };
}

function generationNumber(value: bigint): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > 2_147_483_647) {
    throw new TypeError("Runtime generation is outside the Box identity range");
  }
  return number;
}

function cursorNumber(value: bigint): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new TypeError("Pi broker cursor is outside the safe integer range");
  }
  return number;
}

function isUnknownSnapshot(error: unknown): boolean {
  if (!(error instanceof BoxRuntimeAdapterError)) return false;
  return error.providerCode === "unknown_snapshot" || error.stableCode === "box_not_found";
}

/** A known-negative snapshot response may retry cold with a distinct replay-stable provider key. */
function coldFallbackIdempotencyKey(source: string): string {
  const bytes = createHash("sha256")
    .update(`companion:cold-fallback:${source}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const DEFAULT_PROVIDER_DEADLINE_MS = COMPANION_BUDGETS_BASE.boxRequestTimeoutMs;

function providerDeadlineFactory(options: RuntimeBoxAdapterOptions): (value?: Date) => Date {
  const now = options.now ?? Date.now;
  const timeout = options.providerDeadlineMs ?? DEFAULT_PROVIDER_DEADLINE_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000) {
    throw new TypeError("Box provider deadline must be between 1 and 120000 milliseconds");
  }
  return (value?: Date): Date => {
    const boundedAt = now() + timeout;
    if (value === undefined) return new Date(boundedAt);
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new TypeError("Box lifecycle work requires a valid absolute deadline");
    }
    return new Date(Math.min(value.getTime(), boundedAt));
  };
}
