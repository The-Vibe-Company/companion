import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Mock settings-manager ──────────────────────────────────────────────────
// Returns a settings object; tests override linearApiKey as needed.
const mockSettings = {
  linearApiKey: "lin_api_test_key",
  linearAutoTransition: false,
  linearAutoTransitionStateId: "",
  linearAutoTransitionStateName: "",
    linearArchiveTransition: false,
    linearArchiveTransitionStateId: "",
    linearArchiveTransitionStateName: "",
};

vi.mock("../settings-manager.js", () => ({
  getSettings: vi.fn(() => ({ ...mockSettings })),
}));

// ─── Mock linear-cache ──────────────────────────────────────────────────────
// By default getOrFetch simply executes the fetcher so that we can test the
// fetch / response-parsing logic inside each route handler.
vi.mock("../linear-cache.js", () => ({
  linearCache: {
    getOrFetch: vi.fn(async (_key: string, _ttl: number, fetcher: () => Promise<unknown>) => fetcher()),
    invalidate: vi.fn(),
    clear: vi.fn(),
  },
}));

// ─── Mock session-linear-issues ─────────────────────────────────────────────
vi.mock("../session-linear-issues.js", () => ({
  getLinearIssue: vi.fn(() => undefined),
  setLinearIssue: vi.fn(),
  removeLinearIssue: vi.fn(),
}));

// ─── Mock linear-project-manager ────────────────────────────────────────────
vi.mock("../linear-project-manager.js", () => ({
  getMapping: vi.fn(() => null),
  listMappings: vi.fn(() => []),
  upsertMapping: vi.fn((_root: string, data: { projectId: string; projectName: string }) => ({
    repoRoot: _root,
    ...data,
    createdAt: 1000,
    updatedAt: 1000,
  })),
  removeMapping: vi.fn(() => false),
}));

// ─── Mock linear-connections ────────────────────────────────────────────────
// resolveApiKey returns the test key by default; tests set it to null for "no key" scenarios.
const mockResolveApiKey = vi.fn<() => { apiKey: string; connectionId: string } | null>(
  () => ({ apiKey: "lin_api_test_key", connectionId: "test-conn" }),
);
const mockGetConnection = vi.fn(() => null);

vi.mock("../linear-connections.js", () => ({
  resolveApiKey: (...args: unknown[]) => mockResolveApiKey(),
  getConnection: (...args: unknown[]) => mockGetConnection(),
}));

// ─── Imports (after mocks are declared) ─────────────────────────────────────
import { Hono } from "hono";
import { getSettings } from "../settings-manager.js";
import { linearCache } from "../linear-cache.js";
import * as sessionLinearIssues from "../session-linear-issues.js";
import * as linearProjectManager from "../linear-project-manager.js";
import { registerLinearRoutes, transitionLinearIssue, fetchLinearTeamStates } from "./linear-routes.js";

// ─── Test setup ─────────────────────────────────────────────────────────────

let app: Hono;

// Save original global fetch so we can restore it
const originalFetch = globalThis.fetch;

/** Helper to mock globalThis.fetch without TS errors about missing `preconnect` */
function mockFetch() {
  const fn = vi.fn();
  globalThis.fetch = fn as any;
  return fn;
}

beforeEach(() => {
  vi.clearAllMocks();

  // Reset settings to defaults for each test
  mockSettings.linearApiKey = "lin_api_test_key";
  mockSettings.linearAutoTransition = false;
  mockSettings.linearAutoTransitionStateId = "";
  mockSettings.linearAutoTransitionStateName = "";

  // Reset linear-connections mock to return the test key by default
  mockResolveApiKey.mockReturnValue({ apiKey: "lin_api_test_key", connectionId: "test-conn" });
  mockGetConnection.mockReturnValue(null);

  // Restore global fetch to prevent leaks between tests
  globalThis.fetch = originalFetch;

  app = new Hono();
  const api = new Hono();
  registerLinearRoutes(api);
  app.route("/api", api);
});

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Build a successful Linear GraphQL response. */
function linearOk(data: Record<string, unknown>) {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Build a Linear GraphQL error response. */
function linearError(message: string, status = 200) {
  return new Response(
    JSON.stringify({ errors: [{ message }] }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

/** Build a non-ok HTTP response (e.g. 500). */
function linearHttpError(statusText = "Internal Server Error", status = 500) {
  return new Response(JSON.stringify({}), {
    status,
    statusText,
    headers: { "Content-Type": "application/json" },
  });
}

/** Make a standard issue node from the Linear search response shape. */
function makeIssueNode(overrides: Record<string, unknown> = {}) {
  return {
    id: "issue-1",
    identifier: "COMP-1",
    title: "Test issue",
    description: "A test issue description",
    url: "https://linear.app/test/issue/COMP-1",
    branchName: "comp-1-test-issue",
    priorityLabel: "High",
    state: { name: "In Progress", type: "started" },
    team: { id: "team-1", key: "COMP", name: "Companion" },
    ...overrides,
  };
}

// =============================================================================
// GET /api/linear/issues
// =============================================================================

describe("GET /api/linear/issues", () => {
  it("returns empty array when no query is provided (covers line 22)", async () => {
    // When no query param is provided, the route returns { issues: [] } early
    const res = await app.request("/api/linear/issues");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ issues: [] });
  });

  it("returns empty array when query is whitespace only", async () => {
    const res = await app.request("/api/linear/issues?query=   ");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ issues: [] });
  });

  it("returns 400 when Linear API key is not configured", async () => {
    mockSettings.linearApiKey = "";
    mockResolveApiKey.mockReturnValue(null);
    const res = await app.request("/api/linear/issues?query=test");
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/no linear connection configured/i);
  });

  it("searches Linear and returns mapped issues, filtering out completed/canceled (covers lines 87-108)", async () => {
    // Mock global fetch to simulate Linear API response with mixed states
    mockFetch().mockResolvedValue(
      linearOk({
        searchIssues: {
          nodes: [
            makeIssueNode({ id: "1", identifier: "C-1", state: { name: "In Progress", type: "started" } }),
            makeIssueNode({ id: "2", identifier: "C-2", state: { name: "Todo", type: "unstarted" } }),
            makeIssueNode({ id: "3", identifier: "C-3", state: { name: "Done", type: "completed" } }),
            makeIssueNode({ id: "4", identifier: "C-4", state: { name: "Cancelled", type: "cancelled" } }),
          ],
        },
      }),
    );

    const res = await app.request("/api/linear/issues?query=test&limit=10");
    expect(res.status).toBe(200);
    const json = await res.json();

    // Completed/canceled issues should be filtered out
    expect(json.issues).toHaveLength(2);
    // Unstarted (0) should sort before started (1)
    expect(json.issues[0].identifier).toBe("C-2");
    expect(json.issues[1].identifier).toBe("C-1");

    // Verify mapped fields are present (covers lines 95-99)
    const issue = json.issues[0];
    expect(issue).toHaveProperty("stateName");
    expect(issue).toHaveProperty("stateType");
    expect(issue).toHaveProperty("teamName");
    expect(issue).toHaveProperty("teamKey");
    expect(issue).toHaveProperty("teamId");
  });

  it("clamps limit between 1 and 20", async () => {
    mockFetch().mockResolvedValue(
      linearOk({ searchIssues: { nodes: [] } }),
    );

    // Test limit > 20 gets clamped
    await app.request("/api/linear/issues?query=test&limit=100");
    const fetchCall = vi.mocked(globalThis.fetch as any).mock.calls[0];
    const body = JSON.parse(fetchCall[1]?.body as string);
    expect(body.variables.first).toBe(20);
  });

  it("returns 502 when Linear API returns errors (covers lines 106-108)", async () => {
    mockFetch().mockResolvedValue(
      linearError("Authentication failed"),
    );

    const res = await app.request("/api/linear/issues?query=test");
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error).toBe("Authentication failed");
  });

  it("returns 502 when Linear API returns non-ok HTTP status", async () => {
    mockFetch().mockResolvedValue(
      linearHttpError("Unauthorized", 401),
    );

    const res = await app.request("/api/linear/issues?query=test");
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error).toBe("Unauthorized");
  });

  it("returns 502 when fetch itself throws (network error)", async () => {
    mockFetch().mockRejectedValue(new Error("ECONNREFUSED"));

    const res = await app.request("/api/linear/issues?query=test");
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error).toMatch(/Failed to connect to Linear/);
  });

  it("handles issues with null optional fields gracefully (covers lines 87-100)", async () => {
    mockFetch().mockResolvedValue(
      linearOk({
        searchIssues: {
          nodes: [
            {
              id: "issue-null",
              identifier: "C-99",
              title: "Null fields",
              description: null,
              url: "https://linear.app/test",
              branchName: null,
              priorityLabel: null,
              state: null,
              team: null,
            },
          ],
        },
      }),
    );

    const res = await app.request("/api/linear/issues?query=test");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.issues).toHaveLength(1);
    expect(json.issues[0].description).toBe("");
    expect(json.issues[0].branchName).toBe("");
    expect(json.issues[0].priorityLabel).toBe("");
    expect(json.issues[0].stateName).toBe("");
    expect(json.issues[0].stateType).toBe("");
    expect(json.issues[0].teamName).toBe("");
    expect(json.issues[0].teamKey).toBe("");
    expect(json.issues[0].teamId).toBe("");
  });
});

// =============================================================================
// GET /api/linear/connection
// =============================================================================

describe("GET /api/linear/connection", () => {
  it("returns 400 when API key is empty (covers lines 113-116)", async () => {
    mockSettings.linearApiKey = "";
    mockResolveApiKey.mockReturnValue(null);
    const res = await app.request("/api/linear/connection");
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/no linear connection configured/i);
  });

  it("returns connection info with viewer and team (covers lines 118-120, 124-128)", async () => {
    mockFetch().mockResolvedValue(
      linearOk({
        viewer: { id: "user-1", name: "Test User", email: "test@example.com" },
        teams: { nodes: [{ id: "team-1", key: "COMP", name: "Companion" }] },
      }),
    );

    const res = await app.request("/api/linear/connection");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.connected).toBe(true);
    expect(json.viewerName).toBe("Test User");
    expect(json.viewerEmail).toBe("test@example.com");
    expect(json.teamName).toBe("Companion");
    expect(json.teamKey).toBe("COMP");
  });

  it("returns 502 when Linear API returns errors", async () => {
    mockFetch().mockResolvedValue(
      linearError("Invalid API key"),
    );

    const res = await app.request("/api/linear/connection");
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error).toBe("Invalid API key");
  });

  it("returns 502 when fetch throws a network error", async () => {
    mockFetch().mockRejectedValue(new Error("Network down"));

    const res = await app.request("/api/linear/connection");
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error).toMatch(/Failed to connect to Linear/);
  });
});

// =============================================================================
// PUT /api/sessions/:id/linear-issue
// =============================================================================

describe("PUT /api/sessions/:id/linear-issue", () => {
  it("returns 400 when required fields are missing (covers line 172-173)", async () => {
    const res = await app.request("/api/sessions/sess-1/linear-issue", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "issue-1" }), // missing identifier, title, url
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/required/i);
  });

  it("stores the linear issue and returns ok (covers lines 167-191)", async () => {
    const issueBody = {
      id: "issue-1",
      identifier: "COMP-1",
      title: "Test Issue",
      description: "Some description",
      url: "https://linear.app/test/issue/COMP-1",
      branchName: "comp-1-test",
      priorityLabel: "High",
      stateName: "In Progress",
      stateType: "started",
      teamName: "Companion",
      teamKey: "COMP",
      teamId: "team-1",
      assigneeName: "John Doe",
      updatedAt: "2025-01-01T00:00:00Z",
    };

    const res = await app.request("/api/sessions/sess-1/linear-issue", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(issueBody),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sessionLinearIssues.setLinearIssue).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({
        id: "issue-1",
        identifier: "COMP-1",
        title: "Test Issue",
        assigneeName: "John Doe",
        updatedAt: "2025-01-01T00:00:00Z",
      }),
    );
  });

  it("stores issue with optional fields defaulting to empty string (covers lines 179-190)", async () => {
    const issueBody = {
      id: "issue-2",
      identifier: "COMP-2",
      title: "Minimal Issue",
      url: "https://linear.app/test/issue/COMP-2",
      // No optional fields: description, branchName, etc.
    };

    const res = await app.request("/api/sessions/sess-2/linear-issue", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(issueBody),
    });

    expect(res.status).toBe(200);
    expect(sessionLinearIssues.setLinearIssue).toHaveBeenCalledWith(
      "sess-2",
      expect.objectContaining({
        description: "",
        branchName: "",
        priorityLabel: "",
        assigneeName: undefined,
        updatedAt: undefined,
      }),
    );
  });

  it("handles malformed JSON body gracefully", async () => {
    const res = await app.request("/api/sessions/sess-1/linear-issue", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    // Body parses as {} so required fields are missing
    expect(res.status).toBe(400);
  });
});

// =============================================================================
// GET /api/sessions/:id/linear-issue
// =============================================================================

describe("GET /api/sessions/:id/linear-issue", () => {
  it("returns null when no issue is stored (covers lines 195-197)", async () => {
    vi.mocked(sessionLinearIssues.getLinearIssue).mockReturnValue(undefined);

    const res = await app.request("/api/sessions/sess-1/linear-issue");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ issue: null });
  });

  it("returns stored issue without refresh by default (covers lines 199-200)", async () => {
    const stored = {
      id: "issue-1",
      identifier: "COMP-1",
      title: "Stored issue",
      description: "",
      url: "https://linear.app/test",
      branchName: "",
      priorityLabel: "",
      stateName: "Todo",
      stateType: "unstarted",
      teamName: "Comp",
      teamKey: "COMP",
      teamId: "team-1",
    };
    vi.mocked(sessionLinearIssues.getLinearIssue).mockReturnValue(stored);

    const res = await app.request("/api/sessions/sess-1/linear-issue");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.issue).toEqual(stored);
  });

  it("returns stored issue when refresh=true but no API key (covers line 205)", async () => {
    const stored = {
      id: "issue-1",
      identifier: "COMP-1",
      title: "Stored issue",
      description: "",
      url: "https://linear.app/test",
      branchName: "",
      priorityLabel: "",
      stateName: "Todo",
      stateType: "unstarted",
      teamName: "Comp",
      teamKey: "COMP",
      teamId: "team-1",
    };
    vi.mocked(sessionLinearIssues.getLinearIssue).mockReturnValue(stored);
    mockSettings.linearApiKey = "";
    mockResolveApiKey.mockReturnValue(null);

    const res = await app.request("/api/sessions/sess-1/linear-issue?refresh=true");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.issue).toEqual(stored);
  });

  it("refreshes from Linear API and returns updated data with comments/labels (covers refresh path)", async () => {
    const stored = {
      id: "issue-1",
      identifier: "COMP-1",
      title: "Old title",
      description: "",
      url: "https://linear.app/test",
      branchName: "",
      priorityLabel: "",
      stateName: "Todo",
      stateType: "unstarted",
      teamName: "Comp",
      teamKey: "COMP",
      teamId: "team-1",
    };
    vi.mocked(sessionLinearIssues.getLinearIssue).mockReturnValue(stored);

    mockFetch().mockResolvedValue(
      linearOk({
        issue: {
          id: "issue-1",
          identifier: "COMP-1",
          title: "Updated title",
          description: "Updated desc",
          url: "https://linear.app/test/issue/COMP-1",
          branchName: "comp-1-updated",
          priorityLabel: "Urgent",
          state: { name: "In Progress", type: "started" },
          team: { id: "team-1", key: "COMP", name: "Companion" },
          comments: {
            nodes: [
              {
                id: "comment-1",
                body: "A comment",
                createdAt: "2025-01-01T00:00:00Z",
                user: { name: "John", displayName: "Johnny", avatarUrl: "https://avatar.url" },
              },
            ],
          },
          assignee: { name: "Jane", displayName: "Jane Doe", avatarUrl: "https://jane.url" },
          labels: { nodes: [{ id: "label-1", name: "Bug", color: "#ff0000" }] },
        },
      }),
    );

    const res = await app.request("/api/sessions/sess-1/linear-issue?refresh=true");
    expect(res.status).toBe(200);
    const json = await res.json();

    // Updated issue fields
    expect(json.issue.title).toBe("Updated title");
    expect(json.issue.description).toBe("Updated desc");
    expect(json.issue.stateName).toBe("In Progress");
    expect(json.issue.assigneeName).toBe("Jane Doe");

    // Comments
    expect(json.comments).toHaveLength(1);
    expect(json.comments[0].body).toBe("A comment");
    expect(json.comments[0].userName).toBe("Johnny");
    expect(json.comments[0].userAvatarUrl).toBe("https://avatar.url");

    // Assignee
    expect(json.assignee.name).toBe("Jane Doe");
    expect(json.assignee.avatarUrl).toBe("https://jane.url");

    // Labels
    expect(json.labels).toHaveLength(1);
    expect(json.labels[0].name).toBe("Bug");

    // setLinearIssue should have been called with updated data
    expect(sessionLinearIssues.setLinearIssue).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ title: "Updated title" }),
    );
  });

  it("falls back to stored issue when refresh fetch throws", async () => {
    const stored = {
      id: "issue-1",
      identifier: "COMP-1",
      title: "Stored",
      description: "",
      url: "https://linear.app/test",
      branchName: "",
      priorityLabel: "",
      stateName: "Todo",
      stateType: "unstarted",
      teamName: "Comp",
      teamKey: "COMP",
      teamId: "team-1",
    };
    vi.mocked(sessionLinearIssues.getLinearIssue).mockReturnValue(stored);

    // Make the cache's getOrFetch throw so we exercise the catch block
    vi.mocked(linearCache.getOrFetch).mockRejectedValueOnce(new Error("Network error"));

    const res = await app.request("/api/sessions/sess-1/linear-issue?refresh=true");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.issue).toEqual(stored);
  });

  it("falls back to stored issue when Linear returns null issue", async () => {
    const stored = {
      id: "issue-1",
      identifier: "COMP-1",
      title: "Stored",
      description: "",
      url: "https://linear.app/test",
      branchName: "",
      priorityLabel: "",
      stateName: "Todo",
      stateType: "unstarted",
      teamName: "Comp",
      teamKey: "COMP",
      teamId: "team-1",
    };
    vi.mocked(sessionLinearIssues.getLinearIssue).mockReturnValue(stored);

    mockFetch().mockResolvedValue(
      linearOk({ issue: null }),
    );

    const res = await app.request("/api/sessions/sess-1/linear-issue?refresh=true");
    expect(res.status).toBe(200);
    const json = await res.json();
    // Falls through to stored data since result is null
    expect(json.issue).toEqual(stored);
  });
});

// =============================================================================
// DELETE /api/sessions/:id/linear-issue
// =============================================================================

describe("DELETE /api/sessions/:id/linear-issue", () => {
  it("removes the issue and returns ok (covers lines 311-315)", async () => {
    const res = await app.request("/api/sessions/sess-1/linear-issue", {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sessionLinearIssues.removeLinearIssue).toHaveBeenCalledWith("sess-1");
  });
});

// =============================================================================
// POST /api/linear/issues/:issueId/comments
// =============================================================================

describe("POST /api/linear/issues/:issueId/comments", () => {
  it("returns 400 when body text is missing (covers lines 320-322)", async () => {
    const res = await app.request("/api/linear/issues/issue-1/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/body is required/i);
  });

  it("returns 400 when body is whitespace only", async () => {
    const res = await app.request("/api/linear/issues/issue-1/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "   " }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when Linear API key is not configured (covers lines 324-328)", async () => {
    mockSettings.linearApiKey = "";
    mockResolveApiKey.mockReturnValue(null);
    const res = await app.request("/api/linear/issues/issue-1/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Hello" }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/no linear connection configured/i);
  });

  it("creates a comment and returns it (covers lines 330-388)", async () => {
    mockFetch().mockResolvedValue(
      linearOk({
        commentCreate: {
          success: true,
          comment: {
            id: "comment-1",
            body: "Test comment",
            createdAt: "2025-01-01T00:00:00Z",
            user: { name: "Test", displayName: "Test User" },
          },
        },
      }),
    );

    const res = await app.request("/api/linear/issues/issue-1/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Test comment" }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.comment.id).toBe("comment-1");
    expect(json.comment.userName).toBe("Test User");
    expect(json.comment.userAvatarUrl).toBeNull();

    // Should invalidate cache for the issue with connectionId prefix
    expect(linearCache.invalidate).toHaveBeenCalledWith("test-conn:issue:issue-1");
  });

  it("returns 502 when Linear returns GraphQL errors (covers lines 366-369)", async () => {
    mockFetch().mockResolvedValue(
      linearError("Issue not found"),
    );

    const res = await app.request("/api/linear/issues/issue-1/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Test" }),
    });

    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error).toBe("Issue not found");
  });

  it("returns 502 when Linear returns non-ok HTTP (covers lines 366-369)", async () => {
    mockFetch().mockResolvedValue(
      linearHttpError("Server Error", 500),
    );

    const res = await app.request("/api/linear/issues/issue-1/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Test" }),
    });

    expect(res.status).toBe(502);
  });

  it("returns 502 when commentCreate reports failure (covers lines 371-373)", async () => {
    mockFetch().mockResolvedValue(
      linearOk({
        commentCreate: { success: false, comment: null },
      }),
    );

    const res = await app.request("/api/linear/issues/issue-1/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Test" }),
    });

    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error).toBe("Comment creation failed");
  });

  it("handles fetch network error by throwing (covers line 347-348)", async () => {
    mockFetch().mockRejectedValue(new Error("ECONNREFUSED"));

    const res = await app.request("/api/linear/issues/issue-1/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Test" }),
    });

    // The route does not have a try/catch around the fetch for comments,
    // so Hono's error handler will produce a 500
    expect(res.status).toBe(500);
  });
});

// =============================================================================
// GET /api/linear/states
// =============================================================================

describe("GET /api/linear/states", () => {
  it("returns 400 when API key is empty", async () => {
    mockSettings.linearApiKey = "";
    mockResolveApiKey.mockReturnValue(null);
    const res = await app.request("/api/linear/states");
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/no linear connection configured/i);
  });

  it("returns mapped team states (covers lines 455-467)", async () => {
    mockFetch().mockResolvedValue(
      linearOk({
        teams: {
          nodes: [
            {
              id: "team-1",
              key: "COMP",
              name: "Companion",
              states: {
                nodes: [
                  { id: "state-1", name: "Todo", type: "unstarted" },
                  { id: "state-2", name: "In Progress", type: "started" },
                ],
              },
            },
          ],
        },
      }),
    );

    const res = await app.request("/api/linear/states");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.teams).toHaveLength(1);
    expect(json.teams[0].key).toBe("COMP");
    expect(json.teams[0].states).toHaveLength(2);
    expect(json.teams[0].states[0].name).toBe("Todo");
  });

  it("handles null/empty fields in team states (covers lines 456-463)", async () => {
    mockFetch().mockResolvedValue(
      linearOk({
        teams: {
          nodes: [
            {
              id: undefined,
              key: null,
              name: null,
              states: { nodes: [{ id: undefined, name: null, type: null }] },
            },
          ],
        },
      }),
    );

    const res = await app.request("/api/linear/states");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.teams[0].id).toBe("");
    expect(json.teams[0].key).toBe("");
    expect(json.teams[0].name).toBe("");
    expect(json.teams[0].states[0].id).toBe("");
    expect(json.teams[0].states[0].name).toBe("");
    expect(json.teams[0].states[0].type).toBe("");
  });

  it("returns 502 when fetchLinearTeamStates returns empty (Linear API error)", async () => {
    // fetchLinearTeamStates catches errors internally and returns [].
    // When it returns empty, the route returns a generic 502.
    mockFetch().mockResolvedValue(
      linearError("Rate limited"),
    );

    const res = await app.request("/api/linear/states");
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error).toBe("Failed to fetch Linear workflow states");
  });

  it("returns 502 when fetchLinearTeamStates returns empty (network error)", async () => {
    mockFetch().mockRejectedValue(new Error("timeout"));

    const res = await app.request("/api/linear/states");
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error).toBe("Failed to fetch Linear workflow states");
  });
});

// =============================================================================
// GET /api/linear/project-issues
// =============================================================================

describe("GET /api/linear/project-issues", () => {
  it("returns 400 when projectId is missing", async () => {
    const res = await app.request("/api/linear/project-issues");
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/projectId is required/i);
  });

  it("returns 400 when API key is not configured", async () => {
    mockSettings.linearApiKey = "";
    mockResolveApiKey.mockReturnValue(null);
    const res = await app.request("/api/linear/project-issues?projectId=proj-1");
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/no linear connection configured/i);
  });

  it("returns mapped project issues, filtering done and sorting by state (covers lines 580-628)", async () => {
    mockFetch().mockResolvedValue(
      linearOk({
        issues: {
          nodes: [
            {
              id: "i-1",
              identifier: "C-10",
              title: "Started issue",
              description: "desc",
              url: "https://linear.app/test",
              priorityLabel: "Medium",
              state: { name: "In Progress", type: "started" },
              team: { key: "COMP", name: "Companion" },
              assignee: { name: "Alice" },
              updatedAt: "2025-01-01T00:00:00Z",
            },
            {
              id: "i-2",
              identifier: "C-11",
              title: "Unstarted issue",
              description: null,
              url: "https://linear.app/test",
              priorityLabel: null,
              state: { name: "Backlog", type: "backlog" },
              team: { key: "COMP", name: "Companion" },
              assignee: null,
              updatedAt: null,
            },
            {
              id: "i-3",
              identifier: "C-12",
              title: "Done issue",
              description: "",
              url: "https://linear.app/test",
              priorityLabel: "Low",
              state: { name: "Done", type: "completed" },
              team: { key: "COMP", name: "Companion" },
              assignee: { name: "Bob" },
              updatedAt: "2025-01-02",
            },
          ],
        },
      }),
    );

    const res = await app.request("/api/linear/project-issues?projectId=proj-1&limit=15");
    expect(res.status).toBe(200);
    const json = await res.json();

    // Completed issue should be filtered out
    expect(json.issues).toHaveLength(2);
    // Backlog (0) sorts before started (1)
    expect(json.issues[0].identifier).toBe("C-11");
    expect(json.issues[1].identifier).toBe("C-10");

    // Verify null field defaults
    expect(json.issues[0].description).toBe("");
    expect(json.issues[0].priorityLabel).toBe("");
    expect(json.issues[0].assigneeName).toBe("");
    expect(json.issues[0].updatedAt).toBe("");
  });

  it("returns 502 when Linear API returns errors (covers lines 603-605)", async () => {
    mockFetch().mockResolvedValue(
      linearError("Auth error"),
    );

    const res = await app.request("/api/linear/project-issues?projectId=proj-1");
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error).toBe("Auth error");
  });

  it("returns 502 on network error (covers lines 627-628)", async () => {
    mockFetch().mockRejectedValue(new Error("connection reset"));

    const res = await app.request("/api/linear/project-issues?projectId=proj-1");
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error).toMatch(/Failed to connect to Linear/);
  });

  it("clamps limit to max 50 and min 1", async () => {
    mockFetch().mockResolvedValue(
      linearOk({ issues: { nodes: [] } }),
    );

    await app.request("/api/linear/project-issues?projectId=proj-1&limit=999");
    const fetchCall = vi.mocked(globalThis.fetch as any).mock.calls[0];
    const body = JSON.parse(fetchCall[1]?.body as string);
    expect(body.variables.first).toBe(50);
  });
});

// =============================================================================
// GET /api/linear/project-mappings
// =============================================================================

describe("GET /api/linear/project-mappings", () => {
  it("returns a specific mapping when repoRoot is provided", async () => {
    const mapping = {
      repoRoot: "/home/user/project",
      projectId: "proj-1",
      projectName: "Project One",
      createdAt: 1000,
      updatedAt: 1000,
    };
    vi.mocked(linearProjectManager.getMapping).mockReturnValue(mapping);

    const res = await app.request("/api/linear/project-mappings?repoRoot=/home/user/project");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.mapping).toEqual(mapping);
  });

  it("returns null mapping when repoRoot is not found", async () => {
    vi.mocked(linearProjectManager.getMapping).mockReturnValue(null);

    const res = await app.request("/api/linear/project-mappings?repoRoot=/nonexistent");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.mapping).toBeNull();
  });

  it("returns all mappings when no repoRoot is provided", async () => {
    const mappings = [
      { repoRoot: "/a", projectId: "p1", projectName: "P1", createdAt: 1, updatedAt: 1 },
      { repoRoot: "/b", projectId: "p2", projectName: "P2", createdAt: 2, updatedAt: 2 },
    ];
    vi.mocked(linearProjectManager.listMappings).mockReturnValue(mappings);

    const res = await app.request("/api/linear/project-mappings");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.mappings).toHaveLength(2);
  });
});

// =============================================================================
// PUT /api/linear/project-mappings
// =============================================================================

describe("PUT /api/linear/project-mappings", () => {
  it("returns 400 when required fields are missing", async () => {
    const res = await app.request("/api/linear/project-mappings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoRoot: "/test" }), // missing projectId, projectName
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/required/i);
  });

  it("creates/updates a mapping and returns it", async () => {
    const mapping = {
      repoRoot: "/test",
      projectId: "proj-1",
      projectName: "Project One",
      createdAt: 1000,
      updatedAt: 1000,
    };
    vi.mocked(linearProjectManager.upsertMapping).mockReturnValue(mapping);

    const res = await app.request("/api/linear/project-mappings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repoRoot: "/test",
        projectId: "proj-1",
        projectName: "Project One",
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.mapping).toEqual(mapping);
    expect(linearProjectManager.upsertMapping).toHaveBeenCalledWith("/test", {
      projectId: "proj-1",
      projectName: "Project One",
    });
  });
});

// =============================================================================
// DELETE /api/linear/project-mappings
// =============================================================================

describe("DELETE /api/linear/project-mappings", () => {
  it("returns 400 when repoRoot is missing", async () => {
    const res = await app.request("/api/linear/project-mappings", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/repoRoot is required/i);
  });

  it("returns 404 when mapping is not found", async () => {
    vi.mocked(linearProjectManager.removeMapping).mockReturnValue(false);

    const res = await app.request("/api/linear/project-mappings", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoRoot: "/nonexistent" }),
    });
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toMatch(/not found/i);
  });

  it("deletes the mapping and returns ok", async () => {
    vi.mocked(linearProjectManager.removeMapping).mockReturnValue(true);

    const res = await app.request("/api/linear/project-mappings", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoRoot: "/test" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

// =============================================================================
// POST /api/linear/issues/:id/transition
// =============================================================================

describe("POST /api/linear/issues/:id/transition", () => {
  it("returns 400 when API key is not configured (covers line 670+)", async () => {
    mockSettings.linearApiKey = "";
    mockResolveApiKey.mockReturnValue(null);
    const res = await app.request("/api/linear/issues/issue-1/transition", {
      method: "POST",
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/no linear connection configured/i);
  });

  it("returns skipped when auto-transition is disabled", async () => {
    mockSettings.linearAutoTransition = false;

    const res = await app.request("/api/linear/issues/issue-1/transition", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.skipped).toBe(true);
    expect(json.reason).toBe("auto_transition_disabled");
  });

  it("returns skipped when no target state is configured", async () => {
    mockSettings.linearAutoTransition = true;
    mockSettings.linearAutoTransitionStateId = "";

    const res = await app.request("/api/linear/issues/issue-1/transition", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.skipped).toBe(true);
    expect(json.reason).toBe("no_target_state_configured");
  });

  it("transitions the issue successfully and invalidates cache", async () => {
    mockSettings.linearAutoTransition = true;
    mockSettings.linearAutoTransitionStateId = "state-in-progress";

    mockFetch().mockResolvedValue(
      linearOk({
        issueUpdate: {
          success: true,
          issue: {
            id: "issue-1",
            identifier: "COMP-1",
            state: { name: "In Progress", type: "started" },
          },
        },
      }),
    );

    const res = await app.request("/api/linear/issues/issue-1/transition", {
      method: "POST",
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.skipped).toBe(false);
    expect(json.issue.identifier).toBe("COMP-1");
    expect(json.issue.stateName).toBe("In Progress");
    expect(json.issue.stateType).toBe("started");

    // Cache should be invalidated with connection prefix
    expect(linearCache.invalidate).toHaveBeenCalledWith("test-conn:issue:issue-1");
  });

  it("returns 502 when Linear returns GraphQL errors", async () => {
    mockSettings.linearAutoTransition = true;
    mockSettings.linearAutoTransitionStateId = "state-1";

    mockFetch().mockResolvedValue(
      linearError("State not found"),
    );

    const res = await app.request("/api/linear/issues/issue-1/transition", {
      method: "POST",
    });

    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error).toBe("State not found");
  });

  it("returns 502 when Linear returns non-ok HTTP", async () => {
    mockSettings.linearAutoTransition = true;
    mockSettings.linearAutoTransitionStateId = "state-1";

    mockFetch().mockResolvedValue(
      linearHttpError("Bad Gateway", 502),
    );

    const res = await app.request("/api/linear/issues/issue-1/transition", {
      method: "POST",
    });

    expect(res.status).toBe(502);
  });

  it("returns 502 when fetch throws a network error (covers lines 747-748)", async () => {
    mockSettings.linearAutoTransition = true;
    mockSettings.linearAutoTransitionStateId = "state-1";

    mockFetch().mockRejectedValue(new Error("ECONNREFUSED"));

    const res = await app.request("/api/linear/issues/issue-1/transition", {
      method: "POST",
    });

    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error).toMatch(/Linear transition failed/);
    expect(json.error).toMatch(/ECONNREFUSED/);
  });

  it("handles missing issue data in successful response", async () => {
    mockSettings.linearAutoTransition = true;
    mockSettings.linearAutoTransitionStateId = "state-1";

    mockFetch().mockResolvedValue(
      linearOk({
        issueUpdate: {
          success: true,
          issue: null, // issue data is missing
        },
      }),
    );

    const res = await app.request("/api/linear/issues/issue-1/transition", {
      method: "POST",
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    // Should fall back to the issueId param and empty strings
    expect(json.issue.id).toBe("issue-1");
    expect(json.issue.identifier).toBe("");
    expect(json.issue.stateName).toBe("");
    expect(json.issue.stateType).toBe("");
  });
});

// =============================================================================
// GET /api/linear/projects
// =============================================================================

describe("GET /api/linear/projects", () => {
  it("returns 400 when API key is not configured", async () => {
    mockSettings.linearApiKey = "";
    mockResolveApiKey.mockReturnValue(null);
    const res = await app.request("/api/linear/projects");
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/no linear connection configured/i);
  });

  it("returns mapped projects", async () => {
    mockFetch().mockResolvedValue(
      linearOk({
        projects: {
          nodes: [
            { id: "p1", name: "Project Alpha", state: "started" },
            { id: "p2", name: "Project Beta", state: "planned" },
          ],
        },
      }),
    );

    const res = await app.request("/api/linear/projects");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.projects).toHaveLength(2);
    expect(json.projects[0]).toEqual({ id: "p1", name: "Project Alpha", state: "started" });
  });

  it("returns 502 on Linear API error", async () => {
    mockFetch().mockResolvedValue(
      linearError("Rate limit exceeded"),
    );

    const res = await app.request("/api/linear/projects");
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error).toBe("Rate limit exceeded");
  });

  it("returns 502 on network error", async () => {
    mockFetch().mockRejectedValue(new Error("DNS lookup failed"));

    const res = await app.request("/api/linear/projects");
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error).toMatch(/Failed to connect to Linear/);
  });

  it("handles null fields in project data", async () => {
    mockFetch().mockResolvedValue(
      linearOk({
        projects: {
          nodes: [{ id: undefined, name: null, state: null }],
        },
      }),
    );

    const res = await app.request("/api/linear/projects");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.projects[0]).toEqual({ id: "", name: "", state: "" });
  });
});

// =============================================================================
// linearIssueStateCategory helper (tested indirectly through routes)
// =============================================================================

describe("linearIssueStateCategory (via issue filtering)", () => {
  // This tests the helper function at lines 7-15 which categorizes issue states.
  // We test it through the search endpoint which uses it for filtering/sorting.

  it("categorizes 'canceled' stateType as done (filtered out)", async () => {
    mockFetch().mockResolvedValue(
      linearOk({
        searchIssues: {
          nodes: [
            makeIssueNode({ id: "1", state: { name: "Canceled", type: "canceled" } }),
          ],
        },
      }),
    );

    const res = await app.request("/api/linear/issues?query=test");
    const json = await res.json();
    expect(json.issues).toHaveLength(0);
  });

  it("categorizes 'cancelled' stateType as done (filtered out)", async () => {
    mockFetch().mockResolvedValue(
      linearOk({
        searchIssues: {
          nodes: [
            makeIssueNode({ id: "1", state: { name: "Cancelled", type: "cancelled" } }),
          ],
        },
      }),
    );

    const res = await app.request("/api/linear/issues?query=test");
    const json = await res.json();
    expect(json.issues).toHaveLength(0);
  });

  it("categorizes 'done' stateName as done (filtered out)", async () => {
    mockFetch().mockResolvedValue(
      linearOk({
        searchIssues: {
          nodes: [
            makeIssueNode({ id: "1", state: { name: "done", type: "custom" } }),
          ],
        },
      }),
    );

    const res = await app.request("/api/linear/issues?query=test");
    const json = await res.json();
    expect(json.issues).toHaveLength(0);
  });

  it("keeps 'started' issues and sorts them after unstarted", async () => {
    mockFetch().mockResolvedValue(
      linearOk({
        searchIssues: {
          nodes: [
            makeIssueNode({ id: "started", identifier: "S-1", state: { name: "Working", type: "started" } }),
            makeIssueNode({ id: "backlog", identifier: "B-1", state: { name: "Backlog", type: "triage" } }),
          ],
        },
      }),
    );

    const res = await app.request("/api/linear/issues?query=test");
    const json = await res.json();
    expect(json.issues).toHaveLength(2);
    // triage (0) before started (1)
    expect(json.issues[0].identifier).toBe("B-1");
    expect(json.issues[1].identifier).toBe("S-1");
  });
});

// =============================================================================
// transitionLinearIssue helper (exported function)
// =============================================================================

describe("transitionLinearIssue helper", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns success with issue details on successful transition", async () => {
    mockFetch().mockResolvedValue(
      linearOk({
        issueUpdate: {
          success: true,
          issue: {
            id: "issue-1",
            identifier: "ENG-42",
            state: { name: "Backlog", type: "backlog" },
          },
        },
      }),
    );

    const result = await transitionLinearIssue("issue-1", "state-backlog", "lin_api_key");
    expect(result.ok).toBe(true);
    expect(result.issue).toEqual({
      id: "issue-1",
      identifier: "ENG-42",
      stateName: "Backlog",
      stateType: "backlog",
    });
    // Cache invalidation uses no prefix when connectionId is not passed
    expect(linearCache.invalidate).toHaveBeenCalledWith("issue:issue-1");
  });

  it("returns error when Linear returns GraphQL errors", async () => {
    mockFetch().mockResolvedValue(linearError("State not found"));

    const result = await transitionLinearIssue("issue-1", "bad-state", "lin_api_key");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("State not found");
  });

  it("returns error when fetch throws", async () => {
    mockFetch().mockRejectedValue(new Error("Network error"));

    const result = await transitionLinearIssue("issue-1", "state-1", "lin_api_key");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Network error/);
  });
});

// =============================================================================
// fetchLinearTeamStates helper (exported function)
// =============================================================================

describe("fetchLinearTeamStates helper", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns team states from Linear API", async () => {
    // linearCache.getOrFetch executes the fetcher (mocked above)
    mockFetch().mockResolvedValue(
      linearOk({
        teams: {
          nodes: [
            {
              id: "team-1",
              key: "ENG",
              name: "Engineering",
              states: {
                nodes: [
                  { id: "s1", name: "Backlog", type: "backlog" },
                  { id: "s2", name: "In Progress", type: "started" },
                ],
              },
            },
          ],
        },
      }),
    );

    const teams = await fetchLinearTeamStates("lin_api_key");
    expect(teams).toHaveLength(1);
    expect(teams[0].id).toBe("team-1");
    expect(teams[0].states).toHaveLength(2);
    expect(teams[0].states[0].type).toBe("backlog");
  });

  it("returns empty array on fetch error", async () => {
    mockFetch().mockRejectedValue(new Error("Network error"));

    const teams = await fetchLinearTeamStates("lin_api_key");
    expect(teams).toEqual([]);
  });
});
