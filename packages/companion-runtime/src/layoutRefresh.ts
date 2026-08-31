import { retryIdempotentLifecycle } from "./retry";
import type { LeaseSession } from "./leaseSession";
import type { RuntimeEngineDependencies } from "./ports";
import type { RuntimeAuthorization } from "./types";

/**
 * Keep a warm Companion on the current broker/packages without replacing its disk. Overlay updates
 * are seconds; a pin change still installs in place. Full Box restart remains an explicit user action.
 *
 * This does not persist a new Pi invocation. Attempt work cannot observe instances, so callers that
 * can (health, still at `observing`) record the returned id themselves — with idle proof, per the
 * companion_runtime_observe_instance health identity rule.
 */
export async function refreshWarmCompanionLayout(input: {
  session: LeaseSession;
  deps: RuntimeEngineDependencies;
  authorization: RuntimeAuthorization;
  restartPi: boolean;
  /** Broker evidence can be stale even when a previous executor already updated the disk marker. */
  restartPiWhenUnchanged?: boolean;
}): Promise<{
  applied: "none" | "overlay" | "base";
  restartedPi: boolean;
  piInvocationId: string | null;
}> {
  const boxId = input.authorization.boxId;
  const currentInvocationId = input.authorization.piInvocationId;
  if (!boxId) {
    return { applied: "none", restartedPi: false, piInvocationId: currentInvocationId };
  }
  const refresh = await input.session.external(async (signal) =>
    await input.deps.resourceStager.refreshLayout({ boxId, signal }));
  if (!input.restartPi || (refresh.applied === "none" && !input.restartPiWhenUnchanged)) {
    return { applied: refresh.applied, restartedPi: false, piInvocationId: currentInvocationId };
  }
  try {
    const deadlineAt = input.authorization.coldStartDeadlineAt
      ?? input.authorization.absoluteDeadlineAt
      ?? undefined;
    const started = await retryIdempotentLifecycle({
      call: "restart_pi",
      clock: input.deps.clock,
      jitter: input.deps.jitter,
      signal: input.session.signal,
      operation: async () => await input.session.external(async (signal) =>
        await input.deps.pi.restartPiDaemon({ boxId, deadlineAt, signal })),
    });
    if (started.state !== "idle" || !started.invocationId) {
      await invalidateLayoutAfterFailedRecycle(input, boxId);
      return { applied: refresh.applied, restartedPi: false, piInvocationId: currentInvocationId };
    }
    return {
      applied: refresh.applied,
      restartedPi: true,
      piInvocationId: started.invocationId,
    };
  } catch (error) {
    await invalidateLayoutAfterFailedRecycle(input, boxId).catch(() => undefined);
    throw error;
  }
}

async function invalidateLayoutAfterFailedRecycle(
  input: {
    session: LeaseSession;
    deps: RuntimeEngineDependencies;
  },
  boxId: string,
): Promise<void> {
  await input.session.external(async (signal) =>
    await input.deps.resourceStager.invalidateLayout({ boxId, signal }));
}
