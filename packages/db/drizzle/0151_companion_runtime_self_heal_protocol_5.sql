-- Interrupted work is durable diagnostic history, not a permanent queue lock. Runtime protocol 5
-- owns one internal Pi cleanup per interrupted occurrence, retries that cleanup with bounded
-- backoff, and resolves the occurrence only after the exact cleanup reaches its terminal proof.

-- Adopt pending retries from the pre-protocol-5 world. Keeping only the most advanced operation
-- prevents an old explicit retry from replaying an ambiguous prompt after this migration lands.
WITH ranked AS (
  SELECT operation_row.id,
    row_number() OVER (
      PARTITION BY operation_row.companion_id, operation_row.source_turn_id
      ORDER BY CASE WHEN operation_row.status = 'running' THEN 0 ELSE 1 END,
        operation_row.queue_sequence DESC, operation_row.id DESC
    ) AS rank
  FROM public.companion_operations operation_row
  JOIN public.companion_turns source_turn
    ON source_turn.org_id = operation_row.org_id
   AND source_turn.companion_id = operation_row.companion_id
   AND source_turn.id = operation_row.source_turn_id
  WHERE operation_row.kind = 'restart_pi'
    AND operation_row.status IN ('pending', 'running')
    AND source_turn.status = 'interrupted'
    AND source_turn.resolution IS NULL
)
UPDATE public.companion_operations operation_row
SET status = 'cancelled',
    settled_at = statement_timestamp(),
    last_error_code = NULL,
    last_error_message = NULL,
    last_error_action = NULL,
    updated_at = statement_timestamp()
FROM ranked
WHERE ranked.id = operation_row.id AND ranked.rank > 1;
--> statement-breakpoint

UPDATE public.companion_operations operation_row
SET trigger = 'recovery', request_id = NULL, updated_at = statement_timestamp()
FROM public.companion_turns source_turn
WHERE source_turn.org_id = operation_row.org_id
  AND source_turn.companion_id = operation_row.companion_id
  AND source_turn.id = operation_row.source_turn_id
  AND source_turn.status = 'interrupted'
  AND source_turn.resolution IS NULL
  AND operation_row.kind = 'restart_pi'
  AND operation_row.status IN ('pending', 'running');
--> statement-breakpoint

CREATE UNIQUE INDEX companion_operations_one_recovery_per_turn_uq
  ON public.companion_operations(companion_id, source_turn_id)
  WHERE kind = 'restart_pi' AND trigger = 'recovery';
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
      AND operation.trigger IN ('user', 'recovery')
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
      AND (
        turn_row.status IN ('starting', 'dispatching', 'running', 'needs_input')
        OR (turn_row.status = 'interrupted' AND turn_row.resolution IS NULL)
      )
  )
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_runtime_ensure_turn_recovery(
  p_org_id uuid,
  p_companion_id uuid,
  p_turn_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_owner_id text;
  v_generation bigint;
  v_surface public.companion_client_surface;
  v_lane text;
BEGIN
  SELECT companion.owner_id, instance.generation, turn_row.client_surface,
    CASE WHEN turn_row.routine_snapshot_id IS NULL THEN 'main' ELSE 'routine' END
  INTO v_owner_id, v_generation, v_surface, v_lane
  FROM public.companion_turns turn_row
  JOIN public.companions companion
    ON companion.org_id = turn_row.org_id AND companion.id = turn_row.companion_id
  JOIN public.companion_runtime_instances instance
    ON instance.org_id = turn_row.org_id AND instance.companion_id = turn_row.companion_id
  WHERE turn_row.org_id = p_org_id
    AND turn_row.companion_id = p_companion_id
    AND turn_row.id = p_turn_id
    AND turn_row.status = 'interrupted'
    AND turn_row.resolution IS NULL
    AND instance.retirement_state = 'active'
  FOR UPDATE OF turn_row, instance;
  IF NOT FOUND THEN RETURN; END IF;

  -- An explicit lifecycle intent already owns the same cleanup boundary. Its settlement trigger
  -- resolves the interrupted occurrences on success and re-enqueues recovery on failure.
  IF EXISTS (
    SELECT 1
    FROM public.companion_operations lifecycle
    WHERE lifecycle.org_id = p_org_id
      AND lifecycle.companion_id = p_companion_id
      AND lifecycle.status IN ('pending', 'running')
      AND lifecycle.trigger <> 'recovery'
      AND (
        lifecycle.kind IN ('delete', 'restart_box')
        OR (lifecycle.kind = 'stop' AND v_lane = 'main')
        OR (
          lifecycle.kind = 'restart_pi'
          AND public.companion_runtime_operation_lane(
            lifecycle.org_id, lifecycle.companion_id, lifecycle.id
          ) = v_lane
        )
      )
  ) THEN
    RETURN;
  END IF;

  INSERT INTO public.companion_operations(
    org_id, companion_id, request_id, kind, trigger, actor_id, source_turn_id,
    queue_sequence, turn_queue_cutoff, runtime_generation, client_surface,
    status, available_at, created_at, updated_at
  ) VALUES (
    p_org_id, p_companion_id, NULL, 'restart_pi', 'recovery', v_owner_id, p_turn_id,
    0, 0, v_generation, v_surface,
    'pending', clock_timestamp(), clock_timestamp(), clock_timestamp()
  )
  ON CONFLICT (companion_id, source_turn_id)
    WHERE kind = 'restart_pi' AND trigger = 'recovery'
  DO NOTHING;
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_runtime_ensure_turn_recovery(uuid,uuid,uuid) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_runtime_enqueue_interrupted_recovery()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
BEGIN
  IF NEW.status = 'interrupted' AND NEW.resolution IS NULL THEN
    PERFORM public.companion_runtime_ensure_turn_recovery(
      NEW.org_id, NEW.companion_id, NEW.id
    );
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_runtime_enqueue_interrupted_recovery() FROM PUBLIC;
--> statement-breakpoint

CREATE TRIGGER companion_turns_recover_interrupted_insert
  AFTER INSERT ON public.companion_turns
  FOR EACH ROW EXECUTE FUNCTION public.companion_runtime_enqueue_interrupted_recovery();
CREATE TRIGGER companion_turns_recover_interrupted_update
  AFTER UPDATE OF status ON public.companion_turns
  FOR EACH ROW WHEN (NEW.status = 'interrupted')
  EXECUTE FUNCTION public.companion_runtime_enqueue_interrupted_recovery();
--> statement-breakpoint

CREATE FUNCTION public.companion_runtime_settle_recovery_operation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_delay_seconds integer;
BEGIN
  IF NEW.kind = 'restart_pi' AND NEW.trigger = 'recovery' THEN
    IF NEW.status = 'succeeded' THEN
      UPDATE public.companion_turns source_turn
      SET resolution = 'auto_abandoned', updated_at = clock_timestamp()
      WHERE source_turn.org_id = NEW.org_id
        AND source_turn.companion_id = NEW.companion_id
        AND source_turn.id = NEW.source_turn_id
        AND source_turn.status = 'interrupted'
        AND source_turn.resolution IS NULL;
    ELSIF NEW.status IN ('failed', 'interrupted', 'cancelled') AND NOT EXISTS (
      SELECT 1
      FROM public.companion_operations lifecycle
      WHERE lifecycle.org_id = NEW.org_id
        AND lifecycle.companion_id = NEW.companion_id
        AND lifecycle.id <> NEW.id
        AND lifecycle.status IN ('pending', 'running')
        AND lifecycle.kind IN ('delete', 'stop', 'restart_pi', 'restart_box')
        AND lifecycle.trigger <> 'recovery'
    ) THEN
      v_delay_seconds := LEAST(300, (5 * power(2, LEAST(6, GREATEST(0, NEW.attempt_count - 1))))::integer);
      UPDATE public.companion_operations recovery
      SET status = 'pending',
          settled_at = NULL,
          available_at = clock_timestamp() + make_interval(secs => v_delay_seconds),
          last_error_code = NULL,
          last_error_message = NULL,
          last_error_action = NULL,
          updated_at = clock_timestamp()
      WHERE recovery.id = NEW.id AND recovery.status = NEW.status;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.trigger = 'user'
     AND NEW.kind IN ('stop', 'restart_pi', 'restart_box')
     AND NEW.status = 'succeeded' THEN
    UPDATE public.companion_turns interrupted_turn
    SET resolution = 'auto_abandoned', updated_at = clock_timestamp()
    WHERE interrupted_turn.org_id = NEW.org_id
      AND interrupted_turn.companion_id = NEW.companion_id
      AND interrupted_turn.status = 'interrupted'
      AND interrupted_turn.resolution IS NULL
      AND (
        NEW.kind = 'restart_box'
        OR interrupted_turn.id = NEW.source_turn_id
        OR (
          interrupted_turn.last_error_code = 'runtime_lifecycle_preempted'
          AND interrupted_turn.state_changed_at = NEW.started_at
        )
      );
  ELSIF NEW.trigger = 'user'
     AND NEW.kind IN ('stop', 'restart_pi', 'restart_box')
     AND NEW.status IN ('failed', 'interrupted', 'cancelled') THEN
    -- Re-fire the turn trigger after the explicit lifecycle owner leaves terminal state. This is
    -- deliberately a no-op row value update; the UPDATE OF status trigger observes the column.
    UPDATE public.companion_turns interrupted_turn
    SET status = interrupted_turn.status
    WHERE interrupted_turn.org_id = NEW.org_id
      AND interrupted_turn.companion_id = NEW.companion_id
      AND interrupted_turn.status = 'interrupted'
      AND interrupted_turn.resolution IS NULL
      AND (
        NEW.kind = 'restart_box'
        OR interrupted_turn.id = NEW.source_turn_id
        OR (
          interrupted_turn.last_error_code = 'runtime_lifecycle_preempted'
          AND interrupted_turn.state_changed_at = NEW.started_at
        )
      );
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_runtime_settle_recovery_operation() FROM PUBLIC;
--> statement-breakpoint

CREATE TRIGGER companion_operations_settle_recovery
  AFTER UPDATE OF status ON public.companion_operations
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.companion_runtime_settle_recovery_operation();
--> statement-breakpoint

-- Retry remains wire-compatible for older clients, but it is now an idempotent observation of
-- automatic cleanup. It never creates a user operation and therefore can never reopen or replay
-- an ambiguously dispatched prompt.
CREATE OR REPLACE FUNCTION public.companion_api_retry_turn(
  p_org_id uuid,
  p_companion_id uuid,
  p_turn_id uuid,
  p_retry_id uuid,
  p_client_surface public.companion_client_surface
)
RETURNS TABLE(operation jsonb, replayed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_turn public.companion_turns%ROWTYPE;
  v_operation_id uuid;
BEGIN
  PERFORM public.companion_api_require_access(p_org_id, p_companion_id, 'editor');
  IF p_turn_id IS NULL OR p_retry_id IS NULL OR p_client_surface IS NULL THEN
    RAISE EXCEPTION 'invalid Companion retry request' USING ERRCODE = '22023';
  END IF;

  SELECT source_turn.* INTO STRICT v_turn
  FROM public.companion_turns source_turn
  WHERE source_turn.org_id = p_org_id
    AND source_turn.companion_id = p_companion_id
    AND source_turn.id = p_turn_id
  FOR UPDATE;
  IF v_turn.status <> 'interrupted' THEN
    RAISE EXCEPTION 'only an interrupted Companion turn can be recovered' USING ERRCODE = '55000';
  END IF;

  IF v_turn.resolution IS NULL THEN
    PERFORM public.companion_runtime_ensure_turn_recovery(
      p_org_id, p_companion_id, p_turn_id
    );
  END IF;

  SELECT operation_row.id INTO v_operation_id
  FROM public.companion_operations operation_row
  WHERE operation_row.org_id = p_org_id
    AND operation_row.companion_id = p_companion_id
    AND (
      (
        operation_row.kind = 'restart_pi'
        AND operation_row.trigger = 'recovery'
        AND operation_row.source_turn_id = p_turn_id
      )
      OR (
        v_turn.resolution IS NULL
        AND operation_row.trigger = 'user'
        AND operation_row.kind IN ('delete', 'stop', 'restart_pi', 'restart_box')
        AND operation_row.status IN ('pending', 'running')
      )
    )
  ORDER BY
    CASE WHEN operation_row.status IN ('pending', 'running') THEN 0 ELSE 1 END,
    CASE WHEN operation_row.trigger = 'recovery' THEN 0 ELSE 1 END,
    operation_row.queue_sequence DESC,
    operation_row.id DESC
  LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'automatic Companion recovery is unavailable' USING ERRCODE = '40001';
  END IF;

  RETURN QUERY SELECT
    public.companion_api_operation_json(p_org_id, p_companion_id, v_operation_id), true;
END
$$;
--> statement-breakpoint

-- Backfill every unresolved historical interruption, including the production shape
-- interrupted routine -> pending restart -> waiting main message.
UPDATE public.companion_turns interrupted_turn
SET status = interrupted_turn.status
WHERE interrupted_turn.status = 'interrupted'
  AND interrupted_turn.resolution IS NULL;
--> statement-breakpoint

-- The API keeps the original error on an auto-abandoned occurrence, while the resolution tells
-- new clients why the interrupted row no longer owns the lane.
DO $companion_turn_resolution_projection$
DECLARE
  v_signature text := 'public.companion_api_turn_json(uuid,uuid,uuid)';
  v_definition text := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_signature));
  v_old text := $r$    'status', turn_row.status,
    'queue_sequence', turn_row.queue_sequence,$r$;
  v_new text := $r$    'status', turn_row.status,
    'resolution', turn_row.resolution,
    'queue_sequence', turn_row.queue_sequence,$r$;
  v_count integer;
BEGIN
  v_count := (char_length(v_definition) - char_length(replace(v_definition, v_old, '')))
    / char_length(v_old);
  IF v_definition IS NULL OR v_count <> 1 THEN
    RAISE EXCEPTION 'turn resolution projection matched %, expected 1', COALESCE(v_count, 0)
      USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(v_definition, v_old, v_new);
END
$companion_turn_resolution_projection$;
--> statement-breakpoint

-- Resolved interruptions disappear from the actionable projection, and internal recovery never
-- replaces a user lifecycle intent as latest_operation.
DO $companion_runtime_recovery_projection_filters$
DECLARE
  v_signatures text[] := ARRAY[
    'public.companion_api_read_runtime(uuid,uuid)',
    'public.companion_api_list_runtime(uuid)'
  ];
  v_signature text;
  v_definition text;
  v_count integer;
BEGIN
  FOREACH v_signature IN ARRAY v_signatures LOOP
    v_definition := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_signature));
    v_count := (
      char_length(v_definition)
      - char_length(replace(v_definition, $r$AND interrupted.status = 'interrupted'$r$, ''))
    ) / char_length($r$AND interrupted.status = 'interrupted'$r$);
    IF v_definition IS NULL OR v_count <> 1 THEN
      RAISE EXCEPTION 'runtime interruption filter % matched %, expected 1', v_signature, COALESCE(v_count, 0)
        USING ERRCODE = '55000';
    END IF;
    v_definition := replace(
      v_definition,
      $r$AND interrupted.status = 'interrupted'$r$,
      $r$AND interrupted.status = 'interrupted'
      AND interrupted.resolution IS NULL$r$
    );
    v_count := (
      char_length(v_definition)
      - char_length(replace(v_definition, $r$AND lifecycle.companion_id = instance.companion_id$r$, ''))
    ) / char_length($r$AND lifecycle.companion_id = instance.companion_id$r$);
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'latest operation filter % matched %, expected 1', v_signature, v_count
        USING ERRCODE = '55000';
    END IF;
    EXECUTE replace(
      v_definition,
      $r$AND lifecycle.companion_id = instance.companion_id$r$,
      $r$AND lifecycle.companion_id = instance.companion_id
      AND lifecycle.trigger <> 'recovery'$r$
    );
  END LOOP;
END
$companion_runtime_recovery_projection_filters$;
--> statement-breakpoint

DO $companion_thread_interruption_filter$
DECLARE
  v_signatures text[] := ARRAY[
    'public.companion_api_read_thread(uuid,uuid)',
    'public.companion_api_sync_thread(uuid,uuid)'
  ];
  v_signature text;
  v_definition text;
  v_count integer;
BEGIN
  FOREACH v_signature IN ARRAY v_signatures LOOP
    v_definition := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_signature));
    v_count := (
      char_length(v_definition)
      - char_length(replace(v_definition, $r$AND interrupted.status = 'interrupted'$r$, ''))
    ) / char_length($r$AND interrupted.status = 'interrupted'$r$);
    IF v_definition IS NULL OR v_count <> 1 THEN
      RAISE EXCEPTION 'thread interruption filter % matched %, expected 1', v_signature, COALESCE(v_count, 0)
        USING ERRCODE = '55000';
    END IF;
    EXECUTE replace(
      v_definition,
      $r$AND interrupted.status = 'interrupted'$r$,
      $r$AND interrupted.status = 'interrupted'
        AND interrupted.resolution IS NULL$r$
    );
  END LOOP;
END
$companion_thread_interruption_filter$;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_read_recovery(p_org_id uuid, p_companion_id uuid)
RETURNS TABLE(recovery jsonb)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
BEGIN
  PERFORM public.companion_api_require_access(p_org_id, p_companion_id, 'read');
  RETURN QUERY
  SELECT jsonb_build_object(
    'turn_id', operation_row.source_turn_id,
    'lane', public.companion_runtime_operation_lane(
      operation_row.org_id, operation_row.companion_id, operation_row.id
    ),
    'status', operation_row.status
  )
  FROM public.companion_operations operation_row
  WHERE operation_row.org_id = p_org_id
    AND operation_row.companion_id = p_companion_id
    AND operation_row.kind = 'restart_pi'
    AND operation_row.trigger = 'recovery'
    AND operation_row.status IN ('pending', 'running')
  ORDER BY operation_row.queue_sequence, operation_row.id
  LIMIT 1;
  IF NOT FOUND THEN RETURN QUERY SELECT NULL::jsonb; END IF;
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_list_recoveries(p_org_id uuid)
RETURNS TABLE(companion_id uuid, recovery jsonb)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
  WITH actor AS (
    SELECT public.companion_api_actor(p_org_id) AS id
  )
  SELECT companion.id, recovery_operation.value
  FROM actor
  JOIN public.companions companion ON companion.org_id = p_org_id
  LEFT JOIN public.companion_workspace_access access
    ON access.org_id = companion.org_id AND access.companion_id = companion.id
  LEFT JOIN LATERAL (
    SELECT jsonb_build_object(
      'turn_id', operation_row.source_turn_id,
      'lane', public.companion_runtime_operation_lane(
        operation_row.org_id, operation_row.companion_id, operation_row.id
      ),
      'status', operation_row.status
    ) AS value
    FROM public.companion_operations operation_row
    WHERE operation_row.org_id = companion.org_id
      AND operation_row.companion_id = companion.id
      AND operation_row.kind = 'restart_pi'
      AND operation_row.trigger = 'recovery'
      AND operation_row.status IN ('pending', 'running')
    ORDER BY operation_row.queue_sequence, operation_row.id
    LIMIT 1
  ) recovery_operation ON true
  WHERE companion.owner_id = actor.id OR access.role IS NOT NULL
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_api_read_recovery(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.companion_api_list_recoveries(uuid) FROM PUBLIC;
--> statement-breakpoint

DO $companion_recovery_projection_acl$
DECLARE
  v_pair text[][] := ARRAY[
    ARRAY['public.companion_api_read_runtime(uuid,uuid)', 'public.companion_api_read_recovery(uuid,uuid)'],
    ARRAY['public.companion_api_list_runtime(uuid)', 'public.companion_api_list_recoveries(uuid)']
  ];
  v_item text[];
  v_grantee oid;
  v_role name;
BEGIN
  FOREACH v_item SLICE 1 IN ARRAY v_pair LOOP
    FOR v_grantee IN
      SELECT DISTINCT acl.grantee
      FROM pg_catalog.pg_proc source_proc
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(source_proc.proacl, pg_catalog.acldefault('f', source_proc.proowner))
      ) acl
      WHERE source_proc.oid = pg_catalog.to_regprocedure(v_item[1])
        AND acl.privilege_type = 'EXECUTE'
        AND acl.grantee <> source_proc.proowner
    LOOP
      SELECT rolname INTO v_role FROM pg_catalog.pg_roles WHERE oid = v_grantee;
      IF v_role IS NOT NULL THEN
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', v_item[2], v_role);
      END IF;
    END LOOP;
  END LOOP;
END
$companion_recovery_projection_acl$;
--> statement-breakpoint

-- Routine event activity uses the same monotone ten-minute inactivity projection as main Pi.
DO $companion_routine_activity_deadline$
DECLARE
  v_signature text :=
    'public.companion_runtime_project_event_batch_v2(uuid,uuid,uuid,bigint,bigint,text,'
    || 'public.companion_runtime_work_kind,uuid,bigint,text,jsonb,bigint,timestamp with time zone,'
    || 'integer,integer,integer)';
  v_definition text := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_signature));
  v_old_activity text := $r$      last_activity_at = CASE WHEN p_activity_at IS NULL THEN attempt.last_activity_at
        ELSE LEAST(p_activity_at, v_now) END,$r$;
  v_new_activity text := $r$      last_activity_at = CASE WHEN p_activity_at IS NULL THEN attempt.last_activity_at
        ELSE GREATEST(
          COALESCE(attempt.last_activity_at, '-infinity'::timestamp with time zone),
          LEAST(p_activity_at, v_now)
        ) END,$r$;
  v_old_tail text := $r$  IF NOT FOUND THEN
    RAISE EXCEPTION 'routine event checkpoint changed' USING ERRCODE = '40001';
  END IF;
  UPDATE public.companion_runtime_instances instance$r$;
  v_new_tail text := $r$  IF NOT FOUND THEN
    RAISE EXCEPTION 'routine event checkpoint changed' USING ERRCODE = '40001';
  END IF;
  IF p_activity_at IS NOT NULL THEN
    UPDATE public.companion_turns turn_row
    SET inactivity_deadline_at = GREATEST(
          COALESCE(turn_row.inactivity_deadline_at, '-infinity'::timestamp with time zone),
          LEAST(
            turn_row.absolute_deadline_at,
            GREATEST(
              COALESCE(v_attempt.last_activity_at, '-infinity'::timestamp with time zone),
              LEAST(p_activity_at, v_now)
            ) + interval '10 minutes'
          )
        ),
        updated_at = v_now
    WHERE turn_row.org_id = p_org_id
      AND turn_row.companion_id = p_companion_id
      AND turn_row.id = v_attempt.turn_id;
  END IF;
  UPDATE public.companion_runtime_instances instance$r$;
  v_count integer;
BEGIN
  v_count := (char_length(v_definition) - char_length(replace(v_definition, v_old_activity, '')))
    / char_length(v_old_activity);
  IF v_definition IS NULL OR v_count <> 1 THEN
    RAISE EXCEPTION 'routine activity monotonicity matched %, expected 1', COALESCE(v_count, 0)
      USING ERRCODE = '55000';
  END IF;
  v_definition := replace(v_definition, v_old_activity, v_new_activity);
  v_count := (char_length(v_definition) - char_length(replace(v_definition, v_old_tail, '')))
    / char_length(v_old_tail);
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'routine deadline projection matched %, expected 1', v_count
      USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(v_definition, v_old_tail, v_new_tail);
END
$companion_routine_activity_deadline$;
--> statement-breakpoint

DO $companion_main_activity_deadline$
DECLARE
  v_signature text :=
    'public.companion_runtime_project_event_batch(uuid,uuid,uuid,bigint,bigint,text,'
    || 'public.companion_runtime_work_kind,uuid,bigint,text,jsonb,bigint,timestamp with time zone,'
    || 'integer,integer,integer)';
  v_definition text := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_signature));
  v_old text := $r$        ELSE LEAST(turn_row.absolute_deadline_at, v_effective_activity_at + interval '10 minutes')$r$;
  v_new text := $r$        ELSE GREATEST(
          COALESCE(turn_row.inactivity_deadline_at, '-infinity'::timestamp with time zone),
          LEAST(turn_row.absolute_deadline_at, v_effective_activity_at + interval '10 minutes')
        )$r$;
  v_count integer;
BEGIN
  v_count := (char_length(v_definition) - char_length(replace(v_definition, v_old, '')))
    / char_length(v_old);
  IF v_definition IS NULL OR v_count <> 1 THEN
    RAISE EXCEPTION 'main activity monotonicity matched %, expected 1', COALESCE(v_count, 0)
      USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(v_definition, v_old, v_new);
END
$companion_main_activity_deadline$;
--> statement-breakpoint

-- A run-scoped recovery proves only exact routine termination. It must not require the concurrently
-- running main Pi to be idle. An explicit full-Box restart receives the same captured routine
-- identity as permanent delete so apps/runtime can terminate it before stopping the Box.
DO $companion_recovery_operation_proofs$
DECLARE
  v_settle_signature text :=
    'public.companion_runtime_settle(uuid,uuid,uuid,bigint,bigint,text,'
    || 'public.companion_runtime_work_kind,uuid,text,text,text,'
    || 'public.companion_runtime_error_action)';
  v_settle text := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_settle_signature));
  v_settle_old text := $r$    IF p_terminal_status = 'succeeded'
       AND v_operation_kind IN ('start', 'restart_pi', 'restart_box')
       AND ($r$;
  v_settle_new text := $r$    IF p_terminal_status = 'succeeded'
       AND v_operation_kind IN ('start', 'restart_pi', 'restart_box')
       AND NOT (
         v_operation_kind = 'restart_pi'
         AND EXISTS (
           SELECT 1
           FROM public.companion_operations recovery_operation
           WHERE recovery_operation.org_id = p_org_id
             AND recovery_operation.companion_id = p_companion_id
             AND recovery_operation.id = p_work_id
             AND recovery_operation.trigger = 'recovery'
         )
       )
       AND ($r$;
  v_authorize_signature text :=
    'public.companion_runtime_renew_and_authorize_v2(uuid,uuid,uuid,bigint,bigint,text,'
    || 'public.companion_runtime_work_kind,uuid,integer)';
  v_authorize text := pg_catalog.pg_get_functiondef(
    pg_catalog.to_regprocedure(v_authorize_signature)
  );
  v_identity_old text := $r$AND authorization_row.operation_kind = 'delete'$r$;
  v_identity_new text := $r$AND authorization_row.operation_kind IN ('delete', 'restart_box')$r$;
  v_count integer;
BEGIN
  v_count := (char_length(v_settle) - char_length(replace(v_settle, v_settle_old, '')))
    / char_length(v_settle_old);
  IF v_settle IS NULL OR v_count <> 1 THEN
    RAISE EXCEPTION 'routine recovery settlement proof matched %, expected 1', COALESCE(v_count, 0)
      USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(v_settle, v_settle_old, v_settle_new);

  v_count := (char_length(v_authorize) - char_length(replace(v_authorize, v_identity_old, '')))
    / char_length(v_identity_old);
  IF v_authorize IS NULL OR v_count <> 1 THEN
    RAISE EXCEPTION 'full restart routine identity matched %, expected 1', COALESCE(v_count, 0)
      USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(v_authorize, v_identity_old, v_identity_new);
END
$companion_recovery_operation_proofs$;
--> statement-breakpoint

-- If the Box itself is durably absent there is no Pi invocation left to terminate. Allow the
-- recovery executor to persist that negative proof directly, while retaining the normal restart
-- checkpoint chain for every live Box.
DO $companion_absent_recovery_checkpoint$
DECLARE
  v_signature text :=
    'public.companion_runtime_checkpoint(uuid,uuid,uuid,bigint,bigint,text,'
    || 'public.companion_runtime_work_kind,uuid,bigint,text,text,uuid,text,bigint,'
    || 'timestamptz,integer,integer,integer)';
  v_definition text := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_signature));
  v_old text := $r$        (v_current_checkpoint = 'pending' AND p_next_checkpoint = 'pi_ready'
          AND public.companion_runtime_operation_lane(
            p_org_id, p_companion_id, p_work_id
          ) = 'routine')$r$;
  v_new text := $r$        (v_current_checkpoint = 'pending' AND p_next_checkpoint = 'pi_ready'
          AND (
            public.companion_runtime_operation_lane(
              p_org_id, p_companion_id, p_work_id
            ) = 'routine'
            OR (
              v_box_state IN ('absent', 'archived')
              AND EXISTS (
                SELECT 1
                FROM public.companion_operations recovery_operation
                WHERE recovery_operation.org_id = p_org_id
                  AND recovery_operation.companion_id = p_companion_id
                  AND recovery_operation.id = p_work_id
                  AND recovery_operation.trigger = 'recovery'
              )
            )
          ))$r$;
  v_count integer;
BEGIN
  v_count := (char_length(v_definition) - char_length(replace(v_definition, v_old, '')))
    / char_length(v_old);
  IF v_definition IS NULL OR v_count <> 1 THEN
    RAISE EXCEPTION 'absent recovery checkpoint matched %, expected 1', COALESCE(v_count, 0)
      USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(v_definition, v_old, v_new);
END
$companion_absent_recovery_checkpoint$;
--> statement-breakpoint

DO $companion_absent_recovery_proof$
DECLARE
  v_signature text :=
    'public.companion_runtime_checkpoint(uuid,uuid,uuid,bigint,bigint,text,'
    || 'public.companion_runtime_work_kind,uuid,bigint,text,text,uuid,text,bigint,'
    || 'timestamptz,integer,integer,integer)';
  v_definition text := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_signature));
  v_old text := $r$    IF p_next_checkpoint = 'pi_ready'
       AND (
         v_box_id IS NULL$r$;
  v_new text := $r$    IF p_next_checkpoint = 'pi_ready'
       AND NOT (
         v_box_state IN ('absent', 'archived')
         AND EXISTS (
           SELECT 1
           FROM public.companion_operations recovery_operation
           WHERE recovery_operation.org_id = p_org_id
             AND recovery_operation.companion_id = p_companion_id
             AND recovery_operation.id = p_work_id
             AND recovery_operation.trigger = 'recovery'
         )
       )
       AND (
         v_box_id IS NULL$r$;
  v_count integer;
BEGIN
  v_count := (char_length(v_definition) - char_length(replace(v_definition, v_old, '')))
    / char_length(v_old);
  IF v_definition IS NULL OR v_count <> 1 THEN
    RAISE EXCEPTION 'absent recovery terminal proof matched %, expected 1', COALESCE(v_count, 0)
      USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(v_definition, v_old, v_new);
END
$companion_absent_recovery_proof$;
--> statement-breakpoint

-- The guarded material preparation path must agree with the protocol-5 claimer: a resolved
-- historical interruption is diagnostic history and cannot reject a later queued turn.
DO $companion_resolved_material_guard$
DECLARE
  v_signature text := 'public.companion_runtime_prepare_queued_turn_material(bigint)';
  v_definition text := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_signature));
  v_multiline_old text := $r$            AND active_turn.status IN (
              'starting', 'dispatching', 'running', 'needs_input', 'interrupted'
            )$r$;
  v_multiline_new text := $r$            AND active_turn.status IN (
              'starting', 'dispatching', 'running', 'needs_input', 'interrupted'
            )
            AND (active_turn.status <> 'interrupted' OR active_turn.resolution IS NULL)$r$;
  v_single_old text := $r$        AND active_turn.status IN ('starting', 'dispatching', 'running', 'needs_input', 'interrupted')$r$;
  v_single_new text := $r$        AND active_turn.status IN ('starting', 'dispatching', 'running', 'needs_input', 'interrupted')
        AND (active_turn.status <> 'interrupted' OR active_turn.resolution IS NULL)$r$;
  v_count integer;
BEGIN
  v_count := (char_length(v_definition) - char_length(replace(v_definition, v_multiline_old, '')))
    / char_length(v_multiline_old);
  IF v_definition IS NULL OR v_count <> 1 THEN
    RAISE EXCEPTION 'material guard multiline interruption matched %, expected 1', COALESCE(v_count, 0)
      USING ERRCODE = '55000';
  END IF;
  v_definition := replace(v_definition, v_multiline_old, v_multiline_new);
  v_count := (char_length(v_definition) - char_length(replace(v_definition, v_single_old, '')))
    / char_length(v_single_old);
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'material guard single interruption matched %, expected 1', v_count
      USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(v_definition, v_single_old, v_single_new);
END
$companion_resolved_material_guard$;
--> statement-breakpoint

-- Aggregate-only runtime telemetry. The executor can emit these three numbers without receiving a
-- tenant id, Companion id, turn id, prompt, or provider diagnostic.
CREATE INDEX companion_operations_recovery_metrics_idx
  ON public.companion_operations(created_at)
  WHERE kind = 'restart_pi' AND trigger = 'recovery' AND status IN ('pending', 'running');
CREATE INDEX companion_turns_auto_abandoned_metrics_idx
  ON public.companion_turns(updated_at)
  WHERE resolution = 'auto_abandoned';
--> statement-breakpoint

CREATE FUNCTION public.companion_runtime_recovery_metrics()
RETURNS TABLE(
  pending_recovery_count bigint,
  oldest_recovery_age_seconds double precision,
  auto_abandoned_count bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
  SELECT
    (SELECT count(*)
      FROM public.companion_operations recovery
      WHERE recovery.kind = 'restart_pi'
        AND recovery.trigger = 'recovery'
        AND recovery.status IN ('pending', 'running')),
    (SELECT GREATEST(0, extract(epoch FROM clock_timestamp() - min(recovery.created_at)))
      FROM public.companion_operations recovery
      WHERE recovery.kind = 'restart_pi'
        AND recovery.trigger = 'recovery'
        AND recovery.status IN ('pending', 'running')),
    (SELECT count(*)
      FROM public.companion_turns turn_row
      WHERE turn_row.resolution = 'auto_abandoned')
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_runtime_recovery_metrics() FROM PUBLIC;
--> statement-breakpoint

-- Protocol 5 is the self-healing claim boundary. Older protocol-4 executors may finish an already
-- fenced claim, but cannot claim work whose interruption semantics they do not understand.
DO $companion_self_heal_claim_protocol$
DECLARE
  v_signature text :=
    'public.companion_runtime_claim_work(text,integer,integer,bigint,integer,integer)';
  v_definition text := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_signature));
  v_old text := 'IF p_material_protocol IS DISTINCT FROM 4 THEN RETURN; END IF;';
  v_new text := 'IF p_material_protocol IS DISTINCT FROM 5 THEN RETURN; END IF;';
  v_count integer;
BEGIN
  v_count := (char_length(v_definition) - char_length(replace(v_definition, v_old, '')))
    / char_length(v_old);
  IF v_definition IS NULL OR v_count <> 1 THEN
    RAISE EXCEPTION 'self-heal claim protocol matched %, expected 1', COALESCE(v_count, 0)
      USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(v_definition, v_old, v_new);
END
$companion_self_heal_claim_protocol$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_runtime_claim_work(
  text, integer, integer, bigint, integer, integer
) FROM PUBLIC;
