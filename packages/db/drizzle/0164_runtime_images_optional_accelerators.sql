-- Runtime images are optional accelerators. Their builder retains an independent, fenced lease;
-- a Turn never waits for this retry schedule and cold-installs whenever readiness is not published.

CREATE OR REPLACE FUNCTION public.companion_runtime_image_claim(
  p_executor_id text,
  p_digest text,
  p_image_name text
)
RETURNS TABLE (
  image_digest text,
  image_name text,
  image_claim_epoch bigint,
  image_attempt_count integer,
  image_build_box_id text,
  image_build_delete_intent_recorded boolean,
  image_build_delete_operation_id text,
  image_recovery_only boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN QUERY
  WITH candidate AS (
    SELECT
      row.digest,
      row.status = 'building' AND row.attempt_count >= 4 AS recovery_only
    FROM public.companion_images row
    WHERE row.digest = p_digest
      AND row.image_name = p_image_name
      AND (
        (row.status IN ('requested', 'failed')
          AND row.next_attempt_at <= clock_timestamp()
          AND row.attempt_count < 4)
        OR (row.status = 'building' AND row.lease_expires_at < clock_timestamp())
      )
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  ), claimed AS (
    UPDATE public.companion_images target
    SET status = 'building',
        claim_epoch = coalesce(target.claim_epoch, 0) + 1,
        claim_actor_id = p_executor_id,
        claimed_at = clock_timestamp(),
        lease_expires_at = clock_timestamp() + make_interval(secs => 2700),
        building_at = coalesce(target.building_at, clock_timestamp()),
        attempt_count = CASE
          WHEN candidate.recovery_only THEN target.attempt_count
          ELSE target.attempt_count + 1
        END,
        last_error_code = null,
        last_error_message = null,
        updated_at = clock_timestamp()
    FROM candidate
    WHERE target.digest = candidate.digest
    RETURNING
      target.digest,
      target.image_name,
      target.claim_epoch,
      target.attempt_count,
      target.build_box_id,
      target.build_delete_intent_at IS NOT NULL AS delete_intent_recorded,
      target.build_delete_operation_id,
      candidate.recovery_only
  )
  SELECT
    claimed.digest,
    claimed.image_name,
    claimed.claim_epoch,
    claimed.attempt_count,
    claimed.build_box_id,
    claimed.delete_intent_recorded,
    claimed.build_delete_operation_id,
    claimed.recovery_only
  FROM claimed;
END;
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_runtime_image_authorize_publish(
  p_digest text,
  p_claim_epoch bigint,
  p_build_box_id text
)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.companion_images row
    WHERE row.digest = p_digest
      AND row.status = 'building'
      AND row.claim_epoch = p_claim_epoch
      AND row.build_box_id = p_build_box_id
      -- saveNamedSnapshot has a 30-second provider deadline. Keep additional headroom so the
      -- claim cannot become reclaimable while that irreversible publication request is in flight.
      AND row.lease_expires_at > clock_timestamp() + interval '45 seconds'
  );
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.companion_runtime_image_mark_building_box(
  p_digest text,
  p_claim_epoch bigint,
  p_build_box_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_updated integer;
BEGIN
  UPDATE public.companion_images
  SET build_box_id = p_build_box_id,
      build_delete_intent_at = null,
      build_delete_operation_id = null,
      updated_at = clock_timestamp()
  WHERE digest = p_digest
    AND claim_epoch = p_claim_epoch
    AND status = 'building'
    AND lease_expires_at > clock_timestamp();
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.companion_runtime_image_mark_delete_intent(
  p_digest text,
  p_claim_epoch bigint,
  p_build_box_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_updated integer;
BEGIN
  UPDATE public.companion_images
  SET build_delete_intent_at = coalesce(build_delete_intent_at, clock_timestamp()),
      updated_at = clock_timestamp()
  WHERE digest = p_digest
    AND claim_epoch = p_claim_epoch
    AND status = 'building'
    AND build_box_id = p_build_box_id
    AND lease_expires_at > clock_timestamp();
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.companion_runtime_image_mark_delete_operation(
  p_digest text,
  p_claim_epoch bigint,
  p_build_box_id text,
  p_operation_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_updated integer;
BEGIN
  UPDATE public.companion_images
  SET build_delete_operation_id = p_operation_id, updated_at = clock_timestamp()
  WHERE digest = p_digest
    AND claim_epoch = p_claim_epoch
    AND status = 'building'
    AND build_box_id = p_build_box_id
    AND build_delete_intent_at IS NOT NULL
    AND lease_expires_at > clock_timestamp()
    AND (build_delete_operation_id IS NULL OR build_delete_operation_id = p_operation_id);
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.companion_runtime_image_clear_building_box(
  p_digest text,
  p_claim_epoch bigint,
  p_build_box_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_updated integer;
BEGIN
  UPDATE public.companion_images
  SET build_box_id = null,
      build_delete_intent_at = null,
      build_delete_operation_id = null,
      updated_at = clock_timestamp()
  WHERE digest = p_digest
    AND claim_epoch = p_claim_epoch
    AND status = 'building'
    AND build_box_id = p_build_box_id
    AND lease_expires_at > clock_timestamp();
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.companion_runtime_image_record_ready(
  p_digest text,
  p_claim_epoch bigint,
  p_image_name text,
  p_parent_image_name text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_updated integer;
BEGIN
  UPDATE public.companion_images
  SET status = 'ready',
      ready_at = clock_timestamp(),
      parent_image_name = p_parent_image_name,
      build_box_id = null,
      build_delete_intent_at = null,
      build_delete_operation_id = null,
      claim_actor_id = null,
      claimed_at = null,
      lease_expires_at = null,
      updated_at = clock_timestamp()
  WHERE digest = p_digest
    AND image_name = p_image_name
    AND claim_epoch = p_claim_epoch
    AND status = 'building'
    AND lease_expires_at > clock_timestamp();
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.companion_runtime_image_record_failure(
  p_digest text,
  p_claim_epoch bigint,
  p_error_code text,
  p_error_message text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_new_status public.companion_image_status;
  v_retry_base_seconds integer;
  v_retry_jitter_seconds integer;
BEGIN
  IF p_error_code !~ '^[a-z][a-z0-9_]{0,63}$' THEN
    RAISE EXCEPTION 'image build error code must be a stable snake_case token';
  END IF;
  SELECT CASE attempt_count
      WHEN 1 THEN 60
      WHEN 2 THEN 300
      WHEN 3 THEN 900
      ELSE 3600
    END
    INTO v_retry_base_seconds
  FROM public.companion_images
  WHERE digest = p_digest
    AND claim_epoch = p_claim_epoch
    AND status = 'building'
    AND lease_expires_at > clock_timestamp();
  IF NOT FOUND THEN
    RETURN 'lease_lost';
  END IF;
  -- Positive jitter avoids synchronized replicas while preserving the documented base schedule.
  v_retry_jitter_seconds := floor(random() * greatest(1, v_retry_base_seconds / 5))::integer;
  UPDATE public.companion_images
  SET status = (CASE WHEN attempt_count >= 4 THEN 'failed' ELSE 'requested' END
      )::public.companion_image_status,
      next_attempt_at = clock_timestamp()
        + make_interval(secs => v_retry_base_seconds + v_retry_jitter_seconds),
      last_error_code = p_error_code,
      last_error_message = left(p_error_message, 500),
      claim_actor_id = null,
      claimed_at = null,
      lease_expires_at = null,
      updated_at = clock_timestamp()
  WHERE digest = p_digest
    AND claim_epoch = p_claim_epoch
    AND status = 'building';
  SELECT status INTO v_new_status FROM public.companion_images WHERE digest = p_digest;
  RETURN v_new_status::text;
END;
$$;
