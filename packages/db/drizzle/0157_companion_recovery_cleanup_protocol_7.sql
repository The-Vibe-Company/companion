-- Protocol 7 restores interrupted-turn cleanup as a narrow, lane-scoped operation after the
-- protocol-6 terminal-release deployment. A failed cleanup
-- cycle receives a fresh execution budget, while queued messages remain durable until the Start
-- that they actually require is claimed.

ALTER TABLE public.companion_operations
  ADD COLUMN execution_lane text,
  ADD COLUMN legacy_recovery_snapshot boolean NOT NULL DEFAULT false;
--> statement-breakpoint

UPDATE public.companion_operations operation_row
SET execution_lane = CASE
  WHEN operation_row.kind = 'restart_pi'
    AND EXISTS (
      SELECT 1
      FROM public.companion_turns source_turn
      WHERE source_turn.org_id = operation_row.org_id
        AND source_turn.companion_id = operation_row.companion_id
        AND source_turn.id = operation_row.source_turn_id
        AND source_turn.routine_snapshot_id IS NOT NULL
    ) THEN 'routine'
  ELSE 'main'
END;
--> statement-breakpoint

ALTER TABLE public.companion_operations
  ALTER COLUMN execution_lane SET DEFAULT 'main',
  ALTER COLUMN execution_lane SET NOT NULL,
  ADD CONSTRAINT companion_operations_execution_lane_check
    CHECK (execution_lane IN ('main', 'routine'));

DROP INDEX public.companion_operations_one_running_uq;
CREATE UNIQUE INDEX companion_operations_one_running_uq
  ON public.companion_operations(companion_id, execution_lane)
  WHERE status = 'running';
CREATE UNIQUE INDEX companion_operations_one_recovery_per_turn_uq
  ON public.companion_operations(companion_id, source_turn_id)
  WHERE kind = 'restart_pi' AND trigger = 'recovery';
--> statement-breakpoint

-- Protocol 6 made every interruption resolved at the table boundary. Protocol 7 keeps the safe
-- `last_error_action = none` normalization, but lets the exact cleanup operation own resolution.
-- The existing three triggers remain attached to this replaced function during rolling deploy.
CREATE OR REPLACE FUNCTION public.companion_runtime_normalize_terminal_interruption()
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

-- A protocol-5 or protocol-6 executor that already owns a live recovery lease must be able to
-- renew, checkpoint,
-- and settle with the resource-bearing snapshot it decoded before this migration. This marker is
-- set only for that finite rolling-deploy cohort; every protocol-7 recovery is born false.
UPDATE public.companion_operations recovery
SET status = 'running',
    settled_at = NULL,
    last_error_code = NULL,
    last_error_message = NULL,
    last_error_action = NULL,
    legacy_recovery_snapshot = true,
    updated_at = statement_timestamp()
WHERE recovery.kind = 'restart_pi'
  AND recovery.trigger = 'recovery'
  AND recovery.status IN ('running', 'cancelled')
  AND recovery.claim_epoch IS NOT NULL
  AND recovery.client_surface IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM public.companion_runtime_leases live_lease
    WHERE live_lease.org_id = recovery.org_id
      AND live_lease.companion_id = recovery.companion_id
      AND live_lease.work_kind = 'operation'
      AND live_lease.work_id = recovery.id
      AND live_lease.claim_epoch = recovery.claim_epoch
      AND live_lease.claim_token IS NOT NULL
      AND live_lease.expires_at > statement_timestamp()
  );
--> statement-breakpoint

ALTER TABLE public.companion_operations
  ADD CONSTRAINT companion_operations_legacy_recovery_snapshot_check CHECK (
    NOT legacy_recovery_snapshot OR (
      kind = 'restart_pi' AND trigger = 'recovery'
      AND status = 'running' AND claim_epoch IS NOT NULL
    )
  );
--> statement-breakpoint

-- The legacy recovery rows are normalized below without disabling their immutability trigger.
-- Ordinary operation authority stays immutable, including the new lane. A recovery may only
-- change generation/lane while being rearmed for its still-unresolved exact source turn, against
-- the current instance generation, and only after any previous lease is no longer live.
CREATE OR REPLACE FUNCTION public.companion_runtime_reject_operation_snapshot_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_expected_lane text;
  v_current_generation bigint;
  v_source_unresolved boolean := false;
BEGIN
  IF OLD.kind = 'restart_pi' AND OLD.trigger = 'recovery'
     AND NEW.kind = 'restart_pi' AND NEW.trigger = 'recovery' THEN
    -- The finite protocol-5 cohort keeps its immutable resource selection while the exact old
    -- lease is running. Its material timestamps may advance because the old executor can still be
    -- between staging and publication when this migration commits.
    IF OLD.legacy_recovery_snapshot AND NEW.legacy_recovery_snapshot THEN
      IF NEW.status <> 'running'
         OR NEW.claim_epoch IS NULL
         OR OLD.runtime_generation IS DISTINCT FROM NEW.runtime_generation
         OR OLD.execution_lane IS DISTINCT FROM NEW.execution_lane
         OR OLD.target_settings_revision IS DISTINCT FROM NEW.target_settings_revision
         OR OLD.target_skills_revision IS DISTINCT FROM NEW.target_skills_revision
         OR OLD.client_surface IS DISTINCT FROM NEW.client_surface
         OR OLD.model_id IS DISTINCT FROM NEW.model_id
         OR OLD.persona IS DISTINCT FROM NEW.persona
         OR OLD.can_write_skills IS DISTINCT FROM NEW.can_write_skills
         OR OLD.provider_ids IS DISTINCT FROM NEW.provider_ids
         OR OLD.selected_skill_ids IS DISTINCT FROM NEW.selected_skill_ids
         OR OLD.skill_refs IS DISTINCT FROM NEW.skill_refs
         OR OLD.skill_update_selected_skill_ids IS DISTINCT FROM NEW.skill_update_selected_skill_ids
         OR OLD.skill_update_refs IS DISTINCT FROM NEW.skill_update_refs
         OR OLD.selected_mcp_account_ids IS DISTINCT FROM NEW.selected_mcp_account_ids THEN
        RAISE EXCEPTION 'legacy recovery operation snapshot is immutable'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END IF;

    IF NOT OLD.legacy_recovery_snapshot AND NEW.legacy_recovery_snapshot THEN
      RAISE EXCEPTION 'legacy recovery snapshot marker cannot be enabled after cutover'
        USING ERRCODE = '23514';
    END IF;

    -- Recovery is cleanup authority, never historical message execution authority. This also
    -- permits the one-way live-v5 snapshot normalization performed at settlement/release/takeover.
    IF NEW.legacy_recovery_snapshot
       OR NEW.target_settings_revision IS NOT NULL
       OR NEW.target_skills_revision IS NOT NULL
       OR NEW.client_surface IS NOT NULL
       OR NEW.model_id IS NOT NULL
       OR NEW.persona IS NOT NULL
       OR NEW.can_write_skills IS NOT NULL
       OR NEW.provider_ids IS NOT NULL
       OR NEW.selected_skill_ids IS NOT NULL
       OR NEW.skill_refs IS NOT NULL
       OR NEW.skill_update_selected_skill_ids IS NOT NULL
       OR NEW.skill_update_refs IS NOT NULL
       OR NEW.selected_mcp_account_ids IS NOT NULL
       OR NEW.material_staged_at IS NOT NULL
       OR NEW.material_expires_at IS NOT NULL THEN
      RAISE EXCEPTION 'recovery operation cannot carry a resource snapshot'
        USING ERRCODE = '23514';
    END IF;

    IF OLD.legacy_recovery_snapshot
       AND NEW.status = 'running'
       AND EXISTS (
         SELECT 1
         FROM public.companion_runtime_leases live_lease
         WHERE live_lease.org_id = NEW.org_id
           AND live_lease.companion_id = NEW.companion_id
           AND live_lease.work_kind = 'operation'
           AND live_lease.work_id = NEW.id
           AND live_lease.claim_epoch = OLD.claim_epoch
           AND live_lease.claim_token IS NOT NULL
           AND live_lease.expires_at > statement_timestamp()
       ) THEN
      RAISE EXCEPTION 'live protocol-5 recovery snapshot cannot be normalized'
        USING ERRCODE = '23514';
    END IF;

    IF OLD.runtime_generation IS DISTINCT FROM NEW.runtime_generation
       OR OLD.execution_lane IS DISTINCT FROM NEW.execution_lane THEN
      SELECT CASE WHEN source_turn.routine_snapshot_id IS NULL THEN 'main' ELSE 'routine' END,
             instance.generation,
             source_turn.status = 'interrupted' AND source_turn.resolution IS NULL
      INTO v_expected_lane, v_current_generation, v_source_unresolved
      FROM public.companion_turns source_turn
      JOIN public.companion_runtime_instances instance
        ON instance.org_id = source_turn.org_id
       AND instance.companion_id = source_turn.companion_id
      WHERE source_turn.org_id = NEW.org_id
        AND source_turn.companion_id = NEW.companion_id
        AND source_turn.id = NEW.source_turn_id;

      IF NOT (
        COALESCE(v_source_unresolved, false)
        AND OLD.status IN ('pending', 'running', 'failed', 'interrupted', 'cancelled')
        AND NEW.status = 'pending'
        AND NEW.runtime_generation = v_current_generation
        AND NEW.execution_lane = v_expected_lane
        AND NOT EXISTS (
          SELECT 1
          FROM public.companion_runtime_leases live_lease
          WHERE live_lease.org_id = NEW.org_id
            AND live_lease.companion_id = NEW.companion_id
            AND live_lease.work_kind = 'operation'
            AND live_lease.work_id = NEW.id
            AND live_lease.claim_token IS NOT NULL
            AND live_lease.expires_at > statement_timestamp()
        )
      ) THEN
        RAISE EXCEPTION 'recovery operation generation and lane are immutable outside rearm'
          USING ERRCODE = '23514';
      END IF;
    END IF;

    RETURN NEW;
  END IF;

  IF OLD.runtime_generation IS DISTINCT FROM NEW.runtime_generation
     OR OLD.execution_lane IS DISTINCT FROM NEW.execution_lane
     OR OLD.legacy_recovery_snapshot IS DISTINCT FROM NEW.legacy_recovery_snapshot
     OR OLD.target_settings_revision IS DISTINCT FROM NEW.target_settings_revision
     OR OLD.target_skills_revision IS DISTINCT FROM NEW.target_skills_revision
     OR OLD.client_surface IS DISTINCT FROM NEW.client_surface
     OR OLD.model_id IS DISTINCT FROM NEW.model_id
     OR OLD.persona IS DISTINCT FROM NEW.persona
     OR OLD.can_write_skills IS DISTINCT FROM NEW.can_write_skills
     OR OLD.provider_ids IS DISTINCT FROM NEW.provider_ids
     OR OLD.selected_skill_ids IS DISTINCT FROM NEW.selected_skill_ids
     OR OLD.skill_refs IS DISTINCT FROM NEW.skill_refs
     OR OLD.skill_update_selected_skill_ids IS DISTINCT FROM NEW.skill_update_selected_skill_ids
     OR OLD.skill_update_refs IS DISTINCT FROM NEW.skill_update_refs
     OR OLD.selected_mcp_account_ids IS DISTINCT FROM NEW.selected_mcp_account_ids THEN
    RAISE EXCEPTION 'operation resource snapshot is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

DROP TRIGGER companion_operations_snapshot_immutable ON public.companion_operations;
CREATE TRIGGER companion_operations_snapshot_immutable
  BEFORE UPDATE OF runtime_generation, execution_lane, legacy_recovery_snapshot,
    target_settings_revision,
    target_skills_revision, client_surface, model_id, persona, can_write_skills, provider_ids,
    selected_skill_ids, skill_refs, skill_update_selected_skill_ids, skill_update_refs,
    selected_mcp_account_ids, material_staged_at, material_expires_at
  ON public.companion_operations
  FOR EACH ROW EXECUTE FUNCTION public.companion_runtime_reject_operation_snapshot_change();
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_runtime_reject_operation_snapshot_change() FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_runtime_normalize_legacy_recovery_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
BEGIN
  IF OLD.kind = 'restart_pi' AND OLD.trigger = 'recovery'
     AND OLD.legacy_recovery_snapshot
     AND NEW.status <> 'running' THEN
    IF OLD.checkpoint = 'pi_ready' THEN
      NEW.checkpoint := 'cleanup_complete';
    END IF;
    NEW.legacy_recovery_snapshot := false;
    NEW.client_surface := NULL;
    NEW.target_settings_revision := NULL;
    NEW.target_skills_revision := NULL;
    NEW.model_id := NULL;
    NEW.persona := NULL;
    NEW.can_write_skills := NULL;
    NEW.provider_ids := NULL;
    NEW.selected_skill_ids := NULL;
    NEW.skill_refs := NULL;
    NEW.skill_update_selected_skill_ids := NULL;
    NEW.skill_update_refs := NULL;
    NEW.selected_mcp_account_ids := NULL;
    NEW.material_staged_at := NULL;
    NEW.material_expires_at := NULL;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_runtime_normalize_legacy_recovery_snapshot() FROM PUBLIC;
--> statement-breakpoint

CREATE TRIGGER companion_operations_legacy_recovery_snapshot_normalize
  BEFORE UPDATE OF status ON public.companion_operations
  FOR EACH ROW EXECUTE FUNCTION public.companion_runtime_normalize_legacy_recovery_snapshot();
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
  SELECT operation.execution_lane
  FROM public.companion_operations operation
  WHERE operation.org_id = p_org_id
    AND operation.companion_id = p_companion_id
    AND operation.id = p_operation_id
$$;
--> statement-breakpoint

ALTER TABLE public.companion_operations
  DROP CONSTRAINT companion_operations_checkpoint_check,
  DROP CONSTRAINT companion_operations_target_revision_check,
  DROP CONSTRAINT companion_operations_resource_snapshot_check,
  DROP CONSTRAINT companion_operations_terminal_proof_check;
--> statement-breakpoint

UPDATE public.companion_operations recovery
SET client_surface = NULL,
    target_settings_revision = NULL,
    target_skills_revision = NULL,
    model_id = NULL,
    persona = NULL,
    can_write_skills = NULL,
    provider_ids = NULL,
    selected_skill_ids = NULL,
    skill_refs = NULL,
    skill_update_selected_skill_ids = NULL,
    skill_update_refs = NULL,
    selected_mcp_account_ids = NULL,
    material_staged_at = NULL,
    material_expires_at = NULL,
    updated_at = statement_timestamp()
WHERE recovery.kind = 'restart_pi'
  AND recovery.trigger = 'recovery'
  AND NOT recovery.legacy_recovery_snapshot;
--> statement-breakpoint

-- `pi_ready` is accepted only from an executor that already held a protocol-5 lease at cutover.
-- Historical rows without such a live lease are normalized to the protocol-7 terminal proof.
UPDATE public.companion_operations recovery
SET checkpoint = 'cleanup_complete', updated_at = statement_timestamp()
WHERE recovery.kind = 'restart_pi'
  AND recovery.trigger = 'recovery'
  AND recovery.checkpoint = 'pi_ready'
  AND NOT recovery.legacy_recovery_snapshot;
--> statement-breakpoint

ALTER TABLE public.companion_operations
  ADD CONSTRAINT companion_operations_checkpoint_check CHECK (
    checkpoint IN (
      'pending','resolving_box','box_resolved','box_absence_observed','creating_box',
      'box_created','waiting_ready','box_ready_observed','installing_layout','starting_pi',
      'pi_observed','pi_ready','cleanup_complete','stopping_pi','skills_updated',
      'provider_stop_requested','waiting_archived','box_archived','restarting_pi',
      'restarting_box','applying_settings','settings_applied','provider_delete_requested',
      'waiting_deleted','provider_deleted','box_absent','completed'
    ) AND checkpoint_sequence >= 0 AND attempt_count >= 0
  ),
  ADD CONSTRAINT companion_operations_recovery_legacy_checkpoint_check CHECK (
    kind <> 'restart_pi' OR trigger <> 'recovery'
    OR checkpoint <> 'pi_ready' OR legacy_recovery_snapshot
  ),
  ADD CONSTRAINT companion_operations_target_revision_check CHECK (
    (target_settings_revision IS NULL OR target_settings_revision >= 1)
    AND (target_skills_revision IS NULL OR target_skills_revision >= 1)
    AND (
      (kind = 'restart_pi' AND trigger = 'recovery'
        AND (
          (NOT legacy_recovery_snapshot
            AND target_settings_revision IS NULL AND target_skills_revision IS NULL)
          OR (legacy_recovery_snapshot
            AND target_settings_revision IS NOT NULL AND target_skills_revision IS NOT NULL)
        ))
      OR (kind IN ('start','restart_pi','restart_box','apply_settings')
        AND trigger <> 'recovery'
        AND target_settings_revision IS NOT NULL AND target_skills_revision IS NOT NULL)
      OR (kind = 'stop' AND target_settings_revision IS NULL
        AND target_skills_revision IS NOT NULL)
      OR (kind = 'delete' AND target_settings_revision IS NULL
        AND target_skills_revision IS NULL)
    )
  ),
  ADD CONSTRAINT companion_operations_resource_snapshot_check CHECK (
    (
      kind = 'restart_pi' AND trigger = 'recovery'
      AND NOT legacy_recovery_snapshot
      AND client_surface IS NULL AND model_id IS NULL AND persona IS NULL
      AND can_write_skills IS NULL AND provider_ids IS NULL
      AND selected_skill_ids IS NULL AND skill_refs IS NULL
      AND skill_update_selected_skill_ids IS NULL AND skill_update_refs IS NULL
      AND selected_mcp_account_ids IS NULL
      AND material_staged_at IS NULL AND material_expires_at IS NULL
    ) OR (
      kind = 'restart_pi' AND trigger = 'recovery'
      AND legacy_recovery_snapshot AND client_surface IS NOT NULL
      AND (model_id IS NULL OR (char_length(model_id) BETWEEN 1 AND 200 AND model_id !~ E'[\n\r]'))
      AND (persona IS NULL OR char_length(persona) <= 280)
      AND can_write_skills IS NOT NULL AND jsonb_typeof(provider_ids) = 'array'
      AND jsonb_typeof(selected_skill_ids) = 'array' AND jsonb_typeof(skill_refs) = 'array'
      AND jsonb_typeof(skill_update_selected_skill_ids) = 'array'
      AND jsonb_typeof(skill_update_refs) = 'array'
      AND jsonb_typeof(selected_mcp_account_ids) = 'array'
    ) OR (
      kind = 'start' AND client_surface IS NOT NULL
      AND (model_id IS NULL OR (char_length(model_id) BETWEEN 1 AND 200 AND model_id !~ E'[\n\r]'))
      AND (persona IS NULL OR char_length(persona) <= 280)
      AND can_write_skills IS NOT NULL AND jsonb_typeof(provider_ids) = 'array'
      AND jsonb_typeof(selected_skill_ids) = 'array' AND jsonb_typeof(skill_refs) = 'array'
      AND skill_update_selected_skill_ids IS NULL AND skill_update_refs IS NULL
      AND jsonb_typeof(selected_mcp_account_ids) = 'array'
    ) OR (
      kind IN ('restart_pi','restart_box','apply_settings') AND trigger <> 'recovery'
      AND client_surface IS NOT NULL
      AND (model_id IS NULL OR (char_length(model_id) BETWEEN 1 AND 200 AND model_id !~ E'[\n\r]'))
      AND (persona IS NULL OR char_length(persona) <= 280)
      AND can_write_skills IS NOT NULL AND jsonb_typeof(provider_ids) = 'array'
      AND jsonb_typeof(selected_skill_ids) = 'array' AND jsonb_typeof(skill_refs) = 'array'
      AND jsonb_typeof(skill_update_selected_skill_ids) = 'array'
      AND jsonb_typeof(skill_update_refs) = 'array'
      AND jsonb_typeof(selected_mcp_account_ids) = 'array'
    ) OR (
      kind = 'stop' AND client_surface IS NULL AND model_id IS NULL AND persona IS NULL
      AND can_write_skills IS NULL AND provider_ids IS NULL AND selected_skill_ids IS NULL
      AND skill_refs IS NULL AND jsonb_typeof(skill_update_selected_skill_ids) = 'array'
      AND jsonb_typeof(skill_update_refs) = 'array' AND selected_mcp_account_ids IS NULL
    ) OR (
      kind = 'delete' AND client_surface IS NULL AND model_id IS NULL AND persona IS NULL
      AND can_write_skills IS NULL AND provider_ids IS NULL AND selected_skill_ids IS NULL
      AND skill_refs IS NULL AND skill_update_selected_skill_ids IS NULL
      AND skill_update_refs IS NULL AND selected_mcp_account_ids IS NULL
    )
  ),
  ADD CONSTRAINT companion_operations_terminal_proof_check CHECK (
    status <> 'succeeded' OR (
      (kind = 'restart_pi' AND trigger = 'recovery'
        AND checkpoint = 'cleanup_complete')
      OR (kind IN ('start','restart_pi','restart_box') AND trigger <> 'recovery'
        AND checkpoint = 'pi_ready')
      OR (kind = 'stop' AND checkpoint = 'box_archived')
      OR (kind = 'apply_settings' AND checkpoint = 'settings_applied')
      OR (kind = 'delete' AND checkpoint IN ('provider_deleted','box_absent'))
    )
  );
--> statement-breakpoint

-- Recovery inserts contain no model, provider, Skill, MCP, or actor authorization snapshot. The
-- operation retains only its tenant, generation, lane, source occurrence, and stable audit actor.
DO $companion_cleanup_operation_intent$
DECLARE
  v_signature text := 'public.companion_runtime_assign_operation_intent()';
  v_definition text := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_signature));
  v_anchor text := $r$  IF NEW.kind IN ('start', 'restart_pi', 'restart_box', 'apply_settings', 'stop') THEN$r$;
  v_replacement text := $r$  NEW.execution_lane := CASE
    WHEN NEW.kind = 'restart_pi' AND EXISTS (
      SELECT 1 FROM public.companion_turns source_turn
      WHERE source_turn.org_id = NEW.org_id
        AND source_turn.companion_id = NEW.companion_id
        AND source_turn.id = NEW.source_turn_id
        AND source_turn.routine_snapshot_id IS NOT NULL
    ) THEN 'routine'
    ELSE 'main'
  END;

  IF NEW.kind = 'restart_pi' AND NEW.trigger = 'recovery' THEN
    NEW.legacy_recovery_snapshot := false;
    NEW.client_surface := NULL;
    NEW.target_settings_revision := NULL;
    NEW.target_skills_revision := NULL;
    NEW.model_id := NULL;
    NEW.persona := NULL;
    NEW.can_write_skills := NULL;
    NEW.provider_ids := NULL;
    NEW.selected_skill_ids := NULL;
    NEW.skill_refs := NULL;
    NEW.skill_update_selected_skill_ids := NULL;
    NEW.skill_update_refs := NULL;
    NEW.selected_mcp_account_ids := NULL;
    RETURN NEW;
  END IF;

  IF NEW.kind IN ('start', 'restart_pi', 'restart_box', 'apply_settings', 'stop') THEN$r$;
  v_count integer;
BEGIN
  v_count := (char_length(v_definition) - char_length(replace(v_definition, v_anchor, '')))
    / char_length(v_anchor);
  IF v_definition IS NULL OR v_count <> 1 THEN
    RAISE EXCEPTION 'cleanup operation intent anchor matched %, expected 1', COALESCE(v_count, 0)
      USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(v_definition, v_anchor, v_replacement);
END
$companion_cleanup_operation_intent$;
--> statement-breakpoint

-- Creating a Start validates its source but does not start the three-minute clock. That budget is
-- for actual external startup work and begins only after the runtime owns the Start lease.
DO $companion_start_deadline_assignment$
DECLARE
  v_signature text := 'public.companion_runtime_assign_operation_intent()';
  v_definition text := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_signature));
  v_old text := $r$    UPDATE public.companion_turns t
    SET cold_start_deadline_at = CASE
          WHEN t.status = 'interrupted' THEN statement_timestamp() + interval '3 minutes'
          ELSE COALESCE(t.cold_start_deadline_at, t.created_at + interval '3 minutes')
        END,
        updated_at = statement_timestamp()
    WHERE t.org_id = NEW.org_id AND t.companion_id = NEW.companion_id
      AND t.id = NEW.source_turn_id
      AND (
        t.status = 'queued'
        OR (
          t.status = 'interrupted'
          AND NEW.trigger = 'user'
          AND NEW.request_id IS NOT NULL
        )
      );$r$;
  v_new text := $r$    PERFORM 1
    FROM public.companion_turns t
    WHERE t.org_id = NEW.org_id AND t.companion_id = NEW.companion_id
      AND t.id = NEW.source_turn_id
      AND (
        t.status = 'queued'
        OR (
          t.status = 'interrupted'
          AND NEW.trigger = 'user'
          AND NEW.request_id IS NOT NULL
        )
      );$r$;
  v_count integer;
BEGIN
  v_count := (char_length(v_definition) - char_length(replace(v_definition, v_old, '')))
    / char_length(v_old);
  IF v_definition IS NULL OR v_count <> 1 THEN
    RAISE EXCEPTION 'Start deadline assignment matched %, expected 1', COALESCE(v_count, 0)
      USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(v_definition, v_old, v_new);
END
$companion_start_deadline_assignment$;
--> statement-breakpoint

DO $companion_prepare_start_deadline$
DECLARE
  v_signature text := 'public.companion_runtime_prepare_queued_turn_material(bigint)';
  v_definition text := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_signature));
  v_old text := $r$  UPDATE public.companion_turns
  SET cold_start_deadline_at = v_now + interval '3 minutes', updated_at = v_now
  WHERE org_id = v_org_id AND companion_id = v_companion_id AND id = v_turn_id;

$r$;
  v_count integer;
BEGIN
  v_count := (char_length(v_definition) - char_length(replace(v_definition, v_old, '')))
    / char_length(v_old);
  IF v_definition IS NULL OR v_count <> 1 THEN
    RAISE EXCEPTION 'queued Start deadline matched %, expected 1', COALESCE(v_count, 0)
      USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(v_definition, v_old, '');
END
$companion_prepare_start_deadline$;
--> statement-breakpoint

-- Protocol 6 made interruption immediately terminal by removing it from routine lane ownership.
-- Protocol 7 restores only the narrow cleanup fence: a routine occurrence owns its lane until the
-- exact cleanup proof resolves it, while an independently warm main attempt remains claimable.
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

-- Patch the durable claimer at its behavioral seams. Keeping the established return row stable
-- lets protocol-5/6 executors drain while protocol 7 changes only eligibility and claim timing.
DO $companion_protocol_7_claimer$
DECLARE
  v_signature text :=
    'public.companion_runtime_claim_work_without_material_guard(text,integer,integer,bigint)';
  v_definition text := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_signature));
  v_old text;
  v_new text;
  v_count integer;
BEGIN
  -- A routine recovery never serializes an exact main recovery behind it.
  v_old := $r$        AND (
          v_lane = 'routine'
          OR (o.kind = 'restart_box' AND o.trigger = 'user')
          OR public.companion_runtime_routine_lane_quiescent(v_org_id, v_companion_id)
        )
        AND o.kind IN ('stop', 'restart_pi', 'restart_box')$r$;
  v_new := $r$        AND (
          v_lane = 'routine'
          OR (o.kind = 'restart_box' AND o.trigger = 'user')
          OR (o.kind = 'restart_pi' AND o.trigger = 'recovery')
          OR public.companion_runtime_routine_lane_quiescent(v_org_id, v_companion_id)
        )
        AND o.kind IN ('stop', 'restart_pi', 'restart_box')$r$;
  v_count := (char_length(v_definition) - char_length(replace(v_definition, v_old, '')))
    / char_length(v_old);
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'recovery lane selection matched %, expected 1', v_count USING ERRCODE = '55000';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);

  -- The optimistic candidate pass must still visit a main lease while only a routine interruption
  -- is unresolved and its cleanup is waiting for backoff. The inner selector still requires a
  -- genuinely warm attempt; shared Start/restage lifecycle remains behind routine quiescence.
  v_old := $r$        OR (i.health_due_at <= v_now AND i.retirement_state <> 'retired')$r$;
  v_new := $r$        OR (
          l.lane = 'main'
          AND EXISTS (
            SELECT 1 FROM public.companion_turns main_queued_turn
            WHERE main_queued_turn.org_id = i.org_id
              AND main_queued_turn.companion_id = i.companion_id
              AND main_queued_turn.status = 'queued'
              AND public.companion_runtime_turn_lane(
                main_queued_turn.org_id, main_queued_turn.companion_id, main_queued_turn.id
              ) = 'main'
          )
          AND NOT EXISTS (
            SELECT 1 FROM public.companion_turns active_main_turn
            WHERE active_main_turn.org_id = i.org_id
              AND active_main_turn.companion_id = i.companion_id
              AND public.companion_runtime_turn_lane(
                active_main_turn.org_id, active_main_turn.companion_id, active_main_turn.id
              ) = 'main'
              AND active_main_turn.status IN (
                'starting','dispatching','running','needs_input','interrupted'
              )
              AND (
                active_main_turn.status <> 'interrupted'
                OR active_main_turn.resolution IS NULL
              )
          )
        )
        OR (i.health_due_at <= v_now AND i.retirement_state <> 'retired')$r$;
  v_count := (char_length(v_definition) - char_length(replace(v_definition, v_old, '')))
    / char_length(v_old);
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'main queued outer eligibility matched %, expected 1', v_count USING ERRCODE = '55000';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);

  -- A derived Start is an ordering barrier. Until it settles, the source stays queued and no
  -- attempt row or absolute turn deadline can be created.
  v_old := $r$        AND NOT EXISTS (
          SELECT 1 FROM public.companion_turns active_turn
          WHERE active_turn.org_id = v_org_id
            AND active_turn.companion_id = v_companion_id
            AND public.companion_runtime_turn_lane(
              active_turn.org_id, active_turn.companion_id, active_turn.id
            ) = v_lane
            AND active_turn.status IN ('starting', 'dispatching', 'running', 'needs_input')$r$
    || E'\n' || repeat(' ', 12) || $r$
        )
      ORDER BY t.queue_sequence, t.id$r$;
  v_new := $r$        AND NOT EXISTS (
          SELECT 1 FROM public.companion_turns active_turn
          WHERE active_turn.org_id = v_org_id
            AND active_turn.companion_id = v_companion_id
            AND public.companion_runtime_turn_lane(
              active_turn.org_id, active_turn.companion_id, active_turn.id
            ) = v_lane
            AND active_turn.status IN ('starting', 'dispatching', 'running', 'needs_input', 'interrupted')
            AND (active_turn.status <> 'interrupted' OR active_turn.resolution IS NULL)
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.companion_operations source_start
          WHERE source_start.org_id = t.org_id
            AND source_start.companion_id = t.companion_id
            AND source_start.source_turn_id = t.id
            AND source_start.kind = 'start'
            AND source_start.status IN ('pending', 'running')
        )
      ORDER BY t.queue_sequence, t.id$r$;
  v_count := (char_length(v_definition) - char_length(replace(v_definition, v_old, '')))
    / char_length(v_old);
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'Start-attempt interlock matched %, expected 1', v_count USING ERRCODE = '55000';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);

  -- Recovery is system-owned cleanup. It is not invalidated by the historical actor's current
  -- membership or Companion ACL, while every explicit lifecycle operation keeps the old check.
  v_old := $r$      v_companion_owner_id := NULL;
      v_operation_actor_authorized := false;
      SELECT c.owner_id
      INTO v_companion_owner_id
      FROM public.companions c
      JOIN public.memberships m
        ON m.org_id = c.org_id AND m.user_id = v_actor_id
      WHERE c.org_id = v_org_id AND c.id = v_companion_id
      FOR NO KEY UPDATE OF c, m;

      IF FOUND AND v_companion_owner_id = v_actor_id THEN
        v_operation_actor_authorized := true;
      ELSIF FOUND AND v_operation_kind <> 'delete' THEN
        PERFORM 1
        FROM public.companion_workspace_access a
        WHERE a.org_id = v_org_id
          AND a.companion_id = v_companion_id
          AND a.role = 'editor'
        FOR NO KEY UPDATE;
        v_operation_actor_authorized := FOUND;
      END IF;$r$;
  v_new := $r$      v_companion_owner_id := NULL;
      v_operation_actor_authorized := v_operation_trigger = 'recovery';
      IF v_operation_trigger <> 'recovery' THEN
        SELECT c.owner_id
        INTO v_companion_owner_id
        FROM public.companions c
        JOIN public.memberships m
          ON m.org_id = c.org_id AND m.user_id = v_actor_id
        WHERE c.org_id = v_org_id AND c.id = v_companion_id
        FOR NO KEY UPDATE OF c, m;

        IF FOUND AND v_companion_owner_id = v_actor_id THEN
          v_operation_actor_authorized := true;
        ELSIF FOUND AND v_operation_kind <> 'delete' THEN
          PERFORM 1
          FROM public.companion_workspace_access a
          WHERE a.org_id = v_org_id
            AND a.companion_id = v_companion_id
            AND a.role = 'editor'
          FOR NO KEY UPDATE;
          v_operation_actor_authorized := FOUND;
        END IF;
      END IF;$r$;
  v_count := (char_length(v_definition) - char_length(replace(v_definition, v_old, '')))
    / char_length(v_old);
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'recovery actor bypass matched %, expected 1', v_count USING ERRCODE = '55000';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);

  -- Protocol 6 removed the old recovery guards because recovery was no longer durable. Restore
  -- them before protocol 7 claims cleanup: cleanup never preempts a Start, queued turn, active
  -- attempt, or routine. It only terminates the source attempt's exact Pi invocation.
  v_old := $r$          AND v_lane = 'main'$r$
    || E'\n' || repeat(' ', 10) || $r$
          AND o.id <> v_work_id$r$;
  v_new := $r$          AND v_lane = 'main'
          AND v_operation_trigger <> 'recovery'
          AND o.id <> v_work_id$r$;
  v_count := (char_length(v_definition) - char_length(replace(v_definition, v_old, '')))
    / char_length(v_old);
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'recovery supersession guard matched %, expected 1', v_count
      USING ERRCODE = '55000';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);

  v_old := $r$      WHERE v_lane = 'main'$r$
    || E'\n' || repeat(' ', 8) || $r$
        AND v_operation_kind IN ('stop', 'restart_pi', 'restart_box')$r$;
  v_new := $r$      WHERE v_lane = 'main'
        AND v_operation_trigger <> 'recovery'
        AND v_operation_kind IN ('stop', 'restart_pi', 'restart_box')$r$;
  v_count := (char_length(v_definition) - char_length(replace(v_definition, v_old, '')))
    / char_length(v_old);
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'recovery queued-turn guard matched %, expected 1', v_count
      USING ERRCODE = '55000';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);

  v_old := $r$      IF v_lane = 'main'$r$
    || E'\n' || repeat(' ', 9) || $r$
         AND v_operation_kind IN ('delete', 'stop', 'restart_pi', 'restart_box') THEN$r$;
  v_new := $r$      IF v_lane = 'main'
         AND v_operation_trigger <> 'recovery'
         AND v_operation_kind IN ('delete', 'stop', 'restart_pi', 'restart_box') THEN$r$;
  v_count := (char_length(v_definition) - char_length(replace(v_definition, v_old, '')))
    / char_length(v_old);
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'recovery active-turn guard matched %, expected 1', v_count
      USING ERRCODE = '55000';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);

  -- Claiming, not enqueueing, starts the cold-start clock. COALESCE preserves one deadline across
  -- a lease takeover of the same Start cycle.
  v_old := $r$      UPDATE public.companion_operations o
      SET status = 'running', claim_epoch = v_claim_epoch,
          attempt_count = o.attempt_count + 1,
          started_at = COALESCE(o.started_at, v_now), updated_at = v_now
      WHERE o.org_id = v_org_id AND o.companion_id = v_companion_id AND o.id = v_work_id;$r$;
  v_new := $r$      IF v_operation_kind = 'restart_pi'
         AND v_operation_trigger = 'recovery' THEN
        -- A protocol-7 takeover of the finite live-v5 cohort first narrows the durable row itself.
        -- The newly-published fence has a different epoch, so the immutability trigger can prove
        -- that the old executor no longer owns a live lease. Keep started_at: this is a takeover of
        -- the same cycle, not a failed-cycle re-enqueue.
        UPDATE public.companion_operations recovery_operation
        SET legacy_recovery_snapshot = false,
            checkpoint = CASE WHEN recovery_operation.checkpoint = 'pi_ready'
              THEN 'cleanup_complete' ELSE recovery_operation.checkpoint END,
            client_surface = NULL,
            target_settings_revision = NULL,
            target_skills_revision = NULL,
            model_id = NULL,
            persona = NULL,
            can_write_skills = NULL,
            provider_ids = NULL,
            selected_skill_ids = NULL,
            skill_refs = NULL,
            skill_update_selected_skill_ids = NULL,
            skill_update_refs = NULL,
            selected_mcp_account_ids = NULL,
            material_staged_at = NULL,
            material_expires_at = NULL,
            updated_at = v_now
        WHERE recovery_operation.org_id = v_org_id
          AND recovery_operation.companion_id = v_companion_id
          AND recovery_operation.id = v_work_id
          AND recovery_operation.legacy_recovery_snapshot;
        IF v_checkpoint = 'pi_ready' THEN v_checkpoint := 'cleanup_complete'; END IF;
      END IF;

      UPDATE public.companion_operations o
      SET status = 'running', claim_epoch = v_claim_epoch,
          attempt_count = o.attempt_count + 1,
          started_at = COALESCE(o.started_at, v_now), updated_at = v_now
      WHERE o.org_id = v_org_id AND o.companion_id = v_companion_id AND o.id = v_work_id;

      IF v_operation_kind = 'start' THEN
        UPDATE public.companion_turns source_turn
        SET cold_start_deadline_at = COALESCE(
              source_turn.cold_start_deadline_at,
              v_now + interval '3 minutes'
            ),
            updated_at = v_now
        WHERE source_turn.org_id = v_org_id
          AND source_turn.companion_id = v_companion_id
          AND source_turn.id = (
            SELECT claimed_start.source_turn_id
            FROM public.companion_operations claimed_start
            WHERE claimed_start.org_id = v_org_id
              AND claimed_start.companion_id = v_companion_id
              AND claimed_start.id = v_work_id
          )
          AND source_turn.status = 'queued';
      END IF;$r$;
  v_count := (char_length(v_definition) - char_length(replace(v_definition, v_old, '')))
    / char_length(v_old);
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'Start claim deadline matched %, expected 1', v_count USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(v_definition, v_old, v_new);
END
$companion_protocol_7_claimer$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.companion_runtime_ensure_turn_recovery(
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

  -- Only lifecycle intent that proves the same cleanup boundary suppresses this recovery.
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
        OR (lifecycle.kind = 'restart_pi' AND lifecycle.execution_lane = v_lane)
      )
  ) THEN
    RETURN;
  END IF;

  INSERT INTO public.companion_operations(
    org_id, companion_id, request_id, kind, trigger, actor_id, source_turn_id,
    queue_sequence, turn_queue_cutoff, runtime_generation, client_surface,
    execution_lane, status, available_at, created_at, updated_at
  ) VALUES (
    p_org_id, p_companion_id, NULL, 'restart_pi', 'recovery', v_owner_id, p_turn_id,
    0, 0, v_generation, v_surface,
    v_lane, 'pending', clock_timestamp(), clock_timestamp(), clock_timestamp()
  )
  ON CONFLICT (companion_id, source_turn_id)
    WHERE kind = 'restart_pi' AND trigger = 'recovery'
  DO UPDATE SET
    status = 'pending',
    runtime_generation = EXCLUDED.runtime_generation,
    execution_lane = EXCLUDED.execution_lane,
    claim_epoch = NULL,
    started_at = NULL,
    settled_at = NULL,
    available_at = clock_timestamp(),
    last_error_code = NULL,
    last_error_message = NULL,
    last_error_action = NULL,
    updated_at = clock_timestamp()
  WHERE companion_operations.status IN ('failed', 'interrupted', 'cancelled');
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

CREATE OR REPLACE FUNCTION public.companion_runtime_settle_recovery_operation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_delay_seconds integer;
  v_turn record;
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
    ELSIF NEW.status IN ('failed', 'interrupted', 'cancelled') AND EXISTS (
      SELECT 1
      FROM public.companion_turns source_turn
      WHERE source_turn.org_id = NEW.org_id
        AND source_turn.companion_id = NEW.companion_id
        AND source_turn.id = NEW.source_turn_id
        AND source_turn.status = 'interrupted'
        AND source_turn.resolution IS NULL
    ) AND NOT EXISTS (
      SELECT 1
      FROM public.companion_operations lifecycle
      WHERE lifecycle.org_id = NEW.org_id
        AND lifecycle.companion_id = NEW.companion_id
        AND lifecycle.id <> NEW.id
        AND lifecycle.status IN ('pending', 'running')
        AND lifecycle.trigger <> 'recovery'
        AND (
          lifecycle.kind IN ('delete', 'restart_box')
          OR (lifecycle.kind = 'stop' AND NEW.execution_lane = 'main')
          OR (lifecycle.kind = 'restart_pi'
            AND lifecycle.execution_lane = NEW.execution_lane)
        )
    ) THEN
      v_delay_seconds := LEAST(
        300,
        (5 * power(2, LEAST(6, GREATEST(0, NEW.attempt_count - 1))))::integer
      );
      UPDATE public.companion_operations recovery
      SET status = 'pending',
          claim_epoch = NULL,
          started_at = NULL,
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
  END IF;

  -- A terminal explicit lifecycle may have been the only conflict suppressing one or both exact
  -- recoveries. Re-evaluate every unresolved occurrence now; the unique recovery index makes this
  -- idempotent and the helper retains lane-specific conflict semantics.
  IF NEW.trigger <> 'recovery'
     AND NEW.kind IN ('delete', 'stop', 'restart_pi', 'restart_box')
     AND NEW.status IN ('succeeded', 'failed', 'interrupted', 'cancelled') THEN
    FOR v_turn IN
      SELECT interrupted_turn.org_id, interrupted_turn.companion_id, interrupted_turn.id
      FROM public.companion_turns interrupted_turn
      WHERE interrupted_turn.org_id = NEW.org_id
        AND interrupted_turn.companion_id = NEW.companion_id
        AND interrupted_turn.status = 'interrupted'
        AND interrupted_turn.resolution IS NULL
    LOOP
      PERFORM public.companion_runtime_ensure_turn_recovery(
        v_turn.org_id, v_turn.companion_id, v_turn.id
      );
    END LOOP;
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

-- Retry remains on the wire for rolling clients. It only observes or re-enqueues the single
-- cleanup operation and never creates a user attempt or replays the interrupted prompt.
CREATE FUNCTION public.companion_api_retry_turn(
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

  -- Match Runtime's lease -> instance -> operation -> turn hierarchy. A rolling client's Retry
  -- must wait behind the instance mutex before it can lock the interrupted source turn, otherwise
  -- it can deadlock an exact cleanup renewal that already owns the instance.
  PERFORM 1
  FROM public.companion_runtime_instances instance
  WHERE instance.org_id = p_org_id
    AND instance.companion_id = p_companion_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Companion runtime instance not found' USING ERRCODE = '55000';
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

  PERFORM public.companion_runtime_ensure_turn_recovery(
    p_org_id, p_companion_id, p_turn_id
  );

  SELECT operation_row.id INTO v_operation_id
  FROM public.companion_operations operation_row
  WHERE operation_row.org_id = p_org_id
    AND operation_row.companion_id = p_companion_id
    AND operation_row.source_turn_id = p_turn_id
    AND operation_row.kind = 'restart_pi'
    AND operation_row.trigger = 'recovery'
  ORDER BY operation_row.created_at DESC, operation_row.id DESC
  LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'automatic Companion recovery is unavailable' USING ERRCODE = '40001';
  END IF;

  RETURN QUERY SELECT
    public.companion_api_operation_json(p_org_id, p_companion_id, v_operation_id), true;
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_api_retry_turn(
  uuid,uuid,uuid,uuid,public.companion_client_surface
) FROM PUBLIC;
--> statement-breakpoint

-- Cancel from a rolling client remains valid for queued and active work. Once an interrupted turn
-- owns exact automatic cleanup, however, Cancel is only an idempotent observation: changing the
-- source occurrence would revoke the cleanup fence before its Pi invocation is terminated.
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

  -- The instance mutex serializes this compatibility read with runtime settlement. Avoid locking
  -- the turn before operations so the established instance -> operation -> turn order is intact.
  SELECT source_turn.status INTO v_status
  FROM public.companion_turns source_turn
  WHERE source_turn.org_id = p_org_id
    AND source_turn.companion_id = p_companion_id
    AND source_turn.id = p_turn_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Companion turn not found' USING ERRCODE = '22023';
  END IF;
  -- Cancel is an observation for every interrupted turn, both while exact cleanup is in flight and
  -- after its durable auto_abandoned resolution. Never rewrite interruption history to cancelled.
  IF v_status = 'interrupted' THEN
    RETURN QUERY SELECT public.companion_api_turn_json(p_org_id, p_companion_id, p_turn_id);
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.companion_operations retry_operation
    WHERE retry_operation.org_id = p_org_id
      AND retry_operation.companion_id = p_companion_id
      AND retry_operation.source_turn_id = p_turn_id
      AND retry_operation.kind IN ('start', 'restart_pi')
      AND retry_operation.trigger = 'user'
      AND retry_operation.status = 'running'
  ) THEN
    RAISE EXCEPTION 'Companion turn retry is already running' USING ERRCODE = '55000';
  END IF;
  UPDATE public.companion_operations retry_operation
  SET status = 'cancelled', settled_at = v_now, updated_at = v_now
  WHERE retry_operation.org_id = p_org_id
    AND retry_operation.companion_id = p_companion_id
    AND retry_operation.source_turn_id = p_turn_id
    AND (
      (
        retry_operation.kind IN ('start', 'restart_pi')
        AND retry_operation.trigger = 'user'
      )
      OR (
        retry_operation.kind = 'start'
        AND retry_operation.trigger = 'turn'
      )
    )
    AND retry_operation.status = 'pending';

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
  ELSIF v_status NOT IN ('queued', 'interrupted') THEN
    RAISE EXCEPTION 'only a queued, active, or interrupted Companion turn can be cancelled'
      USING ERRCODE = '55000';
  END IF;

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
    AND source_turn.status IN (
      'queued', 'starting', 'dispatching', 'running', 'needs_input', 'interrupted'
    );
  IF NOT FOUND THEN
    RAISE EXCEPTION 'only a queued, active, or interrupted Companion turn can be cancelled'
      USING ERRCODE = '55000';
  END IF;

  UPDATE public.companion_decision_deliveries delivery
  SET decision_status = CASE WHEN delivery.decision_status = 'pending'
        THEN 'cancelled'::public.companion_decision_status ELSE delivery.decision_status END,
      responded_at = CASE WHEN delivery.decision_status = 'pending'
        THEN v_now ELSE delivery.responded_at END,
      delivery_state = CASE WHEN delivery.command_id IS NULL
        THEN 'cancelled'::public.companion_decision_delivery_state
        ELSE 'ambiguous'::public.companion_decision_delivery_state END,
      delivery_checkpoint = CASE WHEN delivery.command_id IS NULL
        THEN 'cancelled' ELSE 'ambiguous' END,
      delivery_checkpoint_sequence = delivery.delivery_checkpoint_sequence + 1,
      last_error_code = CASE WHEN delivery.command_id IS NULL
        THEN NULL ELSE 'turn_cancelled_after_delivery_intent' END,
      last_error_message = CASE WHEN delivery.command_id IS NULL THEN NULL
        ELSE 'The turn was cancelled after a decision response may have reached Pi.' END,
      last_error_action = CASE WHEN delivery.command_id IS NULL
        THEN NULL ELSE 'none'::public.companion_runtime_error_action END,
      updated_at = v_now
  WHERE delivery.org_id = p_org_id AND delivery.companion_id = p_companion_id
    AND delivery.turn_id = p_turn_id
    AND delivery.delivery_state NOT IN ('delivered', 'cancelled');

  RETURN QUERY SELECT public.companion_api_turn_json(p_org_id, p_companion_id, p_turn_id);
END
$$;
--> statement-breakpoint

DO $companion_cleanup_checkpoint$
DECLARE
  v_signature text :=
    'public.companion_runtime_checkpoint(uuid,uuid,uuid,bigint,bigint,text,'
    || 'public.companion_runtime_work_kind,uuid,bigint,text,text,uuid,text,bigint,'
    || 'timestamptz,integer,integer,integer)';
  v_definition text := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_signature));
  v_old text := $r$      OR (v_operation_kind = 'restart_pi' AND (
        (v_current_checkpoint IN ('pending', 'restarting_pi', 'starting_pi', 'pi_observed')
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
              AND EXISTS (
                SELECT 1
                FROM public.companion_operations recovery_operation
                WHERE recovery_operation.org_id = p_org_id
                  AND recovery_operation.companion_id = p_companion_id
                  AND recovery_operation.id = p_work_id
                  AND recovery_operation.trigger = 'recovery'
              )
            )
          ))
        OR (v_current_checkpoint = 'pending' AND p_next_checkpoint = 'restarting_pi')
        OR (v_current_checkpoint = 'restarting_pi' AND p_next_checkpoint = 'starting_pi')
        OR (v_current_checkpoint = 'pi_observed' AND p_next_checkpoint = 'pi_ready')
      ))$r$;
  v_new text := $r$      OR (v_operation_kind = 'restart_pi' AND (
        (
          v_current_checkpoint IN (
            'pending', 'restarting_pi', 'starting_pi', 'pi_observed', 'pi_ready'
          )
          AND p_next_checkpoint = 'cleanup_complete'
          AND EXISTS (
            SELECT 1
            FROM public.companion_operations recovery_operation
            WHERE recovery_operation.org_id = p_org_id
              AND recovery_operation.companion_id = p_companion_id
              AND recovery_operation.id = p_work_id
              AND recovery_operation.trigger = 'recovery'
          )
        )
        OR (v_current_checkpoint IN ('pending', 'restarting_pi', 'starting_pi', 'pi_observed')
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
              AND EXISTS (
                SELECT 1
                FROM public.companion_operations recovery_operation
                WHERE recovery_operation.org_id = p_org_id
                  AND recovery_operation.companion_id = p_companion_id
                  AND recovery_operation.id = p_work_id
                  AND recovery_operation.trigger = 'recovery'
              )
            )
          ))
        OR (v_current_checkpoint = 'pending' AND p_next_checkpoint = 'restarting_pi')
        OR (v_current_checkpoint = 'restarting_pi' AND p_next_checkpoint = 'starting_pi')
        OR (v_current_checkpoint = 'pi_observed' AND p_next_checkpoint = 'pi_ready')
      ) AND (
        p_next_checkpoint <> 'pi_ready'
        OR NOT EXISTS (
          SELECT 1
          FROM public.companion_operations recovery_operation
          WHERE recovery_operation.org_id = p_org_id
            AND recovery_operation.companion_id = p_companion_id
            AND recovery_operation.id = p_work_id
            AND recovery_operation.trigger = 'recovery'
        )
        OR EXISTS (
          SELECT 1
          FROM public.companion_operations recovery_operation
          WHERE recovery_operation.org_id = p_org_id
            AND recovery_operation.companion_id = p_companion_id
            AND recovery_operation.id = p_work_id
            AND recovery_operation.trigger = 'recovery'
            AND recovery_operation.legacy_recovery_snapshot
        )
      ))$r$;
  v_count integer;
BEGIN
  v_count := (char_length(v_definition) - char_length(replace(v_definition, v_old, '')))
    / char_length(v_old);
  IF v_definition IS NULL OR v_count <> 1 THEN
    RAISE EXCEPTION 'cleanup checkpoint transition matched %, expected 1', COALESCE(v_count, 0)
      USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(v_definition, v_old, v_new);
END
$companion_cleanup_checkpoint$;
--> statement-breakpoint

DO $companion_cleanup_settlement_proof$
DECLARE
  v_signature text :=
    'public.companion_runtime_settle(uuid,uuid,uuid,bigint,bigint,text,'
    || 'public.companion_runtime_work_kind,uuid,text,text,text,'
    || 'public.companion_runtime_error_action)';
  v_definition text := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_signature));
  v_old text := $r$    IF p_terminal_status = 'succeeded' AND NOT (
      (v_operation_kind IN ('start', 'restart_pi', 'restart_box') AND v_operation_checkpoint = 'pi_ready')
      OR (v_operation_kind = 'stop' AND v_operation_checkpoint = 'box_archived')$r$;
  v_new text := $r$    IF p_terminal_status = 'succeeded' AND NOT (
      (v_operation_kind IN ('start', 'restart_pi', 'restart_box')
        AND v_operation_checkpoint = 'pi_ready'
        AND (
          v_operation_kind <> 'restart_pi'
          OR NOT EXISTS (
            SELECT 1 FROM public.companion_operations recovery_operation
            WHERE recovery_operation.org_id = p_org_id
              AND recovery_operation.companion_id = p_companion_id
              AND recovery_operation.id = p_work_id
              AND recovery_operation.trigger = 'recovery'
          )
          OR EXISTS (
            SELECT 1 FROM public.companion_operations recovery_operation
            WHERE recovery_operation.org_id = p_org_id
              AND recovery_operation.companion_id = p_companion_id
              AND recovery_operation.id = p_work_id
              AND recovery_operation.trigger = 'recovery'
              AND recovery_operation.legacy_recovery_snapshot
          )
        ))
      OR (
        v_operation_kind = 'restart_pi'
        AND v_operation_checkpoint = 'cleanup_complete'
        AND EXISTS (
          SELECT 1 FROM public.companion_operations recovery_operation
          WHERE recovery_operation.org_id = p_org_id
            AND recovery_operation.companion_id = p_companion_id
            AND recovery_operation.id = p_work_id
            AND recovery_operation.trigger = 'recovery'
        )
      )
      OR (v_operation_kind = 'stop' AND v_operation_checkpoint = 'box_archived')$r$;
  v_count integer;
BEGIN
  v_count := (char_length(v_definition) - char_length(replace(v_definition, v_old, '')))
    / char_length(v_old);
  IF v_definition IS NULL OR v_count <> 1 THEN
    RAISE EXCEPTION 'cleanup settlement proof matched %, expected 1', COALESCE(v_count, 0)
      USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(v_definition, v_old, v_new);
END
$companion_cleanup_settlement_proof$;
--> statement-breakpoint

-- A cold Start timeout proves that Pi cannot accept the queued prompt yet; it says nothing about
-- the prompt itself. Re-arm the same Start with bounded backoff, clear only the per-cycle budget,
-- and leave the source turn queued without creating an attempt or replaying content. Lease
-- takeover within a cycle still keeps its original deadline; only a settled timeout opens a new
-- cycle.
DO $companion_cold_start_requeue$
DECLARE
  v_signature text :=
    'public.companion_runtime_settle(uuid,uuid,uuid,bigint,bigint,text,'
    || 'public.companion_runtime_work_kind,uuid,text,text,text,'
    || 'public.companion_runtime_error_action)';
  v_definition text := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_signature));
  v_old text := $r$    v_success := FOUND;

    IF v_success
       AND v_operation_kind IN ('start', 'apply_settings')
       AND v_turn_id IS NOT NULL
       AND p_terminal_status <> 'succeeded' THEN$r$;
  v_new text := $r$    v_success := FOUND;

    IF v_success
       AND v_operation_kind = 'start'
       AND v_turn_id IS NOT NULL
       AND p_terminal_status <> 'succeeded'
       AND p_error_code = 'cold_start_deadline_exceeded' THEN
      UPDATE public.companion_operations start_operation
      SET status = 'pending',
          claim_epoch = NULL,
          started_at = NULL,
          settled_at = NULL,
          last_error_code = NULL,
          last_error_message = NULL,
          last_error_action = NULL,
          available_at = v_now + make_interval(secs => LEAST(
            300,
            (5 * power(
              2,
              LEAST(6, GREATEST(0, start_operation.attempt_count - 1))
            ))::integer
          )),
          updated_at = v_now
      WHERE start_operation.org_id = p_org_id
        AND start_operation.companion_id = p_companion_id
        AND start_operation.id = p_work_id
        AND start_operation.status = p_terminal_status::public.companion_operation_status
        AND EXISTS (
          SELECT 1
          FROM public.companion_turns queued_source
          WHERE queued_source.org_id = start_operation.org_id
            AND queued_source.companion_id = start_operation.companion_id
            AND queued_source.id = start_operation.source_turn_id
            AND queued_source.status = 'queued'
        );

      UPDATE public.companion_turns source_turn
      SET cold_start_deadline_at = NULL,
          updated_at = v_now
      WHERE source_turn.org_id = p_org_id
        AND source_turn.companion_id = p_companion_id
        AND source_turn.id = v_turn_id
        AND source_turn.status = 'queued';
    END IF;

    IF v_success
       AND v_operation_kind IN ('start', 'apply_settings')
       AND v_turn_id IS NOT NULL
       AND p_terminal_status <> 'succeeded'
       AND NOT (
         v_operation_kind = 'start'
         AND p_error_code = 'cold_start_deadline_exceeded'
       ) THEN$r$;
  v_count integer;
BEGIN
  v_count := (char_length(v_definition) - char_length(replace(v_definition, v_old, '')))
    / char_length(v_old);
  IF v_definition IS NULL OR v_count <> 1 THEN
    RAISE EXCEPTION 'cold Start requeue settlement matched %, expected 1', COALESCE(v_count, 0)
      USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(v_definition, v_old, v_new);
END
$companion_cold_start_requeue$;
--> statement-breakpoint

-- Versioned authorization adds the recovery discriminants without changing the rolling-deploy
-- surface used by protocol 5. Cleanup authorization deliberately returns no resource material.
CREATE FUNCTION public.companion_runtime_renew_and_authorize_v3(
  p_org_id uuid,
  p_companion_id uuid,
  p_claim_token uuid,
  p_claim_epoch bigint,
  p_gate_epoch bigint,
  p_executor_id text,
  p_work_kind public.companion_runtime_work_kind,
  p_work_id uuid,
  p_lease_seconds integer
)
RETURNS TABLE (
  authorized boolean,
  denial_code text,
  lease_expires_at timestamp with time zone,
  authorization_actor_id text,
  decision_actor_id text,
  client_surface public.companion_client_surface,
  runtime_generation bigint,
  box_id text,
  box_state public.companion_box_observed_state,
  pi_state public.companion_pi_observed_state,
  pi_invocation_id text,
  disk_layout_version integer,
  applied_settings_revision bigint,
  applied_skills_revision integer,
  model_id text,
  persona text,
  can_write_skills boolean,
  provider_refs jsonb,
  skill_refs jsonb,
  mcp_refs jsonb,
  desired_settings_revision bigint,
  skills_revision integer,
  work_checkpoint text,
  work_checkpoint_sequence bigint,
  turn_id uuid,
  turn_status public.companion_turn_status,
  attempt_status public.companion_attempt_status,
  dispatch_state public.companion_dispatch_state,
  event_cursor bigint,
  unknown_event_count integer,
  malformed_event_count integer,
  oversized_event_count integer,
  cold_start_deadline_at timestamp with time zone,
  inactivity_deadline_at timestamp with time zone,
  absolute_deadline_at timestamp with time zone,
  operation_kind public.companion_operation_kind,
  operation_started_at timestamp with time zone,
  operation_attempt_count integer,
  provider_operation_id text,
  target_settings_revision bigint,
  target_skills_revision integer,
  decision_status public.companion_decision_status,
  decision_delivery_state public.companion_decision_delivery_state,
  decision_request_key text,
  decision_response_text text,
  command_id uuid,
  command_pi_invocation_id text,
  operation_trigger public.companion_operation_trigger,
  operation_lane text,
  source_dispatch_state public.companion_dispatch_state,
  source_pi_invocation_id text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_now timestamp with time zone := clock_timestamp();
  v_lease_expires_at timestamp with time zone;
  v_operation record;
  v_instance record;
  v_turn record;
  v_attempt_status public.companion_attempt_status;
  v_source_dispatch_state public.companion_dispatch_state;
  v_source_dispatch_count integer;
  v_source_pi_invocation_id text;
  v_event_cursor bigint;
  v_unknown_event_count integer;
  v_malformed_event_count integer;
  v_oversized_event_count integer;
  v_lane text;
  v_authorized boolean := false;
  v_denial_code text := 'claim_fenced';
BEGIN
  IF p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 5 AND 300 THEN
    RAISE EXCEPTION 'invalid Runtime v2 authorization arguments' USING ERRCODE = '22023';
  END IF;

  IF p_work_kind = 'operation' AND EXISTS (
    SELECT 1
    FROM public.companion_operations operation_row
    WHERE operation_row.org_id = p_org_id
      AND operation_row.companion_id = p_companion_id
      AND operation_row.id = p_work_id
      AND operation_row.kind = 'restart_pi'
      AND operation_row.trigger = 'recovery'
  ) THEN
    -- Preserve the global fence order: lane lease, instance, operation, source turn.
    SELECT lease.lane, lease.expires_at
    INTO v_lane, v_lease_expires_at
    FROM public.companion_runtime_leases lease
    JOIN public.companion_runtime_control control ON control.id = 'runtime-v2'
    WHERE lease.org_id = p_org_id
      AND lease.companion_id = p_companion_id
      AND lease.claim_token = p_claim_token
      AND lease.claim_epoch = p_claim_epoch
      AND lease.gate_epoch = p_gate_epoch
      AND lease.executor_id = p_executor_id
      AND lease.work_kind = p_work_kind
      AND lease.work_id = p_work_id
      AND lease.expires_at > v_now
      AND control.enabled
      AND control.gate_epoch = p_gate_epoch
    FOR UPDATE OF lease;

    IF FOUND THEN
      SELECT instance.generation, instance.box_id, instance.box_state, instance.pi_state,
        instance.pi_invocation_id, instance.disk_layout_version,
        instance.applied_settings_revision, instance.applied_skills_revision
      INTO v_instance
      FROM public.companion_runtime_instances instance
      WHERE instance.org_id = p_org_id
        AND instance.companion_id = p_companion_id
        AND instance.retirement_state = 'active'
      FOR UPDATE;

      IF FOUND THEN
        SELECT operation_row.source_turn_id, operation_row.checkpoint,
          operation_row.checkpoint_sequence, operation_row.kind, operation_row.trigger,
          operation_row.execution_lane, operation_row.started_at, operation_row.attempt_count,
          operation_row.provider_operation_id
        INTO v_operation
        FROM public.companion_operations operation_row
        WHERE operation_row.org_id = p_org_id
          AND operation_row.companion_id = p_companion_id
          AND operation_row.id = p_work_id
          AND operation_row.kind = 'restart_pi'
          AND operation_row.trigger = 'recovery'
          AND operation_row.status = 'running'
          AND operation_row.claim_epoch = p_claim_epoch
          AND operation_row.runtime_generation = v_instance.generation
          AND operation_row.execution_lane = v_lane
        FOR UPDATE;

        IF FOUND THEN
          SELECT source_turn.id, source_turn.status, source_turn.cold_start_deadline_at,
            source_turn.inactivity_deadline_at, source_turn.absolute_deadline_at
          INTO v_turn
          FROM public.companion_turns source_turn
          WHERE source_turn.org_id = p_org_id
            AND source_turn.companion_id = p_companion_id
            AND source_turn.id = v_operation.source_turn_id
            AND source_turn.status = 'interrupted'
            AND source_turn.resolution IS NULL
          FOR UPDATE;

          IF FOUND THEN
            SELECT source_attempt.status, source_attempt.dispatch_state,
              source_attempt.dispatch_count, source_attempt.pi_invocation_id,
              source_attempt.event_cursor, source_attempt.unknown_event_count,
              source_attempt.malformed_event_count, source_attempt.oversized_event_count
            INTO v_attempt_status, v_source_dispatch_state, v_source_dispatch_count,
              v_source_pi_invocation_id, v_event_cursor, v_unknown_event_count,
              v_malformed_event_count, v_oversized_event_count
            FROM public.companion_turn_attempts source_attempt
            WHERE source_attempt.org_id = p_org_id
              AND source_attempt.companion_id = p_companion_id
              AND source_attempt.turn_id = v_turn.id
            ORDER BY source_attempt.attempt_number DESC, source_attempt.id DESC
            LIMIT 1;

            -- A missing historical InvocationID still authorizes the read-only Box observation.
            -- Archived/absent is terminal negative proof; a live Box fails closed in Runtime before
            -- any Pi mutation because exact termination then remains impossible.
            v_now := clock_timestamp();
            IF v_lease_expires_at > v_now THEN
              UPDATE public.companion_runtime_leases lease
              SET renewed_at = v_now,
                  expires_at = v_now + make_interval(secs => p_lease_seconds),
                  updated_at = v_now
              WHERE lease.org_id = p_org_id
                AND lease.companion_id = p_companion_id
                AND lease.lane = v_lane
                AND lease.claim_token = p_claim_token
                AND lease.claim_epoch = p_claim_epoch
                AND lease.gate_epoch = p_gate_epoch
                AND lease.executor_id = p_executor_id
                AND lease.work_kind = p_work_kind
                AND lease.work_id = p_work_id
                AND lease.expires_at > v_now
              RETURNING lease.expires_at INTO v_lease_expires_at;
              IF FOUND THEN
                v_authorized := true;
                v_denial_code := NULL;
              END IF;
            END IF;
          ELSE
            v_denial_code := 'recovery_turn_resolved';
          END IF;
        ELSE
          v_denial_code := 'recovery_generation_changed';
        END IF;
      ELSE
        v_denial_code := 'recovery_instance_unavailable';
      END IF;
    END IF;

    -- Match v2 fencing semantics: a missing/expired lease returns no row. Stable denials after a
    -- valid fence retain the renewed/current expiry so the executor can settle deliberately.
    IF v_lease_expires_at IS NULL THEN RETURN; END IF;

    RETURN QUERY SELECT
      v_authorized,
      v_denial_code,
      v_lease_expires_at,
      NULL::text,
      NULL::text,
      NULL::public.companion_client_surface,
      CASE WHEN v_authorized THEN v_instance.generation ELSE NULL END,
      CASE WHEN v_authorized THEN v_instance.box_id ELSE NULL END,
      CASE WHEN v_authorized THEN v_instance.box_state ELSE NULL END,
      CASE WHEN v_authorized THEN v_instance.pi_state ELSE NULL END,
      CASE WHEN v_authorized THEN v_instance.pi_invocation_id ELSE NULL END,
      CASE WHEN v_authorized THEN v_instance.disk_layout_version ELSE NULL END,
      CASE WHEN v_authorized THEN v_instance.applied_settings_revision ELSE NULL END,
      CASE WHEN v_authorized THEN v_instance.applied_skills_revision ELSE NULL END,
      NULL::text,
      NULL::text,
      NULL::boolean,
      '[]'::jsonb,
      '[]'::jsonb,
      '[]'::jsonb,
      NULL::bigint,
      NULL::integer,
      CASE WHEN v_authorized THEN v_operation.checkpoint ELSE NULL END,
      CASE WHEN v_authorized THEN v_operation.checkpoint_sequence ELSE NULL END,
      CASE WHEN v_authorized THEN v_turn.id ELSE NULL END,
      CASE WHEN v_authorized THEN v_turn.status ELSE NULL END,
      CASE WHEN v_authorized THEN v_attempt_status ELSE NULL END,
      CASE WHEN v_authorized THEN v_source_dispatch_state ELSE NULL END,
      CASE WHEN v_authorized THEN v_event_cursor ELSE NULL END,
      CASE WHEN v_authorized THEN v_unknown_event_count ELSE NULL END,
      CASE WHEN v_authorized THEN v_malformed_event_count ELSE NULL END,
      CASE WHEN v_authorized THEN v_oversized_event_count ELSE NULL END,
      CASE WHEN v_authorized THEN v_turn.cold_start_deadline_at ELSE NULL END,
      CASE WHEN v_authorized THEN v_turn.inactivity_deadline_at ELSE NULL END,
      CASE WHEN v_authorized THEN v_turn.absolute_deadline_at ELSE NULL END,
      CASE WHEN v_authorized THEN v_operation.kind ELSE NULL END,
      CASE WHEN v_authorized THEN v_operation.started_at ELSE NULL END,
      CASE WHEN v_authorized THEN v_operation.attempt_count ELSE NULL END,
      CASE WHEN v_authorized THEN v_operation.provider_operation_id ELSE NULL END,
      NULL::bigint,
      NULL::integer,
      NULL::public.companion_decision_status,
      NULL::public.companion_decision_delivery_state,
      NULL::text,
      NULL::text,
      NULL::uuid,
      NULL::text,
      CASE WHEN v_authorized THEN v_operation.trigger ELSE NULL END,
      CASE WHEN v_authorized THEN v_operation.execution_lane ELSE NULL END,
      CASE WHEN v_authorized THEN v_source_dispatch_state ELSE NULL END,
      CASE WHEN v_authorized THEN v_source_pi_invocation_id ELSE NULL END;
    RETURN;
  END IF;

  RETURN QUERY
  SELECT authorization_row.*,
    operation_row.trigger,
    operation_row.execution_lane,
    NULL::public.companion_dispatch_state,
    NULL::text
  FROM public.companion_runtime_renew_and_authorize_v2(
    p_org_id, p_companion_id, p_claim_token, p_claim_epoch, p_gate_epoch,
    p_executor_id, p_work_kind, p_work_id, p_lease_seconds
  ) authorization_row
  LEFT JOIN public.companion_operations operation_row
    ON operation_row.org_id = p_org_id
   AND operation_row.companion_id = p_companion_id
   AND operation_row.id = p_work_id
   AND p_work_kind = 'operation';
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_runtime_renew_and_authorize_v3(
  uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer
) FROM PUBLIC;
--> statement-breakpoint

DO $companion_authorize_v3_acl$
DECLARE
  v_source oid := pg_catalog.to_regprocedure(
    'public.companion_runtime_renew_and_authorize_v2(uuid,uuid,uuid,bigint,bigint,text,'
    || 'public.companion_runtime_work_kind,uuid,integer)'
  );
  v_grantee oid;
  v_role name;
BEGIN
  SELECT acl.grantee INTO v_grantee
  FROM pg_catalog.pg_proc source_proc
  CROSS JOIN LATERAL pg_catalog.aclexplode(
    COALESCE(source_proc.proacl, pg_catalog.acldefault('f', source_proc.proowner))
  ) acl
  WHERE source_proc.oid = v_source
    AND acl.privilege_type = 'EXECUTE'
    AND acl.grantee NOT IN (source_proc.proowner, 0)
  LIMIT 1;
  IF v_grantee IS NOT NULL THEN
    SELECT role_row.rolname INTO STRICT v_role
    FROM pg_catalog.pg_roles role_row WHERE role_row.oid = v_grantee;
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION public.companion_runtime_renew_and_authorize_v3('
      || 'uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer) TO %I',
      v_role
    );
  END IF;
END
$companion_authorize_v3_acl$;
--> statement-breakpoint

-- Protocol 6 may already have published `auto_abandoned` without any cleanup proof. Reopen only
-- those exact occurrences. Rows that already own a succeeded legacy/new terminal checkpoint stay
-- resolved, so this remains idempotent if a partially rolled deployment is retried.
UPDATE public.companion_turns source_turn
SET resolution = NULL,
    updated_at = statement_timestamp()
WHERE source_turn.status = 'interrupted'
  AND source_turn.resolution = 'auto_abandoned'
  AND NOT EXISTS (
    SELECT 1
    FROM public.companion_operations recovery
    WHERE recovery.org_id = source_turn.org_id
      AND recovery.companion_id = source_turn.companion_id
      AND recovery.source_turn_id = source_turn.id
      AND recovery.kind = 'restart_pi'
      AND recovery.trigger = 'recovery'
      AND recovery.status = 'succeeded'
      AND recovery.checkpoint IN ('cleanup_complete', 'pi_ready')
  );
--> statement-breakpoint

-- Repair every historical recovery shape generically. Live leases remain untouched; an executor
-- that already owns one can finish, and the protocol-7 settlement trigger will freshen a retry.
UPDATE public.companion_operations recovery
SET status = 'cancelled',
    claim_epoch = NULL,
    settled_at = statement_timestamp(),
    last_error_code = NULL,
    last_error_message = NULL,
    last_error_action = NULL,
    updated_at = statement_timestamp()
WHERE recovery.kind = 'restart_pi'
  AND recovery.trigger = 'recovery'
  AND recovery.status IN ('pending', 'running')
  AND NOT EXISTS (
    SELECT 1 FROM public.companion_turns source_turn
    WHERE source_turn.org_id = recovery.org_id
      AND source_turn.companion_id = recovery.companion_id
      AND source_turn.id = recovery.source_turn_id
      AND source_turn.status = 'interrupted'
      AND source_turn.resolution IS NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.companion_runtime_leases live_lease
    WHERE live_lease.org_id = recovery.org_id
      AND live_lease.companion_id = recovery.companion_id
      AND live_lease.work_kind = 'operation'
      AND live_lease.work_id = recovery.id
      AND live_lease.claim_token IS NOT NULL
      AND live_lease.expires_at > statement_timestamp()
  );
--> statement-breakpoint

UPDATE public.companion_operations recovery
SET status = 'succeeded',
    checkpoint = 'cleanup_complete',
    claim_epoch = NULL,
    settled_at = statement_timestamp(),
    last_error_code = NULL,
    last_error_message = NULL,
    last_error_action = NULL,
    updated_at = statement_timestamp()
WHERE recovery.kind = 'restart_pi'
  AND recovery.trigger = 'recovery'
  AND recovery.checkpoint IN ('cleanup_complete', 'pi_ready')
  AND recovery.status <> 'succeeded'
  AND EXISTS (
    SELECT 1 FROM public.companion_turns source_turn
    WHERE source_turn.org_id = recovery.org_id
      AND source_turn.companion_id = recovery.companion_id
      AND source_turn.id = recovery.source_turn_id
      AND source_turn.status = 'interrupted'
      AND source_turn.resolution IS NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.companion_runtime_leases live_lease
    WHERE live_lease.org_id = recovery.org_id
      AND live_lease.companion_id = recovery.companion_id
      AND live_lease.work_kind = 'operation'
      AND live_lease.work_id = recovery.id
      AND live_lease.claim_token IS NOT NULL
      AND live_lease.expires_at > statement_timestamp()
  );
--> statement-breakpoint

UPDATE public.companion_turns source_turn
SET resolution = 'auto_abandoned', updated_at = statement_timestamp()
FROM public.companion_operations recovery
WHERE recovery.org_id = source_turn.org_id
  AND recovery.companion_id = source_turn.companion_id
  AND recovery.source_turn_id = source_turn.id
  AND recovery.kind = 'restart_pi'
  AND recovery.trigger = 'recovery'
  AND recovery.status = 'succeeded'
  AND recovery.checkpoint IN ('cleanup_complete', 'pi_ready')
  AND source_turn.status = 'interrupted'
  AND source_turn.resolution IS NULL;
--> statement-breakpoint

UPDATE public.companion_operations recovery
SET status = 'pending',
    runtime_generation = instance.generation,
    execution_lane = CASE
      WHEN source_turn.routine_snapshot_id IS NULL THEN 'main' ELSE 'routine'
    END,
    claim_epoch = NULL,
    started_at = NULL,
    settled_at = NULL,
    available_at = statement_timestamp(),
    last_error_code = NULL,
    last_error_message = NULL,
    last_error_action = NULL,
    updated_at = statement_timestamp()
FROM public.companion_turns source_turn
JOIN public.companion_runtime_instances instance
  ON instance.org_id = source_turn.org_id
 AND instance.companion_id = source_turn.companion_id
WHERE recovery.org_id = source_turn.org_id
  AND recovery.companion_id = source_turn.companion_id
  AND recovery.source_turn_id = source_turn.id
  AND recovery.kind = 'restart_pi'
  AND recovery.trigger = 'recovery'
  AND source_turn.status = 'interrupted'
  AND source_turn.resolution IS NULL
  AND recovery.status IN ('pending', 'failed', 'interrupted', 'cancelled', 'running')
  AND NOT EXISTS (
    SELECT 1 FROM public.companion_runtime_leases live_lease
    WHERE live_lease.org_id = recovery.org_id
      AND live_lease.companion_id = recovery.companion_id
      AND live_lease.work_kind = 'operation'
      AND live_lease.work_id = recovery.id
      AND live_lease.claim_token IS NOT NULL
      AND live_lease.expires_at > statement_timestamp()
  );
--> statement-breakpoint

-- A pending Start has never crossed the external-work claim boundary. Undo deadlines stamped by
-- older migrations; already-running Starts keep their legitimate takeover deadline.
UPDATE public.companion_turns queued_turn
SET cold_start_deadline_at = NULL, updated_at = statement_timestamp()
WHERE queued_turn.status = 'queued'
  AND queued_turn.cold_start_deadline_at IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM public.companion_operations pending_start
    WHERE pending_start.org_id = queued_turn.org_id
      AND pending_start.companion_id = queued_turn.companion_id
      AND pending_start.source_turn_id = queued_turn.id
      AND pending_start.kind = 'start'
      AND pending_start.status = 'pending'
      AND pending_start.started_at IS NULL
  );
--> statement-breakpoint

DO $companion_backfill_missing_recoveries$
DECLARE
  v_turn record;
BEGIN
  FOR v_turn IN
    SELECT source_turn.org_id, source_turn.companion_id, source_turn.id
    FROM public.companion_turns source_turn
    WHERE source_turn.status = 'interrupted' AND source_turn.resolution IS NULL
    ORDER BY source_turn.created_at, source_turn.id
  LOOP
    PERFORM public.companion_runtime_ensure_turn_recovery(
      v_turn.org_id, v_turn.companion_id, v_turn.id
    );
  END LOOP;
END
$companion_backfill_missing_recoveries$;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_turn_recovery_status(
  p_org_id uuid,
  p_companion_id uuid,
  p_turn_id uuid
)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_status text;
BEGIN
  PERFORM public.companion_api_require_access(p_org_id, p_companion_id, 'read');

  SELECT CASE
    -- The proof may be the exact recovery operation or a successful explicit lifecycle that
    -- subsumed it. Migration backfill reopens protocol-6 auto_abandoned rows that had no proof, so
    -- every remaining auto_abandoned resolution is durably complete.
    WHEN source_turn.resolution = 'auto_abandoned' THEN 'completed'
    WHEN source_turn.status <> 'interrupted' OR source_turn.resolution IS NOT NULL THEN NULL
    WHEN recovery.status = 'running' THEN 'running'
    WHEN recovery.id IS NOT NULL THEN 'pending'
    ELSE NULL
  END
  INTO v_status
  FROM public.companion_turns source_turn
  LEFT JOIN LATERAL (
    SELECT operation_row.id, operation_row.status
    FROM public.companion_operations operation_row
    WHERE operation_row.org_id = source_turn.org_id
      AND operation_row.companion_id = source_turn.companion_id
      AND operation_row.source_turn_id = source_turn.id
      AND operation_row.kind = 'restart_pi'
      AND operation_row.trigger = 'recovery'
    ORDER BY operation_row.created_at DESC, operation_row.id DESC
    LIMIT 1
  ) recovery ON true
  WHERE source_turn.org_id = p_org_id
    AND source_turn.companion_id = p_companion_id
    AND source_turn.id = p_turn_id;

  RETURN v_status;
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_api_turn_recovery_status(uuid,uuid,uuid) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_thread_touch_recovery_operation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
BEGIN
  IF NEW.kind = 'restart_pi' AND NEW.trigger = 'recovery' THEN
    PERFORM public.companion_thread_allocate_projection_sequence(NEW.org_id, NEW.companion_id);
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_thread_touch_recovery_operation() FROM PUBLIC;
CREATE TRIGGER companion_operations_touch_recovery_projection
  AFTER INSERT OR UPDATE OF status ON public.companion_operations
  FOR EACH ROW EXECUTE FUNCTION public.companion_thread_touch_recovery_operation();
--> statement-breakpoint

-- Protocol 6 removed the protocol-5 telemetry indexes together with its metrics function. Restore
-- them before enabling the minute-level aggregate query, including the new maximum-attempt scan.
CREATE INDEX companion_operations_recovery_metrics_idx
  ON public.companion_operations(created_at)
  WHERE kind = 'restart_pi' AND trigger = 'recovery' AND status IN ('pending', 'running');
CREATE INDEX companion_operations_recovery_attempt_metrics_idx
  ON public.companion_operations(attempt_count)
  WHERE kind = 'restart_pi' AND trigger = 'recovery' AND status IN ('pending', 'running');
CREATE INDEX companion_turns_auto_abandoned_metrics_idx
  ON public.companion_turns(updated_at)
  WHERE resolution = 'auto_abandoned';
--> statement-breakpoint

-- Aggregate-only telemetry: no tenant, Companion, turn, prompt, or provider identifier leaves SQL.
DROP FUNCTION IF EXISTS public.companion_runtime_recovery_metrics();
CREATE FUNCTION public.companion_runtime_recovery_metrics()
RETURNS TABLE(
  pending_recovery_count bigint,
  oldest_recovery_age_seconds double precision,
  auto_abandoned_count bigint,
  stalled_recovery_count bigint,
  max_recovery_attempt_count integer
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
      WHERE recovery.kind = 'restart_pi' AND recovery.trigger = 'recovery'
        AND recovery.status IN ('pending', 'running')),
    (SELECT GREATEST(0, extract(epoch FROM clock_timestamp() - min(recovery.created_at)))
      FROM public.companion_operations recovery
      WHERE recovery.kind = 'restart_pi' AND recovery.trigger = 'recovery'
        AND recovery.status IN ('pending', 'running')),
    (SELECT count(*) FROM public.companion_turns turn_row
      WHERE turn_row.resolution = 'auto_abandoned'),
    (SELECT count(*)
      FROM public.companion_operations recovery
      WHERE recovery.kind = 'restart_pi' AND recovery.trigger = 'recovery'
        AND recovery.status IN ('pending', 'running')
        AND recovery.created_at < clock_timestamp() - interval '15 minutes'),
    (SELECT COALESCE(max(recovery.attempt_count), 0)
      FROM public.companion_operations recovery
      WHERE recovery.kind = 'restart_pi' AND recovery.trigger = 'recovery'
        AND recovery.status IN ('pending', 'running'))
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_runtime_recovery_metrics() FROM PUBLIC;
--> statement-breakpoint

-- Protocol 7 is the cleanup-only claim boundary. Protocol-5/6 executors can finish already-fenced
-- leases through their existing functions, but receive no new work after this migration commits.
DO $companion_cleanup_claim_protocol$
DECLARE
  v_signature text :=
    'public.companion_runtime_claim_work(text,integer,integer,bigint,integer,integer)';
  v_definition text := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_signature));
  v_old text := 'IF p_material_protocol IS DISTINCT FROM 6 THEN RETURN; END IF;';
  v_new text := 'IF p_material_protocol IS DISTINCT FROM 7 THEN RETURN; END IF;';
  v_count integer;
BEGIN
  v_count := (char_length(v_definition) - char_length(replace(v_definition, v_old, '')))
    / char_length(v_old);
  IF v_definition IS NULL OR v_count <> 1 THEN
    RAISE EXCEPTION 'cleanup claim protocol matched %, expected 1', COALESCE(v_count, 0)
      USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(v_definition, v_old, v_new);
END
$companion_cleanup_claim_protocol$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_runtime_claim_work(
  text,integer,integer,bigint,integer,integer
) FROM PUBLIC;
--> statement-breakpoint

DO $companion_protocol_7_runtime_acl$
DECLARE
  v_source oid := pg_catalog.to_regprocedure(
    'public.companion_runtime_renew_and_authorize_v2(uuid,uuid,uuid,bigint,bigint,text,'
    || 'public.companion_runtime_work_kind,uuid,integer)'
  );
  v_grantee oid;
  v_role name;
BEGIN
  SELECT acl.grantee INTO v_grantee
  FROM pg_catalog.pg_proc source_proc
  CROSS JOIN LATERAL pg_catalog.aclexplode(
    COALESCE(source_proc.proacl, pg_catalog.acldefault('f', source_proc.proowner))
  ) acl
  WHERE source_proc.oid = v_source
    AND acl.privilege_type = 'EXECUTE'
    AND acl.grantee NOT IN (source_proc.proowner, 0)
  LIMIT 1;
  IF v_grantee IS NOT NULL THEN
    SELECT role_row.rolname INTO STRICT v_role
    FROM pg_catalog.pg_roles role_row WHERE role_row.oid = v_grantee;
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION public.companion_runtime_claim_work('
      || 'text,integer,integer,bigint,integer,integer) TO %I', v_role
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION public.companion_runtime_renew_and_authorize_v3('
      || 'uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer) TO %I',
      v_role
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION public.companion_runtime_recovery_metrics() TO %I', v_role
    );
  END IF;
END
$companion_protocol_7_runtime_acl$;
--> statement-breakpoint
