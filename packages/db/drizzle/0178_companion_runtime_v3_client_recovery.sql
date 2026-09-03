-- Runtime v3's first-party clients share one PostgreSQL-only waiting projection. The p99 bit uses
-- the wake path captured at acceptance and requires a durable progress fact; clients never run a
-- timer, invent an ETA, or contact Box/Pi to classify recovery.
DROP FUNCTION public.companion_v3_api_read_projection(uuid,uuid,jsonb);
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_api_read_projection(
  p_org_id uuid,
  p_companion_id uuid,
  p_event_ids jsonb
)
RETURNS TABLE (
  active_turn jsonb,
  queued_count integer,
  queued_turn jsonb,
  preparation jsonb,
  background_busy boolean,
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
  v_now timestamptz := clock_timestamp();
  v_active public.companion_v3_turns%ROWTYPE;
  v_pending public.companion_v3_turns%ROWTYPE;
  v_instance public.companion_v3_instances%ROWTYPE;
  v_has_active boolean := false;
  v_has_pending boolean := false;
  v_has_progress boolean := false;
  v_p99 interval;
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

  SELECT instance.* INTO STRICT v_instance
  FROM public.companion_v3_instances instance
  WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id;

  SELECT turn_row.* INTO v_active
  FROM public.companion_v3_turns turn_row
  WHERE turn_row.org_id = p_org_id AND turn_row.companion_id = p_companion_id
    AND turn_row.lane = 'main'
    AND turn_row.state IN ('admitted', 'running', 'needs_input')
  ORDER BY turn_row.queue_sequence, turn_row.id
  LIMIT 1;
  v_has_active := FOUND;

  SELECT turn_row.* INTO v_pending
  FROM public.companion_v3_turns turn_row
  WHERE turn_row.org_id = p_org_id AND turn_row.companion_id = p_companion_id
    AND turn_row.lane = 'main' AND turn_row.state = 'queued'
  ORDER BY turn_row.queue_sequence, turn_row.id
  LIMIT 1;
  v_has_pending := FOUND;

  active_turn := CASE WHEN v_has_active
    THEN public.companion_v3_public_turn(v_active) ELSE NULL END;
  SELECT count(*)::integer INTO queued_count
  FROM public.companion_v3_turns turn_row
  WHERE turn_row.org_id = p_org_id AND turn_row.companion_id = p_companion_id
    AND turn_row.lane = 'main' AND turn_row.state = 'queued';
  queued_turn := CASE WHEN v_has_pending
    THEN public.companion_v3_public_turn(v_pending) ELSE NULL END;

  IF v_has_pending AND NOT v_has_active THEN
    v_has_progress := v_pending.first_claimed_at IS NOT NULL
      OR v_pending.box_ready_at IS NOT NULL
      OR v_pending.staging_completed_at IS NOT NULL
      OR v_pending.pi_ready_at IS NOT NULL
      OR v_pending.external_incident_id IS NOT NULL
      OR v_instance.pi_recycle_checkpoint IS NOT NULL;
    v_p99 := CASE v_pending.wake_path
      WHEN 'warm' THEN interval '15 seconds'
      WHEN 'archived_wake' THEN interval '90 seconds'
      ELSE interval '120 seconds' END;
    preparation := jsonb_build_object(
      'state', CASE
        WHEN v_pending.external_incident_id IS NOT NULL THEN 'externally_blocked'
        WHEN v_instance.pi_recycle_checkpoint IS NOT NULL THEN 'repairing'
        WHEN v_instance.lifecycle_state <> 'active' OR v_instance.prepared_at IS NULL THEN 'cold'
        ELSE 'queued' END,
      'taking_longer_than_expected',
        v_has_progress AND v_now - v_pending.accepted_at > v_p99
    );
  ELSE
    preparation := NULL;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.companion_v3_turns turn_row
    WHERE turn_row.org_id = p_org_id AND turn_row.companion_id = p_companion_id
      AND turn_row.lane = 'background'
      AND turn_row.state IN ('queued', 'admitted', 'running', 'needs_input')
  ) INTO background_busy;
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

REVOKE ALL ON FUNCTION public.companion_v3_api_read_projection(uuid,uuid,jsonb) FROM PUBLIC;
--> statement-breakpoint

-- The temporary advanced Restart reuses the established operation envelope for all clients, but
-- marks it runtime-v3-owned before commit so a v2 executor can never claim it. If the exact Pi is
-- already healing this request joins that checkpoint; otherwise it schedules the same bounded
-- recycle immediately or directly after the accepted main Turn reaches a terminal boundary.
CREATE FUNCTION public.companion_v3_api_restart_pi(
  p_org_id uuid,
  p_companion_id uuid,
  p_request_id uuid,
  p_client_surface public.companion_client_surface
)
RETURNS TABLE (operation jsonb, replayed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_actor text := public.companion_api_actor(p_org_id);
  v_enqueued record;
  v_operation_id uuid;
  v_instance public.companion_v3_instances%ROWTYPE;
  v_active public.companion_v3_turns%ROWTYPE;
BEGIN
  PERFORM public.companion_api_require_access(p_org_id,p_companion_id,'editor');
  IF p_request_id IS NULL OR p_client_surface IS NULL THEN
    RAISE EXCEPTION 'invalid Runtime v3 Pi restart request' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.companion_v3_instances instance
    WHERE instance.org_id=p_org_id AND instance.companion_id=p_companion_id) THEN
    RETURN;
  END IF;

  SELECT * INTO v_enqueued FROM public.companion_api_enqueue_operation(
    p_org_id,p_companion_id,p_request_id,'restart_pi',p_client_surface
  );
  v_operation_id := (v_enqueued.operation->>'id')::uuid;
  IF v_enqueued.replayed THEN
    operation := v_enqueued.operation; replayed := true; RETURN NEXT; RETURN;
  END IF;

  SELECT instance.* INTO STRICT v_instance FROM public.companion_v3_instances instance
  WHERE instance.org_id=p_org_id AND instance.companion_id=p_companion_id FOR UPDATE;
  IF v_instance.pi_recycle_checkpoint IS NOT NULL THEN
    UPDATE public.companion_operations operation_row SET
      checkpoint='restarting_pi',checkpoint_sequence=1,available_at='infinity',
      updated_at=clock_timestamp()
    WHERE operation_row.org_id=p_org_id AND operation_row.companion_id=p_companion_id
      AND operation_row.id=v_operation_id AND operation_row.status='pending';
  ELSE
    UPDATE public.companion_operations operation_row SET
      status='running', checkpoint='restarting_pi', checkpoint_sequence=1,
      attempt_count=1, started_at=clock_timestamp(), updated_at=clock_timestamp()
    WHERE operation_row.org_id=p_org_id AND operation_row.companion_id=p_companion_id
      AND operation_row.id=v_operation_id AND operation_row.status='pending';
  END IF;

  IF v_instance.pi_recycle_checkpoint IS NULL AND v_instance.pi_invocation_id IS NOT NULL THEN
    SELECT turn_row.* INTO v_active FROM public.companion_v3_turns turn_row
    WHERE turn_row.org_id=p_org_id AND turn_row.companion_id=p_companion_id
      AND turn_row.lane='main' AND turn_row.state IN ('admitted','running','needs_input')
      AND turn_row.admission_state='accepted'
    ORDER BY turn_row.queue_sequence,turn_row.id LIMIT 1 FOR UPDATE;
    IF FOUND THEN
      INSERT INTO public.companion_deferred_pi_restarts(
        id,org_id,companion_id,source_turn_id,source_attempt_id,source_pi_invocation_id,
        actor_id,status,operation_id
      ) VALUES(
        p_request_id,p_org_id,p_companion_id,v_active.id,v_active.id,v_active.pi_invocation_id,
        v_actor,'pending',v_operation_id
      );
    ELSE
      PERFORM public.companion_v3_invalidate_preparation(p_org_id,p_companion_id);
      UPDATE public.companion_v3_instances instance SET
        desired_lifecycle_actor_id=v_actor,
        pi_recycle_checkpoint='terminate',
        recycle_pi_invocation_id=v_instance.pi_invocation_id,
        recovery_turn_id=v_operation_id,
        recovery_context=NULL,recovery_context_sha256=NULL,recovery_context_turn_id=NULL,
        preparation_checkpoint='box_ready',preparation_available_at=clock_timestamp(),
        updated_at=clock_timestamp()
      WHERE instance.org_id=p_org_id AND instance.companion_id=p_companion_id
        AND instance.pi_recycle_checkpoint IS NULL;
    END IF;
  ELSIF v_instance.pi_recycle_checkpoint IS NULL THEN
    UPDATE public.companion_operations operation_row SET
      status='succeeded',checkpoint='pi_ready',checkpoint_sequence=2,
      settled_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE operation_row.id=v_operation_id AND operation_row.org_id=p_org_id
      AND operation_row.companion_id=p_companion_id;
  END IF;

  operation := public.companion_api_operation_json(p_org_id,p_companion_id,v_operation_id);
  replayed := false;
  RETURN NEXT;
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_settle_manual_restart()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
BEGIN
  IF OLD.pi_recycle_checkpoint IS NOT NULL AND NEW.pi_recycle_checkpoint IS NULL THEN
    UPDATE public.companion_operations operation_row SET
      status='succeeded',checkpoint='pi_ready',checkpoint_sequence=2,
      settled_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE operation_row.org_id=NEW.org_id AND operation_row.companion_id=NEW.companion_id
      AND operation_row.kind='restart_pi' AND operation_row.trigger='user'
      AND operation_row.status IN ('running','pending')
      AND operation_row.checkpoint='restarting_pi';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

CREATE TRIGGER companion_v3_settle_manual_restart
AFTER UPDATE OF pi_recycle_checkpoint ON public.companion_v3_instances
FOR EACH ROW EXECUTE FUNCTION public.companion_v3_settle_manual_restart();
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_cancel_deferred_manual_restart()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
BEGIN
  IF OLD.status='pending' AND NEW.status='cancelled' AND NEW.operation_id IS NOT NULL THEN
    UPDATE public.companion_operations operation_row SET
      status='cancelled',checkpoint='completed',checkpoint_sequence=2,
      settled_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE operation_row.org_id=NEW.org_id AND operation_row.companion_id=NEW.companion_id
      AND operation_row.id=NEW.operation_id AND operation_row.status='running';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

CREATE TRIGGER companion_v3_cancel_deferred_manual_restart
AFTER UPDATE OF status ON public.companion_deferred_pi_restarts
FOR EACH ROW EXECUTE FUNCTION public.companion_v3_cancel_deferred_manual_restart();
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_v3_api_restart_pi(
  uuid,uuid,uuid,public.companion_client_surface
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.companion_v3_settle_manual_restart() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.companion_v3_cancel_deferred_manual_restart() FROM PUBLIC;
