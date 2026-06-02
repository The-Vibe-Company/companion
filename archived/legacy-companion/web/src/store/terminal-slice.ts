import type { StateCreator } from "zustand";
import type { AppState } from "./index.js";

export interface QuickTerminalTab {
  id: string;
  label: string;
  cwd: string;
  containerId?: string;
}

export type QuickTerminalPlacement = "top" | "right" | "bottom" | "left";

export function getInitialQuickTerminalPlacement(): QuickTerminalPlacement {
  if (typeof window === "undefined") return "bottom";
  const stored = window.localStorage.getItem("cc-terminal-placement");
  if (stored === "top" || stored === "right" || stored === "bottom" || stored === "left") return stored;
  return "bottom";
}

export interface TerminalSlice {
  quickTerminalOpen: boolean;
  quickTerminalTabs: QuickTerminalTab[];
  activeQuickTerminalTabId: string | null;
  quickTerminalPlacement: QuickTerminalPlacement;
  quickTerminalNextHostIndex: number;
  quickTerminalNextDockerIndex: number;
  terminalOpen: boolean;
  terminalCwd: string | null;
  terminalId: string | null;

  setQuickTerminalOpen: (open: boolean) => void;
  openQuickTerminal: (opts: { target: "host" | "docker"; cwd: string; containerId?: string; reuseIfExists?: boolean }) => void;
  closeQuickTerminalTab: (tabId: string) => void;
  setActiveQuickTerminalTabId: (tabId: string | null) => void;
  resetQuickTerminal: () => void;
  setTerminalOpen: (open: boolean) => void;
  setTerminalCwd: (cwd: string | null) => void;
  setTerminalId: (id: string | null) => void;
  openTerminal: (cwd: string) => void;
  closeTerminal: () => void;
}

export const createTerminalSlice: StateCreator<AppState, [], [], TerminalSlice> = (set) => ({
  quickTerminalOpen: false,
  quickTerminalTabs: [],
  activeQuickTerminalTabId: null,
  quickTerminalPlacement: getInitialQuickTerminalPlacement(),
  quickTerminalNextHostIndex: 1,
  quickTerminalNextDockerIndex: 1,
  terminalOpen: false,
  terminalCwd: null,
  terminalId: null,

  setQuickTerminalOpen: (open) => set({ quickTerminalOpen: open }),
  openQuickTerminal: (opts) =>
    set((s) => {
      if (opts.reuseIfExists) {
        const existing = s.quickTerminalTabs.find((t) =>
          t.cwd === opts.cwd
          && t.containerId === opts.containerId,
        );
        if (existing) {
          return {
            quickTerminalOpen: true,
            activeQuickTerminalTabId: existing.id,
          };
        }
      }

      const isDocker = opts.target === "docker";
      const hostIndex = s.quickTerminalNextHostIndex;
      const dockerIndex = s.quickTerminalNextDockerIndex;
      const nextHostIndex = isDocker ? hostIndex : hostIndex + 1;
      const nextDockerIndex = isDocker ? dockerIndex + 1 : dockerIndex;
      const nextTab: QuickTerminalTab = {
        id: `${opts.target}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        label: isDocker
          ? `Docker ${dockerIndex}`
          : (hostIndex === 1 ? "Terminal" : `Terminal ${hostIndex}`),
        cwd: opts.cwd,
        containerId: opts.containerId,
      };
      return {
        quickTerminalOpen: true,
        quickTerminalTabs: [...s.quickTerminalTabs, nextTab],
        activeQuickTerminalTabId: nextTab.id,
        quickTerminalNextHostIndex: nextHostIndex,
        quickTerminalNextDockerIndex: nextDockerIndex,
      };
    }),
  closeQuickTerminalTab: (tabId) =>
    set((s) => {
      const nextTabs = s.quickTerminalTabs.filter((t) => t.id !== tabId);
      const nextActive = s.activeQuickTerminalTabId === tabId ? (nextTabs[0]?.id || null) : s.activeQuickTerminalTabId;
      return {
        quickTerminalTabs: nextTabs,
        activeQuickTerminalTabId: nextActive,
        quickTerminalOpen: nextTabs.length > 0 ? s.quickTerminalOpen : false,
      };
    }),
  setActiveQuickTerminalTabId: (tabId) => set({ activeQuickTerminalTabId: tabId }),
  resetQuickTerminal: () =>
    set({
      quickTerminalOpen: false,
      quickTerminalTabs: [],
      activeQuickTerminalTabId: null,
      quickTerminalNextHostIndex: 1,
      quickTerminalNextDockerIndex: 1,
    }),

  setTerminalOpen: (open) => set({ terminalOpen: open }),
  setTerminalCwd: (cwd) => set({ terminalCwd: cwd }),
  setTerminalId: (id) => set({ terminalId: id }),
  openTerminal: (cwd) => set({ terminalOpen: true, terminalCwd: cwd }),
  closeTerminal: () => set({ terminalOpen: false, terminalCwd: null, terminalId: null }),
});
