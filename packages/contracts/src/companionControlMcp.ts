/** Stateless MCP tool catalog staged onto every hosted Companion. */
export const COMPANION_CONTROL_MCP_SERVER_NAME = "companion-control";
export const COMPANION_CONTROL_MCP_PROTOCOL_VERSION = "2025-03-26";

interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: readonly string[];
  additionalProperties?: boolean;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
  format?: string;
  enum?: readonly string[];
  default?: string;
}
export interface CompanionControlMcpToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

const empty = { type: "object", properties: {}, additionalProperties: false } satisfies JsonSchema;
const uuid = { type: "string", format: "uuid" };
const stringList = { type: "array", items: uuid, maxItems: 100 };

export const COMPANION_CONTROL_MCP_TOOLS: readonly CompanionControlMcpToolDefinition[] = [
  { name: "companion_get_self", description: "Read this Companion's identity, settings, and durable runtime status.", inputSchema: empty },
  {
    name: "companion_update_self",
    description: "Change this Companion's name or short instructions. The material settings update applies after the current turn.",
    inputSchema: { type: "object", properties: { name: { type: "string", minLength: 1, maxLength: 120 }, instructions: { type: "string", maxLength: 280 } }, additionalProperties: false },
  },
  { name: "companion_list_skills", description: "List Skills this Companion may select and which are selected.", inputSchema: empty },
  {
    name: "companion_update_skills",
    description: "Directly add or remove selectable Skills from this Companion.",
    inputSchema: { type: "object", properties: { add: stringList, remove: stringList }, additionalProperties: false },
  },
  { name: "companion_list_models", description: "List models available for this Companion's connected provider.", inputSchema: empty },
  {
    name: "companion_request_model_change",
    description: "Request human approval to change this Companion's model.",
    inputSchema: { type: "object", properties: { model_id: { type: "string", minLength: 1, maxLength: 200 } }, required: ["model_id"], additionalProperties: false },
  },
  { name: "companion_list_plugins", description: "List this member's connected plugin accounts and their attachment state.", inputSchema: empty },
  {
    name: "companion_attach_plugin",
    description: "Directly attach an already-connected plugin account to this Companion.",
    inputSchema: { type: "object", properties: { account_id: uuid }, required: ["account_id"], additionalProperties: false },
  },
  {
    name: "companion_detach_plugin",
    description: "Directly detach a plugin account from this Companion without revoking the member connection.",
    inputSchema: { type: "object", properties: { account_id: uuid }, required: ["account_id"], additionalProperties: false },
  },
  {
    name: "companion_request_plugin_connection",
    description: "Request human OAuth consent for a supported plugin connection.",
    inputSchema: { type: "object", properties: { provider: { type: "string", minLength: 1, maxLength: 80 }, reason: { type: "string", maxLength: 280 } }, required: ["provider"], additionalProperties: false },
  },
  { name: "companion_list_routines", description: "List this Companion's scheduled routines.", inputSchema: empty },
  {
    name: "companion_get_routine",
    description: "Read one routine and its durable status.",
    inputSchema: { type: "object", properties: { routine_id: uuid }, required: ["routine_id"], additionalProperties: false },
  },
  {
    name: "companion_list_routine_runs",
    description: "List recent durable runs for one routine.",
    inputSchema: { type: "object", properties: { routine_id: uuid, limit: { type: "integer", minimum: 1, maximum: 100 } }, required: ["routine_id"], additionalProperties: false },
  },
  {
    name: "companion_request_routine_change",
    description: "Request human approval to create, update, enable, disable, or delete a routine.",
    inputSchema: { type: "object", properties: { action: { enum: ["create", "update", "enable", "disable", "delete"] }, routine_id: uuid, draft: { type: "object" } }, required: ["action"], additionalProperties: false },
  },
  { name: "companion_list_triggers", description: "List this Companion's webhook triggers.", inputSchema: empty },
  {
    name: "companion_get_trigger",
    description: "Read one trigger and its registration status.",
    inputSchema: { type: "object", properties: { trigger_id: uuid }, required: ["trigger_id"], additionalProperties: false },
  },
  {
    name: "companion_list_trigger_runs",
    description: "List recent durable runs for one trigger.",
    inputSchema: { type: "object", properties: { trigger_id: uuid, limit: { type: "integer", minimum: 1, maximum: 100 } }, required: ["trigger_id"], additionalProperties: false },
  },
  {
    name: "companion_request_trigger_change",
    description: "Request human approval to create, update, enable, disable, delete, or rotate a trigger secret.",
    inputSchema: { type: "object", properties: { action: { enum: ["create", "update", "enable", "disable", "delete", "rotate_secret"] }, trigger_id: uuid, draft: { type: "object" } }, required: ["action"], additionalProperties: false },
  },
  { name: "companion_list_peers", description: "List other Companions this actor and the source Owner may operate, including grant state.", inputSchema: empty },
  {
    name: "companion_request_peer_access",
    description: "Request source-Owner approval for a persistent directed peer grant.",
    inputSchema: { type: "object", properties: { target_companion_id: uuid }, required: ["target_companion_id"], additionalProperties: false },
  },
  {
    name: "companion_send_message",
    description: "Asynchronously delegate a text question to an approved peer Companion.",
    inputSchema: { type: "object", properties: { target_companion_id: uuid, content: { type: "string", minLength: 1, maxLength: 16384 }, response_mode: { enum: ["relay", "notify"], default: "relay" } }, required: ["target_companion_id", "content"], additionalProperties: false },
  },
  { name: "companion_list_delegations", description: "List this Companion's outgoing delegations.", inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 100 }, cursor: uuid }, additionalProperties: false } },
  { name: "companion_get_delegation", description: "Read one outgoing delegation's status.", inputSchema: { type: "object", properties: { delegation_id: uuid }, required: ["delegation_id"], additionalProperties: false } },
  { name: "companion_cancel_delegation", description: "Cancel an outgoing delegation if its target turn remains cancellable.", inputSchema: { type: "object", properties: { delegation_id: uuid }, required: ["delegation_id"], additionalProperties: false } },
  { name: "companion_restart_pi", description: "Schedule a Pi recycle after the current turn settles. This never restarts the Box.", inputSchema: empty },
] as const;
