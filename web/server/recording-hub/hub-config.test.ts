import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isRecordingHubEnabled, getMaxUploadBytes } from "./hub-config.js";

describe("hub-config", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("isRecordingHubEnabled", () => {
    it("returns false by default (hidden feature)", () => {
      delete process.env.AGENTHANGAR_RECORDING_HUB;
      expect(isRecordingHubEnabled()).toBe(false);
    });

    it("returns true when AGENTHANGAR_RECORDING_HUB=1", () => {
      process.env.AGENTHANGAR_RECORDING_HUB = "1";
      expect(isRecordingHubEnabled()).toBe(true);
    });

    it("returns true when AGENTHANGAR_RECORDING_HUB=true", () => {
      process.env.AGENTHANGAR_RECORDING_HUB = "true";
      expect(isRecordingHubEnabled()).toBe(true);
    });

    it("returns false for other values", () => {
      process.env.AGENTHANGAR_RECORDING_HUB = "0";
      expect(isRecordingHubEnabled()).toBe(false);
    });
  });

  describe("getMaxUploadBytes", () => {
    it("defaults to 50MB", () => {
      delete process.env.AGENTHANGAR_HUB_MAX_UPLOAD_MB;
      expect(getMaxUploadBytes()).toBe(50 * 1024 * 1024);
    });

    it("respects AGENTHANGAR_HUB_MAX_UPLOAD_MB", () => {
      process.env.AGENTHANGAR_HUB_MAX_UPLOAD_MB = "100";
      expect(getMaxUploadBytes()).toBe(100 * 1024 * 1024);
    });
  });
});
