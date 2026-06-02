/**
 * @vitest-environment node
 *
 * Validates the generated service worker bootstrap:
 * - it claims control and skips waiting immediately
 * - it precaches the injected manifest and cleans up stale caches
 * - it registers a navigation fallback that excludes API and WebSocket paths
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type MockServiceWorkerScope = {
  __WB_MANIFEST: Array<{ revision: string | null; url: string }>;
  skipWaiting: ReturnType<typeof vi.fn>;
};

const clientsClaim = vi.fn();
const cleanupOutdatedCaches = vi.fn();
const createHandlerBoundToURL = vi.fn(() => "index-handler");
const precacheAndRoute = vi.fn();
const registerRoute = vi.fn();
const navigationRouteInstances: Array<{
  handler: unknown;
  options: { denylist?: RegExp[] };
}> = [];

vi.mock("workbox-core", () => ({
  clientsClaim,
}));

vi.mock("workbox-precaching", () => ({
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
}));

const NavigationRoute = vi.fn(function NavigationRoute(
  this: unknown,
  handler: unknown,
  options: { denylist?: RegExp[] },
) {
    const route = { handler, options };
    navigationRouteInstances.push(route);
    return route;
  });

vi.mock("workbox-routing", () => ({
  NavigationRoute,
  registerRoute,
}));

describe("sw", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    navigationRouteInstances.length = 0;

    Object.defineProperty(globalThis, "self", {
      value: {
        __WB_MANIFEST: [{ revision: "123", url: "/assets/app.js" }],
        skipWaiting: vi.fn(),
      },
      configurable: true,
      writable: true,
    });
  });

  it("initializes precaching and navigation fallback routes", async () => {
    await import("./sw.js");
    const serviceWorkerScope = globalThis.self as unknown as MockServiceWorkerScope;

    expect(serviceWorkerScope.skipWaiting).toHaveBeenCalledOnce();
    expect(clientsClaim).toHaveBeenCalledOnce();
    expect(precacheAndRoute).toHaveBeenCalledWith(serviceWorkerScope.__WB_MANIFEST);
    expect(cleanupOutdatedCaches).toHaveBeenCalledOnce();
    expect(createHandlerBoundToURL).toHaveBeenCalledWith("index.html");
    expect(registerRoute).toHaveBeenCalledOnce();
    expect(navigationRouteInstances).toHaveLength(1);

    const route = navigationRouteInstances[0];
    expect(route).toMatchObject({
      handler: "index-handler",
    });
    expect(route?.options.denylist).toHaveLength(2);
    expect(route?.options.denylist?.[0]?.test("/api/sessions")).toBe(true);
    expect(route?.options.denylist?.[0]?.test("/chat")).toBe(false);
    expect(route?.options.denylist?.[1]?.test("/ws/browser/123")).toBe(true);
    expect(route?.options.denylist?.[1]?.test("/dashboard")).toBe(false);
  });
});
