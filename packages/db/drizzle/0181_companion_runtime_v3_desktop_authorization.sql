-- Repair the desktop authorization function after Runtime v3 contraction. Migration 0179
-- mechanically retargeted the v2 function to companion_v3_instances, but the function still read
-- retired generation, Box-state, and applied-revision columns. Desktop is an observation-only
-- action: it may mint for an already-live v3 Prepared proof and must never create, resume, stage,
-- recycle, archive, or delete a Box.
CREATE OR REPLACE FUNCTION public.companion_runtime_authorize_desktop(
  p_org_id uuid,
  p_companion_id uuid,
  p_actor_id text
)
RETURNS TABLE (
  authorized boolean,
  denial_code text,
  box_id text,
  box_state public.companion_box_observed_state,
  runtime_generation bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_instance public.companion_v3_instances%ROWTYPE;
  v_companion public.companions%ROWTYPE;
  v_provider_refs jsonb;
  v_mcp_refs jsonb;
  v_provider_count integer;
  v_skill_count integer;
  v_mcp_count integer;
BEGIN
  IF p_actor_id IS NULL OR char_length(p_actor_id) NOT BETWEEN 1 AND 200
     OR p_actor_id ~ E'[\n\r]' THEN
    RAISE EXCEPTION 'invalid desktop authorization actor' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.companion_runtime_control control
    WHERE control.id = 'runtime-v3' AND control.enabled
  ) THEN
    RETURN QUERY SELECT false, 'runtime_disabled'::text, NULL::text,
      NULL::public.companion_box_observed_state, NULL::bigint;
    RETURN;
  END IF;

  -- Runtime claims and API settings mutations lock the v3 instance before the Companion. Hold the
  -- same order through this decision so a concurrent invalidation cannot expose stale Box disk.
  SELECT instance.* INTO v_instance
  FROM public.companion_v3_instances instance
  WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id
  FOR SHARE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'not_authorized'::text, NULL::text,
      NULL::public.companion_box_observed_state, NULL::bigint;
    RETURN;
  END IF;

  SELECT companion.* INTO v_companion
  FROM public.memberships membership
  JOIN public.companions companion
    ON companion.org_id = membership.org_id AND companion.id = p_companion_id
  WHERE membership.org_id = p_org_id
    AND membership.user_id = p_actor_id
    AND companion.org_id = p_org_id
  FOR SHARE OF membership, companion;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'not_authorized'::text, NULL::text,
      NULL::public.companion_box_observed_state, NULL::bigint;
    RETURN;
  END IF;

  IF v_companion.owner_id <> p_actor_id THEN
    PERFORM 1
    FROM public.companion_workspace_access access
    WHERE access.org_id = p_org_id
      AND access.companion_id = p_companion_id
      AND access.role = 'editor'
    FOR SHARE;
    IF NOT FOUND THEN
      RETURN QUERY SELECT false, 'not_authorized'::text, NULL::text,
        NULL::public.companion_box_observed_state, NULL::bigint;
      RETURN;
    END IF;
  END IF;

  -- These are the complete v3 facts that mean the existing Box is live and fully prepared. This
  -- function deliberately has no lifecycle side effect and cannot make an ineligible Box eligible.
  IF v_instance.desired_lifecycle <> 'prepare'
     OR v_instance.lifecycle_state <> 'active'
     OR v_instance.box_id IS NULL
     OR v_instance.preparation_checkpoint <> 'prepared'
     OR v_instance.prepared_at IS NULL
     OR v_instance.pi_invocation_id IS NULL
     OR v_instance.pi_recycle_checkpoint IS NOT NULL
     OR v_instance.prepared_material_expires_at IS NULL
     OR v_instance.prepared_material_expires_at <= v_now THEN
    RETURN QUERY SELECT false, 'box_unavailable'::text, NULL::text,
      NULL::public.companion_box_observed_state, NULL::bigint;
    RETURN;
  END IF;

  IF jsonb_typeof(v_companion.provider_ids) IS DISTINCT FROM 'array'
     OR jsonb_typeof(v_companion.selected_skill_ids) IS DISTINCT FROM 'array'
     OR jsonb_typeof(v_companion.selected_mcp_account_ids) IS DISTINCT FROM 'array'
     OR jsonb_typeof(v_instance.preparation_provider_refs) IS DISTINCT FROM 'array'
     OR jsonb_typeof(v_instance.preparation_skill_refs) IS DISTINCT FROM 'array'
     OR jsonb_typeof(v_instance.preparation_mcp_refs) IS DISTINCT FROM 'array'
     OR v_instance.preparation_actor_id IS DISTINCT FROM p_actor_id THEN
    RETURN QUERY SELECT false, 'resource_access_revoked'::text, NULL::text,
      NULL::public.companion_box_observed_state, NULL::bigint;
    RETURN;
  END IF;

  -- v3 stages the latest available Skill revision, while dispatch and desktop require only the
  -- minimum selection revision. A publication-only revision may therefore remain pending.
  IF v_instance.preparation_settings_revision
       IS DISTINCT FROM v_instance.desired_settings_revision
     OR v_instance.preparation_skills_revision IS NULL
     OR v_instance.preparation_skills_revision < v_companion.skills_revision
     OR v_instance.preparation_model_id IS DISTINCT FROM v_companion.model_id THEN
    RETURN QUERY SELECT false, 'settings_not_applied'::text, NULL::text,
      NULL::public.companion_box_observed_state, NULL::bigint;
    RETURN;
  END IF;

  -- Resource mutation takes the resource row before its v3 invalidation trigger takes the
  -- instance. NOWAIT turns that inverse-order race into a stable denial instead of a deadlock.
  BEGIN
    PERFORM connection.provider_id
    FROM jsonb_array_elements_text(v_companion.provider_ids) selected(provider_id)
    JOIN public.companion_provider_connections connection
      ON connection.org_id = p_org_id AND connection.provider_id = selected.provider_id
    ORDER BY connection.provider_id
    FOR SHARE OF connection NOWAIT;

    PERFORM skill.id
    FROM jsonb_array_elements_text(v_companion.selected_skill_ids) selected(skill_id)
    JOIN public.skills skill
      ON skill.org_id = p_org_id AND skill.id::text = selected.skill_id
    ORDER BY skill.id
    FOR SHARE OF skill NOWAIT;

    PERFORM account.id
    FROM jsonb_array_elements_text(v_companion.selected_mcp_account_ids) selected(account_id)
    JOIN public.companion_mcp_accounts account
      ON account.org_id = p_org_id AND account.id::text = selected.account_id
    ORDER BY account.id
    FOR SHARE OF account NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RETURN QUERY SELECT false, 'settings_not_applied'::text, NULL::text,
      NULL::public.companion_box_observed_state, NULL::bigint;
    RETURN;
  END;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'provider_id', connection.provider_id,
      'credential_generation', connection.credential_generation,
      'credential_version', connection.credential_version
    ) ORDER BY connection.provider_id), '[]'::jsonb), count(*)::integer
  INTO v_provider_refs, v_provider_count
  FROM public.companion_provider_connections connection
  WHERE connection.org_id = p_org_id
    AND v_companion.provider_ids ? connection.provider_id;

  SELECT count(*)::integer INTO v_skill_count
  FROM public.skills skill
  WHERE skill.org_id = p_org_id
    AND v_companion.selected_skill_ids ? skill.id::text
    AND skill.archived_at IS NULL
    AND skill.validation = 'valid'
    AND skill.current_version_id IS NOT NULL
    AND (skill.scope = 'org' OR skill.creator_id = p_actor_id);

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'account_id', account.id,
      'credential_generation', account.credential_generation,
      'credential_version', account.credential_version
    ) ORDER BY account.id), '[]'::jsonb), count(*)::integer
  INTO v_mcp_refs, v_mcp_count
  FROM public.companion_mcp_accounts account
  WHERE account.org_id = p_org_id
    AND v_companion.selected_mcp_account_ids ? account.id::text
    AND account.owner_id = p_actor_id;

  IF jsonb_array_length(v_companion.provider_ids) <> 1
     OR v_provider_count <> 1
     OR v_provider_refs IS DISTINCT FROM v_instance.preparation_provider_refs
     OR v_skill_count <> jsonb_array_length(v_companion.selected_skill_ids)
     OR jsonb_array_length(v_instance.preparation_skill_refs)
       <> jsonb_array_length(v_companion.selected_skill_ids)
     OR EXISTS (
       SELECT 1
       FROM jsonb_array_elements_text(v_companion.selected_skill_ids) selected(skill_id)
       WHERE NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(v_instance.preparation_skill_refs) prepared(ref)
         WHERE prepared.ref->>'skill_id' = selected.skill_id
       )
     )
     OR v_mcp_count <> jsonb_array_length(v_companion.selected_mcp_account_ids)
     OR v_mcp_refs IS DISTINCT FROM v_instance.preparation_mcp_refs THEN
    RETURN QUERY SELECT false, 'resource_access_revoked'::text, NULL::text,
      NULL::public.companion_box_observed_state, NULL::bigint;
    RETURN;
  END IF;

  -- Runtime v3 has one persistent Box and no generation/observed-state authority. The retained
  -- return columns are decode-only compatibility values; callers use only authorized + box_id.
  RETURN QUERY SELECT true, NULL::text, v_instance.box_id,
    'ready'::public.companion_box_observed_state, 1::bigint;
END
$$;
--> statement-breakpoint

COMMENT ON FUNCTION public.companion_runtime_authorize_desktop(uuid, uuid, text) IS
  'Authorizes observation-only desktop minting for an actor-bound live Runtime v3 Prepared Box. box_state=ready and runtime_generation=1 are non-authoritative wire-compatibility values.';
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_runtime_authorize_desktop(uuid, uuid, text) FROM PUBLIC;
