-- THE-519: Runtime v3 Turns and preparation receive durable outer bounds. PostgreSQL owns the
-- deadline facts and monotonic fences; TypeScript owns phase budgets and retry policy.
ALTER TABLE public.companion_v3_instances
  ADD COLUMN preparation_deadline_at timestamp with time zone;
--> statement-breakpoint
ALTER TABLE public.companion_v3_turns
  ADD COLUMN admission_started_at timestamp with time zone,
  ADD COLUMN correlated_activity_cursor bigint NOT NULL DEFAULT 0,
  ADD COLUMN inactivity_deadline_at timestamp with time zone,
  ADD COLUMN absolute_deadline_at timestamp with time zone;
--> statement-breakpoint
UPDATE public.companion_v3_turns
SET admission_started_at = admitted_at
WHERE admission_state IN ('accepted', 'ambiguous') AND admitted_at IS NOT NULL;
--> statement-breakpoint
UPDATE public.companion_v3_turns
SET absolute_deadline_at = admitted_at + interval '2 hours',
    inactivity_deadline_at = CASE WHEN state = 'needs_input' THEN NULL
      ELSE LEAST(admitted_at + interval '2 hours',
        COALESCE(last_activity_at, admitted_at) + interval '10 minutes') END
WHERE state IN ('admitted', 'running', 'needs_input') AND admission_state = 'accepted';
--> statement-breakpoint
ALTER TABLE public.companion_v3_turns
  DROP CONSTRAINT companion_v3_turns_admission_check,
  ADD CONSTRAINT companion_v3_turns_admission_check CHECK (
    (admission_state = 'pending' AND admitted_at IS NULL
      AND pi_invocation_id IS NULL AND admission_cursor IS NULL)
    OR (admission_state IN ('accepted', 'ambiguous') AND admission_started_at IS NOT NULL
      AND admitted_at IS NOT NULL AND pi_invocation_id IS NOT NULL
      AND admission_cursor IS NOT NULL)
  ),
  ADD CONSTRAINT companion_v3_turns_deadline_check CHECK (
    (state = 'queued' AND inactivity_deadline_at IS NULL AND absolute_deadline_at IS NULL)
    OR (state IN ('admitted', 'running') AND inactivity_deadline_at IS NOT NULL
      AND absolute_deadline_at IS NOT NULL AND inactivity_deadline_at <= absolute_deadline_at)
    OR (state = 'needs_input' AND inactivity_deadline_at IS NULL
      AND absolute_deadline_at IS NOT NULL)
    OR (state IN ('succeeded', 'failed', 'interrupted', 'cancelled')
      AND inactivity_deadline_at IS NULL AND absolute_deadline_at IS NULL)
  );
--> statement-breakpoint
CREATE INDEX companion_v3_turns_deadlines_idx
  ON public.companion_v3_turns(absolute_deadline_at, inactivity_deadline_at)
  WHERE state IN ('admitted', 'running', 'needs_input');
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_bound_turn_clocks()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public AS $$
DECLARE v_now timestamp with time zone := clock_timestamp();
BEGIN
  IF NEW.state IN ('succeeded', 'failed', 'interrupted', 'cancelled') THEN
    NEW.inactivity_deadline_at := NULL;
    NEW.absolute_deadline_at := NULL;
    RETURN NEW;
  END IF;
  IF NEW.state = 'queued' THEN
    NEW.inactivity_deadline_at := NULL;
    NEW.absolute_deadline_at := NULL;
    RETURN NEW;
  END IF;
  IF OLD.state = 'queued' AND NEW.admission_state = 'accepted' THEN
    NEW.admission_started_at := COALESCE(NEW.admission_started_at, v_now);
    NEW.absolute_deadline_at := COALESCE(NEW.absolute_deadline_at, v_now + interval '2 hours');
    NEW.last_activity_at := COALESCE(NEW.last_activity_at, v_now);
    NEW.inactivity_deadline_at := CASE WHEN NEW.state = 'needs_input' THEN NULL
      ELSE LEAST(NEW.absolute_deadline_at, NEW.last_activity_at + interval '10 minutes') END;
    RETURN NEW;
  END IF;
  NEW.absolute_deadline_at := OLD.absolute_deadline_at;
  IF NEW.state = 'needs_input' THEN
    NEW.inactivity_deadline_at := NULL;
  ELSIF NEW.correlated_activity_cursor > OLD.correlated_activity_cursor THEN
    NEW.last_activity_at := COALESCE(NEW.last_activity_at, v_now);
    NEW.inactivity_deadline_at := LEAST(
      NEW.absolute_deadline_at, NEW.last_activity_at + interval '10 minutes');
  ELSE
    NEW.last_activity_at := OLD.last_activity_at;
    NEW.inactivity_deadline_at := OLD.inactivity_deadline_at;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER companion_v3_bound_turn_clocks
BEFORE UPDATE OF state, admission_state, correlated_activity_cursor, last_activity_at
ON public.companion_v3_turns FOR EACH ROW
EXECUTE FUNCTION public.companion_v3_bound_turn_clocks();
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_bound_preparation_clock()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.prepared_at IS NOT NULL THEN
    NEW.preparation_deadline_at := NULL;
    NEW.preparation_attempt_count := 0;
  ELSIF NEW.preparation_claim_token IS NOT NULL
    AND OLD.preparation_claim_token IS NULL
    AND NEW.preparation_deadline_at IS NULL THEN
    NEW.preparation_deadline_at := clock_timestamp() + interval '2 hours 15 minutes';
  END IF;
  IF NEW.preparation_error_code = 'companion_prepare_deadline_exceeded' THEN
    NEW.preparation_available_at := 'infinity'::timestamp with time zone;
  ELSIF NEW.preparation_deadline_at IS NOT NULL
    AND NEW.preparation_available_at > NEW.preparation_deadline_at THEN
    NEW.preparation_available_at := NEW.preparation_deadline_at;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER companion_v3_bound_preparation_clock
BEFORE UPDATE OF preparation_claim_token, preparation_available_at, prepared_at
ON public.companion_v3_instances FOR EACH ROW
EXECUTE FUNCTION public.companion_v3_bound_preparation_clock();
--> statement-breakpoint

-- A write-intent precedes the only non-replayable boundary. Takeover can therefore terminalize an
-- outcome-unknown prompt instead of dispatching the accepted occurrence a second time.
CREATE FUNCTION public.companion_v3_runtime_begin_admission(
  p_org_id uuid, p_companion_id uuid, p_lane public.companion_v3_lane,
  p_turn_id uuid, p_claim_token uuid, p_claim_epoch bigint, p_gate_epoch bigint,
  p_protocol integer
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = on AS $$
DECLARE v_now timestamp with time zone := clock_timestamp();
BEGIN
  IF p_protocol IS DISTINCT FROM 4 THEN
    RAISE EXCEPTION 'Runtime v3 protocol 4 is required' USING ERRCODE = '42501';
  END IF;
  UPDATE public.companion_v3_turns turn_row
  SET admission_started_at = v_now, updated_at = v_now
  FROM public.companion_v3_lane_leases lease, public.companion_runtime_control control
  WHERE turn_row.org_id = p_org_id AND turn_row.companion_id = p_companion_id
    AND turn_row.id = p_turn_id AND turn_row.lane = p_lane
    AND turn_row.state = 'queued' AND turn_row.admission_state = 'pending'
    AND turn_row.admission_started_at IS NULL
    AND lease.org_id = turn_row.org_id AND lease.companion_id = turn_row.companion_id
    AND lease.lane = turn_row.lane AND lease.turn_id = turn_row.id
    AND lease.claim_token = p_claim_token AND lease.claim_epoch = p_claim_epoch
    AND lease.gate_epoch = p_gate_epoch AND lease.expires_at > v_now
    AND control.id = 'runtime-v2' AND control.enabled AND control.gate_epoch = p_gate_epoch;
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_runtime_begin_admission(
  uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,integer
) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.companion_v3_runtime_sweep_deadlines(
  p_lane public.companion_v3_lane, p_protocol integer
)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = on AS $$
DECLARE
  v_now timestamp with time zone := clock_timestamp();
  v_turn public.companion_v3_turns%ROWTYPE;
  v_count integer := 0;
  v_code text;
  v_message text;
BEGIN
  PERFORM pg_catalog.set_config('app.companion_runtime_protocol', '2', true);
  IF p_protocol IS DISTINCT FROM 4 OR p_lane IS NULL THEN
    RAISE EXCEPTION 'invalid Runtime v3 deadline sweep' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.companion_runtime_control control
  WHERE control.id = 'runtime-v2' AND control.enabled FOR SHARE;
  IF NOT FOUND THEN RETURN 0; END IF;
  LOOP
    SELECT turn_row.* INTO v_turn
    FROM public.companion_v3_lane_leases lease
    JOIN public.companion_v3_turns turn_row
      ON turn_row.org_id = lease.org_id AND turn_row.companion_id = lease.companion_id
     AND turn_row.lane = lease.lane
    WHERE turn_row.lane = p_lane
      AND turn_row.state IN ('admitted', 'running', 'needs_input')
      AND turn_row.admission_state = 'accepted' AND turn_row.response_turn_id = turn_row.id
      AND (turn_row.absolute_deadline_at <= v_now
        OR (turn_row.state <> 'needs_input' AND turn_row.inactivity_deadline_at <= v_now))
    ORDER BY LEAST(turn_row.absolute_deadline_at,
      COALESCE(turn_row.inactivity_deadline_at, 'infinity'::timestamp with time zone)),
      turn_row.queue_sequence, turn_row.id
    LIMIT 1 FOR UPDATE OF lease, turn_row SKIP LOCKED;
    EXIT WHEN NOT FOUND OR v_count >= 64;
    IF v_turn.absolute_deadline_at <= v_now THEN
      v_code := 'turn_deadline_exceeded';
      v_message := 'The Companion reached its maximum execution time.';
    ELSE
      v_code := 'turn_stalled';
      v_message := 'The Companion stopped making progress.';
    END IF;
    UPDATE public.companion_v3_lane_leases lease
    SET claim_token = NULL, claim_epoch = lease.claim_epoch + 1,
      gate_epoch = NULL, executor_id = NULL, turn_id = NULL,
      claimed_at = NULL, renewed_at = NULL, expires_at = NULL, updated_at = v_now
    WHERE lease.org_id = v_turn.org_id AND lease.companion_id = v_turn.companion_id
      AND lease.lane = p_lane;
    UPDATE public.companion_v3_turns turn_row
    SET state = 'interrupted', outcome = 'interrupted', outcome_code = v_code,
      outcome_message = v_message, outcome_action = 'retry', settled_at = v_now,
      updated_at = v_now
    WHERE turn_row.org_id = v_turn.org_id AND turn_row.companion_id = v_turn.companion_id
      AND turn_row.lane = p_lane AND turn_row.admission_state = 'accepted'
      AND turn_row.response_turn_id = v_turn.id
      AND turn_row.state IN ('admitted', 'running', 'needs_input');
    UPDATE public.companion_threads thread
    SET projection_sequence = thread.projection_sequence + 1, updated_at = v_now
    WHERE thread.org_id = v_turn.org_id AND thread.companion_id = v_turn.companion_id;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_runtime_sweep_deadlines(
  public.companion_v3_lane,integer
) FROM PUBLIC;
--> statement-breakpoint

-- Compatibility wrappers close the old protocol surfaces to the runtime role while reusing the
-- already-reviewed FIFO and completion bodies underneath.
CREATE FUNCTION public.companion_v3_runtime_claim_v4(
  p_executor_id text, p_lane public.companion_v3_lane,
  p_lease_seconds integer, p_protocol integer
)
RETURNS TABLE (
  org_id uuid, companion_id uuid, turn_id uuid, command_id uuid,
  lane public.companion_v3_lane, state public.companion_v3_turn_state,
  claim_token uuid, claim_epoch bigint, gate_epoch bigint,
  admission_started_at timestamp with time zone,
  inactivity_deadline_at timestamp with time zone,
  absolute_deadline_at timestamp with time zone
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = on AS $$
BEGIN
  IF p_protocol IS DISTINCT FROM 4 THEN
    RAISE EXCEPTION 'Runtime v3 protocol 4 is required' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT claimed.org_id, claimed.companion_id, claimed.turn_id, claimed.command_id,
    claimed.lane, claimed.state, claimed.claim_token, claimed.claim_epoch, claimed.gate_epoch,
    turn_row.admission_started_at, turn_row.inactivity_deadline_at,
    turn_row.absolute_deadline_at
  FROM public.companion_v3_runtime_claim(p_executor_id, p_lane, p_lease_seconds, 3) claimed
  JOIN public.companion_v3_turns turn_row
    ON turn_row.org_id = claimed.org_id AND turn_row.companion_id = claimed.companion_id
   AND turn_row.id = claimed.turn_id;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_runtime_claim_v4(
  text,public.companion_v3_lane,integer,integer
) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_runtime_claim_warm_v4(
  p_executor_id text, p_lane public.companion_v3_lane,
  p_lease_seconds integer, p_protocol integer
)
RETURNS TABLE (
  org_id uuid, companion_id uuid, turn_id uuid, command_id uuid,
  lane public.companion_v3_lane, state public.companion_v3_turn_state,
  claim_token uuid, claim_epoch bigint, gate_epoch bigint,
  admission_started_at timestamp with time zone,
  inactivity_deadline_at timestamp with time zone,
  absolute_deadline_at timestamp with time zone
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = on AS $$
BEGIN
  IF p_protocol IS DISTINCT FROM 4 THEN
    RAISE EXCEPTION 'Runtime v3 protocol 4 is required' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT claimed.org_id, claimed.companion_id, claimed.turn_id, claimed.command_id,
    claimed.lane, claimed.state, claimed.claim_token, claimed.claim_epoch, claimed.gate_epoch,
    turn_row.admission_started_at, turn_row.inactivity_deadline_at,
    turn_row.absolute_deadline_at
  FROM public.companion_v3_runtime_claim_warm(
    p_executor_id, p_lane, p_lease_seconds, 3
  ) claimed
  JOIN public.companion_v3_turns turn_row
    ON turn_row.org_id = claimed.org_id AND turn_row.companion_id = claimed.companion_id
   AND turn_row.id = claimed.turn_id;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_runtime_claim_warm_v4(
  text,public.companion_v3_lane,integer,integer
) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_runtime_project_native_page_v4(
  p_org_id uuid, p_companion_id uuid, p_lane public.companion_v3_lane,
  p_turn_id uuid, p_claim_token uuid, p_claim_epoch bigint, p_gate_epoch bigint,
  p_through_cursor bigint, p_assistant jsonb, p_needs_input boolean,
  p_correlated_activity boolean, p_terminal text, p_protocol integer
)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = on AS $$
DECLARE
  v_now timestamp with time zone := clock_timestamp();
  v_projected text;
BEGIN
  IF p_protocol IS DISTINCT FROM 4 OR p_correlated_activity IS NULL THEN
    RAISE EXCEPTION 'Runtime v3 projection protocol 4 is required' USING ERRCODE = '42501';
  END IF;
  IF p_correlated_activity AND NOT p_needs_input AND p_terminal IS NULL THEN
    UPDATE public.companion_v3_turns turn_row
    SET state = 'running', correlated_activity_cursor = p_through_cursor,
      last_activity_at = v_now, updated_at = v_now
    FROM public.companion_v3_lane_leases lease, public.companion_runtime_control control
    WHERE turn_row.org_id = p_org_id AND turn_row.companion_id = p_companion_id
      AND turn_row.id = p_turn_id AND turn_row.lane = p_lane
      AND turn_row.state IN ('admitted', 'running', 'needs_input')
      AND p_through_cursor > turn_row.correlated_activity_cursor
      AND lease.org_id = turn_row.org_id AND lease.companion_id = turn_row.companion_id
      AND lease.lane = turn_row.lane AND lease.turn_id = turn_row.id
      AND lease.claim_token = p_claim_token AND lease.claim_epoch = p_claim_epoch
      AND lease.gate_epoch = p_gate_epoch AND lease.expires_at > v_now
      AND control.id = 'runtime-v2' AND control.enabled AND control.gate_epoch = p_gate_epoch;
    IF NOT FOUND THEN RETURN NULL; END IF;
  END IF;
  v_projected := public.companion_v3_runtime_project_native_page(
    p_org_id, p_companion_id, p_lane, p_turn_id, p_claim_token, p_claim_epoch,
    p_gate_epoch, p_through_cursor, p_assistant, p_needs_input, p_terminal, 3
  );
  IF v_projected IS NULL
    AND p_correlated_activity AND NOT p_needs_input AND p_terminal IS NULL THEN
    RAISE EXCEPTION 'Runtime v3 correlated projection lost its fence' USING ERRCODE = '40001';
  END IF;
  IF v_projected IS NOT NULL AND p_correlated_activity AND p_needs_input
    AND p_terminal IS NULL THEN
    UPDATE public.companion_v3_turns turn_row
    SET correlated_activity_cursor = p_through_cursor,
      last_activity_at = v_now, updated_at = v_now
    FROM public.companion_v3_lane_leases lease, public.companion_runtime_control control
    WHERE turn_row.org_id = p_org_id AND turn_row.companion_id = p_companion_id
      AND turn_row.id = p_turn_id AND turn_row.lane = p_lane
      AND turn_row.state IN ('running', 'needs_input')
      AND p_through_cursor >= turn_row.correlated_activity_cursor
      AND lease.org_id = turn_row.org_id AND lease.companion_id = turn_row.companion_id
      AND lease.lane = turn_row.lane AND lease.turn_id = turn_row.id
      AND lease.claim_token = p_claim_token AND lease.claim_epoch = p_claim_epoch
      AND lease.gate_epoch = p_gate_epoch AND lease.expires_at > v_now
      AND control.id = 'runtime-v2' AND control.enabled AND control.gate_epoch = p_gate_epoch;
    IF NOT FOUND THEN RETURN NULL; END IF;
  END IF;
  RETURN v_projected;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_runtime_project_native_page_v4(
  uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,bigint,jsonb,
  boolean,boolean,text,integer
) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_runtime_complete_v4(
  p_org_id uuid, p_companion_id uuid, p_lane public.companion_v3_lane,
  p_turn_id uuid, p_claim_token uuid, p_claim_epoch bigint, p_gate_epoch bigint,
  p_outcome text, p_code text, p_message text,
  p_action public.companion_runtime_error_action, p_protocol integer
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = on AS $$
DECLARE v_now timestamp with time zone := clock_timestamp();
BEGIN
  IF p_protocol IS DISTINCT FROM 4 THEN
    RAISE EXCEPTION 'Runtime v3 protocol 4 is required' USING ERRCODE = '42501';
  END IF;
  IF p_outcome = 'release' THEN
    UPDATE public.companion_v3_turns turn_row SET admission_started_at = NULL, updated_at = v_now
    FROM public.companion_v3_lane_leases lease, public.companion_runtime_control control
    WHERE turn_row.org_id = p_org_id AND turn_row.companion_id = p_companion_id
      AND turn_row.id = p_turn_id AND turn_row.lane = p_lane
      AND turn_row.state = 'queued' AND turn_row.admission_state = 'pending'
      AND lease.org_id = turn_row.org_id AND lease.companion_id = turn_row.companion_id
      AND lease.lane = turn_row.lane AND lease.turn_id = turn_row.id
      AND lease.claim_token = p_claim_token AND lease.claim_epoch = p_claim_epoch
      AND lease.gate_epoch = p_gate_epoch AND lease.expires_at > v_now
      AND control.id = 'runtime-v2' AND control.enabled AND control.gate_epoch = p_gate_epoch;
  END IF;
  RETURN public.companion_v3_runtime_complete(
    p_org_id, p_companion_id, p_lane, p_turn_id, p_claim_token, p_claim_epoch,
    p_gate_epoch, p_outcome, p_code, p_message, p_action, 3
  );
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_runtime_complete_v4(
  uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,text,text,text,
  public.companion_runtime_error_action,integer
) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_expire_preparation()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = on AS $$
DECLARE
  v_now timestamp with time zone := clock_timestamp();
  v_instance public.companion_v3_instances%ROWTYPE;
BEGIN
  SELECT instance.* INTO v_instance FROM public.companion_v3_instances instance
  JOIN public.companion_runtime_control control
    ON control.id = 'runtime-v2' AND control.enabled
  WHERE instance.prepared_at IS NULL AND instance.preparation_deadline_at <= v_now
    AND instance.preparation_error_code IS DISTINCT FROM 'companion_prepare_deadline_exceeded'
  ORDER BY instance.preparation_deadline_at, instance.created_at
  LIMIT 1 FOR UPDATE OF instance SKIP LOCKED;
  IF NOT FOUND THEN RETURN 0; END IF;
  UPDATE public.companion_v3_turns turn_row SET state = 'failed', outcome = 'failed',
    outcome_code = 'companion_prepare_deadline_exceeded',
    outcome_message = 'The Companion could not prepare before its deadline.',
    outcome_action = 'retry', settled_at = v_now, updated_at = v_now
  WHERE turn_row.org_id = v_instance.org_id
    AND turn_row.companion_id = v_instance.companion_id
    AND turn_row.state = 'queued';
  IF FOUND THEN
    UPDATE public.companion_threads thread
    SET projection_sequence = thread.projection_sequence + 1, updated_at = v_now
    WHERE thread.org_id = v_instance.org_id AND thread.companion_id = v_instance.companion_id;
  END IF;
  UPDATE public.companion_v3_instances instance SET
    preparation_claim_token = NULL,
    preparation_claim_epoch = instance.preparation_claim_epoch + 1,
    preparation_gate_epoch = NULL, preparation_executor_id = NULL,
    preparation_claimed_at = NULL, preparation_expires_at = NULL,
    preparation_attempt_count = instance.preparation_attempt_count,
    preparation_available_at = 'infinity'::timestamp with time zone,
    preparation_error_code = 'companion_prepare_deadline_exceeded',
    preparation_error_message = 'The Companion could not prepare before its deadline.',
    updated_at = v_now
  WHERE instance.org_id = v_instance.org_id AND instance.companion_id = v_instance.companion_id;
  RETURN 1;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_expire_preparation() FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_runtime_sweep_preparation_deadlines(p_protocol integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = on AS $$
DECLARE
  v_count integer := 0;
BEGIN
  IF p_protocol IS DISTINCT FROM 5 THEN
    RAISE EXCEPTION 'Runtime v3 preparation protocol 5 is required' USING ERRCODE = '42501';
  END IF;
  WHILE v_count < 64 LOOP
    EXIT WHEN public.companion_v3_expire_preparation() = 0;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_runtime_sweep_preparation_deadlines(integer)
FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_runtime_claim_preparation_v5(
  p_executor_id text, p_lease_seconds integer, p_protocol integer
)
RETURNS TABLE (
  org_id uuid, companion_id uuid, turn_id uuid, command_id uuid,
  work_kind text, checkpoint text, box_idempotency_key uuid, box_id text,
  claim_token uuid, claim_epoch bigint, gate_epoch bigint, created_at timestamp with time zone,
  attempt_count integer, deadline_at timestamp with time zone,
  authorized boolean, actor_id text, model_id text, persona text,
  settings_revision bigint, skills_revision integer,
  provider_refs jsonb, skill_refs jsonb, mcp_refs jsonb,
  provider_material jsonb, skill_material jsonb, mcp_material jsonb, config_catalog jsonb
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = on AS $$
DECLARE
  v_claim record;
  v_instance public.companion_v3_instances%ROWTYPE;
  v_expired integer;
BEGIN
  IF p_protocol IS DISTINCT FROM 5 THEN
    RAISE EXCEPTION 'Runtime v3 preparation protocol 5 is required' USING ERRCODE = '42501';
  END IF;
  v_expired := public.companion_v3_runtime_sweep_preparation_deadlines(5);
  IF v_expired = 64 THEN RETURN; END IF;
  SELECT claimed.* INTO v_claim
  FROM public.companion_v3_runtime_claim_preparation(
    p_executor_id, p_lease_seconds, 4
  ) claimed;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT instance.* INTO v_instance
  FROM public.companion_v3_instances instance
  WHERE instance.org_id = v_claim.org_id
    AND instance.companion_id = v_claim.companion_id
  FOR UPDATE;
  IF v_instance.preparation_deadline_at <= clock_timestamp() THEN
    PERFORM public.companion_v3_expire_preparation();
    RETURN;
  END IF;
  RETURN QUERY
  SELECT v_claim.org_id, v_claim.companion_id, v_claim.turn_id, v_claim.command_id,
    v_claim.work_kind, v_claim.checkpoint, v_claim.box_idempotency_key, v_claim.box_id,
    v_claim.claim_token, v_claim.claim_epoch, v_claim.gate_epoch, v_claim.created_at,
    v_instance.preparation_attempt_count, v_instance.preparation_deadline_at,
    v_claim.authorized, v_claim.actor_id, v_claim.model_id, v_claim.persona,
    v_claim.settings_revision, v_claim.skills_revision,
    v_claim.provider_refs, v_claim.skill_refs, v_claim.mcp_refs,
    v_claim.provider_material, v_claim.skill_material, v_claim.mcp_material,
    v_claim.config_catalog;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_runtime_claim_preparation_v5(
  text,integer,integer
) FROM PUBLIC;
--> statement-breakpoint

DO $$
DECLARE v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY[
    current_setting('companion.companion_runtime_role', true),
    current_setting('companion.runtime_role', true)
  ] LOOP
    IF v_role IS NULL OR btrim(v_role) = '' OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles role WHERE role.rolname = v_role
    ) THEN CONTINUE; END IF;
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.companion_v3_runtime_claim_warm(text,public.companion_v3_lane,integer,integer) FROM %I', v_role);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.companion_v3_runtime_claim(text,public.companion_v3_lane,integer,integer) FROM %I', v_role);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.companion_v3_runtime_complete(uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,text,text,text,public.companion_runtime_error_action,integer) FROM %I', v_role);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.companion_v3_runtime_project_native_page(uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,bigint,jsonb,boolean,text,integer) FROM %I', v_role);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.companion_v3_runtime_claim_preparation(text,integer,integer) FROM %I', v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_v3_runtime_claim_warm_v4(text,public.companion_v3_lane,integer,integer) TO %I', v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_v3_runtime_claim_v4(text,public.companion_v3_lane,integer,integer) TO %I', v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_v3_runtime_complete_v4(uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,text,text,text,public.companion_runtime_error_action,integer) TO %I', v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_v3_runtime_begin_admission(uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,integer) TO %I', v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_v3_runtime_project_native_page_v4(uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,bigint,jsonb,boolean,boolean,text,integer) TO %I', v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_v3_runtime_sweep_deadlines(public.companion_v3_lane,integer) TO %I', v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_v3_runtime_sweep_preparation_deadlines(integer) TO %I', v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_v3_runtime_claim_preparation_v5(text,integer,integer) TO %I', v_role);
  END LOOP;
END $$;
