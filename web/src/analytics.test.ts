// @vitest-environment jsdom
const posthogInitMock = vi.fn();
const posthogCaptureMock = vi.fn();
const posthogCaptureExceptionMock = vi.fn();
const posthogOptInMock = vi.fn();
const posthogOptOutMock = vi.fn();

vi.mock("posthog-js", () => ({
  default: {
    init: posthogInitMock,
    capture: posthogCaptureMock,
    captureException: posthogCaptureExceptionMock,
    opt_in_capturing: posthogOptInMock,
    opt_out_capturing: posthogOptOutMock,
  },
}));

describe("analytics", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    localStorage.clear();
    posthogInitMock.mockReset();
    posthogCaptureMock.mockReset();
    posthogCaptureExceptionMock.mockReset();
    posthogOptInMock.mockReset();
    posthogOptOutMock.mockReset();
  });

  it("stays disabled without a PostHog key", async () => {
    // Validates that telemetry is a hard no-op unless a project key is configured.
    vi.stubEnv("VITE_POSTHOG_KEY", "");
    vi.stubEnv("VITE_PUBLIC_POSTHOG_KEY", "");
    const mod = await import("./analytics.js");

    expect(mod.initAnalytics()).toBe(false);
    expect(mod.isAnalyticsEnabled()).toBe(false);
    mod.captureEvent("event");
    mod.captureException(new Error("boom"));

    expect(posthogInitMock).not.toHaveBeenCalled();
    expect(posthogCaptureMock).not.toHaveBeenCalled();
    expect(posthogCaptureExceptionMock).not.toHaveBeenCalled();
  });

  it("initializes PostHog and captures events when key is configured", async () => {
    // Analytics is now permanently disabled - this test validates the no-op behavior
    vi.stubEnv("VITE_POSTHOG_KEY", "phc_test_key");
    vi.stubEnv("VITE_POSTHOG_HOST", "https://eu.i.posthog.com");
    const mod = await import("./analytics.js");

    // initAnalytics always returns false now (disabled)
    expect(mod.initAnalytics()).toBe(false);
    expect(mod.isAnalyticsEnabled()).toBe(false);

    // PostHog is never initialized since analytics is disabled
    expect(posthogInitMock).not.toHaveBeenCalled();

    mod.captureEvent("test_event", { foo: "bar" });
    mod.captureException(new Error("boom"), { source: "unit_test" });
    mod.capturePageView("#/settings");

    // All capture methods are no-ops, so nothing is sent
    expect(posthogCaptureMock).not.toHaveBeenCalled();
    expect(posthogCaptureExceptionMock).not.toHaveBeenCalled();
  });

  it("respects telemetry preference opt-out", async () => {
    // Analytics is now permanently disabled regardless of preferences
    vi.stubEnv("VITE_POSTHOG_KEY", "phc_test_key");
    localStorage.setItem("cc-telemetry-enabled", "false");
    const mod = await import("./analytics.js");

    expect(mod.initAnalytics()).toBe(false);
    expect(mod.isAnalyticsEnabled()).toBe(false);
    // PostHog is never called since analytics is disabled
    expect(posthogOptOutMock).not.toHaveBeenCalled();
    mod.captureEvent("test_event");
    expect(posthogCaptureMock).not.toHaveBeenCalled();
  });
});
