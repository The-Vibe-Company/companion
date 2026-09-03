#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const databaseUrl = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_MIGRATION_URL is required for the disposable rehearsal");
const database = new URL(databaseUrl);
if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(database.hostname)) {
  throw new Error("Runtime v3 cutover rehearsal refuses non-loopback PostgreSQL");
}

const environment = { ...process.env, DATABASE_MIGRATION_URL: databaseUrl };
for (const key of Object.keys(environment)) {
  if (/^(?:COMPANION_)?(?:BOX|ASCII).*API_KEY$/.test(key)) delete environment[key];
}
environment.COMPANION_COMPANIONS_ENABLED = "false";
environment.COMPANION_DEV_BOX_MODE = "sim";

const steps = [
  {
    name: "contraction",
    phases: ["claims-off"],
    evidence: "pnpm verify:runtime-v3-contraction",
    args: ["verify:runtime-v3-contraction"],
  },
  {
    name: "offline-purge",
    phases: ["purge-report", "purge-dry-run", "purge-confirmed", "inventory-empty"],
    evidence: "test/integration/companionV2Purge.integration.test.ts",
    args: [
    "--filter", "@companion/runtime", "exec", "vitest", "run",
    "--config", "vitest.integration.config.ts",
    "test/integration/companionV2Purge.integration.test.ts",
    ],
  },
  {
    name: "v3-postgres-topology-lifecycle",
    phases: [
      "v3-create",
      "background-routine-or-trigger",
      "archive-and-wake-same-box",
      "permanent-delete",
    ],
    evidence: "test/integration/runtimeV3Progression.integration.test.ts",
    args: [
    "--filter", "@companion/runtime", "exec", "vitest", "run",
    "--config", "vitest.integration.config.ts",
    "test/integration/runtimeV3Progression.integration.test.ts",
    ],
  },
  {
    name: "v3-simulator-full-stack",
    phases: ["chat-and-pi-steer"],
    evidence: "test/integration/runtimeFullStack.integration.test.ts",
    args: [
    "--filter", "@companion/runtime", "exec", "vitest", "run",
    "--config", "vitest.integration.config.ts",
    "test/integration/runtimeFullStack.integration.test.ts",
    ],
  },
];

const requiredPhases = new Set([
  "claims-off",
  "purge-report",
  "purge-dry-run",
  "purge-confirmed",
  "inventory-empty",
  "v3-create",
  "chat-and-pi-steer",
  "background-routine-or-trigger",
  "archive-and-wake-same-box",
  "permanent-delete",
]);
const declaredPhases = new Set(steps.flatMap((step) => step.phases));
const missingPhases = [...requiredPhases].filter((phase) => !declaredPhases.has(phase));
if (missingPhases.length > 0) {
  throw new Error(`Runtime v3 cutover rehearsal is missing phases: ${missingPhases.join(", ")}`);
}

const startedAt = new Date();
for (const step of steps) {
  process.stdout.write(`${JSON.stringify({
    event: "runtime.v3.rehearsal.step",
    name: step.name,
    phases: step.phases,
    evidence: step.evidence,
    status: "started",
  })}\n`);
  const result = spawnSync("pnpm", step.args, { cwd: process.cwd(), env: environment, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(`${JSON.stringify({ event: "runtime.v3.rehearsal.step", name: step.name, phases: step.phases, evidence: step.evidence, status: "failed", exit_code: result.status })}\n`);
    process.exit(result.status ?? 1);
  }
  for (const phase of step.phases) {
    process.stdout.write(`${JSON.stringify({
      event: "runtime.v3.rehearsal.phase",
      phase,
      evidence: step.evidence,
      status: "passed",
    })}\n`);
  }
}

process.stdout.write(`${JSON.stringify({
  event: "runtime.v3.cutover_rehearsal",
  status: "passed",
  environment: "loopback-disposable",
  provider: "deterministic-box-sim",
  started_at: startedAt.toISOString(),
  completed_at: new Date().toISOString(),
})}\n`);
