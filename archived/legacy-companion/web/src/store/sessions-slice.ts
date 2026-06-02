import type { StateCreator } from "zustand";
import type { AppState } from "./index.js";
import type { SessionState, SdkSessionInfo, McpServerDetail } from "../types.js";
import type { PRStatusResponse, LinearIssue } from "../api.js";
import { deleteFromMap, deleteFromSet } from "./utils.js";

function getInitialSessionNames(): Map<string, string> {
  if (typeof window === "undefined") return new Map();
  try {
    return new Map(JSON.parse(localStorage.getItem("cc-session-names") || "[]"));
  } catch {
    return new Map();
  }
}

function getInitialSessionId(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("cc-current-session") || null;
}

function getInitialCollapsedProjects(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    return new Set(JSON.parse(localStorage.getItem("cc-collapsed-projects") || "[]"));
  } catch {
    return new Set();
  }
}

export interface SessionsSlice {
  sessions: Map<string, SessionState>;
  sdkSessions: SdkSessionInfo[];
  currentSessionId: string | null;
  connectionStatus: Map<string, "connecting" | "connected" | "disconnected">;
  cliConnected: Map<string, boolean>;
  cliReconnecting: Map<string, boolean>;
  sessionStatus: Map<string, "idle" | "running" | "compacting" | null>;
  previousPermissionMode: Map<string, string>;
  sessionNames: Map<string, string>;
  recentlyRenamed: Set<string>;
  prStatus: Map<string, PRStatusResponse>;
  linkedLinearIssues: Map<string, LinearIssue>;
  mcpServers: Map<string, McpServerDetail[]>;
  collapsedProjects: Set<string>;

  setCurrentSession: (id: string | null) => void;
  addSession: (session: SessionState) => void;
  updateSession: (sessionId: string, updates: Partial<SessionState>) => void;
  removeSession: (sessionId: string) => void;
  setSdkSessions: (sessions: SdkSessionInfo[]) => void;
  setConnectionStatus: (sessionId: string, status: "connecting" | "connected" | "disconnected") => void;
  setCliConnected: (sessionId: string, connected: boolean) => void;
  setCliReconnecting: (sessionId: string, reconnecting: boolean) => void;
  setSessionStatus: (sessionId: string, status: "idle" | "running" | "compacting" | null) => void;
  setPreviousPermissionMode: (sessionId: string, mode: string) => void;
  setSessionName: (sessionId: string, name: string) => void;
  markRecentlyRenamed: (sessionId: string) => void;
  clearRecentlyRenamed: (sessionId: string) => void;
  setPRStatus: (sessionId: string, status: PRStatusResponse) => void;
  setLinkedLinearIssue: (sessionId: string, issue: LinearIssue | null) => void;
  setMcpServers: (sessionId: string, servers: McpServerDetail[]) => void;
  toggleProjectCollapse: (projectKey: string) => void;
  setSessionAiValidation: (sessionId: string, settings: { aiValidationEnabled?: boolean | null; aiValidationAutoApprove?: boolean | null; aiValidationAutoDeny?: boolean | null }) => void;
}

export const createSessionsSlice: StateCreator<AppState, [], [], SessionsSlice> = (set) => ({
  sessions: new Map(),
  sdkSessions: [],
  currentSessionId: getInitialSessionId(),
  connectionStatus: new Map(),
  cliConnected: new Map(),
  cliReconnecting: new Map(),
  sessionStatus: new Map(),
  previousPermissionMode: new Map(),
  sessionNames: getInitialSessionNames(),
  recentlyRenamed: new Set(),
  prStatus: new Map(),
  linkedLinearIssues: new Map(),
  mcpServers: new Map(),
  collapsedProjects: getInitialCollapsedProjects(),

  setCurrentSession: (id) => {
    if (id) {
      localStorage.setItem("cc-current-session", id);
    } else {
      localStorage.removeItem("cc-current-session");
    }
    set({ currentSessionId: id });
  },

  addSession: (session) =>
    set((s) => {
      const sessions = new Map(s.sessions);
      sessions.set(session.session_id, session);
      // Cross-slice write: initialize the messages entry (owned by ChatSlice)
      // atomically with the session so consumers always find a messages array.
      const messages = new Map(s.messages);
      if (!messages.has(session.session_id)) messages.set(session.session_id, []);
      return { sessions, messages };
    }),

  updateSession: (sessionId, updates) =>
    set((s) => {
      const sessions = new Map(s.sessions);
      const existing = sessions.get(sessionId);
      if (existing) sessions.set(sessionId, { ...existing, ...updates });
      return { sessions };
    }),

  removeSession: (sessionId) =>
    set((s) => {
      const sessionNames = deleteFromMap(s.sessionNames, sessionId);
      localStorage.setItem("cc-session-names", JSON.stringify(Array.from(sessionNames.entries())));
      if (s.currentSessionId === sessionId) {
        localStorage.removeItem("cc-current-session");
      }
      return {
        // Sessions slice fields
        sessions: deleteFromMap(s.sessions, sessionId),
        connectionStatus: deleteFromMap(s.connectionStatus, sessionId),
        cliConnected: deleteFromMap(s.cliConnected, sessionId),
        cliReconnecting: deleteFromMap(s.cliReconnecting, sessionId),
        sessionStatus: deleteFromMap(s.sessionStatus, sessionId),
        previousPermissionMode: deleteFromMap(s.previousPermissionMode, sessionId),
        sessionNames,
        recentlyRenamed: deleteFromSet(s.recentlyRenamed, sessionId),
        mcpServers: deleteFromMap(s.mcpServers, sessionId),
        prStatus: deleteFromMap(s.prStatus, sessionId),
        linkedLinearIssues: deleteFromMap(s.linkedLinearIssues, sessionId),
        sdkSessions: s.sdkSessions.filter((sdk) => sdk.sessionId !== sessionId),
        currentSessionId: s.currentSessionId === sessionId ? null : s.currentSessionId,
        // Chat slice fields
        messages: deleteFromMap(s.messages, sessionId),
        streaming: deleteFromMap(s.streaming, sessionId),
        streamingStartedAt: deleteFromMap(s.streamingStartedAt, sessionId),
        streamingOutputTokens: deleteFromMap(s.streamingOutputTokens, sessionId),
        // Permissions slice fields
        pendingPermissions: deleteFromMap(s.pendingPermissions, sessionId),
        aiResolvedPermissions: deleteFromMap(s.aiResolvedPermissions, sessionId),
        // Tasks slice fields
        sessionTasks: deleteFromMap(s.sessionTasks, sessionId),
        changedFilesTick: deleteFromMap(s.changedFilesTick, sessionId),
        gitChangedFilesCount: deleteFromMap(s.gitChangedFilesCount, sessionId),
        sessionProcesses: deleteFromMap(s.sessionProcesses, sessionId),
        toolProgress: deleteFromMap(s.toolProgress, sessionId),
        toolActivity: deleteFromMap(s.toolActivity, sessionId),
        // UI slice fields
        diffPanelSelectedFile: deleteFromMap(s.diffPanelSelectedFile, sessionId),
        chatTabReentryTickBySession: deleteFromMap(s.chatTabReentryTickBySession, sessionId),
      };
    }),

  setSdkSessions: (sessions) => set({ sdkSessions: sessions }),

  setConnectionStatus: (sessionId, status) =>
    set((s) => {
      const connectionStatus = new Map(s.connectionStatus);
      connectionStatus.set(sessionId, status);
      return { connectionStatus };
    }),

  setCliConnected: (sessionId, connected) =>
    set((s) => {
      const cliConnected = new Map(s.cliConnected);
      cliConnected.set(sessionId, connected);
      return { cliConnected };
    }),

  setCliReconnecting: (sessionId, reconnecting) =>
    set((s) => {
      const cliReconnecting = new Map(s.cliReconnecting);
      if (reconnecting) {
        cliReconnecting.set(sessionId, true);
      } else {
        cliReconnecting.delete(sessionId);
      }
      return { cliReconnecting };
    }),

  setSessionStatus: (sessionId, status) =>
    set((s) => {
      const sessionStatus = new Map(s.sessionStatus);
      sessionStatus.set(sessionId, status);
      return { sessionStatus };
    }),

  setPreviousPermissionMode: (sessionId, mode) =>
    set((s) => {
      const previousPermissionMode = new Map(s.previousPermissionMode);
      previousPermissionMode.set(sessionId, mode);
      return { previousPermissionMode };
    }),

  setSessionName: (sessionId, name) =>
    set((s) => {
      const sessionNames = new Map(s.sessionNames);
      sessionNames.set(sessionId, name);
      localStorage.setItem("cc-session-names", JSON.stringify(Array.from(sessionNames.entries())));
      return { sessionNames };
    }),

  markRecentlyRenamed: (sessionId) =>
    set((s) => {
      const recentlyRenamed = new Set(s.recentlyRenamed);
      recentlyRenamed.add(sessionId);
      return { recentlyRenamed };
    }),

  clearRecentlyRenamed: (sessionId) =>
    set((s) => {
      const recentlyRenamed = new Set(s.recentlyRenamed);
      recentlyRenamed.delete(sessionId);
      return { recentlyRenamed };
    }),

  setPRStatus: (sessionId, status) =>
    set((s) => {
      const prStatus = new Map(s.prStatus);
      prStatus.set(sessionId, status);
      return { prStatus };
    }),

  setLinkedLinearIssue: (sessionId, issue) =>
    set((s) => {
      const linkedLinearIssues = new Map(s.linkedLinearIssues);
      if (issue) {
        linkedLinearIssues.set(sessionId, issue);
      } else {
        linkedLinearIssues.delete(sessionId);
      }
      return { linkedLinearIssues };
    }),

  setMcpServers: (sessionId, servers) =>
    set((s) => {
      const mcpServers = new Map(s.mcpServers);
      mcpServers.set(sessionId, servers);
      return { mcpServers };
    }),

  toggleProjectCollapse: (projectKey) =>
    set((s) => {
      const collapsedProjects = new Set(s.collapsedProjects);
      if (collapsedProjects.has(projectKey)) {
        collapsedProjects.delete(projectKey);
      } else {
        collapsedProjects.add(projectKey);
      }
      localStorage.setItem("cc-collapsed-projects", JSON.stringify(Array.from(collapsedProjects)));
      return { collapsedProjects };
    }),

  setSessionAiValidation: (sessionId, settings) =>
    set((s) => {
      const sessions = new Map(s.sessions);
      const existing = sessions.get(sessionId);
      if (!existing) return {};
      sessions.set(sessionId, { ...existing, ...settings });
      return { sessions };
    }),
});
