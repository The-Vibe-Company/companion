-- Directed delegation is ordinary Runtime v3 main-lane work. The durable delegation ledger is
-- retained, but its source execution identity and target/relay Turn references now point at v3
-- Turns. No attempt, lane, scheduler, or alternate harness is introduced.
ALTER TABLE public.companion_control_invocations
  DROP CONSTRAINT companion_control_invocations_attempt_fk,
  ADD CONSTRAINT companion_control_invocations_v3_turn_fk
    FOREIGN KEY (org_id, companion_id, source_turn_id)
    REFERENCES public.companion_v3_turns(org_id, companion_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT companion_control_invocations_v3_identity_check
    CHECK (source_attempt_id = source_turn_id);
--> statement-breakpoint

ALTER TABLE public.companion_control_requests
  DROP CONSTRAINT companion_control_requests_attempt_fk,
  DROP CONSTRAINT companion_control_requests_turn_fk,
  ADD CONSTRAINT companion_control_requests_v3_turn_fk
    FOREIGN KEY (org_id, companion_id, source_turn_id)
    REFERENCES public.companion_v3_turns(org_id, companion_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT companion_control_requests_v3_identity_check
    CHECK (source_attempt_id = source_turn_id);
--> statement-breakpoint

ALTER TABLE public.companion_v3_turns
  ADD COLUMN delegation_id uuid REFERENCES public.companion_delegations(id) ON DELETE SET NULL,
  ADD COLUMN delegation_return_id uuid REFERENCES public.companion_delegations(id) ON DELETE SET NULL,
  ADD COLUMN delegation_cancel_requested_at timestamptz,
  ADD COLUMN delegation_cancel_command_id uuid;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.companion_resolve_control_token(p_token_hash text)
RETURNS TABLE(org_id uuid,companion_id uuid,actor_id text,turn_id uuid,attempt_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_now timestamptz:=clock_timestamp();
BEGIN
  IF p_token_hash IS NULL OR p_token_hash!~'^[0-9a-f]{64}$' THEN RETURN; END IF;
  RETURN QUERY
  WITH resolved AS (
    SELECT token.id AS token_id,token.org_id,token.companion_id,
      (array_agg(turn_row.actor_id ORDER BY turn_row.id))[1] AS actor_id,
      (array_agg(turn_row.id ORDER BY turn_row.id))[1] AS turn_id
    FROM public.companion_control_tokens token
    JOIN public.companion_v3_instances instance
      ON instance.org_id=token.org_id AND instance.companion_id=token.companion_id
      AND instance.control_token_id=token.id AND instance.lifecycle_state='active'
      AND instance.desired_lifecycle='prepare'
    JOIN public.companion_v3_turns turn_row
      ON turn_row.org_id=instance.org_id AND turn_row.companion_id=instance.companion_id
      AND turn_row.pi_invocation_id=instance.pi_invocation_id
      AND turn_row.response_turn_id=turn_row.id
      AND turn_row.actor_id=token.staged_actor_id AND turn_row.lane='main'
      AND turn_row.state IN ('admitted','running','needs_input')
      AND turn_row.admission_state='accepted'
    JOIN public.memberships membership
      ON membership.org_id=token.org_id AND membership.user_id=turn_row.actor_id
    WHERE token.token_hash=p_token_hash AND token.revoked_at IS NULL AND token.expires_at>v_now
    GROUP BY token.id,token.org_id,token.companion_id
    HAVING count(*)=1
  )
  UPDATE public.companion_control_tokens token SET last_used_at=v_now
  FROM resolved
  WHERE token.id=resolved.token_id
  RETURNING resolved.org_id,resolved.companion_id,resolved.actor_id,
    resolved.turn_id,resolved.turn_id;
END $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.companion_api_create_control_request(
  p_org_id uuid,p_companion_id uuid,p_id uuid,p_turn_id uuid,p_attempt_id uuid,
  p_kind public.companion_control_request_kind,p_action text,p_summary text,p_payload jsonb,
  p_request_key text,p_request_digest text,p_required_access text
)
RETURNS SETOF public.companion_control_requests
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE
  v_actor text:=public.companion_api_actor(p_org_id);v_now timestamptz:=clock_timestamp();
  v_expires timestamptz:=v_now+interval '24 hours';v_ordinal integer;v_existing record;
BEGIN
  PERFORM public.companion_api_require_access(p_org_id,p_companion_id,
    CASE WHEN p_required_access='owner' THEN 'owner' ELSE 'editor' END);
  IF p_attempt_id IS DISTINCT FROM p_turn_id THEN
    RAISE EXCEPTION 'Runtime v3 control identity is invalid' USING ERRCODE='22023';
  END IF;
  IF p_request_key IS NULL OR char_length(p_request_key) NOT BETWEEN 1 AND 200
    OR p_request_key~E'[\n\r]' OR p_required_access NOT IN ('owner','editor') THEN
    RAISE EXCEPTION 'invalid control request' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_existing FROM public.companion_control_requests request
  WHERE request.org_id=p_org_id AND request.companion_id=p_companion_id
    AND request.source_attempt_id=p_attempt_id AND request.request_key=p_request_key FOR UPDATE;
  IF FOUND THEN
    IF v_existing.request_digest<>p_request_digest THEN
      RAISE EXCEPTION 'control request idempotency conflict' USING ERRCODE='23505';
    END IF;
    RETURN QUERY SELECT * FROM public.companion_control_requests request
    WHERE request.org_id=p_org_id AND request.companion_id=p_companion_id
      AND request.id=v_existing.id;
    RETURN;
  END IF;
  PERFORM 1 FROM public.companion_v3_turns turn_row
  WHERE turn_row.org_id=p_org_id AND turn_row.companion_id=p_companion_id
    AND turn_row.id=p_turn_id AND turn_row.actor_id=v_actor AND turn_row.lane='main'
    AND turn_row.state IN ('admitted','running','needs_input')
    AND turn_row.admission_state='accepted' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'control Turn is not active' USING ERRCODE='42501';END IF;
  INSERT INTO public.companion_control_requests(
    id,org_id,companion_id,source_turn_id,source_attempt_id,requested_by_id,kind,action,summary,
    payload,request_key,request_digest,required_access,expires_at
  ) VALUES(p_id,p_org_id,p_companion_id,p_turn_id,p_attempt_id,v_actor,p_kind,p_action,p_summary,
    p_payload,p_request_key,p_request_digest,p_required_access,v_expires);
  UPDATE public.companion_threads thread
  SET next_ordinal=thread.next_ordinal+1,last_message_at=v_now,updated_at=v_now
  WHERE thread.org_id=p_org_id AND thread.companion_id=p_companion_id
  RETURNING thread.next_ordinal-1 INTO v_ordinal;
  IF NOT FOUND THEN RAISE EXCEPTION 'Companion thread is unavailable' USING ERRCODE='55000';END IF;
  INSERT INTO public.companion_transcript_entries(
    org_id,companion_id,event_id,ordinal,role,content,decision,author_id,turn_id,created_at
  ) VALUES(
    p_org_id,p_companion_id,'control:'||p_id::text,v_ordinal,'decision','',
    jsonb_build_object('request_id',p_id::text,'kind','control','name',p_action,'title',p_summary,
      'detail',NULL,'status','pending','answer',NULL,'decided_by_id',NULL,'decided_by_name',NULL,
      'decided_at',NULL,'expires_at',to_char(v_expires AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'required_access',p_required_access,'control_status','pending',
      'proposal',jsonb_build_object('kind','control','request_kind',p_kind,'action',p_action,
        'summary',p_summary,'payload',p_payload)),
    NULL,NULL,v_now
  );
  RETURN QUERY SELECT * FROM public.companion_control_requests request
  WHERE request.org_id=p_org_id AND request.companion_id=p_companion_id AND request.id=p_id;
END $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.companion_api_register_control_invocation(
  p_org_id uuid,p_companion_id uuid,p_id uuid,p_turn_id uuid,p_attempt_id uuid,
  p_request_key text,p_request_digest text
)
RETURNS TABLE(replayed boolean,result jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_actor text:=public.companion_api_actor(p_org_id); v_existing record;
BEGIN
  PERFORM public.companion_api_require_access(p_org_id,p_companion_id,'editor');
  IF p_attempt_id IS DISTINCT FROM p_turn_id THEN
    RAISE EXCEPTION 'Runtime v3 control identity is invalid' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_companion_id::text||':'||p_turn_id::text||':'||p_request_key,0
  ));
  SELECT * INTO v_existing FROM public.companion_control_invocations invocation
  WHERE invocation.companion_id=p_companion_id
    AND invocation.source_turn_id=p_turn_id AND invocation.request_key=p_request_key FOR UPDATE;
  IF FOUND THEN
    IF v_existing.request_digest<>p_request_digest THEN
      RAISE EXCEPTION 'control invocation idempotency conflict' USING ERRCODE='23505';
    END IF;
    IF v_existing.result IS NULL THEN
      RAISE EXCEPTION 'control invocation replay is incomplete' USING ERRCODE='55000';
    END IF;
    RETURN QUERY SELECT true,v_existing.result; RETURN;
  END IF;
  PERFORM 1 FROM public.companion_v3_turns turn_row
  WHERE turn_row.org_id=p_org_id AND turn_row.companion_id=p_companion_id
    AND turn_row.id=p_turn_id AND turn_row.actor_id=v_actor AND turn_row.lane='main'
    AND turn_row.state IN ('admitted','running','needs_input')
    AND turn_row.admission_state='accepted' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'control Turn is not active' USING ERRCODE='42501'; END IF;
  INSERT INTO public.companion_control_invocations(
    id,org_id,companion_id,source_turn_id,source_attempt_id,request_key,request_digest
  ) VALUES(p_id,p_org_id,p_companion_id,p_turn_id,p_turn_id,p_request_key,p_request_digest);
  RETURN QUERY SELECT false,NULL::jsonb;
END $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.companion_api_record_delegation(
  p_org_id uuid,p_source uuid,p_target uuid,p_source_turn uuid,p_source_attempt uuid,
  p_target_turn uuid,p_id uuid,p_response_mode public.companion_routine_surface_mode,
  p_request_key text,p_request_digest text
)
RETURNS SETOF public.companion_delegations
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE
  v_actor text:=public.companion_api_actor(p_org_id); v_source_name text; v_target_name text;
  v_parent uuid; v_root uuid; v_depth integer; v_existing public.companion_delegations%ROWTYPE;
  v_target_state public.companion_v3_turn_state; v_source_owner text;
BEGIN
  PERFORM public.companion_api_require_access(p_org_id,p_source,'editor');
  PERFORM public.companion_api_require_access(p_org_id,p_target,'editor');
  IF p_source=p_target THEN RAISE EXCEPTION 'self delegation is not allowed' USING ERRCODE='22023'; END IF;
  IF p_source_attempt IS DISTINCT FROM p_source_turn THEN
    RAISE EXCEPTION 'Runtime v3 delegation identity is invalid' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_existing FROM public.companion_delegations delegation
  WHERE delegation.org_id=p_org_id AND delegation.source_companion_id=p_source
    AND delegation.source_turn_id=p_source_turn AND delegation.request_key=p_request_key FOR UPDATE;
  IF FOUND THEN
    IF v_existing.request_digest<>p_request_digest OR v_existing.target_turn_id<>p_target_turn
      OR v_existing.target_companion_id IS DISTINCT FROM p_target
      OR v_existing.response_mode IS DISTINCT FROM p_response_mode THEN
      RAISE EXCEPTION 'delegation idempotency conflict' USING ERRCODE='23505';
    END IF;
    RETURN QUERY SELECT * FROM public.companion_delegations delegation
    WHERE delegation.org_id=p_org_id AND delegation.id=v_existing.id;
    RETURN;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.companion_peer_grants grant_row WHERE grant_row.org_id=p_org_id
    AND grant_row.source_companion_id=p_source AND grant_row.target_companion_id=p_target
    AND grant_row.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'peer access is not approved' USING ERRCODE='42501';
  END IF;
  SELECT source_companion.name,target_companion.name,source_turn.delegation_id,
         target_turn.state,source_companion.owner_id
  INTO v_source_name,v_target_name,v_parent,v_target_state,v_source_owner
  FROM public.companions source_companion,public.companions target_companion,
       public.companion_v3_turns source_turn,public.companion_v3_turns target_turn
  WHERE source_companion.org_id=p_org_id AND source_companion.id=p_source
    AND target_companion.org_id=p_org_id AND target_companion.id=p_target
    AND source_turn.org_id=p_org_id AND source_turn.companion_id=p_source
    AND source_turn.id=p_source_turn AND source_turn.actor_id=v_actor AND source_turn.lane='main'
    AND source_turn.state IN ('admitted','running','needs_input')
    AND source_turn.admission_state='accepted'
    AND target_turn.org_id=p_org_id AND target_turn.companion_id=p_target
    AND target_turn.id=p_target_turn AND target_turn.lane='main';
  IF NOT FOUND THEN RAISE EXCEPTION 'delegation Turns are unavailable' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.memberships membership
    WHERE membership.org_id=p_org_id AND membership.user_id=v_source_owner)
    OR NOT EXISTS(
      SELECT 1 FROM public.companions target_companion
      LEFT JOIN public.companion_workspace_access access
        ON access.org_id=target_companion.org_id AND access.companion_id=target_companion.id
        AND access.role='editor'
      WHERE target_companion.org_id=p_org_id AND target_companion.id=p_target
        AND (target_companion.owner_id=v_source_owner OR access.owner_id=v_source_owner)
    ) THEN
    RAISE EXCEPTION 'source owner cannot operate target Companion' USING ERRCODE='42501';
  END IF;
  IF v_parent IS NULL THEN v_root:=p_source_turn; v_depth:=1;
  ELSE
    SELECT delegation.root_turn_id,delegation.depth+1 INTO v_root,v_depth
    FROM public.companion_delegations delegation
    WHERE delegation.org_id=p_org_id AND delegation.id=v_parent;
    IF NOT FOUND THEN RAISE EXCEPTION 'delegation parent is unavailable' USING ERRCODE='42501'; END IF;
  END IF;
  IF v_depth>4 THEN RAISE EXCEPTION 'delegation depth exceeded' USING ERRCODE='54000'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_root::text,0));
  IF (SELECT count(*) FROM public.companion_delegations delegation
      WHERE delegation.org_id=p_org_id AND delegation.root_turn_id=v_root)>=20 THEN
    RAISE EXCEPTION 'delegation budget exceeded' USING ERRCODE='54000';
  END IF;
  INSERT INTO public.companion_delegations(
    id,org_id,source_companion_id,source_companion_name,target_companion_id,target_companion_name,
    actor_id,source_turn_id,source_attempt_id,target_turn_id,root_turn_id,parent_delegation_id,depth,
    response_mode,status,request_key,request_digest
  ) VALUES(
    p_id,p_org_id,p_source,v_source_name,p_target,v_target_name,v_actor,p_source_turn,p_source_turn,
    p_target_turn,v_root,v_parent,v_depth,p_response_mode,
    v_target_state::text::public.companion_turn_status,p_request_key,p_request_digest
  );
  UPDATE public.companion_v3_turns SET delegation_id=p_id
  WHERE org_id=p_org_id AND companion_id=p_target AND id=p_target_turn;
  UPDATE public.companion_transcript_entries SET delegation=jsonb_build_object(
    'id',p_id,'direction','request','companion_id',p_source,'companion_name',v_source_name,
    'response_mode',p_response_mode,'status',v_target_state,'delivery_status','pending')
  WHERE org_id=p_org_id AND companion_id=p_target AND role='user'
    AND event_id=(SELECT turn_row.message_event_id FROM public.companion_v3_turns turn_row
      WHERE turn_row.org_id=p_org_id AND turn_row.companion_id=p_target
        AND turn_row.id=p_target_turn);
  RETURN QUERY SELECT * FROM public.companion_delegations delegation
  WHERE delegation.org_id=p_org_id AND delegation.id=p_id;
END $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.companion_api_enqueue_delegation(
  p_org_id uuid,p_source uuid,p_target uuid,p_source_turn uuid,p_source_attempt uuid,
  p_target_client_message_id uuid,p_content text,p_id uuid,
  p_response_mode public.companion_routine_surface_mode,p_request_key text,p_request_digest text
)
RETURNS TABLE(delegation jsonb,target_turn jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_enqueued record; v_delegation public.companion_delegations%ROWTYPE;
BEGIN
  PERFORM public.companion_api_require_access(p_org_id,p_source,'editor');
  PERFORM public.companion_api_require_access(p_org_id,p_target,'editor');
  IF p_source=p_target THEN RAISE EXCEPTION 'self delegation is not allowed' USING ERRCODE='22023'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.companion_peer_grants grant_row WHERE grant_row.org_id=p_org_id
    AND grant_row.source_companion_id=p_source AND grant_row.target_companion_id=p_target
    AND grant_row.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'peer access is not approved' USING ERRCODE='42501';
  END IF;
  SELECT * INTO v_enqueued FROM public.companion_v3_api_enqueue_warm_turn(
    p_org_id,p_target,p_target_client_message_id,p_content
  );
  IF NOT FOUND THEN RAISE EXCEPTION 'target Runtime v3 Turn is unavailable' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_delegation FROM public.companion_api_record_delegation(
    p_org_id,p_source,p_target,p_source_turn,p_source_attempt,
    (v_enqueued.turn->>'id')::uuid,p_id,p_response_mode,p_request_key,p_request_digest
  );
  RETURN QUERY SELECT to_jsonb(v_delegation),v_enqueued.turn;
END $$;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_mark_delegation_delivery_failed(
  p_org_id uuid,p_delegation_id uuid,p_target_turn_id uuid,p_code text
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE
  v_delegation public.companion_delegations%ROWTYPE; v_event text;
  v_ordinal integer; v_projection bigint; v_now timestamptz:=clock_timestamp();
BEGIN
  IF p_code IS NULL OR p_code!~'^[a-z][a-z0-9_]{0,63}$' THEN
    RAISE EXCEPTION 'invalid delegation delivery failure' USING ERRCODE='22023';
  END IF;
  SELECT * INTO STRICT v_delegation FROM public.companion_delegations delegation
  WHERE delegation.org_id=p_org_id AND delegation.id=p_delegation_id FOR UPDATE;
  UPDATE public.companion_delegations SET delivery_status='failed',delivery_error_code=p_code,
    updated_at=v_now WHERE org_id=p_org_id AND id=p_delegation_id AND delivery_status='pending';
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE public.companion_threads thread SET projection_sequence=thread.projection_sequence+1,
    updated_at=v_now WHERE thread.org_id=p_org_id
    AND thread.companion_id=v_delegation.target_companion_id
  RETURNING thread.projection_sequence INTO v_projection;
  IF FOUND THEN
    UPDATE public.companion_transcript_entries entry
    SET delegation=entry.delegation||jsonb_build_object(
      'status',v_delegation.status,'delivery_status','failed','delivery_error_code',p_code
    ),projection_sequence=v_projection
    WHERE entry.org_id=p_org_id AND entry.companion_id=v_delegation.target_companion_id
      AND entry.role='user' AND entry.delegation IS NOT NULL
      AND entry.event_id=(SELECT turn_row.message_event_id FROM public.companion_v3_turns turn_row
        WHERE turn_row.org_id=p_org_id
          AND turn_row.companion_id=v_delegation.target_companion_id
          AND turn_row.id=p_target_turn_id);
  END IF;
  IF v_delegation.source_companion_id IS NULL THEN RETURN; END IF;
  v_event:='delegation:'||p_delegation_id::text||':delivery-failed';
  IF EXISTS(SELECT 1 FROM public.companion_transcript_entries entry
    WHERE entry.companion_id=v_delegation.source_companion_id AND entry.event_id=v_event) THEN
    UPDATE public.companion_delegations SET source_result_event_id=v_event
    WHERE org_id=p_org_id AND id=p_delegation_id;
    RETURN;
  END IF;
  UPDATE public.companion_threads thread
  SET next_ordinal=thread.next_ordinal+1,projection_sequence=thread.projection_sequence+1,
      last_message_at=v_now,updated_at=v_now
  WHERE thread.org_id=p_org_id AND thread.companion_id=v_delegation.source_companion_id
  RETURNING thread.next_ordinal-1,thread.projection_sequence INTO v_ordinal,v_projection;
  IF NOT FOUND THEN RETURN; END IF;
  INSERT INTO public.companion_transcript_entries(
    org_id,companion_id,event_id,ordinal,projection_sequence,role,content,delegation,created_at
  ) VALUES(
    p_org_id,v_delegation.source_companion_id,v_event,v_ordinal,v_projection,'assistant',
    'The result from '||v_delegation.target_companion_name||
      ' remains in its thread, but could not be returned here.',
    jsonb_build_object('id',p_delegation_id,'direction','response',
      'companion_id',v_delegation.target_companion_id,
      'companion_name',v_delegation.target_companion_name,
      'response_mode',v_delegation.response_mode,'status',v_delegation.status,
      'delivery_status','failed','delivery_error_code',p_code),v_now
  );
  UPDATE public.companion_delegations SET source_result_event_id=v_event
  WHERE org_id=p_org_id AND id=p_delegation_id;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_mark_delegation_delivery_failed(uuid,uuid,uuid,text)
  FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_surface_delegation_result()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE
  v_delegation public.companion_delegations%ROWTYPE; v_content text; v_event text;
  v_ordinal integer; v_projection bigint; v_client uuid:=gen_random_uuid();
  v_enqueued record; v_relay uuid; v_source_owner text; v_delivery_error text;
  v_now timestamptz:=COALESCE(NEW.settled_at,clock_timestamp());
BEGIN
  IF NEW.delegation_id IS NULL OR NEW.state=OLD.state THEN RETURN NEW; END IF;
  SELECT * INTO v_delegation FROM public.companion_delegations delegation
  WHERE delegation.org_id=NEW.org_id AND delegation.id=NEW.delegation_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF;
  UPDATE public.companion_delegations SET status=CASE NEW.state
      WHEN 'admitted' THEN 'dispatching'::public.companion_turn_status
      ELSE NEW.state::text::public.companion_turn_status
    END,
    settled_at=CASE WHEN NEW.state IN ('succeeded','failed','interrupted','cancelled')
      THEN v_now ELSE NULL END,updated_at=clock_timestamp()
  WHERE org_id=v_delegation.org_id AND id=v_delegation.id;
  UPDATE public.companion_threads thread SET projection_sequence=thread.projection_sequence+1,
    updated_at=clock_timestamp()
  WHERE thread.org_id=NEW.org_id AND thread.companion_id=NEW.companion_id
  RETURNING thread.projection_sequence INTO v_projection;
  UPDATE public.companion_transcript_entries entry
  SET delegation=entry.delegation||jsonb_build_object('status',NEW.state),
      projection_sequence=COALESCE(v_projection,entry.projection_sequence)
  WHERE entry.org_id=NEW.org_id AND entry.companion_id=NEW.companion_id
    AND entry.event_id=NEW.message_event_id AND entry.role='user' AND entry.delegation IS NOT NULL;
  IF NEW.state NOT IN ('succeeded','failed','interrupted','cancelled')
    OR v_delegation.delivery_status<>'pending' THEN RETURN NEW; END IF;

  IF v_delegation.source_companion_id IS NULL OR v_delegation.target_companion_id IS NULL THEN
    v_delivery_error:='delegation_companion_unavailable';
  ELSIF v_delegation.depth NOT BETWEEN 1 AND 4
    OR (SELECT count(*) FROM public.companion_delegations descendant
        WHERE descendant.org_id=v_delegation.org_id
          AND descendant.root_turn_id=v_delegation.root_turn_id)>20 THEN
    v_delivery_error:='delegation_bounds_invalid';
  ELSIF NOT EXISTS(SELECT 1 FROM public.companion_peer_grants grant_row
    WHERE grant_row.org_id=v_delegation.org_id
      AND grant_row.source_companion_id=v_delegation.source_companion_id
      AND grant_row.target_companion_id=v_delegation.target_companion_id
      AND grant_row.revoked_at IS NULL) THEN
    v_delivery_error:='peer_access_revoked';
  ELSIF NOT EXISTS(SELECT 1 FROM public.memberships membership
    WHERE membership.org_id=v_delegation.org_id AND membership.user_id=v_delegation.actor_id) THEN
    v_delivery_error:='delegation_actor_revoked';
  ELSE
    PERFORM set_config('app.org_id',v_delegation.org_id::text,true);
    PERFORM set_config('app.user_id',v_delegation.actor_id,true);
    BEGIN
      PERFORM public.companion_api_require_access(
        v_delegation.org_id,v_delegation.source_companion_id,'editor');
      PERFORM public.companion_api_require_access(
        v_delegation.org_id,v_delegation.target_companion_id,'editor');
    EXCEPTION WHEN OTHERS THEN v_delivery_error:='delegation_access_revoked'; END;
    SELECT companion.owner_id INTO v_source_owner FROM public.companions companion
    WHERE companion.org_id=v_delegation.org_id
      AND companion.id=v_delegation.source_companion_id;
    IF v_delivery_error IS NULL AND (v_source_owner IS NULL
      OR NOT EXISTS(SELECT 1 FROM public.memberships membership
        WHERE membership.org_id=v_delegation.org_id AND membership.user_id=v_source_owner)
      OR NOT EXISTS(
        SELECT 1 FROM public.companions target_companion
        LEFT JOIN public.companion_workspace_access access
          ON access.org_id=target_companion.org_id AND access.companion_id=target_companion.id
          AND access.role='editor'
        WHERE target_companion.org_id=v_delegation.org_id
          AND target_companion.id=v_delegation.target_companion_id
          AND (target_companion.owner_id=v_source_owner OR access.owner_id=v_source_owner)
      )) THEN v_delivery_error:='source_owner_access_revoked'; END IF;
  END IF;
  IF v_delivery_error IS NOT NULL THEN
    PERFORM public.companion_v3_mark_delegation_delivery_failed(
      v_delegation.org_id,v_delegation.id,NEW.id,v_delivery_error);
    RETURN NEW;
  END IF;

  SELECT left(entry.content,16384) INTO v_content
  FROM public.companion_transcript_entries entry
  WHERE entry.org_id=v_delegation.org_id AND entry.companion_id=NEW.companion_id
    AND entry.event_id LIKE 'v3:'||COALESCE(NEW.response_turn_id,NEW.id)::text||':%'
    AND entry.role='assistant'
  ORDER BY entry.ordinal DESC LIMIT 1;
  v_content:=COALESCE(NULLIF(v_content,''),CASE NEW.state
    WHEN 'succeeded' THEN v_delegation.target_companion_name||
      ' completed the delegation without a text response.'
    ELSE v_delegation.target_companion_name||' ended the delegation with status '
      ||NEW.state::text||'.' END);
  IF v_delegation.response_mode='relay' THEN
    BEGIN
      SELECT * INTO v_enqueued FROM public.companion_v3_api_enqueue_warm_turn(
        v_delegation.org_id,v_delegation.source_companion_id,v_client,
        'Delegated response from '||v_delegation.target_companion_name||E':\n\n'||left(
          v_content,16384-char_length(
            'Delegated response from '||v_delegation.target_companion_name||E':\n\n'))
      );
      IF NOT FOUND THEN v_delivery_error:='source_turn_unavailable';
      ELSE v_relay:=(v_enqueued.turn->>'id')::uuid; END IF;
    EXCEPTION WHEN OTHERS THEN v_delivery_error:='source_turn_unavailable'; END;
    IF v_delivery_error IS NOT NULL THEN
      PERFORM public.companion_v3_mark_delegation_delivery_failed(
        v_delegation.org_id,v_delegation.id,NEW.id,v_delivery_error);
      RETURN NEW;
    END IF;
    UPDATE public.companion_v3_turns SET delegation_return_id=v_delegation.id
    WHERE org_id=v_delegation.org_id AND companion_id=v_delegation.source_companion_id
      AND id=v_relay AND lane='main';
    UPDATE public.companion_transcript_entries entry SET delegation=jsonb_build_object(
      'id',v_delegation.id,'direction','response',
      'companion_id',v_delegation.target_companion_id,
      'companion_name',v_delegation.target_companion_name,
      'response_mode',v_delegation.response_mode,'status',NEW.state,
      'delivery_status','delivered')
    WHERE entry.org_id=v_delegation.org_id
      AND entry.companion_id=v_delegation.source_companion_id
      AND entry.event_id=(SELECT turn_row.message_event_id FROM public.companion_v3_turns turn_row
        WHERE turn_row.org_id=v_delegation.org_id
          AND turn_row.companion_id=v_delegation.source_companion_id AND turn_row.id=v_relay)
      AND entry.role='user';
    v_event:='msg:'||v_client::text;
  ELSE
    UPDATE public.companion_threads thread
    SET next_ordinal=thread.next_ordinal+1,projection_sequence=thread.projection_sequence+1,
        last_message_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE thread.org_id=v_delegation.org_id
      AND thread.companion_id=v_delegation.source_companion_id
    RETURNING thread.next_ordinal-1,thread.projection_sequence INTO v_ordinal,v_projection;
    IF NOT FOUND THEN
      PERFORM public.companion_v3_mark_delegation_delivery_failed(
        v_delegation.org_id,v_delegation.id,NEW.id,'source_thread_unavailable');
      RETURN NEW;
    END IF;
    v_event:='delegation:'||v_delegation.id::text||':response';
    INSERT INTO public.companion_transcript_entries(
      org_id,companion_id,event_id,ordinal,projection_sequence,role,content,delegation,created_at
    ) VALUES(
      v_delegation.org_id,v_delegation.source_companion_id,v_event,v_ordinal,v_projection,
      'assistant',v_content,jsonb_build_object('id',v_delegation.id,'direction','response',
        'companion_id',v_delegation.target_companion_id,
        'companion_name',v_delegation.target_companion_name,
        'response_mode',v_delegation.response_mode,'status',NEW.state,
        'delivery_status','delivered'),clock_timestamp()
    );
  END IF;
  UPDATE public.companion_delegations SET delivery_status='delivered',
    source_result_event_id=v_event,source_relay_turn_id=v_relay,
    delivered_at=clock_timestamp(),updated_at=clock_timestamp()
  WHERE org_id=v_delegation.org_id AND id=v_delegation.id AND delivery_status='pending';
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_surface_delegation_result() FROM PUBLIC;
CREATE TRIGGER companion_v3_turns_surface_delegation_result
AFTER UPDATE OF state ON public.companion_v3_turns FOR EACH ROW
EXECUTE FUNCTION public.companion_v3_surface_delegation_result();
--> statement-breakpoint

-- Queued cancellation is immediately terminal. Accepted cancellation is durable intent consumed
-- by the ordinary fenced main-Turn progression, which aborts Pi before terminalizing the response.
CREATE FUNCTION public.companion_v3_api_cancel_delegation_turn(
  p_org_id uuid,p_source_companion_id uuid,p_delegation_id uuid
) RETURNS TABLE(turn jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE
  v_delegation public.companion_delegations%ROWTYPE;
  v_turn public.companion_v3_turns%ROWTYPE;
  v_now timestamptz:=clock_timestamp();
BEGIN
  PERFORM public.companion_api_require_access(p_org_id,p_source_companion_id,'editor');
  SELECT * INTO v_delegation FROM public.companion_delegations delegation
  WHERE delegation.org_id=p_org_id AND delegation.source_companion_id=p_source_companion_id
    AND delegation.id=p_delegation_id;
  IF NOT FOUND OR v_delegation.target_companion_id IS NULL THEN
    RAISE EXCEPTION 'Delegation not found' USING ERRCODE='22023';
  END IF;
  PERFORM 1 FROM public.companion_v3_lane_leases lease
  WHERE lease.org_id=p_org_id AND lease.companion_id=v_delegation.target_companion_id
    AND lease.lane='main' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Delegation target Turn not found' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_turn FROM public.companion_v3_turns turn_row
  WHERE turn_row.org_id=p_org_id
    AND turn_row.companion_id=v_delegation.target_companion_id
    AND turn_row.id=v_delegation.target_turn_id AND turn_row.lane='main'
    AND turn_row.delegation_id=v_delegation.id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Delegation target Turn not found' USING ERRCODE='22023'; END IF;
  IF v_turn.state='queued' AND v_turn.admission_state='pending'
    AND v_turn.admission_started_at IS NULL THEN
    UPDATE public.companion_v3_turns turn_row SET state='cancelled',outcome='cancelled',
      outcome_code=NULL,outcome_message=NULL,outcome_action=NULL,
      inactivity_deadline_at=NULL,absolute_deadline_at=NULL,settled_at=v_now,updated_at=v_now
    WHERE turn_row.org_id=p_org_id AND turn_row.companion_id=v_delegation.target_companion_id
      AND turn_row.id=v_turn.id RETURNING * INTO v_turn;
  ELSIF v_turn.state IN ('queued','admitted','running','needs_input') THEN
    UPDATE public.companion_v3_turns turn_row SET
      delegation_cancel_requested_at=COALESCE(turn_row.delegation_cancel_requested_at,v_now),
      delegation_cancel_command_id=COALESCE(turn_row.delegation_cancel_command_id,gen_random_uuid()),
      updated_at=v_now
    WHERE turn_row.org_id=p_org_id AND turn_row.companion_id=v_delegation.target_companion_id
      AND turn_row.id=v_turn.id RETURNING * INTO v_turn;
  END IF;
  turn:=public.companion_v3_public_turn(v_turn); RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_api_cancel_delegation_turn(uuid,uuid,uuid) FROM PUBLIC;
--> statement-breakpoint

-- Serialize native projection with directed cancellation on the lane row. If cancellation commits
-- first, no assistant page or terminal result may be projected; the next fenced tick aborts Pi and
-- consumes the durable intent. If projection commits first, API cancellation observes a terminal
-- Turn after taking the same lock and remains a stable no-op.
CREATE FUNCTION public.companion_v3_runtime_project_native_page_v7(
  p_org_id uuid,p_companion_id uuid,p_lane public.companion_v3_lane,p_turn_id uuid,
  p_claim_token uuid,p_claim_epoch bigint,p_gate_epoch bigint,p_through_cursor bigint,
  p_assistant jsonb,p_compactions jsonb,p_decisions jsonb,p_needs_input boolean,
  p_correlated_activity boolean,p_terminal text,p_protocol integer
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_now timestamptz:=clock_timestamp();v_response_turn_id uuid;
BEGIN
  IF p_protocol<>7 THEN
    RAISE EXCEPTION 'Runtime v3 protocol 7 is required' USING ERRCODE='42501';
  END IF;
  SELECT COALESCE(claimed_turn.response_turn_id,claimed_turn.id) INTO v_response_turn_id
  FROM public.companion_v3_lane_leases lease
  JOIN public.companion_runtime_control control ON control.id='runtime-v2'
    AND control.enabled AND control.gate_epoch=p_gate_epoch
  JOIN public.companion_v3_turns claimed_turn ON claimed_turn.org_id=lease.org_id
    AND claimed_turn.companion_id=lease.companion_id AND claimed_turn.id=lease.turn_id
    AND claimed_turn.lane=p_lane AND claimed_turn.admission_state='accepted'
    AND claimed_turn.state IN ('admitted','running','needs_input')
  WHERE lease.org_id=p_org_id AND lease.companion_id=p_companion_id AND lease.lane=p_lane
    AND lease.turn_id=p_turn_id AND lease.claim_token=p_claim_token
    AND lease.claim_epoch=p_claim_epoch AND lease.gate_epoch=p_gate_epoch
    AND lease.expires_at>v_now
  FOR UPDATE OF lease,claimed_turn;
  IF NOT FOUND THEN RETURN NULL;END IF;
  IF p_lane='main' AND EXISTS (
    SELECT 1 FROM public.companion_v3_turns candidate
    WHERE candidate.org_id=p_org_id AND candidate.companion_id=p_companion_id
      AND candidate.lane='main' AND candidate.admission_state='accepted'
      AND candidate.state IN ('admitted','running','needs_input')
      AND (candidate.id=v_response_turn_id OR candidate.response_turn_id=v_response_turn_id)
      AND candidate.delegation_id IS NOT NULL
      AND candidate.delegation_cancel_requested_at IS NOT NULL
      AND candidate.delegation_cancel_command_id IS NOT NULL
  ) THEN RETURN 'cancel_pending';END IF;
  RETURN public.companion_v3_runtime_project_native_page_v6(
    p_org_id,p_companion_id,p_lane,p_turn_id,p_claim_token,p_claim_epoch,p_gate_epoch,
    p_through_cursor,p_assistant,p_compactions,p_decisions,p_needs_input,
    p_correlated_activity,p_terminal,6);
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_runtime_project_native_page_v7(
  uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,bigint,jsonb,jsonb,jsonb,
  boolean,boolean,text,integer) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_runtime_pending_delegation_cancel(
  p_org_id uuid,p_companion_id uuid,p_turn_id uuid,p_claim_token uuid,
  p_claim_epoch bigint,p_gate_epoch bigint,p_protocol integer
) RETURNS TABLE(turn_id uuid,response_turn_id uuid,command_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_now timestamptz:=clock_timestamp();
BEGIN
  IF p_protocol<>7 THEN
    RAISE EXCEPTION 'Runtime v3 protocol 7 is required' USING ERRCODE='42501';
  END IF;
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
    AND candidate.delegation_id IS NOT NULL
    AND candidate.delegation_cancel_requested_at IS NOT NULL
    AND candidate.delegation_cancel_command_id IS NOT NULL
  WHERE lease.org_id=p_org_id AND lease.companion_id=p_companion_id AND lease.lane='main'
    AND lease.turn_id=p_turn_id AND lease.claim_token=p_claim_token
    AND lease.claim_epoch=p_claim_epoch AND lease.gate_epoch=p_gate_epoch
    AND lease.expires_at>v_now
  ORDER BY candidate.delegation_cancel_requested_at,candidate.id
  LIMIT 1;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_runtime_pending_delegation_cancel(
  uuid,uuid,uuid,uuid,bigint,bigint,integer) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_runtime_finish_delegation_cancel(
  p_org_id uuid,p_companion_id uuid,p_turn_id uuid,p_cancel_turn_id uuid,
  p_claim_token uuid,p_claim_epoch bigint,p_gate_epoch bigint,p_protocol integer
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_now timestamptz:=clock_timestamp();v_response_turn_id uuid;
BEGIN
  PERFORM pg_catalog.set_config('app.companion_runtime_protocol','2',true);
  IF p_protocol<>7 THEN
    RAISE EXCEPTION 'Runtime v3 protocol 7 is required' USING ERRCODE='42501';
  END IF;
  SELECT root_turn.id INTO v_response_turn_id
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
  JOIN public.companion_v3_turns requested ON requested.org_id=root_turn.org_id
    AND requested.companion_id=root_turn.companion_id AND requested.id=p_cancel_turn_id
    AND requested.lane='main' AND requested.admission_state='accepted'
    AND requested.state IN ('admitted','running','needs_input')
    AND (requested.id=root_turn.id OR requested.response_turn_id=root_turn.id)
    AND requested.delegation_id IS NOT NULL
    AND requested.delegation_cancel_requested_at IS NOT NULL
    AND requested.delegation_cancel_command_id IS NOT NULL
  WHERE lease.org_id=p_org_id AND lease.companion_id=p_companion_id AND lease.lane='main'
    AND lease.turn_id=p_turn_id AND lease.claim_token=p_claim_token
    AND lease.claim_epoch=p_claim_epoch AND lease.gate_epoch=p_gate_epoch
    AND lease.expires_at>v_now
  FOR UPDATE OF lease,claimed_turn,root_turn,requested;
  IF NOT FOUND THEN RETURN false;END IF;
  UPDATE public.companion_v3_turns turn_row SET state='cancelled',outcome='cancelled',
    outcome_code=NULL,outcome_message=NULL,outcome_action=NULL,
    inactivity_deadline_at=NULL,absolute_deadline_at=NULL,settled_at=v_now,updated_at=v_now
  WHERE turn_row.org_id=p_org_id AND turn_row.companion_id=p_companion_id
    AND turn_row.lane='main' AND turn_row.admission_state='accepted'
    AND turn_row.state IN ('admitted','running','needs_input')
    AND (turn_row.id=v_response_turn_id OR turn_row.response_turn_id=v_response_turn_id);
  IF NOT FOUND THEN RETURN false;END IF;
  UPDATE public.companion_threads SET projection_sequence=projection_sequence+1,updated_at=v_now
  WHERE org_id=p_org_id AND companion_id=p_companion_id;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_runtime_finish_delegation_cancel(
  uuid,uuid,uuid,uuid,uuid,bigint,bigint,integer) FROM PUBLIC;
--> statement-breakpoint

DO $companion_v3_delegation_cancel_acl$
DECLARE v_source oid:=pg_catalog.to_regprocedure(
  'public.companion_api_enqueue_delegation(uuid,uuid,uuid,uuid,uuid,uuid,text,uuid,public.companion_routine_surface_mode,text,text)');
  v_grantee oid;v_role name;
BEGIN
  FOR v_grantee IN SELECT DISTINCT acl.grantee FROM pg_catalog.pg_proc source_proc
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(source_proc.proacl,pg_catalog.acldefault('f',source_proc.proowner))) acl
    WHERE source_proc.oid=v_source AND acl.privilege_type='EXECUTE'
      AND acl.grantee<>source_proc.proowner
  LOOP
    SELECT rolname INTO v_role FROM pg_catalog.pg_roles WHERE oid=v_grantee;
    IF v_role IS NOT NULL THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_v3_api_cancel_delegation_turn(uuid,uuid,uuid) TO %I',v_role);
    END IF;
  END LOOP;
END $companion_v3_delegation_cancel_acl$;
--> statement-breakpoint

DO $companion_v3_delegation_runtime_acl$
DECLARE v_source oid:=pg_catalog.to_regprocedure(
  'public.companion_v3_runtime_authorize_warm_turn_v7(uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,integer)');
  v_grantee oid;v_role name;
BEGIN
  FOR v_grantee IN SELECT DISTINCT acl.grantee FROM pg_catalog.pg_proc source_proc
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(source_proc.proacl,pg_catalog.acldefault('f',source_proc.proowner))) acl
    WHERE source_proc.oid=v_source AND acl.privilege_type='EXECUTE'
      AND acl.grantee<>source_proc.proowner
  LOOP
    SELECT rolname INTO v_role FROM pg_catalog.pg_roles WHERE oid=v_grantee;
    IF v_role IS NOT NULL THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_v3_runtime_pending_delegation_cancel(uuid,uuid,uuid,uuid,bigint,bigint,integer) TO %I',v_role);
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_v3_runtime_finish_delegation_cancel(uuid,uuid,uuid,uuid,uuid,bigint,bigint,integer) TO %I',v_role);
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_v3_runtime_project_native_page_v7(uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,bigint,jsonb,jsonb,jsonb,boolean,boolean,text,integer) TO %I',v_role);
    END IF;
  END LOOP;
END $companion_v3_delegation_runtime_acl$;
--> statement-breakpoint
