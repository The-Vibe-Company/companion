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
  reject("scripts/ios-local-live.mjs", [
    /runtime\/stop/,
    /latest_operation/,
    /\.body\?\.operation/,
  ]);
  reject("packages/core/src/companionRuntimeApi.ts", [
    /companion_api_enqueue_turn\(/,
    /companion_api_enqueue_operation\(/,
    /companion_api_retry_turn\(/,
    /companion_v3_api_restart_pi\(/,
    /companion_api_create_companion\(/,
    /companion_api_update_companion\(/,
    /companion_api_set_initial_provider\(/,
    /companion_api_update_member_state_v2\(/,
    /companion_api_(?:read|list)_runtime\(/,
    /companion_api_(?:read|list)_skill_sync\(/,
    /companion_api_(?:bump|require)_skill_revision\(/,
    /export async function retryCompanionTurnV2/,
    /export async function enqueueCompanionOperationV2/,
    /projectCompanionRuntimeV2/,
    /readCompanionRuntimeV2/,
    /getCompanionDecisionV2/,
    /answerCompanion(?:Config|Routine|Trigger)?DecisionV2/,
  ]);
  reject("packages/core/src/companionRoutinesApi.ts", [
    /export async function \w+V2/,
  ]);
  reject("packages/core/src/companionTriggersApi.ts", [
    /export async function \w+V2/,
  ]);
  reject("packages/core/src/companionTriggerWebhookRegistration.ts", [
    /export async function \w+V2/,
  ]);
  reject("packages/contracts/src/companionRuntime.ts", [
    /retryCompanionTurnInputSchema/,
    /restart_box/,
    /latest_attempt/,
    /CompanionTurnAttempt/,
    /companionOperationSchema/,
    /CompanionOperation/,
  ]);
  reject("packages/contracts/src/companionBudgets.ts", [
    /Runtime v2/,
    /Full Box/,
    /protocol.?7/i,
    /turn attempt/i,
  ]);
  reject("packages/contracts/src/companions.ts", [
    /startCompanionRuntimeInputSchema/,
    /latest_operation/,
  ]);
  reject("packages/companion-runtime/src/index.ts", [
    /createRuntimeKernel/,
    /RuntimeScheduler/,
    /PostgresRuntimeStore/,
    /\.\/attempt/,
    /\.\/operations/,
    /\.\/retry/,
    /\.\/store/,
  ]);
  reject("packages/companion-runtime/src/runtimeSupport.ts", [
    /\.\/store/,
    /\bRuntimePiControl\s*,/,
    /RuntimeAuthorization/,
    /RuntimeWorkMaterial/,
    /RuntimeAttachmentStager/,
    /RuntimeMaterialProvider/,
    /RuntimeResourceStager/,
  ]);
  requireText("packages/companion-runtime/src/runtimeSupport.ts", [
    "RuntimePiControl as RuntimeV3PiTransport",
    "always carry the durable Turn id",
  ]);
  reject("packages/box-runtime/src/boxCompanionRuntime.ts", [
    /CompanionBoxRuntimeV2/,
    /dispatch-v2/,
    /Full Box/,
    /legacy retry path/,
  ]);
  reject("apps/ios/CompanionKit/Sources/CompanionKit/Models.swift", [
    /CompanionOperation/,
    /latest_operation/,
    /latest_attempt/,
    /CompanionTurnAttempt/,
    /restart_box/,
  ]);
  reject("apps/ios/CompanionKit/Sources/CompanionKit/APIClient.swift", [
    /CompanionOperation/,
    /OperationEnvelope/,
  ]);
  reject("apps/web/src/components/companions/CompanionTriggerTypes.ts", [
    /CompanionTriggerV2/,
    /Trigger v2/,
  ]);
  reject("packages/db/src/schema.ts", [
    /export const companionTurnAttempts/,
    /export const companionOperations/,
    /export const companionOperationKindEnum/,
    /export const companionAttemptStatusEnum/,
    /export const companionRuntimeErrorActionEnum/,
    /default\("runtime-v2"\)/,
    /\$\{t\.id\} = 'runtime-v2'/,
    /kill switch for the isolated Runtime v2 role/,
  ]);
  reject("packages/db/drizzle/0179_companion_runtime_v3_contraction.sql", [
    /PERFORM\s+pg_catalog\.set_config\(\s*'app\.companion_runtime_protocol'\s*,\s*'2'/,
    /FROM\s+public\.companion_api_create_companion\(/,
    /control\.id='runtime-v2'/,
    /CREATE FUNCTION public\.companion_v3_[\s\S]*set_config\(\s*'app\.companion_runtime_protocol'/,
  ]);
  requireText("packages/db/runtime-role-grants.sql", [
    "procedure.proname LIKE 'companion_v3_runtime_%'",
    "procedure.proname LIKE 'companion_runtime_image_%'",
    "'companion_api_enqueue_operation'",
    "'companion_api_retry_turn'",
    "companion_v3_runtime_record_turn_outputs",
  ]);
  requireText("packages/db/drizzle/0179_companion_runtime_v3_contraction.sql", [
    "DROP TRIGGER companions_runtime_v2_mutation_fence",
    "DROP TRIGGER companion_transcript_entries_runtime_v2_mutation_fence",
    "DROP TRIGGER companions_require_runtime_v2_instance",
    "DROP FUNCTION public.companion_runtime_require_v2_mutation()",
    "DROP FUNCTION public.companion_runtime_assert_v2_mutation()",
    "DROP FUNCTION public.companion_runtime_require_instance_at_commit()",
    "DROP FUNCTION public.companion_v3_settle_manual_restart()",
    "UPDATE public.companion_runtime_control SET id='runtime-v3' WHERE id='runtime-v2'",
    "CREATE OR REPLACE FUNCTION public.companion_v3_api_create_companion",
    "CREATE FUNCTION public.companion_v3_api_update_companion",
    "CREATE FUNCTION public.companion_v3_api_set_initial_provider",
    "CREATE FUNCTION public.companion_v3_api_update_member_state",
    "CREATE FUNCTION public.companion_v3_api_read_runtime",
    "CREATE FUNCTION public.companion_v3_api_list_runtime",
    "procedure.proname LIKE 'companion_v3_%'",
    "procedure.prosrc LIKE '%app.companion_runtime_protocol%'",
    "pg_catalog.replace(v_definition,'''runtime-v2''','''runtime-v3''')",
    "companion_v3_api_enqueue_turn",
    "companion_v3_api_cancel_turn",
    "REVOKE EXECUTE ON FUNCTION public.companion_v3_api_restart_pi",
    "DROP FUNCTION public.companion_v3_api_restart_pi",
    "'companion-attachments/'||p_org_id::text||'/'||p_companion_id::text",
    "'/outputs/'||p_turn_id::text||'/'||(part.ordinality-1)::text||'-'",
  ]);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  assertRuntimeV3Contraction();
  process.stdout.write("Runtime v3 contraction guard passed.\n");
}
