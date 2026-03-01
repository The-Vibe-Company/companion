import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import type { AgentConfig, AgentConfigCreateInput } from "./agent-types.js";

type TriggerAuthMode = "url_secret" | "header_token" | "either";
type ExtendedWebhookTrigger = {
  enabled: boolean;
  secret: string;
  authMode?: TriggerAuthMode;
  token?: string;
  requireHmac?: boolean;
};
type ExtendedLinearTrigger = {
  enabled: boolean;
  secret: string;
  authMode?: TriggerAuthMode;
  token?: string;
  requireHmac?: boolean;
  requireMention?: boolean;
  mention?: string;
};
type ExtendedGithubTrigger = {
  enabled: boolean;
  secret: string;
  authMode?: TriggerAuthMode;
  token?: string;
  requireHmac?: boolean;
  requireMention?: boolean;
  mention?: string;
  events?: Array<"pull_request" | "issue_comment" | "pull_request_review_comment">;
};
type ExtendedTriggers = {
  webhook?: ExtendedWebhookTrigger;
  linear?: ExtendedLinearTrigger;
  github?: ExtendedGithubTrigger;
  schedule?: { enabled: boolean; expression: string; recurring: boolean };
};

// ─── Paths ──────────────────────────────────────────────────────────────────

const COMPANION_DIR = join(homedir(), ".companion");
const AGENTS_DIR = join(COMPANION_DIR, "agents");

function ensureDir(): void {
  mkdirSync(AGENTS_DIR, { recursive: true });
}

function filePath(id: string): string {
  return join(AGENTS_DIR, `${id}.json`);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function generateWebhookSecret(): string {
  return randomBytes(24).toString("hex");
}

function generateTriggerToken(): string {
  return randomBytes(24).toString("base64url");
}

function ensureTriggerSecrets(
  triggers: AgentConfig["triggers"] | undefined,
): AgentConfig["triggers"] | undefined {
  if (!triggers) return triggers;
  const next: ExtendedTriggers = { ...(triggers as unknown as ExtendedTriggers) };
  if (next.webhook) {
    const authMode = next.webhook.authMode ?? "url_secret";
    const needsToken = authMode === "header_token" || authMode === "either";
    next.webhook = {
      ...next.webhook,
      authMode,
      requireHmac: next.webhook.requireHmac ?? false,
      secret: next.webhook.secret || generateWebhookSecret(),
      token: needsToken ? (next.webhook.token || generateTriggerToken()) : next.webhook.token,
    };
  }
  if (next.linear) {
    const authMode = next.linear.authMode ?? "url_secret";
    const needsToken = authMode === "header_token" || authMode === "either";
    next.linear = {
      ...next.linear,
      authMode,
      requireHmac: next.linear.requireHmac ?? false,
      secret: next.linear.secret || generateWebhookSecret(),
      token: needsToken ? (next.linear.token || generateTriggerToken()) : next.linear.token,
    };
  }
  if (next.github) {
    const authMode = next.github.authMode ?? "url_secret";
    const needsToken = authMode === "header_token" || authMode === "either";
    next.github = {
      ...next.github,
      authMode,
      requireHmac: next.github.requireHmac ?? false,
      secret: next.github.secret || generateWebhookSecret(),
      token: needsToken ? (next.github.token || generateTriggerToken()) : next.github.token,
    };
  }
  return next as unknown as AgentConfig["triggers"];
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

export function listAgents(): AgentConfig[] {
  ensureDir();
  try {
    const files = readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".json"));
    const agents: AgentConfig[] = [];
    for (const file of files) {
      try {
        const raw = readFileSync(join(AGENTS_DIR, file), "utf-8");
        agents.push(JSON.parse(raw));
      } catch {
        // Skip corrupt files
      }
    }
    agents.sort((a, b) => a.name.localeCompare(b.name));
    return agents;
  } catch {
    return [];
  }
}

export function getAgent(id: string): AgentConfig | null {
  ensureDir();
  try {
    const raw = readFileSync(filePath(id), "utf-8");
    return JSON.parse(raw) as AgentConfig;
  } catch {
    return null;
  }
}

export function createAgent(data: AgentConfigCreateInput): AgentConfig {
  if (!data.name || !data.name.trim()) throw new Error("Agent name is required");
  if (!data.prompt || !data.prompt.trim()) throw new Error("Agent prompt is required");

  const id = slugify(data.name.trim());
  if (!id) throw new Error("Agent name must contain alphanumeric characters");

  ensureDir();
  if (existsSync(filePath(id))) {
    throw new Error(`An agent with a similar name already exists ("${id}")`);
  }

  // Auto-generate trigger secrets when enabled without a secret.
  const triggers = ensureTriggerSecrets(data.triggers ? { ...data.triggers } : undefined);

  const now = Date.now();
  const agent: AgentConfig = {
    ...data,
    triggers,
    id,
    name: data.name.trim(),
    prompt: data.prompt.trim(),
    description: data.description?.trim() || "",
    cwd: data.cwd?.trim() || "",
    createdAt: now,
    updatedAt: now,
    totalRuns: 0,
    consecutiveFailures: 0,
  };
  writeFileSync(filePath(id), JSON.stringify(agent, null, 2), "utf-8");
  return agent;
}

export function updateAgent(
  id: string,
  updates: Partial<AgentConfig>,
): AgentConfig | null {
  ensureDir();
  const existing = getAgent(id);
  if (!existing) return null;

  const newName = updates.name?.trim() || existing.name;
  const newId = slugify(newName);
  if (!newId) throw new Error("Agent name must contain alphanumeric characters");

  // If name changed, check for slug collision with a different agent
  if (newId !== id && existsSync(filePath(newId))) {
    throw new Error(`An agent with a similar name already exists ("${newId}")`);
  }

  const agent: AgentConfig = {
    ...existing,
    ...updates,
    id: newId,
    name: newName,
    updatedAt: Date.now(),
    // Preserve immutable fields
    createdAt: existing.createdAt,
    triggers: ensureTriggerSecrets(
      updates.triggers
        ? { ...existing.triggers, ...updates.triggers }
        : existing.triggers,
    ),
  };

  // If id changed, delete old file
  if (newId !== id) {
    try {
      unlinkSync(filePath(id));
    } catch {
      /* ok */
    }
  }

  writeFileSync(filePath(newId), JSON.stringify(agent, null, 2), "utf-8");
  return agent;
}

export function deleteAgent(id: string): boolean {
  ensureDir();
  if (!existsSync(filePath(id))) return false;
  try {
    unlinkSync(filePath(id));
    return true;
  } catch {
    return false;
  }
}

/** Generate a new webhook secret for an agent */
export function regenerateWebhookSecret(id: string): AgentConfig | null {
  return regenerateTriggerSecret(id, "webhook");
}

/** Generate a new trigger secret for an agent */
export function regenerateTriggerSecret(
  id: string,
  provider: "webhook" | "linear" | "github",
): AgentConfig | null {
  const agent = getAgent(id);
  if (!agent) return null;

  const triggers: ExtendedTriggers = (agent.triggers || {}) as unknown as ExtendedTriggers;
  if (provider === "webhook") {
    triggers.webhook = {
      enabled: triggers.webhook?.enabled ?? false,
      secret: generateWebhookSecret(),
      authMode: triggers.webhook?.authMode ?? "url_secret",
      token: triggers.webhook?.token,
      requireHmac: triggers.webhook?.requireHmac ?? false,
    };
  } else if (provider === "linear") {
    triggers.linear = {
      enabled: triggers.linear?.enabled ?? false,
      requireMention: triggers.linear?.requireMention ?? true,
      mention: triggers.linear?.mention,
      secret: generateWebhookSecret(),
      authMode: triggers.linear?.authMode ?? "url_secret",
      token: triggers.linear?.token,
      requireHmac: triggers.linear?.requireHmac ?? false,
    };
  } else {
    triggers.github = {
      enabled: triggers.github?.enabled ?? false,
      requireMention: triggers.github?.requireMention ?? true,
      mention: triggers.github?.mention,
      events: triggers.github?.events ?? ["pull_request", "issue_comment", "pull_request_review_comment"],
      secret: generateWebhookSecret(),
      authMode: triggers.github?.authMode ?? "url_secret",
      token: triggers.github?.token,
      requireHmac: triggers.github?.requireHmac ?? false,
    };
  }

  return updateAgent(id, { triggers });
}

/** Generate a new header token for a provider */
export function regenerateTriggerToken(
  id: string,
  provider: "webhook" | "linear" | "github",
): AgentConfig | null {
  const agent = getAgent(id);
  if (!agent) return null;

  const triggers: ExtendedTriggers = (agent.triggers || {}) as unknown as ExtendedTriggers;
  if (provider === "webhook") {
    triggers.webhook = {
      enabled: triggers.webhook?.enabled ?? false,
      secret: triggers.webhook?.secret || generateWebhookSecret(),
      authMode: triggers.webhook?.authMode ?? "header_token",
      token: generateTriggerToken(),
      requireHmac: triggers.webhook?.requireHmac ?? false,
    };
  } else if (provider === "linear") {
    triggers.linear = {
      enabled: triggers.linear?.enabled ?? false,
      requireMention: triggers.linear?.requireMention ?? true,
      mention: triggers.linear?.mention,
      secret: triggers.linear?.secret || generateWebhookSecret(),
      authMode: triggers.linear?.authMode ?? "header_token",
      token: generateTriggerToken(),
      requireHmac: triggers.linear?.requireHmac ?? false,
    };
  } else {
    triggers.github = {
      enabled: triggers.github?.enabled ?? false,
      requireMention: triggers.github?.requireMention ?? true,
      mention: triggers.github?.mention,
      events: triggers.github?.events ?? ["pull_request", "issue_comment", "pull_request_review_comment"],
      secret: triggers.github?.secret || generateWebhookSecret(),
      authMode: triggers.github?.authMode ?? "header_token",
      token: generateTriggerToken(),
      requireHmac: triggers.github?.requireHmac ?? false,
    };
  }

  return updateAgent(id, { triggers });
}
