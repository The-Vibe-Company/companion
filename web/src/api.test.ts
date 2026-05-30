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
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/sessions");
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
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/claude/sessions/discover?limit=250");
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
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/claude/sessions/session-1/history?cursor=20&limit=20");
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
    const settings = { anthropicApiKeyConfigured: true, anthropicModel: "claude-sonnet-4-6", linearApiKeyConfigured: false };
    mockFetch.mockResolvedValueOnce(mockResponse(settings));

    const result = await api.getSettings();

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/settings");
    expect(result).toEqual(settings);
  });

  it("sends PUT to /api/settings", async () => {
    const settings = { anthropicApiKeyConfigured: true, anthropicModel: "claude-sonnet-4-6", linearApiKeyConfigured: true };
    mockFetch.mockResolvedValueOnce(mockResponse(settings));

    await api.updateSettings({ anthropicApiKey: "sk-ant-key", linearApiKey: "lin_api_123" });

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/settings");
    expect(opts.method).toBe("PUT");
    expect(JSON.parse(opts.body)).toEqual({ anthropicApiKey: "sk-ant-key", linearApiKey: "lin_api_123" });
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

  it("verifyAnthropicKey sends POST to /api/settings/anthropic/verify", async () => {
    const data = { valid: true };
    mockFetch.mockResolvedValueOnce(mockResponse(data));

    const result = await api.verifyAnthropicKey("sk-ant-api03-test-key");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/settings/anthropic/verify");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({ apiKey: "sk-ant-api03-test-key" });
    expect(result).toEqual({ valid: true });
  });

  it("verifyAnthropicKey returns error when key is invalid", async () => {
    const data = { valid: false, error: "Invalid API key" };
    mockFetch.mockResolvedValueOnce(mockResponse(data));

    const result = await api.verifyAnthropicKey("bad-key");

    expect(result).toEqual({ valid: false, error: "Invalid API key" });
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

  it("getTerminal sends GET with optional terminalId query param", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ active: true, terminalId: "term-1", cwd: "/workspace" }));

    const result = await api.getTerminal("term-1");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/terminal?terminalId=term-1");
    expect(result).toEqual({ active: true, terminalId: "term-1", cwd: "/workspace" });
  });

  it("getTerminal sends GET without terminalId when omitted", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ active: false }));

    const result = await api.getTerminal();

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/terminal");
    expect(result).toEqual({ active: false });
  });
});

// ===========================================================================
// Auth API (getAuthQr, getAuthToken, regenerateAuthToken)
// ===========================================================================
describe("auth API", () => {
  it("getAuthQr sends GET to /api/auth/qr", async () => {
    const data = { qrCodes: [{ label: "Local", url: "http://localhost:3456", qrDataUrl: "data:image/png;base64,abc" }] };
    mockFetch.mockResolvedValueOnce(mockResponse(data));

    const result = await api.getAuthQr();

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/auth/qr");
    expect(result).toEqual(data);
  });

  it("getAuthToken sends GET to /api/auth/token", async () => {
    const data = { token: "tok_123" };
    mockFetch.mockResolvedValueOnce(mockResponse(data));

    const result = await api.getAuthToken();

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/auth/token");
    expect(result).toEqual(data);
  });

  it("regenerateAuthToken sends POST to /api/auth/regenerate", async () => {
    const data = { token: "tok_new" };
    mockFetch.mockResolvedValueOnce(mockResponse(data));

    const result = await api.regenerateAuthToken();

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/auth/regenerate");
    expect(opts.method).toBe("POST");
    expect(result).toEqual(data);
  });
});

// ===========================================================================
// autoAuth
// ===========================================================================
describe("autoAuth", () => {
  it("returns token on successful auto-auth", async () => {
    const { autoAuth } = await import("./api.js");
    mockFetch.mockResolvedValueOnce(mockResponse({ ok: true, token: "auto_tok" }));

    const result = await autoAuth();

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/auth/auto");
    expect(result).toBe("auto_tok");
  });

  it("returns null when ok is false", async () => {
    const { autoAuth } = await import("./api.js");
    mockFetch.mockResolvedValueOnce(mockResponse({ ok: false }));

    const result = await autoAuth();
    expect(result).toBeNull();
  });

  it("returns null on fetch failure", async () => {
    const { autoAuth } = await import("./api.js");
    mockFetch.mockRejectedValueOnce(new Error("Network error"));

    const result = await autoAuth();
    expect(result).toBeNull();
  });
});

// ===========================================================================
// verifyAuthToken
// ===========================================================================
describe("verifyAuthToken", () => {
  it("returns true when server confirms token", async () => {
    const { verifyAuthToken } = await import("./api.js");
    mockFetch.mockResolvedValueOnce(mockResponse({ ok: true }));

    const result = await verifyAuthToken("valid_token");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/auth/verify");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({ token: "valid_token" });
    expect(result).toBe(true);
  });

  it("returns false when server rejects token", async () => {
    const { verifyAuthToken } = await import("./api.js");
    mockFetch.mockResolvedValueOnce(mockResponse({ ok: false }, 401));

    const result = await verifyAuthToken("bad_token");
    expect(result).toBe(false);
  });

  it("returns false on fetch failure", async () => {
    const { verifyAuthToken } = await import("./api.js");
    mockFetch.mockRejectedValueOnce(new Error("Network error"));

    const result = await verifyAuthToken("any_token");
    expect(result).toBe(false);
  });
});

// ===========================================================================
// relaunchSession
// ===========================================================================
describe("relaunchSession", () => {
  it("sends POST to /api/sessions/:id/relaunch", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ok: true }));

    await api.relaunchSession("sess-42");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/sessions/sess-42/relaunch");
    expect(opts.method).toBe("POST");
  });
});

// ===========================================================================
// archiveSession / unarchiveSession
// ===========================================================================
describe("archiveSession", () => {
  it("sends POST to /api/sessions/:id/archive without options", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ok: true }));

    await api.archiveSession("sess-1");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/sessions/sess-1/archive");
    expect(opts.method).toBe("POST");
  });

  it("sends force option when specified", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ok: true }));

    await api.archiveSession("sess-1", { force: true });

    const [, opts] = mockFetch.mock.calls[0];
    expect(JSON.parse(opts.body)).toEqual({ force: true });
  });
});

describe("unarchiveSession", () => {
  it("sends POST to /api/sessions/:id/unarchive", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ok: true }));

    await api.unarchiveSession("sess-1");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/sessions/sess-1/unarchive");
    expect(opts.method).toBe("POST");
  });
});

// ===========================================================================
// renameSession
// ===========================================================================
describe("renameSession", () => {
  it("sends PATCH to /api/sessions/:id/name with name body", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ok: true, name: "New Name" }));

    const result = await api.renameSession("sess-1", "New Name");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/sessions/sess-1/name");
    expect(opts.method).toBe("PATCH");
    expect(JSON.parse(opts.body)).toEqual({ name: "New Name" });
    expect(result).toEqual({ ok: true, name: "New Name" });
  });
});

// ===========================================================================
// getHome
// ===========================================================================
describe("getHome", () => {
  it("sends GET to /api/fs/home", async () => {
    const data = { home: "/home/user", cwd: "/home/user/project" };
    mockFetch.mockResolvedValueOnce(mockResponse(data));

    const result = await api.getHome();

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/fs/home");
    expect(result).toEqual(data);
  });
});

// ===========================================================================
// Environment API (listEnvs, getEnv, deleteEnv, build-related)
// ===========================================================================
describe("environment API", () => {
  it("listEnvs sends GET to /api/envs", async () => {
    const envs = [{ name: "Dev", slug: "dev", variables: {}, createdAt: 1, updatedAt: 1 }];
    mockFetch.mockResolvedValueOnce(mockResponse(envs));

    const result = await api.listEnvs();

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/envs");
    expect(result).toEqual(envs);
  });

  it("getEnv sends GET to /api/envs/:slug", async () => {
    const env = { name: "Dev", slug: "dev", variables: { A: "1" }, createdAt: 1, updatedAt: 1 };
    mockFetch.mockResolvedValueOnce(mockResponse(env));

    const result = await api.getEnv("dev");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/envs/dev");
    expect(result).toEqual(env);
  });

  it("deleteEnv sends DELETE to /api/envs/:slug", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ok: true }));

    await api.deleteEnv("old-env");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/envs/old-env");
    expect(opts.method).toBe("DELETE");
  });

  it("listSandboxes sends GET to /api/sandboxes", async () => {
    const sandboxes = [{ name: "Dev", slug: "dev", createdAt: 1, updatedAt: 1 }];
    mockFetch.mockResolvedValueOnce(mockResponse(sandboxes));

    const result = await api.listSandboxes();

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/sandboxes");
    expect(result).toEqual(sandboxes);
  });

  it("getSandbox sends GET to /api/sandboxes/:slug", async () => {
    const sandbox = { name: "Dev", slug: "dev", createdAt: 1, updatedAt: 1 };
    mockFetch.mockResolvedValueOnce(mockResponse(sandbox));

    const result = await api.getSandbox("dev");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/sandboxes/dev");
    expect(result).toEqual(sandbox);
  });

  it("createSandbox sends POST to /api/sandboxes with name and options", async () => {
    const sandbox = { name: "My Sandbox", slug: "my-sandbox", initScript: "npm install", createdAt: 1, updatedAt: 1 };
    mockFetch.mockResolvedValueOnce(mockResponse(sandbox));

    const result = await api.createSandbox("My Sandbox", { initScript: "npm install" });

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/sandboxes");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({ name: "My Sandbox", initScript: "npm install" });
    expect(result).toEqual(sandbox);
  });

  it("updateSandbox sends PUT to /api/sandboxes/:slug", async () => {
    const sandbox = { name: "Renamed", slug: "renamed", createdAt: 1, updatedAt: 2 };
    mockFetch.mockResolvedValueOnce(mockResponse(sandbox));

    await api.updateSandbox("my-sandbox", { name: "Renamed" });

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/sandboxes/my-sandbox");
    expect(opts.method).toBe("PUT");
    expect(JSON.parse(opts.body)).toEqual({ name: "Renamed" });
  });

  it("deleteSandbox sends DELETE to /api/sandboxes/:slug", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ok: true }));

    await api.deleteSandbox("old-sandbox");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/sandboxes/old-sandbox");
    expect(opts.method).toBe("DELETE");
  });

  it("testInitScript sends POST to /api/sandboxes/:slug/test-init with initScript", async () => {
    const data = { success: true, exitCode: 0, output: "hello\n" };
    mockFetch.mockResolvedValueOnce(mockResponse(data));

    const result = await api.testInitScript("my-sandbox", "/home/user/project", "echo hi");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/sandboxes/my-sandbox/test-init");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({ cwd: "/home/user/project", initScript: "echo hi" });
    expect(result).toEqual(data);
  });

  it("buildBaseImage sends POST to /api/docker/build-base", async () => {
    const data = { ok: true, tag: "companion-base:latest" };
    mockFetch.mockResolvedValueOnce(mockResponse(data));

    const result = await api.buildBaseImage();

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/docker/build-base");
    expect(opts.method).toBe("POST");
    expect(result).toEqual(data);
  });

  it("getBaseImageStatus sends GET to /api/docker/base-image", async () => {
    const data = { exists: true, tag: "companion-base:latest" };
    mockFetch.mockResolvedValueOnce(mockResponse(data));

    const result = await api.getBaseImageStatus();

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/docker/base-image");
    expect(result).toEqual(data);
  });

  it("createEnv sends name and variables only", async () => {
    const envData = { name: "My Env", slug: "my-env", variables: { KEY: "val" }, createdAt: 1, updatedAt: 1 };
    mockFetch.mockResolvedValueOnce(mockResponse(envData));

    await api.createEnv("My Env", { KEY: "val" });

    const [, opts] = mockFetch.mock.calls[0];
    expect(JSON.parse(opts.body)).toEqual({
      name: "My Env",
      variables: { KEY: "val" },
    });
  });
});

// ===========================================================================
// Linear project API
// ===========================================================================
describe("Linear project API", () => {
  it("listLinearProjects sends GET to /api/linear/projects", async () => {
    const data = { projects: [{ id: "p1", name: "Q1 Roadmap", state: "started" }] };
    mockFetch.mockResolvedValueOnce(mockResponse(data));

    const result = await api.listLinearProjects();

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/linear/projects");
    expect(result).toEqual(data);
  });

  it("getLinearProjectIssues sends GET with projectId and limit", async () => {
    const data = { issues: [{ id: "i1", identifier: "ENG-1", title: "Task" }] };
    mockFetch.mockResolvedValueOnce(mockResponse(data));

    const result = await api.getLinearProjectIssues("proj-1", 10);

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/linear/project-issues?projectId=proj-1&limit=10");
    expect(result).toEqual(data);
  });

  it("getLinearProjectIssues uses default limit of 15", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ issues: [] }));

    await api.getLinearProjectIssues("proj-1");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/linear/project-issues?projectId=proj-1&limit=15");
  });

  it("getLinearProjectMapping sends GET with repoRoot", async () => {
    const data = { mapping: { repoRoot: "/repo", projectId: "p1", projectName: "Q1", createdAt: 1, updatedAt: 1 } };
    mockFetch.mockResolvedValueOnce(mockResponse(data));

    const result = await api.getLinearProjectMapping("/repo");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe(`/api/linear/project-mappings?repoRoot=${encodeURIComponent("/repo")}`);
    expect(result).toEqual(data);
  });

  it("upsertLinearProjectMapping sends PUT to /api/linear/project-mappings", async () => {
    const mapping = { repoRoot: "/repo", projectId: "p1", projectName: "Q1", createdAt: 1, updatedAt: 2 };
    mockFetch.mockResolvedValueOnce(mockResponse({ mapping }));

    const result = await api.upsertLinearProjectMapping({
      repoRoot: "/repo",
      projectId: "p1",
      projectName: "Q1",
    });

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/linear/project-mappings");
    expect(opts.method).toBe("PUT");
    expect(JSON.parse(opts.body)).toEqual({ repoRoot: "/repo", projectId: "p1", projectName: "Q1" });
    expect(result).toEqual({ mapping });
  });

  it("removeLinearProjectMapping sends DELETE with repoRoot body", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ok: true }));

    await api.removeLinearProjectMapping("/repo");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/linear/project-mappings");
    expect(opts.method).toBe("DELETE");
    expect(JSON.parse(opts.body)).toEqual({ repoRoot: "/repo" });
  });
});

// ===========================================================================
// Linear issue <-> session association
// ===========================================================================
describe("Linear issue-session linking", () => {
  const mockIssue = {
    id: "iss-1",
    identifier: "ENG-1",
    title: "Fix bug",
    description: "",
    url: "https://linear.app/ENG-1",
    branchName: "fix-bug",
    priorityLabel: "High",
    stateName: "In Progress",
    stateType: "started",
    teamName: "Engineering",
    teamKey: "ENG",
    teamId: "t1",
  };

  it("linkLinearIssue sends PUT with issue body", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ok: true }));

    await api.linkLinearIssue("sess-1", mockIssue);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/sessions/sess-1/linear-issue");
    expect(opts.method).toBe("PUT");
    expect(JSON.parse(opts.body)).toEqual(mockIssue);
  });

  it("unlinkLinearIssue sends DELETE", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ok: true }));

    await api.unlinkLinearIssue("sess-1");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/sessions/sess-1/linear-issue");
    expect(opts.method).toBe("DELETE");
  });

  it("getLinkedLinearIssue sends GET without refresh by default", async () => {
    const data = { issue: mockIssue, comments: [], labels: [] };
    mockFetch.mockResolvedValueOnce(mockResponse(data));

    const result = await api.getLinkedLinearIssue("sess-1");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/sessions/sess-1/linear-issue");
    expect(result).toEqual(data);
  });

  it("getLinkedLinearIssue sends GET with refresh=true", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ issue: null }));

    await api.getLinkedLinearIssue("sess-1", true);

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/sessions/sess-1/linear-issue?refresh=true");
  });

  it("addLinearComment sends POST with body text", async () => {
    const comment = { id: "c1", body: "Hello", createdAt: "2026-01-01", userName: "Ada" };
    mockFetch.mockResolvedValueOnce(mockResponse({ ok: true, comment }));

    const result = await api.addLinearComment("iss-1", "Hello");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/linear/issues/iss-1/comments");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({ body: "Hello" });
    expect(result).toEqual({ ok: true, comment });
  });
});

// ===========================================================================
// Git branch, fetch, pull, worktree, PR API
// ===========================================================================
describe("git API", () => {
  it("listBranches sends GET with encoded repoRoot", async () => {
    const branches = [{ name: "main", isCurrent: true, isRemote: false, worktreePath: null, ahead: 0, behind: 0 }];
    mockFetch.mockResolvedValueOnce(mockResponse(branches));

    const result = await api.listBranches("/my repo");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe(`/api/git/branches?repoRoot=${encodeURIComponent("/my repo")}`);
    expect(result).toEqual(branches);
  });

  it("gitFetch sends POST with repoRoot", async () => {
    const data = { success: true, output: "Already up to date" };
    mockFetch.mockResolvedValueOnce(mockResponse(data));

    const result = await api.gitFetch("/repo");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/git/fetch");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({ repoRoot: "/repo" });
    expect(result).toEqual(data);
  });

  it("gitPull sends POST with cwd", async () => {
    const data = { success: true, output: "up to date", git_ahead: 0, git_behind: 0 };
    mockFetch.mockResolvedValueOnce(mockResponse(data));

    const result = await api.gitPull("/repo");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/git/pull");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({ cwd: "/repo" });
    expect(result).toEqual(data);
  });

  it("listWorktrees sends GET with encoded repoRoot", async () => {
    const worktrees = [{ path: "/repo", branch: "main", head: "abc123", isMainWorktree: true, isDirty: false }];
    mockFetch.mockResolvedValueOnce(mockResponse(worktrees));

    const result = await api.listWorktrees("/repo");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe(`/api/git/worktrees?repoRoot=${encodeURIComponent("/repo")}`);
    expect(result).toEqual(worktrees);
  });

  it("createWorktree sends POST with repoRoot, branch, and options", async () => {
    const data = { worktreePath: "/repo-wt", branch: "feat", isNew: true };
    mockFetch.mockResolvedValueOnce(mockResponse(data));

    const result = await api.createWorktree("/repo", "feat", { baseBranch: "main", createBranch: true });

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/git/worktree");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({
      repoRoot: "/repo",
      branch: "feat",
      baseBranch: "main",
      createBranch: true,
    });
    expect(result).toEqual(data);
  });

  it("removeWorktree sends DELETE with repoRoot, worktreePath, force", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ok: true }));

    await api.removeWorktree("/repo", "/repo-wt", true);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/git/worktree");
    expect(opts.method).toBe("DELETE");
    expect(JSON.parse(opts.body)).toEqual({ repoRoot: "/repo", worktreePath: "/repo-wt", force: true });
  });

  it("getPRStatus sends GET with cwd and branch", async () => {
    const data = { available: true, pr: { number: 42, title: "Fix", url: "https://github.com/pr/42", state: "OPEN" } };
    mockFetch.mockResolvedValueOnce(mockResponse(data));

    const result = await api.getPRStatus("/repo", "fix-branch");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe(`/api/git/pr-status?cwd=${encodeURIComponent("/repo")}&branch=${encodeURIComponent("fix-branch")}`);
    expect(result).toEqual(data);
  });
});

// ===========================================================================
// Backends API
// ===========================================================================
describe("backends API", () => {
  it("getBackends sends GET to /api/backends", async () => {
    const backends = [{ id: "claude", name: "Claude Code", available: true }];
    mockFetch.mockResolvedValueOnce(mockResponse(backends));

    const result = await api.getBackends();

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/backends");
    expect(result).toEqual(backends);
  });

  it("getBackendModels sends GET with encoded backendId", async () => {
    const models = [{ value: "opus", label: "Claude Opus", description: "Most capable" }];
    mockFetch.mockResolvedValueOnce(mockResponse(models));

    const result = await api.getBackendModels("claude");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/backends/claude/models");
    expect(result).toEqual(models);
  });
});

// ===========================================================================
// Containers API
// ===========================================================================
describe("containers API", () => {
  it("getContainerStatus sends GET to /api/containers/status", async () => {
    const data = { available: true, version: "24.0.6" };
    mockFetch.mockResolvedValueOnce(mockResponse(data));

    const result = await api.getContainerStatus();

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/containers/status");
    expect(result).toEqual(data);
  });

  it("getContainerImages sends GET to /api/containers/images", async () => {
    const images = ["node:20", "companion-core:latest"];
    mockFetch.mockResolvedValueOnce(mockResponse(images));

    const result = await api.getContainerImages();

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/containers/images");
    expect(result).toEqual(images);
  });
});

// ===========================================================================
// Image pull manager
// ===========================================================================
describe("image pull API", () => {
  it("getImageStatus sends GET with encoded tag", async () => {
    const state = { image: "node:20", status: "ready", progress: [] };
    mockFetch.mockResolvedValueOnce(mockResponse(state));

    const result = await api.getImageStatus("node:20");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe(`/api/images/${encodeURIComponent("node:20")}/status`);
    expect(result).toEqual(state);
  });

  it("pullImage sends POST with encoded tag", async () => {
    const data = { ok: true, state: { image: "node:20", status: "pulling", progress: [] } };
    mockFetch.mockResolvedValueOnce(mockResponse(data));

    const result = await api.pullImage("node:20");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe(`/api/images/${encodeURIComponent("node:20")}/pull`);
    expect(opts.method).toBe("POST");
    expect(result).toEqual(data);
  });
});

// ===========================================================================
// Editor API
// ===========================================================================
describe("editor API", () => {
  it("startEditor sends POST to /api/sessions/:id/editor/start", async () => {
    const data = { available: true, installed: true, mode: "host", url: "http://localhost:8080" };
    mockFetch.mockResolvedValueOnce(mockResponse(data));

    const result = await api.startEditor("sess-1");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/sessions/sess-1/editor/start");
    expect(opts.method).toBe("POST");
    expect(result).toEqual(data);
  });
});

// ===========================================================================
// Editor filesystem API
// ===========================================================================
describe("editor filesystem API", () => {
  it("getFileTree sends GET with encoded path", async () => {
    const data = { path: "/repo", tree: [{ name: "src", path: "/repo/src", type: "directory" }] };
    mockFetch.mockResolvedValueOnce(mockResponse(data));

    const result = await api.getFileTree("/repo");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe(`/api/fs/tree?path=${encodeURIComponent("/repo")}`);
    expect(result).toEqual(data);
  });

  it("readFile sends GET with encoded path", async () => {
    const data = { path: "/repo/index.ts", content: "console.log('hello');" };
    mockFetch.mockResolvedValueOnce(mockResponse(data));

    const result = await api.readFile("/repo/index.ts");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe(`/api/fs/read?path=${encodeURIComponent("/repo/index.ts")}`);
    expect(result).toEqual(data);
  });

  it("writeFile sends PUT to /api/fs/write with path and content", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ok: true, path: "/repo/file.ts" }));

    const result = await api.writeFile("/repo/file.ts", "const x = 1;");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/fs/write");
    expect(opts.method).toBe("PUT");
    expect(JSON.parse(opts.body)).toEqual({ path: "/repo/file.ts", content: "const x = 1;" });
    expect(result).toEqual({ ok: true, path: "/repo/file.ts" });
  });

  it("getFileDiff includes base param when provided", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ path: "/repo/f.ts", diff: "+added" }));

    await api.getFileDiff("/repo/f.ts", "default-branch");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe(`/api/fs/diff?path=${encodeURIComponent("/repo/f.ts")}&base=${encodeURIComponent("default-branch")}`);
  });

  it("getChangedFiles sends GET with cwd and optional base", async () => {
    const data = { files: [{ path: "/repo/a.ts", status: "modified" }] };
    mockFetch.mockResolvedValueOnce(mockResponse(data));

    const result = await api.getChangedFiles("/repo", "last-commit");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe(`/api/fs/changed-files?cwd=${encodeURIComponent("/repo")}&base=${encodeURIComponent("last-commit")}`);
    expect(result).toEqual(data);
  });

  it("getChangedFiles sends GET without base when omitted", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ files: [] }));

    await api.getChangedFiles("/repo");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe(`/api/fs/changed-files?cwd=${encodeURIComponent("/repo")}`);
  });

  it("getClaudeMdFiles sends GET with cwd", async () => {
    const data = { cwd: "/repo", files: [{ path: "/repo/CLAUDE.md", content: "# Claude" }] };
    mockFetch.mockResolvedValueOnce(mockResponse(data));

    const result = await api.getClaudeMdFiles("/repo");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe(`/api/fs/claude-md?cwd=${encodeURIComponent("/repo")}`);
    expect(result).toEqual(data);
  });

  it("saveClaudeMd sends PUT to /api/fs/claude-md", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ok: true, path: "/repo/CLAUDE.md" }));

    const result = await api.saveClaudeMd("/repo/CLAUDE.md", "# Updated");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/fs/claude-md");
    expect(opts.method).toBe("PUT");
    expect(JSON.parse(opts.body)).toEqual({ path: "/repo/CLAUDE.md", content: "# Updated" });
    expect(result).toEqual({ ok: true, path: "/repo/CLAUDE.md" });
  });

  it("getClaudeConfig sends GET with cwd", async () => {
    const data = {
      project: { root: "/repo", claudeMd: [], settings: null, settingsLocal: null, commands: [] },
      user: { root: "/home", claudeMd: null, skills: [], agents: [], settings: null, commands: [] },
    };
    mockFetch.mockResolvedValueOnce(mockResponse(data));

    const result = await api.getClaudeConfig("/repo");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe(`/api/fs/claude-config?cwd=${encodeURIComponent("/repo")}`);
    expect(result).toEqual(data);
  });

  it("getFileBlob fetches raw file and creates object URL", async () => {
    const mockBlob = new Blob(["file content"], { type: "text/plain" });
    const mockObjectUrl = "blob:http://localhost/abc123";
    vi.stubGlobal("URL", { ...URL, createObjectURL: vi.fn().mockReturnValue(mockObjectUrl) });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      blob: () => Promise.resolve(mockBlob),
    });

    const result = await api.getFileBlob("/repo/image.png");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe(`/api/fs/raw?path=${encodeURIComponent("/repo/image.png")}`);
    expect(result).toBe(mockObjectUrl);
  });

  it("getFileBlob throws on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: "Not Found",
      json: () => Promise.resolve({ error: "File not found" }),
    });

    await expect(api.getFileBlob("/repo/missing.png")).rejects.toThrow("File not found");
  });
});

// ===========================================================================
// Usage limits (global)
// ===========================================================================
describe("getUsageLimits", () => {
  it("sends GET to /api/usage-limits", async () => {
    const data = { five_hour: null, seven_day: null, extra_usage: null };
    mockFetch.mockResolvedValueOnce(mockResponse(data));

    const result = await api.getUsageLimits();

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/usage-limits");
    expect(result).toEqual(data);
  });
});

// ===========================================================================
// Update checking API
// ===========================================================================
describe("update API", () => {
  it("checkForUpdate sends GET to /api/update-check", async () => {
    const data = { currentVersion: "0.60.0", latestVersion: "0.61.0", updateAvailable: true, isServiceMode: false, updateInProgress: false, lastChecked: 123 };
    mockFetch.mockResolvedValueOnce(mockResponse(data));

    const result = await api.checkForUpdate();

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/update-check");
    expect(result).toEqual(data);
  });

  it("forceCheckForUpdate sends POST to /api/update-check", async () => {
    const data = { currentVersion: "0.60.0", latestVersion: "0.61.0", updateAvailable: true, isServiceMode: false, updateInProgress: false, lastChecked: 456 };
    mockFetch.mockResolvedValueOnce(mockResponse(data));

    const result = await api.forceCheckForUpdate();

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/update-check");
    expect(opts.method).toBe("POST");
    expect(result).toEqual(data);
  });

  it("triggerUpdate sends POST to /api/update", async () => {
    const data = { ok: true, message: "Update started" };
    mockFetch.mockResolvedValueOnce(mockResponse(data));

    const result = await api.triggerUpdate();

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/update");
    expect(opts.method).toBe("POST");
    expect(result).toEqual(data);
  });
});

// ===========================================================================
// Cron jobs API
// ===========================================================================
describe("cron jobs API", () => {
  const mockJob = {
    id: "cron-1",
    name: "Daily backup",
    prompt: "Run backup",
    schedule: "0 0 * * *",
    recurring: true,
    backendType: "claude" as const,
    model: "opus",
    cwd: "/repo",
    enabled: true,
    permissionMode: "auto",
    createdAt: 1,
    updatedAt: 1,
    consecutiveFailures: 0,
    totalRuns: 5,
  };

  it("listCronJobs sends GET to /api/cron/jobs", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse([mockJob]));

    const result = await api.listCronJobs();

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/cron/jobs");
    expect(result).toEqual([mockJob]);
  });

  it("getCronJob sends GET to /api/cron/jobs/:id", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(mockJob));

    const result = await api.getCronJob("cron-1");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/cron/jobs/cron-1");
    expect(result).toEqual(mockJob);
  });

  it("createCronJob sends POST to /api/cron/jobs", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(mockJob));

    const result = await api.createCronJob({ name: "Daily backup", prompt: "Run backup", schedule: "0 0 * * *" });

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/cron/jobs");
    expect(opts.method).toBe("POST");
    expect(result).toEqual(mockJob);
  });

  it("updateCronJob sends PUT to /api/cron/jobs/:id", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ...mockJob, name: "Updated" }));

    const result = await api.updateCronJob("cron-1", { name: "Updated" });

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/cron/jobs/cron-1");
    expect(opts.method).toBe("PUT");
    expect(JSON.parse(opts.body)).toEqual({ name: "Updated" });
    expect(result.name).toBe("Updated");
  });

  it("deleteCronJob sends DELETE to /api/cron/jobs/:id", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ok: true }));

    await api.deleteCronJob("cron-1");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/cron/jobs/cron-1");
    expect(opts.method).toBe("DELETE");
  });

  it("toggleCronJob sends POST to /api/cron/jobs/:id/toggle", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ...mockJob, enabled: false }));

    const result = await api.toggleCronJob("cron-1");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/cron/jobs/cron-1/toggle");
    expect(opts.method).toBe("POST");
    expect(result.enabled).toBe(false);
  });

  it("runCronJob sends POST to /api/cron/jobs/:id/run", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ok: true }));

    await api.runCronJob("cron-1");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/cron/jobs/cron-1/run");
    expect(opts.method).toBe("POST");
  });

  it("getCronJobExecutions sends GET to /api/cron/jobs/:id/executions", async () => {
    const executions = [{ sessionId: "s1", jobId: "cron-1", startedAt: 1000, completedAt: 2000, success: true }];
    mockFetch.mockResolvedValueOnce(mockResponse(executions));

    const result = await api.getCronJobExecutions("cron-1");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/cron/jobs/cron-1/executions");
    expect(result).toEqual(executions);
  });
});

// ===========================================================================
// Background process management
// ===========================================================================
describe("process management API", () => {
  it("killProcess sends POST to /api/sessions/:id/processes/:taskId/kill", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ok: true, taskId: "task-1" }));

    const result = await api.killProcess("sess-1", "task-1");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/sessions/sess-1/processes/task-1/kill");
    expect(opts.method).toBe("POST");
    expect(result).toEqual({ ok: true, taskId: "task-1" });
  });

  it("killAllProcesses sends POST with taskIds array", async () => {
    const data = { ok: true, results: [{ taskId: "t1", ok: true }, { taskId: "t2", ok: true }] };
    mockFetch.mockResolvedValueOnce(mockResponse(data));

    const result = await api.killAllProcesses("sess-1", ["t1", "t2"]);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/sessions/sess-1/processes/kill-all");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({ taskIds: ["t1", "t2"] });
    expect(result).toEqual(data);
  });

  it("getSystemProcesses sends GET to /api/sessions/:id/processes/system", async () => {
    const data = { ok: true, processes: [{ pid: 1234, command: "node", fullCommand: "node server.js", ports: [3000] }] };
    mockFetch.mockResolvedValueOnce(mockResponse(data));

    const result = await api.getSystemProcesses("sess-1");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/sessions/sess-1/processes/system");
    expect(result).toEqual(data);
  });

  it("killSystemProcess sends POST with pid in URL", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ok: true, pid: 1234 }));

    const result = await api.killSystemProcess("sess-1", 1234);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/sessions/sess-1/processes/system/1234/kill");
    expect(opts.method).toBe("POST");
    expect(result).toEqual({ ok: true, pid: 1234 });
  });
});

// ===========================================================================
// Agents API
// ===========================================================================
describe("agents API", () => {
  const mockAgent = {
    id: "agent-1",
    version: 1,
    name: "Test Agent",
    description: "A test agent",
    backendType: "claude" as const,
    model: "opus",
    permissionMode: "auto",
    cwd: "/repo",
    prompt: "You are a test agent",
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    totalRuns: 0,
    consecutiveFailures: 0,
  };

  it("listAgents sends GET to /api/agents", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse([mockAgent]));

    const result = await api.listAgents();

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/agents");
    expect(result).toEqual([mockAgent]);
  });

  it("getAgent sends GET to /api/agents/:id", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(mockAgent));

    const result = await api.getAgent("agent-1");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/agents/agent-1");
    expect(result).toEqual(mockAgent);
  });

  it("createAgent sends POST to /api/agents", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(mockAgent));

    const result = await api.createAgent({ name: "Test Agent", prompt: "hello" });

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/agents");
    expect(opts.method).toBe("POST");
    expect(result).toEqual(mockAgent);
  });

  it("updateAgent sends PUT to /api/agents/:id", async () => {
    const updated = { ...mockAgent, name: "Updated Agent" };
    mockFetch.mockResolvedValueOnce(mockResponse(updated));

    const result = await api.updateAgent("agent-1", { name: "Updated Agent" });

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/agents/agent-1");
    expect(opts.method).toBe("PUT");
    expect(JSON.parse(opts.body)).toEqual({ name: "Updated Agent" });
    expect(result.name).toBe("Updated Agent");
  });

  it("deleteAgent sends DELETE to /api/agents/:id", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ok: true }));

    await api.deleteAgent("agent-1");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/agents/agent-1");
    expect(opts.method).toBe("DELETE");
  });

  it("toggleAgent sends POST to /api/agents/:id/toggle", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ...mockAgent, enabled: false }));

    const result = await api.toggleAgent("agent-1");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/agents/agent-1/toggle");
    expect(opts.method).toBe("POST");
    expect(result.enabled).toBe(false);
  });

  it("runAgent sends POST to /api/agents/:id/run with optional input", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ok: true, message: "Agent started" }));

    const result = await api.runAgent("agent-1", "Do something");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/agents/agent-1/run");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({ input: "Do something" });
    expect(result).toEqual({ ok: true, message: "Agent started" });
  });

  it("getAgentExecutions sends GET to /api/agents/:id/executions", async () => {
    const executions = [{ sessionId: "s1", agentId: "agent-1", triggerType: "manual", startedAt: 100 }];
    mockFetch.mockResolvedValueOnce(mockResponse(executions));

    const result = await api.getAgentExecutions("agent-1");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/agents/agent-1/executions");
    expect(result).toEqual(executions);
  });

  it("importAgent sends POST to /api/agents/import", async () => {
    const exportData = { version: 1, name: "Imported", description: "Imported agent", backendType: "claude" as const, model: "opus", permissionMode: "auto", cwd: "/repo", prompt: "hello" };
    mockFetch.mockResolvedValueOnce(mockResponse(mockAgent));

    const result = await api.importAgent(exportData as any);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/agents/import");
    expect(opts.method).toBe("POST");
    expect(result).toEqual(mockAgent);
  });

  it("exportAgent sends GET to /api/agents/:id/export", async () => {
    const exportData = { version: 1, name: "Test Agent", description: "A test agent" };
    mockFetch.mockResolvedValueOnce(mockResponse(exportData));

    const result = await api.exportAgent("agent-1");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/agents/agent-1/export");
    expect(result).toEqual(exportData);
  });

  it("regenerateAgentWebhookSecret sends POST to /api/agents/:id/regenerate-secret", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(mockAgent));

    const result = await api.regenerateAgentWebhookSecret("agent-1");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/agents/agent-1/regenerate-secret");
    expect(opts.method).toBe("POST");
    expect(result).toEqual(mockAgent);
  });
});

// ===========================================================================
// Skills API
// ===========================================================================
describe("skills API", () => {
  it("listSkills sends GET to /api/skills", async () => {
    const skills = [{ slug: "commit", name: "Commit", description: "Create a git commit", path: "/home/.claude/skills/commit.md" }];
    mockFetch.mockResolvedValueOnce(mockResponse(skills));

    const result = await api.listSkills();

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/skills");
    expect(result).toEqual(skills);
  });
});

// ===========================================================================
// Cross-session messaging
// ===========================================================================
describe("sendSessionMessage", () => {
  it("sends POST to /api/sessions/:id/message with content body", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ok: true }));

    const result = await api.sendSessionMessage("sess-1", "Hello from another session");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/sessions/sess-1/message");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({ content: "Hello from another session" });
    expect(result).toEqual({ ok: true });
  });
});

// ===========================================================================
// Saved prompts API
// ===========================================================================
describe("saved prompts API", () => {
  const mockPrompt = {
    id: "p1",
    name: "Fix tests",
    content: "Please fix the failing tests",
    scope: "global" as const,
    createdAt: 1,
    updatedAt: 1,
  };

  it("listPrompts sends GET to /api/prompts without params", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse([mockPrompt]));

    const result = await api.listPrompts();

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/prompts");
    expect(result).toEqual([mockPrompt]);
  });

  it("listPrompts includes cwd and scope as query params", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse([mockPrompt]));

    await api.listPrompts("/repo", "project");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe(`/api/prompts?cwd=${encodeURIComponent("/repo")}&scope=project`);
  });

  it("listPrompts includes only cwd when scope is omitted", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse([]));

    await api.listPrompts("/repo");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe(`/api/prompts?cwd=${encodeURIComponent("/repo")}`);
  });

  it("createPrompt sends POST to /api/prompts", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(mockPrompt));

    const result = await api.createPrompt({
      name: "Fix tests",
      content: "Please fix the failing tests",
      scope: "global",
    });

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/prompts");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({
      name: "Fix tests",
      content: "Please fix the failing tests",
      scope: "global",
    });
    expect(result).toEqual(mockPrompt);
  });

  it("createPrompt includes cwd for project-scoped prompts", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ...mockPrompt, scope: "project", projectPath: "/repo" }));

    await api.createPrompt({
      name: "Fix tests",
      content: "Please fix the failing tests",
      scope: "project",
      cwd: "/repo",
    });

    const [, opts] = mockFetch.mock.calls[0];
    expect(JSON.parse(opts.body)).toEqual({
      name: "Fix tests",
      content: "Please fix the failing tests",
      scope: "project",
      cwd: "/repo",
    });
  });

  it("createPrompt includes projectPaths for multi-folder targeting", async () => {
    // Validates projectPaths array is sent in the POST body.
    mockFetch.mockResolvedValueOnce(mockResponse({ ...mockPrompt, scope: "project", projectPaths: ["/repo-a", "/repo-b"] }));

    await api.createPrompt({
      name: "Fix tests",
      content: "Please fix the failing tests",
      scope: "project",
      projectPaths: ["/repo-a", "/repo-b"],
    });

    const [, opts] = mockFetch.mock.calls[0];
    expect(JSON.parse(opts.body)).toEqual({
      name: "Fix tests",
      content: "Please fix the failing tests",
      scope: "project",
      projectPaths: ["/repo-a", "/repo-b"],
    });
  });

  it("updatePrompt sends scope and projectPaths", async () => {
    // Validates scope and projectPaths updates are included in PUT body.
    const updated = { ...mockPrompt, scope: "project" as const, projectPaths: ["/repo"] };
    mockFetch.mockResolvedValueOnce(mockResponse(updated));

    await api.updatePrompt("p1", { scope: "project", projectPaths: ["/repo"] });

    const [, opts] = mockFetch.mock.calls[0];
    expect(JSON.parse(opts.body)).toEqual({ scope: "project", projectPaths: ["/repo"] });
  });

  it("updatePrompt sends PUT to /api/prompts/:id", async () => {
    const updated = { ...mockPrompt, name: "Updated name" };
    mockFetch.mockResolvedValueOnce(mockResponse(updated));

    const result = await api.updatePrompt("p1", { name: "Updated name" });

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/prompts/p1");
    expect(opts.method).toBe("PUT");
    expect(JSON.parse(opts.body)).toEqual({ name: "Updated name" });
    expect(result).toEqual(updated);
  });

  it("deletePrompt sends DELETE to /api/prompts/:id", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ok: true }));

    await api.deletePrompt("p1");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/prompts/p1");
    expect(opts.method).toBe("DELETE");
  });
});

// ===========================================================================
// PUT / PATCH / DELETE error handling (verifies these HTTP helpers work like post/get)
// ===========================================================================
describe("put() error handling", () => {
  it("throws with error message from JSON body on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ error: "Env not found" }, 404));

    await expect(api.updateEnv("missing", { name: "X" })).rejects.toThrow("Env not found");
    expect(captureEventMock).toHaveBeenCalledWith(
      "api_request_failed",
      expect.objectContaining({ method: "PUT", status: 404 }),
    );
  });
});

describe("patch() error handling", () => {
  it("throws with error message from JSON body on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ error: "Name too long" }, 400));

    await expect(api.renameSession("sess-1", "x".repeat(500))).rejects.toThrow("Name too long");
    expect(captureEventMock).toHaveBeenCalledWith(
      "api_request_failed",
      expect.objectContaining({ method: "PATCH", status: 400 }),
    );
  });
});

describe("del() error handling", () => {
  it("throws with error message from JSON body on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ error: "Cannot delete active session" }, 409));

    await expect(api.deleteSession("active-sess")).rejects.toThrow("Cannot delete active session");
    expect(captureEventMock).toHaveBeenCalledWith(
      "api_request_failed",
      expect.objectContaining({ method: "DELETE", status: 409 }),
    );
  });
});

// ===========================================================================
// Browser preview API
// ===========================================================================
describe("browser preview API", () => {
  it("navigateBrowser sends POST with url body", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ok: true }));

    const result = await api.navigateBrowser("sess-1", "https://example.com");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/sessions/sess-1/browser/navigate");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({ url: "https://example.com" });
    expect(result).toEqual({ ok: true });
  });
});

// ===========================================================================
// Linear OAuth API (Agent Interaction SDK)
// ===========================================================================
describe("Linear OAuth API", () => {
  it("getLinearOAuthStatus sends GET without params when no stagingId", async () => {
    const data = { configured: true, hasClientId: true, hasClientSecret: true, hasWebhookSecret: true, hasAccessToken: true };
    mockFetch.mockResolvedValueOnce(mockResponse(data));

    const result = await api.getLinearOAuthStatus();

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/linear/oauth/status");
    expect(result).toEqual(data);
  });

  it("getLinearOAuthStatus includes stagingId query param", async () => {
    const data = { configured: false, hasClientId: true, hasClientSecret: true, hasWebhookSecret: false, hasAccessToken: false };
    mockFetch.mockResolvedValueOnce(mockResponse(data));

    const result = await api.getLinearOAuthStatus("staging-abc");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/linear/oauth/status?stagingId=staging-abc");
    expect(result).toEqual(data);
  });

  it("getLinearOAuthAuthorizeUrl sends GET without params", async () => {
    const data = { url: "https://linear.app/oauth/authorize?client_id=xxx" };
    mockFetch.mockResolvedValueOnce(mockResponse(data));

    const result = await api.getLinearOAuthAuthorizeUrl();

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/linear/oauth/authorize-url");
    expect(result).toEqual(data);
  });

  it("getLinearOAuthAuthorizeUrl includes returnTo and stagingId params", async () => {
    const data = { url: "https://linear.app/oauth/authorize?client_id=xxx" };
    mockFetch.mockResolvedValueOnce(mockResponse(data));

    const result = await api.getLinearOAuthAuthorizeUrl("/#/settings", "staging-xyz");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/linear/oauth/authorize-url?");
    expect(url).toContain("returnTo=%2F%23%2Fsettings");
    expect(url).toContain("stagingId=staging-xyz");
    expect(result).toEqual(data);
  });

  it("disconnectLinearOAuth sends POST to /linear/oauth/disconnect", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ok: true }));

    const result = await api.disconnectLinearOAuth();

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/linear/oauth/disconnect");
    expect(opts.method).toBe("POST");
    expect(result).toEqual({ ok: true });
  });
});

// ===========================================================================
// Linear OAuth staging slots API
// ===========================================================================
describe("Linear OAuth staging API", () => {
  it("createLinearStaging sends POST with credentials", async () => {
    const creds = { clientId: "cid", clientSecret: "csec", webhookSecret: "wsec" };
    mockFetch.mockResolvedValueOnce(mockResponse({ stagingId: "slot-123" }));

    const result = await api.createLinearStaging(creds);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/linear/oauth/staging");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual(creds);
    expect(result).toEqual({ stagingId: "slot-123" });
  });

  it("getLinearStagingStatus sends GET with encoded id", async () => {
    const data = { exists: true, hasAccessToken: true, hasClientId: true, hasClientSecret: true };
    mockFetch.mockResolvedValueOnce(mockResponse(data));

    const result = await api.getLinearStagingStatus("slot-123");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/linear/oauth/staging/slot-123/status");
    expect(result).toEqual(data);
  });

  it("deleteLinearStaging sends DELETE with encoded id", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ok: true }));

    await api.deleteLinearStaging("slot-123");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/linear/oauth/staging/slot-123");
    expect(opts.method).toBe("DELETE");
  });
});

// ===========================================================================
// createLinearIssue — covers previously untested one-liner
// ===========================================================================
describe("createLinearIssue", () => {
  it("sends POST to /api/linear/issues", async () => {
    const input = { title: "Bug report", teamId: "team-1" };
    const responseData = { ok: true, issue: { id: "ISS-1", ...input } };
    mockFetch.mockResolvedValueOnce(mockResponse(responseData));

    const result = await api.createLinearIssue(input as Parameters<typeof api.createLinearIssue>[0]);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/linear/issues");
    expect(opts.method).toBe("POST");
    expect(result).toEqual(responseData);
  });
});

// ===========================================================================
// listExecutions — covers URLSearchParams builder logic (lines 1142-1151)
// ===========================================================================
describe("listExecutions", () => {
  it("sends GET to /api/executions without query params when no opts", async () => {
    const responseData = { executions: [], total: 0 };
    mockFetch.mockResolvedValueOnce(mockResponse(responseData));

    await api.listExecutions();

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/executions");
  });

  it("builds query string from all provided options", async () => {
    const responseData = { executions: [], total: 0 };
    mockFetch.mockResolvedValueOnce(mockResponse(responseData));

    await api.listExecutions({
      agentId: "agent-1",
      triggerType: "webhook",
      status: "completed",
      limit: 10,
      offset: 20,
    });

    const [url] = mockFetch.mock.calls[0];
    // Verify all params are present in the query string
    expect(url).toContain("/api/executions?");
    expect(url).toContain("agentId=agent-1");
    expect(url).toContain("triggerType=webhook");
    expect(url).toContain("status=completed");
    expect(url).toContain("limit=10");
    expect(url).toContain("offset=20");
  });

  it("only includes provided params in query string", async () => {
    const responseData = { executions: [], total: 0 };
    mockFetch.mockResolvedValueOnce(mockResponse(responseData));

    await api.listExecutions({ status: "running" });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/executions?status=running");
  });
});

// ===========================================================================
// IDE integration (Task 9 — STATE-02)
//
// Three REST wrappers that back the `/ide` composer flow:
//   - getAvailableIdes(cwd?)      → GET  /api/ide/available
//   - bindIde(sessionId, port)    → POST /api/sessions/:id/ide
//   - unbindIde(sessionId)        → DELETE /api/sessions/:id/ide
//
// Contract details covered here:
//   - getAvailableIdes throws on non-200 (caller decides how to surface).
//   - bindIde returns a discriminated union {ok:true, binding} | {ok:false, error};
//     it must NOT throw for 400/404 — those are normal "bind failed" UX paths.
//   - unbindIde returns {ok:true} on 200 and THROWS on 404 (session truly gone).
// ===========================================================================
import { getAvailableIdes, bindIde, unbindIde } from "./api.js";

describe("getAvailableIdes (Task 9)", () => {
  it("sends GET /api/ide/available with no query string when cwd is omitted", async () => {
    const payload = [
      {
        port: 50001,
        ideName: "Neovim",
        workspaceFolders: ["/Users/x/repo"],
        transport: "ws-ide" as const,
        lockfilePath: "/Users/x/.claude/ide/50001.lock",
        lockfileMtime: 1_700_000_000_000,
      },
    ];
    mockFetch.mockResolvedValueOnce(mockResponse(payload));

    const result = await getAvailableIdes();

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/ide/available");
    expect(result).toEqual(payload);
  });

  it("URL-encodes cwd into the query string when provided", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse([]));

    await getAvailableIdes("/Users/me/my project");

    const [url] = mockFetch.mock.calls[0];
    // encodeURIComponent turns spaces into %20 and '/' into %2F
    expect(url).toBe("/api/ide/available?cwd=%2FUsers%2Fme%2Fmy%20project");
  });

  it("throws an Error when the server responds non-2xx (caller handles)", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ error: "boom" }, 500));

    await expect(getAvailableIdes()).rejects.toThrow("boom");
  });

  // Codex adversarial review (BRITTLE 1): the picker uses an AbortController
  // to cancel superseded / post-unmount requests. The api wrapper must thread
  // the caller-supplied AbortSignal through to the underlying fetch() call so
  // that aborting the controller actually cancels the HTTP request (not just
  // suppresses the setState branch). This test pins that contract.
  it("threads the caller-supplied AbortSignal through to fetch()", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse([]));
    const controller = new AbortController();

    await getAvailableIdes("/tmp/x", controller.signal);

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts?.signal).toBe(controller.signal);
  });

  // ─── cubic PR #652 round-3 (P2): AbortError must not be tracked as a failure ─
  //
  // Context: after we added abortable GETs (BRITTLE 1), IdePicker cleanup
  // cancels in-flight `/api/ide/available` requests. fetch() rejects with
  // an AbortError (a DOMException in browsers, a plain Error in jsdom), which
  // the outer catch forwarded to `trackApiFailure` → analytics. Those events
  // are noise: the cancellation is expected UX, not a server / transport
  // fault. `trackApiFailure` also calls `captureException`, so the noise
  // surfaces in Sentry too.
  //
  // Fix: in every `catch (error)` path that reports to `trackApiFailure`,
  // skip tracking when the error name is "AbortError". Still rethrow so
  // callers can distinguish the cancellation from a real failure.
  //
  // Abort-01 / Abort-02 pin the contract on BOTH sides of the branch.
  it("Abort-01: rethrows AbortError but does NOT report a failure to analytics", async () => {
    // Build an AbortError shaped like the one jsdom / node-fetch produces.
    // Using a plain Error with name=AbortError matches the node path; the
    // production browser path produces a DOMException with the same .name.
    // Both must be treated identically.
    const abortError = new Error("The operation was aborted.");
    abortError.name = "AbortError";
    mockFetch.mockRejectedValueOnce(abortError);

    const controller = new AbortController();
    // Abort immediately — we don't actually need the signal to fire for
    // fetch to reject; the mock simulates the post-abort rejection itself.
    controller.abort();

    await expect(
      getAvailableIdes(undefined, controller.signal),
    ).rejects.toThrow("The operation was aborted.");

    // Critical regression guard: neither tracking path must fire for a
    // cancellation. `api_request_failed` is the analytics event;
    // captureException feeds Sentry.
    expect(captureEventMock).not.toHaveBeenCalledWith(
      "api_request_failed",
      expect.anything(),
    );
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it("Abort-02: a non-abort network error STILL reports a failure (regression guard)", async () => {
    // Make sure the AbortError branch didn't accidentally short-circuit the
    // normal failure-tracking path for real transport errors.
    mockFetch.mockRejectedValueOnce(new Error("Network down"));

    await expect(getAvailableIdes()).rejects.toThrow("Network down");

    expect(captureEventMock).toHaveBeenCalledWith(
      "api_request_failed",
      expect.objectContaining({ method: "GET", path: "/ide/available" }),
    );
    expect(captureExceptionMock).toHaveBeenCalled();
  });

  // ─── Abort-03: explicit DOMException branch (codex round-4 NIT) ────────────
  //
  // Context: `isAbortError` has two branches — a `DOMException` check (the
  // production browser shape) and a plain-Error fallback (jsdom / node-fetch).
  // Abort-01 covers the plain-Error path; the NIT asks for explicit coverage
  // of the DOMException path too so a future edit cannot regress one branch
  // in isolation. jsdom's `DOMException` constructor accepts `(message, name)`
  // and sets `.name` correctly, which is exactly what production browsers do.
  it("Abort-03: DOMException with name=AbortError is also treated as a cancellation (DOMException branch)", async () => {
    // In jsdom, `DOMException` is a real constructor. Using it here exercises
    // the `error instanceof DOMException` branch of `isAbortError`, which
    // Abort-01 (plain Error) does NOT reach.
    const domAbort = new DOMException("The operation was aborted.", "AbortError");
    expect(domAbort).toBeInstanceOf(DOMException);
    expect(domAbort.name).toBe("AbortError");

    mockFetch.mockRejectedValueOnce(domAbort);

    const controller = new AbortController();
    controller.abort();

    await expect(
      getAvailableIdes(undefined, controller.signal),
    ).rejects.toThrow("The operation was aborted.");

    // Same contract as Abort-01: no analytics noise, no Sentry capture.
    expect(captureEventMock).not.toHaveBeenCalledWith(
      "api_request_failed",
      expect.anything(),
    );
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });
});

describe("bindIde (Task 9)", () => {
  it("POSTs JSON { port } to /api/sessions/:id/ide and returns {ok:true, binding} on 200", async () => {
    const binding = {
      port: 50001,
      ideName: "Neovim",
      workspaceFolders: ["/Users/x/repo"],
      transport: "ws-ide" as const,
      boundAt: 1_700_000_000_000,
      lockfilePath: "/Users/x/.claude/ide/50001.lock",
    };
    mockFetch.mockResolvedValueOnce(mockResponse({ ok: true, binding }));

    const result = await bindIde("sess-A", 50001);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/sessions/sess-A/ide");
    expect(opts.method).toBe("POST");
    expect(opts.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(opts.body)).toEqual({ port: 50001 });
    // Narrow to success branch and verify binding flows through unchanged.
    if (!result.ok) throw new Error("expected ok:true");
    expect(result.binding).toEqual(binding);
  });

  it("URL-encodes the sessionId so slashes / spaces in ids cannot break the path", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ok: true, binding: null }));

    await bindIde("weird/id with space", 123);

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/sessions/weird%2Fid%20with%20space/ide");
  });

  it("returns {ok:false, error} (no throw) on 400 — unknown port is a normal UX path", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({ error: "unknown port" }, 400),
    );

    const result = await bindIde("sess-A", 99999);
    expect(result).toEqual({ ok: false, error: "unknown port" });
  });

  it("returns {ok:false, error} (no throw) on 404 — missing session surfaces as a failure, not an exception", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({ error: "session not found" }, 404),
    );

    const result = await bindIde("sess-gone", 50001);
    expect(result).toEqual({ ok: false, error: "session not found" });
  });

  it("falls back to statusText when the error body has no { error } field", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      json: () => Promise.reject(new Error("no body")),
    });

    const result = await bindIde("sess-A", 1);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok:false");
    expect(result.error).toBe("Bad Request");
  });
});

describe("unbindIde (Task 9)", () => {
  it("DELETEs /api/sessions/:id/ide and returns {ok:true} on 200", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ok: true }));

    const result = await unbindIde("sess-A");

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/sessions/sess-A/ide");
    expect(opts.method).toBe("DELETE");
    expect(result).toEqual({ ok: true });
  });

  // Session genuinely gone is an exceptional condition — throw so callers
  // cannot accidentally treat it as a successful clear.
  it("throws on 404 — the session no longer exists", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({ error: "session not found" }, 404),
    );

    await expect(unbindIde("sess-gone")).rejects.toThrow("session not found");
  });
});
