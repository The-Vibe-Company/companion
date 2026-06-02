import type {
  BrowserIncomingMessage,
  BrowserOutgoingMessage,
  PermissionRequest,
} from "./session-types.js";
import type { CodexAdapter } from "./codex-adapter.js";
import type { Session } from "./ws-bridge-types.js";
import { appendHistory } from "./ws-bridge-persist.js";
import { validatePermission } from "./ai-validator.js";
import { getEffectiveAiValidation } from "./ai-validation-settings.js";
import { companionBus } from "./event-bus.js";

/**
 * @deprecated This file is no longer used in production. Codex adapters are now
 * wired through the unified `attachBackendAdapter()` pipeline in `ws-bridge.ts`.
 * This file is kept only for its test coverage which validates Codex-specific
 * adapter handler logic patterns. It will be removed in a future cleanup pass.
 */

export interface CodexAttachDeps {
  persistSession: (session: Session) => void;
  refreshGitInfo: (
    session: Session,
    options?: { broadcastUpdate?: boolean; notifyPoller?: boolean },
  ) => void;
  broadcastToBrowsers: (session: Session, msg: BrowserIncomingMessage) => void;
  autoNamingAttempted: Set<string>;
}

export function attachCodexAdapterHandlers(
  sessionId: string,
  session: Session,
  adapter: CodexAdapter,
  deps: CodexAttachDeps,
): void {
  adapter.onBrowserMessage((msg) => {
    // Track activity for idle detection — mirrors routeCLIMessage logic for
    // Claude Code NDJSON. Without this, Codex sessions get incorrectly
    // idle-killed because lastCliActivityTs is never updated.
    session.lastCliActivityTs = Date.now();

    if (msg.type === "session_init") {
      // Preserve pre-populated commands/skills when adapter sends empty arrays
      // (Codex does not provide its own commands/skills)
      // Exclude session_id: the adapter may report its own internal session ID
      // which differs from the Companion's session ID.  Allowing it to overwrite
      // session.state.session_id causes duplicate sidebar entries.
      const { slash_commands, skills, session_id: _cliSessionId, ...rest } = msg.session;
      session.state = {
        ...session.state,
        ...rest,
        ...(slash_commands?.length ? { slash_commands } : {}),
        ...(skills?.length ? { skills } : {}),
        backend_type: "codex",
      };
      deps.refreshGitInfo(session, { notifyPoller: true });
      deps.persistSession(session);
      session.stateMachine.transition("ready", "codex_session_init");
    } else if (msg.type === "session_update") {
      // Exclude session_id — same rationale as session_init above.
      const { slash_commands, skills, session_id: _cliSessionId, ...rest } = msg.session;
      session.state = {
        ...session.state,
        ...rest,
        ...(slash_commands?.length ? { slash_commands } : {}),
        ...(skills?.length ? { skills } : {}),
        backend_type: "codex",
      };
      deps.refreshGitInfo(session, { notifyPoller: true });
      deps.persistSession(session);
    } else if (msg.type === "status_change") {
      session.state.is_compacting = msg.status === "compacting";
      if (msg.status === "compacting") {
        session.stateMachine.transition("compacting", "codex_compacting_started");
      } else {
        session.stateMachine.transition("ready", "codex_compacting_ended");
      }
      deps.persistSession(session);
    }

    if (msg.type === "assistant") {
      const assistantMsg = { ...msg, timestamp: msg.timestamp || Date.now() };
      appendHistory(session, assistantMsg);
      deps.persistSession(session);
      companionBus.emit("message:assistant", { sessionId, message: assistantMsg });
    } else if (msg.type === "result") {
      appendHistory(session, msg);
      deps.persistSession(session);
      companionBus.emit("message:result", { sessionId, message: msg });
      session.stateMachine.transition("ready", "codex_turn_completed");
    }

    if (msg.type === "assistant") {
      const content = (msg as { message?: { content?: Array<{ type: string }> } }).message?.content;
      const hasToolUse = content?.some((b) => b.type === "tool_use");
      if (hasToolUse) {
        console.log(`[ws-bridge] Broadcasting tool_use assistant to ${session.browserSockets.size} browser(s) for session ${session.id}`);
      }
    }

    if (msg.type === "permission_cancelled") {
      const reqId = (msg as { request_id: string }).request_id;
      session.pendingPermissions.delete(reqId);
      // If no more pending permissions, transition back to streaming
      if (session.pendingPermissions.size === 0 && session.stateMachine.phase === "awaiting_permission") {
        session.stateMachine.transition("streaming", "permission_cancelled");
      }
      deps.persistSession(session);
    }

    if (msg.type === "permission_request") {
      const perm = msg.request;

      // AI Validation Mode for Codex sessions
      const aiSettings = getEffectiveAiValidation(session.state);
      if (
        aiSettings.enabled
        && aiSettings.anthropicApiKey
        && perm.tool_name !== "AskUserQuestion"
        && perm.tool_name !== "ExitPlanMode"
      ) {
        // Run AI validation async — don't broadcast yet
        handleCodexAiValidation(session, adapter, perm, deps).catch((err) => {
          console.warn(`[ws-bridge-codex] AI validation error for tool=${perm.tool_name} request_id=${perm.request_id} session=${session.id}, falling through to manual:`, err);
          // On error, fall through to normal permission flow
          session.pendingPermissions.set(perm.request_id, perm);
          session.stateMachine.transition("awaiting_permission", "ai_validation_error_fallback");
          deps.persistSession(session);
          deps.broadcastToBrowsers(session, msg);
        });
        return;
      }

      session.pendingPermissions.set(perm.request_id, perm);
      deps.persistSession(session);
      session.stateMachine.transition("awaiting_permission", "codex_permission_requested");
    }

    deps.broadcastToBrowsers(session, msg);

    if (
      msg.type === "result" &&
      !(msg.data as { is_error?: boolean }).is_error &&
      !deps.autoNamingAttempted.has(session.id)
    ) {
      deps.autoNamingAttempted.add(session.id);
      const firstUserMsg = session.messageHistory.find((m) => m.type === "user_message");
      if (firstUserMsg && firstUserMsg.type === "user_message") {
        companionBus.emit("session:first-turn-completed", { sessionId: session.id, firstUserMessage: firstUserMsg.content });
      }
    }
  });

  adapter.onSessionMeta((meta) => {
    if (meta.cliSessionId) {
      companionBus.emit("session:cli-id-received", { sessionId: session.id, cliSessionId: meta.cliSessionId });
    }
    if (meta.model) session.state.model = meta.model;
    if (meta.cwd) session.state.cwd = meta.cwd;
    session.state.backend_type = "codex";
    deps.refreshGitInfo(session, { broadcastUpdate: true, notifyPoller: true });
    deps.persistSession(session);
  });

  adapter.onDisconnect(() => {
    // Guard: only clear the adapter reference if THIS adapter is still the active
    // one.  During relaunch, a NEW adapter is attached before the OLD one fires
    // its disconnect callback — without this check the new adapter gets nulled out.
    if (session.backendAdapter !== adapter) {
      console.log(`[ws-bridge] Ignoring stale disconnect for session ${sessionId} (adapter replaced)`);
      return;
    }
    for (const [reqId] of session.pendingPermissions) {
      deps.broadcastToBrowsers(session, { type: "permission_cancelled", request_id: reqId });
    }
    session.pendingPermissions.clear();
    session.backendAdapter = null;
    deps.persistSession(session);
    console.log(`[ws-bridge] Codex adapter disconnected for session ${sessionId}`);
    deps.broadcastToBrowsers(session, { type: "cli_disconnected" });

    // Auto-relaunch if browsers are still connected (don't leave users staring
    // at a dead session when the transport drops mid-conversation).
    if (session.browserSockets.size > 0) {
      console.log(`[ws-bridge] Auto-relaunching Codex for session ${sessionId} (${session.browserSockets.size} browser(s) connected)`);
      companionBus.emit("session:relaunch-needed", { sessionId });
    }
  });

  if (session.pendingMessages.length > 0) {
    console.log(`[ws-bridge] Flushing ${session.pendingMessages.length} queued message(s) to Codex adapter for session ${sessionId}`);
    const queued = session.pendingMessages.splice(0);
    for (const raw of queued) {
      try {
        const msg = JSON.parse(raw) as BrowserOutgoingMessage;
        adapter.sendBrowserMessage(msg);
      } catch {
        console.warn(`[ws-bridge] Failed to parse queued message for Codex: ${raw.substring(0, 100)}`);
      }
    }
  }

  deps.broadcastToBrowsers(session, { type: "cli_connected" });
  console.log(`[ws-bridge] Codex adapter attached for session ${sessionId}`);
}

async function handleCodexAiValidation(
  session: Session,
  adapter: CodexAdapter,
  perm: PermissionRequest,
  deps: CodexAttachDeps,
): Promise<void> {
  const aiSettings = getEffectiveAiValidation(session.state);
  const result = await validatePermission(
    perm.tool_name,
    perm.input,
    perm.description,
  );

  perm.ai_validation = {
    verdict: result.verdict,
    reason: result.reason,
    ruleBasedOnly: result.ruleBasedOnly,
  };

  // Auto-approve safe tools
  if (result.verdict === "safe" && aiSettings.autoApprove) {
    deps.broadcastToBrowsers(session, {
      type: "permission_auto_resolved",
      request: perm,
      behavior: "allow",
      reason: result.reason,
    });
    adapter.sendBrowserMessage({
      type: "permission_response",
      request_id: perm.request_id,
      behavior: "allow",
    });
    return;
  }

  // Auto-deny dangerous tools
  if (result.verdict === "dangerous" && aiSettings.autoDeny) {
    deps.broadcastToBrowsers(session, {
      type: "permission_auto_resolved",
      request: perm,
      behavior: "deny",
      reason: result.reason,
    });
    adapter.sendBrowserMessage({
      type: "permission_response",
      request_id: perm.request_id,
      behavior: "deny",
    });
    return;
  }

  // Uncertain or auto-action disabled: fall through to manual
  session.pendingPermissions.set(perm.request_id, perm);
  session.stateMachine.transition("awaiting_permission", "ai_validation_manual_fallback");
  deps.persistSession(session);
  deps.broadcastToBrowsers(session, {
    type: "permission_request",
    request: perm,
  });
}
