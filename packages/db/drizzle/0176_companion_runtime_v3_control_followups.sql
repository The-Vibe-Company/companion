-- THE-525: applied control approvals and deferred Pi restarts remain Runtime v3 facts even when
-- preparation invalidation races the source Turn's terminal settlement.
ALTER TABLE public.companion_deferred_pi_restarts
  ADD COLUMN source_pi_invocation_id text;
UPDATE public.companion_deferred_pi_restarts restart
SET source_pi_invocation_id=turn_row.pi_invocation_id
FROM public.companion_v3_turns turn_row
WHERE turn_row.org_id=restart.org_id AND turn_row.companion_id=restart.companion_id
  AND turn_row.id=restart.source_turn_id;
ALTER TABLE public.companion_deferred_pi_restarts
  ALTER COLUMN source_pi_invocation_id SET NOT NULL;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.companion_api_enqueue_control_continuation(
  p_org_id uuid,p_companion_id uuid,p_id uuid,p_content text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_request public.companion_control_requests%ROWTYPE; v_enqueued record;
BEGIN
  PERFORM public.companion_api_require_access(p_org_id,p_companion_id,'editor');
  SELECT * INTO v_request FROM public.companion_control_requests request
  WHERE request.org_id=p_org_id AND request.companion_id=p_companion_id
    AND request.id=p_id FOR UPDATE;
  IF NOT FOUND OR v_request.status<>'applied' THEN
    RAISE EXCEPTION 'control request is not applied' USING ERRCODE='55000';
  END IF;
  IF v_request.continuation_turn_id IS NOT NULL THEN
    RETURN (SELECT public.companion_v3_public_turn(turn_row)
      FROM public.companion_v3_turns turn_row
      WHERE turn_row.org_id=p_org_id AND turn_row.companion_id=p_companion_id
        AND turn_row.id=v_request.continuation_turn_id);
  END IF;
  SELECT * INTO v_enqueued FROM public.companion_v3_api_enqueue_warm_turn(
    p_org_id,p_companion_id,v_request.id,p_content
  );
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Runtime v3 continuation Turn is unavailable' USING ERRCODE='55000';
  END IF;
  UPDATE public.companion_control_requests request SET
    continuation_turn_id=(v_enqueued.turn->>'id')::uuid,updated_at=clock_timestamp()
  WHERE request.org_id=p_org_id AND request.companion_id=p_companion_id AND request.id=p_id;
  RETURN v_enqueued.turn;
END $$;
REVOKE ALL ON FUNCTION public.companion_api_enqueue_control_continuation(uuid,uuid,uuid,text) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.companion_api_schedule_pi_restart(
  p_org_id uuid,p_companion_id uuid,p_id uuid,p_turn_id uuid,p_attempt_id uuid
)
RETURNS TABLE(id uuid,status text,source_turn_id uuid,operation_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE
  v_actor text:=public.companion_api_actor(p_org_id);
  v_pi_invocation_id text;
BEGIN
  PERFORM public.companion_api_require_access(p_org_id,p_companion_id,'editor');
  SELECT turn_row.pi_invocation_id INTO v_pi_invocation_id
  FROM public.companion_v3_turns turn_row
  JOIN public.companion_v3_instances instance
    ON instance.org_id=turn_row.org_id AND instance.companion_id=turn_row.companion_id
    AND instance.lifecycle_state='active' AND instance.desired_lifecycle='prepare'
    AND instance.pi_invocation_id=turn_row.pi_invocation_id
  WHERE turn_row.org_id=p_org_id AND turn_row.companion_id=p_companion_id
    AND turn_row.id=p_turn_id AND p_attempt_id=p_turn_id
    AND turn_row.actor_id=v_actor AND turn_row.lane='main'
    AND turn_row.response_turn_id=turn_row.id
    AND turn_row.state IN ('admitted','running','needs_input')
    AND turn_row.admission_state='accepted'
  FOR UPDATE OF turn_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'control Turn is not active' USING ERRCODE='42501';
  END IF;
  INSERT INTO public.companion_deferred_pi_restarts(
    id,org_id,companion_id,source_turn_id,source_attempt_id,source_pi_invocation_id,actor_id
  ) VALUES(
    p_id,p_org_id,p_companion_id,p_turn_id,p_attempt_id,v_pi_invocation_id,v_actor
  ) ON CONFLICT ON CONSTRAINT companion_deferred_pi_restarts_pkey DO NOTHING;
  RETURN QUERY SELECT restart.id,restart.status,restart.source_turn_id,restart.operation_id
  FROM public.companion_deferred_pi_restarts restart
  WHERE restart.id=p_id AND restart.org_id=p_org_id
    AND restart.companion_id=p_companion_id AND restart.source_turn_id=p_turn_id
    AND restart.source_attempt_id=p_attempt_id AND restart.actor_id=v_actor;
END $$;
REVOKE ALL ON FUNCTION public.companion_api_schedule_pi_restart(uuid,uuid,uuid,uuid,uuid) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.companion_enqueue_deferred_pi_restart()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE
  v_restart record;
  v_instance public.companion_v3_instances%ROWTYPE;
  v_enqueued boolean;
BEGIN
  IF NEW.state NOT IN ('succeeded','failed','interrupted','cancelled')
    OR OLD.state=NEW.state THEN RETURN NEW; END IF;
  FOR v_restart IN SELECT * FROM public.companion_deferred_pi_restarts restart
    WHERE restart.org_id=NEW.org_id AND restart.companion_id=NEW.companion_id
      AND restart.source_turn_id=NEW.id AND restart.source_attempt_id=NEW.id
      AND restart.status='pending' FOR UPDATE
  LOOP
    v_enqueued:=false;
    SELECT instance.* INTO v_instance FROM public.companion_v3_instances instance
    WHERE instance.org_id=NEW.org_id AND instance.companion_id=NEW.companion_id
      AND instance.lifecycle_state='active' AND instance.desired_lifecycle='prepare'
      AND instance.box_id IS NOT NULL
      AND (instance.pi_invocation_id=v_restart.source_pi_invocation_id
        OR instance.pi_invocation_id IS NULL)
    FOR UPDATE;
    IF FOUND AND v_instance.pi_recycle_checkpoint IS NULL THEN
      PERFORM public.companion_v3_invalidate_preparation(NEW.org_id,NEW.companion_id);
      UPDATE public.companion_v3_instances instance SET
        desired_lifecycle_actor_id=v_restart.actor_id,
        pi_recycle_checkpoint='terminate',
        recycle_pi_invocation_id=v_restart.source_pi_invocation_id,
        recovery_turn_id=NEW.id,
        recovery_context=NULL,recovery_context_sha256=NULL,recovery_context_turn_id=NULL,
        preparation_checkpoint='box_ready',preparation_available_at=clock_timestamp(),
        updated_at=clock_timestamp()
      WHERE instance.org_id=NEW.org_id AND instance.companion_id=NEW.companion_id
        AND instance.lifecycle_state='active' AND instance.desired_lifecycle='prepare'
        AND instance.box_id IS NOT NULL AND instance.pi_recycle_checkpoint IS NULL
        AND (instance.pi_invocation_id=v_restart.source_pi_invocation_id
          OR instance.pi_invocation_id IS NULL);
      v_enqueued:=FOUND;
    ELSIF FOUND
      AND v_instance.recycle_pi_invocation_id=v_restart.source_pi_invocation_id THEN
      v_enqueued:=true;
    END IF;
    UPDATE public.companion_deferred_pi_restarts restart SET
      status=CASE WHEN v_enqueued THEN 'enqueued' ELSE 'cancelled' END,
      enqueued_at=CASE WHEN v_enqueued THEN clock_timestamp() ELSE restart.enqueued_at END
    WHERE restart.org_id=v_restart.org_id AND restart.companion_id=v_restart.companion_id
      AND restart.id=v_restart.id AND restart.status='pending';
  END LOOP;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.companion_enqueue_deferred_pi_restart() FROM PUBLIC;
--> statement-breakpoint
