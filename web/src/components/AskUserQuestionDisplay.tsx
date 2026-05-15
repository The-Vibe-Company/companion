import { useState } from "react";

/**
 * Renders Claude's AskUserQuestion tool input as a clickable, multi-question
 * survey. Used by both:
 *   1. PermissionBanner — when the tool flows through the can_use_tool
 *      permission gate (legacy --sdk-url protocol path).
 *   2. ToolBlock (AskUserQuestionToolBlock wrapper) — when the tool appears
 *      as a regular `tool_use` in the assistant message stream (the
 *      stdio-mode path; CLI doesn't gate it).
 *
 * The component is purely presentational: parent decides what to do with
 * `onSelect(answers)`. Permission path translates it to a permission_response;
 * tool-use path translates it to a user_message.
 */
export function AskUserQuestionDisplay({
  input,
  onSelect,
  disabled,
}: {
  input: Record<string, unknown>;
  onSelect: (answers: Record<string, string>) => void;
  disabled: boolean;
}) {
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [customText, setCustomText] = useState<Record<string, string>>({});
  const [showCustom, setShowCustom] = useState<Record<string, boolean>>({});

  function handleOptionClick(questionIdx: number, label: string) {
    const key = String(questionIdx);
    setSelections((prev) => ({ ...prev, [key]: label }));
    setShowCustom((prev) => ({ ...prev, [key]: false }));

    // Auto-submit if single question
    if (questions.length <= 1) {
      onSelect({ [key]: label });
    }
  }

  function handleCustomSubmit(questionIdx: number) {
    const key = String(questionIdx);
    const text = customText[key]?.trim();
    if (!text) return;
    setSelections((prev) => ({ ...prev, [key]: text }));

    if (questions.length <= 1) {
      onSelect({ [key]: text });
    }
  }

  function handleCustomChange(questionIdx: number, value: string) {
    const key = String(questionIdx);
    setCustomText((prev) => ({ ...prev, [key]: value }));
    const trimmed = value.trim();
    setSelections((prev) => {
      if (!trimmed) {
        const next = { ...prev };
        delete next[key];
        return next;
      }
      return { ...prev, [key]: trimmed };
    });
  }

  function handleCustomToggle(questionIdx: number) {
    const key = String(questionIdx);
    setShowCustom((prev) => {
      const wasOpen = Boolean(prev[key]);
      const next = { ...prev, [key]: !wasOpen };
      if (wasOpen) {
        setSelections((s) => {
          const cleared = { ...s };
          delete cleared[key];
          return cleared;
        });
        setCustomText((t) => {
          const cleared = { ...t };
          delete cleared[key];
          return cleared;
        });
      }
      return next;
    });
  }

  function handleSubmitAll() {
    onSelect(selections);
  }

  if (questions.length === 0) {
    // Fallback for simple question string
    const question = typeof input.question === "string" ? input.question : "";
    if (question) {
      return (
        <div className="text-sm text-cc-fg bg-cc-code-bg/30 rounded-lg px-3 py-2">
          {question}
        </div>
      );
    }
    return (
      <pre className="text-xs text-cc-muted overflow-x-auto bg-cc-code-bg/30 rounded-lg px-3 py-2">
        {JSON.stringify(input, null, 2)}
      </pre>
    );
  }

  return (
    <div className="space-y-3">
      {questions.map((q: Record<string, unknown>, i: number) => {
        const header = typeof q.header === "string" ? q.header : "";
        const text = typeof q.question === "string" ? q.question : "";
        const options = Array.isArray(q.options) ? q.options : [];
        const key = String(i);
        const selected = selections[key];
        const isCustom = showCustom[key];

        return (
          <div key={i} className="space-y-2">
            {header && (
              <span className="inline-block text-[10px] font-semibold text-cc-primary bg-cc-primary/10 px-1.5 py-0.5 rounded">
                {header}
              </span>
            )}
            {text && (
              <p className="text-sm text-cc-fg leading-relaxed">{text}</p>
            )}
            {options.length > 0 && (
              <div className="space-y-1.5">
                {options.map((opt: Record<string, unknown>, j: number) => {
                  const label = typeof opt.label === "string" ? opt.label : String(opt);
                  const desc = typeof opt.description === "string" ? opt.description : "";
                  const isSelected = selected === label;

                  return (
                    <button
                      key={j}
                      onClick={() => handleOptionClick(i, label)}
                      disabled={disabled}
                      className={`w-full text-left px-3 py-2 rounded-lg border transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
                        isSelected
                          ? "border-cc-primary bg-cc-primary/10 ring-1 ring-cc-primary/30"
                          : "border-cc-border bg-cc-hover/50 hover:bg-cc-hover hover:border-cc-primary/30"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${
                          isSelected ? "border-cc-primary" : "border-cc-muted/40"
                        }`}>
                          {isSelected && <span className="w-2 h-2 rounded-full bg-cc-primary" />}
                        </span>
                        <div>
                          <span className="text-xs font-medium text-cc-fg">{label}</span>
                          {desc && <p className="text-[11px] text-cc-muted mt-0.5 leading-snug">{desc}</p>}
                        </div>
                      </div>
                    </button>
                  );
                })}

                {/* "Other" option */}
                <button
                  onClick={() => handleCustomToggle(i)}
                  disabled={disabled}
                  className={`w-full text-left px-3 py-2 rounded-lg border transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
                    isCustom
                      ? "border-cc-primary bg-cc-primary/10 ring-1 ring-cc-primary/30"
                      : "border-cc-border bg-cc-hover/50 hover:bg-cc-hover hover:border-cc-primary/30"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${
                      isCustom ? "border-cc-primary" : "border-cc-muted/40"
                    }`}>
                      {isCustom && <span className="w-2 h-2 rounded-full bg-cc-primary" />}
                    </span>
                    <span className="text-xs font-medium text-cc-muted">Other...</span>
                  </div>
                </button>

                {isCustom && (
                  <div className="pl-6">
                    <input
                      type="text"
                      value={customText[key] || ""}
                      onChange={(e) => handleCustomChange(i, e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) handleCustomSubmit(i); }}
                      placeholder="Type your answer..."
                      className="w-full px-2.5 py-1.5 text-xs bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/50"
                      autoFocus
                    />
                    {questions.length <= 1 && (
                      <p className="mt-1 text-[10px] text-cc-muted">Press Enter to submit</p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}

      {/* Submit all for multi-question */}
      {questions.length > 1 && Object.keys(selections).length > 0 && (
        <button
          onClick={handleSubmitAll}
          disabled={disabled}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-lg bg-cc-primary hover:bg-cc-primary-hover text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
        >
          Submit answers
        </button>
      )}
    </div>
  );
}

/**
 * Format the user's answers as a single-line-ish user_message that the model
 * can parse. Keeps the question header alongside the chosen label so the
 * model can disambiguate when there are multiple questions in one tool call.
 *
 * Single question → just the label ("共享 Postgres").
 * Multi-question → labelled bullets so the mapping stays unambiguous.
 */
export function formatAskUserAnswers(
  input: Record<string, unknown>,
  answers: Record<string, string>,
): string {
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const ordered = Object.keys(answers).sort((a, b) => Number(a) - Number(b));
  if (questions.length <= 1 && ordered.length === 1) {
    return answers[ordered[0]];
  }
  const lines: string[] = [];
  for (const k of ordered) {
    const idx = Number(k);
    const q = questions[idx] as Record<string, unknown> | undefined;
    const header = (q && typeof q.header === "string" && q.header) || `Q${idx + 1}`;
    lines.push(`- ${header}: ${answers[k]}`);
  }
  return lines.join("\n");
}
