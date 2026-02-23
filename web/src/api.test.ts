// @vitest-environment jsdom
const { captureEventMock, captureExceptionMock } = vi.hoisted(() => ({
  captureEventMock: vi.fn(),
  captureExceptionMock: vi.fn(),
}));

vi.mock("./analytics.js", () => ({
  captureEvent: captureEventMock,
  captureException: captureExceptionMock,
}));

import { api } from "./api.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function mockResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: () => Promise.resolve(data),
  };
}

beforeEach(() => {
  mockFetch.mockReset();
  captureEventMock.mockReset();
  captureExceptionMock.mockReset();
});

// ===========================================================================
// createSession
// ===========================================================================
describe("createSession", () => {
  it("sends POST to /api/sessions/create with body", async () => {
    const responseData = { sessionId: "s1", state: "starting", cwd: "/home" };
    mockFetch.mockResolvedValueOnce(mockResponse(responseData));

    const result = await api.createSession({ model: "opus", cwd: "/home" });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/sessions/create");
    expect(opts.method).toBe("POST");
    expect(opts.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(opts.body)).toEqual({ model: "opus", cwd: "/home" });
    expect(result).toEqual(responseData);
  });

  it("passes codexInternetAccess when provided", async () => {
    const responseData = { sessionId: "s2", state: "starting", cwd: "/repo" };
    mockFetch.mockResolvedValueOnce(mockResponse(responseData));

    await api.createSession({
      backend: "codex",
      cwd: "/repo",
      codexInternetAccess: true,
    });

    const [, opts] = mockFetch.mock.calls[0];
    expect(JSON.parse(opts.body)).toEqual({
      backend: "codex",
      cwd: "/repo",
      codexInternetAccess: true,
    });
  });

  it("passes container options when provided", async () => {
    const responseData = { sessionId: "s3", state: "starting", cwd: "/repo" };
    mockFetch.mockResolvedValueOnce(mockResponse(responseData));

    await api.createSession({
      backend: "claude",
      cwd: "/repo",
      container: {
        image: "companion-core:latest",
        ports: [3000, 5173],
      },
    });

    const [, opts] = mockFetch.mock.calls[0];
    expect(JSON.parse(opts.body)).toEqual({
      backend: "claude",
      cwd: "/repo",
      container: {
        image: "companion-core:latest",
        ports: [3000, 5173],
      },
    });
  });
});

// ===========================================================================
// listSessions
// ===========================================================================
describe("listSessions", () => {
  it("sends GET to /api/sessions", async () => {
    const sessions = [{ sessionId: "s1", state: "connected", cwd: "/tmp" }];
    mockFetch.mockResolvedValueOnce(mockResponse(sessions));

    const result = await api.listSessions();

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/sessions");
    // GET requests now include auth headers (empty when no token is set)
    expect(opts).toEqual({ headers: {} });
    expect(result).toEqual(sessions);
  });
});

describe("discoverClaudeSessions", () => {
  it("sends GET to /api/claude/sessions/discover with limit", async () => {
    const payload = {
      sessions: [
        {
          sessionId: "ac5b80ba-2927-4f20-84c2-6bbaf9afdeb3",
          cwd: "/Users/skolte/Github-Private/companion",
          gitBranch: "main",
          slug: "snazzy-baking-tarjan",
          lastActivityAt: 1234,
          sourceFile: "/Users/skolte/.claude/projects/-Users-skolte-Github-Private-companion/ac5b80ba-2927-4f20-84c2-6bbaf9afdeb3.jsonl",
        },
      ],
    };
    mockFetch.mockResolvedValueOnce(mockResponse(payload));

    const result = await api.discoverClaudeSessions(250);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/claude/sessions/discover?limit=250");
    expect(opts).toEqual({ headers: {} });
    expect(result).toEqual(payload);
  });
});

describe("getClaudeSessionHistory", () => {
  it("sends GET to /api/claude/sessions/:id/history with cursor and limit", async () => {
    const payload = {
      sourceFile: "/Users/skolte/.claude/projects/repo/session-1.jsonl",
      nextCursor: 40,
      hasMore: true,
      totalMessages: 120,
      messages: [],
    };
    mockFetch.mockResolvedValueOnce(mockResponse(payload));

    const result = await api.getClaudeSessionHistory("session-1", { cursor: 20, limit: 20 });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/claude/sessions/session-1/history?cursor=20&limit=20");
    expect(opts).toEqual({ headers: {} });
    expect(result).toEqual(payload);
  });
});

// ===========================================================================
// killSession
// ===========================================================================
describe("killSession", () => {
  it("sends POST with URL-encoded session ID", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ok: true }));

    await api.killSession("session/with/slashes");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe(`/api/sessions/${encodeURIComponent("session/with/slashes")}/kill`);
    expect(opts.method).toBe("POST");
  });
});

// ===========================================================================
// deleteSession
// ===========================================================================
describe("deleteSession", () => {
  it("sends DELETE with URL-encoded session ID", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ok: true }));

    await api.deleteSession("session&id=1");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe(`/api/sessions/${encodeURIComponent("session&id=1")}`);
    expect(opts.method).toBe("DELETE");
  });
});

// ===========================================================================
// post() error handling
// ===========================================================================
describe("post() error handling", () => {
  it("throws with error message from JSON body on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ error: "Session not found" }, 404));

    await expect(api.killSession("nonexistent")).rejects.toThrow("Session not found");
    expect(captureEventMock).toHaveBeenCalledWith(
      "api_request_failed",
      expect.objectContaining({ method: "POST", path: "/sessions/nonexistent/kill", status: 404 }),
    );
    expect(captureExceptionMock).toHaveBeenCalled();
  });

  it("falls back to statusText when JSON body has no error field", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({}, 500));

    await expect(api.killSession("bad")).rejects.toThrow("Error");
  });
});

// ===========================================================================
// get() error handling
// ===========================================================================
describe("get() error handling", () => {
  it("throws statusText on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      json: () => Promise.resolve({}),
    });

    await expect(api.listSessions()).rejects.toThrow("Forbidden");
    expect(captureEventMock).toHaveBeenCalledWith(
      "api_request_failed",
      expect.objectContaining({ method: "GET", path: "/sessions", status: 403 }),
    );
  });

  it("captures network failures", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network down"));

    await expect(api.listSessions()).rejects.toThrow("Network down");
    expect(captureEventMock).toHaveBeenCalledWith(
      "api_request_failed",
      expect.objectContaining({ method: "GET", path: "/sessions" }),
    );
    expect(captureExceptionMock).toHaveBeenCalled();
  });
});

// ===========================================================================
// listDirs
// ===========================================================================
describe("listDirs", () => {
  it("includes query param when path is provided", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ path: "/home", dirs: [], home: "/home" }));

    await api.listDirs("/home/user");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe(`/api/fs/list?path=${encodeURIComponent("/home/user")}`);
  });

  it("omits query param when path is not provided", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ path: "/", dirs: [], home: "/home" }));

    await api.listDirs();

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/fs/list");
  });
});

// ===========================================================================
// createEnv
// ===========================================================================
describe("createEnv", () => {
  it("sends POST to /api/envs with name and variables", async () => {
    const envData = { name: "Prod", slug: "prod", variables: { KEY: "val" }, createdAt: 1, updatedAt: 1 };
    mockFetch.mockResolvedValueOnce(mockResponse(envData));

    const result = await api.createEnv("Prod", { KEY: "val" });

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/envs");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({ name: "Prod", variables: { KEY: "val" } });
    expect(result).toEqual(envData);
  });
});

// ===========================================================================
// updateEnv
// ===========================================================================
describe("updateEnv", () => {
  it("sends PUT to /api/envs/:slug with data", async () => {
    const envData = { name: "Renamed", slug: "renamed", variables: {}, createdAt: 1, updatedAt: 2 };
    mockFetch.mockResolvedValueOnce(mockResponse(envData));

    await api.updateEnv("my-env", { name: "Renamed" });

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe(`/api/envs/${encodeURIComponent("my-env")}`);
    expect(opts.method).toBe("PUT");
    expect(JSON.parse(opts.body)).toEqual({ name: "Renamed" });
  });
});

// ===========================================================================
// settings
// ===========================================================================
describe("settings", () => {
  it("sends GET to /api/settings", async () => {
    const settings = { openrouterApiKeyConfigured: true, openrouterModel: "openrouter/free", linearApiKeyConfigured: false };
    mockFetch.mockResolvedValueOnce(mockResponse(settings));

    const result = await api.getSettings();

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/settings");
    expect(result).toEqual(settings);
  });

  it("sends PUT to /api/settings", async () => {
    const settings = { openrouterApiKeyConfigured: true, openrouterModel: "openrouter/free", linearApiKeyConfigured: true };
    mockFetch.mockResolvedValueOnce(mockResponse(settings));

    await api.updateSettings({ openrouterApiKey: "or-key", linearApiKey: "lin_api_123" });

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/settings");
    expect(opts.method).toBe("PUT");
    expect(JSON.parse(opts.body)).toEqual({ openrouterApiKey: "or-key", linearApiKey: "lin_api_123" });
  });

  it("searches Linear issues with query + limit", async () => {
    const data = { issues: [{ id: "1", identifier: "ENG-1", title: "Fix", description: "", url: "", branchName: "", priorityLabel: "", stateName: "", stateType: "", teamName: "", teamKey: "", teamId: "" }] };
    mockFetch.mockResolvedValueOnce(mockResponse(data));

    const result = await api.searchLinearIssues("auth bug", 5);
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/linear/issues?query=auth%20bug&limit=5");
    expect(result).toEqual(data);
  });

  it("surfaces backend error message for Linear issue search", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ error: "Linear token invalid" }, 502));

    await expect(api.searchLinearIssues("auth bug", 5)).rejects.toThrow("Linear token invalid");
  });

  it("gets Linear connection status", async () => {
    const data = {
      connected: true,
      viewerName: "Ada",
      viewerEmail: "ada@example.com",
      teamName: "Engineering",
      teamKey: "ENG",
    };
    mockFetch.mockResolvedValueOnce(mockResponse(data));

    const result = await api.getLinearConnection();
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/linear/connection");
    expect(result).toEqual(data);
  });

  it("transitions a Linear issue", async () => {
    const data = { ok: true, skipped: false };
    mockFetch.mockResolvedValueOnce(mockResponse(data));

    const result = await api.transitionLinearIssue("issue-123");
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/linear/issues/issue-123/transition");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({});
    expect(result).toEqual(data);
  });

  it("surfaces backend error for Linear issue transition", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ error: "Linear transition failed" }, 502));

    await expect(api.transitionLinearIssue("issue-123")).rejects.toThrow("Linear transition failed");
  });

  it("fetches Linear workflow states", async () => {
    const data = { teams: [{ id: "t1", key: "ENG", name: "Engineering", states: [{ id: "s1", name: "In Progress", type: "started" }] }] };
    mockFetch.mockResolvedValueOnce(mockResponse(data));

    const result = await api.getLinearStates();
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/linear/states");
    expect(result).toEqual(data);
  });
});

// ===========================================================================
// getRepoInfo
// ===========================================================================
describe("getRepoInfo", () => {
  it("sends GET with encoded path query param", async () => {
    const info = { repoRoot: "/repo", repoName: "app", currentBranch: "main", defaultBranch: "main" };
    mockFetch.mockResolvedValueOnce(mockResponse(info));

    const result = await api.getRepoInfo("/path/to repo");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe(`/api/git/repo-info?path=${encodeURIComponent("/path/to repo")}`);
    expect(result).toEqual(info);
  });
});

// ===========================================================================
// getFileDiff
// ===========================================================================
describe("getFileDiff", () => {
  it("sends GET with encoded path query param", async () => {
    const diffData = { path: "/repo/file.ts", diff: "+new line\n-old line" };
    mockFetch.mockResolvedValueOnce(mockResponse(diffData));

    const result = await api.getFileDiff("/repo/file.ts");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe(`/api/fs/diff?path=${encodeURIComponent("/repo/file.ts")}`);
    expect(result).toEqual(diffData);
  });
});

// ===========================================================================
// getSessionUsageLimits
// ===========================================================================
describe("getSessionUsageLimits", () => {
  it("sends GET to /api/sessions/:id/usage-limits", async () => {
    const limitsData = {
      five_hour: { utilization: 25, resets_at: "2026-01-01T12:00:00Z" },
      seven_day: null,
      extra_usage: null,
    };
    mockFetch.mockResolvedValueOnce(mockResponse(limitsData));

    const result = await api.getSessionUsageLimits("sess-123");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/sessions/sess-123/usage-limits");
    expect(result).toEqual(limitsData);
  });
});

// ===========================================================================
// getCloudProviderPlan
// ===========================================================================
describe("getCloudProviderPlan", () => {
  it("sends GET with provider/cwd/sessionId query params", async () => {
    const plan = {
      provider: "modal",
      sessionId: "s1",
      image: "companion-core:latest",
      cwd: "/repo",
      mappedPorts: [{ containerPort: 3000, hostPort: 49152 }],
      commandPreview: "modal run companion_cloud.py --manifest /repo/.companion/cloud/environments/s1.json",
    };
    mockFetch.mockResolvedValueOnce(mockResponse(plan));

    const result = await api.getCloudProviderPlan("modal", "/repo", "s1");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe(
      `/api/cloud/providers/modal/plan?cwd=${encodeURIComponent("/repo")}&sessionId=${encodeURIComponent("s1")}`,
    );
    expect(result).toEqual(plan);
  });
});

// ===========================================================================
// terminal API
// ===========================================================================
describe("terminal API", () => {
  it("spawnTerminal sends cwd, size, and optional containerId", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ terminalId: "term-1" }));

    const result = await api.spawnTerminal("/workspace", 120, 40, { containerId: "abc123" });

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/terminal/spawn");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({
      cwd: "/workspace",
      cols: 120,
      rows: 40,
      containerId: "abc123",
    });
    expect(result).toEqual({ terminalId: "term-1" });
  });

  it("killTerminal sends terminalId in request body", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ok: true }));

    const result = await api.killTerminal("term-1");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/terminal/kill");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({ terminalId: "term-1" });
    expect(result).toEqual({ ok: true });
  });
});
