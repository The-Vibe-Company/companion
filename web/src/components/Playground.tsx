import { useState, useEffect, useMemo } from "react";
import { PermissionBanner } from "./PermissionBanner.js";
import { MessageBubble } from "./MessageBubble.js";
import {
  ToolBlock,
  getToolIcon,
  getToolLabel,
  getPreview,
  ToolIcon,
} from "./ToolBlock.js";
import { DiffViewer } from "./DiffViewer.js";
import { useStore } from "../store.js";
import { navigateToSession, navigateHome } from "../utils/routing.js";
import { UpdateBanner } from "./UpdateBanner.js";
import { ClaudeMdEditor } from "./ClaudeMdEditor.js";
import { ChatView } from "./ChatView.js";
import { api } from "../api.js";
import type {
  PermissionRequest,
  ChatMessage,
  ContentBlock,
  SessionState,
  McpServerDetail,
} from "../types.js";
import { AiValidationBadge } from "./AiValidationBadge.js";
import { AiValidationToggle } from "./AiValidationToggle.js";
import type { TaskItem } from "../types.js";
import type {
  UpdateInfo,
  GitHubPRInfo,
  LinearIssue,
  LinearComment,
} from "../api.js";
import {
  GitHubPRDisplay,
  CodexRateLimitsSection,
  CodexTokenDetailsSection,
} from "./TaskPanel.js";
import { LinearLogo } from "./LinearLogo.js";
import { SessionCreationProgress } from "./SessionCreationProgress.js";
import { SessionLaunchOverlay } from "./SessionLaunchOverlay.js";
import { PlaygroundUpdateOverlay } from "./UpdateOverlay.js";
import { SessionItem } from "./SessionItem.js";
import type { CreationProgressEvent } from "../types.js";
import type { SessionItem as SessionItemType } from "../utils/project-grouping.js";

// ─── Mock Data ──────────────────────────────────────────────────────────────

const MOCK_SESSION_ID = "playground-session";

function mockPermission(
  overrides: Partial<PermissionRequest> & {
    tool_name: string;
    input: Record<string, unknown>;
  },
): PermissionRequest {
  return {
    request_id: `perm-${Math.random().toString(36).slice(2, 8)}`,
    tool_use_id: `tu-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    ...overrides,
  };
}

const PERM_BASH = mockPermission({
  tool_name: "Bash",
  input: {
    command: "git log --oneline -20 && npm run build",
    description: "View recent commits and build the project",
  },
  permission_suggestions: [
    {
      type: "addRules" as const,
      rules: [
        {
          toolName: "Bash",
          ruleContent: "git log --oneline -20 && npm run build",
        },
      ],
      behavior: "allow" as const,
      destination: "session" as const,
    },
    {
      type: "addRules" as const,
      rules: [
        {
          toolName: "Bash",
          ruleContent: "git log --oneline -20 && npm run build",
        },
      ],
      behavior: "allow" as const,
      destination: "projectSettings" as const,
    },
  ],
});

const PERM_EDIT = mockPermission({
  tool_name: "Edit",
  input: {
    file_path: "/Users/stan/Dev/project/src/utils/format.ts",
    old_string:
      "export function formatDate(d: Date) {\n  return d.toISOString();\n}",
    new_string:
      'export function formatDate(d: Date, locale = "en-US") {\n  return d.toLocaleDateString(locale, {\n    year: "numeric",\n    month: "short",\n    day: "numeric",\n  });\n}',
  },
  permission_suggestions: [
    {
      type: "addRules" as const,
      rules: [{ toolName: "Edit" }],
      behavior: "allow" as const,
      destination: "session" as const,
    },
  ],
});

const PERM_WRITE = mockPermission({
  tool_name: "Write",
  input: {
    file_path: "/Users/stan/Dev/project/src/config.ts",
    content:
      'export const config = {\n  apiUrl: "https://api.example.com",\n  timeout: 5000,\n  retries: 3,\n  debug: process.env.NODE_ENV !== "production",\n};\n',
  },
});

const PERM_READ = mockPermission({
  tool_name: "Read",
  input: { file_path: "/Users/stan/Dev/project/package.json" },
  permission_suggestions: [
    {
      type: "addRules" as const,
      rules: [{ toolName: "Read" }],
      behavior: "allow" as const,
      destination: "session" as const,
    },
    {
      type: "addRules" as const,
      rules: [{ toolName: "Read" }],
      behavior: "allow" as const,
      destination: "userSettings" as const,
    },
  ],
});

const PERM_GLOB = mockPermission({
  tool_name: "Glob",
  input: { pattern: "**/*.test.ts", path: "/Users/stan/Dev/project/src" },
});

const PERM_GREP = mockPermission({
  tool_name: "Grep",
  input: {
    pattern: "TODO|FIXME|HACK",
    path: "/Users/stan/Dev/project/src",
    glob: "*.ts",
  },
});

const PERM_EXIT_PLAN = mockPermission({
  tool_name: "ExitPlanMode",
  input: {
    plan: `## Summary\nRefactor the authentication module to use JWT tokens instead of session cookies.\n\n## Changes\n1. **Add JWT utility** — new \`src/auth/jwt.ts\` with sign/verify helpers\n2. **Update middleware** — modify \`src/middleware/auth.ts\` to validate Bearer tokens\n3. **Migrate login endpoint** — return JWT in response body instead of Set-Cookie\n4. **Update tests** — adapt all auth tests to use token-based flow\n\n## Test plan\n- Run \`npm test -- --grep auth\`\n- Manual test with curl`,
    allowedPrompts: [
      { tool: "Bash", prompt: "run tests" },
      { tool: "Bash", prompt: "install dependencies" },
    ],
  },
});

const PERM_GENERIC = mockPermission({
  tool_name: "WebSearch",
  input: {
    query: "TypeScript 5.5 new features",
    allowed_domains: ["typescriptlang.org", "github.com"],
  },
  description: "Search the web for TypeScript 5.5 features",
});

const PERM_DYNAMIC = mockPermission({
  tool_name: "dynamic:code_interpreter",
  input: { code: "print('hello from dynamic tool')" },
  description: "Custom tool call: code_interpreter",
});

// AI Validation mock: uncertain verdict (shown to user with recommendation)
const PERM_AI_UNCERTAIN = mockPermission({
  tool_name: "Bash",
  input: { command: "npm install --save-dev @types/react" },
  ai_validation: {
    verdict: "uncertain",
    reason: "Package installation modifies node_modules",
    ruleBasedOnly: false,
  },
});

// AI Validation mock: safe recommendation (shown when auto-approve is off)
const PERM_AI_SAFE = mockPermission({
  tool_name: "Bash",
  input: { command: "git status" },
  ai_validation: {
    verdict: "safe",
    reason: "Read-only git command",
    ruleBasedOnly: false,
  },
});

// AI Validation mock: dangerous recommendation (shown when auto-deny is off)
const PERM_AI_DANGEROUS = mockPermission({
  tool_name: "Bash",
  input: { command: "rm -rf node_modules && rm -rf .git" },
  ai_validation: {
    verdict: "dangerous",
    reason: "Recursive delete of project files",
    ruleBasedOnly: false,
  },
});

const PERM_ASK_SINGLE = mockPermission({
  tool_name: "AskUserQuestion",
  input: {
    questions: [
      {
        header: "Auth method",
        question: "Which authentication method should we use for the API?",
        options: [
          {
            label: "JWT tokens (Recommended)",
            description: "Stateless, scalable, works well with microservices",
          },
          {
            label: "Session cookies",
            description:
              "Traditional approach, simpler but requires session storage",
          },
          {
            label: "OAuth 2.0",
            description: "Delegated auth, best for third-party integrations",
          },
        ],
        multiSelect: false,
      },
    ],
  },
});

const PERM_ASK_MULTI = mockPermission({
  tool_name: "AskUserQuestion",
  input: {
    questions: [
      {
        header: "Database",
        question: "Which database should we use?",
        options: [
          {
            label: "PostgreSQL",
            description: "Relational, strong consistency",
          },
          { label: "MongoDB", description: "Document store, flexible schema" },
        ],
        multiSelect: false,
      },
      {
        header: "Cache",
        question: "Do you want to add a caching layer?",
        options: [
          { label: "Redis", description: "In-memory, fast, supports pub/sub" },
          { label: "No cache", description: "Keep it simple for now" },
        ],
        multiSelect: false,
      },
    ],
  },
});

// Messages
const MSG_USER: ChatMessage = {
  id: "msg-1",
  role: "user",
  content:
    "Can you help me refactor the authentication module to use JWT tokens?",
  timestamp: Date.now() - 60000,
};

const MSG_USER_IMAGE: ChatMessage = {
  id: "msg-2",
  role: "user",
  content: "Here's a screenshot of the error I'm seeing",
  images: [
    {
      media_type: "image/png",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg==",
    },
  ],
  timestamp: Date.now() - 55000,
};

const MSG_ASSISTANT: ChatMessage = {
  id: "msg-3",
  role: "assistant",
  content: "",
  contentBlocks: [
    {
      type: "text",
      text: "I'll help you refactor the authentication module. Let me first look at the current implementation.\n\nHere's what I found:\n- The current auth uses **session cookies** via `express-session`\n- Sessions are stored in a `MemoryStore` (not production-ready)\n- The middleware checks `req.session.userId`\n\n```typescript\n// Current implementation\napp.use(session({\n  secret: process.env.SESSION_SECRET,\n  resave: false,\n  saveUninitialized: false,\n}));\n```\n\n| Feature | Cookies | JWT |\n|---------|---------|-----|\n| Stateless | No | Yes |\n| Scalable | Limited | Excellent |\n| Revocation | Easy | Needs blocklist |\n",
    },
  ],
  timestamp: Date.now() - 50000,
};

const MSG_ASSISTANT_TOOLS: ChatMessage = {
  id: "msg-4",
  role: "assistant",
  content: "",
  contentBlocks: [
    { type: "text", text: "Let me check the current auth files." },
    {
      type: "tool_use",
      id: "tu-1",
      name: "Glob",
      input: { pattern: "src/auth/**/*.ts" },
    },
    {
      type: "tool_result",
      tool_use_id: "tu-1",
      content: "src/auth/middleware.ts\nsrc/auth/login.ts\nsrc/auth/session.ts",
    },
    {
      type: "tool_use",
      id: "tu-2",
      name: "Read",
      input: { file_path: "src/auth/middleware.ts" },
    },
    {
      type: "tool_result",
      tool_use_id: "tu-2",
      content:
        'export function authMiddleware(req, res, next) {\n  if (!req.session.userId) {\n    return res.status(401).json({ error: "Unauthorized" });\n  }\n  next();\n}',
    },
    {
      type: "text",
      text: "Now I understand the current structure. Let me create the JWT utility.",
    },
  ],
  timestamp: Date.now() - 45000,
};

const MSG_ASSISTANT_THINKING: ChatMessage = {
  id: "msg-5",
  role: "assistant",
  content: "",
  contentBlocks: [
    {
      type: "thinking",
      thinking:
        "Let me think about the best approach here. The user wants to migrate from session cookies to JWT. I need to:\n1. Create a JWT sign/verify utility\n2. Update the middleware to read Authorization header\n3. Change the login endpoint to return a token\n4. Update all tests\n\nI should use jsonwebtoken package for signing and jose for verification in edge environments. But since this is a Node.js server, jsonwebtoken is fine.\n\nThe token should contain: userId, role, iat, exp. Expiry should be configurable. I'll also add a refresh token mechanism.",
    },
    {
      type: "text",
      text: "I've analyzed the codebase and have a clear plan. Let me start implementing.",
    },
  ],
  timestamp: Date.now() - 40000,
};

const MSG_ASSISTANT_STREAMING: ChatMessage = {
  id: "msg-streaming",
  role: "assistant",
  content: "Scanning auth files and drafting migration steps...",
  isStreaming: true,
  timestamp: Date.now() - 35000,
};

const MSG_SYSTEM: ChatMessage = {
  id: "msg-6",
  role: "system",
  content: "Context compacted successfully",
  timestamp: Date.now() - 30000,
};

// Tool result with error
const MSG_TOOL_ERROR: ChatMessage = {
  id: "msg-7",
  role: "assistant",
  content: "",
  contentBlocks: [
    { type: "text", text: "Let me try running the tests." },
    {
      type: "tool_use",
      id: "tu-3",
      name: "Bash",
      input: { command: "npm test -- --grep auth" },
    },
    {
      type: "tool_result",
      tool_use_id: "tu-3",
      content:
        "FAIL src/auth/__tests__/middleware.test.ts\n  ● Auth Middleware › should reject expired tokens\n    Expected: 401\n    Received: 500\n\n    TypeError: Cannot read property 'verify' of undefined",
      is_error: true,
    },
    { type: "text", text: "There's a test failure. Let me fix the issue." },
  ],
  timestamp: Date.now() - 20000,
};

// Tasks
const MOCK_TASKS: TaskItem[] = [
  {
    id: "1",
    subject: "Create JWT utility module",
    description: "",
    status: "completed",
  },
  {
    id: "2",
    subject: "Update auth middleware",
    description: "",
    status: "completed",
    activeForm: "Updating auth middleware",
  },
  {
    id: "3",
    subject: "Migrate login endpoint",
    description: "",
    status: "in_progress",
    activeForm: "Refactoring login to return JWT",
  },
  {
    id: "4",
    subject: "Add refresh token support",
    description: "",
    status: "pending",
  },
  {
    id: "5",
    subject: "Update all auth tests",
    description: "",
    status: "pending",
    blockedBy: ["3"],
  },
  {
    id: "6",
    subject: "Run full test suite and fix failures",
    description: "",
    status: "pending",
    blockedBy: ["5"],
  },
];

// Tool group items (for ToolMessageGroup mock)
const MOCK_TOOL_GROUP_ITEMS = [
  { id: "tg-1", name: "Read", input: { file_path: "src/auth/middleware.ts" } },
  { id: "tg-2", name: "Read", input: { file_path: "src/auth/login.ts" } },
  { id: "tg-3", name: "Read", input: { file_path: "src/auth/session.ts" } },
  { id: "tg-4", name: "Read", input: { file_path: "src/auth/types.ts" } },
];

const MOCK_SUBAGENT_TOOL_ITEMS = [
  { id: "sa-1", name: "Grep", input: { pattern: "useAuth", path: "src/" } },
  {
    id: "sa-2",
    name: "Grep",
    input: { pattern: "session.userId", path: "src/" },
  },
];

// GitHub PR mock data
const MOCK_PR_FAILING: GitHubPRInfo = {
  number: 162,
  title: "feat: add dark mode toggle to application settings",
  url: "https://github.com/example/project/pull/162",
  state: "OPEN",
  isDraft: false,
  reviewDecision: "CHANGES_REQUESTED",
  additions: 91,
  deletions: 88,
  changedFiles: 24,
  checks: [
    { name: "CI / Build", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "CI / Test", status: "COMPLETED", conclusion: "FAILURE" },
    { name: "CI / Lint", status: "COMPLETED", conclusion: "SUCCESS" },
  ],
  checksSummary: { total: 3, success: 2, failure: 1, pending: 0 },
  reviewThreads: { total: 4, resolved: 2, unresolved: 2 },
};

const MOCK_PR_PASSING: GitHubPRInfo = {
  number: 158,
  title: "fix: prevent mobile keyboard layout shift and iOS zoom",
  url: "https://github.com/example/project/pull/158",
  state: "OPEN",
  isDraft: false,
  reviewDecision: "APPROVED",
  additions: 42,
  deletions: 12,
  changedFiles: 3,
  checks: [
    { name: "CI / Build", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "CI / Test", status: "COMPLETED", conclusion: "SUCCESS" },
  ],
  checksSummary: { total: 2, success: 2, failure: 0, pending: 0 },
  reviewThreads: { total: 1, resolved: 1, unresolved: 0 },
};

const MOCK_PR_DRAFT: GitHubPRInfo = {
  number: 165,
  title: "refactor: migrate auth module to JWT tokens with refresh support",
  url: "https://github.com/example/project/pull/165",
  state: "OPEN",
  isDraft: true,
  reviewDecision: null,
  additions: 340,
  deletions: 156,
  changedFiles: 18,
  checks: [
    { name: "CI / Build", status: "IN_PROGRESS", conclusion: null },
    { name: "CI / Test", status: "QUEUED", conclusion: null },
  ],
  checksSummary: { total: 2, success: 0, failure: 0, pending: 2 },
  reviewThreads: { total: 0, resolved: 0, unresolved: 0 },
};

const MOCK_PR_MERGED: GitHubPRInfo = {
  number: 155,
  title: "feat(cli): add service install/uninstall and separate dev/prod ports",
  url: "https://github.com/example/project/pull/155",
  state: "MERGED",
  isDraft: false,
  reviewDecision: "APPROVED",
  additions: 287,
  deletions: 63,
  changedFiles: 11,
  checks: [
    { name: "CI / Build", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "CI / Test", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "CI / Lint", status: "COMPLETED", conclusion: "SUCCESS" },
  ],
  checksSummary: { total: 3, success: 3, failure: 0, pending: 0 },
  reviewThreads: { total: 3, resolved: 3, unresolved: 0 },
};

// MCP server mock data
const MOCK_MCP_SERVERS: McpServerDetail[] = [
  {
    name: "filesystem",
    status: "connected",
    config: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@anthropic/mcp-fs"],
    },
    scope: "project",
    tools: [
      { name: "read_file", annotations: { readOnly: true } },
      { name: "write_file", annotations: { destructive: true } },
      { name: "list_directory", annotations: { readOnly: true } },
    ],
  },
  {
    name: "github",
    status: "connected",
    config: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@anthropic/mcp-github"],
    },
    scope: "user",
    tools: [
      { name: "create_issue" },
      { name: "list_prs", annotations: { readOnly: true } },
      { name: "create_pr" },
    ],
  },
  {
    name: "postgres",
    status: "failed",
    error: "Connection refused: ECONNREFUSED 127.0.0.1:5432",
    config: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@anthropic/mcp-postgres"],
    },
    scope: "project",
    tools: [],
  },
  {
    name: "web-search",
    status: "disabled",
    config: { type: "sse", url: "http://localhost:8080/sse" },
    scope: "user",
    tools: [
      { name: "search", annotations: { readOnly: true, openWorld: true } },
    ],
  },
  {
    name: "docker",
    status: "connecting",
    config: { type: "stdio", command: "docker-mcp-server" },
    scope: "project",
    tools: [],
  },
];

// Linear issue mock data
const MOCK_LINEAR_ISSUE_ACTIVE: LinearIssue = {
  id: "issue-1",
  identifier: "THE-147",
  title:
    "Associer un ticket Linear a une session dans le panneau lateral droit",
  description: "Pouvoir associer un ticket Linear a une session.",
  url: "https://linear.app/thevibecompany/issue/THE-147",
  branchName: "the-147-associer-un-ticket-linear",
  priorityLabel: "High",
  stateName: "In Progress",
  stateType: "started",
  teamName: "Thevibecompany",
  teamKey: "THE",
  teamId: "team-the",
};

const MOCK_LINEAR_ISSUE_DONE: LinearIssue = {
  id: "issue-2",
  identifier: "ENG-256",
  title: "Fix authentication flow for SSO users",
  description: "SSO users get a blank page after login redirect.",
  url: "https://linear.app/team/issue/ENG-256",
  branchName: "eng-256-fix-auth-flow-sso",
  priorityLabel: "Urgent",
  stateName: "Done",
  stateType: "completed",
  teamName: "Engineering",
  teamKey: "ENG",
  teamId: "team-eng",
};

const MOCK_LINEAR_COMMENTS: LinearComment[] = [
  {
    id: "c1",
    body: "Started working on the sidebar integration",
    createdAt: new Date(Date.now() - 3600_000).toISOString(),
    userName: "Alice",
  },
  {
    id: "c2",
    body: "Added the search component, LGTM",
    createdAt: new Date(Date.now() - 1800_000).toISOString(),
    userName: "Bob",
  },
  {
    id: "c3",
    body: "Testing the polling flow now",
    createdAt: new Date(Date.now() - 300_000).toISOString(),
    userName: "Alice",
  },
];

// ─── Playground Component ───────────────────────────────────────────────────

export function Playground() {
  const [darkMode, setDarkMode] = useState(() =>
    document.documentElement.classList.contains("dark"),
  );

  useEffect(() => {
    document.documentElement.classList.toggle("dark", darkMode);
  }, [darkMode]);

  useEffect(() => {
    const store = useStore.getState();
    const snapshot = useStore.getState();
    const sessionId = MOCK_SESSION_ID;

    const prevSession = snapshot.sessions.get(sessionId);
    const prevMessages = snapshot.messages.get(sessionId);
    const prevPerms = snapshot.pendingPermissions.get(sessionId);
    const prevConn = snapshot.connectionStatus.get(sessionId);
    const prevCli = snapshot.cliConnected.get(sessionId);
    const prevStatus = snapshot.sessionStatus.get(sessionId);
    const prevStreaming = snapshot.streaming.get(sessionId);
    const prevStreamingStartedAt = snapshot.streamingStartedAt.get(sessionId);
    const prevStreamingOutputTokens =
      snapshot.streamingOutputTokens.get(sessionId);

    const session: SessionState = {
      session_id: sessionId,
      backend_type: "claude",
      model: "claude-sonnet-4-5",
      cwd: "/Users/stan/Dev/project",
      tools: ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "WebSearch"],
      permissionMode: "default",
      claude_code_version: "1.0.0",
      mcp_servers: [],
      agents: [],
      slash_commands: ["explain", "review", "fix"],
      skills: ["doc-coauthoring", "frontend-design"],
      total_cost_usd: 0.1847,
      num_turns: 14,
      context_used_percent: 62,
      is_compacting: false,
      git_branch: "feat/jwt-auth",
      is_worktree: false,
      is_containerized: true,
      repo_root: "/Users/stan/Dev/project",
      git_ahead: 3,
      git_behind: 0,
      total_lines_added: 142,
      total_lines_removed: 38,
    };

    store.addSession(session);
    store.setConnectionStatus(sessionId, "connected");
    store.setCliConnected(sessionId, true);
    store.setSessionStatus(sessionId, "running");
    const streamingText =
      "I'm updating tests and then I'll run the full suite.";
    store.setMessages(sessionId, [
      MSG_USER,
      MSG_ASSISTANT,
      MSG_ASSISTANT_TOOLS,
      MSG_TOOL_ERROR,
      {
        id: "stream-draft",
        role: "assistant",
        content: streamingText,
        timestamp: Date.now(),
        isStreaming: true,
      },
    ]);
    store.setStreaming(sessionId, streamingText);
    store.setStreamingStats(sessionId, {
      startedAt: Date.now() - 12000,
      outputTokens: 1200,
    });
    store.addPermission(sessionId, PERM_BASH);
    store.addPermission(sessionId, PERM_DYNAMIC);

    return () => {
      useStore.setState((s) => {
        const sessions = new Map(s.sessions);
        const messages = new Map(s.messages);
        const pendingPermissions = new Map(s.pendingPermissions);
        const connectionStatus = new Map(s.connectionStatus);
        const cliConnected = new Map(s.cliConnected);
        const sessionStatus = new Map(s.sessionStatus);
        const streaming = new Map(s.streaming);
        const streamingStartedAt = new Map(s.streamingStartedAt);
        const streamingOutputTokens = new Map(s.streamingOutputTokens);

        if (prevSession) sessions.set(sessionId, prevSession);
        else sessions.delete(sessionId);
        if (prevMessages) messages.set(sessionId, prevMessages);
        else messages.delete(sessionId);
        if (prevPerms) pendingPermissions.set(sessionId, prevPerms);
        else pendingPermissions.delete(sessionId);
        if (prevConn) connectionStatus.set(sessionId, prevConn);
        else connectionStatus.delete(sessionId);
        if (typeof prevCli === "boolean") cliConnected.set(sessionId, prevCli);
        else cliConnected.delete(sessionId);
        if (prevStatus) sessionStatus.set(sessionId, prevStatus);
        else sessionStatus.delete(sessionId);
        if (typeof prevStreaming === "string")
          streaming.set(sessionId, prevStreaming);
        else streaming.delete(sessionId);
        if (typeof prevStreamingStartedAt === "number")
          streamingStartedAt.set(sessionId, prevStreamingStartedAt);
        else streamingStartedAt.delete(sessionId);
        if (typeof prevStreamingOutputTokens === "number")
          streamingOutputTokens.set(sessionId, prevStreamingOutputTokens);
        else streamingOutputTokens.delete(sessionId);

        return {
          sessions,
          messages,
          pendingPermissions,
          connectionStatus,
          cliConnected,
          sessionStatus,
          streaming,
          streamingStartedAt,
          streamingOutputTokens,
        };
      });
    };
  }, []);

  return (
    <div className="min-h-screen bg-cc-bg text-cc-fg font-sans-ui">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-cc-sidebar border-b border-cc-border">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-cc-fg tracking-tight">
              Component Playground
            </h1>
            <p className="text-xs text-cc-muted mt-0.5">
              Visual catalog of all UI components
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => {
                const sessionId = useStore.getState().currentSessionId;
                if (sessionId) {
                  navigateToSession(sessionId);
                } else {
                  navigateHome();
                }
              }}
              className="px-3 py-1.5 text-xs font-medium rounded-lg bg-cc-hover hover:bg-cc-active text-cc-fg border border-cc-border transition-colors cursor-pointer"
            >
              Back to App
            </button>
            <button
              onClick={() => setDarkMode(!darkMode)}
              className="px-3 py-1.5 text-xs font-medium rounded-lg bg-cc-primary/10 hover:bg-cc-primary/20 text-cc-primary border border-cc-primary/20 transition-colors cursor-pointer"
            >
              {darkMode ? "Light Mode" : "Dark Mode"}
            </button>
          </div>
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-6 py-8 space-y-12">
        {/* ─── Permission Banners ──────────────────────────────── */}
        <Section
          title="Permission Banners"
          description="Tool approval requests shown above the composer"
        >
          <div className="border border-cc-border rounded-xl overflow-hidden bg-cc-card divide-y divide-cc-border">
            <PermissionBanner
              permission={PERM_BASH}
              sessionId={MOCK_SESSION_ID}
            />
            <PermissionBanner
              permission={PERM_EDIT}
              sessionId={MOCK_SESSION_ID}
            />
            <PermissionBanner
              permission={PERM_WRITE}
              sessionId={MOCK_SESSION_ID}
            />
            <PermissionBanner
              permission={PERM_READ}
              sessionId={MOCK_SESSION_ID}
            />
            <PermissionBanner
              permission={PERM_GLOB}
              sessionId={MOCK_SESSION_ID}
            />
            <PermissionBanner
              permission={PERM_GREP}
              sessionId={MOCK_SESSION_ID}
            />
            <PermissionBanner
              permission={PERM_GENERIC}
              sessionId={MOCK_SESSION_ID}
            />
            <PermissionBanner
              permission={PERM_DYNAMIC}
              sessionId={MOCK_SESSION_ID}
            />
          </div>
        </Section>

        {/* ─── Real Chat Stack ──────────────────────────────── */}
        <Section
          title="Real Chat Stack"
          description="Integrated ChatView using real MessageFeed + PermissionBanner + Composer components"
        >
          <div
            data-testid="playground-real-chat-stack"
            className="max-w-3xl border border-cc-border rounded-xl overflow-hidden bg-cc-card h-[620px]"
          >
            <ChatView sessionId={MOCK_SESSION_ID} />
          </div>
        </Section>

        {/* ─── ExitPlanMode (the fix) ──────────────────────────── */}
        <Section
          title="ExitPlanMode"
          description="Plan approval request — previously rendered as raw JSON, now shows formatted markdown"
        >
          <div className="border border-cc-border rounded-xl overflow-hidden bg-cc-card">
            <PermissionBanner
              permission={PERM_EXIT_PLAN}
              sessionId={MOCK_SESSION_ID}
            />
          </div>
        </Section>

        {/* ─── AskUserQuestion ──────────────────────────────── */}
        <Section
          title="AskUserQuestion"
          description="Interactive questions with selectable options"
        >
          <div className="space-y-4">
            <Card label="Single question">
              <PermissionBanner
                permission={PERM_ASK_SINGLE}
                sessionId={MOCK_SESSION_ID}
              />
            </Card>
            <Card label="Multi-question">
              <PermissionBanner
                permission={PERM_ASK_MULTI}
                sessionId={MOCK_SESSION_ID}
              />
            </Card>
          </div>
        </Section>

        {/* ─── AI Validation ──────────────────────────────── */}
        <Section
          title="AI Validation"
          description="AI-powered permission validation badges and recommendations"
        >
          <div className="space-y-4">
            <Card label="Permission with AI recommendation (uncertain)">
              <PermissionBanner
                permission={PERM_AI_UNCERTAIN}
                sessionId={MOCK_SESSION_ID}
              />
            </Card>
            <Card label="Permission with AI recommendation (safe)">
              <PermissionBanner
                permission={PERM_AI_SAFE}
                sessionId={MOCK_SESSION_ID}
              />
            </Card>
            <Card label="Permission with AI recommendation (dangerous)">
              <PermissionBanner
                permission={PERM_AI_DANGEROUS}
                sessionId={MOCK_SESSION_ID}
              />
            </Card>
            <Card label="Per-session toggle (disabled)">
              <PlaygroundAiValidationToggle enabled={false} />
            </Card>
            <Card label="Per-session toggle (enabled)">
              <PlaygroundAiValidationToggle enabled={true} />
            </Card>
            <Card label="Auto-resolved badges">
              <div className="border border-cc-border rounded-xl overflow-hidden bg-cc-card divide-y divide-cc-border">
                <AiValidationBadge
                  entry={{
                    request: mockPermission({
                      tool_name: "Read",
                      input: { file_path: "/src/index.ts" },
                    }),
                    behavior: "allow",
                    reason: "Read is a read-only tool",
                    timestamp: Date.now(),
                  }}
                />
                <AiValidationBadge
                  entry={{
                    request: mockPermission({
                      tool_name: "Bash",
                      input: { command: "rm -rf /" },
                    }),
                    behavior: "deny",
                    reason: "Recursive delete of root directory",
                    timestamp: Date.now(),
                  }}
                />
                <AiValidationBadge
                  entry={{
                    request: mockPermission({
                      tool_name: "Grep",
                      input: { pattern: "TODO", path: "/src" },
                    }),
                    behavior: "allow",
                    reason: "Grep is a read-only tool",
                    timestamp: Date.now(),
                  }}
                />
              </div>
            </Card>
          </div>
        </Section>

        {/* ─── Messages ──────────────────────────────── */}
        <Section
          title="Messages"
          description="Chat message bubbles for all roles"
        >
          <div className="space-y-4 max-w-3xl">
            <Card label="User message">
              <MessageBubble message={MSG_USER} />
            </Card>
            <Card label="User message with image">
              <MessageBubble message={MSG_USER_IMAGE} />
            </Card>
            <Card label="Assistant message (markdown)">
              <MessageBubble message={MSG_ASSISTANT} />
            </Card>
            <Card label="Assistant message (with tool calls)">
              <MessageBubble message={MSG_ASSISTANT_TOOLS} />
            </Card>
            <Card label="Assistant message (streaming)">
              <MessageBubble message={MSG_ASSISTANT_STREAMING} />
            </Card>
            <Card label="Assistant message (thinking block)">
              <MessageBubble message={MSG_ASSISTANT_THINKING} />
            </Card>
            <Card label="Tool result with error">
              <MessageBubble message={MSG_TOOL_ERROR} />
            </Card>
            <Card label="System message">
              <MessageBubble message={MSG_SYSTEM} />
            </Card>
          </div>
        </Section>

        {/* ─── Tool Blocks (standalone) ──────────────────────── */}
        <Section
          title="Tool Blocks"
          description="Expandable tool call visualization"
        >
          <div className="space-y-2 max-w-3xl">
            <ToolBlock
              name="Bash"
              input={{
                command: "git status && npm run lint",
                description: "Check git status and lint",
              }}
              toolUseId="tb-1"
            />
            <ToolBlock
              name="Read"
              input={{
                file_path: "/Users/stan/Dev/project/src/index.ts",
                offset: 10,
                limit: 50,
              }}
              toolUseId="tb-2"
            />
            <ToolBlock
              name="Edit"
              input={{
                file_path: "src/utils.ts",
                old_string: "const x = 1;",
                new_string: "const x = 2;",
                replace_all: true,
              }}
              toolUseId="tb-3"
            />
            <ToolBlock
              name="Edit"
              input={{
                file_path: "/Users/stan/Dev/project/src/store.ts",
                changes: [
                  {
                    path: "/Users/stan/Dev/project/src/store.ts",
                    kind: "update",
                  },
                  { path: "/Users/stan/Dev/project/src/ws.ts", kind: "update" },
                ],
              }}
              toolUseId="tb-3b"
            />
            <ToolBlock
              name="Write"
              input={{
                file_path: "src/new-file.ts",
                content: 'export const hello = "world";\n',
              }}
              toolUseId="tb-4"
            />
            <ToolBlock
              name="Glob"
              input={{
                pattern: "**/*.tsx",
                path: "/Users/stan/Dev/project/src",
              }}
              toolUseId="tb-5"
            />
            <ToolBlock
              name="Grep"
              input={{
                pattern: "useEffect",
                path: "src/",
                glob: "*.tsx",
                output_mode: "content",
                context: 3,
                head_limit: 20,
              }}
              toolUseId="tb-6"
            />
            <ToolBlock
              name="WebSearch"
              input={{
                query: "React 19 new features",
                allowed_domains: ["react.dev", "github.com"],
              }}
              toolUseId="tb-7"
            />
            <ToolBlock
              name="WebFetch"
              input={{
                url: "https://react.dev/blog/2024/12/05/react-19",
                prompt: "Summarize the key changes in React 19",
              }}
              toolUseId="tb-8"
            />
            <ToolBlock
              name="Task"
              input={{
                description: "Search for auth patterns",
                subagent_type: "Explore",
                prompt:
                  "Find all files related to authentication and authorization in the codebase. Look for middleware, guards, and token handling.",
              }}
              toolUseId="tb-9"
            />
            <ToolBlock
              name="TodoWrite"
              input={{
                todos: [
                  {
                    content: "Create JWT utility module",
                    status: "completed",
                    activeForm: "Creating JWT module",
                  },
                  {
                    content: "Update auth middleware",
                    status: "in_progress",
                    activeForm: "Updating middleware",
                  },
                  {
                    content: "Migrate login endpoint",
                    status: "pending",
                    activeForm: "Migrating login",
                  },
                  {
                    content: "Run full test suite",
                    status: "pending",
                    activeForm: "Running tests",
                  },
                ],
              }}
              toolUseId="tb-10"
            />
            <ToolBlock
              name="NotebookEdit"
              input={{
                notebook_path: "/Users/stan/Dev/project/analysis.ipynb",
                cell_type: "code",
                edit_mode: "replace",
                cell_number: 3,
                new_source:
                  "import pandas as pd\ndf = pd.read_csv('data.csv')\ndf.describe()",
              }}
              toolUseId="tb-11"
            />
            <ToolBlock
              name="SendMessage"
              input={{
                type: "message",
                recipient: "researcher",
                content:
                  "Please investigate the auth module structure and report back.",
                summary: "Requesting auth module investigation",
              }}
              toolUseId="tb-12"
            />
          </div>
        </Section>

        {/* ─── Tool Progress Indicator ──────────────────────── */}
        <Section
          title="Tool Progress"
          description="Real-time progress indicator shown while tools are running"
        >
          <div className="space-y-4 max-w-3xl">
            <Card label="Single tool running">
              <div className="flex items-center gap-1.5 text-[11px] text-cc-muted font-mono-code pl-9">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-cc-primary animate-pulse" />
                <span>Terminal</span>
                <span className="text-cc-muted/60">8s</span>
              </div>
            </Card>
            <Card label="Multiple tools running">
              <div className="flex items-center gap-1.5 text-[11px] text-cc-muted font-mono-code pl-9">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-cc-primary animate-pulse" />
                <span>Search Content</span>
                <span className="text-cc-muted/60">3s</span>
                <span className="text-cc-muted/40">&middot;</span>
                <span>Find Files</span>
                <span className="text-cc-muted/60">2s</span>
              </div>
            </Card>
          </div>
        </Section>

        {/* ─── Compacting Context Indicator ─────────────────── */}
        <Section
          title="Compacting Context"
          description="Spinner shown in the message feed when Claude Code is compacting context"
        >
          <div className="space-y-4 max-w-3xl">
            <Card label="Compacting indicator">
              <div className="flex items-center gap-1.5 text-[11px] text-cc-warning font-mono-code pl-9">
                <svg
                  className="w-3 h-3 animate-spin shrink-0"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <circle cx="8" cy="8" r="6" opacity="0.25" />
                  <path d="M8 2a6 6 0 0 1 6 6" strokeLinecap="round" />
                </svg>
                <span>Compacting context...</span>
              </div>
            </Card>
          </div>
        </Section>

        {/* ─── Tool Use Summary ──────────────────────────────── */}
        <Section
          title="Tool Use Summary"
          description="System message summarizing batch tool execution"
        >
          <div className="space-y-4 max-w-3xl">
            <Card label="Summary as system message">
              <MessageBubble
                message={{
                  id: "summary-1",
                  role: "system",
                  content:
                    "Read 4 files, searched 12 matches across 3 directories",
                  timestamp: Date.now(),
                }}
              />
            </Card>
          </div>
        </Section>

        {/* ─── Task Panel ──────────────────────────────── */}
        <Section
          title="Tasks"
          description="Task list states: pending, in progress, completed, blocked"
        >
          <div className="w-[280px] border border-cc-border rounded-xl overflow-hidden bg-cc-card">
            {/* Session stats mock */}
            <div className="px-4 py-3 border-b border-cc-border space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-cc-muted uppercase tracking-wider">
                  Cost
                </span>
                <span className="text-[13px] font-medium text-cc-fg tabular-nums">
                  $0.1847
                </span>
              </div>
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-cc-muted uppercase tracking-wider">
                    Context
                  </span>
                  <span className="text-[11px] text-cc-muted tabular-nums">
                    62%
                  </span>
                </div>
                <div className="w-full h-1.5 rounded-full bg-cc-hover overflow-hidden">
                  <div
                    className="h-full rounded-full bg-cc-warning transition-all duration-500"
                    style={{ width: "62%" }}
                  />
                </div>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-cc-muted uppercase tracking-wider">
                  Turns
                </span>
                <span className="text-[13px] font-medium text-cc-fg tabular-nums">
                  14
                </span>
              </div>
            </div>
            {/* Task header */}
            <div className="px-4 py-2.5 border-b border-cc-border flex items-center justify-between">
              <span className="text-[12px] font-semibold text-cc-fg">
                Tasks
              </span>
              <span className="text-[11px] text-cc-muted tabular-nums">
                2/{MOCK_TASKS.length}
              </span>
            </div>
            {/* Task list */}
            <div className="px-3 py-2 space-y-0.5">
              {MOCK_TASKS.map((task) => (
                <TaskRow key={task.id} task={task} />
              ))}
            </div>
          </div>
        </Section>

        {/* ─── GitHub PR Status ──────────────────────────────── */}
        <Section
          title="GitHub PR Status"
          description="PR health shown in the TaskPanel — checks, reviews, unresolved comments"
        >
          <div className="space-y-4">
            <Card label="Open PR — failing checks + changes requested">
              <div className="w-[280px] border border-cc-border rounded-xl overflow-hidden bg-cc-card">
                <GitHubPRDisplay pr={MOCK_PR_FAILING} />
              </div>
            </Card>
            <Card label="Open PR — all checks passed + approved">
              <div className="w-[280px] border border-cc-border rounded-xl overflow-hidden bg-cc-card">
                <GitHubPRDisplay pr={MOCK_PR_PASSING} />
              </div>
            </Card>
            <Card label="Draft PR — pending checks">
              <div className="w-[280px] border border-cc-border rounded-xl overflow-hidden bg-cc-card">
                <GitHubPRDisplay pr={MOCK_PR_DRAFT} />
              </div>
            </Card>
            <Card label="Merged PR">
              <div className="w-[280px] border border-cc-border rounded-xl overflow-hidden bg-cc-card">
                <GitHubPRDisplay pr={MOCK_PR_MERGED} />
              </div>
            </Card>
          </div>
        </Section>

        {/* ─── Linear Issue (TaskPanel) ────────────────── */}
        <Section
          title="Linear Issue (TaskPanel)"
          description="Linear issue linked to a session — displayed in TaskPanel with status, comments, and actions"
        >
          <div className="space-y-4">
            <Card label="Active issue — In Progress with comments">
              <div className="w-[280px] border border-cc-border rounded-xl overflow-hidden bg-cc-card">
                <div className="px-4 py-3 space-y-2">
                  <div className="flex items-center gap-1.5">
                    <LinearLogo className="w-3.5 h-3.5 text-cc-muted shrink-0" />
                    <span className="text-[12px] font-semibold text-cc-fg font-mono-code">
                      {MOCK_LINEAR_ISSUE_ACTIVE.identifier}
                    </span>
                    <span className="text-[9px] font-medium px-1.5 rounded-full leading-[16px] text-blue-400 bg-blue-400/10">
                      {MOCK_LINEAR_ISSUE_ACTIVE.stateName}
                    </span>
                    <button
                      className="ml-auto flex items-center justify-center w-5 h-5 rounded text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
                      title="Unlink"
                    >
                      <svg
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        className="w-3 h-3"
                      >
                        <path d="M4 4l8 8M12 4l-8 8" />
                      </svg>
                    </button>
                  </div>
                  <p className="text-[11px] text-cc-muted truncate">
                    {MOCK_LINEAR_ISSUE_ACTIVE.title}
                  </p>
                  <div className="flex items-center gap-2 text-[10px] text-cc-muted">
                    <span>{MOCK_LINEAR_ISSUE_ACTIVE.priorityLabel}</span>
                    <span>&middot;</span>
                    <span>{MOCK_LINEAR_ISSUE_ACTIVE.teamName}</span>
                    <span>&middot;</span>
                    <span>@ Alice</span>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    <span
                      className="text-[9px] px-1.5 py-0.5 rounded-full"
                      style={{ backgroundColor: "#bb87fc20", color: "#bb87fc" }}
                    >
                      feature
                    </span>
                    <span
                      className="text-[9px] px-1.5 py-0.5 rounded-full"
                      style={{ backgroundColor: "#f2994a20", color: "#f2994a" }}
                    >
                      frontend
                    </span>
                  </div>
                </div>
                {/* Comments */}
                <div className="px-4 py-2 border-t border-cc-border space-y-1.5 max-h-36 overflow-y-auto">
                  <span className="text-[10px] text-cc-muted uppercase tracking-wider">
                    Comments
                  </span>
                  {MOCK_LINEAR_COMMENTS.map((c) => (
                    <div key={c.id} className="text-[11px]">
                      <div className="flex items-center gap-1">
                        <span className="font-medium text-cc-fg">
                          {c.userName}
                        </span>
                        <span className="text-[9px] text-cc-muted">
                          just now
                        </span>
                      </div>
                      <p className="text-cc-muted line-clamp-2">{c.body}</p>
                    </div>
                  ))}
                </div>
                {/* Comment input */}
                <div className="px-4 py-2 border-t border-cc-border flex items-center gap-1.5">
                  <input
                    type="text"
                    placeholder="Add a comment..."
                    className="flex-1 text-[11px] bg-transparent border border-cc-border rounded-md px-2 py-1.5 text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/50"
                  />
                  <button className="flex items-center justify-center w-6 h-6 rounded text-cc-primary cursor-pointer">
                    <svg
                      viewBox="0 0 16 16"
                      fill="currentColor"
                      className="w-3.5 h-3.5"
                    >
                      <path d="M1.724 1.053a.5.5 0 0 0-.714.545l1.403 4.85a.5.5 0 0 0 .397.354l5.19.736-5.19.737a.5.5 0 0 0-.397.353L1.01 13.48a.5.5 0 0 0 .714.545l13-6.5a.5.5 0 0 0 0-.894l-13-6.5z" />
                    </svg>
                  </button>
                </div>
              </div>
            </Card>

            <Card label="Completed issue — Done warning banner">
              <div className="w-[280px] border border-cc-border rounded-xl overflow-hidden bg-cc-card">
                <div className="px-4 py-3 space-y-2">
                  <div className="flex items-center gap-1.5">
                    <LinearLogo className="w-3.5 h-3.5 text-cc-muted shrink-0" />
                    <span className="text-[12px] font-semibold text-cc-fg font-mono-code">
                      {MOCK_LINEAR_ISSUE_DONE.identifier}
                    </span>
                    <span className="text-[9px] font-medium px-1.5 rounded-full leading-[16px] text-cc-success bg-cc-success/10">
                      {MOCK_LINEAR_ISSUE_DONE.stateName}
                    </span>
                  </div>
                  <p className="text-[11px] text-cc-muted truncate">
                    {MOCK_LINEAR_ISSUE_DONE.title}
                  </p>
                  <div className="flex items-center gap-2 text-[10px] text-cc-muted">
                    <span>{MOCK_LINEAR_ISSUE_DONE.priorityLabel}</span>
                    <span>&middot;</span>
                    <span>{MOCK_LINEAR_ISSUE_DONE.teamName}</span>
                  </div>
                </div>
                {/* Done warning */}
                <div className="px-4 py-2 bg-cc-success/10 border-t border-cc-success/20 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-[11px] text-cc-success font-medium">
                      Issue completed
                    </p>
                    <p className="text-[10px] text-cc-success/80">
                      Ticket moved to done.
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button className="text-[10px] text-cc-muted hover:text-cc-fg px-1.5 py-0.5 rounded cursor-pointer">
                      Dismiss
                    </button>
                    <button className="text-[10px] text-cc-success font-medium px-2 py-0.5 rounded bg-cc-success/20 hover:bg-cc-success/30 cursor-pointer">
                      Close session
                    </button>
                  </div>
                </div>
              </div>
            </Card>

            <Card label="No linked issue — Link button">
              <div className="w-[280px] border border-cc-border rounded-xl overflow-hidden bg-cc-card">
                <div className="shrink-0 px-4 py-3 border-b border-cc-border">
                  <button className="flex items-center gap-1.5 text-[11px] text-cc-muted hover:text-cc-fg transition-colors cursor-pointer">
                    <LinearLogo className="w-3.5 h-3.5" />
                    Link Linear issue
                  </button>
                </div>
              </div>
            </Card>
          </div>
        </Section>

        {/* ─── MCP Servers ──────────────────────────────── */}
        <Section
          title="MCP Servers"
          description="MCP server status display with toggle, reconnect, and tool listing"
        >
          <div className="space-y-4">
            <Card label="All server states (connected, failed, disabled, connecting)">
              <div className="w-[280px] border border-cc-border rounded-xl overflow-hidden bg-cc-card">
                {/* MCP section header */}
                <div className="shrink-0 px-4 py-2.5 border-b border-cc-border flex items-center justify-between">
                  <span className="text-[12px] font-semibold text-cc-fg flex items-center gap-1.5">
                    <svg
                      viewBox="0 0 16 16"
                      fill="currentColor"
                      className="w-3.5 h-3.5 text-cc-muted"
                    >
                      <path d="M1.5 3A1.5 1.5 0 013 1.5h10A1.5 1.5 0 0114.5 3v1A1.5 1.5 0 0113 5.5H3A1.5 1.5 0 011.5 4V3zm0 5A1.5 1.5 0 013 6.5h10A1.5 1.5 0 0114.5 8v1A1.5 1.5 0 0113 10.5H3A1.5 1.5 0 011.5 9V8zm0 5A1.5 1.5 0 013 11.5h10a1.5 1.5 0 011.5 1.5v1a1.5 1.5 0 01-1.5 1.5H3A1.5 1.5 0 011.5 14v-1z" />
                    </svg>
                    MCP Servers
                  </span>
                  <span className="text-[11px] text-cc-muted">
                    <svg
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      className="w-3.5 h-3.5"
                    >
                      <path
                        d="M2.5 8a5.5 5.5 0 019.78-3.5M13.5 8a5.5 5.5 0 01-9.78 3.5"
                        strokeLinecap="round"
                      />
                      <path
                        d="M12.5 2v3h-3M3.5 14v-3h3"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </span>
                </div>
                {/* Server rows */}
                <div className="px-3 py-2 space-y-1.5">
                  {MOCK_MCP_SERVERS.map((server) => (
                    <PlaygroundMcpRow key={server.name} server={server} />
                  ))}
                </div>
              </div>
            </Card>
          </div>
        </Section>

        {/* ─── Panel Config View ──────────────────────────── */}
        <Section
          title="Panel Config View"
          description="Inline configuration for the right sidebar — toggle sections on/off and reorder them"
        >
          <div className="space-y-4">
            <Card label="Config mode with mixed enabled/disabled sections">
              <div className="w-[320px] border border-cc-border rounded-xl overflow-hidden bg-cc-card">
                {/* Header */}
                <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-cc-border">
                  <span className="text-sm font-semibold text-cc-fg tracking-tight">
                    Panel Settings
                  </span>
                  <button className="flex items-center justify-center w-6 h-6 rounded-lg text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer">
                    <svg
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      className="w-3.5 h-3.5"
                    >
                      <path d="M4 4l8 8M12 4l-8 8" />
                    </svg>
                  </button>
                </div>
                {/* Section rows */}
                <div className="px-3 py-3 space-y-1">
                  {[
                    {
                      id: "git-branch",
                      label: "Git Branch",
                      desc: "Current branch, ahead/behind, and line changes",
                      enabled: true,
                    },
                    {
                      id: "usage-limits",
                      label: "Usage Limits",
                      desc: "API usage and rate limit meters",
                      enabled: true,
                    },
                    {
                      id: "github-pr",
                      label: "GitHub PR",
                      desc: "Pull request status, CI checks, and reviews",
                      enabled: false,
                    },
                    {
                      id: "linear-issue",
                      label: "Linear Issue",
                      desc: "Linked Linear ticket and comments",
                      enabled: true,
                    },
                    {
                      id: "mcp-servers",
                      label: "MCP Servers",
                      desc: "Model Context Protocol server connections",
                      enabled: false,
                    },
                    {
                      id: "tasks",
                      label: "Tasks",
                      desc: "Agent task list and progress",
                      enabled: true,
                    },
                  ].map((s, i, arr) => (
                    <div
                      key={s.id}
                      className={`flex items-center gap-2 px-2.5 py-2 rounded-lg border border-cc-border transition-opacity ${
                        s.enabled ? "bg-cc-bg" : "bg-cc-hover/50 opacity-60"
                      }`}
                    >
                      <div className="flex flex-col gap-0.5 shrink-0">
                        <button
                          disabled={i === 0}
                          className="w-5 h-4 flex items-center justify-center text-cc-muted hover:text-cc-fg disabled:opacity-20 disabled:cursor-not-allowed cursor-pointer transition-colors"
                        >
                          <svg
                            viewBox="0 0 16 16"
                            fill="currentColor"
                            className="w-3 h-3"
                          >
                            <path d="M8 4l4 4H4l4-4z" />
                          </svg>
                        </button>
                        <button
                          disabled={i === arr.length - 1}
                          className="w-5 h-4 flex items-center justify-center text-cc-muted hover:text-cc-fg disabled:opacity-20 disabled:cursor-not-allowed cursor-pointer transition-colors"
                        >
                          <svg
                            viewBox="0 0 16 16"
                            fill="currentColor"
                            className="w-3 h-3"
                          >
                            <path d="M8 12l4-4H4l4 4z" />
                          </svg>
                        </button>
                      </div>
                      <div className="flex-1 min-w-0">
                        <span className="text-[12px] font-medium text-cc-fg block">
                          {s.label}
                        </span>
                        <span className="text-[10px] text-cc-muted block truncate">
                          {s.desc}
                        </span>
                      </div>
                      <button
                        className={`shrink-0 w-8 h-[18px] rounded-full transition-colors cursor-pointer relative ${
                          s.enabled ? "bg-cc-primary" : "bg-cc-hover"
                        }`}
                        role="switch"
                        aria-checked={s.enabled}
                      >
                        <span
                          className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow transition-transform ${
                            s.enabled
                              ? "translate-x-[16px]"
                              : "translate-x-[2px]"
                          }`}
                        />
                      </button>
                    </div>
                  ))}
                </div>
                {/* Footer */}
                <div className="shrink-0 border-t border-cc-border px-3 py-2.5 flex items-center justify-between">
                  <button className="text-[11px] text-cc-muted hover:text-cc-fg transition-colors cursor-pointer">
                    Reset to defaults
                  </button>
                  <button className="text-[11px] font-medium text-cc-primary hover:text-cc-primary-hover transition-colors cursor-pointer">
                    Done
                  </button>
                </div>
              </div>
            </Card>
          </div>
        </Section>

        {/* ─── Codex Session Details ──────────────────────── */}
        <Section
          title="Codex Session Details"
          description="Rate limits and token details for Codex (OpenAI) sessions — streamed via session_update"
        >
          <div className="space-y-4">
            <Card label="Rate limits with token breakdown">
              <CodexPlaygroundDemo />
            </Card>
          </div>
        </Section>

        {/* ─── Update Banner ──────────────────────────────── */}
        <Section
          title="Update Banner"
          description="Notification banner for available updates"
        >
          <div className="space-y-4 max-w-3xl">
            <Card label="Service mode (auto-update)">
              <PlaygroundUpdateBanner
                updateInfo={{
                  currentVersion: "0.22.1",
                  latestVersion: "0.23.0",
                  updateAvailable: true,
                  isServiceMode: true,
                  updateInProgress: false,
                  lastChecked: Date.now(),
                  channel: "stable",
                }}
              />
            </Card>
            <Card label="Foreground mode (manual)">
              <PlaygroundUpdateBanner
                updateInfo={{
                  currentVersion: "0.22.1",
                  latestVersion: "0.23.0",
                  updateAvailable: true,
                  isServiceMode: false,
                  updateInProgress: false,
                  lastChecked: Date.now(),
                  channel: "stable",
                }}
              />
            </Card>
            <Card label="Update in progress">
              <PlaygroundUpdateBanner
                updateInfo={{
                  currentVersion: "0.22.1",
                  latestVersion: "0.23.0",
                  updateAvailable: true,
                  isServiceMode: true,
                  updateInProgress: true,
                  lastChecked: Date.now(),
                  channel: "stable",
                }}
              />
            </Card>
            <Card label="Prerelease channel update">
              <PlaygroundUpdateBanner
                updateInfo={{
                  currentVersion: "0.22.1",
                  latestVersion: "0.23.0-preview.20260228120000.abc1234",
                  updateAvailable: true,
                  isServiceMode: true,
                  updateInProgress: false,
                  lastChecked: Date.now(),
                  channel: "prerelease",
                }}
              />
            </Card>
          </div>
        </Section>

        {/* ─── Status Indicators ──────────────────────────────── */}
        <Section
          title="Status Indicators"
          description="Connection and session status banners"
        >
          <div className="space-y-3 max-w-3xl">
            <Card label="Disconnected warning">
              <div className="px-4 py-2 bg-cc-warning/10 border border-cc-warning/20 rounded-lg text-center">
                <span className="text-xs text-cc-warning font-medium">
                  Reconnecting to session...
                </span>
              </div>
            </Card>
            <Card label="Connected">
              <div className="flex items-center gap-2 px-3 py-2 bg-cc-card border border-cc-border rounded-lg">
                <span className="w-2 h-2 rounded-full bg-cc-success" />
                <span className="text-xs text-cc-fg font-medium">
                  Connected
                </span>
                <span className="text-[11px] text-cc-muted ml-auto">
                  claude-opus-4-6
                </span>
              </div>
            </Card>
            <Card label="Running / Thinking">
              <div className="flex items-center gap-2 px-3 py-2 bg-cc-card border border-cc-border rounded-lg">
                <span className="w-2 h-2 rounded-full bg-cc-primary animate-[pulse-dot_1.5s_ease-in-out_infinite]" />
                <span className="text-xs text-cc-fg font-medium">Thinking</span>
              </div>
            </Card>
            <Card label="Compacting">
              <div className="flex items-center gap-2 px-3 py-2 bg-cc-card border border-cc-border rounded-lg">
                <svg
                  className="w-3.5 h-3.5 text-cc-muted animate-spin"
                  viewBox="0 0 16 16"
                  fill="none"
                >
                  <circle
                    cx="8"
                    cy="8"
                    r="6"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeDasharray="28"
                    strokeDashoffset="8"
                    strokeLinecap="round"
                  />
                </svg>
                <span className="text-xs text-cc-muted font-medium">
                  Compacting context...
                </span>
              </div>
            </Card>
          </div>
        </Section>

        {/* ─── Composer ──────────────────────────────── */}
        <Section
          title="Composer"
          description="Message input bar with mode toggle, image upload, saved prompts (@), and send/stop buttons"
        >
          <div className="max-w-3xl">
            <Card label="Connected — code mode">
              <div className="border-t border-cc-border bg-cc-card px-4 py-3">
                <div className="relative bg-cc-input-bg/95 border border-cc-border rounded-[14px] shadow-[0_10px_30px_rgba(0,0,0,0.10)] overflow-visible">
                  <div className="flex items-end gap-2 px-2.5 py-2">
                    <div className="mb-0.5 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-cc-border text-[12px] font-semibold text-cc-muted">
                      <svg
                        viewBox="0 0 16 16"
                        fill="currentColor"
                        className="w-3.5 h-3.5"
                      >
                        <path
                          d="M2.5 4l4 4-4 4"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          fill="none"
                        />
                        <path
                          d="M8.5 4l4 4-4 4"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          fill="none"
                        />
                      </svg>
                      <span>code</span>
                    </div>
                    <textarea
                      readOnly
                      value="Can you refactor the auth module to use JWT?"
                      rows={1}
                      className="flex-1 min-w-0 px-2 py-1.5 text-sm bg-transparent resize-none text-cc-fg font-sans-ui"
                      style={{ minHeight: "36px" }}
                    />
                    <div className="mb-0.5 flex items-center gap-1.5">
                      <div className="flex items-center justify-center w-9 h-9 rounded-lg border border-cc-border text-cc-muted">
                        <svg
                          viewBox="0 0 16 16"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          className="w-4 h-4"
                        >
                          <rect x="2" y="2" width="12" height="12" rx="2" />
                          <circle
                            cx="5.5"
                            cy="5.5"
                            r="1"
                            fill="currentColor"
                            stroke="none"
                          />
                          <path
                            d="M2 11l3-3 2 2 3-4 4 5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </div>
                      <div className="flex items-center justify-center w-9 h-9 rounded-full bg-cc-primary text-white shadow-[0_6px_20px_rgba(0,0,0,0.18)]">
                        <svg
                          viewBox="0 0 16 16"
                          fill="currentColor"
                          className="w-3.5 h-3.5"
                        >
                          <path d="M3 2l11 6-11 6V9.5l7-1.5-7-1.5V2z" />
                        </svg>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </Card>
            <div className="mt-4" />
            <Card label="@ prompt insertion">
              <div className="border-t border-cc-border bg-cc-card px-4 py-3">
                <div className="relative bg-cc-input-bg/95 border border-cc-border rounded-[14px] shadow-[0_10px_30px_rgba(0,0,0,0.10)] overflow-visible">
                  <div className="absolute left-2 right-2 bottom-full mb-1 max-h-[180px] overflow-y-auto bg-cc-card border border-cc-border rounded-[10px] shadow-lg z-20 py-1">
                    <div className="px-3 py-2 flex items-center gap-2.5 bg-cc-hover">
                      <span className="flex items-center justify-center w-6 h-6 rounded-md bg-cc-hover text-cc-muted shrink-0">
                        @
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="text-[13px] font-medium text-cc-fg truncate">
                          @review-pr
                        </div>
                        <div className="text-[11px] text-cc-muted truncate">
                          Review this PR and list risks, regressions, and
                          missing tests.
                        </div>
                      </div>
                      <span className="text-[10px] text-cc-muted shrink-0">
                        project
                      </span>
                    </div>
                  </div>
                  <div className="flex items-end gap-2 px-2.5 py-2">
                    <textarea
                      readOnly
                      value="@rev"
                      rows={1}
                      className="flex-1 min-w-0 px-2 py-1.5 text-sm bg-transparent resize-none text-cc-fg font-sans-ui"
                      style={{ minHeight: "36px" }}
                    />
                    <div className="mb-0.5 flex items-center gap-1.5">
                      <div className="flex items-center justify-center w-9 h-9 rounded-lg border border-cc-border text-cc-muted">
                        <svg
                          viewBox="0 0 16 16"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          className="w-4 h-4"
                        >
                          <path d="M4 2.75h8A1.25 1.25 0 0113.25 4v9.25L8 10.5l-5.25 2.75V4A1.25 1.25 0 014 2.75z" />
                        </svg>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </Card>
            <div className="mt-4" />
            <Card label="Plan mode active">
              <div className="border-t border-cc-border bg-cc-card px-4 py-3">
                <div className="relative bg-cc-input-bg/95 border border-cc-primary/40 rounded-[14px] shadow-[0_10px_30px_rgba(0,0,0,0.10)] overflow-visible">
                  <div className="flex items-end gap-2 px-2.5 py-2">
                    <div className="mb-0.5 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-cc-primary/40 text-[12px] font-semibold text-cc-primary bg-cc-primary/8">
                      <svg
                        viewBox="0 0 16 16"
                        fill="currentColor"
                        className="w-3.5 h-3.5"
                      >
                        <rect x="3" y="3" width="3.5" height="10" rx="0.75" />
                        <rect x="9.5" y="3" width="3.5" height="10" rx="0.75" />
                      </svg>
                      <span>plan</span>
                    </div>
                    <textarea
                      readOnly
                      value=""
                      placeholder="Type a message... (/ + @)"
                      rows={1}
                      className="flex-1 min-w-0 px-2 py-1.5 text-sm bg-transparent resize-none text-cc-fg font-sans-ui placeholder:text-cc-muted"
                      style={{ minHeight: "36px" }}
                    />
                    <div className="mb-0.5 flex items-center gap-1.5">
                      <div className="flex items-center justify-center w-9 h-9 rounded-lg border border-cc-border text-cc-muted">
                        <svg
                          viewBox="0 0 16 16"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          className="w-4 h-4"
                        >
                          <rect x="2" y="2" width="12" height="12" rx="2" />
                          <circle
                            cx="5.5"
                            cy="5.5"
                            r="1"
                            fill="currentColor"
                            stroke="none"
                          />
                          <path
                            d="M2 11l3-3 2 2 3-4 4 5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </div>
                      <div className="flex items-center justify-center w-9 h-9 rounded-full bg-cc-hover text-cc-muted">
                        <svg
                          viewBox="0 0 16 16"
                          fill="currentColor"
                          className="w-3.5 h-3.5"
                        >
                          <path d="M3 2l11 6-11 6V9.5l7-1.5-7-1.5V2z" />
                        </svg>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </Card>
            <div className="mt-4" />
            <Card label="Running — stop button visible">
              <div className="border-t border-cc-border bg-cc-card px-4 py-3">
                <div className="relative bg-cc-input-bg/95 border border-cc-border rounded-[14px] shadow-[0_10px_30px_rgba(0,0,0,0.10)] overflow-visible">
                  <div className="flex items-end gap-2 px-2.5 py-2">
                    <div className="mb-0.5 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-cc-border text-[12px] font-semibold text-cc-muted">
                      <svg
                        viewBox="0 0 16 16"
                        fill="currentColor"
                        className="w-3.5 h-3.5"
                      >
                        <path
                          d="M2.5 4l4 4-4 4"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          fill="none"
                        />
                        <path
                          d="M8.5 4l4 4-4 4"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          fill="none"
                        />
                      </svg>
                      <span>code</span>
                    </div>
                    <textarea
                      readOnly
                      value=""
                      placeholder="Type a message... (/ for commands)"
                      rows={1}
                      className="flex-1 min-w-0 px-2 py-1.5 text-sm bg-transparent resize-none text-cc-fg font-sans-ui placeholder:text-cc-muted"
                      style={{ minHeight: "36px" }}
                    />
                    <div className="mb-0.5 flex items-center gap-1.5">
                      <div className="flex items-center justify-center w-9 h-9 rounded-lg border border-cc-border text-cc-muted">
                        <svg
                          viewBox="0 0 16 16"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          className="w-4 h-4"
                        >
                          <rect x="2" y="2" width="12" height="12" rx="2" />
                          <circle
                            cx="5.5"
                            cy="5.5"
                            r="1"
                            fill="currentColor"
                            stroke="none"
                          />
                          <path
                            d="M2 11l3-3 2 2 3-4 4 5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </div>
                      <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-cc-error/10 text-cc-error">
                        <svg
                          viewBox="0 0 16 16"
                          fill="currentColor"
                          className="w-3.5 h-3.5"
                        >
                          <rect x="3" y="3" width="10" height="10" rx="1" />
                        </svg>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </Card>
          </div>
        </Section>

        {/* ─── Streaming Indicator ──────────────────────────────── */}
        <Section
          title="Streaming Indicator"
          description="Live typing animation shown while the assistant is generating"
        >
          <div className="space-y-4 max-w-3xl">
            <Card label="Streaming with cursor">
              <div className="flex items-start gap-3">
                <div className="w-6 h-6 rounded-full bg-cc-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                  <svg
                    viewBox="0 0 16 16"
                    fill="none"
                    className="w-3.5 h-3.5 text-cc-primary"
                  >
                    <path
                      d="M8 1v14M1 8h14"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                    />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <pre className="font-serif-assistant text-[15px] text-cc-fg whitespace-pre-wrap break-words leading-relaxed">
                    I'll start by creating the JWT utility module with sign and
                    verify helpers. Let me first check what dependencies are
                    already installed...
                    <span className="inline-block w-0.5 h-4 bg-cc-primary ml-0.5 align-middle animate-[pulse-dot_0.8s_ease-in-out_infinite]" />
                  </pre>
                </div>
              </div>
            </Card>
            <Card label="Generation stats bar">
              <div className="flex items-center gap-1.5 text-[11px] text-cc-muted font-mono-code pl-9">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-cc-primary animate-pulse" />
                <span>Generating...</span>
                <span className="text-cc-muted/60">(</span>
                <span>12s</span>
                <span className="text-cc-muted/40">&middot;</span>
                <span>&darr; 1.2k</span>
                <span className="text-cc-muted/60">)</span>
              </div>
            </Card>
          </div>
        </Section>

        {/* ─── Tool Message Groups ──────────────────────────────── */}
        <Section
          title="Tool Message Groups"
          description="Consecutive same-tool calls collapsed into a single expandable row"
        >
          <div className="space-y-4 max-w-3xl">
            <Card label="Multi-item group (4 Reads)">
              <PlaygroundToolGroup
                toolName="Read"
                items={MOCK_TOOL_GROUP_ITEMS}
              />
            </Card>
            <Card label="Single-item group">
              <PlaygroundToolGroup
                toolName="Glob"
                items={[
                  {
                    id: "sg-1",
                    name: "Glob",
                    input: { pattern: "src/auth/**/*.ts" },
                  },
                ]}
              />
            </Card>
          </div>
        </Section>

        {/* ─── Subagent Groups ──────────────────────────────── */}
        <Section
          title="Subagent Groups"
          description="Nested messages from Task tool subagents shown in a collapsible indent"
        >
          <div className="space-y-4 max-w-3xl">
            <Card label="Subagent with nested tool calls">
              <PlaygroundSubagentGroup
                description="Search codebase for auth patterns"
                agentType="Explore"
                status="completed"
                senderThreadId="thr_main"
                receiverThreadIds={["thr_sub_1", "thr_sub_2"]}
                receiverCount={2}
                items={MOCK_SUBAGENT_TOOL_ITEMS}
              />
            </Card>
          </div>
        </Section>

        {/* ─── Diff Viewer ──────────────────────────────── */}
        <Section
          title="Diff Viewer"
          description="Unified diff rendering with word-level highlighting — used in ToolBlock, PermissionBanner, and DiffPanel"
        >
          <div className="space-y-4 max-w-3xl">
            <Card label="Edit diff (compact mode)">
              <DiffViewer
                oldText={
                  "export function formatDate(d: Date) {\n  return d.toISOString();\n}"
                }
                newText={
                  'export function formatDate(d: Date, locale = "en-US") {\n  return d.toLocaleDateString(locale, {\n    year: "numeric",\n    month: "short",\n    day: "numeric",\n  });\n}'
                }
                fileName="src/utils/format.ts"
                mode="compact"
              />
            </Card>
            <Card label="New file diff (compact mode)">
              <DiffViewer
                newText={
                  'export const config = {\n  apiUrl: "https://api.example.com",\n  timeout: 5000,\n  retries: 3,\n  debug: process.env.NODE_ENV !== "production",\n};\n'
                }
                fileName="src/config.ts"
                mode="compact"
              />
            </Card>
            <Card label="Git diff (full mode with line numbers)">
              <DiffViewer
                unifiedDiff={`diff --git a/src/auth/middleware.ts b/src/auth/middleware.ts
--- a/src/auth/middleware.ts
+++ b/src/auth/middleware.ts
@@ -1,8 +1,12 @@
-import { getSession } from "./session";
+import { verifyToken } from "./jwt";
+import type { Request, Response, NextFunction } from "express";

-export function authMiddleware(req, res, next) {
-  const session = getSession(req);
-  if (!session?.userId) {
+export function authMiddleware(req: Request, res: Response, next: NextFunction) {
+  const header = req.headers.authorization;
+  if (!header?.startsWith("Bearer ")) {
     return res.status(401).json({ error: "Unauthorized" });
   }
-  req.userId = session.userId;
+  const token = header.slice(7);
+  const payload = verifyToken(token);
+  if (!payload) return res.status(401).json({ error: "Invalid token" });
+  req.userId = payload.userId;
   next();
 }`}
                mode="full"
              />
            </Card>
            <Card label="No changes">
              <DiffViewer oldText="same content" newText="same content" />
            </Card>
          </div>
        </Section>
        {/* ─── Session Creation Progress ─────────────────────── */}
        <Section
          title="Session Creation Progress"
          description="Step-by-step progress indicator shown during session creation (SSE streaming)"
        >
          <div className="space-y-4 max-w-md">
            <Card label="In progress (container session)">
              <SessionCreationProgress
                steps={
                  [
                    {
                      step: "resolving_env",
                      label: "Resolving environment...",
                      status: "done",
                    },
                    {
                      step: "pulling_image",
                      label: "Pulling Docker image...",
                      status: "done",
                    },
                    {
                      step: "creating_container",
                      label: "Starting container...",
                      status: "in_progress",
                    },
                    {
                      step: "launching_cli",
                      label: "Launching Claude Code...",
                      status: "in_progress",
                    },
                  ] satisfies CreationProgressEvent[]
                }
              />
            </Card>
            <Card label="Completed (worktree session)">
              <SessionCreationProgress
                steps={
                  [
                    {
                      step: "resolving_env",
                      label: "Resolving environment...",
                      status: "done",
                    },
                    {
                      step: "fetching_git",
                      label: "Fetching from remote...",
                      status: "done",
                    },
                    {
                      step: "checkout_branch",
                      label: "Checking out feat/auth...",
                      status: "done",
                    },
                    {
                      step: "creating_worktree",
                      label: "Creating worktree...",
                      status: "done",
                    },
                    {
                      step: "launching_cli",
                      label: "Launching Claude Code...",
                      status: "done",
                    },
                  ] satisfies CreationProgressEvent[]
                }
              />
            </Card>
            <Card label="Error during image pull">
              <SessionCreationProgress
                steps={
                  [
                    {
                      step: "resolving_env",
                      label: "Resolving environment...",
                      status: "done",
                    },
                    {
                      step: "pulling_image",
                      label: "Pulling Docker image...",
                      status: "error",
                    },
                  ] satisfies CreationProgressEvent[]
                }
                error="Failed to pull docker.io/stangirard/the-companion:latest — connection timed out after 30s"
              />
            </Card>
            <Card label="With streaming init script logs">
              <SessionCreationProgress
                steps={
                  [
                    {
                      step: "resolving_env",
                      label: "Resolving environment...",
                      status: "done",
                    },
                    {
                      step: "pulling_image",
                      label: "Image ready",
                      status: "done",
                    },
                    {
                      step: "creating_container",
                      label: "Container running",
                      status: "done",
                    },
                    {
                      step: "running_init_script",
                      label: "Running init script...",
                      status: "in_progress",
                      detail: "Installing dependencies...",
                    },
                  ] satisfies CreationProgressEvent[]
                }
              />
            </Card>
            <Card label="With streaming image pull logs">
              <SessionCreationProgress
                steps={
                  [
                    {
                      step: "resolving_env",
                      label: "Resolving environment...",
                      status: "done",
                    },
                    {
                      step: "pulling_image",
                      label: "Pulling Docker image...",
                      status: "in_progress",
                      detail: "Downloading layer 3/7 [=====>    ] 45%",
                    },
                  ] satisfies CreationProgressEvent[]
                }
              />
            </Card>
            <Card label="Error during init script">
              <SessionCreationProgress
                steps={
                  [
                    {
                      step: "resolving_env",
                      label: "Resolving environment...",
                      status: "done",
                    },
                    {
                      step: "pulling_image",
                      label: "Pulling Docker image...",
                      status: "done",
                    },
                    {
                      step: "creating_container",
                      label: "Starting container...",
                      status: "done",
                    },
                    {
                      step: "running_init_script",
                      label: "Running init script...",
                      status: "error",
                    },
                  ] satisfies CreationProgressEvent[]
                }
                error={
                  "npm ERR! code ENOENT\nnpm ERR! syscall open\nnpm ERR! path /app/package.json"
                }
              />
            </Card>
          </div>
        </Section>
        {/* ─── Session Launch Overlay ──────────────────────────── */}
        <Section
          title="Session Launch Overlay"
          description="Full-screen overlay shown during session creation, replacing the inline progress list"
        >
          <div className="space-y-4">
            <Card label="In progress (container session)">
              <div className="relative h-[360px] bg-cc-bg rounded-lg overflow-hidden border border-cc-border">
                <SessionLaunchOverlay
                  steps={
                    [
                      {
                        step: "resolving_env",
                        label: "Environment resolved",
                        status: "done",
                      },
                      {
                        step: "pulling_image",
                        label: "Pulling Docker image...",
                        status: "done",
                      },
                      {
                        step: "creating_container",
                        label: "Starting container...",
                        status: "in_progress",
                      },
                      {
                        step: "launching_cli",
                        label: "Launching Claude Code...",
                        status: "in_progress",
                      },
                    ] satisfies CreationProgressEvent[]
                  }
                  backend="claude"
                  onCancel={() => {}}
                />
              </div>
            </Card>
            <Card label="All steps done (launching)">
              <div className="relative h-[360px] bg-cc-bg rounded-lg overflow-hidden border border-cc-border">
                <SessionLaunchOverlay
                  steps={
                    [
                      {
                        step: "resolving_env",
                        label: "Environment resolved",
                        status: "done",
                      },
                      {
                        step: "fetching_git",
                        label: "Fetch complete",
                        status: "done",
                      },
                      {
                        step: "creating_worktree",
                        label: "Worktree created",
                        status: "done",
                      },
                      {
                        step: "launching_cli",
                        label: "CLI launched",
                        status: "done",
                      },
                    ] satisfies CreationProgressEvent[]
                  }
                  backend="claude"
                />
              </div>
            </Card>
            <Card label="Error state">
              <div className="relative h-[400px] bg-cc-bg rounded-lg overflow-hidden border border-cc-border">
                <SessionLaunchOverlay
                  steps={
                    [
                      {
                        step: "resolving_env",
                        label: "Environment resolved",
                        status: "done",
                      },
                      {
                        step: "pulling_image",
                        label: "Pulling Docker image...",
                        status: "error",
                      },
                    ] satisfies CreationProgressEvent[]
                  }
                  error="Failed to pull docker.io/stangirard/the-companion:latest — connection timed out after 30s"
                  backend="claude"
                  onCancel={() => {}}
                />
              </div>
            </Card>
            <Card label="Codex backend">
              <div className="relative h-[320px] bg-cc-bg rounded-lg overflow-hidden border border-cc-border">
                <SessionLaunchOverlay
                  steps={
                    [
                      {
                        step: "resolving_env",
                        label: "Environment resolved",
                        status: "done",
                      },
                      {
                        step: "launching_cli",
                        label: "Launching Codex...",
                        status: "in_progress",
                      },
                    ] satisfies CreationProgressEvent[]
                  }
                  backend="codex"
                  onCancel={() => {}}
                />
              </div>
            </Card>
          </div>
        </Section>
        {/* ─── Update Overlay ──────────────────────────── */}
        <Section
          title="Update Overlay"
          description="Full-screen overlay shown when auto-update is in progress, polls server and reloads when ready"
        >
          <div className="space-y-4">
            <Card label="Installing phase">
              <div className="relative h-[360px] bg-cc-bg rounded-lg overflow-hidden border border-cc-border">
                <PlaygroundUpdateOverlay phase="installing" />
              </div>
            </Card>
            <Card label="Restarting phase">
              <div className="relative h-[360px] bg-cc-bg rounded-lg overflow-hidden border border-cc-border">
                <PlaygroundUpdateOverlay phase="restarting" />
              </div>
            </Card>
            <Card label="Waiting for server">
              <div className="relative h-[360px] bg-cc-bg rounded-lg overflow-hidden border border-cc-border">
                <PlaygroundUpdateOverlay phase="waiting" />
              </div>
            </Card>
            <Card label="Update complete">
              <div className="relative h-[360px] bg-cc-bg rounded-lg overflow-hidden border border-cc-border">
                <PlaygroundUpdateOverlay phase="ready" />
              </div>
            </Card>
          </div>
        </Section>
        {/* ─── CLAUDE.md Editor ──────────────────────────────── */}
        <Section
          title="CLAUDE.md Editor"
          description="Modal for viewing and editing project CLAUDE.md instructions"
        >
          <div className="space-y-4 max-w-3xl">
            <Card label="Open editor button (from TopBar)">
              <PlaygroundClaudeMdButton />
            </Card>
            <Card label="Terminal quick tabs (from TopBar)">
              <PlaygroundTerminalTabsMock />
            </Card>
          </div>
        </Section>
        {/* ─── Session Items ──────────────────────────────────── */}
        <Section
          title="Session Items"
          description="Sidebar session rows — status dot, backend badge, Docker indicator, archive on hover"
        >
          <PlaygroundSessionItems />
        </Section>
      </div>
    </div>
  );
}

// ─── Session Item Playground ─────────────────────────────────────────────────

function mockSession(overrides: Partial<SessionItemType>): SessionItemType {
  return {
    id: `mock-${Math.random().toString(36).slice(2, 8)}`,
    model: "claude-sonnet-4-20250514",
    cwd: "/Users/dev/project",
    gitBranch: "main",
    isContainerized: false,
    gitAhead: 0,
    gitBehind: 0,
    linesAdded: 0,
    linesRemoved: 0,
    isConnected: false,
    status: null,
    sdkState: null,
    createdAt: Date.now(),
    archived: false,
    backendType: "claude",
    repoRoot: "/Users/dev/project",
    permCount: 0,
    ...overrides,
  };
}

const noopRef = { current: null };
const noopSessionItemProps = {
  onSelect: () => {},
  onStartRename: () => {},
  onArchive: (e: React.MouseEvent) => e.stopPropagation(),
  onUnarchive: (e: React.MouseEvent) => e.stopPropagation(),
  onDelete: (e: React.MouseEvent) => e.stopPropagation(),
  onClearRecentlyRenamed: () => {},
  editingSessionId: null,
  editingName: "",
  setEditingName: () => {},
  onConfirmRename: () => {},
  onCancelRename: () => {},
  editInputRef: noopRef,
};

function PlaygroundSessionItems() {
  return (
    <div className="space-y-4 max-w-sm">
      {/* Running — Claude Code */}
      <Card label="Running — Claude Code">
        <div className="bg-cc-sidebar rounded-lg p-1">
          <SessionItem
            session={mockSession({
              isConnected: true,
              status: "running",
              backendType: "claude",
            })}
            isActive={false}
            sessionName="Refactor auth module"
            permCount={0}
            isRecentlyRenamed={false}
            {...noopSessionItemProps}
          />
        </div>
      </Card>

      {/* Running — Codex + Docker */}
      <Card label="Running — Codex + Docker">
        <div className="bg-cc-sidebar rounded-lg p-1">
          <SessionItem
            session={mockSession({
              isConnected: true,
              status: "running",
              backendType: "codex",
              isContainerized: true,
            })}
            isActive={false}
            sessionName="Add payment flow"
            permCount={0}
            isRecentlyRenamed={false}
            {...noopSessionItemProps}
          />
        </div>
      </Card>

      {/* Awaiting Input — 2 permissions */}
      <Card label="Awaiting Input — 2 permissions pending">
        <div className="bg-cc-sidebar rounded-lg p-1">
          <SessionItem
            session={mockSession({
              isConnected: true,
              status: "running",
              backendType: "claude",
              permCount: 2,
            })}
            isActive={false}
            sessionName="Fix login bug"
            permCount={2}
            isRecentlyRenamed={false}
            {...noopSessionItemProps}
          />
        </div>
      </Card>

      {/* Idle */}
      <Card label="Idle — connected, not running">
        <div className="bg-cc-sidebar rounded-lg p-1">
          <SessionItem
            session={mockSession({
              isConnected: true,
              status: "idle",
              backendType: "claude",
            })}
            isActive={false}
            sessionName="Review PR #42"
            permCount={0}
            isRecentlyRenamed={false}
            {...noopSessionItemProps}
          />
        </div>
      </Card>

      {/* Exited */}
      <Card label="Exited — session stopped">
        <div className="bg-cc-sidebar rounded-lg p-1">
          <SessionItem
            session={mockSession({ sdkState: "exited", backendType: "codex" })}
            isActive={false}
            sessionName="Deploy to staging"
            permCount={0}
            isRecentlyRenamed={false}
            {...noopSessionItemProps}
          />
        </div>
      </Card>

      {/* Active (selected) */}
      <Card label="Active (selected session)">
        <div className="bg-cc-sidebar rounded-lg p-1">
          <SessionItem
            session={mockSession({
              isConnected: true,
              status: "running",
              backendType: "claude",
              isContainerized: true,
            })}
            isActive={true}
            sessionName="Build new dashboard"
            permCount={0}
            isRecentlyRenamed={false}
            {...noopSessionItemProps}
          />
        </div>
      </Card>

      {/* Archived */}
      <Card label="Archived session">
        <div className="bg-cc-sidebar rounded-lg p-1">
          <SessionItem
            session={mockSession({ archived: true, backendType: "claude" })}
            isActive={false}
            isArchived={true}
            sessionName="Old migration script"
            permCount={0}
            isRecentlyRenamed={false}
            {...noopSessionItemProps}
          />
        </div>
      </Card>
    </div>
  );
}

// ─── Shared Layout Helpers ──────────────────────────────────────────────────

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-4">
        <h2 className="text-base font-semibold text-cc-fg">{title}</h2>
        <p className="text-xs text-cc-muted mt-0.5">{description}</p>
      </div>
      {children}
    </section>
  );
}

function Card({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border border-cc-border rounded-xl overflow-hidden bg-cc-card">
      <div className="px-3 py-1.5 bg-cc-hover/50 border-b border-cc-border">
        <span className="text-[10px] text-cc-muted font-mono-code uppercase tracking-wider">
          {label}
        </span>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function PlaygroundTerminalTabsMock() {
  const tabs = [
    { id: "host", label: "Terminal", cwd: "/Users/demo/project" },
    { id: "docker", label: "Docker", cwd: "/workspace" },
  ];
  const [active, setActive] = useState("host");
  const [placement, setPlacement] = useState<
    "top" | "right" | "bottom" | "left"
  >("bottom");

  return (
    <div className="rounded-xl border border-cc-border bg-cc-card overflow-hidden">
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-cc-border bg-cc-sidebar">
        <div className="flex items-center gap-0.5 bg-cc-hover rounded-md p-0.5 mr-1">
          {(["top", "right", "bottom", "left"] as const).map((p) => (
            <button
              key={p}
              onClick={() => setPlacement(p)}
              className={`px-2 py-1 rounded text-[10px] font-medium cursor-pointer ${
                placement === p ? "bg-cc-card text-cc-fg" : "text-cc-muted"
              }`}
            >
              {p[0]?.toUpperCase()}
              {p.slice(1)}
            </button>
          ))}
        </div>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActive(tab.id)}
            className={`px-2 py-1 rounded-md text-[11px] font-medium border cursor-pointer ${
              active === tab.id
                ? "text-cc-fg bg-cc-card border-cc-border"
                : "text-cc-muted border-transparent hover:bg-cc-hover"
            }`}
          >
            {tab.label}
          </button>
        ))}
        <span className="text-[11px] font-mono-code text-cc-muted truncate ml-1">
          {tabs.find((tab) => tab.id === active)?.cwd}
        </span>
      </div>
      <div className="h-32 p-3 bg-cc-bg">
        <div
          className={`h-full min-h-0 rounded-lg border border-cc-border bg-cc-card flex ${placement === "left" || placement === "right" ? "flex-row" : "flex-col"}`}
        >
          {(placement === "top" || placement === "left") && (
            <div
              className={`${placement === "left" ? "w-2/5 border-r" : "h-2/5 border-b"} border-cc-border bg-cc-sidebar/40 flex items-center justify-center text-[10px] text-cc-muted font-mono-code`}
            >
              Terminal docked
            </div>
          )}
          <div className="flex-1 min-h-0 flex items-center justify-center text-xs text-cc-muted">
            Session content
          </div>
          {(placement === "right" || placement === "bottom") && (
            <div
              className={`${placement === "right" ? "w-2/5 border-l" : "h-2/5 border-t"} border-cc-border bg-cc-sidebar/40 flex items-center justify-center text-[10px] text-cc-muted font-mono-code`}
            >
              Terminal docked
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Inline Tool Group (mirrors MessageFeed's ToolMessageGroup) ─────────────

interface ToolItem {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

function PlaygroundToolGroup({
  toolName,
  items,
}: {
  toolName: string;
  items: ToolItem[];
}) {
  const [open, setOpen] = useState(false);
  const iconType = getToolIcon(toolName);
  const label = getToolLabel(toolName);
  const count = items.length;

  if (count === 1) {
    const item = items[0];
    return (
      <div className="flex items-start gap-3">
        <div className="w-6 h-6 rounded-full bg-cc-primary/10 flex items-center justify-center shrink-0 mt-0.5">
          <svg
            viewBox="0 0 16 16"
            fill="currentColor"
            className="w-3 h-3 text-cc-primary"
          >
            <circle cx="8" cy="8" r="3" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <div className="border border-cc-border rounded-[10px] overflow-hidden bg-cc-card">
            <button
              onClick={() => setOpen(!open)}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-cc-hover transition-colors cursor-pointer"
            >
              <svg
                viewBox="0 0 16 16"
                fill="currentColor"
                className={`w-3 h-3 text-cc-muted transition-transform shrink-0 ${open ? "rotate-90" : ""}`}
              >
                <path d="M6 4l4 4-4 4" />
              </svg>
              <ToolIcon type={iconType} />
              <span className="text-xs font-medium text-cc-fg">{label}</span>
              <span className="text-xs text-cc-muted truncate flex-1 font-mono-code">
                {getPreview(item.name, item.input)}
              </span>
            </button>
            {open && (
              <div className="px-3 pb-3 pt-0 border-t border-cc-border mt-0">
                <pre className="mt-2 text-[11px] text-cc-muted font-mono-code whitespace-pre-wrap leading-relaxed max-h-60 overflow-y-auto">
                  {JSON.stringify(item.input, null, 2)}
                </pre>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-3">
      <div className="w-6 h-6 rounded-full bg-cc-primary/10 flex items-center justify-center shrink-0 mt-0.5">
        <svg
          viewBox="0 0 16 16"
          fill="currentColor"
          className="w-3 h-3 text-cc-primary"
        >
          <circle cx="8" cy="8" r="3" />
        </svg>
      </div>
      <div className="flex-1 min-w-0">
        <div className="border border-cc-border rounded-[10px] overflow-hidden bg-cc-card">
          <button
            onClick={() => setOpen(!open)}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-cc-hover transition-colors cursor-pointer"
          >
            <svg
              viewBox="0 0 16 16"
              fill="currentColor"
              className={`w-3 h-3 text-cc-muted transition-transform shrink-0 ${open ? "rotate-90" : ""}`}
            >
              <path d="M6 4l4 4-4 4" />
            </svg>
            <ToolIcon type={iconType} />
            <span className="text-xs font-medium text-cc-fg">{label}</span>
            <span className="text-[10px] text-cc-muted bg-cc-hover rounded-full px-1.5 py-0.5 tabular-nums font-medium">
              {count}
            </span>
          </button>
          {open && (
            <div className="border-t border-cc-border px-3 py-1.5">
              {items.map((item, i) => {
                const preview = getPreview(item.name, item.input);
                return (
                  <div
                    key={item.id || i}
                    className="flex items-center gap-2 py-1 text-xs text-cc-muted font-mono-code truncate"
                  >
                    <span className="w-1 h-1 rounded-full bg-cc-muted/40 shrink-0" />
                    <span className="truncate">
                      {preview || JSON.stringify(item.input).slice(0, 80)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Inline Subagent Group (mirrors MessageFeed's SubagentContainer) ────────

function PlaygroundSubagentGroup({
  description,
  agentType,
  backend = "codex",
  status,
  senderThreadId,
  receiverThreadIds = [],
  receiverCount,
  items,
}: {
  description: string;
  agentType: string;
  backend?: "claude" | "codex";
  status?: string;
  senderThreadId?: string;
  receiverThreadIds?: string[];
  receiverCount?: number;
  items: ToolItem[];
}) {
  const [open, setOpen] = useState(true);
  const normalizedStatus = useMemo(() => {
    if (!status) return null;
    const raw = status.trim().toLowerCase();
    if (!raw) return null;
    if (raw === "completed")
      return {
        label: "completed",
        className: "text-green-600 bg-green-500/15",
        summary: "completed",
      };
    if (raw === "failed" || raw === "error" || raw === "errored")
      return {
        label: "failed",
        className: "text-cc-error bg-cc-error/10",
        summary: "failed",
      };
    if (raw === "pending" || raw === "pendinginit" || raw === "pending_init")
      return {
        label: "pending",
        className: "text-amber-700 bg-amber-500/15",
        summary: "pending",
      };
    if (
      raw === "running" ||
      raw === "inprogress" ||
      raw === "in_progress" ||
      raw === "started"
    )
      return {
        label: "running",
        className: "text-blue-600 bg-blue-500/15",
        summary: "running",
      };
    return {
      label: status,
      className: "text-amber-700 bg-amber-500/15",
      summary: "running",
    };
  }, [status]);
  const statusSummaryCount =
    receiverCount !== undefined ? receiverCount : items.length;

  return (
    <div className="ml-9 border-l-2 border-cc-primary/20 pl-4">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 py-1.5 text-left cursor-pointer mb-1"
      >
        <svg
          viewBox="0 0 16 16"
          fill="currentColor"
          className={`w-3 h-3 text-cc-muted transition-transform shrink-0 ${open ? "rotate-90" : ""}`}
        >
          <path d="M6 4l4 4-4 4" />
        </svg>
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className="w-3.5 h-3.5 text-cc-primary shrink-0"
        >
          <circle cx="8" cy="8" r="5" />
          <path d="M8 5v3l2 1" strokeLinecap="round" />
        </svg>
        <span className="text-xs font-medium text-cc-fg truncate">
          {description}
        </span>
        {agentType && (
          <span className="text-[10px] text-cc-muted bg-cc-hover rounded-full px-1.5 py-0.5 shrink-0">
            {agentType}
          </span>
        )}
        <span className="text-[10px] text-cc-muted bg-cc-hover rounded-full px-1.5 py-0.5 shrink-0">
          {backend === "codex" ? "Codex" : "Claude"}
        </span>
        {normalizedStatus && (
          <span
            className={`text-[10px] rounded-full px-1.5 py-0.5 shrink-0 ${normalizedStatus.className}`}
          >
            {normalizedStatus.label}
          </span>
        )}
        {receiverCount !== undefined && (
          <span className="text-[10px] text-cc-muted bg-cc-hover rounded-full px-1.5 py-0.5 shrink-0">
            {receiverCount} agent{receiverCount === 1 ? "" : "s"}
          </span>
        )}
        <span className="text-[10px] text-cc-muted bg-cc-hover rounded-full px-1.5 py-0.5 tabular-nums shrink-0 ml-auto">
          {items.length}
        </span>
      </button>
      {open && (
        <div className="space-y-3 pb-2">
          {(normalizedStatus ||
            senderThreadId ||
            receiverThreadIds.length > 0) && (
            <div className="rounded-lg border border-cc-border bg-cc-card px-2.5 py-2 space-y-1.5">
              <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
                {normalizedStatus && (
                  <span
                    className={`rounded-full px-1.5 py-0.5 ${normalizedStatus.className}`}
                  >
                    {statusSummaryCount} {normalizedStatus.summary}
                  </span>
                )}
                {senderThreadId && (
                  <span className="rounded-full px-1.5 py-0.5 text-cc-muted bg-cc-hover font-mono-code">
                    sender: {senderThreadId}
                  </span>
                )}
                {receiverThreadIds.length > 0 && (
                  <span className="rounded-full px-1.5 py-0.5 text-cc-muted bg-cc-hover">
                    receivers: {receiverThreadIds.length}
                  </span>
                )}
              </div>
              {receiverThreadIds.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {receiverThreadIds.map((threadId) => (
                    <span
                      key={threadId}
                      className="text-[10px] rounded-full px-1.5 py-0.5 text-cc-muted bg-cc-hover font-mono-code"
                    >
                      {threadId}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
          <PlaygroundToolGroup
            toolName={items[0]?.name || "Grep"}
            items={items}
          />
        </div>
      )}
    </div>
  );
}

// ─── Codex Session Demo (injects mock Codex data into a temp session) ────────

const CODEX_DEMO_SESSION = "codex-playground-demo";

function CodexPlaygroundDemo() {
  useEffect(() => {
    const store = useStore.getState();
    const prev = store.sessions.get(CODEX_DEMO_SESSION);

    // Create a fake Codex session with rate limits and token details
    store.addSession({
      session_id: CODEX_DEMO_SESSION,
      backend_type: "codex",
      model: "o3",
      cwd: "/Users/demo/project",
      tools: [],
      permissionMode: "bypassPermissions",
      claude_code_version: "0.1.0",
      mcp_servers: [],
      agents: [],
      slash_commands: [],
      skills: [],
      total_cost_usd: 0,
      num_turns: 8,
      context_used_percent: 45,
      is_compacting: false,
      git_branch: "main",
      is_worktree: false,
      is_containerized: false,
      repo_root: "/Users/demo/project",
      git_ahead: 0,
      git_behind: 0,
      total_lines_added: 0,
      total_lines_removed: 0,
      codex_rate_limits: {
        primary: {
          usedPercent: 62,
          windowDurationMins: 300,
          resetsAt: Date.now() + 2 * 3_600_000,
        },
        secondary: {
          usedPercent: 18,
          windowDurationMins: 10080,
          resetsAt: Date.now() + 5 * 86_400_000,
        },
      },
      codex_token_details: {
        inputTokens: 84_230,
        outputTokens: 12_450,
        cachedInputTokens: 41_200,
        reasoningOutputTokens: 8_900,
        modelContextWindow: 200_000,
      },
    });

    return () => {
      useStore.setState((s) => {
        const sessions = new Map(s.sessions);
        if (prev) sessions.set(CODEX_DEMO_SESSION, prev);
        else sessions.delete(CODEX_DEMO_SESSION);
        return { sessions };
      });
    };
  }, []);

  return (
    <div className="w-[280px] border border-cc-border rounded-xl overflow-hidden bg-cc-card">
      <CodexRateLimitsSection sessionId={CODEX_DEMO_SESSION} />
      <CodexTokenDetailsSection sessionId={CODEX_DEMO_SESSION} />
    </div>
  );
}

// ─── Inline UpdateBanner (sets store state for playground preview) ───────────

function PlaygroundUpdateBanner({ updateInfo }: { updateInfo: UpdateInfo }) {
  useEffect(() => {
    const prev = useStore.getState().updateInfo;
    const prevDismissed = useStore.getState().updateDismissedVersion;
    useStore.getState().setUpdateInfo(updateInfo);
    // Clear any dismiss so the banner shows
    if (prevDismissed) {
      useStore.setState({ updateDismissedVersion: null });
    }
    return () => {
      useStore.getState().setUpdateInfo(prev);
      if (prevDismissed) {
        useStore.setState({ updateDismissedVersion: prevDismissed });
      }
    };
  }, [updateInfo]);

  return <UpdateBanner />;
}

// ─── Inline ClaudeMd Button (opens the real editor modal) ───────────────────

function PlaygroundClaudeMdButton() {
  const [open, setOpen] = useState(false);
  const [cwd, setCwd] = useState("/tmp");

  useEffect(() => {
    api
      .getHome()
      .then((res) => setCwd(res.cwd))
      .catch(() => {});
  }, []);

  return (
    <div className="flex items-center gap-3">
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 px-3 py-2 rounded-lg bg-cc-hover border border-cc-border hover:bg-cc-active transition-colors cursor-pointer"
      >
        <svg
          viewBox="0 0 16 16"
          fill="currentColor"
          className="w-4 h-4 text-cc-primary"
        >
          <path d="M4 1.5a.5.5 0 01.5-.5h7a.5.5 0 01.354.146l2 2A.5.5 0 0114 3.5v11a.5.5 0 01-.5.5h-11a.5.5 0 01-.5-.5v-13zm1 .5v12h8V4h-1.5a.5.5 0 01-.5-.5V2H5zm6 0v1h1l-1-1zM6.5 7a.5.5 0 000 1h5a.5.5 0 000-1h-5zm0 2a.5.5 0 000 1h5a.5.5 0 000-1h-5zm0 2a.5.5 0 000 1h3a.5.5 0 000-1h-3z" />
        </svg>
        <span className="text-xs font-medium text-cc-fg">Edit CLAUDE.md</span>
      </button>
      <span className="text-[11px] text-cc-muted">
        Click to open the editor modal (uses server working directory)
      </span>
      <ClaudeMdEditor cwd={cwd} open={open} onClose={() => setOpen(false)} />
    </div>
  );
}

// ─── Inline MCP Server Row (static preview, no WebSocket) ──────────────────

function PlaygroundMcpRow({ server }: { server: McpServerDetail }) {
  const [expanded, setExpanded] = useState(false);
  const statusMap: Record<string, { label: string; cls: string; dot: string }> =
    {
      connected: {
        label: "Connected",
        cls: "text-cc-success bg-cc-success/10",
        dot: "bg-cc-success",
      },
      connecting: {
        label: "Connecting",
        cls: "text-cc-warning bg-cc-warning/10",
        dot: "bg-cc-warning animate-pulse",
      },
      failed: {
        label: "Failed",
        cls: "text-cc-error bg-cc-error/10",
        dot: "bg-cc-error",
      },
      disabled: {
        label: "Disabled",
        cls: "text-cc-muted bg-cc-hover",
        dot: "bg-cc-muted opacity-40",
      },
    };
  const badge = statusMap[server.status] || statusMap.disabled;

  return (
    <div className="rounded-lg border border-cc-border bg-cc-bg">
      <div className="flex items-center gap-2 px-2.5 py-2">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${badge.dot}`} />
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex-1 min-w-0 text-left cursor-pointer"
        >
          <span className="text-[12px] font-medium text-cc-fg truncate block">
            {server.name}
          </span>
        </button>
        <span
          className={`text-[9px] font-medium px-1.5 rounded-full leading-[16px] shrink-0 ${badge.cls}`}
        >
          {badge.label}
        </span>
      </div>
      {expanded && (
        <div className="px-2.5 pb-2.5 space-y-1.5 border-t border-cc-border pt-2">
          <div className="text-[11px] text-cc-muted space-y-0.5">
            <div className="flex items-center gap-1">
              <span className="text-cc-muted/60">Type:</span>
              <span>{server.config.type}</span>
            </div>
            {server.config.command && (
              <div className="flex items-start gap-1">
                <span className="text-cc-muted/60 shrink-0">Cmd:</span>
                <span className="font-mono text-[10px] break-all">
                  {server.config.command}
                  {server.config.args?.length
                    ? ` ${server.config.args.join(" ")}`
                    : ""}
                </span>
              </div>
            )}
            {server.config.url && (
              <div className="flex items-start gap-1">
                <span className="text-cc-muted/60 shrink-0">URL:</span>
                <span className="font-mono text-[10px] break-all">
                  {server.config.url}
                </span>
              </div>
            )}
            <div className="flex items-center gap-1">
              <span className="text-cc-muted/60">Scope:</span>
              <span>{server.scope}</span>
            </div>
          </div>
          {server.error && (
            <div className="text-[11px] text-cc-error bg-cc-error/5 rounded px-2 py-1">
              {server.error}
            </div>
          )}
          {server.tools && server.tools.length > 0 && (
            <div className="space-y-1">
              <span className="text-[10px] text-cc-muted uppercase tracking-wider">
                Tools ({server.tools.length})
              </span>
              <div className="flex flex-wrap gap-1">
                {server.tools.map((tool) => (
                  <span
                    key={tool.name}
                    className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-cc-hover text-cc-fg"
                  >
                    {tool.name}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Inline TaskRow (avoids store dependency from TaskPanel) ────────────────

function TaskRow({ task }: { task: TaskItem }) {
  const isCompleted = task.status === "completed";
  const isInProgress = task.status === "in_progress";

  return (
    <div
      className={`px-2.5 py-2 rounded-lg ${isCompleted ? "opacity-50" : ""}`}
    >
      <div className="flex items-start gap-2">
        <span className="shrink-0 flex items-center justify-center w-4 h-4 mt-px">
          {isInProgress ? (
            <svg
              className="w-4 h-4 text-cc-primary animate-spin"
              viewBox="0 0 16 16"
              fill="none"
            >
              <circle
                cx="8"
                cy="8"
                r="6"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeDasharray="28"
                strokeDashoffset="8"
                strokeLinecap="round"
              />
            </svg>
          ) : isCompleted ? (
            <svg
              viewBox="0 0 16 16"
              fill="currentColor"
              className="w-4 h-4 text-cc-success"
            >
              <path
                fillRule="evenodd"
                d="M8 15A7 7 0 108 1a7 7 0 000 14zm3.354-9.354a.5.5 0 00-.708-.708L7 8.586 5.354 6.94a.5.5 0 10-.708.708l2 2a.5.5 0 00.708 0l4-4z"
                clipRule="evenodd"
              />
            </svg>
          ) : (
            <svg
              viewBox="0 0 16 16"
              fill="none"
              className="w-4 h-4 text-cc-muted"
            >
              <circle
                cx="8"
                cy="8"
                r="6"
                stroke="currentColor"
                strokeWidth="1.5"
              />
            </svg>
          )}
        </span>
        <span
          className={`text-[13px] leading-snug flex-1 ${isCompleted ? "text-cc-muted line-through" : "text-cc-fg"}`}
        >
          {task.subject}
        </span>
      </div>
      {isInProgress && task.activeForm && (
        <p className="mt-1 ml-6 text-[11px] text-cc-muted italic truncate">
          {task.activeForm}
        </p>
      )}
      {task.blockedBy && task.blockedBy.length > 0 && (
        <p className="mt-1 ml-6 text-[11px] text-cc-muted flex items-center gap-1">
          <svg viewBox="0 0 16 16" fill="none" className="w-3 h-3 shrink-0">
            <circle
              cx="8"
              cy="8"
              r="6"
              stroke="currentColor"
              strokeWidth="1.5"
            />
            <path
              d="M5 8h6"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
          <span>
            blocked by {task.blockedBy.map((b) => `#${b}`).join(", ")}
          </span>
        </p>
      )}
    </div>
  );
}

// ─── Inline AiValidationToggle playground wrapper ───────────────────────────

const PLAYGROUND_AI_VALIDATION_SESSION = "ai-validation-playground";

function PlaygroundAiValidationToggle({ enabled }: { enabled: boolean }) {
  useEffect(() => {
    const store = useStore.getState();
    const prev = store.sessions.get(PLAYGROUND_AI_VALIDATION_SESSION);
    store.updateSession(PLAYGROUND_AI_VALIDATION_SESSION, {
      session_id: PLAYGROUND_AI_VALIDATION_SESSION,
      model: "claude-sonnet-4-20250514",
      cwd: "/workspace",
      tools: [],
      permissionMode: "default",
      claude_code_version: "1.0.0",
      mcp_servers: [],
      agents: [],
      slash_commands: [],
      skills: [],
      total_cost_usd: 0,
      num_turns: 0,
      context_used_percent: 0,
      is_compacting: false,
      git_branch: "main",
      is_worktree: false,
      is_containerized: false,
      repo_root: "/workspace",
      git_ahead: 0,
      git_behind: 0,
      total_lines_added: 0,
      total_lines_removed: 0,
      aiValidationEnabled: enabled,
      aiValidationAutoApprove: true,
      aiValidationAutoDeny: true,
      ...prev,
    });
    return () => {
      if (prev) {
        useStore
          .getState()
          .updateSession(PLAYGROUND_AI_VALIDATION_SESSION, prev);
      }
    };
  }, [enabled]);

  // Force the enabled state each render to match the prop
  useEffect(() => {
    useStore
      .getState()
      .setSessionAiValidation(PLAYGROUND_AI_VALIDATION_SESSION, {
        aiValidationEnabled: enabled,
      });
  }, [enabled]);

  return (
    <div className="flex items-center gap-2 p-2">
      <AiValidationToggle sessionId={PLAYGROUND_AI_VALIDATION_SESSION} />
      <span className="text-xs text-cc-muted">Click to toggle</span>
    </div>
  );
}
