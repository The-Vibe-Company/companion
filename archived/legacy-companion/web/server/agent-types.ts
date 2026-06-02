// ─── Agent Types ─────────────────────────────────────────────────────────────

export interface McpServerConfigAgent {
  type: "stdio" | "sse" | "http";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
}

export interface AgentConfig {
  /** Unique slug-based ID (derived from name) */
  id: string;
  /** Schema version for forward compat */
  version: 1;
  /** Human-readable name */
  name: string;
  /** Short description of what this agent does */
  description: string;
  /** Emoji or icon identifier */
  icon?: string;

  // ── Session Config ──
  /** "claude" or "codex" */
  backendType: "claude" | "codex";
  /** Model to use (e.g. "claude-sonnet-4-6") */
  model: string;
  /** Permission mode — "bypassPermissions" for Claude auto mode */
  permissionMode: string;
  /** Working directory path, or "temp" for an auto-created temp dir */
  cwd: string;
  /** Optional environment slug (references ~/.companion/envs/) */
  envSlug?: string;
  /** Extra environment variables */
  env?: Record<string, string>;
  /** Tool allowlist (empty = all tools) */
  allowedTools?: string[];
  /** Codex-specific: internet access */
  codexInternetAccess?: boolean;

  // ── Prompt ──
  /** Prompt template. Use {{input}} as placeholder for trigger-provided input */
  prompt: string;

  // ── MCP Servers ──
  /** MCP server configs to set on the session after CLI connects */
  mcpServers?: Record<string, McpServerConfigAgent>;

  // ── Skills ──
  /** Skill slugs to attach (from ~/.claude/skills/) */
  skills?: string[];

  // ── Docker ──
  /** Optional Docker container configuration */
  container?: {
    image?: string;
    ports?: number[];
    volumes?: string[];
    initScript?: string;
  };

  // ── Git ──
  branch?: string;
  createBranch?: boolean;
  useWorktree?: boolean;

  // ── Triggers ──
  triggers?: {
    /** Webhook trigger config */
    webhook?: {
      enabled: boolean;
      /** Auto-generated secret token for URL auth */
      secret: string;
    };
    /** Cron/schedule trigger config */
    schedule?: {
      enabled: boolean;
      /** Cron expression or ISO datetime */
      expression: string;
      /** true = recurring cron, false = one-shot */
      recurring: boolean;
    };
    /** Linear Agent Interaction SDK trigger (per-agent OAuth app) */
    linear?: {
      enabled: boolean;
      /** Reference to a LinearOAuthConnection by ID (new model) */
      oauthConnectionId?: string;
      /** @deprecated OAuth app client ID from Linear — use oauthConnectionId instead */
      oauthClientId?: string;
      /** @deprecated OAuth app client secret — use oauthConnectionId instead */
      oauthClientSecret?: string;
      /** @deprecated Webhook signing secret — use oauthConnectionId instead */
      webhookSecret?: string;
      /** @deprecated OAuth access token — use oauthConnectionId instead */
      accessToken?: string;
      /** @deprecated OAuth refresh token — use oauthConnectionId instead */
      refreshToken?: string;
    };
  };

  // ── Tracking ──
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
  lastSessionId?: string;
  totalRuns: number;
  consecutiveFailures: number;
}

/** Input for creating an agent (without auto-generated fields) */
export type AgentConfigCreateInput = Omit<
  AgentConfig,
  "id" | "createdAt" | "updatedAt" | "totalRuns" | "consecutiveFailures" | "lastRunAt" | "lastSessionId"
>;

/** The portable/shareable JSON format (no internal tracking fields) */
export type AgentConfigExport = Omit<
  AgentConfig,
  "id" | "createdAt" | "updatedAt" | "totalRuns" | "consecutiveFailures" | "lastRunAt" | "lastSessionId" | "enabled"
>;

export interface AgentExecution {
  /** The session ID created for this execution */
  sessionId: string;
  /** The agent ID that triggered this */
  agentId: string;
  /** Trigger type that initiated this execution */
  triggerType: "manual" | "webhook" | "schedule" | "linear";
  /** When the execution started */
  startedAt: number;
  /** When the execution completed */
  completedAt?: number;
  /** Whether the execution succeeded */
  success?: boolean;
  /** Error message if it failed */
  error?: string;
}
