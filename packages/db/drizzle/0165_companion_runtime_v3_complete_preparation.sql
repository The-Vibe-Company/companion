-- THE-516: Prepared is an actor-bound proof that the complete current Companion capability set
-- was staged. Any authority/configuration change fences the old preparation before another Pi
-- admission; the runtime then restages the whole snapshot and starts a fresh Pi invocation.
ALTER TABLE public.companion_v3_instances
  ADD COLUMN preparation_actor_id text,
  ADD COLUMN preparation_settings_revision bigint,
  ADD COLUMN preparation_skills_revision integer,
  ADD COLUMN preparation_model_id text,
  ADD COLUMN preparation_provider_refs jsonb,
  ADD COLUMN preparation_skill_refs jsonb,
  ADD COLUMN preparation_mcp_refs jsonb,
  ADD COLUMN prepared_disk_layout_version integer,
  ADD COLUMN prepared_skills_digest text,
  ADD COLUMN prepared_material_expires_at timestamp with time zone,
  ADD COLUMN hub_token_id uuid REFERENCES public.api_tokens(id) ON DELETE SET NULL,
  ADD COLUMN mcp_broker_token_id uuid REFERENCES public.companion_mcp_broker_tokens(id) ON DELETE SET NULL,
  ADD COLUMN control_token_id uuid REFERENCES public.companion_control_tokens(id) ON DELETE SET NULL;
--> statement-breakpoint

DROP INDEX public.companion_v3_instances_preparation_idx;
CREATE INDEX companion_v3_instances_preparation_idx
  ON public.companion_v3_instances(preparation_available_at, created_at)
  WHERE prepared_at IS NULL AND desired_lifecycle = 'prepare';
--> statement-breakpoint

ALTER TABLE public.companion_v3_instances
  DROP CONSTRAINT companion_v3_instances_preparation_check;
--> statement-breakpoint

-- Earlier tracer-bullet readiness never proved material. Reset those rows while the legacy check
-- is absent, preserving Box identity but requiring a complete stage and fresh Pi activation.
UPDATE public.companion_v3_instances
SET preparation_checkpoint = CASE WHEN box_id IS NULL THEN 'pending' ELSE 'box_ready' END,
    staging_completed_at = NULL, pi_invocation_id = NULL, prepared_at = NULL,
    preparation_available_at = clock_timestamp(), updated_at = clock_timestamp();
--> statement-breakpoint

ALTER TABLE public.companion_v3_instances
  ADD CONSTRAINT companion_v3_instances_preparation_check CHECK (
    preparation_checkpoint IN ('pending', 'box_created', 'box_ready', 'staged', 'prepared')
    AND preparation_attempt_count >= 0 AND preparation_claim_epoch >= 0
    AND (box_id IS NULL OR box_id ~ '^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$')
    AND (pi_invocation_id IS NULL OR (
      char_length(pi_invocation_id) BETWEEN 1 AND 200 AND pi_invocation_id !~ E'[\n\r]'
    ))
    AND (preparation_error_code IS NULL) = (preparation_error_message IS NULL)
    AND (preparation_error_code IS NULL OR (
      preparation_error_code ~ '^[a-z][a-z0-9_]{0,63}$'
      AND char_length(preparation_error_message) BETWEEN 1 AND 500
      AND preparation_error_message !~ E'[\n\r]'
    ))
    AND (preparation_checkpoint = 'pending' OR box_id IS NOT NULL)
    AND (preparation_checkpoint IN ('pending', 'box_created') OR box_ready_at IS NOT NULL)
    AND (preparation_checkpoint IN ('pending', 'box_created', 'box_ready')
      OR staging_completed_at IS NOT NULL)
    AND ((preparation_checkpoint = 'prepared') = (prepared_at IS NOT NULL))
    AND (preparation_checkpoint <> 'prepared' OR pi_invocation_id IS NOT NULL)
    AND (box_ready_at IS NULL OR staging_completed_at IS NULL
      OR staging_completed_at >= box_ready_at)
    AND (staging_completed_at IS NULL OR prepared_at IS NULL
      OR prepared_at >= staging_completed_at)
    AND ((preparation_actor_id IS NULL) = (preparation_settings_revision IS NULL))
    AND ((preparation_actor_id IS NULL) = (preparation_skills_revision IS NULL))
    AND ((preparation_actor_id IS NULL) = (preparation_model_id IS NULL))
    AND ((preparation_actor_id IS NULL) = (preparation_provider_refs IS NULL))
    AND ((preparation_actor_id IS NULL) = (preparation_skill_refs IS NULL))
    AND ((preparation_actor_id IS NULL) = (preparation_mcp_refs IS NULL))
    AND (preparation_actor_id IS NULL OR (
      char_length(preparation_actor_id) BETWEEN 1 AND 200
      AND preparation_actor_id !~ E'[\n\r]'
      AND preparation_settings_revision >= 1 AND preparation_skills_revision >= 1
      AND char_length(preparation_model_id) BETWEEN 1 AND 200
      AND preparation_model_id !~ E'[\n\r]'
      AND jsonb_typeof(preparation_provider_refs) = 'array'
      AND jsonb_typeof(preparation_skill_refs) = 'array'
      AND jsonb_typeof(preparation_mcp_refs) = 'array'
    ))
    AND (prepared_disk_layout_version IS NULL OR prepared_disk_layout_version >= 1)
    AND (prepared_skills_digest IS NULL OR prepared_skills_digest ~ '^[0-9a-f]{64}$')
    AND ((preparation_checkpoint IN ('staged', 'prepared')) =
      (prepared_disk_layout_version IS NOT NULL AND prepared_skills_digest IS NOT NULL
       AND prepared_material_expires_at IS NOT NULL))
    AND (
      (preparation_claim_token IS NULL AND preparation_gate_epoch IS NULL
        AND preparation_executor_id IS NULL AND preparation_claimed_at IS NULL
        AND preparation_expires_at IS NULL)
      OR (preparation_claim_token IS NOT NULL AND preparation_claim_epoch >= 1
        AND preparation_gate_epoch IS NOT NULL AND preparation_executor_id IS NOT NULL
        AND preparation_claimed_at IS NOT NULL AND preparation_expires_at > preparation_claimed_at)
    )
  ) NOT VALID;
--> statement-breakpoint

ALTER TABLE public.companion_v3_instances
  VALIDATE CONSTRAINT companion_v3_instances_preparation_check;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_invalidate_preparation(p_org_id uuid, p_companion_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = on AS $$
BEGIN
  UPDATE public.companion_v3_instances instance SET
    preparation_checkpoint = CASE WHEN instance.box_id IS NULL THEN 'pending' ELSE 'box_ready' END,
    staging_completed_at = NULL, pi_invocation_id = NULL, prepared_at = NULL,
    preparation_actor_id = NULL, preparation_settings_revision = NULL,
    preparation_skills_revision = NULL, preparation_model_id = NULL,
    preparation_provider_refs = NULL, preparation_skill_refs = NULL,
    preparation_mcp_refs = NULL, prepared_disk_layout_version = NULL,
    prepared_skills_digest = NULL, prepared_material_expires_at = NULL,
    preparation_available_at = clock_timestamp(), preparation_claim_token = NULL,
    preparation_gate_epoch = NULL, preparation_executor_id = NULL,
    preparation_claimed_at = NULL, preparation_expires_at = NULL,
    updated_at = clock_timestamp()
  WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id
    AND instance.desired_lifecycle = 'prepare';
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_invalidate_preparation(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_invalidate_from_companion()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = on AS $$
BEGIN
  IF OLD.persona IS DISTINCT FROM NEW.persona OR OLD.model_id IS DISTINCT FROM NEW.model_id
    OR OLD.provider_ids IS DISTINCT FROM NEW.provider_ids
    OR OLD.selected_skill_ids IS DISTINCT FROM NEW.selected_skill_ids
    OR OLD.selected_mcp_account_ids IS DISTINCT FROM NEW.selected_mcp_account_ids
    OR OLD.skills_revision IS DISTINCT FROM NEW.skills_revision
    OR OLD.skills_available_revision IS DISTINCT FROM NEW.skills_available_revision THEN
    PERFORM public.companion_v3_invalidate_preparation(NEW.org_id, NEW.id);
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_invalidate_from_companion() FROM PUBLIC;
CREATE TRIGGER companion_v3_invalidate_from_companion
AFTER UPDATE OF persona, model_id, provider_ids, selected_skill_ids, selected_mcp_account_ids,
  skills_revision, skills_available_revision ON public.companions
FOR EACH ROW EXECUTE FUNCTION public.companion_v3_invalidate_from_companion();
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_invalidate_from_turn()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = on AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.companion_v3_instances instance
    WHERE instance.org_id = NEW.org_id AND instance.companion_id = NEW.companion_id
      AND instance.prepared_at IS NOT NULL
      AND instance.preparation_actor_id IS DISTINCT FROM NEW.actor_id) THEN
    PERFORM public.companion_v3_invalidate_preparation(NEW.org_id, NEW.companion_id);
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_invalidate_from_turn() FROM PUBLIC;
CREATE TRIGGER companion_v3_invalidate_from_turn
AFTER INSERT ON public.companion_v3_turns
FOR EACH ROW WHEN (NEW.lane = 'main') EXECUTE FUNCTION public.companion_v3_invalidate_from_turn();
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_invalidate_from_resource()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = on AS $$
DECLARE
  v_row jsonb := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  v_org uuid := (v_row->>'org_id')::uuid;
  v_resource_id text := CASE TG_TABLE_NAME
    WHEN 'companion_provider_connections' THEN v_row->>'provider_id'
    WHEN 'companion_mcp_accounts' THEN v_row->>'id'
    WHEN 'skills' THEN v_row->>'id'
    ELSE NULL
  END;
  v_companion uuid;
BEGIN
  IF v_org IS NULL OR v_resource_id IS NULL THEN
    RAISE EXCEPTION 'unsupported Runtime v3 preparation invalidation resource'
      USING ERRCODE = '22023';
  END IF;
  FOR v_companion IN
    SELECT instance.companion_id FROM public.companion_v3_instances instance
    JOIN public.companions companion
      ON companion.org_id = instance.org_id AND companion.id = instance.companion_id
    WHERE instance.org_id = v_org AND instance.prepared_at IS NOT NULL AND (
      (TG_TABLE_NAME = 'companion_provider_connections'
        AND companion.provider_ids ? v_resource_id)
      OR (TG_TABLE_NAME = 'companion_mcp_accounts'
        AND companion.selected_mcp_account_ids ? v_resource_id)
      OR (TG_TABLE_NAME = 'skills'
        AND companion.selected_skill_ids ? v_resource_id)
    )
  LOOP PERFORM public.companion_v3_invalidate_preparation(v_org, v_companion); END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_invalidate_from_resource() FROM PUBLIC;
CREATE TRIGGER companion_v3_invalidate_provider
AFTER UPDATE OR DELETE ON public.companion_provider_connections
FOR EACH ROW EXECUTE FUNCTION public.companion_v3_invalidate_from_resource();
CREATE TRIGGER companion_v3_invalidate_mcp
AFTER UPDATE OR DELETE ON public.companion_mcp_accounts
FOR EACH ROW EXECUTE FUNCTION public.companion_v3_invalidate_from_resource();
CREATE TRIGGER companion_v3_invalidate_skill
AFTER UPDATE OR DELETE ON public.skills
FOR EACH ROW EXECUTE FUNCTION public.companion_v3_invalidate_from_resource();
--> statement-breakpoint

-- Keep protocol-3 call signatures while fencing material-expired rows before they can reach Pi.
ALTER FUNCTION public.companion_v3_runtime_claim_warm(
  text,public.companion_v3_lane,integer,integer
) RENAME TO companion_v3_runtime_claim_warm_unchecked;
ALTER FUNCTION public.companion_v3_runtime_authorize_warm_turn(
  uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,integer
) RENAME TO companion_v3_runtime_authorize_warm_unchecked;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_runtime_claim_warm(
  p_executor_id text, p_lane public.companion_v3_lane,
  p_lease_seconds integer, p_protocol integer
)
RETURNS TABLE (
  org_id uuid, companion_id uuid, turn_id uuid, command_id uuid,
  lane public.companion_v3_lane, state public.companion_v3_turn_state,
  claim_token uuid, claim_epoch bigint, gate_epoch bigint
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = on AS $$
DECLARE
  v_now timestamptz := clock_timestamp(); v_org uuid; v_companion uuid;
BEGIN
  SELECT instance.org_id, instance.companion_id INTO v_org, v_companion
  FROM public.companion_v3_instances instance
  JOIN public.companion_v3_lane_leases lease
    ON lease.org_id = instance.org_id AND lease.companion_id = instance.companion_id
  JOIN public.companion_v3_turns eligible
    ON eligible.org_id = lease.org_id AND eligible.companion_id = lease.companion_id
   AND eligible.lane = lease.lane AND eligible.state IN ('queued', 'needs_input')
  WHERE lease.lane = p_lane AND instance.prepared_at IS NOT NULL
    AND (instance.prepared_material_expires_at IS NULL
      OR instance.prepared_material_expires_at <= v_now + interval '2 hours 5 minutes')
  ORDER BY eligible.created_at, eligible.queue_sequence, eligible.id
  LIMIT 1 FOR UPDATE OF instance SKIP LOCKED;
  IF FOUND THEN
    PERFORM public.companion_v3_invalidate_preparation(v_org, v_companion);
    RETURN;
  END IF;
  RETURN QUERY SELECT claimed.org_id, claimed.companion_id, claimed.turn_id,
    claimed.command_id, claimed.lane, claimed.state, claimed.claim_token,
    claimed.claim_epoch, claimed.gate_epoch
  FROM public.companion_v3_runtime_claim_warm_unchecked(
    p_executor_id, p_lane, p_lease_seconds, p_protocol
  ) claimed;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_runtime_claim_warm(
  text,public.companion_v3_lane,integer,integer
) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_runtime_authorize_warm_turn(
  p_org_id uuid, p_companion_id uuid, p_lane public.companion_v3_lane,
  p_turn_id uuid, p_claim_token uuid, p_claim_epoch bigint,
  p_gate_epoch bigint, p_protocol integer
)
RETURNS TABLE (box_id text, pi_invocation_id text, content text, activity_cursor bigint)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = on AS $$
DECLARE v_now timestamptz := clock_timestamp();
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.companion_v3_instances instance
    WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id
      AND instance.prepared_at IS NOT NULL
      AND (instance.prepared_material_expires_at IS NULL
        OR instance.prepared_material_expires_at <= v_now + interval '2 hours 5 minutes')
  ) THEN
    PERFORM public.companion_v3_invalidate_preparation(p_org_id, p_companion_id);
    UPDATE public.companion_v3_lane_leases lease SET
      claim_token = NULL, gate_epoch = NULL, executor_id = NULL, turn_id = NULL,
      claimed_at = NULL, renewed_at = NULL, expires_at = NULL, updated_at = v_now
    WHERE lease.org_id = p_org_id AND lease.companion_id = p_companion_id
      AND lease.lane = p_lane AND lease.turn_id = p_turn_id
      AND lease.claim_token = p_claim_token AND lease.claim_epoch = p_claim_epoch
      AND lease.gate_epoch = p_gate_epoch;
    RETURN;
  END IF;
  RETURN QUERY SELECT authorized.box_id, authorized.pi_invocation_id,
    authorized.content, authorized.activity_cursor
  FROM public.companion_v3_runtime_authorize_warm_unchecked(
    p_org_id, p_companion_id, p_lane, p_turn_id, p_claim_token,
    p_claim_epoch, p_gate_epoch, p_protocol
  ) authorized;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_runtime_authorize_warm_turn(
  uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,integer
) FROM PUBLIC;
--> statement-breakpoint

DO $companion_v3_warm_material_expiry_acl$
DECLARE v_source oid; v_target regprocedure; v_grantee oid; v_role name;
BEGIN
  FOR v_source, v_target IN VALUES
    (pg_catalog.to_regprocedure('public.companion_v3_runtime_claim_warm_unchecked(text,public.companion_v3_lane,integer,integer)'),
      'public.companion_v3_runtime_claim_warm(text,public.companion_v3_lane,integer,integer)'::regprocedure),
    (pg_catalog.to_regprocedure('public.companion_v3_runtime_authorize_warm_unchecked(uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,integer)'),
      'public.companion_v3_runtime_authorize_warm_turn(uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,integer)'::regprocedure)
  LOOP
    FOR v_grantee IN SELECT DISTINCT acl.grantee FROM pg_catalog.pg_proc source_proc
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(source_proc.proacl, pg_catalog.acldefault('f', source_proc.proowner))) acl
      WHERE source_proc.oid = v_source AND acl.privilege_type = 'EXECUTE'
        AND acl.grantee NOT IN (source_proc.proowner, 0)
    LOOP
      SELECT role_row.rolname INTO STRICT v_role FROM pg_catalog.pg_roles role_row
      WHERE role_row.oid = v_grantee;
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', v_target, v_role);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM %I', v_source::regprocedure, v_role);
    END LOOP;
  END LOOP;
END $companion_v3_warm_material_expiry_acl$;
--> statement-breakpoint

DROP FUNCTION public.companion_v3_runtime_claim_preparation(text, integer, integer);
DROP FUNCTION public.companion_v3_runtime_checkpoint_preparation(
  uuid,uuid,uuid,bigint,bigint,text,text,text,text,integer
);
DROP FUNCTION public.companion_v3_runtime_defer_preparation(
  uuid,uuid,uuid,bigint,bigint,integer,text,text,integer
);
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_runtime_claim_preparation(
  p_executor_id text, p_lease_seconds integer, p_protocol integer
)
RETURNS TABLE (
  org_id uuid, companion_id uuid, turn_id uuid, command_id uuid,
  work_kind text, checkpoint text, box_idempotency_key uuid, box_id text,
  claim_token uuid, claim_epoch bigint, gate_epoch bigint, created_at timestamp with time zone,
  authorized boolean, actor_id text, model_id text, persona text,
  settings_revision bigint, skills_revision integer,
  provider_refs jsonb, skill_refs jsonb, mcp_refs jsonb,
  provider_material jsonb, skill_material jsonb, mcp_material jsonb, config_catalog jsonb
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = on AS $$
DECLARE
  v_now timestamptz := clock_timestamp(); v_instance public.companion_v3_instances%ROWTYPE;
  v_companion public.companions%ROWTYPE; v_turn public.companion_v3_turns%ROWTYPE;
  v_runtime public.companion_runtime_instances%ROWTYPE; v_gate bigint;
  v_expired_org uuid; v_expired_companion uuid;
  v_provider_count integer; v_skill_count integer; v_mcp_count integer;
  v_skills jsonb; v_plugins jsonb;
BEGIN
  IF p_protocol IS DISTINCT FROM 4 OR p_executor_id IS NULL
    OR char_length(p_executor_id) NOT BETWEEN 1 AND 200 OR p_executor_id ~ E'[\n\r]'
    OR p_lease_seconds NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION 'invalid Runtime v3 preparation claim' USING ERRCODE = '22023';
  END IF;
  SELECT control.gate_epoch INTO v_gate FROM public.companion_runtime_control control
  WHERE control.id = 'runtime-v2' AND control.enabled FOR SHARE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT instance.org_id, instance.companion_id INTO v_expired_org, v_expired_companion
  FROM public.companion_v3_instances instance
  WHERE instance.desired_lifecycle = 'prepare' AND instance.prepared_at IS NOT NULL
    AND (instance.prepared_material_expires_at IS NULL
      OR instance.prepared_material_expires_at <= v_now + interval '2 hours 5 minutes')
  ORDER BY instance.prepared_material_expires_at NULLS FIRST, instance.created_at
  LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF FOUND THEN
    PERFORM public.companion_v3_invalidate_preparation(v_expired_org, v_expired_companion);
  END IF;
  SELECT instance.* INTO v_instance FROM public.companion_v3_instances instance
  WHERE instance.desired_lifecycle = 'prepare' AND instance.prepared_at IS NULL
    AND instance.preparation_available_at <= v_now
    AND (instance.preparation_claim_token IS NULL OR instance.preparation_expires_at <= v_now)
  ORDER BY EXISTS (SELECT 1 FROM public.companion_v3_turns queued
      WHERE queued.org_id = instance.org_id AND queued.companion_id = instance.companion_id
        AND queued.lane = 'main' AND queued.state = 'queued') DESC,
    instance.created_at, instance.companion_id
  LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT queued.* INTO v_turn FROM public.companion_v3_turns queued
  WHERE queued.org_id = v_instance.org_id AND queued.companion_id = v_instance.companion_id
    AND queued.lane = 'main' AND queued.state = 'queued'
  ORDER BY queued.queue_sequence, queued.id LIMIT 1;
  SELECT companion.* INTO v_companion FROM public.companions companion
  WHERE companion.org_id = v_instance.org_id AND companion.id = v_instance.companion_id;
  SELECT runtime.* INTO v_runtime FROM public.companion_runtime_instances runtime
  WHERE runtime.org_id = v_instance.org_id AND runtime.companion_id = v_instance.companion_id;
  actor_id := COALESCE(v_turn.actor_id, v_instance.desired_lifecycle_actor_id);
  model_id := v_companion.model_id; persona := v_companion.persona;
  settings_revision := v_runtime.desired_settings_revision;
  skills_revision := v_companion.skills_available_revision;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'provider_id', connection.provider_id,
      'credential_generation', connection.credential_generation,
      'credential_version', connection.credential_version
    ) ORDER BY connection.provider_id), '[]'::jsonb), count(*)::integer,
    COALESCE(jsonb_agg(jsonb_build_object(
      'provider_id', connection.provider_id, 'auth_method', connection.auth_method,
      'credential_generation', connection.credential_generation,
      'credential_version', connection.credential_version, 'ciphertext', connection.ciphertext,
      'iv', connection.iv, 'auth_tag', connection.auth_tag, 'wrapped_dek', connection.wrapped_dek,
      'wrap_iv', connection.wrap_iv, 'wrap_auth_tag', connection.wrap_auth_tag, 'key_id', connection.key_id
    ) ORDER BY connection.provider_id), '[]'::jsonb)
  INTO provider_refs, v_provider_count, provider_material
  FROM public.companion_provider_connections connection
  WHERE connection.org_id = v_instance.org_id
    AND v_companion.provider_ids ? connection.provider_id;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'skill_id', skill.id, 'current_version_id', skill.current_version_id
    ) ORDER BY skill.id), '[]'::jsonb), count(*)::integer,
    COALESCE(jsonb_agg(jsonb_build_object(
      'skill_id', skill.id, 'slug', skill.slug, 'version_id', version.id,
      'version', version.version, 'checksum', version.checksum,
      'size_bytes', version.size_bytes, 'storage_path', version.storage_path
    ) ORDER BY skill.id), '[]'::jsonb)
  INTO skill_refs, v_skill_count, skill_material
  FROM public.skills skill
  JOIN public.skill_versions version
    ON version.org_id = skill.org_id AND version.skill_id = skill.id
   AND version.id = skill.current_version_id
  WHERE skill.org_id = v_instance.org_id AND v_companion.selected_skill_ids ? skill.id::text
    AND skill.archived_at IS NULL AND skill.validation = 'valid'
    AND (skill.scope = 'org' OR skill.creator_id = actor_id);

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'account_id', account.id, 'credential_generation', account.credential_generation,
      'credential_version', account.credential_version
    ) ORDER BY account.id), '[]'::jsonb), count(*)::integer,
    COALESCE(jsonb_agg(jsonb_build_object(
      'account_id', account.id, 'owner_id', account.owner_id, 'provider', account.provider,
      'label', account.label, 'transport', account.transport, 'account_config', account.account_config,
      'credential_generation', account.credential_generation, 'credential_version', account.credential_version,
      'ciphertext', account.ciphertext, 'iv', account.iv, 'auth_tag', account.auth_tag,
      'wrapped_dek', account.wrapped_dek, 'wrap_iv', account.wrap_iv,
      'wrap_auth_tag', account.wrap_auth_tag, 'key_id', account.key_id
    ) ORDER BY account.id), '[]'::jsonb)
  INTO mcp_refs, v_mcp_count, mcp_material
  FROM public.companion_mcp_accounts account
  WHERE account.org_id = v_instance.org_id
    AND v_companion.selected_mcp_account_ids ? account.id::text AND account.owner_id = actor_id;

  authorized := actor_id IS NOT NULL AND v_companion.id IS NOT NULL AND v_runtime.companion_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.memberships membership
      WHERE membership.org_id = v_instance.org_id AND membership.user_id = actor_id)
    AND (v_companion.owner_id = actor_id OR EXISTS (
      SELECT 1 FROM public.companion_workspace_access access
      WHERE access.org_id = v_instance.org_id AND access.companion_id = v_instance.companion_id
        AND access.role = 'editor'))
    AND jsonb_typeof(v_companion.provider_ids) = 'array'
    AND jsonb_array_length(v_companion.provider_ids) = 1 AND v_provider_count = 1
    AND model_id IS NOT NULL AND char_length(model_id) BETWEEN 1 AND 200
    AND model_id !~ E'[\n\r]'
    AND jsonb_typeof(v_companion.selected_skill_ids) = 'array'
    AND v_skill_count = jsonb_array_length(v_companion.selected_skill_ids)
    AND jsonb_typeof(v_companion.selected_mcp_account_ids) = 'array'
    AND v_mcp_count = jsonb_array_length(v_companion.selected_mcp_account_ids);

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', listed.id, 'slug', listed.slug, 'name', listed.name,
      'description', listed.description, 'selected', listed.selected
    ) ORDER BY listed.selected DESC, listed.slug), '[]'::jsonb)
  INTO v_skills FROM (
    SELECT skill.id, skill.slug, COALESCE(NULLIF(btrim(skill.display_name), ''), skill.slug) name,
      left(skill.description, 200) description,
      v_companion.selected_skill_ids ? skill.id::text selected
    FROM public.skills skill WHERE skill.org_id = v_instance.org_id
      AND skill.archived_at IS NULL AND skill.validation = 'valid'
      AND skill.current_version_id IS NOT NULL
      AND (v_companion.selected_skill_ids ? skill.id::text OR skill.scope = 'org'
        OR skill.creator_id = actor_id)
    ORDER BY selected DESC, skill.slug LIMIT 100
  ) listed;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', listed.id, 'label', listed.label, 'provider', listed.provider,
      'transport', listed.transport, 'selected', listed.selected
    ) ORDER BY listed.selected DESC, listed.provider, listed.label), '[]'::jsonb)
  INTO v_plugins FROM (
    SELECT account.id, account.label, account.provider, account.transport,
      v_companion.selected_mcp_account_ids ? account.id::text selected
    FROM public.companion_mcp_accounts account WHERE account.org_id = v_instance.org_id
      AND (v_companion.selected_mcp_account_ids ? account.id::text OR account.owner_id = actor_id)
    ORDER BY selected DESC, account.provider, account.label LIMIT 100
  ) listed;
  config_catalog := jsonb_build_object(
    'companion', jsonb_build_object('model_id', model_id,
      'provider_id', v_companion.provider_ids->>0, 'persona', persona),
    'skills', v_skills, 'plugins', v_plugins,
    'note', 'Use companion-control for changes. A change is active only after preparation completes.'
  );
  IF octet_length(provider_material::text) > 2097152
    OR octet_length(skill_material::text) > 2097152
    OR octet_length(mcp_material::text) > 4194304
    OR octet_length(config_catalog::text) > 262144 THEN
    RAISE EXCEPTION 'authorized preparation material exceeds the bounded executor contract'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.companion_v3_instances instance SET
    preparation_claim_token = gen_random_uuid(),
    preparation_claim_epoch = instance.preparation_claim_epoch + 1,
    preparation_gate_epoch = v_gate, preparation_executor_id = p_executor_id,
    preparation_claimed_at = v_now,
    preparation_expires_at = v_now + make_interval(secs => p_lease_seconds),
    preparation_actor_id = CASE WHEN authorized THEN actor_id ELSE NULL END,
    preparation_settings_revision = CASE WHEN authorized THEN settings_revision ELSE NULL END,
    preparation_skills_revision = CASE WHEN authorized THEN skills_revision ELSE NULL END,
    preparation_model_id = CASE WHEN authorized THEN model_id ELSE NULL END,
    preparation_provider_refs = CASE WHEN authorized THEN provider_refs ELSE NULL END,
    preparation_skill_refs = CASE WHEN authorized THEN skill_refs ELSE NULL END,
    preparation_mcp_refs = CASE WHEN authorized THEN mcp_refs ELSE NULL END,
    updated_at = v_now
  WHERE instance.org_id = v_instance.org_id AND instance.companion_id = v_instance.companion_id
  RETURNING instance.preparation_claim_token, instance.preparation_claim_epoch,
    instance.preparation_gate_epoch INTO claim_token, claim_epoch, gate_epoch;
  IF v_turn.id IS NOT NULL THEN
    UPDATE public.companion_v3_turns turn_row SET
      first_claimed_at = coalesce(turn_row.first_claimed_at, v_now),
      last_claimed_at = v_now,
      claim_count = turn_row.claim_count + 1,
      updated_at = v_now
    WHERE turn_row.id = v_turn.id;
  END IF;
  org_id := v_instance.org_id; companion_id := v_instance.companion_id;
  turn_id := v_turn.id; command_id := v_turn.command_id; work_kind := 'preparation';
  checkpoint := v_instance.preparation_checkpoint; box_idempotency_key := v_instance.box_idempotency_key;
  box_id := v_instance.box_id; created_at := v_instance.created_at; RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_runtime_claim_preparation(text,integer,integer) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_runtime_reauthorize_preparation(
  p_org_id uuid, p_companion_id uuid, p_claim_token uuid, p_claim_epoch bigint,
  p_gate_epoch bigint, p_executor_id text, p_lease_seconds integer, p_protocol integer
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = on AS $$
DECLARE v_now timestamptz := clock_timestamp(); v_instance public.companion_v3_instances%ROWTYPE;
  v_companion public.companions%ROWTYPE; v_runtime public.companion_runtime_instances%ROWTYPE;
  v_actor text; v_provider_refs jsonb; v_skill_refs jsonb; v_mcp_refs jsonb;
BEGIN
  IF p_protocol IS DISTINCT FROM 4 OR p_lease_seconds NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION 'invalid Runtime v3 preparation authorization' USING ERRCODE = '22023';
  END IF;
  SELECT instance.* INTO v_instance FROM public.companion_v3_instances instance
  JOIN public.companion_runtime_control control
    ON control.id = 'runtime-v2' AND control.enabled AND control.gate_epoch = p_gate_epoch
  WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id
    AND instance.preparation_claim_token = p_claim_token
    AND instance.preparation_claim_epoch = p_claim_epoch
    AND instance.preparation_gate_epoch = p_gate_epoch
    AND instance.preparation_executor_id = p_executor_id
    AND instance.preparation_expires_at > v_now FOR UPDATE OF instance;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT companion.* INTO v_companion FROM public.companions companion
  WHERE companion.org_id = p_org_id AND companion.id = p_companion_id;
  SELECT runtime.* INTO v_runtime FROM public.companion_runtime_instances runtime
  WHERE runtime.org_id = p_org_id AND runtime.companion_id = p_companion_id;
  SELECT queued.actor_id INTO v_actor FROM public.companion_v3_turns queued
  WHERE queued.org_id = p_org_id AND queued.companion_id = p_companion_id
    AND queued.lane = 'main' AND queued.state = 'queued'
  ORDER BY queued.queue_sequence, queued.id LIMIT 1;
  v_actor := COALESCE(v_actor, v_instance.desired_lifecycle_actor_id);
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'provider_id', connection.provider_id, 'credential_generation', connection.credential_generation,
    'credential_version', connection.credential_version) ORDER BY connection.provider_id), '[]'::jsonb)
  INTO v_provider_refs FROM public.companion_provider_connections connection
  WHERE connection.org_id = p_org_id AND v_companion.provider_ids ? connection.provider_id;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'skill_id', skill.id, 'current_version_id', skill.current_version_id) ORDER BY skill.id), '[]'::jsonb)
  INTO v_skill_refs FROM public.skills skill WHERE skill.org_id = p_org_id
    AND v_companion.selected_skill_ids ? skill.id::text AND skill.archived_at IS NULL
    AND skill.validation = 'valid' AND skill.current_version_id IS NOT NULL
    AND (skill.scope = 'org' OR skill.creator_id = v_actor);
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'account_id', account.id, 'credential_generation', account.credential_generation,
    'credential_version', account.credential_version) ORDER BY account.id), '[]'::jsonb)
  INTO v_mcp_refs FROM public.companion_mcp_accounts account
  WHERE account.org_id = p_org_id AND v_companion.selected_mcp_account_ids ? account.id::text
    AND account.owner_id = v_actor;
  IF v_actor IS NULL OR v_actor IS DISTINCT FROM v_instance.preparation_actor_id
    OR v_companion.id IS NULL OR v_runtime.companion_id IS NULL
    OR v_companion.model_id IS DISTINCT FROM v_instance.preparation_model_id
    OR v_runtime.desired_settings_revision IS DISTINCT FROM v_instance.preparation_settings_revision
    OR v_companion.skills_available_revision IS DISTINCT FROM v_instance.preparation_skills_revision
    OR v_provider_refs IS DISTINCT FROM v_instance.preparation_provider_refs
    OR v_skill_refs IS DISTINCT FROM v_instance.preparation_skill_refs
    OR v_mcp_refs IS DISTINCT FROM v_instance.preparation_mcp_refs
    OR jsonb_array_length(v_provider_refs) <> 1
    OR jsonb_array_length(v_skill_refs) <> jsonb_array_length(v_companion.selected_skill_ids)
    OR jsonb_array_length(v_mcp_refs) <> jsonb_array_length(v_companion.selected_mcp_account_ids)
    OR NOT EXISTS (SELECT 1 FROM public.memberships membership
      WHERE membership.org_id = p_org_id AND membership.user_id = v_actor)
    OR NOT (v_companion.owner_id = v_actor OR EXISTS (
      SELECT 1 FROM public.companion_workspace_access access
      WHERE access.org_id = p_org_id AND access.companion_id = p_companion_id
        AND access.role = 'editor')) THEN
    RETURN false;
  END IF;
  UPDATE public.companion_v3_instances instance
  SET preparation_expires_at = v_now + make_interval(secs => p_lease_seconds), updated_at = v_now
  WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id
    AND instance.preparation_claim_token = p_claim_token
    AND instance.preparation_claim_epoch = p_claim_epoch
    AND instance.preparation_expires_at > v_now;
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_runtime_reauthorize_preparation(
  uuid,uuid,uuid,bigint,bigint,text,integer,integer
) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_runtime_checkpoint_preparation(
  p_org_id uuid, p_companion_id uuid, p_claim_token uuid, p_claim_epoch bigint,
  p_gate_epoch bigint, p_expected text, p_next text, p_box_id text,
  p_pi_invocation_id text, p_disk_layout_version integer,
  p_applied_settings_revision bigint, p_applied_skills_revision integer,
  p_skills_digest text, p_material_expires_at timestamptz, p_protocol integer
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = on AS $$
DECLARE v_now timestamptz := clock_timestamp();
BEGIN
  IF p_protocol IS DISTINCT FROM 4 OR NOT (
      (p_expected = 'pending' AND p_next = 'box_created' AND p_box_id IS NOT NULL
        AND p_disk_layout_version IS NULL)
      OR (p_expected = 'box_created' AND p_next = 'box_ready' AND p_disk_layout_version IS NULL)
      OR (p_expected = 'box_ready' AND p_next = 'staged'
        AND p_disk_layout_version >= 1 AND p_applied_settings_revision >= 1
        AND p_applied_skills_revision >= 1 AND p_skills_digest ~ '^[0-9a-f]{64}$'
        AND p_material_expires_at > v_now + interval '2 hours 5 minutes')
      OR (p_expected = 'staged' AND p_next = 'prepared'
        AND p_pi_invocation_id IS NOT NULL AND p_disk_layout_version IS NULL)
    ) THEN RAISE EXCEPTION 'invalid Runtime v3 preparation checkpoint' USING ERRCODE = '22023';
  END IF;
  IF p_next IN ('staged', 'prepared') AND NOT public.companion_v3_runtime_reauthorize_preparation(
    p_org_id, p_companion_id, p_claim_token, p_claim_epoch, p_gate_epoch,
    (SELECT preparation_executor_id FROM public.companion_v3_instances
      WHERE org_id = p_org_id AND companion_id = p_companion_id), 300, 4
  ) THEN RETURN false; END IF;
  UPDATE public.companion_v3_instances instance SET
    preparation_checkpoint = p_next,
    box_id = CASE WHEN p_next = 'box_created' THEN p_box_id ELSE instance.box_id END,
    box_ready_at = CASE WHEN p_next = 'box_ready' THEN v_now ELSE instance.box_ready_at END,
    staging_completed_at = CASE WHEN p_next = 'staged' THEN v_now ELSE instance.staging_completed_at END,
    prepared_disk_layout_version = CASE WHEN p_next = 'staged' THEN p_disk_layout_version
      ELSE instance.prepared_disk_layout_version END,
    prepared_skills_digest = CASE WHEN p_next = 'staged' THEN p_skills_digest
      ELSE instance.prepared_skills_digest END,
    prepared_material_expires_at = CASE WHEN p_next = 'staged' THEN p_material_expires_at
      ELSE instance.prepared_material_expires_at END,
    pi_invocation_id = CASE WHEN p_next = 'prepared' THEN p_pi_invocation_id ELSE instance.pi_invocation_id END,
    prepared_at = CASE WHEN p_next = 'prepared' THEN v_now ELSE instance.prepared_at END,
    preparation_error_code = NULL, preparation_error_message = NULL,
    preparation_available_at = v_now, preparation_claim_token = NULL,
    preparation_gate_epoch = NULL, preparation_executor_id = NULL,
    preparation_claimed_at = NULL, preparation_expires_at = NULL, updated_at = v_now
  FROM public.companion_runtime_control control
  WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id
    AND instance.preparation_checkpoint = p_expected
    AND instance.preparation_claim_token = p_claim_token
    AND instance.preparation_claim_epoch = p_claim_epoch
    AND instance.preparation_gate_epoch = p_gate_epoch
    AND instance.preparation_expires_at > v_now
    AND (p_next <> 'staged' OR (
      instance.preparation_settings_revision = p_applied_settings_revision
      AND instance.preparation_skills_revision = p_applied_skills_revision))
    AND control.id = 'runtime-v2' AND control.enabled AND control.gate_epoch = p_gate_epoch;
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_runtime_checkpoint_preparation(
  uuid,uuid,uuid,bigint,bigint,text,text,text,text,integer,bigint,integer,text,timestamptz,integer
) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_runtime_defer_preparation(
  p_org_id uuid, p_companion_id uuid, p_claim_token uuid, p_claim_epoch bigint,
  p_gate_epoch bigint, p_delay_seconds integer, p_code text, p_message text, p_protocol integer
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = on AS $$
DECLARE v_now timestamptz := clock_timestamp();
BEGIN
  IF p_protocol IS DISTINCT FROM 4 OR p_delay_seconds NOT BETWEEN 1 AND 300
    OR (p_code IS NULL) <> (p_message IS NULL)
    OR (p_code IS NOT NULL AND (p_code !~ '^[a-z][a-z0-9_]{0,63}$'
      OR char_length(p_message) NOT BETWEEN 1 AND 500 OR p_message ~ E'[\n\r]')) THEN
    RAISE EXCEPTION 'invalid Runtime v3 preparation deferral' USING ERRCODE = '22023';
  END IF;
  UPDATE public.companion_v3_instances instance SET
    preparation_available_at = v_now + make_interval(secs => p_delay_seconds),
    preparation_attempt_count = instance.preparation_attempt_count
      + CASE WHEN p_code IS NULL THEN 0 ELSE 1 END,
    preparation_error_code = p_code, preparation_error_message = p_message,
    preparation_claim_token = NULL, preparation_gate_epoch = NULL,
    preparation_executor_id = NULL, preparation_claimed_at = NULL,
    preparation_expires_at = NULL, updated_at = v_now
  FROM public.companion_runtime_control control
  WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id
    AND instance.preparation_claim_token = p_claim_token
    AND instance.preparation_claim_epoch = p_claim_epoch
    AND instance.preparation_gate_epoch = p_gate_epoch
    AND instance.preparation_expires_at > v_now
    AND control.id = 'runtime-v2' AND control.enabled AND control.gate_epoch = p_gate_epoch;
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_runtime_defer_preparation(
  uuid,uuid,uuid,bigint,bigint,integer,text,text,integer
) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_runtime_mint_preparation_credentials(
  p_org_id uuid, p_companion_id uuid, p_claim_token uuid, p_claim_epoch bigint,
  p_gate_epoch bigint, p_executor_id text, p_lease_seconds integer, p_protocol integer
)
RETURNS TABLE(hub_token text, mcp_broker_token text, control_token text, expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = on AS $$
DECLARE
  v_now timestamptz := clock_timestamp(); v_expires timestamptz := v_now + interval '6 hours';
  v_instance public.companion_v3_instances%ROWTYPE; v_hub_id uuid := gen_random_uuid();
  v_runtime public.companion_runtime_instances%ROWTYPE;
  v_mcp_id uuid; v_control_id uuid := gen_random_uuid(); v_secret text;
BEGIN
  IF NOT public.companion_v3_runtime_reauthorize_preparation(
    p_org_id, p_companion_id, p_claim_token, p_claim_epoch, p_gate_epoch,
    p_executor_id, p_lease_seconds, p_protocol
  ) THEN RETURN; END IF;
  SELECT instance.* INTO STRICT v_instance FROM public.companion_v3_instances instance
  WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id FOR UPDATE;
  SELECT instance.* INTO STRICT v_runtime FROM public.companion_runtime_instances instance
  WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id FOR UPDATE;

  v_secret := left(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 48);
  hub_token := 'cmp_pat_' || v_secret;
  INSERT INTO public.api_tokens(
    id, org_id, user_id, name, token_prefix, token_hash, scopes,
    source_type, source_agent_id, target_workspace_id, expires_at
  ) VALUES (
    v_hub_id, p_org_id, v_instance.preparation_actor_id, 'Companion Skills Hub',
    left(hub_token, 14), encode(sha256(convert_to(hub_token, 'UTF8')), 'hex'),
    jsonb_build_array('skills:read','skills:write','secrets:read','database:read','database:write'),
    'companion', p_companion_id::text, NULL, v_expires
  );

  IF jsonb_array_length(v_instance.preparation_mcp_refs) > 0 THEN
    v_mcp_id := gen_random_uuid();
    v_secret := left(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 48);
    mcp_broker_token := 'cmp_mcp_' || v_secret;
    INSERT INTO public.companion_mcp_broker_tokens(
      id, org_id, companion_id, actor_id, token_prefix, token_hash, account_refs, expires_at
    ) VALUES (
      v_mcp_id, p_org_id, p_companion_id, v_instance.preparation_actor_id,
      left(mcp_broker_token, 14), encode(sha256(convert_to(mcp_broker_token, 'UTF8')), 'hex'),
      v_instance.preparation_mcp_refs, v_expires
    );
  ELSE mcp_broker_token := NULL; END IF;

  v_secret := left(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 48);
  control_token := 'cmp_ctl_' || v_secret;
  INSERT INTO public.companion_control_tokens(
    id, org_id, companion_id, staged_actor_id, token_prefix, token_hash, expires_at
  ) VALUES (
    v_control_id, p_org_id, p_companion_id, v_instance.preparation_actor_id,
    left(control_token, 14), encode(sha256(convert_to(control_token, 'UTF8')), 'hex'), v_expires
  );

  UPDATE public.api_tokens SET revoked_at = v_now
  WHERE id = v_instance.hub_token_id AND revoked_at IS NULL;
  UPDATE public.companion_mcp_broker_tokens SET revoked_at = v_now
  WHERE id IN (v_instance.mcp_broker_token_id, v_runtime.mcp_broker_token_id)
    AND revoked_at IS NULL;
  UPDATE public.companion_control_tokens SET revoked_at = v_now
  WHERE id IN (v_instance.control_token_id, v_runtime.control_token_id)
    AND revoked_at IS NULL;
  UPDATE public.companion_runtime_instances SET
    mcp_broker_token_id = v_mcp_id, control_token_id = v_control_id, updated_at = v_now
  WHERE org_id = p_org_id AND companion_id = p_companion_id
    AND retirement_state = 'active';
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE public.companion_v3_instances SET hub_token_id = v_hub_id,
    mcp_broker_token_id = v_mcp_id, control_token_id = v_control_id, updated_at = v_now
  WHERE org_id = p_org_id AND companion_id = p_companion_id
    AND preparation_claim_token = p_claim_token AND preparation_claim_epoch = p_claim_epoch;
  IF NOT FOUND THEN RETURN; END IF;
  expires_at := v_expires; RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_runtime_mint_preparation_credentials(
  uuid,uuid,uuid,bigint,bigint,text,integer,integer
) FROM PUBLIC;
--> statement-breakpoint

DO $companion_v3_complete_preparation_acl$
DECLARE v_source oid := pg_catalog.to_regprocedure(
  'public.companion_v3_runtime_claim_warm(text,public.companion_v3_lane,integer,integer)'
); v_grantee oid; v_role name;
BEGIN
  FOR v_grantee IN SELECT DISTINCT acl.grantee
    FROM pg_catalog.pg_proc source_proc
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(source_proc.proacl, pg_catalog.acldefault('f', source_proc.proowner))) acl
    WHERE source_proc.oid = v_source AND acl.privilege_type = 'EXECUTE'
      AND acl.grantee NOT IN (source_proc.proowner, 0)
  LOOP
    SELECT role_row.rolname INTO STRICT v_role FROM pg_catalog.pg_roles role_row
    WHERE role_row.oid = v_grantee;
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_v3_runtime_claim_preparation(text,integer,integer) TO %I', v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_v3_runtime_checkpoint_preparation(uuid,uuid,uuid,bigint,bigint,text,text,text,text,integer,bigint,integer,text,timestamp with time zone,integer) TO %I', v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_v3_runtime_defer_preparation(uuid,uuid,uuid,bigint,bigint,integer,text,text,integer) TO %I', v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_v3_runtime_reauthorize_preparation(uuid,uuid,uuid,bigint,bigint,text,integer,integer) TO %I', v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_v3_runtime_mint_preparation_credentials(uuid,uuid,uuid,bigint,bigint,text,integer,integer) TO %I', v_role);
  END LOOP;
END $companion_v3_complete_preparation_acl$;
