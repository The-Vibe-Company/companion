import type {
  RuntimeV3ProgressionOutcome,
  RuntimeV3ProgressionPersistence,
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

function terminalInput(outcome: RuntimeV3ProgressionOutcome): TerminalCompletion {
  if (outcome.kind === "failed" || outcome.kind === "interrupted") {
    return { outcome: outcome.kind, code: outcome.code, message: outcome.message };
  }
  return { outcome: outcome.kind, code: null, message: null };
}

/** PostgreSQL adapter kept outside the v3 module's caller-facing interface and composition root. */
export function createRuntimeV3PostgresPersistence(sql: Sql): RuntimeV3ProgressionPersistence {
  return {
    async admitTurn(input) {
      if (input.lane !== "main") {
        throw new Error("background admission belongs to the worker persistence adapter");
      }
      const rows = await sql<Array<{
        turnId: string;
        commandId: string;
        lane: "main";
        state: RuntimeV3Turn["state"];
      }>>`
        select turn_id as "turnId", command_id as "commandId", lane::text, state::text
        from public.companion_v3_api_admit_turn(
          ${input.orgId}::uuid,
          ${input.companionId}::uuid,
          ${input.clientMessageId}::uuid,
          ${input.messageEventId}
        )
      `;
      const row = rows[0];
      if (!row) throw new Error("Runtime v3 admission returned no Turn");
      return turnFromRow(row);
    },
    async recordDesiredLifecycle(input) {
      const rows = await sql<Array<{ intent: typeof input.intent; revision: string }>>`
        select intent::text, revision::text
        from public.companion_v3_api_desire_lifecycle(
          ${input.orgId}::uuid,
          ${input.companionId}::uuid,
          ${input.intent}
        )
      `;
      const row = rows[0];
      if (!row) throw new Error("Runtime v3 lifecycle change returned no revision");
      return { intent: row.intent, revision: BigInt(row.revision) };
    },
    async claimAvailable({ executorId }) {
      const claims = await Promise.all((["main", "background"] as const).map(async (lane) => {
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
      }));
      return claims.filter((claim) => claim !== null);
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
          3
        ) as completed
      `;
      return rows[0]?.completed === true;
    },
  };
}
