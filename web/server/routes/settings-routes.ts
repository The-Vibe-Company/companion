import type { Hono } from "hono";
import { DEFAULT_ANTHROPIC_MODEL, getSettings, updateSettings, type ClaudeAuthMethod, type CodexAuthMethod, type UpdateChannel } from "../settings-manager.js";
import { linearCache } from "../linear-cache.js";
import { listConnections } from "../linear-connections.js";
import { hasContainerClaudeAuth } from "../claude-container-auth.js";
import { hasContainerCodexAuth } from "../codex-container-auth.js";
import { verifyLocalCliAuth } from "../provider-local-auth.js";

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function isHttpUrl(value: string): boolean {
  return value === "" || /^https?:\/\/.+/.test(value);
}

function modelsUrl(baseUrl: string): string {
  const cleanBase = baseUrl.replace(/\/+$/, "");
  return cleanBase.endsWith("/v1") ? `${cleanBase}/models` : `${cleanBase}/v1/models`;
}

export function registerSettingsRoutes(api: Hono): void {
  api.get("/settings", (c) => {
    const settings = getSettings();
    const connections = listConnections();
    return c.json({
      anthropicApiKeyConfigured: !!settings.anthropicApiKey.trim(),
      anthropicModel: settings.anthropicModel || DEFAULT_ANTHROPIC_MODEL,
      claudeCodeOAuthTokenConfigured: !!settings.claudeCodeOAuthToken.trim(),
      claudeApiKeyConfigured: !!(settings.claudeApiKey ?? "").trim(),
      claudeAuthMethod: settings.claudeAuthMethod ?? "local",
      claudeBaseUrl: settings.claudeBaseUrl,
      claudeDeviceAuthConfigured: hasContainerClaudeAuth(),
      openaiApiKeyConfigured: !!settings.openaiApiKey.trim(),
      codexAuthMethod: settings.codexAuthMethod ?? "local",
      openaiBaseUrl: settings.openaiBaseUrl,
      codexDeviceAuthConfigured: hasContainerCodexAuth(),
      onboardingCompleted: settings.onboardingCompleted,
      linearApiKeyConfigured: !!settings.linearApiKey.trim() || connections.length > 0,
      linearConnectionCount: connections.length,
      linearAutoTransition: settings.linearAutoTransition,
      linearAutoTransitionStateName: settings.linearAutoTransitionStateName,
      linearArchiveTransition: settings.linearArchiveTransition,
      linearArchiveTransitionStateName: settings.linearArchiveTransitionStateName,
      linearOAuthConfigured: !!(settings.linearOAuthClientId.trim() && settings.linearOAuthClientSecret.trim() && settings.linearOAuthAccessToken.trim()),
      linearOAuthCredentialsSaved: !!(settings.linearOAuthClientId.trim() && settings.linearOAuthClientSecret.trim()),
      aiValidationEnabled: settings.aiValidationEnabled,
      aiValidationAutoApprove: settings.aiValidationAutoApprove,
      aiValidationAutoDeny: settings.aiValidationAutoDeny,
      publicUrl: settings.publicUrl,
      updateChannel: settings.updateChannel,
      dockerAutoUpdate: settings.dockerAutoUpdate,
    });
  });

  api.put("/settings", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (body.anthropicApiKey !== undefined && typeof body.anthropicApiKey !== "string") {
      return c.json({ error: "anthropicApiKey must be a string" }, 400);
    }
    if (body.anthropicModel !== undefined && typeof body.anthropicModel !== "string") {
      return c.json({ error: "anthropicModel must be a string" }, 400);
    }
    if (body.linearApiKey !== undefined && typeof body.linearApiKey !== "string") {
      return c.json({ error: "linearApiKey must be a string" }, 400);
    }
    if (body.linearAutoTransition !== undefined && typeof body.linearAutoTransition !== "boolean") {
      return c.json({ error: "linearAutoTransition must be a boolean" }, 400);
    }
    if (body.linearAutoTransitionStateId !== undefined && typeof body.linearAutoTransitionStateId !== "string") {
      return c.json({ error: "linearAutoTransitionStateId must be a string" }, 400);
    }
    if (body.linearAutoTransitionStateName !== undefined && typeof body.linearAutoTransitionStateName !== "string") {
      return c.json({ error: "linearAutoTransitionStateName must be a string" }, 400);
    }
    if (body.linearArchiveTransition !== undefined && typeof body.linearArchiveTransition !== "boolean") {
      return c.json({ error: "linearArchiveTransition must be a boolean" }, 400);
    }
    if (body.linearArchiveTransitionStateId !== undefined && typeof body.linearArchiveTransitionStateId !== "string") {
      return c.json({ error: "linearArchiveTransitionStateId must be a string" }, 400);
    }
    if (body.linearArchiveTransitionStateName !== undefined && typeof body.linearArchiveTransitionStateName !== "string") {
      return c.json({ error: "linearArchiveTransitionStateName must be a string" }, 400);
    }
    if (body.aiValidationEnabled !== undefined && typeof body.aiValidationEnabled !== "boolean") {
      return c.json({ error: "aiValidationEnabled must be a boolean" }, 400);
    }
    if (body.aiValidationAutoApprove !== undefined && typeof body.aiValidationAutoApprove !== "boolean") {
      return c.json({ error: "aiValidationAutoApprove must be a boolean" }, 400);
    }
    if (body.aiValidationAutoDeny !== undefined && typeof body.aiValidationAutoDeny !== "boolean") {
      return c.json({ error: "aiValidationAutoDeny must be a boolean" }, 400);
    }
    if (body.publicUrl !== undefined) {
      if (typeof body.publicUrl !== "string") {
        return c.json({ error: "publicUrl must be a string" }, 400);
      }
      const trimmed = body.publicUrl.trim().replace(/\/+$/, "");
      if (trimmed !== "" && !/^https?:\/\/.+/.test(trimmed)) {
        return c.json({ error: "publicUrl must be a valid http/https URL" }, 400);
      }
    }
    if (body.updateChannel !== undefined && body.updateChannel !== "stable" && body.updateChannel !== "prerelease") {
      return c.json({ error: "updateChannel must be 'stable' or 'prerelease'" }, 400);
    }
    if (body.linearOAuthClientId !== undefined && typeof body.linearOAuthClientId !== "string") {
      return c.json({ error: "linearOAuthClientId must be a string" }, 400);
    }
    if (body.linearOAuthClientSecret !== undefined && typeof body.linearOAuthClientSecret !== "string") {
      return c.json({ error: "linearOAuthClientSecret must be a string" }, 400);
    }
    if (body.linearOAuthWebhookSecret !== undefined && typeof body.linearOAuthWebhookSecret !== "string") {
      return c.json({ error: "linearOAuthWebhookSecret must be a string" }, 400);
    }
    if (body.claudeCodeOAuthToken !== undefined && typeof body.claudeCodeOAuthToken !== "string") {
      return c.json({ error: "claudeCodeOAuthToken must be a string" }, 400);
    }
    if (body.claudeApiKey !== undefined && typeof body.claudeApiKey !== "string") {
      return c.json({ error: "claudeApiKey must be a string" }, 400);
    }
    if (
      body.claudeAuthMethod !== undefined
      && body.claudeAuthMethod !== "local"
      && body.claudeAuthMethod !== "oauth"
      && body.claudeAuthMethod !== "apiKey"
    ) {
      return c.json({ error: "claudeAuthMethod must be 'local', 'oauth', or 'apiKey'" }, 400);
    }
    if (body.claudeBaseUrl !== undefined) {
      if (typeof body.claudeBaseUrl !== "string") {
        return c.json({ error: "claudeBaseUrl must be a string" }, 400);
      }
      if (!isHttpUrl(normalizeBaseUrl(body.claudeBaseUrl))) {
        return c.json({ error: "claudeBaseUrl must be a valid http/https URL" }, 400);
      }
    }
    if (body.openaiApiKey !== undefined && typeof body.openaiApiKey !== "string") {
      return c.json({ error: "openaiApiKey must be a string" }, 400);
    }
    if (
      body.codexAuthMethod !== undefined
      && body.codexAuthMethod !== "local"
      && body.codexAuthMethod !== "apiKey"
    ) {
      return c.json({ error: "codexAuthMethod must be 'local' or 'apiKey'" }, 400);
    }
    if (body.openaiBaseUrl !== undefined) {
      if (typeof body.openaiBaseUrl !== "string") {
        return c.json({ error: "openaiBaseUrl must be a string" }, 400);
      }
      if (!isHttpUrl(normalizeBaseUrl(body.openaiBaseUrl))) {
        return c.json({ error: "openaiBaseUrl must be a valid http/https URL" }, 400);
      }
    }
    if (body.onboardingCompleted !== undefined && typeof body.onboardingCompleted !== "boolean") {
      return c.json({ error: "onboardingCompleted must be a boolean" }, 400);
    }
    if (body.dockerAutoUpdate !== undefined && typeof body.dockerAutoUpdate !== "boolean") {
      return c.json({ error: "dockerAutoUpdate must be a boolean" }, 400);
    }
    const hasAnyField = body.anthropicApiKey !== undefined || body.anthropicModel !== undefined
      || body.claudeCodeOAuthToken !== undefined || body.claudeApiKey !== undefined
      || body.claudeAuthMethod !== undefined || body.claudeBaseUrl !== undefined
      || body.openaiApiKey !== undefined || body.codexAuthMethod !== undefined || body.openaiBaseUrl !== undefined
      || body.onboardingCompleted !== undefined
      || body.linearApiKey !== undefined || body.linearAutoTransition !== undefined
      || body.linearAutoTransitionStateId !== undefined || body.linearAutoTransitionStateName !== undefined
      || body.linearArchiveTransition !== undefined || body.linearArchiveTransitionStateId !== undefined
      || body.linearArchiveTransitionStateName !== undefined
      || body.linearOAuthClientId !== undefined || body.linearOAuthClientSecret !== undefined
      || body.linearOAuthWebhookSecret !== undefined
      || body.aiValidationEnabled !== undefined || body.aiValidationAutoApprove !== undefined
      || body.aiValidationAutoDeny !== undefined
      || body.publicUrl !== undefined
      || body.updateChannel !== undefined
      || body.dockerAutoUpdate !== undefined;
    if (!hasAnyField) {
      return c.json({ error: "At least one settings field is required" }, 400);
    }

    if (typeof body.linearApiKey === "string") {
      linearCache.clear();
    }

    const settings = updateSettings({
      anthropicApiKey:
        typeof body.anthropicApiKey === "string"
          ? body.anthropicApiKey.trim()
          : undefined,
      anthropicModel:
        typeof body.anthropicModel === "string"
          ? (body.anthropicModel.trim() || DEFAULT_ANTHROPIC_MODEL)
          : undefined,
      claudeCodeOAuthToken:
        typeof body.claudeCodeOAuthToken === "string"
          ? body.claudeCodeOAuthToken.trim()
          : undefined,
      claudeApiKey:
        typeof body.claudeApiKey === "string"
          ? body.claudeApiKey.trim()
          : undefined,
      claudeAuthMethod:
        body.claudeAuthMethod === "local" || body.claudeAuthMethod === "oauth" || body.claudeAuthMethod === "apiKey"
          ? (body.claudeAuthMethod as ClaudeAuthMethod)
          : undefined,
      claudeBaseUrl:
        typeof body.claudeBaseUrl === "string"
          ? normalizeBaseUrl(body.claudeBaseUrl)
          : undefined,
      openaiApiKey:
        typeof body.openaiApiKey === "string"
          ? body.openaiApiKey.trim()
          : undefined,
      codexAuthMethod:
        body.codexAuthMethod === "local" || body.codexAuthMethod === "apiKey"
          ? (body.codexAuthMethod as CodexAuthMethod)
          : undefined,
      openaiBaseUrl:
        typeof body.openaiBaseUrl === "string"
          ? normalizeBaseUrl(body.openaiBaseUrl)
          : undefined,
      onboardingCompleted:
        typeof body.onboardingCompleted === "boolean"
          ? body.onboardingCompleted
          : undefined,
      linearApiKey:
        typeof body.linearApiKey === "string"
          ? body.linearApiKey.trim()
          : undefined,
      linearAutoTransition:
        typeof body.linearAutoTransition === "boolean"
          ? body.linearAutoTransition
          : undefined,
      linearAutoTransitionStateId:
        typeof body.linearAutoTransitionStateId === "string"
          ? body.linearAutoTransitionStateId.trim()
          : undefined,
      linearAutoTransitionStateName:
        typeof body.linearAutoTransitionStateName === "string"
          ? body.linearAutoTransitionStateName.trim()
          : undefined,
      linearArchiveTransition:
        typeof body.linearArchiveTransition === "boolean"
          ? body.linearArchiveTransition
          : undefined,
      linearArchiveTransitionStateId:
        typeof body.linearArchiveTransitionStateId === "string"
          ? body.linearArchiveTransitionStateId.trim()
          : undefined,
      linearArchiveTransitionStateName:
        typeof body.linearArchiveTransitionStateName === "string"
          ? body.linearArchiveTransitionStateName.trim()
          : undefined,
      linearOAuthClientId:
        typeof body.linearOAuthClientId === "string"
          ? body.linearOAuthClientId.trim()
          : undefined,
      linearOAuthClientSecret:
        typeof body.linearOAuthClientSecret === "string"
          ? body.linearOAuthClientSecret.trim()
          : undefined,
      linearOAuthWebhookSecret:
        typeof body.linearOAuthWebhookSecret === "string"
          ? body.linearOAuthWebhookSecret.trim()
          : undefined,
      aiValidationEnabled:
        typeof body.aiValidationEnabled === "boolean"
          ? body.aiValidationEnabled
          : undefined,
      aiValidationAutoApprove:
        typeof body.aiValidationAutoApprove === "boolean"
          ? body.aiValidationAutoApprove
          : undefined,
      aiValidationAutoDeny:
        typeof body.aiValidationAutoDeny === "boolean"
          ? body.aiValidationAutoDeny
          : undefined,
      publicUrl:
        typeof body.publicUrl === "string"
          ? body.publicUrl.trim().replace(/\/+$/, "")
          : undefined,
      updateChannel:
        body.updateChannel === "stable" || body.updateChannel === "prerelease"
          ? (body.updateChannel as UpdateChannel)
          : undefined,
      dockerAutoUpdate:
        typeof body.dockerAutoUpdate === "boolean"
          ? body.dockerAutoUpdate
          : undefined,
    });

    const connectionsAfterUpdate = listConnections();
    return c.json({
      anthropicApiKeyConfigured: !!settings.anthropicApiKey.trim(),
      anthropicModel: settings.anthropicModel || DEFAULT_ANTHROPIC_MODEL,
      claudeCodeOAuthTokenConfigured: !!settings.claudeCodeOAuthToken.trim(),
      claudeApiKeyConfigured: !!(settings.claudeApiKey ?? "").trim(),
      claudeAuthMethod: settings.claudeAuthMethod ?? "local",
      claudeBaseUrl: settings.claudeBaseUrl,
      claudeDeviceAuthConfigured: hasContainerClaudeAuth(),
      openaiApiKeyConfigured: !!settings.openaiApiKey.trim(),
      codexAuthMethod: settings.codexAuthMethod ?? "local",
      openaiBaseUrl: settings.openaiBaseUrl,
      codexDeviceAuthConfigured: hasContainerCodexAuth(),
      onboardingCompleted: settings.onboardingCompleted,
      linearApiKeyConfigured: !!settings.linearApiKey.trim() || connectionsAfterUpdate.length > 0,
      linearConnectionCount: connectionsAfterUpdate.length,
      linearAutoTransition: settings.linearAutoTransition,
      linearAutoTransitionStateName: settings.linearAutoTransitionStateName,
      linearArchiveTransition: settings.linearArchiveTransition,
      linearArchiveTransitionStateName: settings.linearArchiveTransitionStateName,
      linearOAuthConfigured: !!(settings.linearOAuthClientId.trim() && settings.linearOAuthClientSecret.trim() && settings.linearOAuthAccessToken.trim()),
      linearOAuthCredentialsSaved: !!(settings.linearOAuthClientId.trim() && settings.linearOAuthClientSecret.trim()),
      aiValidationEnabled: settings.aiValidationEnabled,
      aiValidationAutoApprove: settings.aiValidationAutoApprove,
      aiValidationAutoDeny: settings.aiValidationAutoDeny,
      publicUrl: settings.publicUrl,
      updateChannel: settings.updateChannel,
      dockerAutoUpdate: settings.dockerAutoUpdate,
    });
  });

  api.post("/settings/anthropic/verify", async (c) => {
    const body = await c.req.json().catch(() => ({} as { apiKey?: string }));
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    if (!apiKey) {
      return c.json({ valid: false, error: "API key is required" }, 400);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);

    try {
      const res = await fetch("https://api.anthropic.com/v1/models", {
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        signal: controller.signal,
      });

      if (res.ok) {
        return c.json({ valid: true });
      }
      return c.json({ valid: false, error: `API returned ${res.status}` });
    } catch (err) {
      const isAbort = err instanceof Error && err.name === "AbortError";
      return c.json({ valid: false, error: isAbort ? "Request timed out" : "Request failed" });
    } finally {
      clearTimeout(timer);
    }
  });

  api.post("/settings/providers/verify", async (c) => {
    const body = await c.req.json().catch(() => ({} as { provider?: string; authMethod?: string; token?: string; baseUrl?: string }));
    const provider = body.provider === "claude" || body.provider === "codex" ? body.provider : "";
    if (!provider) {
      return c.json({ valid: false, error: "provider must be 'claude' or 'codex'" }, 400);
    }
    const authMethod = provider === "claude"
      ? (body.authMethod === "apiKey" || body.authMethod === "oauth" || body.authMethod === "local" ? body.authMethod : getSettings().claudeAuthMethod ?? "local")
      : (body.authMethod === "apiKey" || body.authMethod === "local" ? body.authMethod : getSettings().codexAuthMethod ?? "local");

    if (authMethod === "local") {
      return c.json(await verifyLocalCliAuth(provider));
    }

    const current = getSettings();
    const token = typeof body.token === "string" && body.token.trim()
      ? body.token.trim()
      : provider === "claude"
        ? authMethod === "apiKey"
          ? (current.claudeApiKey ?? "").trim()
          : current.claudeCodeOAuthToken.trim()
        : current.openaiApiKey.trim();
    if (!token) {
      return c.json({ valid: false, error: "Provider token is required" }, 400);
    }

    const hasBaseUrl = Object.prototype.hasOwnProperty.call(body, "baseUrl");
    const suppliedBaseUrl = typeof body.baseUrl === "string" ? normalizeBaseUrl(body.baseUrl) : "";
    if (!isHttpUrl(suppliedBaseUrl)) {
      return c.json({ valid: false, error: "baseUrl must be a valid http/https URL" }, 400);
    }
    const usesBaseUrl = authMethod === "apiKey";
    const defaultBaseUrl = provider === "claude" ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1";
    const baseUrl = !usesBaseUrl
      ? defaultBaseUrl
      : hasBaseUrl
      ? (suppliedBaseUrl || defaultBaseUrl)
      : (provider === "claude" ? current.claudeBaseUrl : current.openaiBaseUrl)
      || defaultBaseUrl;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const headers: Record<string, string> =
        provider === "claude" && authMethod === "apiKey"
          ? {
              "x-api-key": token,
              "anthropic-version": "2023-06-01",
            }
          : provider === "claude"
            ? {
                Authorization: `Bearer ${token}`,
                "anthropic-version": "2023-06-01",
              }
            : { Authorization: `Bearer ${token}` };
      const res = await fetch(modelsUrl(baseUrl), {
        headers,
        signal: controller.signal,
      });
      if (res.ok) return c.json({ valid: true });
      return c.json({ valid: false, error: `API returned ${res.status}` });
    } catch (err) {
      const isAbort = err instanceof Error && err.name === "AbortError";
      return c.json({ valid: false, error: isAbort ? "Request timed out" : "Request failed" });
    } finally {
      clearTimeout(timer);
    }
  });
}
