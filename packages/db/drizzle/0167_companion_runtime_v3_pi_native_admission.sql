-- THE-518: PostgreSQL keeps every message identity and its FIFO position while Pi alone decides,
-- atomically inside prompt(streamingBehavior=steer), whether the admission starts or steers a run.
ALTER TABLE public.companion_v3_turns
  ADD COLUMN response_turn_id uuid,
  ADD COLUMN terminal_cursor bigint,
  ADD COLUMN journal_ack_pending boolean NOT NULL DEFAULT false;
--> statement-breakpoint
UPDATE public.companion_v3_turns
SET response_turn_id = id
WHERE admission_state = 'accepted';
--> statement-breakpoint
ALTER TABLE public.companion_v3_turns
  ADD CONSTRAINT companion_v3_turns_response_turn_fk
    FOREIGN KEY (org_id, companion_id, response_turn_id)
    REFERENCES public.companion_v3_turns(org_id, companion_id, id),
  ADD CONSTRAINT companion_v3_turns_response_turn_check CHECK (
    (admission_state = 'pending' AND response_turn_id IS NULL)
    OR (admission_state = 'accepted' AND response_turn_id IS NOT NULL)
    OR admission_state = 'ambiguous'
  ),
  ADD CONSTRAINT companion_v3_turns_terminal_cursor_check CHECK (
    (terminal_cursor IS NULL AND NOT journal_ack_pending)
    OR (terminal_cursor IS NOT NULL AND terminal_cursor >= 0)
  );
--> statement-breakpoint
CREATE INDEX companion_v3_turns_response_active_idx
  ON public.companion_v3_turns(org_id, companion_id, lane, response_turn_id, queue_sequence)
  WHERE state IN ('admitted', 'running', 'needs_input');
--> statement-breakpoint

-- Every queued message is eligible even while Pi is active. Accepted response roots are also
-- reclaimable, so journal projection survives executor loss. The oldest queued row remains the
-- only queued candidate while claim counts alternate admission with durable journal progress.
CREATE OR REPLACE FUNCTION public.companion_v3_runtime_claim_warm(
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
  v_now timestamptz := clock_timestamp();
  v_lease public.companion_v3_lane_leases%ROWTYPE;
  v_turn public.companion_v3_turns%ROWTYPE;
  v_gate_epoch bigint;
  v_expired_org uuid;
  v_expired_companion uuid;
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
  WHERE control.id = 'runtime-v2' AND control.enabled FOR SHARE;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT instance.org_id, instance.companion_id
    INTO v_expired_org, v_expired_companion
  FROM public.companion_v3_instances instance
  JOIN public.companion_v3_turns eligible
    ON eligible.org_id = instance.org_id AND eligible.companion_id = instance.companion_id
   AND eligible.lane = p_lane
   AND ((eligible.state = 'queued' AND NOT EXISTS (
     SELECT 1 FROM public.companion_v3_turns earlier
     WHERE earlier.org_id = eligible.org_id AND earlier.companion_id = eligible.companion_id
       AND earlier.lane = eligible.lane AND earlier.state = 'queued'
       AND earlier.queue_sequence < eligible.queue_sequence
   )) OR (
     eligible.state IN ('admitted', 'running', 'needs_input')
     AND eligible.admission_state = 'accepted' AND eligible.response_turn_id = eligible.id
   ) OR (
     eligible.state IN ('succeeded', 'failed')
     AND eligible.journal_ack_pending AND eligible.response_turn_id = eligible.id
   ))
  WHERE instance.prepared_at IS NOT NULL
    AND (instance.prepared_material_expires_at IS NULL
      OR instance.prepared_material_expires_at <= v_now + interval '2 hours 5 minutes')
  ORDER BY eligible.claim_count, eligible.queue_sequence, eligible.id
  LIMIT 1 FOR UPDATE OF instance SKIP LOCKED;
  IF FOUND THEN
    PERFORM public.companion_v3_invalidate_preparation(v_expired_org, v_expired_companion);
    RETURN;
  END IF;

  SELECT lease.* INTO v_lease
  FROM public.companion_v3_lane_leases lease
  JOIN public.companion_v3_instances instance
    ON instance.org_id = lease.org_id AND instance.companion_id = lease.companion_id
   AND instance.box_id IS NOT NULL AND instance.pi_invocation_id IS NOT NULL
   AND instance.prepared_at IS NOT NULL
   AND (instance.prepared_material_expires_at IS NULL
     OR instance.prepared_material_expires_at > v_now + interval '2 hours 5 minutes')
  JOIN public.companion_v3_turns eligible
    ON eligible.org_id = lease.org_id AND eligible.companion_id = lease.companion_id
   AND eligible.lane = lease.lane
   AND ((eligible.state = 'queued' AND NOT EXISTS (
     SELECT 1 FROM public.companion_v3_turns earlier
     WHERE earlier.org_id = eligible.org_id AND earlier.companion_id = eligible.companion_id
       AND earlier.lane = eligible.lane AND earlier.state = 'queued'
       AND earlier.queue_sequence < eligible.queue_sequence
   )) OR (
     eligible.state IN ('admitted', 'running', 'needs_input')
     AND eligible.admission_state = 'accepted' AND eligible.response_turn_id = eligible.id
   ) OR (
     eligible.state IN ('succeeded', 'failed')
     AND eligible.journal_ack_pending AND eligible.response_turn_id = eligible.id
   ))
  WHERE lease.lane = p_lane
    AND (lease.claim_token IS NULL OR lease.expires_at <= v_now)
  ORDER BY eligible.claim_count, eligible.queue_sequence, eligible.id
  LIMIT 1 FOR UPDATE OF lease SKIP LOCKED;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT eligible.* INTO v_turn
  FROM public.companion_v3_turns eligible
  WHERE eligible.org_id = v_lease.org_id
    AND eligible.companion_id = v_lease.companion_id
    AND eligible.lane = p_lane
    AND ((eligible.state = 'queued' AND NOT EXISTS (
      SELECT 1 FROM public.companion_v3_turns earlier
      WHERE earlier.org_id = eligible.org_id AND earlier.companion_id = eligible.companion_id
        AND earlier.lane = eligible.lane AND earlier.state = 'queued'
        AND earlier.queue_sequence < eligible.queue_sequence
    )) OR (
      eligible.state IN ('admitted', 'running', 'needs_input')
      AND eligible.admission_state = 'accepted' AND eligible.response_turn_id = eligible.id
    ) OR (
      eligible.state IN ('succeeded', 'failed')
      AND eligible.journal_ack_pending AND eligible.response_turn_id = eligible.id
    ))
  ORDER BY eligible.claim_count, eligible.queue_sequence, eligible.id
  LIMIT 1 FOR UPDATE OF eligible;
  IF NOT FOUND THEN RETURN; END IF;

  UPDATE public.companion_v3_lane_leases lease SET
    claim_token = gen_random_uuid(), claim_epoch = lease.claim_epoch + 1,
    gate_epoch = v_gate_epoch, executor_id = p_executor_id, turn_id = v_turn.id,
    claimed_at = v_now, renewed_at = v_now,
    expires_at = v_now + make_interval(secs => p_lease_seconds), updated_at = v_now
  WHERE lease.org_id = v_lease.org_id AND lease.companion_id = v_lease.companion_id
    AND lease.lane = p_lane
  RETURNING lease.claim_token, lease.claim_epoch, lease.gate_epoch
    INTO claim_token, claim_epoch, gate_epoch;
  org_id := v_turn.org_id; companion_id := v_turn.companion_id;
  turn_id := v_turn.id; command_id := v_turn.command_id;
  lane := v_turn.lane; state := v_turn.state;
  RETURN NEXT;
END $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.companion_v3_runtime_authorize_warm_turn(
  p_org_id uuid, p_companion_id uuid, p_lane public.companion_v3_lane,
  p_turn_id uuid, p_claim_token uuid, p_claim_epoch bigint,
  p_gate_epoch bigint, p_protocol integer
)
RETURNS TABLE (box_id text, pi_invocation_id text, content text, activity_cursor bigint)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = on AS $$
DECLARE v_now timestamptz := clock_timestamp();
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
   AND (instance.prepared_material_expires_at IS NULL
     OR instance.prepared_material_expires_at > v_now + interval '2 hours 5 minutes')
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
    AND (turn_row.state = 'queued' OR (
      turn_row.state IN ('admitted', 'running', 'needs_input')
      AND turn_row.admission_state = 'accepted'
      AND turn_row.response_turn_id = turn_row.id
      AND turn_row.pi_invocation_id = instance.pi_invocation_id
    ) OR (
      turn_row.state IN ('succeeded', 'failed')
      AND turn_row.journal_ack_pending
      AND turn_row.response_turn_id = turn_row.id
      AND turn_row.pi_invocation_id = instance.pi_invocation_id
    ))
    AND (companion.owner_id = turn_row.actor_id OR workspace_access.role = 'editor')
    AND jsonb_typeof(companion.provider_ids) = 'array'
    AND jsonb_array_length(companion.provider_ids) = 1
    AND companion.model_id IS NOT NULL AND char_length(companion.model_id) BETWEEN 1 AND 200
    AND companion.model_id !~ E'[\n\r]'
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(companion.provider_ids) selected(provider_id)
      WHERE NOT EXISTS (SELECT 1 FROM public.companion_provider_connections connection
        WHERE connection.org_id = turn_row.org_id
          AND connection.provider_id = selected.provider_id FOR NO KEY UPDATE)
    )
    AND jsonb_typeof(companion.selected_skill_ids) = 'array'
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(companion.selected_skill_ids) selected(skill_id)
      WHERE NOT EXISTS (SELECT 1 FROM public.skills skill
        WHERE skill.org_id = turn_row.org_id AND skill.id::text = selected.skill_id
          AND skill.archived_at IS NULL
          AND (skill.scope = 'org' OR skill.creator_id = turn_row.actor_id) FOR NO KEY UPDATE)
    )
    AND jsonb_typeof(companion.selected_mcp_account_ids) = 'array'
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(companion.selected_mcp_account_ids) selected(account_id)
      WHERE NOT EXISTS (SELECT 1 FROM public.companion_mcp_accounts account
        WHERE account.org_id = turn_row.org_id AND account.id::text = selected.account_id
          AND account.owner_id = turn_row.actor_id FOR NO KEY UPDATE)
    );
END $$;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_runtime_record_native_admission(
  p_org_id uuid, p_companion_id uuid, p_lane public.companion_v3_lane,
  p_turn_id uuid, p_claim_token uuid, p_claim_epoch bigint, p_gate_epoch bigint,
  p_pi_invocation_id text, p_response_turn_id uuid, p_cursor bigint, p_protocol integer
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = on AS $$
DECLARE v_now timestamptz := clock_timestamp(); v_sequence bigint;
BEGIN
  PERFORM pg_catalog.set_config('app.companion_runtime_protocol', '2', true);
  IF p_protocol IS DISTINCT FROM 3 OR p_cursor < 0 OR p_response_turn_id IS NULL
    OR p_pi_invocation_id IS NULL OR char_length(p_pi_invocation_id) NOT BETWEEN 1 AND 200
    OR p_pi_invocation_id ~ E'[\n\r]' THEN
    RAISE EXCEPTION 'invalid Runtime v3 native admission' USING ERRCODE = '22023';
  END IF;
  SELECT turn_row.queue_sequence INTO v_sequence
  FROM public.companion_v3_turns turn_row
  JOIN public.companion_v3_lane_leases lease
    ON lease.org_id = turn_row.org_id AND lease.companion_id = turn_row.companion_id
   AND lease.lane = turn_row.lane AND lease.turn_id = turn_row.id
  JOIN public.companion_runtime_control control
    ON control.id = 'runtime-v2' AND control.enabled AND control.gate_epoch = p_gate_epoch
  WHERE turn_row.org_id = p_org_id AND turn_row.companion_id = p_companion_id
    AND turn_row.id = p_turn_id AND turn_row.lane = p_lane AND turn_row.state = 'queued'
    AND lease.claim_token = p_claim_token AND lease.claim_epoch = p_claim_epoch
    AND lease.gate_epoch = p_gate_epoch AND lease.expires_at > v_now
  FOR UPDATE OF turn_row, lease;
  IF NOT FOUND THEN RETURN false; END IF;
  IF p_response_turn_id <> p_turn_id AND NOT EXISTS (
    SELECT 1 FROM public.companion_v3_turns root
    WHERE root.org_id = p_org_id AND root.companion_id = p_companion_id
      AND root.id = p_response_turn_id AND root.lane = p_lane
      AND root.queue_sequence < v_sequence
      AND root.state IN ('admitted', 'running', 'needs_input')
      AND root.admission_state = 'accepted' AND root.response_turn_id = root.id
      AND root.pi_invocation_id = p_pi_invocation_id
  ) THEN RETURN false; END IF;
  UPDATE public.companion_v3_turns turn_row SET
    state = 'admitted', admission_state = 'accepted', admitted_at = v_now,
    admission_kind = CASE WHEN p_response_turn_id = p_turn_id
      THEN 'prompt'::public.companion_v3_admission_kind
      ELSE 'steer'::public.companion_v3_admission_kind END,
    pi_invocation_id = p_pi_invocation_id, response_turn_id = p_response_turn_id,
    admission_cursor = p_cursor, activity_cursor = p_cursor,
    last_activity_at = v_now, updated_at = v_now
  WHERE turn_row.org_id = p_org_id AND turn_row.companion_id = p_companion_id
    AND turn_row.id = p_turn_id;
  UPDATE public.companion_threads thread
  SET projection_sequence = thread.projection_sequence + 1, updated_at = v_now
  WHERE thread.org_id = p_org_id AND thread.companion_id = p_companion_id;
  RETURN true;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_v3_runtime_record_native_admission(
  uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,text,uuid,bigint,integer
) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_runtime_project_native_page(
  p_org_id uuid, p_companion_id uuid, p_lane public.companion_v3_lane,
  p_turn_id uuid, p_claim_token uuid, p_claim_epoch bigint, p_gate_epoch bigint,
  p_through_cursor bigint, p_assistant jsonb, p_needs_input boolean,
  p_terminal text, p_protocol integer
)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = on AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_item jsonb; v_ordinal integer; v_projection bigint; v_result_count integer;
  v_outcome public.companion_v3_turn_outcome;
BEGIN
  PERFORM pg_catalog.set_config('app.companion_runtime_protocol', '2', true);
  IF p_protocol IS DISTINCT FROM 3 OR p_through_cursor < 0
    OR jsonb_typeof(p_assistant) IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_assistant) > 32
    OR p_terminal IS NOT NULL AND p_terminal NOT IN ('settled', 'process_exit')
    OR (p_needs_input AND p_terminal IS NOT NULL) THEN
    RAISE EXCEPTION 'invalid Runtime v3 native projection' USING ERRCODE = '22023';
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
    AND turn_row.admission_state = 'accepted' AND turn_row.response_turn_id = turn_row.id
    AND p_through_cursor >= turn_row.activity_cursor
  FOR UPDATE OF lease, turn_row;
  IF NOT FOUND THEN RETURN NULL; END IF;

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
      UPDATE public.companion_threads thread SET
        next_ordinal = thread.next_ordinal + 1,
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

  IF p_terminal IS NULL THEN
    UPDATE public.companion_v3_turns turn_row SET
      state = CASE WHEN p_needs_input THEN 'needs_input'::public.companion_v3_turn_state
        ELSE 'running'::public.companion_v3_turn_state END,
      activity_cursor = p_through_cursor, last_activity_at = v_now, updated_at = v_now
    WHERE turn_row.org_id = p_org_id AND turn_row.companion_id = p_companion_id
      AND turn_row.id = p_turn_id;
  ELSE
    SELECT count(*)::integer INTO v_result_count
    FROM public.companion_transcript_entries entry
    WHERE entry.org_id = p_org_id AND entry.companion_id = p_companion_id
      AND entry.role = 'assistant' AND entry.event_id LIKE 'v3:' || p_turn_id::text || ':%';
    v_outcome := CASE WHEN p_terminal = 'settled' AND v_result_count > 0
      THEN 'succeeded'::public.companion_v3_turn_outcome
      ELSE 'failed'::public.companion_v3_turn_outcome END;
    UPDATE public.companion_v3_turns turn_row SET
      state = v_outcome::text::public.companion_v3_turn_state, outcome = v_outcome,
      outcome_code = CASE WHEN v_outcome = 'failed' THEN
        CASE WHEN p_terminal = 'process_exit' THEN 'pi_process_exited' ELSE 'pi_result_missing' END
        ELSE NULL END,
      outcome_message = CASE WHEN v_outcome = 'failed' THEN
        CASE WHEN p_terminal = 'process_exit' THEN 'Pi stopped before the response completed.'
          ELSE 'Pi settled without an assistant result.' END ELSE NULL END,
      outcome_action = CASE WHEN v_outcome = 'failed'
        THEN 'none'::public.companion_runtime_error_action ELSE NULL END,
      settled_at = v_now,
      activity_cursor = CASE WHEN turn_row.id = p_turn_id THEN p_through_cursor
        ELSE turn_row.activity_cursor END,
      terminal_cursor = CASE WHEN turn_row.id = p_turn_id THEN p_through_cursor ELSE NULL END,
      journal_ack_pending = turn_row.id = p_turn_id,
      last_activity_at = v_now, updated_at = v_now
    WHERE turn_row.org_id = p_org_id AND turn_row.companion_id = p_companion_id
      AND turn_row.lane = p_lane AND turn_row.admission_state = 'accepted'
      AND turn_row.response_turn_id = p_turn_id
      AND turn_row.state IN ('admitted', 'running', 'needs_input');
  END IF;
  IF jsonb_array_length(p_assistant) = 0 THEN
    UPDATE public.companion_threads thread
    SET projection_sequence = thread.projection_sequence + 1, updated_at = v_now
    WHERE thread.org_id = p_org_id AND thread.companion_id = p_companion_id;
  END IF;
  RETURN CASE WHEN p_terminal IS NULL THEN 'projected' ELSE v_outcome::text END;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_v3_runtime_project_native_page(
  uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,bigint,jsonb,boolean,text,integer
) FROM PUBLIC;
--> statement-breakpoint

-- A final root event settles every distinct Turn admitted into that native Pi response. Only the
-- root projects assistant output; member messages and their Turn rows remain one-to-one and FIFO.
CREATE OR REPLACE FUNCTION public.companion_v3_runtime_complete(
  p_org_id uuid, p_companion_id uuid, p_lane public.companion_v3_lane,
  p_turn_id uuid, p_claim_token uuid, p_claim_epoch bigint, p_gate_epoch bigint,
  p_outcome text, p_code text, p_message text,
  p_action public.companion_runtime_error_action, p_protocol integer
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = on AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_group boolean := false;
  v_ack_pending boolean;
BEGIN
  PERFORM pg_catalog.set_config('app.companion_runtime_protocol', '2', true);
  IF p_protocol IS DISTINCT FROM 3 OR p_gate_epoch IS NULL OR p_gate_epoch < 1
    OR p_outcome IS NULL OR p_outcome NOT IN (
      'release','ack_completed','retry_ack','succeeded','failed','interrupted'
    )
    OR (p_outcome IN ('failed','interrupted') AND
      (p_code IS NULL OR p_message IS NULL OR p_action IS NULL OR p_action = 'restart_box'))
    OR (p_outcome IN ('release','ack_completed','retry_ack','succeeded') AND
      (p_code IS NOT NULL OR p_message IS NOT NULL OR p_action IS NOT NULL)) THEN
    RAISE EXCEPTION 'invalid Runtime v3 completion' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.companion_runtime_control control
  WHERE control.id = 'runtime-v2' AND control.enabled AND control.gate_epoch = p_gate_epoch FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM 1 FROM public.companion_v3_lane_leases lease
  WHERE lease.org_id = p_org_id AND lease.companion_id = p_companion_id
    AND lease.lane = p_lane AND lease.turn_id = p_turn_id
    AND lease.claim_token = p_claim_token AND lease.claim_epoch = p_claim_epoch
    AND lease.gate_epoch = p_gate_epoch AND lease.expires_at > v_now FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  SELECT turn_row.journal_ack_pending INTO v_ack_pending
  FROM public.companion_v3_turns turn_row
  WHERE turn_row.org_id = p_org_id AND turn_row.companion_id = p_companion_id
    AND turn_row.id = p_turn_id FOR UPDATE;
  IF v_ack_pending THEN
    IF p_outcome NOT IN ('ack_completed', 'retry_ack') THEN RETURN false; END IF;
    IF p_outcome = 'ack_completed' THEN
      UPDATE public.companion_v3_turns turn_row
      SET journal_ack_pending = false, updated_at = v_now
      WHERE turn_row.org_id = p_org_id AND turn_row.companion_id = p_companion_id
        AND turn_row.id = p_turn_id;
    END IF;
    UPDATE public.companion_v3_lane_leases lease SET
      claim_token = NULL, gate_epoch = NULL, executor_id = NULL, turn_id = NULL,
      claimed_at = NULL, renewed_at = NULL, expires_at = NULL, updated_at = v_now
    WHERE lease.org_id = p_org_id AND lease.companion_id = p_companion_id
      AND lease.lane = p_lane AND lease.claim_token = p_claim_token
      AND lease.claim_epoch = p_claim_epoch;
    RETURN FOUND;
  END IF;
  IF p_outcome IN ('ack_completed', 'retry_ack') THEN RETURN false; END IF;

  IF p_outcome <> 'release' THEN
    SELECT turn_row.admission_state = 'accepted' AND turn_row.response_turn_id = turn_row.id
      INTO v_group
    FROM public.companion_v3_turns turn_row
    WHERE turn_row.org_id = p_org_id AND turn_row.companion_id = p_companion_id
      AND turn_row.id = p_turn_id FOR UPDATE;
    UPDATE public.companion_v3_turns turn_row SET
      state = p_outcome::public.companion_v3_turn_state,
      outcome = p_outcome::public.companion_v3_turn_outcome,
      outcome_code = p_code, outcome_message = p_message, outcome_action = p_action,
      settled_at = v_now, updated_at = v_now
    WHERE turn_row.org_id = p_org_id AND turn_row.companion_id = p_companion_id
      AND turn_row.lane = p_lane
      AND turn_row.state IN ('queued','admitted','running','needs_input')
      AND (turn_row.id = p_turn_id OR (v_group
        AND turn_row.admission_state = 'accepted'
        AND turn_row.response_turn_id = p_turn_id));
    IF NOT FOUND THEN RETURN false; END IF;
    UPDATE public.companion_threads thread
    SET projection_sequence = thread.projection_sequence + 1, updated_at = v_now
    WHERE thread.org_id = p_org_id AND thread.companion_id = p_companion_id;
  END IF;
  UPDATE public.companion_v3_lane_leases lease SET
    claim_token = NULL, gate_epoch = NULL, executor_id = NULL, turn_id = NULL,
    claimed_at = NULL, renewed_at = NULL, expires_at = NULL, updated_at = v_now
  WHERE lease.org_id = p_org_id AND lease.companion_id = p_companion_id
    AND lease.lane = p_lane AND lease.claim_token = p_claim_token
    AND lease.claim_epoch = p_claim_epoch;
  RETURN FOUND;
END $$;
