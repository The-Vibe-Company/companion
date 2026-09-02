-- First Runtime v3 tracer bullet. A prepared warm Companion may accept one public text Turn,
-- admit it to Pi, and project its result without creating a v3 attempt or derived operation.
ALTER TABLE public.companion_v3_instances
  ADD COLUMN box_id text,
  ADD COLUMN pi_invocation_id text,
  ADD COLUMN prepared_at timestamp with time zone,
  ADD CONSTRAINT companion_v3_instances_prepared_check CHECK (
    (box_id IS NULL AND pi_invocation_id IS NULL AND prepared_at IS NULL)
    OR (
      box_id ~ '^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$'
      AND char_length(pi_invocation_id) BETWEEN 1 AND 200
      AND pi_invocation_id !~ E'[\n\r]'
      AND prepared_at IS NOT NULL
    )
  );
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_public_turn(p_turn public.companion_v3_turns)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
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
    'error', CASE WHEN p_turn.outcome IN ('failed', 'interrupted') THEN jsonb_build_object(
      'code', p_turn.outcome_code,
      'message', p_turn.outcome_message,
      'action', p_turn.outcome_action
    ) ELSE NULL END,
    'state_changed_at', p_turn.updated_at,
    'settled_at', p_turn.settled_at,
    'created_at', p_turn.created_at,
    'updated_at', p_turn.updated_at
  )
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_api_enqueue_warm_turn(
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

  -- Preparation is a runtime-owned durable fact. The send only locks and consumes it; it never
  -- derives readiness from v2 observations or refreshes the proof while accepting user intent.
  PERFORM 1 FROM public.companion_v3_instances instance
  WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id
    AND instance.box_id IS NOT NULL AND instance.pi_invocation_id IS NOT NULL
    AND instance.prepared_at IS NOT NULL
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT * INTO v_admission FROM public.companion_v3_admit_turn(
    p_org_id, p_companion_id, p_client_message_id,
    'msg:' || p_client_message_id::text, v_actor_id, 'main'
  );
  SELECT * INTO STRICT v_turn FROM public.companion_v3_turns turn_row
  WHERE turn_row.id = v_admission.turn_id;

  SELECT * INTO v_existing FROM public.companion_transcript_entries entry
  WHERE entry.org_id = p_org_id AND entry.companion_id = p_companion_id
    AND entry.event_id = v_turn.message_event_id;
  IF FOUND THEN
    IF v_existing.role <> 'user' OR v_existing.content IS DISTINCT FROM p_content
      OR v_existing.author_id IS DISTINCT FROM v_actor_id THEN
      RAISE EXCEPTION 'client_message_id was reused with different message intent'
        USING ERRCODE = '23505', CONSTRAINT = 'companion_v3_turns_client_message_uq';
    END IF;
  ELSE
    INSERT INTO public.companion_threads(org_id, companion_id)
    VALUES (p_org_id, p_companion_id)
    ON CONFLICT (companion_id) DO NOTHING;
    UPDATE public.companion_threads thread
    SET next_ordinal = thread.next_ordinal + 1,
        projection_sequence = thread.projection_sequence + 1,
        last_message_at = v_now,
        updated_at = v_now
    WHERE thread.org_id = p_org_id AND thread.companion_id = p_companion_id
    RETURNING thread.next_ordinal - 1, thread.projection_sequence
      INTO v_ordinal, v_projection;
    INSERT INTO public.companion_transcript_entries(
      org_id, companion_id, event_id, ordinal, projection_sequence,
      role, content, author_id, created_at
    ) VALUES (
      p_org_id, p_companion_id, v_turn.message_event_id, v_ordinal, v_projection,
      'user', p_content, v_actor_id, v_now
    );
  END IF;

  turn := public.companion_v3_public_turn(v_turn);
  replayed := v_admission.replayed;
  RETURN NEXT;
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_api_read_projection(
  p_org_id uuid,
  p_companion_id uuid,
  p_event_ids jsonb
)
RETURNS TABLE (
  active_turn jsonb,
  queued_count integer,
  is_replying boolean,
  message_turns jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_active public.companion_v3_turns%ROWTYPE;
  v_has_active boolean := false;
BEGIN
  PERFORM public.companion_api_require_access(p_org_id, p_companion_id, 'read');
  IF jsonb_typeof(p_event_ids) IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_event_ids) > 1000 THEN
    RAISE EXCEPTION 'invalid Runtime v3 projection request' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.companion_v3_turns turn_row
    WHERE turn_row.org_id = p_org_id AND turn_row.companion_id = p_companion_id
  ) THEN RETURN; END IF;

  SELECT turn_row.* INTO v_active
  FROM public.companion_v3_turns turn_row
  WHERE turn_row.org_id = p_org_id AND turn_row.companion_id = p_companion_id
    AND turn_row.lane = 'main'
    AND turn_row.state IN ('admitted', 'running', 'needs_input')
  ORDER BY turn_row.queue_sequence, turn_row.id
  LIMIT 1;

  v_has_active := FOUND;
  active_turn := CASE WHEN v_has_active THEN public.companion_v3_public_turn(v_active) ELSE NULL END;
  SELECT count(*)::integer INTO queued_count
  FROM public.companion_v3_turns turn_row
  WHERE turn_row.org_id = p_org_id AND turn_row.companion_id = p_companion_id
    AND turn_row.lane = 'main' AND turn_row.state = 'queued';
  is_replying := v_has_active AND v_active.admission_state = 'accepted'
    AND v_active.state IN ('admitted', 'running');
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'event_id', turn_row.message_event_id,
    'turn', public.companion_v3_public_turn(turn_row)
  ) ORDER BY turn_row.queue_sequence), '[]'::jsonb)
  INTO message_turns
  FROM public.companion_v3_turns turn_row
  WHERE turn_row.org_id = p_org_id AND turn_row.companion_id = p_companion_id
    AND p_event_ids ? turn_row.message_event_id;
  RETURN NEXT;
END
$$;
--> statement-breakpoint

-- Production warm convergence has a narrower claim surface than the generic v3 progression
-- primitive. It takes work only for runtime-owned durable preparation, while authorization below
-- revalidates that fact under the resulting fence immediately before any Pi contact.
CREATE FUNCTION public.companion_v3_runtime_claim_warm(
  p_executor_id text,
  p_lane public.companion_v3_lane,
  p_lease_seconds integer,
  p_protocol integer
)
RETURNS TABLE (
  org_id uuid,
  companion_id uuid,
  turn_id uuid,
  command_id uuid,
  lane public.companion_v3_lane,
  state public.companion_v3_turn_state,
  claim_token uuid,
  claim_epoch bigint,
  gate_epoch bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_now timestamp with time zone := clock_timestamp();
  v_lease public.companion_v3_lane_leases%ROWTYPE;
  v_turn public.companion_v3_turns%ROWTYPE;
  v_gate_epoch bigint;
BEGIN
  IF p_protocol IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'Runtime v3 protocol is required' USING ERRCODE = '42501';
  END IF;
  IF p_executor_id IS NULL OR char_length(p_executor_id) NOT BETWEEN 1 AND 200
    OR p_executor_id ~ E'[\n\r]' OR p_lease_seconds IS NULL
    OR p_lease_seconds NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION 'invalid Runtime v3 warm claim' USING ERRCODE = '22023';
  END IF;
  SELECT control.gate_epoch INTO v_gate_epoch
  FROM public.companion_runtime_control control
  WHERE control.id = 'runtime-v2' AND control.enabled
  FOR SHARE;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT lease.* INTO v_lease
  FROM public.companion_v3_lane_leases lease
  JOIN public.companion_v3_instances instance
    ON instance.org_id = lease.org_id AND instance.companion_id = lease.companion_id
   AND instance.box_id IS NOT NULL AND instance.pi_invocation_id IS NOT NULL
   AND instance.prepared_at IS NOT NULL
  JOIN public.companion_v3_turns queued
    ON queued.org_id = lease.org_id AND queued.companion_id = lease.companion_id
   AND queued.lane = lease.lane AND queued.state = 'queued'
  WHERE lease.lane = p_lane
    AND (lease.claim_token IS NULL OR lease.expires_at <= v_now)
    AND NOT EXISTS (
      SELECT 1 FROM public.companion_v3_turns active
      WHERE active.org_id = lease.org_id AND active.companion_id = lease.companion_id
        AND active.lane = lease.lane
        AND active.state IN ('admitted', 'running', 'needs_input')
    )
  ORDER BY queued.created_at, queued.queue_sequence, queued.id
  LIMIT 1
  FOR UPDATE OF lease SKIP LOCKED;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT queued.* INTO v_turn
  FROM public.companion_v3_turns queued
  JOIN public.companion_v3_instances instance
    ON instance.org_id = queued.org_id AND instance.companion_id = queued.companion_id
   AND instance.box_id IS NOT NULL AND instance.pi_invocation_id IS NOT NULL
   AND instance.prepared_at IS NOT NULL
  WHERE queued.org_id = v_lease.org_id
    AND queued.companion_id = v_lease.companion_id
    AND queued.lane = p_lane
    AND queued.state = 'queued'
  ORDER BY queued.queue_sequence, queued.id
  LIMIT 1
  FOR UPDATE OF queued;
  IF NOT FOUND THEN RETURN; END IF;

  UPDATE public.companion_v3_lane_leases lease
  SET claim_token = gen_random_uuid(),
      claim_epoch = lease.claim_epoch + 1,
      gate_epoch = v_gate_epoch,
      executor_id = p_executor_id,
      turn_id = v_turn.id,
      claimed_at = v_now,
      renewed_at = v_now,
      expires_at = v_now + make_interval(secs => p_lease_seconds),
      updated_at = v_now
  WHERE lease.org_id = v_lease.org_id
    AND lease.companion_id = v_lease.companion_id
    AND lease.lane = p_lane
  RETURNING lease.claim_token, lease.claim_epoch, lease.gate_epoch
  INTO claim_token, claim_epoch, gate_epoch;

  org_id := v_turn.org_id;
  companion_id := v_turn.companion_id;
  turn_id := v_turn.id;
  command_id := v_turn.command_id;
  lane := v_turn.lane;
  state := v_turn.state;
  RETURN NEXT;
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_runtime_authorize_warm_turn(
  p_org_id uuid,
  p_companion_id uuid,
  p_lane public.companion_v3_lane,
  p_turn_id uuid,
  p_claim_token uuid,
  p_claim_epoch bigint,
  p_gate_epoch bigint,
  p_protocol integer
)
RETURNS TABLE (box_id text, pi_invocation_id text, content text, activity_cursor bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE v_now timestamp with time zone := clock_timestamp();
BEGIN
  IF p_protocol IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'Runtime v3 protocol is required' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT instance.box_id, instance.pi_invocation_id, entry.content, turn_row.activity_cursor
  FROM public.companion_v3_lane_leases lease
  JOIN public.companion_runtime_control control
    ON control.id = 'runtime-v2' AND control.enabled AND control.gate_epoch = p_gate_epoch
  JOIN public.companion_v3_turns turn_row
    ON turn_row.org_id = lease.org_id AND turn_row.companion_id = lease.companion_id
   AND turn_row.id = lease.turn_id AND turn_row.lane = lease.lane
  JOIN public.companion_v3_instances instance
    ON instance.org_id = turn_row.org_id AND instance.companion_id = turn_row.companion_id
   AND instance.box_id IS NOT NULL AND instance.pi_invocation_id IS NOT NULL
   AND instance.prepared_at IS NOT NULL
  JOIN public.companions companion
    ON companion.org_id = turn_row.org_id AND companion.id = turn_row.companion_id
  JOIN public.memberships membership
    ON membership.org_id = turn_row.org_id AND membership.user_id = turn_row.actor_id
  LEFT JOIN public.companion_workspace_access workspace_access
    ON workspace_access.org_id = turn_row.org_id
   AND workspace_access.companion_id = turn_row.companion_id
  JOIN public.companion_transcript_entries entry
    ON entry.org_id = turn_row.org_id AND entry.companion_id = turn_row.companion_id
   AND entry.event_id = turn_row.message_event_id AND entry.role = 'user'
  WHERE lease.org_id = p_org_id AND lease.companion_id = p_companion_id
    AND lease.lane = p_lane AND lease.turn_id = p_turn_id
    AND lease.claim_token = p_claim_token AND lease.claim_epoch = p_claim_epoch
    AND lease.gate_epoch = p_gate_epoch AND lease.expires_at > v_now
    AND turn_row.state = 'queued'
    AND (companion.owner_id = turn_row.actor_id OR workspace_access.role = 'editor')
    AND jsonb_typeof(companion.provider_ids) = 'array'
    AND jsonb_array_length(companion.provider_ids) = 1
    AND companion.model_id IS NOT NULL
    AND char_length(companion.model_id) BETWEEN 1 AND 200
    AND companion.model_id !~ E'[\n\r]'
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(companion.provider_ids) selected(provider_id)
      WHERE NOT EXISTS (
        SELECT 1 FROM public.companion_provider_connections connection
        WHERE connection.org_id = turn_row.org_id
          AND connection.provider_id = selected.provider_id
        FOR NO KEY UPDATE
      )
    )
    AND jsonb_typeof(companion.selected_skill_ids) = 'array'
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(companion.selected_skill_ids) selected(skill_id)
      WHERE NOT EXISTS (
        SELECT 1 FROM public.skills skill
        WHERE skill.org_id = turn_row.org_id
          AND skill.id::text = selected.skill_id
          AND skill.archived_at IS NULL
          AND (skill.scope = 'org' OR skill.creator_id = turn_row.actor_id)
        FOR NO KEY UPDATE
      )
    )
    AND jsonb_typeof(companion.selected_mcp_account_ids) = 'array'
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(companion.selected_mcp_account_ids) selected(account_id)
      WHERE NOT EXISTS (
        SELECT 1 FROM public.companion_mcp_accounts account
        WHERE account.org_id = turn_row.org_id
          AND account.id::text = selected.account_id
          AND account.owner_id = turn_row.actor_id
        FOR NO KEY UPDATE
      )
    );
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_runtime_record_admission(
  p_org_id uuid,
  p_companion_id uuid,
  p_lane public.companion_v3_lane,
  p_turn_id uuid,
  p_claim_token uuid,
  p_claim_epoch bigint,
  p_gate_epoch bigint,
  p_pi_invocation_id text,
  p_cursor bigint,
  p_protocol integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE v_now timestamp with time zone := clock_timestamp();
BEGIN
  -- The durable thread projection tables still carry the v2-era mutation fence. This scoped GUC
  -- is its compatibility token, not an authorization boundary; the v3 lease fence below remains
  -- the authority for this write.
  PERFORM pg_catalog.set_config('app.companion_runtime_protocol', '2', true);
  IF p_protocol IS DISTINCT FROM 3 OR p_cursor < 0
    OR p_pi_invocation_id IS NULL OR char_length(p_pi_invocation_id) NOT BETWEEN 1 AND 200
    OR p_pi_invocation_id ~ E'[\n\r]' THEN
    RAISE EXCEPTION 'invalid Runtime v3 admission' USING ERRCODE = '22023';
  END IF;
  UPDATE public.companion_v3_turns turn_row
  SET state = 'admitted', admission_state = 'accepted', admitted_at = v_now,
      pi_invocation_id = p_pi_invocation_id, admission_cursor = p_cursor,
      activity_cursor = p_cursor, last_activity_at = v_now, updated_at = v_now
  FROM public.companion_v3_lane_leases lease, public.companion_runtime_control control
  WHERE turn_row.org_id = p_org_id AND turn_row.companion_id = p_companion_id
    AND turn_row.id = p_turn_id AND turn_row.lane = p_lane AND turn_row.state = 'queued'
    AND lease.org_id = turn_row.org_id AND lease.companion_id = turn_row.companion_id
    AND lease.lane = turn_row.lane AND lease.turn_id = turn_row.id
    AND lease.claim_token = p_claim_token AND lease.claim_epoch = p_claim_epoch
    AND lease.gate_epoch = p_gate_epoch AND lease.expires_at > v_now
    AND control.id = 'runtime-v2' AND control.enabled AND control.gate_epoch = p_gate_epoch;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE public.companion_threads thread
  SET projection_sequence = thread.projection_sequence + 1, updated_at = v_now
  WHERE thread.org_id = p_org_id AND thread.companion_id = p_companion_id;
  RETURN true;
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_runtime_project_page(
  p_org_id uuid,
  p_companion_id uuid,
  p_lane public.companion_v3_lane,
  p_turn_id uuid,
  p_claim_token uuid,
  p_claim_epoch bigint,
  p_gate_epoch bigint,
  p_through_cursor bigint,
  p_assistant jsonb,
  p_needs_input boolean,
  p_settled boolean,
  p_protocol integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_now timestamp with time zone := clock_timestamp();
  v_item jsonb;
  v_ordinal integer;
  v_projection bigint;
BEGIN
  PERFORM pg_catalog.set_config('app.companion_runtime_protocol', '2', true);
  IF p_protocol IS DISTINCT FROM 3 OR p_through_cursor < 0
    OR jsonb_typeof(p_assistant) IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_assistant) > 32
    OR (p_needs_input AND p_settled) THEN
    RAISE EXCEPTION 'invalid Runtime v3 projection' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.companion_v3_lane_leases lease
  JOIN public.companion_runtime_control control
    ON control.id = 'runtime-v2' AND control.enabled AND control.gate_epoch = p_gate_epoch
  JOIN public.companion_v3_turns turn_row
    ON turn_row.org_id = lease.org_id AND turn_row.companion_id = lease.companion_id
   AND turn_row.id = lease.turn_id AND turn_row.lane = lease.lane
  WHERE lease.org_id = p_org_id AND lease.companion_id = p_companion_id
    AND lease.lane = p_lane AND lease.turn_id = p_turn_id
    AND lease.claim_token = p_claim_token AND lease.claim_epoch = p_claim_epoch
    AND lease.gate_epoch = p_gate_epoch AND lease.expires_at > v_now
    AND turn_row.state IN ('admitted', 'running', 'needs_input')
    AND turn_row.admission_state = 'accepted'
    AND p_through_cursor >= turn_row.activity_cursor
  FOR UPDATE OF lease, turn_row;
  IF NOT FOUND THEN RETURN false; END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_assistant) LOOP
    IF jsonb_typeof(v_item) <> 'object'
      OR coalesce(v_item->>'eventId', '') !~ '^v3:[0-9a-f-]{36}:[0-9]+$'
      OR char_length(coalesce(v_item->>'content', '')) < 1
      OR octet_length(v_item->>'content') > 1048576 THEN
      RAISE EXCEPTION 'invalid Runtime v3 assistant projection' USING ERRCODE = '22023';
    END IF;
    PERFORM 1 FROM public.companion_transcript_entries entry
    WHERE entry.org_id = p_org_id AND entry.companion_id = p_companion_id
      AND entry.event_id = v_item->>'eventId'
      AND entry.role = 'assistant' AND entry.content = v_item->>'content';
    IF NOT FOUND AND EXISTS (
      SELECT 1 FROM public.companion_transcript_entries entry
      WHERE entry.org_id = p_org_id AND entry.companion_id = p_companion_id
        AND entry.event_id = v_item->>'eventId'
    ) THEN
      RAISE EXCEPTION 'Runtime v3 assistant projection conflict' USING ERRCODE = '23505';
    ELSIF NOT FOUND THEN
      UPDATE public.companion_threads thread
      SET next_ordinal = thread.next_ordinal + 1,
          projection_sequence = thread.projection_sequence + 1,
          last_message_at = v_now, updated_at = v_now
      WHERE thread.org_id = p_org_id AND thread.companion_id = p_companion_id
      RETURNING thread.next_ordinal - 1, thread.projection_sequence
        INTO v_ordinal, v_projection;
      INSERT INTO public.companion_transcript_entries(
        org_id, companion_id, event_id, ordinal, projection_sequence,
        role, content, created_at
      ) VALUES (
        p_org_id, p_companion_id, v_item->>'eventId', v_ordinal, v_projection,
        'assistant', v_item->>'content', v_now
      );
    END IF;
  END LOOP;

  UPDATE public.companion_v3_turns turn_row
  SET state = CASE WHEN p_needs_input THEN 'needs_input'::public.companion_v3_turn_state
        ELSE 'running'::public.companion_v3_turn_state END,
      activity_cursor = p_through_cursor, last_activity_at = v_now, updated_at = v_now
  WHERE turn_row.org_id = p_org_id AND turn_row.companion_id = p_companion_id
    AND turn_row.id = p_turn_id;
  IF jsonb_array_length(p_assistant) = 0 THEN
    UPDATE public.companion_threads thread
    SET projection_sequence = thread.projection_sequence + 1, updated_at = v_now
    WHERE thread.org_id = p_org_id AND thread.companion_id = p_companion_id;
  END IF;
  RETURN true;
END
$$;
--> statement-breakpoint

-- Terminal settlement now follows positive admission facts instead of assuming every claimed Turn
-- is still queued. Failure before admission remains terminal and always releases the lane.
CREATE OR REPLACE FUNCTION public.companion_v3_runtime_complete(
  p_org_id uuid,
  p_companion_id uuid,
  p_lane public.companion_v3_lane,
  p_turn_id uuid,
  p_claim_token uuid,
  p_claim_epoch bigint,
  p_gate_epoch bigint,
  p_outcome text,
  p_code text,
  p_message text,
  p_action public.companion_runtime_error_action,
  p_protocol integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE v_now timestamp with time zone := clock_timestamp();
BEGIN
  PERFORM pg_catalog.set_config('app.companion_runtime_protocol', '2', true);
  IF p_protocol IS DISTINCT FROM 3 OR p_gate_epoch IS NULL OR p_gate_epoch < 1
    OR p_outcome IS NULL OR p_outcome NOT IN ('release', 'succeeded', 'failed', 'interrupted')
    OR (p_outcome IN ('failed', 'interrupted') AND (
      p_code IS NULL OR p_message IS NULL OR p_action IS NULL OR p_action = 'restart_box'))
    OR (p_outcome IN ('release', 'succeeded') AND (
      p_code IS NOT NULL OR p_message IS NOT NULL OR p_action IS NOT NULL)) THEN
    RAISE EXCEPTION 'invalid Runtime v3 completion' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.companion_runtime_control control
  WHERE control.id = 'runtime-v2' AND control.enabled AND control.gate_epoch = p_gate_epoch
  FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM 1 FROM public.companion_v3_lane_leases lease
  WHERE lease.org_id = p_org_id AND lease.companion_id = p_companion_id
    AND lease.lane = p_lane AND lease.turn_id = p_turn_id
    AND lease.claim_token = p_claim_token AND lease.claim_epoch = p_claim_epoch
    AND lease.gate_epoch = p_gate_epoch AND lease.expires_at > v_now
  FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  IF p_outcome <> 'release' THEN
    UPDATE public.companion_v3_turns turn_row
    SET state = p_outcome::public.companion_v3_turn_state,
        outcome = p_outcome::public.companion_v3_turn_outcome,
        outcome_code = p_code, outcome_message = p_message, outcome_action = p_action,
        settled_at = v_now, updated_at = v_now
    WHERE turn_row.org_id = p_org_id AND turn_row.companion_id = p_companion_id
      AND turn_row.id = p_turn_id
      AND turn_row.state IN ('queued', 'admitted', 'running', 'needs_input');
    IF NOT FOUND THEN RETURN false; END IF;
    UPDATE public.companion_threads thread
    SET projection_sequence = thread.projection_sequence + 1, updated_at = v_now
    WHERE thread.org_id = p_org_id AND thread.companion_id = p_companion_id;
  END IF;
  UPDATE public.companion_v3_lane_leases lease
  SET claim_token = NULL, gate_epoch = NULL, executor_id = NULL, turn_id = NULL,
      claimed_at = NULL, renewed_at = NULL, expires_at = NULL, updated_at = v_now
  WHERE lease.org_id = p_org_id AND lease.companion_id = p_companion_id
    AND lease.lane = p_lane AND lease.claim_token = p_claim_token
    AND lease.claim_epoch = p_claim_epoch;
  RETURN FOUND;
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_v3_public_turn(public.companion_v3_turns) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_v3_api_enqueue_warm_turn(uuid,uuid,uuid,text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_v3_api_read_projection(uuid,uuid,jsonb) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_v3_runtime_claim_warm(
  text,public.companion_v3_lane,integer,integer
) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_v3_runtime_authorize_warm_turn(
  uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,integer
) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_v3_runtime_record_admission(
  uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,text,bigint,integer
) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_v3_runtime_project_page(
  uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,bigint,jsonb,boolean,boolean,integer
) FROM PUBLIC;
