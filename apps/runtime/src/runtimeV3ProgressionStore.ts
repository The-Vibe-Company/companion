import type {
  RuntimeV3ConvergencePersistence,
  RuntimeV3DurableOutcome,
  RuntimeV3Turn,
} from "@companion/companion-runtime/v3/internal";
import type { Sql } from "postgres";

interface ClaimRow {
  orgId: string;
  companionId: string;
  turnId: string;
  commandId: string;
  lane: "main" | "background";
  state: RuntimeV3Turn["state"];
  claimToken: string;
  claimEpoch: string;
}

interface TerminalCompletion {
  outcome: "release" | "succeeded" | "failed" | "interrupted";
  code: string | null;
  message: string | null;
  action: string | null;
}

function turnFromRow(row: {
  turnId: string;
  commandId: string;
  lane: "main" | "background";
  state: RuntimeV3Turn["state"];
}): RuntimeV3Turn {
  return {
    id: row.turnId,
    commandId: row.commandId,
    lane: row.lane,
    state: row.state,
  };
}

function terminalInput(outcome: RuntimeV3DurableOutcome): TerminalCompletion {
  if (outcome.kind === "failed" || outcome.kind === "interrupted") {
    return {
      outcome: outcome.kind,
      code: outcome.error.code,
      message: outcome.error.message,
      action: outcome.error.action,
    };
  }
  return { outcome: outcome.kind, code: null, message: null, action: null };
}

/** Runtime-role PostgreSQL adapter kept outside the caller-facing interface and composition root. */
export function createRuntimeV3PostgresConvergence(sql: Sql): RuntimeV3ConvergencePersistence {
  return {
    async claimLane({ executorId, lane }) {
      const rows = await sql<ClaimRow[]>`
        select org_id as "orgId", companion_id as "companionId", turn_id as "turnId",
          command_id as "commandId", lane::text, state::text,
          claim_token as "claimToken", claim_epoch::text as "claimEpoch"
        from public.companion_v3_runtime_claim(${executorId}, ${lane}, 30, 3)
      `;
      const row = rows[0];
      return row
        ? {
          turn: turnFromRow(row),
          fence: { token: row.claimToken, epoch: BigInt(row.claimEpoch) },
          orgId: row.orgId,
          companionId: row.companionId,
        }
        : null;
    },
    async completeProgression(claim, outcome) {
      const terminal = terminalInput(outcome);
      const rows = await sql<Array<{ completed: boolean }>>`
        select public.companion_v3_runtime_complete(
          ${claim.orgId}::uuid,
          ${claim.companionId}::uuid,
          ${claim.turn.lane},
          ${claim.turn.id}::uuid,
          ${claim.fence.token}::uuid,
          ${claim.fence.epoch.toString()}::bigint,
          ${terminal.outcome},
          ${terminal.code},
          ${terminal.message},
          ${terminal.action}::public.companion_runtime_error_action,
          3
        ) as completed
      `;
      return rows[0]?.completed === true;
    },
  };
}
