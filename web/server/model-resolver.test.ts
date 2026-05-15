import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  resolveClaudeModel,
  fetchProxyModelOptions,
  DEFAULT_CLAUDE_MODEL,
  SUPPORTED_CLAUDE_MODELS,
  __resetProxyCacheForTests,
} from "./model-resolver.js";

// All cases for resolveClaudeModel:
// no env / no BASE_URL: lean on the static whitelist (cheap, no network).
// BASE_URL: probe `${BASE_URL}/v1/models`, with proxy fetch outcomes covered
// (saved id listed / [1m] stripped to a listed base / nothing matches /
// network error / non-OK / token missing). The probe must never reject —
// only return a fallback string.

describe("resolveClaudeModel", () => {
  beforeEach(() => {
    __resetProxyCacheForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns undefined when no saved model is set (let the CLI pick its own default)", async () => {
    const r = await resolveClaudeModel(undefined, {});
    expect(r.model).toBeUndefined();
    expect(r.swapped).toBe(false);
  });

  it("with no BASE_URL, returns the saved model unchanged when it is in the static whitelist", async () => {
    const r = await resolveClaudeModel("claude-opus-4-7", {});
    expect(r.model).toBe("claude-opus-4-7");
    expect(r.swapped).toBe(false);
  });

  it("with no BASE_URL, falls back to DEFAULT when the saved model is not in the static whitelist (e.g. retired id, hand-edited JSON)", async () => {
    const r = await resolveClaudeModel("claude-opus-3-imaginary", {});
    expect(r.model).toBe(DEFAULT_CLAUDE_MODEL);
    expect(r.swapped).toBe(true);
    expect(r.reason).toMatch(/not in supported list/);
  });

  it("with BASE_URL but no auth token, trusts the saved id (we cannot probe so we do not swap)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const r = await resolveClaudeModel("claude-opus-4-6[1m]", {
      ANTHROPIC_BASE_URL: "http://localhost:9999",
    });
    expect(r.model).toBe("claude-opus-4-6[1m]");
    expect(r.swapped).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("when proxy lists the exact saved id, returns it unchanged", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [{ id: "claude-opus-4-7" }, { id: "claude-sonnet-4-6" }],
        }),
        { status: 200 },
      ),
    );
    const r = await resolveClaudeModel("claude-opus-4-7", {
      ANTHROPIC_BASE_URL: "http://localhost:9999",
      ANTHROPIC_AUTH_TOKEN: "tk",
    });
    expect(r.model).toBe("claude-opus-4-7");
    expect(r.swapped).toBe(false);
  });

  // Real-world Sub2API symptom: the proxy lists "claude-opus-4-6" but rejects
  // "claude-opus-4-6[1m]" with an upstream error. Strip the suffix instead of
  // jumping all the way to the default — the user picked 4.6 for a reason.
  it("strips [1m] when proxy lists the base id but not the suffix variant", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ data: [{ id: "claude-opus-4-6" }] }),
        { status: 200 },
      ),
    );
    const r = await resolveClaudeModel("claude-opus-4-6[1m]", {
      ANTHROPIC_BASE_URL: "http://localhost:9999/",
      ANTHROPIC_AUTH_TOKEN: "tk",
    });
    expect(r.model).toBe("claude-opus-4-6");
    expect(r.swapped).toBe(true);
    expect(r.reason).toMatch(/does not list/);
  });

  it("falls back to DEFAULT when neither saved id nor stripped base is listed by the proxy", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ data: [{ id: "claude-haiku-4-5-20251001" }] }),
        { status: 200 },
      ),
    );
    const r = await resolveClaudeModel("claude-opus-4-6[1m]", {
      ANTHROPIC_BASE_URL: "http://localhost:9999",
      ANTHROPIC_AUTH_TOKEN: "tk",
    });
    expect(r.model).toBe(DEFAULT_CLAUDE_MODEL);
    expect(r.swapped).toBe(true);
  });

  it("on proxy fetch error, trusts the saved id (transient outage must not silently swap models)", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const r = await resolveClaudeModel("claude-opus-4-6[1m]", {
      ANTHROPIC_BASE_URL: "http://localhost:9999",
      ANTHROPIC_AUTH_TOKEN: "tk",
    });
    expect(r.model).toBe("claude-opus-4-6[1m]");
    expect(r.swapped).toBe(false);
  });

  it("on proxy non-OK response, trusts the saved id", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("nope", { status: 500 }),
    );
    const r = await resolveClaudeModel("claude-opus-4-6[1m]", {
      ANTHROPIC_BASE_URL: "http://localhost:9999",
      ANTHROPIC_AUTH_TOKEN: "tk",
    });
    expect(r.model).toBe("claude-opus-4-6[1m]");
    expect(r.swapped).toBe(false);
  });

  // Cache check: two back-to-back calls within TTL should hit /v1/models once.
  it("caches /v1/models per BASE_URL within TTL (single fetch across multiple calls)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ data: [{ id: "claude-opus-4-7" }] }),
        { status: 200 },
      ),
    );
    const env = {
      ANTHROPIC_BASE_URL: "http://localhost:9999",
      ANTHROPIC_AUTH_TOKEN: "tk",
    };
    await resolveClaudeModel("claude-opus-4-7", env);
    await resolveClaudeModel("claude-opus-4-7", env);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("ANTHROPIC_API_KEY is accepted as an alternative auth header source", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ data: [{ id: "claude-opus-4-7" }] }),
        { status: 200 },
      ),
    );
    const r = await resolveClaudeModel("claude-opus-4-7", {
      ANTHROPIC_BASE_URL: "http://localhost:9999",
      ANTHROPIC_API_KEY: "sk-ant-xxx",
    });
    expect(r.model).toBe("claude-opus-4-7");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const headers = (fetchSpy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer sk-ant-xxx");
  });

  it("DEFAULT_CLAUDE_MODEL is itself a member of the static whitelist (otherwise fallbacks would loop the user back to a rejected id)", () => {
    expect(SUPPORTED_CLAUDE_MODELS.has(DEFAULT_CLAUDE_MODEL)).toBe(true);
  });
});

// fetchProxyModelOptions backs the dynamic picker shown in the UI. It returns
// {value,label} tuples (so the frontend can render display_name when present)
// and shares the resolver's cache, so a freshly-fetched picker list does not
// cost a second roundtrip when resolveClaudeModel runs right after.
describe("fetchProxyModelOptions", () => {
  beforeEach(() => {
    __resetProxyCacheForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("strips the 'Claude ' prefix from display_name labels and falls back to the id when display_name is missing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [
            { id: "claude-opus-4-7", display_name: "Claude Opus 4.7", created_at: "2026-04-17T00:00:00Z" },
            { id: "claude-sonnet-4-6", created_at: "2026-02-18T00:00:00Z" }, // missing display_name → id form
          ],
        }),
        { status: 200 },
      ),
    );
    const opts = await fetchProxyModelOptions("http://proxy", "tk");
    expect(opts).toEqual([
      // "Claude Opus 4.7" → "Opus 4.7" matches CLAUDE_MODELS picker convention.
      { value: "claude-opus-4-7", label: "Opus 4.7" },
      // No display_name → id is used verbatim (don't try to beautify; the proxy
      // is the source of truth for human labels).
      { value: "claude-sonnet-4-6", label: "claude-sonnet-4-6" },
    ]);
  });

  // Real ordering reflected by Sub2API: a fresh /v1/models response comes in
  // index order, but we want newest-first so just-released models surface at
  // the top of the picker. Sort key is `created_at` (ISO timestamp); missing
  // or invalid values sink to the bottom so they don't disrupt the rest.
  it("sorts options by created_at descending (newest model first), missing dates last", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [
            { id: "old", display_name: "Claude Old", created_at: "2025-09-29T00:00:00Z" },
            { id: "newest", display_name: "Claude Newest", created_at: "2026-04-17T00:00:00Z" },
            { id: "middle", display_name: "Claude Middle", created_at: "2026-02-06T00:00:00Z" },
            { id: "no-date", display_name: "Claude No Date" }, // sinks
          ],
        }),
        { status: 200 },
      ),
    );
    const opts = await fetchProxyModelOptions("http://proxy", "tk");
    expect(opts?.map((o) => o.value)).toEqual(["newest", "middle", "old", "no-date"]);
  });

  it("returns null on fetch error so callers can fall back", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("boom"));
    expect(await fetchProxyModelOptions("http://proxy", "tk")).toBeNull();
  });

  it("returns null on non-OK response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("denied", { status: 401 }),
    );
    expect(await fetchProxyModelOptions("http://proxy", "tk")).toBeNull();
  });

  // Sharing the cache means the picker fetch and the spawn-time resolver fetch
  // don't double-bill the proxy when they happen in the same UI flow.
  it("shares cache with resolveClaudeModel (picker fetch warms the resolver)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [{ id: "claude-opus-4-7", display_name: "Claude Opus 4.7" }],
        }),
        { status: 200 },
      ),
    );
    const opts = await fetchProxyModelOptions("http://proxy", "tk");
    expect(opts).not.toBeNull();
    const r = await resolveClaudeModel("claude-opus-4-7", {
      ANTHROPIC_BASE_URL: "http://proxy",
      ANTHROPIC_AUTH_TOKEN: "tk",
    });
    expect(r.swapped).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("filters out malformed entries (missing or non-string id)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [
            { id: "good" },
            { id: "" }, // empty
            { display_name: "no id" }, // missing id
            { id: 42 }, // wrong type
          ],
        }),
        { status: 200 },
      ),
    );
    const opts = await fetchProxyModelOptions("http://proxy", "tk");
    expect(opts).toEqual([{ value: "good", label: "good" }]);
  });
});
