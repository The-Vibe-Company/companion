import { useMemo, useState } from "react";
import { useStore } from "../store.js";
import { api } from "../api.js";
import { sendToSession } from "../ws.js";

/**
 * Matches the verbatim tool_result content the Claude Code CLI emits when
 * it refuses to write a "sensitive" path (`.claude/hooks/*`,
 * `.claude/settings.json`, memory files, etc.). The CLI returns
 *   "Claude requested permissions to edit X which is a sensitive file."
 * with `is_error: true` and does NOT fire a `can_use_tool` request — so
 * companion never gets to surface a PermissionBanner, and the model
 * misreads the wording as "user is reviewing in UI" and loops.
 *
 * We sniff for the "sensitive file" tail rather than the prefix because
 * the prefix may evolve; the tail has been stable. Anchor on the period
 * to reduce false positives.
 */
const SENSITIVE_FILE_REJECTION_PATTERN = /which is a sensitive file\.?\s*$/i;

export function isSensitiveFileRejection(content: string): boolean {
  return SENSITIVE_FILE_REJECTION_PATTERN.test(content.trim());
}

/**
 * Inline approval card rendered in place of the misleading "Claude
 * requested permissions..." tool_result. Approve writes the file out-of-
 * band via the companion server (which sandboxes the path to session.cwd
 * + ~/.claude/* + ~/.companion/*) and injects a follow-up user_message
 * so the model stops retrying. Reject sends a "skip this" user_message.
 */
export function SensitiveFileWriteApproval({
  content,
  toolUseId,
}: {
  content: string;
  toolUseId: string;
}) {
  const sessionId = useStore((s) => s.currentSessionId);
  const messages = useStore((s) =>
    sessionId ? s.messages.get(sessionId) ?? null : null,
  );
  const [state, setState] = useState<"idle" | "loading" | "approved" | "rejected" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  // Locate the failed Write's original input by walking the chat history
  // for a tool_use block with our id. The CLI sends the tool_use and the
  // rejection tool_result in separate messages, so the same-message
  // toolUseById map in MessageBubble isn't enough.
  const toolUseInput = useMemo<{ file_path?: string; content?: string } | null>(() => {
    if (!messages || !toolUseId) return null;
    for (const m of messages) {
      const blocks = (m as { contentBlocks?: unknown }).contentBlocks;
      if (!Array.isArray(blocks)) continue;
      for (const b of blocks) {
        const block = b as { type?: string; id?: string; input?: unknown };
        if (block.type === "tool_use" && block.id === toolUseId) {
          return (block.input ?? null) as { file_path?: string; content?: string } | null;
        }
      }
    }
    return null;
  }, [messages, toolUseId]);

  const filePath = toolUseInput?.file_path;
  const fileContent = toolUseInput?.content;
  const canApprove = !!sessionId && typeof filePath === "string" && typeof fileContent === "string";

  async function handleApprove() {
    if (!canApprove || !sessionId || !filePath || fileContent === undefined) return;
    setState("loading");
    setError(null);
    try {
      await api.sensitiveWrite(sessionId, {
        file_path: filePath,
        content: fileContent,
        tool_use_id: toolUseId,
      });
      setState("approved");
    } catch (err) {
      setState("error");
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function handleReject() {
    if (state !== "idle" || !sessionId) return;
    setState("rejected");
    sendToSession(sessionId, {
      type: "user_message",
      content: `Skip writing ${filePath ?? "the sensitive file"}; the user declined. Try a different approach or move on.`,
    });
  }

  const headerLabel =
    state === "approved" ? "Approved — file written"
    : state === "rejected" ? "Rejected — model will skip"
    : state === "error" ? "Approval failed"
    : "CLI blocked a write to a sensitive file";

  return (
    <div
      className="border border-cc-warning/40 rounded-[10px] overflow-hidden bg-cc-warning/5"
      data-tool-use-id={toolUseId}
    >
      <div className="flex items-center gap-2 px-3 py-2 bg-cc-warning/10 border-b border-cc-warning/20">
        <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5 text-cc-warning shrink-0">
          <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
        </svg>
        <span className="text-xs font-medium text-cc-warning">{headerLabel}</span>
      </div>

      <div className="p-3 space-y-2">
        <div className="text-[11px] text-cc-muted italic">{content}</div>

        {filePath && (
          <div className="text-[11px] font-mono-code text-cc-fg bg-cc-code-bg/40 rounded-md px-2 py-1.5 break-all">
            {filePath}
          </div>
        )}

        {typeof fileContent === "string" && (
          <details className="text-[11px]">
            <summary className="cursor-pointer text-cc-muted hover:text-cc-fg">
              Show pending content ({fileContent.length} chars)
            </summary>
            <pre className="mt-1 max-h-48 overflow-auto bg-cc-code-bg/40 rounded-md px-2 py-1.5 text-cc-fg font-mono-code whitespace-pre-wrap break-words">
              {fileContent}
            </pre>
          </details>
        )}

        {state === "error" && error && (
          <div className="text-[11px] text-cc-error bg-cc-error/10 rounded-md px-2 py-1.5">
            {error}
          </div>
        )}

        {state === "idle" && (
          <div className="flex items-center gap-2 flex-wrap pt-1">
            <button
              onClick={handleApprove}
              disabled={!canApprove}
              title={!canApprove ? "Original Write tool_use not found in history" : undefined}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg bg-cc-success/90 hover:bg-cc-success text-white disabled:opacity-50 transition-colors cursor-pointer"
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-3 h-3">
                <path d="M3 8.5l3.5 3.5 6.5-7" />
              </svg>
              Approve and write
            </button>
            <button
              onClick={handleReject}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg bg-cc-hover hover:bg-cc-active text-cc-fg border border-cc-border transition-colors cursor-pointer"
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-3 h-3">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
              Reject
            </button>
          </div>
        )}

        {state === "loading" && (
          <div className="text-[11px] text-cc-muted">Writing file…</div>
        )}
      </div>
    </div>
  );
}
