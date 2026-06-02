import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useStore } from "../store.js";
import {
  api,
  createSessionStream,
  type ClaudeDiscoveredSession,
  type CompanionEnv,
  type CompanionSandbox,
  type GitRepoInfo,
  type GitBranchInfo,
  type BackendInfo,
  type ImagePullState,
  type LinearIssue,
} from "../api.js";
import { connectSession, createClientMessageId, waitForConnection, sendToSession } from "../ws.js";
import { disconnectSession } from "../ws.js";
import { generateUniqueSessionName } from "../utils/names.js";
import { getRecentDirs, addRecentDir } from "../utils/recent-dirs.js";
import { navigateToSession } from "../utils/routing.js";
import { getModelsForBackend, getModesForBackend, getDefaultModel, getDefaultMode, toModelOptions, type ModelOption } from "../utils/backends.js";
import type { BackendType } from "../types.js";
import { EnvManager } from "./EnvManager.js";
import { FolderPicker } from "./FolderPicker.js";
import { readFileAsBase64, type ImageAttachment } from "../utils/image.js";
import { LinearSection } from "./home/LinearSection.js";
import { BranchPicker } from "./home/BranchPicker.js";
import { MentionMenu } from "./MentionMenu.js";
import { useMentionMenu } from "../utils/use-mention-menu.js";
import type { SavedPrompt } from "../api.js";
import type { SdkSessionInfo } from "../types.js";

type ResumeCandidate = {
  resumeSessionId: string;
  sessionId: string;
  name?: string;
  slug?: string;
  model?: string;
  createdAt: number;
  cwd: string;
  gitBranch?: string;
  source: "companion" | "claude_disk";
};

type SessionLaunchOverride = {
  resumeSessionAt: string;
  forkSession: boolean;
  cwd?: string;
  branch?: string;
  useWorktree?: boolean;
  createBranch?: boolean;
};

const RECENT_SESSIONS_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const INITIAL_VISIBLE_SESSION_ROWS = 12;
const LOAD_MORE_SESSION_ROWS = 24;

function getResumeCandidateProject(cwd: string): string {
  return cwd.split("/").filter(Boolean).pop() || cwd;
}

function getResumeCandidateTitle(candidate: ResumeCandidate): string {
  return candidate.name?.trim()
    || candidate.slug?.trim()
    || getResumeCandidateProject(candidate.cwd);
}

function shortSessionId(sessionId: string): string {
  return sessionId.length > 8 ? sessionId.slice(0, 8) : sessionId;
}

function formatPathTail(path: string, segments = 2): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= segments) return path;
  return `.../${parts.slice(-segments).join("/")}`;
}

function formatTimeAgo(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "Unknown";
  const deltaMs = Date.now() - timestamp;
  if (deltaMs < 60_000) return "Just now";
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 8) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  return `${Math.max(1, months)}mo ago`;
}

export function HomePage() {
  const [text, setText] = useState("");
  const [backend, setBackend] = useState<BackendType>(() =>
    (localStorage.getItem("cc-backend") as BackendType) || "claude",
  );
  const [backends, setBackends] = useState<BackendInfo[]>([]);
  const [model, setModel] = useState(() => getDefaultModel(
    (localStorage.getItem("cc-backend") as BackendType) || "claude",
  ));
  const [mode, setMode] = useState(() => getDefaultMode(
    (localStorage.getItem("cc-backend") as BackendType) || "claude",
  ));
  const [cwd, setCwd] = useState(() => getRecentDirs()[0] || "");
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [dynamicModels, setDynamicModels] = useState<ModelOption[] | null>(null);
  const [linearConfigured, setLinearConfigured] = useState(false);
  const [selectedLinearIssue, setSelectedLinearIssue] = useState<LinearIssue | null>(null);
  const [selectedLinearConnectionId, setSelectedLinearConnectionId] = useState<string | null>(null);
  const [showOnboardingTip, setShowOnboardingTip] = useState(
    () => localStorage.getItem("cc-onboarding-dismissed") !== "true",
  );

  const MODELS = dynamicModels || getModelsForBackend(backend);
  const MODES = getModesForBackend(backend);

  // Environment state
  const [envs, setEnvs] = useState<CompanionEnv[]>([]);
  const [selectedEnv, setSelectedEnv] = useState(() => localStorage.getItem("cc-selected-env") || "");
  const [showEnvDropdown, setShowEnvDropdown] = useState(false);
  const [showEnvManager, setShowEnvManager] = useState(false);

  // Sandbox state
  const [sandboxEnabled, setSandboxEnabled] = useState(() => localStorage.getItem("cc-sandbox-enabled") === "true");
  const [sandboxes, setSandboxes] = useState<CompanionSandbox[]>([]);
  const [selectedSandbox, setSelectedSandbox] = useState(() => localStorage.getItem("cc-selected-sandbox") || "");
  const [showSandboxDropdown, setShowSandboxDropdown] = useState(false);
  const sandboxDropdownRef = useRef<HTMLDivElement>(null);

  // Sandbox image readiness
  const [sandboxImageState, setSandboxImageState] = useState<ImagePullState | null>(null);
  const sandboxImagePollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Dropdown states
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [showModeDropdown, setShowModeDropdown] = useState(false);
  const [showFolderPicker, setShowFolderPicker] = useState(false);
  const [showBranchingControls, setShowBranchingControls] = useState(false);
  const [resumeSessionAt, setResumeSessionAt] = useState("");
  const [forkSession, setForkSession] = useState(true);
  const [resumeCandidates, setResumeCandidates] = useState<ResumeCandidate[]>([]);
  const [resumeCandidatesLoading, setResumeCandidatesLoading] = useState(false);
  const [resumeCandidatesError, setResumeCandidatesError] = useState("");
  const [showOlderResumeCandidates, setShowOlderResumeCandidates] = useState(false);
  const [visibleResumeCandidateRows, setVisibleResumeCandidateRows] = useState(INITIAL_VISIBLE_SESSION_ROWS);
  const [resumeSearchQuery, setResumeSearchQuery] = useState("");

  // Git branch state (owned here, driven by BranchPicker + LinearSection)
  const [gitRepoInfo, setGitRepoInfo] = useState<GitRepoInfo | null>(null);
  const [useWorktree, setUseWorktree] = useState(false);
  const [selectedBranch, setSelectedBranch] = useState("");
  const [isNewBranch, setIsNewBranch] = useState(false);
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);

  // Branch freshness check state
  const [pullPrompt, setPullPrompt] = useState<{ behind: number; branchName: string } | null>(null);
  const [pulling, setPulling] = useState(false);
  const [pullError, setPullError] = useState("");

  const [caretPos, setCaretPos] = useState(0);
  const pendingSelectionRef = useRef<number | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelDropdownRef = useRef<HTMLDivElement>(null);
  const modeDropdownRef = useRef<HTMLDivElement>(null);
  const envDropdownRef = useRef<HTMLDivElement>(null);

  const currentSessionId = useStore((s) => s.currentSessionId);

  // @ mention support for saved prompts
  const mention = useMentionMenu({
    text,
    caretPos,
    cwd: cwd || undefined,
  });

  // Restore cursor position after prompt insertion
  useEffect(() => {
    if (pendingSelectionRef.current === null || !textareaRef.current) return;
    const next = pendingSelectionRef.current;
    textareaRef.current.setSelectionRange(next, next);
    pendingSelectionRef.current = null;
  }, [text]);

  // Auto-focus textarea (desktop only — on mobile it triggers the keyboard immediately)
  useEffect(() => {
    const isDesktop = window.matchMedia("(min-width: 640px)").matches;
    if (isDesktop) {
      textareaRef.current?.focus();
    }
  }, []);

  // Load server home/cwd and available backends on mount
  useEffect(() => {
    api.getHome().then(({ home, cwd: serverCwd }) => {
      if (!cwd) {
        setCwd(serverCwd || home);
      }
    }).catch(() => {});
    api.listEnvs().then(setEnvs).catch(() => {});
    api.listSandboxes().then(setSandboxes).catch(() => {});
    api.getBackends().then(setBackends).catch(() => {});
    api.getSettings().then((s) => {
      setLinearConfigured(s.linearApiKeyConfigured);
    }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // When backend changes, reset model and mode to defaults
  function switchBackend(newBackend: BackendType) {
    setBackend(newBackend);
    localStorage.setItem("cc-backend", newBackend);
    setDynamicModels(null);
    setModel(getDefaultModel(newBackend));
    setMode(getDefaultMode(newBackend));
    if (newBackend !== "claude") {
      setShowBranchingControls(false);
      setResumeCandidates([]);
      setResumeCandidatesError("");
      setResumeCandidatesLoading(false);
      setShowOlderResumeCandidates(false);
      setVisibleResumeCandidateRows(INITIAL_VISIBLE_SESSION_ROWS);
      setResumeSearchQuery("");
    }
  }

  // Fetch dynamic models for the selected backend
  useEffect(() => {
    if (backend !== "codex") {
      setDynamicModels(null);
      return;
    }
    api.getBackendModels(backend).then((models) => {
      if (models.length > 0) {
        const options = toModelOptions(models);
        setDynamicModels(options);
        // If current model isn't in the list, switch to first
        if (!options.some((m) => m.value === model)) {
          setModel(options[0].value);
        }
      }
    }).catch(() => {
      // Fall back to hardcoded models silently
    });
  }, [backend]); // eslint-disable-line react-hooks/exhaustive-deps

  // When sandbox is enabled, check the-companion:latest image status
  useEffect(() => {
    if (sandboxImagePollRef.current) {
      clearInterval(sandboxImagePollRef.current);
      sandboxImagePollRef.current = null;
    }
    setSandboxImageState(null);

    if (!sandboxEnabled) return;

    const effectiveImage = "the-companion:latest";

    const checkAndPull = () => {
      api.getImageStatus(effectiveImage).then((state) => {
        setSandboxImageState(state);
        if (state.status === "idle") {
          api.pullImage(effectiveImage).catch(() => {});
        }
        if (state.status === "ready" || state.status === "error") {
          if (sandboxImagePollRef.current) {
            clearInterval(sandboxImagePollRef.current);
            sandboxImagePollRef.current = null;
          }
        }
      }).catch(() => {});
    };

    checkAndPull();
    sandboxImagePollRef.current = setInterval(checkAndPull, 2000);

    return () => {
      if (sandboxImagePollRef.current) {
        clearInterval(sandboxImagePollRef.current);
        sandboxImagePollRef.current = null;
      }
    };
  }, [sandboxEnabled]);

  // Close dropdowns on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(e.target as Node)) {
        setShowModelDropdown(false);
      }
      if (modeDropdownRef.current && !modeDropdownRef.current.contains(e.target as Node)) {
        setShowModeDropdown(false);
      }
      if (envDropdownRef.current && !envDropdownRef.current.contains(e.target as Node)) {
        setShowEnvDropdown(false);
      }
      if (sandboxDropdownRef.current && !sandboxDropdownRef.current.contains(e.target as Node)) {
        setShowSandboxDropdown(false);
      }
    }
    document.addEventListener("pointerdown", handleClick);
    return () => document.removeEventListener("pointerdown", handleClick);
  }, []);

  // Detect git repo when cwd changes
  useEffect(() => {
    if (!cwd) {
      setGitRepoInfo(null);
      return;
    }
    api.getRepoInfo(cwd).then((info) => {
      setGitRepoInfo(info);
      setSelectedBranch(info.currentBranch);
      setIsNewBranch(false);
    }).catch(() => {
      setGitRepoInfo(null);
      setSelectedBranch("");
      setIsNewBranch(false);
    });
  }, [cwd]);

  const selectedModel = MODELS.find((m) => m.value === model) || MODELS[0];
  const selectedMode = MODES.find((m) => m.value === mode) || MODES[0];
  const logoSrc = backend === "codex" ? "/logo-codex.svg" : "/logo.svg";
  const dirLabel = cwd ? cwd.split("/").pop() || cwd : "Select folder";
  const trimmedResumeSessionAt = useMemo(() => resumeSessionAt.trim(), [resumeSessionAt]);
  const branchFromSessionEnabled = backend === "claude"
    && showBranchingControls
    && trimmedResumeSessionAt.length > 0;
  const recentResumeCandidates = useMemo(() => {
    const cutoff = Date.now() - RECENT_SESSIONS_WINDOW_MS;
    return resumeCandidates.filter((candidate) => candidate.createdAt >= cutoff);
  }, [resumeCandidates]);
  const activeResumeCandidates = useMemo(() => {
    if (showOlderResumeCandidates) return resumeCandidates;
    return recentResumeCandidates.length > 0 ? recentResumeCandidates : resumeCandidates;
  }, [showOlderResumeCandidates, recentResumeCandidates, resumeCandidates]);
  const normalizedResumeSearchQuery = useMemo(
    () => resumeSearchQuery.trim().toLowerCase(),
    [resumeSearchQuery],
  );
  const filteredActiveResumeCandidates = useMemo(() => {
    if (!normalizedResumeSearchQuery) return activeResumeCandidates;
    return activeResumeCandidates.filter((candidate) => {
      const title = getResumeCandidateTitle(candidate).toLowerCase();
      const project = getResumeCandidateProject(candidate.cwd).toLowerCase();
      const branch = (candidate.gitBranch || "").toLowerCase();
      const cwdText = candidate.cwd.toLowerCase();
      const sessionId = candidate.resumeSessionId.toLowerCase();
      return title.includes(normalizedResumeSearchQuery)
        || project.includes(normalizedResumeSearchQuery)
        || branch.includes(normalizedResumeSearchQuery)
        || cwdText.includes(normalizedResumeSearchQuery)
        || sessionId.includes(normalizedResumeSearchQuery);
    });
  }, [activeResumeCandidates, normalizedResumeSearchQuery]);
  const visibleResumeCandidates = useMemo(
    () => filteredActiveResumeCandidates.slice(0, visibleResumeCandidateRows),
    [filteredActiveResumeCandidates, visibleResumeCandidateRows],
  );
  const hasMoreResumeCandidates = visibleResumeCandidateRows < filteredActiveResumeCandidates.length;
  const hiddenOlderResumeCount = Math.max(0, resumeCandidates.length - recentResumeCandidates.length);
  const showingRecentOnly = !showOlderResumeCandidates && recentResumeCandidates.length > 0;

  const loadResumeCandidates = useCallback(async () => {
    if (backend !== "claude") return;
    setResumeCandidatesLoading(true);
    setResumeCandidatesError("");
    try {
      const [companionSessions, discovered] = await Promise.all([
        api.listSessions(),
        api.discoverClaudeSessions(400).then((result) => result.sessions),
      ]);

      const uniqueByResumeSession = new Map<string, ResumeCandidate>();
      const upsertCandidate = (candidate: ResumeCandidate) => {
        const prev = uniqueByResumeSession.get(candidate.resumeSessionId);
        if (!prev || candidate.createdAt > prev.createdAt) {
          uniqueByResumeSession.set(candidate.resumeSessionId, candidate);
        }
      };

      for (const session of companionSessions as SdkSessionInfo[]) {
        if (session.backendType === "codex") continue;
        if (!session.cliSessionId) continue;
        upsertCandidate({
          resumeSessionId: session.cliSessionId,
          sessionId: session.sessionId,
          name: session.name,
          model: session.model,
          createdAt: session.createdAt,
          cwd: session.cwd,
          gitBranch: session.gitBranch,
          source: "companion",
        });
      }

      for (const diskSession of discovered as ClaudeDiscoveredSession[]) {
        upsertCandidate({
          resumeSessionId: diskSession.sessionId,
          sessionId: diskSession.sessionId,
          slug: diskSession.slug,
          createdAt: diskSession.lastActivityAt,
          cwd: diskSession.cwd,
          gitBranch: diskSession.gitBranch,
          source: "claude_disk",
        });
      }

      const next = Array.from(uniqueByResumeSession.values())
        .sort((a, b) => {
          const aCwdMatch = cwd && a.cwd === cwd ? 0 : 1;
          const bCwdMatch = cwd && b.cwd === cwd ? 0 : 1;
          if (aCwdMatch !== bCwdMatch) return aCwdMatch - bCwdMatch;
          return b.createdAt - a.createdAt;
        });
      setResumeCandidates(next);
      setShowOlderResumeCandidates(false);
      setVisibleResumeCandidateRows(INITIAL_VISIBLE_SESSION_ROWS);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setResumeCandidatesError(msg || "Failed to load existing sessions");
      setResumeCandidates([]);
      setVisibleResumeCandidateRows(INITIAL_VISIBLE_SESSION_ROWS);
    } finally {
      setResumeCandidatesLoading(false);
    }
  }, [backend, cwd]);

  useEffect(() => {
    if (backend === "claude" && showBranchingControls) {
      void loadResumeCandidates();
    }
  }, [backend, showBranchingControls, loadResumeCandidates]);

  useEffect(() => {
    setVisibleResumeCandidateRows(INITIAL_VISIBLE_SESSION_ROWS);
  }, [normalizedResumeSearchQuery, showOlderResumeCandidates]);

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

  function handleSelectPrompt(prompt: SavedPrompt) {
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
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    // @ mention menu navigation
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
        handleSelectPrompt(mention.filteredPrompts[mention.mentionMenuIndex]);
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
      const currentModes = getModesForBackend(backend);
      const currentIndex = currentModes.findIndex((m) => m.value === mode);
      const nextIndex = (currentIndex + 1) % currentModes.length;
      setMode(currentModes[nextIndex].value);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function buildInitialMessage(msg: string): string {
    if (!selectedLinearIssue) return msg;
    const description = (selectedLinearIssue.description ?? "").trim();
    const context = [
      "Linear issue context:",
      `- Identifier: ${selectedLinearIssue.identifier}`,
      `- Title: ${selectedLinearIssue.title}`,
      selectedLinearIssue.stateName ? `- State: ${selectedLinearIssue.stateName}` : "",
      selectedLinearIssue.priorityLabel ? `- Priority: ${selectedLinearIssue.priorityLabel}` : "",
      selectedLinearIssue.teamName ? `- Team: ${selectedLinearIssue.teamName}` : "",
      `- URL: ${selectedLinearIssue.url}`,
      description ? `- Description:\n${description}` : "",
    ].filter(Boolean).join("\n");
    return `${context}\n\nUser request:\n${msg}`;
  }

  async function handleSend() {
    const msg = text.trim();
    if (!msg || sending) return;

    setSending(true);
    setError("");
    setPullError("");

    // Branch freshness check: warn if behind remote
    // Only offer pull when the effective branch is the currently checked-out branch,
    // since git pull operates on the checked-out branch
    if (gitRepoInfo) {
      const effectiveBranch = selectedBranch || gitRepoInfo.currentBranch;
      if (effectiveBranch && effectiveBranch === gitRepoInfo.currentBranch) {
        const branchInfo = branches.find(b => b.name === effectiveBranch && !b.isRemote);
        if (branchInfo && branchInfo.behind > 0) {
          setPullPrompt({ behind: branchInfo.behind, branchName: effectiveBranch });
          return; // Pause — user must choose pull/skip/cancel
        }
      }
    }

    await doCreateSession(msg);
  }

  async function doCreateSession(
    msg: string,
    launchOverride?: SessionLaunchOverride,
  ) {
    const store = useStore.getState();
    store.clearCreation();
    store.setSessionCreating(true, backend as "claude" | "codex");

    try {
      // Disconnect current session if any
      if (currentSessionId) {
        disconnectSession(currentSessionId);
      }

      const effectiveResumeSessionAt = launchOverride?.resumeSessionAt
        || (branchFromSessionEnabled ? trimmedResumeSessionAt : undefined);
      const effectiveForkSession = effectiveResumeSessionAt
        ? (launchOverride?.forkSession ?? (branchFromSessionEnabled ? forkSession : undefined))
        : undefined;
      const effectiveCwd = launchOverride?.cwd || cwd;
      const effectiveBranch = launchOverride?.branch !== undefined
        ? (launchOverride.branch.trim() || undefined)
        : (selectedBranch.trim() || undefined);
      const effectiveUseWorktree = launchOverride?.useWorktree !== undefined
        ? launchOverride.useWorktree
        : useWorktree;
      const effectiveCreateBranch = launchOverride?.createBranch !== undefined
        ? launchOverride.createBranch
        : Boolean(effectiveBranch && isNewBranch);

      // Create session with progress streaming
      const result = await createSessionStream(
        {
          model,
          permissionMode: mode,
          cwd: effectiveCwd || undefined,
          envSlug: selectedEnv || undefined,
          sandboxEnabled: sandboxEnabled ? true : undefined,
          sandboxSlug: sandboxEnabled && selectedSandbox ? selectedSandbox : undefined,
          branch: effectiveBranch,
          createBranch: effectiveCreateBranch ? true : undefined,
          useWorktree: effectiveUseWorktree ? true : undefined,
          backend,
          codexInternetAccess: backend === "codex" ? true : undefined,
          resumeSessionAt: effectiveResumeSessionAt,
          forkSession: effectiveForkSession,
          linearConnectionId: selectedLinearIssue ? (selectedLinearConnectionId || undefined) : undefined,
          linearIssue: selectedLinearIssue ? {
            identifier: selectedLinearIssue.identifier,
            title: selectedLinearIssue.title,
            stateName: selectedLinearIssue.stateName,
            teamName: selectedLinearIssue.teamName,
            url: selectedLinearIssue.url,
          } : undefined,
        },
        (progress) => {
          useStore.getState().addCreationProgress(progress);
        },
      );
      const sessionId = result.sessionId;

      // Seed sdk session metadata immediately so chat can render resume/fork context
      // before the sidebar poller refreshes /api/sessions.
      const sessionStore = useStore.getState();
      const existingSdkSessions = sessionStore.sdkSessions.filter((sdk) => sdk.sessionId !== sessionId);
      sessionStore.setSdkSessions([
        ...existingSdkSessions,
        {
          sessionId,
          state: result.state as "starting" | "connected" | "running" | "exited",
          cwd: result.cwd,
          createdAt: Date.now(),
          backendType: (result.backendType as BackendType | undefined) || backend,
          model,
          permissionMode: mode,
          resumeSessionAt: effectiveResumeSessionAt,
          forkSession: effectiveResumeSessionAt ? effectiveForkSession === true : undefined,
        },
      ]);

      // Assign a random session name
      const existingNames = new Set(useStore.getState().sessionNames.values());
      const sessionName = generateUniqueSessionName(existingNames);
      useStore.getState().setSessionName(sessionId, sessionName);

      // Save cwd to recent dirs
      if (effectiveCwd) addRecentDir(effectiveCwd);

      // Store the permission mode for this session
      useStore.getState().setPreviousPermissionMode(sessionId, mode);

      // Switch to session — use replace to avoid a back-button entry for the creation state
      navigateToSession(sessionId, true);
      // connectSession called eagerly so waitForConnection below can resolve immediately;
      // the App.tsx hash-sync effect also calls it, but that runs after render (too late).
      connectSession(sessionId);

      // Wait for WebSocket connection
      await waitForConnection(sessionId);

      const trimmedMsg = msg.trim();
      if (trimmedMsg.length > 0) {
        const initialMessage = buildInitialMessage(trimmedMsg);
        const clientMsgId = createClientMessageId();

        // Send message
        sendToSession(sessionId, {
          type: "user_message",
          content: initialMessage,
          session_id: sessionId,
          images: images.length > 0 ? images.map((img) => ({ media_type: img.mediaType, data: img.base64 })) : undefined,
          client_msg_id: clientMsgId,
        });

        // Add user message to store
        useStore.getState().appendMessage(sessionId, {
          id: clientMsgId,
          role: "user",
          content: initialMessage,
          images: images.length > 0 ? images.map((img) => ({ media_type: img.mediaType, data: img.base64 })) : undefined,
          timestamp: Date.now(),
        });
      }

      // Auto-link Linear issue if one was selected
      if (selectedLinearIssue) {
        api.linkLinearIssue(sessionId, selectedLinearIssue, selectedLinearConnectionId || undefined)
          .then(() => useStore.getState().setLinkedLinearIssue(sessionId, selectedLinearIssue))
          .catch(() => { /* fire-and-forget: linking is best-effort */ });
        // Fire-and-forget: transition Linear issue to configured status
        api.transitionLinearIssue(selectedLinearIssue.id, selectedLinearConnectionId || undefined).catch(() => {
          /* fire-and-forget: status transition is best-effort */
        });
      }

      // Clear progress on success
      useStore.getState().clearCreation();
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      setError(errMsg);
      // Set error in store so the overlay can display it; keep sessionCreating
      // true so the overlay stays visible — user dismisses via the overlay's cancel button
      useStore.getState().setCreationError(errMsg);
      setSending(false);
    }
  }

  async function handleOpenBranchedSession(candidate: ResumeCandidate, shouldFork: boolean) {
    if (sending) return;
    setSending(true);
    setError("");
    setPullError("");
    setCwd(candidate.cwd);
    setUseWorktree(false);
    setIsNewBranch(false);
    setSelectedBranch(candidate.gitBranch || "");
    setResumeSessionAt(candidate.resumeSessionId);
    setForkSession(shouldFork);
    await doCreateSession("", {
      resumeSessionAt: candidate.resumeSessionId,
      forkSession: shouldFork,
      cwd: candidate.cwd,
      branch: candidate.gitBranch,
      useWorktree: false,
      createBranch: false,
    });
  }

  async function handlePullAndContinue() {
    if (!pullPrompt) return;
    setPulling(true);
    setPullError("");

    try {
      const pullCwd = cwd || gitRepoInfo?.repoRoot;
      if (!pullCwd) throw new Error("No working directory");

      const result = await api.gitPull(pullCwd);
      if (!result.success) {
        setPullError(result.output || "Pull failed");
        setPulling(false);
        setSending(false);
        return;
      }

      setPullPrompt(null);
      setPulling(false);
      await doCreateSession(text.trim());
    } catch (e: unknown) {
      setPullError(e instanceof Error ? e.message : String(e));
      setPulling(false);
    }
  }

  function handleSkipPull() {
    const msg = text.trim();
    setPullPrompt(null);
    setPullError("");
    doCreateSession(msg);
  }

  function handleCancelPull() {
    setPullPrompt(null);
    setPullError("");
    setSending(false);
  }

  const handleBranchChange = useCallback((branch: string, isNew: boolean) => {
    setSelectedBranch(branch);
    setIsNewBranch(isNew);
  }, []);

  const handleBranchFromIssue = useCallback((branch: string, isNew: boolean) => {
    setSelectedBranch(branch);
    setIsNewBranch(isNew);
  }, []);

  const handleBranchesLoaded = useCallback((loadedBranches: GitBranchInfo[]) => {
    setBranches(loadedBranches);
  }, []);

  const handleIssueSelect = useCallback((issue: LinearIssue | null) => {
    setSelectedLinearIssue(issue);
    if (!issue && gitRepoInfo) {
      // Revert branch to current when clearing Linear issue
      setSelectedBranch(gitRepoInfo.currentBranch);
      setIsNewBranch(false);
    }
  }, [gitRepoInfo]);

  const canSend = text.trim().length > 0 && !sending;

  return (
    <div className="flex-1 h-full flex flex-col items-center px-3 sm:px-6 pb-6 pb-safe overflow-y-auto overscroll-y-contain">
      {/* Fixed-height spacer — pushes content to ~20% from top, content grows downward only */}
      <div className="shrink-0 h-[12vh] sm:h-[18vh]" />
      <div className="w-full max-w-[720px]">
        {/* Logo + Title — minimal, centered */}
        <div className="flex flex-col items-center mb-6 sm:mb-10">
          <img src={logoSrc} alt="The Companion" className="w-10 h-10 sm:w-12 sm:h-12 mb-3" />
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-cc-fg">
            The Companion
          </h1>
        </div>

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

        {/* Main input card — the hero element */}
        <div className="relative bg-cc-card border border-cc-border rounded-2xl shadow-sm">
          <MentionMenu
            open={mention.mentionMenuOpen}
            loading={mention.promptsLoading}
            prompts={mention.filteredPrompts}
            selectedIndex={mention.mentionMenuIndex}
            onSelect={handleSelectPrompt}
            menuRef={mention.mentionMenuRef}
            className="absolute left-2 right-2 bottom-full mb-1"
          />
          {/* Context badges (Linear issue, images) — inside card to avoid external shift */}
          {(selectedLinearIssue || images.length > 0) && (
            <div className="flex items-center gap-2 px-4 pt-3 flex-wrap">
              {selectedLinearIssue && (
                <div className="inline-flex max-w-full items-center gap-2 rounded-md border border-cc-border bg-cc-hover/60 px-2.5 py-1.5 text-[11px] text-cc-muted">
                  <span className="shrink-0">Linear</span>
                  <span className="font-mono-code shrink-0">{selectedLinearIssue.identifier}</span>
                  <span className="truncate">{selectedLinearIssue.title}</span>
                  <button
                    type="button"
                    onClick={() => handleIssueSelect(null)}
                    className="shrink-0 rounded px-1 text-cc-muted hover:text-cc-fg hover:bg-cc-active transition-colors cursor-pointer"
                    title="Remove Linear issue"
                  >
                    ×
                  </button>
                </div>
              )}
              {images.map((img, i) => (
                <div key={i} className="relative group">
                  <img
                    src={`data:${img.mediaType};base64,${img.base64}`}
                    alt={img.name}
                    className="w-10 h-10 rounded-lg object-cover border border-cc-border"
                  />
                  <button
                    onClick={() => removeImage(i)}
                    className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-cc-error text-white flex items-center justify-center text-[10px] opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity cursor-pointer"
                  >
                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-2.5 h-2.5">
                      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={text}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onClick={syncCaret}
            onKeyUp={syncCaret}
            onPaste={handlePaste}
            aria-label="Task description"
            placeholder="Fix a bug, build a feature, refactor code..."
            rows={3}
            className="w-full px-4 sm:px-5 pt-4 pb-2 text-[15px] sm:text-sm bg-transparent resize-none focus:outline-none text-cc-fg font-sans-ui placeholder:text-cc-muted/70 overflow-y-auto"
            style={{ minHeight: "80px", maxHeight: "200px" }}
          />

          {/* ── Toolbar: all controls in one bar ── */}
          <div className="flex items-center gap-1 px-2.5 sm:px-3 py-2 flex-wrap">
            {/* Model selector */}
            <div className="relative" ref={modelDropdownRef}>
              <button
                onClick={() => setShowModelDropdown(!showModelDropdown)}
                aria-expanded={showModelDropdown}
                className="flex items-center gap-1 px-2 py-1 text-[11px] sm:text-xs text-cc-muted hover:text-cc-fg rounded-lg hover:bg-cc-hover transition-colors cursor-pointer"
              >
                <span>{selectedModel.icon}</span>
                <span>{selectedModel.label}</span>
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-2.5 h-2.5 opacity-40">
                  <path d="M4 6l4 4 4-4" />
                </svg>
              </button>
              {showModelDropdown && (
                <div className="absolute left-0 bottom-full mb-1 w-48 bg-cc-card border border-cc-border rounded-[10px] shadow-lg z-10 py-1">
                  {MODELS.map((m) => (
                    <button
                      key={m.value}
                      onClick={() => { setModel(m.value); setShowModelDropdown(false); }}
                      className={`w-full px-3 py-2 text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer flex items-center gap-2 ${
                        m.value === model ? "text-cc-primary font-medium" : "text-cc-fg"
                      }`}
                    >
                      <span>{m.icon}</span>
                      {m.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Mode dropdown */}
            <div className="relative" ref={modeDropdownRef}>
              <button
                onClick={() => setShowModeDropdown(!showModeDropdown)}
                aria-expanded={showModeDropdown}
                className="flex items-center gap-1 px-2 py-1 text-[11px] sm:text-xs text-cc-muted hover:text-cc-fg rounded-lg hover:bg-cc-hover transition-colors cursor-pointer"
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3 h-3">
                  <path d="M2 4h12M2 8h8M2 12h10" strokeLinecap="round" />
                </svg>
                {selectedMode.label}
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-2.5 h-2.5 opacity-40">
                  <path d="M4 6l4 4 4-4" />
                </svg>
              </button>
              {showModeDropdown && (
                <div className="absolute left-0 bottom-full mb-1 w-40 bg-cc-card border border-cc-border rounded-[10px] shadow-lg z-10 py-1 overflow-hidden">
                  {MODES.map((m) => (
                    <button
                      key={m.value}
                      onClick={() => { setMode(m.value); setShowModeDropdown(false); }}
                      className={`w-full px-3 py-2 text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer ${
                        m.value === mode ? "text-cc-primary font-medium" : "text-cc-fg"
                      }`}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Separator dot */}
            <span className="w-0.5 h-0.5 rounded-full bg-cc-muted/30 mx-0.5 hidden sm:block" />

            {/* Folder selector */}
            <div>
              <button
                onClick={() => setShowFolderPicker(true)}
                className="flex items-center gap-1 px-2 py-1 text-[11px] sm:text-xs text-cc-muted hover:text-cc-fg rounded-lg hover:bg-cc-hover transition-colors cursor-pointer"
              >
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 opacity-50">
                  <path d="M1 3.5A1.5 1.5 0 012.5 2h3.379a1.5 1.5 0 011.06.44l.622.621a.5.5 0 00.353.146H13.5A1.5 1.5 0 0115 4.707V12.5a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12.5v-9z" />
                </svg>
                <span className="max-w-[80px] sm:max-w-[140px] truncate font-mono-code">{dirLabel}</span>
              </button>
              {showFolderPicker && (
                <FolderPicker
                  initialPath={cwd || ""}
                  onSelect={(path) => { setCwd(path); }}
                  onClose={() => setShowFolderPicker(false)}
                />
              )}
            </div>

            {/* Branch picker */}
            <BranchPicker
              cwd={cwd}
              gitRepoInfo={gitRepoInfo}
              selectedBranch={selectedBranch}
              isNewBranch={isNewBranch}
              useWorktree={useWorktree}
              onBranchChange={handleBranchChange}
              onWorktreeChange={setUseWorktree}
              onBranchesLoaded={handleBranchesLoaded}
            />

            {/* Separator dot */}
            <span className="w-0.5 h-0.5 rounded-full bg-cc-muted/30 mx-0.5 hidden sm:block" />

            {/* Environment selector */}
            <div className="relative" ref={envDropdownRef}>
              <button
                onClick={() => {
                  if (!showEnvDropdown) {
                    api.listEnvs().then(setEnvs).catch(() => {});
                  }
                  setShowEnvDropdown(!showEnvDropdown);
                }}
                aria-expanded={showEnvDropdown}
                className="flex items-center gap-1 px-2 py-1 text-[11px] sm:text-xs text-cc-muted hover:text-cc-fg rounded-lg hover:bg-cc-hover transition-colors cursor-pointer"
              >
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 opacity-50">
                  <path d="M8 1a2 2 0 012 2v1h2a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6a2 2 0 012-2h2V3a2 2 0 012-2zm0 1.5a.5.5 0 00-.5.5v1h1V3a.5.5 0 00-.5-.5zM4 5.5a.5.5 0 00-.5.5v6a.5.5 0 00.5.5h8a.5.5 0 00.5-.5V6a.5.5 0 00-.5-.5H4z" />
                </svg>
                <span className="max-w-[80px] sm:max-w-[100px] truncate">
                  {selectedEnv ? envs.find((e) => e.slug === selectedEnv)?.name || "Env" : "No env"}
                </span>
              </button>
              {showEnvDropdown && (
                <div className="absolute left-0 bottom-full mb-1 w-56 bg-cc-card border border-cc-border rounded-[10px] shadow-lg z-10 py-1 overflow-hidden">
                  <button
                    onClick={() => {
                      setSelectedEnv("");
                      localStorage.setItem("cc-selected-env", "");
                      setShowEnvDropdown(false);
                    }}
                    className={`w-full px-3 py-2 text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer ${
                      !selectedEnv ? "text-cc-primary font-medium" : "text-cc-fg"
                    }`}
                  >
                    No environment
                  </button>
                  {envs.map((env) => (
                    <button
                      key={env.slug}
                      onClick={() => {
                        setSelectedEnv(env.slug);
                        localStorage.setItem("cc-selected-env", env.slug);
                        setShowEnvDropdown(false);
                      }}
                      className={`w-full px-3 py-2 text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer flex items-center gap-1 ${
                        env.slug === selectedEnv ? "text-cc-primary font-medium" : "text-cc-fg"
                      }`}
                    >
                      <span className="truncate">{env.name}</span>
                      <span className="text-cc-muted ml-auto shrink-0">
                        {Object.keys(env.variables).length} var{Object.keys(env.variables).length !== 1 ? "s" : ""}
                      </span>
                    </button>
                  ))}
                  <div className="border-t border-cc-border mt-1 pt-1">
                    <button
                      onClick={() => {
                        setShowEnvManager(true);
                        setShowEnvDropdown(false);
                      }}
                      className="w-full px-3 py-2 text-xs text-left text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
                    >
                      Manage environments...
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Sandbox selector */}
            <div className="relative" ref={sandboxDropdownRef}>
              <button
                onClick={() => {
                  if (!showSandboxDropdown) {
                    api.listSandboxes().then(setSandboxes).catch(() => {});
                  }
                  setShowSandboxDropdown(!showSandboxDropdown);
                }}
                aria-expanded={showSandboxDropdown}
                className={`flex items-center gap-1 px-2 py-1 text-[11px] sm:text-xs rounded-lg transition-colors cursor-pointer ${
                  sandboxEnabled
                    ? "text-cc-primary bg-cc-primary/8 hover:bg-cc-primary/12"
                    : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
                }`}
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3 h-3 opacity-60">
                  <rect x="2" y="4" width="12" height="10" rx="1.5" />
                  <path d="M5 4V2.5A1.5 1.5 0 016.5 1h3A1.5 1.5 0 0111 2.5V4" />
                </svg>
                <span className="max-w-[80px] sm:max-w-[100px] truncate">
                  {sandboxEnabled
                    ? (selectedSandbox ? sandboxes.find((s) => s.slug === selectedSandbox)?.name || "Sandbox" : "Sandbox")
                    : "Sandbox"}
                </span>
                {sandboxEnabled && sandboxImageState && sandboxImageState.status !== "idle" && (
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      sandboxImageState.status === "ready"
                        ? "bg-green-500"
                        : sandboxImageState.status === "pulling"
                          ? "bg-amber-500 animate-pulse"
                          : "bg-cc-error"
                    }`}
                    title={
                      sandboxImageState.status === "ready"
                        ? "Docker image ready"
                        : sandboxImageState.status === "pulling"
                          ? "Pulling Docker image..."
                          : `Image error: ${sandboxImageState.error || "unknown"}`
                    }
                  />
                )}
              </button>
              {showSandboxDropdown && (
                <div className="absolute left-0 bottom-full mb-1 w-56 bg-cc-card border border-cc-border rounded-[10px] shadow-lg z-10 py-1 overflow-hidden">
                  <button
                    onClick={() => {
                      setSandboxEnabled(false);
                      localStorage.setItem("cc-sandbox-enabled", "false");
                      setShowSandboxDropdown(false);
                    }}
                    className={`w-full px-3 py-2 text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer ${
                      !sandboxEnabled ? "text-cc-primary font-medium" : "text-cc-fg"
                    }`}
                  >
                    Off
                  </button>
                  <div className="border-t border-cc-border my-0.5" />
                  <button
                    onClick={() => {
                      setSandboxEnabled(true);
                      localStorage.setItem("cc-sandbox-enabled", "true");
                      setSelectedSandbox("");
                      localStorage.setItem("cc-selected-sandbox", "");
                      setShowSandboxDropdown(false);
                    }}
                    className={`w-full px-3 py-2 text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer ${
                      sandboxEnabled && !selectedSandbox ? "text-cc-primary font-medium" : "text-cc-fg"
                    }`}
                  >
                    Default (the-companion:latest)
                  </button>
                  {sandboxes.map((sb) => (
                    <button
                      key={sb.slug}
                      onClick={() => {
                        setSandboxEnabled(true);
                        localStorage.setItem("cc-sandbox-enabled", "true");
                        setSelectedSandbox(sb.slug);
                        localStorage.setItem("cc-selected-sandbox", sb.slug);
                        setShowSandboxDropdown(false);
                      }}
                      className={`w-full px-3 py-2 text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer flex items-center gap-1 ${
                        sandboxEnabled && sb.slug === selectedSandbox ? "text-cc-primary font-medium" : "text-cc-fg"
                      }`}
                    >
                      <span className="truncate">{sb.name}</span>
                    </button>
                  ))}
                  <div className="border-t border-cc-border mt-1 pt-1">
                    <a
                      href="#/sandboxes"
                      className="block w-full px-3 py-2 text-xs text-left text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
                      onClick={() => setShowSandboxDropdown(false)}
                    >
                      Manage sandboxes...
                    </a>
                  </div>
                </div>
              )}
            </div>

            {/* Spacer pushes action buttons to the right */}
            <div className="flex-1" />

            {/* Image upload */}
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center justify-center w-7 h-7 rounded-lg text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
              title="Upload image"
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
                <rect x="2" y="2" width="12" height="12" rx="2" />
                <circle cx="5.5" cy="5.5" r="1" fill="currentColor" stroke="none" />
                <path d="M2 11l3-3 2 2 3-4 4 5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>

            {/* Send button */}
            <button
              onClick={handleSend}
              disabled={!canSend}
              className={`flex items-center justify-center w-8 h-8 sm:w-9 sm:h-9 rounded-full transition-colors ${
                canSend
                  ? "bg-cc-primary hover:bg-cc-primary-hover text-white cursor-pointer"
                  : "bg-cc-hover text-cc-muted cursor-not-allowed"
              }`}
              title="Send message"
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                <path d="M3 2l11 6-11 6V9.5l7-1.5-7-1.5V2z" />
              </svg>
            </button>
          </div>
        </div>

        {/* ── Below-card controls ── */}
        <div className="mt-3 sm:mt-4 space-y-2">

          {/* Backend toggle */}
          {backends.length > 1 && (
            <div className="flex items-center justify-center">
              <div className="flex items-center bg-cc-hover/50 rounded-lg p-0.5">
                {backends.map((b) => (
                  <button
                    key={b.id}
                    onClick={() => b.available && switchBackend(b.id as BackendType)}
                    disabled={!b.available}
                    title={b.available ? b.name : `${b.name} CLI not found in PATH`}
                    className={`flex items-center gap-1 px-3 py-1.5 text-xs rounded-md transition-colors ${
                      !b.available
                        ? "text-cc-muted/40 cursor-not-allowed"
                        : backend === b.id
                          ? "bg-cc-card text-cc-fg font-medium shadow-sm cursor-pointer"
                          : "text-cc-muted hover:text-cc-fg cursor-pointer"
                    }`}
                  >
                    {b.name}
                    {!b.available && (
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3 h-3 text-cc-error/60">
                        <circle cx="8" cy="8" r="6" />
                        <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" />
                      </svg>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* ── Resume: Branch from session (Claude only) ── */}
          {backend === "claude" && (
            <div>
              <button
                type="button"
                onClick={() => setShowBranchingControls((v) => !v)}
                className={`mx-auto flex items-center gap-1.5 px-2 py-1 text-[11px] sm:text-xs rounded-md transition-colors cursor-pointer ${
                  showBranchingControls
                    ? "text-cc-primary"
                    : "text-cc-muted hover:text-cc-fg"
                }`}
                aria-expanded={showBranchingControls}
                aria-controls="branch-from-session-panel"
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5 opacity-60">
                  <path d="M5 3.5a2 2 0 110 4 2 2 0 010-4zm6 5a2 2 0 110 4 2 2 0 010-4z" />
                  <path d="M7 5.5h2.5A1.5 1.5 0 0111 7v1" strokeLinecap="round" />
                </svg>
                Branch from session
                <svg
                  viewBox="0 0 16 16"
                  fill="currentColor"
                  className={`w-3 h-3 opacity-40 transition-transform ${showBranchingControls ? "rotate-180" : ""}`}
                >
                  <path d="M4 6l4 4 4-4" />
                </svg>
              </button>

              {/* Accordion panel for branch-from-session */}
              <div
                className="accordion-panel"
                data-open={showBranchingControls ? "true" : "false"}
              >
                <div className="accordion-inner" inert={!showBranchingControls || undefined}>
                  <div
                    id="branch-from-session-panel"
                    className="mt-2 px-1 sm:px-2 py-2 space-y-2 rounded-xl border border-cc-border/20 bg-cc-card/30"
                  >
                        <div className="flex flex-wrap items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => void loadResumeCandidates()}
                            disabled={resumeCandidatesLoading}
                            className="px-2 py-1 rounded-md text-[11px] bg-cc-hover text-cc-muted hover:text-cc-fg transition-colors disabled:opacity-60 cursor-pointer"
                          >
                            {resumeCandidatesLoading ? "Refreshing..." : "Refresh detected sessions"}
                          </button>
                          {resumeCandidates.length > 0 && (
                            <span className="text-[11px] text-cc-muted">
                              Showing {visibleResumeCandidates.length} of {filteredActiveResumeCandidates.length}{" "}
                              {normalizedResumeSearchQuery
                                ? "matching"
                                : (showingRecentOnly ? "recent" : "detected")} Claude session{filteredActiveResumeCandidates.length !== 1 ? "s" : ""}.
                            </span>
                          )}
                          {!showOlderResumeCandidates && hiddenOlderResumeCount > 0 && recentResumeCandidates.length > 0 && (
                            <button
                              type="button"
                              onClick={() => {
                                setShowOlderResumeCandidates(true);
                                setVisibleResumeCandidateRows(INITIAL_VISIBLE_SESSION_ROWS);
                              }}
                              className="px-2 py-1 rounded-md text-[11px] bg-cc-hover text-cc-muted hover:text-cc-fg transition-colors cursor-pointer"
                            >
                              Include older ({hiddenOlderResumeCount})
                            </button>
                          )}
                          {showOlderResumeCandidates && recentResumeCandidates.length > 0 && (
                            <button
                              type="button"
                              onClick={() => {
                                setShowOlderResumeCandidates(false);
                                setVisibleResumeCandidateRows(INITIAL_VISIBLE_SESSION_ROWS);
                              }}
                              className="px-2 py-1 rounded-md text-[11px] bg-cc-hover text-cc-muted hover:text-cc-fg transition-colors cursor-pointer"
                            >
                              Recent only
                            </button>
                          )}
                        </div>
                        <label className="block">
                          <span className="sr-only">Search sessions</span>
                          <div className="relative">
                            <svg
                              viewBox="0 0 16 16"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.5"
                              className="w-3.5 h-3.5 text-cc-muted absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
                            >
                              <circle cx="7" cy="7" r="4.25" />
                              <path d="M10.25 10.25L14 14" strokeLinecap="round" />
                            </svg>
                            <input
                              type="text"
                              value={resumeSearchQuery}
                              onChange={(e) => setResumeSearchQuery(e.target.value)}
                              placeholder="Search sessions, branch, folder, or ID"
                              className="w-full bg-cc-card border border-cc-border rounded-md pl-8 pr-2.5 py-1.5 text-xs text-cc-fg placeholder:text-cc-muted focus:outline-none focus:ring-1 focus:ring-cc-primary/40 focus:border-cc-primary/40"
                            />
                          </div>
                        </label>
                        <p className="text-[11px] text-cc-muted">
                          <span className="font-medium text-cc-fg">Fork</span> opens a new session that leaves the original untouched.
                          <span className="mx-1">•</span>
                          <span className="font-medium text-cc-fg">Continue</span> opens from the same linear thread.
                        </p>
                        {resumeCandidatesError && (
                          <p className="text-[11px] text-cc-error">{resumeCandidatesError}</p>
                        )}
                        {!resumeCandidatesLoading && !resumeCandidatesError && filteredActiveResumeCandidates.length === 0 && (
                          <p className="text-[11px] text-cc-muted">
                            {normalizedResumeSearchQuery
                              ? "No sessions match this search."
                              : "No Claude sessions detected yet."}
                          </p>
                        )}
                        {visibleResumeCandidates.length > 0 && (
                          <div className="rounded-md border border-cc-border overflow-hidden bg-cc-card/50">
                            <div className="hidden sm:grid sm:grid-cols-[minmax(0,1.5fr)_minmax(0,1.2fr)_minmax(0,0.8fr)_minmax(0,0.7fr)_auto] px-2.5 py-1.5 border-b border-cc-border text-[10px] uppercase tracking-wider text-cc-muted">
                              <span>Session</span>
                              <span>Project</span>
                              <span>Branch</span>
                              <span>Last active</span>
                              <span className="text-right">Action</span>
                            </div>
                            <div className="divide-y divide-cc-border/50">
                              {visibleResumeCandidates.map((candidate) => {
                                const title = getResumeCandidateTitle(candidate);
                                const project = getResumeCandidateProject(candidate.cwd);
                                const sourceLabel = candidate.source === "companion" ? "Companion" : "Claude";
                                const selected = trimmedResumeSessionAt === candidate.resumeSessionId;
                                return (
                                  <div
                                    key={`${candidate.resumeSessionId}-row-${candidate.sessionId}`}
                                    className="px-2 py-2 sm:px-2.5 sm:py-2.5 grid grid-cols-1 gap-1.5 sm:gap-2 sm:grid-cols-[minmax(0,1.5fr)_minmax(0,1.2fr)_minmax(0,0.8fr)_minmax(0,0.7fr)_auto] sm:items-center"
                                  >
                                    <div className="min-w-0">
                                      <p className={`text-xs truncate ${selected ? "text-cc-primary font-medium" : "text-cc-fg"}`}>
                                        {title}
                                      </p>
                                      <div className="mt-0.5 flex items-center gap-1.5 text-[10px]">
                                        <span className="font-mono-code text-cc-muted">{shortSessionId(candidate.resumeSessionId)}</span>
                                        <span className="px-1 py-0.5 rounded bg-cc-hover text-cc-muted">{sourceLabel}</span>
                                      </div>
                                    </div>
                                    <div className="min-w-0 text-[11px] text-cc-muted sm:font-mono-code truncate" title={candidate.cwd}>
                                      <div className="truncate">{project}</div>
                                      <div className="mt-0.5 text-[10px] text-cc-muted/70 truncate" title={candidate.cwd}>
                                        {formatPathTail(candidate.cwd)}
                                      </div>
                                    </div>
                                    <div className="text-[11px] text-cc-muted sm:font-mono-code truncate">
                                      {candidate.gitBranch || "\u2014"}
                                    </div>
                                    <div className="text-[11px] text-cc-muted">
                                      {formatTimeAgo(candidate.createdAt)}
                                    </div>
                                    <div className="sm:text-right flex gap-1.5 sm:justify-end">
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setResumeSessionAt(candidate.resumeSessionId);
                                          setForkSession(true);
                                          void handleOpenBranchedSession(candidate, true);
                                        }}
                                        aria-label={`Fork and open ${title}`}
                                        className={`px-2 py-1 rounded-md text-[11px] border transition-colors cursor-pointer ${
                                          selected && forkSession
                                            ? "border-cc-primary/40 bg-cc-primary/10 text-cc-primary"
                                            : "border-cc-border bg-cc-card text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
                                        }`}
                                        title={`Fork and open now\n${candidate.cwd}${candidate.gitBranch ? ` (${candidate.gitBranch})` : ""}\n${candidate.resumeSessionId}`}
                                      >
                                        Fork
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setResumeSessionAt(candidate.resumeSessionId);
                                          setForkSession(false);
                                          void handleOpenBranchedSession(candidate, false);
                                        }}
                                        aria-label={`Continue and open ${title}`}
                                        className={`px-2 py-1 rounded-md text-[11px] border transition-colors cursor-pointer ${
                                          selected && !forkSession
                                            ? "border-cc-primary/40 bg-cc-primary/10 text-cc-primary"
                                            : "border-cc-border bg-cc-card text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
                                        }`}
                                        title={`Continue and open now\n${candidate.resumeSessionId}`}
                                      >
                                        Continue
                                      </button>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                            {hasMoreResumeCandidates && (
                              <div className="px-2.5 py-2 border-t border-cc-border bg-cc-card/40">
                                <button
                                  type="button"
                                  onClick={() =>
                                    setVisibleResumeCandidateRows((count) =>
                                      Math.min(count + LOAD_MORE_SESSION_ROWS, filteredActiveResumeCandidates.length)
                                    )}
                                  className="px-2 py-1 rounded-md text-[11px] bg-cc-hover text-cc-muted hover:text-cc-fg transition-colors cursor-pointer"
                                >
                                  Load more ({filteredActiveResumeCandidates.length - visibleResumeCandidateRows} remaining)
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                        <p className="text-[11px] text-cc-muted">
                          Fork/Continue opens the session immediately, then you can type directly in chat.
                          Send from Home still starts a normal new session with your typed prompt.
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
            )}



            {/* Onboarding tip — shown once for new users */}
            {showOnboardingTip && (
              <div className="flex items-start gap-2 px-3 py-2 rounded-xl bg-cc-primary/5 border border-cc-primary/10 text-[11px] text-cc-muted">
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-cc-primary/60 shrink-0 mt-0.5">
                  <path d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM0 8a8 8 0 1116 0A8 8 0 010 8zm6.5-.25A.75.75 0 017.25 7h1a.75.75 0 01.75.75v2.75h.25a.75.75 0 010 1.5h-2a.75.75 0 010-1.5h.25v-2h-.25a.75.75 0 01-.75-.75zM8 6a1 1 0 110-2 1 1 0 010 2z" />
                </svg>
                <span className="flex-1">
                  The toolbar sets where your code lives, which model to use, and how the session runs.
                  {backend === "claude" && (
                    <>{" "}<strong className="text-cc-fg">Branch from session</strong> below lets you fork or continue a previous Claude session.</>
                  )}
                </span>
                <button
                  onClick={() => {
                    setShowOnboardingTip(false);
                    localStorage.setItem("cc-onboarding-dismissed", "true");
                  }}
                  className="shrink-0 w-5 h-5 flex items-center justify-center rounded text-cc-muted hover:text-cc-fg transition-colors cursor-pointer"
                  aria-label="Dismiss onboarding tip"
                >
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="w-3 h-3">
                    <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
            )}

            <LinearSection
              cwd={cwd}
              gitRepoInfo={gitRepoInfo}
              linearConfigured={linearConfigured}
              selectedLinearIssue={selectedLinearIssue}
              onIssueSelect={handleIssueSelect}
              onBranchFromIssue={handleBranchFromIssue}
              onConnectionSelect={setSelectedLinearConnectionId}
            />
          </div>

        {/* Branch behind remote warning */}
        {pullPrompt && (
          <div className="mt-3 p-3 rounded-[10px] bg-amber-500/10 border border-amber-500/20">
            <div className="flex items-start gap-2.5">
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 text-amber-500 shrink-0 mt-0.5">
                <path d="M8.982 1.566a1.13 1.13 0 00-1.96 0L.165 13.233c-.457.778.091 1.767.98 1.767h13.713c.889 0 1.438-.99.98-1.767L8.982 1.566zM8 5c.535 0 .954.462.9.995l-.35 3.507a.552.552 0 01-1.1 0L7.1 5.995A.905.905 0 018 5zm.002 6a1 1 0 110 2 1 1 0 010-2z" />
              </svg>
              <div className="flex-1 min-w-0">
                <p className="text-xs text-cc-fg leading-snug">
                  <span className="font-mono-code font-medium">{pullPrompt.branchName}</span> is{" "}
                  <span className="font-semibold text-amber-500">{pullPrompt.behind} commit{pullPrompt.behind !== 1 ? "s" : ""} behind</span>{" "}
                  remote. Pull before starting?
                </p>
                {pullError && (
                  <div className="mt-2 px-2 py-1.5 rounded-md bg-cc-error/10 border border-cc-error/20 text-[11px] text-cc-error font-mono-code whitespace-pre-wrap">
                    {pullError}
                  </div>
                )}
                <div className="flex flex-wrap gap-2 mt-2.5">
                  <button
                    onClick={handleCancelPull}
                    disabled={pulling}
                    className="px-2.5 py-1 text-[11px] font-medium rounded-md bg-cc-hover text-cc-muted hover:text-cc-fg transition-colors cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSkipPull}
                    disabled={pulling}
                    className="px-2.5 py-1 text-[11px] font-medium rounded-md bg-cc-hover text-cc-muted hover:text-cc-fg transition-colors cursor-pointer"
                  >
                    Continue anyway
                  </button>
                  <button
                    onClick={handlePullAndContinue}
                    disabled={pulling}
                    className="px-2.5 py-1 text-[11px] font-medium rounded-md bg-cc-primary/15 text-cc-primary hover:bg-cc-primary/25 transition-colors cursor-pointer flex items-center gap-1.5"
                  >
                    {pulling ? (
                      <>
                        <span className="w-3 h-3 border-2 border-cc-primary/30 border-t-cc-primary rounded-full animate-spin" />
                        Pulling...
                      </>
                    ) : (
                      "Pull and continue"
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Error message */}
        {error && (
          <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-cc-error/5 border border-cc-error/20">
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-cc-error shrink-0">
              <path fillRule="evenodd" d="M8 15A7 7 0 108 1a7 7 0 000 14zm1-3a1 1 0 11-2 0 1 1 0 012 0zM7.5 5.5a.5.5 0 011 0v3a.5.5 0 01-1 0v-3z" clipRule="evenodd" />
            </svg>
            <p className="text-xs text-cc-error">{error}</p>
          </div>
        )}
      </div>

      {/* Environment manager modal */}
      {showEnvManager && (
        <EnvManager
          onClose={() => {
            setShowEnvManager(false);
            api.listEnvs().then(setEnvs).catch(() => {});
          }}
        />
      )}
    </div>
  );
}
