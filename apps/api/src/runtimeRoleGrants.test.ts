import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { resolveRuntimeRoleGrantsFile } from "./migrate";

describe("Skills Hub runtime-role grants", () => {
  it("grants skill maintenance capabilities without removed execution capabilities", async () => {
    const sql = await readFile(await resolveRuntimeRoleGrantsFile(), "utf8");
    expect(sql).toContain("companion_claim_skill_database_object_deletions");
    expect(sql).toContain("companion_claim_github_sync_destinations");
    expect(sql).toContain("companion_secret_usage_count");
    expect(sql).not.toMatch(/skill_run|project_workspace|project_worker|sandbox_usage|model_provider/i);
  });

  it("keeps Runtime v2 state private and grants only its fenced executor functions", async () => {
    const sql = await readFile(await resolveRuntimeRoleGrantsFile(), "utf8");
    for (const table of [
      "companion_runtime_control",
      "companion_runtime_instances",
      "companion_turns",
      "companion_turn_attempts",
      "companion_operations",
      "companion_decision_deliveries",
      "companion_runtime_leases",
      "companion_mcp_broker_tokens",
      "companion_routines",
    ]) {
      expect(sql).toContain(`'${table}'`);
    }
    expect(sql).toContain("NOT (table_class.relname::text = ANY(private_runtime_table_names))");
    expect(sql).toContain("REVOKE ALL PRIVILEGES ON TABLE %s FROM %I");
    expect(sql).toContain("REVOKE ALL PRIVILEGES ON SEQUENCE %s FROM %I");

    expect(sql).toContain("companion_runtime_functions regprocedure[] := ARRAY[]::regprocedure[]");
    expect(sql).toContain(
      "IF pg_catalog.to_regprocedure('public.companion_runtime_gate_status()') IS NOT NULL THEN",
    );
    const runtimeFunctions = sql.slice(
      sql.indexOf("companion_runtime_functions := ARRAY["),
      sql.indexOf("owner_only_runtime_functions := ARRAY["),
    );
    for (const signature of [
      "companion_runtime_gate_status()",
      "companion_runtime_disable(bigint,text)",
      "companion_runtime_claim_work(text,integer,integer,bigint)",
      "companion_runtime_renew_and_authorize(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)",
      "companion_runtime_checkpoint(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,bigint,text,text,uuid,text,bigint,timestamp with time zone,integer,integer,integer)",
      "companion_runtime_observe_instance(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,bigint,bigint,text,public.companion_box_observed_state,public.companion_pi_observed_state,text,integer,bigint,integer,timestamp with time zone)",
      "companion_runtime_settle(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,text,text,text,public.companion_runtime_error_action)",
      "companion_runtime_release_lease(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid)",
    ]) {
      expect(runtimeFunctions).toContain(signature);
    }
    expect(runtimeFunctions).not.toContain("companion_runtime_enable");
    expect(sql).toContain(
      "companion_runtime_renew_and_authorize_v2(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)",
    );
    expect(sql).toContain("'public.companion_runtime_enable(bigint,text)'::regprocedure");
    for (const helper of [
      "companion_runtime_create_lease_row()",
      "companion_runtime_assert_v2_mutation()",
      "companion_runtime_require_v2_mutation()",
      "companion_runtime_require_instance_at_commit()",
      "companion_runtime_assign_turn_sequence()",
      "companion_runtime_assign_operation_intent()",
      "companion_runtime_assign_attempt_snapshot()",
      "companion_runtime_reject_actor_change()",
      "companion_runtime_reject_turn_surface_change()",
      "companion_runtime_reject_attempt_snapshot_change()",
      "companion_runtime_reject_operation_snapshot_change()",
      "companion_runtime_reject_responder_change()",
      "companion_runtime_reset_material_on_pi_change()",
      "companion_runtime_reset_settings_material_snapshot()",
      "companion_runtime_repair_legacy_material_work(bigint)",
      "companion_runtime_prepare_queued_turn_material(bigint)",
      "companion_runtime_claim_work_without_material_guard(text,integer,integer,bigint)",
      "companion_runtime_close_attempt_decisions(uuid,uuid,uuid,text,text,public.companion_runtime_error_action,uuid)",
    ]) {
      expect(sql).toContain(`'public.${helper}'::regprocedure`);
    }
    expect(sql).toContain("owner_only_runtime_functions || internal_runtime_functions");
    expect(sql).toContain(
      "companion_runtime_get_attempt_terminal_projection(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid)",
    );
    expect(sql).toContain(
      "companion_runtime_get_config_catalog(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)",
    );
    expect(sql).toContain(
      "companion_runtime_mint_hub_token(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)",
    );
    expect(sql).toContain(
      "companion_runtime_mint_mcp_broker_token(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)",
    );
    expect(sql).toContain("companion_resolve_mcp_broker_token(text)");
    expect(sql).toContain(
      "companion_runtime_record_material_snapshot(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,public.companion_client_surface,timestamp with time zone,text,text)",
    );
    expect(sql).toContain(
      "companion_runtime_publish_material_snapshot(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,text)",
    );
    expect(sql).toContain(
      "companion_runtime_claim_work(text,integer,integer,bigint,integer)",
    );
    expect(sql).toContain(
      "companion_runtime_claim_work(text,integer,integer,bigint,integer,integer)",
    );
    expect(sql).toContain(
      "companion_runtime_defer_delete(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid)",
    );
    expect(sql).toContain(
      "'public.companion_runtime_claim_work_without_delete_resume_guard(text,integer,integer,bigint,integer)'::regprocedure",
    );
    expect(sql).toContain(
      "'public.companion_runtime_claim_work_material_v1(text,integer,integer,bigint,integer,integer)'::regprocedure",
    );
    expect(sql).toContain("pg_catalog.aclexplode(");
    expect(sql).toContain("acl.grantee <> protected_proc.proowner");
    expect(sql).toContain("defaults.defaclobjtype = 'f'");
    expect(sql).toContain("defaults.defaclnamespace IN (0, 'public'::regnamespace)");
    expect(sql).toContain("ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC");
    expect(sql).toContain("ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM %I");
    expect(sql).toContain("REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC");
    expect(sql).toContain("REVOKE EXECUTE ON FUNCTIONS FROM %I");
    expect(sql).toContain("FROM pg_catalog.pg_auth_members membership");
    expect(sql).toContain("FROM unnest(active_roles) AS configured_roles(role_name)");
    expect(sql).toContain("active companion database role % must have no role memberships");
    expect(sql).toContain("REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC");
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION %s TO %I");
  });

  it("gives only the API role the Runtime v2 intent and projection capabilities", async () => {
    const sql = await readFile(await resolveRuntimeRoleGrantsFile(), "utf8");
    expect(sql).toContain("companion_api_functions regprocedure[] := ARRAY[]::regprocedure[]");
    const apiBlock = sql.slice(
      sql.indexOf("companion_api_functions := ARRAY["),
      sql.indexOf("-- A migration owner can carry arbitrary", sql.indexOf("companion_api_functions := ARRAY[")),
    );
    expect(sql).toContain("companion_api_create_function regprocedure");
    expect(sql).toContain(
      "companion_api_create_companion(uuid,text,text,text,text,jsonb,boolean,jsonb,uuid,smallint,smallint,smallint,smallint)",
    );
    expect(sql).toContain(
      "companion_api_create_companion(uuid,text,text,text,text,jsonb,boolean,jsonb,uuid)",
    );
    expect(apiBlock).toContain("companion_api_create_function,");
    for (const signature of [
      "companion_api_update_companion(uuid,uuid,jsonb)",
      "companion_api_set_initial_provider(uuid,uuid,text,text)",
      "companion_api_set_workspace_access(uuid,uuid,public.companion_share_role)",
      "companion_api_update_member_state(uuid,uuid,boolean,boolean,boolean)",
      "companion_api_update_member_state_v2(uuid,uuid,boolean,boolean,boolean,boolean)",
      "companion_api_list_sections(uuid)",
      "companion_api_create_section(uuid,text)",
      "companion_api_update_section(uuid,uuid,text)",
      "companion_api_delete_section(uuid,uuid)",
      "companion_api_reorder_sections(uuid,jsonb)",
      "companion_api_assign_section(uuid,uuid,uuid)",
      "companion_api_mark_thread_read(uuid,uuid)",
      "companion_api_enqueue_turn(uuid,uuid,uuid,text,public.companion_client_surface)",
      "companion_api_read_runtime(uuid,uuid)",
      "companion_api_list_runtime(uuid)",
      "companion_api_read_thread(uuid,uuid)",
      "companion_api_sync_thread(uuid,uuid)",
      "companion_api_enqueue_operation(uuid,uuid,uuid,public.companion_operation_kind,public.companion_client_surface)",
      "companion_api_cancel_turn(uuid,uuid,uuid)",
      "companion_api_answer_decision(uuid,uuid,text,text,text)",
      "companion_api_answer_config_decision(uuid,uuid,text,text)",
      "companion_api_answer_routine_decision(uuid,uuid,text,text,uuid,timestamp with time zone)",
      "companion_api_get_decision(uuid,uuid,text)",
      "companion_api_bump_skill_revision(uuid,uuid)",
      "companion_api_list_routines(uuid,uuid)",
      "companion_api_create_routine(uuid,uuid,uuid,text,text,text,text,boolean,timestamp with time zone)",
      "companion_api_update_routine(uuid,uuid,uuid,text,text,text,text,boolean,timestamp with time zone)",
      "companion_api_delete_routine(uuid,uuid,uuid)",
      "companion_api_enqueue_turn(uuid,uuid,uuid,text,public.companion_client_surface,jsonb,uuid,text)",
    ]) {
      expect(apiBlock).toContain(`'public.${signature}'::regprocedure`);
    }
    for (const helper of [
      "companion_api_actor(uuid)",
      "companion_api_require_access(uuid,uuid,text)",
      "companion_api_safe_error(text,text,public.companion_runtime_error_action)",
      "companion_api_turn_json(uuid,uuid,uuid)",
      "companion_api_operation_json(uuid,uuid,uuid)",
      "companion_api_validate_resource_selection(uuid,jsonb,jsonb,jsonb,jsonb)",
      "companion_api_config_merge_ids(jsonb,jsonb,jsonb)",
      "companion_api_retry_operation_handoff()",
      "companion_api_assign_attempt_retry_id()",
    ]) {
      expect(apiBlock).toContain(`'public.${helper}'::regprocedure`);
    }
    const apiGrantLoop = sql.slice(
      sql.indexOf("FOREACH protected_function IN ARRAY companion_api_functions"),
      sql.indexOf("-- The skill-secret usage helper", sql.indexOf("FOREACH protected_function IN ARRAY companion_api_functions")),
    );
    expect(apiGrantLoop).toContain("REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC");
    expect(apiGrantLoop).toContain("acl.grantee <> protected_proc.proowner");
    expect(apiGrantLoop).toContain("GRANT EXECUTE ON FUNCTION %s TO %I', protected_function, api_role");
    expect(apiGrantLoop).not.toContain("worker_role");
    expect(apiGrantLoop).not.toContain("companion_runtime_role");
  });

  it("keeps trigger state private and grants the trigger surface to the API role alone", async () => {
    const sql = await readFile(await resolveRuntimeRoleGrantsFile(), "utf8");
    // The trigger table joins the private runtime set: no application role reads it directly.
    expect(sql).toContain("'companion_triggers'");

    // 0110 re-created companion_api_enqueue_turn with the optional trigger-origin pair, which
    // dropped its grant. The script must detect the 10-argument signature first and keep the
    // 8- and 6-argument fallbacks for databases stopped before 0110.
    const tenArgEnqueue =
      "public.companion_api_enqueue_turn(uuid,uuid,uuid,text,public.companion_client_surface,jsonb,uuid,text,uuid,text)";
    expect(sql).toContain(`IF pg_catalog.to_regprocedure(\n        '${tenArgEnqueue}'\n      ) IS NOT NULL THEN`);
    expect(sql).toContain(`'${tenArgEnqueue}'::regprocedure`);
    const tenArgBranch = sql.indexOf(`'${tenArgEnqueue}'`);
    const eightArgBranch = sql.indexOf(
      "'public.companion_api_enqueue_turn(uuid,uuid,uuid,text,public.companion_client_surface,jsonb,uuid,text)'",
    );
    const sixArgBranch = sql.indexOf(
      "'public.companion_api_enqueue_turn(uuid,uuid,uuid,text,public.companion_client_surface,jsonb)'",
    );
    expect(tenArgBranch).toBeGreaterThan(-1);
    expect(eightArgBranch).toBeGreaterThan(tenArgBranch);
    expect(sixArgBranch).toBeGreaterThan(eightArgBranch);

    // The trigger sentinel block mirrors the routine one: CRUD, webhook lookup, fire, and failure
    // bookkeeping to the API role; the JSON projection stays internal.
    const sentinel = sql.indexOf("'public.companion_api_list_triggers(uuid,uuid)'");
    expect(sentinel).toBeGreaterThan(-1);
    const runtimeV3Sentinel = sql.indexOf("-- 0159 is the dormant Runtime v3 expand seam", sentinel);
    expect(runtimeV3Sentinel).toBeGreaterThan(sentinel);
    const triggerBlock = sql.slice(
      sentinel,
      runtimeV3Sentinel,
    );
    for (const signature of [
      "companion_api_list_triggers(uuid,uuid)",
      "companion_api_create_trigger(uuid,uuid,uuid,text,text,text,text,boolean)",
      "companion_api_update_trigger(uuid,uuid,uuid,text,text,text,boolean)",
      "companion_api_rotate_trigger_secret(uuid,uuid,uuid,text)",
      "companion_api_delete_trigger(uuid,uuid,uuid)",
      "companion_webhook_get_trigger(uuid)",
      "companion_api_fire_trigger(uuid,uuid,uuid,text)",
      "companion_api_fail_trigger_fire(uuid,uuid,text,text)",
      "companion_api_answer_trigger_decision(uuid,uuid,text,text,uuid,text)",
    ]) {
      expect(triggerBlock).toContain(`'public.${signature}'::regprocedure`);
    }
    expect(triggerBlock).toContain(
      "internal_runtime_functions := internal_runtime_functions || ARRAY[\n        'public.companion_api_trigger_json(uuid,uuid,uuid,boolean)'::regprocedure\n      ];",
    );
    // The answer function resolves on its own sentinel, like the routine decision one.
    expect(triggerBlock).toContain(
      "'public.companion_api_answer_trigger_decision(uuid,uuid,text,text,uuid,text)'\n    ) IS NOT NULL THEN",
    );
    // Triggers fire synchronously in the API request: the worker receives nothing here.
    expect(triggerBlock).not.toContain("worker_functions");
    expect(triggerBlock).toContain(
      "'public.companion_runtime_get_trigger_material(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)'::regprocedure",
    );
  });

  it("keeps APNs state private and splits registration from fenced delivery", async () => {
    const sql = await readFile(await resolveRuntimeRoleGrantsFile(), "utf8");
    expect(sql).toContain("'companion_notification_devices'");
    expect(sql).toContain("'companion_notification_deliveries'");
    const sentinel = sql.indexOf("'public.companion_api_register_notification_device");
    const block = sql.slice(sentinel, sql.indexOf("-- A migration owner can carry arbitrary", sentinel));
    expect(block).toContain(
      "'public.companion_api_register_notification_device(uuid,uuid,text,text,public.companion_notification_environment,text)'::regprocedure",
    );
    expect(block).toContain(
      "'public.companion_api_unregister_notification_device(uuid,uuid)'::regprocedure",
    );
    for (const signature of [
      "companion_claim_notification_deliveries(text,integer,integer)",
      "companion_claim_notification_deliveries_v2(text,integer,integer)",
      "companion_validate_notification_delivery(uuid,uuid)",
      "companion_complete_notification_delivery(uuid,uuid)",
      "companion_defer_notification_delivery(uuid,uuid,integer)",
      "companion_invalidate_notification_device(uuid,uuid)",
    ]) {
      expect(block).toContain(`'public.${signature}'::regprocedure`);
    }
    expect(block).toContain(
      "'public.companion_notification_enqueue(uuid,uuid,text,text,public.companion_notification_event,text,text)'::regprocedure",
    );
  });

  it("keeps capability-managed Companion aggregates read-only for API and hidden from worker", async () => {
    const sql = await readFile(await resolveRuntimeRoleGrantsFile(), "utf8");
    const capabilityTables = [
      "companions",
      "companion_workspace_access",
      "companion_member_state",
      "companion_threads",
      "companion_transcript_entries",
    ];
    const workerForbiddenTables = [
      ...capabilityTables,
      "companion_provider_connections",
      "companion_mcp_accounts",
    ];

    const declarations = sql.slice(
      sql.indexOf("api_capability_managed_tables regclass[]"),
      sql.indexOf("api_unprotected_tables regclass[]"),
    );
    for (const table of capabilityTables) {
      expect(declarations).toContain(`'public.${table}'::regclass`);
    }
    for (const table of workerForbiddenTables) {
      expect(declarations).toContain(`'public.${table}'::regclass`);
    }
    expect(sql).toContain("to_regclass('public.companion_sections') IS NOT NULL");
    expect(sql.match(/'public\.companion_sections'::regclass/g)).toHaveLength(2);

    const restrictionBlock = sql.slice(
      sql.indexOf("FOREACH protected_table IN ARRAY api_capability_managed_tables"),
      sql.indexOf("-- The dedicated executor reaches tenant/runtime state"),
    );
    expect(restrictionBlock).toContain("REVOKE INSERT, UPDATE, DELETE ON TABLE %s FROM %I");
    expect(restrictionBlock).toContain("GRANT SELECT ON TABLE %s TO %I");
    expect(restrictionBlock).toContain("api_role");
    expect(restrictionBlock).toContain(
      "FOREACH protected_table IN ARRAY worker_forbidden_companion_tables",
    );
    expect(restrictionBlock).toContain("REVOKE ALL PRIVILEGES ON TABLE %s FROM %I");
    expect(restrictionBlock).toContain("worker_role");
  });

  it("requires three distinct active roles and fail-closed retirement of a detected union role", async () => {
    const sql = await readFile(await resolveRuntimeRoleGrantsFile(), "utf8");
    expect(sql).toContain("api_role text := nullif(current_setting('companion.api_role', true), '')");
    expect(sql).toContain("worker_role text := nullif(current_setting('companion.worker_role', true), '')");
    expect(sql).toContain(
      "nullif(current_setting('companion.companion_runtime_role', true), '')",
    );
    expect(sql).toContain("companion API, worker, and runtime roles are required");
    expect(sql).toContain("companion API, worker, and dedicated runtime roles must be distinct");
    expect(sql).toContain("active companion database role % must have no role memberships");
    expect(sql).toContain("current_setting('companion.retired_runtime_role', true)");
    expect(sql).toContain("detected_legacy_union_roles");
    expect(sql).toContain("legacy union runtime role detected but not named for retirement");
    expect(sql).toContain("must already be NOLOGIN");
    expect(sql).toContain("FROM pg_catalog.pg_stat_activity activity");
    expect(sql).toContain("REVOKE ALL PRIVILEGES ON TABLES FROM %I");
    expect(sql).toContain("REVOKE ALL PRIVILEGES ON SEQUENCES FROM %I");
    expect(sql).toContain("REVOKE ALL PRIVILEGES ON FUNCTIONS FROM %I");
    expect(sql).toContain("REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM %I");
    expect(sql).toContain("REVOKE ALL PRIVILEGES ON SCHEMA public FROM %I");
    expect(sql).toContain("REVOKE CONNECT, TEMPORARY ON DATABASE %I FROM %I");
    expect(sql).toContain("companion.runtime_grants_nonce");
    expect(sql).toContain("companion.runtime_grants_verified");
    expect(sql.indexOf("set_config(\n    'companion.runtime_grants_verified'")).toBeGreaterThan(
      sql.indexOf("FOREACH protected_function IN ARRAY shared_functions"),
    );

    for (const retiredSurface of [
      "companion.runtime_role",
      "retired_companion_functions",
      "companion_claim_delivery_lease",
      "companion_release_delivery_lease",
      "companion_renew_delivery_lease",
      "companion_accept_delivery_lease",
      "companion_expire_tool_runs",
      "companion_claim_reconcile_candidates",
      "companion_settle_reconcile_lease",
      "companion_delivery_read_fence",
      "companion_reconcile_leases",
    ]) {
      expect(sql).not.toContain(retiredSurface);
    }
  });

  it("installs mutually exclusive API, worker, and runtime function capabilities", async () => {
    const sql = await readFile(await resolveRuntimeRoleGrantsFile(), "utf8");
    const workerGrantLoop = sql.slice(
      sql.indexOf("FOREACH protected_function IN ARRAY worker_functions"),
      sql.indexOf("FOREACH protected_function IN ARRAY api_functions"),
    );
    expect(workerGrantLoop).toMatch(/protected_function,\s+api_role/);
    expect(workerGrantLoop).toMatch(/protected_function,\s+companion_runtime_role/);
    expect(workerGrantLoop).toMatch(/protected_function,\s+worker_role/);

    const apiGrantLoop = sql.slice(
      sql.indexOf("FOREACH protected_function IN ARRAY api_functions"),
      sql.indexOf("-- No process role receives direct access to Runtime v2"),
    );
    expect(apiGrantLoop).toMatch(/protected_function,\s+worker_role/);
    expect(apiGrantLoop).toMatch(/protected_function,\s+companion_runtime_role/);
    expect(apiGrantLoop).toMatch(/protected_function,\s+api_role/);

    const runtimeGrantLoop = sql.slice(
      sql.indexOf("FOREACH protected_function IN ARRAY companion_runtime_functions"),
      sql.indexOf("-- Re-enable and trigger/helper functions are owner-only"),
    );
    expect(runtimeGrantLoop).toContain("acl.grantee <> protected_proc.proowner");
    expect(runtimeGrantLoop).toMatch(/protected_function,\s+function_grantee/);
    expect(runtimeGrantLoop).toMatch(/protected_function,\s+companion_runtime_role/);
    expect(runtimeGrantLoop).not.toMatch(/protected_function,\s+api_role/);
    expect(runtimeGrantLoop).not.toMatch(/protected_function,\s+worker_role/);
  });
});
