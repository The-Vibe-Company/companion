import { getSettings } from "./settings-manager.js";
import type { SessionState } from "./session-types.js";
import { resolveAutomationAiProvider, type AutomationAiProvider } from "./automation-ai.js";

export interface EffectiveAiValidationSettings {
  enabled: boolean;
  autoApprove: boolean;
  autoDeny: boolean;
  automationProvider: AutomationAiProvider | null;
  automationAvailable: boolean;
}

/**
 * Resolve effective AI validation settings for a session.
 * Session-level overrides take priority; falls back to global settings.
 * Automation uses the verified Agent Auth provider for the current session
 * backend when possible, then falls back to any available provider.
 */
export function getEffectiveAiValidation(
  sessionState: SessionState,
): EffectiveAiValidationSettings {
  const global = getSettings();
  const automationProvider = resolveAutomationAiProvider(sessionState.backend_type, global);
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
    automationProvider,
    automationAvailable: automationProvider != null,
  };
}
