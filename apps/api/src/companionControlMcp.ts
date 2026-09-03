/* oxlint-disable anti-slop/no-unknown-parameters -- This module is the JSON-RPC I/O boundary; Zod parses raw requests before dispatch. */

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  COMPANION_CONFIG_PROPOSAL_CONNECT_PROVIDERS,
  companionControlJsonObjectSchema,
  companionRequestRoutineChangeInputSchema,
  companionRequestTriggerChangeInputSchema,
  companionSendPeerMessageInputSchema,
  redactCompanionControlTrigger,
  type CompanionControlJsonValue,
  type CompanionControlRequestKind,
} from "@companion/contracts";
import {
  cancelCompanionDelegationTurn,
  companionControlActor,
  createCompanionControlRequest,
  deterministicControlUuid,
  enqueueCompanionDelegation,
  finishCompanionControlInvocation,
  getCompanionDelegation,
  getCompanionProviderCatalog,
  getCompanionRuntimeView,
  listCompanionControlPeers,
  listCompanionControlPlugins,
  listCompanionControlSkills,
  listCompanionDelegations,
  listCompanionRoutineRuns,
  listCompanionRoutines,
  listCompanionTriggerRuns,
  listCompanionTriggers,
  registerCompanionControlInvocation,
  scheduleCompanionPiRestart,
  updateCompanionControlPlugin,
  updateCompanionControlSkills,
  updateCompanionWithRuntime,
  type CompanionControlAuthorization,
} from "@companion/core";
import type { Db } from "@companion/db";

const callSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number().finite(), z.null()]),
  method: z.literal("tools/call"),
  params: z.object({
    name: z.string().min(1).max(128),
    arguments: companionControlJsonObjectSchema.default({}),
  }).strict(),
}).strict();

const emptySchema = z.object({}).strict();
const updateSelfSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  instructions: z.string().max(280).optional(),
}).strict().refine((value) => value.name !== undefined || value.instructions !== undefined);
const updateSkillsSchema = z.object({
  add: z.array(z.string().uuid()).max(100).default([]),
  remove: z.array(z.string().uuid()).max(100).default([]),
}).strict();
const accountSchema = z.object({ account_id: z.string().uuid() }).strict();
const modelSchema = z.object({ model_id: z.string().trim().min(1).max(200) }).strict();
const pluginConnectionSchema = z.object({
  provider: z.enum(COMPANION_CONFIG_PROPOSAL_CONNECT_PROVIDERS),
  reason: z.string().trim().max(280).optional(),
}).strict();
const routineIdSchema = z.object({ routine_id: z.string().uuid() }).strict();
const routineRunsSchema = routineIdSchema.extend({ limit: z.number().int().min(1).max(100).default(50) }).strict();
const triggerIdSchema = z.object({ trigger_id: z.string().uuid() }).strict();
const triggerRunsSchema = triggerIdSchema.extend({ limit: z.number().int().min(1).max(100).default(50) }).strict();
const peerSchema = z.object({ target_companion_id: z.string().uuid() }).strict();
const delegationListSchema = z.object({
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().uuid().optional(),
}).strict();
const delegationIdSchema = z.object({ delegation_id: z.string().uuid() }).strict();

type JsonRpcId = string | number | null;
type McpResult = Record<string, CompanionControlJsonValue>;

export interface CompanionControlMcpDependencies {
  cancelCompanionDelegationTurn: typeof cancelCompanionDelegationTurn;
  companionControlActor: typeof companionControlActor;
  finishCompanionControlInvocation: typeof finishCompanionControlInvocation;
  getCompanionDelegation: typeof getCompanionDelegation;
  registerCompanionControlInvocation: typeof registerCompanionControlInvocation;
  updateCompanionWithRuntime: typeof updateCompanionWithRuntime;
}

const defaultDependencies: CompanionControlMcpDependencies = {
  cancelCompanionDelegationTurn,
  companionControlActor,
  finishCompanionControlInvocation,
  getCompanionDelegation,
  registerCompanionControlInvocation,
  updateCompanionWithRuntime,
};

function canonical(value: CompanionControlJsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  // The recursive JSON schema established the value contract before this object-arm narrowing.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- contract-backed recursive JSON narrowing
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function callIdentity(
  authorization: CompanionControlAuthorization,
  id: JsonRpcId,
  name: string,
  args: Record<string, CompanionControlJsonValue>,
) {
  const rpcIdDigest = createHash("sha256")
    .update(canonical({ id }), "utf8")
    .digest("hex");
  const key = `${authorization.attemptId}:${rpcIdDigest}`;
  const digest = createHash("sha256").update(canonical({ name, args }), "utf8").digest("hex");
  return { key, digest };
}

function ok(id: JsonRpcId, value: McpResult) {
  return {
    jsonrpc: "2.0" as const,
    id,
    result: {
      content: [{ type: "text", text: JSON.stringify(value) }],
      structuredContent: value,
      isError: false,
    },
  };
}

function failure(id: JsonRpcId, message: string) {
  return {
    jsonrpc: "2.0" as const,
    id,
    result: {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    },
  };
}

function safeMessage(error: unknown): string {
  if (error instanceof z.ZodError) return "The tool arguments are invalid.";
  if (error instanceof Error && [
    "peer access is not approved",
    "delegation depth exceeded",
    "delegation budget exceeded",
    "self delegation is not allowed",
  ].some((known) => error.message.includes(known))) return error.message;
  return "The Companion control action could not be completed.";
}

async function requestApproval(input: {
  authorization: CompanionControlAuthorization;
  id: JsonRpcId;
  name: string;
  args: Record<string, CompanionControlJsonValue>;
  kind: CompanionControlRequestKind;
  action: string;
  summary: string;
  payload: Record<string, CompanionControlJsonValue>;
  requiredAccess?: "owner" | "editor";
  database: Db;
}) {
  const identity = callIdentity(input.authorization, input.id, input.name, input.args);
  const request = await createCompanionControlRequest({
    authorization: input.authorization,
    id: deterministicControlUuid(identity.digest, identity.key),
    kind: input.kind,
    action: input.action,
    summary: input.summary,
    payload: input.payload,
    requestKey: identity.key,
    requestDigest: identity.digest,
    requiredAccess: input.requiredAccess ?? "editor",
    database: input.database,
  });
  return { request_id: request.id, status: "pending_approval", expires_at: request.expires_at };
}

export async function executeCompanionControlMcp(input: {
  raw: unknown;
  authorization: CompanionControlAuthorization;
  database: Db;
  dependencies?: CompanionControlMcpDependencies;
}): Promise<object> {
  const parsed = callSchema.safeParse(input.raw);
  if (!parsed.success) {
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } };
  }
  const call = parsed.data;
  const args = call.params.arguments;
  const a = input.authorization;
  const dependencies = input.dependencies ?? defaultDependencies;
  const identity = callIdentity(a, call.id, call.params.name, args);
  let invocation: Awaited<ReturnType<typeof registerCompanionControlInvocation>>;
  try {
    invocation = await dependencies.registerCompanionControlInvocation({
      authorization: a,
      id: deterministicControlUuid(identity.digest, `invocation:${identity.key}`),
      requestKey: identity.key,
      requestDigest: identity.digest,
      database: input.database,
    });
  } catch (error) {
    return failure(call.id, safeMessage(error));
  }
  if (invocation.replayed) {
    if (!invocation.result) return failure(call.id, "The Companion control replay is unavailable.");
    return invocation.result;
  }
  const response = await (async () => {
    const actor = await dependencies.companionControlActor(a, input.database);
    const context = { actor, orgId: a.orgId, companionId: a.companionId, database: input.database };
    switch (call.params.name) {
      case "companion_get_self": {
        emptySchema.parse(args);
        return ok(call.id, await getCompanionRuntimeView(context));
      }
      case "companion_update_self": {
        const body = updateSelfSchema.parse(args);
        const patch: Record<string, string> = {};
        if (body.name !== undefined) patch.name = body.name;
        if (body.instructions !== undefined) patch.persona = body.instructions;
        const companion = await dependencies.updateCompanionWithRuntime({ ...context, patch });
        return ok(call.id, { companion, apply_pending: body.instructions !== undefined });
      }
      case "companion_list_skills":
        emptySchema.parse(args);
        return ok(call.id, { skills: await listCompanionControlSkills(context) });
      case "companion_update_skills": {
        const body = updateSkillsSchema.parse(args);
        const companion = await updateCompanionControlSkills({ ...context, ...body });
        return ok(call.id, { companion, apply_pending: true });
      }
      case "companion_list_models": {
        emptySchema.parse(args);
        const companion = await getCompanionRuntimeView(context);
        const providerId = companion.runtime.provider_ids[0] ?? null;
        const provider = (await getCompanionProviderCatalog()).find((item) => item.id === providerId);
        return ok(call.id, { provider_id: providerId, selected_model_id: companion.model_id, models: provider?.models ?? [] });
      }
      case "companion_request_model_change": {
        const body = modelSchema.parse(args);
        return ok(call.id, await requestApproval({
          authorization: a, id: call.id, name: call.params.name, args,
          kind: "model_change", action: "change_model", summary: `Change model to ${body.model_id}`,
          payload: body, database: input.database,
        }));
      }
      case "companion_list_plugins":
        emptySchema.parse(args);
        return ok(call.id, { plugins: await listCompanionControlPlugins(context) });
      case "companion_attach_plugin":
      case "companion_detach_plugin": {
        const body = accountSchema.parse(args);
        const companion = await updateCompanionControlPlugin({
          ...context,
          accountId: body.account_id,
          selected: call.params.name === "companion_attach_plugin",
        });
        return ok(call.id, { companion, apply_pending: true });
      }
      case "companion_request_plugin_connection": {
        const body = pluginConnectionSchema.parse(args);
        return ok(call.id, await requestApproval({
          authorization: a, id: call.id, name: call.params.name, args,
          kind: "plugin_connection", action: "connect_plugin",
          summary: `Connect ${body.provider}`, payload: body, database: input.database,
        }));
      }
      case "companion_list_routines":
        emptySchema.parse(args);
        return ok(call.id, { routines: await listCompanionRoutines(context) });
      case "companion_get_routine": {
        const body = routineIdSchema.parse(args);
        const routine = (await listCompanionRoutines(context)).find((item) => item.id === body.routine_id);
        return routine ? ok(call.id, { routine }) : failure(call.id, "Routine not found.");
      }
      case "companion_list_routine_runs": {
        const body = routineRunsSchema.parse(args);
        return ok(call.id, await listCompanionRoutineRuns({ ...context, routineId: body.routine_id, limit: body.limit }));
      }
      case "companion_request_routine_change": {
        const body = companionRequestRoutineChangeInputSchema.parse(args);
        return ok(call.id, await requestApproval({
          authorization: a, id: call.id, name: call.params.name, args,
          kind: "routine_change", action: body.action,
          summary: `${body.action} routine${body.draft?.name ? ` ${body.draft.name}` : ""}`,
          payload: body, database: input.database,
        }));
      }
      case "companion_list_triggers":
        emptySchema.parse(args);
        return ok(call.id, {
          triggers: (await listCompanionTriggers({
            ...context,
            webhookBaseUrl: "https://companion.invalid",
          })).map(redactCompanionControlTrigger),
        });
      case "companion_get_trigger": {
        const body = triggerIdSchema.parse(args);
        const trigger = (await listCompanionTriggers({ ...context, webhookBaseUrl: "https://companion.invalid" }))
          .find((item) => item.id === body.trigger_id);
        return trigger
          ? ok(call.id, { trigger: redactCompanionControlTrigger(trigger) })
          : failure(call.id, "Trigger not found.");
      }
      case "companion_list_trigger_runs": {
        const body = triggerRunsSchema.parse(args);
        return ok(call.id, await listCompanionTriggerRuns({ ...context, triggerId: body.trigger_id, limit: body.limit }));
      }
      case "companion_request_trigger_change": {
        const body = companionRequestTriggerChangeInputSchema.parse(args);
        return ok(call.id, await requestApproval({
          authorization: a, id: call.id, name: call.params.name, args,
          kind: "trigger_change", action: body.action,
          summary: `${body.action} trigger${body.draft?.name ? ` ${body.draft.name}` : ""}`,
          payload: body, database: input.database,
        }));
      }
      case "companion_list_peers":
        emptySchema.parse(args);
        return ok(call.id, { peers: await listCompanionControlPeers({ orgId: a.orgId, companionId: a.companionId, database: input.database }) });
      case "companion_request_peer_access": {
        const body = peerSchema.parse(args);
        const peer = (await listCompanionControlPeers({ orgId: a.orgId, companionId: a.companionId, database: input.database }))
          .find((candidate) => candidate.companion_id === body.target_companion_id);
        if (!peer) return failure(call.id, "Peer Companion not found.");
        return ok(call.id, await requestApproval({
          authorization: a, id: call.id, name: call.params.name, args,
          kind: "peer_access", action: "grant_peer_access", summary: `Allow delegation to ${peer.name}`,
          payload: { target_companion_id: peer.companion_id, target_name: peer.name },
          requiredAccess: "owner", database: input.database,
        }));
      }
      case "companion_send_message": {
        const body = companionSendPeerMessageInputSchema.parse(args);
        const identity = callIdentity(a, call.id, call.params.name, args);
        const self = await getCompanionRuntimeView(context);
        const clientMessageId = deterministicControlUuid(identity.digest, "delegation-message");
        const accepted = await enqueueCompanionDelegation({
          authorization: a,
          targetCompanionId: body.target_companion_id,
          targetClientMessageId: clientMessageId,
          content: `Delegated by Companion ${self.name}.\n\n${body.content}`,
          id: deterministicControlUuid(identity.digest, "delegation"),
          responseMode: body.response_mode,
          requestKey: identity.key,
          requestDigest: identity.digest,
          database: input.database,
        });
        return ok(call.id, { delegation: accepted.delegation, target_turn: accepted.targetTurn });
      }
      case "companion_list_delegations": {
        const body = delegationListSchema.parse(args);
        return ok(call.id, { delegations: await listCompanionDelegations({ orgId: a.orgId, companionId: a.companionId, ...body, database: input.database }) });
      }
      case "companion_get_delegation": {
        const body = delegationIdSchema.parse(args);
        const delegation = await dependencies.getCompanionDelegation({ orgId: a.orgId, companionId: a.companionId, delegationId: body.delegation_id, database: input.database });
        return delegation ? ok(call.id, { delegation }) : failure(call.id, "Delegation not found.");
      }
      case "companion_cancel_delegation": {
        const body = delegationIdSchema.parse(args);
        const delegation = await dependencies.getCompanionDelegation({ orgId: a.orgId, companionId: a.companionId, delegationId: body.delegation_id, database: input.database });
        if (!delegation?.target_companion_id) return failure(call.id, "Delegation not found.");
        const turn = await dependencies.cancelCompanionDelegationTurn({
          orgId: a.orgId,
          sourceCompanionId: a.companionId,
          delegationId: delegation.id,
          database: input.database,
        });
        return ok(call.id, { delegation_id: delegation.id, target_turn: turn });
      }
      case "companion_restart_pi": {
        emptySchema.parse(args);
        const identity = callIdentity(a, call.id, call.params.name, args);
        const restart = await scheduleCompanionPiRestart({
          authorization: a,
          id: deterministicControlUuid(identity.digest, "pi-restart"),
          database: input.database,
        });
        return ok(call.id, {
          restart,
          apply_pending: restart.status === "pending",
          message: restart.status === "pending"
            ? "Pi will restart after the current turn settles."
            : "The Pi restart is already enqueued.",
        });
      }
      default:
        return { jsonrpc: "2.0", id: call.id, error: { code: -32601, message: "Tool not found" } };
    }
  })().catch((error: unknown) => failure(call.id, safeMessage(error)));
  return await dependencies.finishCompanionControlInvocation({
    authorization: a,
    requestKey: identity.key,
    requestDigest: identity.digest,
    result: companionControlJsonObjectSchema.parse(response),
    database: input.database,
  });
}
