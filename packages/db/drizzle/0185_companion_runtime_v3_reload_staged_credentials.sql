-- A prepared Companion may have staged a fresh MCP/control capability while its already-active Pi
-- daemon kept the superseded environment loaded. Expire idle affected preparations once so their
-- next ordinary Turn restages current material and activates Pi through the credential-aware path.
-- Never invalidate claimed or admitted work, an ambiguous admission handoff, terminal journal ACK,
-- or Pi recovery during the upgrade; their exact invocation fence remains authoritative. Serialize
-- the one-time decision against warm-claim writes so a lease cannot appear between the eligibility
-- check and the expiry update.
DO $companion_v3_expire_idle_mcp_preparations$
BEGIN
  LOCK TABLE public.companion_v3_lane_leases IN SHARE MODE;

  UPDATE public.companion_v3_instances instance
  SET prepared_material_expires_at = LEAST(
      instance.prepared_material_expires_at,
      clock_timestamp()
    ),
    updated_at = clock_timestamp()
WHERE instance.desired_lifecycle = 'prepare'
  AND instance.prepared_at IS NOT NULL
  AND instance.prepared_material_expires_at IS NOT NULL
  AND instance.mcp_broker_token_id IS NOT NULL
    AND NOT EXISTS (
    SELECT 1
    FROM public.companion_v3_turns turn_row
    WHERE turn_row.org_id = instance.org_id
      AND turn_row.companion_id = instance.companion_id
      AND (
        turn_row.state IN ('admitted', 'running', 'needs_input')
        OR turn_row.journal_ack_pending
        OR (turn_row.state = 'queued' AND turn_row.admission_started_at IS NOT NULL)
      )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.companion_v3_lane_leases lease
      WHERE lease.org_id = instance.org_id
        AND lease.companion_id = instance.companion_id
        AND lease.claim_token IS NOT NULL
        AND lease.expires_at > clock_timestamp()
    )
    AND instance.pi_recycle_checkpoint IS NULL;
END $companion_v3_expire_idle_mcp_preparations$;
--> statement-breakpoint

-- Activation consumes the staged provider file into tmpfs. When Pi fails to become ready, the Box
-- adapter removes that transient material, so retaining the `staged` checkpoint makes every later
-- retry start without credentials. Repair existing rows immediately and make future preparation
-- deferrals restage from durable authority instead of retrying an already-consumed checkpoint.
UPDATE public.companion_v3_instances instance
SET preparation_checkpoint = 'box_ready',
    staging_completed_at = NULL,
    pi_invocation_id = NULL,
    prepared_at = NULL,
    preparation_actor_id = NULL,
    preparation_settings_revision = NULL,
    preparation_skills_revision = NULL,
    preparation_model_id = NULL,
    preparation_provider_refs = NULL,
    preparation_skill_refs = NULL,
    preparation_mcp_refs = NULL,
    prepared_disk_layout_version = NULL,
    prepared_skills_digest = NULL,
    prepared_material_expires_at = NULL,
    preparation_available_at = clock_timestamp(),
    preparation_claim_token = NULL,
    preparation_gate_epoch = NULL,
    preparation_executor_id = NULL,
    preparation_claimed_at = NULL,
    preparation_expires_at = NULL,
    updated_at = clock_timestamp()
WHERE instance.desired_lifecycle = 'prepare'
  AND instance.preparation_checkpoint = 'staged'
  AND instance.preparation_error_code IS NOT NULL;
--> statement-breakpoint

CREATE FUNCTION public.companion_v3_restage_consumed_preparation()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.preparation_checkpoint = 'staged'
    AND NEW.preparation_checkpoint = 'staged'
    AND OLD.preparation_claim_token IS NOT NULL
    AND NEW.preparation_claim_token IS NULL
    AND NEW.preparation_error_code IS NOT NULL THEN
    NEW.preparation_checkpoint := 'box_ready';
    NEW.staging_completed_at := NULL;
    NEW.pi_invocation_id := NULL;
    NEW.prepared_at := NULL;
    NEW.preparation_actor_id := NULL;
    NEW.preparation_settings_revision := NULL;
    NEW.preparation_skills_revision := NULL;
    NEW.preparation_model_id := NULL;
    NEW.preparation_provider_refs := NULL;
    NEW.preparation_skill_refs := NULL;
    NEW.preparation_mcp_refs := NULL;
    NEW.prepared_disk_layout_version := NULL;
    NEW.prepared_skills_digest := NULL;
    NEW.prepared_material_expires_at := NULL;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_v3_restage_consumed_preparation() FROM PUBLIC;
--> statement-breakpoint

CREATE TRIGGER companion_v3_restage_consumed_preparation_trigger
BEFORE UPDATE OF preparation_claim_token, preparation_error_code
ON public.companion_v3_instances
FOR EACH ROW EXECUTE FUNCTION public.companion_v3_restage_consumed_preparation();
--> statement-breakpoint
