import type { AppSettings } from "../api.js";

export function resolveClaudeAuthMethod(settings: Partial<AppSettings>): "local" | "oauth" | "apiKey" {
  return settings.claudeAuthMethod
    ?? (settings.claudeCodeOAuthTokenConfigured ? "oauth" : settings.claudeApiKeyConfigured ? "apiKey" : "local");
}

export function resolveCodexAuthMethod(settings: Partial<AppSettings>): "local" | "apiKey" {
  return settings.codexAuthMethod ?? (settings.openaiApiKeyConfigured ? "apiKey" : "local");
}

export function hasUsableClaudeAuth(settings: Partial<AppSettings>): boolean {
  const authMethod = resolveClaudeAuthMethod(settings);
  if (authMethod === "local") return settings.claudeDeviceAuthConfigured === true;
  if (authMethod === "oauth") return settings.claudeCodeOAuthTokenConfigured === true;
  return settings.claudeApiKeyConfigured === true;
}

export function hasUsableCodexAuth(settings: Partial<AppSettings>): boolean {
  const authMethod = resolveCodexAuthMethod(settings);
  if (authMethod === "local") return settings.codexDeviceAuthConfigured === true;
  return settings.openaiApiKeyConfigured === true;
}

export function hasUsableProviderAuth(settings: Partial<AppSettings>): boolean {
  return hasUsableClaudeAuth(settings) || hasUsableCodexAuth(settings);
}
