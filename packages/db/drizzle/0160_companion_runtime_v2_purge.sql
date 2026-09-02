-- One-shot Runtime v2 -> Runtime v3 purge ledger. It deliberately has no Companion or tenant FK:
-- provider/object cleanup evidence must survive deletion of every Runtime v2 ownership row.
CREATE TABLE public.companion_v2_purge_runs (
  id text PRIMARY KEY DEFAULT 'runtime-v2-purge' NOT NULL,
  phase text DEFAULT 'deleting_external' NOT NULL,
  inventory_hash text NOT NULL,
  inventory jsonb DEFAULT '{}'::jsonb NOT NULL,
  preservation_fingerprint jsonb NOT NULL,
  started_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  completed_at timestamp with time zone,
  CONSTRAINT companion_v2_purge_runs_singleton_check CHECK (id = 'runtime-v2-purge'),
  CONSTRAINT companion_v2_purge_runs_phase_check CHECK (
    phase IN ('deleting_external', 'external_complete', 'database_complete')
  ),
  CONSTRAINT companion_v2_purge_runs_inventory_hash_check CHECK (
    inventory_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT companion_v2_purge_runs_json_check CHECK (
    jsonb_typeof(inventory) = 'object'
    AND jsonb_typeof(preservation_fingerprint) = 'object'
  ),
  CONSTRAINT companion_v2_purge_runs_completed_check CHECK (
    (phase = 'database_complete') = (completed_at IS NOT NULL)
  )
);
--> statement-breakpoint

CREATE TABLE public.companion_v2_purge_targets (
  resource_kind text NOT NULL,
  resource_key text NOT NULL,
  evidence jsonb DEFAULT '[]'::jsonb NOT NULL,
  state text DEFAULT 'discovered' NOT NULL,
  operation_id text,
  attempt_count integer DEFAULT 0 NOT NULL,
  requested_at timestamp with time zone,
  retry_after timestamp with time zone,
  completed_at timestamp with time zone,
  last_error text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT companion_v2_purge_targets_pk PRIMARY KEY (resource_kind, resource_key),
  CONSTRAINT companion_v2_purge_targets_kind_check CHECK (
    resource_kind IN ('trigger', 'object', 'snapshot', 'box')
  ),
  CONSTRAINT companion_v2_purge_targets_key_check CHECK (
    char_length(resource_key) BETWEEN 1 AND 512 AND resource_key !~ E'[\\n\\r]'
  ),
  CONSTRAINT companion_v2_purge_targets_evidence_check CHECK (
    jsonb_typeof(evidence) = 'array'
  ),
  CONSTRAINT companion_v2_purge_targets_state_check CHECK (
    state IN ('discovered', 'requesting', 'completed', 'absent')
  ),
  CONSTRAINT companion_v2_purge_targets_operation_check CHECK (
    operation_id IS NULL OR (
      char_length(operation_id) BETWEEN 1 AND 200 AND operation_id !~ E'[\\n\\r]'
    )
  ),
  CONSTRAINT companion_v2_purge_targets_attempt_check CHECK (attempt_count >= 0),
  CONSTRAINT companion_v2_purge_targets_error_check CHECK (
    last_error IS NULL OR (char_length(last_error) <= 500 AND last_error !~ E'[\\n\\r]')
  ),
  CONSTRAINT companion_v2_purge_targets_completed_check CHECK (
    (state IN ('completed', 'absent')) = (completed_at IS NOT NULL)
  )
);
--> statement-breakpoint

ALTER TABLE public.companion_v2_purge_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companion_v2_purge_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.companion_v2_purge_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companion_v2_purge_targets FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Serialize the approved owner-only enable path with the whole purge. The purge holds the same
-- session lock from inventory through final verification; enable takes its transaction form so it
-- cannot reactivate claims between destructive provider effects and the database finalizer.
CREATE OR REPLACE FUNCTION public.companion_runtime_enable(
  p_expected_gate_epoch bigint,
  p_actor_id text
)
RETURNS TABLE (
  enabled boolean,
  gate_epoch bigint,
  updated_at timestamp with time zone
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_owner name;
  v_control public.companion_runtime_control%ROWTYPE;
  v_now timestamp with time zone := statement_timestamp();
BEGIN
  SELECT pg_get_userbyid(p.proowner) INTO v_owner
  FROM pg_proc p
  WHERE p.oid = 'public.companion_runtime_enable(bigint,text)'::regprocedure;

  IF current_user <> v_owner THEN
    RAISE EXCEPTION 'only the Runtime v2 function owner may enable execution'
      USING ERRCODE = '42501';
  END IF;
  IF p_expected_gate_epoch IS NULL OR p_expected_gate_epoch < 1 THEN
    RAISE EXCEPTION 'invalid runtime gate epoch' USING ERRCODE = '22023';
  END IF;
  IF p_actor_id IS NULL
     OR char_length(p_actor_id) NOT BETWEEN 1 AND 200
     OR p_actor_id ~ E'[\n\r]' THEN
    RAISE EXCEPTION 'invalid runtime gate actor' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(72401, 20260608);

  SELECT c.* INTO v_control
  FROM public.companion_runtime_control c
  WHERE c.id = 'runtime-v2'
  FOR UPDATE;

  IF v_control.gate_epoch <> p_expected_gate_epoch THEN
    RAISE EXCEPTION 'runtime gate epoch is stale' USING ERRCODE = '40001';
  END IF;
  IF v_control.enabled THEN
    RETURN QUERY SELECT true, v_control.gate_epoch, v_control.updated_at;
    RETURN;
  END IF;

  UPDATE public.companion_runtime_control c
  SET enabled = true,
      gate_epoch = c.gate_epoch + 1,
      enabled_at = v_now,
      disabled_at = NULL,
      changed_by = p_actor_id,
      updated_at = v_now
  WHERE c.id = 'runtime-v2'
  RETURNING c.* INTO v_control;

  RETURN QUERY SELECT v_control.enabled, v_control.gate_epoch, v_control.updated_at;
END
$$;
--> statement-breakpoint

-- Hash every preserved row without retaining plaintext. New non-Companion tables are included
-- automatically; the two shared tables are filtered so only Companion-owned rows may disappear.
CREATE FUNCTION public.companion_v2_purge_preservation_fingerprint()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
  v_table record;
  v_count bigint;
  v_hash text;
  v_result jsonb := '{}'::jsonb;
BEGIN
  FOR v_table IN
    SELECT tablename
    FROM pg_catalog.pg_tables
    WHERE schemaname = 'public'
      AND tablename NOT IN ('companions', 'api_tokens', 'skill_database_object_deletions')
      AND (
        tablename NOT LIKE 'companion\_%' ESCAPE E'\\'
        OR tablename IN (
          'companion_provider_connections',
          'companion_mcp_accounts',
          'companion_trigger_provider_accounts',
          'companion_plugin_trigger_keys',
          'companion_legacy_purge_runs',
          'companion_legacy_purge_targets',
          'companion_runtime_control'
        )
      )
    ORDER BY tablename
  LOOP
    EXECUTE format(
      'SELECT count(*)::bigint, md5(coalesce(string_agg(md5(to_jsonb(t)::text), '''' ORDER BY md5(to_jsonb(t)::text)), '''')) FROM public.%I t',
      v_table.tablename
    ) INTO v_count, v_hash;
    v_result := v_result || jsonb_build_object(
      v_table.tablename,
      jsonb_build_object('count', v_count, 'hash', v_hash)
    );
  END LOOP;

  SELECT count(*)::bigint,
         md5(coalesce(string_agg(md5(to_jsonb(t)::text), '' ORDER BY md5(to_jsonb(t)::text)), ''))
  INTO v_count, v_hash
  FROM public.api_tokens t
  WHERE source_type IS DISTINCT FROM 'companion';
  v_result := v_result || jsonb_build_object(
    'api_tokens_non_companion', jsonb_build_object('count', v_count, 'hash', v_hash)
  );

  SELECT count(*)::bigint,
         md5(coalesce(string_agg(md5(to_jsonb(t)::text), '' ORDER BY md5(to_jsonb(t)::text)), ''))
  INTO v_count, v_hash
  FROM public.skill_database_object_deletions t
  WHERE storage_key NOT LIKE 'companion-attachments/%';
  v_result := v_result || jsonb_build_object(
    'skill_database_object_deletions_non_companion',
    jsonb_build_object('count', v_count, 'hash', v_hash)
  );

  RETURN v_result;
END
$$;
--> statement-breakpoint

-- Provider work is intentionally absent. The command proves every current ownership target is
-- terminal first; this short transaction then deletes Runtime v2 state and verifies preservation.
CREATE FUNCTION public.companion_finalize_v2_purge()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
  v_phase text;
  v_before jsonb;
  v_after jsonb;
  v_companions bigint := 0;
  v_tokens bigint := 0;
  v_objects bigint := 0;
  v_remaining bigint := 0;
  v_table record;
  v_table_count bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(72401, 20260608);

  SELECT phase INTO v_phase
  FROM public.companion_v2_purge_runs
  WHERE id = 'runtime-v2-purge'
  FOR UPDATE;
  IF v_phase IS NULL THEN
    RAISE EXCEPTION 'Runtime v2 purge has no durable run ledger' USING ERRCODE = '55000';
  END IF;
  IF v_phase = 'database_complete' THEN
    RETURN jsonb_build_object('already_complete', true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.companion_runtime_control
    WHERE id = 'runtime-v2' AND enabled = false
  ) THEN
    RAISE EXCEPTION 'Runtime v2 must be disabled before purge' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.companion_runtime_leases WHERE claim_token IS NOT NULL
  ) OR EXISTS (
    SELECT 1 FROM public.companion_v3_lane_leases WHERE claim_token IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Runtime leases must be neutral before purge' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.companion_v2_purge_targets
    WHERE state NOT IN ('completed', 'absent')
  ) THEN
    RAISE EXCEPTION 'Runtime v2 external purge targets are incomplete' USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      SELECT 'box'::text AS kind, box_id AS key
      FROM public.companion_runtime_instances WHERE box_id IS NOT NULL
      UNION
      SELECT 'box', box_id
      FROM public.companion_runtime_duplicate_cleanups WHERE box_id IS NOT NULL
      UNION
      SELECT 'box', build_box_id FROM public.companion_images WHERE build_box_id IS NOT NULL
      UNION
      SELECT 'snapshot', image_name FROM public.companion_images
      UNION
      SELECT 'trigger', id::text FROM public.companion_triggers
      WHERE remote_hook_id IS NOT NULL
         OR (
           provider IN ('linear','github','sentry')
           AND remote_hook_account_id IS NOT NULL
         )
      UNION
      SELECT 'object', storage_key FROM public.companion_message_attachments
      UNION
      SELECT 'object', storage_key FROM public.skill_database_object_deletions
      WHERE storage_key LIKE 'companion-attachments/%'
    ) owned
    LEFT JOIN public.companion_v2_purge_targets target
      ON target.resource_kind = owned.kind AND target.resource_key = owned.key
    WHERE target.resource_key IS NULL OR target.state NOT IN ('completed', 'absent')
  ) THEN
    RAISE EXCEPTION 'Runtime v2 ownership lacks confirmed external deletion' USING ERRCODE = '55000';
  END IF;

  -- Freeze every preserved table while taking the before/after proof. This baseline is deliberately
  -- refreshed only now: ordinary Skills Hub, membership, billing, or audit writes during a long
  -- provider cleanup are legitimate and must not make a resumable run irreparable.
  FOR v_table IN
    SELECT tablename
    FROM pg_catalog.pg_tables
    WHERE schemaname = 'public'
      AND tablename NOT IN ('companions', 'api_tokens', 'skill_database_object_deletions')
      AND (
        tablename NOT LIKE 'companion\_%' ESCAPE E'\\'
        OR tablename IN (
          'companion_provider_connections',
          'companion_mcp_accounts',
          'companion_trigger_provider_accounts',
          'companion_plugin_trigger_keys',
          'companion_legacy_purge_runs',
          'companion_legacy_purge_targets',
          'companion_runtime_control'
        )
      )
    ORDER BY tablename
  LOOP
    EXECUTE format('LOCK TABLE public.%I IN SHARE MODE', v_table.tablename);
  END LOOP;
  LOCK TABLE public.api_tokens IN SHARE MODE;
  LOCK TABLE public.skill_database_object_deletions IN SHARE MODE;
  v_before := public.companion_v2_purge_preservation_fingerprint();

  UPDATE public.companion_v2_purge_runs
  SET phase = 'external_complete', preservation_fingerprint = v_before,
      updated_at = statement_timestamp()
  WHERE id = 'runtime-v2-purge';

  -- Break the two deliberate non-cascade historical references before deleting the roots.
  UPDATE public.companion_runtime_instances SET settings_claim_turn_id = NULL
  WHERE settings_claim_turn_id IS NOT NULL;
  UPDATE public.companion_operations SET source_turn_id = NULL
  WHERE source_turn_id IS NOT NULL;

  -- These Runtime v2 histories deliberately do not cascade from Companion ownership: delegation
  -- rows retain names after their source/target is deleted, while desktop replay nonces are global.
  -- Drain them explicitly before deleting the aggregate roots.
  DELETE FROM public.companion_delegations;
  DELETE FROM public.companion_runtime_desktop_requests;

  WITH deleted AS (DELETE FROM public.companions RETURNING 1)
  SELECT count(*) INTO v_companions FROM deleted;
  DELETE FROM public.companion_sections;
  DELETE FROM public.companion_images;
  DELETE FROM public.companion_notification_devices;
  WITH deleted AS (
    DELETE FROM public.api_tokens WHERE source_type = 'companion' RETURNING 1
  ) SELECT count(*) INTO v_tokens FROM deleted;
  WITH deleted AS (
    DELETE FROM public.skill_database_object_deletions
    WHERE storage_key LIKE 'companion-attachments/%' RETURNING 1
  ) SELECT count(*) INTO v_objects FROM deleted;

  FOR v_table IN
    SELECT tablename
    FROM pg_catalog.pg_tables
    WHERE schemaname = 'public'
      AND tablename LIKE 'companion\_%' ESCAPE E'\\'
      AND tablename NOT IN (
        'companion_provider_connections',
        'companion_mcp_accounts',
        'companion_trigger_provider_accounts',
        'companion_plugin_trigger_keys',
        'companion_legacy_purge_runs',
        'companion_legacy_purge_targets',
        'companion_runtime_control',
        'companion_v2_purge_runs',
        'companion_v2_purge_targets'
      )
  LOOP
    EXECUTE format('SELECT count(*)::bigint FROM public.%I', v_table.tablename)
      INTO v_table_count;
    v_remaining := v_remaining + v_table_count;
  END LOOP;
  IF v_remaining <> 0
     OR EXISTS (SELECT 1 FROM public.companions)
     OR EXISTS (SELECT 1 FROM public.api_tokens WHERE source_type = 'companion')
     OR EXISTS (
       SELECT 1 FROM public.skill_database_object_deletions
       WHERE storage_key LIKE 'companion-attachments/%'
     ) THEN
    RAISE EXCEPTION 'Runtime v2 database purge left % Companion-domain row(s)', v_remaining
      USING ERRCODE = '55000';
  END IF;

  v_after := public.companion_v2_purge_preservation_fingerprint();
  IF v_after IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'Runtime v2 purge changed preserved data' USING ERRCODE = '55000';
  END IF;

  UPDATE public.companion_v2_purge_runs
  SET phase = 'database_complete', updated_at = statement_timestamp(),
      completed_at = statement_timestamp()
  WHERE id = 'runtime-v2-purge';
  RETURN jsonb_build_object(
    'already_complete', false,
    'companions', v_companions,
    'companion_tokens', v_tokens,
    'object_deletion_rows', v_objects,
    'remaining_companion_rows', v_remaining
  );
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_v2_purge_ledger_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_TABLE_NAME = 'companion_v2_purge_runs'
     AND to_jsonb(OLD) ->> 'phase' = 'database_complete' THEN
    RAISE EXCEPTION 'completed Runtime v2 purge evidence is immutable' USING ERRCODE = '55000';
  END IF;
  IF TG_TABLE_NAME = 'companion_v2_purge_targets' AND EXISTS (
    SELECT 1 FROM public.companion_v2_purge_runs
    WHERE id = 'runtime-v2-purge' AND phase = 'database_complete'
  ) THEN
    RAISE EXCEPTION 'completed Runtime v2 purge evidence is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
--> statement-breakpoint

CREATE TRIGGER companion_v2_purge_runs_immutable
BEFORE UPDATE OR DELETE ON public.companion_v2_purge_runs
FOR EACH ROW EXECUTE FUNCTION public.companion_v2_purge_ledger_immutable();
CREATE TRIGGER companion_v2_purge_targets_immutable
BEFORE INSERT OR UPDATE OR DELETE ON public.companion_v2_purge_targets
FOR EACH ROW EXECUTE FUNCTION public.companion_v2_purge_ledger_immutable();
--> statement-breakpoint

CREATE POLICY companion_v2_purge_runs_maintenance_rls
ON public.companion_v2_purge_runs FOR ALL
USING (current_user = pg_get_userbyid((
  SELECT proowner FROM pg_proc
  WHERE oid = 'public.companion_finalize_v2_purge()'::regprocedure
)))
WITH CHECK (current_user = pg_get_userbyid((
  SELECT proowner FROM pg_proc
  WHERE oid = 'public.companion_finalize_v2_purge()'::regprocedure
)));
CREATE POLICY companion_v2_purge_targets_maintenance_rls
ON public.companion_v2_purge_targets FOR ALL
USING (current_user = pg_get_userbyid((
  SELECT proowner FROM pg_proc
  WHERE oid = 'public.companion_finalize_v2_purge()'::regprocedure
)))
WITH CHECK (current_user = pg_get_userbyid((
  SELECT proowner FROM pg_proc
  WHERE oid = 'public.companion_finalize_v2_purge()'::regprocedure
)));
--> statement-breakpoint

REVOKE ALL ON TABLE public.companion_v2_purge_runs FROM PUBLIC;
REVOKE ALL ON TABLE public.companion_v2_purge_targets FROM PUBLIC;
REVOKE ALL ON FUNCTION public.companion_v2_purge_preservation_fingerprint() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.companion_finalize_v2_purge() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.companion_v2_purge_ledger_immutable() FROM PUBLIC;
