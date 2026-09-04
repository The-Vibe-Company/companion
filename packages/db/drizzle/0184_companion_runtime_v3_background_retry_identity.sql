-- A routine start that is proven rejected is terminated before its Turn is requeued. Termination
-- leaves an exact-invocation cancellation tombstone on the Box so a cancelled command can never
-- be resurrected. Persist a separate generation only after that cleanup completes; ordinary
-- provider retries and claim takeovers must not change the Pi identity.
ALTER TABLE public.companion_v3_routine_runs
  ADD COLUMN pi_invocation_generation integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT companion_v3_routine_runs_invocation_generation_check
    CHECK (pi_invocation_generation >= 0);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.companion_v3_runtime_authorize_background_v9(
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
    COALESCE(turn_row.pi_invocation_id,
      'background:'||p_turn_id::text||':dispatch-v3:'||turn_row.command_id::text
        ||CASE WHEN run.pi_invocation_generation>0
          THEN ':retry-'||run.pi_invocation_generation::text ELSE '' END),
    CASE WHEN v_context IS NULL OR v_reserved_turn_id IS DISTINCT FROM p_turn_id
      THEN v_material.content
      ELSE v_context||E'\n\n[Scheduled work]\n'||v_material.content END,
    v_material.activity_cursor,v_material.persona,v_material.validation_only,
    v_material.direct_workspace,
    v_context IS NOT NULL AND v_reserved_turn_id IS DISTINCT FROM p_turn_id,v_harvested
  FROM public.companion_v3_turns turn_row
  JOIN public.companion_v3_routine_runs run ON run.org_id=turn_row.org_id
    AND run.companion_id=turn_row.companion_id AND run.turn_id=turn_row.id
  WHERE turn_row.org_id=p_org_id AND turn_row.companion_id=p_companion_id
    AND turn_row.id=p_turn_id;
END $$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_v3_runtime_authorize_background_v9(
  uuid,uuid,uuid,uuid,bigint,bigint,integer
) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.companion_v3_runtime_begin_background_admission_v9(
  p_org_id uuid,p_companion_id uuid,p_turn_id uuid,p_claim_token uuid,p_claim_epoch bigint,
  p_gate_epoch bigint,p_invocation_id text,p_cursor bigint,p_protocol integer
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_now timestamptz:=clock_timestamp();
BEGIN
  IF p_protocol<>9 OR p_cursor<0 OR p_invocation_id IS DISTINCT FROM (
    SELECT 'background:'||turn_row.id::text||':dispatch-v3:'||turn_row.command_id::text
      ||CASE WHEN run.pi_invocation_generation>0
        THEN ':retry-'||run.pi_invocation_generation::text ELSE '' END
    FROM public.companion_v3_turns turn_row
    JOIN public.companion_v3_routine_runs run ON run.org_id=turn_row.org_id
      AND run.companion_id=turn_row.companion_id AND run.turn_id=turn_row.id
    WHERE turn_row.org_id=p_org_id AND turn_row.companion_id=p_companion_id
      AND turn_row.id=p_turn_id)
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

-- v7 performs the exact-invocation termination checkpoint and requeue. Advance the identity only
-- after that state transition is durably complete; terminal cleanup and ordinary lease release do
-- not change it.
CREATE OR REPLACE FUNCTION public.companion_v3_runtime_complete_v8(
  p_org_id uuid,p_companion_id uuid,p_lane public.companion_v3_lane,p_turn_id uuid,
  p_claim_token uuid,p_claim_epoch bigint,p_gate_epoch bigint,p_outcome text,p_code text,
  p_message text,p_action public.companion_runtime_error_action,p_protocol integer
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_now timestamptz:=clock_timestamp();v_completed boolean;v_deadline timestamptz;
  v_trigger boolean;v_requeued boolean;v_retry_count integer;v_rotate_identity boolean:=false;
  v_forbid_trigger_replay boolean:=false;
BEGIN
  IF p_protocol<>8 THEN RAISE EXCEPTION 'Runtime v3 protocol 8 is required' USING ERRCODE='42501';END IF;
  IF p_lane='background' AND p_outcome='cleanup_completed' THEN
    SELECT turn_row.outcome_code='routine_start_failed' AND run.cleanup_retry,
      run.trigger_snapshot_id IS NOT NULL AND turn_row.outcome_code='trigger_validation_invalid'
      INTO v_rotate_identity,v_forbid_trigger_replay
    FROM public.companion_v3_lane_leases lease
    JOIN public.companion_v3_turns turn_row ON turn_row.org_id=lease.org_id
      AND turn_row.companion_id=lease.companion_id AND turn_row.id=lease.turn_id
    JOIN public.companion_v3_routine_runs run ON run.org_id=lease.org_id
      AND run.companion_id=lease.companion_id AND run.turn_id=lease.turn_id
    WHERE lease.org_id=p_org_id AND lease.companion_id=p_companion_id
      AND lease.lane='background' AND lease.turn_id=p_turn_id
      AND lease.claim_token=p_claim_token AND lease.claim_epoch=p_claim_epoch
      AND lease.gate_epoch=p_gate_epoch AND lease.expires_at>v_now
    FOR UPDATE OF lease,turn_row,run;
  END IF;
  v_completed:=public.companion_v3_runtime_complete_v7(p_org_id,p_companion_id,p_lane,p_turn_id,
    p_claim_token,p_claim_epoch,p_gate_epoch,p_outcome,p_code,p_message,p_action,7);
  IF NOT v_completed OR p_lane<>'background' OR p_outcome<>'cleanup_completed' THEN
    RETURN v_completed;END IF;
  SELECT run.trigger_snapshot_id IS NOT NULL,run.trigger_retry_deadline_at,
    turn_row.state='queued' AND run.outcome='pending',turn_row.retry_count
    INTO v_trigger,v_deadline,v_requeued,v_retry_count
  FROM public.companion_v3_routine_runs run
  JOIN public.companion_v3_turns turn_row ON turn_row.org_id=run.org_id
    AND turn_row.companion_id=run.companion_id AND turn_row.id=run.turn_id
  WHERE run.org_id=p_org_id AND run.companion_id=p_companion_id AND run.turn_id=p_turn_id
  FOR UPDATE OF run,turn_row;
  IF v_requeued AND v_forbid_trigger_replay THEN
    -- Validation happens only after Pi accepted this occurrence. The v7 compatibility path used
    -- to requeue malformed validation output, but the exact invocation is now tombstoned by
    -- cleanup and a fresh identity would replay an accepted prompt. Fail this occurrence visibly;
    -- the trigger remains enabled and later webhook occurrences remain independent.
    UPDATE public.companion_v3_turns SET state='failed',outcome='failed',
      outcome_code='trigger_validation_invalid',
      outcome_message='Trigger validation returned an unsupported action.',
      outcome_action='none',settled_at=v_now,available_at=v_now,updated_at=v_now
      WHERE org_id=p_org_id AND companion_id=p_companion_id AND id=p_turn_id;
    UPDATE public.companion_v3_routine_runs SET outcome='failed',settled_at=v_now
      WHERE org_id=p_org_id AND companion_id=p_companion_id AND turn_id=p_turn_id;
    v_requeued:=false;
  END IF;
  IF v_requeued AND v_rotate_identity THEN
    UPDATE public.companion_v3_routine_runs
    SET pi_invocation_generation=pi_invocation_generation+1
    WHERE org_id=p_org_id AND companion_id=p_companion_id AND turn_id=p_turn_id;
  END IF;
  IF v_trigger AND v_requeued THEN
    IF v_deadline<=v_now OR v_retry_count>5 THEN
      UPDATE public.companion_v3_turns SET state='failed',outcome='failed',
        outcome_code='trigger_retry_deadline_exceeded',
        outcome_message='Trigger validation could not complete before its retry deadline.',
        outcome_action='none',settled_at=v_now,available_at=v_now,updated_at=v_now
        WHERE org_id=p_org_id AND companion_id=p_companion_id AND id=p_turn_id;
      UPDATE public.companion_v3_routine_runs SET outcome='failed',settled_at=v_now
        WHERE org_id=p_org_id AND companion_id=p_companion_id AND turn_id=p_turn_id;
    ELSE
      UPDATE public.companion_v3_turns SET available_at=LEAST(available_at,v_deadline),updated_at=v_now
        WHERE org_id=p_org_id AND companion_id=p_companion_id AND id=p_turn_id;
    END IF;
  END IF;
  RETURN true;
END $$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_v3_runtime_complete_v8(
  uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,text,text,text,
  public.companion_runtime_error_action,integer
) FROM PUBLIC;
