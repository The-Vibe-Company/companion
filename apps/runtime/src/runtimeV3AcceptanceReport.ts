#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import { verifyRuntimeDatabaseRole } from "@companion/db/runtime-role";
import {
  createRuntimeV3AcceptanceReport,
  type RuntimeV3MeasurementFact,
} from "@companion/companion-runtime/v3/measurement";
import postgres, { type Sql } from "postgres";

interface MeasurementRow {
  inProductWindow: boolean;
  lane: RuntimeV3MeasurementFact["lane"];
  wakePath: RuntimeV3MeasurementFact["wakePath"];
  boxProvider: string;
  modelProvider: string;
  modelId: string;
  state: RuntimeV3MeasurementFact["state"];
  acceptedAt: Date | null;
  firstClaimedAt: Date | null;
  boxReadyAt: Date | null;
  stagingCompletedAt: Date | null;
  piReadyAt: Date | null;
  admissionKind: RuntimeV3MeasurementFact["admissionKind"];
  admittedAt: Date | null;
  firstActivityAt: Date | null;
  lastActivityAt: Date | null;
  settledAt: Date | null;
  claimCount: number;
}

export async function runtimeV3AcceptanceReport(
  sql: Sql,
  input: { since: Date; until: Date },
) {
  const facts = await sql<MeasurementRow[]>`
    select in_product_window as "inProductWindow", lane::text,
      wake_path::text as "wakePath", box_provider as "boxProvider",
      model_provider as "modelProvider", model_id as "modelId", state::text,
      accepted_at as "acceptedAt", first_claimed_at as "firstClaimedAt",
      box_ready_at as "boxReadyAt", staging_completed_at as "stagingCompletedAt",
      pi_ready_at as "piReadyAt", admission_kind::text as "admissionKind",
      admitted_at as "admittedAt", first_activity_at as "firstActivityAt",
      last_activity_at as "lastActivityAt", settled_at as "settledAt",
      claim_count as "claimCount"
    from public.companion_v3_runtime_measurement_facts(${input.since}, ${input.until}, 3)
  `;
  return createRuntimeV3AcceptanceReport(facts, input.until);
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_COMPANION_RUNTIME_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_COMPANION_RUNTIME_URL is required");
  const hours = reportHours(process.argv[2]);
  const until = new Date();
  const since = new Date(until.getTime() - hours * 60 * 60_000);
  const role = databaseRole(databaseUrl);
  const sql = postgres(databaseUrl, { prepare: false, max: 2 });
  try {
    await verifyRuntimeDatabaseRole(sql, role);
    const report = await runtimeV3AcceptanceReport(sql, { since, until });
    process.stdout.write(`${JSON.stringify({
      event: "runtime.v3.acceptance_report",
      window: { since: since.toISOString(), until: until.toISOString() },
      ...report,
    })}\n`);
    if (!report.releaseMeasurementReady) process.exitCode = 2;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function reportHours(value: string | undefined): number {
  if (value === undefined) return 24;
  const hours = Number(value);
  if (!Number.isSafeInteger(hours) || hours < 1 || hours > 31 * 24) {
    throw new Error("report window must be an integer from 1 to 744 hours");
  }
  return hours;
}

function databaseRole(databaseUrl: string): string {
  try {
    const role = decodeURIComponent(new URL(databaseUrl).username);
    if (role) return role;
  } catch {
    // The generic message below intentionally omits the credential-bearing URL.
  }
  throw new Error("runtime database URL must include its login role");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "acceptance report failed"}\n`);
    process.exitCode = 1;
  });
}
