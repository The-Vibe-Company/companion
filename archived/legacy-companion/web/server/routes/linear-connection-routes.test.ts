import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// ─── Mock linear-connections ────────────────────────────────────────────────
// Each function is declared as a vi.fn() so we can control return values per test.
const mockListConnections = vi.fn(() => [] as any[]);
const mockGetConnection = vi.fn((_id: string) => null as any);
const mockCreateConnection = vi.fn((data: { name: string; apiKey: string }) => ({
  id: "new-conn-id",
  name: data.name,
  apiKey: data.apiKey,
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
}));
const mockUpdateConnection = vi.fn((_id: string, _patch: any) => null as any);
const mockDeleteConnection = vi.fn((_id: string) => false);

vi.mock("../linear-connections.js", () => ({
  listConnections: () => mockListConnections(),
  getConnection: (id: string) => mockGetConnection(id),
  createConnection: (data: any) => mockCreateConnection(data),
  updateConnection: (id: string, patch: any) => mockUpdateConnection(id, patch),
  deleteConnection: (id: string) => mockDeleteConnection(id),
}));

// ─── Mock linear-cache ──────────────────────────────────────────────────────
// The routes use linearCache.invalidate() on update/delete; we mock it as a no-op spy.
vi.mock("../linear-cache.js", () => ({
  linearCache: {
    getOrFetch: vi.fn(async (_key: string, _ttl: number, fetcher: () => Promise<unknown>) => fetcher()),
    invalidate: vi.fn(),
    clear: vi.fn(),
  },
}));

// ─── Imports (after mocks are declared) ─────────────────────────────────────
import { Hono } from "hono";
import { linearCache } from "../linear-cache.js";
import { registerLinearConnectionRoutes } from "./linear-connection-routes.js";

// ─── Test setup ─────────────────────────────────────────────────────────────

let app: Hono;

// Save original global fetch so we can restore it after each test.
const originalFetch = globalThis.fetch;

/** Helper to mock globalThis.fetch without TS errors about missing properties */
function mockFetch() {
  const fn = vi.fn();
  globalThis.fetch = fn as any;
  return fn;
}

/** Build a successful Linear GraphQL response (for verification calls). */
function linearVerifyOk(viewer: Record<string, unknown>, org: Record<string, unknown>) {
  return new Response(
    JSON.stringify({
      data: {
        viewer,
        organization: org,
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

/** Build a Linear GraphQL error response. */
function linearError(message: string, status = 200) {
  return new Response(
    JSON.stringify({ errors: [{ message }] }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

/** Build a non-ok HTTP response. */
function linearHttpError(statusText = "Internal Server Error", status = 500) {
  return new Response(JSON.stringify({}), {
    status,
    statusText,
    headers: { "Content-Type": "application/json" },
  });
}

/** Create a full connection object for use in mocks. */
function makeConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: "conn-1",
    name: "My Workspace",
    apiKey: "lin_api_testapikey1234",
    workspaceName: "TestOrg",
    workspaceId: "org-1",
    viewerName: "Test User",
    viewerEmail: "test@example.com",
    connected: true,
    autoTransition: false,
    autoTransitionStateId: "",
    autoTransitionStateName: "",
    archiveTransition: false,
    archiveTransitionStateId: "",
    archiveTransitionStateName: "",
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  // Restore global fetch to prevent leaks between tests
  globalThis.fetch = originalFetch;

  // Reset mock defaults
  mockListConnections.mockReturnValue([]);
  mockGetConnection.mockReturnValue(null);
  mockDeleteConnection.mockReturnValue(false);
  mockUpdateConnection.mockReturnValue(null);

  app = new Hono();
  const api = new Hono();
  registerLinearConnectionRoutes(api);
  app.route("/api", api);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// =============================================================================
// GET /api/linear/connections
// =============================================================================

describe("GET /api/linear/connections", () => {
  it("returns an empty array when no connections exist", async () => {
    // Validates that listing connections with an empty store returns { connections: [] }
    mockListConnections.mockReturnValue([]);

    const res = await app.request("/api/linear/connections");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.connections).toEqual([]);
  });

  it("returns connections with API keys masked, showing only last 4 chars", async () => {
    // Validates that the maskApiKey helper correctly hides all but the last 4 characters
    const conn = makeConnection({ apiKey: "lin_api_supersecretkey1234" });
    mockListConnections.mockReturnValue([conn]);

    const res = await app.request("/api/linear/connections");
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.connections).toHaveLength(1);
    expect(json.connections[0].apiKeyLast4).toBe("****1234");
    // The raw apiKey should NOT appear in the response
    expect(json.connections[0].apiKey).toBeUndefined();
  });

  it("masks short API keys (4 chars or fewer) as '****'", async () => {
    // Validates the edge case in maskApiKey where key.length <= 4 returns "****"
    const conn = makeConnection({ apiKey: "abcd" });
    mockListConnections.mockReturnValue([conn]);

    const res = await app.request("/api/linear/connections");
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.connections[0].apiKeyLast4).toBe("****");
  });

  it("masks very short API keys (fewer than 4 chars) as '****'", async () => {
    // Validates the edge case in maskApiKey where key.length < 4 returns "****"
    const conn = makeConnection({ apiKey: "ab" });
    mockListConnections.mockReturnValue([conn]);

    const res = await app.request("/api/linear/connections");
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.connections[0].apiKeyLast4).toBe("****");
  });

  it("returns all connection fields (except raw apiKey) for multiple connections", async () => {
    // Validates that all mapped fields are correctly returned for each connection
    const conns = [
      makeConnection({
        id: "conn-1",
        name: "Workspace A",
        apiKey: "lin_api_aaaabbbb",
        workspaceName: "OrgA",
        workspaceId: "org-a",
        viewerName: "Alice",
        viewerEmail: "alice@example.com",
        connected: true,
        autoTransition: true,
        autoTransitionStateId: "state-1",
        autoTransitionStateName: "In Progress",
        archiveTransition: true,
        archiveTransitionStateId: "state-2",
        archiveTransitionStateName: "Done",
      }),
      makeConnection({
        id: "conn-2",
        name: "Workspace B",
        apiKey: "lin_api_ccccdddd",
        connected: false,
      }),
    ];
    mockListConnections.mockReturnValue(conns);

    const res = await app.request("/api/linear/connections");
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.connections).toHaveLength(2);

    // First connection: verify all fields
    const c1 = json.connections[0];
    expect(c1.id).toBe("conn-1");
    expect(c1.name).toBe("Workspace A");
    expect(c1.apiKeyLast4).toBe("****bbbb");
    expect(c1.workspaceName).toBe("OrgA");
    expect(c1.workspaceId).toBe("org-a");
    expect(c1.viewerName).toBe("Alice");
    expect(c1.viewerEmail).toBe("alice@example.com");
    expect(c1.connected).toBe(true);
    expect(c1.autoTransition).toBe(true);
    expect(c1.autoTransitionStateId).toBe("state-1");
    expect(c1.autoTransitionStateName).toBe("In Progress");
    expect(c1.archiveTransition).toBe(true);
    expect(c1.archiveTransitionStateId).toBe("state-2");
    expect(c1.archiveTransitionStateName).toBe("Done");

    // Second connection: spot check
    const c2 = json.connections[1];
    expect(c2.id).toBe("conn-2");
    expect(c2.connected).toBe(false);
  });
});

// =============================================================================
// POST /api/linear/connections
// =============================================================================

describe("POST /api/linear/connections", () => {
  it("returns 400 when name is missing", async () => {
    // Validates that the route rejects requests without a name field
    const res = await app.request("/api/linear/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "lin_api_somekey1234" }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("name is required");
  });

  it("returns 400 when name is empty string", async () => {
    // Validates that whitespace-only names are treated as empty
    const res = await app.request("/api/linear/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "  ", apiKey: "lin_api_somekey1234" }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("name is required");
  });

  it("returns 400 when apiKey is missing", async () => {
    // Validates that the route rejects requests without an apiKey field
    const res = await app.request("/api/linear/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "My Connection" }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("apiKey is required");
  });

  it("returns 400 when apiKey is empty string", async () => {
    // Validates that whitespace-only API keys are treated as empty
    const res = await app.request("/api/linear/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "My Connection", apiKey: "   " }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("apiKey is required");
  });

  it("creates a connection and verifies the API key successfully (201)", async () => {
    // Validates the happy path: API key is verified, connection is created with workspace info
    const fetchMock = mockFetch();
    fetchMock.mockResolvedValue(
      linearVerifyOk(
        { id: "user-1", name: "Test User", email: "test@example.com" },
        { id: "org-1", name: "TestOrg" },
      ),
    );

    const createdConn = makeConnection({
      id: "new-conn-id",
      name: "New Workspace",
      apiKey: "lin_api_newkey1234",
      connected: false,
    });
    mockCreateConnection.mockReturnValue(createdConn);

    // After updateConnection is called with verified info, getConnection returns the updated version
    const updatedConn = makeConnection({
      id: "new-conn-id",
      name: "New Workspace",
      apiKey: "lin_api_newkey1234",
      connected: true,
      workspaceName: "TestOrg",
      workspaceId: "org-1",
      viewerName: "Test User",
      viewerEmail: "test@example.com",
    });
    mockGetConnection.mockReturnValue(updatedConn);

    const res = await app.request("/api/linear/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "New Workspace", apiKey: "lin_api_newkey1234" }),
    });

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.verified).toBe(true);
    expect(json.error).toBeUndefined();
    expect(json.connection.id).toBe("new-conn-id");
    expect(json.connection.name).toBe("New Workspace");
    expect(json.connection.apiKeyLast4).toBe("****1234");
    expect(json.connection.workspaceName).toBe("TestOrg");
    expect(json.connection.connected).toBe(true);

    // Verify that updateConnection was called with workspace info
    expect(mockUpdateConnection).toHaveBeenCalledWith("new-conn-id", {
      connected: true,
      workspaceName: "TestOrg",
      workspaceId: "org-1",
      viewerName: "Test User",
      viewerEmail: "test@example.com",
    });
  });

  it("does not create a connection when verification fails (422)", async () => {
    // Validates that no connection is persisted when the API key verification fails
    const fetchMock = mockFetch();
    fetchMock.mockResolvedValue(linearError("Authentication failed"));

    const res = await app.request("/api/linear/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Bad Key Workspace", apiKey: "lin_api_badkey1234" }),
    });

    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.verified).toBe(false);
    expect(json.error).toBe("Authentication failed");
    expect(json.connection).toBeNull();

    // createConnection should NOT have been called because verification failed
    expect(mockCreateConnection).not.toHaveBeenCalled();
    expect(mockUpdateConnection).not.toHaveBeenCalled();
  });

  it("does not create a connection on non-ok HTTP response (422)", async () => {
    // Validates that a non-200 HTTP response from Linear results in no connection being created
    const fetchMock = mockFetch();
    fetchMock.mockResolvedValue(linearHttpError("Unauthorized", 401));

    const res = await app.request("/api/linear/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Workspace", apiKey: "lin_api_key12345" }),
    });

    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.verified).toBe(false);
    expect(json.error).toBe("Unauthorized");
    expect(json.connection).toBeNull();
    expect(mockCreateConnection).not.toHaveBeenCalled();
  });

  it("does not create a connection on network error (422)", async () => {
    // Validates that a network error (fetch throws) results in no connection being created
    const fetchMock = mockFetch();
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

    const res = await app.request("/api/linear/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Workspace", apiKey: "lin_api_key12345" }),
    });

    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.verified).toBe(false);
    expect(json.error).toBe("ECONNREFUSED");
    expect(json.connection).toBeNull();
    expect(mockCreateConnection).not.toHaveBeenCalled();
  });

  it("handles malformed JSON body gracefully", async () => {
    // Validates that the route handles non-JSON body without crashing
    const res = await app.request("/api/linear/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-valid-json",
    });
    // Body parse fails silently (returns {}), so name is missing
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("name is required");
  });

  it("does not create a connection on non-Error throw during verification", async () => {
    // Validates the catch block handles non-Error thrown values without creating a connection
    const fetchMock = mockFetch();
    fetchMock.mockRejectedValue("string error");

    const res = await app.request("/api/linear/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Workspace", apiKey: "lin_api_key12345" }),
    });

    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.verified).toBe(false);
    expect(json.connection).toBeNull();
    expect(json.error).toBe("Verification failed");
    expect(mockCreateConnection).not.toHaveBeenCalled();
  });

  it("handles verification response with null viewer/organization fields", async () => {
    // Validates that null viewer and organization fields default to empty strings
    const fetchMock = mockFetch();
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            viewer: null,
            organization: null,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const createdConn = makeConnection({ id: "new-conn-id", connected: false });
    mockCreateConnection.mockReturnValue(createdConn);

    const updatedConn = makeConnection({ id: "new-conn-id", connected: true });
    mockGetConnection.mockReturnValue(updatedConn);

    const res = await app.request("/api/linear/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Workspace", apiKey: "lin_api_key12345" }),
    });

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.verified).toBe(true);

    // Should update with empty strings for null fields
    expect(mockUpdateConnection).toHaveBeenCalledWith("new-conn-id", {
      connected: true,
      workspaceName: "",
      workspaceId: "",
      viewerName: "",
      viewerEmail: "",
    });
  });

  it("handles verification response where json parsing fails (returns {})", async () => {
    // Validates that if response.json() fails (e.g., invalid JSON body from Linear),
    // the route handles it gracefully by treating it as a verification failure
    const fetchMock = mockFetch();
    fetchMock.mockResolvedValue(
      new Response("not json at all", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const createdConn = makeConnection({ id: "new-conn-id", connected: false });
    mockCreateConnection.mockReturnValue(createdConn);

    const updatedConn = makeConnection({ id: "new-conn-id", connected: true });
    mockGetConnection.mockReturnValue(updatedConn);

    const res = await app.request("/api/linear/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Workspace", apiKey: "lin_api_key12345" }),
    });

    expect(res.status).toBe(201);
    const json = await res.json();
    // response.ok is true, but json parses to {} so no errors array
    // This means verification succeeds with empty strings for fields
    expect(json.verified).toBe(true);
  });
});

// =============================================================================
// PUT /api/linear/connections/:id
// =============================================================================

describe("PUT /api/linear/connections/:id", () => {
  it("returns 404 when connection is not found", async () => {
    // Validates that updating a nonexistent connection returns 404
    mockGetConnection.mockReturnValue(null);

    const res = await app.request("/api/linear/connections/nonexistent-id", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Updated" }),
    });
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("Connection not found");
  });

  it("updates connection name successfully", async () => {
    // Validates that updating just the name field works and returns the updated connection
    const existing = makeConnection({ id: "conn-1" });
    mockGetConnection.mockReturnValue(existing);

    const updated = makeConnection({ id: "conn-1", name: "Updated Name" });
    mockUpdateConnection.mockReturnValue(updated);

    const res = await app.request("/api/linear/connections/conn-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Updated Name" }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.connection.name).toBe("Updated Name");
    expect(json.connection.apiKeyLast4).toBe("****1234");

    // Cache should be invalidated for this connection
    expect(vi.mocked(linearCache.invalidate)).toHaveBeenCalledWith("conn-1:");
  });

  it("updates apiKey and sets connected to false", async () => {
    // Validates that changing the API key marks the connection as needing re-verification
    const existing = makeConnection({ id: "conn-1", connected: true });
    mockGetConnection.mockReturnValue(existing);

    const updated = makeConnection({
      id: "conn-1",
      apiKey: "lin_api_newkey5678",
      connected: false,
    });
    mockUpdateConnection.mockReturnValue(updated);

    const res = await app.request("/api/linear/connections/conn-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "lin_api_newkey5678" }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.connection.connected).toBe(false);
    expect(json.connection.apiKeyLast4).toBe("****5678");

    // Verify the patch includes connected: false when apiKey changes
    expect(mockUpdateConnection).toHaveBeenCalledWith(
      "conn-1",
      expect.objectContaining({
        apiKey: "lin_api_newkey5678",
        connected: false,
      }),
    );
  });

  it("ignores empty apiKey (whitespace only)", async () => {
    // Validates that an empty/whitespace apiKey is not included in the patch
    const existing = makeConnection({ id: "conn-1" });
    mockGetConnection.mockReturnValue(existing);

    const updated = makeConnection({ id: "conn-1", name: "Same" });
    mockUpdateConnection.mockReturnValue(updated);

    const res = await app.request("/api/linear/connections/conn-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Same", apiKey: "   " }),
    });

    expect(res.status).toBe(200);
    // The patch should contain name but NOT apiKey since it was whitespace
    expect(mockUpdateConnection).toHaveBeenCalledWith(
      "conn-1",
      expect.not.objectContaining({ apiKey: expect.anything() }),
    );
  });

  it("updates autoTransition and archiveTransition boolean fields", async () => {
    // Validates that boolean fields like autoTransition and archiveTransition are accepted
    const existing = makeConnection({ id: "conn-1" });
    mockGetConnection.mockReturnValue(existing);

    const updated = makeConnection({
      id: "conn-1",
      autoTransition: true,
      autoTransitionStateId: "state-1",
      autoTransitionStateName: "In Progress",
      archiveTransition: true,
      archiveTransitionStateId: "state-2",
      archiveTransitionStateName: "Done",
    });
    mockUpdateConnection.mockReturnValue(updated);

    const res = await app.request("/api/linear/connections/conn-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        autoTransition: true,
        autoTransitionStateId: "state-1",
        autoTransitionStateName: "In Progress",
        archiveTransition: true,
        archiveTransitionStateId: "state-2",
        archiveTransitionStateName: "Done",
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.connection.autoTransition).toBe(true);
    expect(json.connection.autoTransitionStateName).toBe("In Progress");
    expect(json.connection.archiveTransition).toBe(true);
    expect(json.connection.archiveTransitionStateName).toBe("Done");

    expect(mockUpdateConnection).toHaveBeenCalledWith(
      "conn-1",
      expect.objectContaining({
        autoTransition: true,
        autoTransitionStateId: "state-1",
        autoTransitionStateName: "In Progress",
        archiveTransition: true,
        archiveTransitionStateId: "state-2",
        archiveTransitionStateName: "Done",
      }),
    );
  });

  it("returns 500 when updateConnection returns null (update failed)", async () => {
    // Validates the error path when updateConnection returns null (unexpected failure)
    const existing = makeConnection({ id: "conn-1" });
    mockGetConnection.mockReturnValue(existing);
    mockUpdateConnection.mockReturnValue(null);

    const res = await app.request("/api/linear/connections/conn-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Updated" }),
    });

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe("Update failed");
  });

  it("handles malformed JSON body gracefully", async () => {
    // Validates that the route handles non-JSON body without crashing
    const existing = makeConnection({ id: "conn-1" });
    mockGetConnection.mockReturnValue(existing);

    // Empty patch should still work (no fields to update)
    const updated = makeConnection({ id: "conn-1" });
    mockUpdateConnection.mockReturnValue(updated);

    const res = await app.request("/api/linear/connections/conn-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "not-valid-json",
    });

    // Body parse fails silently to {}, so an empty patch is applied
    expect(res.status).toBe(200);
  });
});

// =============================================================================
// DELETE /api/linear/connections/:id
// =============================================================================

describe("DELETE /api/linear/connections/:id", () => {
  it("returns 404 when connection is not found", async () => {
    // Validates that deleting a nonexistent connection returns 404
    mockDeleteConnection.mockReturnValue(false);

    const res = await app.request("/api/linear/connections/nonexistent-id", {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("Connection not found");
  });

  it("deletes a connection successfully and invalidates cache", async () => {
    // Validates the happy path: connection is deleted and cache is invalidated
    mockDeleteConnection.mockReturnValue(true);

    const res = await app.request("/api/linear/connections/conn-1", {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);

    // deleteConnection should have been called with the connection ID
    expect(mockDeleteConnection).toHaveBeenCalledWith("conn-1");

    // Cache should be invalidated for this connection's prefix
    expect(vi.mocked(linearCache.invalidate)).toHaveBeenCalledWith("conn-1:");
  });
});

// =============================================================================
// POST /api/linear/connections/:id/verify
// =============================================================================

describe("POST /api/linear/connections/:id/verify", () => {
  it("returns 404 when connection is not found", async () => {
    // Validates that verifying a nonexistent connection returns 404
    mockGetConnection.mockReturnValue(null);

    const res = await app.request("/api/linear/connections/nonexistent-id/verify", {
      method: "POST",
    });
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("Connection not found");
  });

  it("re-verifies a connection successfully", async () => {
    // Validates the happy path: the connection's stored API key is used for verification
    // and the connection is updated with workspace info
    const conn = makeConnection({
      id: "conn-1",
      apiKey: "lin_api_existingkey1234",
      connected: false,
      workspaceName: "",
      viewerName: "",
    });
    mockGetConnection
      .mockReturnValueOnce(conn) // first call: find existing connection
      .mockReturnValueOnce(
        makeConnection({
          id: "conn-1",
          apiKey: "lin_api_existingkey1234",
          connected: true,
          workspaceName: "Verified Org",
          workspaceId: "org-v",
          viewerName: "Verified User",
          viewerEmail: "verified@example.com",
        }),
      ); // second call: return updated connection after updateConnection

    const fetchMock = mockFetch();
    fetchMock.mockResolvedValue(
      linearVerifyOk(
        { id: "user-v", name: "Verified User", email: "verified@example.com" },
        { id: "org-v", name: "Verified Org" },
      ),
    );

    const res = await app.request("/api/linear/connections/conn-1/verify", {
      method: "POST",
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.verified).toBe(true);
    expect(json.error).toBeUndefined();
    expect(json.connection.id).toBe("conn-1");
    expect(json.connection.connected).toBe(true);
    expect(json.connection.workspaceName).toBe("Verified Org");
    expect(json.connection.viewerName).toBe("Verified User");
    expect(json.connection.viewerEmail).toBe("verified@example.com");
    expect(json.connection.apiKeyLast4).toBe("****1234");

    // updateConnection should be called with connected: true and workspace info
    expect(mockUpdateConnection).toHaveBeenCalledWith("conn-1", {
      connected: true,
      workspaceName: "Verified Org",
      workspaceId: "org-v",
      viewerName: "Verified User",
      viewerEmail: "verified@example.com",
    });
  });

  it("marks connection as disconnected when verification fails", async () => {
    // Validates that a failed verification sets connected to false but preserves
    // existing workspace info
    const existingConn = makeConnection({
      id: "conn-1",
      apiKey: "lin_api_badkey1234",
      connected: true,
      workspaceName: "OldOrg",
      workspaceId: "org-old",
      viewerName: "OldUser",
      viewerEmail: "old@example.com",
    });
    mockGetConnection
      .mockReturnValueOnce(existingConn) // first call
      .mockReturnValueOnce(
        makeConnection({
          ...existingConn,
          connected: false,
        }),
      ); // second call after updateConnection

    const fetchMock = mockFetch();
    fetchMock.mockResolvedValue(linearError("Invalid token"));

    const res = await app.request("/api/linear/connections/conn-1/verify", {
      method: "POST",
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.verified).toBe(false);
    expect(json.error).toBe("Invalid token");
    expect(json.connection.connected).toBe(false);

    // When verification fails, updateConnection should preserve existing workspace info
    expect(mockUpdateConnection).toHaveBeenCalledWith("conn-1", {
      connected: false,
      workspaceName: "OldOrg",
      workspaceId: "org-old",
      viewerName: "OldUser",
      viewerEmail: "old@example.com",
    });
  });

  it("handles network error during verification", async () => {
    // Validates that a network error during verification (fetch throws)
    // results in the connection being marked as disconnected
    const existingConn = makeConnection({
      id: "conn-1",
      apiKey: "lin_api_key12345678",
      connected: true,
      workspaceName: "PrevOrg",
      workspaceId: "org-prev",
      viewerName: "PrevUser",
      viewerEmail: "prev@example.com",
    });
    mockGetConnection
      .mockReturnValueOnce(existingConn)
      .mockReturnValueOnce(makeConnection({ ...existingConn, connected: false }));

    const fetchMock = mockFetch();
    fetchMock.mockRejectedValue(new Error("DNS resolution failed"));

    const res = await app.request("/api/linear/connections/conn-1/verify", {
      method: "POST",
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.verified).toBe(false);
    expect(json.error).toBe("DNS resolution failed");

    // Should mark as disconnected but keep existing workspace info
    expect(mockUpdateConnection).toHaveBeenCalledWith("conn-1", {
      connected: false,
      workspaceName: "PrevOrg",
      workspaceId: "org-prev",
      viewerName: "PrevUser",
      viewerEmail: "prev@example.com",
    });
  });

  it("handles HTTP error response during verification", async () => {
    // Validates that a non-ok HTTP status from Linear results in failed verification
    const existingConn = makeConnection({
      id: "conn-1",
      apiKey: "lin_api_key12345678",
      workspaceName: "Existing",
      workspaceId: "org-e",
      viewerName: "ExUser",
      viewerEmail: "ex@example.com",
    });
    mockGetConnection
      .mockReturnValueOnce(existingConn)
      .mockReturnValueOnce(makeConnection({ ...existingConn, connected: false }));

    const fetchMock = mockFetch();
    fetchMock.mockResolvedValue(linearHttpError("Service Unavailable", 503));

    const res = await app.request("/api/linear/connections/conn-1/verify", {
      method: "POST",
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.verified).toBe(false);
    expect(json.error).toBe("Service Unavailable");
  });
});
