-- THE-517: one persistent Box may be archived for cost, resumed for admitted work, and removed
-- only after runtime-owned provider absence proof. Lifecycle owns a separate fenced lease so API,
-- worker, reads, and Turn convergence never contact the provider or extend the warm window.
CREATE TYPE public.companion_v3_lifecycle_state AS ENUM (
  'active',
  'archive_pending', 'archive_requested', 'waiting_archived', 'archived',
  'wake_pending', 'wake_requested', 'waiting_ready',
  'delete_pending', 'delete_requested', 'delete_dispatched', 'waiting_deleted'
);
--> statement-breakpoint

ALTER TABLE public.companion_v3_instances
  ADD COLUMN lifecycle_state public.companion_v3_lifecycle_state NOT NULL DEFAULT 'active',
  ADD COLUMN last_work_accepted_at timestamp with time zone,
  ADD COLUMN lifecycle_available_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN lifecycle_error_code text,
  ADD COLUMN lifecycle_error_message text,
  ADD COLUMN lifecycle_claim_token uuid,
  ADD COLUMN lifecycle_claim_epoch bigint NOT NULL DEFAULT 0,
  ADD COLUMN lifecycle_gate_epoch bigint,
  ADD COLUMN lifecycle_executor_id text,
  ADD COLUMN lifecycle_claimed_at timestamp with time zone,
  ADD COLUMN lifecycle_expires_at timestamp with time zone,
  ADD COLUMN delete_provider_operation_id text,
  ADD COLUMN desired_lifecycle_request_id uuid;
--> statement-breakpoint
UPDATE public.companion_v3_instances
SET last_work_accepted_at = created_at
WHERE last_work_accepted_at IS NULL;
--> statement-breakpoint
ALTER TABLE public.companion_v3_instances
  ALTER COLUMN last_work_accepted_at SET NOT NULL,
  ALTER COLUMN last_work_accepted_at SET DEFAULT clock_timestamp(),
  ADD CONSTRAINT companion_v3_instances_lifecycle_check CHECK (
    lifecycle_claim_epoch >= 0
    AND (lifecycle_error_code IS NULL) = (lifecycle_error_message IS NULL)
    AND (lifecycle_error_code IS NULL OR (
      lifecycle_error_code ~ '^[a-z][a-z0-9_]{0,63}$'
      AND char_length(lifecycle_error_message) BETWEEN 1 AND 500
      AND lifecycle_error_message !~ E'[\n\r]'
    ))
    AND (delete_provider_operation_id IS NULL OR (
      lifecycle_state = 'waiting_deleted'
      AND char_length(delete_provider_operation_id) BETWEEN 1 AND 200
      AND delete_provider_operation_id !~ E'[\n\r]'
    ))
    AND (
      (lifecycle_claim_token IS NULL AND lifecycle_gate_epoch IS NULL
        AND lifecycle_executor_id IS NULL AND lifecycle_claimed_at IS NULL
        AND lifecycle_expires_at IS NULL)
      OR (lifecycle_claim_token IS NOT NULL AND lifecycle_claim_epoch >= 1
        AND lifecycle_gate_epoch IS NOT NULL AND lifecycle_executor_id IS NOT NULL
        AND lifecycle_claimed_at IS NOT NULL
        AND lifecycle_expires_at > lifecycle_claimed_at)
    )
  );
--> statement-breakpoint
CREATE INDEX companion_v3_instances_lifecycle_idx
  ON public.companion_v3_instances(lifecycle_available_at, last_work_accepted_at, created_at)
  WHERE lifecycle_state <> 'active' OR desired_lifecycle <> 'prepare'
    OR box_id IS NOT NULL;
--> statement-breakpoint

-- Configuration invalidation may happen while the Box is archived. It invalidates the staged
-- proof, but only admitted work may make preparation claimable and wake the Box.
CREATE OR REPLACE FUNCTION public.companion_v3_invalidate_preparation(
  p_org_id uuid, p_companion_id uuid
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = on AS $$
BEGIN
  UPDATE public.companion_v3_instances instance SET
    preparation_checkpoint = CASE WHEN instance.box_id IS NULL THEN 'pending' ELSE 'box_ready' END,
    staging_completed_at = NULL, pi_invocation_id = NULL, prepared_at = NULL,
    preparation_actor_id = NULL, preparation_settings_revision = NULL,
    preparation_skills_revision = NULL, preparation_model_id = NULL,
    preparation_provider_refs = NULL, preparation_skill_refs = NULL,
    preparation_mcp_refs = NULL, prepared_disk_layout_version = NULL,
    prepared_skills_digest = NULL, prepared_material_expires_at = NULL,
    preparation_available_at = CASE WHEN instance.lifecycle_state = 'active'
      THEN clock_timestamp() ELSE 'infinity'::timestamptz END,
    preparation_claim_token = NULL, preparation_gate_epoch = NULL,
    preparation_executor_id = NULL, preparation_claimed_at = NULL,
    preparation_expires_at = NULL, updated_at = clock_timestamp()
  WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id
    AND instance.desired_lifecycle = 'prepare';
END $$;
--> statement-breakpoint

CREATE TABLE public.companion_v3_lifecycle_requests (
  org_id uuid NOT NULL,
  companion_id uuid NOT NULL,
  request_id uuid NOT NULL,
  actor_id text NOT NULL,
  intent public.companion_v3_lifecycle_intent NOT NULL,
  revision bigint NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT companion_v3_lifecycle_requests_pk PRIMARY KEY (org_id, companion_id, request_id),
  CONSTRAINT companion_v3_lifecycle_requests_instance_fk FOREIGN KEY (org_id, companion_id)
    REFERENCES public.companion_v3_instances(org_id, companion_id) ON DELETE CASCADE,
  CONSTRAINT companion_v3_lifecycle_requests_revision_check CHECK (revision >= 1),
  CONSTRAINT companion_v3_lifecycle_requests_actor_check CHECK (
    char_length(actor_id) BETWEEN 1 AND 200 AND actor_id !~ E'[\n\r]'
  )
);
--> statement-breakpoint
ALTER TABLE public.companion_v3_lifecycle_requests ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.companion_v3_lifecycle_requests FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY companion_v3_lifecycle_requests_function_owner_rls
  ON public.companion_v3_lifecycle_requests FOR ALL
  USING (current_user = pg_get_userbyid((
    SELECT procedure.proowner FROM pg_proc procedure
    WHERE procedure.oid = 'public.companion_v3_admit_turn(uuid,uuid,uuid,text,text,public.companion_v3_lane)'::regprocedure
  )))
  WITH CHECK (current_user = pg_get_userbyid((
    SELECT procedure.proowner FROM pg_proc procedure
    WHERE procedure.oid = 'public.companion_v3_admit_turn(uuid,uuid,uuid,text,text,public.companion_v3_lane)'::regprocedure
  )));
--> statement-breakpoint
REVOKE ALL ON TABLE public.companion_v3_lifecycle_requests FROM PUBLIC;
--> statement-breakpoint

-- A new admitted occurrence is the only normal wake signal. The AFTER trigger runs only for the
-- first insert, so replaying client_message_id cannot keep a Box warm. Background admission uses
-- the same helper and therefore gets identical behavior without giving the worker provider access.
CREATE FUNCTION public.companion_v3_note_admitted_work()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = on AS $$
DECLARE v_instance public.companion_v3_instances%ROWTYPE;
BEGIN
  SELECT instance.* INTO STRICT v_instance FROM public.companion_v3_instances instance
  WHERE instance.org_id = NEW.org_id AND instance.companion_id = NEW.companion_id
  FOR UPDATE;
  IF v_instance.desired_lifecycle = 'delete'
    OR v_instance.lifecycle_state IN (
      'delete_pending','delete_requested','delete_dispatched','waiting_deleted'
    ) THEN
    RAISE EXCEPTION 'Companion is being permanently deleted' USING ERRCODE = '55000';
  END IF;
  UPDATE public.companion_v3_instances instance SET
    last_work_accepted_at = NEW.accepted_at,
    desired_lifecycle = 'prepare',
    desired_lifecycle_revision = CASE
      WHEN instance.desired_lifecycle = 'prepare' AND instance.lifecycle_state = 'active'
        THEN instance.desired_lifecycle_revision
      ELSE instance.desired_lifecycle_revision + 1 END,
    desired_lifecycle_actor_id = NEW.actor_id,
    desired_lifecycle_request_id = NULL,
    lifecycle_state = CASE
      WHEN instance.lifecycle_state = 'active' THEN 'active'::public.companion_v3_lifecycle_state
      WHEN instance.lifecycle_state IN ('archived','wake_pending','wake_requested','waiting_ready')
        THEN 'wake_pending'::public.companion_v3_lifecycle_state
      ELSE instance.lifecycle_state END,
    lifecycle_available_at = CASE WHEN instance.lifecycle_state = 'active'
      THEN instance.lifecycle_available_at ELSE clock_timestamp() END,
    preparation_available_at = CASE WHEN instance.lifecycle_state = 'active'
      THEN instance.preparation_available_at ELSE 'infinity'::timestamptz END,
    lifecycle_error_code = NULL, lifecycle_error_message = NULL,
    updated_at = clock_timestamp()
  WHERE instance.org_id = NEW.org_id AND instance.companion_id = NEW.companion_id;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER companion_v3_note_admitted_work
AFTER INSERT ON public.companion_v3_turns
FOR EACH ROW EXECUTE FUNCTION public.companion_v3_note_admitted_work();
--> statement-breakpoint

-- Explicit Stop/Resume/Delete intent is replay-safe by request id. Delete remains Owner-only;
-- archive/prepare require Editor. Preparing an archived or in-flight archive schedules wake after
-- archive completes, rather than racing Pi start against the provider transition.
CREATE FUNCTION public.companion_v3_api_desire_lifecycle(
  p_org_id uuid,
  p_companion_id uuid,
  p_intent public.companion_v3_lifecycle_intent,
  p_request_id uuid
)
RETURNS TABLE (intent public.companion_v3_lifecycle_intent, revision bigint)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = on AS $$
DECLARE
  v_actor_id text := public.companion_api_actor(p_org_id);
  v_existing public.companion_v3_lifecycle_requests%ROWTYPE;
  v_revision bigint;
BEGIN
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'Runtime v3 lifecycle request id is required' USING ERRCODE = '22023';
  END IF;
  PERFORM public.companion_api_require_access(p_org_id, p_companion_id,
    CASE WHEN p_intent = 'delete' THEN 'owner' ELSE 'editor' END);
  PERFORM 1 FROM public.companion_v3_instances instance
  WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Companion not found' USING ERRCODE = 'P0002'; END IF;
  SELECT request.* INTO v_existing FROM public.companion_v3_lifecycle_requests request
  WHERE request.org_id = p_org_id AND request.companion_id = p_companion_id
    AND request.request_id = p_request_id;
  IF FOUND THEN
    IF v_existing.actor_id IS DISTINCT FROM v_actor_id
      OR v_existing.intent IS DISTINCT FROM p_intent THEN
      RAISE EXCEPTION 'request_id was reused with different Runtime v3 lifecycle intent'
        USING ERRCODE = '23505', CONSTRAINT = 'companion_v3_lifecycle_requests_pk';
    END IF;
    RETURN QUERY SELECT v_existing.intent, v_existing.revision;
    RETURN;
  END IF;

  UPDATE public.companion_v3_instances instance SET
    desired_lifecycle = p_intent,
    desired_lifecycle_revision = instance.desired_lifecycle_revision + 1,
    desired_lifecycle_actor_id = v_actor_id,
    desired_lifecycle_request_id = p_request_id,
    lifecycle_state = CASE
      WHEN p_intent = 'delete' AND instance.lifecycle_state IN (
        'delete_pending','delete_requested','delete_dispatched','waiting_deleted'
      ) THEN instance.lifecycle_state
      WHEN p_intent = 'delete' THEN 'delete_pending'::public.companion_v3_lifecycle_state
      WHEN p_intent = 'archive' AND instance.lifecycle_state <> 'archived'
        THEN 'archive_pending'::public.companion_v3_lifecycle_state
      WHEN p_intent = 'archive' THEN 'archived'::public.companion_v3_lifecycle_state
      WHEN p_intent = 'prepare' AND instance.lifecycle_state <> 'active'
        THEN 'wake_pending'::public.companion_v3_lifecycle_state
      ELSE instance.lifecycle_state END,
    preparation_checkpoint = CASE WHEN p_intent IN ('archive','delete')
      THEN CASE WHEN instance.box_id IS NULL THEN 'pending' ELSE 'box_created' END
      ELSE instance.preparation_checkpoint END,
    box_ready_at = CASE WHEN p_intent IN ('archive','delete') THEN NULL ELSE instance.box_ready_at END,
    staging_completed_at = CASE WHEN p_intent IN ('archive','delete')
      THEN NULL ELSE instance.staging_completed_at END,
    pi_invocation_id = CASE WHEN p_intent IN ('archive','delete')
      THEN NULL ELSE instance.pi_invocation_id END,
    prepared_at = CASE WHEN p_intent IN ('archive','delete') THEN NULL ELSE instance.prepared_at END,
    prepared_disk_layout_version = CASE WHEN p_intent IN ('archive','delete')
      THEN NULL ELSE instance.prepared_disk_layout_version END,
    prepared_skills_digest = CASE WHEN p_intent IN ('archive','delete')
      THEN NULL ELSE instance.prepared_skills_digest END,
    prepared_material_expires_at = CASE WHEN p_intent IN ('archive','delete')
      THEN NULL ELSE instance.prepared_material_expires_at END,
    preparation_available_at = CASE
      WHEN p_intent = 'prepare' AND instance.lifecycle_state = 'active' THEN clock_timestamp()
      ELSE 'infinity'::timestamptz END,
    lifecycle_available_at = clock_timestamp(),
    lifecycle_error_code = NULL, lifecycle_error_message = NULL,
    delete_provider_operation_id = CASE
      WHEN p_intent = 'delete' AND instance.lifecycle_state IN (
        'delete_pending','delete_requested','delete_dispatched','waiting_deleted'
      ) THEN instance.delete_provider_operation_id
      WHEN p_intent = 'delete' THEN NULL
      ELSE instance.delete_provider_operation_id END,
    updated_at = clock_timestamp()
  WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id
  RETURNING instance.desired_lifecycle_revision INTO v_revision;
  INSERT INTO public.companion_v3_lifecycle_requests(
    org_id, companion_id, request_id, actor_id, intent, revision
  ) VALUES (p_org_id, p_companion_id, p_request_id, v_actor_id, p_intent, v_revision);
  RETURN QUERY SELECT p_intent, v_revision;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.companion_v3_api_desire_lifecycle(
  p_org_id uuid,
  p_companion_id uuid,
  p_intent public.companion_v3_lifecycle_intent
)
RETURNS TABLE (intent public.companion_v3_lifecycle_intent, revision bigint)
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = on AS $$
  SELECT requested.intent, requested.revision
  FROM public.companion_v3_api_desire_lifecycle(
    p_org_id, p_companion_id, p_intent, gen_random_uuid()
  ) requested
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_runtime_claim_lifecycle(
  p_executor_id text, p_lease_seconds integer, p_protocol integer
)
RETURNS TABLE (
  org_id uuid, companion_id uuid, checkpoint public.companion_v3_lifecycle_state,
  box_id text, provider_operation_id text, claim_token uuid, claim_epoch bigint,
  gate_epoch bigint
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = on AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_gate bigint;
  v_instance public.companion_v3_instances%ROWTYPE;
BEGIN
  IF p_protocol IS DISTINCT FROM 5 OR p_executor_id IS NULL
    OR char_length(p_executor_id) NOT BETWEEN 1 AND 200 OR p_executor_id ~ E'[\n\r]'
    OR p_lease_seconds NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION 'invalid Runtime v3 lifecycle claim' USING ERRCODE = '22023';
  END IF;
  SELECT control.gate_epoch INTO v_gate FROM public.companion_runtime_control control
  WHERE control.id = 'runtime-v2' AND control.enabled FOR SHARE;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT instance.* INTO v_instance
  FROM public.companion_v3_instances instance
  JOIN public.companions companion
    ON companion.org_id = instance.org_id AND companion.id = instance.companion_id
  WHERE instance.lifecycle_available_at <= v_now
    AND (instance.lifecycle_claim_token IS NULL OR instance.lifecycle_expires_at <= v_now)
    AND (instance.preparation_claim_token IS NULL OR instance.preparation_expires_at <= v_now)
    AND NOT EXISTS (
      SELECT 1 FROM public.companion_v3_lane_leases lease
      WHERE lease.org_id = instance.org_id AND lease.companion_id = instance.companion_id
        AND lease.claim_token IS NOT NULL AND lease.expires_at > v_now
    )
    AND (
      instance.lifecycle_state IN (
        'archive_pending','archive_requested','waiting_archived',
        'wake_pending','wake_requested','waiting_ready',
        'delete_pending','delete_requested','delete_dispatched','waiting_deleted'
      )
      OR (instance.lifecycle_state = 'active'
        AND instance.desired_lifecycle IN ('archive','delete'))
      OR (
        instance.lifecycle_state = 'active'
        AND instance.desired_lifecycle = 'prepare'
        AND instance.box_id IS NOT NULL
        AND instance.last_work_accepted_at <= v_now - interval '1 hour'
        AND NOT EXISTS (
          SELECT 1 FROM public.companion_v3_turns turn_row
          WHERE turn_row.org_id = instance.org_id
            AND turn_row.companion_id = instance.companion_id
            AND turn_row.state IN ('queued','admitted','running','needs_input')
        )
      )
    )
    AND (
      (instance.lifecycle_state = 'active' AND instance.desired_lifecycle = 'prepare')
      OR
      instance.desired_lifecycle_actor_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.memberships membership
        LEFT JOIN public.companion_workspace_access access
          ON access.org_id = instance.org_id AND access.companion_id = instance.companion_id
        WHERE membership.org_id = instance.org_id
          AND membership.user_id = instance.desired_lifecycle_actor_id
          AND (
            companion.owner_id = instance.desired_lifecycle_actor_id
            OR (instance.desired_lifecycle <> 'delete' AND access.role = 'editor')
          )
      )
    )
  ORDER BY (instance.desired_lifecycle = 'delete') DESC,
    instance.lifecycle_available_at, instance.last_work_accepted_at, instance.created_at
  LIMIT 1 FOR UPDATE OF instance SKIP LOCKED;
  IF NOT FOUND THEN RETURN; END IF;

  UPDATE public.companion_v3_instances instance SET
    desired_lifecycle = CASE
      WHEN v_instance.lifecycle_state = 'active' AND v_instance.desired_lifecycle = 'prepare'
        THEN 'archive'::public.companion_v3_lifecycle_intent
      ELSE instance.desired_lifecycle END,
    desired_lifecycle_revision = CASE
      WHEN v_instance.lifecycle_state = 'active' AND v_instance.desired_lifecycle = 'prepare'
        THEN instance.desired_lifecycle_revision + 1 ELSE instance.desired_lifecycle_revision END,
    desired_lifecycle_actor_id = CASE
      WHEN v_instance.lifecycle_state = 'active' AND v_instance.desired_lifecycle = 'prepare'
        THEN NULL ELSE instance.desired_lifecycle_actor_id END,
    desired_lifecycle_request_id = CASE
      WHEN v_instance.lifecycle_state = 'active' AND v_instance.desired_lifecycle = 'prepare'
        THEN NULL ELSE instance.desired_lifecycle_request_id END,
    lifecycle_state = CASE
      WHEN v_instance.lifecycle_state = 'active' AND v_instance.desired_lifecycle = 'delete'
        THEN 'delete_pending'::public.companion_v3_lifecycle_state
      WHEN v_instance.lifecycle_state = 'active'
        THEN 'archive_pending'::public.companion_v3_lifecycle_state
      ELSE instance.lifecycle_state END,
    preparation_checkpoint = CASE WHEN v_instance.lifecycle_state = 'active'
      THEN CASE WHEN v_instance.box_id IS NULL THEN 'pending' ELSE 'box_created' END
      ELSE instance.preparation_checkpoint END,
    box_ready_at = CASE WHEN v_instance.lifecycle_state = 'active' THEN NULL ELSE instance.box_ready_at END,
    staging_completed_at = CASE WHEN v_instance.lifecycle_state = 'active'
      THEN NULL ELSE instance.staging_completed_at END,
    pi_invocation_id = CASE WHEN v_instance.lifecycle_state = 'active'
      THEN NULL ELSE instance.pi_invocation_id END,
    prepared_at = CASE WHEN v_instance.lifecycle_state = 'active' THEN NULL ELSE instance.prepared_at END,
    prepared_disk_layout_version = CASE WHEN v_instance.lifecycle_state = 'active'
      THEN NULL ELSE instance.prepared_disk_layout_version END,
    prepared_skills_digest = CASE WHEN v_instance.lifecycle_state = 'active'
      THEN NULL ELSE instance.prepared_skills_digest END,
    prepared_material_expires_at = CASE WHEN v_instance.lifecycle_state = 'active'
      THEN NULL ELSE instance.prepared_material_expires_at END,
    preparation_available_at = CASE WHEN v_instance.lifecycle_state = 'active'
      THEN 'infinity'::timestamptz ELSE instance.preparation_available_at END,
    lifecycle_claim_token = gen_random_uuid(),
    lifecycle_claim_epoch = instance.lifecycle_claim_epoch + 1,
    lifecycle_gate_epoch = v_gate, lifecycle_executor_id = p_executor_id,
    lifecycle_claimed_at = v_now,
    lifecycle_expires_at = v_now + make_interval(secs => p_lease_seconds),
    updated_at = v_now
  WHERE instance.org_id = v_instance.org_id AND instance.companion_id = v_instance.companion_id
  RETURNING instance.org_id, instance.companion_id, instance.lifecycle_state,
    instance.box_id, instance.delete_provider_operation_id,
    instance.lifecycle_claim_token, instance.lifecycle_claim_epoch,
    instance.lifecycle_gate_epoch
  INTO org_id, companion_id, checkpoint, box_id, provider_operation_id,
    claim_token, claim_epoch, gate_epoch;
  RETURN NEXT;
END $$;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_runtime_checkpoint_lifecycle(
  p_org_id uuid, p_companion_id uuid, p_claim_token uuid, p_claim_epoch bigint,
  p_gate_epoch bigint, p_expected public.companion_v3_lifecycle_state,
  p_next public.companion_v3_lifecycle_state, p_provider_operation_id text,
  p_protocol integer
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = on AS $$
DECLARE v_now timestamptz := clock_timestamp();
BEGIN
  IF p_protocol IS DISTINCT FROM 5 OR NOT (
    (p_expected = 'archive_pending' AND p_next = 'archive_requested')
    OR (p_expected = 'archive_requested' AND p_next IN ('waiting_archived','archived'))
    OR (p_expected = 'waiting_archived' AND p_next = 'archived')
    OR (p_expected = 'wake_pending' AND p_next = 'wake_requested')
    OR (p_expected = 'wake_requested' AND p_next IN ('waiting_ready','active'))
    OR (p_expected = 'waiting_ready' AND p_next = 'active')
    OR (p_expected = 'delete_pending' AND p_next = 'delete_requested')
    OR (p_expected = 'delete_requested' AND p_next = 'delete_dispatched')
    OR (p_expected = 'delete_dispatched' AND p_next = 'waiting_deleted')
  ) OR ((p_next = 'waiting_deleted') <> (p_provider_operation_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'invalid Runtime v3 lifecycle checkpoint' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.companion_runtime_control control
  WHERE control.id = 'runtime-v2' AND control.enabled AND control.gate_epoch = p_gate_epoch
  FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM 1 FROM public.companion_v3_instances instance
  WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id
    AND instance.lifecycle_state = p_expected
    AND instance.lifecycle_claim_token = p_claim_token
    AND instance.lifecycle_claim_epoch = p_claim_epoch
    AND instance.lifecycle_gate_epoch = p_gate_epoch
    AND instance.lifecycle_expires_at > v_now FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  IF p_next IN ('archive_requested','delete_requested') THEN
    UPDATE public.api_tokens token SET revoked_at = coalesce(token.revoked_at, v_now)
    FROM public.companion_v3_instances instance
    WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id
      AND token.id = instance.hub_token_id;
    UPDATE public.companion_mcp_broker_tokens token SET revoked_at = coalesce(token.revoked_at, v_now)
    FROM public.companion_v3_instances instance
    WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id
      AND token.id = instance.mcp_broker_token_id;
    UPDATE public.companion_control_tokens token SET revoked_at = coalesce(token.revoked_at, v_now)
    FROM public.companion_v3_instances instance
    WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id
      AND token.id = instance.control_token_id;
  END IF;

  UPDATE public.companion_v3_instances instance SET
    lifecycle_state = CASE
      WHEN p_next = 'archived' AND instance.desired_lifecycle = 'prepare'
        THEN 'wake_pending'::public.companion_v3_lifecycle_state
      ELSE p_next END,
    desired_lifecycle = CASE WHEN p_next = 'active'
      THEN 'prepare'::public.companion_v3_lifecycle_intent ELSE instance.desired_lifecycle END,
    preparation_checkpoint = CASE WHEN p_next = 'active'
      THEN 'box_ready' ELSE instance.preparation_checkpoint END,
    box_ready_at = CASE WHEN p_next = 'active' THEN v_now ELSE instance.box_ready_at END,
    preparation_available_at = CASE WHEN p_next = 'active'
      THEN v_now ELSE instance.preparation_available_at END,
    delete_provider_operation_id = CASE WHEN p_next = 'waiting_deleted'
      THEN p_provider_operation_id ELSE instance.delete_provider_operation_id END,
    hub_token_id = CASE WHEN p_next IN ('archive_requested','delete_requested')
      THEN NULL ELSE instance.hub_token_id END,
    mcp_broker_token_id = CASE WHEN p_next IN ('archive_requested','delete_requested')
      THEN NULL ELSE instance.mcp_broker_token_id END,
    control_token_id = CASE WHEN p_next IN ('archive_requested','delete_requested')
      THEN NULL ELSE instance.control_token_id END,
    lifecycle_available_at = v_now,
    lifecycle_error_code = NULL, lifecycle_error_message = NULL,
    lifecycle_claim_token = CASE WHEN p_next = 'delete_dispatched'
      THEN instance.lifecycle_claim_token ELSE NULL END,
    lifecycle_gate_epoch = CASE WHEN p_next = 'delete_dispatched'
      THEN instance.lifecycle_gate_epoch ELSE NULL END,
    lifecycle_executor_id = CASE WHEN p_next = 'delete_dispatched'
      THEN instance.lifecycle_executor_id ELSE NULL END,
    lifecycle_claimed_at = CASE WHEN p_next = 'delete_dispatched'
      THEN instance.lifecycle_claimed_at ELSE NULL END,
    lifecycle_expires_at = CASE WHEN p_next = 'delete_dispatched'
      THEN instance.lifecycle_expires_at ELSE NULL END,
    updated_at = v_now
  WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id
    AND instance.lifecycle_claim_token = p_claim_token
    AND instance.lifecycle_claim_epoch = p_claim_epoch;
  RETURN FOUND;
END $$;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_runtime_defer_lifecycle(
  p_org_id uuid, p_companion_id uuid, p_claim_token uuid, p_claim_epoch bigint,
  p_gate_epoch bigint, p_delay_seconds integer, p_error_code text, p_error_message text,
  p_protocol integer
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = on AS $$
DECLARE v_now timestamptz := clock_timestamp();
BEGIN
  IF p_protocol IS DISTINCT FROM 5 OR p_delay_seconds NOT BETWEEN 1 AND 300
    OR ((p_error_code IS NULL) <> (p_error_message IS NULL)) THEN
    RAISE EXCEPTION 'invalid Runtime v3 lifecycle deferral' USING ERRCODE = '22023';
  END IF;
  UPDATE public.companion_v3_instances instance SET
    lifecycle_available_at = v_now + make_interval(secs => p_delay_seconds),
    lifecycle_error_code = p_error_code, lifecycle_error_message = p_error_message,
    lifecycle_claim_token = NULL, lifecycle_gate_epoch = NULL,
    lifecycle_executor_id = NULL, lifecycle_claimed_at = NULL, lifecycle_expires_at = NULL,
    updated_at = v_now
  FROM public.companion_runtime_control control
  WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id
    AND instance.lifecycle_claim_token = p_claim_token
    AND instance.lifecycle_claim_epoch = p_claim_epoch
    AND instance.lifecycle_gate_epoch = p_gate_epoch AND instance.lifecycle_expires_at > v_now
    AND control.id = 'runtime-v2' AND control.enabled AND control.gate_epoch = p_gate_epoch;
  RETURN FOUND;
END $$;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_runtime_finalize_delete(
  p_org_id uuid, p_companion_id uuid, p_claim_token uuid, p_claim_epoch bigint,
  p_gate_epoch bigint, p_protocol integer
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = on AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_actor text;
  v_request uuid;
  v_previous_protocol text;
BEGIN
  IF p_protocol IS DISTINCT FROM 5 THEN
    RAISE EXCEPTION 'Runtime v3 lifecycle protocol is required' USING ERRCODE = '42501';
  END IF;
  SELECT instance.desired_lifecycle_actor_id, instance.desired_lifecycle_request_id
  INTO v_actor, v_request FROM public.companion_v3_instances instance
  JOIN public.companion_runtime_control control
    ON control.id = 'runtime-v2' AND control.enabled AND control.gate_epoch = p_gate_epoch
  WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id
    AND instance.desired_lifecycle = 'delete'
    AND instance.lifecycle_state IN ('delete_requested','delete_dispatched','waiting_deleted')
    AND instance.lifecycle_claim_token = p_claim_token
    AND instance.lifecycle_claim_epoch = p_claim_epoch
    AND instance.lifecycle_gate_epoch = p_gate_epoch
    AND instance.lifecycle_expires_at > v_now FOR UPDATE OF instance;
  IF NOT FOUND THEN RETURN false; END IF;

  INSERT INTO public.audit_log(org_id, actor_id, action, target_type, target_id, metadata)
  VALUES (
    p_org_id,
    CASE WHEN EXISTS (SELECT 1 FROM public."user" member WHERE member.id = v_actor)
      THEN v_actor ELSE NULL END,
    'companion.deleted', 'companion', p_companion_id::text,
    jsonb_build_object('request_id', v_request::text, 'provider_absence', true)
  );
  UPDATE public.companion_runtime_instances instance SET
    settings_claim_turn_id = NULL, settings_claim_cold_start_deadline_at = NULL,
    updated_at = v_now
  WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id;
  UPDATE public.companion_operations operation SET source_turn_id = NULL, updated_at = v_now
  WHERE operation.org_id = p_org_id AND operation.companion_id = p_companion_id
    AND operation.source_turn_id IS NOT NULL;
  v_previous_protocol := pg_catalog.current_setting('app.companion_runtime_protocol', true);
  PERFORM pg_catalog.set_config('app.companion_runtime_protocol', '2', true);
  DELETE FROM public.companions companion
  WHERE companion.org_id = p_org_id AND companion.id = p_companion_id;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM pg_catalog.set_config(
    'app.companion_runtime_protocol', coalesce(v_previous_protocol, ''), true
  );
  RETURN true;
END $$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_v3_note_admitted_work() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_v3_api_desire_lifecycle(
  uuid,uuid,public.companion_v3_lifecycle_intent,uuid
) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_v3_api_desire_lifecycle(
  uuid,uuid,public.companion_v3_lifecycle_intent
) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_v3_runtime_claim_lifecycle(text,integer,integer) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_v3_runtime_checkpoint_lifecycle(
  uuid,uuid,uuid,bigint,bigint,public.companion_v3_lifecycle_state,
  public.companion_v3_lifecycle_state,text,integer
) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_v3_runtime_defer_lifecycle(
  uuid,uuid,uuid,bigint,bigint,integer,text,text,integer
) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_v3_runtime_finalize_delete(
  uuid,uuid,uuid,bigint,bigint,integer
) FROM PUBLIC;
