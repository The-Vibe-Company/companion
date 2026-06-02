import { useState } from "react";
import { DiffViewer } from "./DiffViewer.js";

const TOOL_ICONS: Record<string, string> = {
  Bash: "terminal",
  Read: "file",
  Write: "file-plus",
  Edit: "file-edit",
  Glob: "search",
  Grep: "search",
  WebFetch: "globe",
  WebSearch: "globe",
  NotebookEdit: "notebook",
  Task: "agent",
  TodoWrite: "checklist",
  TaskCreate: "list",
  TaskUpdate: "list",
  SendMessage: "message",
  // Codex tool types (mapped by codex-adapter)
  web_search: "globe",
  mcp_tool_call: "tool",
};

export function getToolIcon(name: string): string {
  return TOOL_ICONS[name] || "tool";
}

export function getToolLabel(name: string): string {
  if (name === "Bash") return "Terminal";
  if (name === "Read") return "Read File";
  if (name === "Write") return "Write File";
  if (name === "Edit") return "Edit File";
  if (name === "Glob") return "Find Files";
  if (name === "Grep") return "Search Content";
  if (name === "WebSearch") return "Web Search";
  if (name === "WebFetch") return "Web Fetch";
  if (name === "Task") return "Subagent";
  if (name === "TodoWrite") return "Tasks";
  if (name === "NotebookEdit") return "Notebook";
  if (name === "SendMessage") return "Message";
  if (name === "web_search") return "Web Search";
  if (name === "mcp_tool_call") return "MCP Tool";
  // Codex MCP tools come as "mcp:server:tool"
  if (name.startsWith("mcp:")) return name.split(":").slice(1).join(":");
  return name;
}

export function ToolBlock({
  name,
  input,
  toolUseId,
}: {
  name: string;
  input: Record<string, unknown>;
  toolUseId: string;
}) {
  // Edit tool opens by default so users can see the diff
  const [open, setOpen] = useState(name === "Edit");
  const iconType = getToolIcon(name);
  const label = getToolLabel(name);

  // Extract the most useful preview
  const preview = getPreview(name, input);

  // Edit gets a special borderless treatment — visual identity without a card
  if (name === "Edit") {
    return <EditBlock input={input} toolUseId={toolUseId} />;
  }

  // Bash gets a terminal-style borderless treatment
  if (name === "Bash") {
    return <BashBlock input={input} toolUseId={toolUseId} />;
  }

  return (
    <div
      className="border border-cc-border rounded-[10px] overflow-hidden bg-cc-card tool-card"
      data-tool-use-id={toolUseId}
    >
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-cc-hover transition-colors cursor-pointer"
      >
        <svg
          viewBox="0 0 16 16"
          fill="currentColor"
          className={`w-3 h-3 text-cc-muted transition-transform duration-200 shrink-0 ${open ? "rotate-90" : ""}`}
        >
          <path d="M6 4l4 4-4 4" />
        </svg>
        <ToolIcon type={iconType} />
        <span className="text-xs font-medium text-cc-fg">{label}</span>
        {preview && (
          <span className="text-xs text-cc-muted truncate flex-1 font-mono-code">
            {preview}
          </span>
        )}
      </button>

      {open && (
        <div className="px-3 pb-3 pt-0 border-t border-cc-border/60">
          <div className="mt-2">
            <ToolDetail name={name} input={input} />
          </div>
        </div>
      )}
    </div>
  );
}

/** Edit tool — inline diff, no card, no scroll, "show more" for long diffs */
function EditBlock({ input, toolUseId }: { input: Record<string, unknown>; toolUseId: string }) {
  const filePath = String(input.file_path || "");
  const fileName = filePath ? filePath.split("/").pop() || filePath : "";
  const oldStr = String(input.old_string || "");
  const newStr = String(input.new_string || "");
  const hasDiff = Boolean(oldStr || newStr);
  const replaceAll = Boolean(input.replace_all);
  const [expanded, setExpanded] = useState(false);
  const rawChanges = Array.isArray(input.changes)
    ? input.changes as Array<{ path?: unknown; kind?: unknown }>
    : [];
  const changes = rawChanges
    .map((c) => ({
      path: typeof c.path === "string" ? c.path : "",
      kind: typeof c.kind === "string" ? c.kind : "update",
    }))
    .filter((c) => c.path);

  // Estimate if content is tall enough to need truncation
  const diffLineCount = (oldStr + newStr).split("\n").length;
  const isTall = diffLineCount > 15;

  return (
    <div data-tool-use-id={toolUseId}>
      {/* Single-line header: Edit fileName [all] */}
      <div className="flex items-center gap-1.5 py-0.5">
        <span className="text-[11px] font-medium text-emerald-600/70 dark:text-emerald-400/70">Edit</span>
        {fileName && (
          <span className="text-[11px] font-mono-code text-cc-fg/70">{fileName}</span>
        )}
        {replaceAll && (
          <span className="text-[9px] uppercase tracking-wider font-semibold text-amber-600/70 dark:text-amber-400/70">all</span>
        )}
      </div>

      {/* Diff content — always visible, no toggle */}
      {hasDiff ? (
        <div className="relative mt-1">
          <div className={`overflow-hidden ${isTall && !expanded ? "max-h-[240px]" : ""}`}>
            <DiffViewer oldText={oldStr} newText={newStr} mode="compact" />
          </div>
          {isTall && !expanded && (
            <div className="absolute bottom-0 left-0 right-0 h-10 bg-gradient-to-t from-cc-bg to-transparent pointer-events-none" />
          )}
          {isTall && (
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              className="relative z-10 mt-1 text-[11px] text-cc-muted/40 hover:text-cc-muted/70 cursor-pointer transition-colors"
            >
              {expanded ? "Show less" : `Show all ${diffLineCount} lines`}
            </button>
          )}
        </div>
      ) : changes.length > 0 ? (
        <div className="mt-1 space-y-1">
          {changes.map((change, i) => {
            const changeFile = change.path.split("/").pop() || change.path;
            return (
              <div key={`${change.path}-${i}`} className="flex items-center gap-2 text-[11px]">
                <span className={`text-[9px] font-semibold uppercase ${
                  change.kind === "create" ? "text-emerald-600/70 dark:text-emerald-400/70" :
                  change.kind === "delete" ? "text-cc-error/70" :
                  "text-amber-600/70 dark:text-amber-400/70"
                }`}>
                  {change.kind}
                </span>
                <span className="font-mono-code text-cc-fg/60 truncate">{changeFile}</span>
              </div>
            );
          })}
        </div>
      ) : (
        <pre className="mt-1 text-[11px] text-cc-muted font-mono-code whitespace-pre-wrap leading-relaxed">
          {JSON.stringify(input, null, 2)}
        </pre>
      )}
    </div>
  );
}

/** Bash tool — shows command directly, always visible */
function BashBlock({ input, toolUseId }: { input: Record<string, unknown>; toolUseId: string }) {
  const command = typeof input.command === "string" ? input.command : "";
  const desc = typeof input.description === "string" ? input.description : "";

  return (
    <div data-tool-use-id={toolUseId}>
      {desc && (
        <div className="text-[11px] text-cc-muted/50 mb-1 italic">{desc}</div>
      )}
      <div className="rounded-lg bg-cc-code-bg px-3 py-2 overflow-x-auto">
        <pre className="text-[12px] font-mono-code text-cc-code-fg leading-relaxed whitespace-pre-wrap break-words">
          <span className="text-cc-muted/40 select-none">$ </span>{command}
        </pre>
      </div>
    </div>
  );
}

/** Route to custom detail renderer per tool type */
function ToolDetail({ name, input }: { name: string; input: Record<string, unknown> }) {
  switch (name) {
    case "Bash":
      return <BashDetail input={input} />;
    case "Edit":
      return <EditToolDetail input={input} />;
    case "Write":
      return <WriteToolDetail input={input} />;
    case "Read":
      return <ReadToolDetail input={input} />;
    case "Glob":
      return <GlobDetail input={input} />;
    case "Grep":
      return <GrepDetail input={input} />;
    case "WebSearch":
    case "web_search":
      return <WebSearchDetail input={input} />;
    case "WebFetch":
      return <WebFetchDetail input={input} />;
    case "Task":
      return <TaskDetail input={input} />;
    case "TodoWrite":
      return <TodoWriteDetail input={input} />;
    case "NotebookEdit":
      return <NotebookEditDetail input={input} />;
    case "SendMessage":
      return <SendMessageDetail input={input} />;
    default:
      return (
        <pre className="text-[11px] text-cc-muted font-mono-code whitespace-pre-wrap leading-relaxed max-h-60 overflow-y-auto">
          {JSON.stringify(input, null, 2)}
        </pre>
      );
  }
}

// ─── Per-tool detail components ─────────────────────────────────────────────

function BashDetail({ input }: { input: Record<string, unknown> }) {
  return (
    <div className="space-y-1.5">
      {!!input.description && (
        <div className="text-[11px] text-cc-muted italic">{String(input.description)}</div>
      )}
      <pre className="px-3 py-2 rounded-lg bg-cc-code-bg text-cc-code-fg text-[12px] font-mono-code leading-relaxed overflow-x-auto">
        <span className="text-cc-muted select-none">$ </span>
        {String(input.command || "")}
      </pre>
      {!!input.timeout && (
        <div className="text-[10px] text-cc-muted">timeout: {String(input.timeout)}ms</div>
      )}
    </div>
  );
}

function EditToolDetail({ input }: { input: Record<string, unknown> }) {
  const filePath = String(input.file_path || "");
  const oldStr = String(input.old_string || "");
  const newStr = String(input.new_string || "");
  const rawChanges = Array.isArray(input.changes)
    ? input.changes as Array<{ path?: unknown; kind?: unknown }>
    : [];
  const changes = rawChanges
    .map((c) => ({
      path: typeof c.path === "string" ? c.path : "",
      kind: typeof c.kind === "string" ? c.kind : "update",
    }))
    .filter((c) => c.path);

  return (
    <div className="space-y-1.5">
      {!!input.replace_all && (
        <span className="inline-block text-[10px] font-medium px-1.5 py-0.5 rounded bg-cc-warning/10 text-cc-warning">
          replace all
        </span>
      )}
      {(oldStr || newStr) ? (
        <DiffViewer oldText={oldStr} newText={newStr} fileName={filePath} mode="compact" />
      ) : changes.length > 0 ? (
        <div className="space-y-1.5">
          {!!filePath && <div className="text-xs text-cc-muted font-mono-code">{filePath}</div>}
          {changes.map((change, i) => (
            <div key={`${change.path}-${i}`} className="flex items-center gap-2 text-[11px] text-cc-fg">
              <span className="inline-block text-[10px] font-medium px-1.5 py-0.5 rounded bg-cc-primary/10 text-cc-primary min-w-[54px] text-center">
                {change.kind}
              </span>
              <span className="font-mono-code truncate">{change.path}</span>
            </div>
          ))}
        </div>
      ) : (
        <pre className="text-[11px] text-cc-muted font-mono-code whitespace-pre-wrap leading-relaxed max-h-60 overflow-y-auto">
          {JSON.stringify(input, null, 2)}
        </pre>
      )}
    </div>
  );
}

function WriteToolDetail({ input }: { input: Record<string, unknown> }) {
  const filePath = String(input.file_path || "");
  const content = String(input.content || "");

  return <DiffViewer newText={content} fileName={filePath} mode="compact" />;
}

function ReadToolDetail({ input }: { input: Record<string, unknown> }) {
  const filePath = String(input.file_path || input.path || "");
  const offset = input.offset as number | undefined;
  const limit = input.limit as number | undefined;

  return (
    <div className="space-y-1">
      <div className="text-xs text-cc-muted font-mono-code">{filePath}</div>
      {(offset != null || limit != null) && (
        <div className="flex gap-2 text-[10px] text-cc-muted">
          {offset != null && <span>offset: {offset}</span>}
          {limit != null && <span>limit: {limit}</span>}
        </div>
      )}
    </div>
  );
}

function GlobDetail({ input }: { input: Record<string, unknown> }) {
  return (
    <div className="space-y-1">
      <div className="text-xs font-mono-code text-cc-code-fg">{String(input.pattern || "")}</div>
      {!!input.path && (
        <div className="text-[10px] text-cc-muted">
          in: <span className="font-mono-code">{String(input.path)}</span>
        </div>
      )}
    </div>
  );
}

function GrepDetail({ input }: { input: Record<string, unknown> }) {
  return (
    <div className="space-y-1">
      <pre className="px-2 py-1.5 rounded bg-cc-code-bg text-cc-code-fg text-[12px] font-mono-code overflow-x-auto">
        {String(input.pattern || "")}
      </pre>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-cc-muted">
        {!!input.path && (
          <span>path: <span className="font-mono-code">{String(input.path)}</span></span>
        )}
        {!!input.glob && (
          <span>glob: <span className="font-mono-code">{String(input.glob)}</span></span>
        )}
        {!!input.output_mode && <span>mode: {String(input.output_mode)}</span>}
        {!!input.context && <span>context: {String(input.context)}</span>}
        {!!input.head_limit && <span>limit: {String(input.head_limit)}</span>}
      </div>
    </div>
  );
}

function WebSearchDetail({ input }: { input: Record<string, unknown> }) {
  return (
    <div className="space-y-1">
      <div className="text-xs text-cc-fg font-medium">{String(input.query || "")}</div>
      {Array.isArray(input.allowed_domains) && input.allowed_domains.length > 0 && (
        <div className="text-[10px] text-cc-muted">
          domains: {(input.allowed_domains as string[]).join(", ")}
        </div>
      )}
    </div>
  );
}

function WebFetchDetail({ input }: { input: Record<string, unknown> }) {
  return (
    <div className="space-y-1">
      {!!input.url && (
        <div className="text-xs font-mono-code text-cc-primary truncate">{String(input.url)}</div>
      )}
      {!!input.prompt && (
        <div className="text-[11px] text-cc-muted italic line-clamp-2">{String(input.prompt)}</div>
      )}
    </div>
  );
}

function TaskDetail({ input }: { input: Record<string, unknown> }) {
  return (
    <div className="space-y-1.5">
      {!!input.description && (
        <div className="text-xs text-cc-fg font-medium">{String(input.description)}</div>
      )}
      {!!input.subagent_type && (
        <span className="inline-block text-[10px] font-medium px-1.5 py-0.5 rounded bg-cc-primary/10 text-cc-primary">
          {String(input.subagent_type)}
        </span>
      )}
      {!!input.prompt && (
        <pre className="text-[11px] text-cc-muted font-mono-code whitespace-pre-wrap leading-relaxed max-h-40 overflow-y-auto">
          {String(input.prompt)}
        </pre>
      )}
    </div>
  );
}

function TodoWriteDetail({ input }: { input: Record<string, unknown> }) {
  const todos = input.todos as Array<{ content?: string; status?: string; activeForm?: string }> | undefined;
  if (!Array.isArray(todos)) {
    return (
      <pre className="text-[11px] text-cc-muted font-mono-code whitespace-pre-wrap leading-relaxed max-h-60 overflow-y-auto">
        {JSON.stringify(input, null, 2)}
      </pre>
    );
  }

  return (
    <div className="space-y-0.5">
      {todos.map((todo, i) => {
        const status = todo.status || "pending";
        return (
          <div key={i} className="flex items-start gap-2 py-0.5">
            <span className="shrink-0 mt-0.5">
              {status === "completed" ? (
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-cc-success">
                  <path fillRule="evenodd" d="M8 15A7 7 0 108 1a7 7 0 000 14zm3.354-9.354a.5.5 0 00-.708-.708L7 8.586 5.354 6.94a.5.5 0 10-.708.708l2 2a.5.5 0 00.708 0l4-4z" clipRule="evenodd" />
                </svg>
              ) : status === "in_progress" ? (
                <svg className="w-3.5 h-3.5 text-cc-primary animate-spin" viewBox="0 0 16 16" fill="none">
                  <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" strokeDasharray="28" strokeDashoffset="8" strokeLinecap="round" />
                </svg>
              ) : (
                <svg viewBox="0 0 16 16" fill="none" className="w-3.5 h-3.5 text-cc-muted">
                  <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
                </svg>
              )}
            </span>
            <span className={`text-[11px] leading-snug ${status === "completed" ? "text-cc-muted line-through" : "text-cc-fg"}`}>
              {todo.content || "Task"}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function NotebookEditDetail({ input }: { input: Record<string, unknown> }) {
  const path = String(input.notebook_path || "");
  const cellType = input.cell_type as string | undefined;
  const editMode = input.edit_mode as string | undefined;

  return (
    <div className="space-y-1">
      <div className="text-xs font-mono-code text-cc-muted">{path}</div>
      <div className="flex gap-2 text-[10px] text-cc-muted">
        {cellType && <span>type: {cellType}</span>}
        {editMode && <span>mode: {editMode}</span>}
        {input.cell_number != null && <span>cell: {String(input.cell_number)}</span>}
      </div>
      {!!input.new_source && (
        <pre className="px-2 py-1.5 rounded bg-cc-code-bg text-cc-code-fg text-[11px] font-mono-code leading-relaxed max-h-40 overflow-y-auto">
          {String(input.new_source)}
        </pre>
      )}
    </div>
  );
}

function SendMessageDetail({ input }: { input: Record<string, unknown> }) {
  return (
    <div className="space-y-1">
      {!!input.recipient && (
        <div className="text-[11px] text-cc-muted">
          to: <span className="font-medium text-cc-fg">{String(input.recipient)}</span>
        </div>
      )}
      {!!input.content && (
        <div className="text-xs text-cc-fg whitespace-pre-wrap">{String(input.content)}</div>
      )}
    </div>
  );
}

// ─── Preview ────────────────────────────────────────────────────────────────

export function getPreview(name: string, input: Record<string, unknown>): string {
  if (name === "Bash" && typeof input.command === "string") {
    // Prefer description if short enough, otherwise show command
    if (input.description && typeof input.description === "string" && input.description.length <= 60) {
      return input.description;
    }
    return input.command.length > 60 ? input.command.slice(0, 60) + "..." : input.command;
  }
  if ((name === "Read" || name === "Write" || name === "Edit") && input.file_path) {
    const path = String(input.file_path);
    return path.split("/").slice(-2).join("/");
  }
  if (name === "Edit" && Array.isArray(input.changes) && input.changes.length > 0) {
    const first = input.changes[0] as { path?: string };
    if (first?.path) {
      return String(first.path).split("/").slice(-2).join("/");
    }
  }
  if (name === "Glob" && input.pattern) return String(input.pattern);
  if (name === "Grep" && input.pattern) {
    const p = String(input.pattern);
    const suffix = input.path ? ` in ${String(input.path).split("/").slice(-2).join("/")}` : "";
    const full = p + suffix;
    return full.length > 60 ? full.slice(0, 60) + "..." : full;
  }
  if ((name === "WebSearch" || name === "web_search") && input.query) return String(input.query);
  if (name === "WebFetch" && input.url) {
    try {
      const u = new URL(String(input.url));
      return u.hostname + u.pathname;
    } catch {
      return String(input.url).slice(0, 60);
    }
  }
  if (name === "Task" && input.description) return String(input.description);
  if (name === "TodoWrite" && Array.isArray(input.todos)) {
    return `${input.todos.length} task${input.todos.length !== 1 ? "s" : ""}`;
  }
  if (name === "NotebookEdit" && input.notebook_path) {
    return String(input.notebook_path).split("/").pop() || "";
  }
  if (name === "SendMessage" && input.recipient) {
    return `\u2192 ${String(input.recipient)}`;
  }
  return "";
}

// ─── Icons ──────────────────────────────────────────────────────────────────

export function ToolIcon({ type }: { type: string }) {
  const cls = "w-3.5 h-3.5 text-cc-primary shrink-0";

  if (type === "terminal") {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={cls}>
        <polyline points="3 11 6 8 3 5" />
        <line x1="8" y1="11" x2="13" y2="11" />
      </svg>
    );
  }
  if (type === "file" || type === "file-plus" || type === "file-edit") {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={cls}>
        <path d="M9 1H4a1 1 0 00-1 1v12a1 1 0 001 1h8a1 1 0 001-1V5L9 1z" />
        <polyline points="9 1 9 5 13 5" />
      </svg>
    );
  }
  if (type === "search") {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={cls}>
        <circle cx="7" cy="7" r="4" />
        <path d="M13 13l-3-3" />
      </svg>
    );
  }
  if (type === "globe") {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={cls}>
        <circle cx="8" cy="8" r="6" />
        <path d="M2 8h12M8 2c2 2 3 4 3 6s-1 4-3 6c-2-2-3-4-3-6s1-4 3-6z" />
      </svg>
    );
  }
  if (type === "message") {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={cls}>
        <path d="M14 10a1 1 0 01-1 1H5l-3 3V3a1 1 0 011-1h10a1 1 0 011 1v7z" />
      </svg>
    );
  }
  if (type === "list") {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={cls}>
        <path d="M3 4h10M3 8h10M3 12h6" />
      </svg>
    );
  }
  if (type === "agent") {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={cls}>
        <circle cx="8" cy="5" r="3" />
        <path d="M3 14c0-2.8 2.2-5 5-5s5 2.2 5 5" strokeLinecap="round" />
      </svg>
    );
  }
  if (type === "checklist") {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={cls}>
        <path d="M3 4l1.5 1.5L7 3M3 8l1.5 1.5L7 7M3 12l1.5 1.5L7 11" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M9 4h4M9 8h4M9 12h4" />
      </svg>
    );
  }
  if (type === "notebook") {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={cls}>
        <rect x="3" y="1" width="10" height="14" rx="1" />
        <path d="M6 1v14M3 5h3M3 9h3M3 13h3" />
      </svg>
    );
  }
  // Default tool icon
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={cls}>
      <path d="M10.5 2.5l3 3-8 8H2.5v-3l8-8z" />
    </svg>
  );
}
