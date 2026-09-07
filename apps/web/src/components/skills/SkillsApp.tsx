/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- Hosted Companion removal preserves the existing Skills Hub implementation; these patterns predate this change. */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  GettingStartedState,
  LabelColor,
  LabelIcon,
  LabelsResponse,
  LabelVM,
  LocalSkillRow,
  SkillFilterPreferences,
  SkillGroupBy,
  SkillSidebarOrder,
  SkillSharePlan,
  BillingOverview,
} from "@companion/contracts";
import {
  archiveSkill as archiveSkillRpc,
  assignSkillLabel,
  createLabel as createLabelRpc,
  deleteLabel as deleteLabelRpc,
  fetchArchivedSkills,
  fetchSkillDownloadUrl,
  fetchSkillLibrary,
  markSkillInstalled,
  markSkillUninstalled,
  renameLabel as renameLabelRpc,
  restoreSkill as restoreSkillRpc,
  saveSkillFilterPreferences,
  setLabelColor as setLabelColorRpc,
  setLabelIcon as setLabelIconRpc,
  unassignSkillLabel,
} from "@/lib/queries";
import { fetchSettingsAppData } from "@/lib/settingsClient";
import { mapSkill, type MeVM, type OrgVM, type SkillVM } from "@/lib/types";
import { Sidebar } from "./Sidebar";
import { ListView } from "./ListView";
import { SkillPanel } from "./SkillPanel";
import { treeRowKey } from "./dragGeometry";
import { useSkillDrag, type PointerLike } from "./useSkillDrag";
import { ArchivedListView } from "./ArchivedListView";
import { DetailView } from "./DetailView";
import { LocalSkillsView } from "./LocalSkillsView";
import { GettingStartedCard } from "./GettingStartedCard";
import { CommandPalette } from "./CommandPalette";
import { UploadDialog, InstallDialog } from "./UploadDialog";
import {
  parseSkillsRoute,
  canonicalSkillsRouteHref,
  skillShareHref,
  skillsRouteHref,
  skillsRouteKey,
  skillsRouteSource,
  skillsRouteWithSkill,
  skillsRouteWithoutSkill,
  type SkillsLibrary,
  type SkillsRoute,
  type SkillsRouteSource,
} from "./route";
import { ShareDialog } from "./ShareDialog";
import { PublicReleaseDialog } from "./PublicReleaseDialog";
import {
  assignPersonalSkillLabel,
  createPersonalLabel as createPersonalLabelRpc,
  deletePersonalLabel as deletePersonalLabelRpc,
  renamePersonalLabel as renamePersonalLabelRpc,
  setPersonalLabelColor as setPersonalLabelColorRpc,
  setPersonalLabelIcon as setPersonalLabelIconRpc,
  shareSkillToOrg,
  unassignPersonalSkillLabel,
} from "@/lib/queries";
import { Onboarding } from "../org/Onboarding";
import { settingsHref } from "../org/SettingsApp";
import { SettingsDrawer, SettingsDrawerError } from "../org/SettingsDrawer";
import { useOrgActions } from "../org/useOrgActions";
import { parseSettingsView } from "../org/model";
import type { SettingsAppData, SettingsDialog, SettingsIntent, SettingsRoute, SettingsView } from "../org/model";
import { matchFilters, type Filter } from "./filters";
import { deriveTreeRows, remapTreeOrder, removeTreeOrderPath, reorderTreeRows } from "./sidebarTree";
import type { TreeRow } from "./sidebarTree";
import type { SkillAction } from "./skillActions";

const SETTINGS_LOAD_ERROR =
  "Refresh the page to try again. If the problem continues, check that the API and database are reachable.";

type SettingsState = {
  initialRoute: SettingsRoute;
  initialDialog: SettingsDialog;
};

type LocalSettingsSurface =
  | ({ kind: "ready"; data: SettingsAppData } & SettingsState)
  | ({ kind: "error"; message: string; busy: boolean } & SettingsState);

function settingsStateFromIntent(intent?: SettingsIntent): SettingsState {
  const view: SettingsView = intent?.view ?? "profile";
  return {
    initialRoute: { view },
    initialDialog: intent?.dialog ?? null,
  };
}

function settingsStateFromSearch(search: string): SettingsState {
  const params = new URLSearchParams(search);
  // Shared parser (org/model.ts): whitelist settings destinations.
  const view: SettingsView = parseSettingsView(params.get("view"));
  const dialogRaw = params.get("dialog");
  return {
    initialRoute: { view },
    initialDialog: dialogRaw === "invite" ? dialogRaw : null,
  };
}

function settingsErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : SETTINGS_LOAD_ERROR;
}

/* --- Label tree derivation -------------------------------------------------- */

/**
 * One flattened node of the derived label tree (depth-ordered, stable lexicographic sort). Derived
 * in the client from skills + explicit `labels` rows so optimistic assigns / renames re-derive
 * without a refetch.
 */
type ScopeKind = "all" | "installed" | "label";
/** The active workspace slice: a library (`mine`/`org`) + a kind within it. */
type Selection = { lib: SkillsLibrary; kind: ScopeKind; label?: string };

export type DragItem =
  | { kind: "skill"; lib: SkillsLibrary; skillId: string; sourceLabel: string | null }
  | { kind: "label"; lib: SkillsLibrary; path: string; leaf: string };

/**
 * Derive the flattened label tree from the live skills + explicit label appearances. Intermediate
 * parents are synthesized; roll-up counts are de-duped per skill (a skill filed under `a/b` counts
 * once for `a` and once for `a/b`). Sorted lexicographically by path for a stable (hydration-safe)
 * order regardless of insertion order.
 */
/** Whether a skill is filed under `path` OR any descendant of it. */
function skillUnderLabel(skill: SkillVM, path: string): boolean {
  return (skill.labels ?? []).some((p) => p === path || p.startsWith(path + "/"));
}

/**
 * Does a skill belong to the active slice? The skill set is already library-filtered, so this only
 * narrows within the library: installed (a `source: installed` row) / filed
 * under the selected folder. Installed skills carry no personal folders, so a `label` slice naturally
 * shows only authored personal skills.
 */
function skillInSelection(skill: SkillVM, selection: Selection): boolean {
  if (selection.kind === "installed") return skill.source === "installed";
  if (selection.kind === "label") return selection.label ? skillUnderLabel(skill, selection.label) : true;
  return true;
}

type SkillsView = "workspace" | "local" | "archived";

function selectionFromRoute(route: SkillsRoute): Selection {
  if (route.kind === "installed") return { lib: "mine", kind: "installed" };
  if (route.kind === "label") return { lib: route.lib, kind: "label", label: route.label };
  if (route.kind === "all") return { lib: route.lib, kind: "all" };
  // local / archived have no workspace selection — default to My Skills behind the scenes.
  return { lib: "mine", kind: "all" };
}

function skillsViewForRoute(route: SkillsRoute): SkillsView {
  if (route.kind === "local") return "local";
  if (route.kind === "archived") return "archived";
  return "workspace";
}

function routeFromSelection(selection: Selection, skill?: string): SkillsRoute {
  let route: SkillsRoute;
  if (selection.kind === "installed") route = { lib: "mine", kind: "installed" };
  else if (selection.kind === "label" && selection.label) route = { lib: selection.lib, kind: "label", label: selection.label };
  else route = { lib: selection.lib, kind: "all" };
  return skill ? skillsRouteWithSkill(route, skill) : route;
}

function restoreRowAtSnapshot<T extends { id: string }>(
  current: T[],
  row: T | undefined,
  index: number,
): T[] {
  if (!row || current.some((candidate) => candidate.id === row.id)) return current;
  const next = [...current];
  next.splice(Math.min(Math.max(index, 0), next.length), 0, row);
  return next;
}

function isSkillsClientPath(pathname: string): boolean {
  return pathname === "/skills";
}

export function SkillsApp({
  initialMineSkills,
  initialOrgSkills,
  initialLocalSkills,
  initialFilterPreferences,
  initialPersonalLabels,
  initialLabels,
  initialBilling,
  initialGettingStarted = null,
  me,
  orgs,
  currentOrg,
  initialRoute,
  initialRouteSource,
}: {
  initialMineSkills: SkillVM[];
  initialOrgSkills: SkillVM[];
  initialLocalSkills: LocalSkillRow[];
  initialFilterPreferences: SkillFilterPreferences;
  initialPersonalLabels: LabelsResponse;
  initialLabels: LabelsResponse;
  initialBilling: BillingOverview;
  initialGettingStarted?: GettingStartedState | null;
  me: MeVM;
  orgs: OrgVM[];
  currentOrg: OrgVM;
  initialRoute: SkillsRoute;
  initialRouteSource: SkillsRouteSource;
}) {
  const router = useRouter();
  const orgActions = useOrgActions();
  const settingsWarmupRef = useRef<{ orgId: string; promise: Promise<SettingsAppData> } | null>(null);
  const [localSettings, setLocalSettings] = useState<LocalSettingsSurface | null>(null);
  // Two libraries held side by side: My Skills (authored personal + installed org) and the org library;
  // each with its own folder appearances. The active set is derived from `selection.lib` below.
  const [mineSkills, setMineSkills] = useState<SkillVM[]>(initialMineSkills);
  const [orgSkills, setOrgSkills] = useState<SkillVM[]>(initialOrgSkills);
  const [personalLabels, setPersonalLabels] = useState<LabelVM[]>(initialPersonalLabels.flat);
  const [orgLabels, setOrgLabels] = useState<LabelVM[]>(initialLabels.flat);
  const [localSkills, setLocalSkills] = useState<LocalSkillRow[]>(initialLocalSkills);
  const companionLocalSkill = useMemo(
    () => localSkills.find((row) => row.key === "companion") ?? null,
    [localSkills],
  );
  const [currentView, setCurrentView] = useState<SkillsView>(() => skillsViewForRoute(initialRoute));
  const [archivedSkills, setArchivedSkills] = useState<SkillVM[]>([]);
  const [archivedLoaded, setArchivedLoaded] = useState(false);
  const [selection, setSelection] = useState<Selection>(() => selectionFromRoute(initialRoute));
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [filters, setFilters] = useState<Filter[]>(() => initialFilterPreferences.active_filters);
  const [groupBy, setGroupBy] = useState<SkillGroupBy>(() => initialFilterPreferences.group_by);
  const [sidebarOrder, setSidebarOrder] = useState<SkillSidebarOrder>(() => initialFilterPreferences.sidebar_order);
  const [shareTarget, setShareTarget] = useState<SkillVM | null>(null);
  const [drag, setDrag] = useState<DragItem | null>(null);
  const personalSkillsEnabled = initialBilling.entitlements.personalSkills;
  const orgSkillLimit = initialBilling.entitlements.orgSkillLimit;
  const orgCreateBlocked = orgSkillLimit !== null && initialBilling.orgSkillCount >= orgSkillLimit;

  const activeLib: SkillsLibrary = selection.lib;
  const skills = activeLib === "org" ? orgSkills : mineSkills;
  const labels = activeLib === "org" ? orgLabels : personalLabels;

  // Synchronous mirrors for optimistic handlers (StrictMode-safe: read current state via the ref,
  // never gate an RPC on a flag set inside a setState updater — the double-invoke would drop it).
  const mineSkillsRef = useRef<SkillVM[]>(initialMineSkills);
  const orgSkillsRef = useRef<SkillVM[]>(initialOrgSkills);
  const archivedSkillsRef = useRef<SkillVM[]>([]);
  const refreshGenerationRef = useRef(0);
  const installCorrectionOpsRef = useRef(new Map<string, symbol>());
  const personalLabelsRef = useRef<LabelVM[]>(initialPersonalLabels.flat);
  const orgLabelsRef = useRef<LabelVM[]>(initialLabels.flat);
  const activeLibRef = useRef<SkillsLibrary>(activeLib);
  const dragRef = useRef<DragItem | null>(null);
  const sidebarOrderRef = useRef<SkillSidebarOrder>(initialFilterPreferences.sidebar_order);
  mineSkillsRef.current = mineSkills;
  orgSkillsRef.current = orgSkills;
  archivedSkillsRef.current = archivedSkills;
  personalLabelsRef.current = personalLabels;
  orgLabelsRef.current = orgLabels;
  activeLibRef.current = activeLib;
  sidebarOrderRef.current = sidebarOrder;

  const refreshSkillLibraries = useCallback(async () => {
    const generation = refreshGenerationRef.current + 1;
    refreshGenerationRef.current = generation;
    const [mineRows, orgRows] = await Promise.all([fetchSkillLibrary("mine"), fetchSkillLibrary("org")]);
    const nextMineSkills = mineRows.map(mapSkill);
    const nextOrgSkills = orgRows.map(mapSkill);
    // Multiple successful mutations may refetch concurrently. Only the latest-started refresh may
    // replace the client snapshot, otherwise an older response can resurrect stale rows/statuses.
    if (generation !== refreshGenerationRef.current) {
      return { mine: mineSkillsRef.current, org: orgSkillsRef.current };
    }
    mineSkillsRef.current = nextMineSkills;
    orgSkillsRef.current = nextOrgSkills;
    setMineSkills(nextMineSkills);
    setOrgSkills(nextOrgSkills);
    return { mine: nextMineSkills, org: nextOrgSkills };
  }, []);

  useEffect(() => setMineSkills(initialMineSkills), [initialMineSkills]);
  useEffect(() => setOrgSkills(initialOrgSkills), [initialOrgSkills]);
  useEffect(() => setPersonalLabels(initialPersonalLabels.flat), [initialPersonalLabels]);
  useEffect(() => setOrgLabels(initialLabels.flat), [initialLabels]);
  useEffect(() => setLocalSkills(initialLocalSkills), [initialLocalSkills]);
  useEffect(() => {
    document.cookie = `companion_org=${encodeURIComponent(currentOrg.id)}; path=/; SameSite=Lax`;
  }, [currentOrg.id]);

  const loadSettingsData = useCallback(async () => {
    const data = await fetchSettingsAppData({ me, currentOrg });
    if (!data) throw new Error(SETTINGS_LOAD_ERROR);
    return data;
  }, [currentOrg, me]);

  const warmSettings = useCallback(() => {
    const cached = settingsWarmupRef.current;
    if (cached?.orgId === currentOrg.id) return cached.promise;
    const promise = loadSettingsData();
    settingsWarmupRef.current = { orgId: currentOrg.id, promise };
    promise.catch(() => {
      if (settingsWarmupRef.current?.promise === promise) settingsWarmupRef.current = null;
    });
    return promise;
  }, [currentOrg.id, loadSettingsData]);

  const refreshLocalSettingsData = useCallback(async () => {
    const data = await loadSettingsData();
    settingsWarmupRef.current = { orgId: currentOrg.id, promise: Promise.resolve(data) };
    setLocalSettings((surface) => (surface?.kind === "ready" ? { ...surface, data } : surface));
    return data;
  }, [currentOrg.id, loadSettingsData]);

  const showLocalSettings = useCallback(
    (state: SettingsState, pushHistory: boolean) => {
      void warmSettings()
        .then((data) => {
          if (!pushHistory && window.location.pathname !== "/settings") return;
          if (pushHistory) {
            window.history.pushState(window.history.state, "", settingsHref(state.initialRoute, state.initialDialog));
          }
          setLocalSettings({ kind: "ready", data, ...state });
        })
        .catch((error) => {
          if (!pushHistory && window.location.pathname !== "/settings") return;
          if (pushHistory) {
            window.history.pushState(window.history.state, "", settingsHref(state.initialRoute, state.initialDialog));
          }
          setLocalSettings({ kind: "error", message: settingsErrorMessage(error), busy: false, ...state });
        });
    },
    [warmSettings],
  );

  const openSettings = useCallback(
    (intent?: SettingsIntent) => {
      showLocalSettings(settingsStateFromIntent(intent), true);
    },
    [showLocalSettings],
  );

  const retryLocalSettings = useCallback(() => {
    const surface = localSettings;
    if (!surface || surface.kind !== "error") return;
    const state = { initialRoute: surface.initialRoute, initialDialog: surface.initialDialog };
    setLocalSettings({ ...surface, busy: true });
    void loadSettingsData()
      .then((data) => {
        settingsWarmupRef.current = { orgId: currentOrg.id, promise: Promise.resolve(data) };
        window.history.replaceState(window.history.state, "", settingsHref(state.initialRoute, state.initialDialog));
        setLocalSettings({ kind: "ready", data, ...state });
      })
      .catch((error) => {
        setLocalSettings({ kind: "error", message: settingsErrorMessage(error), busy: false, ...state });
      });
  }, [currentOrg.id, loadSettingsData, localSettings]);

  useEffect(() => {
    settingsWarmupRef.current = null;
    setLocalSettings(null);
  }, [currentOrg.id]);

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [updateSkill, setUpdateSkill] = useState<SkillVM | null>(null);
  const [publicReleaseSkill, setPublicReleaseSkill] = useState<SkillVM | null>(null);
  const [installSkill, setInstallSkill] = useState<SkillVM | null>(null);
  const [labelNotice, setLabelNotice] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(() =>
    initialRoute.kind === "local" ? null : initialRoute.skill ?? null,
  );
  const [lastId, setLastId] = useState<string | null>(() =>
    initialRoute.kind === "local" ? null : initialRoute.skill ?? null,
  );
  /**
   * The row whose detail is in the panel beside the list, by database id rather than slug: the same
   * slug can exist in both My Skills and Organization, and a selection has to mean one row. It is
   * deliberately not in the URL — a glance at a row is not a place to come back to; opening one is,
   * and that is what the full page is for.
   */
  const [selectedUuid, setSelectedUuid] = useState<string | null>(null);
  const [preferenceStatus, setPreferenceStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [toast, setToast] = useState<{ msg: string; undo?: () => void } | null>(null);
  const openIdRef = useRef<string | null>(null);
  const uploadReturnRef = useRef<HTMLElement | null>(null);
  const didInitializePersistenceRef = useRef(false);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistInFlightRef = useRef(false);
  const queuedPreferencesRef = useRef<SkillFilterPreferences | null>(null);
  const skipNextDebouncedPersistRef = useRef(false);
  const preferenceKey = JSON.stringify(initialFilterPreferences);
  const effectiveInitialRouteKey = skillsRouteKey(initialRoute);

  useEffect(() => {
    router.prefetch("/secrets");
  }, [router]);

  const shareableSkillForSlug = useCallback((slug: string): SkillVM | null => {
    const isShareable = (s: SkillVM) => s.id === slug && s.scope === "org" && !s.archived;
    return orgSkillsRef.current.find(isShareable) ?? mineSkillsRef.current.find(isShareable) ?? null;
  }, []);

  const hrefForSkillsRoute = useCallback(
    (route: SkillsRoute): string => canonicalSkillsRouteHref(route),
    [],
  );

  const writeSkillsUrl = useCallback((route: SkillsRoute, history: "push" | "replace") => {
    if (typeof window === "undefined" || !isSkillsClientPath(window.location.pathname)) return;
    const href = hrefForSkillsRoute(route);
    const currentHref = `${window.location.pathname}${window.location.search}`;
    if (currentHref === href) return;
    const hasSkill = route.kind !== "local" && !!route.skill;
    const currentState =
      window.history.state && typeof window.history.state === "object"
        ? (window.history.state as Record<string, unknown>)
        : {};
    const { companionSkillsDetail: _detail, ...listState } = currentState;
    if (history === "push") {
      window.history.pushState(hasSkill ? { ...listState, companionSkillsDetail: true } : listState, "", href);
    } else {
      window.history.replaceState(hasSkill ? currentState : listState, "", href);
    }
  }, [hrefForSkillsRoute]);
  const replaceSkillsUrl = useCallback((route: SkillsRoute) => writeSkillsUrl(route, "replace"), [writeSkillsUrl]);
  const pushSkillsUrl = useCallback((route: SkillsRoute) => writeSkillsUrl(route, "push"), [writeSkillsUrl]);
  const clearCurrentSkillUrl = useCallback(() => {
    if (typeof window === "undefined" || !isSkillsClientPath(window.location.pathname)) return;
    replaceSkillsUrl(skillsRouteWithoutSkill(parseSkillsRoute(window.location.search)));
  }, [replaceSkillsUrl]);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 820px)");
    const sync = () => {
      if (!query.matches) setMobileSidebarOpen(false);
    };
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  // Re-derive selection / open skill / view when the server route (or org) changes.
  useEffect(() => {
    setFilters(initialFilterPreferences.active_filters);
    setGroupBy(initialFilterPreferences.group_by);
    setSidebarOrder(initialFilterPreferences.sidebar_order);
    sidebarOrderRef.current = initialFilterPreferences.sidebar_order;
    setSelection(selectionFromRoute(initialRoute));
    didInitializePersistenceRef.current = false;
    setPreferenceStatus("idle");
    setOpenId(initialRoute.kind === "local" ? null : initialRoute.skill ?? null);
    setLastId(initialRoute.kind === "local" ? null : initialRoute.skill ?? null);
    setCurrentView(skillsViewForRoute(initialRoute));
    if (typeof window !== "undefined" && isSkillsClientPath(window.location.pathname)) {
      replaceSkillsUrl(initialRoute);
    }
  }, [
    currentOrg.id,
    effectiveInitialRouteKey,
    initialRoute,
    initialFilterPreferences,
    preferenceKey,
    replaceSkillsUrl,
  ]);

  const flushPreferenceQueue = useCallback(async () => {
    if (persistInFlightRef.current) return;
    persistInFlightRef.current = true;
    try {
      while (queuedPreferencesRef.current) {
        const next = queuedPreferencesRef.current;
        queuedPreferencesRef.current = null;
        try {
          setPreferenceStatus("saving");
          await saveSkillFilterPreferences(next);
          if (!queuedPreferencesRef.current) setPreferenceStatus("saved");
        } catch (error) {
          // A complete newer snapshot may have arrived while this request was in flight.
          // Keep that newest intent; only restore the failed snapshot when nothing superseded it.
          if (!queuedPreferencesRef.current) queuedPreferencesRef.current = next;
          setPreferenceStatus("error");
          console.error("Could not save skill filter preferences", error);
          break;
        }
      }
    } finally {
      persistInFlightRef.current = false;
    }
  }, []);

  const persistPreferences = useCallback((
    activeFilters: Filter[],
    nextGroupBy: SkillGroupBy,
    nextSidebarOrder: SkillSidebarOrder,
  ) => {
    queuedPreferencesRef.current = {
      active_filters: activeFilters.map((f) => ({ ...f })),
      group_by: nextGroupBy,
      sidebar_order: { mine: [...nextSidebarOrder.mine], org: [...nextSidebarOrder.org] },
    };
    void flushPreferenceQueue();
  }, [flushPreferenceQueue]);

  useEffect(() => {
    if (!didInitializePersistenceRef.current) {
      didInitializePersistenceRef.current = true;
      return;
    }
    if (skipNextDebouncedPersistRef.current) {
      skipNextDebouncedPersistRef.current = false;
      return;
    }
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => persistPreferences(filters, groupBy, sidebarOrder), 350);
    return () => {
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    };
  }, [filters, groupBy, persistPreferences, sidebarOrder]);

  const openUpload = useCallback(() => {
    if ((!personalSkillsEnabled && activeLibRef.current === "mine") || (orgCreateBlocked && activeLibRef.current === "org")) {
      openSettings({ view: "billing" });
      return;
    }
    uploadReturnRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setUploadOpen(true);
  }, [openSettings, orgCreateBlocked, personalSkillsEnabled]);
  const closeUpload = useCallback(() => {
    setUploadOpen(false);
    queueMicrotask(() => uploadReturnRef.current?.focus());
  }, []);

  /**
   * Install an org skill into My Skills, or remove it. Updates the org row's status AND mirrors a
   * `source: installed` copy in the My-Skills set so it appears under My Skills → Installed immediately
   * (and the Installed nav count + update dot react). Optimistic, with an Undo toast. No refresh.
   */
  const setInstalled = useCallback(
    (id: string, installed: boolean) => {
      const orgRow = orgSkillsRef.current.find((s) => s.id === id) ?? mineSkillsRef.current.find((s) => s.id === id);
      if (!orgRow) return;
      const markVersion = orgRow.version ?? null;
      const prevOrg = { status: orgRow.installStatus, version: orgRow.installedVersion };
      const prevMine = mineSkillsRef.current;
      const prevMineRow = prevMine.find((row) => row.id === id && row.source === "installed");
      const prevMineIndex = prevMine.findIndex((row) => row.id === id && row.source === "installed");
      const operation = Symbol(id);
      installCorrectionOpsRef.current.set(id, operation);
      // Org row: reflect the new install status.
      const nextOrg = orgSkillsRef.current.map((s) =>
        s.id === id
          ? installed
            ? { ...s, installStatus: "installed" as const, installedVersion: markVersion }
            : { ...s, installStatus: "none" as const, installedVersion: null }
          : s,
      );
      orgSkillsRef.current = nextOrg;
      setOrgSkills(nextOrg);
      // My-Skills mirror: add an installed copy, or drop it.
      const nextMine: SkillVM[] = !installed
        ? prevMine.filter((s) => !(s.id === id && s.source === "installed"))
        : prevMine.some((s) => s.id === id)
          ? prevMine
          : [
              ...prevMine,
              {
                ...orgRow,
                scope: "org" as const,
                source: "installed" as const,
                labels: [],
                installStatus: "installed" as const,
                installedVersion: markVersion,
              },
            ];
      mineSkillsRef.current = nextMine;
      setMineSkills(nextMine);
      const request = installed ? markSkillInstalled(id, markVersion) : markSkillUninstalled(id);
      request
        .then((res) => {
          if (installCorrectionOpsRef.current.get(id) !== operation) return;
          installCorrectionOpsRef.current.delete(id);
          if (res.installed && "installed_version" in res) {
            const v = res.installed_version;
            const st = res.status;
            setOrgSkills((arr) => {
              const next = arr.map((s) => (s.id === id ? { ...s, installStatus: st, installedVersion: v } : s));
              orgSkillsRef.current = next;
              return next;
            });
            setMineSkills((arr) => {
              const next = arr.map((s) =>
                s.id === id && s.source === "installed" ? { ...s, installStatus: st, installedVersion: v } : s,
              );
              mineSkillsRef.current = next;
              return next;
            });
          }
          setToast({ msg: installed ? `Marked ${id} as installed` : `Marked ${id} as not installed` });
        })
        .catch((e) => {
          if (installCorrectionOpsRef.current.get(id) !== operation) return;
          installCorrectionOpsRef.current.delete(id);
          setOrgSkills((arr) => {
            const next = arr.map((s) =>
              s.id === id ? { ...s, installStatus: prevOrg.status, installedVersion: prevOrg.version } : s,
            );
            orgSkillsRef.current = next;
            return next;
          });
          setMineSkills((arr) => {
            const withoutOptimisticCopy = arr.filter((row) => !(row.id === id && row.source === "installed"));
            const next = restoreRowAtSnapshot(withoutOptimisticCopy, prevMineRow, prevMineIndex);
            mineSkillsRef.current = next;
            return next;
          });
          orgActions.setError((e as Error).message);
        });
    },
    [orgActions],
  );

  // --- Optimistic label mutations (per library) ------------------------------
  // Every handler takes the target library explicitly (the stacked sidebar shows BOTH trees, so the
  // org tree can be edited while My Skills is active). It captures the previous value, reads current
  // state from the matching SYNCHRONOUS ref, applies the optimistic setState, fires the matching RPC
  // (org `labels` vs personal folders), and reverts on failure. No router.refresh() on success.
  const skillsSetterFor = useCallback(
    (lib: SkillsLibrary) => (lib === "org" ? setOrgSkills : setMineSkills),
    [],
  );
  const labelsSetterFor = useCallback(
    (lib: SkillsLibrary) => (lib === "org" ? setOrgLabels : setPersonalLabels),
    [],
  );
  const skillsRefFor = useCallback(
    (lib: SkillsLibrary) => (lib === "org" ? orgSkillsRef : mineSkillsRef),
    [],
  );
  const labelsRefFor = useCallback(
    (lib: SkillsLibrary) => (lib === "org" ? orgLabelsRef : personalLabelsRef),
    [],
  );
  const labelRpcs = useMemo(
    () => ({
      org: {
        assign: assignSkillLabel,
        unassign: unassignSkillLabel,
        create: createLabelRpc,
        color: setLabelColorRpc,
        icon: setLabelIconRpc,
        rename: renameLabelRpc,
        del: deleteLabelRpc,
      },
      mine: {
        assign: assignPersonalSkillLabel,
        unassign: unassignPersonalSkillLabel,
        create: createPersonalLabelRpc,
        color: setPersonalLabelColorRpc,
        icon: setPersonalLabelIconRpc,
        rename: renamePersonalLabelRpc,
        del: deletePersonalLabelRpc,
      },
    }),
    [],
  );

  // Assign or unassign a folder path on a skill (toggle). The detail "Add to folder" calls this.
  const toggleSkillLabel = useCallback(
    (lib: SkillsLibrary, skillId: string, path: string) => {
      const setSk = skillsSetterFor(lib);
      const setLb = labelsSetterFor(lib);
      const rpcs = labelRpcs[lib];
      const current = skillsRefFor(lib).current.find((s) => s.id === skillId);
      if (!current) return;
      const had = (current.labels ?? []).includes(path);
      const newFolders: string[] = [];
      if (!had) {
        const known = new Set(labelsRefFor(lib).current.map((l) => l.path));
        const segs = path.split("/");
        for (let i = 1; i <= segs.length; i += 1) {
          const p = segs.slice(0, i).join("/");
          if (!known.has(p)) newFolders.push(p);
        }
      }
      setSk((arr) =>
        arr.map((s) =>
          s.id === skillId ? { ...s, labels: had ? s.labels.filter((p) => p !== path) : [...s.labels, path] } : s,
        ),
      );
      if (newFolders.length) {
        setLb((arr) => [...arr, ...newFolders.map((p) => ({ path: p, displayName: null, color: null, icon: null }))]);
      }
      const rpc = had ? rpcs.unassign(skillId, path) : rpcs.assign(skillId, path);
      rpc.catch((err: unknown) => {
        setSk((arr) =>
          arr.map((s) =>
            s.id === skillId
              ? { ...s, labels: had ? [...s.labels, path] : s.labels.filter((p) => p !== path) }
              : s,
          ),
        );
        if (newFolders.length) {
          const remove = new Set(newFolders);
          setLb((arr) => arr.filter((l) => !remove.has(l.path)));
        }
        setLabelNotice(err instanceof Error ? err.message : "Could not update the skill's folders.");
      });
    },
    [labelRpcs, labelsRefFor, labelsSetterFor, skillsRefFor, skillsSetterFor],
  );

  // Create an empty folder (explicit row) in a library and select it.
  const createLabelPath = useCallback(
    (lib: SkillsLibrary, path: string, displayName?: string) => {
      const setLb = labelsSetterFor(lib);
      if (labelsRefFor(lib).current.some((l) => l.path === path)) {
        setSelection({ lib, kind: "label", label: path });
        replaceSkillsUrl({ lib, kind: "label", label: path });
        return;
      }
      const optimistic: LabelVM = { path, displayName: displayName ?? null, color: null, icon: null };
      setLb((arr) => [...arr, optimistic]);
      setSelection({ lib, kind: "label", label: path });
      setOpenId(null);
      setExpanded((prev) => {
        const next = new Set(prev);
        const segs = path.split("/");
        for (let i = 1; i < segs.length; i += 1) next.add(segs.slice(0, i).join("/"));
        return next;
      });
      replaceSkillsUrl({ lib, kind: "label", label: path });
      labelRpcs[lib].create(path, { displayName }).catch((err: unknown) => {
        setLb((arr) => arr.filter((l) => l.path !== path));
        setLabelNotice(err instanceof Error ? err.message : "Could not create the folder.");
      });
    },
    [labelRpcs, labelsRefFor, labelsSetterFor, replaceSkillsUrl],
  );

  const setLabelColorPath = useCallback(
    (lib: SkillsLibrary, path: string, color: LabelColor | null) => {
      const setLb = labelsSetterFor(lib);
      const prevColor = labelsRefFor(lib).current.find((l) => l.path === path)?.color ?? null;
      setLb((arr) => {
        const exists = arr.some((l) => l.path === path);
        return exists
          ? arr.map((l) => (l.path === path ? { ...l, color } : l))
          : [...arr, { path, displayName: null, color, icon: null }];
      });
      labelRpcs[lib].color(path, color).catch((err: unknown) => {
        setLb((arr) => arr.map((l) => (l.path === path ? { ...l, color: prevColor } : l)));
        setLabelNotice(err instanceof Error ? err.message : "Could not change the folder color.");
      });
    },
    [labelRpcs, labelsRefFor, labelsSetterFor],
  );

  const setLabelIconPath = useCallback(
    (lib: SkillsLibrary, path: string, icon: LabelIcon | null) => {
      const setLb = labelsSetterFor(lib);
      const prevIcon = labelsRefFor(lib).current.find((l) => l.path === path)?.icon ?? null;
      setLb((arr) => {
        const exists = arr.some((l) => l.path === path);
        return exists
          ? arr.map((l) => (l.path === path ? { ...l, icon } : l))
          : [...arr, { path, displayName: null, color: null, icon }];
      });
      labelRpcs[lib].icon(path, icon).catch((err: unknown) => {
        setLb((arr) => arr.map((l) => (l.path === path ? { ...l, icon: prevIcon } : l)));
        setLabelNotice(err instanceof Error ? err.message : "Could not change the folder icon.");
      });
    },
    [labelRpcs, labelsRefFor, labelsSetterFor],
  );

  const renameLabelPath = useCallback(
    (lib: SkillsLibrary, from: string, to: string, displayName?: string, appendToNewParent = false) => {
      if (from === to && displayName === undefined) return;
      const setLb = labelsSetterFor(lib);
      const setSk = skillsSetterFor(lib);
      const prevLabels = labelsRefFor(lib).current;
      const prevSkills = skillsRefFor(lib).current;
      const prevSidebarOrder = sidebarOrderRef.current;
      const currentRows = deriveTreeRows(
        lib === "mine" ? skillsRefFor(lib).current.filter((skill) => skill.source === "authored") : skillsRefFor(lib).current,
        labelsRefFor(lib).current,
        prevSidebarOrder[lib],
      );
      const nextSidebarOrder = {
        ...prevSidebarOrder,
        [lib]: remapTreeOrder(currentRows.map((row) => row.path), from, to, appendToNewParent),
      };
      const within = (p: string) => p === from || p.startsWith(from + "/");
      const remap = (p: string) => (within(p) ? to + p.slice(from.length) : p);
      setLb((arr) =>
        arr.map((l) => ({
          ...l,
          path: remap(l.path),
          displayName: displayName !== undefined && l.path === from ? displayName : l.displayName,
        })),
      );
      setSk((arr) => arr.map((s) => ({ ...s, labels: s.labels.map(remap) })));
      sidebarOrderRef.current = nextSidebarOrder;
      setSidebarOrder(nextSidebarOrder);
      setSelection((sel) =>
        sel.lib === lib && sel.kind === "label" && sel.label && within(sel.label)
          ? { lib, kind: "label", label: remap(sel.label) }
          : sel,
      );
      if (selection.lib === lib && selection.kind === "label" && selection.label && within(selection.label)) {
        replaceSkillsUrl(
          routeFromSelection({ lib, kind: "label", label: remap(selection.label) }, openIdRef.current ?? undefined),
        );
      }
      labelRpcs[lib].rename(from, to, { displayName }).catch((err: unknown) => {
        setLb(prevLabels);
        setSk(prevSkills);
        sidebarOrderRef.current = prevSidebarOrder;
        setSidebarOrder(prevSidebarOrder);
        setLabelNotice(err instanceof Error ? err.message : "Could not rename the folder.");
      });
    },
    [labelRpcs, labelsRefFor, labelsSetterFor, replaceSkillsUrl, selection, skillsRefFor, skillsSetterFor],
  );

  const deleteLabelPath = useCallback(
    (lib: SkillsLibrary, path: string) => {
      const setLb = labelsSetterFor(lib);
      const setSk = skillsSetterFor(lib);
      const prevLabels = labelsRefFor(lib).current;
      const prevSkills = skillsRefFor(lib).current;
      const prevSidebarOrder = sidebarOrderRef.current;
      const nextSidebarOrder = {
        ...prevSidebarOrder,
        [lib]: removeTreeOrderPath(prevSidebarOrder[lib], path),
      };
      const within = (p: string) => p === path || p.startsWith(path + "/");
      setLb((arr) => arr.filter((l) => !within(l.path)));
      setSk((arr) => arr.map((s) => ({ ...s, labels: s.labels.filter((p) => !within(p)) })));
      sidebarOrderRef.current = nextSidebarOrder;
      setSidebarOrder(nextSidebarOrder);
      setSelection((sel) =>
        sel.lib === lib && sel.kind === "label" && sel.label && within(sel.label) ? { lib, kind: "all" } : sel,
      );
      if (selection.lib === lib && selection.kind === "label" && selection.label && within(selection.label)) {
        replaceSkillsUrl({ lib, kind: "all" });
      }
      labelRpcs[lib].del(path).catch((err: unknown) => {
        setLb(prevLabels);
        setSk(prevSkills);
        sidebarOrderRef.current = prevSidebarOrder;
        setSidebarOrder(prevSidebarOrder);
        setLabelNotice(err instanceof Error ? err.message : "Could not delete the folder.");
      });
    },
    [labelRpcs, labelsRefFor, labelsSetterFor, replaceSkillsUrl, selection, skillsRefFor, skillsSetterFor],
  );

  const beginDrag = useCallback((item: DragItem) => {
    dragRef.current = item;
    setDrag(item);
  }, []);

  const endDrag = useCallback(() => {
    dragRef.current = null;
    setDrag(null);
  }, []);

  const dropSkillOnLabel = useCallback(
    (lib: SkillsLibrary, skillId: string, targetPath: string, sourceLabel: string | null) => {
      const setSk = skillsSetterFor(lib);
      const setLb = labelsSetterFor(lib);
      const rpcs = labelRpcs[lib];
      const skill = skillsRefFor(lib).current.find((s) => s.id === skillId);
      if (!skill) return;
      const prevSkills = skillsRefFor(lib).current;
      const prevLabels = labelsRefFor(lib).current;
      const labels = skill.labels ?? [];
      const hadTarget = labels.includes(targetPath);
      const movingOutOfSource =
        !!sourceLabel && sourceLabel !== targetPath && !targetPath.startsWith(sourceLabel + "/");
      const sourceRemovals = movingOutOfSource
        ? labels.filter((path) => path === sourceLabel || path.startsWith(sourceLabel + "/"))
        : [];
      if (hadTarget && sourceRemovals.length === 0) return;

      const known = new Set(prevLabels.map((l) => l.path));
      const newFolders: string[] = [];
      if (!hadTarget) {
        const segs = targetPath.split("/");
        for (let i = 1; i <= segs.length; i += 1) {
          const path = segs.slice(0, i).join("/");
          if (!known.has(path)) newFolders.push(path);
        }
      }

      setSk((arr) =>
        arr.map((s) => {
          if (s.id !== skillId) return s;
          const remove = new Set(sourceRemovals);
          const nextLabels = s.labels.filter((path) => !remove.has(path));
          return { ...s, labels: hadTarget ? nextLabels : [...nextLabels, targetPath] };
        }),
      );
      if (newFolders.length) {
        setLb((arr) => [...arr, ...newFolders.map((path) => ({ path, displayName: null, color: null, icon: null }))]);
      }

      const ops: { run: () => Promise<unknown>; undo: () => Promise<unknown> }[] = [];
      if (!hadTarget) {
        ops.push({
          run: () => rpcs.assign(skillId, targetPath),
          undo: () => rpcs.unassign(skillId, targetPath),
        });
      }
      for (const path of sourceRemovals) {
        ops.push({
          run: () => rpcs.unassign(skillId, path),
          undo: () => rpcs.assign(skillId, path),
        });
      }

      void Promise.allSettled(ops.map((op) => op.run())).then(async (results) => {
        if (results.every((result) => result.status === "fulfilled")) return;
        await Promise.allSettled(
          ops
            .filter((_, index) => results[index]?.status === "fulfilled")
            .reverse()
            .map((op) => op.undo()),
        );
        setSk(prevSkills);
        setLb(prevLabels);
        const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
        setLabelNotice(
          rejected?.reason instanceof Error ? rejected.reason.message : "Could not move the skill between folders.",
        );
      });
    },
    [labelRpcs, labelsRefFor, labelsSetterFor, skillsRefFor, skillsSetterFor],
  );

  const dropSkillOnRoot = useCallback(
    (lib: SkillsLibrary, skillId: string, sourceLabel: string | null) => {
      if (!sourceLabel) return;
      const setSk = skillsSetterFor(lib);
      const rpcs = labelRpcs[lib];
      const skill = skillsRefFor(lib).current.find((s) => s.id === skillId);
      if (!skill) return;
      const prevSkills = skillsRefFor(lib).current;
      const sourceRemovals = (skill.labels ?? []).filter(
        (path) => path === sourceLabel || path.startsWith(sourceLabel + "/"),
      );
      if (sourceRemovals.length === 0) return;

      setSk((arr) =>
        arr.map((s) => {
          if (s.id !== skillId) return s;
          const remove = new Set(sourceRemovals);
          return { ...s, labels: s.labels.filter((path) => !remove.has(path)) };
        }),
      );

      void Promise.allSettled(sourceRemovals.map((path) => rpcs.unassign(skillId, path))).then(async (results) => {
        if (results.every((result) => result.status === "fulfilled")) return;
        await Promise.allSettled(
          sourceRemovals
            .filter((_, index) => results[index]?.status === "fulfilled")
            .reverse()
            .map((path) => rpcs.assign(skillId, path)),
        );
        setSk(prevSkills);
        const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
        setLabelNotice(rejected?.reason instanceof Error ? rejected.reason.message : "Could not remove the skill from this folder.");
      });
    },
    [labelRpcs, skillsRefFor, skillsSetterFor],
  );

  const reparentLabel = useCallback(
    (lib: SkillsLibrary, from: string, targetParent: string | null) => {
      const leaf = from.split("/").pop() ?? from;
      if (!leaf) return;
      if (targetParent) {
        if (targetParent === from || targetParent.startsWith(from + "/")) return;
        const to = `${targetParent}/${leaf}`;
        if (to === from) return;
        renameLabelPath(lib, from, to, undefined, true);
        return;
      }
      if (!from.includes("/")) return;
      renameLabelPath(lib, from, leaf, undefined, true);
    },
    [renameLabelPath],
  );

  // --- Share a personal skill to the org library -----------------------------
  const confirmShare = useCallback(
    (vm: SkillVM, _plan: SkillSharePlan) => {
      const id = vm.id;
      setShareTarget(null);
      // Share is one-way (there is no un-share endpoint). Refetch both libraries after success so
      // derived rows, labels, installs, and dependency counters stay server-authoritative.
      shareSkillToOrg(id)
        .then(async (result) => {
          await refreshSkillLibraries();
          // Re-point the detail to the org copy so it stays open under the new library.
          setSelection({ lib: "org", kind: "all" });
          setOpenId(id);
          setLastId(id);
          if (typeof window !== "undefined" && isSkillsClientPath(window.location.pathname)) {
            replaceSkillsUrl({ lib: "org", kind: "all", skill: id });
          }
          const count = result.shared_dependencies.length;
          setToast({
            msg:
              count > 0
                ? `Shared ${id} and ${count} private ${count === 1 ? "dependency" : "dependencies"} to ${currentOrg.name}.`
                : `Shared ${id} to ${currentOrg.name}. Everyone can use it now.`,
          });
        })
        .catch((e) => {
          orgActions.setError((e as Error).message);
        });
    },
    [currentOrg.name, orgActions, refreshSkillLibraries, replaceSkillsUrl],
  );

  // Auto-dismiss toasts.
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (!labelNotice) return;
    const t = setTimeout(() => setLabelNotice(null), 5000);
    return () => clearTimeout(t);
  }, [labelNotice]);

  // --- Archived skills -------------------------------------------------------
  const loadArchived = useCallback(async () => {
    setArchivedLoaded(false);
    try {
      const rows = (await fetchArchivedSkills()).map(mapSkill);
      archivedSkillsRef.current = rows;
      setArchivedSkills(rows);
      setArchivedLoaded(true);
      return rows;
    } catch {
      setArchivedLoaded(true);
      return [] as SkillVM[];
    }
  }, []);

  useEffect(() => {
    archivedSkillsRef.current = [];
    setArchivedSkills([]);
    setArchivedLoaded(false);
    void loadArchived();
  }, [currentOrg.id, loadArchived]);

  const archiveSkillById = useCallback(
    (id: string) => {
      installCorrectionOpsRef.current.delete(id);
      const prevMine = mineSkillsRef.current;
      const prevOrg = orgSkillsRef.current;
      const mineRow = prevMine.find((row) => row.id === id);
      const orgRow = prevOrg.find((row) => row.id === id);
      const mineIndex = prevMine.findIndex((row) => row.id === id);
      const orgIndex = prevOrg.findIndex((row) => row.id === id);
      const wasOpen = openIdRef.current === id;
      const rollbackRoute = routeFromSelection(selection, id);
      const optimisticHref = skillsRouteHref(skillsRouteWithoutSkill(rollbackRoute));
      const nextMine = prevMine.filter((s) => s.id !== id);
      const nextOrg = prevOrg.filter((s) => s.id !== id);
      // Drop the skill from whichever library it appears in (org skill, or the actor's personal skill).
      mineSkillsRef.current = nextMine;
      orgSkillsRef.current = nextOrg;
      setMineSkills(nextMine);
      setOrgSkills(nextOrg);
      setOpenId((cur) => {
        if (cur !== id) return cur;
        clearCurrentSkillUrl();
        return null;
      });
      void archiveSkillRpc(id).then(
        async () => {
          try {
            await Promise.all([loadArchived(), refreshSkillLibraries()]);
          } catch {
            orgActions.setError("Skill archived, but the active libraries could not be refreshed. Reload to retry the refresh.");
          }
        },
        (error) => {
          setMineSkills((current) => {
            const next = restoreRowAtSnapshot(current, mineRow, mineIndex);
            mineSkillsRef.current = next;
            return next;
          });
          setOrgSkills((current) => {
            const next = restoreRowAtSnapshot(current, orgRow, orgIndex);
            orgSkillsRef.current = next;
            return next;
          });
          const currentHref = `${window.location.pathname}${window.location.search}`;
          if (wasOpen && openIdRef.current === null && currentHref === optimisticHref) {
            setOpenId(id);
            setLastId(id);
            replaceSkillsUrl(rollbackRoute);
          }
          orgActions.setError(error instanceof Error ? error.message : "Could not archive the skill.");
        },
      );
    },
    [clearCurrentSkillUrl, loadArchived, orgActions, refreshSkillLibraries, replaceSkillsUrl, selection],
  );

  const restoreSkillById = useCallback(
    (id: string) => {
      const prevArchived = archivedSkillsRef.current;
      const archivedRow = prevArchived.find((row) => row.id === id);
      const archivedIndex = prevArchived.findIndex((row) => row.id === id);
      const wasOpen = openIdRef.current === id;
      const optimisticHref = skillsRouteHref({ kind: "archived" });
      const nextArchived = prevArchived.filter((row) => row.id !== id);
      archivedSkillsRef.current = nextArchived;
      setArchivedSkills(nextArchived);
      setOpenId((cur) => {
        if (cur !== id) return cur;
        clearCurrentSkillUrl();
        return null;
      });
      void restoreSkillRpc(id).then(
        async () => {
          try {
            await Promise.all([loadArchived(), refreshSkillLibraries()]);
          } catch {
            orgActions.setError("Skill restored, but the active libraries could not be refreshed. Reload to retry the refresh.");
          }
        },
        (error) => {
          setArchivedSkills((current) => {
            const next = restoreRowAtSnapshot(current, archivedRow, archivedIndex);
            archivedSkillsRef.current = next;
            return next;
          });
          const currentHref = `${window.location.pathname}${window.location.search}`;
          if (wasOpen && openIdRef.current === null && currentHref === optimisticHref) {
            setCurrentView("archived");
            setOpenId(id);
            setLastId(id);
            replaceSkillsUrl({ kind: "archived", skill: id });
          }
          orgActions.setError(error instanceof Error ? error.message : "Could not restore the skill.");
        },
      );
    },
    [clearCurrentSkillUrl, loadArchived, orgActions, refreshSkillLibraries, replaceSkillsUrl],
  );

  const reconcileInstallReport = useCallback((reported: SkillVM) => {
    // A server-observed report supersedes any older optimistic manual correction for this skill.
    installCorrectionOpsRef.current.delete(reported.id);
    const nextOrg = orgSkillsRef.current.map((row) =>
      row.id === reported.id
        ? { ...row, installStatus: reported.installStatus, installedVersion: reported.installedVersion }
        : row,
    );
    const orgRow = nextOrg.find((row) => row.id === reported.id) ?? reported;
    const nextMine = mineSkillsRef.current.some((row) => row.id === reported.id && row.source === "installed")
      ? mineSkillsRef.current.map((row) =>
          row.id === reported.id && row.source === "installed"
            ? { ...row, installStatus: reported.installStatus, installedVersion: reported.installedVersion }
            : row,
        )
      : [
          ...mineSkillsRef.current,
          {
            ...orgRow,
            scope: "org" as const,
            source: "installed" as const,
            labels: [],
            installStatus: reported.installStatus,
            installedVersion: reported.installedVersion,
          },
        ];
    orgSkillsRef.current = nextOrg;
    mineSkillsRef.current = nextMine;
    setOrgSkills(nextOrg);
    setMineSkills(nextMine);
    setToast({
      msg: reported.installStatus === "installed" ? `${reported.id} is up to date` : `${reported.id} install reported`,
    });
    // The report endpoint installs the resolved dependency closure as well as the root. Keep the
    // immediate root merge above, then authoritatively refresh both libraries so dependency rows,
    // counts, and update badges converge without a page reload.
    void refreshSkillLibraries().catch(() => {
      orgActions.setError("The skill was installed, but its dependency status could not be refreshed. Reload to try again.");
    });
  }, [orgActions, refreshSkillLibraries]);

  const executeSkillAction = useCallback(
    (target: SkillVM, action: SkillAction) => {
      switch (action.id) {
        case "share":
          setShareTarget(target);
          return;
        case "install":
        case "update":
          setInstallSkill(target);
          return;
        case "publish-version":
          setUpdateSkill(target);
          return;
        case "manage-public":
          setPublicReleaseSkill(target);
          return;
        case "archive":
          archiveSkillById(target.id);
          return;
        case "restore":
          restoreSkillById(target.id);
          return;
        case "mark-installed":
          setInstalled(target.id, true);
          return;
        case "mark-not-installed":
          setInstalled(target.id, false);
          return;
        case "download":
          void fetchSkillDownloadUrl(target.id, target.version)
            .then((url) => {
              window.location.href = url;
            })
            .catch((error) => {
              orgActions.setError(error instanceof Error ? error.message : "Could not download the package.");
            });
      }
    },
    [archiveSkillById, orgActions, restoreSkillById, setInstalled],
  );

  // --- Derived ---------------------------------------------------------------
  // Personal folders organize only AUTHORED personal skills (installed copies carry no personal labels),
  // so the personal tree is derived from that subset. The org tree is unchanged.
  const personalTreeRows = useMemo(
    () => deriveTreeRows(mineSkills.filter((s) => s.source === "authored"), personalLabels, sidebarOrder.mine),
    [mineSkills, personalLabels, sidebarOrder.mine],
  );
  const orgTreeRows = useMemo(
    () => deriveTreeRows(orgSkills, orgLabels, sidebarOrder.org),
    [orgSkills, orgLabels, sidebarOrder.org],
  );
  const activeTreeRows = activeLib === "org" ? orgTreeRows : personalTreeRows;

  const mineCount = mineSkills.length;
  const orgCount = orgSkills.length;
  const installedCount = useMemo(() => mineSkills.filter((s) => s.source === "installed").length, [mineSkills]);
  const installedUpdateCount = useMemo(
    () => mineSkills.filter((s) => s.source === "installed" && s.installStatus === "update").length,
    [mineSkills],
  );

  // The active scope + the in-list filter chips both gate the list.
  const filtered = useMemo(
    () => skills.filter((s) => skillInSelection(s, selection) && matchFilters(s, filters)),
    [skills, selection, filters],
  );

  /** A selection only survives while its row is still on screen: a filter, a folder, or a search
   *  that no longer contains it leaves the panel showing something the list does not.
   */
  const selected = useMemo(
    () => filtered.find((item) => item.uuid === selectedUuid) ?? null,
    [filtered, selectedUuid],
  );
  useEffect(() => {
    if (selectedUuid !== null && selected === null) setSelectedUuid(null);
  }, [selected, selectedUuid]);

  /**
   * Put the panel away and hand focus back to the row it belongs to. Closing unmounts the subtree
   * that held focus, so without this the next Tab restarts at the top of the document.
   */
  const closeSkillPanel = useCallback(() => {
    // By database id, not slug: the same slug exists in both libraries, and focus must come back to
    // the row that was selected rather than the first one that happens to share its name.
    const uuid = selectedUuid;
    setSelectedUuid(null);
    window.requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(`.crow[data-skill-uuid="${uuid}"] .crow__hit`)
        ?.focus();
    });
  }, [selectedUuid]);

  // Esc puts the panel away, the way it closes every other transient surface here.
  useEffect(() => {
    if (selectedUuid === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // The panel is the quietest surface on this page. Anything layered over it — a dialog, a
      // menu — owns Escape first, so dismissing one of those must not also throw the panel away.
      if ((event.target as HTMLElement | null)?.closest?.("[role='dialog'], [role='menu']")) return;
      if (document.querySelector("[role='dialog']")) return;
      closeSkillPanel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeSkillPanel, selectedUuid]);

  const activeLabel = selection.kind === "label" ? selection.label ?? null : null;
  const breadcrumb = useMemo(() => {
    if (selection.kind === "installed") return ["Installed"];
    if (selection.kind === "label" && selection.label) return selection.label.split("/");
    return selection.lib === "org" ? ["All skills"] : ["My Skills"];
  }, [selection]);

  const routeForCurrentSurface = useCallback(
    (skillId?: string): SkillsRoute => {
      if (currentView === "archived") {
        return skillId ? { kind: "archived", skill: skillId } : { kind: "archived" };
      }
      return routeFromSelection(selection, skillId);
    },
    [currentView, selection],
  );

  // --- Filter actions (in-list bar: status / dependencies) -------------------
  const toggleFilter = useCallback((type: Filter["type"], value: string) => {
    setFilters((fs) =>
      fs.some((f) => f.type === type && f.value === value)
        ? fs.filter((f) => !(f.type === type && f.value === value))
        : ([...fs, { type, value }] as Filter[]),
    );
  }, []);
  const removeFilter = useCallback((f: Filter) => {
    setFilters((fs) => fs.filter((x) => !(x.type === f.type && x.value === f.value)));
  }, []);
  const clearFilters = useCallback(() => setFilters([]), []);
  const retryPreferenceSave = useCallback(() => {
    if (!queuedPreferencesRef.current) persistPreferences(filters, groupBy, sidebarOrder);
    else void flushPreferenceQueue();
  }, [filters, flushPreferenceQueue, groupBy, persistPreferences, sidebarOrder]);

  // --- Selection / navigation ------------------------------------------------
  const applySkillsRoute = useCallback(
    (route: SkillsRoute, history: "push" | "replace" | "none") => {
      setCurrentView(skillsViewForRoute(route));
      setSelection(selectionFromRoute(route));
      const nextOpenId = route.kind === "local" ? null : route.skill ?? null;
      setOpenId(nextOpenId);
      setLastId(nextOpenId);
      if (typeof window === "undefined") return;
      if (history === "none") {
        return;
      }
      writeSkillsUrl(route, history);
    },
    [writeSkillsUrl],
  );
  const selectMineAll = useCallback(() => applySkillsRoute({ lib: "mine", kind: "all" }, "push"), [applySkillsRoute]);
  const selectOrgAll = useCallback(() => applySkillsRoute({ lib: "org", kind: "all" }, "push"), [applySkillsRoute]);
  const selectInstalled = useCallback(
    () => applySkillsRoute({ lib: "mine", kind: "installed" }, "push"),
    [applySkillsRoute],
  );
  const selectLabel = useCallback(
    (lib: SkillsLibrary, path: string) => applySkillsRoute({ lib, kind: "label", label: path }, "push"),
    [applySkillsRoute],
  );
  const selectLocal = useCallback(() => applySkillsRoute({ kind: "local" }, "push"), [applySkillsRoute]);
  const selectArchived = useCallback(() => {
    loadArchived();
    applySkillsRoute({ kind: "archived" }, "push");
  }, [applySkillsRoute, loadArchived]);

  const toggleExpand = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  // Selecting a label auto-expands its ancestors so the row is reachable in the tree.
  useEffect(() => {
    if (selection.kind !== "label" || !selection.label) return;
    const segs = selection.label.split("/");
    if (segs.length < 2) return;
    setExpanded((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (let i = 1; i < segs.length; i += 1) {
        const p = segs.slice(0, i).join("/");
        if (!next.has(p)) {
          next.add(p);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [selection]);

  const localUpdateCount = useMemo(
    () => localSkills.filter((s) => s.status === "update").length,
    [localSkills],
  );

  useEffect(() => {
    const onPopState = () => {
      if (window.location.pathname === "/settings") {
        showLocalSettings(settingsStateFromSearch(window.location.search), false);
        return;
      }
      settingsWarmupRef.current = null;
      setLocalSettings(null);
      // Every non-Skills pathname belongs to its own Next.js route. In particular, `/s/:token`
      // must render the public page and is never interpreted by the authenticated Skills shell.
      if (window.location.pathname !== "/skills") return;
      if (window.location.pathname === "/skills") {
        const route = parseSkillsRoute(window.location.search);
        const source = skillsRouteSource(window.location.search);
        if (source === "default" && route.kind === "all" && route.lib === "mine") {
          setCurrentView("workspace");
          setSelection({ lib: "mine", kind: "all" });
          if (!openIdRef.current) setFilters(initialFilterPreferences.active_filters);
          setOpenId(null);
          setLastId(null);
          replaceSkillsUrl(route);
        } else {
          if (route.kind === "archived") void loadArchived();
          // Replace the current history entry as well as applying it. The parser intentionally
          // ignores retired runtime fields, so this also scrubs them from Back/Forward URLs.
          applySkillsRoute(route, "replace");
        }
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [applySkillsRoute, initialFilterPreferences.active_filters, loadArchived, replaceSkillsUrl, showLocalSettings]);

  // --- Open / navigate -------------------------------------------------------
  const detailPool = currentView === "archived" ? archivedSkills : filtered;
  const index = openId ? detailPool.findIndex((s) => s.id === openId) : -1;
  const skill = index >= 0 ? (detailPool[index] ?? null) : null;
  openIdRef.current = openId;

  const open = useCallback((id: string) => {
    const openingFromWorkspace = currentView === "workspace";
    if (!openingFromWorkspace) setCurrentView("workspace");
    setUploadOpen(false);
    setOpenId(id);
    setLastId(id);
    pushSkillsUrl(openingFromWorkspace ? routeForCurrentSurface(id) : { lib: "mine", kind: "all", skill: id });
  }, [currentView, pushSkillsUrl, routeForCurrentSurface]);

  const openArchived = useCallback((id: string) => {
    setCurrentView("archived");
    setUploadOpen(false);
    setOpenId(id);
    setLastId(id);
    pushSkillsUrl({ kind: "archived", skill: id });
  }, [pushSkillsUrl]);

  const openSkillBySlug = useCallback(
    async (slug: string) => {
      setUploadOpen(false);
      // Dependency links resolve to org skills first, then the actor's personal library.
      const lib: SkillsLibrary | null = orgSkillsRef.current.some((s) => s.id === slug)
        ? "org"
        : mineSkillsRef.current.some((s) => s.id === slug)
          ? "mine"
          : null;
      if (lib) {
        setCurrentView("workspace");
        setSelection({ lib, kind: "all" });
        setOpenId(slug);
        setLastId(slug);
        pushSkillsUrl({ lib, kind: "all", skill: slug });
        return;
      }
      await loadArchived();
      setCurrentView("archived");
      setOpenId(slug);
      setLastId(slug);
      pushSkillsUrl({ kind: "archived", skill: slug });
    },
    [loadArchived, pushSkillsUrl],
  );
  const back = useCallback(() => {
    if (
      typeof window !== "undefined" &&
      window.history.state &&
      typeof window.history.state === "object" &&
      (window.history.state as { companionSkillsDetail?: unknown }).companionSkillsDetail
    ) {
      window.history.back();
      return;
    }
    setOpenId(null);
    replaceSkillsUrl(routeForCurrentSurface());
  }, [replaceSkillsUrl, routeForCurrentSurface]);
  const go = useCallback(
    (delta: number) => {
      const i = detailPool.findIndex((row) => row.id === openIdRef.current);
      const n = detailPool[i + delta];
      if (!n) return;
      setOpenId(n.id);
      setLastId(n.id);
      replaceSkillsUrl(routeForCurrentSurface(n.id));
    },
    [detailPool, replaceSkillsUrl, routeForCurrentSurface],
  );

  // If the open skill drops out of the filtered slice, fall back to the list.
  useEffect(() => {
    if (!openId || index >= 0) return;
    if (currentView === "archived" && !archivedLoaded) return;
    setOpenId(null);
    replaceSkillsUrl(routeForCurrentSurface());
  }, [archivedLoaded, currentView, index, openId, replaceSkillsUrl, routeForCurrentSurface]);

  useEffect(() => {
    if (!mobileSidebarOpen) return;
    const side = document.querySelector<HTMLElement>(".side--mobile-open");
    const focusable = () =>
      Array.from(
        side?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((node) => !node.hasAttribute("disabled") && node.offsetParent !== null);
    const items = focusable();
    if (!side?.contains(document.activeElement) && items[0]) items[0].focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const nodes = focusable();
      if (!nodes.length) return;
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
        return;
      }
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileSidebarOpen]);

  // Keyboard: ⌘K toggles palette; ⌘⇧C copies the public link; Esc back to list; ↑/↓ move between skills.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (uploadOpen || updateSkill || installSkill || shareTarget || publicReleaseSkill) return;
      // Modal surfaces own Escape, arrows and Cmd/Ctrl shortcuts. Letting the skill shell handle
      // them would unmount the dialog and move its prompt/files into another skill's route.
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      if (mobileSidebarOpen && e.key === "Escape") {
        e.preventDefault();
        setMobileSidebarOpen(false);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      if (paletteOpen) return;
      if (!openId) return;
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase() ?? "";
      if (tag === "input" || tag === "textarea") return;
      // ⌘⇧C copies the open org skill's public share link (its canonical /s/<token> URL).
      // Personal / archived skills have no public link, so the shortcut no-ops for them.
      if (e.metaKey && e.shiftKey && e.key.toLowerCase() === "c") {
        const shareable = shareableSkillForSlug(openId);
        if (!shareable || !navigator.clipboard) return;
        e.preventDefault();
        const url = `${window.location.origin}${skillShareHref(shareable.shareToken)}`;
        void navigator.clipboard.writeText(url).then(
          () => setToast({ msg: "Public link copied" }),
          () => {},
        );
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        back();
      } else if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault();
        go(1);
      } else if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        go(-1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openId, paletteOpen, mobileSidebarOpen, uploadOpen, updateSkill, installSkill, shareTarget, publicReleaseSkill, back, go, shareableSkillForSlug]);

  const localActive = currentView === "local";
  const archivedActive = currentView === "archived";
  // The open skill's library drives detail actions + the folder picker (authored personal → personal
  // folders; everything else → org folders).
  const detailLib: SkillsLibrary = skill && skill.scope === "personal" ? "mine" : "org";
  const detailTreePaths = (detailLib === "org" ? orgTreeRows : personalTreeRows).map((r) => r.path);
  const activeTreePaths = useMemo(() => activeTreeRows.map((r) => r.path), [activeTreeRows]);
  // The palette searches across both libraries (de-duped by id, preferring the My-Skills copy).
  const paletteSkills = useMemo(() => {
    const seen = new Set(mineSkills.map((s) => s.id));
    return [...mineSkills, ...orgSkills.filter((s) => !seen.has(s.id))];
  }, [mineSkills, orgSkills]);

  // Pointer-based drag-and-drop (skills + folders). The hook owns the live mechanics
  // (ghost, hit-testing, dwell auto-open, teardown); we feed it the DOM-agnostic
  // orchestration callbacks + the per-(lib,path) folder lookup for the dwell check.
  const treeRowsByPath = useMemo(() => {
    const map = new Map<string, { hasChildren: boolean }>();
    for (const r of personalTreeRows) map.set(treeRowKey("mine", r.path), { hasChildren: r.hasChildren });
    for (const r of orgTreeRows) map.set(treeRowKey("org", r.path), { hasChildren: r.hasChildren });
    return map;
  }, [personalTreeRows, orgTreeRows]);
  const reorderLabel = useCallback(
    (lib: SkillsLibrary, from: string, target: string, position: "before" | "after") => {
      const rows = lib === "mine" ? personalTreeRows : orgTreeRows;
      const nextPaths = reorderTreeRows(rows, from, target, position);
      if (!nextPaths) return;
      const nextOrder = { ...sidebarOrderRef.current, [lib]: nextPaths };
      sidebarOrderRef.current = nextOrder;
      skipNextDebouncedPersistRef.current = true;
      setSidebarOrder(nextOrder);
      // Ordering can be changed from any sidebar-backed view, including immediately before
      // navigating away from Skills. Start the queued save now instead of relying only on debounce.
      persistPreferences(filters, groupBy, nextOrder);
    },
    [filters, groupBy, orgTreeRows, persistPreferences, personalTreeRows],
  );
  const skillDrag = useSkillDrag({
    beginDrag,
    endDrag,
    onDropSkillOnLabel: dropSkillOnLabel,
    onDropSkillOnRoot: dropSkillOnRoot,
    onReparentLabel: reparentLabel,
    onReorderLabel: reorderLabel,
    onToggleExpand: toggleExpand,
    expanded,
    treeRowsByPath,
  });
  const startSkillDrag = useCallback(
    (skillId: string, e: PointerLike) =>
      skillDrag.startDrag({ kind: "skill", lib: selection.lib, skillId, sourceLabel: activeLabel }, e),
    [skillDrag, selection.lib, activeLabel],
  );

  return (
    <div className={"app app--skills" + (mobileSidebarOpen ? " app--side-open" : "")}>
      <Sidebar
        orgs={orgs}
        currentOrg={currentOrg}
        onSwitchOrg={orgActions.switchOrg}
        onOnboard={(m) => orgActions.setOnboarding(m)}
        onOpenSettings={openSettings}
        onWarmSettings={() => {
          void warmSettings();
        }}
        mineTreeRows={personalTreeRows}
        orgTreeRows={orgTreeRows}
        expanded={expanded}
        onToggleExpand={toggleExpand}
        selection={currentView === "workspace" ? selection : null}
        mineCount={mineCount}
        orgCount={orgCount}
        installedCount={installedCount}
        installedUpdateCount={installedUpdateCount}
        onOpenPalette={() => setPaletteOpen(true)}
        onSelectMineAll={selectMineAll}
        onSelectOrgAll={selectOrgAll}
        onSelectInstalled={selectInstalled}
        onSelectLabel={selectLabel}
        onCreateLabel={createLabelPath}
        onSetLabelColor={setLabelColorPath}
        onSetLabelIcon={setLabelIconPath}
        onRenameLabel={renameLabelPath}
        onDeleteLabel={deleteLabelPath}
        drag={drag}
        hovered={skillDrag.hovered}
        openPendingPath={skillDrag.openPendingPath}
        dropDone={skillDrag.dropDone}
        onReparentLabel={reparentLabel}
        onReorderLabel={reorderLabel}
        onLabelStartDrag={skillDrag.startDrag}
        onSelectLocal={selectLocal}
        onSelectArchived={selectArchived}
        onSelectSecrets={() => router.push("/secrets")}
        localActive={localActive}
        localUpdateCount={localUpdateCount}
        archivedActive={archivedActive}
        archivedCount={archivedSkills.length}
        mobileOpen={mobileSidebarOpen}
        onToggleMobile={() => setMobileSidebarOpen((open) => !open)}
        onCloseMobile={() => setMobileSidebarOpen(false)}
        personalSkillsEnabled={personalSkillsEnabled}
        onUpgrade={() => openSettings({ view: "billing" })}
      />
      {mobileSidebarOpen && (
        <button
          type="button"
          className="side-scrim"
          aria-label="Close navigation"
          onClick={() => setMobileSidebarOpen(false)}
        />
      )}
      <div className="main" aria-hidden={mobileSidebarOpen || undefined} inert={mobileSidebarOpen ? true : undefined}>
        {currentView === "local" ? (
          <LocalSkillsView skills={localSkills} workspaceId={currentOrg.id} workspaceName={currentOrg.name} />
        ) : skill ? (
          <DetailView
            skill={skill}
            index={index}
            total={detailPool.length}
            me={me}
            orgName={currentOrg.name}
            orgId={currentOrg.id}
            allLabels={detailTreePaths}
            onBack={back}
            onPrev={() => go(-1)}
            onNext={() => go(1)}
            onToggleLabel={(path) => toggleSkillLabel(detailLib, skill.id, path)}
            onSelectLabel={(path) => selectLabel(detailLib, path)}
            onAction={(action) => executeSkillAction(skill, action)}
            onOpenSkill={openSkillBySlug}
            historyEnabled={initialBilling.entitlements.skillHistory}
            onUpgrade={() => openSettings({ view: "billing" })}
          />
        ) : currentView === "archived" ? (
          <ArchivedListView
            skills={archivedSkills}
            onOpen={openArchived}
            onUpload={openUpload}
            actorId={me.id}
            onPrimaryAction={executeSkillAction}
          />
        ) : (
          <>
            {selection.lib === "mine"
            && initialGettingStarted
            && companionLocalSkill ? (
              <GettingStartedCard
                initialState={initialGettingStarted}
                companionSkill={companionLocalSkill}
                workspaceId={currentOrg.id}
              />
            ) : null}
            <ListView
              skills={filtered}
              labels={labels}
              workspaceId={currentOrg.id}
              library={selection.lib}
              categoryOrder={activeTreePaths}
              scopeKind={selection.kind}
              activeLabel={activeLabel}
              breadcrumb={breadcrumb}
              groupBy={groupBy}
              onGroupByChange={setGroupBy}
              onOpen={open}
              onUpload={openUpload}
              onSelect={(picked) => setSelectedUuid(picked?.uuid ?? null)}
              selectedUuid={selectedUuid}
              lastId={lastId}
              filters={filters}
              onToggleFilter={toggleFilter}
              onRemoveFilter={removeFilter}
              onClearFilters={clearFilters}
              preferenceStatus={preferenceStatus}
              onRetryPreferences={retryPreferenceSave}
              dragSkillId={drag?.kind === "skill" && drag.lib === selection.lib ? drag.skillId : null}
              onSkillStartDrag={startSkillDrag}
              upgradeNotice={
                !personalSkillsEnabled && selection.lib === "mine"
                  ? `${initialBilling.hiddenPersonalSkillCount} personal skill${initialBilling.hiddenPersonalSkillCount === 1 ? " is" : "s are"} preserved but hidden on Free. Organization skills you install remain available here.`
                  : orgCreateBlocked && selection.lib === "org"
                    ? initialBilling.entitlements.catalogFrozen
                      ? `This catalog has ${initialBilling.orgSkillCount} skills and is read-only on Free.`
                      : `Free includes ${orgSkillLimit} organization skills. Upgrade to add another.`
                    : null
              }
              onUpgrade={() => openSettings({ view: "billing" })}
              panel={
                /*
                  The selected row's detail, beside the list rather than over it: the list stays
                  where it was, and the panel is one row's worth of answers. It exists only in the
                  workspace libraries; local and archived have their own surfaces and actions.
                */
                selected ? (
                  <SkillPanel
                    skill={selected}
                    labels={labels}
                    actorId={me.id}
                    onOpen={open}
                    onAction={executeSkillAction}
                    onClose={closeSkillPanel}
                  />
                ) : null
              }
            />
          </>
        )}
      </div>
      {(currentView !== "workspace" || skill) && preferenceStatus !== "idle" ? (
        <div className={`prefstatus prefstatus--${preferenceStatus} prefstatus--overlay`} role="status" aria-live="polite">
          {preferenceStatus === "saving" ? "Saving" : null}
          {preferenceStatus === "saved" ? "Saved" : null}
          {preferenceStatus === "error" ? (
            <>Not saved<button className="prefstatus__retry" onClick={retryPreferenceSave}>Retry</button></>
          ) : null}
        </div>
      ) : null}
      {paletteOpen && (
        <CommandPalette
          allSkills={paletteSkills}
          onPick={(id) => {
            open(id);
            setPaletteOpen(false);
          }}
          onClose={() => setPaletteOpen(false)}
          onUpload={openUpload}
          currentSkill={skill}
          actorId={me.id}
          onPrimaryAction={executeSkillAction}
        />
      )}
      {uploadOpen && (
        <UploadDialog
          mode="create"
          workspaceId={currentOrg.id}
          scope={activeLib === "org" ? "org" : "personal"}
          allLabels={activeTreePaths}
          defaultLabels={activeLabel ? [activeLabel] : []}
          knownSkillSlugs={paletteSkills.map((item) => item.id)}
          onClose={closeUpload}
          onPublished={() => {
            void refreshSkillLibraries().catch((error) => {
              orgActions.setError(error instanceof Error ? error.message : "Could not refresh skills.");
            });
            router.refresh();
          }}
        />
      )}
      {updateSkill && (
        <UploadDialog
          mode="update"
          workspaceId={currentOrg.id}
          skill={updateSkill}
          scope={updateSkill.scope === "personal" ? "personal" : "org"}
          allLabels={(updateSkill.scope === "personal" ? personalTreeRows : orgTreeRows).map((r) => r.path)}
          knownSkillSlugs={paletteSkills.map((item) => item.id)}
          onClose={() => setUpdateSkill(null)}
          onPublished={() => {
            void refreshSkillLibraries().catch((error) => {
              orgActions.setError(error instanceof Error ? error.message : "Could not refresh skills.");
            });
            router.refresh();
          }}
        />
      )}
      {installSkill && (
        <InstallDialog
          skill={installSkill}
          workspaceId={currentOrg.id}
          onClose={() => setInstallSkill(null)}
          onReported={reconcileInstallReport}
        />
      )}
      {labelNotice && (
        <div className="og-toast" role="alert" onClick={() => setLabelNotice(null)}>
          {labelNotice}
        </div>
      )}
      {orgActions.onboarding && (
        <Onboarding
          mode={orgActions.onboarding}
          onMode={orgActions.setOnboarding}
          onCreate={orgActions.createOrg}
          onJoin={orgActions.joinOrg}
          busy={orgActions.busy}
        />
      )}
      {orgActions.error && (
        <div className="og-toast" role="alert" onClick={() => orgActions.setError(null)}>
          {orgActions.error}
        </div>
      )}
      {shareTarget && (
        <ShareDialog
          skill={shareTarget}
          orgName={currentOrg.name}
          onConfirm={(plan) => confirmShare(shareTarget, plan)}
          onClose={() => setShareTarget(null)}
        />
      )}
      {publicReleaseSkill && (
        <PublicReleaseDialog
          skill={publicReleaseSkill}
          onClose={() => setPublicReleaseSkill(null)}
          onChanged={(publicVersion) => {
            const updateRows = (rows: SkillVM[]) =>
              rows.map((row) => (row.id === publicReleaseSkill.id ? { ...row, publicVersion } : row));
            const nextMine = updateRows(mineSkillsRef.current);
            const nextOrg = updateRows(orgSkillsRef.current);
            mineSkillsRef.current = nextMine;
            orgSkillsRef.current = nextOrg;
            setMineSkills(nextMine);
            setOrgSkills(nextOrg);
            setPublicReleaseSkill((current) => current ? { ...current, publicVersion } : current);
            setToast({ msg: publicVersion ? `Public v${publicVersion} is live` : "Public package access removed" });
          }}
        />
      )}
      {toast && (
        <div className="og-toast og-toast--ok" role="status">
          <span className="og-toast__msg">{toast.msg}</span>
          {toast.undo && (
            <button
              type="button"
              className="og-toast__undo"
              onClick={() => {
                toast.undo?.();
                setToast(null);
              }}
            >
              Undo
            </button>
          )}
          <button type="button" className="og-toast__close" aria-label="Dismiss" onClick={() => setToast(null)}>
            ×
          </button>
        </div>
      )}
      {localSettings?.kind === "ready" && (
        <SettingsDrawer
          data={localSettings.data}
          initialRoute={localSettings.initialRoute}
          initialDialog={localSettings.initialDialog}
          onRefreshData={refreshLocalSettingsData}
        />
      )}
      {localSettings?.kind === "error" && (
        <SettingsDrawerError
          message={localSettings.message}
          busy={localSettings.busy}
          onClose={() => window.history.back()}
          onRetry={retryLocalSettings}
        />
      )}
    </div>
  );
}
