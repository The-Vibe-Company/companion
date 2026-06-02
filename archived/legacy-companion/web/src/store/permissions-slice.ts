import type { StateCreator } from "zustand";
import type { AppState } from "./index.js";
import type { PermissionRequest } from "../types.js";

export interface PermissionsSlice {
  pendingPermissions: Map<string, Map<string, PermissionRequest>>;
  aiResolvedPermissions: Map<string, Array<{
    request: PermissionRequest;
    behavior: "allow" | "deny";
    reason: string;
    timestamp: number;
  }>>;

  addPermission: (sessionId: string, perm: PermissionRequest) => void;
  removePermission: (sessionId: string, requestId: string) => void;
  addAiResolvedPermission: (sessionId: string, entry: { request: PermissionRequest; behavior: "allow" | "deny"; reason: string; timestamp: number }) => void;
  clearAiResolvedPermissions: (sessionId: string) => void;
}

export const createPermissionsSlice: StateCreator<AppState, [], [], PermissionsSlice> = (set) => ({
  pendingPermissions: new Map(),
  aiResolvedPermissions: new Map(),

  addPermission: (sessionId, perm) =>
    set((s) => {
      const pendingPermissions = new Map(s.pendingPermissions);
      const sessionPerms = new Map(pendingPermissions.get(sessionId) || []);
      sessionPerms.set(perm.request_id, perm);
      pendingPermissions.set(sessionId, sessionPerms);
      return { pendingPermissions };
    }),

  removePermission: (sessionId, requestId) =>
    set((s) => {
      const pendingPermissions = new Map(s.pendingPermissions);
      const sessionPerms = pendingPermissions.get(sessionId);
      if (sessionPerms) {
        const updated = new Map(sessionPerms);
        updated.delete(requestId);
        pendingPermissions.set(sessionId, updated);
      }
      return { pendingPermissions };
    }),

  addAiResolvedPermission: (sessionId, entry) =>
    set((s) => {
      const aiResolvedPermissions = new Map(s.aiResolvedPermissions);
      const sessionEntries = [...(aiResolvedPermissions.get(sessionId) || []), entry];
      // Keep only the last 50 entries per session to avoid unbounded growth
      if (sessionEntries.length > 50) sessionEntries.splice(0, sessionEntries.length - 50);
      aiResolvedPermissions.set(sessionId, sessionEntries);
      return { aiResolvedPermissions };
    }),

  clearAiResolvedPermissions: (sessionId) =>
    set((s) => {
      const aiResolvedPermissions = new Map(s.aiResolvedPermissions);
      aiResolvedPermissions.delete(sessionId);
      return { aiResolvedPermissions };
    }),
});
