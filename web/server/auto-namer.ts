import { runAutomationAi } from "./automation-ai.js";
import type { BackendType } from "./session-types.js";

function sanitizeTitle(raw: string): string | null {
  const title = raw.replace(/^"|"$/g, "").replace(/^'|'$/g, "").trim();
  if (!title || title.length >= 100) return null;
  return title;
}

/**
 * Generates a short session title using the configured Automation AI provider.
 * Returns null if no Claude/Codex Agent Auth is available or generation fails.
 */
export async function generateSessionTitle(
  firstUserMessage: string,
  _model: string,
  options?: {
    timeoutMs?: number;
    preferredBackend?: BackendType;
  },
): Promise<string | null> {
  const timeout = options?.timeoutMs || 15_000;
  const truncated = firstUserMessage.slice(0, 500);
  const userPrompt = `Generate a concise 3-5 word session title for this user request. Output only the title.\n\nRequest: ${truncated}`;

  try {
    const res = await runAutomationAi(userPrompt, {
      timeoutMs: timeout,
      preferredBackend: options?.preferredBackend,
    });
    if (!res.ok) {
      console.warn(`[auto-namer] Automation AI request failed: ${res.reason}`);
      return null;
    }
    return sanitizeTitle(res.text);
  } catch (err) {
    console.warn("[auto-namer] Failed to generate session title via Automation AI:", err);
    return null;
  }
}
