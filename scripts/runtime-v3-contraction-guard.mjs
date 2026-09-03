#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

function read(path) {
  return readFileSync(new URL(path, `file://${repositoryRoot}/`), "utf8");
}

function reject(path, patterns) {
  const source = read(path);
  for (const pattern of patterns) {
    if (pattern.test(source)) {
      throw new Error(`${path} exposes retired Runtime v2 surface: ${pattern}`);
    }
  }
}

function requireText(path, values) {
  const source = read(path);
  for (const value of values) {
    if (!source.includes(value)) throw new Error(`${path} is missing contraction proof: ${value}`);
  }
}

export function assertRuntimeV3Contraction() {
  reject("apps/runtime/src/production.ts", [
    /createRuntimeKernel/,
    /PostgresRuntimeStore/,
    /new RuntimeScheduler/,
    /from ["']@companion\/companion-runtime["']/,
  ]);
  reject("apps/api/src/companionRoutes.ts", [
    /turns\/:turnId\/retry/,
    /runtime\/start/,
    /runtime\/stop/,
    /enqueueCompanionOperationV2/,
  ]);
  reject("packages/core/src/companionRuntimeApi.ts", [
    /companion_api_enqueue_turn\(/,
    /companion_api_enqueue_operation\(/,
    /companion_api_retry_turn\(/,
    /companion_v3_api_restart_pi\(/,
    /export async function retryCompanionTurnV2/,
    /export async function enqueueCompanionOperationV2/,
  ]);
  reject("packages/contracts/src/companionRuntime.ts", [
    /retryCompanionTurnInputSchema/,
    /restart_box/,
  ]);
  reject("packages/contracts/src/companions.ts", [/startCompanionRuntimeInputSchema/]);
  reject("packages/companion-runtime/src/index.ts", [
    /createRuntimeKernel/,
    /RuntimeScheduler/,
    /PostgresRuntimeStore/,
    /\.\/attempt/,
    /\.\/operations/,
    /\.\/retry/,
    /\.\/store/,
  ]);
  reject("packages/db/src/schema.ts", [
    /export const companionTurnAttempts/,
    /export const companionOperations/,
    /export const companionOperationKindEnum/,
    /export const companionAttemptStatusEnum/,
  ]);
  requireText("packages/db/runtime-role-grants.sql", [
    "procedure.proname LIKE 'companion_v3_runtime_%'",
    "procedure.proname LIKE 'companion_runtime_image_%'",
    "'companion_api_enqueue_operation'",
    "'companion_api_retry_turn'",
  ]);
  requireText("packages/db/drizzle/0179_companion_runtime_v3_contraction.sql", [
    "companion_v3_api_enqueue_turn",
    "companion_v3_api_cancel_turn",
    "REVOKE EXECUTE ON FUNCTION public.companion_v3_api_restart_pi",
    "DROP FUNCTION public.companion_v3_api_restart_pi",
  ]);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  assertRuntimeV3Contraction();
  process.stdout.write("Runtime v3 contraction guard passed.\n");
}
