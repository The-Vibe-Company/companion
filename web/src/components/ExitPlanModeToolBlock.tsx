import { useMemo, useState } from "react";
import { useStore } from "../store.js";
import { sendToSession } from "../ws.js";
import { ExitPlanModeDisplay } from "./ExitPlanModeDisplay.js";

/**
 * Renders an `ExitPlanMode` `tool_use` block with an Approve / Reject pair
 * of buttons.
 *
 * Why the buttons: in `--permission-mode plan`, the CLI keeps gating tool
 * calls (Edit/Write) even after `ExitPlanMode` is auto-resolved at the
 * tool-use level. The model sees the tool call as "answered" but the
 * downstream writes still get refused because the permission mode hasn't
 * actually flipped. The TUI version of Claude Code provides an Approve
 * button that flips the mode; we replicate that here for stdio mode.
 *
 * Approve sends:
 *   - `set_permission_mode` to `"default"` IFF the session is currently
 *     in `"plan"` (don't downgrade a bypass session unintentionally)
 *   - a follow-up `user_message` confirming approval so the model
 *     proceeds on the next turn
 *
 * Reject just sends a `user_message` asking the model to revise. No mode
 * change.
 *
 * "Already answered" detection mirrors AskUserQuestionToolBlock — if any
 * user_message appears in chat history *after* this tool_use, the buttons
 * are hidden so a refresh-then-click can't double-answer.
 */
export function ExitPlanModeToolBlock({
  input,
  toolUseId,
}: {
  input: Record<string, unknown>;
  toolUseId: string;
}) {
  const sessionId = useStore((s) => s.currentSessionId);
  const messages = useStore((s) =>
    sessionId ? s.messages.get(sessionId) ?? null : null,
  );
  const currentPermissionMode = useStore((s) => {
    const sdk = sessionId
      ? s.sdkSessions.find((x) => x.sessionId === sessionId)
      : null;
    return sdk?.permissionMode ?? null;
  });
  const [submitted, setSubmitted] = useState<"approved" | "rejected" | null>(null);

  const alreadyAnswered = useMemo(() => {
    if (!messages || !toolUseId) return false;
    let foundOurToolUse = false;
    for (const m of messages) {
      if (!foundOurToolUse) {
        // ChatMessage stores tool_use blocks in `contentBlocks` (the array
        // mirroring the CLI's message.content). `content` is the extracted
        // plain-text string — reading from it always misses tool_use and
        // the buttons would never auto-disable. Regression observed in
        // session dbb49e21 where 3 stale plan cards from 24h ago stayed
        // clickable indefinitely.
        const blocks = (m as { contentBlocks?: unknown }).contentBlocks;
        if (Array.isArray(blocks)) {
          for (const b of blocks) {
            const block = b as { type?: string; id?: string };
            if (block.type === "tool_use" && block.id === toolUseId) {
              foundOurToolUse = true;
              break;
            }
          }
        }
        continue;
      }
      if ((m as { role?: string }).role === "user") return true;
    }
    return false;
  }, [messages, toolUseId]);

  const disabled = !sessionId || submitted !== null || alreadyAnswered;
  const showButtons = submitted === null && !alreadyAnswered;

  function handleApprove() {
    if (disabled || !sessionId) return;
    setSubmitted("approved");
    if (currentPermissionMode === "plan") {
      sendToSession(sessionId, { type: "set_permission_mode", mode: "default" });
    }
    sendToSession(sessionId, {
      type: "user_message",
      content: "Plan approved. Please proceed with the implementation.",
    });
  }

  function handleReject() {
    if (disabled || !sessionId) return;
    setSubmitted("rejected");
    sendToSession(sessionId, {
      type: "user_message",
      content: "Plan rejected — please revise the plan and present a new version.",
    });
  }

  let statusLine: string | null = null;
  if (submitted === "approved") statusLine = "Plan approved — sent to model.";
  else if (submitted === "rejected") statusLine = "Plan rejected — sent revision request.";
  else if (alreadyAnswered) statusLine = "Already responded.";

  return (
    <div
      className="border border-cc-border rounded-[10px] overflow-hidden bg-cc-card p-3 space-y-3"
      data-tool-use-id={toolUseId}
    >
      <ExitPlanModeDisplay input={input} />

      {showButtons ? (
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={handleApprove}
            disabled={disabled}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg bg-cc-success/90 hover:bg-cc-success text-white disabled:opacity-50 transition-colors cursor-pointer"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-3 h-3">
              <path d="M3 8.5l3.5 3.5 6.5-7" />
            </svg>
            Approve plan
          </button>
          <button
            onClick={handleReject}
            disabled={disabled}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg bg-cc-hover hover:bg-cc-active text-cc-fg border border-cc-border disabled:opacity-50 transition-colors cursor-pointer"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-3 h-3">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
            Reject
          </button>
        </div>
      ) : (
        <div className="text-[11px] text-cc-muted italic">{statusLine}</div>
      )}
    </div>
  );
}
