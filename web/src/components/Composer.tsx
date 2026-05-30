import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useStore } from "../store.js";
import { createClientMessageId, sendToSession } from "../ws.js";
import { CLAUDE_MODES, CODEX_MODES } from "../utils/backends.js";
import { api, type SavedPrompt } from "../api.js";
import type { ModeOption } from "../utils/backends.js";
import { ModelSwitcher } from "./ModelSwitcher.js";
import { MentionMenu } from "./MentionMenu.js";
import { useMentionMenu } from "../utils/use-mention-menu.js";

import { readFileAsBase64, type ImageAttachment } from "../utils/image.js";

/** Stable reference to avoid infinite re-renders in Zustand selectors. */
const emptyStringArray: string[] = [];

interface CommandItem {
  name: string;
  type: "command" | "skill" | "ide";
  /** When true, render as disabled (aria-disabled, muted styling, non-interactive). */
  disabled?: boolean;
  /** Tooltip (title attribute) shown on hover — used for disabled reasons. */
  tooltip?: string;
}

interface ComposerProps {
  sessionId: string;
  /**
   * Called when the user selects `/ide` (either from the autocomplete menu or
   * by typing `/ide` and pressing Enter). Parent owns the IdePicker modal's
   * open/close state. The Composer never sends `/ide` as a user_message —
   * the slash command is intercepted client-side.
   */
  onOpenIdePicker?: () => void;
}

export function Composer({ sessionId, onOpenIdePicker }: ComposerProps) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashMenuIndex, setSlashMenuIndex] = useState(0);
  const [savePromptOpen, setSavePromptOpen] = useState(false);
  const [savePromptName, setSavePromptName] = useState("");
  const [savePromptScope, setSavePromptScope] = useState<"global" | "project">("global");
  const [savePromptError, setSavePromptError] = useState<string | null>(null);
  const [caretPos, setCaretPos] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
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

  const mention = useMentionMenu({
    text,
    caretPos,
    cwd: sessionData?.cwd,
    enabled: !slashMenuOpen,
  });

  // Build command list from session data.
  // NOTE: We inject `/ide` as a synthetic client-side overlay. We do NOT mutate
  // `session.slash_commands` — the server has no knowledge of this command
  // because /ide is handled entirely in the browser (BIND-06). On Codex
  // sessions the entry is rendered disabled with a tooltip (UI-04).
  const allCommands = useMemo<CommandItem[]>(() => {
    const cmds: CommandItem[] = [];
    if (sessionData?.slash_commands) {
      for (const cmd of sessionData.slash_commands) {
        cmds.push({ name: cmd, type: "command" });
      }
    }
    // Synthetic /ide overlay. Append after user slash commands so typing
    // `/cl` prefers real commands when both match.
    cmds.push({
      name: "ide",
      type: "ide",
      disabled: isCodex,
      tooltip: isCodex
        ? "IDE integration requires Claude Code"
        : "Bind an IDE for context/diff/selection",
    });
    if (sessionData?.skills) {
      for (const skill of sessionData.skills) {
        cmds.push({ name: skill, type: "skill" });
      }
    }
    return cmds;
  }, [sessionData?.slash_commands, sessionData?.skills, isCodex]);

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

  // Open/close slash menu based on text
  useEffect(() => {
    const shouldOpen = text.startsWith("/") && /^\/\S*$/.test(text) && allCommands.length > 0;
    if (shouldOpen && !slashMenuOpen) {
      setSlashMenuOpen(true);
      setSlashMenuIndex(0);
    } else if (!shouldOpen && slashMenuOpen) {
      setSlashMenuOpen(false);
    }
  }, [text, allCommands.length, slashMenuOpen]);

  // Keep slash menu selected index in bounds AND off any disabled row
  // (e.g. `/ide` on Codex sessions). UI-04.
  useEffect(() => {
    if (filteredCommands.length === 0) return;
    const current = filteredCommands[slashMenuIndex];
    const currentOutOfBounds = slashMenuIndex >= filteredCommands.length;
    const currentDisabled = current?.disabled === true;
    if (currentOutOfBounds || currentDisabled) {
      // Find the first enabled index; fall back to 0 if all are disabled.
      const firstEnabled = filteredCommands.findIndex((c) => !c.disabled);
      setSlashMenuIndex(firstEnabled === -1 ? 0 : firstEnabled);
    }
  }, [filteredCommands, slashMenuIndex]);

  // Scroll slash menu selected item into view
  useEffect(() => {
    if (!menuRef.current || !slashMenuOpen) return;
    const items = menuRef.current.querySelectorAll("[data-cmd-index]");
    const selected = items[slashMenuIndex];
    if (selected) {
      selected.scrollIntoView({ block: "nearest" });
    }
  }, [slashMenuIndex, slashMenuOpen]);

  useEffect(() => {
    if (pendingSelectionRef.current === null || !textareaRef.current) return;
    const next = pendingSelectionRef.current;
    textareaRef.current.setSelectionRange(next, next);
    pendingSelectionRef.current = null;
  }, [text]);

  const selectCommand = useCallback((cmd: CommandItem) => {
    // Disabled rows (e.g. /ide on Codex) are a hard no-op: do not insert
    // text, do not close the menu, do not call the callback. (UI-04)
    if (cmd.disabled) return;
    // PRIMARY /ide intercept (UI-01, BIND-06). The /ide command is handled
    // entirely client-side: skip setText, skip sendToSession, just open the
    // IdePicker via the parent-supplied callback. Clear any pending text
    // (including a manually-typed `/ide`) so Enter doesn't leave stray
    // characters in the composer.
    if (cmd.type === "ide") {
      onOpenIdePicker?.();
      setText("");
      setSlashMenuOpen(false);
      return;
    }
    setText(`/${cmd.name} `);
    setSlashMenuOpen(false);
    textareaRef.current?.focus();
  }, [onOpenIdePicker]);

  const selectPrompt = useCallback((prompt: SavedPrompt) => {
    const result = mention.selectPrompt(prompt);
    pendingSelectionRef.current = result.nextCursor;
    setText(result.nextText);
    mention.setMentionMenuOpen(false);
    setCaretPos(result.nextCursor);
    textareaRef.current?.focus();
    // Auto-resize textarea after prompt insertion
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + "px";
    }
  }, [mention]);

  function handleSend() {
    const msg = text.trim();
    if (!msg || !isConnected) return;
    // SECONDARY /ide intercept (UI-01, BIND-06). Handles the case where the
    // user typed `/ide` manually (bypassing the autocomplete menu) and hit
    // Enter. On Codex the synthetic overlay is disabled, but we still
    // intercept here so the CLI never observes `/ide` as a user_message.
    if (msg === "/ide") {
      if (!isCodex) onOpenIdePicker?.();
      setText("");
      setSlashMenuOpen(false);
      return;
    }
    // Escape hatch (cubic round-5 P2 FIX 1, narrowed in P2 FIX 1.1 per
    // codex review): allow the user to send a literal `/ide` to the backend
    // by prefixing with a backslash. `\/ide` → sends `/ide` as a user_message.
    // The intercept above operates on the ORIGINAL `msg`, so prefixing with
    // `\` bypasses it cleanly. Strip the backslash and continue down the
    // normal send path with `outbound` in place of `msg`.
    //
    // NARROW BY DESIGN: this match is EXACT on the single string `\/ide`
    // because `/ide` is the ONLY slash string Companion intercepts today.
    // A broader rule (e.g. `msg.startsWith("\\/")`) would silently inherit
    // escape semantics for any future intercepted string and would also
    // strip backslashes from unrelated input like `\/clear`, which the user
    // never opted into. If a new intercept is added (e.g. `/foo`), extend
    // this explicitly — e.g. `new Set(["\\/ide", "\\/foo"]).has(msg)` —
    // rather than loosening the prefix test. See codex review on PR for
    // rationale.
    const outbound = msg === "\\/ide" ? "/ide" : msg;
    const clientMsgId = createClientMessageId();

    sendToSession(sessionId, {
      type: "user_message",
      content: outbound,
      session_id: sessionId,
      images: images.length > 0 ? images.map((img) => ({ media_type: img.mediaType, data: img.base64 })) : undefined,
      client_msg_id: clientMsgId,
    });

    useStore.getState().appendMessage(sessionId, {
      id: clientMsgId,
      role: "user",
      content: outbound,
      images: images.length > 0 ? images.map((img) => ({ media_type: img.mediaType, data: img.base64 })) : undefined,
      timestamp: Date.now(),
    });

    setText("");
    setImages([]);
    setSlashMenuOpen(false);
    mention.setMentionMenuOpen(false);

    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
    textareaRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    // Slash menu navigation
    if (slashMenuOpen && filteredCommands.length > 0) {
      // Arrow nav skips disabled rows (e.g. /ide on Codex). UI-04.
      const nextEnabledIndex = (start: number, dir: 1 | -1): number => {
        const n = filteredCommands.length;
        for (let step = 1; step <= n; step++) {
          const candidate = (start + dir * step + n * n) % n;
          if (!filteredCommands[candidate].disabled) return candidate;
        }
        return start;
      };
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashMenuIndex((i) => nextEnabledIndex(i, 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashMenuIndex((i) => nextEnabledIndex(i, -1));
        return;
      }
      if (e.key === "Tab" && !e.shiftKey) {
        e.preventDefault();
        selectCommand(filteredCommands[slashMenuIndex]);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        const cmd = filteredCommands[slashMenuIndex];
        if (cmd?.disabled) {
          // Cubic round-8 P2: close the menu but let Enter fall through to
          // handleSend so manually-typed text (e.g. "/ide" on Codex) still
          // reaches the send intercept path instead of being swallowed.
          setSlashMenuOpen(false);
        } else {
          e.preventDefault();
          selectCommand(cmd);
          return;
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashMenuOpen(false);
        return;
      }
    }

    if (mention.mentionMenuOpen) {
      if (e.key === "Escape") {
        e.preventDefault();
        mention.setMentionMenuOpen(false);
        return;
      }
    }

    if (mention.mentionMenuOpen && mention.filteredPrompts.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        mention.setMentionMenuIndex((i) => (i + 1) % mention.filteredPrompts.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        mention.setMentionMenuIndex((i) => (i - 1 + mention.filteredPrompts.length) % mention.filteredPrompts.length);
        return;
      }
      if ((e.key === "Tab" && !e.shiftKey) || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        selectPrompt(mention.filteredPrompts[mention.mentionMenuIndex]);
        return;
      }
    }

    if (
      mention.mentionMenuOpen
      && mention.filteredPrompts.length === 0
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
    if (savePromptScope === "project" && !sessionData?.cwd) {
      setSavePromptError("No project folder available for this session");
      return;
    }
    const payload: { name: string; content: string; scope: "global" | "project"; projectPaths?: string[] } = {
      name,
      content,
      scope: savePromptScope,
    };
    if (savePromptScope === "project") {
      payload.projectPaths = [sessionData!.cwd!];
    }
    try {
      await api.createPrompt(payload);
      await mention.refreshPrompts();
      setSavePromptOpen(false);
      setSavePromptName("");
      setSavePromptScope("global");
      setSavePromptError(null);
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : "Could not save prompt.";
      setSavePromptError(message);
    }
  }

  const promptSuggestionsRaw = useStore((s) => s.promptSuggestions.get(sessionId));
  const promptSuggestions = promptSuggestionsRaw ?? emptyStringArray;
  const clearPromptSuggestions = useStore((s) => s.clearPromptSuggestions);

  const sessionStatus = useStore((s) => s.sessionStatus);
  const isRunning = sessionStatus.get(sessionId) === "running";
  const canSend = text.trim().length > 0 && isConnected;

  return (
    <div className="shrink-0 px-0 sm:px-6 pt-0 sm:pt-3 pb-5 sm:pb-4 bg-cc-input-bg sm:bg-transparent">
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
                  className="absolute -top-1.5 -right-1.5 w-6 h-6 rounded-full bg-cc-error text-white flex items-center justify-center text-[10px] opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity cursor-pointer"
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

        {/* Prompt suggestion chips */}
        {promptSuggestions.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-2 sm:px-4 pb-2">
            {promptSuggestions.map((suggestion, i) => (
              <button
                key={i}
                onClick={() => {
                  if (!isConnected || isRunning) return;
                  const clientMsgId = createClientMessageId();
                  sendToSession(sessionId, {
                    type: "user_message",
                    content: suggestion,
                    session_id: sessionId,
                    client_msg_id: clientMsgId,
                  });
                  useStore.getState().appendMessage(sessionId, {
                    id: clientMsgId,
                    role: "user",
                    content: suggestion,
                    timestamp: Date.now(),
                  });
                  clearPromptSuggestions(sessionId);
                }}
                disabled={!isConnected || isRunning}
                className="text-xs px-2.5 py-1.5 rounded-lg bg-cc-hover hover:bg-cc-active text-cc-fg border border-cc-border transition-colors cursor-pointer truncate max-w-[280px]"
                title={suggestion}
              >
                {suggestion}
              </button>
            ))}
          </div>
        )}

        {/* Input container: flat separator on mobile, card on desktop */}
        <div className={`relative overflow-visible transition-all duration-200 border-t border-cc-separator sm:border sm:border-cc-border sm:bg-cc-input-bg/95 sm:rounded-[16px] sm:backdrop-blur-sm composer-card ${
          isPlan
            ? "sm:border-cc-primary/40 sm:shadow-[0_10px_30px_rgba(217,119,87,0.08)]"
            : "sm:focus-within:border-cc-primary/25"
        }`}>
          {/* Slash command menu */}
          {slashMenuOpen && filteredCommands.length > 0 && (
            <div
              ref={menuRef}
              className="absolute left-2 right-2 bottom-full mb-1 max-h-[240px] overflow-y-auto bg-cc-card border border-cc-border rounded-[10px] shadow-lg z-20 py-1"
            >
              {filteredCommands.map((cmd, i) => {
                const isSelected = i === slashMenuIndex;
                const isDisabled = cmd.disabled === true;
                return (
                  <button
                    key={`${cmd.type}-${cmd.name}`}
                    data-cmd-index={i}
                    onClick={() => selectCommand(cmd)}
                    aria-disabled={isDisabled ? "true" : undefined}
                    aria-selected={isSelected && !isDisabled ? "true" : "false"}
                    title={cmd.tooltip}
                    className={`w-full px-3 py-2 text-left flex items-center gap-2.5 transition-colors ${
                      isDisabled
                        ? "opacity-40 cursor-not-allowed"
                        : "cursor-pointer"
                    } ${
                      isSelected && !isDisabled
                        ? "bg-cc-hover"
                        : isDisabled
                          ? ""
                          : "hover:bg-cc-hover/50"
                    }`}
                  >
                    <span className="flex items-center justify-center w-6 h-6 rounded-md bg-cc-hover text-cc-muted shrink-0">
                      {cmd.type === "skill" ? (
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                          <path d="M8 1l1.796 3.64L14 5.255l-3 2.924.708 4.126L8 10.5l-3.708 1.805L5 8.18 2 5.255l4.204-.615L8 1z" />
                        </svg>
                      ) : cmd.type === "ide" ? (
                        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
                          <rect x="2" y="3" width="12" height="9" rx="1.5" />
                          <path d="M2 6h12" strokeLinecap="round" />
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
                );
              })}
            </div>
          )}

          {/* @ prompt menu */}
          <MentionMenu
            open={mention.mentionMenuOpen}
            loading={mention.promptsLoading}
            prompts={mention.filteredPrompts}
            selectedIndex={mention.mentionMenuIndex}
            onSelect={selectPrompt}
            menuRef={mention.mentionMenuRef}
            className="absolute left-2 right-2 bottom-full mb-1"
          />

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
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  aria-pressed={savePromptScope === "global"}
                  onClick={() => setSavePromptScope("global")}
                  className={`px-2 py-0.5 text-[11px] rounded border transition-colors cursor-pointer ${
                    savePromptScope === "global"
                      ? "border-cc-primary/40 text-cc-primary bg-cc-primary/8"
                      : "border-cc-border text-cc-muted hover:text-cc-fg"
                  }`}
                >
                  Global
                </button>
                <button
                  type="button"
                  aria-pressed={savePromptScope === "project"}
                  onClick={() => setSavePromptScope("project")}
                  className={`px-2 py-0.5 text-[11px] rounded border transition-colors cursor-pointer ${
                    savePromptScope === "project"
                      ? "border-cc-primary/40 text-cc-primary bg-cc-primary/8"
                      : "border-cc-border text-cc-muted hover:text-cc-fg"
                  }`}
                >
                  This project
                </button>
              </div>
              {savePromptScope === "project" && sessionData?.cwd && (
                <div className="text-[10px] text-cc-muted font-mono-code truncate" title={sessionData.cwd}>
                  {sessionData.cwd}
                </div>
              )}
              {savePromptError ? (
                <div className="text-[11px] text-cc-error">{savePromptError}</div>
              ) : null}
              <div className="flex items-center gap-1.5 justify-end">
                <button
                  onClick={() => {
                    setSavePromptOpen(false);
                    setSavePromptScope("global");
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

          {/* Mobile toolbar: mode toggle + model switcher + secondary actions (hidden on sm+) */}
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

            <ModelSwitcher sessionId={sessionId} />

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

          {/* Textarea row */}
          <div className="px-3 sm:px-3 pt-1 sm:pt-2.5">
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
              className="w-full px-1 py-1.5 text-base sm:text-sm bg-transparent resize-none outline-none text-cc-fg font-sans-ui placeholder:text-cc-muted disabled:opacity-50 overflow-y-auto"
              style={{ minHeight: "36px", maxHeight: "200px" }}
            />
          </div>

          {/* Mobile action row (hidden on sm+) */}
          <div className="flex items-center justify-end gap-1 px-3 pb-1 sm:hidden">
            {/* Send/stop */}
            {isRunning ? (
              <button
                onClick={handleInterrupt}
                className="flex items-center justify-center w-10 h-10 rounded-lg bg-cc-error/10 hover:bg-cc-error/20 text-cc-error transition-colors cursor-pointer"
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
                className={`flex items-center justify-center w-10 h-10 rounded-full transition-all duration-200 ${
                  canSend
                    ? "bg-cc-primary hover:bg-cc-primary-hover active:scale-95 text-white cursor-pointer shadow-[0_4px_16px_rgba(217,119,87,0.25)]"
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

          {/* Desktop action bar: + bookmark mode spacer model send (hidden on mobile) */}
          <div className="hidden sm:flex items-center gap-1.5 px-2.5 pb-2">
            {/* + button (image upload) */}
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={!isConnected}
              className={`flex items-center justify-center w-8 h-8 rounded-md transition-colors ${
                isConnected
                  ? "text-cc-muted hover:text-cc-fg hover:bg-cc-hover cursor-pointer"
                  : "text-cc-muted opacity-30 cursor-not-allowed"
              }`}
              title="Attach image"
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4">
                <path d="M8 3v10M3 8h10" strokeLinecap="round" />
              </svg>
            </button>

            {/* Save prompt (bookmark) */}
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

            {/* Mode toggle */}
            <button
              onClick={toggleMode}
              disabled={!isConnected}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[12px] font-semibold transition-all border select-none shrink-0 ${
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

            {/* Spacer */}
            <div className="flex-1" />

            {/* Model switcher */}
            <ModelSwitcher sessionId={sessionId} />

            {/* Send/stop */}
            {isRunning ? (
              <button
                onClick={handleInterrupt}
                className="flex items-center justify-center w-9 h-9 rounded-lg bg-cc-error/10 hover:bg-cc-error/20 text-cc-error transition-colors cursor-pointer"
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
                className={`flex items-center justify-center w-9 h-9 rounded-full transition-all duration-200 ${
                  canSend
                    ? "bg-cc-primary hover:bg-cc-primary-hover hover:scale-105 text-white cursor-pointer shadow-[0_4px_16px_rgba(217,119,87,0.25)]"
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
  );
}
