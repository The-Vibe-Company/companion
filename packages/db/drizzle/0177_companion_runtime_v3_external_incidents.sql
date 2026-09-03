-- Runtime v3 external dependency failures are retryable occurrences, not source configuration.
-- The durable incident key contains only a coarse class and a one-way dependency fingerprint;
-- operator/member delivery checkpoints therefore aggregate a continuous outage without retaining
-- credentials, URLs, provider payloads, message ids, or tenant data in metric labels.
CREATE TYPE public.companion_v3_external_failure_class AS ENUM (
  'box', 'model', 'plugin_provider', 'authority'
);
--> statement-breakpoint
CREATE TYPE public.companion_v3_work_source AS ENUM (
  'main', 'routine', 'trigger', 'delegation'
);
--> statement-breakpoint

CREATE TABLE public.companion_v3_external_incidents (
  id uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  companion_id uuid NOT NULL,
  failure_class public.companion_v3_external_failure_class NOT NULL,
  dependency_fingerprint text NOT NULL,
  stable_code text NOT NULL,
  first_source public.companion_v3_work_source NOT NULL,
  last_source public.companion_v3_work_source NOT NULL,
  occurrence_count integer NOT NULL DEFAULT 1,
  opened_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
  last_seen_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
  operator_signal_at timestamp with time zone,
  member_signal_at timestamp with time zone,
  recovered_at timestamp with time zone,
  recovery_signal_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT companion_v3_external_incidents_instance_fk
    FOREIGN KEY (org_id, companion_id)
    REFERENCES public.companion_v3_instances(org_id, companion_id) ON DELETE CASCADE,
  CONSTRAINT companion_v3_external_incidents_fingerprint_check
    CHECK (dependency_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT companion_v3_external_incidents_code_check
    CHECK (stable_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT companion_v3_external_incidents_count_check CHECK (occurrence_count >= 1),
  CONSTRAINT companion_v3_external_incidents_recovery_check CHECK (
    recovery_signal_at IS NULL OR recovered_at IS NOT NULL
  ),
  CONSTRAINT companion_v3_external_incidents_scope_uq UNIQUE (id, org_id, companion_id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX companion_v3_external_incidents_open_uq
  ON public.companion_v3_external_incidents(
    org_id, companion_id, failure_class, dependency_fingerprint
  ) WHERE recovered_at IS NULL;
CREATE INDEX companion_v3_external_incidents_slo_idx
  ON public.companion_v3_external_incidents(failure_class, opened_at, recovered_at);
--> statement-breakpoint

-- Occurrences are intentionally separate from the alert aggregate: this keeps exact SLO/source
-- attribution without storing any dependency identifier or provider-controlled value.
CREATE TABLE public.companion_v3_external_incident_occurrences (
  id uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  companion_id uuid NOT NULL,
  incident_id uuid NOT NULL,
  source public.companion_v3_work_source NOT NULL,
  occurred_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT companion_v3_external_incident_occurrences_incident_fk
    FOREIGN KEY (incident_id, org_id, companion_id)
    REFERENCES public.companion_v3_external_incidents(id, org_id, companion_id) ON DELETE CASCADE
);
CREATE INDEX companion_v3_external_incident_occurrences_slo_idx
  ON public.companion_v3_external_incident_occurrences(occurred_at, incident_id, source);
--> statement-breakpoint

-- A proven external refusal whose producer omitted an exact provider/grant identity still counts
-- in SLO and receives bounded retry, but cannot invent or merge a dependency incident.
CREATE TABLE public.companion_v3_external_unattributed_occurrences (
  id uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  companion_id uuid NOT NULL,
  failure_class public.companion_v3_external_failure_class NOT NULL,
  source public.companion_v3_work_source NOT NULL,
  occurred_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT companion_v3_external_unattributed_occurrences_instance_fk
    FOREIGN KEY (org_id, companion_id)
    REFERENCES public.companion_v3_instances(org_id, companion_id) ON DELETE CASCADE
);
CREATE INDEX companion_v3_external_unattributed_occurrences_slo_idx
  ON public.companion_v3_external_unattributed_occurrences(occurred_at, failure_class, source);
--> statement-breakpoint

CREATE TABLE public.companion_v3_external_incident_signals (
  id uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  companion_id uuid NOT NULL,
  incident_id uuid NOT NULL,
  kind text NOT NULL,
  failure_class public.companion_v3_external_failure_class NOT NULL,
  source public.companion_v3_work_source NOT NULL,
  stable_code text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
  claim_token uuid,
  claim_epoch bigint NOT NULL DEFAULT 0,
  claimed_by text,
  claim_expires_at timestamp with time zone,
  acknowledged_at timestamp with time zone,
  CONSTRAINT companion_v3_external_incident_signals_incident_fk
    FOREIGN KEY (incident_id, org_id, companion_id)
    REFERENCES public.companion_v3_external_incidents(id, org_id, companion_id) ON DELETE CASCADE,
  CONSTRAINT companion_v3_external_incident_signals_kind_check CHECK (kind IN ('opened','recovered')),
  CONSTRAINT companion_v3_external_incident_signals_code_check
    CHECK (stable_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT companion_v3_external_incident_signals_claim_check CHECK (
    (claim_token IS NULL AND claimed_by IS NULL AND claim_expires_at IS NULL)
    OR (claim_token IS NOT NULL AND claimed_by IS NOT NULL AND claim_expires_at IS NOT NULL)
  ),
  CONSTRAINT companion_v3_external_incident_signals_incident_kind_uq UNIQUE (incident_id, kind)
);
CREATE INDEX companion_v3_external_incident_signals_pending_idx
  ON public.companion_v3_external_incident_signals(created_at, id)
  WHERE acknowledged_at IS NULL;
--> statement-breakpoint

ALTER TABLE public.companion_v3_external_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companion_v3_external_incidents FORCE ROW LEVEL SECURITY;
CREATE POLICY companion_v3_external_incidents_function_owner_rls
  ON public.companion_v3_external_incidents
  USING (pg_has_role(current_user, (SELECT c.relowner FROM pg_catalog.pg_class c
    WHERE c.oid='public.companion_v3_external_incidents'::regclass), 'USAGE'))
  WITH CHECK (pg_has_role(current_user, (SELECT c.relowner FROM pg_catalog.pg_class c
    WHERE c.oid='public.companion_v3_external_incidents'::regclass), 'USAGE'));
--> statement-breakpoint

ALTER TABLE public.companion_v3_external_incident_occurrences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companion_v3_external_incident_occurrences FORCE ROW LEVEL SECURITY;
CREATE POLICY companion_v3_external_incident_occurrences_function_owner_rls
  ON public.companion_v3_external_incident_occurrences
  USING (pg_has_role(current_user, (SELECT c.relowner FROM pg_catalog.pg_class c
    WHERE c.oid='public.companion_v3_external_incident_occurrences'::regclass), 'USAGE'))
  WITH CHECK (pg_has_role(current_user, (SELECT c.relowner FROM pg_catalog.pg_class c
    WHERE c.oid='public.companion_v3_external_incident_occurrences'::regclass), 'USAGE'));
--> statement-breakpoint

ALTER TABLE public.companion_v3_external_unattributed_occurrences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companion_v3_external_unattributed_occurrences FORCE ROW LEVEL SECURITY;
CREATE POLICY companion_v3_external_unattributed_occurrences_function_owner_rls
  ON public.companion_v3_external_unattributed_occurrences
  USING (pg_has_role(current_user, (SELECT c.relowner FROM pg_catalog.pg_class c
    WHERE c.oid='public.companion_v3_external_unattributed_occurrences'::regclass), 'USAGE'))
  WITH CHECK (pg_has_role(current_user, (SELECT c.relowner FROM pg_catalog.pg_class c
    WHERE c.oid='public.companion_v3_external_unattributed_occurrences'::regclass), 'USAGE'));
--> statement-breakpoint

ALTER TABLE public.companion_v3_external_incident_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companion_v3_external_incident_signals FORCE ROW LEVEL SECURITY;
CREATE POLICY companion_v3_external_incident_signals_function_owner_rls
  ON public.companion_v3_external_incident_signals
  USING (pg_has_role(current_user, (SELECT c.relowner FROM pg_catalog.pg_class c
    WHERE c.oid='public.companion_v3_external_incident_signals'::regclass), 'USAGE'))
  WITH CHECK (pg_has_role(current_user, (SELECT c.relowner FROM pg_catalog.pg_class c
    WHERE c.oid='public.companion_v3_external_incident_signals'::regclass), 'USAGE'));
--> statement-breakpoint

ALTER TABLE public.companion_v3_turns
  ADD COLUMN external_incident_id uuid
    REFERENCES public.companion_v3_external_incidents(id) ON DELETE SET NULL,
  ADD COLUMN external_failure_class public.companion_v3_external_failure_class,
  ADD COLUMN external_failure_source public.companion_v3_work_source,
  ADD COLUMN external_blocked_message text,
  ADD CONSTRAINT companion_v3_turns_external_failure_check CHECK (
    (external_incident_id IS NULL AND external_failure_class IS NULL
      AND external_failure_source IS NULL AND external_blocked_message IS NULL)
    OR (external_incident_id IS NOT NULL AND external_failure_class IS NOT NULL
      AND external_failure_source IS NOT NULL
      AND char_length(external_blocked_message) BETWEEN 1 AND 500
      AND external_blocked_message !~ E'[\n\r]')
  );
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.companion_v3_public_turn(p_turn public.companion_v3_turns)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
  SELECT jsonb_build_object(
    'id',p_turn.id,'companion_id',p_turn.companion_id,
    'client_message_id',p_turn.client_message_id,'status',p_turn.state,
    'queue_sequence',p_turn.queue_sequence,'latest_attempt',NULL,
    'admission_state',p_turn.admission_state,'admitted_at',p_turn.admitted_at,
    'replying',p_turn.admission_state='accepted' AND p_turn.state IN ('admitted','running'),
    'error',CASE WHEN p_turn.outcome IN ('failed','interrupted') THEN jsonb_build_object(
      'code',p_turn.outcome_code,'message',p_turn.outcome_message,'action',p_turn.outcome_action
    ) ELSE NULL END,
    'state_changed_at',p_turn.updated_at,'settled_at',p_turn.settled_at,
    'created_at',p_turn.created_at,'updated_at',p_turn.updated_at)
    || CASE WHEN p_turn.external_incident_id IS NULL THEN '{}'::jsonb
      ELSE jsonb_build_object('external_block',jsonb_build_object(
        'classification',p_turn.external_failure_class,'source',p_turn.external_failure_source,
        'message',p_turn.external_blocked_message)) END
$$;
--> statement-breakpoint

-- A retry deadline belongs to the FIFO head. Protocol 3's selector predates retry
-- availability and would otherwise reclaim that same row immediately. Keep its established
-- recovery/ACK ordering, but require queued work to be due before it is leaseable; the existing
-- earlier-row predicate then prevents a later message from overtaking the deferred head.
CREATE OR REPLACE FUNCTION public.companion_v3_runtime_claim_warm(
  p_executor_id text,p_lane public.companion_v3_lane,p_lease_seconds integer,p_protocol integer
) RETURNS TABLE(org_id uuid,companion_id uuid,turn_id uuid,command_id uuid,
  lane public.companion_v3_lane,state public.companion_v3_turn_state,claim_token uuid,
  claim_epoch bigint,gate_epoch bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_now timestamptz:=clock_timestamp();v_lease public.companion_v3_lane_leases%ROWTYPE;
  v_turn public.companion_v3_turns%ROWTYPE;v_gate_epoch bigint;v_expired_org uuid;
  v_expired_companion uuid;v_material_margin interval:=interval '2 hours 5 minutes';
BEGIN
  IF p_protocol IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'Runtime v3 protocol is required' USING ERRCODE='42501';END IF;
  IF p_executor_id IS NULL OR char_length(p_executor_id) NOT BETWEEN 1 AND 200
    OR p_executor_id~E'[\n\r]' OR p_lease_seconds IS NULL
    OR p_lease_seconds NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION 'invalid Runtime v3 warm claim' USING ERRCODE='22023';END IF;
  SELECT control.gate_epoch INTO v_gate_epoch FROM public.companion_runtime_control control
  WHERE control.id='runtime-v2' AND control.enabled FOR SHARE;
  IF NOT FOUND THEN RETURN;END IF;

  SELECT instance.org_id,instance.companion_id INTO v_expired_org,v_expired_companion
  FROM public.companion_v3_instances instance
  JOIN public.companion_v3_turns eligible ON eligible.org_id=instance.org_id
    AND eligible.companion_id=instance.companion_id AND eligible.lane=p_lane
    AND ((eligible.state='queued' AND eligible.available_at<=v_now AND NOT EXISTS(
      SELECT 1 FROM public.companion_v3_turns earlier WHERE earlier.org_id=eligible.org_id
        AND earlier.companion_id=eligible.companion_id AND earlier.lane=eligible.lane
        AND earlier.state='queued' AND earlier.queue_sequence<eligible.queue_sequence))
      OR (eligible.state IN ('admitted','running','needs_input')
        AND eligible.admission_state='accepted' AND eligible.response_turn_id=eligible.id)
      OR (eligible.state IN ('succeeded','failed') AND eligible.journal_ack_pending
        AND eligible.response_turn_id=eligible.id))
  WHERE instance.prepared_at IS NOT NULL AND (instance.prepared_material_expires_at IS NULL
    OR instance.prepared_material_expires_at<=v_now+v_material_margin)
  ORDER BY eligible.claim_count,eligible.queue_sequence,eligible.id
  LIMIT 1 FOR UPDATE OF instance SKIP LOCKED;
  IF FOUND THEN
    PERFORM public.companion_v3_invalidate_preparation(v_expired_org,v_expired_companion);RETURN;
  END IF;

  SELECT lease.* INTO v_lease FROM public.companion_v3_lane_leases lease
  JOIN public.companion_v3_instances instance ON instance.org_id=lease.org_id
    AND instance.companion_id=lease.companion_id AND instance.box_id IS NOT NULL
    AND instance.pi_invocation_id IS NOT NULL AND instance.prepared_at IS NOT NULL
    AND (instance.prepared_material_expires_at IS NULL
      OR instance.prepared_material_expires_at>v_now+v_material_margin)
  JOIN public.companion_v3_turns eligible ON eligible.org_id=lease.org_id
    AND eligible.companion_id=lease.companion_id AND eligible.lane=lease.lane
    AND ((eligible.state='queued' AND eligible.available_at<=v_now AND NOT EXISTS(
      SELECT 1 FROM public.companion_v3_turns earlier WHERE earlier.org_id=eligible.org_id
        AND earlier.companion_id=eligible.companion_id AND earlier.lane=eligible.lane
        AND earlier.state='queued' AND earlier.queue_sequence<eligible.queue_sequence))
      OR (eligible.state IN ('admitted','running','needs_input')
        AND eligible.admission_state='accepted' AND eligible.response_turn_id=eligible.id)
      OR (eligible.state IN ('succeeded','failed') AND eligible.journal_ack_pending
        AND eligible.response_turn_id=eligible.id))
  WHERE lease.lane=p_lane AND (lease.claim_token IS NULL OR lease.expires_at<=v_now)
  ORDER BY eligible.claim_count,eligible.queue_sequence,eligible.id
  LIMIT 1 FOR UPDATE OF lease SKIP LOCKED;
  IF NOT FOUND THEN RETURN;END IF;

  SELECT eligible.* INTO v_turn FROM public.companion_v3_turns eligible
  WHERE eligible.org_id=v_lease.org_id AND eligible.companion_id=v_lease.companion_id
    AND eligible.lane=p_lane
    AND ((eligible.state='queued' AND eligible.available_at<=v_now AND NOT EXISTS(
      SELECT 1 FROM public.companion_v3_turns earlier WHERE earlier.org_id=eligible.org_id
        AND earlier.companion_id=eligible.companion_id AND earlier.lane=eligible.lane
        AND earlier.state='queued' AND earlier.queue_sequence<eligible.queue_sequence))
      OR (eligible.state IN ('admitted','running','needs_input')
        AND eligible.admission_state='accepted' AND eligible.response_turn_id=eligible.id)
      OR (eligible.state IN ('succeeded','failed') AND eligible.journal_ack_pending
        AND eligible.response_turn_id=eligible.id))
  ORDER BY eligible.claim_count,eligible.queue_sequence,eligible.id
  LIMIT 1 FOR UPDATE OF eligible;
  IF NOT FOUND THEN RETURN;END IF;
  UPDATE public.companion_v3_lane_leases lease SET claim_token=gen_random_uuid(),
    claim_epoch=lease.claim_epoch+1,gate_epoch=v_gate_epoch,executor_id=p_executor_id,
    turn_id=v_turn.id,claimed_at=v_now,renewed_at=v_now,
    expires_at=v_now+make_interval(secs=>p_lease_seconds),updated_at=v_now
  WHERE lease.org_id=v_lease.org_id AND lease.companion_id=v_lease.companion_id
    AND lease.lane=p_lane
  RETURNING lease.claim_token,lease.claim_epoch,lease.gate_epoch
    INTO claim_token,claim_epoch,gate_epoch;
  org_id:=v_turn.org_id;companion_id:=v_turn.companion_id;turn_id:=v_turn.id;
  command_id:=v_turn.command_id;lane:=v_turn.lane;state:=v_turn.state;RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_runtime_claim_warm(
  text,public.companion_v3_lane,integer,integer) FROM PUBLIC;
--> statement-breakpoint

-- The background selector already honors available_at; add the matching FIFO-head predicate so
-- routine and trigger occurrences cannot overtake a deferred occurrence in their shared lane.
CREATE OR REPLACE FUNCTION public.companion_v3_runtime_claim_background_internal_v7(
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
  IF p_protocol<>7 THEN RAISE EXCEPTION 'Runtime v3 protocol 7 is required' USING ERRCODE='42501';END IF;
  IF p_lane<>'background' THEN RETURN;END IF;
  IF p_executor_id IS NULL OR char_length(p_executor_id) NOT BETWEEN 1 AND 200
    OR p_executor_id~E'[\n\r]' OR p_lease_seconds NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION 'invalid Runtime v3 background claim' USING ERRCODE='22023';END IF;
  SELECT control.gate_epoch INTO v_gate FROM public.companion_runtime_control control
    WHERE control.id='runtime-v2' AND control.enabled FOR SHARE;
  IF NOT FOUND THEN RETURN;END IF;

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
    IF FOUND THEN PERFORM public.companion_v3_invalidate_preparation(v_invalid_org,v_invalid_companion);END IF;

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
      OR (run.outcome IN ('pending','running') AND ((turn_row.state='queued'
        AND turn_row.available_at<=v_now AND NOT EXISTS(
          SELECT 1 FROM public.companion_v3_turns earlier
          WHERE earlier.org_id=turn_row.org_id AND earlier.companion_id=turn_row.companion_id
            AND earlier.lane='background' AND earlier.state='queued'
            AND earlier.queue_sequence<turn_row.queue_sequence)
        AND NOT EXISTS(SELECT 1 FROM public.companion_v3_turns active
          WHERE active.org_id=turn_row.org_id AND active.companion_id=turn_row.companion_id
            AND active.lane='background' AND active.state IN ('admitted','running','needs_input')))
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
REVOKE ALL ON FUNCTION public.companion_v3_runtime_claim_background_internal_v7(
  text,public.companion_v3_lane,integer,integer) FROM PUBLIC;
--> statement-breakpoint

-- Protocol 9 adds source identity to a claim without changing either lane's durable selector.
CREATE FUNCTION public.companion_v3_runtime_claim_warm_v9(
  p_executor_id text,p_lane public.companion_v3_lane,p_lease_seconds integer,p_protocol integer
) RETURNS TABLE(org_id uuid,companion_id uuid,turn_id uuid,command_id uuid,
  lane public.companion_v3_lane,state public.companion_v3_turn_state,claim_token uuid,
  claim_epoch bigint,gate_epoch bigint,admission_started_at timestamptz,
  inactivity_deadline_at timestamptz,absolute_deadline_at timestamptz,
  work_source public.companion_v3_work_source,box_dependency text,model_dependency text,
  plugin_provider_dependency text,authority_dependency text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=on AS $$
BEGIN
  IF p_protocol<>9 THEN RAISE EXCEPTION 'Runtime v3 protocol 9 is required' USING ERRCODE='42501';END IF;
  RETURN QUERY SELECT claimed.*,CASE WHEN turn_row.delegation_id IS NOT NULL
      OR turn_row.delegation_return_id IS NOT NULL THEN 'delegation'::public.companion_v3_work_source
      ELSE 'main'::public.companion_v3_work_source END,
    'box:companion'::text,'model:'||COALESCE(companion.model_id,'unselected'),
    CASE WHEN jsonb_array_length(companion.provider_ids)=1
      THEN 'provider:'||(companion.provider_ids->>0) ELSE NULL END,
    NULL::text
    FROM public.companion_v3_runtime_claim_warm_v8(
      p_executor_id,p_lane,p_lease_seconds,8) claimed
    JOIN public.companion_v3_turns turn_row ON turn_row.org_id=claimed.org_id
      AND turn_row.companion_id=claimed.companion_id AND turn_row.id=claimed.turn_id
    JOIN public.companions companion ON companion.org_id=turn_row.org_id
      AND companion.id=turn_row.companion_id;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_runtime_claim_warm_v9(
  text,public.companion_v3_lane,integer,integer) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_runtime_claim_background_v9(
  p_executor_id text,p_lane public.companion_v3_lane,p_lease_seconds integer,p_protocol integer
) RETURNS TABLE(org_id uuid,companion_id uuid,turn_id uuid,command_id uuid,
  lane public.companion_v3_lane,state public.companion_v3_turn_state,claim_token uuid,
  claim_epoch bigint,gate_epoch bigint,admission_started_at timestamptz,
  inactivity_deadline_at timestamptz,absolute_deadline_at timestamptz,
  cleanup_box_id text,cleanup_invocation_id text,
  work_source public.companion_v3_work_source,box_dependency text,model_dependency text,
  plugin_provider_dependency text,authority_dependency text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=on AS $$
BEGIN
  IF p_protocol<>9 THEN RAISE EXCEPTION 'Runtime v3 protocol 9 is required' USING ERRCODE='42501';END IF;
  RETURN QUERY SELECT claimed.*,CASE WHEN run.trigger_snapshot_id IS NULL
      THEN 'routine'::public.companion_v3_work_source
      ELSE 'trigger'::public.companion_v3_work_source END,
    'box:companion'::text,'model:'||COALESCE(companion.model_id,'unselected'),
    CASE WHEN jsonb_array_length(companion.provider_ids)=1
      THEN 'provider:'||(companion.provider_ids->>0) ELSE NULL END,
    NULL::text
    FROM public.companion_v3_runtime_claim_background_v8(
      p_executor_id,p_lane,p_lease_seconds,8) claimed
    JOIN public.companion_v3_routine_runs run ON run.org_id=claimed.org_id
      AND run.companion_id=claimed.companion_id AND run.turn_id=claimed.turn_id
    JOIN public.companion_v3_turns turn_row ON turn_row.org_id=claimed.org_id
      AND turn_row.companion_id=claimed.companion_id AND turn_row.id=claimed.turn_id
    JOIN public.companions companion ON companion.org_id=turn_row.org_id
      AND companion.id=turn_row.companion_id;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_runtime_claim_background_v9(
  text,public.companion_v3_lane,integer,integer) FROM PUBLIC;
--> statement-breakpoint

-- Opens or joins one continuous incident and atomically releases the lane. This function is valid
-- only before Pi admission, so requeue cannot replay an ambiguous prompt. The caller supplies a
-- privacy-safe SHA-256 dependency fingerprint, never the dependency identifier itself.
CREATE FUNCTION public.companion_v3_runtime_defer_external_v9(
  p_org_id uuid,p_companion_id uuid,p_lane public.companion_v3_lane,p_turn_id uuid,
  p_claim_token uuid,p_claim_epoch bigint,p_gate_epoch bigint,
  p_failure_class public.companion_v3_external_failure_class,
  p_source public.companion_v3_work_source,p_dependency_fingerprint text,
  p_code text,p_message text,p_jitter double precision,p_protocol integer
) RETURNS TABLE(incident_id uuid,incident_opened boolean,delay_seconds integer)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_now timestamptz:=clock_timestamp();v_turn public.companion_v3_turns%ROWTYPE;
  v_incident public.companion_v3_external_incidents%ROWTYPE;v_retry integer;v_base integer;
  v_delay integer;v_deadline timestamptz;v_previous record;
BEGIN
  IF p_protocol<>9 THEN RAISE EXCEPTION 'Runtime v3 protocol 9 is required' USING ERRCODE='42501';END IF;
  IF (p_dependency_fingerprint IS NOT NULL AND p_dependency_fingerprint!~'^[0-9a-f]{64}$')
    OR p_code IS NULL OR p_code!~'^[a-z][a-z0-9_]{0,63}$'
    OR p_message IS NULL OR char_length(p_message) NOT BETWEEN 1 AND 500
    OR p_message~E'[\n\r]' OR p_jitter<0 OR p_jitter>1 THEN
    RAISE EXCEPTION 'invalid Runtime v3 external failure' USING ERRCODE='22023';END IF;
  SELECT turn_row.* INTO v_turn FROM public.companion_v3_lane_leases lease
  JOIN public.companion_runtime_control control ON control.id='runtime-v2' AND control.enabled
    AND control.gate_epoch=p_gate_epoch
  JOIN public.companion_v3_turns turn_row ON turn_row.org_id=lease.org_id
    AND turn_row.companion_id=lease.companion_id AND turn_row.id=lease.turn_id
  WHERE lease.org_id=p_org_id AND lease.companion_id=p_companion_id AND lease.lane=p_lane
    AND lease.turn_id=p_turn_id AND lease.claim_token=p_claim_token
    AND lease.claim_epoch=p_claim_epoch AND lease.gate_epoch=p_gate_epoch
    AND lease.expires_at>v_now AND turn_row.state='queued'
    AND turn_row.admission_state='pending'
  FOR UPDATE OF lease,turn_row;
  IF NOT FOUND THEN RETURN;END IF;
  v_retry:=v_turn.retry_count+1;
  v_base:=CASE v_retry WHEN 1 THEN 5 WHEN 2 THEN 15 WHEN 3 THEN 30 WHEN 4 THEN 60 ELSE 300 END;
  v_delay:=least(300,greatest(1,round(v_base*(0.8+p_jitter*0.4))::integer));
  IF (p_lane='main' AND p_source NOT IN ('main','delegation'))
    OR (p_lane='background' AND p_source NOT IN ('routine','trigger')) THEN
    RAISE EXCEPTION 'Runtime v3 source does not match its lane' USING ERRCODE='22023';END IF;
  v_deadline:=v_turn.accepted_at+interval '2 hours';
  IF p_lane='background' THEN
    v_deadline:=COALESCE(
      (SELECT run.trigger_retry_deadline_at FROM public.companion_v3_routine_runs run
        WHERE run.org_id=p_org_id AND run.companion_id=p_companion_id AND run.turn_id=p_turn_id),
      v_deadline);
  END IF;
  v_delay:=greatest(0,least(v_delay,floor(extract(epoch FROM (v_deadline-v_now)))::integer));

  IF p_dependency_fingerprint IS NULL THEN
    incident_opened:=false;
    INSERT INTO public.companion_v3_external_unattributed_occurrences(
      org_id,companion_id,failure_class,source,occurred_at
    ) VALUES(p_org_id,p_companion_id,p_failure_class,p_source,v_now);
  ELSE
    PERFORM pg_advisory_xact_lock(hashtextextended(
      p_companion_id::text||':'||p_failure_class::text||':'||p_dependency_fingerprint,0));
    SELECT incident.* INTO v_incident FROM public.companion_v3_external_incidents incident
    WHERE incident.org_id=p_org_id AND incident.companion_id=p_companion_id
      AND incident.failure_class=p_failure_class
      AND incident.dependency_fingerprint=p_dependency_fingerprint
      AND incident.recovered_at IS NULL FOR UPDATE;
    incident_opened:=NOT FOUND;
    IF incident_opened THEN
      INSERT INTO public.companion_v3_external_incidents(
        org_id,companion_id,failure_class,dependency_fingerprint,stable_code,
        first_source,last_source,member_signal_at
      ) VALUES(p_org_id,p_companion_id,p_failure_class,p_dependency_fingerprint,p_code,
        p_source,p_source,v_now) RETURNING * INTO v_incident;
    ELSE
      UPDATE public.companion_v3_external_incidents SET occurrence_count=occurrence_count+1,
        last_source=p_source,last_seen_at=v_now,updated_at=v_now
      WHERE id=v_incident.id RETURNING * INTO v_incident;
    END IF;
    INSERT INTO public.companion_v3_external_incident_occurrences(
      org_id,companion_id,incident_id,source,occurred_at
    ) VALUES(p_org_id,p_companion_id,v_incident.id,p_source,v_now);
    IF incident_opened THEN
      INSERT INTO public.companion_v3_external_incident_signals(
        org_id,companion_id,incident_id,kind,failure_class,source,stable_code,created_at
      ) VALUES(p_org_id,p_companion_id,v_incident.id,'opened',p_failure_class,p_source,p_code,v_now);
    END IF;
  END IF;
  IF v_turn.external_incident_id IS NOT NULL
    AND p_dependency_fingerprint IS NOT NULL
    AND v_turn.external_incident_id<>v_incident.id THEN
    UPDATE public.companion_v3_external_incidents previous SET recovered_at=v_now,updated_at=v_now
    WHERE previous.id=v_turn.external_incident_id AND previous.org_id=p_org_id
      AND previous.companion_id=p_companion_id AND previous.recovered_at IS NULL
    RETURNING previous.* INTO v_previous;
    IF FOUND THEN
      INSERT INTO public.companion_v3_external_incident_signals(
        org_id,companion_id,incident_id,kind,failure_class,source,stable_code,created_at
      ) VALUES(p_org_id,p_companion_id,v_previous.id,'recovered',v_previous.failure_class,
        v_previous.last_source,v_previous.stable_code,v_now) ON CONFLICT DO NOTHING;
      UPDATE public.companion_v3_turns SET external_incident_id=NULL,
        external_failure_class=NULL,external_failure_source=NULL,external_blocked_message=NULL,
        available_at=LEAST(available_at,v_now),updated_at=v_now
      WHERE org_id=p_org_id AND companion_id=p_companion_id
        AND external_incident_id=v_previous.id AND state='queued';
    END IF;
  END IF;
  UPDATE public.companion_v3_turns SET retry_count=v_retry,
    state=CASE WHEN v_delay=0 THEN 'failed'::public.companion_v3_turn_state ELSE state END,
    outcome=CASE WHEN v_delay=0 THEN 'failed'::public.companion_v3_turn_outcome ELSE outcome END,
    outcome_code=CASE WHEN v_delay=0 THEN p_code ELSE NULL END,
    outcome_message=CASE WHEN v_delay=0 THEN p_message ELSE NULL END,
    outcome_action=CASE WHEN v_delay=0 THEN 'retry'::public.companion_runtime_error_action ELSE NULL END,
    settled_at=CASE WHEN v_delay=0 THEN v_now ELSE NULL END,
    admission_started_at=NULL,pi_invocation_id=NULL,admission_cursor=NULL,
    available_at=least(v_deadline,v_now+make_interval(secs=>v_delay)),
    external_incident_id=CASE WHEN p_dependency_fingerprint IS NULL
      THEN external_incident_id ELSE v_incident.id END,
    external_failure_class=CASE WHEN p_dependency_fingerprint IS NULL
      THEN external_failure_class ELSE p_failure_class END,
    external_failure_source=CASE WHEN p_dependency_fingerprint IS NULL
      THEN external_failure_source ELSE p_source END,
    external_blocked_message=CASE WHEN p_dependency_fingerprint IS NULL
      THEN external_blocked_message ELSE p_message END,
    updated_at=v_now
  WHERE org_id=p_org_id AND companion_id=p_companion_id AND id=p_turn_id;
  IF v_delay=0 AND p_lane='background' THEN
    UPDATE public.companion_v3_routine_runs SET outcome='failed',settled_at=v_now
    WHERE org_id=p_org_id AND companion_id=p_companion_id AND turn_id=p_turn_id
      AND outcome IN ('pending','running');
  END IF;
  UPDATE public.companion_v3_lane_leases SET claim_token=NULL,gate_epoch=NULL,executor_id=NULL,
    turn_id=NULL,claimed_at=NULL,renewed_at=NULL,expires_at=NULL,updated_at=v_now
  WHERE org_id=p_org_id AND companion_id=p_companion_id AND lane=p_lane
    AND claim_token=p_claim_token AND claim_epoch=p_claim_epoch;
  incident_id:=CASE WHEN p_dependency_fingerprint IS NULL THEN NULL ELSE v_incident.id END;
  delay_seconds:=v_delay;RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_runtime_defer_external_v9(
  uuid,uuid,public.companion_v3_lane,uuid,uuid,bigint,bigint,
  public.companion_v3_external_failure_class,public.companion_v3_work_source,
  text,text,text,double precision,integer) FROM PUBLIC;
--> statement-breakpoint

-- Preparation owns a separate fenced lease. Failures before a queued source can reach a warm
-- lane join the same incident key, project the same honest block, and release that preparation
-- claim through the existing bounded retry primitive.
CREATE FUNCTION public.companion_v3_runtime_defer_preparation_external_v9(
  p_org_id uuid,p_companion_id uuid,p_turn_id uuid,p_claim_token uuid,p_claim_epoch bigint,p_gate_epoch bigint,
  p_failure_class public.companion_v3_external_failure_class,p_dependency_fingerprint text,
  p_code text,p_message text,p_delay_seconds integer,p_protocol integer
) RETURNS TABLE(incident_id uuid,incident_opened boolean,source public.companion_v3_work_source)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_now timestamptz:=clock_timestamp();v_turn public.companion_v3_turns%ROWTYPE;
  v_incident public.companion_v3_external_incidents%ROWTYPE;v_deferred boolean;
  v_source public.companion_v3_work_source;v_previous record;
BEGIN
  IF p_protocol<>9 THEN RAISE EXCEPTION 'Runtime v3 protocol 9 is required' USING ERRCODE='42501';END IF;
  IF p_dependency_fingerprint IS NULL OR p_dependency_fingerprint!~'^[0-9a-f]{64}$'
    OR p_code IS NULL OR p_code!~'^[a-z][a-z0-9_]{0,63}$'
    OR p_message IS NULL OR char_length(p_message) NOT BETWEEN 1 AND 500
    OR p_message~E'[\n\r]' OR p_delay_seconds NOT BETWEEN 0 AND 300 THEN
    RAISE EXCEPTION 'invalid Runtime v3 external preparation failure' USING ERRCODE='22023';END IF;
  SELECT turn_row.* INTO v_turn FROM public.companion_v3_instances instance
  JOIN public.companion_runtime_control control ON control.id='runtime-v2' AND control.enabled
    AND control.gate_epoch=p_gate_epoch
  JOIN public.companion_v3_turns turn_row ON turn_row.org_id=instance.org_id
    AND turn_row.companion_id=instance.companion_id AND turn_row.id=p_turn_id
    AND turn_row.state='queued' AND NOT EXISTS(
      SELECT 1 FROM public.companion_v3_turns earlier
      WHERE earlier.org_id=turn_row.org_id AND earlier.companion_id=turn_row.companion_id
        AND earlier.lane=turn_row.lane AND earlier.state='queued'
        AND earlier.queue_sequence<turn_row.queue_sequence)
  WHERE instance.org_id=p_org_id AND instance.companion_id=p_companion_id
    AND instance.preparation_claim_token=p_claim_token
    AND instance.preparation_claim_epoch=p_claim_epoch
    AND instance.preparation_gate_epoch=p_gate_epoch AND instance.preparation_expires_at>v_now
  FOR UPDATE OF instance,turn_row;
  IF NOT FOUND THEN RETURN;END IF;
  v_source:=CASE WHEN v_turn.lane='background' THEN COALESCE(
      (SELECT CASE WHEN run.trigger_snapshot_id IS NULL THEN 'routine' ELSE 'trigger' END
        FROM public.companion_v3_routine_runs run WHERE run.turn_id=v_turn.id),'routine')
    WHEN v_turn.delegation_id IS NOT NULL OR v_turn.delegation_return_id IS NOT NULL
      THEN 'delegation' ELSE 'main' END::public.companion_v3_work_source;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_companion_id::text||':'||p_failure_class::text||':'||p_dependency_fingerprint,0));
  SELECT incident.* INTO v_incident FROM public.companion_v3_external_incidents incident
  WHERE incident.org_id=p_org_id AND incident.companion_id=p_companion_id
    AND incident.failure_class=p_failure_class
    AND incident.dependency_fingerprint=p_dependency_fingerprint
    AND incident.recovered_at IS NULL FOR UPDATE;
  incident_opened:=NOT FOUND;
  IF incident_opened THEN
    INSERT INTO public.companion_v3_external_incidents(
      org_id,companion_id,failure_class,dependency_fingerprint,stable_code,
      first_source,last_source,member_signal_at
    ) VALUES(p_org_id,p_companion_id,p_failure_class,p_dependency_fingerprint,p_code,
      v_source,v_source,v_now) RETURNING * INTO v_incident;
  ELSE
    UPDATE public.companion_v3_external_incidents SET occurrence_count=occurrence_count+1,
      last_source=v_source,last_seen_at=v_now,updated_at=v_now
    WHERE id=v_incident.id RETURNING * INTO v_incident;
  END IF;
  INSERT INTO public.companion_v3_external_incident_occurrences(
    org_id,companion_id,incident_id,source,occurred_at
  ) VALUES(p_org_id,p_companion_id,v_incident.id,v_source,v_now);
  IF incident_opened THEN
    INSERT INTO public.companion_v3_external_incident_signals(
      org_id,companion_id,incident_id,kind,failure_class,source,stable_code,created_at
    ) VALUES(p_org_id,p_companion_id,v_incident.id,'opened',p_failure_class,v_source,p_code,v_now);
  END IF;
  IF v_turn.external_incident_id IS NOT NULL
    AND v_turn.external_incident_id<>v_incident.id THEN
    UPDATE public.companion_v3_external_incidents previous SET recovered_at=v_now,updated_at=v_now
    WHERE previous.id=v_turn.external_incident_id AND previous.org_id=p_org_id
      AND previous.companion_id=p_companion_id AND previous.recovered_at IS NULL
    RETURNING previous.* INTO v_previous;
    IF FOUND THEN
      INSERT INTO public.companion_v3_external_incident_signals(
        org_id,companion_id,incident_id,kind,failure_class,source,stable_code,created_at
      ) VALUES(p_org_id,p_companion_id,v_previous.id,'recovered',v_previous.failure_class,
        v_previous.last_source,v_previous.stable_code,v_now) ON CONFLICT DO NOTHING;
      UPDATE public.companion_v3_turns SET external_incident_id=NULL,
        external_failure_class=NULL,external_failure_source=NULL,external_blocked_message=NULL,
        available_at=LEAST(available_at,v_now),updated_at=v_now
      WHERE org_id=p_org_id AND companion_id=p_companion_id
        AND external_incident_id=v_previous.id AND state='queued';
    END IF;
  END IF;
  UPDATE public.companion_v3_turns SET external_incident_id=v_incident.id,
    external_failure_class=p_failure_class,external_failure_source=v_source,
    external_blocked_message=p_message,updated_at=v_now
  WHERE org_id=p_org_id AND companion_id=p_companion_id AND id=v_turn.id;
  IF p_delay_seconds=0 THEN
    UPDATE public.companion_v3_instances instance SET preparation_available_at=v_now,
      preparation_attempt_count=instance.preparation_attempt_count+1,
      preparation_error_code=p_code,preparation_error_message=p_message,
      preparation_claim_token=NULL,preparation_gate_epoch=NULL,
      preparation_executor_id=NULL,preparation_claimed_at=NULL,
      preparation_expires_at=NULL,updated_at=v_now
    WHERE instance.org_id=p_org_id AND instance.companion_id=p_companion_id
      AND instance.preparation_claim_token=p_claim_token
      AND instance.preparation_claim_epoch=p_claim_epoch
      AND instance.preparation_gate_epoch=p_gate_epoch;
    v_deferred:=FOUND;
    UPDATE public.companion_v3_turns SET state='failed',outcome='failed',
      outcome_code=p_code,outcome_message=p_message,outcome_action='retry',settled_at=v_now,
      available_at=v_now,updated_at=v_now
    WHERE org_id=p_org_id AND companion_id=p_companion_id AND id=v_turn.id;
    IF v_turn.lane='background' THEN
      UPDATE public.companion_v3_routine_runs SET outcome='failed',settled_at=v_now
      WHERE org_id=p_org_id AND companion_id=p_companion_id AND turn_id=v_turn.id
        AND outcome IN ('pending','running');
    END IF;
  ELSE
    SELECT public.companion_v3_runtime_defer_preparation(
      p_org_id,p_companion_id,p_claim_token,p_claim_epoch,p_gate_epoch,p_delay_seconds,
      p_code,p_message,4) INTO v_deferred;
  END IF;
  IF NOT v_deferred THEN RAISE EXCEPTION 'Runtime v3 preparation fence changed' USING ERRCODE='40001';END IF;
  incident_id:=v_incident.id;source:=v_source;RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_runtime_defer_preparation_external_v9(
  uuid,uuid,uuid,uuid,bigint,bigint,public.companion_v3_external_failure_class,
  text,text,text,integer,integer) FROM PUBLIC;
--> statement-breakpoint

-- Successful dependency contact closes the exact open incident once. Returning recovery_signal
-- only on the state transition gives the process one durable recovery notification checkpoint.
CREATE FUNCTION public.companion_v3_runtime_recover_external_v9(
  p_org_id uuid,p_companion_id uuid,
  p_failure_class public.companion_v3_external_failure_class,
  p_dependency_fingerprint text,p_protocol integer
) RETURNS TABLE(incident_id uuid,recovery_signal boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_now timestamptz:=clock_timestamp();v_id uuid;
BEGIN
  IF p_protocol<>9 THEN RAISE EXCEPTION 'Runtime v3 protocol 9 is required' USING ERRCODE='42501';END IF;
  IF p_dependency_fingerprint IS NULL OR p_dependency_fingerprint!~'^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid Runtime v3 dependency fingerprint' USING ERRCODE='22023';END IF;
  UPDATE public.companion_v3_external_incidents SET recovered_at=v_now,updated_at=v_now
  WHERE org_id=p_org_id AND companion_id=p_companion_id
    AND failure_class=p_failure_class AND dependency_fingerprint=p_dependency_fingerprint
    AND recovered_at IS NULL RETURNING id INTO v_id;
  IF v_id IS NULL THEN RETURN;END IF;
  INSERT INTO public.companion_v3_external_incident_signals(
    org_id,companion_id,incident_id,kind,failure_class,source,stable_code,created_at
  ) SELECT incident.org_id,incident.companion_id,incident.id,'recovered',
      incident.failure_class,incident.last_source,incident.stable_code,v_now
    FROM public.companion_v3_external_incidents incident WHERE incident.id=v_id
    ON CONFLICT DO NOTHING;
  UPDATE public.companion_v3_turns SET external_incident_id=NULL,
    external_failure_class=NULL,external_failure_source=NULL,external_blocked_message=NULL,
    available_at=LEAST(available_at,v_now),updated_at=v_now
  WHERE org_id=p_org_id AND companion_id=p_companion_id AND external_incident_id=v_id
    AND state='queued';
  incident_id:=v_id;recovery_signal:=true;RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_runtime_recover_external_v9(
  uuid,uuid,public.companion_v3_external_failure_class,text,integer) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_runtime_recover_external_turn_v9(
  p_org_id uuid,p_companion_id uuid,p_turn_id uuid,p_protocol integer
) RETURNS TABLE(incident_id uuid,failure_class public.companion_v3_external_failure_class,
  source public.companion_v3_work_source)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_now timestamptz:=clock_timestamp();v_incident record;
BEGIN
  IF p_protocol<>9 THEN RAISE EXCEPTION 'Runtime v3 protocol 9 is required' USING ERRCODE='42501';END IF;
  UPDATE public.companion_v3_external_incidents AS incident SET recovered_at=v_now,updated_at=v_now
  FROM public.companion_v3_turns turn_row
  WHERE turn_row.org_id=p_org_id AND turn_row.companion_id=p_companion_id
    AND turn_row.id=p_turn_id AND turn_row.external_incident_id=incident.id
    AND incident.org_id=turn_row.org_id AND incident.companion_id=turn_row.companion_id
    AND incident.recovered_at IS NULL
  RETURNING incident.id,incident.failure_class,incident.last_source,incident.stable_code
    INTO v_incident;
  IF NOT FOUND THEN RETURN;END IF;
  INSERT INTO public.companion_v3_external_incident_signals(
    org_id,companion_id,incident_id,kind,failure_class,source,stable_code,created_at
  ) VALUES(p_org_id,p_companion_id,v_incident.id,'recovered',v_incident.failure_class,
    v_incident.last_source,v_incident.stable_code,v_now) ON CONFLICT DO NOTHING;
  UPDATE public.companion_v3_turns SET external_incident_id=NULL,
    external_failure_class=NULL,external_failure_source=NULL,external_blocked_message=NULL,
    available_at=LEAST(available_at,v_now),updated_at=v_now
  WHERE org_id=p_org_id AND companion_id=p_companion_id
    AND external_incident_id=v_incident.id AND state='queued';
  incident_id:=v_incident.id;failure_class:=v_incident.failure_class;
  source:=v_incident.last_source;RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_runtime_recover_external_turn_v9(
  uuid,uuid,uuid,integer) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_runtime_claim_external_incident_signal_v9(
  p_executor_id text,p_lease_seconds integer,p_protocol integer
) RETURNS TABLE(signal_id uuid,incident_id uuid,kind text,
  failure_class public.companion_v3_external_failure_class,
  source public.companion_v3_work_source,stable_code text,claim_token uuid,claim_epoch bigint)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_now timestamptz:=clock_timestamp();v_signal record;
BEGIN
  IF p_protocol<>9 OR p_executor_id IS NULL OR char_length(p_executor_id) NOT BETWEEN 1 AND 200
    OR p_executor_id~E'[\n\r]' OR p_lease_seconds NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION 'invalid Runtime v3 incident signal claim' USING ERRCODE='22023';END IF;
  SELECT signal.* INTO v_signal FROM public.companion_v3_external_incident_signals signal
  WHERE signal.acknowledged_at IS NULL
    AND (signal.claim_token IS NULL OR signal.claim_expires_at<=v_now)
  ORDER BY signal.created_at,signal.id LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN;END IF;
  UPDATE public.companion_v3_external_incident_signals signal SET
    claim_token=gen_random_uuid(),claim_epoch=signal.claim_epoch+1,claimed_by=p_executor_id,
    claim_expires_at=v_now+make_interval(secs=>p_lease_seconds)
  WHERE signal.id=v_signal.id
  RETURNING signal.id,signal.incident_id,signal.kind,signal.failure_class,signal.source,
    signal.stable_code,signal.claim_token,signal.claim_epoch
  INTO signal_id,incident_id,kind,failure_class,source,stable_code,claim_token,claim_epoch;
  RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_runtime_claim_external_incident_signal_v9(
  text,integer,integer) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_runtime_ack_external_incident_signal_v9(
  p_signal_id uuid,p_claim_token uuid,p_claim_epoch bigint,p_protocol integer
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_now timestamptz:=clock_timestamp();v_signal record;
BEGIN
  IF p_protocol<>9 THEN RAISE EXCEPTION 'Runtime v3 protocol 9 is required' USING ERRCODE='42501';END IF;
  UPDATE public.companion_v3_external_incident_signals signal SET acknowledged_at=v_now,
    claim_token=NULL,claimed_by=NULL,claim_expires_at=NULL
  WHERE signal.id=p_signal_id AND signal.claim_token=p_claim_token
    AND signal.claim_epoch=p_claim_epoch AND signal.acknowledged_at IS NULL
  RETURNING signal.incident_id,signal.kind INTO v_signal;
  IF NOT FOUND THEN RETURN false;END IF;
  UPDATE public.companion_v3_external_incidents incident SET
    operator_signal_at=CASE WHEN v_signal.kind='opened' THEN v_now ELSE incident.operator_signal_at END,
    recovery_signal_at=CASE WHEN v_signal.kind='recovered' THEN v_now ELSE incident.recovery_signal_at END,
    updated_at=v_now WHERE incident.id=v_signal.incident_id;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_runtime_ack_external_incident_signal_v9(
  uuid,uuid,bigint,integer) FROM PUBLIC;
--> statement-breakpoint

-- Aggregate-only SLO facts. No identifier or provider-controlled value crosses this boundary.
CREATE FUNCTION public.companion_v3_runtime_external_incident_facts_v9(
  p_since timestamptz,p_until timestamptz,p_protocol integer
) RETURNS TABLE(failure_class public.companion_v3_external_failure_class,
  source public.companion_v3_work_source,
  occurrence_count integer,opened_at timestamptz,recovered_at timestamptz,
  aggregated_incident boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
BEGIN
  IF p_protocol<>9 OR p_since IS NULL OR p_until IS NULL OR p_since>p_until
    OR p_until-p_since>interval '31 days' THEN
    RAISE EXCEPTION 'invalid Runtime v3 incident measurement window' USING ERRCODE='22023';END IF;
  RETURN QUERY
  SELECT incident.failure_class,occurrence.source,count(*)::integer,
    incident.opened_at,incident.recovered_at,true
  FROM public.companion_v3_external_incident_occurrences occurrence
  JOIN public.companion_v3_external_incidents incident
    ON incident.id=occurrence.incident_id AND incident.org_id=occurrence.org_id
    AND incident.companion_id=occurrence.companion_id
  WHERE occurrence.occurred_at>=p_since AND occurrence.occurred_at<=p_until
  GROUP BY incident.id,incident.failure_class,occurrence.source,
    incident.opened_at,incident.recovered_at
  UNION ALL
  SELECT occurrence.failure_class,occurrence.source,count(*)::integer,
    min(occurrence.occurred_at),NULL::timestamptz,false
  FROM public.companion_v3_external_unattributed_occurrences occurrence
  WHERE occurrence.occurred_at>=p_since AND occurrence.occurred_at<=p_until
  GROUP BY occurrence.failure_class,occurrence.source;
END $$;
REVOKE ALL ON FUNCTION public.companion_v3_runtime_external_incident_facts_v9(
  timestamptz,timestamptz,integer) FROM PUBLIC;
