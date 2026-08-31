-- A hosted Pi cannot authoritatively choose the member-scoped trigger-provider account used by
-- the person who eventually approves its proposal. Older broker versions nevertheless exposed a
-- provider_account_id argument, and Pi could copy an unrelated UUID (for example the preceding
-- propose_config request id) into the durable proposal. Approval then failed closed even when the
-- approver had exactly one eligible provider connection.
--
-- Keep valid historical selections, but treat an unavailable proposal account as absent. The
-- ordinary create function then applies its existing approver-scoped policy: zero eligible
-- accounts leaves the trigger unwired, one selects silently, and more than one remains ambiguous.
-- Direct create/update calls retain their strict explicit-account validation.
CREATE OR REPLACE FUNCTION public.companion_api_answer_trigger_decision(
  p_org_id uuid,p_companion_id uuid,p_request_key text,p_action text,p_trigger_id uuid,p_secret text
)
RETURNS TABLE(delivery_id uuid,turn_id uuid,decision_status public.companion_decision_status,
  delivery_state public.companion_decision_delivery_state,responded_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on
AS $$
DECLARE
  v_actor_id text:=public.companion_api_actor(p_org_id); v_actor_name text;
  v_delivery public.companion_decision_deliveries%ROWTYPE;
  v_status public.companion_decision_status; v_event_id text; v_now timestamptz:=clock_timestamp();
  v_proposal jsonb; v_name text; v_prompt text; v_mode text; v_provider text; v_account_id uuid;
BEGIN
  PERFORM public.companion_api_require_access(p_org_id,p_companion_id,'editor');
  IF p_request_key IS NULL OR char_length(p_request_key) NOT BETWEEN 1 AND 200
    OR p_request_key~E'[\n\r]' OR p_action NOT IN ('allow','deny')
    OR (p_action='allow' AND (p_trigger_id IS NULL OR p_secret !~ '^[0-9a-f]{32,128}$')) THEN
    RAISE EXCEPTION 'invalid Companion trigger proposal' USING ERRCODE='22023';
  END IF;
  SELECT d.* INTO v_delivery FROM public.companion_decision_deliveries d
  JOIN public.companion_turn_attempts a ON a.org_id=d.org_id AND a.companion_id=d.companion_id AND a.id=d.attempt_id
  WHERE d.org_id=p_org_id AND d.companion_id=p_companion_id AND d.request_key=p_request_key
    AND d.decision_status='pending' AND a.status='needs_input'
  ORDER BY d.created_at DESC,d.id DESC LIMIT 1 FOR UPDATE OF d;
  IF NOT FOUND THEN
    SELECT * INTO v_delivery FROM public.companion_decision_deliveries d
    WHERE d.org_id=p_org_id AND d.companion_id=p_companion_id AND d.request_key=p_request_key
      AND d.actor_id=v_actor_id ORDER BY d.created_at DESC,d.id DESC LIMIT 1;
    IF NOT FOUND OR v_delivery.request_kind<>'trigger_proposal' OR NOT (
      (p_action='allow' AND v_delivery.decision_status='allowed') OR
      (p_action='deny' AND v_delivery.decision_status='denied')) THEN
      RAISE EXCEPTION 'Companion decision is not pending' USING ERRCODE='55000';
    END IF;
    RETURN QUERY SELECT v_delivery.id,v_delivery.turn_id,v_delivery.decision_status,
      v_delivery.delivery_state,v_delivery.responded_at; RETURN;
  END IF;
  IF v_delivery.request_kind<>'trigger_proposal' OR v_delivery.expires_at<=v_now THEN
    RAISE EXCEPTION 'Companion trigger proposal is not answerable' USING ERRCODE='55000';
  END IF;
  v_proposal:=v_delivery.proposal;
  IF v_proposal IS NULL OR jsonb_typeof(v_proposal)<>'object' OR v_proposal->>'kind'<>'trigger'
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(v_proposal) k
      WHERE k NOT IN ('kind','name','prompt','mode','provider','provider_account_id','target')) THEN
    RAISE EXCEPTION 'invalid Companion trigger proposal' USING ERRCODE='22023';
  END IF;
  v_name:=btrim(v_proposal->>'name'); v_prompt:=btrim(v_proposal->>'prompt');
  v_mode:=COALESCE(v_proposal->>'mode','relay'); v_provider:=COALESCE(v_proposal->>'provider','webhook');
  BEGIN v_account_id:=NULLIF(v_proposal->>'provider_account_id','')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'invalid Companion trigger proposal' USING ERRCODE='22023'; END;
  IF char_length(v_name) NOT BETWEEN 1 AND 80 OR v_name~E'[\n\r]'
    OR char_length(v_prompt) NOT BETWEEN 1 AND 16384 OR v_mode NOT IN ('notify','relay')
    OR v_provider NOT IN ('webhook','linear','github','sentry','custom') THEN
    RAISE EXCEPTION 'invalid Companion trigger proposal' USING ERRCODE='22023';
  END IF;
  IF v_account_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.companion_trigger_provider_accounts a
    WHERE a.org_id=p_org_id AND a.owner_id=v_actor_id AND a.id=v_account_id
      AND a.provider=v_provider AND a.status='connected'
  ) THEN
    v_account_id:=NULL;
  END IF;
  IF p_action='allow' THEN
    PERFORM public.companion_api_create_trigger(p_org_id,p_companion_id,p_trigger_id,v_name,v_prompt,
      v_mode,v_provider,v_account_id,COALESCE(v_proposal->'target','{}'::jsonb),p_secret,true);
  END IF;
  v_status:=CASE p_action WHEN 'allow' THEN 'allowed'::public.companion_decision_status
    ELSE 'denied'::public.companion_decision_status END;
  UPDATE public.companion_decision_deliveries d SET decision_status=v_status,actor_id=v_actor_id,
    response_text=NULL,responded_at=v_now,updated_at=v_now
  WHERE d.id=v_delivery.id AND d.org_id=p_org_id AND d.companion_id=p_companion_id
    AND d.decision_status='pending' RETURNING d.* INTO v_delivery;
  IF NOT FOUND THEN RAISE EXCEPTION 'Companion decision changed concurrently' USING ERRCODE='40001'; END IF;
  SELECT COALESCE(p.name,u.name,u.email) INTO v_actor_name FROM public."user" u
    LEFT JOIN public.profiles p ON p.id=u.id WHERE u.id=v_actor_id;
  SELECT e.event_id INTO v_event_id FROM public.companion_transcript_entries e
  WHERE e.org_id=p_org_id AND e.companion_id=p_companion_id AND e.role='decision'
    AND e.decision->>'request_id'=p_request_key AND e.decision->>'status'='pending'
  ORDER BY e.ordinal DESC LIMIT 1 FOR UPDATE;
  IF v_event_id IS NULL THEN RAISE EXCEPTION 'Companion decision transcript projection is missing' USING ERRCODE='55000'; END IF;
  UPDATE public.companion_transcript_entries e SET decision=e.decision||jsonb_build_object(
    'status',v_status,'answer',NULL,'decided_by_id',v_actor_id,'decided_by_name',v_actor_name,
    'decided_at',to_char(v_now AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
  WHERE e.org_id=p_org_id AND e.companion_id=p_companion_id AND e.event_id=v_event_id;
  RETURN QUERY SELECT v_delivery.id,v_delivery.turn_id,v_delivery.decision_status,
    v_delivery.delivery_state,v_delivery.responded_at;
END $$;
--> statement-breakpoint
