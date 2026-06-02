/**
 * Tests for linear-oauth-connections.ts — file-based CRUD store for
 * Linear OAuth connections.
 *
 * Validates:
 * - CRUD: create, read, update, delete
 * - List and lookup operations
 * - findOAuthConnectionByClientId lookup
 * - sanitizeOAuthConnection masks secrets
 * - Auto-derived status from accessToken
 * - _resetForTest clears state
 * - Persistence to disk (write + reload)
 * - Invalid/corrupt JSON file handling
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  listOAuthConnections,
  getOAuthConnection,
  findOAuthConnectionByClientId,
  createOAuthConnection,
  updateOAuthConnection,
  deleteOAuthConnection,
  sanitizeOAuthConnection,
  _resetForTest,
  type LinearOAuthConnection,
} from "./linear-oauth-connections.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TEST_DIR = join(tmpdir(), `companion-oauth-test-${Date.now()}`);
const TEST_FILE = join(TEST_DIR, "linear-oauth-connections.json");

beforeEach(() => {
  // Reset state and point at a temp file per test
  _resetForTest(TEST_FILE);
  // Ensure clean directory
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
  mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
  // Clean up temp directory
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
});

// =============================================================================
// Tests
// =============================================================================

describe("linear-oauth-connections", () => {
  // ─── List ─────────────────────────────────────────────────────────────────

  it("returns empty array when no connections exist", () => {
    const conns = listOAuthConnections();
    expect(conns).toEqual([]);
  });

  // ─── Create ───────────────────────────────────────────────────────────────

  it("creates a connection with all required fields", () => {
    const conn = createOAuthConnection({
      name: "My App",
      oauthClientId: "client-123",
      oauthClientSecret: "secret-456",
      webhookSecret: "webhook-789",
    });

    expect(conn.id).toBeTruthy();
    expect(conn.name).toBe("My App");
    expect(conn.oauthClientId).toBe("client-123");
    expect(conn.oauthClientSecret).toBe("secret-456");
    expect(conn.webhookSecret).toBe("webhook-789");
    expect(conn.accessToken).toBe("");
    expect(conn.refreshToken).toBe("");
    expect(conn.status).toBe("disconnected");
    expect(conn.createdAt).toBeGreaterThan(0);
    expect(conn.updatedAt).toBeGreaterThan(0);
  });

  it("trims whitespace from inputs", () => {
    const conn = createOAuthConnection({
      name: "  Trimmed App  ",
      oauthClientId: "  cid  ",
      oauthClientSecret: "  csec  ",
      webhookSecret: "  wsec  ",
    });

    expect(conn.name).toBe("Trimmed App");
    expect(conn.oauthClientId).toBe("cid");
    expect(conn.oauthClientSecret).toBe("csec");
    expect(conn.webhookSecret).toBe("wsec");
  });

  it("sets status to 'connected' when accessToken is provided", () => {
    const conn = createOAuthConnection({
      name: "With Token",
      oauthClientId: "cid",
      oauthClientSecret: "csec",
      webhookSecret: "wsec",
      accessToken: "tok-123",
    });

    expect(conn.status).toBe("connected");
    expect(conn.accessToken).toBe("tok-123");
  });

  // ─── Get ──────────────────────────────────────────────────────────────────

  it("retrieves a connection by ID", () => {
    const created = createOAuthConnection({
      name: "Findable",
      oauthClientId: "cid",
      oauthClientSecret: "csec",
      webhookSecret: "wsec",
    });

    const found = getOAuthConnection(created.id);
    expect(found).not.toBeNull();
    expect(found!.name).toBe("Findable");
  });

  it("returns null for non-existent ID", () => {
    expect(getOAuthConnection("non-existent-id")).toBeNull();
  });

  // ─── Find by client ID ────────────────────────────────────────────────────

  it("finds a connection by oauthClientId", () => {
    createOAuthConnection({
      name: "Target",
      oauthClientId: "unique-client-id",
      oauthClientSecret: "csec",
      webhookSecret: "wsec",
    });

    const found = findOAuthConnectionByClientId("unique-client-id");
    expect(found).not.toBeNull();
    expect(found!.name).toBe("Target");
  });

  it("returns null when no matching oauthClientId", () => {
    expect(findOAuthConnectionByClientId("nope")).toBeNull();
  });

  // ─── Update ───────────────────────────────────────────────────────────────

  it("updates connection fields", () => {
    const conn = createOAuthConnection({
      name: "Old Name",
      oauthClientId: "cid",
      oauthClientSecret: "csec",
      webhookSecret: "wsec",
    });

    const updated = updateOAuthConnection(conn.id, { name: "New Name" });
    expect(updated).not.toBeNull();
    expect(updated!.name).toBe("New Name");
    expect(updated!.oauthClientId).toBe("cid"); // unchanged
  });

  it("auto-derives connected status when accessToken is set", () => {
    const conn = createOAuthConnection({
      name: "App",
      oauthClientId: "cid",
      oauthClientSecret: "csec",
      webhookSecret: "wsec",
    });
    expect(conn.status).toBe("disconnected");

    const updated = updateOAuthConnection(conn.id, { accessToken: "tok" });
    expect(updated!.status).toBe("connected");
  });

  it("auto-derives disconnected status when accessToken is cleared", () => {
    const conn = createOAuthConnection({
      name: "App",
      oauthClientId: "cid",
      oauthClientSecret: "csec",
      webhookSecret: "wsec",
      accessToken: "tok",
    });
    expect(conn.status).toBe("connected");

    const updated = updateOAuthConnection(conn.id, { accessToken: "" });
    expect(updated!.status).toBe("disconnected");
  });

  it("allows explicit status override", () => {
    const conn = createOAuthConnection({
      name: "App",
      oauthClientId: "cid",
      oauthClientSecret: "csec",
      webhookSecret: "wsec",
    });

    const updated = updateOAuthConnection(conn.id, { status: "connected" });
    expect(updated!.status).toBe("connected");
  });

  it("returns null when updating non-existent ID", () => {
    expect(updateOAuthConnection("nope", { name: "x" })).toBeNull();
  });

  // ─── Delete ───────────────────────────────────────────────────────────────

  it("deletes a connection and returns true", () => {
    const conn = createOAuthConnection({
      name: "Deletable",
      oauthClientId: "cid",
      oauthClientSecret: "csec",
      webhookSecret: "wsec",
    });

    expect(deleteOAuthConnection(conn.id)).toBe(true);
    expect(getOAuthConnection(conn.id)).toBeNull();
    expect(listOAuthConnections()).toHaveLength(0);
  });

  it("returns false when deleting non-existent ID", () => {
    expect(deleteOAuthConnection("nope")).toBe(false);
  });

  // ─── List ─────────────────────────────────────────────────────────────────

  it("lists all connections", () => {
    createOAuthConnection({ name: "A", oauthClientId: "a", oauthClientSecret: "s", webhookSecret: "w" });
    createOAuthConnection({ name: "B", oauthClientId: "b", oauthClientSecret: "s", webhookSecret: "w" });

    const all = listOAuthConnections();
    expect(all).toHaveLength(2);
    expect(all.map((c) => c.name)).toEqual(["A", "B"]);
  });

  it("returns a copy (mutations don't affect store)", () => {
    createOAuthConnection({ name: "Safe", oauthClientId: "cid", oauthClientSecret: "s", webhookSecret: "w" });
    const list = listOAuthConnections();
    list.pop();
    expect(listOAuthConnections()).toHaveLength(1);
  });

  // ─── Sanitize ─────────────────────────────────────────────────────────────

  it("masks secrets in sanitized output", () => {
    const conn = createOAuthConnection({
      name: "Sensitive",
      oauthClientId: "visible-client-id",
      oauthClientSecret: "super-secret",
      webhookSecret: "wh-secret",
      accessToken: "at-secret",
    });

    const sanitized = sanitizeOAuthConnection(conn);

    // Should include these public fields
    expect(sanitized.id).toBe(conn.id);
    expect(sanitized.name).toBe("Sensitive");
    expect(sanitized.oauthClientId).toBe("visible-client-id");
    expect(sanitized.status).toBe("connected");
    expect(sanitized.createdAt).toBe(conn.createdAt);
    expect(sanitized.updatedAt).toBe(conn.updatedAt);

    // Should have boolean flags instead of actual secrets
    expect(sanitized.hasAccessToken).toBe(true);
    expect(sanitized.hasClientSecret).toBe(true);
    expect(sanitized.hasWebhookSecret).toBe(true);

    // Should NOT contain the actual secrets
    const raw = sanitized as unknown as Record<string, unknown>;
    expect(raw["oauthClientSecret"]).toBeUndefined();
    expect(raw["webhookSecret"]).toBeUndefined();
    expect(raw["accessToken"]).toBeUndefined();
    expect(raw["refreshToken"]).toBeUndefined();
  });

  it("reports false flags when secrets are empty", () => {
    const conn = createOAuthConnection({
      name: "No Secrets",
      oauthClientId: "cid",
      oauthClientSecret: "csec",
      webhookSecret: "wsec",
    });

    const sanitized = sanitizeOAuthConnection(conn);
    expect(sanitized.hasAccessToken).toBe(false); // no accessToken provided
  });

  // ─── Persistence ──────────────────────────────────────────────────────────

  it("persists to disk and reloads correctly", () => {
    // Create a connection
    const conn = createOAuthConnection({
      name: "Persistent",
      oauthClientId: "persist-cid",
      oauthClientSecret: "persist-csec",
      webhookSecret: "persist-wsec",
    });

    // Verify file exists
    expect(existsSync(TEST_FILE)).toBe(true);

    // Reset state (simulates server restart) and reload
    _resetForTest(TEST_FILE);
    const reloaded = listOAuthConnections();
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0].id).toBe(conn.id);
    expect(reloaded[0].name).toBe("Persistent");
  });

  it("handles corrupt JSON file gracefully", () => {
    // Write invalid JSON to the file
    writeFileSync(TEST_FILE, "not valid json{{{", "utf-8");

    _resetForTest(TEST_FILE);
    const conns = listOAuthConnections();
    expect(conns).toEqual([]);
  });

  it("handles non-array JSON file gracefully", () => {
    // Write valid JSON but not an array
    writeFileSync(TEST_FILE, JSON.stringify({ foo: "bar" }), "utf-8");

    _resetForTest(TEST_FILE);
    const conns = listOAuthConnections();
    expect(conns).toEqual([]);
  });

  it("filters out malformed entries from JSON file", () => {
    // Write array with mix of valid and invalid entries
    const data = [
      { id: "valid", oauthClientId: "cid", name: "Valid", oauthClientSecret: "", webhookSecret: "", accessToken: "", refreshToken: "", status: "disconnected", createdAt: 1, updatedAt: 1 },
      { noId: true }, // missing id
      null,           // null entry
      "string entry", // not an object
    ];
    writeFileSync(TEST_FILE, JSON.stringify(data), "utf-8");

    _resetForTest(TEST_FILE);
    const conns = listOAuthConnections();
    expect(conns).toHaveLength(1);
    expect(conns[0].name).toBe("Valid");
  });

  // ─── _resetForTest ────────────────────────────────────────────────────────

  it("clears state when _resetForTest is called", () => {
    createOAuthConnection({ name: "Will Reset", oauthClientId: "cid", oauthClientSecret: "s", webhookSecret: "w" });
    expect(listOAuthConnections()).toHaveLength(1);

    _resetForTest(TEST_FILE);
    // Next list call will attempt to read from TEST_FILE which no longer has this connection
    // But since we created a connection above, the file DOES have it.
    // So reset and use a non-existent file to prove state is cleared
    const emptyFile = join(TEST_DIR, "empty.json");
    _resetForTest(emptyFile);
    expect(listOAuthConnections()).toHaveLength(0);
  });
});
