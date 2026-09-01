-- An interrupted turn is terminal evidence, never durable lane ownership. Runtime protocol 6
-- attempts exact Pi cleanup before settlement, but PostgreSQL releases the lane regardless of
-- cleanup outcome and never creates a recovery operation or replacement attempt.

-- Disable protocol-5 recovery automation before touching existing rows. In-flight executors are
-- fenced by the protocol bump below; a lease they already hold may only age out normally.
DROP TRIGGER IF EXISTS companion_turns_recover_interrupted_insert ON public.companion_turns;
DROP TRIGGER IF EXISTS companion_turns_recover_interrupted_update ON public.companion_turns;
DROP TRIGGER IF EXISTS companion_operations_settle_recovery ON public.companion_operations;
--> statement-breakpoint

UPDATE public.companion_operations operation_row
SET status = 'cancelled',
    settled_at = COALESCE(operation_row.settled_at, statement_timestamp()),
    last_error_code = NULL,
    last_error_message = NULL,
    last_error_action = NULL,
    updated_at = statement_timestamp()
WHERE operation_row.kind = 'restart_pi'
  AND operation_row.trigger = 'recovery'
  AND operation_row.status IN ('pending', 'running');
--> statement-breakpoint

-- Keep every occurrence and its expurgated error, while making its terminal release explicit.
UPDATE public.companion_turns turn_row
SET resolution = 'auto_abandoned',
    last_error_action = CASE
      WHEN turn_row.last_error_code IS NULL THEN NULL
      ELSE 'none'::public.companion_runtime_error_action
    END,
    updated_at = statement_timestamp()
WHERE turn_row.status = 'interrupted'
  AND (
    turn_row.resolution IS DISTINCT FROM 'auto_abandoned'
    OR turn_row.last_error_action IS DISTINCT FROM
      CASE WHEN turn_row.last_error_code IS NULL THEN NULL
        ELSE 'none'::public.companion_runtime_error_action END
  );
--> statement-breakpoint

-- A main interruption invalidates optimistic Box/Pi readiness until ordinary turn-derived Start
-- re-observes the exact Box. This repairs historical stale-idle projections without making cleanup
-- durable: the interruption is already terminal, and only accepted later work owns the wake path.
UPDATE public.companion_runtime_instances instance
SET box_state = 'unknown',
    pi_state = 'unknown',
    pi_invocation_id = NULL,
    health_due_at = statement_timestamp(),
    updated_at = statement_timestamp()
WHERE EXISTS (
  SELECT 1
  FROM public.companion_turns interrupted_turn
  WHERE interrupted_turn.org_id = instance.org_id
    AND interrupted_turn.companion_id = instance.companion_id
    AND interrupted_turn.routine_snapshot_id IS NULL
    AND interrupted_turn.status = 'interrupted'
    AND NOT EXISTS (
      SELECT 1
      FROM public.companion_turns later_success
      WHERE later_success.org_id = interrupted_turn.org_id
        AND later_success.companion_id = interrupted_turn.companion_id
        AND later_success.routine_snapshot_id IS NULL
        AND later_success.queue_sequence > interrupted_turn.queue_sequence
        AND later_success.status = 'succeeded'
    )
);
--> statement-breakpoint

UPDATE public.companion_turn_attempts attempt
SET last_error_action = CASE
      WHEN attempt.last_error_code IS NULL THEN NULL
      ELSE 'none'::public.companion_runtime_error_action
    END,
    updated_at = statement_timestamp()
WHERE attempt.status = 'interrupted'
  AND attempt.last_error_action IS DISTINCT FROM
    CASE WHEN attempt.last_error_code IS NULL THEN NULL
      ELSE 'none'::public.companion_runtime_error_action END;
--> statement-breakpoint

UPDATE public.companion_operations operation_row
SET last_error_action = CASE
      WHEN operation_row.last_error_code IS NULL THEN NULL
      ELSE 'none'::public.companion_runtime_error_action
    END,
    updated_at = statement_timestamp()
WHERE operation_row.status = 'interrupted'
  AND operation_row.last_error_action IS DISTINCT FROM
    CASE WHEN operation_row.last_error_code IS NULL THEN NULL
      ELSE 'none'::public.companion_runtime_error_action END;
--> statement-breakpoint

DROP INDEX IF EXISTS public.companion_operations_one_recovery_per_turn_uq;
DROP INDEX IF EXISTS public.companion_operations_recovery_metrics_idx;
DROP INDEX IF EXISTS public.companion_turns_auto_abandoned_metrics_idx;
--> statement-breakpoint

DROP FUNCTION IF EXISTS public.companion_api_retry_turn(
  uuid, uuid, uuid, uuid, public.companion_client_surface
);
DROP FUNCTION IF EXISTS public.companion_api_read_recovery(uuid, uuid);
DROP FUNCTION IF EXISTS public.companion_api_list_recoveries(uuid);
DROP FUNCTION IF EXISTS public.companion_runtime_recovery_metrics();
DROP FUNCTION IF EXISTS public.companion_runtime_settle_recovery_operation();
DROP FUNCTION IF EXISTS public.companion_runtime_enqueue_interrupted_recovery();
DROP FUNCTION IF EXISTS public.companion_runtime_ensure_turn_recovery(uuid, uuid, uuid);
--> statement-breakpoint

-- Normalize every future interruption at the table boundary, including direct terminalization in
-- the claim sweep. This prevents any old error action from becoming an actionable retry contract.
CREATE FUNCTION public.companion_runtime_normalize_terminal_interruption()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
BEGIN
  IF NEW.status = 'interrupted' THEN
    IF NEW.last_error_code IS NOT NULL THEN
      NEW.last_error_action := 'none'::public.companion_runtime_error_action;
    END IF;
    IF TG_TABLE_NAME = 'companion_turns' THEN
      NEW.resolution := 'auto_abandoned';
      IF NEW.routine_snapshot_id IS NULL
         AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'interrupted') THEN
        UPDATE public.companion_runtime_instances instance
        SET box_state = 'unknown',
            pi_state = 'unknown',
            pi_invocation_id = NULL,
            health_due_at = statement_timestamp(),
            updated_at = statement_timestamp()
        WHERE instance.org_id = NEW.org_id
          AND instance.companion_id = NEW.companion_id;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_runtime_normalize_terminal_interruption() FROM PUBLIC;
--> statement-breakpoint

CREATE TRIGGER companion_turns_normalize_interruption
  BEFORE INSERT OR UPDATE OF status, resolution, last_error_code, last_error_action
  ON public.companion_turns
  FOR EACH ROW EXECUTE FUNCTION public.companion_runtime_normalize_terminal_interruption();
CREATE TRIGGER companion_turn_attempts_normalize_interruption
  BEFORE INSERT OR UPDATE OF status, last_error_code, last_error_action
  ON public.companion_turn_attempts
  FOR EACH ROW EXECUTE FUNCTION public.companion_runtime_normalize_terminal_interruption();
CREATE TRIGGER companion_operations_normalize_interruption
  BEFORE INSERT OR UPDATE OF status, last_error_code, last_error_action
  ON public.companion_operations
  FOR EACH ROW EXECUTE FUNCTION public.companion_runtime_normalize_terminal_interruption();
--> statement-breakpoint

ALTER TABLE public.companion_turns
  ADD CONSTRAINT companion_turns_interrupted_action_check CHECK (
    status <> 'interrupted' OR last_error_action = 'none'
  );
ALTER TABLE public.companion_turn_attempts
  ADD CONSTRAINT companion_turn_attempts_interrupted_action_check CHECK (
    status <> 'interrupted' OR last_error_action = 'none'
  );
ALTER TABLE public.companion_operations
  ADD CONSTRAINT companion_operations_interrupted_action_check CHECK (
    status <> 'interrupted' OR last_error_action = 'none'
  );
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.companion_runtime_operation_lane(
  p_org_id uuid,
  p_companion_id uuid,
  p_operation_id uuid
)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
  SELECT CASE
    WHEN operation.kind = 'restart_pi'
      AND operation.trigger = 'user'
      AND source_turn.routine_snapshot_id IS NOT NULL
      THEN 'routine'
    ELSE 'main'
  END
  FROM public.companion_operations operation
  LEFT JOIN public.companion_turns source_turn
    ON source_turn.org_id = operation.org_id
   AND source_turn.companion_id = operation.companion_id
   AND source_turn.id = operation.source_turn_id
  WHERE operation.org_id = p_org_id
    AND operation.companion_id = p_companion_id
    AND operation.id = p_operation_id
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.companion_runtime_routine_lane_quiescent(
  p_org_id uuid,
  p_companion_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
  SELECT NOT EXISTS (
    SELECT 1
    FROM public.companion_turns turn_row
    WHERE turn_row.org_id = p_org_id
      AND turn_row.companion_id = p_companion_id
      AND turn_row.routine_snapshot_id IS NOT NULL
      AND turn_row.status IN ('starting', 'dispatching', 'running', 'needs_input')
  )
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_runtime_routine_lane_quiescent(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint

-- Remove every terminal interruption from claim eligibility, ordering, lane ownership, and
-- lifecycle capture. Guarded text rewrites fail loudly if the mature claim state machine drifts.
DO $companion_protocol_6_claim_guards$
DECLARE
  v_signature text :=
    'public.companion_runtime_claim_work_without_material_guard(text,integer,integer,bigint)';
  v_definition text := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_signature));
  v_status_old text := $r$'starting', 'dispatching', 'running', 'needs_input', 'interrupted'$r$;
  v_status_new text := $r$'starting', 'dispatching', 'running', 'needs_input'$r$;
  v_active_resolution text :=
    $r$AND (active_turn.status <> 'interrupted' OR active_turn.resolution IS NULL)$r$;
  v_blocking_resolution text :=
    $r$AND (blocking_turn.status <> 'interrupted' OR blocking_turn.resolution IS NULL)$r$;
  v_routine_resolution text :=
    $r$AND (routine_turn.status <> 'interrupted' OR routine_turn.resolution IS NULL)$r$;
  v_recovery_guard text := $r$AND v_operation_trigger <> 'recovery'$r$;
  v_count integer;
BEGIN
  v_count := (char_length(v_definition) - char_length(replace(v_definition, v_status_old, '')))
    / char_length(v_status_old);
  IF v_definition IS NULL OR v_count <> 5 THEN
    RAISE EXCEPTION 'protocol-6 claim status guard matched %, expected 5', COALESCE(v_count, 0)
      USING ERRCODE = '55000';
  END IF;
  v_definition := replace(v_definition, v_status_old, v_status_new);

  v_count := (char_length(v_definition)
    - char_length(replace(v_definition, v_active_resolution, '')))
    / char_length(v_active_resolution);
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'protocol-6 active resolution guard matched %, expected 2', v_count
      USING ERRCODE = '55000';
  END IF;
  v_definition := replace(v_definition, v_active_resolution, '');

  v_count := (char_length(v_definition)
    - char_length(replace(v_definition, v_blocking_resolution, '')))
    / char_length(v_blocking_resolution);
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'protocol-6 blocking resolution guard matched %, expected 1', v_count
      USING ERRCODE = '55000';
  END IF;
  v_definition := replace(v_definition, v_blocking_resolution, '');

  v_count := (char_length(v_definition)
    - char_length(replace(v_definition, v_routine_resolution, '')))
    / char_length(v_routine_resolution);
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'protocol-6 routine resolution guard matched %, expected 1', v_count
      USING ERRCODE = '55000';
  END IF;
  v_definition := replace(v_definition, v_routine_resolution, '');

  v_count := (char_length(v_definition)
    - char_length(replace(v_definition, v_recovery_guard, '')))
    / char_length(v_recovery_guard);
  IF v_count <> 3 THEN
    RAISE EXCEPTION 'protocol-6 recovery claim guard matched %, expected 3', v_count
      USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(v_definition, v_recovery_guard, '');
END
$companion_protocol_6_claim_guards$;
--> statement-breakpoint

-- Material preparation follows the same rule. A main turn queued after an interruption may stage
-- while Pi is still projected non-idle; its attempt preflight owns the Pi-only recycle.
DO $companion_protocol_6_material_guards$
DECLARE
  v_signature text := 'public.companion_runtime_prepare_queued_turn_material(bigint)';
  v_definition text := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_signature));
  v_status_old text := $r$'starting', 'dispatching', 'running', 'needs_input', 'interrupted'$r$;
  v_status_new text := $r$'starting', 'dispatching', 'running', 'needs_input'$r$;
  v_resolution text :=
    $r$AND (active_turn.status <> 'interrupted' OR active_turn.resolution IS NULL)$r$;
  v_idle_old text :=
    $r$AND (queued_turn.routine_snapshot_id IS NOT NULL OR instance.pi_state = 'idle')$r$;
  v_idle_new text := $r$AND (
        queued_turn.routine_snapshot_id IS NOT NULL
        OR instance.pi_state = 'idle'
        OR (
          instance.box_state IN ('ready', 'idle', 'running')
          AND EXISTS (
          SELECT 1
          FROM public.companion_turns interrupted_predecessor
          WHERE interrupted_predecessor.org_id = queued_turn.org_id
            AND interrupted_predecessor.companion_id = queued_turn.companion_id
            AND interrupted_predecessor.routine_snapshot_id IS NULL
            AND interrupted_predecessor.status = 'interrupted'
            AND interrupted_predecessor.queue_sequence < queued_turn.queue_sequence
          )
        )
      )$r$;
  v_count integer;
BEGIN
  v_count := (char_length(v_definition) - char_length(replace(v_definition, v_status_old, '')))
    / char_length(v_status_old);
  IF v_definition IS NULL OR v_count <> 2 THEN
    RAISE EXCEPTION 'protocol-6 material status guard matched %, expected 2', COALESCE(v_count, 0)
      USING ERRCODE = '55000';
  END IF;
  v_definition := replace(v_definition, v_status_old, v_status_new);

  v_count := (char_length(v_definition) - char_length(replace(v_definition, v_resolution, '')))
    / char_length(v_resolution);
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'protocol-6 material resolution guard matched %, expected 2', v_count
      USING ERRCODE = '55000';
  END IF;
  v_definition := replace(v_definition, v_resolution, '');

  v_count := (char_length(v_definition) - char_length(replace(v_definition, v_idle_old, '')))
    / char_length(v_idle_old);
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'protocol-6 material idle guard matched %, expected 2', v_count
      USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(v_definition, v_idle_old, v_idle_new);
END
$companion_protocol_6_material_guards$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.companion_runtime_defer_busy_turn_start()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.kind = 'start'
     AND NEW.trigger = 'turn'
     AND NEW.source_turn_id IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM public.companion_turns active_turn
       WHERE active_turn.org_id = NEW.org_id
         AND active_turn.companion_id = NEW.companion_id
         AND active_turn.id <> NEW.source_turn_id
         AND active_turn.status IN ('starting', 'dispatching', 'running', 'needs_input')
     ) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_runtime_defer_busy_turn_start() FROM PUBLIC;
--> statement-breakpoint

-- Cancel remains the Stop/remove endpoint for active or queued work. An interrupted occurrence is
-- terminal, so Cancel rejects it with a stable invalid-state SQLSTATE and performs no mutation.
CREATE OR REPLACE FUNCTION public.companion_api_cancel_turn(
  p_org_id uuid,
  p_companion_id uuid,
  p_turn_id uuid
)
RETURNS TABLE (turn jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_now timestamp with time zone := clock_timestamp();
  v_status public.companion_turn_status;
  v_dispatch public.companion_dispatch_state;
BEGIN
  PERFORM public.companion_api_require_access(p_org_id, p_companion_id, 'editor');
  PERFORM 1 FROM public.companion_runtime_instances instance
  WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id
  FOR UPDATE;

  SELECT source_turn.status INTO v_status
  FROM public.companion_turns source_turn
  WHERE source_turn.org_id = p_org_id
    AND source_turn.companion_id = p_companion_id
    AND source_turn.id = p_turn_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Companion turn not found' USING ERRCODE = '22023';
  END IF;

  IF v_status = 'cancelled' THEN
    RETURN QUERY SELECT public.companion_api_turn_json(p_org_id, p_companion_id, p_turn_id);
    RETURN;
  END IF;

  IF v_status IN ('starting', 'dispatching', 'running', 'needs_input') THEN
    SELECT attempt.dispatch_state INTO v_dispatch
    FROM public.companion_turn_attempts attempt
    WHERE attempt.org_id = p_org_id
      AND attempt.companion_id = p_companion_id
      AND attempt.turn_id = p_turn_id
    ORDER BY attempt.attempt_number DESC, attempt.id DESC
    LIMIT 1;
    IF v_dispatch IN ('write_intent', 'accepted', 'ambiguous') THEN
      UPDATE public.companion_turns source_turn
      SET cancel_requested_at = COALESCE(source_turn.cancel_requested_at, v_now),
          updated_at = v_now
      WHERE source_turn.org_id = p_org_id
        AND source_turn.companion_id = p_companion_id
        AND source_turn.id = p_turn_id;
      RETURN QUERY SELECT public.companion_api_turn_json(p_org_id, p_companion_id, p_turn_id);
      RETURN;
    END IF;
  ELSIF v_status <> 'queued' THEN
    RAISE EXCEPTION 'only a queued or active Companion turn can be cancelled'
      USING ERRCODE = '55000';
  END IF;

  UPDATE public.companion_operations turn_start
  SET status = 'cancelled', settled_at = v_now, updated_at = v_now
  WHERE turn_start.org_id = p_org_id
    AND turn_start.companion_id = p_companion_id
    AND turn_start.source_turn_id = p_turn_id
    AND turn_start.kind = 'start'
    AND turn_start.trigger = 'turn'
    AND turn_start.status = 'pending';

  UPDATE public.companion_turn_attempts attempt
  SET status = 'cancelled',
      settled_at = COALESCE(attempt.settled_at, v_now),
      last_error_code = NULL,
      last_error_message = NULL,
      last_error_action = NULL,
      updated_at = v_now
  WHERE attempt.org_id = p_org_id
    AND attempt.companion_id = p_companion_id
    AND attempt.turn_id = p_turn_id
    AND attempt.status IN ('starting', 'dispatching', 'running', 'needs_input');

  UPDATE public.companion_turns source_turn
  SET status = 'cancelled',
      cold_start_deadline_at = NULL,
      inactivity_deadline_at = NULL,
      absolute_deadline_at = NULL,
      state_changed_at = v_now,
      settled_at = v_now,
      last_error_code = NULL,
      last_error_message = NULL,
      last_error_action = NULL,
      updated_at = v_now
  WHERE source_turn.org_id = p_org_id
    AND source_turn.companion_id = p_companion_id
    AND source_turn.id = p_turn_id
    AND source_turn.status IN ('queued', 'starting', 'dispatching', 'running', 'needs_input');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'only a queued or active Companion turn can be cancelled'
      USING ERRCODE = '55000';
  END IF;

  UPDATE public.companion_decision_deliveries delivery
  SET decision_status = CASE WHEN delivery.decision_status = 'pending'
        THEN 'cancelled'::public.companion_decision_status ELSE delivery.decision_status END,
      responded_at = CASE WHEN delivery.decision_status = 'pending' THEN v_now ELSE delivery.responded_at END,
      delivery_state = CASE WHEN delivery.command_id IS NULL
        THEN 'cancelled'::public.companion_decision_delivery_state
        ELSE 'ambiguous'::public.companion_decision_delivery_state END,
      delivery_checkpoint = CASE WHEN delivery.command_id IS NULL THEN 'cancelled' ELSE 'ambiguous' END,
      delivery_checkpoint_sequence = delivery.delivery_checkpoint_sequence + 1,
      last_error_code = CASE WHEN delivery.command_id IS NULL THEN NULL
        ELSE 'turn_cancelled_after_delivery_intent' END,
      last_error_message = CASE WHEN delivery.command_id IS NULL THEN NULL
        ELSE 'The turn was cancelled after a decision response may have reached Pi.' END,
      last_error_action = CASE WHEN delivery.command_id IS NULL THEN NULL
        ELSE 'none'::public.companion_runtime_error_action END,
      updated_at = v_now
  WHERE delivery.org_id = p_org_id AND delivery.companion_id = p_companion_id
    AND delivery.turn_id = p_turn_id
    AND delivery.delivery_state NOT IN ('delivered', 'cancelled');

  RETURN QUERY SELECT public.companion_api_turn_json(p_org_id, p_companion_id, p_turn_id);
END
$$;
--> statement-breakpoint

-- Preserve the latest terminal interruption as passive history in first-party projections. It is
-- no longer actionable and does not suppress later work.
DO $companion_protocol_6_interruption_projection$
DECLARE
  v_signature text;
  v_definition text;
  v_resolution text := $r$AND interrupted.resolution IS NULL$r$;
  v_order_old text := 'ORDER BY interrupted.queue_sequence, interrupted.id LIMIT 1';
  v_order_new text := 'ORDER BY interrupted.queue_sequence DESC, interrupted.id DESC LIMIT 1';
  v_count integer;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.companion_api_read_runtime(uuid,uuid)',
    'public.companion_api_list_runtime(uuid)',
    'public.companion_api_read_thread(uuid,uuid)',
    'public.companion_api_sync_thread(uuid,uuid)',
    'public.companion_api_thread_metadata(uuid,uuid,boolean)'
  ] LOOP
    v_definition := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_signature));
    v_count := (char_length(v_definition)
      - char_length(replace(v_definition, v_resolution, '')))
      / char_length(v_resolution);
    IF v_definition IS NULL OR v_count <> 1 THEN
      RAISE EXCEPTION 'protocol-6 interruption resolution filter % matched %, expected 1',
        v_signature, COALESCE(v_count, 0) USING ERRCODE = '55000';
    END IF;
    v_definition := replace(v_definition, v_resolution, '');
    v_count := (char_length(v_definition)
      - char_length(replace(v_definition, v_order_old, '')))
      / char_length(v_order_old);
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'protocol-6 interruption order % matched %, expected 1', v_signature, v_count
        USING ERRCODE = '55000';
    END IF;
    EXECUTE replace(v_definition, v_order_old, v_order_new);
  END LOOP;
END
$companion_protocol_6_interruption_projection$;
--> statement-breakpoint

DO $companion_protocol_6_notification_copy$
DECLARE
  v_signature text := 'public.companion_notification_terminal_turn()';
  v_definition text := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_signature));
  v_old text :=
    $r$v_body := COALESCE(NEW.last_error_message, 'Open the conversation to retry or cancel.');$r$;
  v_new text := $r$v_body := left(
      COALESCE(NEW.last_error_message, 'This turn ended without a confirmed outcome.'),
      180 - char_length(' Later messages continue automatically.')
    ) || ' Later messages continue automatically.';$r$;
  v_count integer;
BEGIN
  v_count := (char_length(v_definition) - char_length(replace(v_definition, v_old, '')))
    / char_length(v_old);
  IF v_definition IS NULL OR v_count <> 1 THEN
    RAISE EXCEPTION 'protocol-6 interruption notification matched %, expected 1',
      COALESCE(v_count, 0) USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(v_definition, v_old, v_new);
END
$companion_protocol_6_notification_copy$;
--> statement-breakpoint

-- Protocol 6 is the terminal-interruption claim boundary. Protocol-5 executors may finish an
-- already-held lease, but cannot claim work under the new release semantics.
DO $companion_terminal_interruption_claim_protocol$
DECLARE
  v_signature text :=
    'public.companion_runtime_claim_work(text,integer,integer,bigint,integer,integer)';
  v_definition text := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_signature));
  v_old text := 'IF p_material_protocol IS DISTINCT FROM 5 THEN RETURN; END IF;';
  v_new text := 'IF p_material_protocol IS DISTINCT FROM 6 THEN RETURN; END IF;';
  v_count integer;
BEGIN
  v_count := (char_length(v_definition) - char_length(replace(v_definition, v_old, '')))
    / char_length(v_old);
  IF v_definition IS NULL OR v_count <> 1 THEN
    RAISE EXCEPTION 'protocol-6 claim boundary matched %, expected 1', COALESCE(v_count, 0)
      USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(v_definition, v_old, v_new);
END
$companion_terminal_interruption_claim_protocol$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_runtime_claim_work(
  text, integer, integer, bigint, integer, integer
) FROM PUBLIC;
