import crypto from "node:crypto";
import type { Hono } from "hono";
import * as agentStore from "../agent-store.js";
import type { AgentExecutor } from "../agent-executor.js";
import type { AgentConfig, AgentConfigExport } from "../agent-types.js";

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
  return exportable;
}

function safeEqualSecret(expectedSecret: string, receivedSecret: string): boolean {
  const expected = Buffer.from(expectedSecret);
  const received = Buffer.from(receivedSecret);
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

interface TriggerSecurityConfig {
  secret: string;
  authMode?: "url_secret" | "header_token" | "either";
  token?: string;
  requireHmac?: boolean;
}

interface ParsedBody {
  raw: string;
  json: Record<string, unknown>;
  contentType: string;
  invalidJson: boolean;
}

async function parseBody(c: { req: { header: (name: string) => string | undefined; text: () => Promise<string> } }): Promise<ParsedBody> {
  const contentType = c.req.header("content-type") || "";
  const raw = await c.req.text().catch(() => "");
  let json: Record<string, unknown> = {};
  let invalidJson = false;
  if (contentType.includes("application/json") && raw.trim()) {
    try {
      json = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      invalidJson = true;
    }
  }
  return { raw, json, contentType, invalidJson };
}

type ExtendedLinearTrigger = TriggerSecurityConfig & {
  enabled: boolean;
  requireMention?: boolean;
  mention?: string;
};
type ExtendedGithubTrigger = TriggerSecurityConfig & {
  enabled: boolean;
  requireMention?: boolean;
  mention?: string;
  events?: Array<"pull_request" | "issue_comment" | "pull_request_review_comment">;
};
type ExtendedWebhookTrigger = TriggerSecurityConfig & { enabled: boolean };
type ExtendedTriggers = {
  webhook?: ExtendedWebhookTrigger;
  linear?: ExtendedLinearTrigger;
  github?: ExtendedGithubTrigger;
};

function verifyHmacSignature(secret: string, rawBody: string, timestampHeader: string, signatureHeader: string): boolean {
  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp)) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - timestamp) > 300) return false;

  const payload = `${timestamp}.${rawBody}`;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return safeEqualSecret(expected, signatureHeader);
}

function checkTriggerSecurity(
  c: { req: { header: (name: string) => string | undefined } },
  config: TriggerSecurityConfig,
  secretFromPath: string,
  rawBody: string,
): { ok: true } | { ok: false; status: 400 | 401; error: string } {
  const authMode = config.authMode ?? "url_secret";
  const authHeader = (c.req.header("authorization") || "").trim();
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : "";

  const urlOk = safeEqualSecret(config.secret, secretFromPath);
  const headerOk = !!config.token && !!bearerToken && safeEqualSecret(config.token, bearerToken);

  const authOk = authMode === "url_secret"
    ? urlOk
    : authMode === "header_token"
      ? headerOk
      : (urlOk || headerOk);

  if (!authOk) {
    return {
      ok: false,
      status: 401,
      error: authMode === "header_token" ? "Invalid or missing bearer token" : "Invalid trigger credentials",
    };
  }

  if (config.requireHmac) {
    const ts = c.req.header("x-companion-timestamp") || "";
    const sig = c.req.header("x-companion-signature") || "";
    if (!ts || !sig) {
      return { ok: false, status: 400, error: "Missing HMAC headers" };
    }
    if (!verifyHmacSignature(config.secret, rawBody, ts, sig)) {
      return { ok: false, status: 401, error: "Invalid HMAC signature" };
    }
  }

  return { ok: true };
}

function mentionAliases(agent: AgentConfig, mentionOverride?: string): string[] {
  const raw = [mentionOverride, agent.id, agent.name]
    .filter((v): v is string => !!v && !!v.trim())
    .map((v) => v.trim().replace(/^@+/, ""));
  const set = new Set<string>();
  for (const alias of raw) {
    set.add(alias.toLowerCase());
    set.add(alias.toLowerCase().replace(/\s+/g, "-"));
    set.add(alias.toLowerCase().replace(/\s+/g, ""));
  }
  return Array.from(set).filter(Boolean);
}

function hasMention(text: string, aliases: string[]): boolean {
  const hay = text.toLowerCase();
  return aliases.some((alias) => hay.includes(`@${alias}`));
}

function normalizeInput(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function buildLinearInput(payload: Record<string, unknown>): { input?: string; mentionText: string } {
  const data = (payload.data && typeof payload.data === "object") ? payload.data as Record<string, unknown> : {};
  const issue = (data.issue && typeof data.issue === "object") ? data.issue as Record<string, unknown> : {};
  const comment = (data.comment && typeof data.comment === "object") ? data.comment as Record<string, unknown> : {};
  const title = normalizeInput(data.title) || normalizeInput(issue.title);
  const identifier = normalizeInput(data.identifier) || normalizeInput(issue.identifier);
  const body = normalizeInput(payload.input)
    || normalizeInput(data.body)
    || normalizeInput(comment.body)
    || normalizeInput(issue.description);
  const eventType = normalizeInput(payload.type) || "linear_event";
  const url = normalizeInput(data.url) || normalizeInput(issue.url);

  const summary = [
    `[Linear event: ${eventType}]`,
    identifier ? `Issue: ${identifier}${title ? ` - ${title}` : ""}` : (title ? `Title: ${title}` : ""),
    body ? `Content:\n${body}` : "",
    url ? `URL: ${url}` : "",
  ].filter(Boolean).join("\n");

  return {
    input: body || title || identifier ? summary : undefined,
    mentionText: [title, body, identifier].filter(Boolean).join("\n"),
  };
}

function buildGithubInput(
  payload: Record<string, unknown>,
  event: string,
): { input?: string; mentionText: string; action: string } {
  const repo = (payload.repository && typeof payload.repository === "object")
    ? payload.repository as Record<string, unknown>
    : {};
  const pr = (payload.pull_request && typeof payload.pull_request === "object")
    ? payload.pull_request as Record<string, unknown>
    : {};
  const issue = (payload.issue && typeof payload.issue === "object")
    ? payload.issue as Record<string, unknown>
    : {};
  const comment = (payload.comment && typeof payload.comment === "object")
    ? payload.comment as Record<string, unknown>
    : {};
  const action = normalizeInput(payload.action) || "unknown";
  const repoName = normalizeInput(repo.full_name) || normalizeInput(repo.name);
  const title = normalizeInput(pr.title) || normalizeInput(issue.title);
  const body = normalizeInput(payload.input)
    || normalizeInput(comment.body)
    || normalizeInput(pr.body)
    || normalizeInput(issue.body);
  const number = typeof pr.number === "number"
    ? pr.number
    : (typeof issue.number === "number" ? issue.number : undefined);
  const url = normalizeInput(pr.html_url) || normalizeInput(issue.html_url) || normalizeInput(comment.html_url);

  const summary = [
    `[GitHub ${event}:${action}]`,
    repoName ? `Repository: ${repoName}` : "",
    number ? `PR/Issue #${number}${title ? ` - ${title}` : ""}` : (title ? `Title: ${title}` : ""),
    body ? `Content:\n${body}` : "",
    url ? `URL: ${url}` : "",
  ].filter(Boolean).join("\n");

  return {
    input: body || title || number ? summary : undefined,
    mentionText: [title, body].filter(Boolean).join("\n"),
    action,
  };
}

function triggerAgent(
  agentExecutor: AgentExecutor | undefined,
  agentId: string,
  input: string | undefined,
  triggerType: "manual" | "webhook" | "schedule" | "linear" | "github",
): void {
  (agentExecutor as unknown as {
    executeAgent?: (
      id: string,
      triggerInput?: string,
      opts?: { force?: boolean; triggerType?: "manual" | "webhook" | "schedule" },
    ) => Promise<unknown>;
  })?.executeAgent?.(agentId, input, { force: true, triggerType } as never).catch((err) => {
    console.error(`[agent-routes] Failed to trigger agent "${agentId}" via ${triggerType}:`, err);
  });
}

export function registerAgentRoutes(
  api: Hono,
  agentExecutor?: AgentExecutor,
): void {
  // ── CRUD ────────────────────────────────────────────────────────────────

  api.get("/agents", (c) => {
    const agents = agentStore.listAgents();
    const enriched = agents.map((a) => ({
      ...a,
      nextRunAt: agentExecutor?.getNextRunTime(a.id)?.getTime() ?? null,
    }));
    return c.json(enriched);
  });

  api.get("/agents/:id", (c) => {
    const agent = agentStore.getAgent(c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    return c.json({
      ...agent,
      nextRunAt: agentExecutor?.getNextRunTime(agent.id)?.getTime() ?? null,
    });
  });

  api.post("/agents", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const agent = agentStore.createAgent({
        version: 1,
        name: body.name || "",
        description: body.description || "",
        icon: body.icon,
        backendType: body.backendType || "claude",
        model: body.model || "",
        permissionMode: body.permissionMode || "bypassPermissions",
        cwd: body.cwd || "",
        envSlug: body.envSlug,
        env: body.env,
        allowedTools: body.allowedTools,
        codexInternetAccess: body.codexInternetAccess,
        prompt: body.prompt || "",
        mcpServers: body.mcpServers,
        skills: body.skills,
        container: body.container,
        branch: body.branch,
        createBranch: body.createBranch,
        useWorktree: body.useWorktree,
        triggers: body.triggers,
        enabled: body.enabled ?? true,
      });
      if (agent.enabled && agent.triggers?.schedule?.enabled) {
        agentExecutor?.scheduleAgent(agent);
      }
      return c.json(agent, 201);
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
      if (agent.id !== id) agentExecutor?.stopAgent(id);
      // Reschedule if enabled
      if (agent.enabled && agent.triggers?.schedule?.enabled) {
        agentExecutor?.scheduleAgent(agent);
      } else {
        agentExecutor?.stopAgent(agent.id);
      }
      return c.json(agent);
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
    return c.json(updated);
  });

  // ── Run (manual trigger) ───────────────────────────────────────────────

  api.post("/agents/:id/run", async (c) => {
    const id = c.req.param("id");
    const agent = agentStore.getAgent(id);
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    const body = await c.req.json().catch(() => ({}));
    const input = typeof body.input === "string" ? body.input : undefined;
    triggerAgent(agentExecutor, id, input, "manual");
    return c.json({ ok: true, message: "Agent triggered" });
  });

  // ── Executions ─────────────────────────────────────────────────────────

  api.get("/agents/:id/executions", (c) => {
    const id = c.req.param("id");
    return c.json(agentExecutor?.getExecutions(id) ?? []);
  });

  // ── Import / Export ────────────────────────────────────────────────────

  api.post("/agents/import", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      // Accept an exported agent JSON and create a new agent from it
      const agent = agentStore.createAgent({
        version: body.version || 1,
        name: body.name || "",
        description: body.description || "",
        icon: body.icon,
        backendType: body.backendType || "claude",
        model: body.model || "",
        permissionMode: body.permissionMode || "bypassPermissions",
        cwd: body.cwd || "",
        envSlug: body.envSlug,
        env: body.env,
        allowedTools: body.allowedTools,
        codexInternetAccess: body.codexInternetAccess,
        prompt: body.prompt || "",
        mcpServers: body.mcpServers,
        skills: body.skills,
        container: body.container,
        branch: body.branch,
        createBranch: body.createBranch,
        useWorktree: body.useWorktree,
        triggers: body.triggers,
        enabled: false, // Imported agents start disabled for safety
      });
      return c.json(agent, 201);
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
    return c.json(agent);
  });

  api.post("/agents/:id/regenerate-secret/:provider", (c) => {
    const id = c.req.param("id");
    const provider = c.req.param("provider");
    if (provider !== "webhook" && provider !== "linear" && provider !== "github") {
      return c.json({ error: "Invalid provider" }, 400);
    }
    const agent = agentStore.regenerateTriggerSecret(id, provider);
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    return c.json(agent);
  });

  api.post("/agents/:id/regenerate-token/:provider", (c) => {
    const id = c.req.param("id");
    const provider = c.req.param("provider");
    if (provider !== "webhook" && provider !== "linear" && provider !== "github") {
      return c.json({ error: "Invalid provider" }, 400);
    }
    const agent = agentStore.regenerateTriggerToken(id, provider);
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    return c.json(agent);
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
    const parsed = await parseBody(c);
    if (parsed.invalidJson) return c.json({ error: "Invalid JSON body" }, 400);
    const webhook = agent.triggers?.webhook as unknown as ExtendedWebhookTrigger | undefined;
    if (!webhook) return c.json({ error: "Webhook not configured for this agent" }, 403);
    const security = checkTriggerSecurity(c, webhook, secret, parsed.raw);
    if (!security.ok) return c.json({ error: security.error }, security.status);

    // Extract input from body — accept JSON { input: "..." } or plain text
    let input: string | undefined;
    if (parsed.contentType.includes("application/json")) {
      input = typeof parsed.json.input === "string" ? parsed.json.input : undefined;
    } else if (parsed.raw.trim()) {
      input = parsed.raw.trim();
    }

    triggerAgent(agentExecutor, id, input, "webhook");
    return c.json({ ok: true, message: "Agent triggered via webhook" });
  });

  // ── Public integration hooks (Linear / GitHub) ────────────────────────

  api.post("/agent-hooks/linear/:id/:secret", async (c) => {
    const id = c.req.param("id");
    const secret = c.req.param("secret");
    const agent = agentStore.getAgent(id);
    if (!agent) return c.json({ error: "Agent not found" }, 404);

    const linear = (agent.triggers as unknown as ExtendedTriggers | undefined)?.linear;
    if (!linear?.enabled) return c.json({ error: "Linear trigger not enabled for this agent" }, 403);
    const parsed = await parseBody(c);
    if (parsed.invalidJson) return c.json({ error: "Invalid JSON body" }, 400);
    const security = checkTriggerSecurity(c, linear, secret, parsed.raw);
    if (!security.ok) return c.json({ error: security.error }, security.status);

    const payload = parsed.json;
    const { input, mentionText } = buildLinearInput(payload);
    if (linear.requireMention) {
      const aliases = mentionAliases(agent, linear.mention);
      if (!hasMention(mentionText, aliases)) {
        return c.json({ ok: true, skipped: true, reason: "mention_required" });
      }
    }

    triggerAgent(agentExecutor, id, input, "linear");
    return c.json({ ok: true, message: "Agent triggered via Linear webhook" });
  });

  api.post("/agent-hooks/github/:id/:secret", async (c) => {
    const id = c.req.param("id");
    const secret = c.req.param("secret");
    const agent = agentStore.getAgent(id);
    if (!agent) return c.json({ error: "Agent not found" }, 404);

    const github = (agent.triggers as unknown as ExtendedTriggers | undefined)?.github;
    if (!github?.enabled) return c.json({ error: "GitHub trigger not enabled for this agent" }, 403);
    const parsed = await parseBody(c);
    if (parsed.invalidJson) return c.json({ error: "Invalid JSON body" }, 400);
    const security = checkTriggerSecurity(c, github, secret, parsed.raw);
    if (!security.ok) return c.json({ error: security.error }, security.status);

    const event = (c.req.header("x-github-event") || "").trim();
    if (!event) return c.json({ error: "Missing x-github-event header" }, 400);
    const allowedEvents = github.events ?? ["pull_request", "issue_comment", "pull_request_review_comment"];
    if (!allowedEvents.includes(event as "pull_request" | "issue_comment" | "pull_request_review_comment")) {
      return c.json({ ok: true, skipped: true, reason: "event_not_enabled", event });
    }

    const payload = parsed.json;
    const { input, mentionText } = buildGithubInput(payload, event);
    if (github.requireMention) {
      const aliases = mentionAliases(agent, github.mention);
      if (!hasMention(mentionText, aliases)) {
        return c.json({ ok: true, skipped: true, reason: "mention_required" });
      }
    }

    triggerAgent(agentExecutor, id, input, "github");
    return c.json({ ok: true, message: "Agent triggered via GitHub webhook", event });
  });
}
