-- Product-owned Companion control MCP: hash-only runtime capability, asynchronous approvals,
-- directed peer grants, and bounded Companion-to-Companion delegation.

CREATE TYPE public.companion_control_request_kind AS ENUM (
  'model_change', 'plugin_connection', 'routine_change', 'trigger_change', 'peer_access'
);
CREATE TYPE public.companion_control_request_status AS ENUM (
  'pending', 'applying', 'applied', 'denied', 'expired', 'cancelled', 'failed'
);
CREATE TYPE public.companion_delegation_delivery_status AS ENUM ('pending', 'delivered', 'failed');
--> statement-breakpoint

CREATE TABLE public.companion_control_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  companion_id uuid NOT NULL,
  staged_actor_id text NOT NULL,
  token_prefix text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT companion_control_tokens_companion_fk FOREIGN KEY (org_id, companion_id)
    REFERENCES public.companions(org_id, id) ON DELETE CASCADE,
  CONSTRAINT companion_control_tokens_actor_membership_fk FOREIGN KEY (org_id, staged_actor_id)
    REFERENCES public.memberships(org_id, user_id) ON DELETE CASCADE
);
CREATE INDEX companion_control_tokens_expiry_idx ON public.companion_control_tokens(expires_at);

ALTER TABLE public.companion_runtime_instances
  ADD COLUMN control_token_id uuid REFERENCES public.companion_control_tokens(id) ON DELETE SET NULL;
-- Native snapshots created before the unified control surface intentionally had no expiring
-- credentials. They cannot prove possession of the new bounded control/plugin capabilities, so
-- invalidate them and let the normal claim path restage instead of assigning a synthetic expiry.
UPDATE public.companion_runtime_instances
SET material_client_surface=NULL,material_pi_invocation_id=NULL,material_expires_at=NULL
WHERE material_client_surface='native_mobile' AND material_expires_at IS NULL;
UPDATE public.companion_runtime_instances
SET settings_claim_material_client_surface=NULL,settings_claim_material_staged_at=NULL,
    settings_claim_material_expires_at=NULL
WHERE settings_claim_material_client_surface='native_mobile'
  AND settings_claim_material_expires_at IS NULL;
UPDATE public.companion_operations
SET material_staged_at=NULL,material_expires_at=NULL
WHERE client_surface='native_mobile' AND material_staged_at IS NOT NULL
  AND material_expires_at IS NULL;
ALTER TABLE public.companion_runtime_instances
  DROP CONSTRAINT companion_runtime_instances_material_snapshot_check,
  ADD CONSTRAINT companion_runtime_instances_material_snapshot_check CHECK (
    ((material_client_surface IS NULL) = (material_pi_invocation_id IS NULL))
    AND (material_client_surface IS NOT NULL OR material_expires_at IS NULL)
    AND (material_pi_invocation_id IS NULL OR (
      char_length(material_pi_invocation_id) BETWEEN 1 AND 200
      AND material_pi_invocation_id !~ E'[\n\r]'
    ))
    AND (material_client_surface IS NULL OR material_expires_at IS NOT NULL)
    AND ((settings_claim_material_client_surface IS NULL) = (settings_claim_material_staged_at IS NULL))
    AND (settings_claim_material_staged_at IS NULL OR settings_claim_material_expires_at IS NOT NULL)
  );
ALTER TABLE public.companion_operations
  DROP CONSTRAINT companion_operations_material_snapshot_check,
  ADD CONSTRAINT companion_operations_material_snapshot_check CHECK (
    (material_staged_at IS NOT NULL OR material_expires_at IS NULL)
    AND (material_staged_at IS NULL OR material_expires_at IS NOT NULL)
  );
--> statement-breakpoint

-- First-party clients share one runtime capability contract. Remove the legacy native-mobile
-- reductions; because the unified material now contains expiring control and plugin capabilities,
-- native snapshots follow the same bounded-expiry rule as web snapshots from this migration on.
DO $companion_control_full_operation_material$
DECLARE v_definition text; v_rewritten text;
  v_old_revision text := $needle$NEW.target_skills_revision := CASE
        WHEN NEW.client_surface = 'native_mobile' THEN v_required_revision
        ELSE v_available_revision
      END;$needle$;
  v_new_revision text := $needle$NEW.target_skills_revision := v_available_revision;$needle$;
  v_old_reduction text := $needle$IF NEW.client_surface = 'native_mobile' THEN
      NEW.can_write_skills := false;
      NEW.selected_skill_ids := '[]'::jsonb;
      NEW.selected_mcp_account_ids := '[]'::jsonb;
    END IF;$needle$;
BEGIN
  v_definition:=pg_catalog.pg_get_functiondef(
    'public.companion_runtime_assign_operation_intent()'::regprocedure
  );
  v_rewritten:=replace(replace(v_definition,v_old_revision,v_new_revision),v_old_reduction,'');
  IF v_rewritten=v_definition OR strpos(v_rewritten,v_old_revision)>0
    OR strpos(v_rewritten,v_old_reduction)>0 THEN
    RAISE EXCEPTION 'native operation material reduction cannot be removed' USING ERRCODE='55000';
  END IF;
  EXECUTE v_rewritten;
END $companion_control_full_operation_material$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.companion_runtime_assign_attempt_snapshot()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
DECLARE
  v_applied_ids jsonb; v_applied_refs jsonb; v_selected_ids jsonb; v_use_applied boolean;
BEGIN
  SELECT c.persona,i.applied_selected_skill_ids,i.applied_skill_refs,
         i.applied_skills_digest IS NOT NULL AND i.applied_skills_revision>=c.skills_revision,
         c.can_write_skills,c.selected_skill_ids,c.selected_mcp_account_ids
  INTO NEW.persona,v_applied_ids,v_applied_refs,v_use_applied,
       NEW.can_write_skills,v_selected_ids,NEW.selected_mcp_account_ids
  FROM public.companions c
  JOIN public.companion_turns t ON t.org_id=c.org_id AND t.companion_id=c.id AND t.id=NEW.turn_id
  JOIN public.companion_runtime_instances i ON i.org_id=c.org_id AND i.companion_id=c.id
  WHERE c.org_id=NEW.org_id AND c.id=NEW.companion_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'attempt Companion turn does not exist' USING ERRCODE='23503';
  END IF;
  IF v_use_applied THEN
    NEW.selected_skill_ids:=v_applied_ids;
    NEW.skill_refs:=v_applied_refs;
  ELSE
    NEW.selected_skill_ids:=v_selected_ids;
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'skill_id',s.id,'current_version_id',s.current_version_id
    ) ORDER BY s.id),'[]'::jsonb)
    INTO NEW.skill_refs FROM public.skills s
    WHERE s.org_id=NEW.org_id AND EXISTS(
      SELECT 1 FROM jsonb_array_elements_text(NEW.selected_skill_ids) selected(skill_id)
      WHERE selected.skill_id=s.id::text
    );
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

CREATE FUNCTION public.companion_control_normalize_native_settings_material()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_companion public.companions%ROWTYPE;
BEGIN
  IF NEW.settings_claim_client_surface IS DISTINCT FROM 'native_mobile'
    OR NEW.settings_claim_epoch IS NOT DISTINCT FROM OLD.settings_claim_epoch THEN
    RETURN NEW;
  END IF;
  SELECT * INTO STRICT v_companion FROM public.companions c
  WHERE c.org_id=NEW.org_id AND c.id=NEW.companion_id;
  NEW.settings_claim_skills_revision:=v_companion.skills_available_revision;
  NEW.settings_claim_can_write_skills:=v_companion.can_write_skills;
  NEW.settings_claim_selected_skill_ids:=v_companion.selected_skill_ids;
  NEW.settings_claim_selected_mcp_account_ids:=v_companion.selected_mcp_account_ids;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'skill_id',s.id,'current_version_id',s.current_version_id
  ) ORDER BY s.id),'[]'::jsonb)
  INTO NEW.settings_claim_skill_refs FROM public.skills s
  WHERE s.org_id=NEW.org_id AND EXISTS(
    SELECT 1 FROM jsonb_array_elements_text(v_companion.selected_skill_ids) selected(skill_id)
    WHERE selected.skill_id=s.id::text
  );
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.companion_control_normalize_native_settings_material() FROM PUBLIC;
CREATE TRIGGER companion_runtime_instances_normalize_native_settings_material
BEFORE UPDATE OF settings_claim_client_surface,settings_claim_skills_revision,
  settings_claim_selected_skill_ids,settings_claim_selected_mcp_account_ids
ON public.companion_runtime_instances FOR EACH ROW
EXECUTE FUNCTION public.companion_control_normalize_native_settings_material();
--> statement-breakpoint

DO $companion_control_full_material_read$
DECLARE v_definition text; v_rewritten text;
  v_old text := $needle$IF v_authorization.client_surface IS DISTINCT FROM 'native_mobile' THEN$needle$;
BEGIN
  v_definition:=pg_catalog.pg_get_functiondef(
    'public.companion_runtime_get_material(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)'::regprocedure
  );
  v_rewritten:=replace(v_definition,v_old,'IF true THEN');
  IF v_rewritten=v_definition THEN
    RAISE EXCEPTION 'native material read reduction cannot be removed' USING ERRCODE='55000';
  END IF;
  EXECUTE v_rewritten;
END $companion_control_full_material_read$;
--> statement-breakpoint

-- Native settings now stage the same Skills and control material as every first-party client.
-- Remove the three legacy observe-time branches that required a NULL Skills revision for native
-- activation; the Runtime can then prove the exact staged revision uniformly on every surface.
DO $companion_control_full_native_activation$
DECLARE v_definition text; v_rewritten text;
  v_old_settings text := $needle$CASE WHEN v_client_surface = 'native_mobile'
            THEN p_applied_skills_revision IS NOT NULL
            ELSE p_applied_skills_revision IS DISTINCT FROM v_settings_claim_skills_revision
          END$needle$;
  v_new_settings text := $needle$p_applied_skills_revision IS DISTINCT FROM v_settings_claim_skills_revision$needle$;
  v_old_operation text := $needle$CASE WHEN v_client_surface = 'native_mobile'
            THEN p_applied_skills_revision IS NOT NULL
            ELSE p_applied_skills_revision IS DISTINCT FROM v_target_skills_revision
          END$needle$;
  v_new_operation text := $needle$p_applied_skills_revision IS DISTINCT FROM v_target_skills_revision$needle$;
  v_old_operation_guard text := $needle$CASE
       WHEN v_operation_kind IN ('start', 'restart_box', 'apply_settings')
            AND v_client_surface = 'native_mobile' THEN
         v_target_settings_revision IS NULL
         OR p_applied_settings_revision IS DISTINCT FROM v_target_settings_revision
         OR p_applied_skills_revision IS NOT NULL
       ELSE
         v_target_settings_revision IS NULL
         OR v_target_skills_revision IS NULL
         OR p_applied_settings_revision IS DISTINCT FROM v_target_settings_revision
         OR p_applied_skills_revision IS DISTINCT FROM v_target_skills_revision
     END$needle$;
  v_new_operation_guard text := $needle$v_target_settings_revision IS NULL
         OR v_target_skills_revision IS NULL
         OR p_applied_settings_revision IS DISTINCT FROM v_target_settings_revision
         OR p_applied_skills_revision IS DISTINCT FROM v_target_skills_revision$needle$;
  v_old_checkpoint text := $needle$CASE WHEN v_client_surface = 'native_mobile'
          THEN p_applied_skills_revision IS NULL
          ELSE p_applied_skills_revision = v_target_skills_revision
        END$needle$;
  v_new_checkpoint text := $needle$p_applied_skills_revision = v_target_skills_revision$needle$;
BEGIN
  v_definition:=pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(
    'public.companion_runtime_observe_instance(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,bigint,bigint,text,public.companion_box_observed_state,public.companion_pi_observed_state,text,integer,bigint,integer,timestamp with time zone)'
  ));
  IF strpos(v_definition,v_old_settings)=0 OR strpos(v_definition,v_old_operation)=0
    OR strpos(v_definition,v_old_operation_guard)=0
    OR strpos(v_definition,v_old_checkpoint)=0 THEN
    RAISE EXCEPTION 'native settings activation reduction cannot be removed' USING ERRCODE='55000';
  END IF;
  v_rewritten:=replace(v_definition,v_old_settings,v_new_settings);
  v_rewritten:=replace(v_rewritten,v_old_operation,v_new_operation);
  v_rewritten:=replace(v_rewritten,v_old_operation_guard,v_new_operation_guard);
  v_rewritten:=replace(v_rewritten,v_old_checkpoint,v_new_checkpoint);
  EXECUTE v_rewritten;
END $companion_control_full_native_activation$;
--> statement-breakpoint

CREATE TABLE public.companion_peer_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  source_companion_id uuid NOT NULL,
  target_companion_id uuid NOT NULL,
  granted_by_id text NOT NULL REFERENCES public."user"(id) ON DELETE RESTRICT,
  revoked_by_id text REFERENCES public."user"(id) ON DELETE SET NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT companion_peer_grants_pair_uq UNIQUE (org_id, source_companion_id, target_companion_id),
  CONSTRAINT companion_peer_grants_source_fk FOREIGN KEY (org_id, source_companion_id)
    REFERENCES public.companions(org_id, id) ON DELETE CASCADE,
  CONSTRAINT companion_peer_grants_target_fk FOREIGN KEY (org_id, target_companion_id)
    REFERENCES public.companions(org_id, id) ON DELETE CASCADE,
  CONSTRAINT companion_peer_grants_no_self_check CHECK (source_companion_id <> target_companion_id)
);
--> statement-breakpoint

ALTER TABLE public.companion_turns
  ADD COLUMN delegation_id uuid,
  ADD COLUMN delegation_return_id uuid;
ALTER TABLE public.companion_transcript_entries ADD COLUMN delegation jsonb;
--> statement-breakpoint

CREATE TABLE public.companion_control_requests (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  companion_id uuid NOT NULL,
  source_turn_id uuid NOT NULL,
  source_attempt_id uuid NOT NULL,
  requested_by_id text NOT NULL,
  kind public.companion_control_request_kind NOT NULL,
  action text NOT NULL,
  summary text NOT NULL,
  payload jsonb NOT NULL,
  request_key text NOT NULL,
  request_digest text NOT NULL,
  required_access text NOT NULL DEFAULT 'editor',
  status public.companion_control_request_status NOT NULL DEFAULT 'pending',
  decided_by_id text,
  result jsonb,
  error_code text,
  error_message text,
  expires_at timestamptz NOT NULL,
  decided_at timestamptz,
  applied_at timestamptz,
  continuation_turn_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT companion_control_requests_companion_fk FOREIGN KEY (org_id, companion_id)
    REFERENCES public.companions(org_id, id) ON DELETE CASCADE,
  CONSTRAINT companion_control_requests_turn_fk FOREIGN KEY (org_id, companion_id, source_turn_id)
    REFERENCES public.companion_turns(org_id, companion_id, id) ON DELETE CASCADE,
  CONSTRAINT companion_control_requests_attempt_fk
    FOREIGN KEY (org_id, companion_id, source_turn_id, source_attempt_id)
    REFERENCES public.companion_turn_attempts(org_id, companion_id, turn_id, id) ON DELETE CASCADE,
  CONSTRAINT companion_control_requests_request_key_uq
    UNIQUE (companion_id, source_attempt_id, request_key),
  CONSTRAINT companion_control_requests_action_check
    CHECK (action ~ '^[a-z][a-z0-9_]{0,79}$'),
  CONSTRAINT companion_control_requests_summary_check
    CHECK (char_length(btrim(summary)) BETWEEN 1 AND 300 AND summary !~ E'[\n\r]'),
  CONSTRAINT companion_control_requests_payload_check
    CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 131072),
  CONSTRAINT companion_control_requests_digest_check CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT companion_control_requests_access_check CHECK (required_access IN ('owner', 'editor')),
  CONSTRAINT companion_control_requests_result_check CHECK (
    result IS NULL OR (jsonb_typeof(result) = 'object' AND octet_length(result::text) <= 1048576)
  ),
  CONSTRAINT companion_control_requests_error_check CHECK (
    (error_code IS NULL) = (error_message IS NULL)
    AND (error_code IS NULL OR error_code ~ '^[a-z][a-z0-9_]{0,63}$')
    AND (error_message IS NULL OR (char_length(error_message) <= 500 AND error_message !~ E'[\n\r]'))
  )
);
CREATE INDEX companion_control_requests_pending_idx
  ON public.companion_control_requests(companion_id, created_at) WHERE status = 'pending';
--> statement-breakpoint

CREATE TABLE public.companion_control_invocations (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  companion_id uuid NOT NULL,
  source_turn_id uuid NOT NULL,
  source_attempt_id uuid NOT NULL,
  request_key text NOT NULL,
  request_digest text NOT NULL,
  result jsonb,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT companion_control_invocations_attempt_fk
    FOREIGN KEY (org_id, companion_id, source_turn_id, source_attempt_id)
    REFERENCES public.companion_turn_attempts(org_id, companion_id, turn_id, id) ON DELETE CASCADE,
  CONSTRAINT companion_control_invocations_request_key_uq
    UNIQUE (companion_id, source_attempt_id, request_key),
  CONSTRAINT companion_control_invocations_digest_check CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT companion_control_invocations_result_check CHECK (
    (result IS NULL) = (finished_at IS NULL)
    AND (result IS NULL OR (jsonb_typeof(result) = 'object' AND octet_length(result::text) <= 1048576))
  )
);
--> statement-breakpoint

CREATE TABLE public.companion_deferred_pi_restarts (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  companion_id uuid NOT NULL,
  source_turn_id uuid NOT NULL,
  source_attempt_id uuid NOT NULL,
  actor_id text NOT NULL,
  client_surface public.companion_client_surface NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  operation_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  enqueued_at timestamptz,
  CONSTRAINT companion_deferred_pi_restarts_companion_fk FOREIGN KEY (org_id, companion_id)
    REFERENCES public.companions(org_id, id) ON DELETE CASCADE,
  CONSTRAINT companion_deferred_pi_restarts_turn_fk FOREIGN KEY (org_id, companion_id, source_turn_id)
    REFERENCES public.companion_turns(org_id, companion_id, id) ON DELETE CASCADE,
  CONSTRAINT companion_deferred_pi_restarts_attempt_fk
    FOREIGN KEY (org_id, companion_id, source_turn_id, source_attempt_id)
    REFERENCES public.companion_turn_attempts(org_id, companion_id, turn_id, id) ON DELETE CASCADE,
  CONSTRAINT companion_deferred_pi_restarts_status_check CHECK (status IN ('pending','enqueued','cancelled'))
);
--> statement-breakpoint

CREATE TABLE public.companion_delegations (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  source_companion_id uuid,
  source_companion_name text NOT NULL,
  target_companion_id uuid,
  target_companion_name text NOT NULL,
  actor_id text NOT NULL,
  source_turn_id uuid NOT NULL,
  source_attempt_id uuid NOT NULL,
  target_turn_id uuid NOT NULL,
  root_turn_id uuid NOT NULL,
  parent_delegation_id uuid REFERENCES public.companion_delegations(id) ON DELETE SET NULL,
  depth integer NOT NULL,
  response_mode public.companion_routine_surface_mode NOT NULL,
  status public.companion_turn_status NOT NULL DEFAULT 'queued',
  delivery_status public.companion_delegation_delivery_status NOT NULL DEFAULT 'pending',
  request_key text NOT NULL,
  request_digest text NOT NULL,
  source_result_event_id text,
  source_relay_turn_id uuid,
  delivery_error_code text,
  settled_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT companion_delegations_source_fk FOREIGN KEY (org_id, source_companion_id)
    REFERENCES public.companions(org_id, id) ON DELETE SET NULL (source_companion_id),
  CONSTRAINT companion_delegations_target_fk FOREIGN KEY (org_id, target_companion_id)
    REFERENCES public.companions(org_id, id) ON DELETE SET NULL (target_companion_id),
  CONSTRAINT companion_delegations_request_key_uq
    UNIQUE (source_companion_id, source_attempt_id, request_key),
  CONSTRAINT companion_delegations_target_turn_uq UNIQUE (target_turn_id),
  CONSTRAINT companion_delegations_depth_check CHECK (depth BETWEEN 1 AND 4),
  CONSTRAINT companion_delegations_no_self_check CHECK (
    source_companion_id IS NULL OR target_companion_id IS NULL
    OR source_companion_id <> target_companion_id
  ),
  CONSTRAINT companion_delegations_digest_check CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT companion_delegations_terminal_check CHECK (
    (status IN ('succeeded','failed','interrupted','cancelled')) = (settled_at IS NOT NULL)
  ),
  CONSTRAINT companion_delegations_delivery_error_check CHECK (
    delivery_error_code IS NULL OR delivery_error_code ~ '^[a-z][a-z0-9_]{0,63}$'
  )
);
CREATE INDEX companion_delegations_root_idx ON public.companion_delegations(root_turn_id, created_at);
ALTER TABLE public.companion_turns
  ADD CONSTRAINT companion_turns_delegation_fk FOREIGN KEY (delegation_id)
    REFERENCES public.companion_delegations(id) ON DELETE SET NULL,
  ADD CONSTRAINT companion_turns_delegation_return_fk FOREIGN KEY (delegation_return_id)
    REFERENCES public.companion_delegations(id) ON DELETE SET NULL;
--> statement-breakpoint

ALTER TABLE public.companion_control_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companion_control_tokens FORCE ROW LEVEL SECURITY;
ALTER TABLE public.companion_control_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companion_control_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE public.companion_control_invocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companion_control_invocations FORCE ROW LEVEL SECURITY;
ALTER TABLE public.companion_peer_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companion_peer_grants FORCE ROW LEVEL SECURITY;
ALTER TABLE public.companion_delegations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companion_delegations FORCE ROW LEVEL SECURITY;
ALTER TABLE public.companion_deferred_pi_restarts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companion_deferred_pi_restarts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE FUNCTION public.companion_revoke_inactive_control_token()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
BEGIN
  IF OLD.control_token_id IS NOT NULL AND (
    NEW.control_token_id IS DISTINCT FROM OLD.control_token_id
    OR NEW.retirement_state <> 'active' OR NEW.box_state IN ('archived','absent')
  ) THEN
    UPDATE public.companion_control_tokens
    SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE id=OLD.control_token_id;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.companion_revoke_inactive_control_token() FROM PUBLIC;
CREATE TRIGGER companion_runtime_instances_revoke_control_token
AFTER UPDATE OF control_token_id,retirement_state,box_state ON public.companion_runtime_instances
FOR EACH ROW EXECUTE FUNCTION public.companion_revoke_inactive_control_token();
--> statement-breakpoint

CREATE FUNCTION public.companion_runtime_mint_control_token(
  p_org_id uuid,p_companion_id uuid,p_claim_token uuid,p_claim_epoch bigint,p_gate_epoch bigint,
  p_executor_id text,p_work_kind public.companion_runtime_work_kind,p_work_id uuid,p_lease_seconds integer
)
RETURNS TABLE(token text,expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE
  v_authorization record; v_instance public.companion_runtime_instances%ROWTYPE;
  v_previous uuid; v_token_id uuid:=gen_random_uuid(); v_secret text; v_token text;
  v_now timestamptz:=clock_timestamp(); v_expires timestamptz:=v_now+interval '6 hours';
BEGIN
  IF p_work_kind NOT IN ('operation','settings') THEN
    RAISE EXCEPTION 'control token mint requires staging work' USING ERRCODE='22023';
  END IF;
  SELECT a.* INTO v_authorization FROM public.companion_runtime_renew_and_authorize(
    p_org_id,p_companion_id,p_claim_token,p_claim_epoch,p_gate_epoch,p_executor_id,p_work_kind,p_work_id,p_lease_seconds
  ) a;
  IF NOT FOUND OR NOT COALESCE(v_authorization.authorized,false) THEN RETURN; END IF;
  SELECT i.* INTO STRICT v_instance FROM public.companion_runtime_instances i
  WHERE i.org_id=p_org_id AND i.companion_id=p_companion_id FOR UPDATE;
  v_previous:=v_instance.control_token_id;
  IF v_authorization.authorization_actor_id IS NULL THEN
    UPDATE public.companion_runtime_instances SET control_token_id=NULL,updated_at=v_now
    WHERE org_id=p_org_id AND companion_id=p_companion_id;
    IF v_previous IS NOT NULL THEN UPDATE public.companion_control_tokens
      SET revoked_at=v_now WHERE id=v_previous AND revoked_at IS NULL; END IF;
    RETURN;
  END IF;
  v_secret:=left(replace(gen_random_uuid()::text||gen_random_uuid()::text,'-',''),48);
  v_token:='cmp_ctl_'||v_secret;
  INSERT INTO public.companion_control_tokens(
    id,org_id,companion_id,staged_actor_id,token_prefix,token_hash,expires_at
  ) VALUES(
    v_token_id,p_org_id,p_companion_id,v_authorization.authorization_actor_id,left(v_token,14),
    encode(sha256(convert_to(v_token,'UTF8')),'hex'),v_expires
  );
  UPDATE public.companion_runtime_instances SET control_token_id=v_token_id,
    material_client_surface=NULL,material_pi_invocation_id=NULL,material_expires_at=NULL,updated_at=v_now
  WHERE org_id=p_org_id AND companion_id=p_companion_id;
  IF v_previous IS NOT NULL THEN UPDATE public.companion_control_tokens
    SET revoked_at=v_now WHERE id=v_previous AND revoked_at IS NULL; END IF;
  RETURN QUERY SELECT v_token,v_expires;
END $$;
REVOKE ALL ON FUNCTION public.companion_runtime_mint_control_token(
  uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer
) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_resolve_control_token(p_token_hash text)
RETURNS TABLE(org_id uuid,companion_id uuid,actor_id text,turn_id uuid,attempt_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_now timestamptz:=clock_timestamp();
BEGIN
  IF p_token_hash IS NULL OR p_token_hash!~'^[0-9a-f]{64}$' THEN RETURN; END IF;
  RETURN QUERY
  UPDATE public.companion_control_tokens token SET last_used_at=v_now
  FROM public.companion_runtime_instances instance,public.companion_turns turn_row,
       public.companion_turn_attempts attempt,public.memberships membership
  WHERE token.token_hash=p_token_hash AND token.revoked_at IS NULL AND token.expires_at>v_now
    AND instance.org_id=token.org_id AND instance.companion_id=token.companion_id
    AND instance.control_token_id=token.id AND instance.retirement_state='active'
    AND turn_row.org_id=token.org_id AND turn_row.companion_id=token.companion_id
    AND turn_row.actor_id=token.staged_actor_id
    AND turn_row.status IN ('running','needs_input')
    AND turn_row.routine_snapshot_id IS NULL AND turn_row.trigger_name IS NULL
    AND attempt.org_id=turn_row.org_id AND attempt.companion_id=turn_row.companion_id
    AND attempt.turn_id=turn_row.id AND attempt.status IN ('running','needs_input')
    AND attempt.dispatch_state='accepted'
    AND membership.org_id=token.org_id AND membership.user_id=turn_row.actor_id
  RETURNING token.org_id,token.companion_id,turn_row.actor_id,turn_row.id,attempt.id;
END $$;
REVOKE ALL ON FUNCTION public.companion_resolve_control_token(text) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_register_control_invocation(
  p_org_id uuid,p_companion_id uuid,p_id uuid,p_turn_id uuid,p_attempt_id uuid,
  p_request_key text,p_request_digest text
)
RETURNS TABLE(replayed boolean,result jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_actor text:=public.companion_api_actor(p_org_id); v_existing record;
BEGIN
  PERFORM public.companion_api_require_access(p_org_id,p_companion_id,'editor');
  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_companion_id::text||':'||p_attempt_id::text||':'||p_request_key,0
  ));
  SELECT * INTO v_existing FROM public.companion_control_invocations i
  WHERE i.companion_id=p_companion_id AND i.source_attempt_id=p_attempt_id
    AND i.request_key=p_request_key FOR UPDATE;
  IF FOUND THEN
    IF v_existing.request_digest<>p_request_digest THEN
      RAISE EXCEPTION 'control invocation idempotency conflict' USING ERRCODE='23505';
    END IF;
    IF v_existing.result IS NULL THEN
      RAISE EXCEPTION 'control invocation replay is incomplete' USING ERRCODE='55000';
    END IF;
    RETURN QUERY SELECT true,v_existing.result; RETURN;
  END IF;
  PERFORM 1 FROM public.companion_turn_attempts a JOIN public.companion_turns t
    ON t.org_id=a.org_id AND t.companion_id=a.companion_id AND t.id=a.turn_id
  WHERE a.org_id=p_org_id AND a.companion_id=p_companion_id AND a.id=p_attempt_id
    AND a.turn_id=p_turn_id AND a.status IN ('running','needs_input') AND a.dispatch_state='accepted'
    AND t.actor_id=v_actor AND t.routine_snapshot_id IS NULL AND t.trigger_name IS NULL FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'control attempt is not active' USING ERRCODE='42501'; END IF;
  INSERT INTO public.companion_control_invocations(
    id,org_id,companion_id,source_turn_id,source_attempt_id,request_key,request_digest
  ) VALUES(p_id,p_org_id,p_companion_id,p_turn_id,p_attempt_id,p_request_key,p_request_digest);
  RETURN QUERY SELECT false,NULL::jsonb;
END $$;
REVOKE ALL ON FUNCTION public.companion_api_register_control_invocation(uuid,uuid,uuid,uuid,uuid,text,text) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_finish_control_invocation(
  p_org_id uuid,p_companion_id uuid,p_attempt_id uuid,p_request_key text,
  p_request_digest text,p_result jsonb
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_result jsonb;
BEGIN
  PERFORM public.companion_api_require_access(p_org_id,p_companion_id,'editor');
  IF p_result IS NULL OR jsonb_typeof(p_result)<>'object' OR octet_length(p_result::text)>1048576 THEN
    RAISE EXCEPTION 'invalid control invocation result' USING ERRCODE='22023';
  END IF;
  UPDATE public.companion_control_invocations i SET result=p_result,finished_at=clock_timestamp()
  WHERE i.org_id=p_org_id AND i.companion_id=p_companion_id
    AND i.source_attempt_id=p_attempt_id AND i.request_key=p_request_key
    AND i.request_digest=p_request_digest AND i.result IS NULL
  RETURNING i.result INTO v_result;
  IF NOT FOUND THEN
    SELECT i.result INTO v_result FROM public.companion_control_invocations i
    WHERE i.org_id=p_org_id AND i.companion_id=p_companion_id
      AND i.source_attempt_id=p_attempt_id AND i.request_key=p_request_key
      AND i.request_digest=p_request_digest;
  END IF;
  IF v_result IS NULL THEN
    RAISE EXCEPTION 'control invocation is unavailable' USING ERRCODE='55000';
  END IF;
  RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION public.companion_api_finish_control_invocation(uuid,uuid,uuid,text,text,jsonb) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_create_control_request(
  p_org_id uuid,p_companion_id uuid,p_id uuid,p_turn_id uuid,p_attempt_id uuid,
  p_kind public.companion_control_request_kind,p_action text,p_summary text,p_payload jsonb,
  p_request_key text,p_request_digest text,p_required_access text
)
RETURNS SETOF public.companion_control_requests
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE
  v_actor text:=public.companion_api_actor(p_org_id); v_now timestamptz:=clock_timestamp();
  v_expires timestamptz:=v_now+interval '24 hours'; v_ordinal integer; v_existing record;
BEGIN
  PERFORM public.companion_api_require_access(p_org_id,p_companion_id,
    CASE WHEN p_required_access='owner' THEN 'owner' ELSE 'editor' END);
  IF p_request_key IS NULL OR char_length(p_request_key) NOT BETWEEN 1 AND 200
    OR p_request_key~E'[\n\r]' OR p_required_access NOT IN ('owner','editor') THEN
    RAISE EXCEPTION 'invalid control request' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_existing FROM public.companion_control_requests r
  WHERE r.org_id=p_org_id AND r.companion_id=p_companion_id AND r.source_attempt_id=p_attempt_id
    AND r.request_key=p_request_key FOR UPDATE;
  IF FOUND THEN
    IF v_existing.request_digest<>p_request_digest THEN
      RAISE EXCEPTION 'control request idempotency conflict' USING ERRCODE='23505';
    END IF;
    RETURN QUERY SELECT * FROM public.companion_control_requests r
    WHERE r.org_id=p_org_id AND r.companion_id=p_companion_id AND r.id=v_existing.id;
    RETURN;
  END IF;
  PERFORM 1 FROM public.companion_turn_attempts a JOIN public.companion_turns t
    ON t.org_id=a.org_id AND t.companion_id=a.companion_id AND t.id=a.turn_id
  WHERE a.org_id=p_org_id AND a.companion_id=p_companion_id AND a.id=p_attempt_id
    AND a.turn_id=p_turn_id AND a.status IN ('running','needs_input') AND a.dispatch_state='accepted'
    AND t.actor_id=v_actor AND t.routine_snapshot_id IS NULL AND t.trigger_name IS NULL FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'control attempt is not active' USING ERRCODE='42501'; END IF;
  INSERT INTO public.companion_control_requests(
    id,org_id,companion_id,source_turn_id,source_attempt_id,requested_by_id,kind,action,summary,
    payload,request_key,request_digest,required_access,expires_at
  ) VALUES(p_id,p_org_id,p_companion_id,p_turn_id,p_attempt_id,v_actor,p_kind,p_action,p_summary,
    p_payload,p_request_key,p_request_digest,p_required_access,v_expires);
  UPDATE public.companion_threads thread
  SET next_ordinal=thread.next_ordinal+1,last_message_at=v_now,updated_at=v_now
  WHERE thread.org_id=p_org_id AND thread.companion_id=p_companion_id
  RETURNING thread.next_ordinal-1 INTO v_ordinal;
  IF NOT FOUND THEN RAISE EXCEPTION 'Companion thread is unavailable' USING ERRCODE='55000'; END IF;
  INSERT INTO public.companion_transcript_entries(
    org_id,companion_id,event_id,ordinal,role,content,decision,author_id,turn_id,created_at
  ) VALUES(
    p_org_id,p_companion_id,'control:'||p_id::text,v_ordinal,'decision','',
    jsonb_build_object('request_id',p_id::text,'kind','control','name',p_action,'title',p_summary,
      'detail',NULL,'status','pending','answer',NULL,'decided_by_id',NULL,'decided_by_name',NULL,
      'decided_at',NULL,'expires_at',to_char(v_expires AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'required_access',p_required_access,'control_status','pending',
      'proposal',jsonb_build_object('kind','control','request_kind',p_kind,'action',p_action,
        'summary',p_summary,'payload',p_payload)),
    NULL,p_turn_id,v_now
  );
  RETURN QUERY SELECT * FROM public.companion_control_requests r
  WHERE r.org_id=p_org_id AND r.companion_id=p_companion_id AND r.id=p_id;
END $$;
REVOKE ALL ON FUNCTION public.companion_api_create_control_request(
  uuid,uuid,uuid,uuid,uuid,public.companion_control_request_kind,text,text,jsonb,text,text,text
) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_get_control_request(
  p_org_id uuid,p_companion_id uuid,p_id uuid
)
RETURNS SETOF public.companion_control_requests
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
BEGIN
  PERFORM public.companion_api_require_access(p_org_id,p_companion_id,'read');
  RETURN QUERY SELECT * FROM public.companion_control_requests r
  WHERE r.org_id=p_org_id AND r.companion_id=p_companion_id AND r.id=p_id;
END $$;
REVOKE ALL ON FUNCTION public.companion_api_get_control_request(uuid,uuid,uuid) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_decide_control_request(
  p_org_id uuid,p_companion_id uuid,p_id uuid,p_action text
)
RETURNS SETOF public.companion_control_requests
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE
  v_actor text:=public.companion_api_actor(p_org_id); v_name text; v_request record;
  v_now timestamptz:=clock_timestamp(); v_status public.companion_control_request_status;
BEGIN
  IF p_action NOT IN ('allow','deny') THEN RAISE EXCEPTION 'invalid control decision' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_request FROM public.companion_control_requests r
  WHERE r.org_id=p_org_id AND r.companion_id=p_companion_id AND r.id=p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'control request not found' USING ERRCODE='P0002'; END IF;
  PERFORM public.companion_api_require_access(p_org_id,p_companion_id,v_request.required_access);
  IF v_request.status='pending' AND v_request.expires_at<=v_now THEN
    UPDATE public.companion_control_requests r SET status='expired',decided_at=v_now,updated_at=v_now
    WHERE r.org_id=p_org_id AND r.companion_id=p_companion_id AND r.id=p_id;
    UPDATE public.companion_transcript_entries e SET decision=e.decision||jsonb_build_object(
      'status','expired','control_status','expired',
      'decided_at',to_char(v_now AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
    WHERE e.org_id=p_org_id AND e.companion_id=p_companion_id AND e.event_id='control:'||p_id::text;
    RETURN QUERY SELECT * FROM public.companion_control_requests r
    WHERE r.org_id=p_org_id AND r.companion_id=p_companion_id AND r.id=p_id;
    RETURN;
  END IF;
  IF (p_action='allow' AND v_request.status IN ('applying','applied','failed'))
    OR (p_action='deny' AND v_request.status='denied') THEN
    RETURN QUERY SELECT * FROM public.companion_control_requests r
    WHERE r.org_id=p_org_id AND r.companion_id=p_companion_id AND r.id=p_id;
    RETURN;
  END IF;
  IF v_request.status<>(CASE WHEN p_action='allow' THEN 'applying'::public.companion_control_request_status
      ELSE 'denied'::public.companion_control_request_status END) THEN
    IF v_request.status<>'pending' THEN
      RAISE EXCEPTION 'control request is not pending' USING ERRCODE='55000';
    END IF;
    v_status:=CASE WHEN p_action='allow' THEN 'applying'::public.companion_control_request_status
      ELSE 'denied'::public.companion_control_request_status END;
    UPDATE public.companion_control_requests r SET status=v_status,decided_by_id=v_actor,
      decided_at=v_now,updated_at=v_now
    WHERE r.org_id=p_org_id AND r.companion_id=p_companion_id AND r.id=p_id;
    SELECT COALESCE(p.name,u.name,u.email) INTO v_name FROM public."user" u
      LEFT JOIN public.profiles p ON p.id=u.id WHERE u.id=v_actor;
    UPDATE public.companion_transcript_entries e SET decision=e.decision||jsonb_build_object(
      'status',CASE WHEN p_action='allow' THEN 'allowed' ELSE 'denied' END,
      'control_status',v_status,'decided_by_id',v_actor,'decided_by_name',v_name,
      'decided_at',to_char(v_now AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
    WHERE e.org_id=p_org_id AND e.companion_id=p_companion_id AND e.event_id='control:'||p_id::text;
  END IF;
  RETURN QUERY SELECT * FROM public.companion_control_requests r
  WHERE r.org_id=p_org_id AND r.companion_id=p_companion_id AND r.id=p_id;
END $$;
REVOKE ALL ON FUNCTION public.companion_api_decide_control_request(uuid,uuid,uuid,text) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_finish_control_request(
  p_org_id uuid,p_companion_id uuid,p_id uuid,p_result jsonb,p_error_code text,p_error_message text
)
RETURNS SETOF public.companion_control_requests
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_now timestamptz:=clock_timestamp(); v_ordinal integer; v_summary text; v_status public.companion_control_request_status;
BEGIN
  PERFORM public.companion_api_require_access(p_org_id,p_companion_id,'editor');
  IF p_result IS NOT NULL AND (
    jsonb_typeof(p_result) <> 'object' OR octet_length(p_result::text) > 1048576
  ) THEN
    RAISE EXCEPTION 'invalid control request result' USING ERRCODE='22023';
  END IF;
  v_status:=CASE WHEN p_error_code IS NULL THEN 'applied'::public.companion_control_request_status
    ELSE 'failed'::public.companion_control_request_status END;
  UPDATE public.companion_control_requests r SET status=v_status,result=p_result,error_code=p_error_code,
    error_message=p_error_message,applied_at=CASE WHEN p_error_code IS NULL THEN v_now ELSE NULL END,
    updated_at=v_now
  WHERE r.org_id=p_org_id AND r.companion_id=p_companion_id AND r.id=p_id AND r.status='applying'
  RETURNING r.summary INTO v_summary;
  IF NOT FOUND THEN
    RETURN QUERY SELECT * FROM public.companion_control_requests r
    WHERE r.org_id=p_org_id AND r.companion_id=p_companion_id AND r.id=p_id AND r.status=v_status;
    RETURN;
  END IF;
  UPDATE public.companion_transcript_entries e SET decision=e.decision||jsonb_build_object('control_status',v_status)
  WHERE e.org_id=p_org_id AND e.companion_id=p_companion_id AND e.event_id='control:'||p_id::text;
  UPDATE public.companion_threads thread
  SET next_ordinal=thread.next_ordinal+1,last_message_at=v_now,updated_at=v_now
  WHERE thread.org_id=p_org_id AND thread.companion_id=p_companion_id
  RETURNING thread.next_ordinal-1 INTO v_ordinal;
  IF NOT FOUND THEN RAISE EXCEPTION 'Companion thread is unavailable' USING ERRCODE='55000'; END IF;
  INSERT INTO public.companion_transcript_entries(org_id,companion_id,event_id,ordinal,role,content,created_at)
  VALUES(p_org_id,p_companion_id,'control-result:'||p_id::text,v_ordinal,'system',
    CASE WHEN p_error_code IS NULL THEN 'Applied: '||v_summary ELSE 'Could not apply: '||left(p_error_message,500) END,v_now);
  RETURN QUERY SELECT * FROM public.companion_control_requests r
  WHERE r.org_id=p_org_id AND r.companion_id=p_companion_id AND r.id=p_id;
END $$;
REVOKE ALL ON FUNCTION public.companion_api_finish_control_request(uuid,uuid,uuid,jsonb,text,text) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_enqueue_control_continuation(
  p_org_id uuid,p_companion_id uuid,p_id uuid,p_content text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_request public.companion_control_requests%ROWTYPE; v_enqueued record; v_client_message_id uuid;
BEGIN
  PERFORM public.companion_api_require_access(p_org_id,p_companion_id,'editor');
  SELECT * INTO v_request FROM public.companion_control_requests r
  WHERE r.org_id=p_org_id AND r.companion_id=p_companion_id AND r.id=p_id FOR UPDATE;
  IF NOT FOUND OR v_request.status<>'applied' THEN
    RAISE EXCEPTION 'control request is not applied' USING ERRCODE='55000';
  END IF;
  IF v_request.continuation_turn_id IS NOT NULL THEN
    RETURN (SELECT to_jsonb(t) FROM public.companion_turns t
      WHERE t.org_id=p_org_id AND t.companion_id=p_companion_id
        AND t.id=v_request.continuation_turn_id);
  END IF;
  -- The request UUID is a deterministic client message id, making callback and decision retries
  -- converge on the same ordinary FIFO turn.
  v_client_message_id:=v_request.id;
  SELECT * INTO v_enqueued FROM public.companion_api_enqueue_turn(
    p_org_id,p_companion_id,v_client_message_id,p_content,
    'web'::public.companion_client_surface,'[]'::jsonb
  );
  UPDATE public.companion_control_requests SET
    continuation_turn_id=(v_enqueued.turn->>'id')::uuid,updated_at=clock_timestamp()
  WHERE org_id=p_org_id AND companion_id=p_companion_id AND id=p_id;
  RETURN v_enqueued.turn;
END $$;
REVOKE ALL ON FUNCTION public.companion_api_enqueue_control_continuation(uuid,uuid,uuid,text) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_schedule_pi_restart(
  p_org_id uuid,p_companion_id uuid,p_id uuid,p_turn_id uuid,p_attempt_id uuid
)
RETURNS TABLE(id uuid,status text,source_turn_id uuid,operation_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_actor text:=public.companion_api_actor(p_org_id); v_surface public.companion_client_surface;
BEGIN
  PERFORM public.companion_api_require_access(p_org_id,p_companion_id,'editor');
  SELECT t.client_surface INTO v_surface FROM public.companion_turns t
  JOIN public.companion_turn_attempts a ON a.org_id=t.org_id AND a.companion_id=t.companion_id
    AND a.turn_id=t.id
  WHERE t.org_id=p_org_id AND t.companion_id=p_companion_id AND t.id=p_turn_id
    AND t.actor_id=v_actor AND t.status IN ('running','needs_input')
    AND t.routine_snapshot_id IS NULL AND t.trigger_name IS NULL
    AND a.id=p_attempt_id AND a.status IN ('running','needs_input') AND a.dispatch_state='accepted';
  IF NOT FOUND THEN RAISE EXCEPTION 'control attempt is not active' USING ERRCODE='42501'; END IF;
  INSERT INTO public.companion_deferred_pi_restarts(
    id,org_id,companion_id,source_turn_id,source_attempt_id,actor_id,client_surface
  ) VALUES(p_id,p_org_id,p_companion_id,p_turn_id,p_attempt_id,v_actor,v_surface)
  ON CONFLICT(id) DO NOTHING;
  RETURN QUERY SELECT r.id,r.status,r.source_turn_id,r.operation_id
  FROM public.companion_deferred_pi_restarts r
  WHERE r.id=p_id AND r.org_id=p_org_id AND r.companion_id=p_companion_id
    AND r.source_turn_id=p_turn_id AND r.source_attempt_id=p_attempt_id;
END $$;
REVOKE ALL ON FUNCTION public.companion_api_schedule_pi_restart(uuid,uuid,uuid,uuid,uuid) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_enqueue_deferred_pi_restart()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_restart record; v_operation record;
BEGIN
  IF NEW.status NOT IN ('succeeded','failed','interrupted','cancelled') OR OLD.status=NEW.status THEN RETURN NEW; END IF;
  FOR v_restart IN SELECT * FROM public.companion_deferred_pi_restarts r
    WHERE r.org_id=NEW.org_id AND r.companion_id=NEW.companion_id
      AND r.source_turn_id=NEW.id AND r.status='pending' FOR UPDATE
  LOOP
    PERFORM set_config('app.org_id',v_restart.org_id::text,true);
    PERFORM set_config('app.user_id',v_restart.actor_id,true);
    SELECT * INTO v_operation FROM public.companion_api_enqueue_operation(
      v_restart.org_id,v_restart.companion_id,v_restart.id,'restart_pi',v_restart.client_surface
    );
    UPDATE public.companion_deferred_pi_restarts SET status='enqueued',
      operation_id=(v_operation.operation->>'id')::uuid,enqueued_at=clock_timestamp()
    WHERE org_id=v_restart.org_id AND companion_id=v_restart.companion_id
      AND id=v_restart.id AND status='pending';
  END LOOP;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.companion_enqueue_deferred_pi_restart() FROM PUBLIC;
CREATE TRIGGER companion_turns_enqueue_deferred_pi_restart
AFTER UPDATE OF status ON public.companion_turns FOR EACH ROW
EXECUTE FUNCTION public.companion_enqueue_deferred_pi_restart();
--> statement-breakpoint

CREATE FUNCTION public.companion_api_list_peers(p_org_id uuid,p_source_companion_id uuid)
RETURNS TABLE(companion_id uuid,name text,access text,grant_id uuid,grant_active boolean,runtime_state text,queued_count bigint)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_actor text:=public.companion_api_actor(p_org_id); v_owner text;
BEGIN
  PERFORM public.companion_api_require_access(p_org_id,p_source_companion_id,'editor');
  SELECT c.owner_id INTO STRICT v_owner FROM public.companions c
  WHERE c.org_id=p_org_id AND c.id=p_source_companion_id;
  RETURN QUERY
  SELECT c.id,c.name,
    CASE WHEN c.owner_id=v_actor THEN 'owner' ELSE wa.role::text END,
    g.id,(g.id IS NOT NULL AND g.revoked_at IS NULL),i.box_state::text,
    (SELECT count(*) FROM public.companion_turns t WHERE t.companion_id=c.id AND t.status='queued')
  FROM public.companions c
  LEFT JOIN public.companion_workspace_access wa ON wa.org_id=c.org_id AND wa.companion_id=c.id
  LEFT JOIN public.companion_peer_grants g ON g.org_id=c.org_id
    AND g.source_companion_id=p_source_companion_id AND g.target_companion_id=c.id
  JOIN public.companion_runtime_instances i ON i.org_id=c.org_id AND i.companion_id=c.id
  WHERE c.org_id=p_org_id AND c.id<>p_source_companion_id
    AND (c.owner_id=v_actor OR wa.role='editor')
    AND (c.owner_id=v_owner OR wa.role='editor')
  ORDER BY lower(c.name),c.id;
END $$;
REVOKE ALL ON FUNCTION public.companion_api_list_peers(uuid,uuid) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_grant_peer_access(p_org_id uuid,p_source uuid,p_target uuid)
RETURNS SETOF public.companion_peer_grants
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_actor text:=public.companion_api_actor(p_org_id); v_now timestamptz:=clock_timestamp();
BEGIN
  PERFORM public.companion_api_require_access(p_org_id,p_source,'owner');
  PERFORM public.companion_api_require_access(p_org_id,p_target,'editor');
  IF p_source=p_target THEN RAISE EXCEPTION 'self delegation is not allowed' USING ERRCODE='22023'; END IF;
  INSERT INTO public.companion_peer_grants(org_id,source_companion_id,target_companion_id,granted_by_id)
  VALUES(p_org_id,p_source,p_target,v_actor)
  ON CONFLICT(org_id,source_companion_id,target_companion_id) DO UPDATE SET
    granted_by_id=excluded.granted_by_id,revoked_by_id=NULL,revoked_at=NULL,updated_at=v_now;
  RETURN QUERY SELECT * FROM public.companion_peer_grants g
  WHERE g.org_id=p_org_id AND g.source_companion_id=p_source AND g.target_companion_id=p_target;
END $$;
REVOKE ALL ON FUNCTION public.companion_api_grant_peer_access(uuid,uuid,uuid) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_revoke_peer_access(p_org_id uuid,p_source uuid,p_target uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_actor text:=public.companion_api_actor(p_org_id);
BEGIN
  PERFORM public.companion_api_require_access(p_org_id,p_source,'owner');
  UPDATE public.companion_peer_grants SET revoked_by_id=v_actor,revoked_at=clock_timestamp(),updated_at=clock_timestamp()
  WHERE org_id=p_org_id AND source_companion_id=p_source AND target_companion_id=p_target AND revoked_at IS NULL;
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.companion_api_revoke_peer_access(uuid,uuid,uuid) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_record_delegation(
  p_org_id uuid,p_source uuid,p_target uuid,p_source_turn uuid,p_source_attempt uuid,
  p_target_turn uuid,p_id uuid,p_response_mode public.companion_routine_surface_mode,
  p_request_key text,p_request_digest text
)
RETURNS SETOF public.companion_delegations
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE
  v_actor text:=public.companion_api_actor(p_org_id); v_source_name text; v_target_name text;
  v_parent uuid; v_root uuid; v_depth integer; v_existing record; v_target_status public.companion_turn_status;
  v_source_owner text;
BEGIN
  PERFORM public.companion_api_require_access(p_org_id,p_source,'editor');
  PERFORM public.companion_api_require_access(p_org_id,p_target,'editor');
  IF p_source=p_target THEN RAISE EXCEPTION 'self delegation is not allowed' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_existing FROM public.companion_delegations d
  WHERE d.org_id=p_org_id AND d.source_companion_id=p_source
    AND d.source_attempt_id=p_source_attempt AND d.request_key=p_request_key FOR UPDATE;
  IF FOUND THEN
    IF v_existing.request_digest<>p_request_digest THEN RAISE EXCEPTION 'delegation idempotency conflict' USING ERRCODE='23505'; END IF;
    RETURN QUERY SELECT * FROM public.companion_delegations d
    WHERE d.org_id=p_org_id AND d.id=v_existing.id;
    RETURN;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.companion_peer_grants g WHERE g.org_id=p_org_id
    AND g.source_companion_id=p_source AND g.target_companion_id=p_target AND g.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'peer access is not approved' USING ERRCODE='42501';
  END IF;
  SELECT s.name,t.name,st.delegation_id,tt.status,s.owner_id
  INTO v_source_name,v_target_name,v_parent,v_target_status,v_source_owner
  FROM public.companions s,public.companions t,public.companion_turns st,
       public.companion_turn_attempts sa,public.companion_turns tt
  WHERE s.org_id=p_org_id AND s.id=p_source AND t.org_id=p_org_id AND t.id=p_target
    AND st.org_id=p_org_id AND st.companion_id=p_source AND st.id=p_source_turn AND st.actor_id=v_actor
    AND st.status IN ('running','needs_input') AND st.routine_snapshot_id IS NULL
    AND st.trigger_name IS NULL
    AND sa.org_id=st.org_id AND sa.companion_id=st.companion_id AND sa.turn_id=st.id
    AND sa.id=p_source_attempt AND sa.status IN ('running','needs_input')
    AND sa.dispatch_state='accepted'
    AND tt.org_id=p_org_id AND tt.companion_id=p_target AND tt.id=p_target_turn;
  IF NOT FOUND THEN RAISE EXCEPTION 'delegation turns are unavailable' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.memberships m
    WHERE m.org_id=p_org_id AND m.user_id=v_source_owner
  ) OR NOT EXISTS (
    SELECT 1 FROM public.companions target
    LEFT JOIN public.companion_workspace_access access
      ON access.org_id=target.org_id AND access.companion_id=target.id
      AND access.role='editor'
    WHERE target.org_id=p_org_id AND target.id=p_target
      AND (target.owner_id=v_source_owner OR access.companion_id IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'source owner cannot operate target Companion' USING ERRCODE='42501';
  END IF;
  IF v_parent IS NULL THEN v_root:=p_source_turn; v_depth:=1;
  ELSE SELECT d.root_turn_id,d.depth+1 INTO v_root,v_depth FROM public.companion_delegations d
    WHERE d.org_id=p_org_id AND d.id=v_parent; END IF;
  IF v_depth>4 THEN RAISE EXCEPTION 'delegation depth exceeded' USING ERRCODE='54000'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_root::text,0));
  IF (SELECT count(*) FROM public.companion_delegations d
      WHERE d.org_id=p_org_id AND d.root_turn_id=v_root)>=20 THEN
    RAISE EXCEPTION 'delegation budget exceeded' USING ERRCODE='54000';
  END IF;
  INSERT INTO public.companion_delegations(
    id,org_id,source_companion_id,source_companion_name,target_companion_id,target_companion_name,
    actor_id,source_turn_id,source_attempt_id,target_turn_id,root_turn_id,parent_delegation_id,depth,
    response_mode,status,request_key,request_digest
  ) VALUES(p_id,p_org_id,p_source,v_source_name,p_target,v_target_name,v_actor,p_source_turn,p_source_attempt,
    p_target_turn,v_root,v_parent,v_depth,p_response_mode,v_target_status,p_request_key,p_request_digest);
  UPDATE public.companion_turns SET delegation_id=p_id
  WHERE org_id=p_org_id AND id=p_target_turn AND companion_id=p_target;
  UPDATE public.companion_transcript_entries SET delegation=jsonb_build_object(
    'id',p_id,'direction','request','companion_id',p_source,'companion_name',v_source_name,
    'response_mode',p_response_mode,'status',v_target_status)
  WHERE org_id=p_org_id AND companion_id=p_target AND turn_id=p_target_turn AND role='user';
  RETURN QUERY SELECT * FROM public.companion_delegations d
  WHERE d.org_id=p_org_id AND d.id=p_id;
END $$;
REVOKE ALL ON FUNCTION public.companion_api_record_delegation(
  uuid,uuid,uuid,uuid,uuid,uuid,uuid,public.companion_routine_surface_mode,text,text
) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_enqueue_delegation(
  p_org_id uuid,p_source uuid,p_target uuid,p_source_turn uuid,p_source_attempt uuid,
  p_target_client_message_id uuid,p_content text,p_id uuid,
  p_response_mode public.companion_routine_surface_mode,p_request_key text,p_request_digest text
)
RETURNS TABLE(delegation jsonb,target_turn jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE v_enqueued record; v_delegation public.companion_delegations%ROWTYPE;
BEGIN
  -- Reject revoked or inaccessible routes before target queue constraints can obscure the
  -- authorization failure. record_delegation repeats these checks after enqueue so the grant and
  -- both ACLs are still evaluated atomically with the durable delegation row.
  PERFORM public.companion_api_require_access(p_org_id,p_source,'editor');
  PERFORM public.companion_api_require_access(p_org_id,p_target,'editor');
  IF NOT EXISTS(SELECT 1 FROM public.companion_peer_grants g WHERE g.org_id=p_org_id
    AND g.source_companion_id=p_source AND g.target_companion_id=p_target AND g.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'peer access is not approved' USING ERRCODE='42501';
  END IF;
  -- Both calls run in this statement's transaction. Any grant, ACL, depth, or budget failure rolls
  -- the target turn back instead of leaving an untracked delegation message in its queue.
  SELECT * INTO v_enqueued FROM public.companion_api_enqueue_turn(
    p_org_id,p_target,p_target_client_message_id,p_content,
    'web'::public.companion_client_surface,'[]'::jsonb
  );
  SELECT * INTO v_delegation FROM public.companion_api_record_delegation(
    p_org_id,p_source,p_target,p_source_turn,p_source_attempt,
    (v_enqueued.turn->>'id')::uuid,p_id,p_response_mode,p_request_key,p_request_digest
  );
  RETURN QUERY SELECT to_jsonb(v_delegation),v_enqueued.turn;
END $$;
REVOKE ALL ON FUNCTION public.companion_api_enqueue_delegation(
  uuid,uuid,uuid,uuid,uuid,uuid,text,uuid,public.companion_routine_surface_mode,text,text
) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_list_delegations(p_org_id uuid,p_source uuid,p_limit integer,p_cursor uuid)
RETURNS SETOF public.companion_delegations
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
BEGIN
  PERFORM public.companion_api_require_access(p_org_id,p_source,'editor');
  RETURN QUERY SELECT * FROM public.companion_delegations d
  WHERE d.org_id=p_org_id AND d.source_companion_id=p_source
    AND (p_cursor IS NULL OR (d.created_at,d.id)<(
      SELECT c.created_at,c.id FROM public.companion_delegations c
      WHERE c.org_id=p_org_id AND c.source_companion_id=p_source AND c.id=p_cursor
    ))
  ORDER BY d.created_at DESC,d.id DESC LIMIT greatest(1,least(COALESCE(p_limit,50),100));
END $$;
REVOKE ALL ON FUNCTION public.companion_api_list_delegations(uuid,uuid,integer,uuid) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_get_delegation(p_org_id uuid,p_source uuid,p_id uuid)
RETURNS SETOF public.companion_delegations
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
BEGIN
  PERFORM public.companion_api_require_access(p_org_id,p_source,'editor');
  RETURN QUERY SELECT * FROM public.companion_delegations d
  WHERE d.org_id=p_org_id AND d.source_companion_id=p_source AND d.id=p_id;
END $$;
REVOKE ALL ON FUNCTION public.companion_api_get_delegation(uuid,uuid,uuid) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.companion_surface_delegation_result()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $$
DECLARE
  v_d public.companion_delegations%ROWTYPE; v_content text; v_event text; v_ordinal integer;
  v_client uuid:=gen_random_uuid(); v_enqueued record; v_relay uuid;
BEGIN
  IF NEW.delegation_id IS NULL OR NEW.status=OLD.status THEN RETURN NEW; END IF;
  SELECT * INTO v_d FROM public.companion_delegations d
  WHERE d.org_id=NEW.org_id AND d.id=NEW.delegation_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF;
  UPDATE public.companion_delegations SET status=NEW.status,
    settled_at=CASE WHEN NEW.status IN ('succeeded','failed','interrupted','cancelled') THEN NEW.settled_at ELSE NULL END,
    updated_at=clock_timestamp() WHERE org_id=v_d.org_id AND id=v_d.id;
  UPDATE public.companion_transcript_entries SET delegation=delegation||jsonb_build_object('status',NEW.status)
  WHERE org_id=NEW.org_id AND companion_id=NEW.companion_id
    AND turn_id=NEW.id AND delegation IS NOT NULL;
  IF NEW.status NOT IN ('succeeded','failed','interrupted','cancelled') OR v_d.delivery_status<>'pending' THEN RETURN NEW; END IF;
  IF v_d.source_companion_id IS NULL OR NOT EXISTS(
    SELECT 1 FROM public.memberships m WHERE m.org_id=v_d.org_id AND m.user_id=v_d.actor_id
  ) THEN
    UPDATE public.companion_delegations SET delivery_status='failed',delivery_error_code='source_access_revoked',updated_at=clock_timestamp()
    WHERE org_id=v_d.org_id AND id=v_d.id; RETURN NEW;
  END IF;
  PERFORM set_config('app.org_id',v_d.org_id::text,true);
  PERFORM set_config('app.user_id',v_d.actor_id,true);
  BEGIN PERFORM public.companion_api_require_access(v_d.org_id,v_d.source_companion_id,'editor');
  EXCEPTION WHEN OTHERS THEN
    UPDATE public.companion_delegations SET delivery_status='failed',delivery_error_code='source_access_revoked',updated_at=clock_timestamp()
    WHERE org_id=v_d.org_id AND id=v_d.id; RETURN NEW;
  END;
  SELECT left(e.content,16384) INTO v_content FROM public.companion_transcript_entries e
  WHERE e.org_id=v_d.org_id AND e.companion_id=NEW.companion_id AND e.turn_id=NEW.id AND e.role='assistant'
  ORDER BY e.ordinal DESC LIMIT 1;
  v_content:=COALESCE(NULLIF(v_content,''),CASE NEW.status
    WHEN 'succeeded' THEN v_d.target_companion_name||' completed the delegation without a text response.'
    ELSE v_d.target_companion_name||' ended the delegation with status '||NEW.status::text||'.' END);
  IF v_d.response_mode='relay' THEN
    SELECT * INTO v_enqueued FROM public.companion_api_enqueue_turn(
      v_d.org_id,v_d.source_companion_id,v_client,
      'Delegated response from '||v_d.target_companion_name||E':\n\n'||v_content,
      'web'::public.companion_client_surface,'[]'::jsonb
    );
    v_relay:=(v_enqueued.turn->>'id')::uuid;
    UPDATE public.companion_turns SET delegation_return_id=v_d.id
    WHERE org_id=v_d.org_id AND id=v_relay;
    UPDATE public.companion_transcript_entries SET delegation=jsonb_build_object(
      'id',v_d.id,'direction','response','companion_id',v_d.target_companion_id,
      'companion_name',v_d.target_companion_name,'response_mode',v_d.response_mode,'status',NEW.status)
    WHERE org_id=v_d.org_id AND companion_id=v_d.source_companion_id
      AND turn_id=v_relay AND role='user';
    v_event:='msg:'||v_client::text;
  ELSE
    UPDATE public.companion_threads thread
    SET next_ordinal=thread.next_ordinal+1,last_message_at=clock_timestamp(),
        updated_at=clock_timestamp()
    WHERE thread.org_id=v_d.org_id AND thread.companion_id=v_d.source_companion_id
    RETURNING thread.next_ordinal-1 INTO v_ordinal;
    IF NOT FOUND THEN
      UPDATE public.companion_delegations SET delivery_status='failed',
        delivery_error_code='source_thread_unavailable',updated_at=clock_timestamp()
      WHERE org_id=v_d.org_id AND id=v_d.id;
      RETURN NEW;
    END IF;
    v_event:='delegation:'||v_d.id::text||':response';
    INSERT INTO public.companion_transcript_entries(
      org_id,companion_id,event_id,ordinal,role,content,delegation,created_at
    ) VALUES(v_d.org_id,v_d.source_companion_id,v_event,v_ordinal,'assistant',v_content,
      jsonb_build_object('id',v_d.id,'direction','response','companion_id',v_d.target_companion_id,
        'companion_name',v_d.target_companion_name,'response_mode',v_d.response_mode,'status',NEW.status),
      clock_timestamp());
  END IF;
  UPDATE public.companion_delegations SET delivery_status='delivered',source_result_event_id=v_event,
    source_relay_turn_id=v_relay,delivered_at=clock_timestamp(),updated_at=clock_timestamp()
  WHERE org_id=v_d.org_id AND id=v_d.id;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.companion_surface_delegation_result() FROM PUBLIC;
CREATE TRIGGER companion_turns_surface_delegation_result
AFTER UPDATE OF status ON public.companion_turns FOR EACH ROW
EXECUTE FUNCTION public.companion_surface_delegation_result();
--> statement-breakpoint

-- Keep the read and background-sync projections byte-for-byte aligned while exposing the new
-- transcript metadata. Existing grants stay attached because these are CREATE OR REPLACE calls.
DO $companion_control_thread_projection$
DECLARE v_signature text; v_definition text; v_old text := $needle$'decision', entry.decision,$needle$;
  v_new text := $needle$'decision', entry.decision,
        'delegation', entry.delegation,$needle$;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.companion_api_read_thread(uuid,uuid)',
    'public.companion_api_sync_thread(uuid,uuid)'
  ] LOOP
    v_definition:=pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_signature));
    IF v_definition IS NULL OR strpos(v_definition,v_old)=0 THEN
      RAISE EXCEPTION 'Companion thread projection % cannot be extended',v_signature USING ERRCODE='55000';
    END IF;
    EXECUTE replace(v_definition,v_old,v_new);
  END LOOP;
END $companion_control_thread_projection$;
--> statement-breakpoint

-- FORCE RLS admits only the shared SECURITY DEFINER owner. All application/runtime access is via
-- the narrow functions above.
CREATE POLICY companion_control_tokens_function_owner_rls ON public.companion_control_tokens FOR ALL
  USING(current_user=pg_get_userbyid((SELECT proowner FROM pg_catalog.pg_proc WHERE oid='public.companion_resolve_control_token(text)'::regprocedure)))
  WITH CHECK(current_user=pg_get_userbyid((SELECT proowner FROM pg_catalog.pg_proc WHERE oid='public.companion_resolve_control_token(text)'::regprocedure)));
CREATE POLICY companion_control_requests_function_owner_rls ON public.companion_control_requests FOR ALL
  USING(current_user=pg_get_userbyid((SELECT proowner FROM pg_catalog.pg_proc WHERE oid='public.companion_resolve_control_token(text)'::regprocedure)))
  WITH CHECK(current_user=pg_get_userbyid((SELECT proowner FROM pg_catalog.pg_proc WHERE oid='public.companion_resolve_control_token(text)'::regprocedure)));
CREATE POLICY companion_control_invocations_function_owner_rls ON public.companion_control_invocations FOR ALL
  USING(current_user=pg_get_userbyid((SELECT proowner FROM pg_catalog.pg_proc WHERE oid='public.companion_resolve_control_token(text)'::regprocedure)))
  WITH CHECK(current_user=pg_get_userbyid((SELECT proowner FROM pg_catalog.pg_proc WHERE oid='public.companion_resolve_control_token(text)'::regprocedure)));
CREATE POLICY companion_peer_grants_function_owner_rls ON public.companion_peer_grants FOR ALL
  USING(current_user=pg_get_userbyid((SELECT proowner FROM pg_catalog.pg_proc WHERE oid='public.companion_resolve_control_token(text)'::regprocedure)))
  WITH CHECK(current_user=pg_get_userbyid((SELECT proowner FROM pg_catalog.pg_proc WHERE oid='public.companion_resolve_control_token(text)'::regprocedure)));
CREATE POLICY companion_delegations_function_owner_rls ON public.companion_delegations FOR ALL
  USING(current_user=pg_get_userbyid((SELECT proowner FROM pg_catalog.pg_proc WHERE oid='public.companion_resolve_control_token(text)'::regprocedure)))
  WITH CHECK(current_user=pg_get_userbyid((SELECT proowner FROM pg_catalog.pg_proc WHERE oid='public.companion_resolve_control_token(text)'::regprocedure)));
CREATE POLICY companion_deferred_pi_restarts_function_owner_rls ON public.companion_deferred_pi_restarts FOR ALL
  USING(current_user=pg_get_userbyid((SELECT proowner FROM pg_catalog.pg_proc WHERE oid='public.companion_resolve_control_token(text)'::regprocedure)))
  WITH CHECK(current_user=pg_get_userbyid((SELECT proowner FROM pg_catalog.pg_proc WHERE oid='public.companion_resolve_control_token(text)'::regprocedure)));
--> statement-breakpoint

-- Material protocol 5 is the first executor that always stages the control gateway capability.
CREATE OR REPLACE FUNCTION public.companion_runtime_claim_work(
  p_executor_id text,p_limit integer,p_lease_seconds integer,p_gate_epoch bigint,
  p_material_protocol integer,p_delete_resume_protocol integer
)
RETURNS TABLE(
  org_id uuid,companion_id uuid,claim_token uuid,claim_epoch bigint,gate_epoch bigint,
  work_kind public.companion_runtime_work_kind,work_id uuid,actor_id text,
  client_surface public.companion_client_surface,runtime_generation bigint,checkpoint text,
  checkpoint_sequence bigint,turn_id uuid,turn_status public.companion_turn_status,
  attempt_status public.companion_attempt_status,dispatch_state public.companion_dispatch_state,
  event_cursor bigint,unknown_event_count integer,malformed_event_count integer,
  oversized_event_count integer,cold_start_deadline_at timestamptz,
  inactivity_deadline_at timestamptz,absolute_deadline_at timestamptz,
  operation_kind public.companion_operation_kind,operation_started_at timestamptz,
  operation_attempt_count integer,provider_operation_id text,target_settings_revision bigint,
  target_skills_revision integer,decision_status public.companion_decision_status,
  decision_delivery_state public.companion_decision_delivery_state
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=on AS $$
BEGIN
  IF p_material_protocol IS DISTINCT FROM 5 THEN RETURN; END IF;
  PERFORM public.companion_runtime_expire_queued_routine_turns(greatest(1,least(COALESCE(p_limit,1),100)),p_gate_epoch);
  PERFORM public.companion_runtime_reconcile_settled_turn_starts(greatest(1,least(COALESCE(p_limit,1),100)),p_gate_epoch);
  RETURN QUERY SELECT * FROM public.companion_runtime_claim_work_material_v1(
    p_executor_id,p_limit,p_lease_seconds,p_gate_epoch,1,p_delete_resume_protocol
  );
END $$;
REVOKE ALL ON FUNCTION public.companion_runtime_claim_work(text,integer,integer,bigint,integer,integer) FROM PUBLIC;
--> statement-breakpoint

DO $companion_control_acl$
DECLARE v_runtime oid:=pg_catalog.to_regprocedure('public.companion_runtime_get_material(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)');
  v_api oid:=pg_catalog.to_regprocedure('public.companion_resolve_api_token(text,text)'); v_role name; v_grantee oid;
BEGIN
  SELECT acl.grantee INTO v_grantee FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(
    COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) acl
    WHERE p.oid=v_runtime AND acl.privilege_type='EXECUTE' AND acl.grantee NOT IN(p.proowner,0) LIMIT 1;
  IF v_grantee IS NOT NULL THEN SELECT rolname INTO v_role FROM pg_catalog.pg_roles WHERE oid=v_grantee;
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_runtime_mint_control_token(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer) TO %I',v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_runtime_claim_work(text,integer,integer,bigint,integer,integer) TO %I',v_role);
  END IF;
  v_grantee:=NULL;
  SELECT acl.grantee INTO v_grantee FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(
    COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) acl
    WHERE p.oid=v_api AND acl.privilege_type='EXECUTE' AND acl.grantee NOT IN(p.proowner,0) LIMIT 1;
  IF v_grantee IS NOT NULL THEN SELECT rolname INTO v_role FROM pg_catalog.pg_roles WHERE oid=v_grantee;
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_resolve_control_token(text) TO %I',v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_api_register_control_invocation(uuid,uuid,uuid,uuid,uuid,text,text) TO %I',v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_api_finish_control_invocation(uuid,uuid,uuid,text,text,jsonb) TO %I',v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_api_create_control_request(uuid,uuid,uuid,uuid,uuid,public.companion_control_request_kind,text,text,jsonb,text,text,text) TO %I',v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_api_get_control_request(uuid,uuid,uuid) TO %I',v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_api_decide_control_request(uuid,uuid,uuid,text) TO %I',v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_api_finish_control_request(uuid,uuid,uuid,jsonb,text,text) TO %I',v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_api_enqueue_control_continuation(uuid,uuid,uuid,text) TO %I',v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_api_list_peers(uuid,uuid) TO %I',v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_api_grant_peer_access(uuid,uuid,uuid) TO %I',v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_api_revoke_peer_access(uuid,uuid,uuid) TO %I',v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_api_record_delegation(uuid,uuid,uuid,uuid,uuid,uuid,uuid,public.companion_routine_surface_mode,text,text) TO %I',v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_api_enqueue_delegation(uuid,uuid,uuid,uuid,uuid,uuid,text,uuid,public.companion_routine_surface_mode,text,text) TO %I',v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_api_list_delegations(uuid,uuid,integer,uuid) TO %I',v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_api_get_delegation(uuid,uuid,uuid) TO %I',v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_api_schedule_pi_restart(uuid,uuid,uuid,uuid,uuid) TO %I',v_role);
  END IF;
END $companion_control_acl$;
