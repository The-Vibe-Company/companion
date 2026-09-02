-- A newly-created Companion is a durable Runtime v3 fact immediately. The runtime owns the
-- asynchronous Box/Pi preparation; API acceptance never waits for either provider.
ALTER TABLE public.companion_v3_instances
  DROP CONSTRAINT companion_v3_instances_prepared_check,
  ADD COLUMN box_idempotency_key uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN preparation_checkpoint text NOT NULL DEFAULT 'pending',
  ADD COLUMN preparation_available_at timestamp with time zone NOT NULL DEFAULT now(),
  ADD COLUMN preparation_attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN preparation_error_code text,
  ADD COLUMN preparation_error_message text,
  ADD COLUMN box_ready_at timestamp with time zone,
  ADD COLUMN staging_completed_at timestamp with time zone,
  ADD COLUMN preparation_claim_token uuid,
  ADD COLUMN preparation_claim_epoch bigint NOT NULL DEFAULT 0,
  ADD COLUMN preparation_gate_epoch bigint,
  ADD COLUMN preparation_executor_id text,
  ADD COLUMN preparation_claimed_at timestamp with time zone,
  ADD COLUMN preparation_expires_at timestamp with time zone;
--> statement-breakpoint

-- Warm Runtime v3 rows created by THE-512 already carry the complete readiness proof.
UPDATE public.companion_v3_instances SET
  preparation_checkpoint = 'prepared',
  box_ready_at = prepared_at,
  staging_completed_at = prepared_at
WHERE prepared_at IS NOT NULL;
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
    AND (
      (preparation_claim_token IS NULL AND preparation_gate_epoch IS NULL
        AND preparation_executor_id IS NULL AND preparation_claimed_at IS NULL
        AND preparation_expires_at IS NULL)
      OR (preparation_claim_token IS NOT NULL AND preparation_claim_epoch >= 1
        AND preparation_gate_epoch IS NOT NULL AND preparation_executor_id IS NOT NULL
        AND preparation_claimed_at IS NOT NULL AND preparation_expires_at > preparation_claimed_at)
    )
  );
--> statement-breakpoint

CREATE INDEX companion_v3_instances_preparation_idx
  ON public.companion_v3_instances(preparation_available_at, created_at)
  WHERE prepared_at IS NULL AND desired_lifecycle = 'prepare';
--> statement-breakpoint

-- Queued cold Turns expose their runtime-owned preparation delay without becoming failed. The
-- existing public error shape keeps clients PostgreSQL-only while the Turn status remains queued.
CREATE OR REPLACE FUNCTION public.companion_v3_public_turn(p_turn public.companion_v3_turns)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT jsonb_build_object(
    'id', p_turn.id,
    'companion_id', p_turn.companion_id,
    'client_message_id', p_turn.client_message_id,
    'status', p_turn.state,
    'queue_sequence', p_turn.queue_sequence,
    'latest_attempt', NULL,
    'admission_state', p_turn.admission_state,
    'admitted_at', p_turn.admitted_at,
    'replying', p_turn.admission_state = 'accepted'
      AND p_turn.state IN ('admitted', 'running'),
    'error', CASE
      WHEN p_turn.outcome IN ('failed', 'interrupted') THEN jsonb_build_object(
        'code', p_turn.outcome_code,
        'message', p_turn.outcome_message,
        'action', p_turn.outcome_action
      )
      WHEN p_turn.state = 'queued' THEN (
        SELECT CASE WHEN instance.preparation_error_code IS NOT NULL THEN jsonb_build_object(
          'code', instance.preparation_error_code,
          'message', instance.preparation_error_message,
          'action', 'retry'
        ) ELSE NULL END
        FROM public.companion_v3_instances instance
        WHERE instance.org_id = p_turn.org_id
          AND instance.companion_id = p_turn.companion_id
      )
      ELSE NULL
    END,
    'state_changed_at', p_turn.updated_at,
    'settled_at', p_turn.settled_at,
    'created_at', p_turn.created_at,
    'updated_at', p_turn.updated_at
  )
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.companion_v3_api_create_companion(
  p_org_id uuid,
  p_name text,
  p_persona text,
  p_provider_id text,
  p_model_id text,
  p_selected_skill_ids jsonb,
  p_can_write_skills boolean,
  p_selected_mcp_account_ids jsonb,
  p_source_companion_id uuid DEFAULT NULL,
  p_icon_shape smallint DEFAULT 1,
  p_icon_mouth smallint DEFAULT 1,
  p_icon_accessory smallint DEFAULT 1,
  p_icon_color smallint DEFAULT 2
)
RETURNS TABLE (
  companion_id uuid,
  desired_settings_revision bigint,
  skills_revision integer,
  created_at timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE v_created record;
BEGIN
  SELECT * INTO STRICT v_created FROM public.companion_api_create_companion(
    p_org_id, p_name, p_persona, p_provider_id, p_model_id,
    p_selected_skill_ids, p_can_write_skills, p_selected_mcp_account_ids,
    p_source_companion_id, p_icon_shape, p_icon_mouth, p_icon_accessory, p_icon_color
  );
  INSERT INTO public.companion_v3_instances(
    org_id, companion_id, desired_lifecycle_actor_id, created_at, updated_at
  ) VALUES (
    p_org_id, v_created.companion_id, public.companion_api_actor(p_org_id),
    v_created.created_at, v_created.created_at
  );
  INSERT INTO public.companion_v3_lane_leases(org_id, companion_id, lane)
  VALUES (p_org_id, v_created.companion_id, 'main'),
         (p_org_id, v_created.companion_id, 'background');
  INSERT INTO public.companion_threads(org_id, companion_id)
  VALUES (p_org_id, v_created.companion_id)
  ON CONFLICT ON CONSTRAINT companion_threads_pkey DO NOTHING;
  RETURN QUERY SELECT v_created.companion_id, v_created.desired_settings_revision,
    v_created.skills_revision, v_created.created_at;
END
$$;
--> statement-breakpoint

-- Cold Companions accept ordinary Turns immediately. Presence of the v3 instance, rather than its
-- readiness checkpoint, owns the client_message_id and prevents a fallback Start operation.
CREATE OR REPLACE FUNCTION public.companion_v3_api_enqueue_warm_turn(
  p_org_id uuid,
  p_companion_id uuid,
  p_client_message_id uuid,
  p_content text
)
RETURNS TABLE (turn jsonb, replayed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_actor_id text := public.companion_api_actor(p_org_id);
  v_admission record;
  v_turn public.companion_v3_turns%ROWTYPE;
  v_existing public.companion_transcript_entries%ROWTYPE;
  v_ordinal integer;
  v_projection bigint;
  v_now timestamp with time zone := clock_timestamp();
BEGIN
  PERFORM public.companion_api_require_access(p_org_id, p_companion_id, 'editor');
  IF p_content IS NULL OR char_length(btrim(p_content)) < 1 OR char_length(p_content) > 16384 THEN
    RAISE EXCEPTION 'invalid Runtime v3 message' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_turn FROM public.companion_v3_turns turn_row
  WHERE turn_row.org_id = p_org_id AND turn_row.companion_id = p_companion_id
    AND turn_row.client_message_id = p_client_message_id;
  IF FOUND THEN
    SELECT * INTO v_existing FROM public.companion_transcript_entries entry
    WHERE entry.org_id = p_org_id AND entry.companion_id = p_companion_id
      AND entry.event_id = v_turn.message_event_id;
    IF NOT FOUND OR v_existing.role <> 'user' OR v_existing.content IS DISTINCT FROM p_content
      OR v_existing.author_id IS DISTINCT FROM v_actor_id THEN
      RAISE EXCEPTION 'client_message_id was reused with different message intent'
        USING ERRCODE = '23505', CONSTRAINT = 'companion_v3_turns_client_message_uq';
    END IF;
    turn := public.companion_v3_public_turn(v_turn); replayed := true; RETURN NEXT; RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.companion_turns legacy_turn
    WHERE legacy_turn.org_id = p_org_id AND legacy_turn.companion_id = p_companion_id
      AND legacy_turn.client_message_id = p_client_message_id) THEN RETURN; END IF;
  PERFORM 1 FROM public.companion_v3_instances instance
  WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  INSERT INTO public.companion_threads(org_id, companion_id)
  VALUES (p_org_id, p_companion_id)
  ON CONFLICT ON CONSTRAINT companion_threads_pkey DO NOTHING;

  SELECT * INTO v_admission FROM public.companion_v3_admit_turn(
    p_org_id, p_companion_id, p_client_message_id,
    'msg:' || p_client_message_id::text, v_actor_id, 'main'
  );
  SELECT * INTO STRICT v_turn FROM public.companion_v3_turns turn_row
  WHERE turn_row.id = v_admission.turn_id;
  UPDATE public.companion_threads thread
  SET next_ordinal = thread.next_ordinal + 1,
      projection_sequence = thread.projection_sequence + 1,
      last_message_at = v_now, updated_at = v_now
  WHERE thread.org_id = p_org_id AND thread.companion_id = p_companion_id
  RETURNING thread.next_ordinal - 1, thread.projection_sequence INTO v_ordinal, v_projection;
  INSERT INTO public.companion_transcript_entries(
    org_id, companion_id, event_id, ordinal, projection_sequence,
    role, content, author_id, created_at
  ) VALUES (
    p_org_id, p_companion_id, v_turn.message_event_id, v_ordinal, v_projection,
    'user', p_content, v_actor_id, v_now
  );
  turn := public.companion_v3_public_turn(v_turn); replayed := v_admission.replayed; RETURN NEXT;
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_runtime_claim_preparation(
  p_executor_id text,
  p_lease_seconds integer,
  p_protocol integer
)
RETURNS TABLE (
  org_id uuid, companion_id uuid, turn_id uuid, command_id uuid,
  work_kind text, checkpoint text, box_idempotency_key uuid, box_id text,
  claim_token uuid, claim_epoch bigint, gate_epoch bigint, model_id text, persona text,
  provider_material jsonb, created_at timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_now timestamp with time zone := clock_timestamp();
  v_instance public.companion_v3_instances%ROWTYPE;
  v_turn public.companion_v3_turns%ROWTYPE;
  v_gate_epoch bigint;
  v_model_id text;
  v_persona text;
  v_provider_material jsonb;
BEGIN
  IF p_protocol IS DISTINCT FROM 3 OR p_executor_id IS NULL
    OR char_length(p_executor_id) NOT BETWEEN 1 AND 200 OR p_executor_id ~ E'[\n\r]'
    OR p_lease_seconds NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION 'invalid Runtime v3 preparation claim' USING ERRCODE = '22023';
  END IF;
  SELECT control.gate_epoch INTO v_gate_epoch FROM public.companion_runtime_control control
  WHERE control.id = 'runtime-v2' AND control.enabled FOR SHARE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT instance.* INTO v_instance FROM public.companion_v3_instances instance
  WHERE instance.desired_lifecycle = 'prepare' AND instance.prepared_at IS NULL
    AND instance.preparation_available_at <= v_now
    AND (instance.preparation_claim_token IS NULL OR instance.preparation_expires_at <= v_now)
    AND EXISTS (
      SELECT 1 FROM public.companions companion
      JOIN public.memberships membership
        ON membership.org_id = companion.org_id AND membership.user_id = companion.owner_id
      JOIN public.companion_provider_connections connection
        ON connection.org_id = companion.org_id
       AND connection.provider_id = companion.provider_ids->>0
      WHERE companion.org_id = instance.org_id AND companion.id = instance.companion_id
    )
  ORDER BY EXISTS (
      SELECT 1 FROM public.companion_v3_turns queued
      WHERE queued.org_id = instance.org_id AND queued.companion_id = instance.companion_id
        AND queued.lane = 'main' AND queued.state = 'queued'
    ) DESC, instance.created_at, instance.companion_id
  LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT queued.* INTO v_turn FROM public.companion_v3_turns queued
  WHERE queued.org_id = v_instance.org_id AND queued.companion_id = v_instance.companion_id
    AND queued.lane = 'main' AND queued.state = 'queued'
  ORDER BY queued.queue_sequence, queued.id LIMIT 1;
  SELECT companion.model_id, companion.persona, jsonb_build_array(jsonb_build_object(
      'provider_id', connection.provider_id,
      'auth_method', connection.auth_method,
      'credential_generation', connection.credential_generation,
      'credential_version', connection.credential_version,
      'ciphertext', connection.ciphertext,
      'iv', connection.iv,
      'auth_tag', connection.auth_tag,
      'wrapped_dek', connection.wrapped_dek,
      'wrap_iv', connection.wrap_iv,
      'wrap_auth_tag', connection.wrap_auth_tag,
      'key_id', connection.key_id
    ))
  INTO v_model_id, v_persona, v_provider_material
  FROM public.companions companion
  JOIN public.memberships membership
    ON membership.org_id = companion.org_id AND membership.user_id = companion.owner_id
  JOIN public.companion_provider_connections connection
    ON connection.org_id = companion.org_id
   AND connection.provider_id = companion.provider_ids->>0
  WHERE companion.org_id = v_instance.org_id AND companion.id = v_instance.companion_id
    AND companion.model_id IS NOT NULL;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE public.companion_v3_instances instance SET
    preparation_claim_token = gen_random_uuid(),
    preparation_claim_epoch = instance.preparation_claim_epoch + 1,
    preparation_gate_epoch = v_gate_epoch,
    preparation_executor_id = p_executor_id,
    preparation_claimed_at = v_now,
    preparation_expires_at = v_now + make_interval(secs => p_lease_seconds),
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
  turn_id := v_turn.id; command_id := v_turn.command_id;
  work_kind := 'preparation';
  checkpoint := v_instance.preparation_checkpoint;
  box_idempotency_key := v_instance.box_idempotency_key; box_id := v_instance.box_id;
  model_id := v_model_id; persona := v_persona; provider_material := v_provider_material;
  created_at := v_instance.created_at; RETURN NEXT;
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_runtime_checkpoint_preparation(
  p_org_id uuid, p_companion_id uuid, p_claim_token uuid, p_claim_epoch bigint,
  p_gate_epoch bigint, p_expected text, p_next text, p_box_id text,
  p_pi_invocation_id text, p_protocol integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE v_now timestamp with time zone := clock_timestamp();
BEGIN
  IF p_protocol IS DISTINCT FROM 3 OR NOT (
      (p_expected = 'pending' AND p_next = 'box_created' AND p_box_id IS NOT NULL)
      OR (p_expected = 'box_created' AND p_next = 'box_ready')
      OR (p_expected = 'box_ready' AND p_next = 'staged')
      OR (p_expected = 'staged' AND p_next = 'prepared' AND p_pi_invocation_id IS NOT NULL)
    ) THEN RAISE EXCEPTION 'invalid Runtime v3 preparation checkpoint' USING ERRCODE = '22023';
  END IF;
  UPDATE public.companion_v3_instances instance SET
    preparation_checkpoint = p_next,
    box_id = CASE WHEN p_next = 'box_created' THEN p_box_id ELSE instance.box_id END,
    box_ready_at = CASE WHEN p_next = 'box_ready' THEN v_now ELSE instance.box_ready_at END,
    staging_completed_at = CASE WHEN p_next = 'staged' THEN v_now ELSE instance.staging_completed_at END,
    pi_invocation_id = CASE WHEN p_next = 'prepared' THEN p_pi_invocation_id ELSE instance.pi_invocation_id END,
    prepared_at = CASE WHEN p_next = 'prepared' THEN v_now ELSE instance.prepared_at END,
    preparation_error_code = NULL, preparation_error_message = NULL,
    preparation_available_at = v_now,
    preparation_claim_token = NULL, preparation_gate_epoch = NULL,
    preparation_executor_id = NULL, preparation_claimed_at = NULL, preparation_expires_at = NULL,
    updated_at = v_now
  FROM public.companion_runtime_control control
  WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id
    AND instance.preparation_checkpoint = p_expected
    AND instance.preparation_claim_token = p_claim_token
    AND instance.preparation_claim_epoch = p_claim_epoch
    AND instance.preparation_gate_epoch = p_gate_epoch
    AND instance.preparation_expires_at > v_now
    AND control.id = 'runtime-v2' AND control.enabled AND control.gate_epoch = p_gate_epoch;
  RETURN FOUND;
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_runtime_defer_preparation(
  p_org_id uuid, p_companion_id uuid, p_claim_token uuid, p_claim_epoch bigint,
  p_gate_epoch bigint, p_delay_seconds integer, p_code text, p_message text, p_protocol integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE v_now timestamp with time zone := clock_timestamp();
BEGIN
  IF p_protocol IS DISTINCT FROM 3 OR p_delay_seconds NOT BETWEEN 1 AND 300
    OR (p_code IS NULL) <> (p_message IS NULL)
    OR (p_code IS NOT NULL AND (p_code !~ '^[a-z][a-z0-9_]{0,63}$'
      OR char_length(p_message) NOT BETWEEN 1 AND 500 OR p_message ~ E'[\n\r]')) THEN
    RAISE EXCEPTION 'invalid Runtime v3 preparation deferral' USING ERRCODE = '22023';
  END IF;
  UPDATE public.companion_v3_instances instance SET
    preparation_available_at = v_now + make_interval(secs => p_delay_seconds),
    preparation_attempt_count = instance.preparation_attempt_count + CASE WHEN p_code IS NULL THEN 0 ELSE 1 END,
    preparation_error_code = p_code, preparation_error_message = p_message,
    preparation_claim_token = NULL, preparation_gate_epoch = NULL,
    preparation_executor_id = NULL, preparation_claimed_at = NULL, preparation_expires_at = NULL,
    updated_at = v_now
  FROM public.companion_runtime_control control
  WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id
    AND instance.preparation_claim_token = p_claim_token
    AND instance.preparation_claim_epoch = p_claim_epoch
    AND instance.preparation_gate_epoch = p_gate_epoch
    AND instance.preparation_expires_at > v_now
    AND control.id = 'runtime-v2' AND control.enabled AND control.gate_epoch = p_gate_epoch;
  RETURN FOUND;
END
$$;
--> statement-breakpoint

-- Admission records the real asynchronous preparation chronology approved by THE-513.
CREATE OR REPLACE FUNCTION public.companion_v3_measure_progress()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE v_instance public.companion_v3_instances%ROWTYPE;
BEGIN
  IF OLD.admission_state <> 'accepted' AND NEW.admission_state = 'accepted' THEN
    SELECT instance.* INTO v_instance FROM public.companion_v3_instances instance
    WHERE instance.org_id = NEW.org_id AND instance.companion_id = NEW.companion_id;
    NEW.box_ready_at := coalesce(NEW.box_ready_at, v_instance.box_ready_at);
    NEW.staging_completed_at := coalesce(NEW.staging_completed_at, v_instance.staging_completed_at);
    NEW.pi_ready_at := coalesce(NEW.pi_ready_at, v_instance.prepared_at);
    NEW.admission_kind := coalesce(NEW.admission_kind, 'prompt');
  END IF;
  IF NEW.admission_state = 'accepted'
    AND NEW.activity_cursor > coalesce(NEW.admission_cursor, NEW.activity_cursor)
    AND NEW.activity_cursor > OLD.activity_cursor THEN
    NEW.first_activity_at := coalesce(OLD.first_activity_at, clock_timestamp());
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_v3_api_create_companion(
  uuid,text,text,text,text,jsonb,boolean,jsonb,uuid,smallint,smallint,smallint,smallint
) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_v3_runtime_claim_preparation(text,integer,integer) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_v3_runtime_checkpoint_preparation(
  uuid,uuid,uuid,bigint,bigint,text,text,text,text,integer
) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_v3_runtime_defer_preparation(
  uuid,uuid,uuid,bigint,bigint,integer,text,text,integer
) FROM PUBLIC;
