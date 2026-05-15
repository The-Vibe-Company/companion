import { runAutomationAi } from "./automation-ai.js";

const AI_TIMEOUT_MS = 5_000;

export type AiVerdict = "safe" | "dangerous" | "uncertain";

export interface AiValidationResult {
  verdict: AiVerdict;
  reason: string;
  ruleBasedOnly: boolean;
}

// Tools that are always safe (read-only, no side effects)
const SAFE_TOOLS = new Set(["Read", "Glob", "Grep", "Task"]);

// Tools that should always be shown to the user (interactive)
const ALWAYS_MANUAL_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

// Dangerous patterns for Bash commands
const DANGEROUS_BASH_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+(-\w*r\w*\s+(-\w*f\w*\s+)?|(-\w*f\w*\s+)?-\w*r\w*\s+)[/~.]/, reason: "Recursive delete of root, home, or current directory" },
  { pattern: /\|\s*(ba)?sh\b/, reason: "Piping content to shell execution" },
  { pattern: /\|\s*bash\b/, reason: "Piping content to bash" },
  { pattern: /\bcurl\b.*\|\s*(ba)?sh/, reason: "Piping remote content to shell" },
  { pattern: /\bwget\b.*\|\s*(ba)?sh/, reason: "Piping remote download to shell" },
  { pattern: /^\s*sudo\b/, reason: "Privilege escalation with sudo" },
  { pattern: /\bgit\s+push\s+.*(-f|--force)\b/, reason: "Force pushing to remote" },
  { pattern: /\bgit\s+push\s+(-f|--force)\b/, reason: "Force pushing to remote" },
  { pattern: /\bDROP\s+(DATABASE|TABLE)\b/i, reason: "Dropping database or table" },
  { pattern: /\bTRUNCATE\s+TABLE\b/i, reason: "Truncating table" },
  { pattern: /\bmkfs\b/, reason: "Formatting filesystem" },
  { pattern: /\bdd\s+if=/, reason: "Direct disk write with dd" },
  { pattern: /:\(\)\s*\{\s*:\|:&\s*\}\s*;?\s*:/, reason: "Fork bomb" },
  { pattern: /\b(shutdown|reboot|init\s+0)\b/, reason: "System shutdown or reboot" },
  { pattern: />\s*\/dev\/[hs]d[a-z]/, reason: "Writing to block device" },
  { pattern: /\bchmod\s+777\b/, reason: "Setting overly permissive file permissions" },
];

// Sensitive file paths for Write/Edit tools
const SENSITIVE_PATH_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\/etc\/passwd\b/, reason: "Modifying system password file" },
  { pattern: /\/etc\/shadow\b/, reason: "Modifying system shadow file" },
  { pattern: /\/etc\/sudoers\b/, reason: "Modifying sudoers file" },
  { pattern: /\.ssh\/authorized_keys\b/, reason: "Modifying SSH authorized keys" },
  { pattern: /\.ssh\/id_[a-z]+\b/, reason: "Modifying SSH private keys" },
];

/**
 * Rule-based pre-filter: returns a verdict without making any API call,
 * or null if the tool call needs AI evaluation.
 */
export function ruleBasedFilter(
  toolName: string,
  input: Record<string, unknown>,
): AiValidationResult | null {
  // Always-safe read-only tools
  if (SAFE_TOOLS.has(toolName)) {
    return { verdict: "safe", reason: `${toolName} is a read-only tool`, ruleBasedOnly: true };
  }

  // Always-manual interactive tools
  if (ALWAYS_MANUAL_TOOLS.has(toolName)) {
    return { verdict: "uncertain", reason: "Interactive tool requires user input", ruleBasedOnly: true };
  }

  // Bash command analysis
  if (toolName === "Bash" || toolName === "bash") {
    const command = typeof input.command === "string" ? input.command : "";
    for (const { pattern, reason } of DANGEROUS_BASH_PATTERNS) {
      if (pattern.test(command)) {
        return { verdict: "dangerous", reason, ruleBasedOnly: true };
      }
    }
  }

  // Write/Edit sensitive path analysis
  if (toolName === "Write" || toolName === "Edit") {
    const filePath = typeof input.file_path === "string"
      ? input.file_path
      : typeof input.path === "string"
        ? input.path
        : "";
    for (const { pattern, reason } of SENSITIVE_PATH_PATTERNS) {
      if (pattern.test(filePath)) {
        return { verdict: "dangerous", reason, ruleBasedOnly: true };
      }
    }
  }

  // No rule matched — needs AI evaluation
  return null;
}

const SYSTEM_PROMPT = `You are a security validator for a coding assistant. You evaluate tool calls and classify them as "safe", "dangerous", or "uncertain".

Respond with exactly one JSON object on a single line:
{"verdict": "safe"|"dangerous"|"uncertain", "reason": "brief explanation"}

Rules:
- "safe": The operation is clearly non-destructive (reading files, creating new files in project dirs, standard dev commands like npm install/test, git commit, running tests, writing code)
- "dangerous": The operation could cause data loss, security issues, or system damage (deleting files recursively, modifying system files, running untrusted scripts, force-pushing, dropping databases, privilege escalation)
- "uncertain": You cannot confidently determine safety (complex bash pipelines, unfamiliar tools, ambiguous file operations)

Be conservative: when in doubt, say "uncertain" rather than "safe".`;

/**
 * Call the configured Automation AI provider to evaluate a tool call.
 */
export async function aiEvaluate(
  toolName: string,
  input: Record<string, unknown>,
  description?: string,
): Promise<AiValidationResult> {
  // Build a concise representation of the tool call for the AI
  const inputStr = JSON.stringify(input, null, 0);
  const truncatedInput = inputStr.length > 1000 ? inputStr.slice(0, 1000) + "..." : inputStr;
  let userPrompt = `${SYSTEM_PROMPT}\n\nTool: ${toolName}\nInput: ${truncatedInput}`;
  if (description) {
    userPrompt += `\nDescription: ${description}`;
  }

  try {
    const result = await runAutomationAi(userPrompt, { timeoutMs: AI_TIMEOUT_MS });
    if (!result.ok) {
      console.warn(`[ai-validator] Automation AI request failed: ${result.reason}`);
      return { verdict: "uncertain", reason: result.reason, ruleBasedOnly: false };
    }
    return parseAiResponse(result.text);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.warn("[ai-validator] AI evaluation failed:", err);
    const reason = `Automation AI unavailable: ${errMsg.slice(0, 100)}`;
    return { verdict: "uncertain", reason, ruleBasedOnly: false };
  }
}

/**
 * Parse the AI model's JSON response into a structured result.
 */
export function parseAiResponse(raw: string): AiValidationResult {
  try {
    // Try to extract JSON from the response (the model may include extra text)
    const jsonMatch = raw.match(/\{[^}]*"verdict"\s*:\s*"[^"]*"[^}]*\}/);
    if (!jsonMatch) {
      return { verdict: "uncertain", reason: "Could not parse AI response", ruleBasedOnly: false };
    }

    const parsed = JSON.parse(jsonMatch[0]) as { verdict?: string; reason?: string };

    if (parsed.verdict === "safe" || parsed.verdict === "dangerous" || parsed.verdict === "uncertain") {
      return {
        verdict: parsed.verdict,
        reason: typeof parsed.reason === "string" ? parsed.reason : "No reason provided",
        ruleBasedOnly: false,
      };
    }

    return { verdict: "uncertain", reason: "Invalid AI verdict value", ruleBasedOnly: false };
  } catch {
    return { verdict: "uncertain", reason: "Failed to parse AI response JSON", ruleBasedOnly: false };
  }
}

/**
 * Main entry point: validate a permission request using rule-based filter first,
 * then AI if needed.
 */
export async function validatePermission(
  toolName: string,
  input: Record<string, unknown>,
  description?: string,
): Promise<AiValidationResult> {
  // Step 1: Try rule-based filter (instant, no API call)
  const ruleResult = ruleBasedFilter(toolName, input);
  if (ruleResult) {
    return ruleResult;
  }

  // Step 2: Call AI for evaluation
  return aiEvaluate(toolName, input, description);
}
