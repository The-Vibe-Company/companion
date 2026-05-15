// Resolves a saved Claude model id to one that the active backend will accept,
// falling back to a known-good default when the saved id is rejected.
//
// Two checks, in priority order:
//   1) Static whitelist — guards against a saved session JSON that names a
//      model id this build no longer ships in CLAUDE_MODELS (e.g. user hand-
//      edited the file, or we removed the id).
//   2) Proxy /v1/models — when the session env carries an ANTHROPIC_BASE_URL
//      we additionally probe `${BASE_URL}/v1/models`. Some proxies (Sub2API,
//      one-api, etc.) reject the `[1m]` suffix variant even though the base
//      model is fine; we strip the suffix and accept the base if listed.
//
// Failure modes are biased toward "trust the saved id": probe error /
// timeout / missing token returns the saved id unchanged so a transient
// proxy outage doesn't silently swap everyone's model.

export const DEFAULT_CLAUDE_MODEL = "claude-opus-4-7";

export const SUPPORTED_CLAUDE_MODELS: ReadonlySet<string> = new Set([
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-opus-4-6[1m]",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
]);

const PROXY_CACHE_TTL_MS = 60_000;
const PROXY_FETCH_TIMEOUT_MS = 5_000;

export interface ProxyModelOption {
  value: string;
  label: string;
}

interface ProxyCacheEntry {
  options: ReadonlyArray<ProxyModelOption>;
  ids: ReadonlySet<string>;
  ts: number;
}

const proxyCache = new Map<string, ProxyCacheEntry>();

/** Test-only: clears the per-BASE_URL `/v1/models` cache. */
export function __resetProxyCacheForTests(): void {
  proxyCache.clear();
}

function stripContextSuffix(model: string): string {
  return model.replace(/\[1m\]$/, "");
}

async function fetchAndCache(
  baseUrl: string,
  token: string,
): Promise<ProxyCacheEntry | null> {
  const cleanBase = baseUrl.replace(/\/+$/, "");
  const cached = proxyCache.get(cleanBase);
  if (cached && Date.now() - cached.ts < PROXY_CACHE_TTL_MS) {
    return cached;
  }
  try {
    const res = await fetch(`${cleanBase}/v1/models`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "x-api-key": token,
      },
      signal: AbortSignal.timeout(PROXY_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      data?: Array<{ id?: unknown; display_name?: unknown; created_at?: unknown }>;
    };
    const list = Array.isArray(data?.data) ? data.data : [];
    type Entry = { id: string; label: string; createdAt: number };
    const entries: Entry[] = [];
    const idSet = new Set<string>();
    for (const m of list) {
      if (typeof m?.id !== "string" || m.id.length === 0) continue;
      idSet.add(m.id);
      // Strip the "Claude " prefix from display_name to match the picker's
      // existing convention (CLAUDE_MODELS uses "Opus 4.7", "Sonnet 4.6"
      // without the brand prefix). Falls back to the model id when the proxy
      // omits display_name.
      const rawLabel = typeof m.display_name === "string" && m.display_name.length > 0
        ? m.display_name
        : m.id;
      const label = rawLabel.replace(/^Claude\s+/, "");
      // created_at is an ISO timestamp on Sub2API responses; missing/invalid
      // values sink to the bottom (sort key 0).
      const ts = typeof m.created_at === "string" ? Date.parse(m.created_at) : NaN;
      entries.push({ id: m.id, label, createdAt: Number.isFinite(ts) ? ts : 0 });
    }
    // Newest first, so the picker shows the latest model at the top — matches
    // user expectation that just-released models surface immediately.
    entries.sort((a, b) => b.createdAt - a.createdAt);
    const options: ProxyModelOption[] = entries.map((e) => ({ value: e.id, label: e.label }));
    const entry: ProxyCacheEntry = { options, ids: idSet, ts: Date.now() };
    proxyCache.set(cleanBase, entry);
    return entry;
  } catch {
    return null;
  }
}

async function fetchProxyModelIds(
  baseUrl: string,
  token: string,
): Promise<ReadonlySet<string> | null> {
  const entry = await fetchAndCache(baseUrl, token);
  return entry ? entry.ids : null;
}

/**
 * Public: returns the proxy's `/v1/models` list as picker-ready ModelOption-shaped
 * tuples. Honors the same per-BASE_URL cache as the resolver. Returns null on
 * any fetch / parse / non-OK failure so the caller can fall back to a static list.
 */
export async function fetchProxyModelOptions(
  baseUrl: string,
  token: string,
): Promise<ReadonlyArray<ProxyModelOption> | null> {
  const entry = await fetchAndCache(baseUrl, token);
  return entry ? entry.options : null;
}

export interface ResolveResult {
  model: string | undefined;
  /** The id we started with (so callers can log a swap). */
  original: string | undefined;
  /** True iff resolver replaced `original` with a different id. */
  swapped: boolean;
  /** Human-readable explanation, only set when swapped. */
  reason?: string;
}

export async function resolveClaudeModel(
  savedModel: string | undefined,
  env: Record<string, string> | undefined,
): Promise<ResolveResult> {
  if (!savedModel) {
    return { model: undefined, original: undefined, swapped: false };
  }

  const baseUrl = env?.ANTHROPIC_BASE_URL;

  if (!baseUrl) {
    if (SUPPORTED_CLAUDE_MODELS.has(savedModel)) {
      return { model: savedModel, original: savedModel, swapped: false };
    }
    return {
      model: DEFAULT_CLAUDE_MODEL,
      original: savedModel,
      swapped: true,
      reason: `model "${savedModel}" not in supported list`,
    };
  }

  const token = env?.ANTHROPIC_AUTH_TOKEN || env?.ANTHROPIC_API_KEY;
  if (!token) {
    return { model: savedModel, original: savedModel, swapped: false };
  }

  const proxyIds = await fetchProxyModelIds(baseUrl, token);
  if (!proxyIds) {
    return { model: savedModel, original: savedModel, swapped: false };
  }

  const base = stripContextSuffix(savedModel);
  if (proxyIds.has(savedModel)) {
    return { model: savedModel, original: savedModel, swapped: false };
  }
  if (proxyIds.has(base)) {
    return {
      model: base,
      original: savedModel,
      swapped: true,
      reason: `proxy ${baseUrl} does not list "${savedModel}"; using base id`,
    };
  }
  return {
    model: DEFAULT_CLAUDE_MODEL,
    original: savedModel,
    swapped: true,
    reason: `proxy ${baseUrl} does not list "${savedModel}" or base "${base}"`,
  };
}
