import type { Sql } from "postgres";

export type RuntimeDatabaseRoleFailure =
  | "profile_unavailable"
  | "login_mismatch"
  | "unsafe_role_attributes"
  | "role_membership"
  | "create_privilege"
  | "object_ownership"
  | "release_schema_incomplete"
  | "relation_privilege"
  | "required_function_ownership"
  | "unexpected_function_grant";

const RUNTIME_DATABASE_ROLE_MESSAGES = {
  profile_unavailable: "Runtime database role verification returned no complete profile",
  login_mismatch:
    "Runtime database connection authenticated as a different role than DATABASE_COMPANION_RUNTIME_URL",
  unsafe_role_attributes:
    "Runtime database role must be LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT",
  role_membership: "Runtime database role must not have any role memberships",
  create_privilege: "Runtime database role must not have database or public schema CREATE",
  object_ownership: "Runtime database role must not own database objects",
  release_schema_incomplete:
    "Runtime database is not ready for this release; apply its migrations and runtime grants before starting apps/runtime",
  relation_privilege: "Runtime database role must not have direct public relation privileges",
  required_function_ownership: "Runtime database role must not own runtime functions",
  unexpected_function_grant:
    "Runtime database role has an unexpected SECURITY DEFINER grant; reapply the runtime grants",
} satisfies Record<RuntimeDatabaseRoleFailure, string>;

const REQUIRED_PROTECTED_RELATION_COUNT = 19;

export class RuntimeDatabaseRoleError extends Error {
  readonly failure: RuntimeDatabaseRoleFailure;
  readonly stableCode: string;

  constructor(failure: RuntimeDatabaseRoleFailure) {
    super(RUNTIME_DATABASE_ROLE_MESSAGES[failure]);
    this.name = "RuntimeDatabaseRoleError";
    this.failure = failure;
    this.stableCode = `runtime_database_role_${failure}`;
  }
}

interface RuntimeRoleProfile {
  currentRole: string;
  canLogin: boolean;
  isSuperuser: boolean;
  bypassesRls: boolean;
  inheritsPrivileges: boolean;
  hasMemberships: boolean;
  hasDatabaseCreatePrivilege: boolean;
  hasPublicSchemaCreatePrivilege: boolean;
  ownsDatabaseOrSchema: boolean;
  ownsRelations: boolean;
  ownsFunctionsOrTypes: boolean;
  protectedRelationCount: number;
  hasPublicRelationPrivileges: boolean;
  requiredFunctionsReady: boolean;
  ownsRequiredFunctions: boolean;
  hasUnexpectedDefinerGrant: boolean;
}

const RUNTIME_ROLE_PROFILE_SQL = `
WITH runtime_role AS (
  SELECT oid, rolcanlogin, rolsuper, rolbypassrls, rolinherit
  FROM pg_catalog.pg_roles
  WHERE rolname = current_user
), required(signature) AS (
  VALUES
    ('public.companion_runtime_gate_status()'),
    ('public.companion_runtime_disable(bigint,text)'),
    ('public.companion_runtime_claim_work(text,integer,integer,bigint)'),
    ('public.companion_runtime_claim_work(text,integer,integer,bigint,integer)'),
    ('public.companion_runtime_claim_work(text,integer,integer,bigint,integer,integer)'),
    ('public.companion_runtime_renew_and_authorize(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)'),
    ('public.companion_runtime_renew_and_authorize_v2(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)'),
    ('public.companion_runtime_renew_and_authorize_v3(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)'),
    ('public.companion_runtime_recovery_metrics()'),
    ('public.companion_runtime_checkpoint(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,bigint,text,text,uuid,text,bigint,timestamp with time zone,integer,integer,integer)'),
    ('public.companion_runtime_observe_instance(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,bigint,bigint,text,public.companion_box_observed_state,public.companion_pi_observed_state,text,integer,bigint,integer,timestamp with time zone)'),
    ('public.companion_runtime_get_material(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)'),
    ('public.companion_runtime_get_turn_context(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)'),
    ('public.companion_runtime_get_skill_update_material(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)'),
    ('public.companion_runtime_commit_skill_update(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer,integer,jsonb,jsonb,text)'),
    ('public.companion_runtime_record_skill_update_error(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer,text,text)'),
    ('public.companion_runtime_get_config_catalog(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)'),
    ('public.companion_runtime_get_attempt_terminal_projection(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid)'),
    ('public.companion_runtime_project_event_batch(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,bigint,text,jsonb,bigint,timestamp with time zone,integer,integer,integer)'),
    ('public.companion_runtime_get_routine_material(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)'),
    ('public.companion_runtime_get_trigger_material(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)'),
    ('public.companion_runtime_prepare_routine_run(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,boolean)'),
    ('public.companion_runtime_project_event_batch_v2(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,bigint,text,jsonb,bigint,timestamp with time zone,integer,integer,integer)'),
    ('public.companion_runtime_register_duplicate_cleanups(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,text[])'),
    ('public.companion_runtime_checkpoint_duplicate_cleanup(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,text,bigint,public.companion_duplicate_cleanup_status,text)'),
    ('public.companion_runtime_mint_hub_token(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)'),
    ('public.companion_runtime_mint_mcp_broker_token(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)'),
    ('public.companion_runtime_mint_control_token(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)'),
    ('public.companion_runtime_record_material_snapshot(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,public.companion_client_surface,timestamp with time zone,text,text)'),
    ('public.companion_runtime_publish_material_snapshot(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,text)'),
    ('public.companion_runtime_settle(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,text,text,text,public.companion_runtime_error_action)'),
    ('public.companion_runtime_release_lease(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid)'),
    ('public.companion_runtime_defer_delete(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid)'),
    ('public.companion_runtime_image_request(text,text)'),
    ('public.companion_runtime_image_get(text)'),
    ('public.companion_runtime_image_claim(text,text,text)'),
    ('public.companion_runtime_image_authorize_publish(text,bigint,text)'),
    ('public.companion_runtime_image_mark_building_box(text,bigint,text)'),
    ('public.companion_runtime_image_clear_building_box(text,bigint,text)'),
    ('public.companion_runtime_image_mark_delete_intent(text,bigint,text)'),
    ('public.companion_runtime_image_mark_delete_operation(text,bigint,text,text)'),
    ('public.companion_runtime_image_record_ready(text,bigint,text,text)'),
    ('public.companion_runtime_image_record_failure(text,bigint,text,text)'),
    ('public.companion_runtime_authorize_desktop(uuid,uuid,text)'),
    ('public.companion_runtime_consume_desktop_request(text,bigint,integer)'),
    ('public.companion_runtime_record_attempt_outputs(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,jsonb,timestamp with time zone)'),
    ('public.companion_v3_runtime_claim_v4(text,public.companion_v3_lane,integer,integer)'),
    ('public.companion_v3_runtime_claim_warm_v4(text,public.companion_v3_lane,integer,integer)'),
    ('public.companion_v3_runtime_claim_warm_v5(text,public.companion_v3_lane,integer,integer)'),
    ('public.companion_v3_runtime_claim_preparation_v6(text,integer,integer)'),
    ('public.companion_v3_runtime_begin_admission_v5(uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,text,bigint,integer)'),
    ('public.companion_v3_runtime_sweep_deadlines(public.companion_v3_lane,integer)'),
    ('public.companion_v3_runtime_sweep_preparation_deadlines(integer)'),
    ('public.companion_v3_runtime_claim_lifecycle(text,integer,integer)'),
    ('public.companion_v3_runtime_checkpoint_lifecycle(uuid,uuid,uuid,bigint,bigint,public.companion_v3_lifecycle_state,public.companion_v3_lifecycle_state,text,integer)'),
    ('public.companion_v3_runtime_defer_lifecycle(uuid,uuid,uuid,bigint,bigint,integer,text,text,integer)'),
    ('public.companion_v3_runtime_finalize_delete(uuid,uuid,uuid,bigint,bigint,integer)'),
    ('public.companion_v3_runtime_checkpoint_preparation_v6(uuid,uuid,uuid,bigint,bigint,text,text,text,text,integer,bigint,integer,text,timestamp with time zone,integer)'),
    ('public.companion_v3_runtime_checkpoint_pi_recycle(uuid,uuid,uuid,bigint,bigint,text,text,integer)'),
    ('public.companion_v3_runtime_reconcile_pi_recycle_invocation(uuid,uuid,uuid,bigint,bigint,text,text,integer)'),
    ('public.companion_v3_runtime_defer_preparation(uuid,uuid,uuid,bigint,bigint,integer,text,text,integer)'),
    ('public.companion_v3_runtime_reauthorize_preparation(uuid,uuid,uuid,bigint,bigint,text,integer,integer)'),
    ('public.companion_v3_runtime_mint_preparation_credentials(uuid,uuid,uuid,bigint,bigint,text,integer,integer)'),
    ('public.companion_v3_runtime_complete_v5(uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,text,text,text,public.companion_runtime_error_action,integer)'),
    ('public.companion_v3_runtime_authorize_warm_turn_v5(uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,integer)'),
    ('public.companion_v3_runtime_record_native_admission_v5(uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,text,uuid,bigint,integer)'),
    ('public.companion_v3_runtime_project_native_page_v5(uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,bigint,jsonb,jsonb,boolean,boolean,text,integer)'),
    ('public.companion_v3_runtime_measurement_facts(timestamp with time zone,timestamp with time zone,integer)')
), required_functions AS (
  SELECT signature, pg_catalog.to_regprocedure(signature) AS oid
  FROM required
), public_relations AS (
  SELECT relation.oid, relation.relkind
  FROM pg_catalog.pg_class relation
  JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = 'public'
    AND relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
), protected_relations AS (
  SELECT relation.oid
  FROM pg_catalog.pg_class relation
  JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = 'public'
    AND relation.relkind IN ('r', 'p')
    AND relation.relname = ANY (ARRAY[
      'companion_runtime_control',
      'companion_runtime_instances',
      'companion_turns',
      'companion_turn_attempts',
      'companion_operations',
      'companion_decision_deliveries',
      'companion_runtime_leases',
      'companion_runtime_duplicate_cleanups',
      'companion_runtime_event_projections',
      'companion_runtime_desktop_requests',
      'companion_main_pi_compactions',
      'companion_routine_context_substrates',
      'companion_mcp_broker_tokens',
      'companion_control_tokens',
      'companion_message_attachments',
      'companion_v3_instances',
      'companion_v3_turns',
      'companion_v3_lane_leases',
      'companion_v3_lifecycle_requests'
    ]::text[])
)
SELECT
  current_user::text AS "currentRole",
  role.rolcanlogin AS "canLogin",
  role.rolsuper AS "isSuperuser",
  role.rolbypassrls AS "bypassesRls",
  role.rolinherit AS "inheritsPrivileges",
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members membership
    WHERE membership.member = role.oid OR membership.roleid = role.oid
  ) AS "hasMemberships",
  pg_catalog.has_database_privilege(role.oid, current_database(), 'CREATE')
    AS "hasDatabaseCreatePrivilege",
  pg_catalog.has_schema_privilege(role.oid, 'public', 'CREATE')
    AS "hasPublicSchemaCreatePrivilege",
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_database database
    WHERE database.datname = current_database() AND database.datdba = role.oid
    UNION ALL
    SELECT 1 FROM pg_catalog.pg_namespace namespace WHERE namespace.nspowner = role.oid
  ) AS "ownsDatabaseOrSchema",
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_class relation WHERE relation.relowner = role.oid
  ) AS "ownsRelations",
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc procedure WHERE procedure.proowner = role.oid
    UNION ALL
    SELECT 1 FROM pg_catalog.pg_type type WHERE type.typowner = role.oid
  ) AS "ownsFunctionsOrTypes",
  (SELECT count(*)::int FROM protected_relations) AS "protectedRelationCount",
  EXISTS (
    SELECT 1
    FROM public_relations relation
    WHERE CASE relation.relkind
      WHEN 'S' THEN pg_catalog.has_sequence_privilege(role.oid, relation.oid, 'USAGE,SELECT,UPDATE')
      ELSE pg_catalog.has_table_privilege(
        role.oid,
        relation.oid,
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
      )
    END
  ) AS "hasPublicRelationPrivileges",
  NOT EXISTS (
    SELECT 1
    FROM required_functions function
    LEFT JOIN pg_catalog.pg_proc procedure ON procedure.oid = function.oid
    WHERE function.oid IS NULL
      OR procedure.prosecdef IS NOT TRUE
      OR NOT pg_catalog.has_function_privilege(role.oid, function.oid, 'EXECUTE')
  ) AS "requiredFunctionsReady",
  EXISTS (
    SELECT 1
    FROM required_functions function
    JOIN pg_catalog.pg_proc procedure ON procedure.oid = function.oid
    WHERE procedure.proowner = role.oid
  ) AS "ownsRequiredFunctions",
  EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc procedure
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = 'public'
      AND procedure.prosecdef
      AND pg_catalog.has_function_privilege(role.oid, procedure.oid, 'EXECUTE')
      AND procedure.oid <> ALL (
        SELECT function.oid FROM required_functions function WHERE function.oid IS NOT NULL
      )
  ) AS "hasUnexpectedDefinerGrant"
FROM runtime_role role
`;

export async function verifyRuntimeDatabaseRole(
  sql: Pick<Sql, "unsafe">,
  expectedRole: string,
): Promise<void> {
  const rows = await sql.unsafe<RuntimeRoleProfile[]>(RUNTIME_ROLE_PROFILE_SQL);
  const profile = rows[0];
  if (rows.length !== 1 || !profile) {
    throw new RuntimeDatabaseRoleError("profile_unavailable");
  }
  if (profile.currentRole !== expectedRole) {
    throw new RuntimeDatabaseRoleError("login_mismatch");
  }
  if (
    profile.canLogin !== true
    || profile.isSuperuser !== false
    || profile.bypassesRls !== false
    || profile.inheritsPrivileges !== false
  ) throw new RuntimeDatabaseRoleError("unsafe_role_attributes");
  if (profile.hasMemberships !== false) {
    throw new RuntimeDatabaseRoleError("role_membership");
  }
  if (
    profile.hasDatabaseCreatePrivilege !== false
    || profile.hasPublicSchemaCreatePrivilege !== false
  ) throw new RuntimeDatabaseRoleError("create_privilege");
  if (
    profile.ownsDatabaseOrSchema !== false
    || profile.ownsRelations !== false
    || profile.ownsFunctionsOrTypes !== false
  ) throw new RuntimeDatabaseRoleError("object_ownership");
  if (
    profile.protectedRelationCount !== REQUIRED_PROTECTED_RELATION_COUNT
    || profile.requiredFunctionsReady !== true
  ) {
    throw new RuntimeDatabaseRoleError("release_schema_incomplete");
  }
  if (profile.hasPublicRelationPrivileges !== false) {
    throw new RuntimeDatabaseRoleError("relation_privilege");
  }
  if (profile.ownsRequiredFunctions !== false) {
    throw new RuntimeDatabaseRoleError("required_function_ownership");
  }
  if (profile.hasUnexpectedDefinerGrant !== false) {
    throw new RuntimeDatabaseRoleError("unexpected_function_grant");
  }
}
