import type { StateCreator } from "zustand";
import type { AppState } from "./index.js";
import type { ChatMessage } from "../types.js";

export interface ChatSlice {
  messages: Map<string, ChatMessage[]>;
  streaming: Map<string, string>;
  streamingStartedAt: Map<string, number>;
  streamingOutputTokens: Map<string, number>;

  appendMessage: (sessionId: string, msg: ChatMessage) => void;
  setMessages: (sessionId: string, msgs: ChatMessage[]) => void;
  updateLastAssistantMessage: (sessionId: string, updater: (msg: ChatMessage) => ChatMessage) => void;
  setStreaming: (sessionId: string, text: string | null) => void;
  setStreamingStats: (sessionId: string, stats: { startedAt?: number; outputTokens?: number } | null) => void;

  promptSuggestions: Map<string, string[]>;
  setPromptSuggestions: (sessionId: string, suggestions: string[]) => void;
  clearPromptSuggestions: (sessionId: string) => void;
}

export const createChatSlice: StateCreator<AppState, [], [], ChatSlice> = (set) => ({
  messages: new Map(),
  streaming: new Map(),
  streamingStartedAt: new Map(),
  streamingOutputTokens: new Map(),

  appendMessage: (sessionId, msg) =>
    set((s) => {
      const existing = s.messages.get(sessionId) || [];
      // Deduplicate: skip if a message with same ID already exists
      if (msg.id && existing.some((m) => m.id === msg.id)) {
        return s;
      }
      const messages = new Map(s.messages);
      messages.set(sessionId, [...existing, msg]);
      return { messages };
    }),

  setMessages: (sessionId, msgs) =>
    set((s) => {
      const messages = new Map(s.messages);
      messages.set(sessionId, msgs);
      return { messages };
    }),

  updateLastAssistantMessage: (sessionId, updater) =>
    set((s) => {
      const messages = new Map(s.messages);
      const list = [...(messages.get(sessionId) || [])];
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].role === "assistant") {
          list[i] = updater(list[i]);
          break;
        }
      }
      messages.set(sessionId, list);
      return { messages };
    }),

  setStreaming: (sessionId, text) =>
    set((s) => {
      const streaming = new Map(s.streaming);
      if (text === null) {
        streaming.delete(sessionId);
      } else {
        streaming.set(sessionId, text);
      }
      return { streaming };
    }),

  setStreamingStats: (sessionId, stats) =>
    set((s) => {
      const streamingStartedAt = new Map(s.streamingStartedAt);
      const streamingOutputTokens = new Map(s.streamingOutputTokens);
      if (stats === null) {
        streamingStartedAt.delete(sessionId);
        streamingOutputTokens.delete(sessionId);
      } else {
        if (stats.startedAt !== undefined) streamingStartedAt.set(sessionId, stats.startedAt);
        if (stats.outputTokens !== undefined) streamingOutputTokens.set(sessionId, stats.outputTokens);
      }
      return { streamingStartedAt, streamingOutputTokens };
    }),

  promptSuggestions: new Map(),

  setPromptSuggestions: (sessionId, suggestions) =>
    set((s) => {
      const promptSuggestions = new Map(s.promptSuggestions);
      promptSuggestions.set(sessionId, suggestions);
      return { promptSuggestions };
    }),

  clearPromptSuggestions: (sessionId) =>
    set((s) => {
      const promptSuggestions = new Map(s.promptSuggestions);
      promptSuggestions.delete(sessionId);
      return { promptSuggestions };
    }),
});
