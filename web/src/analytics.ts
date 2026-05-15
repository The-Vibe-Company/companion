// Analytics disabled - no data collection
// All functions are no-ops to prevent any external data transmission

const TELEMETRY_STORAGE_KEY = "cc-telemetry-enabled";

export function isAnalyticsEnabled(): boolean {
  // Always disabled
  return false;
}

export function getTelemetryPreferenceEnabled(): boolean {
  // Always return false - analytics is disabled
  return false;
}

export function setTelemetryPreferenceEnabled(enabled: boolean): void {
  // No-op - analytics is disabled
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(TELEMETRY_STORAGE_KEY, "false");
  }
}

export function initAnalytics(): boolean {
  // No-op - analytics is disabled
  return false;
}

export function captureEvent(event: string, properties?: Record<string, unknown>): void {
  // No-op - analytics is disabled
}

export function captureException(error: unknown, properties?: Record<string, unknown>): void {
  // No-op - analytics is disabled
}

export function capturePageView(path: string): void {
  // No-op - analytics is disabled
}
