\if :{?api_role}
SELECT set_config('companion.api_role', :'api_role', false);
\if :{?worker_role}
SELECT set_config('companion.worker_role', :'worker_role', false);
\if :{?companion_runtime_role}
SELECT set_config('companion.companion_runtime_role', :'companion_runtime_role', false);
\if :{?retired_runtime_role}
SELECT set_config('companion.retired_runtime_role', :'retired_runtime_role', false);
\else
SELECT set_config('companion.retired_runtime_role', '', false);
\endif
\else
  \echo 'companion_runtime_role psql variable is required with api_role + worker_role'
  \quit 1
\endif
\else
  \echo 'worker_role psql variable is required when api_role is configured'
  \quit 1
\endif
\else
  \echo 'api_role, worker_role, and companion_runtime_role psql variables are required'
  \quit 1
\endif

-- Run as the migration/table owner after every migration. The login role must already exist with
-- NOSUPERUSER, NOBYPASSRLS, NOINHERIT and no membership in the migration-owner role. Production
-- must provide distinct API, worker, and Companion runtime roles. Upgrades from the historical
-- union login additionally name that credential as retired, after making it NOLOGIN and draining
-- every session. Fresh installs may omit it only when no union-role ACL footprint is detected.
-- The API migration runner executes the marked DO block directly; keep the markers and GUC hand-off.
-- companion-runtime-grants-begin
DO $companion_runtime_grants$
DECLARE
  api_role text := nullif(current_setting('companion.api_role', true), '');
  worker_role text := nullif(current_setting('companion.worker_role', true), '');
  companion_runtime_role text :=
    nullif(current_setting('companion.companion_runtime_role', true), '');
  retired_runtime_role text :=
    nullif(current_setting('companion.retired_runtime_role', true), '');
  runtime_grants_nonce text := md5(
    random()::text || clock_timestamp()::text || pg_backend_pid()::text
  );
  configured_role text;
  function_grantee name;
  default_function_grantees name[] := ARRAY[]::name[];
  runtime_attributes record;
  retired_attributes record;
  runtime_membership record;
  detected_legacy_union_roles text[] := ARRAY[]::text[];
  protected_column record;
  protected_table regclass;
  image_registry_function text;
  protected_sequence regclass;
  protected_type regtype;
  companion_api_create_function regprocedure;
  active_roles text[] := ARRAY[api_role, worker_role, companion_runtime_role];
  runtime_image_registry_tables text[] := ARRAY[
    'companion_images'
  ];
  runtime_image_registry_functions text[] := ARRAY[
    'public.companion_runtime_image_request(text,text)',
    'public.companion_runtime_image_get(text)',
    'public.companion_runtime_image_claim(text,text,text)',
    'public.companion_runtime_image_mark_building_box(text,bigint,text)',
    'public.companion_runtime_image_clear_building_box(text,bigint,text)',
    'public.companion_runtime_image_mark_delete_intent(text,bigint,text)',
    'public.companion_runtime_image_mark_delete_operation(text,bigint,text,text)',
    'public.companion_runtime_image_record_ready(text,bigint,text,text)',
    'public.companion_runtime_image_record_failure(text,bigint,text,text)'
  ];
  private_runtime_table_names text[] := ARRAY[
    'companion_runtime_control',
    'companion_runtime_instances',
    'companion_turns',
    'companion_turn_attempts',
    'companion_operations',
    'companion_v3_instances',
    'companion_v3_turns',
    'companion_v3_lane_leases',
    'companion_decision_deliveries',
    'companion_runtime_leases',
    'companion_runtime_duplicate_cleanups',
    'companion_runtime_event_projections',
    'companion_runtime_desktop_requests',
    'companion_mcp_broker_tokens',
    'companion_legacy_purge_runs',
    'companion_legacy_purge_targets',
    'companion_message_attachments',
    'companion_routines',
    'companion_triggers',
    'companion_notification_devices',
    'companion_notification_deliveries',
    'companion_routine_run_entries',
    'companion_routine_returns',
    'companion_main_pi_compactions',
    'companion_routine_context_substrates'
  ];
  api_capability_managed_tables regclass[] := ARRAY[
    'public.companions'::regclass,
    'public.companion_workspace_access'::regclass,
    'public.companion_member_state'::regclass,
    'public.companion_threads'::regclass,
    'public.companion_transcript_entries'::regclass
  ];
  worker_forbidden_companion_tables regclass[] := ARRAY[
    'public.companions'::regclass,
    'public.companion_workspace_access'::regclass,
    'public.companion_member_state'::regclass,
    'public.companion_threads'::regclass,
    'public.companion_transcript_entries'::regclass,
    'public.companion_provider_connections'::regclass,
    'public.companion_mcp_accounts'::regclass
  ];
  api_unprotected_tables regclass[] := ARRAY[
    'public.account'::regclass,
    'public.agent'::regclass,
    'public.agent_auth_ephemeral'::regclass,
    'public.agent_capability_grant'::regclass,
    'public.agent_host'::regclass,
    'public.approval_request'::regclass,
    'public.profiles'::regclass,
    'public."session"'::regclass,
    'public."user"'::regclass,
    'public.verification'::regclass
  ];
  protected_function regprocedure;
  shared_functions regprocedure[] := ARRAY[
    'public.companion_secret_usage_count(uuid,uuid)'::regprocedure
  ];
  api_functions regprocedure[] := ARRAY[
    'public.companion_list_user_orgs(text)'::regprocedure,
    'public.companion_users_share_org(text,text)'::regprocedure,
    'public.companion_list_joinable_orgs(text)'::regprocedure,
    'public.companion_lock_invitation_for_actor(text,text)'::regprocedure,
    'public.companion_resolve_api_token(text)'::regprocedure,
    'public.companion_resolve_api_token(text,text)'::regprocedure,
    'public.companion_lock_api_token_for_refresh(text)'::regprocedure,
    'public.companion_public_skill_preview(text)'::regprocedure,
    'public.companion_authorize_public_skill_package(text,text,text)'::regprocedure,
    'public.companion_authorize_public_skill_package(text,text,text,text)'::regprocedure,
    'public.companion_issue_public_skill_transfer_ticket(text,text,text,text,text,text,timestamp with time zone)'::regprocedure,
    'public.companion_consume_public_skill_transfer_ticket(text,text,text)'::regprocedure,
    'public.companion_consume_agent_transfer_ticket(text,text,text,text,text,integer,text)'::regprocedure,
    'public.companion_preflight_agent_transfer_ticket(text,text,text,text)'::regprocedure,
    'public.companion_revalidate_agent_transfer_ticket(text)'::regprocedure,
    'public.companion_revoke_agent_transfer_tickets(text,text,text)'::regprocedure,
    'public.companion_skill_share_target(text,text)'::regprocedure,
    'public.companion_billing_org_for_stripe_event(text,text)'::regprocedure,
    'public.companion_revoke_inactive_skill_database_realm_shares(uuid,uuid)'::regprocedure
  ];
  worker_functions regprocedure[] := ARRAY[
    'public.companion_claim_skill_database_object_deletions(integer,integer)'::regprocedure,
    'public.companion_complete_skill_database_object_deletion(text,uuid)'::regprocedure,
    'public.companion_defer_skill_database_object_deletion(text,uuid)'::regprocedure,
    'public.companion_list_billing_sync_candidates(timestamp with time zone,boolean,integer)'::regprocedure,
    'public.companion_claim_github_sync_destinations(text,integer,integer)'::regprocedure
  ];
  -- The grants hook is also used by historical-migration tests and migration-first deploys. Keep
  -- the v2 lists empty until 0090's sentinel exists. Once it does, the exact casts below remain a
  -- fail-closed contract: a partial or drifted 0090 must fail instead of silently granting a subset.
  companion_runtime_functions regprocedure[] := ARRAY[]::regprocedure[];
  companion_api_functions regprocedure[] := ARRAY[]::regprocedure[];
  owner_only_runtime_functions regprocedure[] := ARRAY[]::regprocedure[];
  internal_runtime_functions regprocedure[] := ARRAY[]::regprocedure[];
BEGIN
  -- The migration hook also runs at the Runtime v2 checkpoint before later migrations. Append the
  -- Wave A table only once it exists; the post-migration pass then applies the final split grants.
  IF pg_catalog.to_regclass('public.companion_sections') IS NOT NULL THEN
    api_capability_managed_tables := api_capability_managed_tables || ARRAY[
      'public.companion_sections'::regclass
    ];
    worker_forbidden_companion_tables := worker_forbidden_companion_tables || ARRAY[
      'public.companion_sections'::regclass
    ];
  END IF;
  IF pg_catalog.to_regclass('public.companion_trigger_provider_accounts') IS NOT NULL THEN
    worker_forbidden_companion_tables := worker_forbidden_companion_tables || ARRAY[
      'public.companion_trigger_provider_accounts'::regclass
    ];
  END IF;
  IF api_role IS NULL OR worker_role IS NULL OR companion_runtime_role IS NULL THEN
    RAISE EXCEPTION 'companion API, worker, and runtime roles are required';
  END IF;
  IF cardinality(ARRAY(SELECT DISTINCT unnest(active_roles))) <> 3 THEN
    RAISE EXCEPTION 'companion API, worker, and dedicated runtime roles must be distinct';
  END IF;
  IF retired_runtime_role IS NOT NULL
    AND retired_runtime_role !~ '^[a-z_][a-z0-9_]{0,62}$' THEN
    RAISE EXCEPTION 'invalid retired companion runtime role';
  END IF;
  IF retired_runtime_role = ANY(active_roles) THEN
    RAISE EXCEPTION 'retired companion runtime role must be distinct from every active role';
  END IF;

  -- The historical single-role mode installed both table-DML and sequence defaults for one login.
  -- That paired default-ACL footprint is specific enough to discover an upgrade without guessing a
  -- role name. Fail closed until the operator explicitly identifies every such credential.
  SELECT COALESCE(array_agg(candidate.rolname ORDER BY candidate.rolname), ARRAY[]::text[])
  INTO detected_legacy_union_roles
  FROM pg_catalog.pg_roles candidate
  WHERE candidate.rolname <> current_user
    AND NOT (candidate.rolname = ANY(active_roles))
    AND (
      (
        EXISTS (
          SELECT 1
          FROM pg_catalog.pg_default_acl defaults
          CROSS JOIN LATERAL pg_catalog.aclexplode(defaults.defaclacl) acl
          WHERE defaults.defaclrole = (
              SELECT owner.oid FROM pg_catalog.pg_roles owner WHERE owner.rolname = current_user
            )
            AND defaults.defaclnamespace IN (0, 'public'::regnamespace)
            AND defaults.defaclobjtype = 'r'
            AND acl.grantee = candidate.oid
            AND acl.privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
        )
        AND EXISTS (
          SELECT 1
          FROM pg_catalog.pg_default_acl defaults
          CROSS JOIN LATERAL pg_catalog.aclexplode(defaults.defaclacl) acl
          WHERE defaults.defaclrole = (
              SELECT owner.oid FROM pg_catalog.pg_roles owner WHERE owner.rolname = current_user
            )
            AND defaults.defaclnamespace IN (0, 'public'::regnamespace)
            AND defaults.defaclobjtype = 'S'
            AND acl.grantee = candidate.oid
            AND acl.privilege_type IN ('USAGE', 'SELECT')
        )
      )
      OR (
        EXISTS (
          SELECT 1
          FROM pg_catalog.pg_class object
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = object.relnamespace
          CROSS JOIN LATERAL pg_catalog.aclexplode(object.relacl) acl
          WHERE namespace.nspname = 'public'
            AND object.relname = 'user'
            AND acl.grantee = candidate.oid
            AND acl.privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
        )
        AND EXISTS (
          SELECT 1
          FROM pg_catalog.pg_class object
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = object.relnamespace
          CROSS JOIN LATERAL pg_catalog.aclexplode(object.relacl) acl
          WHERE namespace.nspname = 'public'
            AND object.relname = 'companion_runtime_pools'
            AND acl.grantee = candidate.oid
            AND acl.privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
        )
      )
    );

  IF cardinality(detected_legacy_union_roles) > 0 AND retired_runtime_role IS NULL THEN
    RAISE EXCEPTION 'legacy union runtime role detected but not named for retirement'
      USING DETAIL = format(
        'set DATABASE_RETIRED_RUNTIME_ROLE to the NOLOGIN, fully drained role: %s',
        array_to_string(detected_legacy_union_roles, ', ')
      );
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(detected_legacy_union_roles) detected(role_name)
    WHERE detected.role_name IS DISTINCT FROM retired_runtime_role
  ) THEN
    RAISE EXCEPTION 'configured retired runtime role does not cover every detected legacy union role'
      USING DETAIL = format(
        'detected legacy union roles: %s', array_to_string(detected_legacy_union_roles, ', ')
      );
  END IF;

  IF retired_runtime_role IS NOT NULL THEN
    SELECT r.rolcanlogin, r.rolsuper, r.rolbypassrls, r.rolinherit
    INTO retired_attributes
    FROM pg_catalog.pg_roles r
    WHERE r.rolname = retired_runtime_role;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'retired companion runtime role % does not exist', retired_runtime_role;
    END IF;

    IF retired_attributes.rolcanlogin THEN
      RAISE EXCEPTION 'retired companion runtime role % must already be NOLOGIN', retired_runtime_role;
    END IF;

    IF retired_attributes.rolsuper
      OR retired_attributes.rolbypassrls
      OR retired_attributes.rolinherit THEN
      RAISE EXCEPTION 'retired companion runtime role % must be NOSUPERUSER NOBYPASSRLS NOINHERIT',
        retired_runtime_role;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_stat_activity activity
      WHERE activity.usename = retired_runtime_role
    ) THEN
      RAISE EXCEPTION 'retired companion runtime role % still has active sessions',
        retired_runtime_role;
    END IF;
    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_auth_members membership
      JOIN pg_catalog.pg_roles parent ON parent.oid = membership.roleid
      JOIN pg_catalog.pg_roles member ON member.oid = membership.member
      WHERE parent.rolname = retired_runtime_role OR member.rolname = retired_runtime_role
    ) THEN
      RAISE EXCEPTION 'retired companion runtime role % must have no role memberships',
        retired_runtime_role;
    END IF;

    -- This is a one-way credential retirement checkpoint. Remove current object, function,
    -- namespace and database ACLs plus every future-object ACL the migration owner could have
    -- installed for the legacy union role. NOLOGIN is deliberately a prerequisite, not an action
    -- hidden inside this script, so an operator must drain the credential before cutover begins.
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES REVOKE ALL PRIVILEGES ON TABLES FROM %I',
      retired_runtime_role
    );
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public
       REVOKE ALL PRIVILEGES ON TABLES FROM %I',
      retired_runtime_role
    );
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES REVOKE ALL PRIVILEGES ON SEQUENCES FROM %I',
      retired_runtime_role
    );
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public
       REVOKE ALL PRIVILEGES ON SEQUENCES FROM %I',
      retired_runtime_role
    );
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES REVOKE ALL PRIVILEGES ON FUNCTIONS FROM %I',
      retired_runtime_role
    );
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public
       REVOKE ALL PRIVILEGES ON FUNCTIONS FROM %I',
      retired_runtime_role
    );
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES REVOKE ALL PRIVILEGES ON TYPES FROM %I',
      retired_runtime_role
    );
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public
       REVOKE ALL PRIVILEGES ON TYPES FROM %I',
      retired_runtime_role
    );
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES REVOKE ALL PRIVILEGES ON SCHEMAS FROM %I',
      retired_runtime_role
    );
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM %I',
      retired_runtime_role
    );
    FOR protected_column IN
      SELECT object.oid::regclass AS relation, attribute.attname AS column_name
      FROM pg_catalog.pg_attribute attribute
      JOIN pg_catalog.pg_class object ON object.oid = attribute.attrelid
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = object.relnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) acl
      WHERE namespace.nspname = 'public'
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND acl.grantee = retired_runtime_role::regrole
      ORDER BY object.oid, attribute.attnum
    LOOP
      EXECUTE format(
        'REVOKE ALL PRIVILEGES (%I) ON TABLE %s FROM %I',
        protected_column.column_name,
        protected_column.relation,
        retired_runtime_role
      );
    END LOOP;
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM %I',
      retired_runtime_role
    );
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM %I',
      retired_runtime_role
    );
    FOR protected_type IN
      SELECT type.oid::regtype
      FROM pg_catalog.pg_type type
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = type.typnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(type.typacl) acl
      WHERE namespace.nspname = 'public' AND acl.grantee = retired_runtime_role::regrole
      ORDER BY type.oid
    LOOP
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON TYPE %s FROM %I',
        protected_type,
        retired_runtime_role
      );
    END LOOP;
    EXECUTE format('REVOKE ALL PRIVILEGES ON SCHEMA public FROM %I', retired_runtime_role);
    EXECUTE format(
      'REVOKE CONNECT, TEMPORARY ON DATABASE %I FROM %I',
      current_database(),
      retired_runtime_role
    );
  END IF;

  IF pg_catalog.to_regprocedure('public.companion_runtime_gate_status()') IS NOT NULL THEN
    companion_runtime_functions := ARRAY[
      'public.companion_runtime_gate_status()'::regprocedure,
      'public.companion_runtime_disable(bigint,text)'::regprocedure,
      'public.companion_runtime_claim_work(text,integer,integer,bigint)'::regprocedure,
      'public.companion_runtime_renew_and_authorize(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)'::regprocedure,
      'public.companion_runtime_checkpoint(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,bigint,text,text,uuid,text,bigint,timestamp with time zone,integer,integer,integer)'::regprocedure,
      'public.companion_runtime_observe_instance(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,bigint,bigint,text,public.companion_box_observed_state,public.companion_pi_observed_state,text,integer,bigint,integer,timestamp with time zone)'::regprocedure,
      'public.companion_runtime_settle(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,text,text,text,public.companion_runtime_error_action)'::regprocedure,
      'public.companion_runtime_release_lease(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid)'::regprocedure
    ];
    owner_only_runtime_functions := ARRAY[
      'public.companion_runtime_enable(bigint,text)'::regprocedure
    ];
    internal_runtime_functions := ARRAY[
      'public.companion_runtime_create_lease_row()'::regprocedure,
      'public.companion_runtime_assert_v2_mutation()'::regprocedure,
      'public.companion_runtime_require_v2_mutation()'::regprocedure,
      'public.companion_runtime_require_instance_at_commit()'::regprocedure,
      'public.companion_runtime_assign_turn_sequence()'::regprocedure,
      'public.companion_runtime_assign_operation_intent()'::regprocedure,
      'public.companion_runtime_assign_attempt_snapshot()'::regprocedure,
      'public.companion_runtime_reject_actor_change()'::regprocedure,
      'public.companion_runtime_reject_turn_surface_change()'::regprocedure,
      'public.companion_runtime_reject_attempt_snapshot_change()'::regprocedure,
      'public.companion_runtime_reject_operation_snapshot_change()'::regprocedure,
      'public.companion_runtime_reject_responder_change()'::regprocedure,
      'public.companion_runtime_close_attempt_decisions(uuid,uuid,uuid,text,text,public.companion_runtime_error_action,uuid)'::regprocedure
    ];

    -- 0091 and desktop-replay repair 0093 are additive, and the hook is also replayed by
    -- historical-migration tests. Resolve the executor surface only when the 0091 sentinel exists;
    -- the two-phase runner applies 0093 before these exact casts, so either partial migration still
    -- fails closed.
    IF pg_catalog.to_regprocedure(
      'public.companion_runtime_get_material(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)'
    ) IS NOT NULL THEN
      companion_runtime_functions := companion_runtime_functions || ARRAY[
        'public.companion_runtime_get_material(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)'::regprocedure,
        'public.companion_runtime_get_attempt_terminal_projection(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid)'::regprocedure,
        'public.companion_runtime_register_duplicate_cleanups(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,text[])'::regprocedure,
        'public.companion_runtime_checkpoint_duplicate_cleanup(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,text,bigint,public.companion_duplicate_cleanup_status,text)'::regprocedure,
        'public.companion_runtime_authorize_desktop(uuid,uuid,text)'::regprocedure,
        'public.companion_runtime_consume_desktop_request(text,bigint,integer)'::regprocedure,
        'public.companion_runtime_project_event_batch(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,bigint,text,jsonb,bigint,timestamp with time zone,integer,integer,integer)'::regprocedure,
        'public.companion_runtime_cas_mcp_oauth(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,uuid,uuid,uuid,text,text,text,text,text,text,text)'::regprocedure
      ];
      IF pg_catalog.to_regprocedure(
        'public.companion_runtime_get_turn_context(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)'
      ) IS NOT NULL THEN
        companion_runtime_functions := companion_runtime_functions || ARRAY[
          'public.companion_runtime_get_turn_context(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)'::regprocedure
        ];
      END IF;
      internal_runtime_functions := internal_runtime_functions || ARRAY[
        'public.companion_runtime_guard_duplicate_cleanup()'::regprocedure,
        'public.companion_runtime_resume_after_decision_delivery()'::regprocedure
      ];
    END IF;

    -- 0092 gives only the API login the durable intent/read surface. The worker and dedicated
    -- executor never receive these functions, and helpers remain migration-owner-only.
    companion_api_create_function := COALESCE(
      pg_catalog.to_regprocedure(
        'public.companion_api_create_companion(uuid,text,text,text,text,jsonb,boolean,jsonb,uuid,smallint,smallint,smallint,smallint)'
      ),
      pg_catalog.to_regprocedure(
        'public.companion_api_create_companion(uuid,text,text,text,text,jsonb,boolean,jsonb,uuid)'
      )
    );
    IF companion_api_create_function IS NOT NULL THEN
      companion_api_functions := ARRAY[
        companion_api_create_function,
        'public.companion_api_update_companion(uuid,uuid,jsonb)'::regprocedure,
        'public.companion_api_set_initial_provider(uuid,uuid,text,text)'::regprocedure,
        'public.companion_api_set_workspace_access(uuid,uuid,public.companion_share_role)'::regprocedure,
        'public.companion_api_update_member_state(uuid,uuid,boolean,boolean,boolean)'::regprocedure,
        'public.companion_api_mark_thread_read(uuid,uuid)'::regprocedure,
        'public.companion_api_read_runtime(uuid,uuid)'::regprocedure,
        'public.companion_api_list_runtime(uuid)'::regprocedure,
        'public.companion_api_read_thread(uuid,uuid)'::regprocedure,
        'public.companion_api_enqueue_operation(uuid,uuid,uuid,public.companion_operation_kind,public.companion_client_surface)'::regprocedure,
        'public.companion_api_cancel_turn(uuid,uuid,uuid)'::regprocedure,
        'public.companion_api_answer_decision(uuid,uuid,text,text,text)'::regprocedure,
        'public.companion_api_bump_skill_revision(uuid,uuid)'::regprocedure
      ];
      IF pg_catalog.to_regprocedure('public.companion_api_sync_thread(uuid,uuid)') IS NOT NULL THEN
        companion_api_functions := companion_api_functions || ARRAY[
          'public.companion_api_sync_thread(uuid,uuid)'::regprocedure
        ];
      END IF;
      IF pg_catalog.to_regprocedure(
        'public.companion_api_read_thread_window(uuid,uuid,integer,integer,boolean)'
      ) IS NOT NULL THEN
        companion_api_functions := companion_api_functions || ARRAY[
          'public.companion_api_read_thread_window(uuid,uuid,integer,integer,boolean)'::regprocedure,
          'public.companion_api_read_thread_projection_sequence(uuid,uuid)'::regprocedure,
          'public.companion_api_read_thread_changes(uuid,uuid,bigint,integer)'::regprocedure
        ];
        internal_runtime_functions := internal_runtime_functions || ARRAY[
          'public.companion_thread_allocate_projection_sequence(uuid,uuid)'::regprocedure,
          'public.companion_thread_sequence_entry()'::regprocedure,
          'public.companion_thread_touch_turn_entry()'::regprocedure,
          'public.companion_thread_touch_attachment_entry()'::regprocedure,
          'public.companion_thread_touch_routine_return()'::regprocedure,
          'public.companion_api_thread_entry_visible(public.companion_transcript_entries)'::regprocedure,
          'public.companion_api_thread_entry_json(public.companion_transcript_entries)'::regprocedure,
          'public.companion_api_routine_notify_returns_window(uuid,uuid,text[])'::regprocedure,
          'public.companion_api_thread_metadata(uuid,uuid,boolean)'::regprocedure
        ];
      END IF;
      IF pg_catalog.to_regprocedure('public.companion_api_list_sections(uuid)') IS NOT NULL THEN
        companion_api_functions := companion_api_functions || ARRAY[
          'public.companion_api_list_sections(uuid)'::regprocedure,
          'public.companion_api_create_section(uuid,text)'::regprocedure,
          'public.companion_api_update_section(uuid,uuid,text)'::regprocedure,
          'public.companion_api_delete_section(uuid,uuid)'::regprocedure,
          'public.companion_api_reorder_sections(uuid,jsonb)'::regprocedure,
          'public.companion_api_assign_section(uuid,uuid,uuid)'::regprocedure,
          'public.companion_api_update_member_state_v2(uuid,uuid,boolean,boolean,boolean,boolean)'::regprocedure
        ];
      END IF;
      internal_runtime_functions := internal_runtime_functions || ARRAY[
        'public.companion_api_actor(uuid)'::regprocedure,
        'public.companion_api_require_access(uuid,uuid,text)'::regprocedure,
        'public.companion_api_safe_error(text,text,public.companion_runtime_error_action)'::regprocedure,
        'public.companion_api_turn_json(uuid,uuid,uuid)'::regprocedure,
        'public.companion_api_operation_json(uuid,uuid,uuid)'::regprocedure,
        'public.companion_api_validate_resource_selection(uuid,jsonb,jsonb,jsonb,jsonb)'::regprocedure,
        'public.companion_api_retry_operation_handoff()'::regprocedure,
        'public.companion_api_assign_attempt_retry_id()'::regprocedure
      ];

      -- 0098 changed companion_api_enqueue_turn's parameter list and added the attachment surface.
      -- 0105 added optional routine origin columns with defaults, and 0110 added the optional
      -- trigger origin pair. Name whichever signature this database actually has:
      -- historical-migration replays and a migration-first deploy must both stay fail-closed
      -- rather than error on a cast to a function that does not exist yet.
      IF pg_catalog.to_regprocedure(
        'public.companion_api_enqueue_turn(uuid,uuid,uuid,text,public.companion_client_surface,jsonb,uuid,text,uuid,text)'
      ) IS NOT NULL THEN
        companion_api_functions := companion_api_functions || ARRAY[
          'public.companion_api_enqueue_turn(uuid,uuid,uuid,text,public.companion_client_surface,jsonb,uuid,text,uuid,text)'::regprocedure,
          'public.companion_api_read_attachment(uuid,uuid,uuid)'::regprocedure
        ];
        internal_runtime_functions := internal_runtime_functions || ARRAY[
          'public.companion_api_assert_message_attachments(uuid,uuid,jsonb)'::regprocedure,
          'public.companion_api_message_attachment_intent(jsonb)'::regprocedure,
          'public.companion_api_stored_attachment_intent(uuid,uuid,text)'::regprocedure,
          'public.companion_enqueue_attachment_object_deletion()'::regprocedure
        ];
      ELSIF pg_catalog.to_regprocedure(
        'public.companion_api_enqueue_turn(uuid,uuid,uuid,text,public.companion_client_surface,jsonb,uuid,text)'
      ) IS NOT NULL THEN
        companion_api_functions := companion_api_functions || ARRAY[
          'public.companion_api_enqueue_turn(uuid,uuid,uuid,text,public.companion_client_surface,jsonb,uuid,text)'::regprocedure,
          'public.companion_api_read_attachment(uuid,uuid,uuid)'::regprocedure
        ];
        internal_runtime_functions := internal_runtime_functions || ARRAY[
          'public.companion_api_assert_message_attachments(uuid,uuid,jsonb)'::regprocedure,
          'public.companion_api_message_attachment_intent(jsonb)'::regprocedure,
          'public.companion_api_stored_attachment_intent(uuid,uuid,text)'::regprocedure,
          'public.companion_enqueue_attachment_object_deletion()'::regprocedure
        ];
      ELSIF pg_catalog.to_regprocedure(
        'public.companion_api_enqueue_turn(uuid,uuid,uuid,text,public.companion_client_surface,jsonb)'
      ) IS NOT NULL THEN
        companion_api_functions := companion_api_functions || ARRAY[
          'public.companion_api_enqueue_turn(uuid,uuid,uuid,text,public.companion_client_surface,jsonb)'::regprocedure,
          'public.companion_api_read_attachment(uuid,uuid,uuid)'::regprocedure
        ];
        internal_runtime_functions := internal_runtime_functions || ARRAY[
          'public.companion_api_assert_message_attachments(uuid,uuid,jsonb)'::regprocedure,
          'public.companion_api_message_attachment_intent(jsonb)'::regprocedure,
          'public.companion_api_stored_attachment_intent(uuid,uuid,text)'::regprocedure,
          'public.companion_enqueue_attachment_object_deletion()'::regprocedure
        ];
      ELSE
        companion_api_functions := companion_api_functions || ARRAY[
          'public.companion_api_enqueue_turn(uuid,uuid,uuid,text,public.companion_client_surface)'::regprocedure
        ];
      END IF;
    END IF;

    -- 0111 separates publication-only Skill updates from dispatch-required revisions.
    IF pg_catalog.to_regprocedure(
      'public.companion_runtime_get_skill_update_material(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)'
    ) IS NOT NULL THEN
      companion_runtime_functions := companion_runtime_functions || ARRAY[
        'public.companion_runtime_get_skill_update_material(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)'::regprocedure,
        'public.companion_runtime_commit_skill_update(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer,integer,jsonb,jsonb,text)'::regprocedure,
        'public.companion_runtime_record_skill_update_error(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer,text,text)'::regprocedure
      ];
      companion_api_functions := companion_api_functions || ARRAY[
        'public.companion_api_require_skill_revision(uuid,uuid)'::regprocedure,
        'public.companion_api_read_skill_sync(uuid,uuid)'::regprocedure,
        'public.companion_api_list_skill_sync(uuid)'::regprocedure
      ];
      internal_runtime_functions := internal_runtime_functions || ARRAY[
        'public.companion_runtime_keep_available_skill_revision()'::regprocedure
      ];
    END IF;

    -- 0099 adds the executor's harvest recorder. It is resolved on its own sentinel so a database
    -- stopped at 0098 still grants a complete, self-consistent surface.
    IF pg_catalog.to_regprocedure(
      'public.companion_runtime_record_attempt_outputs(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,jsonb,timestamp with time zone)'
    ) IS NOT NULL THEN
      companion_runtime_functions := companion_runtime_functions || ARRAY[
        'public.companion_runtime_record_attempt_outputs(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,jsonb,timestamp with time zone)'::regprocedure
      ];
    END IF;

    -- 0099 lets the API login apply an approved config_proposal and read the
    -- pending delivery so the HTTP layer can validate model_id first. Merge
    -- remains owner-only; the worker and executor never receive these.
    IF pg_catalog.to_regprocedure(
      'public.companion_api_answer_config_decision(uuid,uuid,text,text)'
    ) IS NOT NULL THEN
      companion_api_functions := companion_api_functions || ARRAY[
        'public.companion_api_answer_config_decision(uuid,uuid,text,text)'::regprocedure,
        'public.companion_api_get_decision(uuid,uuid,text)'::regprocedure
      ];
      internal_runtime_functions := internal_runtime_functions || ARRAY[
        'public.companion_api_config_merge_ids(jsonb,jsonb,jsonb)'::regprocedure
      ];
    END IF;

    -- 0100 stages a credential-free config catalog onto the Box under the same claim fence.
    IF pg_catalog.to_regprocedure(
      'public.companion_runtime_get_config_catalog(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)'
    ) IS NOT NULL THEN
      companion_runtime_functions := companion_runtime_functions || ARRAY[
        'public.companion_runtime_get_config_catalog(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)'::regprocedure
      ];
    END IF;

    -- 0104 mints the ephemeral Skills Hub token under the live claim fence.
    IF pg_catalog.to_regprocedure(
      'public.companion_runtime_mint_hub_token(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)'
    ) IS NOT NULL THEN
      companion_runtime_functions := companion_runtime_functions || ARRAY[
        'public.companion_runtime_mint_hub_token(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)'::regprocedure
      ];
    END IF;

    -- 0120 vends a hash-only capability to the Box-local MCP OAuth gateway.
    IF pg_catalog.to_regprocedure(
      'public.companion_runtime_mint_mcp_broker_token(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)'
    ) IS NOT NULL THEN
      companion_runtime_functions := array_remove(
        companion_runtime_functions,
        'public.companion_runtime_cas_mcp_oauth(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,uuid,uuid,uuid,text,text,text,text,text,text,text)'::regprocedure
      );
      companion_runtime_functions := companion_runtime_functions || ARRAY[
        'public.companion_runtime_mint_mcp_broker_token(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)'::regprocedure
      ];
      internal_runtime_functions := internal_runtime_functions || ARRAY[
        'public.companion_runtime_claim_work_material_v1(text,integer,integer,bigint,integer,integer)'::regprocedure,
        'public.companion_revoke_inactive_mcp_broker_token()'::regprocedure,
        'public.companion_runtime_cas_mcp_oauth(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,uuid,uuid,uuid,text,text,text,text,text,text,text)'::regprocedure
      ];
      companion_api_functions := companion_api_functions || ARRAY[
        'public.companion_resolve_mcp_broker_token(text)'::regprocedure
      ];
    END IF;

    -- 0121 keeps the current Companion selection row-locked during API-side token vending without
    -- restoring ambient mutation privileges on the runtime aggregate.
    IF pg_catalog.to_regprocedure(
      'public.companion_api_lock_selected_mcp_account(uuid,uuid,uuid)'
    ) IS NOT NULL THEN
      companion_api_functions := companion_api_functions || ARRAY[
        'public.companion_api_lock_selected_mcp_account(uuid,uuid,uuid)'::regprocedure
      ];
    END IF;

    -- 0127 exposes the durable dispatch command id and its pinned Pi invocation to the executor so
    -- takeover can resolve the exact prompt against the on-box ledger. The legacy function remains
    -- executable for rolling deploys, while only the dedicated runtime receives this extension.
    IF pg_catalog.to_regprocedure(
      'public.companion_runtime_renew_and_authorize_v2(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)'
    ) IS NOT NULL THEN
      companion_runtime_functions := companion_runtime_functions || ARRAY[
        'public.companion_runtime_renew_and_authorize_v2(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)'::regprocedure
      ];
    END IF;

    -- 0157 exposes cleanup-only authorization without granting access to historical actor,
    -- provider, Skill, MCP, or staged-material resources.
    IF pg_catalog.to_regprocedure(
      'public.companion_runtime_renew_and_authorize_v3(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)'
    ) IS NOT NULL THEN
      companion_runtime_functions := companion_runtime_functions || ARRAY[
        'public.companion_runtime_renew_and_authorize_v3(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)'::regprocedure,
        'public.companion_runtime_recovery_metrics()'::regprocedure
      ];
      companion_api_functions := companion_api_functions || ARRAY[
        'public.companion_api_turn_recovery_status(uuid,uuid,uuid)'::regprocedure,
        'public.companion_api_retry_turn(uuid,uuid,uuid,uuid,public.companion_client_surface)'::regprocedure
      ];
      internal_runtime_functions := internal_runtime_functions || ARRAY[
        'public.companion_runtime_normalize_legacy_recovery_snapshot()'::regprocedure,
        'public.companion_runtime_ensure_turn_recovery(uuid,uuid,uuid)'::regprocedure,
        'public.companion_runtime_enqueue_interrupted_recovery()'::regprocedure,
        'public.companion_runtime_settle_recovery_operation()'::regprocedure,
        'public.companion_thread_touch_recovery_operation()'::regprocedure
      ];
    END IF;

    -- 0110 records staged credential expiry and publishes it only after a new Pi invocation.
    -- 0125 re-created the record function with the hosted Box-agent endpoint arguments, so the
    -- feature detection keys on that latest signature.
    IF pg_catalog.to_regprocedure(
      'public.companion_runtime_record_material_snapshot(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,public.companion_client_surface,timestamp with time zone,text,text)'
    ) IS NOT NULL THEN
      companion_runtime_functions := companion_runtime_functions || ARRAY[
        'public.companion_runtime_claim_work(text,integer,integer,bigint,integer)'::regprocedure,
        'public.companion_runtime_record_material_snapshot(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,public.companion_client_surface,timestamp with time zone,text,text)'::regprocedure,
        'public.companion_runtime_publish_material_snapshot(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,text)'::regprocedure
      ];
      internal_runtime_functions := internal_runtime_functions || ARRAY[
        'public.companion_runtime_reset_material_on_pi_change()'::regprocedure,
        'public.companion_runtime_reset_settings_material_snapshot()'::regprocedure,
        'public.companion_runtime_repair_legacy_material_work(bigint)'::regprocedure,
        'public.companion_runtime_prepare_queued_turn_material(bigint)'::regprocedure,
        'public.companion_runtime_claim_work_without_material_guard(text,integer,integer,bigint)'::regprocedure
      ];
    END IF;

    -- 0114 moves all productive claims behind the delete-resume protocol. The five-argument
    -- signature remains executable but returns no rows, allowing old runtimes to drain quietly.
    IF pg_catalog.to_regprocedure(
      'public.companion_runtime_defer_delete(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid)'
    ) IS NOT NULL THEN
      companion_runtime_functions := companion_runtime_functions || ARRAY[
        'public.companion_runtime_claim_work(text,integer,integer,bigint,integer,integer)'::regprocedure,
        'public.companion_runtime_defer_delete(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid)'::regprocedure
      ];
      internal_runtime_functions := internal_runtime_functions || ARRAY[
        'public.companion_runtime_claim_work_without_delete_resume_guard(text,integer,integer,bigint,integer)'::regprocedure
      ];
    END IF;

    -- 0105/0106 add Companion routines. Resolved on sentinels so a database stopped before those
    -- migrations still grants a complete, self-consistent surface.
    IF pg_catalog.to_regprocedure(
      'public.companion_api_list_routines(uuid,uuid)'
    ) IS NOT NULL THEN
      companion_api_functions := companion_api_functions || ARRAY[
        'public.companion_api_list_routines(uuid,uuid)'::regprocedure,
        'public.companion_api_create_routine(uuid,uuid,uuid,text,text,text,text,boolean,timestamp with time zone)'::regprocedure,
        'public.companion_api_update_routine(uuid,uuid,uuid,text,text,text,text,boolean,timestamp with time zone)'::regprocedure,
        'public.companion_api_delete_routine(uuid,uuid,uuid)'::regprocedure
      ];
      internal_runtime_functions := internal_runtime_functions || ARRAY[
        'public.companion_api_routine_json(uuid,uuid,uuid)'::regprocedure
      ];
      worker_functions := worker_functions || ARRAY[
        'public.companion_claim_due_routines(text,integer,integer)'::regprocedure,
        'public.companion_fire_routine(text,uuid,uuid,uuid,timestamp with time zone,timestamp with time zone)'::regprocedure,
        'public.companion_fail_routine_fire(text,uuid,uuid,text,text,timestamp with time zone)'::regprocedure
      ];
    END IF;
    IF pg_catalog.to_regprocedure(
      'public.companion_api_answer_routine_decision(uuid,uuid,text,text,uuid,timestamp with time zone)'
    ) IS NOT NULL THEN
      companion_api_functions := companion_api_functions || ARRAY[
        'public.companion_api_answer_routine_decision(uuid,uuid,text,text,uuid,timestamp with time zone)'::regprocedure
      ];
    END IF;

    -- 0135 adds read-only routine run history. The run id is the routine-origin turn id, so the
    -- detail surface remains addressable after the routine row itself is deleted.
    IF pg_catalog.to_regprocedure(
      'public.companion_api_list_routine_runs(uuid,uuid,uuid,uuid,integer)'
    ) IS NOT NULL THEN
      companion_api_functions := companion_api_functions || ARRAY[
        'public.companion_api_list_routine_runs(uuid,uuid,uuid,uuid,integer)'::regprocedure,
        'public.companion_api_get_routine_run(uuid,uuid,uuid,integer,integer)'::regprocedure
      ];
      internal_runtime_functions := internal_runtime_functions || ARRAY[
        'public.companion_api_routine_run_json(uuid,uuid,uuid,boolean,integer,integer)'::regprocedure,
        'public.companion_api_routine_run_summary_json(uuid,uuid,uuid,boolean)'::regprocedure
      ];
    END IF;
    IF pg_catalog.to_regprocedure(
      'public.companion_runtime_project_event_batch_v2(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,bigint,text,jsonb,bigint,timestamp with time zone,integer,integer,integer)'
    ) IS NOT NULL THEN
      companion_runtime_functions := companion_runtime_functions || ARRAY[
        'public.companion_runtime_get_routine_material(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)'::regprocedure,
        'public.companion_runtime_prepare_routine_run(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,boolean)'::regprocedure,
        'public.companion_runtime_project_event_batch_v2(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,bigint,text,jsonb,bigint,timestamp with time zone,integer,integer,integer)'::regprocedure
      ];
      companion_api_functions := companion_api_functions || ARRAY[
        'public.companion_api_routine_hidden_relay_turns(uuid,uuid)'::regprocedure
      ];
      IF pg_catalog.to_regprocedure(
        'public.companion_api_routine_notify_returns(uuid,uuid)'
      ) IS NOT NULL THEN
        companion_api_functions := companion_api_functions || ARRAY[
          'public.companion_api_routine_notify_returns(uuid,uuid)'::regprocedure
        ];
      END IF;
      internal_runtime_functions := internal_runtime_functions || ARRAY[
        'public.companion_runtime_surface_routine_return(uuid,uuid,uuid,public.companion_routine_surface_mode,text)'::regprocedure
      ];
    END IF;

    -- 0124 adds the API-owned device registry and the worker-only APNs delivery queue. The
    -- transition triggers remain owner-only helpers: neither API nor runtime can forge a push.
    IF pg_catalog.to_regprocedure(
      'public.companion_api_register_notification_device(uuid,uuid,text,text,public.companion_notification_environment,text)'
    ) IS NOT NULL THEN
      companion_api_functions := companion_api_functions || ARRAY[
        'public.companion_api_register_notification_device(uuid,uuid,text,text,public.companion_notification_environment,text)'::regprocedure,
        'public.companion_api_unregister_notification_device(uuid,uuid)'::regprocedure
      ];
      worker_functions := worker_functions || ARRAY[
        'public.companion_claim_notification_deliveries(text,integer,integer)'::regprocedure,
        'public.companion_validate_notification_delivery(uuid,uuid)'::regprocedure,
        'public.companion_complete_notification_delivery(uuid,uuid)'::regprocedure,
        'public.companion_defer_notification_delivery(uuid,uuid,integer)'::regprocedure,
        'public.companion_invalidate_notification_device(uuid,uuid)'::regprocedure
      ];
      internal_runtime_functions := internal_runtime_functions || ARRAY[
        'public.companion_notification_enqueue(uuid,uuid,text,text,public.companion_notification_event,text,text)'::regprocedure,
        'public.companion_notification_terminal_turn()'::regprocedure,
        'public.companion_notification_pending_decision()'::regprocedure
      ];
      IF pg_catalog.to_regprocedure(
        'public.companion_claim_notification_deliveries_v2(text,integer,integer)'
      ) IS NOT NULL THEN
        worker_functions := worker_functions || ARRAY[
          'public.companion_claim_notification_deliveries_v2(text,integer,integer)'::regprocedure
        ];
      END IF;
    END IF;
    -- 0110 adds webhook-fired Companion triggers. They are API-only: the webhook fires
    -- synchronously in the API request through the Owner-impersonating enqueue, so the worker
    -- receives no trigger capability at all.
    IF pg_catalog.to_regprocedure(
      'public.companion_api_list_triggers(uuid,uuid)'
    ) IS NOT NULL THEN
      companion_api_functions := companion_api_functions || ARRAY[
        'public.companion_api_list_triggers(uuid,uuid)'::regprocedure,
        'public.companion_api_create_trigger(uuid,uuid,uuid,text,text,text,text,boolean)'::regprocedure,
        'public.companion_api_update_trigger(uuid,uuid,uuid,text,text,text,boolean)'::regprocedure,
        'public.companion_api_rotate_trigger_secret(uuid,uuid,uuid,text)'::regprocedure,
        'public.companion_api_delete_trigger(uuid,uuid,uuid)'::regprocedure,
        'public.companion_webhook_get_trigger(uuid)'::regprocedure,
        'public.companion_api_fire_trigger(uuid,uuid,uuid,text)'::regprocedure,
        'public.companion_api_fail_trigger_fire(uuid,uuid,text,text)'::regprocedure
      ];
      internal_runtime_functions := internal_runtime_functions || ARRAY[
        'public.companion_api_trigger_json(uuid,uuid,uuid,boolean)'::regprocedure
      ];
    END IF;
    -- 0115-0117 add plugin-gated, target-aware trigger overloads plus the on-demand registration
    -- and plugin trigger-key surfaces. Same API-role placement as the base trigger surface.
    IF pg_catalog.to_regprocedure(
      'public.companion_api_create_trigger(uuid,uuid,uuid,text,text,text,jsonb,text,boolean)'
    ) IS NOT NULL THEN
      companion_api_functions := companion_api_functions || ARRAY[
        'public.companion_api_create_trigger(uuid,uuid,uuid,text,text,text,jsonb,text,boolean)'::regprocedure,
        'public.companion_api_update_trigger(uuid,uuid,uuid,text,text,text,jsonb,boolean)'::regprocedure,
        'public.companion_api_set_trigger_registration(uuid,uuid,uuid,uuid,text,text,text)'::regprocedure,
        'public.companion_api_get_trigger_for_registration(uuid,uuid,uuid,text)'::regprocedure,
        'public.companion_api_set_plugin_trigger_key(uuid,uuid,text,uuid,text,text,text,text,text,text,text)'::regprocedure,
        'public.companion_api_get_plugin_trigger_key(uuid,uuid,text)'::regprocedure
      ];
    END IF;
    IF pg_catalog.to_regprocedure(
      'public.companion_api_answer_trigger_decision(uuid,uuid,text,text,uuid,text)'
    ) IS NOT NULL THEN
      companion_api_functions := companion_api_functions || ARRAY[
        'public.companion_api_answer_trigger_decision(uuid,uuid,text,text,uuid,text)'::regprocedure
      ];
    END IF;
    -- 0147 adds autonomous Trigger v2 definitions, read-only history, and one runtime-only
    -- identity/mode reader for the isolated validation lane.
    IF pg_catalog.to_regprocedure(
      'public.companion_api_create_trigger(uuid,uuid,uuid,text,text,text,text,uuid,jsonb,text,boolean)'
    ) IS NOT NULL THEN
      companion_api_functions := companion_api_functions || ARRAY[
        'public.companion_api_create_trigger(uuid,uuid,uuid,text,text,text,text,uuid,jsonb,text,boolean)'::regprocedure,
        'public.companion_api_update_trigger(uuid,uuid,uuid,text,text,text,text,uuid,jsonb,boolean)'::regprocedure,
        'public.companion_api_list_trigger_provider_accounts(uuid)'::regprocedure,
        'public.companion_api_list_trigger_runs(uuid,uuid,uuid,uuid,integer)'::regprocedure,
        'public.companion_api_get_trigger_run(uuid,uuid,uuid,integer,integer)'::regprocedure
      ];
      companion_runtime_functions := companion_runtime_functions || ARRAY[
        'public.companion_runtime_get_trigger_material(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)'::regprocedure
      ];
      internal_runtime_functions := internal_runtime_functions || ARRAY[
        'public.companion_api_trigger_run_json(uuid,uuid,uuid,boolean,integer,integer)'::regprocedure,
        'public.companion_api_trigger_run_summary_json(uuid,uuid,uuid,boolean)'::regprocedure
      ];
    END IF;

    -- 0150 installs the product-owned Companion control MCP and directed delegation surface.
    -- The API owns decisions and ordinary-turn persistence; only the dedicated runtime may mint
    -- the short-lived gateway token under its live claim fence.
    IF pg_catalog.to_regprocedure(
      'public.companion_runtime_mint_control_token(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)'
    ) IS NOT NULL THEN
      companion_runtime_functions := companion_runtime_functions || ARRAY[
        'public.companion_runtime_mint_control_token(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)'::regprocedure
      ];
      companion_api_functions := companion_api_functions || ARRAY[
        'public.companion_resolve_control_token(text)'::regprocedure,
        'public.companion_api_register_control_invocation(uuid,uuid,uuid,uuid,uuid,text,text)'::regprocedure,
        'public.companion_api_finish_control_invocation(uuid,uuid,uuid,text,text,jsonb)'::regprocedure,
        'public.companion_api_create_control_request(uuid,uuid,uuid,uuid,uuid,public.companion_control_request_kind,text,text,jsonb,text,text,text)'::regprocedure,
        'public.companion_api_get_control_request(uuid,uuid,uuid)'::regprocedure,
        'public.companion_api_decide_control_request(uuid,uuid,uuid,text)'::regprocedure,
        'public.companion_api_finish_control_request(uuid,uuid,uuid,jsonb,text,text)'::regprocedure,
        'public.companion_api_enqueue_control_continuation(uuid,uuid,uuid,text)'::regprocedure,
        'public.companion_api_list_peers(uuid,uuid)'::regprocedure,
        'public.companion_api_grant_peer_access(uuid,uuid,uuid)'::regprocedure,
        'public.companion_api_revoke_peer_access(uuid,uuid,uuid)'::regprocedure,
        'public.companion_api_record_delegation(uuid,uuid,uuid,uuid,uuid,uuid,uuid,public.companion_routine_surface_mode,text,text)'::regprocedure,
        'public.companion_api_enqueue_delegation(uuid,uuid,uuid,uuid,uuid,uuid,text,uuid,public.companion_routine_surface_mode,text,text)'::regprocedure,
        'public.companion_api_list_delegations(uuid,uuid,integer,uuid)'::regprocedure,
        'public.companion_api_get_delegation(uuid,uuid,uuid)'::regprocedure,
        'public.companion_api_schedule_pi_restart(uuid,uuid,uuid,uuid,uuid)'::regprocedure
      ];
      internal_runtime_functions := internal_runtime_functions || ARRAY[
        'public.companion_revoke_inactive_control_token()'::regprocedure,
        'public.companion_enqueue_deferred_pi_restart()'::regprocedure,
        'public.companion_surface_delegation_result()'::regprocedure
      ];
    END IF;

    -- 0159 is the dormant Runtime v3 expand seam. Each process gets only its own capability;
    -- direct facts and the generic admission helper remain migration-owner-only. Protocol 3 is a
    -- separate function surface, so a deployed v2 executor cannot claim these rows.
    IF pg_catalog.to_regprocedure(
      'public.companion_v3_runtime_claim(text,public.companion_v3_lane,integer,integer)'
    ) IS NOT NULL THEN
      companion_api_functions := companion_api_functions || ARRAY[
        'public.companion_v3_api_admit_turn(uuid,uuid,uuid,text)'::regprocedure,
        'public.companion_v3_api_desire_lifecycle(uuid,uuid,public.companion_v3_lifecycle_intent)'::regprocedure,
        'public.companion_v3_api_enqueue_warm_turn(uuid,uuid,uuid,text)'::regprocedure,
        'public.companion_v3_api_read_projection(uuid,uuid,jsonb)'::regprocedure
      ];
      worker_functions := worker_functions || ARRAY[
        'public.companion_v3_worker_admit_turn(uuid,uuid,uuid,text,text)'::regprocedure
      ];
      companion_runtime_functions := companion_runtime_functions || ARRAY[
        'public.companion_v3_runtime_claim(text,public.companion_v3_lane,integer,integer)'::regprocedure,
        'public.companion_v3_runtime_claim_warm(text,public.companion_v3_lane,integer,integer)'::regprocedure,
        'public.companion_v3_runtime_complete(uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,text,text,text,public.companion_runtime_error_action,integer)'::regprocedure,
        'public.companion_v3_runtime_authorize_warm_turn(uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,integer)'::regprocedure,
        'public.companion_v3_runtime_record_admission(uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,text,bigint,integer)'::regprocedure,
        'public.companion_v3_runtime_project_page(uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,bigint,jsonb,boolean,boolean,integer)'::regprocedure
      ];
      internal_runtime_functions := internal_runtime_functions || ARRAY[
        'public.companion_v3_admit_turn(uuid,uuid,uuid,text,text,public.companion_v3_lane)'::regprocedure,
        'public.companion_v3_public_turn(public.companion_v3_turns)'::regprocedure
      ];
    END IF;

    -- A migration owner can carry arbitrary ALTER DEFAULT PRIVILEGES grants installed by an
    -- earlier operator. Runtime v2 never relies on default function EXECUTE: erase every named
    -- non-owner grantee and PUBLIC before granting the exact executor surface below.
    SELECT COALESCE(array_agg(DISTINCT grantee.rolname), ARRAY[]::name[])
    INTO default_function_grantees
    FROM pg_catalog.pg_default_acl defaults
    CROSS JOIN LATERAL pg_catalog.aclexplode(defaults.defaclacl) acl
    JOIN pg_catalog.pg_roles grantee ON grantee.oid = acl.grantee
    WHERE defaults.defaclrole = (
        SELECT owner.oid FROM pg_catalog.pg_roles owner WHERE owner.rolname = current_user
      )
      AND defaults.defaclnamespace IN (0, 'public'::regnamespace)
      AND defaults.defaclobjtype = 'f'
      AND acl.privilege_type = 'EXECUTE'
      AND grantee.rolname <> current_user;

    EXECUTE 'ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC';
    EXECUTE
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public
         REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC';
    FOREACH function_grantee IN ARRAY default_function_grantees
    LOOP
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM %I',
        function_grantee
      );
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public
           REVOKE EXECUTE ON FUNCTIONS FROM %I',
        function_grantee
      );
    END LOOP;
  END IF;

  FOR configured_role IN
    SELECT DISTINCT role_name
    FROM unnest(active_roles) AS configured_roles(role_name)
  LOOP
    IF configured_role !~ '^[a-z_][a-z0-9_]{0,62}$' THEN
      RAISE EXCEPTION 'invalid companion runtime role';
    END IF;

    SELECT r.rolcanlogin, r.rolsuper, r.rolbypassrls, r.rolinherit
    INTO runtime_attributes
    FROM pg_catalog.pg_roles r
    WHERE r.rolname = configured_role;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'companion runtime role % does not exist', configured_role;
    END IF;
    IF NOT runtime_attributes.rolcanlogin
      OR runtime_attributes.rolsuper
      OR runtime_attributes.rolbypassrls
      OR runtime_attributes.rolinherit THEN
      RAISE EXCEPTION 'companion runtime role % must be LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT', configured_role;
    END IF;
    -- These are effective-privilege checks, so an unsafe ambient PUBLIC CREATE grant is rejected
    -- just as firmly as a direct role grant.
    IF pg_catalog.has_database_privilege(configured_role, current_database(), 'CREATE')
       OR pg_catalog.has_schema_privilege(configured_role, 'public', 'CREATE') THEN
      RAISE EXCEPTION 'companion runtime role % must not have database or public schema CREATE',
        configured_role;
    END IF;
    IF pg_catalog.pg_has_role(configured_role, current_user, 'member') THEN
      RAISE EXCEPTION 'companion runtime role % must not inherit the migration-owner role', configured_role;
    END IF;
  END LOOP;

  -- NOINHERIT does not prevent SET ROLE. Any direct edge in either direction lets an active login
  -- reach privileges that this grant pass cannot audit (or lets another login assume the active
  -- process role). Reject the whole role graph edge, not only memberships between the three named
  -- process roles. With no direct edge touching a process login, no transitive SET ROLE path can
  -- start from or terminate at that login.
  FOR configured_role IN
    SELECT DISTINCT role_name
    FROM unnest(active_roles) AS configured_roles(role_name)
  LOOP
    SELECT parent.rolname AS parent_role, member.rolname AS member_role
    INTO runtime_membership
    FROM pg_catalog.pg_auth_members membership
    JOIN pg_catalog.pg_roles parent ON parent.oid = membership.roleid
    JOIN pg_catalog.pg_roles member ON member.oid = membership.member
    WHERE membership.roleid = configured_role::regrole
       OR membership.member = configured_role::regrole
    ORDER BY parent.rolname, member.rolname
    LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'active companion database role % must have no role memberships', configured_role
        USING DETAIL = format(
          'role membership %s -> %s would permit inherited privileges or SET ROLE',
          runtime_membership.member_role,
          runtime_membership.parent_role
        );
    END IF;
  END LOOP;

  -- A split-role application is also a downgrade pass for names reused from the legacy union
  -- topology. Clear every direct/current and future table or sequence grant first. The migration
  -- hook is rerun after each schema migration, so future tables fail closed until they either
  -- enable RLS or are deliberately added to a process-specific unprotected-table list.
    FOREACH configured_role IN ARRAY ARRAY[api_role, worker_role]
    LOOP
      EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), configured_role);
      EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', configured_role);
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public
         REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM %I',
        configured_role
      );
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public
         REVOKE USAGE, SELECT ON SEQUENCES FROM %I',
        configured_role
      );
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM %I',
        configured_role
      );
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM %I',
        configured_role
      );

      FOR protected_table IN
        SELECT table_class.oid::regclass
        FROM pg_catalog.pg_class table_class
        JOIN pg_catalog.pg_namespace table_namespace
          ON table_namespace.oid = table_class.relnamespace
        WHERE table_namespace.nspname = 'public'
          AND table_class.relkind IN ('r', 'p')
          AND table_class.relrowsecurity
          AND NOT (table_class.relname::text = ANY(private_runtime_table_names))
        ORDER BY table_class.oid
      LOOP
        EXECUTE format(
          'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %s TO %I',
          protected_table,
          configured_role
        );
      END LOOP;
    END LOOP;

    -- Runtime v2 aggregate mutations are capabilities, not ambient table access. The API keeps
    -- direct SELECT for its PostgreSQL-backed list/detail projections, but every write to these
    -- rows must cross a tenant- and actor-scoped companion_api_* SECURITY DEFINER function. The
    -- diagnostic protocol GUC is deliberately not an authorization boundary.
    FOREACH protected_table IN ARRAY api_capability_managed_tables
    LOOP
      EXECUTE format(
        'REVOKE INSERT, UPDATE, DELETE ON TABLE %s FROM %I',
        protected_table,
        api_role
      );
      EXECUTE format('GRANT SELECT ON TABLE %s TO %I', protected_table, api_role);
    END LOOP;

    -- Billing, GitHub sync, and Skill Database cleanup never inspect or mutate hosted Companion
    -- state. Remove the generic RLS-table grant from every Companion table the worker could
    -- otherwise reach, including credential metadata that remains directly API-managed.
    FOREACH protected_table IN ARRAY worker_forbidden_companion_tables
    LOOP
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON TABLE %s FROM %I',
        protected_table,
        worker_role
      );
    END LOOP;

      -- The dedicated executor reaches tenant/runtime state only through fenced v2 functions.
      EXECUTE format(
        'GRANT CONNECT ON DATABASE %I TO %I',
        current_database(),
        companion_runtime_role
      );
      EXECUTE format(
        'REVOKE CREATE ON DATABASE %I FROM %I',
        current_database(),
        companion_runtime_role
      );
      EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', companion_runtime_role);
      EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I', companion_runtime_role);
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public
         REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM %I',
        companion_runtime_role
      );
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public
         REVOKE USAGE, SELECT ON SEQUENCES FROM %I',
        companion_runtime_role
      );
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public
         REVOKE EXECUTE ON FUNCTIONS FROM %I',
        companion_runtime_role
      );
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM %I',
        companion_runtime_role
      );
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM %I',
        companion_runtime_role
      );
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM %I',
        companion_runtime_role
      );

    -- Better Auth, user profiles and Agent Auth are API-owned surfaces without RLS. Worker
    -- heartbeat tables are intentionally absent: both processes reach them only through the
    -- narrow SECURITY DEFINER readiness/heartbeat functions.
    FOREACH protected_table IN ARRAY api_unprotected_tables
    LOOP
      EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %s TO %I',
        protected_table,
        api_role
      );
    END LOOP;

    -- Re-applying the split must also remove opposite-process SECURITY DEFINER capabilities.
    FOREACH protected_function IN ARRAY worker_functions
    LOOP
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', protected_function);
      EXECUTE format(
        'REVOKE EXECUTE ON FUNCTION %s FROM %I',
        protected_function,
        api_role
      );
      EXECUTE format(
        'REVOKE EXECUTE ON FUNCTION %s FROM %I',
        protected_function,
        companion_runtime_role
      );
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION %s TO %I',
        protected_function,
        worker_role
      );
    END LOOP;
    FOREACH protected_function IN ARRAY api_functions
    LOOP
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', protected_function);
      EXECUTE format(
        'REVOKE EXECUTE ON FUNCTION %s FROM %I',
        protected_function,
        worker_role
      );
      EXECUTE format(
        'REVOKE EXECUTE ON FUNCTION %s FROM %I',
        protected_function,
        companion_runtime_role
      );
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION %s TO %I',
        protected_function,
        api_role
      );
    END LOOP;

  -- No process role receives direct access to Runtime v2
  -- state or to an identity/queue sequence owned by one of those tables. All mutations and reads
  -- cross a SECURITY DEFINER function that validates the lease epoch and current authority.
  FOR protected_table IN
    SELECT table_class.oid::regclass
    FROM pg_catalog.pg_class table_class
    JOIN pg_catalog.pg_namespace table_namespace
      ON table_namespace.oid = table_class.relnamespace
    WHERE table_namespace.nspname = 'public'
      AND table_class.relkind IN ('r', 'p')
      AND table_class.relname::text = ANY(private_runtime_table_names)
    ORDER BY table_class.oid
  LOOP
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE %s FROM PUBLIC', protected_table);
    FOR configured_role IN
      SELECT DISTINCT role_name
      FROM unnest(active_roles) AS configured_roles(role_name)
    LOOP
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON TABLE %s FROM %I',
        protected_table,
        configured_role
      );
    END LOOP;
  END LOOP;

  FOR protected_sequence IN
    SELECT sequence_class.oid::regclass
    FROM pg_catalog.pg_class sequence_class
    JOIN pg_catalog.pg_namespace sequence_namespace
      ON sequence_namespace.oid = sequence_class.relnamespace
    JOIN pg_catalog.pg_depend sequence_dependency
      ON sequence_dependency.classid = 'pg_catalog.pg_class'::regclass
      AND sequence_dependency.refclassid = 'pg_catalog.pg_class'::regclass
      AND sequence_dependency.objid = sequence_class.oid
      AND sequence_dependency.deptype IN ('a', 'i')
    JOIN pg_catalog.pg_class owning_table
      ON owning_table.oid = sequence_dependency.refobjid
    JOIN pg_catalog.pg_namespace owning_namespace
      ON owning_namespace.oid = owning_table.relnamespace
    WHERE sequence_namespace.nspname = 'public'
      AND owning_namespace.nspname = 'public'
      AND sequence_class.relkind = 'S'
      AND owning_table.relname::text = ANY(private_runtime_table_names)
    ORDER BY sequence_class.oid
  LOOP
    EXECUTE format('REVOKE ALL PRIVILEGES ON SEQUENCE %s FROM PUBLIC', protected_sequence);
    FOR configured_role IN
      SELECT DISTINCT role_name
      FROM unnest(active_roles) AS configured_roles(role_name)
    LOOP
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON SEQUENCE %s FROM %I',
        protected_sequence,
        configured_role
      );
    END LOOP;
  END LOOP;

  -- Runtime v2 functions are private by construction. Scrub every directly recorded non-owner
  -- grantee, including roles unknown to this deployment configuration, before installing the one
  -- exact executor grant. This closes inherited migration-owner default ACLs and stale grants.
  FOREACH protected_function IN ARRAY companion_runtime_functions
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', protected_function);
    FOR function_grantee IN
      SELECT DISTINCT grantee.rolname
      FROM pg_catalog.pg_proc protected_proc
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(protected_proc.proacl, pg_catalog.acldefault('f', protected_proc.proowner))
      ) acl
      JOIN pg_catalog.pg_roles grantee ON grantee.oid = acl.grantee
      WHERE protected_proc.oid = protected_function
        AND acl.privilege_type = 'EXECUTE'
        AND acl.grantee <> protected_proc.proowner
    LOOP
      EXECUTE format(
        'REVOKE EXECUTE ON FUNCTION %s FROM %I',
        protected_function,
        function_grantee
      );
    END LOOP;
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %s TO %I',
      protected_function,
      companion_runtime_role
    );
  END LOOP;

  -- Re-enable and trigger/helper functions are owner-only. They never receive an application-role
  -- grant; generic revocation prevents an unconfigured default grantee from reaching them.
  FOREACH protected_function IN ARRAY owner_only_runtime_functions || internal_runtime_functions
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', protected_function);
    FOR function_grantee IN
      SELECT DISTINCT grantee.rolname
      FROM pg_catalog.pg_proc protected_proc
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(protected_proc.proacl, pg_catalog.acldefault('f', protected_proc.proowner))
      ) acl
      JOIN pg_catalog.pg_roles grantee ON grantee.oid = acl.grantee
      WHERE protected_proc.oid = protected_function
        AND acl.privilege_type = 'EXECUTE'
        AND acl.grantee <> protected_proc.proowner
    LOOP
      EXECUTE format(
        'REVOKE EXECUTE ON FUNCTION %s FROM %I',
        protected_function,
        function_grantee
      );
    END LOOP;
  END LOOP;

  -- The API is the sole authority allowed to persist user/runtime intent and read private runtime
  -- projections. Scrub every inherited/default grantee before installing that exact capability.
  FOREACH protected_function IN ARRAY companion_api_functions
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', protected_function);
    FOR function_grantee IN
      SELECT DISTINCT grantee.rolname
      FROM pg_catalog.pg_proc protected_proc
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(protected_proc.proacl, pg_catalog.acldefault('f', protected_proc.proowner))
      ) acl
      JOIN pg_catalog.pg_roles grantee ON grantee.oid = acl.grantee
      WHERE protected_proc.oid = protected_function
        AND acl.privilege_type = 'EXECUTE'
        AND acl.grantee <> protected_proc.proowner
    LOOP
      EXECUTE format(
        'REVOKE EXECUTE ON FUNCTION %s FROM %I',
        protected_function,
        function_grantee
      );
    END LOOP;
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', protected_function, api_role);
  END LOOP;

  -- The skill-secret usage helper is needed by both process roles.
  FOREACH protected_function IN ARRAY shared_functions
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', protected_function);
    EXECUTE format(
      'REVOKE EXECUTE ON FUNCTION %s FROM %I',
      protected_function,
      companion_runtime_role
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %s TO %I',
      protected_function,
      api_role
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %s TO %I',
      protected_function,
      worker_role
    );
  END LOOP;

  -- The image registry is runtime-owned infrastructure reached only through its SECURITY DEFINER
  -- functions (0123). No process role receives any direct table privilege, keeping the dedicated
  -- role verifier's "no public relation privileges" invariant intact.
  FOREACH image_registry_function IN ARRAY runtime_image_registry_functions
  LOOP
    CONTINUE WHEN to_regprocedure(image_registry_function) IS NULL;
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', image_registry_function);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM %I', image_registry_function, api_role);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM %I', image_registry_function, worker_role);
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %s TO %I',
      image_registry_function,
      companion_runtime_role
    );
  END LOOP;

  IF retired_runtime_role IS NOT NULL AND (
    EXISTS (
      SELECT 1
      FROM pg_catalog.pg_default_acl defaults
      CROSS JOIN LATERAL pg_catalog.aclexplode(defaults.defaclacl) acl
      WHERE acl.grantee = retired_runtime_role::regrole
    )
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class object
      CROSS JOIN LATERAL pg_catalog.aclexplode(object.relacl) acl
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = object.relnamespace
      WHERE namespace.nspname = 'public' AND acl.grantee = retired_runtime_role::regrole
    )
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute attribute
      JOIN pg_catalog.pg_class object ON object.oid = attribute.attrelid
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = object.relnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) acl
      WHERE namespace.nspname = 'public' AND acl.grantee = retired_runtime_role::regrole
    )
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc function
      CROSS JOIN LATERAL pg_catalog.aclexplode(function.proacl) acl
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = function.pronamespace
      WHERE namespace.nspname = 'public' AND acl.grantee = retired_runtime_role::regrole
    )
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_type type
      CROSS JOIN LATERAL pg_catalog.aclexplode(type.typacl) acl
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = type.typnamespace
      WHERE namespace.nspname = 'public' AND acl.grantee = retired_runtime_role::regrole
    )
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_namespace namespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(namespace.nspacl) acl
      WHERE namespace.nspname = 'public' AND acl.grantee = retired_runtime_role::regrole
    )
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_database database
      CROSS JOIN LATERAL pg_catalog.aclexplode(database.datacl) acl
      WHERE database.datname = current_database() AND acl.grantee = retired_runtime_role::regrole
    )
  ) THEN
    RAISE EXCEPTION 'retired companion runtime role % still owns a direct or default ACL',
      retired_runtime_role;
  END IF;

  -- This nonce and its role/backend-bound marker are deliberately written only at the very end of
  -- the exact grant block. Migration 0094 consumes them on this same connection before its first
  -- DDL statement; a missing, stale, copied or human-friendly spoof marker fails closed.
  PERFORM set_config('companion.runtime_grants_nonce', runtime_grants_nonce, false);
  PERFORM set_config(
    'companion.runtime_grants_verified',
    'v1:' || md5(concat_ws(
      chr(31),
      runtime_grants_nonce,
      current_database(),
      current_user,
      pg_backend_pid()::text,
      api_role,
      worker_role,
      companion_runtime_role,
      coalesce(retired_runtime_role, '')
    )),
    false
  );
END
$companion_runtime_grants$;
-- companion-runtime-grants-end

RESET companion.api_role;
RESET companion.worker_role;
RESET companion.companion_runtime_role;
RESET companion.retired_runtime_role;
RESET companion.runtime_grants_nonce;
RESET companion.runtime_grants_verified;
