// ─── Linear Agent Session Bridge ──────────────────────────────────────────────
// Bridges Linear Agent Interaction SDK sessions with Companion CLI sessions.
// When Linear sends an AgentSessionEvent webhook, this module:
// 1. Acknowledges immediately (post a "thought" activity within 10s)
// 2. Finds the right Companion agent to handle it (by oauthClientId)
// 3. Launches a CLI session via AgentExecutor
// 4. Relays CLI output back to Linear as agent activities
// 5. Relays TodoWrite → Linear plan checklist
// 6. Periodically flushes intermediate progress as ephemeral thoughts

import type { AgentExecutor } from "./agent-executor.js";
import type { WsBridge } from "./ws-bridge.js";
import type { BrowserIncomingMessage } from "./session-types.js";
import type { AgentConfig } from "./agent-types.js";
import * as agentStore from "./agent-store.js";
import * as linearAgent from "./linear-agent.js";
import type { AgentSessionEventPayload, AgentPlanItem, LinearOAuthCredentials } from "./linear-agent.js";
import { buildLinearOAuthSystemPrompt } from "./linear-prompt-builder.js";
import { getSettings } from "./settings-manager.js";
import { companionBus } from "./event-bus.js";
import { findOAuthConnectionByClientId, getOAuthConnection, updateOAuthConnection } from "./linear-oauth-connections.js";

/** Interval (ms) for flushing intermediate progress as ephemeral thoughts. */
const PROGRESS_FLUSH_INTERVAL_MS = 30_000;

/** Safely extract the content array from an assistant-type message. */
function getAssistantContent(msg: BrowserIncomingMessage): unknown[] | null {
  if (msg.type !== "assistant") return null;
  // Assistant messages carry content blocks at msg.message.content
  const raw = msg as Record<string, unknown>;
  const message = raw.message;
  if (!message || typeof message !== "object") return null;
  const content = (message as Record<string, unknown>).content;
  return Array.isArray(content) ? content : null;
}

/** Extract text from assistant message content blocks */
function extractTextFromAssistant(msg: BrowserIncomingMessage): string {
  const content = getAssistantContent(msg);
  if (!content) return "";
  return content
    .filter((b): b is { type: string; text: string } =>
      typeof b === "object" && b !== null && (b as Record<string, unknown>).type === "text" && typeof (b as Record<string, unknown>).text === "string")
    .map((b) => b.text)
    .join("\n");
}

/** Extract text deltas from stream events. */
function extractTextDeltaFromStreamEvent(msg: BrowserIncomingMessage): string {
  if (msg.type !== "stream_event") return "";
  const event = msg.event as Record<string, unknown> | undefined;
  if (!event || event.type !== "content_block_delta") return "";
  const delta = event.delta as Record<string, unknown> | undefined;
  if (!delta || delta.type !== "text_delta" || typeof delta.text !== "string") return "";
  return delta.text;
}

/** Extract all tool use blocks from assistant message content (with raw input for plan extraction) */
function extractToolUses(msg: BrowserIncomingMessage): Array<{ id?: string; name: string; input: string; rawInput?: Record<string, unknown> }> {
  const content = getAssistantContent(msg);
  if (!content) return [];
  return content
    .filter((b): b is { type: string; id?: string; name: string; input?: Record<string, unknown> } =>
      typeof b === "object" && b !== null
      && (b as Record<string, unknown>).type === "tool_use"
      && typeof (b as Record<string, unknown>).name === "string")
    .map((toolBlock) => ({
      id: typeof toolBlock.id === "string" ? toolBlock.id : undefined,
      name: toolBlock.name,
      input: toolBlock.input ? JSON.stringify(toolBlock.input).slice(0, 200) : "",
      rawInput: toolBlock.input,
    }));
}

/** Extract tool_result blocks from assistant message content. */
function extractToolResults(msg: BrowserIncomingMessage): Array<{ tool_use_id: string; content: string }> {
  const content = getAssistantContent(msg);
  if (!content) return [];
  return content
    .filter((b): b is { type: string; tool_use_id: string; content?: unknown } =>
      typeof b === "object" && b !== null
      && (b as Record<string, unknown>).type === "tool_result"
      && typeof (b as Record<string, unknown>).tool_use_id === "string")
    .map((block) => ({
      tool_use_id: block.tool_use_id,
      content: typeof block.content === "string"
        ? block.content.slice(0, 500)
        : Array.isArray(block.content)
          ? (block.content as Array<{ type?: string; text?: string }>)
            .filter((c) => c.type === "text" && typeof c.text === "string")
            .map((c) => c.text)
            .join("\n")
            .slice(0, 500)
          : "",
    }));
}

/** Map TodoWrite status values to Linear plan item status values. */
function mapTodoStatus(status: string): AgentPlanItem["status"] {
  if (status === "in_progress") return "inProgress";
  if (status === "completed") return "completed";
  if (status === "canceled") return "canceled";
  return "pending";
}

/** Build an enriched prompt from the webhook payload's structured data. */
export function buildPrompt(payload: AgentSessionEventPayload): string {
  const parts: string[] = [];
  const issue = payload.agentSession?.issue;
  const comment = payload.agentSession?.comment;

  if (issue) {
    parts.push(`[Linear Issue ${issue.identifier}] ${issue.title}`);
    parts.push(`URL: ${issue.url}`);
    if (issue.description) {
      parts.push(`\nDescription:\n${issue.description}`);
    }
  }

  if (comment?.body) {
    parts.push(`\nUser comment:\n${comment.body}`);
  }

  if (payload.previousComments?.length) {
    const commentLines = payload.previousComments.map((c) => `- ${c.body}`).join("\n");
    parts.push(`\nThread context (${payload.previousComments.length} previous comments):\n${commentLines}`);
  }

  if (payload.guidance) {
    parts.push(`\nAgent guidance:\n${payload.guidance}`);
  }

  const promptContext = payload.promptContext ?? "";

  // If we have structured context, prepend it before the XML prompt context
  if (parts.length > 0) {
    return parts.join("\n") + "\n\n---\n\n" + promptContext;
  }

  return promptContext;
}

export class LinearAgentBridge {
  private agentExecutor: AgentExecutor;
  private wsBridge: WsBridge;

  /** Maps Linear agent session IDs to Companion session info */
  private sessionMap = new Map<string, { companionSessionId: string; agentId: string }>();
  /** Maps Companion session IDs back to Linear agent session IDs */
  private reverseMap = new Map<string, string>();
  /** Track active session unsubscribers for cleanup */
  private sessionCleanups = new Map<string, Array<() => void>>();

  constructor(agentExecutor: AgentExecutor, wsBridge: WsBridge) {
    this.agentExecutor = agentExecutor;
    this.wsBridge = wsBridge;
    this.restoreSessionMaps();
  }

  /** Restore Linear<->Companion session mappings from persisted session state. */
  private restoreSessionMaps(): void {
    const mappings = this.wsBridge.getLinearSessionMappings();
    for (const { sessionId, linearSessionId } of mappings) {
      // Try to find the agent for this session from the session's execution history
      // Fallback: find any enabled Linear agent
      const agentId = this.findAnyLinearAgentId() || "";
      this.sessionMap.set(linearSessionId, { companionSessionId: sessionId, agentId });
      this.reverseMap.set(sessionId, linearSessionId);
    }
    if (mappings.length > 0) {
      console.log(`[linear-agent-bridge] Restored ${mappings.length} session mapping(s) from disk`);
    }
  }

  /** Handle an incoming AgentSessionEvent from Linear. */
  async handleEvent(payload: AgentSessionEventPayload): Promise<void> {
    if (payload.action === "created") {
      await this.handleCreated(payload);
    } else if (payload.action === "prompted") {
      await this.handlePrompted(payload);
    }
  }

  /** Handle a new agent session (user mentioned or assigned the agent). */
  private async handleCreated(payload: AgentSessionEventPayload): Promise<void> {
    const linearSessionId = payload.agentSession?.id;
    const enrichedPrompt = buildPrompt(payload);

    if (!linearSessionId) {
      console.error("[linear-agent-bridge] No session ID found in payload:", JSON.stringify(payload));
      return;
    }

    console.log(`[linear-agent-bridge] New agent session: ${linearSessionId}`);

    // 1. Find the right Companion agent by OAuth client ID
    const agent = this.findLinearAgentByClientId(payload.oauthClientId);
    if (!agent) {
      // Can't post activity without credentials — just log
      console.error(`[linear-agent-bridge] No agent configured for oauthClientId: ${payload.oauthClientId}`);
      return;
    }

    const creds = this.getCredentials(agent);
    const onTokensRefreshed = this.createTokenRefreshCallback(agent.id);
    const oauthConn = agent.triggers?.linear?.oauthConnectionId
      ? getOAuthConnection(agent.triggers.linear.oauthConnectionId)
      : null;
    const linearAccessEnv = oauthConn?.accessToken
      ? {
        LINEAR_OAUTH_ACCESS_TOKEN: oauthConn.accessToken,
        LINEAR_API_KEY: oauthConn.accessToken,
      }
      : undefined;
    const linearSystemPrompt = oauthConn?.accessToken
      ? buildLinearOAuthSystemPrompt({ name: oauthConn.name })
      : undefined;

    // 2. Immediately acknowledge with a thought (must be within 10s)
    linearAgent.postActivity(creds, linearSessionId, {
      type: "thought",
      body: "Starting Companion session...",
      ephemeral: true,
    }, onTokensRefreshed).catch((err) => console.error("[linear-agent-bridge] Failed to post initial thought:", err));

    // 3. Launch the CLI session with enriched prompt
    try {
      const sessionInfo = await this.agentExecutor.executeAgent(agent.id, enrichedPrompt, {
        force: true,
        triggerType: "linear",
        additionalEnv: linearAccessEnv,
        systemPrompt: linearSystemPrompt,
      });

      if (!sessionInfo) {
        // Check if the agent is already running (overlap prevention)
        const agentData = agentStore.getAgent(agent.id);
        const isOverlap = agentData?.lastSessionId && this.wsBridge.getSession(agentData.lastSessionId);
        await linearAgent.postActivity(creds, linearSessionId, {
          type: "error",
          body: isOverlap
            ? `Agent "${agent.name}" is currently busy with another session. Please wait for it to complete.`
            : "Failed to start Companion session. Check The Companion for details.",
        }, onTokensRefreshed);
        return;
      }

      const companionSessionId = sessionInfo.sessionId;

      // 4. Map sessions and persist (include agentId for follow-up credential lookup)
      this.sessionMap.set(linearSessionId, { companionSessionId, agentId: agent.id });
      this.reverseMap.set(companionSessionId, linearSessionId);
      this.wsBridge.setLinearSessionId(companionSessionId, linearSessionId);

      // 5. Set external URL linking back to Companion
      const settings = getSettings();
      const baseUrl = settings.publicUrl || "http://localhost:3456";
      linearAgent.updateSessionUrls(
        creds,
        linearSessionId,
        [{ label: "Companion Session", url: `${baseUrl}/#/session/${companionSessionId}` }],
        onTokensRefreshed,
      ).catch((err) => console.error("[linear-agent-bridge] Failed to set external URLs:", err));

      // 6. Set up response relay (pass agentId for credential lookup)
      this.setupRelay(linearSessionId, companionSessionId, agent.id);

      await linearAgent.postActivity(creds, linearSessionId, {
        type: "thought",
        body: `Agent "${agent.name}" session started. Working on it...`,
      }, onTokensRefreshed);
    } catch (err) {
      console.error("[linear-agent-bridge] Failed to start session:", err);
      await linearAgent.postActivity(creds, linearSessionId, {
        type: "error",
        body: `Failed to start session: ${err instanceof Error ? err.message : String(err)}`,
      }, onTokensRefreshed);
    }
  }

  /** Handle a follow-up prompt in an existing agent session. */
  private async handlePrompted(payload: AgentSessionEventPayload): Promise<void> {
    const linearSessionId = payload.agentSession?.id;

    // Extract follow-up message from multiple possible locations:
    // 1. agentActivity.content.body — the nested content from the prompted activity
    // 2. agentActivity.body — direct body (alternative format)
    // 3. agentSession.comment.body — the comment that triggered the follow-up
    // 4. promptContext — the full XML context (last resort)
    const message = (
      payload.agentActivity?.content?.body
      || payload.agentActivity?.body
      || payload.agentSession?.comment?.body
      || payload.promptContext
      || ""
    ).trim();

    if (!linearSessionId) {
      console.error("[linear-agent-bridge] No session ID found in prompted payload:", JSON.stringify(payload));
      return;
    }

    // Skip empty follow-ups — no point injecting a blank message
    if (!message) {
      console.log(`[linear-agent-bridge] Ignoring empty follow-up for ${linearSessionId}`);
      return;
    }

    const mapping = this.sessionMap.get(linearSessionId);
    if (!mapping) {
      // Session not found — might have expired. Create a new one with the follow-up message.
      console.log(`[linear-agent-bridge] No session mapping for ${linearSessionId}, creating new`);
      await this.handleCreated({
        ...payload,
        action: "created",
        promptContext: message,
      });
      return;
    }

    const { companionSessionId, agentId } = mapping;

    console.log(`[linear-agent-bridge] Follow-up for session ${linearSessionId} → ${companionSessionId}`);

    // Check if the Companion session is still alive before injecting
    const session = this.wsBridge.getSession(companionSessionId);
    if (!session) {
      console.log(`[linear-agent-bridge] Session ${companionSessionId} is dead, creating new`);
      // Clean up stale mapping
      this.sessionMap.delete(linearSessionId);
      this.reverseMap.delete(companionSessionId);
      this.cleanupRelay(companionSessionId);
      // Start a new session with the follow-up message as prompt context
      await this.handleCreated({
        ...payload,
        action: "created",
        promptContext: message,
      });
      return;
    }

    // Look up agent for credentials
    const agent = agentStore.getAgent(agentId);
    const creds = agent ? this.getCredentials(agent) : null;
    const onTokensRefreshed = this.createTokenRefreshCallback(agentId);

    // Post acknowledgement
    if (creds) {
      linearAgent.postActivity(creds, linearSessionId, {
        type: "thought",
        body: "Processing follow-up...",
        ephemeral: true,
      }, onTokensRefreshed).catch((err) => console.error("[linear-agent-bridge] Failed to post thought:", err));
    }

    // Re-establish relay for the new turn (resets pendingText accumulator).
    // setupRelay calls cleanupRelay internally first, so old listeners are removed.
    this.setupRelay(linearSessionId, companionSessionId, agentId);

    // Inject user message into the running Companion session
    this.wsBridge.injectUserMessage(companionSessionId, message);
  }

  /** Set up bidirectional relay between a Companion session and a Linear agent session. */
  private setupRelay(linearSessionId: string, companionSessionId: string, agentId: string): void {
    // Clean up any existing relay
    this.cleanupRelay(companionSessionId);

    // Look up current agent credentials for this relay session
    const agent = agentStore.getAgent(agentId);
    const creds = agent ? this.getCredentials(agent) : null;
    if (!creds) {
      console.error(`[linear-agent-bridge] Cannot setup relay — agent ${agentId} not found`);
      return;
    }

    const cleanups: Array<() => void> = [];
    let pendingText = "";
    let streamedTextForCurrentMessage = "";
    // Track pending tool uses by ID so we can post results when they come back
    const pendingToolUseIds = new Map<string, string>(); // tool_use_id → tool name
    const onTokensRefreshed = this.createTokenRefreshCallback(agentId);

    const appendPendingText = (text: string) => {
      if (!text) return;
      pendingText += (pendingText ? "\n" : "") + text;
    };

    const unsubStream = companionBus.on("message:stream_event", ({ sessionId, message }) => {
      if (sessionId !== companionSessionId) return;
      const delta = extractTextDeltaFromStreamEvent(message);
      if (!delta) return;

      if (!streamedTextForCurrentMessage) {
        appendPendingText(delta);
      } else {
        pendingText += delta;
      }
      streamedTextForCurrentMessage += delta;
    });
    cleanups.push(unsubStream);

    // Relay assistant messages → Linear activities
    const unsubAssistant = companionBus.on("message:assistant", ({ sessionId, message: msg }) => {
      if (sessionId !== companionSessionId) return;
      const text = extractTextFromAssistant(msg);
      if (text) {
        if (streamedTextForCurrentMessage && text.startsWith(streamedTextForCurrentMessage)) {
          const suffix = text.slice(streamedTextForCurrentMessage.length);
          if (suffix) {
            pendingText += suffix;
          }
        } else if (!streamedTextForCurrentMessage || text !== streamedTextForCurrentMessage) {
          appendPendingText(text);
        }
      }
      streamedTextForCurrentMessage = "";

      // Relay all tool use blocks as action activities (supports parallel tool calls)
      for (const tool of extractToolUses(msg)) {
        // Track tool use IDs for result matching (id is on the block itself)
        if (tool.id) {
          pendingToolUseIds.set(tool.id, tool.name);
        }

        linearAgent.postActivity(creds, linearSessionId, {
          type: "action",
          action: tool.name,
          parameter: tool.input || undefined,
          ephemeral: true,
        }, onTokensRefreshed).catch((err) => console.error("[linear-agent-bridge] Failed to post action:", err));

        // Relay TodoWrite → Linear plan checklist
        if (tool.name === "TodoWrite" && tool.rawInput) {
          const todos = (tool.rawInput as { todos?: unknown[] }).todos;
          if (Array.isArray(todos)) {
            const planItems: AgentPlanItem[] = todos
              .filter((t): t is { content: string; status: string } =>
                typeof t === "object" && t !== null
                && typeof (t as Record<string, unknown>).content === "string"
                && typeof (t as Record<string, unknown>).status === "string")
              .map((t) => ({
                content: t.content,
                status: mapTodoStatus(t.status),
              }));
            if (planItems.length > 0) {
              linearAgent.updateSessionPlan(creds, linearSessionId, planItems, onTokensRefreshed)
                .catch((err) => console.error("[linear-agent-bridge] Failed to update plan:", err));
            }
          }
        }
      }

      // Relay tool results back to Linear as action activities with result field
      for (const result of extractToolResults(msg)) {
        const toolName = pendingToolUseIds.get(result.tool_use_id);
        if (toolName && result.content) {
          pendingToolUseIds.delete(result.tool_use_id);
          linearAgent.postActivity(creds, linearSessionId, {
            type: "action",
            action: toolName,
            result: result.content,
            ephemeral: true,
          }, onTokensRefreshed).catch((err) => console.error("[linear-agent-bridge] Failed to post tool result:", err));
        }
      }
    });
    cleanups.push(unsubAssistant);

    // Intermediate progress flush — post accumulated text as ephemeral thoughts
    // every PROGRESS_FLUSH_INTERVAL_MS so Linear doesn't look stalled.
    let lastFlushedLength = 0;
    const progressTimer = setInterval(() => {
      if (pendingText.length > lastFlushedLength) {
        const newText = pendingText.slice(lastFlushedLength);
        lastFlushedLength = pendingText.length;
        linearAgent.postActivity(creds, linearSessionId, {
          type: "thought",
          body: newText.slice(0, 2000),
          ephemeral: true,
        }, onTokensRefreshed).catch((err) => console.error("[linear-agent-bridge] Failed to post progress:", err));
      }
    }, PROGRESS_FLUSH_INTERVAL_MS);
    cleanups.push(() => clearInterval(progressTimer));

    // Relay turn completion → post accumulated text as a response activity.
    // Do NOT clean up session mappings or relay — the Linear agent session
    // is long-lived and supports multi-turn follow-ups via "prompted" events.
    const unsubResult = companionBus.on("message:result", async ({ sessionId }) => {
      if (sessionId !== companionSessionId) return;
      if (pendingText) {
        try {
          await linearAgent.postActivity(creds, linearSessionId, {
            type: "response",
            body: pendingText,
          }, onTokensRefreshed);
        } catch (err) {
          console.error("[linear-agent-bridge] Failed to post response:", err);
        }
        pendingText = "";
        lastFlushedLength = 0;
        streamedTextForCurrentMessage = "";
      }
    });
    cleanups.push(unsubResult);

    // Auto-cleanup relay when the Companion session exits, restoring the
    // implicit cleanup that the old per-session WsBridge listener Maps provided.
    const unsubExited = companionBus.on("session:exited", ({ sessionId }) => {
      if (sessionId === companionSessionId) {
        this.cleanupRelay(companionSessionId);
      }
    });
    cleanups.push(unsubExited);

    this.sessionCleanups.set(companionSessionId, cleanups);
  }

  /** Clean up listeners for a session. */
  private cleanupRelay(companionSessionId: string): void {
    const cleanups = this.sessionCleanups.get(companionSessionId);
    if (cleanups) {
      cleanups.forEach((fn) => fn());
      this.sessionCleanups.delete(companionSessionId);
    }
  }

  /** Extract Linear OAuth credentials from an agent's config.
   *  Prefers the new `oauthConnectionId` model, falls back to inline credentials. */
  private getCredentials(agent: AgentConfig): LinearOAuthCredentials {
    const linear = agent.triggers?.linear;

    // New model: resolve from OAuth connection
    if (linear?.oauthConnectionId) {
      const conn = getOAuthConnection(linear.oauthConnectionId);
      if (conn) {
        return {
          clientId: conn.oauthClientId,
          clientSecret: conn.oauthClientSecret,
          webhookSecret: conn.webhookSecret,
          accessToken: conn.accessToken,
          refreshToken: conn.refreshToken,
        };
      }
      console.warn(
        `[linear-agent-bridge] OAuth connection "${linear.oauthConnectionId}" referenced by agent not found — falling back to inline credentials`,
      );
    }

    // Legacy fallback: inline credentials
    return {
      clientId: linear?.oauthClientId || "",
      clientSecret: linear?.oauthClientSecret || "",
      webhookSecret: linear?.webhookSecret || "",
      accessToken: linear?.accessToken || "",
      refreshToken: linear?.refreshToken || "",
    };
  }

  /** Create a callback that persists refreshed tokens back to the appropriate store. */
  private createTokenRefreshCallback(agentId: string): (tokens: { accessToken: string; refreshToken: string }) => void {
    return (tokens) => {
      const agent = agentStore.getAgent(agentId);
      if (!agent?.triggers?.linear) return;

      // New model: update the OAuth connection
      if (agent.triggers.linear.oauthConnectionId) {
        updateOAuthConnection(agent.triggers.linear.oauthConnectionId, {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          status: "connected",
        });
        return;
      }

      // Legacy fallback: update agent inline
      agentStore.updateAgent(agentId, {
        triggers: {
          ...agent.triggers,
          linear: {
            ...agent.triggers.linear,
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
          },
        },
      });
    };
  }

  /** Find the agent configured for a specific Linear OAuth client ID.
   *  Checks both new `oauthConnectionId` model and legacy inline credentials. */
  private findLinearAgentByClientId(oauthClientId: string | undefined): AgentConfig | null {
    if (!oauthClientId) return null;
    const agents = agentStore.listAgents();

    // New model: find agents via OAuth connection reference
    const oauthConn = findOAuthConnectionByClientId(oauthClientId);
    if (oauthConn) {
      const agent = agents.find(
        (a) => a.enabled && a.triggers?.linear?.enabled
          && a.triggers.linear.oauthConnectionId === oauthConn.id,
      );
      if (agent) return agent;
    }

    // Legacy fallback: inline oauthClientId
    const legacyAgent = agents.find(
      (a) => a.enabled && a.triggers?.linear?.enabled
        && a.triggers.linear.oauthClientId === oauthClientId,
    );
    return legacyAgent || null;
  }

  /** Find any enabled Linear agent's ID (for backward compat on session restore). */
  private findAnyLinearAgentId(): string | null {
    const agents = agentStore.listAgents();
    const agent = agents.find((a) => a.enabled && a.triggers?.linear?.enabled);
    return agent?.id || null;
  }

  /** Clean up all session mappings and listeners. */
  shutdown(): void {
    for (const [companionSessionId] of this.sessionCleanups) {
      this.cleanupRelay(companionSessionId);
    }
    this.sessionMap.clear();
    this.reverseMap.clear();
  }
}
