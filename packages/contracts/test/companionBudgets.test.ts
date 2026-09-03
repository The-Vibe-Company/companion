import { describe, expect, it } from "vitest";
import {
  COMPANION_BUDGETS,
  COMPANION_BUDGETS_BASE,
  COMPANION_RUNTIME_V3_BUDGETS,
  COMPANION_SQL_BUDGET_CONTRACT,
  COMPANION_SQL_UNTRACKED_INTERVAL_FUNCTIONS,
  deriveCompanionBudgets,
  KNOWN_EXCEEDANCES,
  sqlIntervalToMs,
  type CompanionBudgetExceedance,
} from "../src/companionBudgets";
import {
  COMPANION_EXEC_TOOL_RUN_TIMEOUT_MS,
  COMPANION_ROUTINE_MISSED_GRACE_MS,
  COMPANION_TOOL_RUN_TIMEOUT_MS,
} from "../src/companions";

const base = COMPANION_BUDGETS_BASE;
const budgets = COMPANION_BUDGETS;

function exceedance(id: string): CompanionBudgetExceedance | undefined {
  return KNOWN_EXCEEDANCES.find((entry) => entry.id === id);
}

describe("companion budget derivation", () => {
  it("derives exactly the values every consumer used before unification", () => {
    expect(budgets.renewIntervalMs).toBe(10_000);
    expect(budgets.shutdownDrainMs).toBe(25_000);
    expect(budgets.materialMinTtlMs).toBe(125 * 60 * 1_000);
    expect(budgets.hubTokenTtlSeconds).toBe(21_600);
    expect(budgets.settingsActivationDeadlineMs).toBe(10 * 60 * 1_000);
  });

  it("is a pure derivation over any base", () => {
    const alternate = deriveCompanionBudgets({ ...base, leaseSeconds: 60 });
    expect(alternate.renewIntervalMs).toBe(20_000);
    expect(alternate.shutdownDrainMs).toBe(55_000);
    // The original object is untouched and re-derivation is stable.
    expect(deriveCompanionBudgets(base)).toEqual(budgets);
  });

  it("re-exports the Pi tool timeouts unchanged", () => {
    expect(COMPANION_TOOL_RUN_TIMEOUT_MS).toBe(base.toolRunTimeoutMs);
    expect(COMPANION_EXEC_TOOL_RUN_TIMEOUT_MS).toBe(base.execToolRunTimeoutMs);
  });
});

describe("companion budget invariants", () => {
  it("nests every Runtime v3 phase inside the durable Turn and preparation bounds", () => {
    const v3 = COMPANION_RUNTIME_V3_BUDGETS;
    expect(v3.providerRequestMs).toBe(30_000);
    expect(v3.stagingMs).toBe(300_000);
    expect(v3.piActivationMs).toBe(120_000);
    expect(v3.admissionAckMs).toBe(15_000);
    expect(v3.silentCommandMs).toBe(510_000);
    expect(v3.silentSettlementMs).toBe(90_000);
    expect(v3.heartbeatCommandMs).toBe(118 * 60_000);
    expect(v3.heartbeatSettlementMs).toBe(120_000);
    expect(v3.silentCommandMs + v3.silentSettlementMs).toBe(base.inactivityStallMs);
    expect(v3.heartbeatCommandMs + v3.heartbeatSettlementMs)
      .toBe(base.turnAbsoluteDeadlineMs);
    expect(v3.preparationDeadlineMs).toBe(135 * 60_000);
    expect(v3.preparationRetrySeconds).toEqual([5, 15, 30, 60, 300]);
    expect(v3.externalIncidentRetrySeconds).toEqual([5, 15, 30, 60, 300]);
  });
  it("returns unanswered decisions to Pi after ten minutes", () => {
    expect(base.decisionTimeoutMs).toBe(10 * 60 * 1_000);
    expect(base.decisionTimeoutMs).toBeLessThan(base.turnAbsoluteDeadlineMs);
  });

  it("plain tool runs settle before exec tool runs may", () => {
    expect(base.toolRunTimeoutMs).toBeLessThan(base.execToolRunTimeoutMs);
  });

  it("renew cadence gives two retries inside one lease", () => {
    expect(budgets.renewIntervalMs).toBeLessThanOrEqual((base.leaseSeconds * 1_000) / 3);
  });

  it("a full shutdown drain finishes inside the lease it started under", () => {
    expect(budgets.shutdownDrainMs).toBeLessThan(base.leaseSeconds * 1_000);
  });

  it("takeover is bounded: lease + renew + sweep fits the 45-second promise", () => {
    expect(base.leaseSeconds * 1_000 + budgets.renewIntervalMs + base.sweepIntervalMs)
      .toBeLessThanOrEqual(45_000);
  });

  it("one provider call cannot consume a whole operation", () => {
    expect(base.boxRequestTimeoutMs).toBeLessThan(base.operationDeadlineMs);
  });

  it("layout install fits inside one operation", () => {
    expect(base.layoutInstallBudgetMs).toBeLessThan(base.operationDeadlineMs);
  });

  it("material outlives the longest legal turn plus its staging reserve", () => {
    // Twin of COMPANION_RUNTIME_MATERIAL_MIN_TTL_MS in packages/companion-runtime/src/types.ts,
    // which is now an alias of this derived value (125 minutes).
    expect(budgets.materialMinTtlMs)
      .toBe(base.turnAbsoluteDeadlineMs + base.materialStagingReserveMs);
    expect(budgets.materialMinTtlMs).toBe(125 * 60 * 1_000);
  });

  it("hub tokens live exactly as long as the warm Box window", () => {
    expect(budgets.hubTokenTtlSeconds).toBe(base.boxWarmTtlSeconds);
  });

  it("settings activation shares the operation deadline", () => {
    expect(budgets.settingsActivationDeadlineMs).toBe(base.operationDeadlineMs);
  });

  it("exec tool margin under the stall is healthy only once its exceedance is deleted", () => {
    const entry = exceedance("exec_tool_timeout_equals_stall");
    if (entry) {
      // Latent violation pinned by KNOWN_EXCEEDANCES: fixing the values without deleting the
      // entry fails below in the exceedance suite; deleting the entry re-enables this branch.
      expect(base.execToolRunTimeoutMs).toBeGreaterThanOrEqual(base.inactivityStallMs);
    } else {
      expect(base.execToolRunTimeoutMs).toBeLessThan(base.inactivityStallMs);
    }
  });

  it("the nominal cold path fits the cold start deadline only once its exceedance is deleted", () => {
    const entry = exceedance("cold_start_nominal_exceeds_deadline");
    if (entry) {
      expect(entry.actualMs).toBeGreaterThan(base.coldStartDeadlineMs);
    } else {
      // Once Phase 1 makes the cold path honest, pin the nominal step sum here instead.
      expect(base.coldStartDeadlineMs).toBe(3 * 60 * 1_000);
    }
  });
});

describe("known budget exceedances", () => {
  it("has unique ids", () => {
    const ids = KNOWN_EXCEEDANCES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every documented violation still holds — fix the budget and delete its entry together", () => {
    for (const entry of KNOWN_EXCEEDANCES) {
      if (entry.kind === "exceeds") {
        expect(entry.actualMs, entry.id).toBeGreaterThan(entry.boundMs);
      } else {
        expect(entry.actualMs, entry.id).toBeGreaterThanOrEqual(entry.boundMs);
      }
    }
  });

  it("entries that mirror budget values stay in lockstep with them", () => {
    const execEntry = exceedance("exec_tool_timeout_equals_stall");
    expect(execEntry?.actualMs).toBe(base.execToolRunTimeoutMs);
    expect(execEntry?.boundMs).toBe(base.inactivityStallMs);
    const coldEntry = exceedance("cold_start_nominal_exceeds_deadline");
    expect(coldEntry?.boundMs).toBe(base.coldStartDeadlineMs);
  });
});

describe("SQL budget contract", () => {
  it("parses this repo's interval dialect", () => {
    expect(sqlIntervalToMs("30 seconds")).toBe(30_000);
    expect(sqlIntervalToMs("10 minutes")).toBe(600_000);
    expect(sqlIntervalToMs("2 hours 5 minutes")).toBe(7_500_000);
    expect(sqlIntervalToMs("7 days")).toBe(7 * 86_400_000);
    expect(() => sqlIntervalToMs("1 fortnight")).toThrow();
    expect(() => sqlIntervalToMs("hours")).toThrow();
  });

  it("every contract literal is parseable", () => {
    for (const literals of Object.values(COMPANION_SQL_BUDGET_CONTRACT)) {
      for (const literal of literals) expect(() => sqlIntervalToMs(literal)).not.toThrow();
    }
  });

  it("contract and untracked lists are disjoint", () => {
    for (const name of COMPANION_SQL_UNTRACKED_INTERVAL_FUNCTIONS) {
      expect(COMPANION_SQL_BUDGET_CONTRACT[name]).toBeUndefined();
    }
  });

  it("pins the SQL twins of the TypeScript budgets", () => {
    const contract = COMPANION_SQL_BUDGET_CONTRACT;
    expect(contract.companion_runtime_claim_work_without_material_guard?.map(sqlIntervalToMs))
      .toContain(base.turnAbsoluteDeadlineMs);
    expect(contract.companion_runtime_claim_work_without_material_guard?.map(sqlIntervalToMs))
      .toContain(base.coldStartDeadlineMs);
    expect(contract.companion_runtime_checkpoint?.map(sqlIntervalToMs))
      .toContain(base.inactivityStallMs);
    expect(contract.companion_runtime_prepare_queued_turn_material?.map(sqlIntervalToMs))
      .toContain(budgets.materialMinTtlMs);
    expect(contract.companion_api_enqueue_turn?.map(sqlIntervalToMs))
      .toContain(budgets.materialMinTtlMs);
    expect(contract.companion_runtime_record_material_snapshot?.map(sqlIntervalToMs))
      .toContain(budgets.materialMinTtlMs);
    expect(contract.companion_runtime_mint_hub_token?.map(sqlIntervalToMs))
      .toEqual([budgets.hubTokenTtlSeconds * 1_000]);
    expect(contract.companion_runtime_mint_mcp_broker_token?.map(sqlIntervalToMs))
      .toEqual([budgets.hubTokenTtlSeconds * 1_000]);
    expect(contract.companion_runtime_settle?.map(sqlIntervalToMs))
      .toContain(base.leaseSeconds * 1_000);
    expect(contract.companion_runtime_observe_instance?.map(sqlIntervalToMs))
      .toContain(base.coldStartDeadlineMs);
    expect(contract.companion_runtime_assign_operation_intent).toBeUndefined();
    expect(contract.companion_runtime_recovery_metrics?.map(sqlIntervalToMs))
      .toEqual([15 * 60_000]);
    expect(contract.companion_fire_routine).toBeUndefined();
    expect(contract.companion_runtime_expire_queued_routine_turns?.map(sqlIntervalToMs))
      .toEqual([COMPANION_ROUTINE_MISSED_GRACE_MS]);
    // Runtime v3 deduplicates provider deliveries by identity rather than dropping distinct
    // occurrences inside the legacy time throttle.
    expect(contract.companion_api_fire_trigger).toBeUndefined();
  });
});
