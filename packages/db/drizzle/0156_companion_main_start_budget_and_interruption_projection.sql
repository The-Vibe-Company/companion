-- A main turn may be queued while an isolated routine owns the routine lane. Shared Box lifecycle
-- and material staging intentionally wait for that routine, so do not start the main turn's
-- three-minute cold-start budget until the shared start operation can actually enter scheduling.
-- Locking the routine lease closes the check/insert race: after the Start row commits, routine
-- claims already yield to pending main operations.
DO $companion_main_start_budget$
DECLARE
  v_signature text := 'public.companion_runtime_prepare_queued_turn_material(bigint)';
  v_definition text := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_signature));
  v_old text := $r$  IF NOT FOUND THEN RETURN false; END IF;

  SELECT queued_turn.id, queued_turn.actor_id$r$;
  v_new text := $r$  IF NOT FOUND THEN RETURN false; END IF;

  PERFORM 1
  FROM public.companion_runtime_leases routine_lease
  WHERE routine_lease.org_id = v_org_id
    AND routine_lease.companion_id = v_companion_id
    AND routine_lease.lane = 'routine'
  FOR UPDATE SKIP LOCKED;
  IF NOT FOUND
     OR NOT public.companion_runtime_routine_lane_quiescent(v_org_id, v_companion_id) THEN
    RETURN false;
  END IF;

  SELECT queued_turn.id, queued_turn.actor_id$r$;
  v_count integer;
BEGIN
  v_count := (char_length(v_definition) - char_length(replace(v_definition, v_old, '')))
    / char_length(v_old);
  IF v_definition IS NULL OR v_count <> 1 THEN
    RAISE EXCEPTION 'main start budget guard matched %, expected 1', COALESCE(v_count, 0)
      USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(v_definition, v_old, v_new);
END
$companion_main_start_budget$;
--> statement-breakpoint

-- Unified first-party material contains expiring control and plugin capabilities on every client
-- surface. Make native enqueue and deferred preparation use the same two-hour reserve as the claim
-- guard; otherwise an expired native snapshot can be considered warm by one boundary and rejected
-- by the next with no Start work left to claim.
DO $companion_native_material_expiry$
DECLARE
  v_enqueue_signature text :=
    'public.companion_api_enqueue_turn(uuid,uuid,uuid,text,public.companion_client_surface,'
    || 'jsonb,uuid,text,uuid,text)';
  v_enqueue_definition text :=
    pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_enqueue_signature));
  v_enqueue_old text := $r$    AND (
      p_client_surface = 'native_mobile'
        AND v_instance.material_client_surface = 'native_mobile'
      OR p_client_surface IN ('web', 'mobile_web')
        AND v_instance.material_client_surface IN ('web', 'mobile_web')
        AND v_instance.material_expires_at > v_now + interval '2 hours 5 minutes'
    )$r$;
  v_enqueue_new text := $r$    AND (
      p_client_surface = 'native_mobile'
        AND v_instance.material_client_surface = 'native_mobile'
      OR p_client_surface IN ('web', 'mobile_web')
        AND v_instance.material_client_surface IN ('web', 'mobile_web')
    )
    AND v_instance.material_expires_at > v_now + interval '2 hours 5 minutes'$r$;
  v_prepare_signature text := 'public.companion_runtime_prepare_queued_turn_material(bigint)';
  v_prepare_definition text :=
    pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_prepare_signature));
  v_prepare_old text[] := ARRAY[
$r$          AND (
            queued_turn.client_surface = 'native_mobile'
              AND instance.material_client_surface = 'native_mobile'
            OR queued_turn.client_surface IN ('web', 'mobile_web')
              AND instance.material_client_surface IN ('web', 'mobile_web')
              AND instance.material_expires_at > v_now + interval '2 hours 5 minutes'
          )$r$,
$r$      AND (
        queued_turn.client_surface = 'native_mobile'
          AND instance.material_client_surface = 'native_mobile'
        OR queued_turn.client_surface IN ('web', 'mobile_web')
          AND instance.material_client_surface IN ('web', 'mobile_web')
          AND instance.material_expires_at > v_now + interval '2 hours 5 minutes'
      )$r$
  ];
  v_prepare_new text[] := ARRAY[
$r$          AND (
            queued_turn.client_surface = 'native_mobile'
              AND instance.material_client_surface = 'native_mobile'
            OR queued_turn.client_surface IN ('web', 'mobile_web')
              AND instance.material_client_surface IN ('web', 'mobile_web')
          )
          AND instance.material_expires_at > v_now + interval '2 hours 5 minutes'$r$,
$r$      AND (
        queued_turn.client_surface = 'native_mobile'
          AND instance.material_client_surface = 'native_mobile'
        OR queued_turn.client_surface IN ('web', 'mobile_web')
          AND instance.material_client_surface IN ('web', 'mobile_web')
      )
      AND instance.material_expires_at > v_now + interval '2 hours 5 minutes'$r$
  ];
  v_count integer;
  v_index integer;
BEGIN
  v_count := (char_length(v_enqueue_definition)
    - char_length(replace(v_enqueue_definition, v_enqueue_old, '')))
    / char_length(v_enqueue_old);
  IF v_enqueue_definition IS NULL OR v_count <> 1 THEN
    RAISE EXCEPTION 'native enqueue expiry guard matched %, expected 1', COALESCE(v_count, 0)
      USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(v_enqueue_definition, v_enqueue_old, v_enqueue_new);

  IF v_prepare_definition IS NULL THEN
    RAISE EXCEPTION 'queued material preparation is missing' USING ERRCODE = '55000';
  END IF;
  FOR v_index IN 1..cardinality(v_prepare_old) LOOP
    v_count := (char_length(v_prepare_definition)
      - char_length(replace(v_prepare_definition, v_prepare_old[v_index], '')))
      / char_length(v_prepare_old[v_index]);
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'native preparation expiry guard % matched %, expected 1', v_index, v_count
        USING ERRCODE = '55000';
    END IF;
    v_prepare_definition := replace(
      v_prepare_definition, v_prepare_old[v_index], v_prepare_new[v_index]
    );
  END LOOP;
  EXECUTE v_prepare_definition;
END
$companion_native_material_expiry$;
--> statement-breakpoint

-- The material wrapper and the lane-aware claimer are separate functions. If preparation defers
-- for an active routine, the claimer must not fall through and manufacture a main attempt against
-- stale material. Warm main turns still run concurrently with routines; only turns lacking the
-- exact current staged snapshot wait for shared lifecycle work.
CREATE FUNCTION public.companion_runtime_main_turn_material_ready(
  p_org_id uuid,
  p_companion_id uuid,
  p_turn_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
  SELECT COALESCE((
    SELECT instance.box_state IN ('ready', 'idle', 'running')
      AND instance.pi_state = 'idle'
      AND instance.last_observed_at >= statement_timestamp() - interval '2 minutes'
      AND instance.material_pi_invocation_id = instance.pi_invocation_id
      AND (
        queued_turn.client_surface = 'native_mobile'
          AND instance.material_client_surface = 'native_mobile'
        OR queued_turn.client_surface IN ('web', 'mobile_web')
          AND instance.material_client_surface IN ('web', 'mobile_web')
      )
      AND instance.material_expires_at > statement_timestamp() + interval '2 hours 5 minutes'
      AND instance.desired_settings_revision = instance.applied_settings_revision
      AND instance.applied_skills_revision >= companion.skills_revision
    FROM public.companion_turns queued_turn
    JOIN public.companion_runtime_instances instance
      ON instance.org_id = queued_turn.org_id
     AND instance.companion_id = queued_turn.companion_id
    JOIN public.companions companion
      ON companion.org_id = queued_turn.org_id
     AND companion.id = queued_turn.companion_id
    WHERE queued_turn.org_id = p_org_id
      AND queued_turn.companion_id = p_companion_id
      AND queued_turn.id = p_turn_id
      AND queued_turn.routine_snapshot_id IS NULL
      AND queued_turn.status = 'queued'
  ), false)
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_runtime_main_turn_material_ready(uuid, uuid, uuid)
  FROM PUBLIC;
--> statement-breakpoint

DO $companion_main_attempt_material_guard$
DECLARE
  v_signature text :=
    'public.companion_runtime_claim_work_without_material_guard(text,integer,integer,bigint)';
  v_definition text := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_signature));
  v_old text := $r$        AND public.companion_runtime_turn_lane(t.org_id, t.companion_id, t.id) = v_lane
        AND (
          v_lane = 'main'
          OR NOT EXISTS ($r$;
  v_new text := $r$        AND public.companion_runtime_turn_lane(t.org_id, t.companion_id, t.id) = v_lane
        AND (
          v_lane = 'routine'
          OR public.companion_runtime_main_turn_material_ready(t.org_id, t.companion_id, t.id)
        )
        AND (
          v_lane = 'main'
          OR NOT EXISTS ($r$;
  v_count integer;
BEGIN
  v_count := (char_length(v_definition) - char_length(replace(v_definition, v_old, '')))
    / char_length(v_old);
  IF v_definition IS NULL OR v_count <> 1 THEN
    RAISE EXCEPTION 'main attempt material guard matched %, expected 1', COALESCE(v_count, 0)
      USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(v_definition, v_old, v_new);
END
$companion_main_attempt_material_guard$;
--> statement-breakpoint

-- Protocol 6 interruptions are terminal auto-abandoned evidence, not actionable lane state. Keep
-- the durable turn and notification, but stop projecting a settled interruption as a permanent
-- thread-tail card. The unresolved filter also preserves compatibility with an older in-flight
-- protocol during a rolling deployment.
DO $companion_hide_settled_interruptions$
DECLARE
  v_signature text;
  v_definition text;
  v_order text := 'ORDER BY interrupted.queue_sequence DESC, interrupted.id DESC LIMIT 1';
  v_filtered_order text := $r$AND interrupted.resolution IS NULL
      ORDER BY interrupted.queue_sequence DESC, interrupted.id DESC LIMIT 1$r$;
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
    v_count := (char_length(v_definition) - char_length(replace(v_definition, v_order, '')))
      / char_length(v_order);
    IF v_definition IS NULL OR v_count <> 1 THEN
      RAISE EXCEPTION 'settled interruption filter % matched %, expected 1',
        v_signature, COALESCE(v_count, 0) USING ERRCODE = '55000';
    END IF;
    EXECUTE replace(v_definition, v_order, v_filtered_order);
  END LOOP;
END
$companion_hide_settled_interruptions$;
--> statement-breakpoint
