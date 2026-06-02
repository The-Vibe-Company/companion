import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Redirect COMPANION_HOME to a temp directory so tests don't touch real config
const TEST_HOME = join(tmpdir(), `linear-staging-test-${Date.now()}`);
process.env.COMPANION_HOME = TEST_HOME;

// Import after setting env var so the module picks up the test directory
const staging = await import("./linear-staging.js");

describe("linear-staging", () => {
  beforeEach(() => {
    mkdirSync(TEST_HOME, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(TEST_HOME, { recursive: true, force: true });
    } catch { /* ok */ }
  });

  describe("createSlot", () => {
    it("creates a slot and returns a hex ID", () => {
      const id = staging.createSlot({
        clientId: "cid",
        clientSecret: "csecret",
        webhookSecret: "wsecret",
      });
      expect(id).toMatch(/^[0-9a-f]{32}$/);
    });

    it("creates the staging directory and JSON file", () => {
      const id = staging.createSlot({
        clientId: "cid",
        clientSecret: "csecret",
        webhookSecret: "wsecret",
      });
      const files = readdirSync(join(TEST_HOME, "staging"));
      expect(files).toContain(`${id}.json`);
    });
  });

  describe("getSlot", () => {
    it("returns the slot with matching credentials", () => {
      const id = staging.createSlot({
        clientId: "my-client",
        clientSecret: "my-secret",
        webhookSecret: "my-webhook",
      });
      const slot = staging.getSlot(id);
      expect(slot).not.toBeNull();
      expect(slot!.clientId).toBe("my-client");
      expect(slot!.clientSecret).toBe("my-secret");
      expect(slot!.webhookSecret).toBe("my-webhook");
      expect(slot!.accessToken).toBe("");
      expect(slot!.refreshToken).toBe("");
    });

    it("returns null for a non-existent slot", () => {
      expect(staging.getSlot("nonexistent")).toBeNull();
    });
  });

  describe("updateSlotTokens", () => {
    it("updates the access and refresh tokens", () => {
      const id = staging.createSlot({
        clientId: "cid",
        clientSecret: "csecret",
        webhookSecret: "wsecret",
      });

      const updated = staging.updateSlotTokens(id, {
        accessToken: "at_123",
        refreshToken: "rt_456",
      });
      expect(updated).toBe(true);

      const slot = staging.getSlot(id);
      expect(slot!.accessToken).toBe("at_123");
      expect(slot!.refreshToken).toBe("rt_456");
      // Original credentials are preserved
      expect(slot!.clientId).toBe("cid");
    });

    it("returns false for a non-existent slot", () => {
      expect(staging.updateSlotTokens("nope", { accessToken: "a", refreshToken: "r" })).toBe(false);
    });
  });

  describe("consumeSlot", () => {
    it("returns the slot and deletes it", () => {
      const id = staging.createSlot({
        clientId: "cid",
        clientSecret: "csecret",
        webhookSecret: "wsecret",
      });

      const slot = staging.consumeSlot(id);
      expect(slot).not.toBeNull();
      expect(slot!.clientId).toBe("cid");

      // Slot is gone after consuming
      expect(staging.getSlot(id)).toBeNull();
    });

    it("returns null for a non-existent slot", () => {
      expect(staging.consumeSlot("nonexistent")).toBeNull();
    });
  });

  describe("deleteSlot", () => {
    it("deletes an existing slot", () => {
      const id = staging.createSlot({
        clientId: "cid",
        clientSecret: "csecret",
        webhookSecret: "wsecret",
      });
      expect(staging.deleteSlot(id)).toBe(true);
      expect(staging.getSlot(id)).toBeNull();
    });

    it("returns false for a non-existent slot", () => {
      expect(staging.deleteSlot("nonexistent")).toBe(false);
    });
  });

  describe("multiple slots", () => {
    it("supports multiple concurrent staging slots", () => {
      // Validates that multiple wizards can run in parallel
      const id1 = staging.createSlot({
        clientId: "client-A",
        clientSecret: "secret-A",
        webhookSecret: "webhook-A",
      });
      const id2 = staging.createSlot({
        clientId: "client-B",
        clientSecret: "secret-B",
        webhookSecret: "webhook-B",
      });

      expect(id1).not.toBe(id2);

      const slot1 = staging.getSlot(id1);
      const slot2 = staging.getSlot(id2);
      expect(slot1!.clientId).toBe("client-A");
      expect(slot2!.clientId).toBe("client-B");

      // Consuming one doesn't affect the other
      staging.consumeSlot(id1);
      expect(staging.getSlot(id1)).toBeNull();
      expect(staging.getSlot(id2)).not.toBeNull();
    });
  });

  describe("TTL / expiry", () => {
    // Slots have a 30-minute TTL. After that window, getSlot should treat
    // them as expired and return null (also cleaning up the file).
    it("getSlot returns null for a slot whose createdAt is older than 30 minutes", () => {
      const id = staging.createSlot({
        clientId: "cid",
        clientSecret: "csecret",
        webhookSecret: "wsecret",
      });

      // Backdate createdAt to 31 minutes ago so it exceeds the 30-min TTL
      const filePath = join(TEST_HOME, "staging", `${id}.json`);
      const slot = JSON.parse(readFileSync(filePath, "utf-8"));
      slot.createdAt = Date.now() - 31 * 60 * 1000;
      writeFileSync(filePath, JSON.stringify(slot, null, 2));

      // The slot should now be treated as expired
      expect(staging.getSlot(id)).toBeNull();
    });
  });

  describe("pruneExpired", () => {
    // pruneExpired should remove all slot files whose createdAt exceeds
    // the 30-minute TTL, leaving fresh slots untouched.
    it("removes stale files from the staging directory", () => {
      // Create two slots: one will be backdated (expired), one stays fresh
      const expiredId = staging.createSlot({
        clientId: "old-client",
        clientSecret: "old-secret",
        webhookSecret: "old-webhook",
      });
      const freshId = staging.createSlot({
        clientId: "new-client",
        clientSecret: "new-secret",
        webhookSecret: "new-webhook",
      });

      // Backdate the first slot to 31 minutes ago
      const expiredPath = join(TEST_HOME, "staging", `${expiredId}.json`);
      const expiredSlot = JSON.parse(readFileSync(expiredPath, "utf-8"));
      expiredSlot.createdAt = Date.now() - 31 * 60 * 1000;
      writeFileSync(expiredPath, JSON.stringify(expiredSlot, null, 2));

      // Run pruneExpired explicitly
      staging.pruneExpired();

      // The expired slot file should be gone
      const remaining = readdirSync(join(TEST_HOME, "staging"));
      expect(remaining).not.toContain(`${expiredId}.json`);

      // The fresh slot should still be present
      expect(remaining).toContain(`${freshId}.json`);
    });
  });

  describe("updateSlotTokens on expired slot", () => {
    // updateSlotTokens delegates to getSlot internally, so if the slot is
    // expired it should return false and not persist any token update.
    it("returns false when the slot has expired", () => {
      const id = staging.createSlot({
        clientId: "cid",
        clientSecret: "csecret",
        webhookSecret: "wsecret",
      });

      // Backdate createdAt to 31 minutes ago
      const filePath = join(TEST_HOME, "staging", `${id}.json`);
      const slot = JSON.parse(readFileSync(filePath, "utf-8"));
      slot.createdAt = Date.now() - 31 * 60 * 1000;
      writeFileSync(filePath, JSON.stringify(slot, null, 2));

      // Attempting to update tokens on an expired slot should fail
      const result = staging.updateSlotTokens(id, {
        accessToken: "at_new",
        refreshToken: "rt_new",
      });
      expect(result).toBe(false);
    });
  });

  describe("path traversal protection", () => {
    // The internal slotPath helper validates IDs against /^[0-9a-f]{32}$/.
    // Any ID that doesn't match (e.g. containing "../") is rejected.
    // Public functions that wrap slotPath in try/catch safely return
    // null/false instead of throwing, but the key invariant is that
    // no file outside the staging directory is ever accessed.

    const maliciousIds = [
      "../settings",
      "../../etc/passwd",
      "../staging/legit",
      "a".repeat(31) + "/",   // wrong length + slash
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA0", // uppercase hex — regex requires lowercase
    ];

    it("getSlot safely rejects malicious IDs (returns null)", () => {
      // getSlot wraps slotPath in a try/catch, so the invalid-ID error
      // is caught and the function returns null — no file access occurs.
      for (const id of maliciousIds) {
        expect(staging.getSlot(id)).toBeNull();
      }
    });

    it("deleteSlot safely rejects malicious IDs (returns false)", () => {
      // deleteSlot wraps unlinkSync(slotPath(id)) in a try/catch,
      // so the invalid-ID error causes it to return false.
      for (const id of maliciousIds) {
        expect(staging.deleteSlot(id)).toBe(false);
      }
    });

    it("consumeSlot safely rejects malicious IDs (returns null)", () => {
      // consumeSlot delegates to getSlot first, which returns null
      // for invalid IDs, so consumeSlot returns null immediately.
      for (const id of maliciousIds) {
        expect(staging.consumeSlot(id)).toBeNull();
      }
    });
  });
});
