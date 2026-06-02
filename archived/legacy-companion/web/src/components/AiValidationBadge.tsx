import type { PermissionRequest } from "../types.js";

interface AiValidationBadgeProps {
  entry: {
    request: PermissionRequest;
    behavior: "allow" | "deny";
    reason: string;
    timestamp: number;
  };
  onDismiss?: () => void;
}

/** Compact inline notification for AI auto-resolved permissions. */
export function AiValidationBadge({ entry, onDismiss }: AiValidationBadgeProps) {
  const { request, behavior, reason } = entry;
  const isAllow = behavior === "allow";

  // Build a short description of what was auto-resolved
  let toolDesc = request.tool_name;
  if (request.tool_name === "Bash" && typeof request.input.command === "string") {
    const cmd = request.input.command;
    toolDesc = cmd.length > 60 ? cmd.slice(0, 60) + "..." : cmd;
  } else if ((request.tool_name === "Read" || request.tool_name === "Write" || request.tool_name === "Edit") && typeof request.input.file_path === "string") {
    toolDesc = `${request.tool_name} ${request.input.file_path}`;
  } else if (request.tool_name === "Glob" && typeof request.input.pattern === "string") {
    toolDesc = `Glob ${request.input.pattern}`;
  } else if (request.tool_name === "Grep" && typeof request.input.pattern === "string") {
    toolDesc = `Grep ${request.input.pattern}`;
  }

  return (
    <div className={`flex items-center gap-2 px-3 py-1.5 text-[11px] ${
      isAllow ? "text-cc-success" : "text-cc-error"
    }`}>
      {/* Shield icon */}
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 shrink-0 opacity-70">
        <path fillRule="evenodd" d="M8 1.246l.542.228c1.926.812 3.732.95 5.408.435l.61-.187v6.528a5.75 5.75 0 01-2.863 4.973L8 15.5l-3.697-2.277A5.75 5.75 0 011.44 8.25V1.722l.61.187c1.676.515 3.482.377 5.408-.435L8 1.246z" clipRule="evenodd" />
      </svg>
      <span className="flex-1">
        AI auto-{isAllow ? "approved" : "denied"}:
        {" "}
        <span className="font-mono-code opacity-80">{toolDesc}</span>
        {reason && (
          <span className="text-cc-muted ml-1">({reason})</span>
        )}
      </span>
      {onDismiss && (
        <button
          onClick={onDismiss}
          className="opacity-50 hover:opacity-100 transition-opacity cursor-pointer flex-shrink-0"
          aria-label="Dismiss notification"
        >
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
            <path d="M4.646 4.646a.5.5 0 01.708 0L8 7.293l2.646-2.647a.5.5 0 01.708.708L8.707 8l2.647 2.646a.5.5 0 01-.708.708L8 8.707l-2.646 2.647a.5.5 0 01-.708-.708L7.293 8 4.646 5.354a.5.5 0 010-.708z" />
          </svg>
        </button>
      )}
    </div>
  );
}
