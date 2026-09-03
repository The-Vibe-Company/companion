-- Webhook triggers become ordinary Runtime v3 background occurrences. They share the exact FIFO,
-- lease, retry, private-history, and terminal bridge substrate introduced for routines, while an
-- explicit trigger origin keeps authorization and Pi staging capability-free.
ALTER TABLE public.companion_v3_routine_runs
  ADD COLUMN trigger_snapshot_id uuid,
  ADD COLUMN trigger_name text,
  ADD COLUMN trigger_mode public.companion_routine_surface_mode,
  ADD CONSTRAINT companion_v3_background_runs_origin_check CHECK (
    (trigger_snapshot_id IS NULL AND trigger_name IS NULL AND trigger_mode IS NULL)
    OR (trigger_snapshot_id IS NOT NULL
      AND trigger_name IS NOT NULL
      AND trigger_mode IS NOT NULL
      AND routine_id IS NULL)
  ),
  ADD CONSTRAINT companion_v3_background_runs_trigger_name_check CHECK (
    trigger_name IS NULL OR (char_length(trigger_name) BETWEEN 1 AND 80
      AND trigger_name !~ E'[\n\r]')
  );
--> statement-breakpoint

CREATE INDEX companion_v3_background_trigger_runs_history_idx
  ON public.companion_v3_routine_runs(
    org_id, companion_id, trigger_snapshot_id, created_at DESC, turn_id DESC
  ) WHERE trigger_snapshot_id IS NOT NULL;
--> statement-breakpoint

-- Delivery admission is API-only persistence. Registration/provider authority was reconciled
-- before the provider called this route; neither the route nor this function contacts Box or Pi.
CREATE OR REPLACE FUNCTION public.companion_api_fire_trigger(
  p_org_id uuid,p_trigger_id uuid,p_client_message_id uuid,p_content text
) RETURNS TABLE(outcome text,turn jsonb,replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_now timestamptz:=clock_timestamp();v_trigger public.companion_triggers%ROWTYPE;
  v_owner text;v_admitted record;v_turn public.companion_v3_turns%ROWTYPE;
  v_run public.companion_v3_routine_runs%ROWTYPE;
BEGIN
  IF p_org_id IS NULL OR p_trigger_id IS NULL OR p_client_message_id IS NULL
    OR p_content IS NULL OR char_length(btrim(p_content)) NOT BETWEEN 1 AND 16384 THEN
    RAISE EXCEPTION 'invalid Companion trigger fire' USING ERRCODE='22023';END IF;
  SELECT trigger_row.* INTO v_trigger FROM public.companion_triggers trigger_row
    WHERE trigger_row.org_id=p_org_id AND trigger_row.id=p_trigger_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Companion trigger not found' USING ERRCODE='P0002';END IF;
  IF NOT v_trigger.enabled OR (v_trigger.provider IN ('github','linear','sentry') AND
    (v_trigger.registration_status<>'registered' OR NOT EXISTS(
      SELECT 1 FROM public.companion_trigger_provider_accounts account
      WHERE account.org_id=p_org_id AND account.id=v_trigger.provider_account_id
        AND account.provider=v_trigger.provider AND account.status='connected'))) THEN
    outcome:='skipped_disabled';turn:=NULL;replayed:=false;RETURN NEXT;RETURN;
  END IF;
  SELECT companion.owner_id INTO STRICT v_owner FROM public.companions companion
    JOIN public.memberships membership ON membership.org_id=companion.org_id
      AND membership.user_id=companion.owner_id
    WHERE companion.org_id=p_org_id AND companion.id=v_trigger.companion_id;
  SELECT * INTO v_admitted FROM public.companion_v3_admit_turn(p_org_id,
    v_trigger.companion_id,p_client_message_id,'msg:'||p_client_message_id::text,v_owner,'background');
  SELECT * INTO STRICT v_turn FROM public.companion_v3_turns WHERE id=v_admitted.turn_id;
  INSERT INTO public.companion_v3_routine_runs(org_id,companion_id,turn_id,routine_id,
    routine_snapshot_id,routine_generation,routine_name,prompt,scheduled_for,
    trigger_snapshot_id,trigger_name,trigger_mode)
  VALUES(p_org_id,v_trigger.companion_id,v_turn.id,NULL,v_trigger.id,v_trigger.created_at,
    v_trigger.name,p_content,v_now,v_trigger.id,v_trigger.name,
    v_trigger.mode::public.companion_routine_surface_mode)
  ON CONFLICT (org_id,companion_id,turn_id) DO NOTHING;
  SELECT * INTO STRICT v_run FROM public.companion_v3_routine_runs run
    WHERE run.org_id=p_org_id AND run.companion_id=v_trigger.companion_id
      AND run.turn_id=v_turn.id;
  IF v_run.trigger_snapshot_id IS DISTINCT FROM v_trigger.id
    OR v_run.routine_generation IS DISTINCT FROM v_trigger.created_at
    OR v_run.trigger_name IS DISTINCT FROM v_trigger.name
    OR v_run.trigger_mode::text IS DISTINCT FROM v_trigger.mode
    OR v_run.prompt IS DISTINCT FROM p_content THEN
    RAISE EXCEPTION 'client_message_id was reused with different trigger delivery intent'
      USING ERRCODE='23505',CONSTRAINT='companion_v3_turns_client_message_uq';
  END IF;
  UPDATE public.companion_triggers SET
    last_fired_at=CASE WHEN v_admitted.replayed THEN last_fired_at ELSE v_now END,
    last_error_code=NULL,last_error_message=NULL,last_error_at=NULL,updated_at=v_now
    WHERE org_id=p_org_id AND id=p_trigger_id;
  outcome:=CASE WHEN v_admitted.replayed THEN 'replayed' ELSE 'fired' END;
  turn:=public.companion_v3_public_turn(v_turn);replayed:=v_admitted.replayed;RETURN NEXT;
END $$;
--> statement-breakpoint

-- Inbound persistence failures stay diagnostic. They never disable a definition; the provider may
-- redeliver the same identity after the external outage clears.
CREATE OR REPLACE FUNCTION public.companion_api_fail_trigger_fire(
  p_org_id uuid,p_trigger_id uuid,p_error_code text,p_error_message text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
BEGIN
  IF p_error_code!~'^[a-z][a-z0-9_]{0,63}$'
    OR char_length(p_error_message) NOT BETWEEN 1 AND 500 OR p_error_message~E'[\n\r]' THEN
    RAISE EXCEPTION 'invalid Companion trigger failure' USING ERRCODE='22023';END IF;
  UPDATE public.companion_triggers SET consecutive_failures=consecutive_failures+1,
    last_error_code=p_error_code,last_error_message=p_error_message,
    last_error_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE org_id=p_org_id AND id=p_trigger_id;
END $$;
--> statement-breakpoint

-- Authorization deliberately branches by durable source. Routines keep current Skills/plugins/MCP
-- checks. Trigger validators receive only the model needed to execute Pi; no selected Skill,
-- general plugin, member MCP, trigger-provider account, or control-MCP authority is consulted.
CREATE FUNCTION public.companion_v3_runtime_authorize_background_v8(
  p_org_id uuid,p_companion_id uuid,p_turn_id uuid,p_claim_token uuid,p_claim_epoch bigint,
  p_gate_epoch bigint,p_protocol integer
) RETURNS TABLE(background_kind text,box_id text,pi_invocation_id text,content text,
  activity_cursor bigint,persona text,validation_only boolean,direct_workspace boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_now timestamptz:=clock_timestamp();
BEGIN
  IF p_protocol<>8 THEN RAISE EXCEPTION 'Runtime v3 protocol 8 is required' USING ERRCODE='42501';END IF;
  RETURN QUERY
  SELECT CASE WHEN run.trigger_snapshot_id IS NULL THEN 'routine' ELSE 'trigger' END,
    instance.box_id,'routine:'||turn_row.id::text||':dispatch-v2:'||turn_row.command_id::text,
    run.prompt,turn_row.activity_cursor,companion.persona,
    run.trigger_snapshot_id IS NOT NULL,run.trigger_snapshot_id IS NULL
  FROM public.companion_v3_lane_leases lease
  JOIN public.companion_runtime_control control ON control.id='runtime-v2' AND control.enabled
    AND control.gate_epoch=p_gate_epoch
  JOIN public.companion_v3_turns turn_row ON turn_row.org_id=lease.org_id
    AND turn_row.companion_id=lease.companion_id AND turn_row.id=lease.turn_id
    AND turn_row.lane='background'
  JOIN public.companion_v3_routine_runs run ON run.org_id=turn_row.org_id
    AND run.companion_id=turn_row.companion_id AND run.turn_id=turn_row.id
    AND run.outcome IN ('pending','running','notify','relay','no_output','failed','interrupted')
  JOIN public.companion_v3_instances instance ON instance.org_id=turn_row.org_id
    AND instance.companion_id=turn_row.companion_id AND instance.box_id IS NOT NULL
    AND instance.prepared_at IS NOT NULL AND instance.pi_recycle_checkpoint IS NULL
  JOIN public.companions companion ON companion.org_id=turn_row.org_id
    AND companion.id=turn_row.companion_id AND companion.owner_id=turn_row.actor_id
  JOIN public.memberships membership ON membership.org_id=turn_row.org_id
    AND membership.user_id=turn_row.actor_id
  WHERE lease.org_id=p_org_id AND lease.companion_id=p_companion_id AND lease.lane='background'
    AND lease.turn_id=p_turn_id AND lease.claim_token=p_claim_token
    AND lease.claim_epoch=p_claim_epoch AND lease.gate_epoch=p_gate_epoch AND lease.expires_at>v_now
    AND (turn_row.state IN ('queued','admitted','running','needs_input')
      OR (turn_row.state IN ('succeeded','failed') AND turn_row.journal_ack_pending))
    AND jsonb_typeof(companion.provider_ids)='array' AND jsonb_array_length(companion.provider_ids)=1
    AND companion.model_id IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(companion.provider_ids) selected(provider_id)
      WHERE NOT EXISTS(SELECT 1 FROM public.companion_provider_connections connection
        WHERE connection.org_id=turn_row.org_id AND connection.provider_id=selected.provider_id))
    AND (run.trigger_snapshot_id IS NOT NULL OR (
      jsonb_typeof(companion.selected_skill_ids)='array'
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(companion.selected_skill_ids) selected(skill_id)
        WHERE NOT EXISTS(SELECT 1 FROM public.skills skill WHERE skill.org_id=turn_row.org_id
          AND skill.id::text=selected.skill_id AND skill.archived_at IS NULL
          AND (skill.scope='org' OR skill.creator_id=turn_row.actor_id)))
      AND jsonb_typeof(companion.selected_mcp_account_ids)='array'
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(companion.selected_mcp_account_ids) selected(account_id)
        WHERE NOT EXISTS(SELECT 1 FROM public.companion_mcp_accounts account
          WHERE account.org_id=turn_row.org_id AND account.id::text=selected.account_id
            AND account.owner_id=turn_row.actor_id))));
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_runtime_authorize_background_v8(
  uuid,uuid,uuid,uuid,bigint,bigint,integer) FROM PUBLIC;
--> statement-breakpoint

-- Preserve protocol 7 for routines without exposing trigger validation material to that caller.
ALTER FUNCTION public.companion_v3_runtime_authorize_routine(
  uuid,uuid,uuid,uuid,bigint,bigint,integer
) RENAME TO companion_v3_runtime_authorize_routine_internal_v7;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_runtime_authorize_routine(
  p_org_id uuid,p_companion_id uuid,p_turn_id uuid,p_claim_token uuid,p_claim_epoch bigint,
  p_gate_epoch bigint,p_protocol integer
) RETURNS TABLE(box_id text,pi_invocation_id text,content text,activity_cursor bigint,persona text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=on AS $$
BEGIN
  IF p_protocol<>7 THEN RAISE EXCEPTION 'Runtime v3 protocol 7 is required' USING ERRCODE='42501';END IF;
  IF NOT EXISTS(SELECT 1 FROM public.companion_v3_routine_runs run
    WHERE run.org_id=p_org_id AND run.companion_id=p_companion_id AND run.turn_id=p_turn_id
      AND run.trigger_snapshot_id IS NULL) THEN RETURN;END IF;
  RETURN QUERY SELECT authorized.* FROM public.companion_v3_runtime_authorize_routine_internal_v7(
    p_org_id,p_companion_id,p_turn_id,p_claim_token,p_claim_epoch,p_gate_epoch,7) authorized;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_runtime_authorize_routine(
  uuid,uuid,uuid,uuid,bigint,bigint,integer) FROM PUBLIC;
--> statement-breakpoint

-- Preserve THE-523's fenced preparation and cleanup selector behind a protocol-8-only entry point.
ALTER FUNCTION public.companion_v3_runtime_claim_routine_v7(
  text,public.companion_v3_lane,integer,integer
) RENAME TO companion_v3_runtime_claim_background_internal_v7;
REVOKE ALL ON FUNCTION public.companion_v3_runtime_claim_background_internal_v7(
  text,public.companion_v3_lane,integer,integer) FROM PUBLIC;
--> statement-breakpoint

-- Protocol 7 remains fail-closed during a mixed rollout. It cannot claim a trigger occurrence.
CREATE OR REPLACE FUNCTION public.companion_v3_runtime_claim_routine_v7(
  p_executor_id text,p_lane public.companion_v3_lane,p_lease_seconds integer,p_protocol integer
) RETURNS TABLE(org_id uuid,companion_id uuid,turn_id uuid,command_id uuid,
  lane public.companion_v3_lane,state public.companion_v3_turn_state,claim_token uuid,
  claim_epoch bigint,gate_epoch bigint,admission_started_at timestamptz,
  inactivity_deadline_at timestamptz,absolute_deadline_at timestamptz,
  cleanup_box_id text,cleanup_invocation_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=on AS $$
BEGIN
  IF p_protocol<>7 THEN RAISE EXCEPTION 'Runtime v3 protocol 7 is required' USING ERRCODE='42501';END IF;
  -- Protocol 8 owns all background claims after this migration. A protocol-7 executor
  -- remains fail-closed instead of consuming an occurrence it cannot classify safely.
  RETURN;
END $$;
--> statement-breakpoint

-- Protocol 8 is the source-neutral selector. Its only ordering key is the durable Turn sequence.
CREATE FUNCTION public.companion_v3_runtime_claim_background_v8(
  p_executor_id text,p_lane public.companion_v3_lane,p_lease_seconds integer,p_protocol integer
) RETURNS TABLE(org_id uuid,companion_id uuid,turn_id uuid,command_id uuid,
  lane public.companion_v3_lane,state public.companion_v3_turn_state,claim_token uuid,
  claim_epoch bigint,gate_epoch bigint,admission_started_at timestamptz,
  inactivity_deadline_at timestamptz,absolute_deadline_at timestamptz,
  cleanup_box_id text,cleanup_invocation_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=on AS $$
BEGIN
  IF p_protocol<>8 THEN RAISE EXCEPTION 'Runtime v3 protocol 8 is required' USING ERRCODE='42501';END IF;
  RETURN QUERY SELECT claimed.*
    FROM public.companion_v3_runtime_claim_background_internal_v7(
      p_executor_id,p_lane,p_lease_seconds,7) claimed;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_runtime_claim_background_v8(
  text,public.companion_v3_lane,integer,integer) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_runtime_claim_warm_v8(
  p_executor_id text,p_lane public.companion_v3_lane,p_lease_seconds integer,p_protocol integer
) RETURNS TABLE(org_id uuid,companion_id uuid,turn_id uuid,command_id uuid,
  lane public.companion_v3_lane,state public.companion_v3_turn_state,claim_token uuid,
  claim_epoch bigint,gate_epoch bigint,admission_started_at timestamptz,
  inactivity_deadline_at timestamptz,absolute_deadline_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=on AS $$
BEGIN
  IF p_protocol<>8 THEN RAISE EXCEPTION 'Runtime v3 protocol 8 is required' USING ERRCODE='42501';END IF;
  RETURN QUERY SELECT claimed.* FROM public.companion_v3_runtime_claim_warm_v7(
    p_executor_id,p_lane,p_lease_seconds,7) claimed;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_runtime_claim_warm_v8(
  text,public.companion_v3_lane,integer,integer) FROM PUBLIC;
--> statement-breakpoint

-- Reuse the atomic private projection/bridge transaction, adding the trigger-specific capability
-- guard and configured-mode check before any visible effect can be written.
ALTER FUNCTION public.companion_v3_runtime_project_routine_page(
  uuid,uuid,uuid,uuid,bigint,bigint,bigint,jsonb,jsonb,jsonb,boolean,boolean,text,integer
) RENAME TO companion_v3_runtime_project_background_page_v7;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_runtime_project_background_page_v8(
  p_org_id uuid,p_companion_id uuid,p_turn_id uuid,p_claim_token uuid,p_claim_epoch bigint,
  p_gate_epoch bigint,p_through_cursor bigint,p_entries jsonb,p_decisions jsonb,p_returns jsonb,
  p_needs_input boolean,p_activity boolean,p_terminal text,p_protocol integer
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_trigger boolean;v_mode text;v_result text;v_relay uuid;
BEGIN
  IF p_protocol<>8 THEN RAISE EXCEPTION 'Runtime v3 protocol 8 is required' USING ERRCODE='42501';END IF;
  SELECT run.trigger_snapshot_id IS NOT NULL,run.trigger_mode::text INTO v_trigger,v_mode
  FROM public.companion_v3_routine_runs run
  WHERE run.org_id=p_org_id AND run.companion_id=p_companion_id AND run.turn_id=p_turn_id;
  IF NOT FOUND THEN RETURN NULL;END IF;
  IF v_trigger AND (jsonb_array_length(p_decisions)<>0
    OR (jsonb_array_length(p_returns)=1 AND p_returns->0->>'mode' IS DISTINCT FROM v_mode)) THEN
    RAISE EXCEPTION 'trigger validator exceeded its isolated capability' USING ERRCODE='22023';END IF;
  v_result:=public.companion_v3_runtime_project_background_page_v7(p_org_id,p_companion_id,
    p_turn_id,p_claim_token,p_claim_epoch,p_gate_epoch,p_through_cursor,p_entries,p_decisions,
    p_returns,p_needs_input,p_activity,p_terminal,7);
  IF v_result IS NOT NULL AND v_trigger THEN
    SELECT relay_turn_id INTO v_relay FROM public.companion_v3_routine_runs
      WHERE org_id=p_org_id AND companion_id=p_companion_id AND turn_id=p_turn_id;
    IF v_relay IS NOT NULL THEN
      UPDATE public.companion_transcript_entries entry SET
        content='A webhook trigger surfaced the previous Companion entry. Read it and respond to that entry.'
      FROM public.companion_v3_turns relay
      WHERE relay.org_id=p_org_id AND relay.companion_id=p_companion_id AND relay.id=v_relay
        AND entry.org_id=relay.org_id AND entry.companion_id=relay.companion_id
        AND entry.event_id=relay.message_event_id;
    END IF;
  END IF;
  RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_runtime_project_background_page_v8(
  uuid,uuid,uuid,uuid,bigint,bigint,bigint,jsonb,jsonb,jsonb,boolean,boolean,text,integer) FROM PUBLIC;
--> statement-breakpoint

-- Keep the old symbol for migration replay and legacy callers; current runtime uses the v8 name.
CREATE FUNCTION public.companion_v3_runtime_project_routine_page(
  p_org_id uuid,p_companion_id uuid,p_turn_id uuid,p_claim_token uuid,p_claim_epoch bigint,
  p_gate_epoch bigint,p_through_cursor bigint,p_entries jsonb,p_decisions jsonb,p_returns jsonb,
  p_needs_input boolean,p_activity boolean,p_terminal text,p_protocol integer
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
BEGIN
  IF p_protocol<>7 THEN RAISE EXCEPTION 'Runtime v3 protocol 7 is required' USING ERRCODE='42501';END IF;
  IF NOT EXISTS(SELECT 1 FROM public.companion_v3_routine_runs run
    WHERE run.org_id=p_org_id AND run.companion_id=p_companion_id AND run.turn_id=p_turn_id
      AND run.trigger_snapshot_id IS NULL) THEN RETURN NULL;END IF;
  RETURN public.companion_v3_runtime_project_background_page_v7(p_org_id,p_companion_id,p_turn_id,
    p_claim_token,p_claim_epoch,p_gate_epoch,p_through_cursor,p_entries,p_decisions,p_returns,
    p_needs_input,p_activity,p_terminal,7);
END
$$;
REVOKE ALL ON FUNCTION public.companion_v3_runtime_project_routine_page(
  uuid,uuid,uuid,uuid,bigint,bigint,bigint,jsonb,jsonb,jsonb,boolean,boolean,text,integer) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_runtime_complete_v8(
  p_org_id uuid,p_companion_id uuid,p_lane public.companion_v3_lane,p_turn_id uuid,
  p_claim_token uuid,p_claim_epoch bigint,p_gate_epoch bigint,p_outcome text,p_code text,
  p_message text,p_action public.companion_runtime_error_action,p_protocol integer
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
BEGIN
  IF p_protocol<>8 THEN RAISE EXCEPTION 'Runtime v3 protocol 8 is required' USING ERRCODE='42501';END IF;
  RETURN public.companion_v3_runtime_complete_v7(p_org_id,p_companion_id,p_lane,p_turn_id,
    p_claim_token,p_claim_epoch,p_gate_epoch,p_outcome,p_code,p_message,p_action,7);
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_runtime_complete_v8(
  uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,text,text,text,
  public.companion_runtime_error_action,integer) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_runtime_sweep_background_deadlines_v8(p_protocol integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
BEGIN
  IF p_protocol<>8 THEN RAISE EXCEPTION 'Runtime v3 protocol 8 is required' USING ERRCODE='42501';END IF;
  RETURN public.companion_v3_runtime_sweep_routine_deadlines_v7(7);
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_runtime_sweep_background_deadlines_v8(integer) FROM PUBLIC;
--> statement-breakpoint

-- Trigger history reads v3 occurrences first and retains legacy v2 rows during the stacked cutover.
ALTER FUNCTION public.companion_api_trigger_run_json(uuid,uuid,uuid,boolean,integer,integer)
  RENAME TO companion_api_trigger_run_json_v2;
ALTER FUNCTION public.companion_api_list_trigger_runs(uuid,uuid,uuid,uuid,integer)
  RENAME TO companion_api_list_trigger_runs_v2;
ALTER FUNCTION public.companion_api_get_trigger_run(uuid,uuid,uuid,integer,integer)
  RENAME TO companion_api_get_trigger_run_v2;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_v3_trigger_run_json(
  p_org_id uuid,p_companion_id uuid,p_run_id uuid,p_viewer boolean DEFAULT false,
  p_entry_cursor integer DEFAULT NULL,p_entry_limit integer DEFAULT 50
) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
  SELECT jsonb_build_object(
    'run_id',run.turn_id,'companion_id',run.companion_id,
    'trigger',jsonb_build_object('id',run.trigger_snapshot_id,'name',run.trigger_name),
    'status',turn_row.state::text,'mode',run.trigger_mode::text,
    'outcome',CASE WHEN run.outcome IN ('notify','relay') THEN 'surfaced'
      WHEN run.outcome='no_output' THEN 'no_output'
      WHEN run.outcome IN ('failed','interrupted','cancelled') THEN 'error' ELSE 'pending' END,
    'surface_mode',run.surface_mode,'main_entry_event_id',run.main_entry_event_id,
    'relay_turn_id',run.relay_turn_id,'created_at',run.created_at,'started_at',run.started_at,
    'settled_at',run.settled_at,
    'error',CASE WHEN turn_row.outcome_code IS NULL THEN NULL
      WHEN p_viewer THEN public.companion_api_safe_error('runtime_unavailable',
        'Companion runtime needs attention.','none'::public.companion_runtime_error_action)
      ELSE public.companion_api_safe_error(turn_row.outcome_code,turn_row.outcome_message,
        turn_row.outcome_action) END,
    'internal_entries',COALESCE(history.entries,'[]'::jsonb),
    'next_entry_cursor',history.next_cursor)
  FROM public.companion_v3_routine_runs run
  JOIN public.companion_v3_turns turn_row ON turn_row.org_id=run.org_id
    AND turn_row.companion_id=run.companion_id AND turn_row.id=run.turn_id
  LEFT JOIN LATERAL (
    WITH ranked AS (
      SELECT entry.*,row_number() OVER(ORDER BY entry.ordinal,entry.event_id) AS position
      FROM public.companion_v3_routine_run_entries entry
      WHERE entry.org_id=run.org_id AND entry.companion_id=run.companion_id
        AND entry.run_id=run.turn_id AND (p_entry_cursor IS NULL OR entry.ordinal>p_entry_cursor)
    ),page AS (SELECT * FROM ranked
      WHERE position<=greatest(1,least(COALESCE(p_entry_limit,50),100)) ORDER BY ordinal,event_id)
    SELECT COALESCE(jsonb_agg(jsonb_build_object('event_id',entry.event_id,
      'ordinal',entry.ordinal,'role',entry.role,'content',entry.content,
      'reasoning',entry.reasoning,'tool',entry.tool,'decision',entry.decision,
      'created_at',entry.created_at) ORDER BY entry.ordinal,entry.event_id),'[]'::jsonb) entries,
      CASE WHEN count(*)<(SELECT count(*) FROM ranked) THEN max(entry.ordinal) END next_cursor
    FROM page entry
  ) history ON COALESCE(p_entry_limit,50)>0
  WHERE run.org_id=p_org_id AND run.companion_id=p_companion_id AND run.turn_id=p_run_id
    AND run.trigger_snapshot_id IS NOT NULL
$$;
REVOKE ALL ON FUNCTION public.companion_api_v3_trigger_run_json(
  uuid,uuid,uuid,boolean,integer,integer) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_trigger_run_json(
  p_org_id uuid,p_companion_id uuid,p_run_id uuid,p_viewer boolean DEFAULT false,
  p_entry_cursor integer DEFAULT NULL,p_entry_limit integer DEFAULT 50
) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
  SELECT COALESCE(public.companion_api_v3_trigger_run_json(p_org_id,p_companion_id,p_run_id,
    p_viewer,p_entry_cursor,p_entry_limit),public.companion_api_trigger_run_json_v2(
      p_org_id,p_companion_id,p_run_id,p_viewer,p_entry_cursor,p_entry_limit))
$$;
REVOKE ALL ON FUNCTION public.companion_api_trigger_run_json(
  uuid,uuid,uuid,boolean,integer,integer) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.companion_api_trigger_run_summary_json(
  p_org_id uuid,p_companion_id uuid,p_run_id uuid,p_viewer boolean DEFAULT false
) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
  SELECT public.companion_api_trigger_run_json(p_org_id,p_companion_id,p_run_id,p_viewer,NULL,0)
    - ARRAY['internal_entries','next_entry_cursor']
$$;
REVOKE ALL ON FUNCTION public.companion_api_trigger_run_summary_json(uuid,uuid,uuid,boolean) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_list_trigger_runs(
  p_org_id uuid,p_companion_id uuid,p_trigger_id uuid,p_cursor uuid DEFAULT NULL,p_limit integer DEFAULT 50
) RETURNS TABLE(run jsonb) LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_access text;
BEGIN
  v_access:=public.companion_api_require_access(p_org_id,p_companion_id,'read');
  RETURN QUERY WITH candidates AS (
    SELECT v3.turn_id AS run_id,v3.created_at FROM public.companion_v3_routine_runs v3
      WHERE v3.org_id=p_org_id AND v3.companion_id=p_companion_id
        AND v3.trigger_snapshot_id=p_trigger_id
    UNION ALL
    SELECT legacy.id,legacy.created_at FROM public.companion_turns legacy
      WHERE legacy.org_id=p_org_id AND legacy.companion_id=p_companion_id
        AND legacy.trigger_name IS NOT NULL
        AND COALESCE(legacy.routine_snapshot_id,legacy.trigger_id)=p_trigger_id
  ),page AS (SELECT candidates.* FROM candidates
    WHERE p_cursor IS NULL OR candidates.created_at<(SELECT cursor_row.created_at FROM candidates cursor_row
      WHERE cursor_row.run_id=p_cursor)
    ORDER BY candidates.created_at DESC,candidates.run_id DESC
    LIMIT greatest(1,least(COALESCE(p_limit,50),101)))
  SELECT public.companion_api_trigger_run_summary_json(p_org_id,p_companion_id,page.run_id,
    v_access='viewer') FROM page ORDER BY page.created_at DESC,page.run_id DESC;
END $$;
REVOKE ALL ON FUNCTION public.companion_api_list_trigger_runs(uuid,uuid,uuid,uuid,integer) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_get_trigger_run(
  p_org_id uuid,p_companion_id uuid,p_run_id uuid,p_entry_cursor integer DEFAULT NULL,
  p_entry_limit integer DEFAULT 50
) RETURNS TABLE(run jsonb) LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_access text;v_run jsonb;
BEGIN
  v_access:=public.companion_api_require_access(p_org_id,p_companion_id,'read');
  v_run:=public.companion_api_trigger_run_json(p_org_id,p_companion_id,p_run_id,
    v_access='viewer',p_entry_cursor,greatest(1,least(COALESCE(p_entry_limit,50),100)));
  IF v_run IS NOT NULL THEN RETURN QUERY SELECT v_run;END IF;
END $$;
REVOKE ALL ON FUNCTION public.companion_api_get_trigger_run(uuid,uuid,uuid,integer,integer) FROM PUBLIC;
--> statement-breakpoint

DO $$ DECLARE v_role text;BEGIN
  SELECT pg_get_userbyid(proowner) INTO v_role FROM pg_proc WHERE oid=
    'public.companion_v3_runtime_claim_warm_v7(text,public.companion_v3_lane,integer,integer)'::regprocedure;
  IF v_role IS NOT NULL THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_v3_runtime_claim_background_v8(text,public.companion_v3_lane,integer,integer) TO %I',v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_v3_runtime_claim_warm_v8(text,public.companion_v3_lane,integer,integer) TO %I',v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_v3_runtime_authorize_background_v8(uuid,uuid,uuid,uuid,bigint,bigint,integer) TO %I',v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_v3_runtime_project_background_page_v8(uuid,uuid,uuid,uuid,bigint,bigint,bigint,jsonb,jsonb,jsonb,boolean,boolean,text,integer) TO %I',v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_v3_runtime_complete_v8(uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,text,text,text,public.companion_runtime_error_action,integer) TO %I',v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_v3_runtime_sweep_background_deadlines_v8(integer) TO %I',v_role);
  END IF;
END $$;
--> statement-breakpoint

DO $companion_v3_trigger_api_acl$ DECLARE v_source oid:=to_regprocedure(
  'public.companion_api_read_thread(uuid,uuid)');v_grantee oid;v_role name;
BEGIN
  FOR v_grantee IN SELECT DISTINCT acl.grantee FROM pg_proc procedure
    CROSS JOIN LATERAL aclexplode(COALESCE(procedure.proacl,acldefault('f',procedure.proowner))) acl
    WHERE procedure.oid=v_source AND acl.privilege_type='EXECUTE' AND acl.grantee<>procedure.proowner
  LOOP SELECT rolname INTO v_role FROM pg_roles WHERE oid=v_grantee;
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_api_list_trigger_runs(uuid,uuid,uuid,uuid,integer) TO %I',v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_api_get_trigger_run(uuid,uuid,uuid,integer,integer) TO %I',v_role);
  END LOOP;
END $companion_v3_trigger_api_acl$;
--> statement-breakpoint
