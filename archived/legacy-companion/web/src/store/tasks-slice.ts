import type { StateCreator } from "zustand";
import type { AppState } from "./index.js";
import type { TaskItem, ProcessItem, BackgroundAgentItem } from "../types.js";

/** A single tool invocation tracked across its lifecycle. */
export interface ToolActivityEntry {
  toolUseId: string;
  toolName: string;
  preview: string;
  startedAt: number;
  completedAt?: number;
  elapsedSeconds: number;
  isError: boolean;
  parentToolUseId?: string;
}

export interface TasksSlice {
  sessionTasks: Map<string, TaskItem[]>;
  sessionProcesses: Map<string, ProcessItem[]>;
  sessionBackgroundAgents: Map<string, BackgroundAgentItem[]>;
  changedFilesTick: Map<string, number>;
  gitChangedFilesCount: Map<string, number>;
  toolProgress: Map<string, Map<string, { toolName: string; elapsedSeconds: number }>>;
  toolActivity: Map<string, ToolActivityEntry[]>;

  addTask: (sessionId: string, task: TaskItem) => void;
  setTasks: (sessionId: string, tasks: TaskItem[]) => void;
  updateTask: (sessionId: string, taskId: string, updates: Partial<TaskItem>) => void;
  addProcess: (sessionId: string, process: ProcessItem) => void;
  updateProcess: (sessionId: string, taskId: string, updates: Partial<ProcessItem>) => void;
  updateProcessByToolUseId: (sessionId: string, toolUseId: string, updates: Partial<ProcessItem>) => void;
  addBackgroundAgent: (sessionId: string, agent: BackgroundAgentItem) => void;
  updateBackgroundAgent: (sessionId: string, toolUseId: string, updates: Partial<BackgroundAgentItem>) => void;
  bumpChangedFilesTick: (sessionId: string) => void;
  setGitChangedFilesCount: (sessionId: string, count: number) => void;
  setToolProgress: (sessionId: string, toolUseId: string, data: { toolName: string; elapsedSeconds: number }) => void;
  clearToolProgress: (sessionId: string, toolUseId?: string) => void;
  setToolActivity: (sessionId: string, entries: ToolActivityEntry[]) => void;
  addToolActivity: (sessionId: string, entry: ToolActivityEntry) => void;
  updateToolActivity: (sessionId: string, toolUseId: string, updates: Partial<ToolActivityEntry>) => void;
}

export const createTasksSlice: StateCreator<AppState, [], [], TasksSlice> = (set) => ({
  sessionTasks: new Map(),
  sessionProcesses: new Map(),
  sessionBackgroundAgents: new Map(),
  changedFilesTick: new Map(),
  gitChangedFilesCount: new Map(),
  toolProgress: new Map(),
  toolActivity: new Map(),

  addTask: (sessionId, task) =>
    set((s) => {
      const sessionTasks = new Map(s.sessionTasks);
      const tasks = [...(sessionTasks.get(sessionId) || []), task];
      sessionTasks.set(sessionId, tasks);
      return { sessionTasks };
    }),

  setTasks: (sessionId, tasks) =>
    set((s) => {
      const sessionTasks = new Map(s.sessionTasks);
      sessionTasks.set(sessionId, tasks);
      return { sessionTasks };
    }),

  updateTask: (sessionId, taskId, updates) =>
    set((s) => {
      const sessionTasks = new Map(s.sessionTasks);
      const tasks = sessionTasks.get(sessionId);
      if (tasks) {
        sessionTasks.set(
          sessionId,
          tasks.map((t) => (t.id === taskId ? { ...t, ...updates } : t)),
        );
      }
      return { sessionTasks };
    }),

  addProcess: (sessionId, process) =>
    set((s) => {
      const sessionProcesses = new Map(s.sessionProcesses);
      const processes = [...(sessionProcesses.get(sessionId) || []), process];
      sessionProcesses.set(sessionId, processes);
      return { sessionProcesses };
    }),

  updateProcess: (sessionId, taskId, updates) =>
    set((s) => {
      const sessionProcesses = new Map(s.sessionProcesses);
      const processes = sessionProcesses.get(sessionId);
      if (processes) {
        sessionProcesses.set(
          sessionId,
          processes.map((p) => (p.taskId === taskId ? { ...p, ...updates } : p)),
        );
      }
      return { sessionProcesses };
    }),

  updateProcessByToolUseId: (sessionId, toolUseId, updates) =>
    set((s) => {
      const sessionProcesses = new Map(s.sessionProcesses);
      const processes = sessionProcesses.get(sessionId);
      if (processes) {
        sessionProcesses.set(
          sessionId,
          processes.map((p) => (p.toolUseId === toolUseId ? { ...p, ...updates } : p)),
        );
      }
      return { sessionProcesses };
    }),

  addBackgroundAgent: (sessionId, agent) =>
    set((s) => {
      const sessionBackgroundAgents = new Map(s.sessionBackgroundAgents);
      const agents = [...(sessionBackgroundAgents.get(sessionId) || []), agent];
      sessionBackgroundAgents.set(sessionId, agents);
      return { sessionBackgroundAgents };
    }),

  updateBackgroundAgent: (sessionId, toolUseId, updates) =>
    set((s) => {
      const sessionBackgroundAgents = new Map(s.sessionBackgroundAgents);
      const agents = sessionBackgroundAgents.get(sessionId);
      if (agents) {
        sessionBackgroundAgents.set(
          sessionId,
          agents.map((a) => (a.toolUseId === toolUseId ? { ...a, ...updates } : a)),
        );
      }
      return { sessionBackgroundAgents };
    }),

  bumpChangedFilesTick: (sessionId) =>
    set((s) => {
      const changedFilesTick = new Map(s.changedFilesTick);
      changedFilesTick.set(sessionId, (changedFilesTick.get(sessionId) ?? 0) + 1);
      return { changedFilesTick };
    }),

  setGitChangedFilesCount: (sessionId, count) =>
    set((s) => {
      const gitChangedFilesCount = new Map(s.gitChangedFilesCount);
      gitChangedFilesCount.set(sessionId, count);
      return { gitChangedFilesCount };
    }),

  setToolProgress: (sessionId, toolUseId, data) =>
    set((s) => {
      const toolProgress = new Map(s.toolProgress);
      const sessionProgress = new Map(toolProgress.get(sessionId) || []);
      sessionProgress.set(toolUseId, data);
      toolProgress.set(sessionId, sessionProgress);
      return { toolProgress };
    }),

  clearToolProgress: (sessionId, toolUseId) =>
    set((s) => {
      const toolProgress = new Map(s.toolProgress);
      if (toolUseId) {
        const sessionProgress = toolProgress.get(sessionId);
        if (sessionProgress) {
          const updated = new Map(sessionProgress);
          updated.delete(toolUseId);
          toolProgress.set(sessionId, updated);
        }
      } else {
        toolProgress.delete(sessionId);
      }
      return { toolProgress };
    }),

  setToolActivity: (sessionId, entries) =>
    set((s) => {
      const toolActivity = new Map(s.toolActivity);
      if (entries.length === 0) {
        toolActivity.delete(sessionId);
      } else {
        toolActivity.set(sessionId, entries);
      }
      return { toolActivity };
    }),

  addToolActivity: (sessionId, entry) =>
    set((s) => {
      const toolActivity = new Map(s.toolActivity);
      const entries = [...(toolActivity.get(sessionId) || [])];
      const existingIndex = entries.findIndex((e) => e.toolUseId === entry.toolUseId);
      if (existingIndex >= 0) {
        const existing = entries[existingIndex];
        entries[existingIndex] = {
          ...existing,
          ...entry,
          startedAt: existing.startedAt,
          completedAt: entry.completedAt ?? existing.completedAt,
          elapsedSeconds: Math.max(existing.elapsedSeconds, entry.elapsedSeconds),
          isError: existing.isError || entry.isError,
        };
      } else {
        entries.push(entry);
      }
      toolActivity.set(sessionId, entries);
      return { toolActivity };
    }),

  updateToolActivity: (sessionId, toolUseId, updates) =>
    set((s) => {
      const toolActivity = new Map(s.toolActivity);
      const entries = toolActivity.get(sessionId);
      if (entries) {
        toolActivity.set(
          sessionId,
          entries.map((e) => (e.toolUseId === toolUseId ? { ...e, ...updates } : e)),
        );
      }
      return { toolActivity };
    }),
});
