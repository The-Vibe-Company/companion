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

const steps = [
  ["contraction", ["verify:runtime-v3-contraction"]],
  ["v2-report-dry-run-purge", [
    "--filter", "@companion/runtime", "exec", "vitest", "run",
    "--config", "vitest.integration.config.ts",
    "test/integration/companionV2Purge.integration.test.ts",
  ]],
  ["v3-postgres-topology-lifecycle", [
    "--filter", "@companion/runtime", "exec", "vitest", "run",
    "--config", "vitest.integration.config.ts",
    "test/integration/runtimeV3Progression.integration.test.ts",
  ]],
  ["v3-simulator-full-stack", [
    "--filter", "@companion/runtime", "exec", "vitest", "run",
    "--config", "vitest.integration.config.ts",
    "test/integration/runtimeFullStack.integration.test.ts",
  ]],
];

const startedAt = new Date();
for (const [name, args] of steps) {
  process.stdout.write(`${JSON.stringify({ event: "runtime.v3.rehearsal.step", name, status: "started" })}\n`);
  const result = spawnSync("pnpm", args, { cwd: process.cwd(), env: environment, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(`${JSON.stringify({ event: "runtime.v3.rehearsal.step", name, status: "failed", exit_code: result.status })}\n`);
    process.exit(result.status ?? 1);
  }
  process.stdout.write(`${JSON.stringify({ event: "runtime.v3.rehearsal.step", name, status: "passed" })}\n`);
}

process.stdout.write(`${JSON.stringify({
  event: "runtime.v3.cutover_rehearsal",
  status: "passed",
  environment: "loopback-disposable",
  provider: "deterministic-box-sim",
  started_at: startedAt.toISOString(),
  completed_at: new Date().toISOString(),
})}\n`);
