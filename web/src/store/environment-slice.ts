import type { StateCreator } from "zustand";
import type { AppState } from "./index.js";

export interface PortStatusInfo {
  port: number;
  label: string;
  protocol: "http" | "tcp";
  status: "unknown" | "healthy" | "unhealthy";
  service?: string;
  openOnReady?: boolean;
}

export interface ServiceInfo {
  name: string;
  status: "starting" | "started" | "ready" | "failed" | "stopped";
  pid?: number;
  port?: number;
}

export interface EnvironmentSlice {
  /** Port health statuses keyed by session ID. */
  portStatuses: Map<string, PortStatusInfo[]>;
  /** Currently previewed port in the browser pane, keyed by session ID. */
  activePort: Map<string, number | null>;
  /** URL the sandbox browser should navigate to once ready, keyed by session ID. */
  pendingBrowserUrl: Map<string, string>;

  serviceStatuses: Map<string, ServiceInfo[]>;

  /** Service log lines: sessionId -> serviceName -> lines[] */
  serviceLogs: Map<string, Map<string, string[]>>;
  appendServiceLog: (sessionId: string, serviceName: string, line: string) => void;
  setServiceLogs: (sessionId: string, serviceName: string, lines: string[]) => void;
  getServiceLogs: (sessionId: string, serviceName: string) => string[];

  setPortStatuses: (sessionId: string, ports: PortStatusInfo[]) => void;
  setServiceStatuses: (sessionId: string, services: ServiceInfo[]) => void;
  setActivePort: (sessionId: string, port: number | null) => void;
  setPendingBrowserUrl: (sessionId: string, url: string | null) => void;
  clearEnvironment: (sessionId: string) => void;
}

const MAX_LOG_LINES = 500;

export const createEnvironmentSlice: StateCreator<AppState, [], [], EnvironmentSlice> = (set, get) => ({
  portStatuses: new Map(),
  activePort: new Map(),
  pendingBrowserUrl: new Map(),
  serviceStatuses: new Map(),
  serviceLogs: new Map(),

  appendServiceLog: (sessionId, serviceName, line) =>
    set((state) => {
      const outer = new Map(state.serviceLogs);
      const inner = new Map(outer.get(sessionId) ?? new Map<string, string[]>());
      const existing = inner.get(serviceName) ?? [];
      const updated = [...existing, line];
      // Keep only the last MAX_LOG_LINES lines
      if (updated.length > MAX_LOG_LINES) {
        updated.splice(0, updated.length - MAX_LOG_LINES);
      }
      inner.set(serviceName, updated);
      outer.set(sessionId, inner);
      return { serviceLogs: outer };
    }),

  setServiceLogs: (sessionId, serviceName, lines) =>
    set((state) => {
      const outer = new Map(state.serviceLogs);
      const inner = new Map(outer.get(sessionId) ?? new Map<string, string[]>());
      const normalized = lines.slice(-MAX_LOG_LINES);
      inner.set(serviceName, normalized);
      outer.set(sessionId, inner);
      return { serviceLogs: outer };
    }),

  getServiceLogs: (sessionId, serviceName) => {
    const state = get();
    return state.serviceLogs.get(sessionId)?.get(serviceName) ?? [];
  },

  setPortStatuses: (sessionId, ports) =>
    set((state) => {
      const next = new Map(state.portStatuses);
      next.set(sessionId, ports);
      return { portStatuses: next };
    }),

  setServiceStatuses: (sessionId, services) =>
    set((state) => {
      const next = new Map(state.serviceStatuses);
      next.set(sessionId, services);
      return { serviceStatuses: next };
    }),

  setActivePort: (sessionId, port) =>
    set((state) => {
      const next = new Map(state.activePort);
      next.set(sessionId, port);
      return { activePort: next };
    }),

  setPendingBrowserUrl: (sessionId, url) =>
    set((state) => {
      const next = new Map(state.pendingBrowserUrl);
      if (url) {
        next.set(sessionId, url);
      } else {
        next.delete(sessionId);
      }
      return { pendingBrowserUrl: next };
    }),

  clearEnvironment: (sessionId) =>
    set((state) => {
      const nextPorts = new Map(state.portStatuses);
      nextPorts.delete(sessionId);
      const nextActive = new Map(state.activePort);
      nextActive.delete(sessionId);
      const nextPending = new Map(state.pendingBrowserUrl);
      nextPending.delete(sessionId);
      const nextServices = new Map(state.serviceStatuses);
      nextServices.delete(sessionId);
      const nextLogs = new Map(state.serviceLogs);
      nextLogs.delete(sessionId);
      return { portStatuses: nextPorts, activePort: nextActive, pendingBrowserUrl: nextPending, serviceStatuses: nextServices, serviceLogs: nextLogs };
    }),
});
