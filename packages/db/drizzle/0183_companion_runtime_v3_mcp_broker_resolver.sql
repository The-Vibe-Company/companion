-- The MCP broker resolver predates Runtime v3 and was not included in 0179's companion_v3_*
-- function rewrite. Resolve the current capability against the v3 aggregate so a completed
-- Runtime v2 purge cannot make a valid Box-local MCP request look unauthorized.
CREATE OR REPLACE FUNCTION public.companion_resolve_mcp_broker_token(p_token_hash text)
RETURNS TABLE (
  org_id uuid,
  companion_id uuid,
  actor_id text,
  account_refs jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_now timestamp with time zone := clock_timestamp();
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN RETURN; END IF;
  RETURN QUERY
  UPDATE public.companion_mcp_broker_tokens token
  SET last_used_at = v_now
  FROM public.companion_v3_instances instance,
       public.companions companion,
       public.memberships membership
  WHERE token.token_hash = p_token_hash
    AND token.revoked_at IS NULL
    AND token.expires_at > v_now
    AND instance.org_id = token.org_id
    AND instance.companion_id = token.companion_id
    AND instance.mcp_broker_token_id = token.id
    AND instance.desired_lifecycle = 'prepare'
    AND instance.lifecycle_state = 'active'
    AND companion.org_id = token.org_id
    AND companion.id = token.companion_id
    AND membership.org_id = token.org_id
    AND membership.user_id = token.actor_id
  RETURNING token.org_id, token.companion_id, token.actor_id, token.account_refs;
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_resolve_mcp_broker_token(text) FROM PUBLIC;
