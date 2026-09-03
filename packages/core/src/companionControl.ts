import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  companionControlJsonObjectSchema,
  companionControlRequestSchema,
  companionDelegationSchema,
  companionPeerGrantSchema,
  companionTurnSchema,
  type CompanionControlJsonValue,
  type CompanionControlRequest,
  type CompanionControlRequestKind,
  type CompanionDelegation,
  type CompanionDelegationResponseMode,
  type CompanionPeerGrant,
  type CompanionTurn,
} from "@companion/contracts";
import { db, schema, type Db } from "@companion/db";
import type { ActorContext } from "./services";
import { listSkills } from "./services";
import {
  listCompanionPlugins,
  resolveCompanionSelectedMcpAccountIds,
  resolveCompanionSelectedSkillIds,
} from "./companions";
import { getCompanionV2, updateCompanionV2 } from "./companionRuntimeApi";
import { resolvePreTenantCompanionControlToken } from "./preTenant";

const CONTROL_TOKEN = /^cmp_ctl_[0-9a-f]{48}$/;

export class CompanionControlAuthorizationError extends Error {
  constructor() {
    super("Companion control authorization is unavailable");
    this.name = "CompanionControlAuthorizationError";
  }
}

export interface CompanionControlAuthorization {
  orgId: string;
  companionId: string;
  actorId: string;
  turnId: string;
  attemptId: string;
}

export async function resolveCompanionControlAuthorization(
  rawToken: string,
  database: Db = db,
): Promise<CompanionControlAuthorization | null> {
  if (!CONTROL_TOKEN.test(rawToken)) return null;
  const tokenHash = createHash("sha256").update(rawToken, "utf8").digest("hex");
  const row = await resolvePreTenantCompanionControlToken(database, tokenHash);
  return row ? {
    orgId: row.org_id,
    companionId: row.companion_id,
    actorId: row.actor_id,
    turnId: row.turn_id,
    attemptId: row.attempt_id,
  } : null;
}

export async function companionControlActor(
  authorization: CompanionControlAuthorization,
  database: Db,
): Promise<ActorContext> {
  const [row] = await database
    .select({
      id: schema.user.id,
      email: schema.user.email,
      userName: schema.user.name,
      profileName: schema.profiles.name,
    })
    .from(schema.user)
    .leftJoin(schema.profiles, eq(schema.profiles.id, schema.user.id))
    .where(eq(schema.user.id, authorization.actorId))
    .limit(1);
  if (!row) throw new CompanionControlAuthorizationError();
  return { id: row.id, email: row.email, name: row.profileName ?? row.userName ?? row.email };
}

export async function registerCompanionControlInvocation(input: {
  authorization: CompanionControlAuthorization;
  id: string;
  requestKey: string;
  requestDigest: string;
  database: Db;
}): Promise<{ replayed: boolean; result: Record<string, CompanionControlJsonValue> | null }> {
  const a = input.authorization;
  const result = await input.database.execute<{
    replayed: boolean;
    result: Record<string, CompanionControlJsonValue> | null;
  }>(sql`
    select * from public.companion_api_register_control_invocation(
      ${a.orgId}::uuid,${a.companionId}::uuid,${input.id}::uuid,${a.turnId}::uuid,
      ${a.attemptId}::uuid,${input.requestKey}::text,${input.requestDigest}::text
    )
  `);
  const [row] = rows<{
    replayed: boolean;
    result: Record<string, CompanionControlJsonValue> | null;
  }>(result);
  if (!row) throw new Error("failed to register Companion control invocation");
  return row;
}

export async function finishCompanionControlInvocation(input: {
  authorization: CompanionControlAuthorization;
  requestKey: string;
  requestDigest: string;
  result: Record<string, CompanionControlJsonValue>;
  database: Db;
}): Promise<Record<string, CompanionControlJsonValue>> {
  const a = input.authorization;
  const query = await input.database.execute<{
    result: Record<string, CompanionControlJsonValue>;
  }>(sql`
    select public.companion_api_finish_control_invocation(
      ${a.orgId}::uuid,${a.companionId}::uuid,${a.attemptId}::uuid,
      ${input.requestKey}::text,${input.requestDigest}::text,
      ${JSON.stringify(input.result)}::jsonb
    ) as result
  `);
  const [row] = rows<{ result: Record<string, CompanionControlJsonValue> }>(query);
  if (!row) throw new Error("failed to finish Companion control invocation");
  return companionControlJsonObjectSchema.parse(row.result);
}

interface ControlRequestRow {
  [key: string]: CompanionControlJsonValue | Date;
  id: string;
  companion_id: string;
  kind: CompanionControlRequestKind;
  action: string;
  summary: string;
  payload: Record<string, CompanionControlJsonValue>;
  status: CompanionControlRequest["status"];
  requested_by_id: string;
  decided_by_id: string | null;
  result: Record<string, CompanionControlJsonValue> | null;
  error_code: string | null;
  error_message: string | null;
  expires_at: Date | string;
  decided_at: Date | string | null;
  applied_at: Date | string | null;
  continuation_turn_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function optionalIso(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}

function rows<T>(result: Iterable<T>): T[] {
  return Array.from(result);
}

function projectControlRequest(row: ControlRequestRow): CompanionControlRequest {
  return companionControlRequestSchema.parse({
    id: row.id,
    companion_id: row.companion_id,
    kind: row.kind,
    action: row.action,
    summary: row.summary,
    payload: row.payload,
    status: row.status,
    requested_by_id: row.requested_by_id,
    decided_by_id: row.decided_by_id,
    result: row.result,
    error_code: row.error_code,
    error_message: row.error_message,
    expires_at: iso(row.expires_at),
    decided_at: optionalIso(row.decided_at),
    applied_at: optionalIso(row.applied_at),
    continuation_turn_id: row.continuation_turn_id,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  });
}

export async function createCompanionControlRequest(input: {
  authorization: CompanionControlAuthorization;
  id: string;
  kind: CompanionControlRequestKind;
  action: string;
  summary: string;
  payload: Record<string, CompanionControlJsonValue>;
  requestKey: string;
  requestDigest: string;
  requiredAccess: "owner" | "editor";
  database: Db;
}): Promise<CompanionControlRequest> {
  const a = input.authorization;
  const result = await input.database.execute<ControlRequestRow>(sql`
    select * from public.companion_api_create_control_request(
      ${a.orgId}::uuid,${a.companionId}::uuid,${input.id}::uuid,${a.turnId}::uuid,
      ${a.attemptId}::uuid,${input.kind}::companion_control_request_kind,${input.action}::text,
      ${input.summary}::text,${JSON.stringify(input.payload)}::jsonb,${input.requestKey}::text,
      ${input.requestDigest}::text,${input.requiredAccess}::text
    )
  `);
  const [row] = rows<ControlRequestRow>(result);
  if (!row) throw new Error("failed to create Companion control request");
  return projectControlRequest(row);
}

export async function getCompanionControlRequest(input: {
  orgId: string;
  companionId: string;
  requestId: string;
  database: Db;
}): Promise<CompanionControlRequest | null> {
  const result = await input.database.execute<ControlRequestRow>(sql`
    select * from public.companion_api_get_control_request(
      ${input.orgId}::uuid,${input.companionId}::uuid,${input.requestId}::uuid
    )
  `);
  const [row] = rows<ControlRequestRow>(result);
  return row ? projectControlRequest(row) : null;
}

export async function decideCompanionControlRequest(input: {
  orgId: string;
  companionId: string;
  requestId: string;
  action: "allow" | "deny";
  database: Db;
}): Promise<CompanionControlRequest> {
  const result = await input.database.execute<ControlRequestRow>(sql`
    select * from public.companion_api_decide_control_request(
      ${input.orgId}::uuid,${input.companionId}::uuid,${input.requestId}::uuid,${input.action}::text
    )
  `);
  const [row] = rows<ControlRequestRow>(result);
  if (!row) throw new Error("failed to decide Companion control request");
  return projectControlRequest(row);
}

export async function finishCompanionControlRequest(input: {
  orgId: string;
  companionId: string;
  requestId: string;
  result?: Record<string, CompanionControlJsonValue> | null;
  error?: { code: string; message: string } | null;
  database: Db;
}): Promise<CompanionControlRequest> {
  const result = await input.database.execute<ControlRequestRow>(sql`
    select * from public.companion_api_finish_control_request(
      ${input.orgId}::uuid,${input.companionId}::uuid,${input.requestId}::uuid,
      ${input.result ? JSON.stringify(input.result) : null}::jsonb,
      ${input.error?.code ?? null}::text,${input.error?.message ?? null}::text
    )
  `);
  const [row] = rows<ControlRequestRow>(result);
  if (!row) throw new Error("failed to finish Companion control request");
  return projectControlRequest(row);
}

export async function enqueueCompanionControlContinuation(input: {
  orgId: string;
  companionId: string;
  requestId: string;
  content: string;
  database: Db;
}): Promise<CompanionTurn> {
  const result = await input.database.execute<{ turn: CompanionControlJsonValue }>(sql`
    select public.companion_api_enqueue_control_continuation(
      ${input.orgId}::uuid,${input.companionId}::uuid,${input.requestId}::uuid,${input.content}::text
    ) as turn
  `);
  const [row] = rows<{ turn: CompanionControlJsonValue }>(result);
  if (!row) throw new Error("failed to enqueue Companion control continuation");
  return companionTurnSchema.parse(row.turn);
}

export async function scheduleCompanionPiRestart(input: {
  authorization: CompanionControlAuthorization;
  id: string;
  database: Db;
}): Promise<{ id: string; status: "pending" | "enqueued" | "cancelled"; source_turn_id: string; operation_id: string | null }> {
  const a = input.authorization;
  const result = await input.database.execute<{
    id: string;
    status: "pending" | "enqueued" | "cancelled";
    source_turn_id: string;
    operation_id: string | null;
  }>(sql`
    select * from public.companion_api_schedule_pi_restart(
      ${a.orgId}::uuid,${a.companionId}::uuid,${input.id}::uuid,${a.turnId}::uuid,${a.attemptId}::uuid
    )
  `);
  const [row] = rows<{
    id: string;
    status: "pending" | "enqueued" | "cancelled";
    source_turn_id: string;
    operation_id: string | null;
  }>(result);
  if (!row) throw new Error("failed to schedule Companion Pi restart");
  return row;
}

export async function listCompanionControlSkills(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  database: Db;
}) {
  const [companion, skills] = await Promise.all([
    getCompanionV2(input),
    listSkills({ actor: input.actor, orgId: input.orgId, library: "accessible", database: input.database }),
  ]);
  const selected = new Set(companion.selected_skill_ids);
  return skills
    .filter((skill) => !skill.archived && skill.validation === "valid" && skill.current_version)
    .map((skill) => ({
      id: skill.id,
      slug: skill.slug,
      description: skill.description,
      version: skill.current_version,
      selected: selected.has(skill.id),
    }));
}

export async function updateCompanionControlSkills(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  add: string[];
  remove: string[];
  database: Db;
}) {
  const current = await getCompanionV2(input);
  const desired = [...new Set([
    ...current.selected_skill_ids.filter((id) => !input.remove.includes(id)),
    ...input.add,
  ])];
  const selected = await resolveCompanionSelectedSkillIds({
    actor: input.actor,
    orgId: input.orgId,
    selectedSkillIds: desired,
    previouslySelectedSkillIds: current.selected_skill_ids,
    database: input.database,
  });
  return await updateCompanionV2({ ...input, patch: { selected_skill_ids: selected } });
}

export async function listCompanionControlPlugins(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  database: Db;
}) {
  const [companion, accounts] = await Promise.all([
    getCompanionV2(input),
    listCompanionPlugins(input),
  ]);
  const selected = new Set(companion.selected_mcp_account_ids);
  return accounts.map((account) => ({ ...account, selected: selected.has(account.id) }));
}

export async function updateCompanionControlPlugin(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  accountId: string;
  selected: boolean;
  database: Db;
}) {
  const current = await getCompanionV2(input);
  const ids = input.selected
    ? [...new Set([...current.selected_mcp_account_ids, input.accountId])]
    : current.selected_mcp_account_ids.filter((id) => id !== input.accountId);
  const selected = await resolveCompanionSelectedMcpAccountIds({
    actor: input.actor,
    orgId: input.orgId,
    selectedMcpAccountIds: ids,
    previouslySelectedMcpAccountIds: current.selected_mcp_account_ids,
    database: input.database,
  });
  return await updateCompanionV2({ ...input, patch: { selected_mcp_account_ids: selected } });
}

export interface CompanionControlPeer {
  [key: string]: string | number | boolean | null;
  companion_id: string;
  name: string;
  access: "owner" | "editor";
  grant_id: string | null;
  grant_active: boolean;
  runtime_state: string;
  queued_count: number;
}

export async function listCompanionControlPeers(input: {
  orgId: string;
  companionId: string;
  database: Db;
}): Promise<CompanionControlPeer[]> {
  const result = await input.database.execute<CompanionControlPeer & { queued_count: number | string }>(sql`
    select * from public.companion_api_list_peers(${input.orgId}::uuid,${input.companionId}::uuid)
  `);
  return rows<CompanionControlPeer & { queued_count: number | string }>(result).map((row) => ({
    ...row,
    queued_count: Number(row.queued_count),
  }));
}

interface PeerGrantRow {
  [key: string]: string | Date | null;
  id: string;
  source_companion_id: string;
  target_companion_id: string;
  granted_by_id: string;
  created_at: Date | string;
  revoked_at: Date | string | null;
}

export async function grantCompanionPeerAccess(input: {
  orgId: string;
  sourceCompanionId: string;
  targetCompanionId: string;
  targetName: string;
  database: Db;
}): Promise<CompanionPeerGrant> {
  const result = await input.database.execute<PeerGrantRow>(sql`
    select * from public.companion_api_grant_peer_access(
      ${input.orgId}::uuid,${input.sourceCompanionId}::uuid,${input.targetCompanionId}::uuid
    )
  `);
  const [row] = rows<PeerGrantRow>(result);
  if (!row) throw new Error("failed to grant Companion peer access");
  return companionPeerGrantSchema.parse({
    id: row.id,
    source_companion_id: row.source_companion_id,
    target_companion_id: row.target_companion_id,
    target_name: input.targetName,
    granted_by_id: row.granted_by_id,
    created_at: iso(row.created_at),
    revoked_at: optionalIso(row.revoked_at),
  });
}

export async function revokeCompanionPeerAccess(input: {
  orgId: string;
  sourceCompanionId: string;
  targetCompanionId: string;
  database: Db;
}): Promise<boolean> {
  const result = await input.database.execute<{ revoked: boolean }>(sql`
    select public.companion_api_revoke_peer_access(
      ${input.orgId}::uuid,${input.sourceCompanionId}::uuid,${input.targetCompanionId}::uuid
    ) as revoked
  `);
  return rows<{ revoked: boolean }>(result)[0]?.revoked === true;
}

interface DelegationRow {
  [key: string]: string | number | Date | null;
  id: string;
  source_companion_id: string | null;
  source_companion_name: string;
  target_companion_id: string | null;
  target_companion_name: string;
  source_turn_id: string;
  target_turn_id: string;
  root_turn_id: string;
  parent_delegation_id: string | null;
  depth: number;
  response_mode: CompanionDelegationResponseMode;
  status: CompanionDelegation["status"];
  delivery_status: CompanionDelegation["delivery_status"];
  created_at: Date | string;
  settled_at: Date | string | null;
}

function projectDelegation(row: DelegationRow): CompanionDelegation {
  return companionDelegationSchema.parse({
    id: row.id,
    source_companion_id: row.source_companion_id,
    source_companion_name: row.source_companion_name,
    target_companion_id: row.target_companion_id,
    target_companion_name: row.target_companion_name,
    source_turn_id: row.source_turn_id,
    target_turn_id: row.target_turn_id,
    root_turn_id: row.root_turn_id,
    parent_delegation_id: row.parent_delegation_id,
    depth: row.depth,
    response_mode: row.response_mode,
    status: row.status,
    delivery_status: row.delivery_status,
    created_at: iso(row.created_at),
    settled_at: optionalIso(row.settled_at),
  });
}

export async function enqueueCompanionDelegation(input: {
  authorization: CompanionControlAuthorization;
  targetCompanionId: string;
  targetClientMessageId: string;
  content: string;
  id: string;
  responseMode: CompanionDelegationResponseMode;
  requestKey: string;
  requestDigest: string;
  database: Db;
}): Promise<{ delegation: CompanionDelegation; targetTurn: CompanionTurn }> {
  const a = input.authorization;
  const result = await input.database.execute<{
    delegation: DelegationRow;
    target_turn: CompanionControlJsonValue;
  }>(sql`
    select * from public.companion_api_enqueue_delegation(
      ${a.orgId}::uuid,${a.companionId}::uuid,${input.targetCompanionId}::uuid,
      ${a.turnId}::uuid,${a.attemptId}::uuid,${input.targetClientMessageId}::uuid,
      ${input.content}::text,${input.id}::uuid,
      ${input.responseMode}::companion_routine_surface_mode,${input.requestKey}::text,
      ${input.requestDigest}::text
    )
  `);
  const [row] = rows<{ delegation: DelegationRow; target_turn: CompanionControlJsonValue }>(result);
  if (!row) throw new Error("failed to enqueue Companion delegation");
  return {
    delegation: projectDelegation(row.delegation),
    targetTurn: companionTurnSchema.parse(row.target_turn),
  };
}

export async function listCompanionDelegations(input: {
  orgId: string;
  companionId: string;
  limit?: number;
  cursor?: string;
  database: Db;
}): Promise<CompanionDelegation[]> {
  const result = await input.database.execute<DelegationRow>(sql`
    select * from public.companion_api_list_delegations(
      ${input.orgId}::uuid,${input.companionId}::uuid,${input.limit ?? 50}::integer,
      ${input.cursor ?? null}::uuid
    )
  `);
  return rows<DelegationRow>(result).map(projectDelegation);
}

export async function getCompanionDelegation(input: {
  orgId: string;
  companionId: string;
  delegationId: string;
  database: Db;
}): Promise<CompanionDelegation | null> {
  const result = await input.database.execute<DelegationRow>(sql`
    select * from public.companion_api_get_delegation(
      ${input.orgId}::uuid,${input.companionId}::uuid,${input.delegationId}::uuid
    )
  `);
  const [row] = rows<DelegationRow>(result);
  return row ? projectDelegation(row) : null;
}

export async function cancelCompanionDelegationTurn(input: {
  orgId: string;
  sourceCompanionId: string;
  delegationId: string;
  database: Db;
}): Promise<CompanionTurn> {
  const result = await input.database.execute<{ turn: unknown }>(sql`
    select * from public.companion_v3_api_cancel_delegation_turn(
      ${input.orgId}::uuid,${input.sourceCompanionId}::uuid,${input.delegationId}::uuid
    )
  `);
  const [row] = rows<{ turn: unknown }>(result);
  if (!row) throw new Error("failed to cancel Companion delegation Turn");
  return companionTurnSchema.parse(row.turn);
}

export function deterministicControlUuid(digest: string, namespace: string): string {
  const hex = createHash("sha256").update(`${namespace}:${digest}`, "utf8").digest("hex").slice(0, 32);
  const chars = hex.split("");
  chars[12] = "5";
  chars[16] = ((Number.parseInt(chars[16]!, 16) & 0x3) | 0x8).toString(16);
  const value = chars.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
