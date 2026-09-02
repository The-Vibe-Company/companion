-- A recovery is exact lane-local cleanup, not higher-priority lifecycle work. Keep a pending
-- recovery behind any operation or attempt that is already active on its lane, and keep a new
-- Start behind unresolved cleanup even while that cleanup is waiting for backoff. This also
-- repairs the rolling overlap by reclaiming the already-running work before cleanup.
DO $companion_recovery_lane_interlock$
DECLARE
  v_signature text :=
    'public.companion_runtime_claim_work_without_material_guard(text,integer,integer,bigint)';
  v_definition text := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_signature));
  v_old text;
  v_new text;
  v_count integer;
BEGIN
  v_old := $r$        AND o.kind IN ('stop', 'restart_pi', 'restart_box')
        AND o.status IN ('pending', 'running') AND o.available_at <= v_now
      ORDER BY CASE WHEN o.status = 'running' THEN 0 ELSE 1 END, o.queue_sequence, o.id
      LIMIT 1
      FOR UPDATE;$r$;
  v_new := $r$        AND o.kind IN ('stop', 'restart_pi', 'restart_box')
        AND o.status IN ('pending', 'running') AND o.available_at <= v_now
        AND (
          o.status = 'running'
          OR o.trigger <> 'recovery'
          OR (
            NOT EXISTS (
              SELECT 1 FROM public.companion_operations active_operation
              WHERE active_operation.org_id = o.org_id
                AND active_operation.companion_id = o.companion_id
                AND active_operation.execution_lane = v_lane
                AND active_operation.status = 'running'
            )
            AND NOT EXISTS (
              SELECT 1 FROM public.companion_turn_attempts active_attempt
              WHERE active_attempt.org_id = o.org_id
                AND active_attempt.companion_id = o.companion_id
                AND active_attempt.execution_lane = v_lane
                AND active_attempt.status IN (
                  'starting', 'dispatching', 'running', 'needs_input'
                )
            )
          )
        )
      ORDER BY CASE WHEN o.status = 'running' THEN 0 ELSE 1 END, o.queue_sequence, o.id
      LIMIT 1
      FOR UPDATE;$r$;
  v_count := (char_length(v_definition) - char_length(replace(v_definition, v_old, '')))
    / char_length(v_old);
  IF v_definition IS NULL OR v_count <> 1 THEN
    RAISE EXCEPTION 'recovery active-lane interlock matched %, expected 1', COALESCE(v_count, 0)
      USING ERRCODE = '55000';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);

  v_old := $r$        AND (
          o.trigger <> 'turn'
          OR EXISTS (
            SELECT 1
            FROM public.companion_turns source_turn
            WHERE source_turn.org_id = o.org_id
              AND source_turn.companion_id = o.companion_id
              AND source_turn.id = o.source_turn_id
              AND source_turn.status = 'queued'
          )
        )
      ORDER BY CASE WHEN o.status = 'running' THEN 0 ELSE 1 END, o.queue_sequence, o.id$r$;
  v_new := $r$        AND (
          o.trigger <> 'turn'
          OR EXISTS (
            SELECT 1
            FROM public.companion_turns source_turn
            WHERE source_turn.org_id = o.org_id
              AND source_turn.companion_id = o.companion_id
              AND source_turn.id = o.source_turn_id
              AND source_turn.status = 'queued'
          )
        )
        AND (
          o.status = 'running'
          OR NOT EXISTS (
            SELECT 1
            FROM public.companion_operations recovery_operation
            JOIN public.companion_turns recovery_source
              ON recovery_source.org_id = recovery_operation.org_id
             AND recovery_source.companion_id = recovery_operation.companion_id
             AND recovery_source.id = recovery_operation.source_turn_id
            WHERE recovery_operation.org_id = o.org_id
              AND recovery_operation.companion_id = o.companion_id
              AND recovery_operation.execution_lane = v_lane
              AND recovery_operation.kind = 'restart_pi'
              AND recovery_operation.trigger = 'recovery'
              AND recovery_operation.status IN ('pending', 'running')
              AND recovery_source.status = 'interrupted'
              AND recovery_source.resolution IS NULL
          )
        )
      ORDER BY CASE WHEN o.status = 'running' THEN 0 ELSE 1 END, o.queue_sequence, o.id$r$;
  v_count := (char_length(v_definition) - char_length(replace(v_definition, v_old, '')))
    / char_length(v_old);
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'Start recovery interlock matched %, expected 1', v_count
      USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(v_definition, v_old, v_new);
END
$companion_recovery_lane_interlock$;
