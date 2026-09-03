-- THE-525: Companion-initiated Pi restart is deferred against the accepted Runtime v3 main Turn.
-- The terminal Turn only schedules the existing Pi-recycle preparation checkpoint; it never
-- creates a Runtime v2 operation or requests a full Box restart.
ALTER TABLE public.companion_deferred_pi_restarts
  DROP CONSTRAINT companion_deferred_pi_restarts_attempt_fk,
  DROP CONSTRAINT companion_deferred_pi_restarts_turn_fk,
  ALTER COLUMN client_surface DROP NOT NULL,
  ADD CONSTRAINT companion_deferred_pi_restarts_v3_turn_fk
    FOREIGN KEY (org_id, companion_id, source_turn_id)
    REFERENCES public.companion_v3_turns(org_id, companion_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT companion_deferred_pi_restarts_v3_identity_check
    CHECK (source_attempt_id = source_turn_id);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.companion_api_schedule_pi_restart(
  p_org_id uuid,p_companion_id uuid,p_id uuid,p_turn_id uuid,p_attempt_id uuid
)
RETURNS TABLE(id uuid,status text,source_turn_id uuid,operation_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_actor text:=public.companion_api_actor(p_org_id);
BEGIN
  PERFORM public.companion_api_require_access(p_org_id,p_companion_id,'editor');
  PERFORM 1 FROM public.companion_v3_turns turn_row
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
    id,org_id,companion_id,source_turn_id,source_attempt_id,actor_id
  ) VALUES(p_id,p_org_id,p_companion_id,p_turn_id,p_attempt_id,v_actor)
  ON CONFLICT ON CONSTRAINT companion_deferred_pi_restarts_pkey DO NOTHING;
  RETURN QUERY SELECT restart.id,restart.status,restart.source_turn_id,restart.operation_id
  FROM public.companion_deferred_pi_restarts restart
  WHERE restart.id=p_id AND restart.org_id=p_org_id
    AND restart.companion_id=p_companion_id AND restart.source_turn_id=p_turn_id
    AND restart.source_attempt_id=p_attempt_id AND restart.actor_id=v_actor;
END $$;
REVOKE ALL ON FUNCTION public.companion_api_schedule_pi_restart(uuid,uuid,uuid,uuid,uuid) FROM PUBLIC;
--> statement-breakpoint

DROP TRIGGER companion_turns_enqueue_deferred_pi_restart ON public.companion_turns;
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
      AND instance.pi_invocation_id=NEW.pi_invocation_id
    FOR UPDATE;
    IF FOUND AND v_instance.pi_recycle_checkpoint IS NULL THEN
      PERFORM public.companion_v3_invalidate_preparation(NEW.org_id,NEW.companion_id);
      UPDATE public.companion_v3_instances instance SET
        desired_lifecycle_actor_id=v_restart.actor_id,
        pi_recycle_checkpoint='terminate',
        recycle_pi_invocation_id=NEW.pi_invocation_id,
        recovery_turn_id=NEW.id,
        recovery_context=NULL,recovery_context_sha256=NULL,recovery_context_turn_id=NULL,
        preparation_checkpoint='box_ready',preparation_available_at=clock_timestamp(),
        updated_at=clock_timestamp()
      WHERE instance.org_id=NEW.org_id AND instance.companion_id=NEW.companion_id
        AND instance.lifecycle_state='active' AND instance.desired_lifecycle='prepare'
        AND instance.box_id IS NOT NULL AND instance.pi_recycle_checkpoint IS NULL;
      v_enqueued:=FOUND;
    ELSIF FOUND
      AND v_instance.recycle_pi_invocation_id=NEW.pi_invocation_id THEN
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

CREATE TRIGGER companion_v3_turns_enqueue_deferred_pi_restart
AFTER UPDATE OF state ON public.companion_v3_turns FOR EACH ROW
EXECUTE FUNCTION public.companion_enqueue_deferred_pi_restart();
--> statement-breakpoint
