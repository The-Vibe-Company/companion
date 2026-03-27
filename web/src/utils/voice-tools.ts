/**
 * Voice tool declarations and executor for Gemini Voice Control.
 *
 * Defines the 10 function declarations that Gemini can call, and implements
 * each tool using the existing Companion REST API and WebSocket client.
 */

import { api, createSessionStream } from "../api.js";
import { sendToSession, createClientMessageId, connectSession, waitForConnection } from "../ws.js";
import { useStore } from "../store.js";
import { navigateToSession } from "./routing.js";
import { generateUniqueSessionName } from "./names.js";

// ─── System Instruction ──────────────────────────────────────────────────────

export const VOICE_SYSTEM_INSTRUCTION = `You are a voice assistant for "The Companion", a web UI for AI coding agents (Claude Code and Codex).
You help users control The Companion hands-free by voice. You can:

- Create coding sessions: specify a prompt, project folder (cwd), backend (claude or codex), model, and sandbox mode
- Send messages to active sessions
- Approve or deny tool permission requests (describe what's being approved first)
- Navigate the UI to different pages (home, settings, sandboxes, environments, prompts, integrations, agents, runs, scheduled, terminal)
- Switch between active sessions by name or ID
- List active sessions and their status
- Interrupt/stop running sessions
- Get detailed session status

Rules:
- Keep responses brief — you're speaking them aloud
- When creating sessions, use "claude" backend and the user's home directory if they don't specify
- When approving permissions, briefly describe what the tool wants to do
- Be conversational and confirm completed actions
- If you need more info to execute a command, ask briefly
- When listing sessions, mention their name, status, and project
- Respond in the same language as the user. If the user speaks French, respond in French. If they speak English, respond in English.`;

// ─── Tool Declarations (Gemini function declaration format) ──────────────────

export const TOOL_DECLARATIONS = [
  {
    name: "create_session",
    description: "Create a new AI coding session and optionally send an initial prompt",
    parameters: {
      type: "OBJECT",
      properties: {
        prompt: { type: "STRING", description: "Initial prompt/task to send to the AI" },
        cwd: { type: "STRING", description: "Project directory path (working directory)" },
        backend: { type: "STRING", description: "AI backend: 'claude' or 'codex'", enum: ["claude", "codex"] },
        model: { type: "STRING", description: "Model name (e.g. 'claude-sonnet-4-6', 'o4-mini')" },
        sandbox_enabled: { type: "BOOLEAN", description: "Run in a Docker sandbox" },
        permission_mode: { type: "STRING", description: "Permission mode: 'default', 'acceptEdits', 'bypassPermissions', 'plan'" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "send_message",
    description: "Send a text message or prompt to an active session",
    parameters: {
      type: "OBJECT",
      properties: {
        session_id: { type: "STRING", description: "Session ID to send the message to. Use list_sessions to find available sessions." },
        content: { type: "STRING", description: "Message content to send" },
      },
      required: ["session_id", "content"],
    },
  },
  {
    name: "approve_permission",
    description: "Approve a pending tool permission request in a session",
    parameters: {
      type: "OBJECT",
      properties: {
        session_id: { type: "STRING", description: "Session ID" },
        request_id: { type: "STRING", description: "Permission request ID to approve" },
      },
      required: ["session_id", "request_id"],
    },
  },
  {
    name: "deny_permission",
    description: "Deny a pending tool permission request in a session",
    parameters: {
      type: "OBJECT",
      properties: {
        session_id: { type: "STRING", description: "Session ID" },
        request_id: { type: "STRING", description: "Permission request ID to deny" },
      },
      required: ["session_id", "request_id"],
    },
  },
  {
    name: "approve_all_permissions",
    description: "Approve all pending permission requests for a session at once",
    parameters: {
      type: "OBJECT",
      properties: {
        session_id: { type: "STRING", description: "Session ID" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "navigate_page",
    description: "Navigate the Companion UI to a specific page",
    parameters: {
      type: "OBJECT",
      properties: {
        page: {
          type: "STRING",
          description: "Page to navigate to",
          enum: ["home", "settings", "sandboxes", "environments", "prompts", "integrations", "agents", "runs", "scheduled", "terminal"],
        },
      },
      required: ["page"],
    },
  },
  {
    name: "switch_session",
    description: "Switch to viewing a specific session by name or ID",
    parameters: {
      type: "OBJECT",
      properties: {
        session_name_or_id: { type: "STRING", description: "Session name or session ID to switch to" },
      },
      required: ["session_name_or_id"],
    },
  },
  {
    name: "list_sessions",
    description: "List all active (non-archived) sessions with their name, status, backend, and project folder",
    parameters: { type: "OBJECT", properties: {} },
  },
  {
    name: "interrupt_session",
    description: "Stop/interrupt the current AI generation in a session",
    parameters: {
      type: "OBJECT",
      properties: {
        session_id: { type: "STRING", description: "Session ID to interrupt" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "get_session_status",
    description: "Get detailed status of a session including model, cost, turns, and pending permissions",
    parameters: {
      type: "OBJECT",
      properties: {
        session_id: { type: "STRING", description: "Session ID" },
      },
      required: ["session_id"],
    },
  },
];

// ─── Tool Executor ───────────────────────────────────────────────────────────

/**
 * Execute a voice tool call from Gemini and return the result.
 * Each tool maps to existing Companion APIs.
 */
export async function executeVoiceTool(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "create_session":
      return executeCreateSession(args);
    case "send_message":
      return executeSendMessage(args);
    case "approve_permission":
      return executePermissionResponse(args, "allow");
    case "deny_permission":
      return executePermissionResponse(args, "deny");
    case "approve_all_permissions":
      return executeApproveAll(args);
    case "navigate_page":
      return executeNavigatePage(args);
    case "switch_session":
      return executeSwitchSession(args);
    case "list_sessions":
      return executeListSessions();
    case "interrupt_session":
      return executeInterruptSession(args);
    case "get_session_status":
      return executeGetSessionStatus(args);
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ─── Individual Tool Implementations ─────────────────────────────────────────

async function executeCreateSession(args: Record<string, unknown>): Promise<unknown> {
  const prompt = (args.prompt as string) || "";
  const cwd = (args.cwd as string) || undefined;
  const backend = (args.backend as "claude" | "codex") || "claude";
  const model = (args.model as string) || undefined;
  const sandboxEnabled = (args.sandbox_enabled as boolean) || false;
  const permissionMode = (args.permission_mode as string) || undefined;

  try {
    const result = await createSessionStream(
      {
        cwd,
        backend,
        model,
        permissionMode,
        sandboxEnabled: sandboxEnabled || undefined,
      },
      (progress) => {
        useStore.getState().addCreationProgress(progress);
      },
    );

    const sessionId = result.sessionId;

    // Seed SDK session metadata
    const store = useStore.getState();
    const existingSdkSessions = store.sdkSessions.filter((sdk) => sdk.sessionId !== sessionId);
    store.setSdkSessions([
      ...existingSdkSessions,
      {
        sessionId,
        state: result.state as "starting" | "connected" | "running" | "exited",
        cwd: result.cwd,
        createdAt: Date.now(),
        backendType: (result.backendType as "claude" | "codex" | undefined) || backend,
        model,
        permissionMode,
      },
    ]);

    // Assign a session name
    const existingNames = new Set(store.sessionNames.values());
    const sessionName = generateUniqueSessionName(existingNames);
    store.setSessionName(sessionId, sessionName);

    // Navigate to the new session
    navigateToSession(sessionId, true);
    connectSession(sessionId);

    // Send the initial prompt if provided
    if (prompt.trim()) {
      await waitForConnection(sessionId);
      const clientMsgId = createClientMessageId();
      sendToSession(sessionId, {
        type: "user_message",
        content: prompt,
        session_id: sessionId,
        client_msg_id: clientMsgId,
      });
      store.appendMessage(sessionId, {
        id: clientMsgId,
        role: "user",
        content: prompt,
        timestamp: Date.now(),
      });
    }

    // Clear creation progress
    store.clearCreation();

    return { success: true, session_id: sessionId, name: sessionName };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    useStore.getState().clearCreation();
    return { error: msg };
  }
}

function executeSendMessage(args: Record<string, unknown>): unknown {
  const sessionId = args.session_id as string;
  const content = args.content as string;
  if (!sessionId || !content) {
    return { error: "session_id and content are required" };
  }

  const clientMsgId = createClientMessageId();
  sendToSession(sessionId, {
    type: "user_message",
    content,
    session_id: sessionId,
    client_msg_id: clientMsgId,
  });

  useStore.getState().appendMessage(sessionId, {
    id: clientMsgId,
    role: "user",
    content,
    timestamp: Date.now(),
  });

  return { success: true };
}

function executePermissionResponse(
  args: Record<string, unknown>,
  behavior: "allow" | "deny",
): unknown {
  const sessionId = args.session_id as string;
  const requestId = args.request_id as string;
  if (!sessionId || !requestId) {
    return { error: "session_id and request_id are required" };
  }

  sendToSession(sessionId, {
    type: "permission_response",
    request_id: requestId,
    behavior,
  });

  useStore.getState().removePermission(sessionId, requestId);
  return { success: true, action: behavior };
}

function executeApproveAll(args: Record<string, unknown>): unknown {
  const sessionId = args.session_id as string;
  if (!sessionId) return { error: "session_id is required" };

  const store = useStore.getState();
  const perms = store.pendingPermissions.get(sessionId);
  let approvedCount = 0;

  if (perms && perms.size > 0) {
    for (const [requestId] of perms) {
      sendToSession(sessionId, {
        type: "permission_response",
        request_id: requestId,
        behavior: "allow",
      });
      approvedCount++;
    }
    // Clear all permissions from the store
    for (const [requestId] of perms) {
      store.removePermission(sessionId, requestId);
    }
  }

  return { success: true, approved_count: approvedCount };
}

function executeNavigatePage(args: Record<string, unknown>): unknown {
  const page = args.page as string;
  if (!page) return { error: "page is required" };

  const validPages = ["home", "settings", "sandboxes", "environments", "prompts", "integrations", "agents", "runs", "scheduled", "terminal"];
  if (!validPages.includes(page)) {
    return { error: `Invalid page. Valid pages: ${validPages.join(", ")}` };
  }

  window.location.hash = page === "home" ? "#/" : `#/${page}`;
  return { success: true, navigated_to: page };
}

function executeSwitchSession(args: Record<string, unknown>): unknown {
  const nameOrId = (args.session_name_or_id as string) || "";
  if (!nameOrId) return { error: "session_name_or_id is required" };

  const store = useStore.getState();
  let sessionId = nameOrId;

  // Try to find by name (case-insensitive partial match)
  const lowerQuery = nameOrId.toLowerCase();
  for (const [id, name] of store.sessionNames) {
    if (name.toLowerCase().includes(lowerQuery)) {
      sessionId = id;
      break;
    }
  }

  // Also check sdkSessions to verify it exists
  const exists = store.sdkSessions.some((s) => s.sessionId === sessionId && !s.archived);
  if (!exists) {
    return { error: `Session not found: ${nameOrId}` };
  }

  navigateToSession(sessionId);
  return { success: true, session_id: sessionId, name: store.sessionNames.get(sessionId) || sessionId };
}

async function executeListSessions(): Promise<unknown> {
  try {
    const sessions = await api.listSessions();
    const store = useStore.getState();
    const activeSessions = sessions
      .filter((s) => !s.archived)
      .map((s) => ({
        id: s.sessionId,
        name: store.sessionNames.get(s.sessionId) || s.name || s.sessionId,
        status: s.state,
        backend: s.backendType || "claude",
        project: s.cwd?.split("/").pop() || s.cwd,
        cwd: s.cwd,
        model: s.model,
      }));

    return { sessions: activeSessions, count: activeSessions.length };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

function executeInterruptSession(args: Record<string, unknown>): unknown {
  const sessionId = args.session_id as string;
  if (!sessionId) return { error: "session_id is required" };

  sendToSession(sessionId, { type: "interrupt" });
  return { success: true };
}

function executeGetSessionStatus(args: Record<string, unknown>): unknown {
  const sessionId = args.session_id as string;
  if (!sessionId) return { error: "session_id is required" };

  const store = useStore.getState();
  const session = store.sessions.get(sessionId);
  const perms = store.pendingPermissions.get(sessionId);
  const status = store.sessionStatus.get(sessionId);
  const name = store.sessionNames.get(sessionId);

  if (!session) {
    return { error: `Session not found: ${sessionId}` };
  }

  return {
    session_id: sessionId,
    name: name || sessionId,
    model: session.model,
    cwd: session.cwd,
    status: status || "unknown",
    cost_usd: session.total_cost_usd,
    num_turns: session.num_turns,
    context_used_percent: session.context_used_percent,
    git_branch: session.git_branch,
    permission_mode: session.permissionMode,
    pending_permissions: perms
      ? Array.from(perms.values()).map((p) => ({
        request_id: p.request_id,
        tool: p.tool_name,
        description: p.description || `${p.tool_name} wants to execute`,
      }))
      : [],
  };
}
