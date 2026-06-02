/**
 * Feature gate for the Recording Hub.
 *
 * The hub is disabled by default. Enable with COMPANION_RECORDING_HUB=1.
 * When disabled, hub routes are not registered and hub storage is not initialized.
 */

const DEFAULT_MAX_UPLOAD_MB = 50;

export function isRecordingHubEnabled(): boolean {
  const env = process.env.COMPANION_RECORDING_HUB;
  return env === "1" || env === "true";
}

export function getMaxUploadBytes(): number {
  const parsed = Number(process.env.COMPANION_HUB_MAX_UPLOAD_MB);
  const mb = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_UPLOAD_MB;
  return mb * 1024 * 1024;
}
