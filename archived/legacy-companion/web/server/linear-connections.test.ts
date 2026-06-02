import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  listConnections,
  getConnection,
  getDefaultConnection,
  createConnection,
  updateConnection,
  deleteConnection,
  resolveApiKey,
  _resetForTest,
  type LinearConnection,
} from "./linear-connections.js";

// Mock settings-manager to control legacy linearApiKey fallback
vi.mock("./settings-manager.js", () => ({
  getSettings: vi.fn(() => ({
    linearApiKey: "",
    linearAutoTransition: false,
    linearAutoTransitionStateId: "",
    linearAutoTransitionStateName: "",
    linearArchiveTransition: false,
    linearArchiveTransitionStateId: "",
    linearArchiveTransitionStateName: "",
  })),
}));

import { getSettings } from "./settings-manager.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "linear-connections-test-"));
  _resetForTest(join(tempDir, "linear-connections.json"));
  vi.mocked(getSettings).mockReturnValue({
    linearApiKey: "",
    linearAutoTransition: false,
    linearAutoTransitionStateId: "",
    linearAutoTransitionStateName: "",
    linearArchiveTransition: false,
    linearArchiveTransitionStateId: "",
    linearArchiveTransitionStateName: "",
    anthropicApiKey: "",
    anthropicModel: "",
    linearOAuthClientId: "",
    linearOAuthClientSecret: "",
    linearOAuthWebhookSecret: "",
    linearOAuthAccessToken: "",
    linearOAuthRefreshToken: "",
    claudeCodeOAuthToken: "",
    openaiApiKey: "",
    onboardingCompleted: false,
    aiValidationEnabled: false,
    aiValidationAutoApprove: true,
    aiValidationAutoDeny: false,
    publicUrl: "",
    updateChannel: "stable",
    dockerAutoUpdate: false,
    updatedAt: 0,
  });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("linear-connections", () => {
  // ─── CRUD ────────────────────────────────────────────────────────────

  it("listConnections returns empty array when no connections exist", () => {
    expect(listConnections()).toEqual([]);
  });

  it("createConnection creates a connection and persists", () => {
    const conn = createConnection({ name: "Work", apiKey: "lin_api_work123" });
    expect(conn.name).toBe("Work");
    expect(conn.apiKey).toBe("lin_api_work123");
    expect(conn.id).toBeTruthy();
    expect(conn.connected).toBe(false);
    expect(conn.autoTransition).toBe(false);

    // Verify persisted to disk
    const raw = JSON.parse(readFileSync(join(tempDir, "linear-connections.json"), "utf-8"));
    expect(raw).toHaveLength(1);
    expect(raw[0].name).toBe("Work");
  });

  it("getConnection retrieves by id", () => {
    const conn = createConnection({ name: "Test", apiKey: "lin_api_test" });
    expect(getConnection(conn.id)).toEqual(conn);
    expect(getConnection("nonexistent")).toBeNull();
  });

  it("getDefaultConnection returns the first connection", () => {
    expect(getDefaultConnection()).toBeNull();
    createConnection({ name: "First", apiKey: "lin_api_first" });
    createConnection({ name: "Second", apiKey: "lin_api_second" });
    expect(getDefaultConnection()?.name).toBe("First");
  });

  it("updateConnection updates fields and preserves others", () => {
    const conn = createConnection({ name: "Original", apiKey: "lin_api_orig" });
    const updated = updateConnection(conn.id, {
      name: "Updated",
      connected: true,
      workspaceName: "My Workspace",
    });
    expect(updated).not.toBeNull();
    expect(updated!.name).toBe("Updated");
    expect(updated!.apiKey).toBe("lin_api_orig"); // unchanged
    expect(updated!.connected).toBe(true);
    expect(updated!.workspaceName).toBe("My Workspace");
  });

  it("updateConnection returns null for nonexistent id", () => {
    expect(updateConnection("nope", { name: "x" })).toBeNull();
  });

  it("deleteConnection removes a connection and persists", () => {
    const conn = createConnection({ name: "ToDelete", apiKey: "lin_api_del" });
    expect(deleteConnection(conn.id)).toBe(true);
    expect(getConnection(conn.id)).toBeNull();
    expect(listConnections()).toEqual([]);
  });

  it("deleteConnection returns false for nonexistent id", () => {
    expect(deleteConnection("nope")).toBe(false);
  });

  it("supports multiple connections", () => {
    createConnection({ name: "A", apiKey: "lin_api_a" });
    createConnection({ name: "B", apiKey: "lin_api_b" });
    createConnection({ name: "C", apiKey: "lin_api_c" });
    expect(listConnections()).toHaveLength(3);
  });

  it("trims name and apiKey on create and update", () => {
    const conn = createConnection({ name: "  Spaced  ", apiKey: "  lin_api_key  " });
    expect(conn.name).toBe("Spaced");
    expect(conn.apiKey).toBe("lin_api_key");

    const updated = updateConnection(conn.id, { name: "  Updated  " });
    expect(updated!.name).toBe("Updated");
  });

  // ─── resolveApiKey ─────────────────────────────────────────────────

  it("resolveApiKey returns specific connection when connectionId is provided", () => {
    const conn = createConnection({ name: "Target", apiKey: "lin_api_target" });
    const result = resolveApiKey(conn.id);
    expect(result).toEqual({ apiKey: "lin_api_target", connectionId: conn.id });
  });

  it("resolveApiKey returns null for invalid connectionId", () => {
    expect(resolveApiKey("nonexistent")).toBeNull();
  });

  it("resolveApiKey falls back to default connection when no connectionId", () => {
    const conn = createConnection({ name: "Default", apiKey: "lin_api_default" });
    const result = resolveApiKey();
    expect(result).toEqual({ apiKey: "lin_api_default", connectionId: conn.id });
  });

  it("resolveApiKey falls back to legacy settings.linearApiKey", () => {
    // No connections exist, but settings has a key
    vi.mocked(getSettings).mockReturnValue({
      linearApiKey: "lin_api_legacy",
      linearAutoTransition: false,
      linearAutoTransitionStateId: "",
      linearAutoTransitionStateName: "",
      linearArchiveTransition: false,
      linearArchiveTransitionStateId: "",
      linearArchiveTransitionStateName: "",
      anthropicApiKey: "",
      anthropicModel: "",
      linearOAuthClientId: "",
      linearOAuthClientSecret: "",
      linearOAuthWebhookSecret: "",
      linearOAuthAccessToken: "",
      linearOAuthRefreshToken: "",
      claudeCodeOAuthToken: "",
      openaiApiKey: "",
      onboardingCompleted: false,
      aiValidationEnabled: false,
      aiValidationAutoApprove: true,
      aiValidationAutoDeny: false,
      publicUrl: "",
      updateChannel: "stable",
      dockerAutoUpdate: false,
      updatedAt: 0,
    });
    // Need to reset so migration runs with updated mock
    _resetForTest(join(tempDir, "linear-connections-legacy.json"));
    // Migration should create a connection from the legacy key
    const result = resolveApiKey();
    expect(result).not.toBeNull();
    expect(result!.apiKey).toBe("lin_api_legacy");
  });

  it("resolveApiKey returns null when nothing configured", () => {
    expect(resolveApiKey()).toBeNull();
  });

  // ─── Migration ─────────────────────────────────────────────────────

  it("migrates from settings.linearApiKey on first load", () => {
    vi.mocked(getSettings).mockReturnValue({
      linearApiKey: "lin_api_migrated",
      linearAutoTransition: true,
      linearAutoTransitionStateId: "state-1",
      linearAutoTransitionStateName: "In Progress",
      linearArchiveTransition: false,
      linearArchiveTransitionStateId: "",
      linearArchiveTransitionStateName: "",
      anthropicApiKey: "",
      anthropicModel: "",
      linearOAuthClientId: "",
      linearOAuthClientSecret: "",
      linearOAuthWebhookSecret: "",
      linearOAuthAccessToken: "",
      linearOAuthRefreshToken: "",
      claudeCodeOAuthToken: "",
      openaiApiKey: "",
      onboardingCompleted: false,
      aiValidationEnabled: false,
      aiValidationAutoApprove: true,
      aiValidationAutoDeny: false,
      publicUrl: "",
      updateChannel: "stable",
      dockerAutoUpdate: false,
      updatedAt: 0,
    });
    _resetForTest(join(tempDir, "linear-connections-migrate.json"));

    const conns = listConnections();
    expect(conns).toHaveLength(1);
    expect(conns[0].name).toBe("Default");
    expect(conns[0].apiKey).toBe("lin_api_migrated");
    expect(conns[0].autoTransition).toBe(true);
    expect(conns[0].autoTransitionStateId).toBe("state-1");
  });

  it("does not migrate when connections already exist on disk", () => {
    // Pre-populate the file with an existing connection
    writeFileSync(
      join(tempDir, "linear-connections-existing.json"),
      JSON.stringify([{
        id: "existing-id",
        name: "Existing",
        apiKey: "lin_api_existing",
        workspaceName: "",
        workspaceId: "",
        viewerName: "",
        viewerEmail: "",
        connected: false,
        autoTransition: false,
        autoTransitionStateId: "",
        autoTransitionStateName: "",
        archiveTransition: false,
        archiveTransitionStateId: "",
        archiveTransitionStateName: "",
        createdAt: 1000,
        updatedAt: 1000,
      }]),
    );

    vi.mocked(getSettings).mockReturnValue({
      linearApiKey: "lin_api_should_not_migrate",
      linearAutoTransition: false,
      linearAutoTransitionStateId: "",
      linearAutoTransitionStateName: "",
      linearArchiveTransition: false,
      linearArchiveTransitionStateId: "",
      linearArchiveTransitionStateName: "",
      anthropicApiKey: "",
      anthropicModel: "",
      linearOAuthClientId: "",
      linearOAuthClientSecret: "",
      linearOAuthWebhookSecret: "",
      linearOAuthAccessToken: "",
      linearOAuthRefreshToken: "",
      claudeCodeOAuthToken: "",
      openaiApiKey: "",
      onboardingCompleted: false,
      aiValidationEnabled: false,
      aiValidationAutoApprove: true,
      aiValidationAutoDeny: false,
      publicUrl: "",
      updateChannel: "stable",
      dockerAutoUpdate: false,
      updatedAt: 0,
    });

    _resetForTest(join(tempDir, "linear-connections-existing.json"));
    const conns = listConnections();
    expect(conns).toHaveLength(1);
    expect(conns[0].name).toBe("Existing");
  });

  // ─── Persistence ───────────────────────────────────────────────────

  it("loads existing data from disk on first access", () => {
    const existingConn = {
      id: "loaded-id",
      name: "Loaded",
      apiKey: "lin_api_loaded",
      workspaceName: "WS",
      workspaceId: "ws-id",
      viewerName: "User",
      viewerEmail: "user@test.com",
      connected: true,
      autoTransition: false,
      autoTransitionStateId: "",
      autoTransitionStateName: "",
      archiveTransition: false,
      archiveTransitionStateId: "",
      archiveTransitionStateName: "",
      createdAt: 1000,
      updatedAt: 2000,
    };
    writeFileSync(
      join(tempDir, "linear-connections.json"),
      JSON.stringify([existingConn]),
    );
    _resetForTest(join(tempDir, "linear-connections.json"));
    const conn = getConnection("loaded-id");
    expect(conn?.name).toBe("Loaded");
    expect(conn?.workspaceName).toBe("WS");
  });

  it("handles corrupt JSON gracefully", () => {
    writeFileSync(join(tempDir, "linear-connections.json"), "NOT VALID JSON");
    _resetForTest(join(tempDir, "linear-connections.json"));
    expect(listConnections()).toEqual([]);
  });

  it("creates parent directories if needed", () => {
    const nestedPath = join(tempDir, "nested", "dir", "connections.json");
    _resetForTest(nestedPath);
    createConnection({ name: "Nested", apiKey: "lin_api_nested" });
    expect(listConnections()).toHaveLength(1);
  });
});
