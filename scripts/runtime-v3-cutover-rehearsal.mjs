#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const providerCredentialPatterns = [
  /^(?:COMPANION_)?(?:BOX|ASCII).*API_KEY$/,
  /^COMPANION_(?:BOX_E2E_ZAI|IOS_LOCAL_ZAI|GEMINI_TRANSCRIPTION)_API_KEY$/,
  /^COMPANION_MCP_[A-Z0-9_]+_CLIENT_SECRET$/,
  /^(?:GITHUB_APP_PRIVATE_KEY|GITHUB_APP_CLIENT_SECRET|GOOGLE_CLIENT_SECRET)$/,
  /^(?:ANTHROPIC|OPENAI|GOOGLE|GEMINI|KIMI|MOONSHOT|ZAI|XAI|MISTRAL|OPENROUTER|GROQ|COHERE|TOGETHER|FIREWORKS)(?:_[A-Z0-9]+)*_(?:API_KEY|ACCESS_TOKEN|TOKEN|SECRET)$/,
];
const presentProviderCredentials = Object.keys(process.env)
  .filter((key) => process.env[key]?.trim())
  .filter((key) => providerCredentialPatterns.some((pattern) => pattern.test(key)))
  .sort();
if (presentProviderCredentials.length > 0) {
  throw new Error(
    `Runtime v3 cutover rehearsal refuses provider credentials: ${presentProviderCredentials.join(", ")}`,
  );
}

const databaseUrl = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_MIGRATION_URL is required for the disposable rehearsal");
const database = new URL(databaseUrl);
if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(database.hostname)) {
  throw new Error("Runtime v3 cutover rehearsal refuses non-loopback PostgreSQL");
}

const requiredDatabaseUrls = [
  ["DATABASE_MIGRATION_URL", databaseUrl],
  ["DATABASE_API_URL", process.env.DATABASE_API_URL],
  ["DATABASE_WORKER_URL", process.env.DATABASE_WORKER_URL],
  ["DATABASE_COMPANION_RUNTIME_URL", process.env.DATABASE_COMPANION_RUNTIME_URL],
];
for (const [name, raw] of requiredDatabaseUrls) {
  if (!raw) throw new Error(`${name} is required for the disposable rehearsal`);
  const parsed = new URL(raw);
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname)) {
    throw new Error(`Runtime v3 cutover rehearsal refuses non-loopback ${name}`);
  }
}

const environment = {
  ...process.env,
  DATABASE_URL: databaseUrl,
  DATABASE_MIGRATION_URL: databaseUrl,
};
environment.COMPANION_COMPANIONS_ENABLED = "false";
environment.COMPANION_DEV_BOX_MODE = "sim";

const steps = [
  {
    name: "contraction",
    phases: [{ name: "production-v3-boundary" }],
    evidence: "pnpm verify:runtime-v3-contraction",
    args: ["verify:runtime-v3-contraction"],
  },
  {
    name: "offline-purge",
    phases: [
      "legacy-claims-off-before-purge",
      "purge-report",
      "purge-dry-run",
      "purge-confirmed",
      "inventory-empty",
    ].map((name) => ({
      name,
      test: "keeps ownership on failure, resumes once, and preserves reusable data exactly",
    })),
    evidence: "apps/runtime/test/integration/companionV2Purge.integration.test.ts",
    args: [
    "--filter", "@companion/runtime", "exec", "vitest", "run",
    "--config", "vitest.integration.config.ts",
    "test/integration/companionV2Purge.integration.test.ts",
    ],
  },
  {
    name: "v3-postgres-topology-lifecycle",
    phases: [
      {
        name: "v3-claims-off-before-activation",
        test: "keeps v3 work non-activatable while the existing runtime gate is disabled",
      },
      {
        name: "v3-create",
        test: "creates a cold Companion, durably queues its first Turn, and claims preparation",
      },
      {
        name: "background-routine-or-trigger",
        test: "runs untrusted triggers through the shared isolated FIFO and surfaces each result once",
      },
      {
        name: "archive-and-wake-same-box",
        test: "archives after one idle hour, resumes the same Box through staging, and deletes once",
      },
      {
        name: "permanent-delete",
        test: "archives after one idle hour, resumes the same Box through staging, and deletes once",
      },
    ],
    evidence: "apps/runtime/test/integration/runtimeV3Progression.integration.test.ts",
    args: [
    "--filter", "@companion/runtime", "exec", "vitest", "run",
    "--config", "vitest.integration.config.ts",
    "test/integration/runtimeV3Progression.integration.test.ts",
    ],
  },
  {
    name: "v3-simulator-full-stack",
    phases: [{
      name: "chat-and-pi-steer",
      test: "survives API death and runtime takeover while preserving ordered chat, wake, and delete",
    }],
    evidence: "apps/runtime/test/integration/runtimeFullStack.integration.test.ts",
    args: [
    "--filter", "@companion/runtime", "exec", "vitest", "run",
    "--config", "vitest.integration.config.ts",
    "test/integration/runtimeFullStack.integration.test.ts",
    ],
  },
];

const requiredPhases = new Set([
  "production-v3-boundary",
  "legacy-claims-off-before-purge",
  "v3-claims-off-before-activation",
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
const declaredPhases = new Set(steps.flatMap((step) => step.phases.map((phase) => phase.name)));
const missingPhases = [...requiredPhases].filter((phase) => !declaredPhases.has(phase));
if (missingPhases.length > 0) {
  throw new Error(`Runtime v3 cutover rehearsal is missing phases: ${missingPhases.join(", ")}`);
}

for (const step of steps) {
  const namedTests = step.phases.flatMap((phase) => phase.test ? [phase.test] : []);
  if (namedTests.length === 0) continue;
  const source = readFileSync(step.evidence, "utf8");
  for (const test of namedTests) {
    if (!source.includes(`it("${test}"`)) {
      throw new Error(`${step.evidence} no longer contains required rehearsal test: ${test}`);
    }
  }
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
      phase: phase.name,
      evidence: step.evidence,
      test: phase.test ?? null,
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
