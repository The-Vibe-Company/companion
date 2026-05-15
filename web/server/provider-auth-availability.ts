import type { CompanionSettings } from "./settings-manager.js";
import { hasContainerClaudeAuth } from "./claude-container-auth.js";
import { hasContainerCodexAuth } from "./codex-container-auth.js";

function hasClaudeAuthEnv(envVars?: Record<string, string>): boolean {
  return !!(
    envVars?.ANTHROPIC_API_KEY?.trim()
    || envVars?.ANTHROPIC_AUTH_TOKEN?.trim()
    || envVars?.CLAUDE_CODE_AUTH_TOKEN?.trim()
    || envVars?.CLAUDE_CODE_OAUTH_TOKEN?.trim()
  );
}

function hasCodexAuthEnv(envVars?: Record<string, string>): boolean {
  return !!(envVars?.OPENAI_API_KEY?.trim() || envVars?.CODEX_API_KEY?.trim());
}

export function hasUsableClaudeSessionAuth(
  settings: CompanionSettings,
  envVars?: Record<string, string>,
): boolean {
  if (hasClaudeAuthEnv(envVars)) return true;
  const authMethod = settings.claudeAuthMethod ?? (
    settings.claudeCodeOAuthToken.trim()
      ? "oauth"
      : settings.claudeApiKey?.trim() ? "apiKey" : "local"
  );
  if (authMethod === "oauth") return settings.claudeCodeOAuthToken.trim().length > 0;
  if (authMethod === "apiKey") return (settings.claudeApiKey ?? "").trim().length > 0;
  return hasContainerClaudeAuth();
}

export function hasUsableCodexSessionAuth(
  settings: CompanionSettings,
  envVars?: Record<string, string>,
): boolean {
  if (hasCodexAuthEnv(envVars)) return true;
  const authMethod = settings.codexAuthMethod ?? (settings.openaiApiKey.trim() ? "apiKey" : "local");
  if (authMethod === "apiKey") return settings.openaiApiKey.trim().length > 0;
  return hasContainerCodexAuth();
}
