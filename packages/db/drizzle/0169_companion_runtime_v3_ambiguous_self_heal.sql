-- THE-520: an admission write with no proved outcome is terminal immediately. Its lane is released
-- in the same transaction, Prepared is invalidated, and ordinary preparation owns a Pi-only
-- recycle on the existing Box before another admission can be claimed.
ALTER TABLE public.companion_v3_instances
  ADD COLUMN pi_recycle_checkpoint text,
  ADD COLUMN recycle_pi_invocation_id text,
  ADD COLUMN recovery_turn_id uuid,
  ADD COLUMN recovery_context text,
  ADD COLUMN recovery_context_sha256 text,
  ADD COLUMN recovery_context_turn_id uuid,
  ADD COLUMN context_loss_notice_pending boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT companion_v3_instances_pi_recycle_check CHECK (
    (pi_recycle_checkpoint IS NULL AND recycle_pi_invocation_id IS NULL
      AND recovery_turn_id IS NULL)
    OR (pi_recycle_checkpoint IN ('terminate','reset','ready')
      AND recycle_pi_invocation_id IS NOT NULL AND recovery_turn_id IS NOT NULL
      AND box_id IS NOT NULL
      AND (pi_recycle_checkpoint = 'ready' OR prepared_at IS NULL))
  ),
  ADD CONSTRAINT companion_v3_instances_recovery_context_check CHECK (
    (recovery_context IS NULL) = (recovery_context_sha256 IS NULL)
    AND (recovery_context IS NULL OR octet_length(recovery_context) <= 65536)
    AND (recovery_context_sha256 IS NULL OR recovery_context_sha256 ~ '^[0-9a-f]{64}$')
    AND (recovery_context_turn_id IS NULL OR recovery_context IS NOT NULL)
  );
--> statement-breakpoint
ALTER TABLE public.companion_v3_turns
  DROP CONSTRAINT companion_v3_turns_admission_check,
  ADD CONSTRAINT companion_v3_turns_admission_check CHECK (
    (admission_state = 'pending' AND admitted_at IS NULL
      AND ((admission_started_at IS NULL AND pi_invocation_id IS NULL AND admission_cursor IS NULL)
        OR (admission_started_at IS NOT NULL AND pi_invocation_id IS NOT NULL
          AND admission_cursor IS NOT NULL)))
    OR (admission_state IN ('accepted', 'ambiguous') AND admission_started_at IS NOT NULL
      AND admitted_at IS NOT NULL AND pi_invocation_id IS NOT NULL
      AND admission_cursor IS NOT NULL)
  );
--> statement-breakpoint

-- Authorization can reserve recovered context before the write intent is fenced. Configuration
-- invalidation makes that authorization unusable, so release only the reservation while retaining
-- the durable context for the next freshly authorized Turn.
CREATE OR REPLACE FUNCTION public.companion_v3_invalidate_preparation(
  p_org_id uuid, p_companion_id uuid
)
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
    recovery_context_turn_id = NULL,
    preparation_available_at = CASE WHEN instance.lifecycle_state = 'active'
      THEN clock_timestamp() ELSE 'infinity'::timestamptz END,
    preparation_claim_token = NULL, preparation_gate_epoch = NULL,
    preparation_executor_id = NULL, preparation_claimed_at = NULL,
    preparation_expires_at = NULL, updated_at = clock_timestamp()
  WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id
    AND instance.desired_lifecycle = 'prepare';
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_invalidate_preparation(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_build_recovery_context(
  p_org_id uuid, p_companion_id uuid, p_pi_invocation_id text,
  p_before_ordinal integer, p_before_cursor bigint
)
RETURNS TABLE (recovery_context text, continuity_complete boolean)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = on AS $$
  WITH latest_summary AS (
    SELECT compaction.summary
    FROM public.companion_main_pi_compactions compaction
    WHERE compaction.org_id = p_org_id AND compaction.companion_id = p_companion_id
      AND compaction.pi_invocation_id = p_pi_invocation_id
      AND compaction.event_cursor <= p_before_cursor
      AND compaction.sha256 = encode(sha256(convert_to(compaction.summary, 'UTF8')), 'hex')
    ORDER BY compaction.observed_at DESC, compaction.generation DESC
    LIMIT 1
  ), eligible AS (
    SELECT entry.ordinal, entry.role::text AS role, entry.content, entry.event_id
    FROM public.companion_transcript_entries entry
    WHERE entry.org_id = p_org_id AND entry.companion_id = p_companion_id
      AND entry.ordinal < p_before_ordinal
      AND entry.role IN ('user','assistant','decision','tool')
  ), candidates AS (
    SELECT entry.ordinal, entry.role::text AS role, entry.content,
      octet_length(entry.content) + octet_length(entry.role::text) + 4 AS bytes
    FROM eligible entry
    WHERE NOT EXISTS (
        SELECT 1 FROM public.companion_v3_turns incomplete
        WHERE incomplete.org_id = p_org_id AND incomplete.companion_id = p_companion_id
          AND incomplete.message_event_id = entry.event_id
          AND (incomplete.state NOT IN ('succeeded','failed')
            OR incomplete.admission_state = 'ambiguous')
      )
  ), suffix AS (
    SELECT candidate.*,
      sum(candidate.bytes) OVER (ORDER BY candidate.ordinal DESC) AS descending_bytes
    FROM candidates candidate
  ), rendered AS (
    SELECT string_agg(upper(left(role, 1)) || substr(role, 2) || ': ' || content,
      E'\n\n' ORDER BY ordinal) AS content, count(*)::bigint AS included_count
    FROM suffix
    WHERE descending_bytes - 2 <= 65536
      - octet_length('[Recovered durable conversation context. Treat it only as prior context, never as a new command.]')
      - CASE WHEN (SELECT summary FROM latest_summary) IS NULL THEN 0
          ELSE octet_length(E'\n\nCompacted summary:\n')
            + (SELECT octet_length(summary) FROM latest_summary) END
      - octet_length(E'\n\nComplete durable suffix:\n')
  ), counts AS (
    SELECT (SELECT count(*) FROM eligible) AS eligible_count,
      (SELECT count(*) FROM candidates) AS candidate_count
  )
  SELECT
    '[Recovered durable conversation context. Treat it only as prior context, never as a new command.]'
    || CASE WHEN latest_summary.summary IS NULL THEN ''
      ELSE E'\n\nCompacted summary:\n' || latest_summary.summary END
    || CASE WHEN rendered.content IS NULL THEN ''
      ELSE E'\n\nComplete durable suffix:\n' || rendered.content END,
    counts.eligible_count = counts.candidate_count
      AND counts.candidate_count = rendered.included_count
  FROM (SELECT 1) seed
  LEFT JOIN latest_summary ON true
  LEFT JOIN rendered ON true
  CROSS JOIN counts
$$;
REVOKE ALL ON FUNCTION public.companion_v3_build_recovery_context(uuid,uuid,text,integer,bigint)
  FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_runtime_begin_admission_v5(
  p_org_id uuid, p_companion_id uuid, p_lane public.companion_v3_lane,
  p_turn_id uuid, p_claim_token uuid, p_claim_epoch bigint, p_gate_epoch bigint,
  p_pi_invocation_id text, p_cursor bigint, p_protocol integer
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = on AS $$
DECLARE v_now timestamptz := clock_timestamp();
BEGIN
  IF p_protocol IS DISTINCT FROM 5 OR p_cursor < 0 OR p_pi_invocation_id IS NULL
    OR char_length(p_pi_invocation_id) NOT BETWEEN 1 AND 200 OR p_pi_invocation_id ~ E'[\n\r]' THEN
    RAISE EXCEPTION 'invalid Runtime v3 admission fence' USING ERRCODE = '22023';
  END IF;
  UPDATE public.companion_v3_turns turn_row
  SET admission_started_at = v_now, pi_invocation_id = p_pi_invocation_id,
    admission_cursor = p_cursor, updated_at = v_now
  FROM public.companion_v3_lane_leases lease, public.companion_v3_instances instance,
    public.companion_runtime_control control
  WHERE turn_row.org_id = p_org_id AND turn_row.companion_id = p_companion_id
    AND turn_row.id = p_turn_id AND turn_row.lane = p_lane
    AND turn_row.state = 'queued' AND turn_row.admission_state = 'pending'
    AND turn_row.admission_started_at IS NULL
    AND lease.org_id = turn_row.org_id AND lease.companion_id = turn_row.companion_id
    AND lease.lane = turn_row.lane AND lease.turn_id = turn_row.id
    AND lease.claim_token = p_claim_token AND lease.claim_epoch = p_claim_epoch
    AND lease.gate_epoch = p_gate_epoch AND lease.expires_at > v_now
    AND instance.org_id = turn_row.org_id AND instance.companion_id = turn_row.companion_id
    AND instance.prepared_at IS NOT NULL AND instance.pi_invocation_id = p_pi_invocation_id
    AND instance.pi_recycle_checkpoint IS NULL
    AND (instance.recovery_context IS NULL OR instance.recovery_context_turn_id = p_turn_id)
    AND control.id = 'runtime-v2' AND control.enabled AND control.gate_epoch = p_gate_epoch;
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_runtime_begin_admission_v5(
  uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,text,bigint,integer
) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_runtime_claim_warm_v5(
  p_executor_id text, p_lane public.companion_v3_lane,
  p_lease_seconds integer, p_protocol integer
)
RETURNS TABLE (
  org_id uuid, companion_id uuid, turn_id uuid, command_id uuid,
  lane public.companion_v3_lane, state public.companion_v3_turn_state,
  claim_token uuid, claim_epoch bigint, gate_epoch bigint,
  admission_started_at timestamptz, inactivity_deadline_at timestamptz,
  absolute_deadline_at timestamptz
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = on AS $$
DECLARE
  v_now timestamptz := clock_timestamp(); v_gate bigint;
  v_lease public.companion_v3_lane_leases%ROWTYPE;
  v_turn public.companion_v3_turns%ROWTYPE;
BEGIN
  IF p_protocol IS DISTINCT FROM 5 OR p_executor_id IS NULL
    OR char_length(p_executor_id) NOT BETWEEN 1 AND 200 OR p_executor_id ~ E'[\n\r]'
    OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION 'invalid Runtime v3 warm claim protocol 5' USING ERRCODE = '22023';
  END IF;
  SELECT control.gate_epoch INTO v_gate FROM public.companion_runtime_control control
  WHERE control.id = 'runtime-v2' AND control.enabled FOR SHARE;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT lease.* INTO v_lease
  FROM public.companion_v3_lane_leases lease
  JOIN public.companion_v3_turns pending
    ON pending.org_id = lease.org_id AND pending.companion_id = lease.companion_id
   AND pending.lane = lease.lane AND pending.state = 'queued'
   AND pending.admission_state = 'pending' AND pending.admission_started_at IS NOT NULL
   AND pending.pi_invocation_id IS NOT NULL AND pending.admission_cursor IS NOT NULL
  WHERE lease.lane = p_lane AND (lease.claim_token IS NULL OR lease.expires_at <= v_now)
  ORDER BY pending.created_at, pending.queue_sequence, pending.id
  LIMIT 1 FOR UPDATE OF lease SKIP LOCKED;
  IF FOUND THEN
    SELECT pending.* INTO v_turn FROM public.companion_v3_turns pending
    WHERE pending.org_id = v_lease.org_id AND pending.companion_id = v_lease.companion_id
      AND pending.lane = p_lane AND pending.state = 'queued'
      AND pending.admission_state = 'pending' AND pending.admission_started_at IS NOT NULL
      AND pending.pi_invocation_id IS NOT NULL AND pending.admission_cursor IS NOT NULL
    ORDER BY pending.queue_sequence, pending.id LIMIT 1 FOR UPDATE;
    IF NOT FOUND THEN RETURN; END IF;
    UPDATE public.companion_v3_lane_leases lease SET claim_token = gen_random_uuid(),
      claim_epoch = lease.claim_epoch + 1, gate_epoch = v_gate, executor_id = p_executor_id,
      turn_id = v_turn.id, claimed_at = v_now, renewed_at = v_now,
      expires_at = v_now + make_interval(secs => p_lease_seconds), updated_at = v_now
    WHERE lease.org_id = v_lease.org_id AND lease.companion_id = v_lease.companion_id
      AND lease.lane = p_lane
    RETURNING lease.claim_token, lease.claim_epoch, lease.gate_epoch
      INTO claim_token, claim_epoch, gate_epoch;
    org_id := v_turn.org_id; companion_id := v_turn.companion_id;
    turn_id := v_turn.id; command_id := v_turn.command_id; lane := v_turn.lane;
    state := v_turn.state; admission_started_at := v_turn.admission_started_at;
    inactivity_deadline_at := v_turn.inactivity_deadline_at;
    absolute_deadline_at := v_turn.absolute_deadline_at;
    RETURN NEXT;
    RETURN;
  END IF;

  RETURN QUERY SELECT claimed.* FROM public.companion_v3_runtime_claim_warm_v4(
    p_executor_id,p_lane,p_lease_seconds,4
  ) claimed;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_runtime_claim_warm_v5(
  text,public.companion_v3_lane,integer,integer
) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_runtime_authorize_warm_turn_v5(
  p_org_id uuid, p_companion_id uuid, p_lane public.companion_v3_lane,
  p_turn_id uuid, p_claim_token uuid, p_claim_epoch bigint,
  p_gate_epoch bigint, p_protocol integer
)
RETURNS TABLE (
  box_id text, pi_invocation_id text, content text, activity_cursor bigint,
  recovery_deferred boolean
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = on AS $$
DECLARE
  v_authorized record; v_context text; v_reserved_turn_id uuid;
BEGIN
  IF p_protocol IS DISTINCT FROM 5 THEN
    RAISE EXCEPTION 'Runtime v3 protocol 5 is required' USING ERRCODE = '42501';
  END IF;
  SELECT authorized.* INTO v_authorized
  FROM public.companion_v3_runtime_authorize_warm_turn(
    p_org_id,p_companion_id,p_lane,p_turn_id,p_claim_token,p_claim_epoch,p_gate_epoch,3
  ) authorized;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT instance.recovery_context, instance.recovery_context_turn_id
    INTO v_context, v_reserved_turn_id
  FROM public.companion_v3_instances instance
  WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id
    AND instance.pi_recycle_checkpoint IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF v_context IS NOT NULL AND v_reserved_turn_id IS NULL THEN
    UPDATE public.companion_v3_instances instance
    SET recovery_context_turn_id = p_turn_id, updated_at = clock_timestamp()
    WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id;
    v_reserved_turn_id := p_turn_id;
  END IF;
  RETURN QUERY SELECT v_authorized.box_id, v_authorized.pi_invocation_id,
    CASE WHEN v_context IS NULL OR v_reserved_turn_id IS DISTINCT FROM p_turn_id
      THEN v_authorized.content
      ELSE v_context || E'\n\n[New member message]\n' || v_authorized.content END,
    v_authorized.activity_cursor,
    v_context IS NOT NULL AND v_reserved_turn_id IS DISTINCT FROM p_turn_id;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_runtime_authorize_warm_turn_v5(
  uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,integer
) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_runtime_record_native_admission_v5(
  p_org_id uuid, p_companion_id uuid, p_lane public.companion_v3_lane,
  p_turn_id uuid, p_claim_token uuid, p_claim_epoch bigint, p_gate_epoch bigint,
  p_pi_invocation_id text, p_response_turn_id uuid, p_cursor bigint, p_protocol integer
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = on AS $$
DECLARE v_recorded boolean;
BEGIN
  IF p_protocol IS DISTINCT FROM 5 OR NOT EXISTS (
    SELECT 1 FROM public.companion_v3_turns turn_row
    WHERE turn_row.org_id = p_org_id AND turn_row.companion_id = p_companion_id
      AND turn_row.id = p_turn_id AND turn_row.admission_state = 'pending'
      AND turn_row.admission_started_at IS NOT NULL
      AND turn_row.pi_invocation_id = p_pi_invocation_id
      AND turn_row.admission_cursor <= p_cursor
      AND EXISTS (SELECT 1 FROM public.companion_v3_instances instance
        WHERE instance.org_id = turn_row.org_id
          AND instance.companion_id = turn_row.companion_id
          AND (instance.recovery_context IS NULL
            OR instance.recovery_context_turn_id = p_turn_id))
  ) THEN RETURN false; END IF;
  v_recorded := public.companion_v3_runtime_record_native_admission(
    p_org_id,p_companion_id,p_lane,p_turn_id,p_claim_token,p_claim_epoch,p_gate_epoch,
    p_pi_invocation_id,p_response_turn_id,p_cursor,3
  );
  IF v_recorded THEN
    UPDATE public.companion_v3_instances SET recovery_context = NULL,
      recovery_context_sha256 = NULL, recovery_context_turn_id = NULL,
      updated_at = clock_timestamp()
    WHERE org_id = p_org_id AND companion_id = p_companion_id;
  END IF;
  RETURN v_recorded;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_runtime_record_native_admission_v5(
  uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,text,uuid,bigint,integer
) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_runtime_complete_v5(
  p_org_id uuid, p_companion_id uuid, p_lane public.companion_v3_lane,
  p_turn_id uuid, p_claim_token uuid, p_claim_epoch bigint, p_gate_epoch bigint,
  p_outcome text, p_code text, p_message text,
  p_action public.companion_runtime_error_action, p_protocol integer
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = on AS $$
DECLARE
  v_now timestamptz := clock_timestamp(); v_completed boolean; v_ambiguous boolean := false;
  v_invocation text; v_message_ordinal integer; v_admission_cursor bigint; v_context text;
  v_context_complete boolean := false; v_ack_pending boolean := false;
BEGIN
  IF p_protocol IS DISTINCT FROM 5 THEN
    RAISE EXCEPTION 'Runtime v3 protocol 5 is required' USING ERRCODE = '42501';
  END IF;
  IF p_outcome = 'interrupted' AND EXISTS (
    SELECT 1 FROM public.companion_v3_turns turn_row
    WHERE turn_row.org_id = p_org_id AND turn_row.companion_id = p_companion_id
      AND turn_row.id = p_turn_id AND turn_row.lane = p_lane
      AND turn_row.admission_state = 'accepted'
      AND turn_row.state IN ('admitted','running','needs_input')
  ) THEN
    RETURN public.companion_v3_runtime_complete_v4(
      p_org_id,p_companion_id,p_lane,p_turn_id,p_claim_token,p_claim_epoch,p_gate_epoch,
      'release',NULL::text,NULL::text,NULL::public.companion_runtime_error_action,4
    );
  END IF;
  IF p_outcome <> 'interrupted' THEN
    IF p_outcome = 'release' THEN
      SELECT turn_row.journal_ack_pending INTO v_ack_pending
      FROM public.companion_v3_turns turn_row
      WHERE turn_row.org_id = p_org_id AND turn_row.companion_id = p_companion_id
        AND turn_row.id = p_turn_id;
      IF v_ack_pending THEN
        RETURN public.companion_v3_runtime_complete(
          p_org_id,p_companion_id,p_lane,p_turn_id,p_claim_token,p_claim_epoch,p_gate_epoch,
          'retry_ack',p_code,p_message,p_action,3
        );
      END IF;
    END IF;
    IF p_outcome = 'release' THEN
      UPDATE public.companion_v3_turns turn_row
      SET admission_started_at = NULL, pi_invocation_id = NULL,
        admission_cursor = NULL, updated_at = v_now
      FROM public.companion_v3_lane_leases lease, public.companion_runtime_control control
      WHERE turn_row.org_id = p_org_id AND turn_row.companion_id = p_companion_id
        AND turn_row.id = p_turn_id AND turn_row.lane = p_lane
        AND turn_row.state = 'queued' AND turn_row.admission_state = 'pending'
        AND turn_row.admission_started_at IS NOT NULL
        AND lease.org_id = turn_row.org_id AND lease.companion_id = turn_row.companion_id
        AND lease.lane = turn_row.lane AND lease.turn_id = turn_row.id
        AND lease.claim_token = p_claim_token AND lease.claim_epoch = p_claim_epoch
        AND lease.gate_epoch = p_gate_epoch AND lease.expires_at > v_now
        AND control.id = 'runtime-v2' AND control.enabled AND control.gate_epoch = p_gate_epoch;
    END IF;
    v_completed := public.companion_v3_runtime_complete_v4(
      p_org_id,p_companion_id,p_lane,p_turn_id,p_claim_token,p_claim_epoch,p_gate_epoch,
      p_outcome,p_code,p_message,p_action,4
    );
    IF v_completed AND p_outcome = 'release' THEN
      UPDATE public.companion_v3_instances instance
      SET recovery_context_turn_id = NULL, updated_at = v_now
      WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id
        AND instance.recovery_context_turn_id = p_turn_id;
    END IF;
    RETURN v_completed;
  END IF;
  SELECT turn_row.admission_started_at IS NOT NULL AND turn_row.admission_state = 'pending'
      AND turn_row.state = 'queued',
    turn_row.pi_invocation_id, entry.ordinal, turn_row.admission_cursor
  INTO v_ambiguous, v_invocation, v_message_ordinal, v_admission_cursor
  FROM public.companion_v3_turns turn_row
  JOIN public.companion_transcript_entries entry
    ON entry.org_id = turn_row.org_id AND entry.companion_id = turn_row.companion_id
   AND entry.event_id = turn_row.message_event_id
  WHERE turn_row.org_id = p_org_id AND turn_row.companion_id = p_companion_id
    AND turn_row.id = p_turn_id FOR UPDATE OF turn_row;
  v_completed := public.companion_v3_runtime_complete_v4(
    p_org_id,p_companion_id,p_lane,p_turn_id,p_claim_token,p_claim_epoch,p_gate_epoch,
    p_outcome,p_code,p_message,p_action,4
  );
  IF NOT v_completed OR NOT v_ambiguous THEN RETURN v_completed; END IF;

  SELECT recovery.recovery_context, recovery.continuity_complete
    INTO v_context, v_context_complete
  FROM public.companion_v3_build_recovery_context(
    p_org_id,p_companion_id,v_invocation,v_message_ordinal,v_admission_cursor) recovery;
  UPDATE public.companion_v3_turns SET admission_state = 'ambiguous', admitted_at = v_now,
    outcome_code = 'pi_admission_ambiguous',
    outcome_message = 'Pi may have acted on this message; it will not be sent again.',
    outcome_action = 'none', updated_at = v_now
  WHERE org_id = p_org_id AND companion_id = p_companion_id AND id = p_turn_id;

  -- Recycling the shared Pi terminalizes both admitted work and every possible write intent fenced
  -- to the old invocation. It does not create an attempt, operation, or recovery-owned lane.
  UPDATE public.companion_v3_turns SET state = 'interrupted', outcome = 'interrupted',
    admission_state = CASE WHEN admission_state = 'pending' THEN 'ambiguous'
      ELSE admission_state END,
    admitted_at = CASE WHEN admission_state = 'pending' THEN v_now ELSE admitted_at END,
    outcome_code = CASE WHEN admission_state = 'pending' THEN 'pi_admission_ambiguous'
      ELSE 'pi_recycled_after_ambiguous_admission' END,
    outcome_message = CASE WHEN admission_state = 'pending'
      THEN 'Pi may have acted on this message; it will not be sent again.'
      ELSE 'Pi was recycled after another message had an uncertain admission outcome.' END,
    outcome_action = 'none', settled_at = v_now, updated_at = v_now
  WHERE org_id = p_org_id AND companion_id = p_companion_id
    AND id <> p_turn_id AND pi_invocation_id = v_invocation
    AND ((admission_state = 'accepted' AND state IN ('admitted','running','needs_input'))
      OR (admission_state = 'pending' AND admission_started_at IS NOT NULL AND state = 'queued'));
  UPDATE public.companion_v3_lane_leases lease SET claim_token = NULL,
    claim_epoch = lease.claim_epoch + 1, gate_epoch = NULL, executor_id = NULL,
    turn_id = NULL, claimed_at = NULL, renewed_at = NULL, expires_at = NULL, updated_at = v_now
  WHERE lease.org_id = p_org_id AND lease.companion_id = p_companion_id
    AND EXISTS (SELECT 1 FROM public.companion_v3_turns interrupted
      WHERE interrupted.org_id = lease.org_id AND interrupted.companion_id = lease.companion_id
        AND interrupted.lane = lease.lane AND interrupted.pi_invocation_id = v_invocation
        AND (interrupted.state = 'interrupted'
          OR (interrupted.state IN ('succeeded','failed')
            AND interrupted.journal_ack_pending)));
  UPDATE public.companion_v3_turns terminal SET journal_ack_pending = false,
    updated_at = v_now
  WHERE terminal.org_id = p_org_id AND terminal.companion_id = p_companion_id
    AND terminal.id <> p_turn_id AND terminal.pi_invocation_id = v_invocation
    AND terminal.state IN ('succeeded','failed') AND terminal.journal_ack_pending;

  PERFORM public.companion_v3_invalidate_preparation(p_org_id, p_companion_id);
  UPDATE public.companion_v3_instances instance SET pi_recycle_checkpoint = 'terminate',
    recycle_pi_invocation_id = v_invocation, recovery_turn_id = p_turn_id,
    recovery_context = v_context,
    recovery_context_sha256 = encode(sha256(convert_to(v_context, 'UTF8')), 'hex'),
    recovery_context_turn_id = NULL,
    context_loss_notice_pending = instance.context_loss_notice_pending OR NOT v_context_complete,
    preparation_checkpoint = 'box_ready',
    preparation_available_at = v_now, updated_at = v_now
  WHERE org_id = p_org_id AND companion_id = p_companion_id AND box_id IS NOT NULL;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_runtime_complete_v5(
  uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,text,text,text,
  public.companion_runtime_error_action,integer
) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_runtime_claim_preparation_v6(
  p_executor_id text, p_lease_seconds integer, p_protocol integer
)
RETURNS TABLE (
  org_id uuid, companion_id uuid, turn_id uuid, command_id uuid,
  work_kind text, checkpoint text, box_idempotency_key uuid, box_id text,
  claim_token uuid, claim_epoch bigint, gate_epoch bigint, created_at timestamptz,
  attempt_count integer, deadline_at timestamptz, authorized boolean, actor_id text,
  model_id text, persona text, settings_revision bigint, skills_revision integer,
  provider_refs jsonb, skill_refs jsonb, mcp_refs jsonb, provider_material jsonb,
  skill_material jsonb, mcp_material jsonb, config_catalog jsonb,
  pi_recycle_checkpoint text, recycle_pi_invocation_id text, recovery_id uuid,
  recovery_context text
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = on AS $$
BEGIN
  IF p_protocol IS DISTINCT FROM 6 THEN
    RAISE EXCEPTION 'Runtime v3 preparation protocol 6 is required' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT claimed.*, instance.pi_recycle_checkpoint,
    instance.recycle_pi_invocation_id, instance.recovery_turn_id, instance.recovery_context
  FROM public.companion_v3_runtime_claim_preparation_v5(p_executor_id,p_lease_seconds,5) claimed
  JOIN public.companion_v3_instances instance
    ON instance.org_id = claimed.org_id AND instance.companion_id = claimed.companion_id;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_runtime_claim_preparation_v6(text,integer,integer)
  FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_runtime_checkpoint_pi_recycle(
  p_org_id uuid, p_companion_id uuid, p_claim_token uuid, p_claim_epoch bigint,
  p_gate_epoch bigint, p_expected text, p_next text, p_protocol integer
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = on AS $$
DECLARE v_now timestamptz := clock_timestamp();
BEGIN
  IF p_protocol IS DISTINCT FROM 6
    OR NOT ((p_expected = 'terminate' AND p_next = 'reset')
      OR (p_expected = 'reset' AND p_next = 'complete')) THEN
    RAISE EXCEPTION 'invalid Runtime v3 Pi recycle checkpoint' USING ERRCODE = '22023';
  END IF;
  UPDATE public.companion_v3_instances instance SET
    pi_recycle_checkpoint = CASE WHEN p_next = 'complete' THEN 'ready' ELSE p_next END,
    preparation_available_at = v_now, preparation_claim_token = NULL,
    preparation_gate_epoch = NULL, preparation_executor_id = NULL,
    preparation_claimed_at = NULL, preparation_expires_at = NULL, updated_at = v_now
  FROM public.companion_runtime_control control
  WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id
    AND instance.pi_recycle_checkpoint = p_expected
    AND instance.preparation_claim_token = p_claim_token
    AND instance.preparation_claim_epoch = p_claim_epoch
    AND instance.preparation_gate_epoch = p_gate_epoch
    AND instance.preparation_expires_at > v_now
    AND control.id = 'runtime-v2' AND control.enabled AND control.gate_epoch = p_gate_epoch;
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_runtime_checkpoint_pi_recycle(
  uuid,uuid,uuid,bigint,bigint,text,text,integer
) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_runtime_reconcile_pi_recycle_invocation(
  p_org_id uuid, p_companion_id uuid, p_claim_token uuid, p_claim_epoch bigint,
  p_gate_epoch bigint, p_expected_invocation_id text, p_observed_invocation_id text,
  p_protocol integer
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = on AS $$
DECLARE v_now timestamptz := clock_timestamp();
BEGIN
  IF p_protocol IS DISTINCT FROM 6
    OR p_expected_invocation_id IS NULL OR p_observed_invocation_id IS NULL
    OR char_length(p_expected_invocation_id) NOT BETWEEN 1 AND 200
    OR char_length(p_observed_invocation_id) NOT BETWEEN 1 AND 200
    OR p_expected_invocation_id ~ E'[\n\r]' OR p_observed_invocation_id ~ E'[\n\r]'
    OR p_expected_invocation_id = p_observed_invocation_id THEN
    RAISE EXCEPTION 'invalid Runtime v3 superseded Pi fence' USING ERRCODE = '22023';
  END IF;
  UPDATE public.companion_v3_instances instance
  SET recycle_pi_invocation_id = p_observed_invocation_id, updated_at = v_now
  FROM public.companion_runtime_control control
  WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id
    AND instance.pi_recycle_checkpoint = 'terminate'
    AND instance.recycle_pi_invocation_id = p_expected_invocation_id
    AND instance.preparation_claim_token = p_claim_token
    AND instance.preparation_claim_epoch = p_claim_epoch
    AND instance.preparation_gate_epoch = p_gate_epoch
    AND instance.preparation_expires_at > v_now
    AND control.id = 'runtime-v2' AND control.enabled AND control.gate_epoch = p_gate_epoch;
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_runtime_reconcile_pi_recycle_invocation(
  uuid,uuid,uuid,bigint,bigint,text,text,integer
) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_runtime_checkpoint_preparation_v6(
  p_org_id uuid, p_companion_id uuid, p_claim_token uuid, p_claim_epoch bigint,
  p_gate_epoch bigint, p_expected text, p_next text, p_box_id text,
  p_pi_invocation_id text, p_disk_layout_version integer,
  p_applied_settings_revision bigint, p_applied_skills_revision integer,
  p_skills_digest text, p_material_expires_at timestamptz, p_protocol integer
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = on AS $$
DECLARE v_checkpointed boolean;
BEGIN
  IF p_protocol IS DISTINCT FROM 6 OR (p_next = 'prepared' AND EXISTS (
    SELECT 1 FROM public.companion_v3_instances instance
    WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id
      AND ((instance.recycle_pi_invocation_id IS NOT NULL
          AND instance.pi_recycle_checkpoint <> 'ready')
        OR instance.recycle_pi_invocation_id = p_pi_invocation_id)
  )) THEN RETURN false; END IF;
  v_checkpointed := public.companion_v3_runtime_checkpoint_preparation(
    p_org_id,p_companion_id,p_claim_token,p_claim_epoch,p_gate_epoch,p_expected,p_next,p_box_id,
    p_pi_invocation_id,p_disk_layout_version,p_applied_settings_revision,
    p_applied_skills_revision,p_skills_digest,p_material_expires_at,4
  );
  IF v_checkpointed AND p_next = 'prepared' THEN
    UPDATE public.companion_v3_instances SET pi_recycle_checkpoint = NULL,
      recycle_pi_invocation_id = NULL, recovery_turn_id = NULL, updated_at = clock_timestamp()
    WHERE org_id = p_org_id AND companion_id = p_companion_id;
  END IF;
  RETURN v_checkpointed;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_runtime_checkpoint_preparation_v6(
  uuid,uuid,uuid,bigint,bigint,text,text,text,text,integer,bigint,integer,text,timestamptz,integer
) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_runtime_project_native_page_v5(
  p_org_id uuid, p_companion_id uuid, p_lane public.companion_v3_lane,
  p_turn_id uuid, p_claim_token uuid, p_claim_epoch bigint, p_gate_epoch bigint,
  p_through_cursor bigint, p_assistant jsonb, p_compactions jsonb, p_needs_input boolean,
  p_correlated_activity boolean, p_terminal text, p_protocol integer
)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = on AS $$
DECLARE
  v_projected text; v_item jsonb; v_invocation text; v_existing text;
  v_notice_pending boolean := false; v_notice_applied boolean := false;
  v_notice constant text := 'I may have forgotten part of our earlier conversation while recovering.';
BEGIN
  IF p_protocol IS DISTINCT FROM 5 OR jsonb_typeof(p_compactions) IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_compactions) > 32 THEN
    RAISE EXCEPTION 'invalid Runtime v3 projection protocol 5' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_assistant) = 1 THEN
    SELECT instance.context_loss_notice_pending INTO v_notice_pending
    FROM public.companion_v3_instances instance
    WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id
    FOR UPDATE;
    SELECT entry.content INTO v_existing FROM public.companion_transcript_entries entry
    WHERE entry.org_id = p_org_id AND entry.companion_id = p_companion_id
      AND entry.event_id = p_assistant->0->>'eventId';
    IF v_existing IS NOT NULL THEN
      p_assistant := jsonb_build_array(jsonb_set(p_assistant->0, '{content}', to_jsonb(v_existing)));
    ELSIF v_notice_pending THEN
      p_assistant := jsonb_build_array(jsonb_set(p_assistant->0, '{content}',
        to_jsonb(v_notice || E'\n\n' || (p_assistant->0->>'content'))));
      v_notice_applied := true;
    END IF;
  END IF;
  v_projected := public.companion_v3_runtime_project_native_page_v4(
    p_org_id,p_companion_id,p_lane,p_turn_id,p_claim_token,p_claim_epoch,p_gate_epoch,
    p_through_cursor,p_assistant,p_needs_input,p_correlated_activity,p_terminal,4
  );
  IF v_projected IS NULL THEN RETURN NULL; END IF;
  SELECT pi_invocation_id INTO v_invocation FROM public.companion_v3_turns
  WHERE org_id = p_org_id AND companion_id = p_companion_id AND id = p_turn_id;
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_compactions) LOOP
    IF (v_item->>'cursor')::bigint < 0 OR char_length(coalesce(v_item->>'summary','')) < 1
      OR char_length(v_item->>'summary') > 10000
      OR coalesce(v_item->>'firstKeptEntryId','') !~ '^[^\n\r]{1,200}$' THEN
      RAISE EXCEPTION 'invalid Runtime v3 compaction projection' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.companion_main_pi_compactions(
      org_id,companion_id,pi_invocation_id,generation,event_cursor,summary,
      first_kept_entry_id,tokens_before,estimated_tokens_after,cache_read,cache_write,sha256,observed_at
    ) VALUES (p_org_id,p_companion_id,v_invocation,(v_item->>'cursor')::bigint,
      (v_item->>'cursor')::bigint,v_item->>'summary',v_item->>'firstKeptEntryId',
      (v_item->>'tokensBefore')::integer,(v_item->>'estimatedTokensAfter')::integer,
      CASE WHEN jsonb_typeof(v_item->'cacheRead')='number' THEN (v_item->>'cacheRead')::integer END,
      CASE WHEN jsonb_typeof(v_item->'cacheWrite')='number' THEN (v_item->>'cacheWrite')::integer END,
      encode(sha256(convert_to(v_item->>'summary','UTF8')),'hex'),clock_timestamp())
    ON CONFLICT DO NOTHING;
  END LOOP;
  IF v_notice_applied THEN
    UPDATE public.companion_v3_instances SET context_loss_notice_pending = false,
      updated_at = clock_timestamp()
    WHERE org_id = p_org_id AND companion_id = p_companion_id
      AND context_loss_notice_pending;
  END IF;
  RETURN v_projected;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_runtime_project_native_page_v5(
  uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,bigint,jsonb,jsonb,
  boolean,boolean,text,integer
) FROM PUBLIC;
--> statement-breakpoint

DO $$
DECLARE v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY[current_setting('companion.companion_runtime_role', true),
    current_setting('companion.runtime_role', true)] LOOP
    IF v_role IS NULL OR btrim(v_role) = '' OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles role WHERE role.rolname = v_role) THEN CONTINUE; END IF;
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.companion_v3_runtime_complete_v4(uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,text,text,text,public.companion_runtime_error_action,integer) FROM %I',v_role);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.companion_v3_runtime_begin_admission(uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,integer) FROM %I',v_role);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.companion_v3_runtime_authorize_warm_turn(uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,integer) FROM %I',v_role);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.companion_v3_runtime_record_native_admission(uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,text,uuid,bigint,integer) FROM %I',v_role);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.companion_v3_runtime_project_native_page_v4(uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,bigint,jsonb,boolean,boolean,text,integer) FROM %I',v_role);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.companion_v3_runtime_claim_preparation_v5(text,integer,integer) FROM %I',v_role);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.companion_v3_runtime_checkpoint_preparation(uuid,uuid,uuid,bigint,bigint,text,text,text,text,integer,bigint,integer,text,timestamptz,integer) FROM %I',v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_v3_runtime_begin_admission_v5(uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,text,bigint,integer) TO %I',v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_v3_runtime_claim_warm_v5(text,public.companion_v3_lane,integer,integer) TO %I',v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_v3_runtime_authorize_warm_turn_v5(uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,integer) TO %I',v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_v3_runtime_record_native_admission_v5(uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,text,uuid,bigint,integer) TO %I',v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_v3_runtime_complete_v5(uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,text,text,text,public.companion_runtime_error_action,integer) TO %I',v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_v3_runtime_claim_preparation_v6(text,integer,integer) TO %I',v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_v3_runtime_checkpoint_pi_recycle(uuid,uuid,uuid,bigint,bigint,text,text,integer) TO %I',v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_v3_runtime_reconcile_pi_recycle_invocation(uuid,uuid,uuid,bigint,bigint,text,text,integer) TO %I',v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_v3_runtime_checkpoint_preparation_v6(uuid,uuid,uuid,bigint,bigint,text,text,text,text,integer,bigint,integer,text,timestamptz,integer) TO %I',v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_v3_runtime_project_native_page_v5(uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,bigint,jsonb,jsonb,boolean,boolean,text,integer) TO %I',v_role);
  END LOOP;
END $$;
