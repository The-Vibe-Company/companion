import posthog from "posthog-js";

const POSTHOG_DEFAULT_HOST = "https://us.i.posthog.com";
const TELEMETRY_STORAGE_KEY = "cc-telemetry-enabled";

let analyticsInitialized = false;
let analyticsEnabled = false;

function getPostHogKey(): string | undefined {
  const key = import.meta.env.VITE_POSTHOG_KEY || import.meta.env.VITE_PUBLIC_POSTHOG_KEY;
  if (!key || !key.trim()) return undefined;
  return key.trim();
}

function getPostHogHost(): string {
  const host = import.meta.env.VITE_POSTHOG_HOST || import.meta.env.VITE_PUBLIC_POSTHOG_HOST;
  if (!host || !host.trim()) return POSTHOG_DEFAULT_HOST;
  return host.trim();
}

export function isAnalyticsEnabled(): boolean {
  return analyticsEnabled;
}

export function getTelemetryPreferenceEnabled(): boolean {
  if (typeof localStorage === "undefined") return true;
  const stored = localStorage.getItem(TELEMETRY_STORAGE_KEY);
  if (stored === null) return true;
  return stored === "true";
}

function applyTelemetryPreference(enabled: boolean): void {
  if (!analyticsInitialized) return;
  if (enabled) {
    posthog.opt_in_capturing({ captureEventName: null });
    analyticsEnabled = true;
  } else {
    posthog.opt_out_capturing();
    analyticsEnabled = false;
  }
}

export function setTelemetryPreferenceEnabled(enabled: boolean): void {
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(TELEMETRY_STORAGE_KEY, String(enabled));
  }
  applyTelemetryPreference(enabled);
}

export function initAnalytics(): boolean {
  const key = getPostHogKey();
  if (!key) {
    analyticsInitialized = false;
    analyticsEnabled = false;
    return false;
  }

  posthog.init(key, {
    api_host: getPostHogHost(),
    defaults: "2026-01-30",
    capture_pageview: false,
    capture_pageleave: true,
    capture_exceptions: true,
    autocapture: true,
    respect_dnt: true,
  });

  analyticsInitialized = true;
  applyTelemetryPreference(getTelemetryPreferenceEnabled());
  return true;
}

export function captureEvent(event: string, properties?: Record<string, unknown>): void {
  if (!analyticsEnabled) return;
  posthog.capture(event, properties);
}

export function captureException(error: unknown, properties?: Record<string, unknown>): void {
  if (!analyticsEnabled) return;
  posthog.captureException(error, properties);
}

export function capturePageView(path: string): void {
  captureEvent("$pageview", { $current_url: path });
}
