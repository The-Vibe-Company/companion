-- Scheduled routines become ordinary Runtime v3 background Turns. The worker owns only the due
-- row transaction; Runtime remains the sole Box/Pi owner.
ALTER TABLE public.companion_v3_turns
  ADD COLUMN available_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN retry_count integer NOT NULL DEFAULT 0,
  ADD COLUMN routine_relay_source_event_id text,
  ADD CONSTRAINT companion_v3_turns_retry_check CHECK (retry_count >= 0),
  ADD CONSTRAINT companion_v3_turns_relay_source_check CHECK (
    routine_relay_source_event_id IS NULL
    OR (lane = 'main' AND char_length(routine_relay_source_event_id) BETWEEN 1 AND 200
      AND routine_relay_source_event_id !~ E'[\n\r]')
  );
--> statement-breakpoint

CREATE INDEX companion_v3_turns_available_fifo_idx
  ON public.companion_v3_turns(lane, available_at, companion_id, queue_sequence, id)
  WHERE state = 'queued';
--> statement-breakpoint

ALTER TABLE public.companion_routines
  ADD COLUMN fire_available_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN fire_attempt_count integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT companion_routines_fire_retry_check CHECK (fire_attempt_count >= 0);
--> statement-breakpoint

CREATE TABLE public.companion_v3_routine_runs (
  org_id uuid NOT NULL,
  companion_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  routine_id uuid REFERENCES public.companion_routines(id) ON DELETE SET NULL
    DEFERRABLE INITIALLY DEFERRED,
  routine_snapshot_id uuid NOT NULL,
  routine_generation timestamp with time zone NOT NULL,
  routine_name text NOT NULL,
  prompt text NOT NULL,
  scheduled_for timestamp with time zone NOT NULL,
  outcome text NOT NULL DEFAULT 'pending',
  cleanup_checkpoint text,
  cleanup_invocation_id text,
  cleanup_retry boolean NOT NULL DEFAULT false,
  surface_mode public.companion_routine_surface_mode,
  main_entry_event_id text,
  relay_turn_id uuid,
  next_ordinal integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
  started_at timestamp with time zone,
  settled_at timestamp with time zone,
  CONSTRAINT companion_v3_routine_runs_pk PRIMARY KEY (org_id, companion_id, turn_id),
  CONSTRAINT companion_v3_routine_runs_turn_fk FOREIGN KEY (org_id, companion_id, turn_id)
    REFERENCES public.companion_v3_turns(org_id, companion_id, id) ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT companion_v3_routine_runs_name_check CHECK (
    char_length(routine_name) BETWEEN 1 AND 80 AND routine_name !~ E'[\n\r]'),
  CONSTRAINT companion_v3_routine_runs_prompt_check CHECK (
    char_length(btrim(prompt)) BETWEEN 1 AND 16384),
  CONSTRAINT companion_v3_routine_runs_outcome_check CHECK (
    outcome IN ('pending','running','notify','relay','no_output','failed','interrupted','cancelled','superseded')
    AND ((outcome IN ('pending','running')) = (settled_at IS NULL))
    AND ((surface_mode IS NULL) = (main_entry_event_id IS NULL))
    AND ((surface_mode = 'relay') = (relay_turn_id IS NOT NULL))),
  CONSTRAINT companion_v3_routine_runs_ordinal_check CHECK (next_ordinal >= 0),
  CONSTRAINT companion_v3_routine_runs_cleanup_check CHECK (
    (cleanup_checkpoint IS NULL AND cleanup_invocation_id IS NULL AND NOT cleanup_retry)
    OR (cleanup_checkpoint = 'terminate'
      AND char_length(cleanup_invocation_id) BETWEEN 1 AND 200
      AND cleanup_invocation_id !~ E'[\n\r]')),
  CONSTRAINT companion_v3_routine_runs_surface_event_check CHECK (
    main_entry_event_id IS NULL OR (char_length(main_entry_event_id) BETWEEN 1 AND 200
      AND main_entry_event_id !~ E'[\n\r]'))
);
--> statement-breakpoint

CREATE INDEX companion_v3_routine_runs_history_idx
  ON public.companion_v3_routine_runs(org_id, companion_id, routine_snapshot_id, scheduled_for DESC, turn_id DESC);
--> statement-breakpoint

CREATE TABLE public.companion_v3_routine_run_entries (
  org_id uuid NOT NULL,
  companion_id uuid NOT NULL,
  run_id uuid NOT NULL,
  event_id text NOT NULL,
  ordinal integer NOT NULL,
  role public.companion_transcript_role NOT NULL,
  content text NOT NULL,
  reasoning text,
  tool jsonb,
  decision jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT companion_v3_routine_run_entries_pk PRIMARY KEY (org_id, companion_id, run_id, event_id),
  CONSTRAINT companion_v3_routine_run_entries_run_fk FOREIGN KEY (org_id, companion_id, run_id)
    REFERENCES public.companion_v3_routine_runs(org_id, companion_id, turn_id) ON DELETE CASCADE,
  CONSTRAINT companion_v3_routine_run_entries_ordinal_uq UNIQUE (companion_id, run_id, ordinal),
  CONSTRAINT companion_v3_routine_run_entries_event_check CHECK (
    char_length(event_id) BETWEEN 1 AND 200 AND event_id !~ E'[\n\r]'),
  CONSTRAINT companion_v3_routine_run_entries_size_check CHECK (
    ordinal >= 0 AND octet_length(content) <= 1048576
    AND (reasoning IS NULL OR octet_length(reasoning) <= 48000)
    AND (tool IS NULL OR octet_length(tool::text) <= 262144)
    AND (decision IS NULL OR octet_length(decision::text) <= 262144))
);
--> statement-breakpoint

ALTER TABLE public.companion_v3_routine_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companion_v3_routine_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.companion_v3_routine_run_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companion_v3_routine_run_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY companion_v3_routine_runs_owner_rls ON public.companion_v3_routine_runs
  USING (current_user = pg_get_userbyid((SELECT proowner FROM pg_proc
    WHERE oid = 'public.companion_v3_runtime_claim_warm_v6(text,public.companion_v3_lane,integer,integer)'::regprocedure)))
  WITH CHECK (current_user = pg_get_userbyid((SELECT proowner FROM pg_proc
    WHERE oid = 'public.companion_v3_runtime_claim_warm_v6(text,public.companion_v3_lane,integer,integer)'::regprocedure)));
CREATE POLICY companion_v3_routine_entries_owner_rls ON public.companion_v3_routine_run_entries
  USING (current_user = pg_get_userbyid((SELECT proowner FROM pg_proc
    WHERE oid = 'public.companion_v3_runtime_claim_warm_v6(text,public.companion_v3_lane,integer,integer)'::regprocedure)))
  WITH CHECK (current_user = pg_get_userbyid((SELECT proowner FROM pg_proc
    WHERE oid = 'public.companion_v3_runtime_claim_warm_v6(text,public.companion_v3_lane,integer,integer)'::regprocedure)));
--> statement-breakpoint

-- The source remains enabled after every execution failure. Failure history is diagnostic only.
CREATE OR REPLACE FUNCTION public.companion_record_routine_run_outcome()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = on AS $$
DECLARE v_now timestamptz := COALESCE(NEW.settled_at, clock_timestamp());
BEGIN
  IF OLD.status IS NOT DISTINCT FROM NEW.status OR NEW.routine_snapshot_id IS NULL
    OR NEW.status NOT IN ('succeeded','failed','interrupted','cancelled') THEN RETURN NULL; END IF;
  UPDATE public.companion_routines routine SET
    consecutive_failures = CASE WHEN NEW.status='succeeded' THEN 0
      WHEN NEW.status='failed' THEN routine.consecutive_failures+1 ELSE routine.consecutive_failures END,
    last_error_code = CASE WHEN NEW.status='succeeded' THEN NULL
      WHEN NEW.status='failed' THEN NEW.last_error_code ELSE routine.last_error_code END,
    last_error_message = CASE WHEN NEW.status='succeeded' THEN NULL
      WHEN NEW.status='failed' THEN NEW.last_error_message ELSE routine.last_error_message END,
    last_error_at = CASE WHEN NEW.status='succeeded' THEN NULL
      WHEN NEW.status='failed' THEN v_now ELSE routine.last_error_at END,
    updated_at = v_now
  WHERE routine.org_id=NEW.org_id AND routine.companion_id=NEW.companion_id
    AND routine.id=NEW.routine_snapshot_id AND routine.created_at=NEW.routine_snapshot_created_at;
  RETURN NULL;
END $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.companion_claim_due_routines(
  p_worker_id text,p_limit integer,p_lease_seconds integer
) RETURNS TABLE(org_id uuid,companion_id uuid,routine_id uuid,name text,prompt text,cron text,
  timezone text,scheduled_for timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  WITH candidates AS (
    SELECT routine.id FROM public.companion_routines routine
    WHERE routine.enabled AND routine.next_fire_at IS NOT NULL
      AND routine.next_fire_at<=statement_timestamp() AND routine.fire_available_at<=statement_timestamp()
      AND (routine.lease_expires_at IS NULL OR routine.lease_expires_at<statement_timestamp())
    ORDER BY routine.next_fire_at,routine.id FOR UPDATE SKIP LOCKED
    LIMIT greatest(1,least(p_limit,50))
  ), claimed AS (
    UPDATE public.companion_routines routine SET claimed_by=p_worker_id,
      lease_expires_at=statement_timestamp()+make_interval(secs=>greatest(15,least(p_lease_seconds,300))),
      updated_at=statement_timestamp() FROM candidates WHERE routine.id=candidates.id
    RETURNING routine.*
  ) SELECT claimed.org_id,claimed.companion_id,claimed.id,claimed.name,claimed.prompt,
      claimed.cron,claimed.timezone,claimed.next_fire_at FROM claimed
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.companion_fire_routine(
  p_worker_id text,p_org_id uuid,p_routine_id uuid,p_client_message_id uuid,
  p_scheduled_for timestamptz,p_next_fire_at timestamptz
) RETURNS TABLE(outcome text,turn jsonb,replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_now timestamptz:=clock_timestamp(); v_routine public.companion_routines%ROWTYPE;
  v_owner text; v_admitted record; v_turn public.companion_v3_turns%ROWTYPE;
BEGIN
  IF p_worker_id IS NULL OR char_length(p_worker_id) NOT BETWEEN 1 AND 200
    OR p_worker_id~E'[\n\r]' OR p_org_id IS NULL OR p_routine_id IS NULL
    OR p_client_message_id IS NULL OR p_scheduled_for IS NULL OR p_next_fire_at<=v_now THEN
    RAISE EXCEPTION 'invalid Companion routine fire' USING ERRCODE='22023'; END IF;
  SELECT routine.* INTO v_routine FROM public.companion_routines routine
  WHERE routine.org_id=p_org_id AND routine.id=p_routine_id FOR UPDATE;
  IF NOT FOUND OR v_routine.claimed_by IS DISTINCT FROM p_worker_id
    OR v_routine.lease_expires_at<=v_now OR v_routine.next_fire_at IS DISTINCT FROM p_scheduled_for THEN
    RAISE EXCEPTION 'Companion routine fire fence was lost' USING ERRCODE='40001'; END IF;
  IF NOT v_routine.enabled THEN
    UPDATE public.companion_routines SET claimed_by=NULL,lease_expires_at=NULL,
      fire_attempt_count=0,fire_available_at=v_now,updated_at=v_now WHERE id=p_routine_id;
    outcome:='skipped_disabled';turn:=NULL;replayed:=false;RETURN NEXT;RETURN;
  END IF;
  -- Preserve the scheduler's existing catch-up contract: an occurrence that is already outside
  -- the grace window advances the schedule without ever becoming executable work.
  IF p_scheduled_for<v_now-interval '10 minutes' THEN
    UPDATE public.companion_routines SET next_fire_at=p_next_fire_at,claimed_by=NULL,
      lease_expires_at=NULL,fire_attempt_count=0,fire_available_at=v_now,updated_at=v_now
    WHERE id=p_routine_id;
    outcome:='skipped_missed';turn:=NULL;replayed:=false;RETURN NEXT;RETURN;
  END IF;

  -- A due instant must not preempt or replace an outstanding occurrence. This preserves the
  -- scheduler's established pile-up contract across the v3 storage cutover.
  IF EXISTS (SELECT 1 FROM public.companion_v3_routine_runs active_run
    JOIN public.companion_v3_turns active_turn
      ON active_turn.org_id=active_run.org_id
      AND active_turn.companion_id=active_run.companion_id
      AND active_turn.id=active_run.turn_id
    WHERE active_run.org_id=p_org_id AND active_run.companion_id=v_routine.companion_id
      AND active_run.routine_id=p_routine_id AND active_run.outcome IN ('pending','running')
      AND active_turn.client_message_id<>p_client_message_id
      AND active_turn.state IN ('queued','admitted','running','needs_input')) THEN
    UPDATE public.companion_routines SET next_fire_at=p_next_fire_at,claimed_by=NULL,
      lease_expires_at=NULL,fire_attempt_count=0,fire_available_at=v_now,updated_at=v_now
    WHERE id=p_routine_id;
    outcome:='skipped_pileup';turn:=NULL;replayed:=false;RETURN NEXT;RETURN;
  END IF;
  SELECT companion.owner_id INTO STRICT v_owner FROM public.companions companion
  WHERE companion.org_id=p_org_id AND companion.id=v_routine.companion_id;

  -- A newer due instant replaces only obsolete pending work. Running work keeps its one slot.
  UPDATE public.companion_v3_turns pending SET state='cancelled',outcome='cancelled',
    settled_at=v_now,updated_at=v_now
  FROM public.companion_v3_routine_runs old_run
  WHERE old_run.org_id=p_org_id AND old_run.companion_id=v_routine.companion_id
    AND old_run.routine_id=p_routine_id AND old_run.outcome='pending'
    AND old_run.scheduled_for<p_scheduled_for
    AND pending.org_id=old_run.org_id AND pending.companion_id=old_run.companion_id
    AND pending.id=old_run.turn_id AND pending.state='queued';
  UPDATE public.companion_v3_routine_runs old_run SET outcome='superseded',settled_at=v_now
  WHERE old_run.org_id=p_org_id AND old_run.companion_id=v_routine.companion_id
    AND old_run.routine_id=p_routine_id AND old_run.outcome='pending'
    AND old_run.scheduled_for<p_scheduled_for
    AND EXISTS (SELECT 1 FROM public.companion_v3_turns superseded
      WHERE superseded.org_id=old_run.org_id AND superseded.companion_id=old_run.companion_id
        AND superseded.id=old_run.turn_id AND superseded.state='cancelled');

  SELECT * INTO v_admitted FROM public.companion_v3_admit_turn(p_org_id,
    v_routine.companion_id,p_client_message_id,'msg:'||p_client_message_id::text,v_owner,'background');
  SELECT * INTO STRICT v_turn FROM public.companion_v3_turns WHERE id=v_admitted.turn_id;
  INSERT INTO public.companion_v3_routine_runs(org_id,companion_id,turn_id,routine_id,
    routine_snapshot_id,routine_generation,routine_name,prompt,scheduled_for)
  VALUES(p_org_id,v_routine.companion_id,v_turn.id,p_routine_id,p_routine_id,v_routine.created_at,
    v_routine.name,v_routine.prompt,p_scheduled_for)
  ON CONFLICT (org_id,companion_id,turn_id) DO NOTHING;
  UPDATE public.companion_routines SET last_fired_at=v_now,next_fire_at=p_next_fire_at,
    fire_available_at=v_now,fire_attempt_count=0,last_error_code=NULL,last_error_message=NULL,
    last_error_at=NULL,claimed_by=NULL,lease_expires_at=NULL,updated_at=v_now WHERE id=p_routine_id;
  outcome:=CASE WHEN v_admitted.replayed THEN 'replayed' ELSE 'fired' END;
  turn:=public.companion_v3_public_turn(v_turn);replayed:=v_admitted.replayed;RETURN NEXT;
END $$;
--> statement-breakpoint

-- The legacy cleanup trigger remains the single atomic disable/delete hook. Extend it with v3
-- queue settlement while retaining the old-table cleanup during the additive rollout.
CREATE FUNCTION public.companion_v3_cancel_queued_routine_turns(
  p_org_id uuid,p_companion_id uuid,p_routine_id uuid,p_routine_created_at timestamptz
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_now timestamptz:=clock_timestamp(); v_count integer;
BEGIN
  UPDATE public.companion_v3_turns turn_row SET state='cancelled',outcome='cancelled',
    outcome_code=NULL,outcome_message=NULL,outcome_action=NULL,settled_at=v_now,updated_at=v_now
  WHERE turn_row.org_id=p_org_id AND turn_row.companion_id=p_companion_id
    AND turn_row.state='queued'
    AND EXISTS (SELECT 1 FROM public.companion_v3_routine_runs run
      WHERE run.org_id=turn_row.org_id AND run.companion_id=turn_row.companion_id
        AND run.turn_id=turn_row.id AND run.routine_snapshot_id=p_routine_id
        AND run.routine_generation=p_routine_created_at AND run.outcome='pending');
  GET DIAGNOSTICS v_count=ROW_COUNT;
  UPDATE public.companion_v3_routine_runs run SET outcome='cancelled',settled_at=v_now
  WHERE run.org_id=p_org_id AND run.companion_id=p_companion_id
    AND run.routine_snapshot_id=p_routine_id AND run.routine_generation=p_routine_created_at
    AND run.outcome='pending'
    AND EXISTS (SELECT 1 FROM public.companion_v3_turns cancelled
      WHERE cancelled.org_id=run.org_id AND cancelled.companion_id=run.companion_id
        AND cancelled.id=run.turn_id AND cancelled.state='cancelled');
  RETURN v_count;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_cancel_queued_routine_turns(uuid,uuid,uuid,timestamptz)
  FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.companion_cancel_queued_routine_on_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    PERFORM public.companion_cancel_queued_routine_turns(OLD.org_id,OLD.companion_id,OLD.id,
      OLD.created_at,'routine_deleted','This scheduled run was skipped because the routine was deleted.');
    PERFORM public.companion_v3_cancel_queued_routine_turns(
      OLD.org_id,OLD.companion_id,OLD.id,OLD.created_at);
    RETURN OLD;
  END IF;
  IF OLD.enabled AND NOT NEW.enabled THEN
    PERFORM public.companion_cancel_queued_routine_turns(OLD.org_id,OLD.companion_id,OLD.id,
      OLD.created_at,'routine_disabled','This scheduled run was skipped because the routine was disabled.');
    PERFORM public.companion_v3_cancel_queued_routine_turns(
      OLD.org_id,OLD.companion_id,OLD.id,OLD.created_at);
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

-- Permanent deletion fences accepted background work before lifecycle may touch the Box. Runtime
-- must first claim this cleanup checkpoint and terminate the exact run-scoped Pi invocation.
CREATE FUNCTION public.companion_v3_preempt_routine_for_delete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_now timestamptz:=clock_timestamp();
BEGIN
  IF NEW.intent<>'delete' THEN RETURN NEW;END IF;

  UPDATE public.companion_v3_turns turn_row SET state='cancelled',outcome='cancelled',
    outcome_code=NULL,outcome_message=NULL,outcome_action=NULL,settled_at=v_now,updated_at=v_now
  WHERE turn_row.org_id=NEW.org_id AND turn_row.companion_id=NEW.companion_id
    AND turn_row.lane='background' AND turn_row.state='queued'
    AND turn_row.pi_invocation_id IS NULL
    AND EXISTS (SELECT 1 FROM public.companion_v3_routine_runs run
      WHERE run.org_id=turn_row.org_id AND run.companion_id=turn_row.companion_id
        AND run.turn_id=turn_row.id AND run.outcome IN ('pending','running'));
  UPDATE public.companion_v3_routine_runs run SET outcome='cancelled',settled_at=v_now
  WHERE run.org_id=NEW.org_id AND run.companion_id=NEW.companion_id
    AND run.outcome IN ('pending','running')
    AND EXISTS (SELECT 1 FROM public.companion_v3_turns turn_row
      WHERE turn_row.org_id=run.org_id AND turn_row.companion_id=run.companion_id
        AND turn_row.id=run.turn_id AND turn_row.state='cancelled');

  UPDATE public.companion_v3_turns turn_row SET state='interrupted',outcome='interrupted',
    outcome_code='runtime_lifecycle_preempted',
    outcome_message='Permanent deletion interrupted this scheduled routine.',
    outcome_action='none',inactivity_deadline_at=NULL,absolute_deadline_at=NULL,
    settled_at=v_now,updated_at=v_now
  WHERE turn_row.org_id=NEW.org_id AND turn_row.companion_id=NEW.companion_id
    AND turn_row.lane='background' AND turn_row.state IN ('queued','admitted','running','needs_input')
    AND turn_row.pi_invocation_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.companion_v3_routine_runs run
      WHERE run.org_id=turn_row.org_id AND run.companion_id=turn_row.companion_id
        AND run.turn_id=turn_row.id AND run.outcome IN ('pending','running'));
  UPDATE public.companion_v3_routine_runs run SET outcome='interrupted',settled_at=v_now,
    cleanup_checkpoint='terminate',cleanup_invocation_id=turn_row.pi_invocation_id,
    cleanup_retry=false
  FROM public.companion_v3_turns turn_row
  WHERE run.org_id=NEW.org_id AND run.companion_id=NEW.companion_id
    AND run.outcome IN ('pending','running') AND turn_row.org_id=run.org_id
    AND turn_row.companion_id=run.companion_id AND turn_row.id=run.turn_id
    AND turn_row.state='interrupted' AND turn_row.pi_invocation_id IS NOT NULL;

  UPDATE public.companion_v3_lane_leases lease SET claim_token=NULL,
    claim_epoch=lease.claim_epoch+1,gate_epoch=NULL,executor_id=NULL,turn_id=NULL,
    claimed_at=NULL,renewed_at=NULL,expires_at=NULL,updated_at=v_now
  WHERE lease.org_id=NEW.org_id AND lease.companion_id=NEW.companion_id
    AND lease.lane='background';
  UPDATE public.companion_v3_instances instance SET lifecycle_available_at='infinity'::timestamptz,
    updated_at=v_now WHERE instance.org_id=NEW.org_id AND instance.companion_id=NEW.companion_id
    AND EXISTS (SELECT 1 FROM public.companion_v3_routine_runs run
      WHERE run.org_id=NEW.org_id AND run.companion_id=NEW.companion_id
        AND run.cleanup_checkpoint='terminate');
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_preempt_routine_for_delete() FROM PUBLIC;
CREATE TRIGGER companion_v3_preempt_routine_for_delete
AFTER INSERT ON public.companion_v3_lifecycle_requests
FOR EACH ROW WHEN (NEW.intent='delete')
EXECUTE FUNCTION public.companion_v3_preempt_routine_for_delete();
--> statement-breakpoint

-- Every admitted lane is actor-bound. A background Owner occurrence must fence an Editor's
-- completed or in-flight preparation before runtime can receive either member's private material.
CREATE OR REPLACE FUNCTION public.companion_v3_invalidate_from_turn()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.companion_v3_instances instance
    WHERE instance.org_id=NEW.org_id AND instance.companion_id=NEW.companion_id
      AND instance.preparation_actor_id IS NOT NULL
      AND instance.preparation_actor_id IS DISTINCT FROM NEW.actor_id) THEN
    PERFORM public.companion_v3_invalidate_preparation(NEW.org_id,NEW.companion_id);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER companion_v3_invalidate_from_turn ON public.companion_v3_turns;
CREATE TRIGGER companion_v3_invalidate_from_turn
AFTER INSERT ON public.companion_v3_turns
FOR EACH ROW EXECUTE FUNCTION public.companion_v3_invalidate_from_turn();
--> statement-breakpoint

-- Main FIFO remains authoritative. With no queued main Turn, bind preparation explicitly to the
-- oldest queued background occurrence instead of a later lifecycle actor.
CREATE OR REPLACE FUNCTION public.companion_v3_runtime_claim_preparation_v6(
  p_executor_id text,p_lease_seconds integer,p_protocol integer
) RETURNS TABLE(org_id uuid,companion_id uuid,turn_id uuid,command_id uuid,
  work_kind text,checkpoint text,box_idempotency_key uuid,box_id text,
  claim_token uuid,claim_epoch bigint,gate_epoch bigint,created_at timestamptz,
  attempt_count integer,deadline_at timestamptz,authorized boolean,actor_id text,
  model_id text,persona text,settings_revision bigint,skills_revision integer,
  provider_refs jsonb,skill_refs jsonb,mcp_refs jsonb,provider_material jsonb,
  skill_material jsonb,mcp_material jsonb,config_catalog jsonb,
  pi_recycle_checkpoint text,recycle_pi_invocation_id text,recovery_id uuid,
  recovery_context text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=on AS $$
BEGIN
  IF p_protocol<>6 THEN
    RAISE EXCEPTION 'Runtime v3 preparation protocol 6 is required' USING ERRCODE='42501';
  END IF;
  UPDATE public.companion_v3_instances instance SET
    desired_lifecycle_actor_id=(SELECT queued.actor_id FROM public.companion_v3_turns queued
      WHERE queued.org_id=instance.org_id AND queued.companion_id=instance.companion_id
        AND queued.lane='background' AND queued.state='queued'
      ORDER BY queued.queue_sequence,queued.id LIMIT 1),
    updated_at=clock_timestamp()
  WHERE instance.desired_lifecycle='prepare' AND instance.prepared_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM public.companion_v3_turns queued
      WHERE queued.org_id=instance.org_id AND queued.companion_id=instance.companion_id
        AND queued.lane='main' AND queued.state='queued')
    AND EXISTS (SELECT 1 FROM public.companion_v3_turns queued
      WHERE queued.org_id=instance.org_id AND queued.companion_id=instance.companion_id
        AND queued.lane='background' AND queued.state='queued')
    AND instance.desired_lifecycle_actor_id IS DISTINCT FROM (
      SELECT queued.actor_id FROM public.companion_v3_turns queued
      WHERE queued.org_id=instance.org_id AND queued.companion_id=instance.companion_id
        AND queued.lane='background' AND queued.state='queued'
      ORDER BY queued.queue_sequence,queued.id LIMIT 1);
  RETURN QUERY SELECT claimed.*,instance.pi_recycle_checkpoint,
    instance.recycle_pi_invocation_id,instance.recovery_turn_id,instance.recovery_context
  FROM public.companion_v3_runtime_claim_preparation_v5(p_executor_id,p_lease_seconds,5) claimed
  JOIN public.companion_v3_instances instance
    ON instance.org_id=claimed.org_id AND instance.companion_id=claimed.companion_id;
END $$;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_routine_preparation_matches(
  p_org_id uuid,p_companion_id uuid,p_actor_id text
) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
  SELECT EXISTS(SELECT 1 FROM public.companion_v3_instances instance
  JOIN public.companions companion ON companion.org_id=instance.org_id
    AND companion.id=instance.companion_id
  JOIN public.companion_runtime_instances runtime ON runtime.org_id=instance.org_id
    AND runtime.companion_id=instance.companion_id
  WHERE instance.org_id=p_org_id AND instance.companion_id=p_companion_id
    AND instance.prepared_at IS NOT NULL AND instance.preparation_actor_id=p_actor_id
    AND instance.preparation_settings_revision=runtime.desired_settings_revision
    AND instance.preparation_skills_revision=companion.skills_available_revision
    AND instance.preparation_model_id=companion.model_id
    AND jsonb_typeof(companion.provider_ids)='array'
    AND jsonb_typeof(companion.selected_skill_ids)='array'
    AND jsonb_typeof(companion.selected_mcp_account_ids)='array'
    AND jsonb_array_length(companion.provider_ids)=(SELECT count(*) FROM
      public.companion_provider_connections connection
      WHERE connection.org_id=p_org_id AND companion.provider_ids ? connection.provider_id)
    AND jsonb_array_length(companion.selected_skill_ids)=(SELECT count(*) FROM public.skills skill
      WHERE skill.org_id=p_org_id AND companion.selected_skill_ids ? skill.id::text
        AND skill.archived_at IS NULL AND skill.validation='valid'
        AND skill.current_version_id IS NOT NULL
        AND (skill.scope='org' OR skill.creator_id=p_actor_id))
    AND jsonb_array_length(companion.selected_mcp_account_ids)=(SELECT count(*)
      FROM public.companion_mcp_accounts account
      WHERE account.org_id=p_org_id AND companion.selected_mcp_account_ids ? account.id::text
        AND account.owner_id=p_actor_id)
    AND instance.preparation_provider_refs IS NOT DISTINCT FROM (SELECT COALESCE(jsonb_agg(
      jsonb_build_object('provider_id',connection.provider_id,
        'credential_generation',connection.credential_generation,
        'credential_version',connection.credential_version) ORDER BY connection.provider_id),'[]'::jsonb)
      FROM public.companion_provider_connections connection
      WHERE connection.org_id=p_org_id AND companion.provider_ids ? connection.provider_id)
    AND instance.preparation_skill_refs IS NOT DISTINCT FROM (SELECT COALESCE(jsonb_agg(
      jsonb_build_object('skill_id',skill.id,'current_version_id',skill.current_version_id)
        ORDER BY skill.id),'[]'::jsonb) FROM public.skills skill
      WHERE skill.org_id=p_org_id AND companion.selected_skill_ids ? skill.id::text
        AND skill.archived_at IS NULL AND skill.validation='valid'
        AND skill.current_version_id IS NOT NULL
        AND (skill.scope='org' OR skill.creator_id=p_actor_id))
    AND instance.preparation_mcp_refs IS NOT DISTINCT FROM (SELECT COALESCE(jsonb_agg(
      jsonb_build_object('account_id',account.id,
        'credential_generation',account.credential_generation,
        'credential_version',account.credential_version) ORDER BY account.id),'[]'::jsonb)
      FROM public.companion_mcp_accounts account
      WHERE account.org_id=p_org_id AND companion.selected_mcp_account_ids ? account.id::text
        AND account.owner_id=p_actor_id));
$$;
REVOKE ALL ON FUNCTION public.companion_v3_routine_preparation_matches(uuid,uuid,text) FROM PUBLIC;
--> statement-breakpoint

-- Scheduler persistence retries the same due instant. It never disables or advances the source.
CREATE OR REPLACE FUNCTION public.companion_fail_routine_fire(
  p_worker_id text,p_org_id uuid,p_routine_id uuid,p_error_code text,p_error_message text,
  p_next_fire_at timestamptz
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_now timestamptz:=clock_timestamp(); v_attempt integer; v_delay integer;
BEGIN
  IF p_worker_id IS NULL OR char_length(p_worker_id) NOT BETWEEN 1 AND 200 OR p_worker_id~E'[\n\r]'
    OR p_error_code!~'^[a-z][a-z0-9_]{0,63}$' OR char_length(p_error_message) NOT BETWEEN 1 AND 500
    OR p_error_message~E'[\n\r]' THEN RAISE EXCEPTION 'invalid Companion routine failure' USING ERRCODE='22023'; END IF;
  SELECT fire_attempt_count+1 INTO v_attempt FROM public.companion_routines
    WHERE org_id=p_org_id AND id=p_routine_id AND claimed_by=p_worker_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  v_delay:=CASE WHEN v_attempt=1 THEN 5 WHEN v_attempt=2 THEN 15 WHEN v_attempt=3 THEN 30
    WHEN v_attempt=4 THEN 60 ELSE 300 END;
  -- SQL random jitter is bounded to 80-120%; releasing the claim lets any worker recover it.
  UPDATE public.companion_routines SET fire_attempt_count=v_attempt,
    fire_available_at=v_now+make_interval(secs=>greatest(1,round(v_delay*(0.8+random()*0.4))::integer)),
    consecutive_failures=consecutive_failures+1,last_error_code=p_error_code,
    last_error_message=p_error_message,last_error_at=v_now,claimed_by=NULL,lease_expires_at=NULL,
    updated_at=v_now WHERE org_id=p_org_id AND id=p_routine_id;
END $$;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_runtime_claim_routine_v7(
  p_executor_id text,p_lane public.companion_v3_lane,p_lease_seconds integer,p_protocol integer
) RETURNS TABLE(org_id uuid,companion_id uuid,turn_id uuid,command_id uuid,
  lane public.companion_v3_lane,state public.companion_v3_turn_state,claim_token uuid,
  claim_epoch bigint,gate_epoch bigint,admission_started_at timestamptz,
  inactivity_deadline_at timestamptz,absolute_deadline_at timestamptz,
  cleanup_box_id text,cleanup_invocation_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_now timestamptz:=clock_timestamp();v_gate bigint;v_candidate record;
  v_invalid_org uuid;v_invalid_companion uuid;
BEGIN
  IF p_protocol<>7 THEN RAISE EXCEPTION 'Runtime v3 protocol 7 is required' USING ERRCODE='42501'; END IF;
  IF p_lane<>'background' THEN RETURN;END IF;
  IF p_executor_id IS NULL OR char_length(p_executor_id) NOT BETWEEN 1 AND 200
    OR p_executor_id~E'[\n\r]' OR p_lease_seconds NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION 'invalid Runtime v3 background claim' USING ERRCODE='22023'; END IF;
  SELECT control.gate_epoch INTO v_gate FROM public.companion_runtime_control control
    WHERE control.id='runtime-v2' AND control.enabled FOR SHARE;
  IF NOT FOUND THEN RETURN;END IF;

  -- Cleanup claims need only the already-persisted Box and exact routine invocation. They never
  -- load current member material or trigger main-Pi preparation.
  SELECT turn_row.*,instance.box_id AS cleanup_box_id,
    run.cleanup_invocation_id AS cleanup_invocation_id INTO v_candidate
  FROM public.companion_v3_lane_leases lease
  JOIN public.companion_v3_turns turn_row ON turn_row.org_id=lease.org_id
    AND turn_row.companion_id=lease.companion_id AND turn_row.lane='background'
  JOIN public.companion_v3_routine_runs run ON run.org_id=turn_row.org_id
    AND run.companion_id=turn_row.companion_id AND run.turn_id=turn_row.id
    AND run.cleanup_checkpoint='terminate'
  JOIN public.companion_v3_instances instance ON instance.org_id=turn_row.org_id
    AND instance.companion_id=turn_row.companion_id AND instance.box_id IS NOT NULL
  WHERE lease.lane='background' AND (lease.claim_token IS NULL OR lease.expires_at<=v_now)
  ORDER BY turn_row.queue_sequence,turn_row.id
  LIMIT 1 FOR UPDATE OF lease,turn_row,run SKIP LOCKED;

  IF NOT FOUND THEN
    SELECT instance.org_id,instance.companion_id INTO v_invalid_org,v_invalid_companion
    FROM public.companion_v3_instances instance
    JOIN public.companion_v3_turns turn_row ON turn_row.org_id=instance.org_id
      AND turn_row.companion_id=instance.companion_id AND turn_row.lane='background'
    JOIN public.companion_v3_routine_runs run ON run.org_id=turn_row.org_id
      AND run.companion_id=turn_row.companion_id AND run.turn_id=turn_row.id
      AND run.outcome IN ('pending','running')
    WHERE instance.prepared_at IS NOT NULL
      AND NOT public.companion_v3_routine_preparation_matches(
        turn_row.org_id,turn_row.companion_id,turn_row.actor_id)
    ORDER BY turn_row.queue_sequence,turn_row.id
    LIMIT 1 FOR UPDATE OF instance SKIP LOCKED;
    IF FOUND THEN
      PERFORM public.companion_v3_invalidate_preparation(v_invalid_org,v_invalid_companion);
    END IF;

    SELECT turn_row.*,NULL::text AS cleanup_box_id,NULL::text AS cleanup_invocation_id
      INTO v_candidate FROM public.companion_v3_lane_leases lease
    JOIN public.companion_v3_turns turn_row ON turn_row.org_id=lease.org_id
      AND turn_row.companion_id=lease.companion_id AND turn_row.lane='background'
    JOIN public.companion_v3_routine_runs run ON run.org_id=turn_row.org_id
      AND run.companion_id=turn_row.companion_id AND run.turn_id=turn_row.id
      AND run.cleanup_checkpoint IS NULL
    JOIN public.companion_v3_instances instance ON instance.org_id=turn_row.org_id
      AND instance.companion_id=turn_row.companion_id AND instance.box_id IS NOT NULL
      AND instance.prepared_at IS NOT NULL AND instance.pi_recycle_checkpoint IS NULL
      AND (instance.prepared_material_expires_at IS NULL
        OR instance.prepared_material_expires_at>v_now+interval '2 hours 5 minutes')
    WHERE lease.lane='background' AND (lease.claim_token IS NULL OR lease.expires_at<=v_now)
      AND public.companion_v3_routine_preparation_matches(
        turn_row.org_id,turn_row.companion_id,turn_row.actor_id)
      AND ((turn_row.state IN ('succeeded','failed') AND turn_row.journal_ack_pending)
      OR (run.outcome IN ('pending','running') AND ((turn_row.state='queued' AND turn_row.available_at<=v_now AND NOT EXISTS(
      SELECT 1 FROM public.companion_v3_turns active WHERE active.org_id=turn_row.org_id
        AND active.companion_id=turn_row.companion_id AND active.lane='background'
        AND active.state IN ('admitted','running','needs_input')))
      OR turn_row.state IN ('admitted','running','needs_input'))))
    ORDER BY turn_row.journal_ack_pending DESC,(turn_row.state<>'queued') DESC,
      turn_row.queue_sequence,turn_row.id
    LIMIT 1 FOR UPDATE OF lease,turn_row SKIP LOCKED;
  END IF;
  IF NOT FOUND THEN RETURN;END IF;
  UPDATE public.companion_v3_lane_leases lease SET claim_token=gen_random_uuid(),
    claim_epoch=lease.claim_epoch+1,gate_epoch=v_gate,executor_id=p_executor_id,
    turn_id=v_candidate.id,claimed_at=v_now,renewed_at=v_now,
    expires_at=v_now+make_interval(secs=>p_lease_seconds),updated_at=v_now
  WHERE lease.org_id=v_candidate.org_id AND lease.companion_id=v_candidate.companion_id
    AND lease.lane='background'
  RETURNING lease.claim_token,lease.claim_epoch,lease.gate_epoch
    INTO claim_token,claim_epoch,gate_epoch;
  UPDATE public.companion_v3_turns SET first_claimed_at=COALESCE(first_claimed_at,v_now),
    last_claimed_at=v_now,claim_count=claim_count+1,updated_at=v_now WHERE id=v_candidate.id;
  org_id:=v_candidate.org_id;companion_id:=v_candidate.companion_id;turn_id:=v_candidate.id;
  command_id:=v_candidate.command_id;lane:=v_candidate.lane;state:=v_candidate.state;
  admission_started_at:=v_candidate.admission_started_at;
  inactivity_deadline_at:=v_candidate.inactivity_deadline_at;
  absolute_deadline_at:=v_candidate.absolute_deadline_at;
  cleanup_box_id:=v_candidate.cleanup_box_id;
  cleanup_invocation_id:=v_candidate.cleanup_invocation_id;RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_runtime_claim_routine_v7(
  text,public.companion_v3_lane,integer,integer) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_runtime_claim_warm_v7(
  p_executor_id text,p_lane public.companion_v3_lane,p_lease_seconds integer,p_protocol integer
) RETURNS TABLE(org_id uuid,companion_id uuid,turn_id uuid,command_id uuid,
  lane public.companion_v3_lane,state public.companion_v3_turn_state,claim_token uuid,
  claim_epoch bigint,gate_epoch bigint,admission_started_at timestamptz,
  inactivity_deadline_at timestamptz,absolute_deadline_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=on AS $$
BEGIN
  IF p_protocol<>7 THEN RAISE EXCEPTION 'Runtime v3 protocol 7 is required' USING ERRCODE='42501';END IF;
  RETURN QUERY SELECT claimed.* FROM public.companion_v3_runtime_claim_warm_v6(
    p_executor_id,p_lane,p_lease_seconds,6) claimed;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_runtime_claim_warm_v7(
  text,public.companion_v3_lane,integer,integer) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_runtime_authorize_routine(
  p_org_id uuid,p_companion_id uuid,p_turn_id uuid,p_claim_token uuid,p_claim_epoch bigint,
  p_gate_epoch bigint,p_protocol integer
) RETURNS TABLE(box_id text,pi_invocation_id text,content text,activity_cursor bigint,persona text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_now timestamptz:=clock_timestamp();
BEGIN
  IF p_protocol<>7 THEN RAISE EXCEPTION 'Runtime v3 protocol 7 is required' USING ERRCODE='42501'; END IF;
  RETURN QUERY SELECT instance.box_id,
    'routine:'||turn_row.id::text||':dispatch-v2:'||turn_row.command_id::text,
    run.prompt,turn_row.activity_cursor,companion.persona
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
    AND public.companion_v3_routine_preparation_matches(
      turn_row.org_id,turn_row.companion_id,turn_row.actor_id)
    AND (turn_row.state IN ('queued','admitted','running','needs_input')
      OR (turn_row.state IN ('succeeded','failed') AND turn_row.journal_ack_pending))
    AND jsonb_typeof(companion.provider_ids)='array' AND jsonb_array_length(companion.provider_ids)=1
    AND companion.model_id IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(companion.provider_ids) selected(provider_id)
      WHERE NOT EXISTS(SELECT 1 FROM public.companion_provider_connections connection
        WHERE connection.org_id=turn_row.org_id AND connection.provider_id=selected.provider_id))
    AND jsonb_typeof(companion.selected_skill_ids)='array'
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(companion.selected_skill_ids) selected(skill_id)
      WHERE NOT EXISTS(SELECT 1 FROM public.skills skill WHERE skill.org_id=turn_row.org_id
        AND skill.id::text=selected.skill_id AND skill.archived_at IS NULL
        AND (skill.scope='org' OR skill.creator_id=turn_row.actor_id)))
    AND jsonb_typeof(companion.selected_mcp_account_ids)='array'
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(companion.selected_mcp_account_ids) selected(account_id)
      WHERE NOT EXISTS(SELECT 1 FROM public.companion_mcp_accounts account WHERE account.org_id=turn_row.org_id
        AND account.id::text=selected.account_id AND account.owner_id=turn_row.actor_id));
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_runtime_authorize_routine(
  uuid,uuid,uuid,uuid,bigint,bigint,integer) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_runtime_begin_routine_admission(
  p_org_id uuid,p_companion_id uuid,p_turn_id uuid,p_claim_token uuid,p_claim_epoch bigint,
  p_gate_epoch bigint,p_invocation_id text,p_cursor bigint,p_protocol integer
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_now timestamptz:=clock_timestamp();
BEGIN
  IF p_protocol<>7 OR p_cursor<0 OR p_invocation_id IS DISTINCT FROM
    'routine:'||p_turn_id::text||':dispatch-v2:'||(
      SELECT command_id::text FROM public.companion_v3_turns WHERE id=p_turn_id) THEN RETURN false;END IF;
  UPDATE public.companion_v3_turns turn_row SET admission_started_at=v_now,
    pi_invocation_id=p_invocation_id,admission_cursor=p_cursor,updated_at=v_now
  FROM public.companion_v3_lane_leases lease,public.companion_runtime_control control
  WHERE turn_row.org_id=p_org_id AND turn_row.companion_id=p_companion_id AND turn_row.id=p_turn_id
    AND turn_row.lane='background' AND turn_row.state='queued' AND turn_row.admission_state='pending'
    AND turn_row.admission_started_at IS NULL AND lease.org_id=turn_row.org_id
    AND lease.companion_id=turn_row.companion_id AND lease.lane='background'
    AND lease.turn_id=turn_row.id AND lease.claim_token=p_claim_token AND lease.claim_epoch=p_claim_epoch
    AND lease.gate_epoch=p_gate_epoch AND lease.expires_at>v_now AND control.id='runtime-v2'
    AND control.enabled AND control.gate_epoch=p_gate_epoch;
  IF NOT FOUND THEN RETURN false;END IF;
  UPDATE public.companion_v3_routine_runs SET outcome='running',started_at=COALESCE(started_at,v_now)
    WHERE org_id=p_org_id AND companion_id=p_companion_id AND turn_id=p_turn_id AND outcome='pending';
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_runtime_begin_routine_admission(
  uuid,uuid,uuid,uuid,bigint,bigint,text,bigint,integer) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_runtime_project_routine_page(
  p_org_id uuid,p_companion_id uuid,p_turn_id uuid,p_claim_token uuid,p_claim_epoch bigint,
  p_gate_epoch bigint,p_through_cursor bigint,p_entries jsonb,p_decisions jsonb,p_returns jsonb,
  p_needs_input boolean,p_activity boolean,p_terminal text,p_protocol integer
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_now timestamptz:=clock_timestamp();v_run public.companion_v3_routine_runs%ROWTYPE;
  v_item jsonb;v_sequence bigint;v_event_id text;v_ordinal integer;v_mode text;v_message text;
  v_main_event text;v_projection bigint;v_owner text;v_name text;v_relay uuid;v_admitted record;
  v_card jsonb;v_expires timestamptz;v_relay_client uuid;v_relay_event text;v_inserted integer;
BEGIN
  PERFORM pg_catalog.set_config('app.companion_runtime_protocol','2',true);
  IF p_protocol<>7 OR p_through_cursor<0 OR jsonb_typeof(p_entries)<>'array'
    OR jsonb_typeof(p_decisions)<>'array' OR jsonb_typeof(p_returns)<>'array'
    OR jsonb_array_length(p_entries)>128 OR jsonb_array_length(p_decisions)>32
    OR jsonb_array_length(p_returns)>1 OR p_terminal IS NOT NULL AND p_terminal NOT IN ('settled','process_exit')
    OR p_needs_input AND p_terminal IS NOT NULL THEN
    RAISE EXCEPTION 'invalid Runtime v3 routine projection' USING ERRCODE='22023';END IF;
  SELECT run.* INTO v_run FROM public.companion_v3_lane_leases lease
  JOIN public.companion_runtime_control control ON control.id='runtime-v2' AND control.enabled
    AND control.gate_epoch=p_gate_epoch
  JOIN public.companion_v3_turns turn_row ON turn_row.org_id=lease.org_id
    AND turn_row.companion_id=lease.companion_id AND turn_row.id=lease.turn_id
    AND turn_row.lane='background' AND turn_row.state IN ('admitted','running','needs_input')
    AND turn_row.admission_state='accepted' AND p_through_cursor>=turn_row.activity_cursor
  JOIN public.companion_v3_routine_runs run ON run.org_id=turn_row.org_id
    AND run.companion_id=turn_row.companion_id AND run.turn_id=turn_row.id
    AND run.outcome IN ('pending','running')
  WHERE lease.org_id=p_org_id AND lease.companion_id=p_companion_id AND lease.lane='background'
    AND lease.turn_id=p_turn_id AND lease.claim_token=p_claim_token
    AND lease.claim_epoch=p_claim_epoch AND lease.gate_epoch=p_gate_epoch AND lease.expires_at>v_now
  FOR UPDATE OF lease,turn_row,run;
  IF NOT FOUND THEN RETURN NULL;END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_entries)
  LOOP
    IF (v_item->>'sequence')!~'^[0-9]{1,18}$' THEN
      RAISE EXCEPTION 'invalid routine projection sequence' USING ERRCODE='22023';END IF;
    v_sequence:=(v_item->>'sequence')::bigint;
    v_event_id:='v3:'||p_turn_id::text||':private:'||v_sequence::text;
    IF v_item->>'type' IN ('assistant','decision','tool') AND NOT EXISTS(
      SELECT 1 FROM public.companion_v3_routine_run_entries WHERE org_id=p_org_id
        AND companion_id=p_companion_id AND run_id=p_turn_id AND event_id=v_event_id) THEN
      UPDATE public.companion_v3_routine_runs SET next_ordinal=next_ordinal+1
        WHERE org_id=p_org_id AND companion_id=p_companion_id AND turn_id=p_turn_id
        RETURNING next_ordinal-1 INTO v_ordinal;
      INSERT INTO public.companion_v3_routine_run_entries(org_id,companion_id,run_id,event_id,
        ordinal,role,content,reasoning,tool,decision,created_at)
      VALUES(p_org_id,p_companion_id,p_turn_id,v_event_id,v_ordinal,
        (v_item->>'type')::public.companion_transcript_role,
        COALESCE(v_item->>'content',CASE WHEN v_item->>'type'='tool' THEN v_item#>>'{tool,name}' ELSE '' END),
        CASE WHEN v_item->>'type'='assistant' THEN v_item->>'reasoning' END,
        CASE WHEN v_item->>'type'='tool' THEN v_item->'tool' END,
        CASE WHEN v_item->>'type'='decision' THEN v_item->'decision' END,v_now);
    END IF;
  END LOOP;

  -- Questions are durable public decisions, but the routine transcript that produced them stays private.
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_decisions)
  LOOP
    v_expires:=(v_item->>'expires_at')::timestamptz;
    v_card:=v_item->'decision';
    INSERT INTO public.companion_v3_decisions(org_id,companion_id,turn_id,lane,event_id,
      request_key,request_kind,expires_at,created_at)
    VALUES(p_org_id,p_companion_id,p_turn_id,'background',v_item->>'eventId',
      v_item->>'request_key','question',v_expires,v_now)
    ON CONFLICT (turn_id,request_key) DO NOTHING;
    GET DIAGNOSTICS v_inserted=ROW_COUNT;
    IF v_inserted=1 THEN
      v_card:=v_item->'decision';
      INSERT INTO public.companion_threads(org_id,companion_id) VALUES(p_org_id,p_companion_id)
        ON CONFLICT (companion_id) DO NOTHING;
      UPDATE public.companion_threads SET next_ordinal=next_ordinal+1,
        projection_sequence=projection_sequence+1,last_message_at=v_now,updated_at=v_now
        WHERE org_id=p_org_id AND companion_id=p_companion_id
        RETURNING next_ordinal-1,projection_sequence INTO v_ordinal,v_projection;
      INSERT INTO public.companion_transcript_entries(org_id,companion_id,event_id,ordinal,
        projection_sequence,role,content,decision,created_at)
      VALUES(p_org_id,p_companion_id,v_item->>'eventId',v_ordinal,v_projection,'decision',
        v_item->>'content',v_card,v_now);
    END IF;
  END LOOP;

  IF jsonb_array_length(p_returns)=1 THEN
    v_item:=p_returns->0;v_mode:=v_item->>'mode';v_message:=btrim(v_item->>'message');
    IF v_mode NOT IN ('notify','relay') OR char_length(v_message) NOT BETWEEN 1 AND 16384 THEN
      RAISE EXCEPTION 'invalid routine return' USING ERRCODE='22023';END IF;
    v_main_event:='routine-return:'||p_turn_id::text;
    SELECT companion.owner_id,companion.name INTO STRICT v_owner,v_name FROM public.companions companion
      WHERE companion.org_id=p_org_id AND companion.id=p_companion_id;
    IF v_mode='relay' THEN
      v_relay_client:=gen_random_uuid();v_relay_event:='msg:'||v_relay_client::text;
      SELECT * INTO v_admitted FROM public.companion_v3_admit_turn(p_org_id,p_companion_id,
        v_relay_client,v_relay_event,v_owner,'main');
      v_relay:=v_admitted.turn_id;
    END IF;
    INSERT INTO public.companion_threads(org_id,companion_id) VALUES(p_org_id,p_companion_id)
      ON CONFLICT (companion_id) DO NOTHING;
    UPDATE public.companion_threads SET next_ordinal=next_ordinal+1,
      projection_sequence=projection_sequence+1,last_message_at=v_now,updated_at=v_now
      WHERE org_id=p_org_id AND companion_id=p_companion_id
      RETURNING next_ordinal-1,projection_sequence INTO v_ordinal,v_projection;
    INSERT INTO public.companion_transcript_entries(org_id,companion_id,event_id,ordinal,
      projection_sequence,role,content,created_at)
    VALUES(p_org_id,p_companion_id,v_main_event,v_ordinal,v_projection,'assistant',v_message,v_now)
    ON CONFLICT (companion_id,event_id) DO NOTHING;
    IF v_relay IS NOT NULL THEN
      UPDATE public.companion_threads SET next_ordinal=next_ordinal+1,
        projection_sequence=projection_sequence+1,last_message_at=v_now,updated_at=v_now
        WHERE org_id=p_org_id AND companion_id=p_companion_id
        RETURNING next_ordinal-1,projection_sequence INTO v_ordinal,v_projection;
      INSERT INTO public.companion_transcript_entries(org_id,companion_id,event_id,ordinal,
        projection_sequence,role,content,author_id,created_at)
      VALUES(p_org_id,p_companion_id,v_relay_event,v_ordinal,v_projection,'user',
        'A scheduled routine surfaced the previous Companion entry. Read it and respond to that entry.',
        v_owner,v_now);
      UPDATE public.companion_v3_turns SET routine_relay_source_event_id=v_main_event,updated_at=v_now
        WHERE org_id=p_org_id AND companion_id=p_companion_id AND id=v_relay;
    END IF;
    UPDATE public.companion_v3_routine_runs SET outcome=v_mode,
      surface_mode=v_mode::public.companion_routine_surface_mode,
      main_entry_event_id=v_main_event,relay_turn_id=v_relay,settled_at=v_now WHERE org_id=p_org_id
      AND companion_id=p_companion_id AND turn_id=p_turn_id AND outcome IN ('pending','running');
  ELSIF p_terminal IS NOT DISTINCT FROM 'settled' THEN
    UPDATE public.companion_v3_routine_runs SET outcome='no_output',settled_at=v_now
      WHERE org_id=p_org_id AND companion_id=p_companion_id AND turn_id=p_turn_id
        AND outcome IN ('pending','running');
  END IF;

  UPDATE public.companion_v3_turns SET activity_cursor=p_through_cursor,
    correlated_activity_cursor=CASE WHEN p_activity THEN p_through_cursor ELSE correlated_activity_cursor END,
    first_activity_at=CASE WHEN p_activity THEN COALESCE(first_activity_at,v_now) ELSE first_activity_at END,
    last_activity_at=CASE WHEN p_activity THEN v_now ELSE last_activity_at END,
    state=CASE WHEN jsonb_array_length(p_returns)=1 OR p_terminal IS NOT DISTINCT FROM 'settled'
      THEN 'succeeded'::public.companion_v3_turn_state WHEN p_needs_input
      THEN 'needs_input'::public.companion_v3_turn_state
      ELSE 'running'::public.companion_v3_turn_state END,
    outcome=CASE WHEN jsonb_array_length(p_returns)=1 OR p_terminal IS NOT DISTINCT FROM 'settled'
      THEN 'succeeded'::public.companion_v3_turn_outcome END,
    settled_at=CASE WHEN jsonb_array_length(p_returns)=1 OR p_terminal IS NOT DISTINCT FROM 'settled' THEN v_now END,
    journal_ack_pending=jsonb_array_length(p_returns)=1 OR p_terminal IS NOT DISTINCT FROM 'settled',
    terminal_cursor=CASE WHEN jsonb_array_length(p_returns)=1 OR p_terminal IS NOT DISTINCT FROM 'settled' THEN p_through_cursor END,
    inactivity_deadline_at=CASE WHEN p_needs_input OR jsonb_array_length(p_returns)=1 OR p_terminal IS NOT DISTINCT FROM 'settled'
      THEN NULL ELSE LEAST(v_now+interval '10 minutes',absolute_deadline_at) END,
    absolute_deadline_at=CASE WHEN jsonb_array_length(p_returns)=1 OR p_terminal IS NOT DISTINCT FROM 'settled' THEN NULL ELSE absolute_deadline_at END,
    updated_at=v_now WHERE org_id=p_org_id AND companion_id=p_companion_id AND id=p_turn_id;
  IF jsonb_array_length(p_decisions)>0 THEN RETURN 'detached';END IF;
  IF jsonb_array_length(p_returns)=1 OR p_terminal IS NOT DISTINCT FROM 'settled' THEN RETURN 'succeeded';END IF;
  RETURN 'projected';
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_runtime_project_routine_page(
  uuid,uuid,uuid,uuid,bigint,bigint,bigint,jsonb,jsonb,jsonb,boolean,boolean,text,integer) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_runtime_authorize_warm_turn_v7(
  p_org_id uuid,p_companion_id uuid,p_lane public.companion_v3_lane,p_turn_id uuid,
  p_claim_token uuid,p_claim_epoch bigint,p_gate_epoch bigint,p_protocol integer
) RETURNS TABLE(box_id text,pi_invocation_id text,content text,activity_cursor bigint,
  recovery_deferred boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_material record;v_source text;
BEGIN
  IF p_protocol<>7 THEN RAISE EXCEPTION 'Runtime v3 protocol 7 is required' USING ERRCODE='42501';END IF;
  SELECT authorized.* INTO v_material FROM public.companion_v3_runtime_authorize_warm_turn_v5(
    p_org_id,p_companion_id,p_lane,p_turn_id,p_claim_token,p_claim_epoch,p_gate_epoch,5) authorized;
  IF NOT FOUND THEN RETURN;END IF;
  SELECT source.content INTO v_source FROM public.companion_v3_turns turn_row
  JOIN public.companion_transcript_entries source ON source.org_id=turn_row.org_id
    AND source.companion_id=turn_row.companion_id
    AND source.event_id=turn_row.routine_relay_source_event_id
  WHERE turn_row.org_id=p_org_id AND turn_row.companion_id=p_companion_id AND turn_row.id=p_turn_id;
  RETURN QUERY SELECT v_material.box_id,v_material.pi_invocation_id,
    CASE WHEN v_source IS NULL THEN v_material.content
      ELSE v_material.content||E'\n\n[Scheduled routine result]\n'||v_source END,
    v_material.activity_cursor,v_material.recovery_deferred;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_runtime_authorize_warm_turn_v7(
  uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,integer) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_runtime_complete_v7(
  p_org_id uuid,p_companion_id uuid,p_lane public.companion_v3_lane,p_turn_id uuid,
  p_claim_token uuid,p_claim_epoch bigint,p_gate_epoch bigint,p_outcome text,p_code text,
  p_message text,p_action public.companion_runtime_error_action,p_protocol integer
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_now timestamptz:=clock_timestamp();v_retry integer;v_delay integer;
  v_turn public.companion_v3_turns%ROWTYPE;v_run public.companion_v3_routine_runs%ROWTYPE;
  v_terminal_state public.companion_v3_turn_state;v_run_outcome text;
BEGIN
  IF p_protocol<>7 THEN RAISE EXCEPTION 'Runtime v3 protocol 7 is required' USING ERRCODE='42501';END IF;
  IF p_lane='main' THEN
    RETURN public.companion_v3_runtime_complete_v6(p_org_id,p_companion_id,p_lane,p_turn_id,
      p_claim_token,p_claim_epoch,p_gate_epoch,p_outcome,p_code,p_message,p_action,6);
  END IF;
  SELECT turn_row.* INTO v_turn FROM public.companion_v3_lane_leases lease
  JOIN public.companion_runtime_control control ON control.id='runtime-v2' AND control.enabled
    AND control.gate_epoch=p_gate_epoch
  JOIN public.companion_v3_turns turn_row ON turn_row.org_id=lease.org_id
    AND turn_row.companion_id=lease.companion_id AND turn_row.id=lease.turn_id
  JOIN public.companion_v3_routine_runs run ON run.org_id=lease.org_id
    AND run.companion_id=lease.companion_id AND run.turn_id=lease.turn_id
  WHERE lease.org_id=p_org_id AND lease.companion_id=p_companion_id AND lease.lane='background'
    AND lease.turn_id=p_turn_id AND lease.claim_token=p_claim_token
    AND lease.claim_epoch=p_claim_epoch AND lease.gate_epoch=p_gate_epoch AND lease.expires_at>v_now
  FOR UPDATE OF lease,turn_row,run;
  IF NOT FOUND THEN RETURN false;END IF;
  SELECT run.* INTO STRICT v_run FROM public.companion_v3_routine_runs run
    WHERE run.org_id=p_org_id AND run.companion_id=p_companion_id AND run.turn_id=p_turn_id;

  -- Cooperative polling and terminal-ACK retry release only the lease. Durable admission,
  -- invocation, cursors, deadlines, and retry count remain unchanged for takeover.
  IF p_outcome IN ('release','retry_ack') THEN
    UPDATE public.companion_v3_lane_leases SET claim_token=NULL,gate_epoch=NULL,executor_id=NULL,
      turn_id=NULL,claimed_at=NULL,renewed_at=NULL,expires_at=NULL,updated_at=v_now
    WHERE org_id=p_org_id AND companion_id=p_companion_id AND lane='background'
      AND claim_token=p_claim_token AND claim_epoch=p_claim_epoch;
    RETURN FOUND;
  END IF;

  IF p_outcome='ack_completed' THEN
    UPDATE public.companion_v3_turns SET journal_ack_pending=false,updated_at=v_now
      WHERE org_id=p_org_id AND companion_id=p_companion_id AND id=p_turn_id
        AND state IN ('succeeded','failed');
    UPDATE public.companion_v3_lane_leases SET claim_token=NULL,gate_epoch=NULL,executor_id=NULL,
      turn_id=NULL,claimed_at=NULL,renewed_at=NULL,expires_at=NULL,updated_at=v_now
      WHERE org_id=p_org_id AND companion_id=p_companion_id AND lane='background'
        AND claim_token=p_claim_token AND claim_epoch=p_claim_epoch;
    RETURN FOUND;
  END IF;

  IF p_outcome='detached' THEN
    UPDATE public.companion_v3_turns SET state='cancelled',outcome='cancelled',
      outcome_code=NULL,outcome_message=NULL,outcome_action=NULL,settled_at=v_now,updated_at=v_now
      WHERE org_id=p_org_id AND companion_id=p_companion_id AND id=p_turn_id;
    UPDATE public.companion_v3_routine_runs SET outcome='cancelled',settled_at=v_now,
      cleanup_checkpoint=NULL,cleanup_invocation_id=NULL
      WHERE org_id=p_org_id AND companion_id=p_companion_id AND turn_id=p_turn_id
        AND outcome IN ('pending','running');
    UPDATE public.companion_v3_lane_leases SET claim_token=NULL,claim_epoch=claim_epoch+1,
      gate_epoch=NULL,executor_id=NULL,turn_id=NULL,claimed_at=NULL,renewed_at=NULL,
      expires_at=NULL,updated_at=v_now WHERE org_id=p_org_id AND companion_id=p_companion_id
      AND lane='background' AND claim_token=p_claim_token AND claim_epoch=p_claim_epoch;
    RETURN FOUND;
  END IF;

  IF p_outcome='cleanup_completed' THEN
    IF v_run.cleanup_checkpoint IS DISTINCT FROM 'terminate'
      OR v_run.cleanup_invocation_id IS NULL THEN RETURN false;END IF;
    IF v_run.cleanup_retry THEN
      v_retry:=v_turn.retry_count+1;
      v_delay:=CASE WHEN v_retry=1 THEN 5 WHEN v_retry=2 THEN 15 WHEN v_retry=3 THEN 30
        WHEN v_retry=4 THEN 60 ELSE 300 END;
      UPDATE public.companion_v3_turns SET state='queued',admission_state='pending',
        admission_kind=NULL,admission_started_at=NULL,admitted_at=NULL,pi_invocation_id=NULL,
        response_turn_id=NULL,terminal_cursor=NULL,journal_ack_pending=false,admission_cursor=NULL,
        activity_cursor=0,correlated_activity_cursor=0,last_activity_at=NULL,first_activity_at=NULL,
        inactivity_deadline_at=NULL,absolute_deadline_at=NULL,outcome=NULL,outcome_code=NULL,
        outcome_message=NULL,outcome_action=NULL,settled_at=NULL,retry_count=v_retry,
        available_at=v_now+make_interval(
          secs=>greatest(1,round(v_delay*(0.8+random()*0.4))::integer)),updated_at=v_now
        WHERE org_id=p_org_id AND companion_id=p_companion_id AND id=p_turn_id;
      UPDATE public.companion_v3_routine_runs SET outcome='pending',started_at=NULL,settled_at=NULL,
        cleanup_checkpoint=NULL,cleanup_invocation_id=NULL,cleanup_retry=false
        WHERE org_id=p_org_id AND companion_id=p_companion_id AND turn_id=p_turn_id;
    ELSE
      -- A terminal accepted Turn retains its immutable invocation as execution history. Clearing
      -- the cleanup checkpoint is the durable proof that this identity was already terminated.
      UPDATE public.companion_v3_routine_runs SET cleanup_checkpoint=NULL,
        cleanup_invocation_id=NULL,cleanup_retry=false
        WHERE org_id=p_org_id AND companion_id=p_companion_id AND turn_id=p_turn_id;
    END IF;
    UPDATE public.companion_v3_lane_leases SET claim_token=NULL,claim_epoch=claim_epoch+1,
      gate_epoch=NULL,executor_id=NULL,
      turn_id=NULL,claimed_at=NULL,renewed_at=NULL,expires_at=NULL,updated_at=v_now
      WHERE org_id=p_org_id AND companion_id=p_companion_id AND lane='background'
        AND claim_token=p_claim_token AND claim_epoch=p_claim_epoch;
    UPDATE public.companion_v3_instances instance SET lifecycle_available_at=v_now,updated_at=v_now
      WHERE instance.org_id=p_org_id AND instance.companion_id=p_companion_id
        AND instance.desired_lifecycle='delete'
        AND NOT EXISTS (SELECT 1 FROM public.companion_v3_routine_runs pending_cleanup
          WHERE pending_cleanup.org_id=p_org_id AND pending_cleanup.companion_id=p_companion_id
            AND pending_cleanup.cleanup_checkpoint='terminate');
    RETURN true;
  END IF;

  IF p_outcome IN ('admission_rejected','failed','interrupted','decision_ambiguous') THEN
    v_terminal_state:=CASE WHEN p_outcome IN ('admission_rejected','failed')
      THEN 'failed'::public.companion_v3_turn_state
      ELSE 'interrupted'::public.companion_v3_turn_state END;
    v_run_outcome:=CASE WHEN p_outcome IN ('admission_rejected','failed')
      THEN 'failed' ELSE 'interrupted' END;
    UPDATE public.companion_v3_turns SET state=v_terminal_state,
      outcome=v_terminal_state::text::public.companion_v3_turn_outcome,
      outcome_code=p_code,outcome_message=p_message,outcome_action=p_action,
      settled_at=v_now,updated_at=v_now
      WHERE org_id=p_org_id AND companion_id=p_companion_id AND id=p_turn_id;
    UPDATE public.companion_v3_routine_runs SET outcome=v_run_outcome,settled_at=v_now,
      cleanup_checkpoint=CASE WHEN v_turn.pi_invocation_id IS NULL THEN NULL ELSE 'terminate' END,
      cleanup_invocation_id=v_turn.pi_invocation_id,
      cleanup_retry=p_outcome='admission_rejected' AND v_turn.pi_invocation_id IS NOT NULL
      WHERE org_id=p_org_id AND companion_id=p_companion_id AND turn_id=p_turn_id;
    UPDATE public.companion_v3_lane_leases SET claim_token=NULL,claim_epoch=claim_epoch+1,
      gate_epoch=NULL,executor_id=NULL,turn_id=NULL,claimed_at=NULL,renewed_at=NULL,
      expires_at=NULL,updated_at=v_now WHERE org_id=p_org_id AND companion_id=p_companion_id
      AND lane='background' AND claim_token=p_claim_token AND claim_epoch=p_claim_epoch;
    RETURN true;
  END IF;
  RETURN false;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_runtime_complete_v7(
  uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,text,text,text,
  public.companion_runtime_error_action,integer) FROM PUBLIC;
--> statement-breakpoint

-- A deadline only makes exact routine cleanup due. Runtime owns termination of the captured
-- run-scoped Pi invocation; SQL never clears or reuses that identity before confirmation.
CREATE FUNCTION public.companion_v3_runtime_sweep_routine_deadlines_v7(p_protocol integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_now timestamptz:=clock_timestamp();v_candidate record;v_count integer:=0;
  v_code text;v_message text;
BEGIN
  IF p_protocol<>7 THEN RAISE EXCEPTION 'Runtime v3 protocol 7 is required' USING ERRCODE='42501';END IF;
  PERFORM 1 FROM public.companion_runtime_control WHERE id='runtime-v2' AND enabled FOR SHARE;
  IF NOT FOUND THEN RETURN 0;END IF;
  LOOP
    SELECT turn_row.org_id,turn_row.companion_id,turn_row.id,turn_row.pi_invocation_id,
      turn_row.absolute_deadline_at,turn_row.inactivity_deadline_at
      INTO v_candidate
    FROM public.companion_v3_turns turn_row
    JOIN public.companion_v3_routine_runs run ON run.org_id=turn_row.org_id
      AND run.companion_id=turn_row.companion_id AND run.turn_id=turn_row.id
      AND run.outcome IN ('pending','running')
    WHERE turn_row.lane='background' AND turn_row.state IN ('admitted','running','needs_input')
      AND turn_row.pi_invocation_id IS NOT NULL AND run.cleanup_checkpoint IS NULL
      AND ((turn_row.inactivity_deadline_at IS NOT NULL AND turn_row.inactivity_deadline_at<=v_now)
        OR (turn_row.absolute_deadline_at IS NOT NULL AND turn_row.absolute_deadline_at<=v_now))
    ORDER BY COALESCE(turn_row.absolute_deadline_at,turn_row.inactivity_deadline_at),turn_row.id
    LIMIT 1;
    EXIT WHEN NOT FOUND OR v_count>=64;
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      v_candidate.org_id::text||':'||v_candidate.companion_id::text,0));
    IF v_candidate.absolute_deadline_at IS NOT NULL
      AND v_candidate.absolute_deadline_at<=v_now THEN
      v_code:='turn_deadline_exceeded';
      v_message:='The Companion reached its maximum execution time.';
    ELSE
      v_code:='turn_stalled';v_message:='The Companion stopped making progress.';
    END IF;
    UPDATE public.companion_v3_turns SET state='interrupted',outcome='interrupted',
      outcome_code=v_code,outcome_message=v_message,outcome_action='none',settled_at=v_now,
      updated_at=v_now WHERE org_id=v_candidate.org_id AND companion_id=v_candidate.companion_id
      AND id=v_candidate.id AND state IN ('admitted','running','needs_input');
    IF NOT FOUND THEN CONTINUE;END IF;
    UPDATE public.companion_v3_routine_runs SET outcome='interrupted',settled_at=v_now,
      cleanup_checkpoint='terminate',cleanup_invocation_id=v_candidate.pi_invocation_id,
      cleanup_retry=false
      WHERE org_id=v_candidate.org_id AND companion_id=v_candidate.companion_id
        AND turn_id=v_candidate.id AND outcome IN ('pending','running');
    UPDATE public.companion_v3_lane_leases SET claim_token=NULL,claim_epoch=claim_epoch+1,
      gate_epoch=NULL,executor_id=NULL,turn_id=NULL,claimed_at=NULL,renewed_at=NULL,
      expires_at=NULL,updated_at=v_now WHERE org_id=v_candidate.org_id
      AND companion_id=v_candidate.companion_id AND lane='background'
      AND turn_id=v_candidate.id;
    v_count:=v_count+1;
  END LOOP;
  RETURN v_count;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_runtime_sweep_routine_deadlines_v7(integer) FROM PUBLIC;
--> statement-breakpoint

-- Keep the established routine-history API contract while reading new v3 background runs first.
-- The main-thread payload remains a reference; only the private run entries are returned here.
ALTER FUNCTION public.companion_api_routine_run_json(
  uuid,uuid,uuid,boolean,integer,integer)
  RENAME TO companion_api_routine_run_json_v2;
--> statement-breakpoint
ALTER FUNCTION public.companion_api_list_routine_runs(uuid,uuid,uuid,uuid,integer)
  RENAME TO companion_api_list_routine_runs_v2;
--> statement-breakpoint
ALTER FUNCTION public.companion_api_get_routine_run(uuid,uuid,uuid,integer,integer)
  RENAME TO companion_api_get_routine_run_v2;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_v3_routine_run_json(
  p_org_id uuid,p_companion_id uuid,p_run_id uuid,p_viewer boolean DEFAULT false,
  p_entry_cursor integer DEFAULT NULL,p_entry_limit integer DEFAULT 50
) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
  SELECT jsonb_build_object(
    'run_id',run.turn_id,
    'companion_id',run.companion_id,
    'routine',jsonb_build_object('id',run.routine_snapshot_id,'name',run.routine_name),
    'status',turn_row.state,
    'outcome',CASE WHEN run.outcome IN ('notify','relay') THEN 'surfaced'
      WHEN run.outcome='no_output' THEN 'no_output'
      WHEN run.outcome IN ('failed','interrupted','cancelled','superseded') THEN 'error'
      ELSE 'pending' END,
    'surface_mode',run.surface_mode,
    'main_entry_event_id',run.main_entry_event_id,
    'relay_turn_id',run.relay_turn_id,
    'created_at',run.created_at,
    'started_at',run.started_at,
    'settled_at',run.settled_at,
    'error',CASE
      WHEN run.outcome='superseded' THEN public.companion_api_safe_error(
        'routine_superseded','A newer scheduled occurrence replaced this pending run.',
        'none'::public.companion_runtime_error_action)
      WHEN p_viewer AND turn_row.outcome_code IS NOT NULL THEN public.companion_api_safe_error(
        'runtime_unavailable','Companion runtime needs attention.',
        'none'::public.companion_runtime_error_action)
      ELSE public.companion_api_safe_error(
        turn_row.outcome_code,turn_row.outcome_message,turn_row.outcome_action)
    END,
    'internal_entries',COALESCE(history_page.entries,'[]'::jsonb),
    'next_entry_cursor',history_page.next_cursor
  )
  FROM public.companion_v3_routine_runs run
  JOIN public.companion_v3_turns turn_row ON turn_row.org_id=run.org_id
    AND turn_row.companion_id=run.companion_id AND turn_row.id=run.turn_id
  LEFT JOIN LATERAL (
    WITH ranked_entries AS MATERIALIZED (
      SELECT entry.*,
        row_number() OVER (ORDER BY entry.ordinal,entry.event_id) AS page_number,
        sum(octet_length(entry.content)+COALESCE(octet_length(entry.reasoning),0)
          +COALESCE(octet_length(entry.tool::text),0)
          +COALESCE(octet_length(entry.decision::text),0)+256)
          OVER (ORDER BY entry.ordinal,entry.event_id) AS cumulative_bytes
      FROM public.companion_v3_routine_run_entries entry
      WHERE entry.org_id=run.org_id AND entry.companion_id=run.companion_id
        AND entry.run_id=run.turn_id
        AND (p_entry_cursor IS NULL OR entry.ordinal>p_entry_cursor)
    ), page AS MATERIALIZED (
      SELECT entry.* FROM ranked_entries entry
      WHERE entry.page_number<=greatest(1,least(COALESCE(p_entry_limit,50),100))
        AND (entry.cumulative_bytes<=8388608 OR entry.page_number=1)
      ORDER BY entry.ordinal,entry.event_id
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'event_id',entry.event_id,'ordinal',entry.ordinal,'role',entry.role,
      'content',entry.content,'reasoning',entry.reasoning,'tool',entry.tool,
      'decision',entry.decision,'created_at',entry.created_at)
      ORDER BY entry.ordinal,entry.event_id),'[]'::jsonb) AS entries,
      CASE WHEN count(*)<(SELECT count(*) FROM ranked_entries) THEN max(entry.ordinal)
        ELSE NULL END AS next_cursor
    FROM page entry
  ) history_page ON COALESCE(p_entry_limit,50)>0
  WHERE run.org_id=p_org_id AND run.companion_id=p_companion_id AND run.turn_id=p_run_id
$$;
REVOKE ALL ON FUNCTION public.companion_api_v3_routine_run_json(
  uuid,uuid,uuid,boolean,integer,integer) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_routine_run_json(
  p_org_id uuid,p_companion_id uuid,p_run_id uuid,p_viewer boolean DEFAULT false,
  p_entry_cursor integer DEFAULT NULL,p_entry_limit integer DEFAULT 50
) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
  SELECT COALESCE(
    public.companion_api_v3_routine_run_json(p_org_id,p_companion_id,p_run_id,p_viewer,
      p_entry_cursor,p_entry_limit),
    public.companion_api_routine_run_json_v2(p_org_id,p_companion_id,p_run_id,p_viewer,
      p_entry_cursor,p_entry_limit))
$$;
REVOKE ALL ON FUNCTION public.companion_api_routine_run_json(
  uuid,uuid,uuid,boolean,integer,integer) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.companion_api_routine_run_summary_json(
  p_org_id uuid,p_companion_id uuid,p_run_id uuid,p_viewer boolean DEFAULT false
) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
  SELECT public.companion_api_routine_run_json(
    p_org_id,p_companion_id,p_run_id,p_viewer,NULL,0)
    - ARRAY['internal_entries','next_entry_cursor']
$$;
REVOKE ALL ON FUNCTION public.companion_api_routine_run_summary_json(
  uuid,uuid,uuid,boolean) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_list_routine_runs(
  p_org_id uuid,p_companion_id uuid,p_routine_id uuid,p_cursor uuid DEFAULT NULL,
  p_limit integer DEFAULT 50
) RETURNS TABLE(run jsonb) LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $function$
DECLARE v_access text;
BEGIN
  v_access:=public.companion_api_require_access(p_org_id,p_companion_id,'read');
  RETURN QUERY
  WITH all_runs AS MATERIALIZED (
    SELECT v3.turn_id AS run_id,v3.created_at
    FROM public.companion_v3_routine_runs v3
    WHERE v3.org_id=p_org_id AND v3.companion_id=p_companion_id
      AND v3.routine_snapshot_id=p_routine_id
    UNION ALL
    SELECT legacy.id,legacy.created_at FROM public.companion_turns legacy
    WHERE legacy.org_id=p_org_id AND legacy.companion_id=p_companion_id
      AND legacy.routine_name IS NOT NULL
      AND COALESCE(legacy.routine_snapshot_id,legacy.routine_id)=p_routine_id
  ), cursor_position AS (
    SELECT cursor_run.created_at,cursor_run.run_id FROM all_runs cursor_run
    WHERE cursor_run.run_id=p_cursor
  )
  SELECT public.companion_api_routine_run_summary_json(
    p_org_id,p_companion_id,candidate.run_id,v_access='viewer')
  FROM all_runs candidate
  WHERE p_cursor IS NULL OR EXISTS (
    SELECT 1 FROM cursor_position cursor_run
    WHERE (candidate.created_at,candidate.run_id)<(cursor_run.created_at,cursor_run.run_id))
  ORDER BY candidate.created_at DESC,candidate.run_id DESC
  LIMIT greatest(1,least(COALESCE(p_limit,50),101));
END
$function$;
REVOKE ALL ON FUNCTION public.companion_api_list_routine_runs(
  uuid,uuid,uuid,uuid,integer) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_get_routine_run(
  p_org_id uuid,p_companion_id uuid,p_run_id uuid,p_entry_cursor integer DEFAULT NULL,
  p_entry_limit integer DEFAULT 50
) RETURNS TABLE(run jsonb) LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $function$
DECLARE v_access text;v_run jsonb;
BEGIN
  v_access:=public.companion_api_require_access(p_org_id,p_companion_id,'read');
  v_run:=public.companion_api_routine_run_json(p_org_id,p_companion_id,p_run_id,
    v_access='viewer',p_entry_cursor,greatest(1,least(COALESCE(p_entry_limit,50),100)));
  IF v_run IS NOT NULL THEN RETURN QUERY SELECT v_run;END IF;
END
$function$;
REVOKE ALL ON FUNCTION public.companion_api_get_routine_run(
  uuid,uuid,uuid,integer,integer) FROM PUBLIC;
--> statement-breakpoint

DO $companion_v3_routine_history_acl$
DECLARE v_source oid:=pg_catalog.to_regprocedure('public.companion_api_read_thread(uuid,uuid)');
  v_grantee oid;v_role name;
BEGIN
  IF v_source IS NULL THEN RAISE EXCEPTION 'Companion API thread surface is missing' USING ERRCODE='55000';END IF;
  FOR v_grantee IN SELECT DISTINCT acl.grantee FROM pg_catalog.pg_proc source_proc
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(source_proc.proacl,pg_catalog.acldefault('f',source_proc.proowner))) acl
    WHERE source_proc.oid=v_source AND acl.privilege_type='EXECUTE'
      AND acl.grantee<>source_proc.proowner
  LOOP
    SELECT rolname INTO v_role FROM pg_catalog.pg_roles WHERE oid=v_grantee;
    IF v_role IS NOT NULL THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_api_list_routine_runs(uuid,uuid,uuid,uuid,integer) TO %I',v_role);
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_api_get_routine_run(uuid,uuid,uuid,integer,integer) TO %I',v_role);
    END IF;
  END LOOP;
END
$companion_v3_routine_history_acl$;
--> statement-breakpoint

DO $$ DECLARE v_role text;BEGIN
  FOREACH v_role IN ARRAY ARRAY[current_setting('companion.companion_runtime_role',true),
    current_setting('companion.runtime_role',true)] LOOP
    IF v_role IS NULL OR btrim(v_role)='' OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=v_role) THEN CONTINUE;END IF;
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_v3_runtime_claim_warm_v7(text,public.companion_v3_lane,integer,integer) TO %I',v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_v3_runtime_claim_routine_v7(text,public.companion_v3_lane,integer,integer) TO %I',v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_v3_runtime_authorize_warm_turn_v7(uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,integer) TO %I',v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_v3_runtime_authorize_routine(uuid,uuid,uuid,uuid,bigint,bigint,integer) TO %I',v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_v3_runtime_begin_routine_admission(uuid,uuid,uuid,uuid,bigint,bigint,text,bigint,integer) TO %I',v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_v3_runtime_project_routine_page(uuid,uuid,uuid,uuid,bigint,bigint,bigint,jsonb,jsonb,jsonb,boolean,boolean,text,integer) TO %I',v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_v3_runtime_sweep_routine_deadlines_v7(integer) TO %I',v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_v3_runtime_complete_v7(uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,text,text,text,public.companion_runtime_error_action,integer) TO %I',v_role);
  END LOOP;
END $$;
--> statement-breakpoint
