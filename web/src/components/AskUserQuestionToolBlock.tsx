import { useMemo, useState } from "react";
import { useStore } from "../store.js";
import { sendToSession } from "../ws.js";
import { AskUserQuestionDisplay, formatAskUserAnswers } from "./AskUserQuestionDisplay.js";

/**
 * Renders an AskUserQuestion `tool_use` block from the assistant stream as
 * an interactive options card. This is the stdio-mode equivalent of the
 * permission_request rendering in PermissionBanner — the CLI no longer
 * routes AskUserQuestion through the can_use_tool gate, so we surface it
 * inline in the chat instead.
 *
 * On submit, the user's answers are formatted as a regular user_message and
 * sent over the existing WS. The model picks them up on the next turn — the
 * AskUserQuestion call is already in conversation history, so it knows what
 * the answer is responding to.
 *
 * "Already answered" detection is intentionally minimal: if any user_message
 * appears in the chat history *after* this AskUserQuestion's tool_use, the
 * card is rendered in a disabled / display-only state. This avoids letting
 * users re-submit answers on a stale historical question after a page
 * refresh.
 */
export function AskUserQuestionToolBlock({
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
  const [submitted, setSubmitted] = useState<string | null>(null);

  // Has the user already responded to *this specific* AskUserQuestion call?
  // We treat any user_message AFTER the assistant message that contained
  // this tool_use_id as a response. The model is the actual interpreter —
  // we just gate the UI so the user can't accidentally answer twice.
  const alreadyAnswered = useMemo(() => {
    if (!messages || !toolUseId) return false;
    let foundOurToolUse = false;
    for (const m of messages) {
      if (!foundOurToolUse) {
        // ChatMessage stores tool_use blocks in `contentBlocks` (the array
        // mirroring the CLI's message.content). `content` is the extracted
        // plain-text string — reading from it always misses tool_use and
        // the option buttons would never auto-disable. Same bug class as
        // ExitPlanModeToolBlock's stale-card regression (session dbb49e21).
        const blocks = (m as { contentBlocks?: unknown }).contentBlocks;
        if (Array.isArray(blocks)) {
          for (const b of blocks) {
            const block = b as { type?: string; id?: string; name?: string };
            if (block.type === "tool_use" && block.id === toolUseId) {
              foundOurToolUse = true;
              break;
            }
          }
        }
        continue;
      }
      // We're now scanning AFTER the AskUserQuestion call. Any user-role
      // message means the user has already answered — model will / has
      // interpret(ed) it.
      if ((m as { role?: string }).role === "user") return true;
    }
    return false;
  }, [messages, toolUseId]);

  function handleSelect(answers: Record<string, string>) {
    if (submitted || alreadyAnswered || !sessionId) return;
    const text = formatAskUserAnswers(input, answers);
    setSubmitted(text);
    sendToSession(sessionId, { type: "user_message", content: text });
  }

  return (
    <div
      className="border border-cc-primary/30 rounded-[10px] overflow-hidden bg-cc-primary/5"
      data-tool-use-id={toolUseId}
    >
      <div className="flex items-center gap-2 px-3 py-2 bg-cc-primary/10 border-b border-cc-primary/20">
        <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5 text-cc-primary shrink-0">
          <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-5a.75.75 0 01.75.75v4.5a.75.75 0 01-1.5 0v-4.5A.75.75 0 0110 5zm0 10a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
        </svg>
        <span className="text-xs font-medium text-cc-primary">
          {alreadyAnswered || submitted ? "Question answered" : "Question for you"}
        </span>
      </div>
      <div className="p-3">
        {submitted ? (
          <div className="text-xs text-cc-muted">
            Sent: <span className="font-mono-code text-cc-fg whitespace-pre-wrap">{submitted}</span>
          </div>
        ) : (
          <AskUserQuestionDisplay
            input={input}
            onSelect={handleSelect}
            disabled={alreadyAnswered || !sessionId}
          />
        )}
      </div>
    </div>
  );
}
