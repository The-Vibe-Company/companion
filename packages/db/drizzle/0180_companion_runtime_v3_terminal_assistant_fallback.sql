-- Retain only redacted, bounded assistant candidates from Pi's documented terminal envelopes.
-- They are promoted by the existing main/background page projector only after agent_settled, and
-- only when no primary message_end result has already been projected for the Turn.
ALTER TABLE public.companion_v3_turns
  ADD COLUMN terminal_assistant_fallback_source text,
  ADD COLUMN terminal_assistant_fallback_cursor bigint,
  ADD COLUMN terminal_assistant_fallback_content text,
  ADD COLUMN terminal_assistant_fallback_admitted_at timestamptz;
--> statement-breakpoint

ALTER TABLE public.companion_v3_turns
  ADD CONSTRAINT companion_v3_turns_terminal_assistant_fallback_check CHECK (
    (
      terminal_assistant_fallback_source IS NULL
      AND terminal_assistant_fallback_cursor IS NULL
      AND terminal_assistant_fallback_content IS NULL
      AND terminal_assistant_fallback_admitted_at IS NULL
    ) OR (
      terminal_assistant_fallback_source IS NOT NULL
      AND terminal_assistant_fallback_cursor IS NOT NULL
      AND terminal_assistant_fallback_content IS NOT NULL
      AND terminal_assistant_fallback_admitted_at IS NOT NULL
      AND terminal_assistant_fallback_source IN ('turn_end', 'agent_end')
      AND terminal_assistant_fallback_cursor >= 0
      AND char_length(terminal_assistant_fallback_content) BETWEEN 1 AND 100000
    )
  );
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_runtime_record_native_fallback_v8(
  p_org_id uuid,p_companion_id uuid,p_lane public.companion_v3_lane,p_turn_id uuid,
  p_claim_token uuid,p_claim_epoch bigint,p_gate_epoch bigint,p_fallbacks jsonb,p_protocol integer
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE
  v_now timestamptz:=clock_timestamp();v_item jsonb;v_source text;v_cursor bigint;v_content text;
  v_current_source text;v_current_cursor bigint;v_current_content text;
  v_candidate_admitted_at timestamptz;v_turn_admitted_at timestamptz;
BEGIN
  IF p_protocol IS DISTINCT FROM 8 OR jsonb_typeof(p_fallbacks) IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_fallbacks)>2 THEN
    RAISE EXCEPTION 'Runtime v3 terminal fallback protocol 8 is required' USING ERRCODE='42501';
  END IF;
  SELECT turn_row.terminal_assistant_fallback_source,
    turn_row.terminal_assistant_fallback_cursor,
    turn_row.terminal_assistant_fallback_content,
    turn_row.terminal_assistant_fallback_admitted_at,turn_row.admitted_at
  INTO v_current_source,v_current_cursor,v_current_content,
    v_candidate_admitted_at,v_turn_admitted_at
  FROM public.companion_v3_lane_leases lease
  JOIN public.companion_runtime_control control ON control.id='runtime-v3'
    AND control.enabled AND control.gate_epoch=p_gate_epoch
  JOIN public.companion_v3_turns turn_row ON turn_row.org_id=lease.org_id
    AND turn_row.companion_id=lease.companion_id AND turn_row.id=lease.turn_id
    AND turn_row.lane=p_lane AND turn_row.admission_state='accepted'
    AND turn_row.state IN ('admitted','running','needs_input')
  WHERE lease.org_id=p_org_id AND lease.companion_id=p_companion_id
    AND lease.lane=p_lane AND lease.turn_id=p_turn_id
    AND lease.claim_token=p_claim_token AND lease.claim_epoch=p_claim_epoch
    AND lease.gate_epoch=p_gate_epoch AND lease.expires_at>v_now
  FOR UPDATE OF lease,turn_row;
  IF NOT FOUND THEN RETURN false;END IF;
  IF v_candidate_admitted_at IS DISTINCT FROM v_turn_admitted_at THEN
    v_current_source:=NULL;v_current_cursor:=NULL;v_current_content:=NULL;
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_fallbacks) LOOP
    v_source:=v_item->>'source';v_content:=v_item->>'content';
    IF jsonb_typeof(v_item) IS DISTINCT FROM 'object' OR v_source IS NULL
      OR v_source NOT IN ('turn_end','agent_end')
      OR coalesce(v_item->>'sequence','')!~'^[0-9]{1,16}$'
      OR char_length(coalesce(v_content,'')) NOT BETWEEN 1 AND 100000 THEN
      RAISE EXCEPTION 'invalid Runtime v3 terminal assistant fallback' USING ERRCODE='22023';
    END IF;
    v_cursor:=(v_item->>'sequence')::bigint;
    IF v_current_cursor=v_cursor AND (
      v_current_source IS DISTINCT FROM v_source OR v_current_content IS DISTINCT FROM v_content
    ) THEN
      RAISE EXCEPTION 'Runtime v3 terminal assistant fallback conflict' USING ERRCODE='23505';
    END IF;
    IF v_current_source IS NULL
      OR (v_source='turn_end' AND v_current_source='agent_end')
      OR (v_source=v_current_source AND v_cursor>v_current_cursor) THEN
      UPDATE public.companion_v3_turns turn_row SET
        terminal_assistant_fallback_source=v_source,
        terminal_assistant_fallback_cursor=v_cursor,
        terminal_assistant_fallback_content=v_content,
        terminal_assistant_fallback_admitted_at=v_turn_admitted_at,
        updated_at=v_now
      WHERE turn_row.org_id=p_org_id AND turn_row.companion_id=p_companion_id
        AND turn_row.id=p_turn_id;
      v_current_source:=v_source;v_current_cursor:=v_cursor;v_current_content:=v_content;
    END IF;
  END LOOP;
  RETURN true;
END $$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_v3_runtime_record_native_fallback_v8(
  uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,jsonb,integer
) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_runtime_read_native_fallback_v8(
  p_org_id uuid,p_companion_id uuid,p_lane public.companion_v3_lane,p_turn_id uuid,
  p_claim_token uuid,p_claim_epoch bigint,p_gate_epoch bigint,p_protocol integer
) RETURNS TABLE(sequence bigint,content text) LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_now timestamptz:=clock_timestamp();
BEGIN
  IF p_protocol IS DISTINCT FROM 8 THEN
    RAISE EXCEPTION 'Runtime v3 terminal fallback protocol 8 is required' USING ERRCODE='42501';
  END IF;
  RETURN QUERY
  SELECT turn_row.terminal_assistant_fallback_cursor,
    turn_row.terminal_assistant_fallback_content
  FROM public.companion_v3_lane_leases lease
  JOIN public.companion_runtime_control control ON control.id='runtime-v3'
    AND control.enabled AND control.gate_epoch=p_gate_epoch
  JOIN public.companion_v3_turns turn_row ON turn_row.org_id=lease.org_id
    AND turn_row.companion_id=lease.companion_id AND turn_row.id=lease.turn_id
    AND turn_row.lane=p_lane AND turn_row.admission_state='accepted'
    AND turn_row.state IN ('admitted','running','needs_input')
  WHERE lease.org_id=p_org_id AND lease.companion_id=p_companion_id
    AND lease.lane=p_lane AND lease.turn_id=p_turn_id
    AND lease.claim_token=p_claim_token AND lease.claim_epoch=p_claim_epoch
    AND lease.gate_epoch=p_gate_epoch AND lease.expires_at>v_now
    AND turn_row.terminal_assistant_fallback_source IS NOT NULL
    AND turn_row.terminal_assistant_fallback_admitted_at=turn_row.admitted_at
    AND (
      p_lane='main' AND NOT EXISTS (
        SELECT 1 FROM public.companion_transcript_entries entry
        WHERE entry.org_id=p_org_id AND entry.companion_id=p_companion_id
          AND entry.role='assistant'
          AND entry.event_id LIKE 'v3:'||p_turn_id::text||':%'
      )
      OR p_lane='background' AND NOT EXISTS (
        SELECT 1 FROM public.companion_v3_routine_run_entries entry
        WHERE entry.org_id=p_org_id AND entry.companion_id=p_companion_id
          AND entry.run_id=p_turn_id AND entry.role='assistant'
      )
    );
END $$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_v3_runtime_read_native_fallback_v8(
  uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,integer
) FROM PUBLIC;
