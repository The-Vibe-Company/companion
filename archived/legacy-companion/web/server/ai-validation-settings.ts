import { getSettings } from "./settings-manager.js";
import type { SessionState } from "./session-types.js";

export interface EffectiveAiValidationSettings {
  enabled: boolean;
  autoApprove: boolean;
  autoDeny: boolean;
  anthropicApiKey: string;
}

/**
 * Resolve effective AI validation settings for a session.
 * Session-level overrides take priority; falls back to global settings.
 * The anthropicApiKey is always from global settings.
 */
export function getEffectiveAiValidation(
  sessionState: SessionState,
): EffectiveAiValidationSettings {
  const global = getSettings();
  return {
    enabled:
      sessionState.aiValidationEnabled != null
        ? sessionState.aiValidationEnabled
        : global.aiValidationEnabled,
    autoApprove:
      sessionState.aiValidationAutoApprove != null
        ? sessionState.aiValidationAutoApprove
        : global.aiValidationAutoApprove,
    autoDeny:
      sessionState.aiValidationAutoDeny != null
        ? sessionState.aiValidationAutoDeny
        : global.aiValidationAutoDeny,
    anthropicApiKey: global.anthropicApiKey,
  };
}
