-- Retain only redacted, bounded assistant candidates from Pi's documented terminal envelopes.
-- They are promoted by the existing main/background page projector only after agent_settled, and
-- only when no primary message_end result has already been projected for the Turn.
ALTER TABLE public.companion_v3_turns
  ADD COLUMN terminal_assistant_fallback_source text,
  ADD COLUMN terminal_assistant_fallback_cursor bigint,
  ADD COLUMN terminal_assistant_fallback_content text,
  ADD COLUMN terminal_assistant_fallback_admitted_at timestamptz,
  ADD COLUMN terminal_model_error_cursor bigint,
  ADD COLUMN terminal_model_error_admitted_at timestamptz;
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

ALTER TABLE public.companion_v3_turns
  ADD CONSTRAINT companion_v3_turns_terminal_model_error_check CHECK (
    (terminal_model_error_cursor IS NULL AND terminal_model_error_admitted_at IS NULL)
    OR (terminal_model_error_cursor IS NOT NULL AND terminal_model_error_cursor >= 0
      AND terminal_model_error_admitted_at IS NOT NULL)
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
--> statement-breakpoint

-- Record only the existence and cursor of a product-classified terminal model failure. The raw
-- provider error is deliberately absent from both the function contract and durable storage.
CREATE FUNCTION public.companion_v3_runtime_record_terminal_model_error_v9(
  p_org_id uuid,p_companion_id uuid,p_lane public.companion_v3_lane,p_turn_id uuid,
  p_claim_token uuid,p_claim_epoch bigint,p_gate_epoch bigint,p_error jsonb,p_protocol integer
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_now timestamptz:=clock_timestamp();v_cursor bigint;v_admitted_at timestamptz;
BEGIN
  IF p_protocol IS DISTINCT FROM 9 OR jsonb_typeof(p_error) IS DISTINCT FROM 'object'
    OR coalesce(p_error->>'sequence','')!~'^[0-9]{1,16}$'
    OR p_error->>'code' IS DISTINCT FROM 'model_unavailable'
    OR p_error->>'message' IS DISTINCT FROM
      'The selected model is unavailable. Choose a different model and try again.'
    OR p_error->>'action' IS DISTINCT FROM 'switch_model'
    OR p_error - ARRAY['sequence','code','message','action'] <> '{}'::jsonb THEN
    RAISE EXCEPTION 'invalid Runtime v3 terminal model error' USING ERRCODE='22023';
  END IF;
  v_cursor:=(p_error->>'sequence')::bigint;
  SELECT turn_row.admitted_at INTO v_admitted_at
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
  UPDATE public.companion_v3_turns turn_row SET
    terminal_model_error_cursor=CASE
      WHEN turn_row.terminal_model_error_admitted_at IS DISTINCT FROM v_admitted_at
        OR turn_row.terminal_model_error_cursor IS NULL
        OR v_cursor>turn_row.terminal_model_error_cursor THEN v_cursor
      ELSE turn_row.terminal_model_error_cursor END,
    terminal_model_error_admitted_at=v_admitted_at,updated_at=v_now
  WHERE turn_row.org_id=p_org_id AND turn_row.companion_id=p_companion_id
    AND turn_row.id=p_turn_id;
  RETURN true;
END $$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_v3_runtime_record_terminal_model_error_v9(
  uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,jsonb,integer
) FROM PUBLIC;
--> statement-breakpoint

-- Promote the stable failure and its visible system note in the same transaction as terminal page
-- projection. A primary or fallback assistant result makes v7 succeed and always wins.
CREATE FUNCTION public.companion_v3_runtime_project_native_page_v8(
  p_org_id uuid,p_companion_id uuid,p_lane public.companion_v3_lane,p_turn_id uuid,
  p_claim_token uuid,p_claim_epoch bigint,p_gate_epoch bigint,p_through_cursor bigint,
  p_assistant jsonb,p_compactions jsonb,p_decisions jsonb,p_needs_input boolean,
  p_correlated_activity boolean,p_terminal text,p_protocol integer
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_result text;v_cursor bigint;v_event_id text;v_now timestamptz:=clock_timestamp();
  v_ordinal integer;v_projection bigint;
BEGIN
  IF p_protocol IS DISTINCT FROM 8 THEN
    RAISE EXCEPTION 'Runtime v3 native projection protocol 8 is required' USING ERRCODE='42501';
  END IF;
  v_result:=public.companion_v3_runtime_project_native_page_v7(
    p_org_id,p_companion_id,p_lane,p_turn_id,p_claim_token,p_claim_epoch,p_gate_epoch,
    p_through_cursor,p_assistant,p_compactions,p_decisions,p_needs_input,
    p_correlated_activity,p_terminal,7);
  IF v_result IS DISTINCT FROM 'failed' OR p_terminal IS DISTINCT FROM 'settled' THEN
    RETURN v_result;
  END IF;
  SELECT turn_row.terminal_model_error_cursor INTO v_cursor
  FROM public.companion_v3_turns turn_row
  WHERE turn_row.org_id=p_org_id AND turn_row.companion_id=p_companion_id
    AND turn_row.id=p_turn_id
    AND turn_row.terminal_model_error_admitted_at=turn_row.admitted_at;
  IF v_cursor IS NULL THEN RETURN v_result;END IF;

  UPDATE public.companion_v3_turns turn_row SET
    outcome_code='model_unavailable',
    outcome_message='The selected model is unavailable. Choose a different model and try again.',
    outcome_action='switch_model',updated_at=v_now
  WHERE turn_row.org_id=p_org_id AND turn_row.companion_id=p_companion_id
    AND turn_row.lane=p_lane AND turn_row.admission_state='accepted'
    AND turn_row.response_turn_id=p_turn_id AND turn_row.state='failed'
    AND turn_row.outcome_code='pi_result_missing';
  v_event_id:='v3:'||p_turn_id::text||':error:'||v_cursor::text;
  IF NOT EXISTS (
    SELECT 1 FROM public.companion_transcript_entries entry
    WHERE entry.org_id=p_org_id AND entry.companion_id=p_companion_id
      AND entry.event_id=v_event_id
  ) THEN
    UPDATE public.companion_threads thread SET next_ordinal=thread.next_ordinal+1,
      projection_sequence=thread.projection_sequence+1,last_message_at=v_now,updated_at=v_now
    WHERE thread.org_id=p_org_id AND thread.companion_id=p_companion_id
    RETURNING thread.next_ordinal-1,thread.projection_sequence INTO v_ordinal,v_projection;
    INSERT INTO public.companion_transcript_entries(
      org_id,companion_id,event_id,ordinal,projection_sequence,role,content,created_at
    ) VALUES (
      p_org_id,p_companion_id,v_event_id,v_ordinal,v_projection,'system',
      'The selected model is unavailable. Choose a different model and try again.',v_now
    );
  END IF;
  RETURN 'failed';
END $$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_v3_runtime_project_native_page_v8(
  uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,bigint,jsonb,jsonb,jsonb,
  boolean,boolean,text,integer
) FROM PUBLIC;
--> statement-breakpoint

-- Routine/trigger failures remain private to their run transcript but use the same stable outcome.
CREATE FUNCTION public.companion_v3_runtime_project_background_page_v10(
  p_org_id uuid,p_companion_id uuid,p_turn_id uuid,p_claim_token uuid,p_claim_epoch bigint,
  p_gate_epoch bigint,p_through_cursor bigint,p_entries jsonb,p_decisions jsonb,p_returns jsonb,
  p_needs_input boolean,p_activity boolean,p_terminal text,p_protocol integer
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_result text;v_cursor bigint;v_now timestamptz:=clock_timestamp();v_ordinal integer;
BEGIN
  IF p_protocol IS DISTINCT FROM 10 THEN
    RAISE EXCEPTION 'Runtime v3 background projection protocol 10 is required' USING ERRCODE='42501';
  END IF;
  v_result:=public.companion_v3_runtime_project_background_page_v9(
    p_org_id,p_companion_id,p_turn_id,p_claim_token,p_claim_epoch,p_gate_epoch,
    p_through_cursor,p_entries,p_decisions,p_returns,p_needs_input,p_activity,p_terminal,9);
  IF v_result IS DISTINCT FROM 'succeeded' OR p_terminal IS DISTINCT FROM 'settled'
    OR jsonb_array_length(p_returns)<>0 THEN RETURN v_result;END IF;
  SELECT turn_row.terminal_model_error_cursor INTO v_cursor
  FROM public.companion_v3_turns turn_row
  WHERE turn_row.org_id=p_org_id AND turn_row.companion_id=p_companion_id
    AND turn_row.id=p_turn_id
    AND turn_row.terminal_model_error_admitted_at=turn_row.admitted_at
    AND NOT EXISTS (
      SELECT 1 FROM public.companion_v3_routine_run_entries entry
      WHERE entry.org_id=p_org_id AND entry.companion_id=p_companion_id
        AND entry.run_id=p_turn_id AND entry.role='assistant'
    );
  IF v_cursor IS NULL THEN RETURN v_result;END IF;

  UPDATE public.companion_v3_turns turn_row SET state='failed',outcome='failed',
    outcome_code='model_unavailable',
    outcome_message='The selected model is unavailable. Choose a different model and try again.',
    outcome_action='switch_model',updated_at=v_now
  WHERE turn_row.org_id=p_org_id AND turn_row.companion_id=p_companion_id
    AND turn_row.id=p_turn_id AND turn_row.state='succeeded';
  UPDATE public.companion_v3_routine_runs run SET outcome='failed',settled_at=v_now
  WHERE run.org_id=p_org_id AND run.companion_id=p_companion_id AND run.turn_id=p_turn_id;
  IF NOT EXISTS (
    SELECT 1 FROM public.companion_v3_routine_run_entries entry
    WHERE entry.org_id=p_org_id AND entry.companion_id=p_companion_id
      AND entry.run_id=p_turn_id AND entry.event_id='error:'||v_cursor::text
  ) THEN
    UPDATE public.companion_v3_routine_runs run SET next_ordinal=run.next_ordinal+1
    WHERE run.org_id=p_org_id AND run.companion_id=p_companion_id AND run.turn_id=p_turn_id
    RETURNING run.next_ordinal-1 INTO v_ordinal;
    INSERT INTO public.companion_v3_routine_run_entries(
      org_id,companion_id,run_id,event_id,ordinal,role,content,created_at
    ) VALUES (
      p_org_id,p_companion_id,p_turn_id,'error:'||v_cursor::text,v_ordinal,'system',
      'The selected model is unavailable. Choose a different model and try again.',v_now
    );
  END IF;
  RETURN 'failed';
END $$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_v3_runtime_project_background_page_v10(
  uuid,uuid,uuid,uuid,bigint,bigint,bigint,jsonb,jsonb,jsonb,boolean,boolean,text,integer
) FROM PUBLIC;
