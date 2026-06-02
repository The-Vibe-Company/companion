import type { StateCreator } from "zustand";
import type { AppState } from "./index.js";

export type DiffBase = "last-commit" | "default-branch";
import { type TaskPanelConfig, getInitialTaskPanelConfig, getDefaultConfig, persistTaskPanelConfig } from "../components/task-panel-sections.js";

function getInitialDarkMode(): boolean {
  if (typeof window === "undefined") return false;
  const stored = localStorage.getItem("cc-dark-mode");
  if (stored !== null) return stored === "true";
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function getInitialNotificationSound(): boolean {
  if (typeof window === "undefined") return true;
  const stored = localStorage.getItem("cc-notification-sound");
  if (stored !== null) return stored === "true";
  return true;
}

function getInitialNotificationDesktop(): boolean {
  if (typeof window === "undefined") return false;
  const stored = localStorage.getItem("cc-notification-desktop");
  if (stored !== null) return stored === "true";
  return false;
}

export function getInitialDiffBase(): DiffBase {
  if (typeof window === "undefined") return "last-commit";
  const stored = window.localStorage.getItem("cc-diff-base");
  if (stored === "last-commit" || stored === "default-branch") return stored;
  return "last-commit";
}

export interface UiSlice {
  darkMode: boolean;
  notificationSound: boolean;
  notificationDesktop: boolean;
  sidebarOpen: boolean;
  taskPanelOpen: boolean;
  taskPanelConfig: TaskPanelConfig;
  taskPanelConfigMode: boolean;
  homeResetKey: number;
  publicUrl: string;
  activeTab: "chat" | "diff";
  chatTabReentryTickBySession: Map<string, number>;
  diffPanelSelectedFile: Map<string, string>;
  diffBase: DiffBase;

  setDarkMode: (v: boolean) => void;
  toggleDarkMode: () => void;
  setNotificationSound: (v: boolean) => void;
  toggleNotificationSound: () => void;
  setNotificationDesktop: (v: boolean) => void;
  toggleNotificationDesktop: () => void;
  setPublicUrl: (url: string) => void;
  setSidebarOpen: (v: boolean) => void;
  setTaskPanelOpen: (open: boolean) => void;
  setTaskPanelConfigMode: (open: boolean) => void;
  toggleSectionEnabled: (sectionId: string) => void;
  moveSectionUp: (sectionId: string) => void;
  moveSectionDown: (sectionId: string) => void;
  resetTaskPanelConfig: () => void;
  newSession: () => void;
  setActiveTab: (tab: "chat" | "diff") => void;
  markChatTabReentry: (sessionId: string) => void;
  setDiffPanelSelectedFile: (sessionId: string, filePath: string | null) => void;
  setDiffBase: (base: DiffBase) => void;
}

export const createUiSlice: StateCreator<AppState, [], [], UiSlice> = (set) => ({
  darkMode: getInitialDarkMode(),
  notificationSound: getInitialNotificationSound(),
  notificationDesktop: getInitialNotificationDesktop(),
  sidebarOpen: typeof window !== "undefined" ? window.innerWidth >= 768 : true,
  taskPanelOpen: typeof window !== "undefined" ? window.innerWidth >= 1024 : true,
  taskPanelConfig: getInitialTaskPanelConfig(),
  taskPanelConfigMode: false,
  homeResetKey: 0,
  publicUrl: "",
  activeTab: "chat",
  chatTabReentryTickBySession: new Map(),
  diffPanelSelectedFile: new Map(),
  diffBase: getInitialDiffBase(),

  setDarkMode: (v) => {
    localStorage.setItem("cc-dark-mode", String(v));
    set({ darkMode: v });
  },
  toggleDarkMode: () =>
    set((s) => {
      const next = !s.darkMode;
      localStorage.setItem("cc-dark-mode", String(next));
      return { darkMode: next };
    }),
  setNotificationSound: (v) => {
    localStorage.setItem("cc-notification-sound", String(v));
    set({ notificationSound: v });
  },
  toggleNotificationSound: () =>
    set((s) => {
      const next = !s.notificationSound;
      localStorage.setItem("cc-notification-sound", String(next));
      return { notificationSound: next };
    }),
  setNotificationDesktop: (v) => {
    localStorage.setItem("cc-notification-desktop", String(v));
    set({ notificationDesktop: v });
  },
  toggleNotificationDesktop: () =>
    set((s) => {
      const next = !s.notificationDesktop;
      localStorage.setItem("cc-notification-desktop", String(next));
      return { notificationDesktop: next };
    }),
  setPublicUrl: (url) => set({ publicUrl: url }),
  setSidebarOpen: (v) => set({ sidebarOpen: v }),
  setTaskPanelOpen: (open) => set({ taskPanelOpen: open }),
  setTaskPanelConfigMode: (open) => set({ taskPanelConfigMode: open }),
  toggleSectionEnabled: (sectionId) =>
    set((s) => {
      const config: TaskPanelConfig = {
        order: [...s.taskPanelConfig.order],
        enabled: { ...s.taskPanelConfig.enabled, [sectionId]: !s.taskPanelConfig.enabled[sectionId] },
      };
      persistTaskPanelConfig(config);
      return { taskPanelConfig: config };
    }),
  moveSectionUp: (sectionId) =>
    set((s) => {
      const order = [...s.taskPanelConfig.order];
      const idx = order.indexOf(sectionId);
      if (idx <= 0) return s;
      [order[idx - 1], order[idx]] = [order[idx], order[idx - 1]];
      const config: TaskPanelConfig = { ...s.taskPanelConfig, order };
      persistTaskPanelConfig(config);
      return { taskPanelConfig: config };
    }),
  moveSectionDown: (sectionId) =>
    set((s) => {
      const order = [...s.taskPanelConfig.order];
      const idx = order.indexOf(sectionId);
      if (idx < 0 || idx >= order.length - 1) return s;
      [order[idx], order[idx + 1]] = [order[idx + 1], order[idx]];
      const config: TaskPanelConfig = { ...s.taskPanelConfig, order };
      persistTaskPanelConfig(config);
      return { taskPanelConfig: config };
    }),
  resetTaskPanelConfig: () => {
    const config = getDefaultConfig();
    persistTaskPanelConfig(config);
    set({ taskPanelConfig: config });
  },
  newSession: () => {
    localStorage.removeItem("cc-current-session");
    // Cross-slice write: clears currentSessionId (owned by SessionsSlice)
    // alongside the homeResetKey bump to return the user to the home page.
    set((s) => ({ currentSessionId: null, homeResetKey: s.homeResetKey + 1 }));
  },
  setActiveTab: (tab) => set({ activeTab: tab }),
  markChatTabReentry: (sessionId) =>
    set((s) => {
      const chatTabReentryTickBySession = new Map(s.chatTabReentryTickBySession);
      const nextTick = (chatTabReentryTickBySession.get(sessionId) ?? 0) + 1;
      chatTabReentryTickBySession.set(sessionId, nextTick);
      return { chatTabReentryTickBySession };
    }),

  setDiffPanelSelectedFile: (sessionId, filePath) =>
    set((s) => {
      const diffPanelSelectedFile = new Map(s.diffPanelSelectedFile);
      if (filePath) {
        diffPanelSelectedFile.set(sessionId, filePath);
      } else {
        diffPanelSelectedFile.delete(sessionId);
      }
      return { diffPanelSelectedFile };
    }),

  setDiffBase: (base) => {
    if (typeof window !== "undefined") {
      localStorage.setItem("cc-diff-base", base);
    }
    set({ diffBase: base });
  },
});
