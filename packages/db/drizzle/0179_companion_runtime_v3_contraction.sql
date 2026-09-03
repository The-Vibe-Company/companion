-- Runtime v3 contraction. Runtime v2 remains readable only by the offline purge command; normal
-- API/runtime roles lose every v2 mutation/claim capability before v3-only entry points are added.

CREATE FUNCTION public.companion_v3_api_enqueue_turn(
  p_org_id uuid,
  p_companion_id uuid,
  p_client_message_id uuid,
  p_content text,
  p_client_surface public.companion_client_surface,
  p_attachments jsonb DEFAULT '[]'::jsonb
)
RETURNS TABLE(turn jsonb, replayed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_result record;
  v_event_id text := 'msg:' || p_client_message_id::text;
  v_attachments jsonb := COALESCE(p_attachments, '[]'::jsonb);
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_client_surface IS NULL THEN
    RAISE EXCEPTION 'invalid Runtime v3 client surface' USING ERRCODE='22023';
  END IF;
  PERFORM public.companion_api_assert_message_attachments(
    p_org_id, p_companion_id, v_attachments
  );
  SELECT * INTO v_result FROM public.companion_v3_api_enqueue_warm_turn(
    p_org_id, p_companion_id, p_client_message_id, p_content
  );
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Companion has no Runtime v3 instance' USING ERRCODE='55000';
  END IF;
  IF v_result.replayed THEN
    IF public.companion_api_stored_attachment_intent(
      p_org_id, p_companion_id, v_event_id
    ) IS DISTINCT FROM public.companion_api_message_attachment_intent(v_attachments) THEN
      RAISE EXCEPTION 'client_message_id was reused with different message intent'
        USING ERRCODE='23505', CONSTRAINT='companion_v3_turns_client_message_uq';
    END IF;
  ELSE
    INSERT INTO public.companion_message_attachments(
      org_id, companion_id, entry_event_id, kind, storage_key,
      content_type, byte_size, sha256, filename, position, created_at
    )
    SELECT p_org_id, p_companion_id, v_event_id, 'user_upload',
      part.value ->> 'storage_key', part.value ->> 'content_type',
      (part.value ->> 'byte_size')::integer, part.value ->> 'sha256',
      part.value ->> 'filename', (part.ordinality - 1)::integer, v_now
    FROM jsonb_array_elements(v_attachments) WITH ORDINALITY AS part(value, ordinality);
  END IF;
  turn := v_result.turn;
  replayed := v_result.replayed;
  RETURN NEXT;
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_v3_api_enqueue_turn(
  uuid,uuid,uuid,text,public.companion_client_surface,jsonb
) FROM PUBLIC;
--> statement-breakpoint

-- Cancel is a v3 Turn mutation. Queued work terminalizes immediately; admitted work is consumed by
-- the existing fenced Pi-abort checkpoint. The old Retry path is intentionally not replaced.
CREATE FUNCTION public.companion_v3_api_cancel_turn(
  p_org_id uuid,p_companion_id uuid,p_turn_id uuid
) RETURNS TABLE(turn jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_turn public.companion_v3_turns%ROWTYPE;v_now timestamptz:=clock_timestamp();
BEGIN
  PERFORM public.companion_api_require_access(p_org_id,p_companion_id,'editor');
  PERFORM 1 FROM public.companion_v3_lane_leases lease
    WHERE lease.org_id=p_org_id AND lease.companion_id=p_companion_id
      AND lease.lane='main' FOR UPDATE;
  SELECT * INTO v_turn FROM public.companion_v3_turns turn_row
    WHERE turn_row.org_id=p_org_id AND turn_row.companion_id=p_companion_id
      AND turn_row.id=p_turn_id AND turn_row.lane='main' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Companion Turn not found' USING ERRCODE='P0002'; END IF;
  IF v_turn.state='queued' AND v_turn.admission_state='pending'
    AND v_turn.admission_started_at IS NULL THEN
    UPDATE public.companion_v3_turns turn_row SET state='cancelled',outcome='cancelled',
      outcome_code=NULL,outcome_message=NULL,outcome_action=NULL,
      inactivity_deadline_at=NULL,absolute_deadline_at=NULL,settled_at=v_now,updated_at=v_now
    WHERE turn_row.id=v_turn.id RETURNING * INTO v_turn;
    UPDATE public.companion_threads SET projection_sequence=projection_sequence+1,updated_at=v_now
      WHERE org_id=p_org_id AND companion_id=p_companion_id;
  ELSIF v_turn.state IN ('admitted','running','needs_input') THEN
    UPDATE public.companion_v3_turns turn_row SET
      delegation_cancel_requested_at=COALESCE(turn_row.delegation_cancel_requested_at,v_now),
      delegation_cancel_command_id=COALESCE(turn_row.delegation_cancel_command_id,gen_random_uuid()),
      updated_at=v_now
    WHERE turn_row.id=v_turn.id RETURNING * INTO v_turn;
  END IF;
  turn:=public.companion_v3_public_turn(v_turn);RETURN NEXT;
END $$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_v3_api_cancel_turn(uuid,uuid,uuid) FROM PUBLIC;
--> statement-breakpoint

-- Generalize the fenced cancel consumer from delegated target Turns to every ordinary main Turn.
CREATE OR REPLACE FUNCTION public.companion_v3_runtime_pending_delegation_cancel(
  p_org_id uuid,p_companion_id uuid,p_turn_id uuid,p_claim_token uuid,
  p_claim_epoch bigint,p_gate_epoch bigint,p_protocol integer
) RETURNS TABLE(turn_id uuid,response_turn_id uuid,command_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_now timestamptz:=clock_timestamp();
BEGIN
  IF p_protocol<>7 THEN RAISE EXCEPTION 'Runtime v3 protocol 7 is required' USING ERRCODE='42501'; END IF;
  RETURN QUERY
  SELECT candidate.id,root_turn.id,candidate.delegation_cancel_command_id
  FROM public.companion_v3_lane_leases lease
  JOIN public.companion_runtime_control control ON control.id='runtime-v2'
    AND control.enabled AND control.gate_epoch=p_gate_epoch
  JOIN public.companion_v3_turns claimed_turn ON claimed_turn.org_id=lease.org_id
    AND claimed_turn.companion_id=lease.companion_id AND claimed_turn.id=lease.turn_id
    AND claimed_turn.lane='main' AND claimed_turn.admission_state='accepted'
    AND claimed_turn.state IN ('admitted','running','needs_input')
  JOIN public.companion_v3_turns root_turn ON root_turn.org_id=claimed_turn.org_id
    AND root_turn.companion_id=claimed_turn.companion_id
    AND root_turn.id=COALESCE(claimed_turn.response_turn_id,claimed_turn.id)
    AND root_turn.lane='main' AND root_turn.admission_state='accepted'
    AND root_turn.state IN ('admitted','running','needs_input')
    AND root_turn.response_turn_id=root_turn.id
  JOIN public.companion_v3_turns candidate ON candidate.org_id=root_turn.org_id
    AND candidate.companion_id=root_turn.companion_id AND candidate.lane='main'
    AND candidate.admission_state='accepted'
    AND candidate.state IN ('admitted','running','needs_input')
    AND (candidate.id=root_turn.id OR candidate.response_turn_id=root_turn.id)
    AND candidate.delegation_cancel_requested_at IS NOT NULL
    AND candidate.delegation_cancel_command_id IS NOT NULL
  WHERE lease.org_id=p_org_id AND lease.companion_id=p_companion_id AND lease.lane='main'
    AND lease.turn_id=p_turn_id AND lease.claim_token=p_claim_token
    AND lease.claim_epoch=p_claim_epoch AND lease.gate_epoch=p_gate_epoch
    AND lease.expires_at>v_now
  ORDER BY candidate.delegation_cancel_requested_at,candidate.id LIMIT 1;
END $$;
--> statement-breakpoint

-- Copy API execute capability from the v3 send entry point without naming deployment roles.
DO $runtime_v3_contraction_api_acl$
DECLARE v_source oid:=pg_catalog.to_regprocedure(
  'public.companion_v3_api_enqueue_warm_turn(uuid,uuid,uuid,text)');v_grantee oid;v_role name;
BEGIN
  FOR v_grantee IN SELECT DISTINCT acl.grantee FROM pg_catalog.pg_proc source_proc
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(source_proc.proacl,pg_catalog.acldefault('f',source_proc.proowner))) acl
    WHERE source_proc.oid=v_source AND acl.privilege_type='EXECUTE'
      AND acl.grantee<>source_proc.proowner
  LOOP
    SELECT rolname INTO v_role FROM pg_catalog.pg_roles WHERE oid=v_grantee;
    IF v_role IS NOT NULL THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_v3_api_enqueue_turn(uuid,uuid,uuid,text,public.companion_client_surface,jsonb) TO %I',v_role);
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_v3_api_cancel_turn(uuid,uuid,uuid) TO %I',v_role);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.companion_api_enqueue_turn(uuid,uuid,uuid,text,public.companion_client_surface,jsonb,uuid,text,uuid,text) FROM %I',v_role);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.companion_api_retry_turn(uuid,uuid,uuid,uuid,public.companion_client_surface) FROM %I',v_role);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.companion_api_cancel_turn(uuid,uuid,uuid) FROM %I',v_role);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.companion_api_enqueue_operation(uuid,uuid,uuid,public.companion_operation_kind,public.companion_client_surface) FROM %I',v_role);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.companion_v3_api_restart_pi(uuid,uuid,uuid,public.companion_client_surface) FROM %I',v_role);
    END IF;
  END LOOP;
END $runtime_v3_contraction_api_acl$;
--> statement-breakpoint

-- 0178's client bridge wrote a Runtime v2 operation. The public restart route now records the
-- native recycle_pi lifecycle desire, so keep no callable bridge in the contracted schema.
DROP FUNCTION public.companion_v3_api_restart_pi(
  uuid,uuid,uuid,public.companion_client_surface
);
--> statement-breakpoint
