-- Runtime v3 contraction. Runtime v2 remains readable only by the offline purge command; normal
-- API/runtime roles lose every v2 mutation/claim capability before v3-only entry points are added.

-- Runtime v3 initially shared projection tables with the v2 executor and temporarily entered its
-- diagnostic mutation fence. At the final contraction there is no mixed executor rollout left:
-- remove that fence and erase its GUC shim from every retained v3 function. Historical owner-only
-- purge functions may still manipulate the retired aggregate, but no current v3 function presents
-- itself as protocol 2.
DROP TRIGGER companions_runtime_v2_mutation_fence ON public.companions;
DROP TRIGGER companion_workspace_access_runtime_v2_mutation_fence ON public.companion_workspace_access;
DROP TRIGGER companion_member_state_runtime_v2_mutation_fence ON public.companion_member_state;
DROP TRIGGER companion_threads_runtime_v2_mutation_fence ON public.companion_threads;
DROP TRIGGER companion_transcript_entries_runtime_v2_mutation_fence ON public.companion_transcript_entries;
DROP TRIGGER companions_require_runtime_v2_instance ON public.companions;
DROP FUNCTION public.companion_runtime_require_v2_mutation();
DROP FUNCTION public.companion_runtime_assert_v2_mutation();
DROP FUNCTION public.companion_runtime_require_instance_at_commit();
DROP TRIGGER companion_v3_settle_manual_restart ON public.companion_v3_instances;
DROP FUNCTION public.companion_v3_settle_manual_restart();
DROP TRIGGER companion_v3_cancel_deferred_manual_restart
  ON public.companion_deferred_pi_restarts;
DROP FUNCTION public.companion_v3_cancel_deferred_manual_restart();
--> statement-breakpoint

ALTER TABLE public.companion_v3_instances
  ADD COLUMN desired_settings_revision bigint NOT NULL DEFAULT 1;
ALTER TABLE public.companion_v3_instances
  ADD CONSTRAINT companion_v3_instances_settings_revision_check
  CHECK(desired_settings_revision>=1);
--> statement-breakpoint

DO $runtime_v3_remove_protocol_2_shim$
DECLARE v_function regprocedure;v_definition text;
BEGIN
  FOR v_function IN
    SELECT procedure.oid::regprocedure
    FROM pg_catalog.pg_proc procedure
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid=procedure.pronamespace
    WHERE namespace.nspname='public'
      AND (procedure.proname LIKE 'companion_v3_%'
        OR procedure.proname IN ('companion_runtime_gate_status','companion_runtime_disable',
          'companion_runtime_enable','companion_runtime_authorize_desktop'))
      AND (procedure.prosrc LIKE '%app.companion_runtime_protocol%'
        OR procedure.prosrc LIKE '%runtime-v2%'
        OR procedure.proname IN ('companion_v3_api_enqueue_warm_turn_v5',
          'companion_v3_runtime_mint_preparation_credentials',
          'companion_v3_routine_preparation_matches'))
  LOOP
    v_definition:=pg_catalog.pg_get_functiondef(v_function);
    v_definition:=pg_catalog.regexp_replace(v_definition,
      E'\\s*v_previous_protocol\\s*:=\\s*pg_catalog\\.current_setting\\(\\s*''app\\.companion_runtime_protocol''\\s*,\\s*true\\s*\\)\\s*;',E'\n','g');
    v_definition:=pg_catalog.regexp_replace(v_definition,
      E'\\s*PERFORM\\s+pg_catalog\\.set_config\\(\\s*''app\\.companion_runtime_protocol''\\s*,\\s*''2''\\s*,\\s*true\\s*\\)\\s*;',E'\n','g');
    v_definition:=pg_catalog.regexp_replace(v_definition,
      E'\\s*PERFORM\\s+pg_catalog\\.set_config\\(\\s*''app\\.companion_runtime_protocol''\\s*,\\s*coalesce\\(v_previous_protocol\\s*,\\s*''''\\s*\\)\\s*,\\s*true\\s*\\)\\s*;',E'\n','g');
    v_definition:=pg_catalog.replace(v_definition,'''runtime-v2''','''runtime-v3''');
    v_definition:=pg_catalog.replace(v_definition,
      'public.companion_runtime_instances','public.companion_v3_instances');
    v_definition:=pg_catalog.replace(v_definition,
      'retirement_state = ''active''','desired_lifecycle <> ''delete''');
    v_definition:=pg_catalog.regexp_replace(v_definition,
      E'\\s*IF EXISTS \\(SELECT 1 FROM public\\.companion_turns legacy_turn\\s+WHERE legacy_turn\\.org_id = p_org_id AND legacy_turn\\.companion_id = p_companion_id\\s+AND legacy_turn\\.client_message_id = p_client_message_id\\) THEN RETURN; END IF;',
      E'\n','g');
    EXECUTE v_definition;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc procedure
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid=procedure.pronamespace
    WHERE namespace.nspname='public' AND procedure.proname LIKE 'companion_v3_%'
      AND procedure.prosrc LIKE '%app.companion_runtime_protocol%'
  ) THEN
    RAISE EXCEPTION 'Runtime v3 still depends on the retired protocol-2 mutation shim'
      USING ERRCODE='55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc procedure
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid=procedure.pronamespace
    WHERE namespace.nspname='public' AND procedure.proname LIKE 'companion_v3_%'
      AND (procedure.prosrc LIKE '%public.companion_runtime_instances%'
        OR procedure.prosrc LIKE '%public.companion_turns%')
  ) THEN
    RAISE EXCEPTION 'Runtime v3 still depends on a retired runtime projection'
      USING ERRCODE='55000';
  END IF;
END $runtime_v3_remove_protocol_2_shim$;
--> statement-breakpoint

-- The kill switch survives the cutover, but its durable singleton identity no longer advertises
-- the retired executor. All current v3 and gate functions above were rewritten in the same
-- transaction, so feature-off remains continuous and fail-closed.
ALTER TABLE public.companion_runtime_control
  DROP CONSTRAINT companion_runtime_control_singleton_check;
UPDATE public.companion_runtime_control SET id='runtime-v3' WHERE id='runtime-v2';
ALTER TABLE public.companion_runtime_control ALTER COLUMN id SET DEFAULT 'runtime-v3';
ALTER TABLE public.companion_runtime_control
  ADD CONSTRAINT companion_runtime_control_singleton_check CHECK(id='runtime-v3');
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.companion_v3_runtime_finalize_delete(
  p_org_id uuid,p_companion_id uuid,p_claim_token uuid,p_claim_epoch bigint,
  p_gate_epoch bigint,p_protocol integer
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_now timestamptz:=clock_timestamp();v_actor text;v_request uuid;
BEGIN
  IF p_protocol<>5 THEN
    RAISE EXCEPTION 'Runtime v3 lifecycle protocol is required' USING ERRCODE='42501';END IF;
  SELECT instance.desired_lifecycle_actor_id,instance.desired_lifecycle_request_id
  INTO v_actor,v_request FROM public.companion_v3_instances instance
  JOIN public.companion_runtime_control control ON control.id='runtime-v3'
    AND control.enabled AND control.gate_epoch=p_gate_epoch
  WHERE instance.org_id=p_org_id AND instance.companion_id=p_companion_id
    AND instance.desired_lifecycle='delete'
    AND instance.lifecycle_state IN ('delete_requested','delete_dispatched','waiting_deleted')
    AND instance.lifecycle_claim_token=p_claim_token
    AND instance.lifecycle_claim_epoch=p_claim_epoch
    AND instance.lifecycle_gate_epoch=p_gate_epoch AND instance.lifecycle_expires_at>v_now
  FOR UPDATE OF instance;
  IF NOT FOUND THEN RETURN false;END IF;
  INSERT INTO public.audit_log(org_id,actor_id,action,target_type,target_id,metadata)
  VALUES(p_org_id,CASE WHEN EXISTS(SELECT 1 FROM public."user" member WHERE member.id=v_actor)
      THEN v_actor ELSE NULL END,'companion.deleted','companion',p_companion_id::text,
    jsonb_build_object('request_id',v_request::text,'provider_absence',true));
  DELETE FROM public.companions companion
  WHERE companion.org_id=p_org_id AND companion.id=p_companion_id;
  RETURN FOUND;
END $$;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_release_recovery_reservation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
BEGIN
  IF OLD.turn_id IS NOT NULL AND NEW.turn_id IS NULL THEN
    UPDATE public.companion_v3_instances instance SET
      recovery_context_turn_id=NULL,updated_at=clock_timestamp()
    WHERE instance.org_id=OLD.org_id AND instance.companion_id=OLD.companion_id
      AND instance.recovery_context IS NOT NULL
      AND instance.recovery_context_turn_id=OLD.turn_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER companion_v3_release_recovery_reservation
AFTER UPDATE OF turn_id ON public.companion_v3_lane_leases
FOR EACH ROW EXECUTE FUNCTION public.companion_v3_release_recovery_reservation();
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_api_request_pi_recycle(
  p_org_id uuid,p_companion_id uuid,p_request_id uuid
) RETURNS TABLE(intent public.companion_v3_lifecycle_intent,revision bigint)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_actor text:=public.companion_api_actor(p_org_id);
  v_instance public.companion_v3_instances%ROWTYPE;
  v_active public.companion_v3_turns%ROWTYPE;
  v_existing public.companion_v3_lifecycle_requests%ROWTYPE;v_revision bigint;
BEGIN
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'Runtime v3 Pi recycle request id is required' USING ERRCODE='22023';END IF;
  PERFORM public.companion_api_require_access(p_org_id,p_companion_id,'editor');
  SELECT * INTO STRICT v_instance FROM public.companion_v3_instances instance
    WHERE instance.org_id=p_org_id AND instance.companion_id=p_companion_id FOR UPDATE;
  SELECT * INTO v_existing FROM public.companion_v3_lifecycle_requests request
    WHERE request.org_id=p_org_id AND request.companion_id=p_companion_id
      AND request.request_id=p_request_id;
  IF FOUND THEN
    IF v_existing.actor_id IS DISTINCT FROM v_actor OR v_existing.intent<>'recycle_pi' THEN
      RAISE EXCEPTION 'request_id was reused with different Runtime v3 lifecycle intent'
        USING ERRCODE='23505',CONSTRAINT='companion_v3_lifecycle_requests_pk';END IF;
    RETURN QUERY SELECT v_existing.intent,v_existing.revision;RETURN;
  END IF;
  v_revision:=v_instance.desired_lifecycle_revision+1;
  SELECT * INTO v_active FROM public.companion_v3_turns turn_row
  WHERE turn_row.org_id=p_org_id AND turn_row.companion_id=p_companion_id
    AND turn_row.lane='main' AND turn_row.state IN ('admitted','running','needs_input')
    AND turn_row.admission_state='accepted' AND turn_row.pi_invocation_id IS NOT NULL
  ORDER BY turn_row.queue_sequence,turn_row.id LIMIT 1 FOR UPDATE;
  IF FOUND AND v_instance.pi_recycle_checkpoint IS NULL THEN
    INSERT INTO public.companion_deferred_pi_restarts(
      id,org_id,companion_id,source_turn_id,source_attempt_id,source_pi_invocation_id,actor_id)
    VALUES(p_request_id,p_org_id,p_companion_id,v_active.id,v_active.id,
      v_active.pi_invocation_id,v_actor);
    UPDATE public.companion_v3_instances instance SET
      desired_lifecycle_revision=v_revision,desired_lifecycle_actor_id=v_actor,
      desired_lifecycle_request_id=p_request_id,updated_at=clock_timestamp()
    WHERE instance.org_id=p_org_id AND instance.companion_id=p_companion_id;
  ELSIF v_instance.pi_recycle_checkpoint IS NULL AND v_instance.pi_invocation_id IS NOT NULL THEN
    PERFORM public.companion_v3_invalidate_preparation(p_org_id,p_companion_id);
    UPDATE public.companion_v3_instances instance SET
      desired_lifecycle='prepare',desired_lifecycle_revision=v_revision,
      desired_lifecycle_actor_id=v_actor,desired_lifecycle_request_id=p_request_id,
      pi_recycle_checkpoint='terminate',recycle_pi_invocation_id=v_instance.pi_invocation_id,
      recovery_turn_id=p_request_id,recovery_context=NULL,recovery_context_sha256=NULL,
      recovery_context_turn_id=NULL,preparation_checkpoint='box_ready',
      preparation_available_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE instance.org_id=p_org_id AND instance.companion_id=p_companion_id;
  ELSE
    UPDATE public.companion_v3_instances instance SET
      desired_lifecycle_revision=v_revision,desired_lifecycle_actor_id=v_actor,
      desired_lifecycle_request_id=p_request_id,updated_at=clock_timestamp()
    WHERE instance.org_id=p_org_id AND instance.companion_id=p_companion_id;
  END IF;
  INSERT INTO public.companion_v3_lifecycle_requests(
    org_id,companion_id,request_id,actor_id,intent,revision)
  VALUES(p_org_id,p_companion_id,p_request_id,v_actor,'recycle_pi',v_revision);
  RETURN QUERY SELECT 'recycle_pi'::public.companion_v3_lifecycle_intent,v_revision;
END $$;
--> statement-breakpoint

-- Create the aggregate directly on the v3 durable instance. The prior tracer bullet delegated the
-- common validation to companion_api_create_companion, which also created a v2 runtime projection;
-- that bridge is forbidden after contraction.
CREATE OR REPLACE FUNCTION public.companion_v3_api_create_companion(
  p_org_id uuid,p_name text,p_persona text,p_provider_id text,p_model_id text,
  p_selected_skill_ids jsonb,p_can_write_skills boolean,p_selected_mcp_account_ids jsonb,
  p_source_companion_id uuid DEFAULT NULL,p_icon_shape smallint DEFAULT 1,
  p_icon_mouth smallint DEFAULT 1,p_icon_accessory smallint DEFAULT 1,p_icon_color smallint DEFAULT 2
) RETURNS TABLE(companion_id uuid,desired_settings_revision bigint,skills_revision integer,
  created_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_actor text:=public.companion_api_actor(p_org_id);v_id uuid:=gen_random_uuid();
  v_now timestamptz:=clock_timestamp();
BEGIN
  IF p_name IS NULL OR char_length(btrim(p_name)) NOT BETWEEN 1 AND 120
    OR (p_persona IS NOT NULL AND char_length(p_persona)>280)
    OR (p_provider_id IS NOT NULL AND p_provider_id!~'^[a-z][a-z0-9-]{0,62}$')
    OR (p_model_id IS NOT NULL AND (char_length(p_model_id) NOT BETWEEN 1 AND 200
      OR p_model_id~E'[\n\r]')) OR p_can_write_skills IS NULL
    OR p_icon_shape IS NULL OR p_icon_shape NOT BETWEEN 0 AND 7
    OR p_icon_mouth IS NULL OR p_icon_mouth NOT BETWEEN 0 AND 4
    OR p_icon_accessory IS NULL OR p_icon_accessory NOT BETWEEN 0 AND 6
    OR p_icon_color IS NULL OR p_icon_color NOT BETWEEN 0 AND 10 THEN
    RAISE EXCEPTION 'invalid Companion create arguments' USING ERRCODE='22023';
  END IF;
  IF p_provider_id IS NOT NULL AND NOT EXISTS(SELECT 1
    FROM public.companion_provider_connections connection
    WHERE connection.org_id=p_org_id AND connection.provider_id=p_provider_id) THEN
    RAISE EXCEPTION 'Companion provider is not connected' USING ERRCODE='22023';
  END IF;
  IF p_source_companion_id IS NOT NULL THEN
    PERFORM public.companion_api_require_access(p_org_id,p_source_companion_id,'owner');
  END IF;
  PERFORM public.companion_api_validate_resource_selection(p_org_id,
    COALESCE(p_selected_skill_ids,'[]'::jsonb),'[]'::jsonb,
    COALESCE(p_selected_mcp_account_ids,'[]'::jsonb),'[]'::jsonb);
  INSERT INTO public.companions(id,org_id,owner_id,name,persona,icon_shape,icon_mouth,
    icon_accessory,icon_color,model_id,selected_skill_ids,can_write_skills,
    selected_mcp_account_ids,provider_ids,created_at,updated_at)
  VALUES(v_id,p_org_id,v_actor,btrim(p_name),NULLIF(btrim(p_persona),''),p_icon_shape,
    p_icon_mouth,p_icon_accessory,p_icon_color,p_model_id,
    COALESCE(p_selected_skill_ids,'[]'::jsonb),p_can_write_skills,
    COALESCE(p_selected_mcp_account_ids,'[]'::jsonb),
    CASE WHEN p_provider_id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(p_provider_id) END,
    v_now,v_now);
  INSERT INTO public.companion_v3_instances(org_id,companion_id,desired_lifecycle_actor_id,
    created_at,updated_at) VALUES(p_org_id,v_id,v_actor,v_now,v_now);
  INSERT INTO public.companion_v3_lane_leases(org_id,companion_id,lane)
    VALUES(p_org_id,v_id,'main'),(p_org_id,v_id,'background');
  INSERT INTO public.companion_threads(org_id,companion_id) VALUES(p_org_id,v_id);
  IF p_source_companion_id IS NOT NULL THEN
    INSERT INTO public.audit_log(org_id,actor_id,action,target_type,target_id,metadata)
    VALUES(p_org_id,v_actor,'companion.duplicated','companion',v_id::text,
      jsonb_build_object('source_companion_id',p_source_companion_id));
  END IF;
  RETURN QUERY SELECT v_id,1::bigint,1,v_now;
END $$;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_api_update_companion(
  p_org_id uuid,p_companion_id uuid,p_patch jsonb
) RETURNS TABLE(companion_id uuid,desired_settings_revision bigint,skills_revision integer,
  settings_changed boolean,skills_changed boolean,updated_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_actor text:=public.companion_api_actor(p_org_id);
  v_companion public.companions%ROWTYPE;v_instance public.companion_v3_instances%ROWTYPE;
  v_name text;v_persona text;v_provider text;v_model text;v_skills jsonb;v_mcp jsonb;
  v_can_write boolean;v_shape smallint;v_mouth smallint;v_accessory smallint;v_color smallint;
  v_settings_changed boolean;v_skills_changed boolean;v_now timestamptz:=clock_timestamp();
BEGIN
  PERFORM public.companion_api_require_access(p_org_id,p_companion_id,'editor');
  IF p_patch IS NULL OR jsonb_typeof(p_patch)<>'object' OR p_patch='{}'::jsonb OR EXISTS(
    SELECT 1 FROM jsonb_object_keys(p_patch) key
    WHERE key NOT IN('name','persona','provider_id','model_id','selected_skill_ids',
      'can_write_skills','selected_mcp_account_ids','icon')) THEN
    RAISE EXCEPTION 'invalid Companion settings patch' USING ERRCODE='22023';
  END IF;
  SELECT * INTO STRICT v_instance FROM public.companion_v3_instances instance
    WHERE instance.org_id=p_org_id AND instance.companion_id=p_companion_id FOR UPDATE;
  IF v_instance.desired_lifecycle='delete' THEN
    RAISE EXCEPTION 'deleted Companion settings cannot change' USING ERRCODE='55000';
  END IF;
  SELECT * INTO STRICT v_companion FROM public.companions companion
    WHERE companion.org_id=p_org_id AND companion.id=p_companion_id FOR UPDATE;
  IF p_patch?'name' AND (jsonb_typeof(p_patch->'name')<>'string'
    OR char_length(btrim(p_patch->>'name')) NOT BETWEEN 1 AND 120) THEN
    RAISE EXCEPTION 'invalid Companion name' USING ERRCODE='22023';END IF;
  IF p_patch?'persona' AND NOT(jsonb_typeof(p_patch->'persona')='null' OR
    jsonb_typeof(p_patch->'persona')='string' AND char_length(p_patch->>'persona')<=280) THEN
    RAISE EXCEPTION 'invalid Companion persona' USING ERRCODE='22023';END IF;
  IF p_patch?'provider_id' AND (jsonb_typeof(p_patch->'provider_id')<>'string'
    OR (p_patch->>'provider_id')!~'^[a-z][a-z0-9-]{0,62}$') THEN
    RAISE EXCEPTION 'invalid Companion provider' USING ERRCODE='22023';END IF;
  IF p_patch?'model_id' AND (jsonb_typeof(p_patch->'model_id')<>'string'
    OR char_length(p_patch->>'model_id') NOT BETWEEN 1 AND 200
    OR (p_patch->>'model_id')~E'[\n\r]') THEN
    RAISE EXCEPTION 'invalid Companion model' USING ERRCODE='22023';END IF;
  IF p_patch?'selected_skill_ids' AND jsonb_typeof(p_patch->'selected_skill_ids')<>'array' THEN
    RAISE EXCEPTION 'invalid Companion Skill selection' USING ERRCODE='22023';END IF;
  IF p_patch?'selected_mcp_account_ids'
    AND jsonb_typeof(p_patch->'selected_mcp_account_ids')<>'array' THEN
    RAISE EXCEPTION 'invalid Companion MCP selection' USING ERRCODE='22023';END IF;
  IF p_patch?'can_write_skills' AND jsonb_typeof(p_patch->'can_write_skills')<>'boolean' THEN
    RAISE EXCEPTION 'invalid Companion Skills write setting' USING ERRCODE='22023';END IF;
  IF p_patch?'icon' THEN
    IF jsonb_typeof(p_patch->'icon')<>'object' OR EXISTS(SELECT 1
      FROM jsonb_object_keys(p_patch->'icon') key
      WHERE key NOT IN('shape','mouth','accessory','color')) OR
      (NOT (p_patch->'icon')?'shape' AND NOT (p_patch->'icon')?'mouth'
        AND NOT (p_patch->'icon')?'accessory' AND NOT (p_patch->'icon')?'color') THEN
      RAISE EXCEPTION 'invalid Companion icon patch' USING ERRCODE='22023';END IF;
    IF (p_patch->'icon')?'shape' AND (jsonb_typeof(p_patch->'icon'->'shape')<>'number'
      OR (p_patch->'icon'->>'shape')!~'^[0-9]+$'
      OR (p_patch->'icon'->>'shape')::numeric NOT BETWEEN 0 AND 7) THEN
      RAISE EXCEPTION 'invalid Companion icon shape' USING ERRCODE='22023';END IF;
    IF (p_patch->'icon')?'mouth' AND (jsonb_typeof(p_patch->'icon'->'mouth')<>'number'
      OR (p_patch->'icon'->>'mouth')!~'^[0-9]+$'
      OR (p_patch->'icon'->>'mouth')::numeric NOT BETWEEN 0 AND 4) THEN
      RAISE EXCEPTION 'invalid Companion icon mouth' USING ERRCODE='22023';END IF;
    IF (p_patch->'icon')?'accessory' AND (jsonb_typeof(p_patch->'icon'->'accessory')<>'number'
      OR (p_patch->'icon'->>'accessory')!~'^[0-9]+$'
      OR (p_patch->'icon'->>'accessory')::numeric NOT BETWEEN 0 AND 6) THEN
      RAISE EXCEPTION 'invalid Companion icon accessory' USING ERRCODE='22023';END IF;
    IF (p_patch->'icon')?'color' AND (jsonb_typeof(p_patch->'icon'->'color')<>'number'
      OR (p_patch->'icon'->>'color')!~'^[0-9]+$'
      OR (p_patch->'icon'->>'color')::numeric NOT BETWEEN 0 AND 10) THEN
      RAISE EXCEPTION 'invalid Companion icon color' USING ERRCODE='22023';END IF;
  END IF;
  v_name:=CASE WHEN p_patch?'name' THEN btrim(p_patch->>'name') ELSE v_companion.name END;
  v_persona:=CASE WHEN p_patch?'persona' THEN NULLIF(btrim(p_patch->>'persona'),'')
    ELSE v_companion.persona END;
  v_provider:=CASE WHEN p_patch?'provider_id' THEN p_patch->>'provider_id'
    ELSE v_companion.provider_ids->>0 END;
  v_model:=CASE WHEN p_patch?'model_id' THEN p_patch->>'model_id' ELSE v_companion.model_id END;
  v_skills:=CASE WHEN p_patch?'selected_skill_ids' THEN p_patch->'selected_skill_ids'
    ELSE v_companion.selected_skill_ids END;
  v_mcp:=CASE WHEN p_patch?'selected_mcp_account_ids' THEN p_patch->'selected_mcp_account_ids'
    ELSE v_companion.selected_mcp_account_ids END;
  v_can_write:=CASE WHEN p_patch?'can_write_skills' THEN (p_patch->>'can_write_skills')::boolean
    ELSE v_companion.can_write_skills END;
  v_shape:=CASE WHEN p_patch->'icon'?'shape' THEN (p_patch->'icon'->>'shape')::smallint
    ELSE v_companion.icon_shape END;
  v_mouth:=CASE WHEN p_patch->'icon'?'mouth' THEN (p_patch->'icon'->>'mouth')::smallint
    ELSE v_companion.icon_mouth END;
  v_accessory:=CASE WHEN p_patch->'icon'?'accessory' THEN
    (p_patch->'icon'->>'accessory')::smallint ELSE v_companion.icon_accessory END;
  v_color:=CASE WHEN p_patch->'icon'?'color' THEN (p_patch->'icon'->>'color')::smallint
    ELSE v_companion.icon_color END;
  IF v_provider IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.companion_provider_connections
    connection WHERE connection.org_id=p_org_id AND connection.provider_id=v_provider) THEN
    RAISE EXCEPTION 'Companion provider is not connected' USING ERRCODE='22023';END IF;
  PERFORM public.companion_api_validate_resource_selection(p_org_id,v_skills,
    v_companion.selected_skill_ids,v_mcp,v_companion.selected_mcp_account_ids);
  v_skills_changed:=v_skills IS DISTINCT FROM v_companion.selected_skill_ids;
  v_settings_changed:=v_persona IS DISTINCT FROM v_companion.persona
    OR v_provider IS DISTINCT FROM v_companion.provider_ids->>0
    OR v_model IS DISTINCT FROM v_companion.model_id OR v_skills_changed
    OR v_can_write IS DISTINCT FROM v_companion.can_write_skills
    OR v_mcp IS DISTINCT FROM v_companion.selected_mcp_account_ids;
  UPDATE public.companions companion SET name=v_name,persona=v_persona,
    provider_ids=CASE WHEN v_provider IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(v_provider) END,
    model_id=v_model,selected_skill_ids=v_skills,can_write_skills=v_can_write,
    selected_mcp_account_ids=v_mcp,icon_shape=v_shape,icon_mouth=v_mouth,
    icon_accessory=v_accessory,icon_color=v_color,
    skills_revision=companion.skills_revision+CASE WHEN v_skills_changed THEN 1 ELSE 0 END,
    updated_at=v_now WHERE companion.org_id=p_org_id AND companion.id=p_companion_id
    RETURNING companion.skills_revision INTO v_companion.skills_revision;
  UPDATE public.companion_v3_instances instance SET
    desired_settings_revision=instance.desired_settings_revision+
      CASE WHEN v_settings_changed THEN 1 ELSE 0 END,updated_at=v_now
    WHERE instance.org_id=p_org_id AND instance.companion_id=p_companion_id
    RETURNING instance.desired_settings_revision INTO v_instance.desired_settings_revision;
  INSERT INTO public.audit_log(org_id,actor_id,action,target_type,target_id,metadata)
    VALUES(p_org_id,v_actor,'companion.settings.updated','companion',p_companion_id::text,
      jsonb_build_object('name',p_patch?'name','persona',p_patch?'persona',
        'provider',p_patch?'provider_id','model',p_patch?'model_id' OR p_patch?'provider_id',
        'selected_skills',p_patch?'selected_skill_ids','can_write_skills',p_patch?'can_write_skills',
        'selected_mcp_accounts',p_patch?'selected_mcp_account_ids','icon',p_patch?'icon'));
  RETURN QUERY SELECT p_companion_id,v_instance.desired_settings_revision,
    v_companion.skills_revision,v_settings_changed,v_skills_changed,v_now;
END $$;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_api_set_initial_provider(
  p_org_id uuid,p_companion_id uuid,p_provider_id text,p_model_id text
) RETURNS TABLE(companion_id uuid,desired_settings_revision bigint,updated_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_updated record;v_provider_ids jsonb;
BEGIN
  PERFORM public.companion_api_require_access(p_org_id,p_companion_id,'owner');
  PERFORM 1 FROM public.companion_v3_instances instance WHERE instance.org_id=p_org_id
    AND instance.companion_id=p_companion_id FOR UPDATE;
  SELECT companion.provider_ids INTO STRICT v_provider_ids FROM public.companions companion
    WHERE companion.org_id=p_org_id AND companion.id=p_companion_id FOR UPDATE;
  IF v_provider_ids<>'[]'::jsonb THEN
    RAISE EXCEPTION 'Companion already has a provider' USING ERRCODE='55000';END IF;
  SELECT * INTO STRICT v_updated FROM public.companion_v3_api_update_companion(
    p_org_id,p_companion_id,jsonb_build_object('provider_id',p_provider_id,'model_id',p_model_id));
  RETURN QUERY SELECT v_updated.companion_id,v_updated.desired_settings_revision,
    v_updated.updated_at;
END $$;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_api_bump_skill_revision(p_org_id uuid,p_skill_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_actor text:=public.companion_api_actor(p_org_id);v_count integer:=0;
BEGIN
  IF p_skill_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.skills skill
    WHERE skill.org_id=p_org_id AND skill.id=p_skill_id
      AND (skill.scope='org' OR skill.creator_id=v_actor)) THEN
    RAISE EXCEPTION 'Skill not found' USING ERRCODE='P0002';END IF;
  UPDATE public.companions companion SET
    skills_available_revision=companion.skills_available_revision+1,updated_at=clock_timestamp()
    WHERE companion.org_id=p_org_id
      AND companion.selected_skill_ids@>jsonb_build_array(p_skill_id::text);
  GET DIAGNOSTICS v_count=ROW_COUNT;RETURN v_count;
END $$;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_api_require_skill_revision(p_org_id uuid,p_skill_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_actor text:=public.companion_api_actor(p_org_id);v_count integer:=0;
BEGIN
  IF p_skill_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.skills skill
    WHERE skill.org_id=p_org_id AND skill.id=p_skill_id
      AND (skill.scope='org' OR skill.creator_id=v_actor)) THEN
    RAISE EXCEPTION 'Skill not found' USING ERRCODE='P0002';END IF;
  UPDATE public.companions companion SET
    skills_revision=companion.skills_available_revision+1,
    skills_available_revision=companion.skills_available_revision+1,updated_at=clock_timestamp()
    WHERE companion.org_id=p_org_id
      AND companion.selected_skill_ids@>jsonb_build_array(p_skill_id::text);
  GET DIAGNOSTICS v_count=ROW_COUNT;RETURN v_count;
END $$;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_api_update_member_state(
  p_org_id uuid,p_companion_id uuid,p_pinned boolean,p_hidden boolean,
  p_muted boolean,p_unread boolean
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_actor text:=public.companion_api_actor(p_org_id);v_now timestamptz:=clock_timestamp();
BEGIN
  PERFORM public.companion_api_require_access(p_org_id,p_companion_id,'read');
  IF p_pinned IS NULL AND p_hidden IS NULL AND p_muted IS NULL AND p_unread IS NULL THEN
    RAISE EXCEPTION 'at least one member-state setting is required' USING ERRCODE='22023';END IF;
  IF p_pinned IS NOT NULL OR p_hidden IS NOT NULL OR p_unread IS NOT NULL THEN
    PERFORM 1 FROM public.companion_api_update_member_state(
      p_org_id,p_companion_id,p_pinned,p_hidden,p_unread);
  END IF;
  IF p_muted IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('companion-notification:member:'||
      p_org_id::text||':'||p_companion_id::text||':'||v_actor,0));
    INSERT INTO public.companion_member_state(org_id,companion_id,user_id,muted,created_at,updated_at)
      VALUES(p_org_id,p_companion_id,v_actor,p_muted,v_now,v_now)
      ON CONFLICT(companion_id,user_id) DO UPDATE SET muted=excluded.muted,
        updated_at=excluded.updated_at WHERE companion_member_state.org_id=excluded.org_id;
    IF p_muted THEN
      DELETE FROM public.companion_notification_deliveries delivery
        WHERE delivery.org_id=p_org_id AND delivery.companion_id=p_companion_id
          AND delivery.recipient_user_id=v_actor;
    END IF;
  END IF;
END $$;
--> statement-breakpoint

-- Keep a deferred preparation failure visible on the queued Turn while retaining the external
-- incident projection added by v3. This is a v3 instance lookup; no attempt projection participates.
CREATE FUNCTION public.companion_v3_api_read_runtime(
  p_org_id uuid,p_companion_id uuid
) RETURNS TABLE(
  access_role text,generation bigint,selected_skill_ids jsonb,selected_mcp_account_ids jsonb,
  box_id text,box_state public.companion_box_observed_state,
  pi_state public.companion_pi_observed_state,pi_invocation_id text,disk_layout_version integer,
  desired_settings_revision bigint,applied_settings_revision bigint,
  applied_skills_revision integer,retirement_state public.companion_runtime_retirement_state,
  last_observed_at timestamptz,last_error_code text,last_error_message text,
  last_error_action public.companion_runtime_error_action,active_turn jsonb,queued_count integer,
  interrupted_turn jsonb,lifecycle_intent public.companion_v3_lifecycle_intent,is_replying boolean
) LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_actor text:=public.companion_api_actor(p_org_id);
  v_access text:=public.companion_api_require_access(p_org_id,p_companion_id,'read');
BEGIN
  RETURN QUERY SELECT v_access,1::bigint,
    COALESCE((SELECT jsonb_agg(selected.skill_id ORDER BY selected.ordinality)
      FROM jsonb_array_elements_text(companion.selected_skill_ids)
        WITH ORDINALITY selected(skill_id,ordinality)
      JOIN public.skills skill ON skill.org_id=p_org_id AND skill.id::text=selected.skill_id
      WHERE skill.scope='org' OR skill.creator_id=v_actor),'[]'::jsonb),
    COALESCE((SELECT jsonb_agg(selected.account_id ORDER BY selected.ordinality)
      FROM jsonb_array_elements_text(companion.selected_mcp_account_ids)
        WITH ORDINALITY selected(account_id,ordinality)
      JOIN public.companion_mcp_accounts account
        ON account.org_id=p_org_id AND account.id::text=selected.account_id
      WHERE account.owner_id=v_actor),'[]'::jsonb),
    CASE WHEN v_access='viewer' THEN NULL ELSE instance.box_id END,
    (CASE WHEN instance.box_id IS NULL THEN 'absent'
      WHEN instance.lifecycle_state='archived' THEN 'archived'
      WHEN instance.lifecycle_state IN ('archive_pending','archive_requested','waiting_archived',
        'delete_pending','delete_requested','delete_dispatched','waiting_deleted') THEN 'archiving'
      WHEN instance.prepared_at IS NULL THEN 'provisioning' ELSE 'ready' END)
      ::public.companion_box_observed_state,
    (CASE WHEN instance.pi_invocation_id IS NULL THEN 'absent'
      WHEN instance.prepared_at IS NULL OR instance.pi_recycle_checkpoint IS NOT NULL THEN 'starting'
      WHEN active_turn.value IS NOT NULL THEN 'running' ELSE 'idle' END)
      ::public.companion_pi_observed_state,
    instance.pi_invocation_id,COALESCE(instance.prepared_disk_layout_version,0),
    instance.desired_settings_revision,COALESCE(instance.preparation_settings_revision,0),
    COALESCE(instance.preparation_skills_revision,0),
    (CASE WHEN instance.desired_lifecycle='delete' THEN 'requested' ELSE 'active' END)
      ::public.companion_runtime_retirement_state,
    GREATEST(instance.prepared_at,instance.staging_completed_at,instance.box_ready_at,
      instance.updated_at),
    COALESCE(instance.lifecycle_error_code,instance.preparation_error_code),
    CASE WHEN v_access='viewer' AND COALESCE(instance.lifecycle_error_message,
      instance.preparation_error_message) IS NOT NULL THEN 'The Companion runtime needs attention.'
      ELSE COALESCE(instance.lifecycle_error_message,instance.preparation_error_message) END,
    CASE WHEN COALESCE(instance.lifecycle_error_code,instance.preparation_error_code) IS NULL
      THEN NULL ELSE 'retry'::public.companion_runtime_error_action END,
    active_turn.value,
    (SELECT count(*)::integer FROM public.companion_v3_turns queued
      WHERE queued.org_id=instance.org_id AND queued.companion_id=instance.companion_id
        AND queued.lane='main' AND queued.state='queued'),
    interrupted_turn.value,instance.desired_lifecycle,
    active_turn.value IS NOT NULL AND COALESCE((active_turn.value->>'replying')::boolean,false)
  FROM public.companion_v3_instances instance
  JOIN public.companions companion ON companion.org_id=instance.org_id
    AND companion.id=instance.companion_id
  LEFT JOIN LATERAL(SELECT public.companion_v3_public_turn(turn_row) value
    FROM public.companion_v3_turns turn_row
    WHERE turn_row.org_id=instance.org_id AND turn_row.companion_id=instance.companion_id
      AND turn_row.lane='main' AND turn_row.state IN ('admitted','running','needs_input')
    ORDER BY turn_row.queue_sequence,turn_row.id LIMIT 1) active_turn ON true
  LEFT JOIN LATERAL(SELECT public.companion_v3_public_turn(turn_row) value
    FROM public.companion_v3_turns turn_row
    WHERE turn_row.org_id=instance.org_id AND turn_row.companion_id=instance.companion_id
      AND turn_row.lane='main' AND turn_row.state='interrupted'
    ORDER BY turn_row.queue_sequence DESC,turn_row.id DESC LIMIT 1) interrupted_turn ON true
  WHERE instance.org_id=p_org_id AND instance.companion_id=p_companion_id;
END $$;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_api_list_runtime(p_org_id uuid)
RETURNS TABLE(
  companion_id uuid,access_role text,generation bigint,selected_skill_ids jsonb,
  selected_mcp_account_ids jsonb,box_id text,box_state public.companion_box_observed_state,
  pi_state public.companion_pi_observed_state,pi_invocation_id text,disk_layout_version integer,
  desired_settings_revision bigint,applied_settings_revision bigint,
  applied_skills_revision integer,retirement_state public.companion_runtime_retirement_state,
  last_observed_at timestamptz,last_error_code text,last_error_message text,
  last_error_action public.companion_runtime_error_action,active_turn jsonb,queued_count integer,
  interrupted_turn jsonb,lifecycle_intent public.companion_v3_lifecycle_intent,is_replying boolean
) LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_actor text:=public.companion_api_actor(p_org_id);v_companion uuid;
BEGIN
  FOR v_companion IN SELECT companion.id FROM public.companions companion
    LEFT JOIN public.companion_workspace_access access ON access.org_id=companion.org_id
      AND access.companion_id=companion.id
    JOIN public.companion_v3_instances instance ON instance.org_id=companion.org_id
      AND instance.companion_id=companion.id
    WHERE companion.org_id=p_org_id AND (companion.owner_id=v_actor OR access.role IS NOT NULL)
    ORDER BY companion.updated_at DESC,companion.id
  LOOP
    RETURN QUERY SELECT v_companion,runtime.*
    FROM public.companion_v3_api_read_runtime(p_org_id,v_companion) runtime;
  END LOOP;
END $$;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_api_read_skill_sync(p_org_id uuid,p_companion_id uuid)
RETURNS TABLE(skills_available_revision integer,skills_update_error_message text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_access text:=public.companion_api_require_access(p_org_id,p_companion_id,'read');
BEGIN
  RETURN QUERY SELECT companion.skills_available_revision,
    CASE WHEN v_access='viewer' AND instance.preparation_error_message IS NOT NULL
      THEN 'The Skill update needs attention.' ELSE instance.preparation_error_message END
  FROM public.companions companion
  JOIN public.companion_v3_instances instance ON instance.org_id=companion.org_id
    AND instance.companion_id=companion.id
  WHERE companion.org_id=p_org_id AND companion.id=p_companion_id;
END $$;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_api_list_skill_sync(p_org_id uuid)
RETURNS TABLE(companion_id uuid,skills_available_revision integer,
  skills_update_error_message text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
  SELECT runtime.companion_id,sync.skills_available_revision,sync.skills_update_error_message
  FROM public.companion_v3_api_list_runtime(p_org_id) runtime
  CROSS JOIN LATERAL public.companion_v3_api_read_skill_sync(
    p_org_id,runtime.companion_id) sync
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.companion_v3_public_turn(p_turn public.companion_v3_turns)
RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
  SELECT jsonb_build_object(
    'id',p_turn.id,'companion_id',p_turn.companion_id,
    'client_message_id',p_turn.client_message_id,'status',p_turn.state,
    'queue_sequence',p_turn.queue_sequence,
    'admission_state',p_turn.admission_state,'admitted_at',p_turn.admitted_at,
    'replying',p_turn.admission_state='accepted' AND p_turn.state IN ('admitted','running'),
    'error',CASE
      WHEN p_turn.outcome IN ('failed','interrupted') THEN jsonb_build_object(
        'code',p_turn.outcome_code,'message',p_turn.outcome_message,'action',p_turn.outcome_action)
      WHEN p_turn.state='queued' THEN (SELECT CASE
        WHEN instance.preparation_error_code IS NULL THEN NULL
        ELSE jsonb_build_object('code',instance.preparation_error_code,
          'message',instance.preparation_error_message,'action','retry') END
        FROM public.companion_v3_instances instance
        WHERE instance.org_id=p_turn.org_id AND instance.companion_id=p_turn.companion_id)
      ELSE NULL END,
    'state_changed_at',p_turn.updated_at,'settled_at',p_turn.settled_at,
    'created_at',p_turn.created_at,'updated_at',p_turn.updated_at)
    || CASE WHEN p_turn.external_incident_id IS NULL THEN '{}'::jsonb
      ELSE jsonb_build_object('external_block',jsonb_build_object(
        'classification',p_turn.external_failure_class,'source',p_turn.external_failure_source,
        'message',p_turn.external_blocked_message)) END
$$;
--> statement-breakpoint

ALTER TABLE public.companion_v3_turns
  ADD COLUMN outputs_harvested_at timestamptz;
--> statement-breakpoint

-- Persist Pi outbox images against the v3 Turn before the terminal journal page is projected. The
-- provider/object writes happen first, so this SQL side is fenced, idempotent, and safe to resume
-- after a committed response is lost. `attempt_id` remains only a Pi transport spelling; no v2
-- attempt row participates in this function.
CREATE FUNCTION public.companion_v3_runtime_record_turn_outputs(
  p_org_id uuid,
  p_companion_id uuid,
  p_lane public.companion_v3_lane,
  p_turn_id uuid,
  p_claim_token uuid,
  p_claim_epoch bigint,
  p_gate_epoch bigint,
  p_attachments jsonb,
  p_activity_at timestamptz,
  p_protocol integer
)
RETURNS TABLE(recorded integer,has_visible_output boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE
  v_turn public.companion_v3_turns%ROWTYPE;
  v_event_id text:='v3:'||p_turn_id::text||':outputs';
  v_now timestamptz:=clock_timestamp();
  v_activity_at timestamptz;
  v_ordinal integer;
  v_projection bigint;
  v_total bigint;
BEGIN
  IF p_protocol<>3 OR p_lane<>'main' OR p_attachments IS NULL
    OR jsonb_typeof(p_attachments)<>'array' OR jsonb_array_length(p_attachments)>10 THEN
    RAISE EXCEPTION 'invalid Runtime v3 Turn outputs' USING ERRCODE='22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_attachments) WITH ORDINALITY part(value,ordinality)
    WHERE jsonb_typeof(part.value)<>'object'
      OR COALESCE(part.value->>'position','')<>(part.ordinality-1)::text
      OR COALESCE(part.value->>'storage_key','')<>
        'companion-attachments/'||p_org_id::text||'/'||p_companion_id::text||
        '/outputs/'||p_turn_id::text||'/'||(part.ordinality-1)::text||'-'||
        COALESCE(part.value->>'sha256','')
      OR COALESCE(part.value->>'content_type','') NOT IN
        ('image/png','image/jpeg','image/webp','image/gif')
      OR COALESCE(part.value->>'sha256','')!~'^[0-9a-f]{64}$'
      OR COALESCE(part.value->>'filename','')!~'^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'
      OR COALESCE(part.value->>'byte_size','')!~'^[1-9][0-9]{0,7}$'
      OR (part.value->>'byte_size')::bigint>10485760
      OR COALESCE(part.value->>'uploaded_at','')=''
      OR (part.value->>'uploaded_at')::timestamptz>v_now
  ) THEN
    RAISE EXCEPTION 'invalid Runtime v3 output attachment' USING ERRCODE='22023';
  END IF;
  SELECT COALESCE(sum((part.value->>'byte_size')::bigint),0) INTO v_total
  FROM jsonb_array_elements(p_attachments) part;
  IF v_total>104857600 THEN
    RAISE EXCEPTION 'Runtime v3 Turn outputs exceed the byte budget' USING ERRCODE='22023';
  END IF;

  SELECT turn_row.* INTO v_turn
  FROM public.companion_v3_lane_leases lease
  JOIN public.companion_runtime_control control ON control.id='runtime-v3'
    AND control.enabled AND control.gate_epoch=p_gate_epoch
  JOIN public.companion_v3_turns turn_row ON turn_row.org_id=lease.org_id
    AND turn_row.companion_id=lease.companion_id AND turn_row.id=lease.turn_id
  WHERE lease.org_id=p_org_id AND lease.companion_id=p_companion_id AND lease.lane=p_lane
    AND lease.turn_id=p_turn_id AND lease.claim_token=p_claim_token
    AND lease.claim_epoch=p_claim_epoch AND lease.gate_epoch=p_gate_epoch
    AND lease.expires_at>v_now
    AND turn_row.lane='main' AND turn_row.admission_state='accepted'
    AND turn_row.response_turn_id=turn_row.id
    AND (turn_row.state IN ('admitted','running','needs_input')
      OR (turn_row.state IN ('succeeded','failed') AND turn_row.journal_ack_pending))
  FOR UPDATE OF lease,turn_row;
  IF NOT FOUND THEN RETURN; END IF;

  IF v_turn.outputs_harvested_at IS NOT NULL THEN
    SELECT count(*)::integer INTO recorded FROM public.companion_message_attachments attachment
    WHERE attachment.org_id=p_org_id AND attachment.companion_id=p_companion_id
      AND attachment.entry_event_id=v_event_id AND attachment.kind='pi_output';
    SELECT EXISTS(SELECT 1 FROM public.companion_transcript_entries entry
      WHERE entry.org_id=p_org_id AND entry.companion_id=p_companion_id
        AND entry.role='assistant' AND entry.event_id LIKE 'v3:'||p_turn_id::text||':%')
      INTO has_visible_output;
    RETURN NEXT; RETURN;
  END IF;

  IF jsonb_array_length(p_attachments)>0 THEN
    UPDATE public.companion_threads thread SET
      next_ordinal=thread.next_ordinal+1,
      projection_sequence=thread.projection_sequence+1,
      last_message_at=v_now,updated_at=v_now
    WHERE thread.org_id=p_org_id AND thread.companion_id=p_companion_id
    RETURNING thread.next_ordinal-1,thread.projection_sequence INTO v_ordinal,v_projection;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Companion thread allocation failed' USING ERRCODE='40001';
    END IF;
    INSERT INTO public.companion_transcript_entries(
      org_id,companion_id,event_id,ordinal,projection_sequence,role,content,created_at
    ) VALUES(p_org_id,p_companion_id,v_event_id,v_ordinal,v_projection,'assistant','',v_now);
    INSERT INTO public.companion_message_attachments(
      org_id,companion_id,entry_event_id,kind,storage_key,content_type,byte_size,sha256,
      filename,position,created_at,uploaded_at,expires_at
    ) SELECT p_org_id,p_companion_id,v_event_id,'pi_output',part.value->>'storage_key',
      part.value->>'content_type',(part.value->>'byte_size')::integer,
      part.value->>'sha256',part.value->>'filename',(part.ordinality-1)::integer,v_now,
      (part.value->>'uploaded_at')::timestamptz,
      (part.value->>'uploaded_at')::timestamptz+interval '30 days'
    FROM jsonb_array_elements(p_attachments) WITH ORDINALITY part(value,ordinality);
  END IF;

  v_activity_at:=GREATEST(COALESCE(v_turn.last_activity_at,'-infinity'::timestamptz),
    LEAST(COALESCE(p_activity_at,v_now),v_now));
  UPDATE public.companion_v3_turns turn_row SET
    outputs_harvested_at=v_now,last_activity_at=v_activity_at,
    inactivity_deadline_at=CASE WHEN turn_row.state IN ('admitted','running')
      THEN LEAST(turn_row.absolute_deadline_at,v_activity_at+interval '10 minutes')
      ELSE turn_row.inactivity_deadline_at END,
    updated_at=v_now
  WHERE turn_row.id=p_turn_id;
  recorded:=jsonb_array_length(p_attachments);
  SELECT EXISTS(SELECT 1 FROM public.companion_transcript_entries entry
    WHERE entry.org_id=p_org_id AND entry.companion_id=p_companion_id
      AND entry.role='assistant' AND entry.event_id LIKE 'v3:'||p_turn_id::text||':%')
    INTO has_visible_output;
  RETURN NEXT;
END $$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_v3_runtime_record_turn_outputs(
  uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,jsonb,timestamptz,integer
) FROM PUBLIC;
--> statement-breakpoint

-- The material read returns the committed output checkpoint under the same claim fence. A
-- takeover can therefore skip Box reads and object uploads after `record_turn_outputs` committed.
CREATE FUNCTION public.companion_v3_runtime_authorize_warm_turn_v8(
  p_org_id uuid,p_companion_id uuid,p_lane public.companion_v3_lane,p_turn_id uuid,
  p_claim_token uuid,p_claim_epoch bigint,p_gate_epoch bigint,p_protocol integer
) RETURNS TABLE(box_id text,pi_invocation_id text,content text,activity_cursor bigint,
  recovery_deferred boolean,outputs_harvested boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_material record;v_harvested boolean;
BEGIN
  IF p_protocol<>8 THEN
    RAISE EXCEPTION 'Runtime v3 protocol 8 is required' USING ERRCODE='42501';
  END IF;
  SELECT authorized.* INTO v_material
  FROM public.companion_v3_runtime_authorize_warm_turn_v7(
    p_org_id,p_companion_id,p_lane,p_turn_id,p_claim_token,p_claim_epoch,p_gate_epoch,7
  ) authorized;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT turn_row.outputs_harvested_at IS NOT NULL INTO v_harvested
  FROM public.companion_v3_lane_leases lease
  JOIN public.companion_v3_turns turn_row ON turn_row.org_id=lease.org_id
    AND turn_row.companion_id=lease.companion_id AND turn_row.id=lease.turn_id
  WHERE lease.org_id=p_org_id AND lease.companion_id=p_companion_id AND lease.lane=p_lane
    AND lease.turn_id=p_turn_id AND lease.claim_token=p_claim_token
    AND lease.claim_epoch=p_claim_epoch AND lease.gate_epoch=p_gate_epoch;
  IF NOT FOUND THEN RETURN; END IF;
  RETURN QUERY SELECT v_material.box_id,v_material.pi_invocation_id,v_material.content,
    v_material.activity_cursor,v_material.recovery_deferred,v_harvested;
END $$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_v3_runtime_authorize_warm_turn_v8(
  uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,integer
) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_api_enqueue_turn(
  p_org_id uuid,
  p_companion_id uuid,
  p_client_message_id uuid,
  p_content text,
  p_client_surface public.companion_client_surface,
  p_attachments jsonb DEFAULT '[]'::jsonb
)
RETURNS TABLE(turn jsonb, replayed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_result record;
  v_event_id text := 'msg:' || p_client_message_id::text;
  v_attachments jsonb := COALESCE(p_attachments, '[]'::jsonb);
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_client_surface IS NULL THEN
    RAISE EXCEPTION 'invalid Runtime v3 client surface' USING ERRCODE='22023';
  END IF;
  PERFORM public.companion_api_assert_message_attachments(
    p_org_id, p_companion_id, v_attachments
  );
  SELECT * INTO v_result FROM public.companion_v3_api_enqueue_warm_turn(
    p_org_id, p_companion_id, p_client_message_id, p_content
  );
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Companion has no Runtime v3 instance' USING ERRCODE='55000';
  END IF;
  IF v_result.replayed THEN
    IF public.companion_api_stored_attachment_intent(
      p_org_id, p_companion_id, v_event_id
    ) IS DISTINCT FROM public.companion_api_message_attachment_intent(v_attachments) THEN
      RAISE EXCEPTION 'client_message_id was reused with different message intent'
        USING ERRCODE='23505', CONSTRAINT='companion_v3_turns_client_message_uq';
    END IF;
  ELSE
    INSERT INTO public.companion_message_attachments(
      org_id, companion_id, entry_event_id, kind, storage_key,
      content_type, byte_size, sha256, filename, position, created_at
    )
    SELECT p_org_id, p_companion_id, v_event_id, 'user_upload',
      part.value ->> 'storage_key', part.value ->> 'content_type',
      (part.value ->> 'byte_size')::integer, part.value ->> 'sha256',
      part.value ->> 'filename', (part.ordinality - 1)::integer, v_now
    FROM jsonb_array_elements(v_attachments) WITH ORDINALITY AS part(value, ordinality);
  END IF;
  turn := v_result.turn;
  replayed := v_result.replayed;
  RETURN NEXT;
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_v3_api_enqueue_turn(
  uuid,uuid,uuid,text,public.companion_client_surface,jsonb
) FROM PUBLIC;
--> statement-breakpoint

-- Cancel is a v3 Turn mutation. Queued work terminalizes immediately; admitted work is consumed by
-- the existing fenced Pi-abort checkpoint. The old Retry path is intentionally not replaced.
CREATE FUNCTION public.companion_v3_api_cancel_turn(
  p_org_id uuid,p_companion_id uuid,p_turn_id uuid
) RETURNS TABLE(turn jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_turn public.companion_v3_turns%ROWTYPE;v_now timestamptz:=clock_timestamp();
BEGIN
  PERFORM public.companion_api_require_access(p_org_id,p_companion_id,'editor');
  PERFORM 1 FROM public.companion_v3_lane_leases lease
    WHERE lease.org_id=p_org_id AND lease.companion_id=p_companion_id
      AND lease.lane='main' FOR UPDATE;
  SELECT * INTO v_turn FROM public.companion_v3_turns turn_row
    WHERE turn_row.org_id=p_org_id AND turn_row.companion_id=p_companion_id
      AND turn_row.id=p_turn_id AND turn_row.lane='main' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Companion Turn not found' USING ERRCODE='P0002'; END IF;
  IF v_turn.state='queued' AND v_turn.admission_state='pending'
    AND v_turn.admission_started_at IS NULL THEN
    UPDATE public.companion_v3_turns turn_row SET state='cancelled',outcome='cancelled',
      outcome_code=NULL,outcome_message=NULL,outcome_action=NULL,
      inactivity_deadline_at=NULL,absolute_deadline_at=NULL,settled_at=v_now,updated_at=v_now
    WHERE turn_row.id=v_turn.id RETURNING * INTO v_turn;
    UPDATE public.companion_threads SET projection_sequence=projection_sequence+1,updated_at=v_now
      WHERE org_id=p_org_id AND companion_id=p_companion_id;
  ELSIF v_turn.state IN ('admitted','running','needs_input') THEN
    UPDATE public.companion_v3_turns turn_row SET
      delegation_cancel_requested_at=COALESCE(turn_row.delegation_cancel_requested_at,v_now),
      delegation_cancel_command_id=COALESCE(turn_row.delegation_cancel_command_id,gen_random_uuid()),
      updated_at=v_now
    WHERE turn_row.id=v_turn.id RETURNING * INTO v_turn;
  END IF;
  turn:=public.companion_v3_public_turn(v_turn);RETURN NEXT;
END $$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_v3_api_cancel_turn(uuid,uuid,uuid) FROM PUBLIC;
--> statement-breakpoint

-- Generalize the fenced cancel consumer from delegated target Turns to every ordinary main Turn.
CREATE OR REPLACE FUNCTION public.companion_v3_runtime_pending_delegation_cancel(
  p_org_id uuid,p_companion_id uuid,p_turn_id uuid,p_claim_token uuid,
  p_claim_epoch bigint,p_gate_epoch bigint,p_protocol integer
) RETURNS TABLE(turn_id uuid,response_turn_id uuid,command_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_now timestamptz:=clock_timestamp();
BEGIN
  IF p_protocol<>7 THEN RAISE EXCEPTION 'Runtime v3 protocol 7 is required' USING ERRCODE='42501'; END IF;
  RETURN QUERY
  SELECT candidate.id,root_turn.id,candidate.delegation_cancel_command_id
  FROM public.companion_v3_lane_leases lease
  JOIN public.companion_runtime_control control ON control.id='runtime-v3'
    AND control.enabled AND control.gate_epoch=p_gate_epoch
  JOIN public.companion_v3_turns claimed_turn ON claimed_turn.org_id=lease.org_id
    AND claimed_turn.companion_id=lease.companion_id AND claimed_turn.id=lease.turn_id
    AND claimed_turn.lane='main' AND claimed_turn.admission_state='accepted'
    AND claimed_turn.state IN ('admitted','running','needs_input')
  JOIN public.companion_v3_turns root_turn ON root_turn.org_id=claimed_turn.org_id
    AND root_turn.companion_id=claimed_turn.companion_id
    AND root_turn.id=COALESCE(claimed_turn.response_turn_id,claimed_turn.id)
    AND root_turn.lane='main' AND root_turn.admission_state='accepted'
    AND root_turn.state IN ('admitted','running','needs_input')
    AND root_turn.response_turn_id=root_turn.id
  JOIN public.companion_v3_turns candidate ON candidate.org_id=root_turn.org_id
    AND candidate.companion_id=root_turn.companion_id AND candidate.lane='main'
    AND candidate.admission_state='accepted'
    AND candidate.state IN ('admitted','running','needs_input')
    AND (candidate.id=root_turn.id OR candidate.response_turn_id=root_turn.id)
    AND candidate.delegation_cancel_requested_at IS NOT NULL
    AND candidate.delegation_cancel_command_id IS NOT NULL
  WHERE lease.org_id=p_org_id AND lease.companion_id=p_companion_id AND lease.lane='main'
    AND lease.turn_id=p_turn_id AND lease.claim_token=p_claim_token
    AND lease.claim_epoch=p_claim_epoch AND lease.gate_epoch=p_gate_epoch
    AND lease.expires_at>v_now
  ORDER BY candidate.delegation_cancel_requested_at,candidate.id LIMIT 1;
END $$;
--> statement-breakpoint

-- Copy API execute capability from the v3 send entry point without naming deployment roles.
DO $runtime_v3_contraction_api_acl$
DECLARE v_source oid:=pg_catalog.to_regprocedure(
  'public.companion_v3_api_enqueue_warm_turn(uuid,uuid,uuid,text)');v_grantee oid;v_role name;
BEGIN
  FOR v_grantee IN SELECT DISTINCT acl.grantee FROM pg_catalog.pg_proc source_proc
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(source_proc.proacl,pg_catalog.acldefault('f',source_proc.proowner))) acl
    WHERE source_proc.oid=v_source AND acl.privilege_type='EXECUTE'
      AND acl.grantee<>source_proc.proowner
  LOOP
    SELECT rolname INTO v_role FROM pg_catalog.pg_roles WHERE oid=v_grantee;
    IF v_role IS NOT NULL THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_v3_api_enqueue_turn(uuid,uuid,uuid,text,public.companion_client_surface,jsonb) TO %I',v_role);
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_v3_api_cancel_turn(uuid,uuid,uuid) TO %I',v_role);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.companion_api_enqueue_turn(uuid,uuid,uuid,text,public.companion_client_surface,jsonb,uuid,text,uuid,text) FROM %I',v_role);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.companion_api_retry_turn(uuid,uuid,uuid,uuid,public.companion_client_surface) FROM %I',v_role);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.companion_api_cancel_turn(uuid,uuid,uuid) FROM %I',v_role);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.companion_api_enqueue_operation(uuid,uuid,uuid,public.companion_operation_kind,public.companion_client_surface) FROM %I',v_role);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.companion_v3_api_restart_pi(uuid,uuid,uuid,public.companion_client_surface) FROM %I',v_role);
    END IF;
  END LOOP;
END $runtime_v3_contraction_api_acl$;
--> statement-breakpoint

-- 0178's client bridge wrote a Runtime v2 operation. The public restart route now records the
-- native recycle_pi lifecycle desire, so keep no callable bridge in the contracted schema.
DROP FUNCTION public.companion_v3_api_restart_pi(
  uuid,uuid,uuid,public.companion_client_surface
);
--> statement-breakpoint

-- Background work shares the same recovery-context reservation and committed-output checkpoint
-- as main Turns. Protocol 9 also gives each occurrence a v3-native Pi identity; claim epochs fence
-- settlement but never alter that durable external identity.
CREATE FUNCTION public.companion_v3_runtime_authorize_background_v9(
  p_org_id uuid,p_companion_id uuid,p_turn_id uuid,p_claim_token uuid,p_claim_epoch bigint,
  p_gate_epoch bigint,p_protocol integer
) RETURNS TABLE(background_kind text,box_id text,pi_invocation_id text,content text,
  activity_cursor bigint,persona text,validation_only boolean,direct_workspace boolean,
  recovery_deferred boolean,outputs_harvested boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE
  v_material record;v_context text;v_reserved_turn_id uuid;v_harvested boolean;
BEGIN
  IF p_protocol<>9 THEN
    RAISE EXCEPTION 'Runtime v3 background protocol 9 is required' USING ERRCODE='42501';
  END IF;
  SELECT authorized.* INTO v_material
  FROM public.companion_v3_runtime_authorize_background_v8(
    p_org_id,p_companion_id,p_turn_id,p_claim_token,p_claim_epoch,p_gate_epoch,8
  ) authorized;
  IF NOT FOUND THEN RETURN;END IF;

  SELECT instance.recovery_context,instance.recovery_context_turn_id,
    turn_row.outputs_harvested_at IS NOT NULL
  INTO v_context,v_reserved_turn_id,v_harvested
  FROM public.companion_v3_lane_leases lease
  JOIN public.companion_v3_turns turn_row ON turn_row.org_id=lease.org_id
    AND turn_row.companion_id=lease.companion_id AND turn_row.id=lease.turn_id
  JOIN public.companion_v3_instances instance ON instance.org_id=turn_row.org_id
    AND instance.companion_id=turn_row.companion_id
  WHERE lease.org_id=p_org_id AND lease.companion_id=p_companion_id
    AND lease.lane='background' AND lease.turn_id=p_turn_id
    AND lease.claim_token=p_claim_token AND lease.claim_epoch=p_claim_epoch
    AND lease.gate_epoch=p_gate_epoch AND instance.pi_recycle_checkpoint IS NULL
  FOR UPDATE OF instance;
  IF NOT FOUND THEN RETURN;END IF;
  IF v_context IS NOT NULL AND v_reserved_turn_id IS NULL THEN
    UPDATE public.companion_v3_instances instance
    SET recovery_context_turn_id=p_turn_id,updated_at=clock_timestamp()
    WHERE instance.org_id=p_org_id AND instance.companion_id=p_companion_id;
    v_reserved_turn_id:=p_turn_id;
  END IF;

  RETURN QUERY SELECT v_material.background_kind,v_material.box_id,
    'background:'||p_turn_id::text||':dispatch-v3:'||(
      SELECT turn_row.command_id::text FROM public.companion_v3_turns turn_row
      WHERE turn_row.org_id=p_org_id AND turn_row.companion_id=p_companion_id
        AND turn_row.id=p_turn_id),
    CASE WHEN v_context IS NULL OR v_reserved_turn_id IS DISTINCT FROM p_turn_id
      THEN v_material.content
      ELSE v_context||E'\n\n[Scheduled work]\n'||v_material.content END,
    v_material.activity_cursor,v_material.persona,v_material.validation_only,
    v_material.direct_workspace,
    v_context IS NOT NULL AND v_reserved_turn_id IS DISTINCT FROM p_turn_id,v_harvested;
END $$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_v3_runtime_authorize_background_v9(
  uuid,uuid,uuid,uuid,bigint,bigint,integer
) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_runtime_begin_background_admission_v9(
  p_org_id uuid,p_companion_id uuid,p_turn_id uuid,p_claim_token uuid,p_claim_epoch bigint,
  p_gate_epoch bigint,p_invocation_id text,p_cursor bigint,p_protocol integer
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_now timestamptz:=clock_timestamp();
BEGIN
  IF p_protocol<>9 OR p_cursor<0 OR p_invocation_id IS DISTINCT FROM
    'background:'||p_turn_id::text||':dispatch-v3:'||(
      SELECT command_id::text FROM public.companion_v3_turns
      WHERE org_id=p_org_id AND companion_id=p_companion_id AND id=p_turn_id)
  THEN RETURN false;END IF;
  UPDATE public.companion_v3_turns turn_row SET admission_started_at=v_now,
    pi_invocation_id=p_invocation_id,admission_cursor=p_cursor,updated_at=v_now
  FROM public.companion_v3_lane_leases lease,public.companion_runtime_control control
  WHERE turn_row.org_id=p_org_id AND turn_row.companion_id=p_companion_id
    AND turn_row.id=p_turn_id AND turn_row.lane='background' AND turn_row.state='queued'
    AND turn_row.admission_state='pending' AND turn_row.admission_started_at IS NULL
    AND lease.org_id=turn_row.org_id AND lease.companion_id=turn_row.companion_id
    AND lease.lane='background' AND lease.turn_id=turn_row.id
    AND lease.claim_token=p_claim_token AND lease.claim_epoch=p_claim_epoch
    AND lease.gate_epoch=p_gate_epoch AND lease.expires_at>v_now
    AND control.id='runtime-v3' AND control.enabled AND control.gate_epoch=p_gate_epoch;
  IF NOT FOUND THEN RETURN false;END IF;
  UPDATE public.companion_v3_routine_runs SET outcome='running',
    started_at=COALESCE(started_at,v_now)
  WHERE org_id=p_org_id AND companion_id=p_companion_id AND turn_id=p_turn_id
    AND outcome='pending';
  RETURN true;
END $$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_v3_runtime_begin_background_admission_v9(
  uuid,uuid,uuid,uuid,bigint,bigint,text,bigint,integer
) FROM PUBLIC;
--> statement-breakpoint

-- Apply the one visible context-loss warning transactionally whichever lane produces the first
-- visible answer. Private/no-output background work leaves the warning pending for a later reply.
CREATE FUNCTION public.companion_v3_runtime_project_background_page_v9(
  p_org_id uuid,p_companion_id uuid,p_turn_id uuid,p_claim_token uuid,p_claim_epoch bigint,
  p_gate_epoch bigint,p_through_cursor bigint,p_entries jsonb,p_decisions jsonb,p_returns jsonb,
  p_needs_input boolean,p_activity boolean,p_terminal text,p_protocol integer
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE
  v_result text;v_notice_pending boolean:=false;v_notice_applied boolean:=false;
  v_notice constant text:='I may have forgotten part of our earlier conversation while recovering.';
BEGIN
  IF p_protocol<>9 THEN
    RAISE EXCEPTION 'Runtime v3 background projection protocol 9 is required' USING ERRCODE='42501';
  END IF;
  IF jsonb_typeof(p_returns)='array' AND jsonb_array_length(p_returns)=1 THEN
    SELECT instance.context_loss_notice_pending INTO v_notice_pending
    FROM public.companion_v3_instances instance
    WHERE instance.org_id=p_org_id AND instance.companion_id=p_companion_id
    FOR UPDATE;
    IF v_notice_pending THEN
      p_returns:=jsonb_build_array(jsonb_set(p_returns->0,'{message}',
        to_jsonb(v_notice||E'\n\n'||(p_returns->0->>'message'))));
      v_notice_applied:=true;
    END IF;
  END IF;
  v_result:=public.companion_v3_runtime_project_background_page_v8(
    p_org_id,p_companion_id,p_turn_id,p_claim_token,p_claim_epoch,p_gate_epoch,
    p_through_cursor,p_entries,p_decisions,p_returns,p_needs_input,p_activity,p_terminal,8
  );
  IF v_result IS NOT NULL AND v_notice_applied THEN
    UPDATE public.companion_v3_instances SET context_loss_notice_pending=false,
      updated_at=clock_timestamp()
    WHERE org_id=p_org_id AND companion_id=p_companion_id AND context_loss_notice_pending;
  END IF;
  RETURN v_result;
END $$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_v3_runtime_project_background_page_v9(
  uuid,uuid,uuid,uuid,bigint,bigint,bigint,jsonb,jsonb,jsonb,boolean,boolean,text,integer
) FROM PUBLIC;
--> statement-breakpoint
