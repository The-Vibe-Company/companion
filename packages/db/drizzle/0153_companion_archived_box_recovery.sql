-- Protocol 5 keeps an interrupted turn as durable history after exact cleanup and marks it
-- auto_abandoned. The busy-turn Start guard predates that resolution and would still suppress the
-- next ordinary wake Start, leaving the queued turn eligible for a direct attempt against an
-- archived Box. Only unresolved interruptions own their lane and may defer a derived Start.
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
         AND active_turn.status IN (
           'starting', 'dispatching', 'running', 'needs_input', 'interrupted'
         )
         AND (active_turn.status <> 'interrupted' OR active_turn.resolution IS NULL)
     ) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_runtime_defer_busy_turn_start() FROM PUBLIC;
--> statement-breakpoint

-- A recovery claim may be taken over after its pending checkpoint. Re-observing an archived or
-- absent Box remains valid negative proof at every later restart_pi checkpoint that would
-- otherwise contact Pi. Isolated routine cleanup keeps its existing pending-only shortcut.
DO $companion_archived_recovery_checkpoint$
DECLARE
  v_signature text :=
    'public.companion_runtime_checkpoint(uuid,uuid,uuid,bigint,bigint,text,'
    || 'public.companion_runtime_work_kind,uuid,bigint,text,text,uuid,text,bigint,'
    || 'timestamptz,integer,integer,integer)';
  v_definition text := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_signature));
  v_old text := $r$        (v_current_checkpoint = 'pending' AND p_next_checkpoint = 'pi_ready'
          AND (
            public.companion_runtime_operation_lane(
              p_org_id, p_companion_id, p_work_id
            ) = 'routine'
            OR (
              v_box_state IN ('absent', 'archived')
              AND EXISTS ($r$;
  v_new text := $r$        (v_current_checkpoint IN ('pending', 'restarting_pi', 'starting_pi', 'pi_observed')
          AND p_next_checkpoint = 'pi_ready'
          AND (
            (
              v_current_checkpoint = 'pending'
              AND public.companion_runtime_operation_lane(
                p_org_id, p_companion_id, p_work_id
              ) = 'routine'
            )
            OR (
              v_box_state IN ('absent', 'archived')
              AND EXISTS ($r$;
  v_count integer;
BEGIN
  v_count := (char_length(v_definition) - char_length(replace(v_definition, v_old, '')))
    / char_length(v_old);
  IF v_definition IS NULL OR v_count <> 1 THEN
    RAISE EXCEPTION 'archived recovery checkpoint matched %, expected 1', COALESCE(v_count, 0)
      USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(v_definition, v_old, v_new);
END
$companion_archived_recovery_checkpoint$;
