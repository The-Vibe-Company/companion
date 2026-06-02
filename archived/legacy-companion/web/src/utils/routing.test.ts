// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  parseHash,
  sessionHash,
  navigateToSession,
  navigateHome,
} from "./routing.js";

describe("parseHash", () => {
  it("returns home for empty string", () => {
    expect(parseHash("")).toEqual({ page: "home" });
  });

  it("returns home for bare hash", () => {
    expect(parseHash("#/")).toEqual({ page: "home" });
  });

  it("returns home for unknown routes", () => {
    expect(parseHash("#/unknown")).toEqual({ page: "home" });
  });

  it("parses settings route", () => {
    expect(parseHash("#/settings")).toEqual({ page: "settings" });
  });

  it("parses integrations route", () => {
    expect(parseHash("#/integrations")).toEqual({ page: "integrations" });
  });

  it("parses linear integration route", () => {
    expect(parseHash("#/integrations/linear")).toEqual({ page: "integration-linear" });
  });

  it("parses prompts route", () => {
    expect(parseHash("#/prompts")).toEqual({ page: "prompts" });
  });

  it("parses environments route", () => {
    expect(parseHash("#/environments")).toEqual({ page: "environments" });
  });

  it("parses docker-builder route as home (removed)", () => {
    // docker-builder route was removed; unknown routes map to home
    expect(parseHash("#/docker-builder")).toEqual({ page: "home" });
  });

  it("parses scheduled route (redirects to agents)", () => {
    expect(parseHash("#/scheduled")).toEqual({ page: "agents" });
  });

  it("parses playground route", () => {
    expect(parseHash("#/playground")).toEqual({ page: "playground" });
  });

  it("parses session route with UUID", () => {
    expect(parseHash("#/session/a1b2c3d4-e5f6-7890-abcd-ef1234567890")).toEqual({
      page: "session",
      sessionId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    });
  });

  it("parses session route with short ID", () => {
    expect(parseHash("#/session/abc123")).toEqual({
      page: "session",
      sessionId: "abc123",
    });
  });

  it("returns home for session route with empty ID", () => {
    // #/session/ with no ID should be treated as home
    expect(parseHash("#/session/")).toEqual({ page: "home" });
  });
});

describe("sessionHash", () => {
  it("builds hash for a session ID", () => {
    expect(sessionHash("abc123")).toBe("#/session/abc123");
  });

  it("builds hash for a UUID session ID", () => {
    expect(sessionHash("a1b2c3d4-e5f6-7890-abcd-ef1234567890")).toBe(
      "#/session/a1b2c3d4-e5f6-7890-abcd-ef1234567890"
    );
  });
});

describe("navigateToSession", () => {
  beforeEach(() => {
    window.location.hash = "";
  });

  it("sets hash to session route", () => {
    navigateToSession("test-id");
    expect(window.location.hash).toBe("#/session/test-id");
  });

  it("uses replaceState when replace=true", () => {
    const spy = vi.spyOn(history, "replaceState");
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    navigateToSession("test-id", true);
    expect(spy).toHaveBeenCalledWith(null, "", "#/session/test-id");
    // Should dispatch hashchange since replaceState doesn't trigger it natively
    expect(dispatchSpy).toHaveBeenCalledWith(expect.any(HashChangeEvent));
    spy.mockRestore();
    dispatchSpy.mockRestore();
  });
});

describe("navigateHome", () => {
  beforeEach(() => {
    window.location.hash = "#/session/test";
  });

  it("clears the hash", () => {
    navigateHome();
    // After clearing, hash is empty string (browser may keep "#" or "")
    expect(window.location.hash === "" || window.location.hash === "#").toBe(true);
  });

  it("uses replaceState when replace=true", () => {
    const spy = vi.spyOn(history, "replaceState");
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    navigateHome(true);
    expect(spy).toHaveBeenCalled();
    expect(dispatchSpy).toHaveBeenCalledWith(expect.any(HashChangeEvent));
    spy.mockRestore();
    dispatchSpy.mockRestore();
  });
});
