-- Runtime v3 acceptance measurement stays on the Turn: one durable chronology follows the user
-- occurrence from API acceptance through the current claim, prepared Box/Pi proof, admission,
-- first correlated activity, and settlement. The only read surface omits tenant/conversation ids.
CREATE TYPE public.companion_v3_wake_path AS ENUM ('warm', 'creation', 'archived_wake');
--> statement-breakpoint
CREATE TYPE public.companion_v3_admission_kind AS ENUM ('prompt', 'steer');
--> statement-breakpoint

ALTER TABLE public.companion_v3_turns
  ADD COLUMN accepted_at timestamp with time zone,
  ADD COLUMN first_claimed_at timestamp with time zone,
  ADD COLUMN last_claimed_at timestamp with time zone,
  ADD COLUMN claim_count integer NOT NULL DEFAULT 0,
  ADD COLUMN wake_path public.companion_v3_wake_path NOT NULL DEFAULT 'creation',
  ADD COLUMN box_provider text NOT NULL DEFAULT 'ascii',
  ADD COLUMN model_provider text NOT NULL DEFAULT 'unconfigured',
  ADD COLUMN model_id text NOT NULL DEFAULT 'unconfigured',
  ADD COLUMN box_ready_at timestamp with time zone,
  ADD COLUMN staging_completed_at timestamp with time zone,
  ADD COLUMN pi_ready_at timestamp with time zone,
  ADD COLUMN admission_kind public.companion_v3_admission_kind,
  ADD COLUMN first_activity_at timestamp with time zone,
  ADD CONSTRAINT companion_v3_turns_measurement_check CHECK (
    claim_count >= 0
    AND ((claim_count = 0 AND first_claimed_at IS NULL AND last_claimed_at IS NULL)
      OR (claim_count > 0 AND first_claimed_at IS NOT NULL AND last_claimed_at IS NOT NULL
        AND last_claimed_at >= first_claimed_at))
    AND char_length(box_provider) BETWEEN 1 AND 40 AND box_provider !~ E'[\n\r]'
    AND char_length(model_provider) BETWEEN 1 AND 80 AND model_provider !~ E'[\n\r]'
    AND char_length(model_id) BETWEEN 1 AND 200 AND model_id !~ E'[\n\r]'
    AND (admission_kind IS NULL OR admission_state = 'accepted')
    AND (box_ready_at IS NULL OR staging_completed_at IS NULL
      OR staging_completed_at >= box_ready_at)
    AND (staging_completed_at IS NULL OR pi_ready_at IS NULL
      OR pi_ready_at >= staging_completed_at)
    AND (first_activity_at IS NULL OR admitted_at IS NULL OR first_activity_at >= admitted_at)
  );
--> statement-breakpoint
UPDATE public.companion_v3_turns SET accepted_at = created_at WHERE accepted_at IS NULL;
--> statement-breakpoint
ALTER TABLE public.companion_v3_turns
  ALTER COLUMN accepted_at SET NOT NULL,
  ALTER COLUMN accepted_at SET DEFAULT clock_timestamp();
--> statement-breakpoint
CREATE INDEX companion_v3_turns_measurement_window_idx
  ON public.companion_v3_turns(accepted_at, lane, wake_path);
--> statement-breakpoint

-- Populate stable attribution before the row exists. Neither this trigger nor the report surface
-- copies organization, Companion, actor, transcript, URL, credential, or provider payload values.
CREATE FUNCTION public.companion_v3_measure_acceptance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_instance public.companion_v3_instances%ROWTYPE;
  v_model_id text;
  v_model_provider text;
BEGIN
  SELECT instance.* INTO v_instance
  FROM public.companion_v3_instances instance
  WHERE instance.org_id = NEW.org_id AND instance.companion_id = NEW.companion_id;
  SELECT companion.model_id, companion.provider_ids->>0
    INTO v_model_id, v_model_provider
  FROM public.companions companion
  WHERE companion.org_id = NEW.org_id AND companion.id = NEW.companion_id;
  NEW.accepted_at := coalesce(NEW.accepted_at, clock_timestamp());
  NEW.wake_path := CASE WHEN v_instance.prepared_at IS NOT NULL
    THEN 'warm'::public.companion_v3_wake_path
    ELSE 'creation'::public.companion_v3_wake_path END;
  NEW.box_provider := 'ascii';
  NEW.model_provider := coalesce(nullif(v_model_provider, ''), 'unconfigured');
  NEW.model_id := coalesce(nullif(v_model_id, ''), 'unconfigured');
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER companion_v3_measure_acceptance
BEFORE INSERT ON public.companion_v3_turns
FOR EACH ROW EXECUTE FUNCTION public.companion_v3_measure_acceptance();
--> statement-breakpoint

-- Every claim implementation crosses the retained lane row, so claim/takeover measurement is
-- centralized here instead of being copied into generic and warm claim functions.
CREATE FUNCTION public.companion_v3_measure_claim()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
BEGIN
  IF NEW.claim_token IS NOT NULL AND NEW.turn_id IS NOT NULL
    AND (OLD.claim_token IS DISTINCT FROM NEW.claim_token
      OR OLD.claim_epoch IS DISTINCT FROM NEW.claim_epoch) THEN
    UPDATE public.companion_v3_turns turn_row
    SET first_claimed_at = coalesce(turn_row.first_claimed_at, NEW.claimed_at),
        last_claimed_at = NEW.claimed_at,
        claim_count = turn_row.claim_count + 1
    WHERE turn_row.org_id = NEW.org_id AND turn_row.companion_id = NEW.companion_id
      AND turn_row.id = NEW.turn_id;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER companion_v3_measure_claim
AFTER UPDATE OF claim_token, claim_epoch ON public.companion_v3_lane_leases
FOR EACH ROW EXECUTE FUNCTION public.companion_v3_measure_claim();
--> statement-breakpoint

-- Admission snapshots the runtime-owned warm preparation proof. Activity stays distinct from ACK:
-- only a later correlated cursor advances first_activity_at.
CREATE FUNCTION public.companion_v3_measure_progress()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE v_prepared_at timestamp with time zone;
BEGIN
  IF OLD.admission_state <> 'accepted' AND NEW.admission_state = 'accepted' THEN
    SELECT instance.prepared_at INTO v_prepared_at
    FROM public.companion_v3_instances instance
    WHERE instance.org_id = NEW.org_id AND instance.companion_id = NEW.companion_id;
    NEW.wake_path := 'warm';
    NEW.box_ready_at := coalesce(NEW.box_ready_at, v_prepared_at);
    NEW.staging_completed_at := coalesce(NEW.staging_completed_at, v_prepared_at);
    NEW.pi_ready_at := coalesce(NEW.pi_ready_at, v_prepared_at);
    NEW.admission_kind := coalesce(NEW.admission_kind, 'prompt');
  END IF;
  IF NEW.admission_state = 'accepted'
    AND NEW.activity_cursor > coalesce(NEW.admission_cursor, NEW.activity_cursor)
    AND NEW.activity_cursor > OLD.activity_cursor THEN
    NEW.first_activity_at := coalesce(OLD.first_activity_at, clock_timestamp());
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER companion_v3_measure_progress
BEFORE UPDATE OF admission_state, activity_cursor ON public.companion_v3_turns
FOR EACH ROW EXECUTE FUNCTION public.companion_v3_measure_progress();
--> statement-breakpoint

-- This is the sole telemetry adapter. It returns stable dimensions and clocks only; aggregation
-- happens in the shared measurement module, and direct runtime tables remain inaccessible.
CREATE FUNCTION public.companion_v3_runtime_measurement_facts(
  p_since timestamp with time zone,
  p_until timestamp with time zone,
  p_protocol integer
)
RETURNS TABLE (
  lane public.companion_v3_lane,
  wake_path public.companion_v3_wake_path,
  box_provider text,
  model_provider text,
  model_id text,
  state public.companion_v3_turn_state,
  accepted_at timestamp with time zone,
  first_claimed_at timestamp with time zone,
  box_ready_at timestamp with time zone,
  staging_completed_at timestamp with time zone,
  pi_ready_at timestamp with time zone,
  admission_kind public.companion_v3_admission_kind,
  admitted_at timestamp with time zone,
  first_activity_at timestamp with time zone,
  last_activity_at timestamp with time zone,
  settled_at timestamp with time zone,
  claim_count integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
BEGIN
  IF p_protocol IS DISTINCT FROM 3 OR p_since IS NULL OR p_until IS NULL
    OR p_since > p_until OR p_until - p_since > interval '31 days' THEN
    RAISE EXCEPTION 'invalid Runtime v3 measurement window' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY SELECT
    turn_row.lane, turn_row.wake_path, turn_row.box_provider,
    turn_row.model_provider, turn_row.model_id, turn_row.state,
    turn_row.accepted_at, turn_row.first_claimed_at, turn_row.box_ready_at,
    turn_row.staging_completed_at, turn_row.pi_ready_at, turn_row.admission_kind,
    turn_row.admitted_at, turn_row.first_activity_at, turn_row.last_activity_at,
    turn_row.settled_at, turn_row.claim_count
  FROM public.companion_v3_turns turn_row
  WHERE turn_row.accepted_at >= p_since AND turn_row.accepted_at <= p_until;
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_v3_measure_acceptance() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_v3_measure_claim() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_v3_measure_progress() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_v3_runtime_measurement_facts(
  timestamp with time zone,timestamp with time zone,integer
) FROM PUBLIC;
