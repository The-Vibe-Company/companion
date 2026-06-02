// ─── Linear Agent Interaction SDK Routes ─────────────────────────────────────
// Webhook endpoint for AgentSessionEvent + OAuth callback for app installation.
// The webhook route and OAuth callback are registered BEFORE auth middleware —
// Linear handles its own signature verification via HMAC-SHA256 and the OAuth
// callback is a redirect from Linear's authorization flow (no auth token in URL).

import type { Hono } from "hono";
import type { LinearAgentBridge } from "../linear-agent-bridge.js";
import * as linearAgent from "../linear-agent.js";
import type { AgentSessionEventPayload } from "../linear-agent.js";
import * as agentStore from "../agent-store.js";
import * as staging from "../linear-staging.js";
import { getSettings, updateSettings } from "../settings-manager.js";
import { findOAuthConnectionByClientId } from "../linear-oauth-connections.js";

function sanitizeLogField(value: string | undefined): string {
  return (value || "unknown").replace(/[\r\n\t]/g, "_").slice(0, 128);
}

/**
 * Register the Linear Agent SDK pre-auth routes (before auth middleware).
 * Includes the webhook (HMAC-SHA256 verified) and the OAuth callback
 * (redirect from Linear — user has no auth token in the URL).
 */
export function registerLinearAgentWebhookRoute(
  api: Hono,
  bridge: LinearAgentBridge,
): void {
  // Webhook endpoint — verified via HMAC-SHA256 signature (per-agent lookup)
  api.post("/linear/agent-webhook", async (c) => {
    const rawBody = await c.req.text();
    const signature = c.req.header("linear-signature") ?? c.req.header("x-linear-signature");

    // Parse payload first to extract oauthClientId for agent lookup
    let payload: AgentSessionEventPayload;
    try {
      payload = JSON.parse(rawBody) as AgentSessionEventPayload;
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    // Only handle AgentSessionEvent
    if (payload.type !== "AgentSessionEvent") {
      return c.json({ ok: true, ignored: true });
    }

    const action = sanitizeLogField(payload.action);
    const oauthClientId = sanitizeLogField(payload.oauthClientId);
    const linearSessionId = sanitizeLogField(payload.agentSession?.id);

    // Look up credentials: first try OAuth connection (new model), then inline (legacy)
    const oauthConn = payload.oauthClientId ? findOAuthConnectionByClientId(payload.oauthClientId) : null;
    let webhookSecret: string;
    let agent: ReturnType<typeof agentStore.listAgents>[number] | undefined;

    if (oauthConn) {
      // New model: find agent referencing this connection
      webhookSecret = oauthConn.webhookSecret;
      agent = agentStore.listAgents().find(
        (a) => a.enabled && a.triggers?.linear?.enabled
          && a.triggers.linear.oauthConnectionId === oauthConn.id,
      );
    } else {
      // Legacy: find agent by inline oauthClientId
      agent = agentStore.listAgents().find(
        (a) => a.enabled && a.triggers?.linear?.enabled
          && a.triggers.linear.oauthClientId === payload.oauthClientId,
      );
      webhookSecret = agent?.triggers?.linear?.webhookSecret || "";
    }

    if (!agent) {
      console.error(
        `[linear-agent-routes] No agent found for oauthClientId: ${oauthClientId} action=${action} sessionId=${linearSessionId}`,
      );
      return c.json({ error: "No agent configured for this OAuth client" }, 404);
    }
    if (!linearAgent.verifyWebhookSignature(webhookSecret, rawBody, signature ?? null)) {
      console.warn(
        `[linear-agent-routes] Invalid webhook signature for oauthClientId: ${oauthClientId} action=${action} sessionId=${linearSessionId} agentId=${agent.id} signature=${signature ? "present" : "missing"}`,
      );
      return c.json({ error: "Invalid signature" }, 401);
    }

    console.log(
      `[linear-agent-routes] Accepted AgentSessionEvent action=${action} sessionId=${linearSessionId} oauthClientId=${oauthClientId} agentId=${agent.id}`,
    );

    // Dispatch asynchronously — must return 200 within 5s
    bridge.handleEvent(payload).catch((err) => {
      console.error("[linear-agent-routes] Error handling event:", err);
    });

    return c.json({ ok: true });
  });

  // OAuth callback — redirect from Linear after authorization.
  // Pre-auth because the browser lands here from Linear with no Companion auth token.
  // Protected by the OAuth `state` nonce (CSRF prevention).
  api.get("/linear/oauth/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    const error = c.req.query("error");

    if (error) {
      return c.redirect(`/#/settings/linear?oauth_error=${encodeURIComponent(error)}`);
    }

    if (!code) {
      return c.redirect("/#/settings/linear?oauth_error=no_code");
    }

    // Validate the state nonce to prevent CSRF
    const stateResult = linearAgent.validateOAuthState(state);
    if (!stateResult.valid) {
      return c.redirect("/#/settings/linear?oauth_error=invalid_state");
    }

    // Determine redirect target — validate returnTo is a safe relative hash-router path
    // to prevent open redirects (state passes through the browser and could be tampered with)
    const rawReturnTo = stateResult.returnTo;
    const redirectBase = (rawReturnTo && /^\/?#\//.test(rawReturnTo)) ? rawReturnTo : "/#/settings/linear";

    // Build redirect URI (must match what was sent in the authorize request)
    const settings = getSettings();
    const baseUrl = settings.publicUrl || `http://localhost:${process.env.PORT || 3456}`;
    const redirectUri = `${baseUrl}/api/linear/oauth/callback`;

    // Determine which credentials to use for token exchange:
    // 1. OAuth connection (new model) — connectionId in state
    // 2. Staging slot (wizard flow) — stagingId in state
    // 3. Global settings (legacy fallback)
    const { getOAuthConnection, updateOAuthConnection } = await import("../linear-oauth-connections.js");
    const oauthConnection = stateResult.connectionId ? getOAuthConnection(stateResult.connectionId) : null;
    const stagingSlot = stateResult.stagingId ? staging.getSlot(stateResult.stagingId) : null;

    // If a connectionId was in the state but the connection is gone, fail
    if (stateResult.connectionId && !oauthConnection) {
      return c.redirect(`${redirectBase}?oauth_error=${encodeURIComponent("connection_not_found")}`);
    }

    // If a stagingId was in the state but the slot is gone (expired/deleted), don't silently
    // fall back to global settings — that would use the wrong OAuth app's credentials
    if (stateResult.stagingId && !stagingSlot) {
      return c.redirect(`${redirectBase}?oauth_error=${encodeURIComponent("staging_slot_expired")}`);
    }

    const clientId = oauthConnection?.oauthClientId || stagingSlot?.clientId || settings.linearOAuthClientId;
    const clientSecret = oauthConnection?.oauthClientSecret || stagingSlot?.clientSecret || settings.linearOAuthClientSecret;

    const tokens = await linearAgent.exchangeCodeForTokens(
      { clientId, clientSecret },
      code,
      redirectUri,
    );
    if (!tokens) {
      return c.redirect(`${redirectBase}?oauth_error=token_exchange_failed`);
    }

    // Persist tokens to the appropriate store
    if (stateResult.connectionId && oauthConnection) {
      // New model: store tokens directly in the OAuth connection
      updateOAuthConnection(stateResult.connectionId, {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        status: "connected",
      });
    } else if (stateResult.stagingId) {
      staging.updateSlotTokens(stateResult.stagingId, tokens);
    } else {
      updateSettings({
        linearOAuthAccessToken: tokens.accessToken,
        linearOAuthRefreshToken: tokens.refreshToken,
      });
    }

    console.log("[linear-agent-routes] OAuth tokens obtained successfully");
    return c.redirect(`${redirectBase}?oauth_success=true`);
  });
}

/**
 * Register protected Linear Agent SDK routes (after auth middleware).
 * Status + authorize URL + disconnect + staging slot endpoints.
 */
export function registerLinearAgentProtectedRoutes(api: Hono): void {
  // ── Staging slot CRUD ──────────────────────────────────────────────────

  // Create a staging slot for the wizard flow
  api.post("/linear/oauth/staging", async (c) => {
    const body = await c.req.json() as {
      clientId?: string;
      clientSecret?: string;
      webhookSecret?: string;
    };

    const clientId = (body.clientId || "").trim();
    const clientSecret = (body.clientSecret || "").trim();
    const webhookSecret = (body.webhookSecret || "").trim();

    if (!clientId || !clientSecret || !webhookSecret) {
      return c.json({ error: "clientId, clientSecret, and webhookSecret are required" }, 400);
    }

    const stagingId = staging.createSlot({ clientId, clientSecret, webhookSecret });
    return c.json({ stagingId });
  });

  // Check staging slot status
  api.get("/linear/oauth/staging/:id/status", (c) => {
    const id = c.req.param("id");
    const slot = staging.getSlot(id);
    if (!slot) {
      return c.json({ exists: false, hasAccessToken: false, hasClientId: false, hasClientSecret: false });
    }
    return c.json({
      exists: true,
      hasAccessToken: !!slot.accessToken,
      hasClientId: !!slot.clientId,
      hasClientSecret: !!slot.clientSecret,
    });
  });

  // Delete a staging slot
  api.delete("/linear/oauth/staging/:id", (c) => {
    const id = c.req.param("id");
    staging.deleteSlot(id);
    return c.json({ ok: true });
  });

  // ── OAuth flow endpoints ───────────────────────────────────────────────

  // Get OAuth authorize URL for installing the app
  api.get("/linear/oauth/authorize-url", (c) => {
    const settings = getSettings();
    const baseUrl = settings.publicUrl || `http://localhost:${process.env.PORT || 3456}`;
    const redirectUri = `${baseUrl}/api/linear/oauth/callback`;
    const returnTo = c.req.query("returnTo");
    const stagingId = c.req.query("stagingId");

    // Validate returnTo is a safe relative hash-router path to prevent open redirects
    const safeReturnTo = returnTo && /^\/?#\//.test(returnTo) ? returnTo : undefined;

    // Use staging slot's clientId if provided, fall back to global settings
    const slot = stagingId ? staging.getSlot(stagingId) : null;

    // If a stagingId was provided but the slot is expired/missing, fail early
    // rather than generating a URL that will fail at callback time
    if (stagingId && !slot) {
      return c.json({ error: "Staging slot expired or not found" }, 404);
    }

    const clientId = slot?.clientId || settings.linearOAuthClientId;

    const result = linearAgent.getOAuthAuthorizeUrl(clientId, redirectUri, {
      returnTo: safeReturnTo,
      stagingId,
    });

    if (!result) {
      return c.json({ error: "OAuth client ID not configured" }, 400);
    }

    return c.json({ url: result.url });
  });

  // Check OAuth configuration status (global or staging slot)
  api.get("/linear/oauth/status", (c) => {
    const stagingId = c.req.query("stagingId");

    if (stagingId) {
      const slot = staging.getSlot(stagingId);
      return c.json({
        configured: !!(slot?.clientId && slot?.clientSecret && slot?.accessToken),
        hasClientId: !!slot?.clientId,
        hasClientSecret: !!slot?.clientSecret,
        hasWebhookSecret: !!slot?.webhookSecret,
        hasAccessToken: !!slot?.accessToken,
      });
    }

    const settings = getSettings();
    return c.json({
      configured: linearAgent.isLinearOAuthConfigured({
        clientId: settings.linearOAuthClientId,
        clientSecret: settings.linearOAuthClientSecret,
        accessToken: settings.linearOAuthAccessToken,
      }),
      hasClientId: !!settings.linearOAuthClientId.trim(),
      hasClientSecret: !!settings.linearOAuthClientSecret.trim(),
      hasWebhookSecret: !!settings.linearOAuthWebhookSecret.trim(),
      hasAccessToken: !!settings.linearOAuthAccessToken.trim(),
    });
  });

  // Disconnect OAuth (clear tokens)
  api.post("/linear/oauth/disconnect", (c) => {
    updateSettings({
      linearOAuthAccessToken: "",
      linearOAuthRefreshToken: "",
    });
    return c.json({ ok: true });
  });
}
