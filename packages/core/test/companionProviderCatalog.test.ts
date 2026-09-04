/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion -- These established typed fetch fixtures parse only repository-owned mock responses; this regression changes their catalog expectations, not their I/O boundary. */
import { describe, expect, it, vi } from "vitest";
import { COMPANION_PROVIDER_CATALOG } from "@companion/contracts";
import {
  COMPANION_PI_PROVIDER_IDS,
  CompanionProviderCatalogCache,
  companionCatalogModel,
  getCompanionProviderCatalog,
} from "../src/companionProviderCatalog";

function providerIdFromUrl(input: string | URL | Request): string {
  const url = typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
  return decodeURIComponent(new URL(url).pathname.split("/").at(-1)!);
}

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

describe("Companion pi.dev provider catalog", () => {
  it("maps only supported providers and refreshes metadata for pinned model ids", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const providerId = providerIdFromUrl(input);
      if (providerId === "zai") {
        return jsonResponse({
          "glm-4.7": { id: "glm-4.7", name: "GLM-4.7", input: ["text", "image"] },
          "glm-5.2": { id: "glm-5.2", name: "GLM-5.2", input: ["text"] },
          "glm-5.3": { id: "glm-5.3", name: "GLM-5.3" },
        });
      }
      const id = `${providerId}-live`;
      return jsonResponse({ [id]: { id, name: `${providerId} live` } });
    }) as typeof fetch;

    const catalog = await getCompanionProviderCatalog({
      fetchImpl,
      cache: new CompanionProviderCatalogCache(),
    });

    expect(Object.keys(COMPANION_PI_PROVIDER_IDS)).toEqual(
      COMPANION_PROVIDER_CATALOG.map((provider) => provider.id),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(COMPANION_PROVIDER_CATALOG.length);
    expect(catalog.find((provider) => provider.id === "zai")?.models)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "glm-4.7", input: ["text", "image"] }),
      ]));
    expect(catalog.find((provider) => provider.id === "zai")?.models)
      .not.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "glm-5.2" }),
        expect.objectContaining({ id: "glm-5.3" }),
      ]));
  });

  it("keeps live model capabilities constrained by the shared Companion input schema", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const providerId = providerIdFromUrl(input);
      if (providerId === "zai") {
        return jsonResponse({
          "future-audio": {
            id: "future-audio",
            name: "Future audio",
            input: ["text", "audio"],
          },
        });
      }
      const id = `${providerId}-live`;
      return jsonResponse({ [id]: { id, name: `${providerId} live`, input: ["text"] } });
    }) as typeof fetch;

    const catalog = await getCompanionProviderCatalog({
      fetchImpl,
      cache: new CompanionProviderCatalogCache(),
    });

    expect(catalog.find((provider) => provider.id === "zai")?.models)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: "glm-4.7" })]));
    expect(catalog.find((provider) => provider.id === "zai")?.models)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ id: "future-audio" })]));
  });

  it("serves last-known models after a failed refresh, then bundled pins on a cold failure", async () => {
    const cache = new CompanionProviderCatalogCache();
    const liveFetch = vi.fn(async (input: string | URL | Request) => {
      const providerId = providerIdFromUrl(input);
      const id = `${providerId}-latest`;
      return jsonResponse({ [id]: { id, name: `${providerId} latest` } });
    }) as typeof fetch;
    const failedFetch = vi.fn(async () => jsonResponse({}, 503)) as typeof fetch;

    const live = await getCompanionProviderCatalog({ fetchImpl: liveFetch, cache, now: () => 0 });
    const lastKnown = await getCompanionProviderCatalog({
      fetchImpl: failedFetch,
      cache,
      now: () => 10,
      cacheTtlMs: 1,
    });
    const coldCache = new CompanionProviderCatalogCache();
    const bundled = await getCompanionProviderCatalog({
      fetchImpl: failedFetch,
      cache: coldCache,
    });
    const failedCalls = vi.mocked(failedFetch).mock.calls.length;
    await getCompanionProviderCatalog({ fetchImpl: failedFetch, cache: coldCache });

    expect(lastKnown).toEqual(live);
    expect(failedFetch).toHaveBeenCalledTimes(failedCalls);
    expect(bundled.every((provider) => provider.models.length > 0)).toBe(true);
    expect(bundled.find((provider) => provider.id === "zai")?.models)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: "glm-4.7" })]));
  });

  it("aborts a stalled pi.dev request within the configured budget and still returns pins", async () => {
    const stalledFetch = vi.fn((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      })) as typeof fetch;

    const startedAt = Date.now();
    const catalog = await getCompanionProviderCatalog({
      fetchImpl: stalledFetch,
      cache: new CompanionProviderCatalogCache(),
      requestTimeoutMs: 10,
    });

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(catalog.every((provider) => provider.models.length > 0)).toBe(true);
  });

  it("coalesces concurrent refreshes for the same provider catalog", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      await gate;
      const providerId = providerIdFromUrl(input);
      const id = `${providerId}-live`;
      return jsonResponse({ [id]: { id, name: `${providerId} live` } });
    }) as typeof fetch;
    const cache = new CompanionProviderCatalogCache();

    const first = getCompanionProviderCatalog({ fetchImpl, cache });
    const second = getCompanionProviderCatalog({ fetchImpl, cache });
    release();
    await Promise.all([first, second]);

    expect(fetchImpl).toHaveBeenCalledTimes(COMPANION_PROVIDER_CATALOG.length);
  });

  it("keeps the bundled executable set even when pi.dev advertises newer models", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const providerId = providerIdFromUrl(input);
      if (providerId === "zai") {
        return jsonResponse({
          "glm-5.3": { id: "glm-5.3", name: "GLM-5.3" },
          "glm-4.7": { id: "glm-4.7", name: "GLM-4.7" },
        });
      }
      const id = providerId === "google" ? "gemini-3.8-flash" : `${providerId}-first`;
      return jsonResponse({ [id]: { id, name: `${providerId} first` } });
    }) as typeof fetch;

    const catalog = await getCompanionProviderCatalog({
      fetchImpl,
      cache: new CompanionProviderCatalogCache(),
    });

    expect(companionCatalogModel(catalog, "zai")).toBe("glm-4.7");
    expect(companionCatalogModel(catalog, "anthropic")).toBe("claude-opus-4-8");
    expect(companionCatalogModel(catalog, "zai", "glm-5.3")).toBeUndefined();
    expect(companionCatalogModel(catalog, "google", "gemini-3.8-flash")).toBeUndefined();
    expect(companionCatalogModel(catalog, "zai", "unknown-model")).toBeUndefined();
  });
});
