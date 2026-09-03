import {
  validatePiJournalRead,
  type RuntimePiControl,
} from "@companion/companion-runtime/runtime-support";
import type { RuntimeV3WarmPi } from "@companion/companion-runtime/v3/internal";

const ROUTINE_PI_CALL_TIMEOUT_MS = 30_000;

function bounded(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ROUTINE_PI_CALL_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * Runtime v3 background work uses one run-scoped Pi process in the Companion's existing Box.
 * The map is only an addressing aid for ACK; PostgreSQL remains the claim and fencing authority.
 */
export function createRuntimeV3RoutinePi(
  pi: Pick<RuntimePiControl, "routineSession">,
): RuntimeV3WarmPi {
  const routine = pi.routineSession;
  if (!routine) throw new Error("Runtime v3 routine Pi transport is unavailable");
  const activeByBox = new Map<string, { runId: string; invocationId: string; terminal: boolean }>();

  return {
    async prompt(input) {
      const signal = bounded(input.signal);
      let started: Awaited<ReturnType<typeof routine.start>>;
      try {
        started = await routine.start({
          boxId: input.boxId,
          runId: input.turnId,
          persona: input.persona ?? null,
          validationOnly: input.validationOnly ?? false,
          directWorkspace: input.directWorkspace ?? true,
          expectedInvocationId: input.expectedInvocationId,
          signal,
        });
      } catch {
        try {
          await routine.terminate({
            boxId: input.boxId,
            runId: input.turnId,
            expectedInvocationId: input.expectedInvocationId,
            signal: bounded(),
          });
          return { outcome: "rejected", code: "routine_start_failed" };
        } catch {
          return { outcome: "ambiguous", code: "routine_start_ambiguous" };
        }
      }
      if (started.invocationId !== input.expectedInvocationId) {
        return { outcome: "ambiguous", code: "routine_invocation_changed" };
      }
      activeByBox.set(input.boxId, {
        runId: input.turnId,
        invocationId: started.invocationId,
        terminal: false,
      });
      try {
        return await routine.prompt({
          boxId: input.boxId,
          runId: input.turnId,
          commandId: input.commandId,
          attemptId: input.turnId,
          expectedInvocationId: started.invocationId,
          message: input.message,
          signal,
        });
      } catch {
        return { outcome: "ambiguous", code: "routine_prompt_outcome_unknown" };
      }
    },
    async read(input) {
      const value = await routine.read({
        boxId: input.boxId,
        runId: input.turnId,
        after: input.after,
        signal: bounded(input.signal),
      });
      const page = validatePiJournalRead({
        value,
        after: input.after,
        attemptId: input.turnId,
        invocationId: input.invocationId,
      });
      const terminal = page.events.some((record) => {
        if (record.kind === "pi_process_exit") return true;
        return record.event.type === "agent_settled"
          || (record.event.type === "tool_execution_start"
            && JSON.stringify(record.event).includes("surface_to_main"));
      });
      const active = activeByBox.get(input.boxId);
      if (active?.runId === input.turnId) {
        active.terminal = terminal;
      } else {
        activeByBox.set(input.boxId, {
          runId: input.turnId,
          invocationId: input.invocationId,
          terminal,
        });
      }
      return page;
    },
    async acknowledge(input) {
      const active = activeByBox.get(input.boxId);
      const runId = active?.runId ?? input.turnId;
      const invocationId = active?.invocationId ?? input.invocationId;
      if (!runId || !invocationId) throw new Error("Runtime v3 routine ACK has no durable run identity");
      const acknowledged = await routine.ack({
        boxId: input.boxId,
        runId,
        through: input.through,
        signal: bounded(input.signal),
      });
      if (active?.terminal || !active) {
        await routine.terminate({
          boxId: input.boxId,
          runId,
          expectedInvocationId: invocationId,
          signal: bounded(input.signal),
        });
        activeByBox.delete(input.boxId);
      }
      return acknowledged;
    },
    async terminate(input) {
      await routine.terminate({
        boxId: input.boxId,
        runId: input.turnId,
        expectedInvocationId: input.invocationId,
        signal: bounded(input.signal),
      });
      activeByBox.delete(input.boxId);
    },
    async abort(input) {
      return await routine.abort({
        boxId: input.boxId,
        runId: input.turnId,
        commandId: input.commandId,
        attemptId: input.turnId,
        signal: bounded(input.signal),
      });
    },
  };
}
