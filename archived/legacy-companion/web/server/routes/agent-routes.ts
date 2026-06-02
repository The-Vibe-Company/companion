import crypto from "node:crypto";
import type { Hono } from "hono";
import * as agentStore from "../agent-store.js";
import type { AgentExecutor } from "../agent-executor.js";
import type { AgentConfig, AgentConfigCreateInput, AgentConfigExport } from "../agent-types.js";
import { getSettings, updateSettings } from "../settings-manager.js";
import * as staging from "../linear-staging.js";
import { getOAuthConnection, createOAuthConnection } from "../linear-oauth-connections.js";

/** Fields the user can set when creating/updating an agent */
const EDITABLE_FIELDS = [
  "name", "description", "icon", "version",
  "backendType", "model", "permissionMode", "cwd",
  "envSlug", "env", "allowedTools", "codexInternetAccess",
  "prompt", "mcpServers", "skills",
  "container", "branch", "createBranch", "useWorktree",
  "triggers", "enabled",
] as const;

function pickEditable(body: Record<string, unknown>): Partial<AgentConfig> {
  const result: Record<string, unknown> = {};
  for (const key of EDITABLE_FIELDS) {
    if (key in body) result[key] = body[key];
  }
  return result as Partial<AgentConfig>;
}

function buildCreateInput(
  body: Record<string, unknown>,
  overrides?: Partial<Pick<AgentConfigCreateInput, "enabled" | "version">>,
): AgentConfigCreateInput {
  return {
    version: overrides?.version ?? 1,
    name: (body.name as string | undefined) || "",
    description: (body.description as string | undefined) || "",
    icon: body.icon as string | undefined,
    backendType: (body.backendType as AgentConfig["backendType"] | undefined) || "claude",
    model: (body.model as string | undefined) || "",
    permissionMode: (body.permissionMode as string | undefined) || "bypassPermissions",
    cwd: (body.cwd as string | undefined) || "",
    envSlug: body.envSlug as string | undefined,
    env: body.env as Record<string, string> | undefined,
    allowedTools: body.allowedTools as string[] | undefined,
    codexInternetAccess: body.codexInternetAccess as boolean | undefined,
    prompt: (body.prompt as string | undefined) || "",
    mcpServers: body.mcpServers as AgentConfig["mcpServers"] | undefined,
    skills: body.skills as string[] | undefined,
    container: body.container as AgentConfig["container"] | undefined,
    branch: body.branch as string | undefined,
    createBranch: body.createBranch as boolean | undefined,
    useWorktree: body.useWorktree as boolean | undefined,
    triggers: body.triggers as AgentConfig["triggers"] | undefined,
    enabled: overrides?.enabled ?? ((body.enabled as boolean | undefined) ?? true),
  };
}

/** Strip sensitive Linear OAuth credentials before sending to the browser */
function sanitizeAgent(agent: AgentConfig & { nextRunAt?: number | null }): Record<string, unknown> {
  if (!agent.triggers?.linear) return agent as unknown as Record<string, unknown>;
  const { oauthClientSecret, webhookSecret, accessToken, refreshToken, ...safeLinear } = agent.triggers.linear;

  // Resolve connection info for display and flag derivation
  const conn = safeLinear.oauthConnectionId
    ? getOAuthConnection(safeLinear.oauthConnectionId)
    : null;
  const oauthConnectionName = conn?.name;
  const oauthConnectionStatus = conn?.status;

  return {
    ...agent,
    triggers: {
      ...agent.triggers,
      linear: {
        ...safeLinear,
        hasAccessToken: !!(accessToken || oauthConnectionStatus === "connected"),
        hasClientSecret: !!(oauthClientSecret || conn?.oauthClientSecret),
        hasWebhookSecret: !!(webhookSecret || conn?.webhookSecret),
        oauthConnectionName,
        oauthConnectionStatus,
      },
    },
  } as unknown as Record<string, unknown>;
}

/** Strip internal tracking fields to produce a portable export */
function toExport(agent: AgentConfig): AgentConfigExport {
  const {
    id: _id,
    createdAt: _ca,
    updatedAt: _ua,
    totalRuns: _tr,
    consecutiveFailures: _cf,
    lastRunAt: _lr,
    lastSessionId: _ls,
    enabled: _en,
    ...exportable
  } = agent;
  // Strip Linear OAuth credentials from export (keep oauthConnectionId for reference)
  if (exportable.triggers?.linear) {
    const { oauthClientId, oauthClientSecret, webhookSecret, accessToken, refreshToken, ...safeLinear } = exportable.triggers.linear;
    exportable.triggers = { ...exportable.triggers, linear: safeLinear };
  }
  return exportable;
}

export function registerAgentRoutes(
  api: Hono,
  agentExecutor?: AgentExecutor,
): void {
  // ── CRUD ────────────────────────────────────────────────────────────────

  api.get("/agents", (c) => {
    const agents = agentStore.listAgents();
    const enriched = agents.map((a) => sanitizeAgent({
      ...a,
      nextRunAt: agentExecutor?.getNextRunTime(a.id)?.getTime() ?? null,
    }));
    return c.json(enriched);
  });

  api.get("/agents/:id", (c) => {
    const agent = agentStore.getAgent(c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    return c.json(sanitizeAgent({
      ...agent,
      nextRunAt: agentExecutor?.getNextRunTime(agent.id)?.getTime() ?? null,
    }));
  });

  api.post("/agents", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const agent = agentStore.createAgent(buildCreateInput(body));

      // If this is a Linear agent, resolve credentials:
      // New model: oauthConnectionId already set in triggers.linear
      // Legacy model: resolve from staging/clone/global
      if (agent.triggers?.linear?.enabled) {
        // New model: oauthConnectionId passed directly — nothing more to do
        if (agent.triggers.linear.oauthConnectionId) {
          // Already stored via triggers, just proceed
        } else if (!agent.triggers.linear.oauthClientId) {
          // Legacy model: resolve credentials from staging/clone/global
          let linearCreds: {
            oauthClientId: string;
            oauthClientSecret: string;
            webhookSecret: string;
            accessToken: string;
            refreshToken: string;
          } | null = null;

          // Priority 1: staging slot → create OAuth connection from it
          if (body.stagingId) {
            const slot = staging.consumeSlot(body.stagingId);
            if (slot?.clientId) {
              // Create a new OAuth connection from the staging slot
              const conn = createOAuthConnection({
                name: `${agent.name} OAuth App`,
                oauthClientId: slot.clientId,
                oauthClientSecret: slot.clientSecret,
                webhookSecret: slot.webhookSecret,
                accessToken: slot.accessToken,
                refreshToken: slot.refreshToken,
              });
              const updated = agentStore.updateAgent(agent.id, {
                triggers: {
                  ...agent.triggers,
                  linear: {
                    ...agent.triggers.linear,
                    oauthConnectionId: conn.id,
                  },
                },
              });
              if (updated) {
                if (updated.enabled && updated.triggers?.schedule?.enabled) {
                  agentExecutor?.scheduleAgent(updated);
                }
                return c.json(sanitizeAgent({ ...updated, nextRunAt: null }), 201);
              }
            }
          }

          // Priority 2: clone from existing agent
          if (!linearCreds && body.cloneFromAgentId) {
            const source = agentStore.getAgent(body.cloneFromAgentId);
            // Prefer cloning the oauthConnectionId reference
            if (source?.triggers?.linear?.oauthConnectionId) {
              const updated = agentStore.updateAgent(agent.id, {
                triggers: {
                  ...agent.triggers,
                  linear: {
                    ...agent.triggers.linear,
                    oauthConnectionId: source.triggers.linear.oauthConnectionId,
                  },
                },
              });
              if (updated) {
                if (updated.enabled && updated.triggers?.schedule?.enabled) {
                  agentExecutor?.scheduleAgent(updated);
                }
                return c.json(sanitizeAgent({ ...updated, nextRunAt: null }), 201);
              }
            } else if (source?.triggers?.linear?.oauthClientId) {
              linearCreds = {
                oauthClientId: source.triggers.linear.oauthClientId,
                oauthClientSecret: source.triggers.linear.oauthClientSecret || "",
                webhookSecret: source.triggers.linear.webhookSecret || "",
                accessToken: source.triggers.linear.accessToken || "",
                refreshToken: source.triggers.linear.refreshToken || "",
              };
            }
          }

          // Priority 3: global staging (backward compat)
          if (!linearCreds) {
            const settings = getSettings();
            if (settings.linearOAuthClientId) {
              linearCreds = {
                oauthClientId: settings.linearOAuthClientId,
                oauthClientSecret: settings.linearOAuthClientSecret,
                webhookSecret: settings.linearOAuthWebhookSecret,
                accessToken: settings.linearOAuthAccessToken,
                refreshToken: settings.linearOAuthRefreshToken,
              };
            }
          }

          if (linearCreds) {
            const updated = agentStore.updateAgent(agent.id, {
              triggers: {
                ...agent.triggers,
                linear: {
                  ...agent.triggers.linear,
                  ...linearCreds,
                },
              },
            });
            if (updated) {
              // Clear global staging if we used it (no stagingId and no clone source)
              if (!body.stagingId && !body.cloneFromAgentId) {
                updateSettings({
                  linearOAuthClientId: "",
                  linearOAuthClientSecret: "",
                  linearOAuthWebhookSecret: "",
                  linearOAuthAccessToken: "",
                  linearOAuthRefreshToken: "",
                });
              }
              if (updated.enabled && updated.triggers?.schedule?.enabled) {
                agentExecutor?.scheduleAgent(updated);
              }
              return c.json(sanitizeAgent({ ...updated, nextRunAt: null }), 201);
            }
          }
        }
      }

      if (agent.enabled && agent.triggers?.schedule?.enabled) {
        agentExecutor?.scheduleAgent(agent);
      }
      return c.json(sanitizeAgent({ ...agent, nextRunAt: null }), 201);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.put("/agents/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    try {
      const allowed = pickEditable(body);
      const agent = agentStore.updateAgent(id, allowed);
      if (!agent) return c.json({ error: "Agent not found" }, 404);
      // Stop old timer (id may differ after a rename)
      if (agent.id !== id) {
        agentExecutor?.stopAgent(id);
      }
      // Reschedule if enabled
      if (agent.enabled && agent.triggers?.schedule?.enabled) {
        agentExecutor?.scheduleAgent(agent);
      } else {
        agentExecutor?.stopAgent(agent.id);
      }
      return c.json(sanitizeAgent({ ...agent, nextRunAt: agentExecutor?.getNextRunTime(agent.id)?.getTime() ?? null }));
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.delete("/agents/:id", (c) => {
    const id = c.req.param("id");
    agentExecutor?.stopAgent(id);
    const deleted = agentStore.deleteAgent(id);
    if (!deleted) return c.json({ error: "Agent not found" }, 404);
    return c.json({ ok: true });
  });

  // ── Toggle ──────────────────────────────────────────────────────────────

  api.post("/agents/:id/toggle", (c) => {
    const id = c.req.param("id");
    const agent = agentStore.getAgent(id);
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    const updated = agentStore.updateAgent(id, { enabled: !agent.enabled });
    if (updated?.enabled && updated.triggers?.schedule?.enabled) {
      agentExecutor?.scheduleAgent(updated);
    } else if (updated) {
      agentExecutor?.stopAgent(updated.id);
    }
    return c.json(updated ? sanitizeAgent({ ...updated, nextRunAt: agentExecutor?.getNextRunTime(updated.id)?.getTime() ?? null }) : updated);
  });

  // ── Run (manual trigger) ───────────────────────────────────────────────

  api.post("/agents/:id/run", async (c) => {
    const id = c.req.param("id");
    const agent = agentStore.getAgent(id);
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    const body = await c.req.json().catch(() => ({}));
    const input = typeof body.input === "string" ? body.input : undefined;
    agentExecutor?.executeAgentManually(id, input);
    return c.json({ ok: true, message: "Agent triggered" });
  });

  // ── Executions ─────────────────────────────────────────────────────────

  api.get("/agents/:id/executions", (c) => {
    const id = c.req.param("id");
    return c.json(agentExecutor?.getExecutions(id) ?? []);
  });

  /** List executions across all agents with filtering and pagination (for Runs view). */
  api.get("/executions", (c) => {
    const agentId = c.req.query("agentId");
    const triggerType = c.req.query("triggerType");
    const rawStatus = c.req.query("status");
    const status = (rawStatus === "running" || rawStatus === "success" || rawStatus === "error")
      ? rawStatus : undefined;
    const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 500);
    const offset = Math.max(Number(c.req.query("offset")) || 0, 0);
    return c.json(agentExecutor?.listAllExecutions({ agentId, triggerType, status, limit, offset }) ?? { executions: [], total: 0 });
  });

  // ── Import / Export ────────────────────────────────────────────────────

  api.post("/agents/import", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      // Accept an exported agent JSON and create a new agent from it
      const agent = agentStore.createAgent(buildCreateInput(body, {
        version: (body.version as AgentConfigCreateInput["version"] | undefined) || 1,
        enabled: false, // Imported agents start disabled for safety
      }));
      return c.json(sanitizeAgent({ ...agent, nextRunAt: null }), 201);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.get("/agents/:id/export", (c) => {
    const agent = agentStore.getAgent(c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    return c.json(toExport(agent));
  });

  // ── Webhook Secret ─────────────────────────────────────────────────────

  api.post("/agents/:id/regenerate-secret", (c) => {
    const id = c.req.param("id");
    const agent = agentStore.regenerateWebhookSecret(id);
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    return c.json(sanitizeAgent({ ...agent, nextRunAt: agentExecutor?.getNextRunTime(agent.id)?.getTime() ?? null }));
  });

  // ── Webhook Trigger ────────────────────────────────────────────────────

  api.post("/agents/:id/webhook/:secret", async (c) => {
    const id = c.req.param("id");
    const secret = c.req.param("secret");

    const agent = agentStore.getAgent(id);
    if (!agent) return c.json({ error: "Agent not found" }, 404);

    // Validate webhook is enabled and secret matches
    if (!agent.triggers?.webhook?.enabled) {
      return c.json({ error: "Webhook not enabled for this agent" }, 403);
    }
    // Use constant-time comparison to prevent timing attacks
    const expected = Buffer.from(agent.triggers.webhook.secret);
    const received = Buffer.from(secret);
    if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
      return c.json({ error: "Invalid webhook secret" }, 401);
    }

    // Extract input from body — accept JSON { input: "..." } or plain text
    let input: string | undefined;
    const contentType = c.req.header("content-type") || "";
    if (contentType.includes("application/json")) {
      const body = await c.req.json().catch(() => ({}));
      input = typeof body.input === "string" ? body.input : undefined;
    } else {
      const text = await c.req.text().catch(() => "");
      if (text.trim()) input = text.trim();
    }

    agentExecutor?.executeAgentManually(id, input);
    return c.json({ ok: true, message: "Agent triggered via webhook" });
  });
}
