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

export function setTelemetryPreferenceEnabled(_enabled: boolean): void {
  // No-op — analytics is disabled. We still pin the localStorage flag
  // to "false" so any code that reads it back gets a consistent answer.
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(TELEMETRY_STORAGE_KEY, "false");
  }
}

export function initAnalytics(): boolean {
  // No-op - analytics is disabled
  return false;
}

export function captureEvent(_event: string, _properties?: Record<string, unknown>): void {
  // No-op — analytics is disabled.
}

export function captureException(_error: unknown, _properties?: Record<string, unknown>): void {
  // No-op — analytics is disabled.
}

export function capturePageView(_path: string): void {
  // No-op — analytics is disabled.
}
