-- Runtime v3 expand step. These facts and capabilities are deliberately not wired into any
-- production composition root: Runtime v2 remains the live path until the later cutover stack.
-- PostgreSQL owns admission identity, per-lane FIFO, and monotonic fences; TypeScript owns what a
-- claimed fact progresses to. There is no v3 attempt table and no derived Start operation.
CREATE TYPE public.companion_v3_lane AS ENUM ('main', 'background');
--> statement-breakpoint
CREATE TYPE public.companion_v3_turn_state AS ENUM (
  'queued', 'admitted', 'running', 'needs_input',
  'succeeded', 'failed', 'interrupted', 'cancelled'
);
--> statement-breakpoint
CREATE TYPE public.companion_v3_admission_state AS ENUM ('pending', 'accepted', 'ambiguous');
--> statement-breakpoint
CREATE TYPE public.companion_v3_turn_outcome AS ENUM (
  'succeeded', 'failed', 'interrupted', 'cancelled'
);
--> statement-breakpoint
CREATE TYPE public.companion_v3_lifecycle_intent AS ENUM (
  'prepare', 'archive', 'recycle_pi', 'delete'
);
--> statement-breakpoint

CREATE TABLE public.companion_v3_instances (
  org_id uuid NOT NULL,
  companion_id uuid NOT NULL,
  desired_lifecycle public.companion_v3_lifecycle_intent NOT NULL DEFAULT 'prepare',
  desired_lifecycle_revision bigint NOT NULL DEFAULT 1,
  desired_lifecycle_actor_id text,
  next_main_sequence bigint NOT NULL DEFAULT 1,
  next_background_sequence bigint NOT NULL DEFAULT 1,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT companion_v3_instances_pk PRIMARY KEY (org_id, companion_id),
  CONSTRAINT companion_v3_instances_companion_fk
    FOREIGN KEY (org_id, companion_id)
    REFERENCES public.companions(org_id, id) ON DELETE CASCADE,
  CONSTRAINT companion_v3_instances_revision_check CHECK (
    desired_lifecycle_revision >= 1
    AND next_main_sequence >= 1
    AND next_background_sequence >= 1
  ),
  CONSTRAINT companion_v3_instances_actor_check CHECK (
    desired_lifecycle_actor_id IS NULL
    OR (char_length(desired_lifecycle_actor_id) BETWEEN 1 AND 200
      AND desired_lifecycle_actor_id !~ E'[\n\r]')
  )
);
--> statement-breakpoint

CREATE TABLE public.companion_v3_turns (
  id uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  companion_id uuid NOT NULL,
  command_id uuid NOT NULL,
  client_message_id uuid NOT NULL,
  message_event_id text NOT NULL,
  actor_id text NOT NULL,
  lane public.companion_v3_lane NOT NULL,
  queue_sequence bigint NOT NULL,
  state public.companion_v3_turn_state NOT NULL DEFAULT 'queued',
  admission_state public.companion_v3_admission_state NOT NULL DEFAULT 'pending',
  admitted_at timestamp with time zone,
  pi_invocation_id text,
  admission_cursor bigint,
  activity_cursor bigint NOT NULL DEFAULT 0,
  last_activity_at timestamp with time zone,
  outcome public.companion_v3_turn_outcome,
  outcome_code text,
  outcome_message text,
  outcome_action public.companion_runtime_error_action,
  settled_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT companion_v3_turns_org_companion_id_uq UNIQUE (org_id, companion_id, id),
  CONSTRAINT companion_v3_turns_command_uq UNIQUE (companion_id, command_id),
  CONSTRAINT companion_v3_turns_client_message_uq UNIQUE (companion_id, client_message_id),
  CONSTRAINT companion_v3_turns_lane_sequence_uq UNIQUE (companion_id, lane, queue_sequence),
  CONSTRAINT companion_v3_turns_instance_fk
    FOREIGN KEY (org_id, companion_id)
    REFERENCES public.companion_v3_instances(org_id, companion_id) ON DELETE CASCADE,
  CONSTRAINT companion_v3_turns_sequence_check CHECK (queue_sequence >= 1),
  CONSTRAINT companion_v3_turns_message_event_check CHECK (
    message_event_id = 'msg:' || client_message_id::text
  ),
  CONSTRAINT companion_v3_turns_actor_check CHECK (
    char_length(actor_id) BETWEEN 1 AND 200 AND actor_id !~ E'[\n\r]'
  ),
  CONSTRAINT companion_v3_turns_invocation_check CHECK (
    pi_invocation_id IS NULL
    OR (char_length(pi_invocation_id) BETWEEN 1 AND 200 AND pi_invocation_id !~ E'[\n\r]')
  ),
  CONSTRAINT companion_v3_turns_cursor_check CHECK (
    activity_cursor >= 0 AND (admission_cursor IS NULL OR admission_cursor >= 0)
  ),
  CONSTRAINT companion_v3_turns_admission_check CHECK (
    (admission_state = 'pending' AND admitted_at IS NULL AND pi_invocation_id IS NULL
      AND admission_cursor IS NULL)
    OR (admission_state IN ('accepted', 'ambiguous') AND admitted_at IS NOT NULL
      AND pi_invocation_id IS NOT NULL AND admission_cursor IS NOT NULL)
  ),
  CONSTRAINT companion_v3_turns_outcome_check CHECK (
    (outcome IS NULL AND settled_at IS NULL
      AND outcome_code IS NULL AND outcome_message IS NULL AND outcome_action IS NULL
      AND state IN ('queued', 'admitted', 'running', 'needs_input'))
    OR (outcome IS NOT NULL AND settled_at IS NOT NULL AND state::text = outcome::text
      AND ((outcome IN ('failed', 'interrupted')
          AND outcome_code ~ '^[a-z][a-z0-9_]{0,63}$'
          AND char_length(outcome_message) BETWEEN 1 AND 500
          AND outcome_message !~ E'[\n\r]'
          AND outcome_action IS NOT NULL AND outcome_action <> 'restart_box')
        OR (outcome IN ('succeeded', 'cancelled')
          AND outcome_code IS NULL AND outcome_message IS NULL AND outcome_action IS NULL)))
  )
);
--> statement-breakpoint
CREATE INDEX companion_v3_turns_fifo_idx
  ON public.companion_v3_turns(companion_id, lane, queue_sequence, id)
  WHERE state = 'queued';
--> statement-breakpoint

CREATE TABLE public.companion_v3_lane_leases (
  org_id uuid NOT NULL,
  companion_id uuid NOT NULL,
  lane public.companion_v3_lane NOT NULL,
  claim_token uuid,
  claim_epoch bigint NOT NULL DEFAULT 0,
  executor_id text,
  turn_id uuid,
  claimed_at timestamp with time zone,
  renewed_at timestamp with time zone,
  expires_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT companion_v3_lane_leases_pk PRIMARY KEY (org_id, companion_id, lane),
  CONSTRAINT companion_v3_lane_leases_instance_fk
    FOREIGN KEY (org_id, companion_id)
    REFERENCES public.companion_v3_instances(org_id, companion_id) ON DELETE CASCADE,
  CONSTRAINT companion_v3_lane_leases_turn_fk
    FOREIGN KEY (org_id, companion_id, turn_id)
    REFERENCES public.companion_v3_turns(org_id, companion_id, id) ON DELETE CASCADE,
  CONSTRAINT companion_v3_lane_leases_epoch_check CHECK (claim_epoch >= 0),
  CONSTRAINT companion_v3_lane_leases_executor_check CHECK (
    executor_id IS NULL
    OR (char_length(executor_id) BETWEEN 1 AND 200 AND executor_id !~ E'[\n\r]')
  ),
  CONSTRAINT companion_v3_lane_leases_claim_check CHECK (
    (claim_token IS NULL AND executor_id IS NULL AND turn_id IS NULL
      AND claimed_at IS NULL AND renewed_at IS NULL AND expires_at IS NULL)
    OR (claim_token IS NOT NULL AND claim_epoch >= 1 AND executor_id IS NOT NULL
      AND turn_id IS NOT NULL AND claimed_at IS NOT NULL AND renewed_at IS NOT NULL
      AND expires_at > renewed_at)
  )
);
--> statement-breakpoint
CREATE INDEX companion_v3_lane_leases_expiry_idx
  ON public.companion_v3_lane_leases(expires_at)
  WHERE claim_token IS NOT NULL;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_admit_turn(
  p_org_id uuid,
  p_companion_id uuid,
  p_client_message_id uuid,
  p_message_event_id text,
  p_actor_id text,
  p_lane public.companion_v3_lane
)
RETURNS TABLE (
  turn_id uuid,
  command_id uuid,
  lane public.companion_v3_lane,
  state public.companion_v3_turn_state,
  replayed boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_turn public.companion_v3_turns%ROWTYPE;
  v_sequence bigint;
BEGIN
  IF p_org_id IS NULL OR p_companion_id IS NULL OR p_client_message_id IS NULL
    OR p_actor_id IS NULL OR char_length(p_actor_id) NOT BETWEEN 1 AND 200
    OR p_actor_id ~ E'[\n\r]'
    OR p_message_event_id IS DISTINCT FROM 'msg:' || p_client_message_id::text THEN
    RAISE EXCEPTION 'invalid Runtime v3 Turn admission' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.companion_v3_instances(org_id, companion_id)
  VALUES (p_org_id, p_companion_id)
  ON CONFLICT (org_id, companion_id) DO NOTHING;

  -- Serialize idempotency lookup and sequence allocation per Companion. Concurrent retries of one
  -- client_message_id therefore resolve to the first Turn instead of surfacing a uniqueness race.
  PERFORM 1 FROM public.companion_v3_instances instance
  WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id
  FOR UPDATE;

  SELECT turn_row.* INTO v_turn
  FROM public.companion_v3_turns turn_row
  WHERE turn_row.org_id = p_org_id
    AND turn_row.companion_id = p_companion_id
    AND turn_row.client_message_id = p_client_message_id;
  IF FOUND THEN
    IF v_turn.org_id IS DISTINCT FROM p_org_id
      OR v_turn.actor_id IS DISTINCT FROM p_actor_id
      OR v_turn.message_event_id IS DISTINCT FROM p_message_event_id
      OR v_turn.lane IS DISTINCT FROM p_lane THEN
      RAISE EXCEPTION 'client_message_id was reused with different Runtime v3 intent'
        USING ERRCODE = '23505', CONSTRAINT = 'companion_v3_turns_client_message_uq';
    END IF;
    RETURN QUERY SELECT v_turn.id, v_turn.command_id, v_turn.lane, v_turn.state, true;
    RETURN;
  END IF;

  IF p_lane = 'main' THEN
    UPDATE public.companion_v3_instances instance
    SET next_main_sequence = instance.next_main_sequence + 1,
        updated_at = clock_timestamp()
    WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id
    RETURNING instance.next_main_sequence - 1 INTO v_sequence;
  ELSE
    UPDATE public.companion_v3_instances instance
    SET next_background_sequence = instance.next_background_sequence + 1,
        updated_at = clock_timestamp()
    WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id
    RETURNING instance.next_background_sequence - 1 INTO v_sequence;
  END IF;

  INSERT INTO public.companion_v3_lane_leases(org_id, companion_id, lane)
  VALUES (p_org_id, p_companion_id, 'main'), (p_org_id, p_companion_id, 'background')
  ON CONFLICT ON CONSTRAINT companion_v3_lane_leases_pk DO NOTHING;

  INSERT INTO public.companion_v3_turns(
    org_id, companion_id, command_id, client_message_id, message_event_id,
    actor_id, lane, queue_sequence
  ) VALUES (
    p_org_id, p_companion_id, p_client_message_id, p_client_message_id,
    p_message_event_id, p_actor_id, p_lane, v_sequence
  ) RETURNING * INTO v_turn;
  RETURN QUERY SELECT v_turn.id, v_turn.command_id, v_turn.lane, v_turn.state, false;
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_api_admit_turn(
  p_org_id uuid,
  p_companion_id uuid,
  p_client_message_id uuid,
  p_message_event_id text
)
RETURNS TABLE (
  turn_id uuid,
  command_id uuid,
  lane public.companion_v3_lane,
  state public.companion_v3_turn_state,
  replayed boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_actor_id text := public.companion_api_actor(p_org_id);
BEGIN
  PERFORM public.companion_api_require_access(p_org_id, p_companion_id, 'editor');
  RETURN QUERY SELECT * FROM public.companion_v3_admit_turn(
    p_org_id, p_companion_id, p_client_message_id, p_message_event_id,
    v_actor_id, 'main'
  );
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_worker_admit_turn(
  p_org_id uuid,
  p_companion_id uuid,
  p_client_message_id uuid,
  p_message_event_id text,
  p_actor_id text
)
RETURNS TABLE (
  turn_id uuid,
  command_id uuid,
  lane public.companion_v3_lane,
  state public.companion_v3_turn_state,
  replayed boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.companions companion
    JOIN public.memberships membership
      ON membership.org_id = companion.org_id
     AND membership.user_id = companion.owner_id
    WHERE companion.org_id = p_org_id
      AND companion.id = p_companion_id
      AND companion.owner_id = p_actor_id
  ) THEN
    RAISE EXCEPTION 'Runtime v3 background actor is not the Companion Owner'
      USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT * FROM public.companion_v3_admit_turn(
    p_org_id, p_companion_id, p_client_message_id, p_message_event_id,
    p_actor_id, 'background'
  );
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_api_desire_lifecycle(
  p_org_id uuid,
  p_companion_id uuid,
  p_intent public.companion_v3_lifecycle_intent
)
RETURNS TABLE (intent public.companion_v3_lifecycle_intent, revision bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_actor_id text := public.companion_api_actor(p_org_id);
BEGIN
  PERFORM public.companion_api_require_access(p_org_id, p_companion_id,
    CASE WHEN p_intent = 'delete' THEN 'owner' ELSE 'editor' END);
  INSERT INTO public.companion_v3_instances(
    org_id, companion_id, desired_lifecycle, desired_lifecycle_actor_id
  ) VALUES (p_org_id, p_companion_id, p_intent, v_actor_id)
  ON CONFLICT (org_id, companion_id) DO UPDATE
  SET desired_lifecycle = EXCLUDED.desired_lifecycle,
      desired_lifecycle_revision = companion_v3_instances.desired_lifecycle_revision + 1,
      desired_lifecycle_actor_id = EXCLUDED.desired_lifecycle_actor_id,
      updated_at = clock_timestamp()
  RETURNING desired_lifecycle, desired_lifecycle_revision INTO intent, revision;
  INSERT INTO public.companion_v3_lane_leases(org_id, companion_id, lane)
  VALUES (p_org_id, p_companion_id, 'main'), (p_org_id, p_companion_id, 'background')
  ON CONFLICT ON CONSTRAINT companion_v3_lane_leases_pk DO NOTHING;
  RETURN NEXT;
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_runtime_claim(
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
  claim_epoch bigint
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
BEGIN
  IF p_protocol IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'Runtime v3 protocol is required' USING ERRCODE = '42501';
  END IF;
  IF p_executor_id IS NULL OR char_length(p_executor_id) NOT BETWEEN 1 AND 200
    OR p_executor_id ~ E'[\n\r]' OR p_lease_seconds NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION 'invalid Runtime v3 claim' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.companion_runtime_control control
    WHERE control.id = 'runtime-v2' AND control.enabled
  ) THEN
    RETURN;
  END IF;

  SELECT lease.* INTO v_lease
  FROM public.companion_v3_lane_leases lease
  JOIN public.companion_v3_turns queued
    ON queued.org_id = lease.org_id AND queued.companion_id = lease.companion_id
   AND queued.lane = lease.lane AND queued.state = 'queued'
  WHERE lease.lane = p_lane
    AND (lease.claim_token IS NULL OR lease.expires_at <= v_now)
  ORDER BY queued.created_at, queued.queue_sequence, queued.id
  LIMIT 1
  FOR UPDATE OF lease SKIP LOCKED;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT queued.* INTO v_turn
  FROM public.companion_v3_turns queued
  WHERE queued.org_id = v_lease.org_id
    AND queued.companion_id = v_lease.companion_id
    AND queued.lane = p_lane
    AND queued.state = 'queued'
  ORDER BY queued.queue_sequence, queued.id
  LIMIT 1
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  UPDATE public.companion_v3_lane_leases lease
  SET claim_token = gen_random_uuid(),
      claim_epoch = lease.claim_epoch + 1,
      executor_id = p_executor_id,
      turn_id = v_turn.id,
      claimed_at = v_now,
      renewed_at = v_now,
      expires_at = v_now + make_interval(secs => p_lease_seconds),
      updated_at = v_now
  WHERE lease.org_id = v_lease.org_id
    AND lease.companion_id = v_lease.companion_id
    AND lease.lane = p_lane
  RETURNING lease.claim_token, lease.claim_epoch INTO claim_token, claim_epoch;

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

CREATE FUNCTION public.companion_v3_runtime_complete(
  p_org_id uuid,
  p_companion_id uuid,
  p_lane public.companion_v3_lane,
  p_turn_id uuid,
  p_claim_token uuid,
  p_claim_epoch bigint,
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
DECLARE
  v_now timestamp with time zone := clock_timestamp();
BEGIN
  IF p_protocol IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'Runtime v3 protocol is required' USING ERRCODE = '42501';
  END IF;
  IF p_outcome NOT IN ('release', 'succeeded', 'failed', 'interrupted')
    OR (p_outcome IN ('failed', 'interrupted') AND (
      p_code IS NULL OR p_message IS NULL OR p_action IS NULL OR p_action = 'restart_box'
    ))
    OR (p_outcome IN ('release', 'succeeded') AND (
      p_code IS NOT NULL OR p_message IS NOT NULL OR p_action IS NOT NULL
    )) THEN
    RAISE EXCEPTION 'invalid Runtime v3 completion' USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM public.companion_v3_lane_leases lease
  WHERE lease.org_id = p_org_id AND lease.companion_id = p_companion_id
    AND lease.lane = p_lane AND lease.turn_id = p_turn_id
    AND lease.claim_token = p_claim_token AND lease.claim_epoch = p_claim_epoch
    AND lease.expires_at > v_now
  FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  IF p_outcome <> 'release' THEN
    UPDATE public.companion_v3_turns turn_row
    SET state = p_outcome::public.companion_v3_turn_state,
        outcome = p_outcome::public.companion_v3_turn_outcome,
        outcome_code = p_code,
        outcome_message = p_message,
        outcome_action = p_action,
        settled_at = v_now,
        updated_at = v_now
    WHERE turn_row.org_id = p_org_id AND turn_row.companion_id = p_companion_id
      AND turn_row.id = p_turn_id AND turn_row.state = 'queued';
    IF NOT FOUND THEN RETURN false; END IF;
  END IF;

  UPDATE public.companion_v3_lane_leases lease
  SET claim_token = NULL, executor_id = NULL, turn_id = NULL,
      claimed_at = NULL, renewed_at = NULL, expires_at = NULL, updated_at = v_now
  WHERE lease.org_id = p_org_id AND lease.companion_id = p_companion_id
    AND lease.lane = p_lane AND lease.claim_token = p_claim_token
    AND lease.claim_epoch = p_claim_epoch;
  RETURN FOUND;
END
$$;
--> statement-breakpoint

ALTER TABLE public.companion_v3_instances ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.companion_v3_instances FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.companion_v3_turns ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.companion_v3_turns FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.companion_v3_lane_leases ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.companion_v3_lane_leases FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY companion_v3_instances_function_owner_rls
  ON public.companion_v3_instances FOR ALL
  USING (current_user = pg_get_userbyid((
    SELECT procedure.proowner FROM pg_proc procedure
    WHERE procedure.oid = 'public.companion_v3_admit_turn(uuid,uuid,uuid,text,text,public.companion_v3_lane)'::regprocedure
  )))
  WITH CHECK (current_user = pg_get_userbyid((
    SELECT procedure.proowner FROM pg_proc procedure
    WHERE procedure.oid = 'public.companion_v3_admit_turn(uuid,uuid,uuid,text,text,public.companion_v3_lane)'::regprocedure
  )));
--> statement-breakpoint
CREATE POLICY companion_v3_turns_function_owner_rls
  ON public.companion_v3_turns FOR ALL
  USING (current_user = pg_get_userbyid((
    SELECT procedure.proowner FROM pg_proc procedure
    WHERE procedure.oid = 'public.companion_v3_admit_turn(uuid,uuid,uuid,text,text,public.companion_v3_lane)'::regprocedure
  )))
  WITH CHECK (current_user = pg_get_userbyid((
    SELECT procedure.proowner FROM pg_proc procedure
    WHERE procedure.oid = 'public.companion_v3_admit_turn(uuid,uuid,uuid,text,text,public.companion_v3_lane)'::regprocedure
  )));
--> statement-breakpoint
CREATE POLICY companion_v3_lane_leases_function_owner_rls
  ON public.companion_v3_lane_leases FOR ALL
  USING (current_user = pg_get_userbyid((
    SELECT procedure.proowner FROM pg_proc procedure
    WHERE procedure.oid = 'public.companion_v3_admit_turn(uuid,uuid,uuid,text,text,public.companion_v3_lane)'::regprocedure
  )))
  WITH CHECK (current_user = pg_get_userbyid((
    SELECT procedure.proowner FROM pg_proc procedure
    WHERE procedure.oid = 'public.companion_v3_admit_turn(uuid,uuid,uuid,text,text,public.companion_v3_lane)'::regprocedure
  )));
--> statement-breakpoint

REVOKE ALL ON TABLE public.companion_v3_instances FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON TABLE public.companion_v3_turns FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON TABLE public.companion_v3_lane_leases FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_v3_admit_turn(
  uuid,uuid,uuid,text,text,public.companion_v3_lane
) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_v3_api_admit_turn(uuid,uuid,uuid,text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_v3_worker_admit_turn(uuid,uuid,uuid,text,text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_v3_api_desire_lifecycle(
  uuid,uuid,public.companion_v3_lifecycle_intent
) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_v3_runtime_claim(
  text,public.companion_v3_lane,integer,integer
) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_v3_runtime_complete(
  uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,text,text,text,
  public.companion_runtime_error_action,integer
) FROM PUBLIC;
