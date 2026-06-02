import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { api, type SavedPrompt } from "../api.js";

export interface MentionContext {
  query: string;
  start: number;
  end: number;
}

interface UseMentionMenuOptions {
  text: string;
  caretPos: number;
  cwd: string | undefined;
  enabled?: boolean;
}

export function useMentionMenu({ text, caretPos, cwd, enabled = true }: UseMentionMenuOptions) {
  const [mentionMenuOpen, setMentionMenuOpen] = useState(false);
  const [mentionMenuIndex, setMentionMenuIndex] = useState(0);
  const [savedPrompts, setSavedPrompts] = useState<SavedPrompt[]>([]);
  const [promptsLoading, setPromptsLoading] = useState(false);
  const mentionMenuRef = useRef<HTMLDivElement>(null);

  const refreshPrompts = useCallback(async () => {
    setPromptsLoading(true);
    try {
      const prompts = await api.listPrompts(cwd);
      setSavedPrompts(prompts.filter((p) => !!p.name.trim()));
    } catch {
      setSavedPrompts([]);
    } finally {
      setPromptsLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    void refreshPrompts();
  }, [refreshPrompts]);

  const mentionContext = useMemo<MentionContext | null>(() => {
    const prefix = text.slice(0, caretPos);
    const match = prefix.match(/(^|\s)@([^\s@]*)$/);
    if (!match || match.index === undefined) return null;
    const start = prefix.length - match[0].length + match[1].length;
    return {
      query: match[2] || "",
      start,
      end: caretPos,
    };
  }, [text, caretPos]);

  const filteredPrompts = useMemo(() => {
    if (!mentionMenuOpen || !mentionContext) return [];
    const query = mentionContext.query.toLowerCase();
    if (!query) return savedPrompts;
    const startsWith = savedPrompts.filter((p) => p.name.toLowerCase().startsWith(query));
    const includes = savedPrompts.filter(
      (p) => !p.name.toLowerCase().startsWith(query) && p.name.toLowerCase().includes(query),
    );
    return [...startsWith, ...includes];
  }, [mentionMenuOpen, mentionContext, savedPrompts]);

  // Open/close menu based on context
  useEffect(() => {
    const shouldOpen = enabled && !!mentionContext;
    if (shouldOpen && !mentionMenuOpen) {
      setMentionMenuOpen(true);
      setMentionMenuIndex(0);
    } else if (!shouldOpen && mentionMenuOpen) {
      setMentionMenuOpen(false);
    }
  }, [enabled, mentionContext, mentionMenuOpen]);

  // Keep selected index in bounds
  useEffect(() => {
    if (mentionMenuIndex >= filteredPrompts.length) {
      setMentionMenuIndex(Math.max(0, filteredPrompts.length - 1));
    }
  }, [filteredPrompts.length, mentionMenuIndex]);

  // Scroll selected item into view
  useEffect(() => {
    if (!mentionMenuRef.current || !mentionMenuOpen) return;
    const items = mentionMenuRef.current.querySelectorAll("[data-prompt-index]");
    const selected = items[mentionMenuIndex];
    if (selected) {
      selected.scrollIntoView({ block: "nearest" });
    }
  }, [mentionMenuIndex, mentionMenuOpen]);

  const selectPrompt = useCallback(
    (prompt: SavedPrompt): { nextText: string; nextCursor: number } => {
      if (!mentionContext) return { nextText: text, nextCursor: caretPos };
      const insertion = `${prompt.content} `;
      const nextText = `${text.slice(0, mentionContext.start)}${insertion}${text.slice(mentionContext.end)}`;
      const nextCursor = mentionContext.start + insertion.length;
      return { nextText, nextCursor };
    },
    [mentionContext, text, caretPos],
  );

  return {
    mentionMenuOpen,
    setMentionMenuOpen,
    mentionMenuIndex,
    setMentionMenuIndex,
    mentionContext,
    filteredPrompts,
    promptsLoading,
    savedPrompts,
    selectPrompt,
    refreshPrompts,
    mentionMenuRef,
  };
}
