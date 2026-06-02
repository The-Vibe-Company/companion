import { DEFAULT_ANTHROPIC_MODEL, getSettings } from "./settings-manager.js";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

function sanitizeTitle(raw: string): string | null {
  const title = raw.replace(/^"|"$/g, "").replace(/^'|'$/g, "").trim();
  if (!title || title.length >= 100) return null;
  return title;
}

/**
 * Generates a short session title using the Anthropic Messages API.
 * Returns null if Anthropic isn't configured or if generation fails.
 */
export async function generateSessionTitle(
  firstUserMessage: string,
  _model: string,
  options?: {
    timeoutMs?: number;
  },
): Promise<string | null> {
  const timeout = options?.timeoutMs || 15_000;
  const settings = getSettings();
  const apiKey = settings.anthropicApiKey.trim();

  if (!apiKey) {
    return null;
  }

  const model = settings.anthropicModel?.trim() || DEFAULT_ANTHROPIC_MODEL;
  const truncated = firstUserMessage.slice(0, 500);
  const userPrompt = `Generate a concise 3-5 word session title for this user request. Output only the title.\n\nRequest: ${truncated}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 256,
        messages: [
          {
            role: "user",
            content: userPrompt,
          },
        ],
        temperature: 0.2,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      console.warn(`[auto-namer] Anthropic request failed: ${res.status} ${res.statusText}`);
      return null;
    }

    const data = await res.json() as {
      content?: Array<{ type: string; text?: string }>;
    };

    const raw = data.content?.[0]?.type === "text"
      ? (data.content[0].text ?? "")
      : "";
    return sanitizeTitle(raw);
  } catch (err) {
    console.warn("[auto-namer] Failed to generate session title via Anthropic:", err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
