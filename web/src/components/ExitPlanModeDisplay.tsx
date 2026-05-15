import { type ComponentProps } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Renders the plan content of an ExitPlanMode tool call as a card.
 *
 * Used in two places:
 *   1. PermissionBanner — when can_use_tool gates ExitPlanMode (i.e. user
 *      is in plan mode, not bypass).
 *   2. ToolBlock (ExitPlanModeToolBlock wrapper) — when ExitPlanMode shows
 *      up directly as `tool_use` in the assistant stream (the bypass case;
 *      CLI auto-approves the transition out of plan mode without firing
 *      can_use_tool, so the user never sees a permission banner).
 *
 * No interactive Approve/Deny here on purpose. By the time companion
 * renders the tool_use block, the CLI has already moved on — we can't
 * un-exit plan mode after the fact. If the user is in non-bypass mode
 * the PermissionBanner path provides those buttons; in bypass mode the
 * Stop button on the composer is the rollback escape hatch.
 */
export function ExitPlanModeDisplay({ input }: { input: Record<string, unknown> }) {
  const plan = typeof input.plan === "string" ? input.plan : "";
  const allowedPrompts = Array.isArray(input.allowedPrompts) ? input.allowedPrompts : [];

  return (
    <div className="space-y-2">
      {plan && (
        <div className="rounded-xl border border-cc-border overflow-hidden bg-cc-card">
          <div className="px-3 py-2 border-b border-cc-border bg-cc-primary/[0.04] flex items-center gap-2">
            <span className="inline-flex items-center justify-center w-5 h-5 rounded bg-cc-primary/15 text-cc-primary shrink-0">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3 h-3">
                <path d="M3 3.5h10M3 8h10M3 12.5h6" strokeLinecap="round" />
              </svg>
            </span>
            <span className="text-[11px] text-cc-primary font-semibold tracking-wide uppercase">Plan</span>
          </div>
          <div className="px-3 py-3 max-h-[50vh] overflow-y-auto markdown-body text-[13px] text-cc-fg leading-relaxed">
            <Markdown
              remarkPlugins={[remarkGfm]}
              components={{
                h1: ({ children }) => <h1 className="text-base font-semibold text-cc-fg mb-2">{children}</h1>,
                h2: ({ children }) => <h2 className="text-sm font-semibold text-cc-fg mb-1.5 mt-3 first:mt-0">{children}</h2>,
                h3: ({ children }) => <h3 className="text-sm font-medium text-cc-fg mb-1.5 mt-2">{children}</h3>,
                p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                ul: ({ children }) => <ul className="list-disc pl-4 mb-2 space-y-0.5">{children}</ul>,
                ol: ({ children }) => <ol className="list-decimal pl-4 mb-2 space-y-0.5">{children}</ol>,
                li: ({ children }) => <li>{children}</li>,
                strong: ({ children }) => <strong className="font-semibold text-cc-fg">{children}</strong>,
                a: ({ href, children }) => (
                  <a href={href} target="_blank" rel="noopener noreferrer" className="text-cc-primary hover:underline">{children}</a>
                ),
                code: (props: ComponentProps<"code">) => {
                  const { children, className } = props;
                  const match = /language-(\w+)/.exec(className || "");
                  const isBlock = match || (typeof children === "string" && children.includes("\n"));

                  if (isBlock) {
                    return (
                      <pre className="my-2 px-2.5 py-2 rounded-lg bg-cc-code-bg text-cc-code-fg text-[12px] font-mono-code leading-relaxed overflow-x-auto border border-cc-border">
                        <code>{children}</code>
                      </pre>
                    );
                  }

                  return (
                    <code className="px-1.5 py-0.5 rounded-md bg-cc-fg/[0.06] text-cc-code-fg font-mono-code text-[12px]">
                      {children}
                    </code>
                  );
                },
                pre: ({ children }) => <>{children}</>,
                blockquote: ({ children }) => (
                  <blockquote className="border-l-2 border-cc-primary/40 pl-2 text-cc-muted italic my-2">{children}</blockquote>
                ),
              }}
            >
              {plan}
            </Markdown>
          </div>
        </div>
      )}
      {allowedPrompts.length > 0 && (
        <div className="space-y-1">
          <div className="text-[10px] text-cc-muted uppercase tracking-wider">Requested permissions</div>
          <div className="space-y-1">
            {allowedPrompts.map((p: Record<string, unknown>, i: number) => (
              <div key={i} className="flex items-center gap-2 text-[11px] font-mono-code bg-cc-code-bg/30 rounded-lg px-2.5 py-1.5">
                <span className="text-cc-muted shrink-0">{String(p.tool || "")}</span>
                <span className="text-cc-fg">{String(p.prompt || "")}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {!plan && allowedPrompts.length === 0 && (
        <div className="text-xs text-cc-muted">Plan approval requested</div>
      )}
    </div>
  );
}
