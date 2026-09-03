/**
 * Product promise:
 * Every timeout, deadline, and TTL a Companions-runtime SQL function spends is registered in
 * `COMPANION_SQL_BUDGET_CONTRACT` (packages/contracts/src/companionBudgets.ts), so retuning a
 * budget in TypeScript without the paired migration — or adding a SQL timeout nobody registered —
 * is impossible to merge silently.
 *
 * Regression caught:
 * The runtime SQL functions live in rename chains (the claim-work function was renamed three
 * times; the `'2 hours'` absolute deadline survives only in the innermost
 * `companion_runtime_claim_work_without_material_guard`). Editing an `interval '...'` literal in a
 * later CREATE OR REPLACE, or introducing a new interval in any `companion%` function, would
 * otherwise drift away from the unified TypeScript budgets that the rest of the runtime trusts.
 *
 * Why integrated:
 * The final definition of each function only exists after replaying every migration in order;
 * parsing migration files cannot resolve renames and re-creations. Only `pg_get_functiondef` on a
 * migrated database is authoritative.
 *
 * Failure proof:
 * The suite replays the real migrations into a disposable database and compares the interval
 * multiset of every `companion%` function against the contract in both directions, with an
 * explicit allowlist for non-runtime subsystems so the default stays fail-closed.
 */
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractRuntimeRoleGrantBlock, resolveRuntimeRoleGrantsFile } from "../../src/migrate";
import {
  COMPANION_ROUTINE_MISSED_GRACE_MS,
  COMPANION_SQL_BUDGET_CONTRACT,
  COMPANION_SQL_UNTRACKED_INTERVAL_FUNCTIONS,
  sqlIntervalToMs,
} from "@companion/contracts";

const databaseUrl = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!databaseUrl?.trim()) {
  throw new Error("Companion runtime budgets integration test requires an explicit disposable DATABASE_URL");
}

const migrationsDir = fileURLToPath(new URL("../../../../packages/db/drizzle/", import.meta.url));
const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
const budgetsDatabaseName = `runtime_budgets_${suffix}`;
const apiRole = `runtime_budgets_api_${suffix}`;
const workerRole = `runtime_budgets_worker_${suffix}`;
const executorRole = `runtime_budgets_exec_${suffix}`;
/** The migration whose preflight requires the split runtime grants on the same connection. */
const CUTOVER_MIGRATION = "0094_companion_runtime_cutover.sql";

const adminSql = postgres(databaseUrl, { max: 1 });
const budgetsUrl = new URL(databaseUrl);
budgetsUrl.pathname = `/${budgetsDatabaseName}`;
budgetsUrl.search = "";

type Sql = ReturnType<typeof postgres>;

let budgetsSql: Sql | undefined;
let budgetsDatabaseCreated = false;
let rolesCreated = false;
/** proname → every `interval '...'` literal in its final definition, with multiplicity. */
let intervalsByFunction: Map<string, string[]>;

async function applyMigrationFile(client: Sql, name: string): Promise<void> {
  const source = await readFile(`${migrationsDir}/${name}`, "utf8");
  const statements = source
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
  await client.begin(async (tx) => {
    for (const statement of statements) await tx.unsafe(statement);
  });
}

async function migrationNames(): Promise<string[]> {
  return (await readdir(migrationsDir))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
}

async function replayMigrations(
  client: Sql,
  range: { before?: string; after?: string } = {},
): Promise<void> {
  for (const migration of await migrationNames()) {
    if (range.before !== undefined && migration >= range.before) continue;
    if (range.after !== undefined && migration <= range.after) continue;
    await applyMigrationFile(client, migration);
  }
}

/** Mirrors the production migrate hook: role markers plus the split grants on this connection. */
async function applySplitRuntimeGrants(client: Sql): Promise<void> {
  const grants = extractRuntimeRoleGrantBlock(
    await readFile(await resolveRuntimeRoleGrantsFile(), "utf8"),
  );
  await client`select
    set_config('companion.api_role', ${apiRole}, false),
    set_config('companion.worker_role', ${workerRole}, false),
    set_config('companion.companion_runtime_role', ${executorRole}, false),
    set_config('companion.retired_runtime_role', '', false)`;
  await client.unsafe(grants);
}

function sortedMultiset(literals: readonly string[]): string[] {
  return [...literals].sort();
}

beforeAll(async () => {
  await adminSql.unsafe(`
    create role ${apiRole} login nosuperuser nobypassrls noinherit;
    create role ${workerRole} login nosuperuser nobypassrls noinherit;
    create role ${executorRole} login nosuperuser nobypassrls noinherit;
  `);
  rolesCreated = true;
  await adminSql.unsafe(`create database "${budgetsDatabaseName}"`);
  budgetsDatabaseCreated = true;
  budgetsSql = postgres(budgetsUrl.toString(), { max: 1 });
  // The cutover migration's preflight verifies the split runtime grants on this connection, so
  // the replay pauses there, applies the production grant block, and resumes to the newest file.
  await replayMigrations(budgetsSql, { before: CUTOVER_MIGRATION });
  await applySplitRuntimeGrants(budgetsSql);
  await applyMigrationFile(budgetsSql, CUTOVER_MIGRATION);
  await replayMigrations(budgetsSql, { after: CUTOVER_MIGRATION });

  const rows = await budgetsSql<Array<{ name: string; definition: string }>>`
    select p.proname as name, pg_get_functiondef(p.oid) as definition
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'companion%'
  `;
  intervalsByFunction = new Map();
  for (const row of rows) {
    // A few functions keep legacy overloads under one name (claim_work's guarded wrapper chain,
    // trigger create/update, token resolution). The contract governs the *name*: literals merge
    // across overloads, so a budget hiding in any arity still has to be registered.
    const literals = [...row.definition.matchAll(/interval\s+'([^']+)'/gi)]
      .map((match) => match[1]!);
    intervalsByFunction.set(row.name, [...(intervalsByFunction.get(row.name) ?? []), ...literals]);
  }
}, 120_000);

afterAll(async () => {
  await budgetsSql?.end({ timeout: 1 });
  if (budgetsDatabaseCreated) {
    await adminSql.unsafe(`drop database if exists "${budgetsDatabaseName}" with (force)`);
  }
  if (rolesCreated) {
    await adminSql.unsafe(`
      drop role if exists ${apiRole};
      drop role if exists ${workerRole};
      drop role if exists ${executorRole};
    `);
  }
  await adminSql.end({ timeout: 1 });
});

describe("companion runtime SQL budget contract", () => {
  it("finds every contract function in the migrated schema", () => {
    for (const name of Object.keys(COMPANION_SQL_BUDGET_CONTRACT)) {
      expect(intervalsByFunction.has(name), `contract function ${name} is missing`).toBe(true);
    }
  });

  it("matches each contract function's interval multiset in both directions", () => {
    for (const [name, expected] of Object.entries(COMPANION_SQL_BUDGET_CONTRACT)) {
      const actual = intervalsByFunction.get(name) ?? [];
      // Sorted multiset equality: an interval present in SQL but absent from the contract fails
      // exactly like a contract entry the SQL no longer carries.
      expect(sortedMultiset(actual), name).toEqual(sortedMultiset(expected));
    }
  });

  it("rejects interval literals in any function outside the contract and the allowlist", () => {
    const registered = new Set([
      ...Object.keys(COMPANION_SQL_BUDGET_CONTRACT),
      ...COMPANION_SQL_UNTRACKED_INTERVAL_FUNCTIONS,
    ]);
    for (const [name, literals] of intervalsByFunction) {
      if (registered.has(name)) continue;
      expect(
        literals,
        `${name} carries unregistered interval literals — add it to COMPANION_SQL_BUDGET_CONTRACT `
        + "(runtime budget) or COMPANION_SQL_UNTRACKED_INTERVAL_FUNCTIONS (other subsystem)",
      ).toEqual([]);
    }
  });

  it("keeps the untracked allowlist honest — every entry exists and still uses intervals", () => {
    const stale = COMPANION_SQL_UNTRACKED_INTERVAL_FUNCTIONS.filter((name) => {
      const literals = intervalsByFunction.get(name);
      return literals === undefined || literals.length === 0;
    });
    // A listed function that disappeared or dropped its intervals must leave the allowlist.
    expect(stale).toEqual([]);
  });

  it("keeps the current routine queue budget aligned and v3 trigger admission unthrottled", () => {
    const routineQueue = intervalsByFunction.get("companion_runtime_expire_queued_routine_turns") ?? [];
    expect(routineQueue.map(sqlIntervalToMs)).toEqual([COMPANION_ROUTINE_MISSED_GRACE_MS]);
    const trigger = intervalsByFunction.get("companion_api_fire_trigger") ?? [];
    expect(trigger).toEqual([]);
  });
});
