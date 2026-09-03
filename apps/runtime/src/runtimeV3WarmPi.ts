import { validatePiJournalRead, type RuntimePiControl } from "@companion/companion-runtime/runtime-support";
import type { RuntimeV3WarmPi } from "@companion/companion-runtime/v3/internal";

const WARM_PI_CALL_TIMEOUT_MS = 30_000;

function warmCallSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(WARM_PI_CALL_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Narrow Runtime v3 Pi boundary over the existing, simulator-backed broker transport. */
export function createRuntimeV3WarmPi(pi: RuntimePiControl): RuntimeV3WarmPi {
  return {
    async prompt(input) {
      return await pi.prompt({
        boxId: input.boxId,
        commandId: input.commandId,
        attemptId: input.turnId,
        expectedInvocationId: input.expectedInvocationId,
        message: input.message,
        signal: warmCallSignal(input.signal),
      });
    },
    async read(input) {
      const value = await pi.readBrokerEvents({
        boxId: input.boxId,
        after: input.after,
        signal: warmCallSignal(input.signal),
      });
      return validatePiJournalRead({
        value,
        after: input.after,
        attemptId: input.turnId,
        invocationId: input.invocationId,
      });
    },
    async acknowledge(input) {
      return await pi.ackBrokerEvents({
        boxId: input.boxId,
        through: input.through,
        signal: warmCallSignal(input.signal),
      });
    },
    async abort(input) {
      return await pi.abort({
        boxId: input.boxId,
        commandId: input.commandId,
        attemptId: input.turnId,
        signal: warmCallSignal(input.signal),
      });
    },
    async respondExtensionUi(input) {
      return await pi.respondExtensionUi({
        boxId: input.boxId,
        commandId: input.commandId,
        attemptId: input.turnId,
        response: input.response,
        signal: warmCallSignal(input.signal),
      });
    },
  };
}
