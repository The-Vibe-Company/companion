import { useState, type ComponentProps } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useStore } from "../store.js";
import { sendToSession } from "../ws.js";
import type { PermissionRequest } from "../types.js";
import type { PermissionUpdate, AiValidationInfo } from "../../server/session-types.js";
import { DiffViewer } from "./DiffViewer.js";
import { AskUserQuestionDisplay } from "./AskUserQuestionDisplay.js";
import { ExitPlanModeDisplay } from "./ExitPlanModeDisplay.js";

/** Human-readable label for a permission suggestion */
function suggestionLabel(s: PermissionUpdate): string {
  if (s.type === "setMode") return `Set mode to "${s.mode}"`;
  const dest = s.destination;
  const scope = dest === "session" ? "for session" : "always";
  if (s.type === "addRules" || s.type === "replaceRules") {
    const rule = s.rules[0];
    if (rule?.ruleContent) return `Allow "${rule.ruleContent}" ${scope}`;
    if (rule?.toolName) return `Allow ${rule.toolName} ${scope}`;
  }
  if (s.type === "addDirectories") {
    return `Trust ${s.directories[0] || "directory"} ${scope}`;
  }
  return `Allow ${scope}`;
}

export function PermissionBanner({
  permission,
  sessionId,
}: {
  permission: PermissionRequest;
  sessionId: string;
}) {
  const [loading, setLoading] = useState(false);
  const removePermission = useStore((s) => s.removePermission);

  function handleAllow(updatedInput?: Record<string, unknown>, updatedPermissions?: PermissionUpdate[]) {
    setLoading(true);
    sendToSession(sessionId, {
      type: "permission_response",
      request_id: permission.request_id,
      behavior: "allow",
      updated_input: updatedInput,
      ...(updatedPermissions?.length ? { updated_permissions: updatedPermissions } : {}),
    });
    removePermission(sessionId, permission.request_id);
  }

  function handleDeny() {
    setLoading(true);
    sendToSession(sessionId, {
      type: "permission_response",
      request_id: permission.request_id,
      behavior: "deny",
      message: "Denied by user",
    });
    removePermission(sessionId, permission.request_id);
  }

  const isAskUser = permission.tool_name === "AskUserQuestion";
  const suggestions = permission.permission_suggestions;

  return (
    <div className="px-2 sm:px-4 py-3 border-b border-cc-border animate-[fadeSlideIn_0.2s_ease-out]">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-start gap-2 sm:gap-3">
          {/* Icon */}
          <div className={`w-7 h-7 sm:w-8 sm:h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${
            isAskUser
              ? "bg-cc-primary/10 border border-cc-primary/20"
              : "bg-cc-warning/10 border border-cc-warning/20"
          }`}>
            {isAskUser ? (
              <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-cc-primary">
                <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-5a.75.75 0 01.75.75v4.5a.75.75 0 01-1.5 0v-4.5A.75.75 0 0110 5zm0 10a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
              </svg>
            ) : (
              <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-cc-warning">
                <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
            )}
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1.5 flex-wrap">
              <span className={`text-xs font-semibold ${isAskUser ? "text-cc-primary" : "text-cc-warning"}`}>
                {isAskUser ? "Question" : "Permission Request"}
              </span>
              {!isAskUser && (
                <>
                  <span className="text-[11px] text-cc-muted font-mono-code">{permission.display_name || permission.tool_name}</span>
                  <FilePathIndicator toolName={permission.tool_name} input={permission.input} />
                </>
              )}
              {permission.title && (
                <span className="text-[11px] text-cc-muted">{permission.title}</span>
              )}
            </div>

            {isAskUser ? (
              <AskUserQuestionDisplay
                input={permission.input}
                onSelect={(answers) => handleAllow({ ...permission.input, answers })}
                disabled={loading}
              />
            ) : (
              <ToolInputDisplay toolName={permission.tool_name} input={permission.input} description={permission.description} />
            )}
            {permission.decision_reason && (
              <p className="text-xs text-cc-muted mt-1 italic">{permission.decision_reason}</p>
            )}

            {/* AI validation recommendation (shown for "uncertain" verdicts that fall through to manual) */}
            {permission.ai_validation && !isAskUser && (
              <AiValidationBadge validation={permission.ai_validation} />
            )}

            {/* Actions - only for non-AskUserQuestion tools */}
            {!isAskUser && (
              <div className="flex items-center gap-2 mt-3 flex-wrap">
                <button
                  onClick={() => handleAllow()}
                  disabled={loading}
                  className="inline-flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium rounded-lg bg-cc-success/90 hover:bg-cc-success text-white disabled:opacity-50 transition-colors cursor-pointer"
                >
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-3 h-3">
                    <path d="M3 8.5l3.5 3.5 6.5-7" />
                  </svg>
                  Allow
                </button>

                {/* Permission suggestion buttons — only when CLI provides them */}
                {suggestions?.map((suggestion, i) => (
                  <button
                    key={i}
                    onClick={() => handleAllow(undefined, [suggestion])}
                    disabled={loading}
                    title={`${suggestion.type}: ${JSON.stringify(suggestion)}`}
                    className="inline-flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium rounded-lg bg-cc-primary/10 hover:bg-cc-primary/20 text-cc-primary border border-cc-primary/20 disabled:opacity-50 transition-colors cursor-pointer"
                  >
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="w-3 h-3">
                      <path d="M3 8.5l3.5 3.5 6.5-7" />
                    </svg>
                    {suggestionLabel(suggestion)}
                  </button>
                ))}

                <button
                  onClick={handleDeny}
                  disabled={loading}
                  className="inline-flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium rounded-lg bg-cc-hover hover:bg-cc-active text-cc-fg border border-cc-border disabled:opacity-50 transition-colors cursor-pointer"
                >
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-3 h-3">
                    <path d="M4 4l8 8M12 4l-8 8" />
                  </svg>
                  Deny
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Detect if a reason string indicates a service/infrastructure failure rather than a genuine analysis. */
function isServiceFailure(reason: string): boolean {
  const failurePatterns = [
    /^Invalid Anthropic/i,
    /^Anthropic .*(rate limit|overloaded|unavailable|error|lacks permission)/i,
    /^AI service/i,
    /^AI evaluation timed out/i,
    /^Model not found/i,
    /^No Anthropic API key/i,
  ];
  return failurePatterns.some((p) => p.test(reason));
}

function AiValidationBadge({ validation }: { validation: AiValidationInfo }) {
  const isFailure = validation.verdict === "uncertain" && isServiceFailure(validation.reason);

  const colorClass =
    validation.verdict === "safe"
      ? "bg-cc-success/10 text-cc-success"
      : validation.verdict === "dangerous"
        ? "bg-cc-error/10 text-cc-error"
        : "bg-cc-warning/10 text-cc-warning";

  const label = isFailure ? "AI analysis unavailable — manual review:" : "AI analysis:";

  return (
    <div className={`mt-2 flex items-center gap-1.5 text-[11px] px-2 py-1.5 rounded-md ${colorClass}`}>
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 shrink-0">
        <path d="M8 1a2.5 2.5 0 00-2.5 2.5v.382a8 8 0 00-1.074.646l-.33-.191a2.5 2.5 0 00-3.415.912 2.5 2.5 0 00.916 3.42l.33.19A8 8 0 001.5 9.5v.382A8 8 0 002 10.5l-.33.19a2.5 2.5 0 00-.916 3.42 2.5 2.5 0 003.415.912l.33-.191a8 8 0 001.074.646V16A2.5 2.5 0 008 13.5 2.5 2.5 0 0010.5 16v-.713a8 8 0 001.074-.646l.33.191a2.5 2.5 0 003.415-.912 2.5 2.5 0 00-.916-3.42L14 10.5V9.5l.33-.19a2.5 2.5 0 00.916-3.42 2.5 2.5 0 00-3.415-.912l-.33.191A8 8 0 0010.5 4.882V4.5A2.5 2.5 0 008 2V1z"/>
      </svg>
      <span className="font-medium">{label}</span>
      <span>{validation.reason}</span>
    </div>
  );
}

/** Shows the file path for file operations in the permission header */
function FilePathIndicator({
  toolName,
  input,
}: {
  toolName: string;
  input: Record<string, unknown>;
}) {
  const filePath = typeof input.file_path === "string" ? input.file_path : "";

  // File operation tools that have a file_path
  if ((toolName === "Edit" || toolName === "Write" || toolName === "Read") && filePath) {
    const fileName = filePath.split("/").pop() || filePath;
    return (
      <span className="text-[11px] px-2 py-1 rounded-md bg-cc-code-bg/50 text-cc-fg/80 font-mono-code truncate max-w-[300px]" title={filePath}>
        {fileName}
      </span>
    );
  }

  // Glob has a pattern
  if (toolName === "Glob") {
    const pattern = typeof input.pattern === "string" ? input.pattern : "";
    if (pattern) {
      return (
        <span className="text-[11px] px-2 py-1 rounded-md bg-cc-code-bg/50 text-cc-fg/80 font-mono-code truncate max-w-[300px]" title={pattern}>
          {pattern}
        </span>
      );
    }
  }

  // Grep has a pattern
  if (toolName === "Grep") {
    const pattern = typeof input.pattern === "string" ? input.pattern : "";
    if (pattern) {
      return (
        <span className="text-[11px] px-2 py-1 rounded-md bg-cc-code-bg/50 text-cc-fg/80 font-mono-code truncate max-w-[300px]" title={pattern}>
          {pattern}
        </span>
      );
    }
  }

  return null;
}

function ToolInputDisplay({
  toolName,
  input,
  description,
}: {
  toolName: string;
  input: Record<string, unknown>;
  description?: string;
}) {
  if (toolName === "Bash") {
    return <BashDisplay input={input} />;
  }
  if (toolName === "Edit") {
    return <EditDisplay input={input} />;
  }
  if (toolName === "Write") {
    return <WriteDisplay input={input} />;
  }
  if (toolName === "Read") {
    return <ReadDisplay input={input} />;
  }
  if (toolName === "Glob") {
    return <GlobDisplay input={input} />;
  }
  if (toolName === "Grep") {
    return <GrepDisplay input={input} />;
  }
  if (toolName === "ExitPlanMode") {
    return <ExitPlanModeDisplay input={input} />;
  }

  // Fallback: formatted key-value display
  return <GenericDisplay input={input} description={description} />;
}

function BashDisplay({ input }: { input: Record<string, unknown> }) {
  const command = typeof input.command === "string" ? input.command : "";
  const desc = typeof input.description === "string" ? input.description : "";

  return (
    <div className="space-y-1.5">
      {desc && <div className="text-xs text-cc-muted">{desc}</div>}
      <pre className="text-xs text-cc-fg font-mono-code bg-cc-code-bg/30 rounded-lg px-2 sm:px-3 py-2 max-h-32 overflow-y-auto overflow-x-auto whitespace-pre-wrap break-words">
        <span className="text-cc-muted select-none">$ </span>{command}
      </pre>
    </div>
  );
}

// AskUserQuestionDisplay was extracted to its own file so that ToolBlock can
// re-use the same UI when AskUserQuestion appears as a regular tool_use in
// the assistant stream (stdio-mode path, where the CLI never invokes the
// can_use_tool gate). See AskUserQuestionDisplay.tsx.

function EditDisplay({ input }: { input: Record<string, unknown> }) {
  const filePath = String(input.file_path || "");
  const oldStr = String(input.old_string || "");
  const newStr = String(input.new_string || "");

  return (
    <DiffViewer
      oldText={oldStr}
      newText={newStr}
      fileName={filePath}
      mode="compact"
    />
  );
}

function WriteDisplay({ input }: { input: Record<string, unknown> }) {
  const filePath = String(input.file_path || "");
  const content = String(input.content || "");

  return (
    <DiffViewer
      newText={content}
      fileName={filePath}
      mode="compact"
    />
  );
}

function ReadDisplay({ input }: { input: Record<string, unknown> }) {
  const filePath = String(input.file_path || "");
  return (
    <div className="text-xs text-cc-muted font-mono-code bg-cc-code-bg/30 rounded-lg px-3 py-2">
      {filePath}
    </div>
  );
}

function GlobDisplay({ input }: { input: Record<string, unknown> }) {
  const pattern = typeof input.pattern === "string" ? input.pattern : "";
  const path = typeof input.path === "string" ? input.path : "";
  return (
    <div className="text-xs font-mono-code bg-cc-code-bg/30 rounded-lg px-3 py-2 space-y-0.5">
      <div className="text-cc-fg">{pattern}</div>
      {path && <div className="text-cc-muted">{path}</div>}
    </div>
  );
}

function GrepDisplay({ input }: { input: Record<string, unknown> }) {
  const pattern = typeof input.pattern === "string" ? input.pattern : "";
  const path = typeof input.path === "string" ? input.path : "";
  const glob = typeof input.glob === "string" ? input.glob : "";
  return (
    <div className="text-xs font-mono-code bg-cc-code-bg/30 rounded-lg px-3 py-2 space-y-0.5">
      <div className="text-cc-fg">{pattern}</div>
      {path && <div className="text-cc-muted">{path}</div>}
      {glob && <div className="text-cc-muted">{glob}</div>}
    </div>
  );
}

// ExitPlanModeDisplay was extracted to its own file so ToolBlock can re-use
// the same plan-card layout when the tool appears as a regular tool_use in
// the assistant stream (bypass-mode path; CLI auto-approves the plan-mode
// transition without firing can_use_tool). See ExitPlanModeDisplay.tsx.

function GenericDisplay({
  input,
  description,
}: {
  input: Record<string, unknown>;
  description?: string;
}) {
  const entries = Object.entries(input).filter(
    ([, v]) => v !== undefined && v !== null && v !== "",
  );

  if (entries.length === 0 && description) {
    return <div className="text-xs text-cc-fg">{description}</div>;
  }

  return (
    <div className="space-y-1">
      {description && <div className="text-xs text-cc-muted mb-1">{description}</div>}
      <div className="bg-cc-code-bg/30 rounded-lg px-3 py-2 space-y-1 max-h-[50vh] overflow-y-auto">
        {entries.map(([key, value]) => {
          const displayValue = typeof value === "string"
            ? value
            : JSON.stringify(value, null, 2);
          return (
            <div key={key} className="text-[11px] font-mono-code">
              <span className="text-cc-muted">{key}:</span>
              <pre className="text-cc-fg whitespace-pre-wrap break-words mt-0.5">{displayValue}</pre>
            </div>
          );
        })}
      </div>
    </div>
  );
}
