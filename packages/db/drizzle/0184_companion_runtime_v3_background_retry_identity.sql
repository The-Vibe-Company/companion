-- A safely rejected background Pi start is terminated before the Turn is requeued. Termination
-- leaves an exact-invocation cancellation tombstone on the Box so an ambiguous or cancelled
-- command can never be resurrected. Reusing the original invocation across a proven-safe retry
-- therefore makes every later start reject itself. Keep the first identity transcript-compatible,
-- and derive a fresh identity only after PostgreSQL increments the durable retry counter.
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
    'background:'||p_turn_id::text||':dispatch-v3:'||turn_row.command_id::text
      ||CASE WHEN turn_row.retry_count>0 THEN ':retry-'||turn_row.retry_count::text ELSE '' END,
    CASE WHEN v_context IS NULL OR v_reserved_turn_id IS DISTINCT FROM p_turn_id
      THEN v_material.content
      ELSE v_context||E'\n\n[Scheduled work]\n'||v_material.content END,
    v_material.activity_cursor,v_material.persona,v_material.validation_only,
    v_material.direct_workspace,
    v_context IS NOT NULL AND v_reserved_turn_id IS DISTINCT FROM p_turn_id,v_harvested
  FROM public.companion_v3_turns turn_row
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
  IF p_protocol<>9 OR p_cursor<0 OR p_invocation_id IS DISTINCT FROM
    'background:'||p_turn_id::text||':dispatch-v3:'||(
      SELECT command_id::text
        ||CASE WHEN retry_count>0 THEN ':retry-'||retry_count::text ELSE '' END
      FROM public.companion_v3_turns
      WHERE org_id=p_org_id AND companion_id=p_companion_id AND id=p_turn_id)
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
