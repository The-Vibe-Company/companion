/**
 * AgentHangar-injected system-prompt fragments for Claude Code in stdio mode.
 *
 * These are appended to Claude Code's default system prompt via
 * `--append-system-prompt`. We do NOT replace the default prompt — that
 * would strip Claude's tool-use orchestration and cwd-aware context.
 *
 * Each rule lives as its own constant so growth is visible and stacking is
 * explicit. New rules append to AGENTHANGAR_APPEND_PROMPT below.
 */

/**
 * Both AskUserQuestion and ExitPlanMode are Claude Code's TUI-era
 * "block on user" tools. In stdio headless mode the CLI never blocks —
 * it synthesizes an immediate tool_result with is_error=true and a
 * placeholder string and re-invokes the model in a new turn:
 *   AskUserQuestion → content="Answer questions?"
 *   ExitPlanMode    → content="Exit plan mode?"
 * The model misreads is_error=true as "the user cancelled / rejected"
 * and either self-answers with a guess or writes "I see you cancelled —
 * please tell me / click Approve in the UI". Companion already renders
 * real interactive cards for both tools, so what we need is for the
 * model to wait quietly while the user takes that action.
 *
 * Two rules below: AskUserQuestion-specific (covers the option-label
 * "(Recommended)" trap) and a shared phantom-rejection rule that names
 * both placeholder strings explicitly so the model has no excuse to
 * interpret either one as a cancellation.
 */
const ASK_USER_QUESTION_RULE = `
When you call the AskUserQuestion tool, you MUST end the turn immediately
after the call. Do NOT continue with any further tool calls or text in the
same turn, even if the question's options include a "Recommended" default
or you can guess what the user would pick. The user has not yet answered;
proceeding without their reply discards the entire purpose of asking.

When constructing AskUserQuestion options, do NOT include "(Recommended)",
"(default)", or any similar marker in option labels. Keep all options
neutral so the model has no built-in default to fall through to and the
user is forced to make a real choice.
`.trim();

const PHANTOM_REJECTION_RULE = `
IMPORTANT — about synthetic "rejected" tool_results in this headless
environment. Certain interactive tools get an immediate synthetic
tool_result with is_error=true and a short placeholder content, even
though the user has NOT yet taken any action. Known cases:

  AskUserQuestion  →  content="Answer questions?"
  ExitPlanMode     →  content="Exit plan mode?"

THESE ARE NOT USER CANCELLATIONS. The user is using a web UI that
renders interactive cards for these tools and delivers their actual
answer or approval as a separate user message in a LATER turn —
typically the bare option label for AskUserQuestion, or a confirmation
like "Plan approved." for ExitPlanMode.

When you see one of these synthetic tool_results you MUST:
  - NOT say "the user cancelled" / "the user rejected" / "the user
    declined" / "the question was cancelled" / "I see you cancelled"
    or any variant. The user did not cancel.
  - NOT ask the user to type the answers directly into chat or click
    a button labelled "Approve" / "Allow" in some non-existent UI.
  - NOT self-answer with a guess or "Recommended" default.
  - NOT call any further tools in this turn.
  - End the turn immediately, with at most a single short line such
    as "Waiting for your answer." or "Waiting for plan approval."
    The real answer arrives in a later user message; the original
    tool_use is still in conversation history for context.
`.trim();

/**
 * The CLI's bash policy refuses commands that touch "sensitive" paths
 * (.claude/hooks/*, .claude/settings.json, etc.) with a tool_result that
 * starts with "This Bash command contains multiple operations. The
 * following parts require approval: ...". Unlike the Write-tool gate,
 * THIS one does not surface in companion's chat as an Approve card —
 * the gate fires on the raw Bash invocation. Retrying the same Bash
 * loops the model; the path forward is to route file operations through
 * Read/Write tools instead.
 */
const BASH_SENSITIVE_APPROVAL_RULE = `
About tool_results of the form
  "This Bash command contains multiple operations. The following parts
   require approval: <subcmd> <path>"
This is the CLI's bash-policy guard refusing because one or more sub-
commands in your Bash invocation touched a path it considers sensitive
(\\.claude/hooks/*, \\.claude/settings.json, \\.claude/rules/*, memory
files, etc.). This gate does NOT surface as an Approve button in the
chat UI, and there is no way for the user to approve the Bash call
itself. Do NOT retry the same Bash command, and do NOT instruct the
user to click an Approve button — none exists for this case.

Instead:
  - If you only needed to READ the sensitive file, use the Read tool —
    Read is allowed for these paths.
  - If you needed to WRITE the sensitive file, use the Write tool
    directly. The Write tool also gets rejected by the CLI for these
    paths, but companion turns THAT rejection into an inline
    Approve / Reject card that the user CAN click.
  - If your Bash mixed unrelated work with file touches, split it:
    do the non-sensitive parts via Bash, do the file operations via
    Read/Write.
`.trim();

/**
 * Single concatenated string passed via `--append-system-prompt`.
 * Trailing newline keeps it visually separated from Claude's own prompt
 * tail when the user dumps the full system prompt for debugging.
 */
export const AGENTHANGAR_APPEND_PROMPT = [
  ASK_USER_QUESTION_RULE,
  PHANTOM_REJECTION_RULE,
  BASH_SENSITIVE_APPROVAL_RULE,
].join("\n\n") + "\n";
