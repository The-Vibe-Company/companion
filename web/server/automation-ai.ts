import { DEFAULT_ANTHROPIC_MODEL, getSettings, type CompanionSettings } from "./settings-manager.js";
import type { BackendType } from "./session-types.js";
import { hasContainerClaudeAuth } from "./claude-container-auth.js";
import { hasContainerCodexAuth } from "./codex-container-auth.js";

export type AutomationAiProvider = "claude" | "codex";

const AUTOMATION_AI_TIMEOUT_MS = 20_000;
const DEFAULT_CODEX_AUTOMATION_MODEL = "gpt-5-mini";

function hasClaudeAutomationAuth(settings: CompanionSettings): boolean {
  if ((settings.anthropicApiKey ?? "").trim()) return true;
  const method = settings.claudeAuthMethod ?? "local";
  if (method === "oauth") return !!(settings.claudeCodeOAuthToken ?? "").trim();
  if (method === "apiKey") return !!(settings.claudeApiKey ?? "").trim();
  return hasContainerClaudeAuth();
}

function hasCodexAutomationAuth(settings: CompanionSettings): boolean {
  const method = settings.codexAuthMethod ?? "local";
  if (method === "apiKey") return !!(settings.openaiApiKey ?? "").trim();
  return hasContainerCodexAuth();
}

export function resolveAutomationAiProvider(
  preferredBackend?: BackendType,
  settings: CompanionSettings = getSettings(),
): AutomationAiProvider | null {
  const claudeAvailable = hasClaudeAutomationAuth(settings);
  const codexAvailable = hasCodexAutomationAuth(settings);

  if (preferredBackend === "codex" && codexAvailable) return "codex";
  if (preferredBackend === "claude" && claudeAvailable) return "claude";
  if (claudeAvailable) return "claude";
  if (codexAvailable) return "codex";
  return null;
}

export function getAutomationAiModel(
  provider: AutomationAiProvider,
  settings: CompanionSettings = getSettings(),
): string {
  const configured = settings.anthropicModel?.trim();
  if (provider === "claude" && configured && !/^(gpt|o\d|openai\/)/i.test(configured)) return configured;
  if (provider === "codex" && configured && !/^claude/i.test(configured)) return configured;
  return provider === "codex" ? DEFAULT_CODEX_AUTOMATION_MODEL : DEFAULT_ANTHROPIC_MODEL;
}

function buildEnv(provider: AutomationAiProvider, settings: CompanionSettings): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };

  if (provider === "claude") {
    if ((settings.claudeAuthMethod ?? "local") === "oauth" && settings.claudeCodeOAuthToken.trim()) {
      env.CLAUDE_CODE_OAUTH_TOKEN = settings.claudeCodeOAuthToken.trim();
    } else if ((settings.claudeAuthMethod ?? "local") === "apiKey" && (settings.claudeApiKey ?? "").trim()) {
      env.ANTHROPIC_API_KEY = (settings.claudeApiKey ?? "").trim();
      if (settings.claudeBaseUrl?.trim()) env.ANTHROPIC_BASE_URL = settings.claudeBaseUrl.trim();
    } else if ((settings.anthropicApiKey ?? "").trim()) {
      // Backward compatibility for users who configured the legacy Automation
      // AI key before Automation started reusing Agent Auth.
      env.ANTHROPIC_API_KEY = (settings.anthropicApiKey ?? "").trim();
    }
  } else if ((settings.codexAuthMethod ?? "local") === "apiKey" && settings.openaiApiKey.trim()) {
    env.OPENAI_API_KEY = settings.openaiApiKey.trim();
    if (settings.openaiBaseUrl?.trim()) env.OPENAI_BASE_URL = settings.openaiBaseUrl.trim();
  }

  return env;
}

function commandForProvider(provider: AutomationAiProvider, model: string, prompt: string): string[] {
  if (provider === "claude") {
    const args = ["claude"];
    if (model) args.push("--model", model);
    args.push(
      "--output-format",
      "text",
      "--permission-mode",
      "default",
      "--no-session-persistence",
      "-p",
      prompt,
    );
    return args;
  }

  const args = [
    "codex",
    "exec",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "--ephemeral",
  ];
  if (model) args.push("--model", model);
  args.push(prompt);
  return args;
}

function redactOutput(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-***")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer ***")
    .trim();
}

export async function runAutomationAi(
  prompt: string,
  options?: {
    preferredBackend?: BackendType;
    timeoutMs?: number;
  },
): Promise<{ ok: true; provider: AutomationAiProvider; model: string; text: string } | { ok: false; reason: string }> {
  const settings = getSettings();
  const provider = resolveAutomationAiProvider(options?.preferredBackend, settings);
  if (!provider) return { ok: false, reason: "No verified Claude Code or Codex auth method is configured" };

  const model = getAutomationAiModel(provider, settings);
  const command = commandForProvider(provider, model, prompt);
  let proc: ReturnType<typeof Bun.spawn>;

  try {
    proc = Bun.spawn(command, {
      cwd: process.cwd(),
      env: buildEnv(provider, settings),
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    return {
      ok: false,
      reason: `${provider === "claude" ? "Claude Code" : "Codex"} CLI could not be started: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const timeoutMs = options?.timeoutMs ?? AUTOMATION_AI_TIMEOUT_MS;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      // Process may have already exited.
    }
  }, timeoutMs);

  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
      new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
    ]);

    if (exitCode === 0) {
      return { ok: true, provider, model, text: stdout.trim() };
    }

    const detail = redactOutput(stderr || stdout);
    return {
      ok: false,
      reason: timedOut
        ? `${provider === "claude" ? "Claude Code" : "Codex"} automation request timed out`
        : detail || `${provider === "claude" ? "Claude Code" : "Codex"} automation request exited with code ${exitCode}`,
    };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}
