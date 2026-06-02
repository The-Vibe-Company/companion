import { useState, useMemo, type ComponentProps } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage, ContentBlock } from "../types.js";
import { ToolBlock, getToolIcon, getToolLabel, getPreview, ToolIcon } from "./ToolBlock.js";

export function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === "system") {
    return (
      <div className="flex items-center gap-3 py-1 min-w-0">
        <div className="shrink-0 flex-1 h-px bg-cc-border" />
        <span className="text-[11px] text-cc-muted italic font-mono-code px-1 min-w-0 break-words text-center">
          {message.content}
        </span>
        <div className="shrink-0 flex-1 h-px bg-cc-border" />
      </div>
    );
  }

  if (message.role === "user") {
    return (
      <div className="flex justify-end animate-[userSlideIn_0.3s_ease-out]">
        <div className="max-w-[85%] sm:max-w-[80%] px-3.5 sm:px-4 py-2.5 rounded-[16px] rounded-br-[6px] user-bubble-gradient text-cc-fg shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
          {message.images && message.images.length > 0 && (
            <div className="flex gap-2 flex-wrap mb-2">
              {message.images.map((img, i) => (
                <img
                  key={i}
                  src={`data:${img.media_type};base64,${img.data}`}
                  alt="attachment"
                  className="max-w-[150px] sm:max-w-[200px] max-h-[120px] sm:max-h-[150px] rounded-xl object-cover border border-cc-border/30"
                />
              ))}
            </div>
          )}
          <div className="text-[13px] sm:text-[14px] leading-relaxed break-words">
            <MarkdownContent text={message.content} />
          </div>
        </div>
      </div>
    );
  }

  // Assistant message
  return (
    <div className="animate-[fadeSlideIn_0.3s_ease-out]">
      <AssistantMessage message={message} />
    </div>
  );
}

interface ToolGroupItem {
  id: string;
  name: string;
  input: Record<string, unknown>;
}
interface ToolUseInfo {
  name: string;
  input: Record<string, unknown>;
}

type GroupedBlock =
  | { kind: "content"; block: ContentBlock }
  | { kind: "tool_group"; name: string; items: ToolGroupItem[] };

function groupContentBlocks(blocks: ContentBlock[]): GroupedBlock[] {
  const groups: GroupedBlock[] = [];

  for (const block of blocks) {
    if (block.type === "tool_use") {
      const last = groups[groups.length - 1];
      if (last?.kind === "tool_group" && last.name === block.name) {
        last.items.push({ id: block.id, name: block.name, input: block.input });
      } else {
        groups.push({
          kind: "tool_group",
          name: block.name,
          items: [{ id: block.id, name: block.name, input: block.input }],
        });
      }
    } else {
      groups.push({ kind: "content", block });
    }
  }

  return groups;
}

function mapToolUsesById(blocks: ContentBlock[]): Map<string, ToolUseInfo> {
  const map = new Map<string, ToolUseInfo>();
  for (const block of blocks) {
    if (block.type === "tool_use") {
      map.set(block.id, { name: block.name, input: block.input });
    }
  }
  return map;
}

function AssistantMessage({ message }: { message: ChatMessage }) {
  const blocks = message.contentBlocks || [];

  const grouped = useMemo(() => groupContentBlocks(blocks), [blocks]);
  const toolUseById = useMemo(() => mapToolUsesById(blocks), [blocks]);

  if (blocks.length === 0 && message.content) {
    // During streaming thinking phase, render as faded italic inline text
    const isThinkingPhase = message.isStreaming && message.streamingPhase === "thinking";
    return (
      <div className="flex items-start gap-3">
        <AssistantAvatar />
        <div className="flex-1 min-w-0">
          {isThinkingPhase ? (
            <ThinkingBlock text={message.content} />
          ) : (
            <MarkdownContent text={message.content} showCursor={!!message.isStreaming} />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-3">
      <AssistantAvatar />
      <div className="flex-1 min-w-0 space-y-3">
        {grouped.map((group, i) => {
          if (group.kind === "content") {
            return <ContentBlockRenderer key={i} block={group.block} toolUseById={toolUseById} />;
          }
          // Single tool_use renders as before
          if (group.items.length === 1) {
            const item = group.items[0];
            return <ToolBlock key={i} name={item.name} input={item.input} toolUseId={item.id} />;
          }
          // Grouped tool_uses
          return <ToolGroupBlock key={i} name={group.name} items={group.items} />;
        })}
      </div>
    </div>
  );
}

function AssistantAvatar() {
  return (
    <div className="w-6 h-6 rounded-full avatar-ring flex items-center justify-center shrink-0 mt-0.5">
      <div className="avatar-inner w-full h-full rounded-full flex items-center justify-center">
        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 text-cc-primary">
          <path d="M8 2L10.5 6.5L15 8L10.5 9.5L8 14L5.5 9.5L1 8L5.5 6.5L8 2Z" />
        </svg>
      </div>
    </div>
  );
}

function MarkdownContent({ text, showCursor = false }: { text: string; showCursor?: boolean }) {
  return (
    <div className="markdown-body text-[14px] sm:text-[15px] text-cc-fg leading-relaxed overflow-hidden">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => (
            <p className="mb-3 last:mb-0">{children}</p>
          ),
          strong: ({ children }) => (
            <strong className="font-semibold text-cc-fg">{children}</strong>
          ),
          em: ({ children }) => (
            <em className="italic">{children}</em>
          ),
          h1: ({ children }) => (
            <h1 className="text-xl font-bold text-cc-fg mt-4 mb-2">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-lg font-bold text-cc-fg mt-3 mb-2">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-base font-semibold text-cc-fg mt-3 mb-1">{children}</h3>
          ),
          ul: ({ children }) => (
            <ul className="list-disc pl-5 mb-3 space-y-1">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal pl-5 mb-3 space-y-1">{children}</ol>
          ),
          li: ({ children }) => (
            <li className="text-cc-fg">{children}</li>
          ),
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer" className="text-cc-primary hover:underline">
              {children}
            </a>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-cc-primary/30 pl-3 my-2 text-cc-muted italic">
              {children}
            </blockquote>
          ),
          hr: () => (
            <hr className="border-cc-border my-4" />
          ),
          code: (props: ComponentProps<"code">) => {
            const { children, className } = props;
            const match = /language-(\w+)/.exec(className || "");
            const isBlock = match || (typeof children === "string" && children.includes("\n"));

            if (isBlock) {
              const lang = match?.[1] || "";
              return (
                <div className="my-2.5 rounded-xl overflow-hidden border border-cc-border shadow-[0_2px_8px_rgba(0,0,0,0.04)]">
                  {lang && (
                    <div className="px-3 py-1.5 bg-cc-code-bg border-b border-cc-border flex items-center gap-2">
                      <div className="flex gap-1">
                        <span className="w-2 h-2 rounded-full bg-cc-muted/20" />
                        <span className="w-2 h-2 rounded-full bg-cc-muted/20" />
                        <span className="w-2 h-2 rounded-full bg-cc-muted/20" />
                      </div>
                      <span className="text-[10px] text-cc-muted/70 font-mono-code uppercase tracking-wider">
                        {lang}
                      </span>
                    </div>
                  )}
                  <pre className="px-3 sm:px-4 py-2.5 sm:py-3 bg-cc-code-bg text-cc-code-fg text-[12px] sm:text-[13px] font-mono-code leading-relaxed overflow-x-auto">
                    <code>{children}</code>
                  </pre>
                </div>
              );
            }

            return (
              <code className="px-1.5 py-0.5 rounded-md bg-cc-fg/[0.06] text-[12.5px] font-mono-code text-cc-fg/80 border border-cc-border/40">
                {children}
              </code>
            );
          },
          pre: ({ children }) => <>{children}</>,
          table: ({ children }) => (
            <div className="overflow-x-auto my-2">
              <table className="min-w-full text-sm border border-cc-border rounded-lg overflow-hidden">
                {children}
              </table>
            </div>
          ),
          thead: ({ children }) => (
            <thead className="bg-cc-code-bg/50">{children}</thead>
          ),
          th: ({ children }) => (
            <th className="px-3 py-1.5 text-left text-xs font-semibold text-cc-fg border-b border-cc-border">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="px-3 py-1.5 text-xs text-cc-fg border-b border-cc-border">
              {children}
            </td>
          ),
        }}
      >
        {text}
      </Markdown>
      {showCursor && (
        <span
          data-testid="assistant-stream-cursor"
          className="inline-block w-[3px] h-[18px] bg-cc-primary rounded-full ml-0.5 align-middle animate-[pulse-dot_1s_ease-in-out_infinite]"
        />
      )}
    </div>
  );
}

function ContentBlockRenderer({
  block,
  toolUseById,
}: {
  block: ContentBlock;
  toolUseById: Map<string, ToolUseInfo>;
}) {
  if (block.type === "text") {
    return <MarkdownContent text={block.text} />;
  }

  if (block.type === "thinking") {
    return <ThinkingBlock text={block.thinking} />;
  }

  if (block.type === "tool_use") {
    return <ToolBlock name={block.name} input={block.input} toolUseId={block.id} />;
  }

  if (block.type === "tool_result") {
    const content = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
    const linkedTool = toolUseById.get(block.tool_use_id);
    const toolName = linkedTool?.name;
    const isError = block.is_error ?? false;
    if (toolName === "Bash") {
      return <BashResultBlock text={content} isError={isError} />;
    }
    return (
      <div className="rounded-lg bg-cc-code-bg overflow-hidden">
        <pre className={`text-[12px] font-mono-code px-3 py-2 whitespace-pre-wrap leading-relaxed max-h-60 overflow-y-auto ${
          isError ? "text-cc-error" : "text-cc-code-fg/60"
        }`}>
          {content}
        </pre>
      </div>
    );
  }

  return null;
}

function BashResultBlock({ text, isError }: { text: string; isError: boolean }) {
  const lines = text.split(/\r?\n/);
  const hasMore = lines.length > 20;
  const [showFull, setShowFull] = useState(false);
  const rendered = showFull || !hasMore ? text : lines.slice(-20).join("\n");

  return (
    <div className="rounded-lg bg-cc-code-bg overflow-hidden">
      <pre className={`text-[12px] font-mono-code px-3 py-2 whitespace-pre-wrap leading-relaxed ${
        isError ? "text-cc-error" : "text-cc-code-fg/60"
      }`}>
        {rendered}
      </pre>
      {hasMore && (
        <div className="px-3 pb-1.5 flex items-center justify-between">
          <span className={`text-[10px] ${isError ? "text-cc-error/50" : "text-cc-muted/40"}`}>
            {showFull ? `${lines.length} lines` : `last 20 of ${lines.length}`}
          </span>
          <button
            onClick={() => setShowFull(!showFull)}
            className="text-[10px] text-cc-muted/40 hover:text-cc-muted/70 transition-colors cursor-pointer"
          >
            {showFull ? "Show tail" : "Show all"}
          </button>
        </div>
      )}
    </div>
  );
}

function ToolGroupBlock({ name, items }: { name: string; items: ToolGroupItem[] }) {
  const [open, setOpen] = useState(false);
  const iconType = getToolIcon(name);
  const label = getToolLabel(name);

  return (
    <div className="border border-cc-border rounded-[10px] overflow-hidden bg-cc-card tool-card">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-cc-hover transition-colors cursor-pointer"
      >
        <svg
          viewBox="0 0 16 16"
          fill="currentColor"
          className={`w-3 h-3 text-cc-muted transition-transform shrink-0 ${open ? "rotate-90" : ""}`}
        >
          <path d="M6 4l4 4-4 4" />
        </svg>
        <ToolIcon type={iconType} />
        <span className="text-xs font-medium text-cc-fg">{label}</span>
        <span className="text-[10px] text-cc-muted bg-cc-hover rounded-full px-1.5 py-0.5 tabular-nums">
          {items.length}
        </span>
      </button>

      {open && (
        <div className="border-t border-cc-border px-3 py-1.5">
          {items.map((item, i) => {
            const preview = getPreview(item.name, item.input);
            return (
              <div key={item.id || i} className="flex items-center gap-2 py-1 text-xs text-cc-muted font-mono-code truncate">
                <span className="w-1 h-1 rounded-full bg-cc-muted/40 shrink-0" />
                <span className="truncate">{preview || JSON.stringify(item.input).slice(0, 80)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ThinkingBlock({ text }: { text: string }) {
  const normalized = text.trim();
  const [expanded, setExpanded] = useState(false);
  const lines = normalized.split("\n");
  const isLong = lines.length > 8 || normalized.length > 600;
  const displayed = isLong && !expanded
    ? lines.slice(0, 8).join("\n")
    : normalized;

  return (
    <div>
      <div className="markdown-body text-[13px] text-cc-fg/40 leading-relaxed italic">
        <Markdown
          remarkPlugins={[remarkGfm]}
          components={{
            p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
            ul: ({ children }) => <ul className="list-disc pl-4 mb-2 space-y-0.5">{children}</ul>,
            ol: ({ children }) => <ol className="list-decimal pl-4 mb-2 space-y-0.5">{children}</ol>,
            li: ({ children }) => <li>{children}</li>,
            code: ({ children }) => (
              <code className="px-1 py-0.5 rounded bg-cc-fg/[0.03] text-cc-fg/40 font-mono-code text-[12px] not-italic">
                {children}
              </code>
            ),
          }}
        >
          {displayed || "No thinking text captured."}
        </Markdown>
      </div>
      {isLong && !expanded && (
        <button
          onClick={() => setExpanded(true)}
          className="text-[11px] text-cc-muted/40 hover:text-cc-muted/70 cursor-pointer transition-colors"
        >
          Show more
        </button>
      )}
    </div>
  );
}
