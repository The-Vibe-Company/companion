-- THE-521: persist ask_user independently from an executor claim. Main questions resume only after
-- an explicit answer or fail-closed cancellation; background questions detach from obsolete work.
CREATE TABLE public.companion_v3_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  companion_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  lane public.companion_v3_lane NOT NULL,
  event_id text NOT NULL,
  request_key text NOT NULL,
  request_kind public.companion_decision_request_kind NOT NULL,
  decision_status public.companion_decision_status NOT NULL DEFAULT 'pending',
  actor_id text,
  response_text text,
  responded_at timestamptz,
  expires_at timestamptz NOT NULL,
  delivery_state public.companion_decision_delivery_state NOT NULL DEFAULT 'pending',
  command_id uuid,
  delivery_started_at timestamptz,
  delivered_at timestamptz,
  detached_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT companion_v3_decisions_org_companion_id_uq UNIQUE(org_id,companion_id,id),
  CONSTRAINT companion_v3_decisions_request_uq UNIQUE(turn_id,request_key),
  CONSTRAINT companion_v3_decisions_event_uq UNIQUE(companion_id,event_id),
  CONSTRAINT companion_v3_decisions_turn_fk FOREIGN KEY(org_id,companion_id,turn_id)
    REFERENCES public.companion_v3_turns(org_id,companion_id,id) ON DELETE CASCADE,
  CONSTRAINT companion_v3_decisions_request_key_check CHECK (
    char_length(request_key) BETWEEN 1 AND 200 AND request_key !~ E'[\n\r]'),
  CONSTRAINT companion_v3_decisions_event_id_check CHECK (
    event_id ~ '^v3:[0-9a-f-]{36}:decision:[0-9]+$'),
  CONSTRAINT companion_v3_decisions_question_only_check CHECK (request_kind = 'question'),
  CONSTRAINT companion_v3_decisions_response_check CHECK (
    (response_text IS NULL OR octet_length(response_text) <= 24000)
    AND ((decision_status = 'pending' AND actor_id IS NULL AND response_text IS NULL
          AND responded_at IS NULL)
      OR (decision_status = 'answered' AND actor_id IS NOT NULL AND response_text IS NOT NULL
          AND responded_at IS NOT NULL)
      OR (decision_status IN ('denied','expired','cancelled') AND response_text IS NULL
          AND responded_at IS NOT NULL))),
  CONSTRAINT companion_v3_decisions_delivery_check CHECK (
    ((delivery_state IN ('pending','cancelled') AND command_id IS NULL
        AND delivery_started_at IS NULL)
      OR (delivery_state IN ('write_intent','delivered','ambiguous') AND command_id IS NOT NULL
        AND delivery_started_at IS NOT NULL))
    AND ((delivery_state = 'delivered') = (delivered_at IS NOT NULL))
    AND (detached_at IS NULL OR (lane = 'background' AND delivery_state = 'cancelled')))
);
--> statement-breakpoint
CREATE INDEX companion_v3_decisions_pending_idx
  ON public.companion_v3_decisions(expires_at,companion_id)
  WHERE decision_status = 'pending';
--> statement-breakpoint
ALTER TABLE public.companion_v3_decisions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.companion_v3_decisions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY companion_v3_decisions_function_owner_rls
  ON public.companion_v3_decisions FOR ALL
  USING (current_user = pg_get_userbyid((SELECT procedure.proowner FROM pg_proc procedure
    WHERE procedure.oid = 'public.companion_v3_admit_turn(uuid,uuid,uuid,text,text,public.companion_v3_lane)'::regprocedure)))
  WITH CHECK (current_user = pg_get_userbyid((SELECT procedure.proowner FROM pg_proc procedure
    WHERE procedure.oid = 'public.companion_v3_admit_turn(uuid,uuid,uuid,text,text,public.companion_v3_lane)'::regprocedure)));
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.companion_v3_bound_turn_clocks()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog,public AS $$
DECLARE v_now timestamptz:=clock_timestamp();
BEGIN
  IF NEW.state IN ('succeeded','failed','interrupted','cancelled') THEN
    NEW.inactivity_deadline_at:=NULL; NEW.absolute_deadline_at:=NULL; RETURN NEW;
  END IF;
  IF NEW.state='queued' THEN
    NEW.inactivity_deadline_at:=NULL; NEW.absolute_deadline_at:=NULL; RETURN NEW;
  END IF;
  IF OLD.state='queued' AND NEW.admission_state='accepted' THEN
    NEW.admission_started_at:=COALESCE(NEW.admission_started_at,v_now);
    NEW.absolute_deadline_at:=COALESCE(NEW.absolute_deadline_at,v_now+interval '2 hours');
    NEW.last_activity_at:=COALESCE(NEW.last_activity_at,v_now);
    NEW.inactivity_deadline_at:=CASE WHEN NEW.state='needs_input' THEN NULL
      ELSE LEAST(NEW.absolute_deadline_at,NEW.last_activity_at+interval '10 minutes') END;
    RETURN NEW;
  END IF;
  NEW.absolute_deadline_at:=OLD.absolute_deadline_at;
  IF NEW.state='needs_input' THEN NEW.inactivity_deadline_at:=NULL;
  ELSIF OLD.state='needs_input' AND NEW.state IN ('admitted','running') THEN
    NEW.last_activity_at:=v_now;
    NEW.inactivity_deadline_at:=LEAST(NEW.absolute_deadline_at,v_now+interval '10 minutes');
  ELSIF NEW.correlated_activity_cursor>OLD.correlated_activity_cursor THEN
    NEW.last_activity_at:=COALESCE(NEW.last_activity_at,v_now);
    NEW.inactivity_deadline_at:=LEAST(NEW.absolute_deadline_at,NEW.last_activity_at+interval '10 minutes');
  ELSE
    NEW.last_activity_at:=OLD.last_activity_at; NEW.inactivity_deadline_at:=OLD.inactivity_deadline_at;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_api_get_decision(
  p_org_id uuid,p_companion_id uuid,p_request_key text
)
RETURNS TABLE(request_key text,request_kind public.companion_decision_request_kind,
  decision_status public.companion_decision_status,proposal jsonb,expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog,public SET row_security = on AS $$
BEGIN
  PERFORM public.companion_api_require_access(p_org_id,p_companion_id,'read');
  RETURN QUERY SELECT decision.request_key,decision.request_kind,decision.decision_status,
    NULL::jsonb,decision.expires_at
  FROM public.companion_v3_decisions decision
  WHERE decision.org_id=p_org_id AND decision.companion_id=p_companion_id
    AND decision.request_key=p_request_key
  ORDER BY decision.created_at DESC,decision.id DESC LIMIT 1;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_api_get_decision(uuid,uuid,text) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_api_answer_decision(
  p_org_id uuid,p_companion_id uuid,p_request_key text,p_action text,p_answer text
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog,public SET row_security = on AS $$
DECLARE
  v_actor text := public.companion_api_actor(p_org_id); v_name text;
  v_decision public.companion_v3_decisions%ROWTYPE; v_now timestamptz := clock_timestamp();
  v_status public.companion_decision_status; v_response text; v_projection bigint;
BEGIN
  PERFORM public.companion_api_require_access(p_org_id,p_companion_id,'editor');
  IF p_request_key IS NULL OR char_length(p_request_key) NOT BETWEEN 1 AND 200
    OR p_request_key ~ E'[\n\r]' THEN
    RAISE EXCEPTION 'invalid Runtime v3 decision response' USING ERRCODE='22023';
  END IF;
  SELECT decision.* INTO v_decision FROM public.companion_v3_decisions decision
  WHERE decision.org_id=p_org_id AND decision.companion_id=p_companion_id
    AND decision.request_key=p_request_key
  ORDER BY decision.created_at DESC,decision.id DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF p_action NOT IN ('deny','answer')
    OR (p_action='answer' AND (p_answer IS NULL OR char_length(btrim(p_answer)) NOT BETWEEN 1 AND 8000))
    OR (p_action<>'answer' AND p_answer IS NOT NULL) THEN
    RAISE EXCEPTION 'invalid Runtime v3 decision response' USING ERRCODE='22023';
  END IF;
  IF v_decision.decision_status <> 'pending' OR v_decision.expires_at <= v_now THEN
    RAISE EXCEPTION 'Runtime v3 decision is not pending' USING ERRCODE='55000';
  END IF;
  IF v_decision.lane='main' AND NOT EXISTS (
    SELECT 1 FROM public.companion_v3_turns turn_row
    WHERE turn_row.org_id=p_org_id AND turn_row.companion_id=p_companion_id
      AND turn_row.id=v_decision.turn_id AND turn_row.state='needs_input'
      AND turn_row.admission_state='accepted' AND turn_row.response_turn_id=turn_row.id
  ) THEN RAISE EXCEPTION 'Runtime v3 decision Turn is no longer active' USING ERRCODE='55000';
  END IF;
  v_status := CASE WHEN p_action='answer' THEN 'answered'::public.companion_decision_status
    ELSE 'denied'::public.companion_decision_status END;
  v_response := CASE WHEN p_action='answer' THEN btrim(p_answer) END;
  UPDATE public.companion_v3_decisions SET decision_status=v_status,actor_id=v_actor,
    response_text=v_response,responded_at=v_now,updated_at=v_now WHERE id=v_decision.id;
  SELECT COALESCE(profile.name,app_user.name,app_user.email) INTO v_name
  FROM public."user" app_user LEFT JOIN public.profiles profile ON profile.id=app_user.id
  WHERE app_user.id=v_actor;
  UPDATE public.companion_threads SET projection_sequence=projection_sequence+1,updated_at=v_now
  WHERE org_id=p_org_id AND companion_id=p_companion_id
  RETURNING projection_sequence INTO v_projection;
  UPDATE public.companion_transcript_entries SET projection_sequence=v_projection,
    decision=decision || jsonb_build_object('status',v_status,'answer',v_response,
      'decided_by_id',v_actor,'decided_by_name',v_name,
      'decided_at',to_char(v_now AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
  WHERE org_id=p_org_id AND companion_id=p_companion_id AND event_id=v_decision.event_id
    AND decision->>'status'='pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'Runtime v3 decision projection is missing' USING ERRCODE='55000';
  END IF;
  IF v_decision.lane='main' THEN
    UPDATE public.companion_v3_turns SET state='running',
      inactivity_deadline_at=LEAST(v_now+interval '10 minutes',absolute_deadline_at),updated_at=v_now
    WHERE org_id=p_org_id AND companion_id=p_companion_id AND id=v_decision.turn_id
      AND state='needs_input';
    IF NOT FOUND THEN RAISE EXCEPTION 'Runtime v3 decision Turn changed concurrently' USING ERRCODE='40001';
    END IF;
  END IF;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_api_answer_decision(uuid,uuid,text,text,text) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_runtime_project_native_page_v6(
  p_org_id uuid,p_companion_id uuid,p_lane public.companion_v3_lane,p_turn_id uuid,
  p_claim_token uuid,p_claim_epoch bigint,p_gate_epoch bigint,p_through_cursor bigint,
  p_assistant jsonb,p_compactions jsonb,p_decisions jsonb,p_needs_input boolean,
  p_correlated_activity boolean,p_terminal text,p_protocol integer
)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog,public SET row_security = on AS $$
DECLARE
  v_projected text; v_item jsonb; v_card jsonb; v_expiry timestamptz; v_absolute timestamptz;
  v_now timestamptz := clock_timestamp(); v_ordinal integer; v_projection bigint; v_inserted integer;
BEGIN
  IF p_protocol IS DISTINCT FROM 6 OR jsonb_typeof(p_decisions) IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_decisions)>1
    OR (jsonb_array_length(p_decisions)>0 AND (NOT p_needs_input OR p_terminal IS NOT NULL)) THEN
    RAISE EXCEPTION 'invalid Runtime v3 decision projection' USING ERRCODE='22023';
  END IF;
  v_projected := public.companion_v3_runtime_project_native_page_v5(
    p_org_id,p_companion_id,p_lane,p_turn_id,p_claim_token,p_claim_epoch,p_gate_epoch,
    p_through_cursor,p_assistant,p_compactions,p_needs_input,p_correlated_activity,p_terminal,5);
  IF v_projected IS NULL THEN RETURN NULL; END IF;
  SELECT absolute_deadline_at INTO v_absolute FROM public.companion_v3_turns
  WHERE org_id=p_org_id AND companion_id=p_companion_id AND id=p_turn_id;
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_decisions) LOOP
    IF jsonb_typeof(v_item)<>'object' OR (v_item->>'type') IS DISTINCT FROM 'decision'
      OR (v_item->>'request_kind') IS DISTINCT FROM 'question'
      OR (v_item->'decision'->>'kind') IS DISTINCT FROM 'question'
      OR (v_item->'decision'->>'status') IS DISTINCT FROM 'pending'
      OR (v_item->'decision'->>'request_id') IS DISTINCT FROM v_item->>'request_key'
      OR coalesce(v_item->>'eventId','') !~ ('^v3:'||p_turn_id::text||':decision:[0-9]+$')
      OR char_length(coalesce(v_item->>'request_key','')) NOT BETWEEN 1 AND 200
      OR (v_item->>'request_key') ~ E'[\n\r]'
      OR char_length(coalesce(v_item->>'content',''))>300
      OR octet_length(coalesce(v_item->'decision'->>'detail',''))>48000 THEN
      RAISE EXCEPTION 'invalid Runtime v3 ask_user projection' USING ERRCODE='22023';
    END IF;
    v_expiry := LEAST((v_item->>'expires_at')::timestamptz,v_now+interval '10 minutes',v_absolute);
    v_card := jsonb_build_object('request_id',v_item->>'request_key','kind','question',
      'name',coalesce(v_item->'decision'->>'name','ask_user'),
      'title',coalesce(v_item->'decision'->>'title',v_item->>'content'),
      'detail',v_item->'decision'->'detail','status','pending','answer',NULL,
      'decided_by_id',NULL,'decided_by_name',NULL,'decided_at',NULL,
      'expires_at',to_char(v_expiry AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'required_access','editor','proposal',NULL);
    INSERT INTO public.companion_v3_decisions(org_id,companion_id,turn_id,lane,event_id,
      request_key,request_kind,expires_at)
    VALUES(p_org_id,p_companion_id,p_turn_id,p_lane,v_item->>'eventId',
      v_item->>'request_key','question',v_expiry)
    ON CONFLICT ON CONSTRAINT companion_v3_decisions_request_uq DO NOTHING;
    GET DIAGNOSTICS v_inserted=ROW_COUNT;
    IF v_inserted=1 THEN
      UPDATE public.companion_threads SET next_ordinal=next_ordinal+1,
        projection_sequence=projection_sequence+1,last_message_at=v_now,updated_at=v_now
      WHERE org_id=p_org_id AND companion_id=p_companion_id
      RETURNING next_ordinal-1,projection_sequence INTO v_ordinal,v_projection;
      INSERT INTO public.companion_transcript_entries(org_id,companion_id,event_id,ordinal,
        projection_sequence,role,content,decision,created_at)
      VALUES(p_org_id,p_companion_id,v_item->>'eventId',v_ordinal,v_projection,'decision',
        v_item->>'content',v_card,v_now);
    ELSIF NOT EXISTS (SELECT 1 FROM public.companion_v3_decisions decision
      WHERE decision.turn_id=p_turn_id AND decision.request_key=v_item->>'request_key'
        AND decision.org_id=p_org_id AND decision.companion_id=p_companion_id
        AND decision.lane=p_lane AND decision.event_id=v_item->>'eventId') THEN
      RAISE EXCEPTION 'Runtime v3 decision identity conflict' USING ERRCODE='23505';
    END IF;
  END LOOP;
  IF p_lane='background' AND jsonb_array_length(p_decisions)>0 THEN RETURN 'detached'; END IF;
  RETURN v_projected;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_runtime_project_native_page_v6(
  uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,bigint,jsonb,jsonb,jsonb,
  boolean,boolean,text,integer) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_runtime_claim_warm_v6(
  p_executor_id text,p_lane public.companion_v3_lane,p_lease_seconds integer,p_protocol integer
)
RETURNS TABLE(org_id uuid,companion_id uuid,turn_id uuid,command_id uuid,
  lane public.companion_v3_lane,state public.companion_v3_turn_state,claim_token uuid,
  claim_epoch bigint,gate_epoch bigint,admission_started_at timestamptz,
  inactivity_deadline_at timestamptz,absolute_deadline_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog,public SET row_security = on AS $$
DECLARE v_now timestamptz:=clock_timestamp(); v_gate bigint; v_candidate record;
BEGIN
  IF p_protocol IS DISTINCT FROM 6 OR p_executor_id IS NULL
    OR char_length(p_executor_id) NOT BETWEEN 1 AND 200 OR p_executor_id ~ E'[\n\r]'
    OR p_lease_seconds NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION 'invalid Runtime v3 warm claim protocol 6' USING ERRCODE='22023'; END IF;
  SELECT control.gate_epoch INTO v_gate FROM public.companion_runtime_control control
  WHERE control.id='runtime-v2' AND control.enabled FOR SHARE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT lease.org_id,lease.companion_id,turn_row.id AS turn_id,
    turn_row.command_id,turn_row.lane,turn_row.state,turn_row.admission_started_at,
    turn_row.inactivity_deadline_at,turn_row.absolute_deadline_at INTO v_candidate
  FROM public.companion_v3_lane_leases lease
  JOIN public.companion_v3_instances instance ON instance.org_id=lease.org_id
    AND instance.companion_id=lease.companion_id AND instance.box_id IS NOT NULL
    AND instance.pi_invocation_id IS NOT NULL AND instance.prepared_at IS NOT NULL
    AND instance.pi_recycle_checkpoint IS NULL
    AND (instance.prepared_material_expires_at IS NULL
      OR instance.prepared_material_expires_at>v_now+interval '2 hours 5 minutes')
  JOIN public.companion_v3_turns turn_row ON turn_row.org_id=lease.org_id
    AND turn_row.companion_id=lease.companion_id AND turn_row.lane=lease.lane
    AND turn_row.state='running' AND turn_row.admission_state='accepted'
    AND turn_row.response_turn_id=turn_row.id
  JOIN public.companion_v3_decisions decision ON decision.org_id=turn_row.org_id
    AND decision.companion_id=turn_row.companion_id AND decision.turn_id=turn_row.id
    AND decision.lane=turn_row.lane AND decision.decision_status<>'pending'
    AND decision.delivery_state IN ('pending','write_intent')
  WHERE lease.lane=p_lane AND (lease.claim_token IS NULL OR lease.expires_at<=v_now)
  ORDER BY turn_row.queue_sequence,turn_row.id LIMIT 1 FOR UPDATE OF lease,turn_row SKIP LOCKED;
  IF FOUND THEN
    UPDATE public.companion_v3_lane_leases lease SET claim_token=gen_random_uuid(),
      claim_epoch=lease.claim_epoch+1,gate_epoch=v_gate,executor_id=p_executor_id,
      turn_id=v_candidate.turn_id,claimed_at=v_now,renewed_at=v_now,
      expires_at=v_now+make_interval(secs=>p_lease_seconds),updated_at=v_now
    WHERE lease.org_id=v_candidate.org_id AND lease.companion_id=v_candidate.companion_id
      AND lease.lane=p_lane
    RETURNING lease.claim_token,lease.claim_epoch,lease.gate_epoch
      INTO claim_token,claim_epoch,gate_epoch;
    org_id:=v_candidate.org_id; companion_id:=v_candidate.companion_id;
    turn_id:=v_candidate.turn_id; command_id:=v_candidate.command_id;
    lane:=v_candidate.lane; state:=v_candidate.state;
    admission_started_at:=v_candidate.admission_started_at;
    inactivity_deadline_at:=v_candidate.inactivity_deadline_at;
    absolute_deadline_at:=v_candidate.absolute_deadline_at;
    UPDATE public.companion_v3_turns SET first_claimed_at=COALESCE(first_claimed_at,v_now),
      last_claimed_at=v_now,claim_count=claim_count+1,updated_at=v_now
    WHERE id=v_candidate.turn_id;
    RETURN NEXT; RETURN;
  END IF;
  RETURN QUERY SELECT claimed.* FROM public.companion_v3_runtime_claim_warm_v5(
    p_executor_id,p_lane,p_lease_seconds,5) claimed;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_runtime_claim_warm_v6(
  text,public.companion_v3_lane,integer,integer) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_runtime_begin_decision_action(
  p_org_id uuid,p_companion_id uuid,p_lane public.companion_v3_lane,p_turn_id uuid,
  p_claim_token uuid,p_claim_epoch bigint,p_gate_epoch bigint,p_protocol integer
)
RETURNS TABLE(action_kind text,decision_id uuid,command_id uuid,response jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog,public SET row_security = on AS $$
DECLARE v_now timestamptz:=clock_timestamp(); v_decision public.companion_v3_decisions%ROWTYPE;
BEGIN
  PERFORM pg_catalog.set_config('app.companion_runtime_protocol','2',true);
  IF p_protocol IS DISTINCT FROM 6 THEN RAISE EXCEPTION 'Runtime v3 protocol 6 is required' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM public.companion_v3_lane_leases lease JOIN public.companion_runtime_control control
    ON control.id='runtime-v2' AND control.enabled AND control.gate_epoch=p_gate_epoch
  WHERE lease.org_id=p_org_id AND lease.companion_id=p_companion_id AND lease.lane=p_lane
    AND lease.turn_id=p_turn_id AND lease.claim_token=p_claim_token
    AND lease.claim_epoch=p_claim_epoch AND lease.gate_epoch=p_gate_epoch AND lease.expires_at>v_now
  FOR UPDATE OF lease;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT decision.* INTO v_decision FROM public.companion_v3_decisions decision
  JOIN public.companion_v3_turns turn_row ON turn_row.org_id=decision.org_id
    AND turn_row.companion_id=decision.companion_id AND turn_row.id=decision.turn_id
  WHERE decision.org_id=p_org_id AND decision.companion_id=p_companion_id
    AND decision.turn_id=p_turn_id AND decision.lane=p_lane
    AND decision.delivery_state IN ('pending','write_intent')
    AND ((p_lane='background' AND turn_row.state='needs_input')
      OR (p_lane='main' AND decision.decision_status IN ('answered','denied','expired','cancelled')
        AND turn_row.state='running'))
  ORDER BY decision.created_at,decision.id LIMIT 1 FOR UPDATE OF decision;
  IF NOT FOUND THEN RETURN; END IF;
  IF v_decision.delivery_state='pending' THEN
    UPDATE public.companion_v3_decisions SET delivery_state='write_intent',command_id=gen_random_uuid(),
      delivery_started_at=v_now,updated_at=v_now WHERE id=v_decision.id
    RETURNING id,companion_v3_decisions.command_id INTO decision_id,command_id;
  ELSE
    decision_id:=v_decision.id; command_id:=v_decision.command_id;
  END IF;
  action_kind:=CASE WHEN p_lane='background' THEN 'detach' ELSE 'respond' END;
  response:=CASE WHEN action_kind='detach' THEN NULL
    WHEN v_decision.decision_status='answered' THEN jsonb_build_object('type','extension_ui_response',
      'id',v_decision.request_key,'value',v_decision.response_text)
    ELSE jsonb_build_object('type','extension_ui_response','id',v_decision.request_key,'cancelled',true) END;
  RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_runtime_begin_decision_action(
  uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,integer) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_runtime_finish_decision_action(
  p_org_id uuid,p_companion_id uuid,p_lane public.companion_v3_lane,p_turn_id uuid,
  p_claim_token uuid,p_claim_epoch bigint,p_gate_epoch bigint,p_decision_id uuid,
  p_action_kind text,p_pi_invocation_id text,p_protocol integer
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog,public SET row_security = on AS $$
DECLARE v_now timestamptz:=clock_timestamp();
BEGIN
  IF p_protocol IS DISTINCT FROM 6 OR p_action_kind NOT IN ('respond','detach') THEN
    RAISE EXCEPTION 'invalid Runtime v3 decision checkpoint' USING ERRCODE='22023'; END IF;
  UPDATE public.companion_v3_decisions decision SET
    delivery_state=CASE WHEN p_action_kind='detach' THEN 'cancelled'::public.companion_decision_delivery_state
      ELSE 'delivered'::public.companion_decision_delivery_state END,
    command_id=CASE WHEN p_action_kind='detach' THEN NULL ELSE decision.command_id END,
    delivery_started_at=CASE WHEN p_action_kind='detach' THEN NULL ELSE decision.delivery_started_at END,
    delivered_at=CASE WHEN p_action_kind='respond' THEN v_now END,
    detached_at=CASE WHEN p_action_kind='detach' THEN v_now END,updated_at=v_now
  FROM public.companion_v3_turns turn_row,public.companion_v3_lane_leases lease,
    public.companion_runtime_control control
  WHERE decision.id=p_decision_id AND decision.org_id=p_org_id
    AND decision.companion_id=p_companion_id AND decision.turn_id=p_turn_id
    AND decision.lane=p_lane AND decision.delivery_state='write_intent'
    AND ((p_action_kind='detach' AND p_lane='background')
      OR (p_action_kind='respond' AND p_lane='main' AND decision.decision_status<>'pending'))
    AND turn_row.org_id=decision.org_id AND turn_row.companion_id=decision.companion_id
    AND turn_row.id=decision.turn_id AND turn_row.pi_invocation_id=p_pi_invocation_id
    AND lease.org_id=turn_row.org_id AND lease.companion_id=turn_row.companion_id
    AND lease.lane=p_lane AND lease.turn_id=p_turn_id AND lease.claim_token=p_claim_token
    AND lease.claim_epoch=p_claim_epoch AND lease.gate_epoch=p_gate_epoch AND lease.expires_at>v_now
    AND control.id='runtime-v2' AND control.enabled AND control.gate_epoch=p_gate_epoch;
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_runtime_finish_decision_action(
  uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,uuid,text,text,integer) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_runtime_complete_v6(
  p_org_id uuid,p_companion_id uuid,p_lane public.companion_v3_lane,p_turn_id uuid,
  p_claim_token uuid,p_claim_epoch bigint,p_gate_epoch bigint,p_outcome text,p_code text,
  p_message text,p_action public.companion_runtime_error_action,p_protocol integer
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog,public SET row_security = on AS $$
DECLARE v_now timestamptz:=clock_timestamp();
BEGIN
  PERFORM pg_catalog.set_config('app.companion_runtime_protocol','2',true);
  IF p_protocol IS DISTINCT FROM 6 THEN RAISE EXCEPTION 'Runtime v3 protocol 6 is required' USING ERRCODE='42501'; END IF;
  IF p_outcome<>'detached' THEN RETURN public.companion_v3_runtime_complete_v5(
    p_org_id,p_companion_id,p_lane,p_turn_id,p_claim_token,p_claim_epoch,p_gate_epoch,
    p_outcome,p_code,p_message,p_action,5); END IF;
  IF p_lane<>'background' OR p_code IS NOT NULL OR p_message IS NOT NULL OR p_action IS NOT NULL
    OR NOT EXISTS (SELECT 1 FROM public.companion_v3_decisions decision
      WHERE decision.org_id=p_org_id AND decision.companion_id=p_companion_id
        AND decision.turn_id=p_turn_id AND decision.lane='background'
        AND decision.delivery_state='cancelled' AND decision.detached_at IS NOT NULL) THEN RETURN false; END IF;
  PERFORM 1 FROM public.companion_v3_lane_leases lease JOIN public.companion_runtime_control control
    ON control.id='runtime-v2' AND control.enabled AND control.gate_epoch=p_gate_epoch
  WHERE lease.org_id=p_org_id AND lease.companion_id=p_companion_id AND lease.lane=p_lane
    AND lease.turn_id=p_turn_id AND lease.claim_token=p_claim_token
    AND lease.claim_epoch=p_claim_epoch AND lease.gate_epoch=p_gate_epoch AND lease.expires_at>v_now
  FOR UPDATE OF lease;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE public.companion_v3_turns SET state='cancelled',outcome='cancelled',
    inactivity_deadline_at=NULL,absolute_deadline_at=NULL,settled_at=v_now,updated_at=v_now
  WHERE org_id=p_org_id AND companion_id=p_companion_id AND id=p_turn_id AND lane='background'
    AND state='needs_input' AND admission_state='accepted';
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE public.companion_v3_lane_leases SET claim_token=NULL,gate_epoch=NULL,executor_id=NULL,
    turn_id=NULL,claimed_at=NULL,renewed_at=NULL,expires_at=NULL,updated_at=v_now
  WHERE org_id=p_org_id AND companion_id=p_companion_id AND lane=p_lane
    AND claim_token=p_claim_token AND claim_epoch=p_claim_epoch;
  UPDATE public.companion_threads SET projection_sequence=projection_sequence+1,updated_at=v_now
  WHERE org_id=p_org_id AND companion_id=p_companion_id;
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_runtime_complete_v6(
  uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,text,text,text,
  public.companion_runtime_error_action,integer) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_runtime_sweep_decisions(
  p_lane public.companion_v3_lane,p_protocol integer
)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog,public SET row_security = on AS $$
DECLARE v_now timestamptz:=clock_timestamp(); v_decision public.companion_v3_decisions%ROWTYPE;
  v_count integer:=0; v_deadline_count integer:=0; v_projection bigint;
BEGIN
  PERFORM pg_catalog.set_config('app.companion_runtime_protocol','2',true);
  IF p_protocol IS DISTINCT FROM 6 THEN RAISE EXCEPTION 'Runtime v3 protocol 6 is required' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM public.companion_runtime_control WHERE id='runtime-v2' AND enabled FOR SHARE;
  IF NOT FOUND THEN RETURN 0; END IF;
  -- Keep the absolute deadline and decision expiry in one transaction. Other executors cannot
  -- observe a needs_input Turn rearmed by expiry before its authoritative two-hour sweep wins.
  v_deadline_count:=public.companion_v3_runtime_sweep_deadlines(p_lane,4);
  LOOP
    SELECT decision.* INTO v_decision FROM public.companion_v3_decisions decision
    WHERE decision.lane=p_lane AND decision.decision_status='pending' AND decision.expires_at<=v_now
    ORDER BY decision.expires_at,decision.id LIMIT 1 FOR UPDATE SKIP LOCKED;
    EXIT WHEN NOT FOUND OR v_count>=64;
    UPDATE public.companion_v3_decisions SET decision_status='expired',responded_at=v_now,updated_at=v_now
    WHERE id=v_decision.id;
    UPDATE public.companion_threads SET projection_sequence=projection_sequence+1,updated_at=v_now
    WHERE org_id=v_decision.org_id AND companion_id=v_decision.companion_id
    RETURNING projection_sequence INTO v_projection;
    UPDATE public.companion_transcript_entries SET projection_sequence=v_projection,
      decision=decision || jsonb_build_object('status','expired','decided_at',
        to_char(v_now AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
    WHERE org_id=v_decision.org_id AND companion_id=v_decision.companion_id
      AND event_id=v_decision.event_id AND decision->>'status'='pending';
    IF p_lane='main' THEN UPDATE public.companion_v3_turns SET state='running',
      inactivity_deadline_at=LEAST(v_now+interval '10 minutes',absolute_deadline_at),updated_at=v_now
      WHERE org_id=v_decision.org_id AND companion_id=v_decision.companion_id
        AND id=v_decision.turn_id AND state='needs_input'; END IF;
    v_count:=v_count+1;
  END LOOP;
  v_deadline_count:=v_deadline_count
    + public.companion_v3_runtime_sweep_deadlines(p_lane,4);
  RETURN v_count+v_deadline_count;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_runtime_sweep_decisions(
  public.companion_v3_lane,integer) FROM PUBLIC;
--> statement-breakpoint

-- Wrap member enqueue so a genuinely new message cancels an attached wait before FIFO processing.
ALTER FUNCTION public.companion_v3_api_enqueue_warm_turn(uuid,uuid,uuid,text)
  RENAME TO companion_v3_api_enqueue_warm_turn_v5;
--> statement-breakpoint
CREATE FUNCTION public.companion_v3_api_enqueue_warm_turn(
  p_org_id uuid,p_companion_id uuid,p_client_message_id uuid,p_content text
)
RETURNS TABLE(turn jsonb,replayed boolean) LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog,public SET row_security = on AS $$
DECLARE v_result record; v_now timestamptz:=clock_timestamp(); v_projection bigint;
BEGIN
  SELECT * INTO v_result FROM public.companion_v3_api_enqueue_warm_turn_v5(
    p_org_id,p_companion_id,p_client_message_id,p_content);
  IF NOT FOUND THEN RETURN; END IF;
  IF NOT v_result.replayed THEN
    UPDATE public.companion_v3_decisions decision SET decision_status='cancelled',
      responded_at=v_now,updated_at=v_now
    FROM public.companion_v3_turns turn_row
    WHERE decision.org_id=p_org_id AND decision.companion_id=p_companion_id
      AND decision.lane='main' AND decision.decision_status='pending'
      AND turn_row.org_id=decision.org_id AND turn_row.companion_id=decision.companion_id
      AND turn_row.id=decision.turn_id AND turn_row.state='needs_input';
    IF FOUND THEN
      UPDATE public.companion_v3_turns turn_row SET state='running',
        inactivity_deadline_at=LEAST(v_now+interval '10 minutes',absolute_deadline_at),updated_at=v_now
      WHERE turn_row.org_id=p_org_id AND turn_row.companion_id=p_companion_id
        AND turn_row.lane='main' AND turn_row.state='needs_input'
        AND EXISTS (SELECT 1 FROM public.companion_v3_decisions decision
          WHERE decision.turn_id=turn_row.id AND decision.decision_status='cancelled'
            AND decision.responded_at=v_now);
      UPDATE public.companion_threads SET projection_sequence=projection_sequence+1,updated_at=v_now
      WHERE org_id=p_org_id AND companion_id=p_companion_id
      RETURNING projection_sequence INTO v_projection;
      UPDATE public.companion_transcript_entries entry SET projection_sequence=v_projection,
        decision=entry.decision || jsonb_build_object('status','cancelled','decided_at',
          to_char(v_now AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
      WHERE entry.org_id=p_org_id AND entry.companion_id=p_companion_id
        AND entry.role='decision' AND entry.decision->>'status'='pending'
        AND EXISTS (SELECT 1 FROM public.companion_v3_decisions decision
          WHERE decision.event_id=entry.event_id AND decision.decision_status='cancelled'
            AND decision.responded_at=v_now);
    END IF;
  END IF;
  turn:=v_result.turn; replayed:=v_result.replayed; RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_api_enqueue_warm_turn_v5(uuid,uuid,uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.companion_v3_api_enqueue_warm_turn(uuid,uuid,uuid,text) FROM PUBLIC;
--> statement-breakpoint

DO $$ DECLARE v_role text; BEGIN
  FOREACH v_role IN ARRAY ARRAY[current_setting('companion.api_role',true)] LOOP
    IF v_role IS NULL OR btrim(v_role)='' OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=v_role) THEN CONTINUE; END IF;
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_v3_api_get_decision(uuid,uuid,text) TO %I',v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_v3_api_answer_decision(uuid,uuid,text,text,text) TO %I',v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_v3_api_enqueue_warm_turn(uuid,uuid,uuid,text) TO %I',v_role);
  END LOOP;
  FOREACH v_role IN ARRAY ARRAY[current_setting('companion.companion_runtime_role',true),current_setting('companion.runtime_role',true)] LOOP
    IF v_role IS NULL OR btrim(v_role)='' OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=v_role) THEN CONTINUE; END IF;
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_v3_runtime_project_native_page_v6(uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,bigint,jsonb,jsonb,jsonb,boolean,boolean,text,integer) TO %I',v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_v3_runtime_claim_warm_v6(text,public.companion_v3_lane,integer,integer) TO %I',v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_v3_runtime_begin_decision_action(uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,integer) TO %I',v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_v3_runtime_finish_decision_action(uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,uuid,text,text,integer) TO %I',v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_v3_runtime_complete_v6(uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,text,text,text,public.companion_runtime_error_action,integer) TO %I',v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_v3_runtime_sweep_decisions(public.companion_v3_lane,integer) TO %I',v_role);
  END LOOP;
END $$;
