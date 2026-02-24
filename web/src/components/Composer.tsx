import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useStore } from "../store.js";
import { sendToSession } from "../ws.js";
import { CLAUDE_MODES, CODEX_MODES } from "../utils/backends.js";
import { api, type SavedPrompt } from "../api.js";
import type { ModeOption } from "../utils/backends.js";

import { readFileAsBase64, type ImageAttachment } from "../utils/image.js";
import { useSTT } from "../hooks/useSTT.js";

let idCounter = 0;

interface CommandItem {
  name: string;
  type: "command" | "skill";
}

interface MentionContext {
  query: string;
  start: number;
  end: number;
}

export function Composer({ sessionId }: { sessionId: string }) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashMenuIndex, setSlashMenuIndex] = useState(0);
  const [mentionMenuOpen, setMentionMenuOpen] = useState(false);
  const [mentionMenuIndex, setMentionMenuIndex] = useState(0);
  const [savePromptOpen, setSavePromptOpen] = useState(false);
  const [savePromptName, setSavePromptName] = useState("");
  const [savePromptError, setSavePromptError] = useState<string | null>(null);
  const [savedPrompts, setSavedPrompts] = useState<SavedPrompt[]>([]);
  const [promptsLoading, setPromptsLoading] = useState(false);
  const [caretPos, setCaretPos] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const mentionMenuRef = useRef<HTMLDivElement>(null);
  const pendingSelectionRef = useRef<number | null>(null);
  const cliConnected = useStore((s) => s.cliConnected);
  const sessionData = useStore((s) => s.sessions.get(sessionId));
  const previousMode = useStore((s) => s.previousPermissionMode.get(sessionId) || "acceptEdits");

  const isConnected = cliConnected.get(sessionId) ?? false;
  const currentMode = sessionData?.permissionMode || "acceptEdits";
  const isPlan = currentMode === "plan";
  const isCodex = sessionData?.backend_type === "codex";
  const modes: ModeOption[] = isCodex ? CODEX_MODES : CLAUDE_MODES;
  const modeLabel = modes.find((m) => m.value === currentMode)?.label?.toLowerCase() || currentMode;

  const refreshPrompts = useCallback(async () => {
    setPromptsLoading(true);
    try {
      const prompts = await api.listPrompts(sessionData?.cwd, "global");
      setSavedPrompts(prompts.filter((p) => !!p.name.trim()));
    } catch {
      setSavedPrompts([]);
    } finally {
      setPromptsLoading(false);
    }
  }, [sessionData?.cwd]);

  useEffect(() => {
    void refreshPrompts();
  }, [refreshPrompts]);

  // Build command list from session data
  const allCommands = useMemo<CommandItem[]>(() => {
    const cmds: CommandItem[] = [];
    if (sessionData?.slash_commands) {
      for (const cmd of sessionData.slash_commands) {
        cmds.push({ name: cmd, type: "command" });
      }
    }
    if (sessionData?.skills) {
      for (const skill of sessionData.skills) {
        cmds.push({ name: skill, type: "skill" });
      }
    }
    return cmds;
  }, [sessionData?.slash_commands, sessionData?.skills]);

  // Filter commands based on what the user typed after /
  const filteredCommands = useMemo(() => {
    if (!slashMenuOpen) return [];
    // Extract the slash query: text starts with / and we match the part after /
    const match = text.match(/^\/(\S*)$/);
    if (!match) return [];
    const query = match[1].toLowerCase();
    if (query === "") return allCommands;
    return allCommands.filter((cmd) => cmd.name.toLowerCase().includes(query));
  }, [text, slashMenuOpen, allCommands]);

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

  // Open/close menu based on text
  useEffect(() => {
    const shouldOpen = text.startsWith("/") && /^\/\S*$/.test(text) && allCommands.length > 0;
    if (shouldOpen && !slashMenuOpen) {
      setSlashMenuOpen(true);
      setSlashMenuIndex(0);
    } else if (!shouldOpen && slashMenuOpen) {
      setSlashMenuOpen(false);
    }
  }, [text, allCommands.length, slashMenuOpen]);

  useEffect(() => {
    const shouldOpen = !slashMenuOpen && !!mentionContext;
    if (shouldOpen && !mentionMenuOpen) {
      setMentionMenuOpen(true);
      setMentionMenuIndex(0);
    } else if (!shouldOpen && mentionMenuOpen) {
      setMentionMenuOpen(false);
    }
  }, [slashMenuOpen, mentionContext, mentionMenuOpen]);

  // Keep selected index in bounds
  useEffect(() => {
    if (slashMenuIndex >= filteredCommands.length) {
      setSlashMenuIndex(Math.max(0, filteredCommands.length - 1));
    }
  }, [filteredCommands.length, slashMenuIndex]);

  useEffect(() => {
    if (mentionMenuIndex >= filteredPrompts.length) {
      setMentionMenuIndex(Math.max(0, filteredPrompts.length - 1));
    }
  }, [filteredPrompts.length, mentionMenuIndex]);

  // Scroll selected item into view
  useEffect(() => {
    if (!menuRef.current || !slashMenuOpen) return;
    const items = menuRef.current.querySelectorAll("[data-cmd-index]");
    const selected = items[slashMenuIndex];
    if (selected) {
      selected.scrollIntoView({ block: "nearest" });
    }
  }, [slashMenuIndex, slashMenuOpen]);

  useEffect(() => {
    if (!mentionMenuRef.current || !mentionMenuOpen) return;
    const items = mentionMenuRef.current.querySelectorAll("[data-prompt-index]");
    const selected = items[mentionMenuIndex];
    if (selected) {
      selected.scrollIntoView({ block: "nearest" });
    }
  }, [mentionMenuIndex, mentionMenuOpen]);

  useEffect(() => {
    if (pendingSelectionRef.current === null || !textareaRef.current) return;
    const next = pendingSelectionRef.current;
    textareaRef.current.setSelectionRange(next, next);
    pendingSelectionRef.current = null;
  }, [text]);

  const selectCommand = useCallback((cmd: CommandItem) => {
    setText(`/${cmd.name} `);
    setSlashMenuOpen(false);
    textareaRef.current?.focus();
  }, []);

  const selectPrompt = useCallback((prompt: SavedPrompt) => {
    if (!mentionContext) return;
    const insertion = `${prompt.content} `;
    const nextText = `${text.slice(0, mentionContext.start)}${insertion}${text.slice(mentionContext.end)}`;
    const nextCursor = mentionContext.start + insertion.length;
    pendingSelectionRef.current = nextCursor;
    setText(nextText);
    setMentionMenuOpen(false);
    setCaretPos(nextCursor);
    textareaRef.current?.focus();
  }, [mentionContext, text]);

  function handleSend() {
    const msg = text.trim();
    if (!msg || !isConnected) return;

    sendToSession(sessionId, {
      type: "user_message",
      content: msg,
      session_id: sessionId,
      images: images.length > 0 ? images.map((img) => ({ media_type: img.mediaType, data: img.base64 })) : undefined,
    });

    useStore.getState().appendMessage(sessionId, {
      id: `user-${Date.now()}-${++idCounter}`,
      role: "user",
      content: msg,
      images: images.length > 0 ? images.map((img) => ({ media_type: img.mediaType, data: img.base64 })) : undefined,
      timestamp: Date.now(),
    });

    setText("");
    setImages([]);
    setSlashMenuOpen(false);
    setMentionMenuOpen(false);

    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
    textareaRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    // Slash menu navigation
    if (slashMenuOpen && filteredCommands.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashMenuIndex((i) => (i + 1) % filteredCommands.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashMenuIndex((i) => (i - 1 + filteredCommands.length) % filteredCommands.length);
        return;
      }
      if (e.key === "Tab" && !e.shiftKey) {
        e.preventDefault();
        selectCommand(filteredCommands[slashMenuIndex]);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        selectCommand(filteredCommands[slashMenuIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashMenuOpen(false);
        return;
      }
    }

    if (mentionMenuOpen) {
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionMenuOpen(false);
        return;
      }
    }

    if (mentionMenuOpen && filteredPrompts.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionMenuIndex((i) => (i + 1) % filteredPrompts.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionMenuIndex((i) => (i - 1 + filteredPrompts.length) % filteredPrompts.length);
        return;
      }
      if ((e.key === "Tab" && !e.shiftKey) || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        selectPrompt(filteredPrompts[mentionMenuIndex]);
        return;
      }
    }

    if (
      mentionMenuOpen
      && filteredPrompts.length === 0
      && ((e.key === "Enter" && !e.shiftKey) || (e.key === "Tab" && !e.shiftKey))
    ) {
      e.preventDefault();
      return;
    }

    if (e.key === "Tab" && e.shiftKey) {
      e.preventDefault();
      toggleMode();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setText(e.target.value);
    setCaretPos(e.target.selectionStart ?? e.target.value.length);
    const ta = e.target;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  }

  function syncCaret() {
    if (!textareaRef.current) return;
    setCaretPos(textareaRef.current.selectionStart ?? 0);
  }

  function handleInterrupt() {
    sendToSession(sessionId, { type: "interrupt" });
  }

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files) return;
    const newImages: ImageAttachment[] = [];
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) continue;
      const { base64, mediaType } = await readFileAsBase64(file);
      newImages.push({ name: file.name, base64, mediaType });
    }
    setImages((prev) => [...prev, ...newImages]);
    e.target.value = "";
  }

  function removeImage(index: number) {
    setImages((prev) => prev.filter((_, i) => i !== index));
  }

  async function handlePaste(e: React.ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const newImages: ImageAttachment[] = [];
    for (const item of Array.from(items)) {
      if (!item.type.startsWith("image/")) continue;
      const file = item.getAsFile();
      if (!file) continue;
      const { base64, mediaType } = await readFileAsBase64(file);
      newImages.push({ name: `pasted-${Date.now()}.${file.type.split("/")[1]}`, base64, mediaType });
    }
    if (newImages.length > 0) {
      e.preventDefault();
      setImages((prev) => [...prev, ...newImages]);
    }
  }

  function toggleMode() {
    if (!isConnected) return;
    const store = useStore.getState();
    if (!isPlan) {
      store.setPreviousPermissionMode(sessionId, currentMode);
      sendToSession(sessionId, { type: "set_permission_mode", mode: "plan" });
      store.updateSession(sessionId, { permissionMode: "plan" });
    } else {
      const restoreMode = previousMode || (isCodex ? "bypassPermissions" : "acceptEdits");
      sendToSession(sessionId, { type: "set_permission_mode", mode: restoreMode });
      store.updateSession(sessionId, { permissionMode: restoreMode });
    }
  }

  async function handleCreatePrompt() {
    const content = text.trim();
    const name = savePromptName.trim();
    if (!content || !name) return;
    const payload: { name: string; content: string; scope: "global" | "project"; cwd?: string } = {
      name,
      content,
      scope: "global",
    };
    try {
      await api.createPrompt(payload);
      await refreshPrompts();
      setSavePromptOpen(false);
      setSavePromptName("");
      setSavePromptError(null);
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : "Could not save prompt.";
      setSavePromptError(message);
    }
  }

  const sessionStatus = useStore((s) => s.sessionStatus);
  const isRunning = sessionStatus.get(sessionId) === "running";
  const canSend = text.trim().length > 0 && isConnected;

  const stt = useSTT();

  // Append transcribed text to the input when a new transcript arrives
  useEffect(() => {
    if (!stt.transcript) return;
    setText((prev) => (prev ? `${prev} ${stt.transcript}` : stt.transcript));
    // Resize textarea to fit new content
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
        textareaRef.current.style.height =
          Math.min(textareaRef.current.scrollHeight, 200) + "px";
        const end = textareaRef.current.value.length;
        textareaRef.current.setSelectionRange(end, end);
        textareaRef.current.focus();
      }
    });
  }, [stt.transcript]);

  return (
    <div className="shrink-0 px-0 sm:px-6 pt-0 sm:pt-3 pb-safe bg-cc-input-bg sm:bg-transparent">
      <div className="max-w-3xl mx-auto">
        {/* Image thumbnails */}
        {images.length > 0 && (
          <div className="flex items-center gap-2 mb-2 px-3 sm:px-0 flex-wrap">
            {images.map((img, i) => (
              <div key={i} className="relative group">
                <img
                  src={`data:${img.mediaType};base64,${img.base64}`}
                  alt={img.name}
                  className="w-12 h-12 rounded-lg object-cover border border-cc-border"
                />
                <button
                  onClick={() => removeImage(i)}
                  aria-label="Remove image"
                  className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-cc-error text-white flex items-center justify-center text-[10px] opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                >
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-2.5 h-2.5">
                    <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          onChange={handleFileSelect}
          className="hidden"
          aria-label="Attach images"
        />

        {/* Input container: flat separator on mobile, card on desktop */}
        <div className={`relative overflow-visible transition-colors border-t border-cc-separator sm:border sm:border-cc-border sm:bg-cc-input-bg/95 sm:rounded-[14px] sm:shadow-[0_10px_30px_rgba(0,0,0,0.10)] sm:backdrop-blur-sm ${
          isPlan
            ? "sm:border-cc-primary/40"
            : "sm:focus-within:border-cc-primary/30"
        }`}>
          {/* Slash command menu */}
          {slashMenuOpen && filteredCommands.length > 0 && (
            <div
              ref={menuRef}
              className="absolute left-2 right-2 bottom-full mb-1 max-h-[240px] overflow-y-auto bg-cc-card border border-cc-border rounded-[10px] shadow-lg z-20 py-1"
            >
              {filteredCommands.map((cmd, i) => (
                <button
                  key={`${cmd.type}-${cmd.name}`}
                  data-cmd-index={i}
                  onClick={() => selectCommand(cmd)}
                  className={`w-full px-3 py-2 text-left flex items-center gap-2.5 transition-colors cursor-pointer ${
                    i === slashMenuIndex
                      ? "bg-cc-hover"
                      : "hover:bg-cc-hover/50"
                  }`}
                >
                  <span className="flex items-center justify-center w-6 h-6 rounded-md bg-cc-hover text-cc-muted shrink-0">
                    {cmd.type === "skill" ? (
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                        <path d="M8 1l1.796 3.64L14 5.255l-3 2.924.708 4.126L8 10.5l-3.708 1.805L5 8.18 2 5.255l4.204-.615L8 1z" />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
                        <path d="M5 12L10 4" strokeLinecap="round" />
                      </svg>
                    )}
                  </span>
                  <div className="flex-1 min-w-0">
                    <span className="text-[13px] font-medium text-cc-fg">/{cmd.name}</span>
                    <span className="ml-2 text-[11px] text-cc-muted">{cmd.type}</span>
                  </div>
                </button>
              ))}
            </div>
          )}

          {/* @ prompt menu */}
          {mentionMenuOpen && (
            <div
              ref={mentionMenuRef}
              className="absolute left-2 right-2 bottom-full mb-1 max-h-[240px] overflow-y-auto bg-cc-card border border-cc-border rounded-[10px] shadow-lg z-20 py-1"
            >
              {promptsLoading ? (
                <div className="px-3 py-2 text-[12px] text-cc-muted">
                  Searching prompts...
                </div>
              ) : filteredPrompts.length > 0 ? (
                filteredPrompts.map((prompt, i) => (
                  <button
                    key={prompt.id}
                    data-prompt-index={i}
                    onClick={() => selectPrompt(prompt)}
                    className={`w-full px-3 py-2 text-left flex items-center gap-2.5 transition-colors cursor-pointer ${
                      i === mentionMenuIndex
                        ? "bg-cc-hover"
                        : "hover:bg-cc-hover/50"
                    }`}
                  >
                    <span className="flex items-center justify-center w-6 h-6 rounded-md bg-cc-hover text-cc-muted shrink-0">
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
                        <path d="M2.5 8a5.5 5.5 0 1111 0v3a2.5 2.5 0 01-2.5 2.5h-1" strokeLinecap="round" />
                        <circle cx="8" cy="8" r="1.75" fill="currentColor" stroke="none" />
                      </svg>
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] font-medium text-cc-fg truncate">@{prompt.name}</div>
                      <div className="text-[11px] text-cc-muted truncate">{prompt.content}</div>
                    </div>
                    <span className="text-[10px] text-cc-muted shrink-0">{prompt.scope}</span>
                  </button>
                ))
              ) : (
                <div className="px-3 py-2 text-[12px] text-cc-muted">
                  No prompts found.
                </div>
              )}
            </div>
          )}

          {savePromptOpen && (
            <div className="absolute left-2 right-2 bottom-full mb-1 bg-cc-card border border-cc-border rounded-[10px] shadow-lg z-20 p-3 space-y-2">
              <div className="text-xs font-semibold text-cc-fg">Save prompt</div>
              <input
                value={savePromptName}
                onChange={(e) => {
                  setSavePromptName(e.target.value);
                  if (savePromptError) setSavePromptError(null);
                }}
                placeholder="Prompt title"
                aria-label="Prompt title"
                className="w-full px-2 py-1.5 text-sm bg-cc-input-bg border border-cc-border rounded-md text-cc-fg focus:outline-none focus:border-cc-primary/40"
              />
              <div className="text-[11px] text-cc-muted">Scope: global • stored locally</div>
              {savePromptError ? (
                <div className="text-[11px] text-cc-error">{savePromptError}</div>
              ) : null}
              <div className="flex items-center gap-1.5 justify-end">
                <button
                  onClick={() => {
                    setSavePromptOpen(false);
                    setSavePromptError(null);
                  }}
                  className="px-2 py-1 text-[11px] rounded-md border border-cc-border text-cc-muted hover:text-cc-fg cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCreatePrompt}
                  disabled={!savePromptName.trim() || !text.trim()}
                  className={`px-2 py-1 text-[11px] rounded-md border ${
                    savePromptName.trim() && text.trim()
                      ? "border-cc-primary/40 text-cc-primary bg-cc-primary/8 cursor-pointer"
                      : "border-cc-border text-cc-muted cursor-not-allowed"
                  }`}
                >
                  Save
                </button>
              </div>
            </div>
          )}

          {/* Mobile toolbar: mode toggle + secondary actions (hidden on sm+) */}
          <div className="flex items-center gap-1.5 px-3 pt-1.5 pb-0.5 sm:hidden">
            <button
              onClick={toggleMode}
              disabled={!isConnected}
              className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] font-semibold transition-all border select-none shrink-0 ${
                !isConnected
                  ? "opacity-30 cursor-not-allowed text-cc-muted border-transparent"
                  : isPlan
                    ? "text-cc-primary border-cc-primary/30 bg-cc-primary/8"
                    : "text-cc-muted border-cc-border"
              }`}
              title="Toggle mode (Shift+Tab)"
            >
              {isPlan ? (
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                  <rect x="3" y="3" width="3.5" height="10" rx="0.75" />
                  <rect x="9.5" y="3" width="3.5" height="10" rx="0.75" />
                </svg>
              ) : (
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                  <path d="M2.5 4l4 4-4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                  <path d="M8.5 4l4 4-4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                </svg>
              )}
              <span>{modeLabel}</span>
            </button>

            <div className="flex-1" />

            <button
              onClick={() => {
                const defaultName = text.trim().slice(0, 32);
                setSavePromptName(defaultName || "");
                setSavePromptError(null);
                setSavePromptOpen((v) => !v);
              }}
              disabled={!isConnected || !text.trim()}
              className={`flex items-center justify-center w-8 h-8 rounded-md transition-colors ${
                isConnected && text.trim()
                  ? "text-cc-muted hover:text-cc-fg hover:bg-cc-hover cursor-pointer"
                  : "text-cc-muted opacity-30 cursor-not-allowed"
              }`}
              title="Save as prompt"
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4">
                <path d="M4 2.75h8A1.25 1.25 0 0113.25 4v9.25L8 10.5l-5.25 2.75V4A1.25 1.25 0 014 2.75z" />
              </svg>
            </button>

            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={!isConnected}
              className={`flex items-center justify-center w-8 h-8 rounded-md transition-colors ${
                isConnected
                  ? "text-cc-muted hover:text-cc-fg hover:bg-cc-hover cursor-pointer"
                  : "text-cc-muted opacity-30 cursor-not-allowed"
              }`}
              title="Upload image"
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4">
                <rect x="2" y="2" width="12" height="12" rx="2" />
                <circle cx="5.5" cy="5.5" r="1" fill="currentColor" stroke="none" />
                <path d="M2 11l3-3 2 2 3-4 4 5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>

          {/* Main input row */}
          <div className="flex items-end gap-2 px-3 sm:px-2.5 py-1 sm:py-2">
            {/* Desktop mode toggle (hidden on mobile) */}
            <button
              onClick={toggleMode}
              disabled={!isConnected}
              className={`mb-0.5 hidden sm:flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[12px] font-semibold transition-all border select-none shrink-0 ${
                !isConnected
                  ? "opacity-30 cursor-not-allowed text-cc-muted border-transparent"
                  : isPlan
                    ? "text-cc-primary border-cc-primary/30 bg-cc-primary/8 hover:bg-cc-primary/12 cursor-pointer"
                    : "text-cc-muted border-cc-border hover:text-cc-fg hover:bg-cc-hover cursor-pointer"
              }`}
              title="Toggle mode (Shift+Tab)"
            >
              {isPlan ? (
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                  <rect x="3" y="3" width="3.5" height="10" rx="0.75" />
                  <rect x="9.5" y="3" width="3.5" height="10" rx="0.75" />
                </svg>
              ) : (
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                  <path d="M2.5 4l4 4-4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                  <path d="M8.5 4l4 4-4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                </svg>
              )}
              <span>{modeLabel}</span>
            </button>

            <textarea
              ref={textareaRef}
              value={text}
              onChange={handleInput}
              onKeyDown={handleKeyDown}
              onClick={syncCaret}
              onKeyUp={syncCaret}
              onPaste={handlePaste}
              aria-label="Message input"
              placeholder={isConnected
                ? "Type a message... (/ + @)"
                : "Waiting for CLI connection..."}
              disabled={!isConnected}
              rows={1}
              className="flex-1 min-w-0 px-2 py-2 text-base sm:text-sm bg-transparent resize-none outline-none text-cc-fg font-sans-ui placeholder:text-cc-muted disabled:opacity-50 overflow-y-auto"
              style={{ minHeight: "42px", maxHeight: "200px" }}
            />

              {/* Right: image + mic + send/stop */}
            <div className="mb-0.5 flex items-center gap-1.5 shrink-0">
              {/* Bookmark + image: desktop only */}
              <button
                onClick={() => {
                  const defaultName = text.trim().slice(0, 32);
                  setSavePromptName(defaultName || "");
                  setSavePromptError(null);
                  setSavePromptOpen((v) => !v);
                }}
                disabled={!isConnected || !text.trim()}
                className={`hidden sm:flex items-center justify-center w-9 h-9 rounded-lg border transition-colors ${
                  isConnected && text.trim()
                    ? "text-cc-muted border-cc-border hover:text-cc-fg hover:bg-cc-hover cursor-pointer"
                    : "text-cc-muted opacity-30 border-cc-border/60 cursor-not-allowed"
                }`}
                title="Save as prompt"
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4">
                  <path d="M4 2.75h8A1.25 1.25 0 0113.25 4v9.25L8 10.5l-5.25 2.75V4A1.25 1.25 0 014 2.75z" />
                </svg>
              </button>

              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={!isConnected}
                className={`hidden sm:flex items-center justify-center w-9 h-9 rounded-lg border transition-colors ${
                  isConnected
                    ? "text-cc-muted border-cc-border hover:text-cc-fg hover:bg-cc-hover cursor-pointer"
                    : "text-cc-muted opacity-30 border-cc-border/60 cursor-not-allowed"
                }`}
                title="Upload image"
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4">
                  <rect x="2" y="2" width="12" height="12" rx="2" />
                  <circle cx="5.5" cy="5.5" r="1" fill="currentColor" stroke="none" />
                  <path d="M2 11l3-3 2 2 3-4 4 5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>

              {/* Mic / STT button */}
              <button
                onClick={() => {
                  if (stt.status === "recording") {
                    stt.stopRecording();
                  } else if (stt.status === "idle" || stt.status === "ready") {
                    void stt.startRecording();
                  }
                }}
                disabled={stt.status === "loading-model" || stt.status === "transcribing" || stt.status === "error"}
                title={
                  stt.status === "loading-model"
                    ? "Loading model…"
                    : stt.status === "recording"
                      ? "Recording… click to stop"
                      : stt.status === "transcribing"
                        ? "Transcribing…"
                        : stt.error
                          ? stt.error
                          : "Voice input"
                }
                className={`relative flex items-center justify-center w-9 h-9 rounded-lg border transition-colors ${
                  stt.status === "recording"
                    ? "text-cc-error border-cc-error/40 bg-cc-error/10 cursor-pointer"
                    : stt.status === "loading-model" || stt.status === "transcribing" || stt.status === "error"
                      ? "text-cc-muted border-cc-border opacity-60 cursor-not-allowed"
                      : "text-cc-muted border-cc-border hover:text-cc-fg hover:bg-cc-hover cursor-pointer"
                }`}
              >
                {(stt.status === "loading-model" || stt.status === "transcribing") ? (
                  <svg className="w-4 h-4 animate-spin" viewBox="0 0 16 16" fill="none">
                    <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" strokeDasharray="28" strokeDashoffset="10" />
                  </svg>
                ) : (
                  <>
                    {stt.status === "recording" && (
                      <span className="absolute inset-0 rounded-lg animate-ping bg-cc-error/20" />
                    )}
                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 relative">
                      <rect x="5.5" y="1" width="5" height="8" rx="2.5" />
                      <path d="M3 7.5A5 5 0 0013 7.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
                      <line x1="8" y1="12.5" x2="8" y2="15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                      <line x1="5.5" y1="15" x2="10.5" y2="15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                  </>
                )}
              </button>

              {/* Send/stop: always visible */}
              {isRunning ? (
                <button
                  onClick={handleInterrupt}
                  className="flex items-center justify-center w-10 h-10 sm:w-9 sm:h-9 rounded-lg bg-cc-error/10 hover:bg-cc-error/20 text-cc-error transition-colors cursor-pointer"
                  title="Stop generation"
                >
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                    <rect x="3" y="3" width="10" height="10" rx="1" />
                  </svg>
                </button>
              ) : (
                <button
                  onClick={handleSend}
                  disabled={!canSend}
                  className={`flex items-center justify-center w-10 h-10 sm:w-9 sm:h-9 rounded-full transition-colors ${
                    canSend
                      ? "bg-cc-primary hover:bg-cc-primary-hover text-white cursor-pointer shadow-[0_6px_20px_rgba(0,0,0,0.18)]"
                      : "bg-cc-hover text-cc-muted cursor-not-allowed"
                  }`}
                  title="Send message"
                >
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                    <path d="M3 2l11 6-11 6V9.5l7-1.5-7-1.5V2z" />
                  </svg>
                </button>
              )}
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
