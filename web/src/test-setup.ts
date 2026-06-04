// Vitest setup for jsdom-based component tests.
//
// - Registers @testing-library/jest-dom matchers (toBeInTheDocument, etc.).
// - Auto-cleans the React tree between tests.
// - Provides a fetch mock helper so tests assert behavior at the network
//   boundary and never hit a live server.

import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});

// jsdom does not implement matchMedia; several components read it (e.g. for
// prefers-reduced-motion). Provide an inert, non-matching stub.
beforeEach(() => {
  if (typeof window !== "undefined" && !window.matchMedia) {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: (query: string): MediaQueryList =>
        ({
          matches: false,
          media: query,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => false,
        }) as unknown as MediaQueryList,
    });
  }
});

/**
 * A single recorded fetch interaction: a matcher against the request and the
 * Response (or factory) to return when it matches.
 */
export interface FetchRoute {
  method?: string;
  /** Substring or RegExp matched against the request URL. */
  url: string | RegExp;
  /** Status code for the synthesized JSON response. Defaults to 200. */
  status?: number;
  /** JSON body, or a function computing it from the parsed request. */
  body?: unknown | ((req: { url: string; method: string; body: unknown }) => unknown);
}

/**
 * Installs a `globalThis.fetch` mock that resolves the first matching route.
 * Returns the vi mock so tests can assert on calls. Unmatched requests reject
 * with a descriptive error to surface missing stubs loudly.
 *
 * Tests own the network: every component test that performs I/O must stub it
 * here rather than reaching a real console server or provider.
 */
export function mockFetch(routes: FetchRoute[]): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const route = routes.find((r) => {
      if (r.method && r.method.toUpperCase() !== method) return false;
      return typeof r.url === "string" ? url.includes(r.url) : r.url.test(url);
    });
    if (!route) {
      throw new Error(`mockFetch: no route for ${method} ${url}`);
    }
    let parsedBody: unknown;
    if (typeof init?.body === "string") {
      try {
        parsedBody = JSON.parse(init.body);
      } catch {
        parsedBody = init.body;
      }
    }
    const payload =
      typeof route.body === "function"
        ? (route.body as (req: { url: string; method: string; body: unknown }) => unknown)({
            url,
            method,
            body: parsedBody,
          })
        : route.body;
    const status = route.status ?? 200;
    return new Response(payload === undefined ? null : JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
