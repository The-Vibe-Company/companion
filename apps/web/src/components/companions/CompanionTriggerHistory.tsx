"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ArrowLeftIcon, BellIcon, ChevronRightIcon, CornerDownRightIcon, WebhookIcon, WrenchIcon, XIcon } from "lucide-react";
import { Badge } from "../cds";
import { formatMemberDateTime, detectedBrowserTimeZone } from "@/lib/timezones";
import type {
  CompanionTriggerHistoryApi,
  CompanionTriggerHistoryDetail,
  CompanionTriggerHistoryEntry,
  CompanionTriggerHistoryMode,
  CompanionTriggerHistoryStatus,
  CompanionTriggerHistorySummary,
} from "./CompanionTriggerHistoryTypes";

export type {
  CompanionTriggerHistoryApi,
  CompanionTriggerHistoryDetail,
  CompanionTriggerHistoryEntry,
  CompanionTriggerHistoryMode,
  CompanionTriggerHistoryStatus,
  CompanionTriggerHistorySummary,
} from "./CompanionTriggerHistoryTypes";

export interface TriggerHistoryTarget {
  triggerId: string | null;
  runId: string | null;
  name: string;
}

type StatusTone = "neutral" | "ok" | "warn" | "danger";

const FOCUSABLE =
  'a[href], button:not([disabled]), details > summary, input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const STATUS_LABELS = {
  queued: "Queued",
  admitted: "Admitted",
  running: "Running",
  needs_input: "Needs input",
  succeeded: "Completed",
  failed: "Failed",
  interrupted: "Interrupted",
  cancelled: "Cancelled",
} satisfies Record<CompanionTriggerHistoryStatus, string>;

function statusTone(status: CompanionTriggerHistoryStatus): StatusTone {
  if (status === "succeeded") return "ok";
  if (status === "failed" || status === "cancelled") return "danger";
  if (status === "interrupted" || status === "needs_input") return "warn";
  return "neutral";
}

function statusLabel(status: CompanionTriggerHistoryStatus): string {
  return STATUS_LABELS[status] ?? status;
}

function outcomeLabel(run: CompanionTriggerHistorySummary): string {
  if (run.outcome === "surfaced" && run.surface_mode === "notify") return "Notified in main chat";
  if (run.outcome === "surfaced" && run.surface_mode === "relay") return "Relayed to main Companion";
  if (run.outcome === "no_output") return "No output";
  if (run.outcome === "error") return "Processing failed";
  return "Processing";
}

function outcomeIcon(outcome: CompanionTriggerHistorySummary["outcome"], mode: CompanionTriggerHistoryMode | null | undefined) {
  if (outcome === "surfaced" && mode === "notify") return <BellIcon aria-hidden="true" className="size-3.5" />;
  if (outcome === "surfaced" && mode === "relay") return <CornerDownRightIcon aria-hidden="true" className="size-3.5" />;
  return <WebhookIcon aria-hidden="true" className="size-3.5" />;
}

function TriggerRunRow({
  run,
  timezone,
  onOpen,
}: {
  run: CompanionTriggerHistorySummary;
  timezone: string;
  onOpen: () => void;
}) {
  return (
    <li className="routine-history__run">
      <button type="button" className="routine-history__run-button" onClick={onOpen}>
        <span className="routine-history__run-main">
          <span className="routine-history__run-time">
            <time dateTime={run.created_at}>{formatMemberDateTime(run.created_at, timezone)}</time>
          </span>
          <span className="routine-history__run-outcome">
            {outcomeIcon(run.outcome, run.surface_mode)}
            {outcomeLabel(run)}
          </span>
        </span>
        <Badge tone={statusTone(run.status)} dot>{statusLabel(run.status)}</Badge>
        <ChevronRightIcon aria-hidden="true" className="routine-history__chevron" />
      </button>
    </li>
  );
}

function Entry({ entry, timezone }: { entry: CompanionTriggerHistoryEntry; timezone: string }) {
  const label = entry.role === "assistant"
    ? "Trigger Pi"
    : entry.role === "user"
      ? "Trigger event"
      : entry.role === "system"
        ? "System"
        : entry.role === "tool"
          ? entry.tool?.name ?? "Tool"
          : entry.decision?.name ?? entry.role ?? "Event";
  const payload = entry.role === "user" ? entry.content : null;

  return (
    <li className={`routine-history__entry routine-history__entry--${entry.role ?? "event"}`}>
      <div className="routine-history__entry-head">
        {entry.role === "tool" ? <WrenchIcon aria-hidden="true" className="size-3.5" /> : null}
        <strong>{label}</strong>
        <time dateTime={entry.created_at}>{formatMemberDateTime(entry.created_at, timezone)}</time>
      </div>
      {payload ? (
        <details className="routine-history__details" open>
          <summary>Event payload</summary>
          <pre>{payload}</pre>
        </details>
      ) : null}
      {entry.tool ? (
        <div className="routine-history__event-card">
          <div className="routine-history__event-head">
            <span>{entry.tool.title || entry.tool.name || entry.tool.kind || "Tool"}</span>
            {entry.tool.status ? <Badge tone={entry.tool.status === "ok" ? "ok" : entry.tool.status === "running" ? "neutral" : "danger"}>{entry.tool.status}</Badge> : null}
          </div>
          {entry.tool.detail ? (
            <details className="routine-history__details">
              <summary>Tool details</summary>
              <pre>{entry.tool.detail}</pre>
            </details>
          ) : null}
        </div>
      ) : entry.decision ? (
        <div className="routine-history__event-card">
          <div className="routine-history__event-head">
            <span>{entry.decision.title || entry.decision.name || "Decision"}</span>
            {entry.decision.status ? <Badge tone={entry.decision.status === "pending" ? "warn" : "neutral"}>{entry.decision.status}</Badge> : null}
          </div>
          {entry.decision.detail ? <p>{entry.decision.detail}</p> : null}
          {entry.decision.answer ? <p>Answer: {entry.decision.answer}</p> : null}
        </div>
      ) : entry.content ? (
        <div className="routine-history__content">{entry.content}</div>
      ) : null}
      {entry.reasoning ? (
        <details className="routine-history__details">
          <summary>Reasoning</summary>
          <div className="routine-history__content">{entry.reasoning}</div>
        </details>
      ) : null}
    </li>
  );
}

function HistorySkeleton({ label }: { label: string }) {
  return (
    <>
      <span className="sr-only" role="status">{label}</span>
      <div className="routine-history__skeleton" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
    </>
  );
}

/**
 * Read-only, no-wake trigger fire history. The API is deliberately injected: a stale server branch
 * must not cause this component to guess a route, and a test can prove ordering/pagination without
 * replacing the entire Companion client.
 */
export function CompanionTriggerHistory({
  orgId,
  companionId,
  target,
  memberTimezone,
  api,
  onClose,
}: {
  orgId: string;
  companionId: string;
  target: TriggerHistoryTarget;
  memberTimezone?: string | null;
  api: CompanionTriggerHistoryApi;
  onClose: () => void;
}) {
  const titleId = useId();
  const drawerRef = useRef<HTMLElement>(null);
  const selectedRunIdRef = useRef<string | null>(target.runId);
  const detailRequestGenerationRef = useRef(0);
  const [runs, setRuns] = useState<CompanionTriggerHistorySummary[]>([]);
  const [runsCursor, setRunsCursor] = useState<string | null>(null);
  const [runsLoading, setRunsLoading] = useState(target.triggerId !== null);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(target.runId);
  const [detail, setDetail] = useState<CompanionTriggerHistoryDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(target.runId !== null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const displayTimezone = memberTimezone ?? detectedBrowserTimeZone();

  const loadRuns = useCallback(async (cursor?: string) => {
    if (!target.triggerId) return;
    setRunsLoading(true);
    setRunsError(null);
    try {
      const page = await api.listCompanionTriggerRuns(orgId, companionId, target.triggerId, {
        limit: 20,
        cursor,
      });
      const ordered = [...page.runs].sort((left, right) => (
        Date.parse(right.created_at) - Date.parse(left.created_at)
      ));
      setRuns((current) => cursor ? [...current, ...ordered] : ordered);
      setRunsCursor(page.next_cursor);
    } catch (cause) {
      setRunsError(cause instanceof Error ? cause.message : "Trigger history could not be loaded.");
    } finally {
      setRunsLoading(false);
    }
  }, [api, companionId, orgId, target.triggerId]);

  const loadDetail = useCallback(async (runId: string, cursor?: number) => {
    const generation = ++detailRequestGenerationRef.current;
    const requestIsCurrent = () => detailRequestGenerationRef.current === generation
      && selectedRunIdRef.current === runId;
    setDetailLoading(true);
    setDetailError(null);
    try {
      const page = await api.readCompanionTriggerRun(orgId, companionId, runId, {
        entryLimit: 50,
        entryCursor: cursor,
      });
      if (!requestIsCurrent()) return;
      setDetail((current) => cursor !== undefined && current?.run_id === page.run_id
        ? { ...page, internal_entries: [...current.internal_entries, ...page.internal_entries] }
        : page);
    } catch (cause) {
      if (!requestIsCurrent()) return;
      setDetailError(cause instanceof Error ? cause.message : "This trigger fire could not be loaded.");
    } finally {
      if (requestIsCurrent()) setDetailLoading(false);
    }
  }, [api, companionId, orgId]);

  const selectRun = useCallback((runId: string | null) => {
    selectedRunIdRef.current = runId;
    detailRequestGenerationRef.current += 1;
    setSelectedRunId(runId);
    setDetail(null);
    setDetailError(null);
    if (!runId) setDetailLoading(false);
  }, []);

  useEffect(() => {
    if (target.triggerId) void loadRuns();
  }, [loadRuns, target.triggerId]);

  useEffect(() => {
    selectedRunIdRef.current = selectedRunId;
    if (!selectedRunId) {
      setDetail(null);
      setDetailError(null);
      setDetailLoading(false);
      return;
    }
    setDetail(null);
    void loadDetail(selectedRunId);
  }, [loadDetail, selectedRunId]);

  useEffect(() => {
    const drawer = drawerRef.current;
    (drawer?.querySelector<HTMLElement>(FOCUSABLE) ?? drawer)?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !drawer) return;
      const items = Array.from(drawer.querySelectorAll<HTMLElement>(FOCUSABLE))
        .filter((item) => item.offsetParent !== null);
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  const selectedSummary = detail ?? runs.find((run) => run.run_id === selectedRunId) ?? null;
  const canReturnToList = selectedRunId !== null && target.triggerId !== null;

  return (
    <div className="trigger-history-layer routine-history-layer">
      <button type="button" className="routine-history__scrim" aria-label="Close trigger history" onClick={onClose} />
      <aside
        ref={drawerRef}
        className="routine-history trigger-history"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className="routine-history__head">
          {canReturnToList ? (
            <button type="button" className="iconbtn" aria-label={`Back to ${target.name} fires`} onClick={() => selectRun(null)}>
              <ArrowLeftIcon aria-hidden="true" className="size-4" />
            </button>
          ) : null}
          <div className="routine-history__identity">
            <h2 id={titleId}>{target.name}</h2>
            <p>{selectedRunId ? "Trigger fire" : "Fire history"}</p>
          </div>
          <button type="button" className="iconbtn" aria-label="Close trigger history" onClick={onClose}>
            <XIcon aria-hidden="true" className="size-4" />
          </button>
        </header>

        <div className="routine-history__body">
          {selectedRunId ? (
            <>
              {selectedSummary ? (
                <section className="routine-history__summary" aria-label="Trigger fire summary">
                  <div>
                    <span>Received</span>
                    <strong><time dateTime={selectedSummary.created_at}>{formatMemberDateTime(selectedSummary.created_at, displayTimezone)}</time></strong>
                  </div>
                  <div>
                    <span>Status</span>
                    <Badge tone={statusTone(selectedSummary.status)} dot>{statusLabel(selectedSummary.status)}</Badge>
                  </div>
                  <div>
                    <span>Result</span>
                    <strong className="routine-history__result">
                      {outcomeIcon(selectedSummary.outcome, selectedSummary.surface_mode)}
                      {outcomeLabel(selectedSummary)}
                    </strong>
                  </div>
                  {selectedSummary.error?.message ? (
                    <p className="routine-history__error" role="alert">{selectedSummary.error.message}</p>
                  ) : null}
                </section>
              ) : null}
              <section className="routine-history__transcript" aria-labelledby={`${titleId}-transcript`}>
                <h3 id={`${titleId}-transcript`}>Internal transcript</h3>
                {detailLoading && !detail ? <HistorySkeleton label="Loading trigger transcript…" /> : null}
                {detailError ? (
                  <div className="routine-history__error" role="alert">
                    <p>{detailError}</p>
                    <button type="button" className="cds-btn cds-btn--secondary cds-btn--sm" onClick={() => void loadDetail(selectedRunId)}>Retry</button>
                  </div>
                ) : null}
                {detail && detail.internal_entries.length === 0 ? (
                  <div className="routine-history__empty">
                    <strong>No internal transcript</strong>
                    <p>This fire finished without recorded private activity.</p>
                  </div>
                ) : null}
                {detail && detail.internal_entries.length > 0 ? (
                  <ol className="routine-history__entries">
                    {detail.internal_entries.map((entry) => <Entry key={entry.event_id} entry={entry} timezone={displayTimezone} />)}
                  </ol>
                ) : null}
                {detail?.next_entry_cursor !== null && detail?.next_entry_cursor !== undefined ? (
                  <button type="button" className="cds-btn cds-btn--secondary cds-btn--sm routine-history__more" disabled={detailLoading} onClick={() => void loadDetail(selectedRunId, detail.next_entry_cursor ?? undefined)}>
                    {detailLoading ? "Loading…" : "Load more transcript"}
                  </button>
                ) : null}
              </section>
            </>
          ) : (
            <section className="routine-history__list" aria-label={`${target.name} fires`}>
              {runsLoading && runs.length === 0 ? <HistorySkeleton label="Loading trigger history…" /> : null}
              {runsError ? (
                <div className="routine-history__error" role="alert">
                  <p>{runsError}</p>
                  <button type="button" className="cds-btn cds-btn--secondary cds-btn--sm" onClick={() => void loadRuns()}>Retry</button>
                </div>
              ) : null}
              {!runsLoading && !runsError && runs.length === 0 ? (
                <div className="routine-history__empty">
                  <strong>No fires yet</strong>
                  <p>The first provider event will appear here with its status and payload.</p>
                </div>
              ) : null}
              {runs.length > 0 ? (
                <ul className="routine-history__runs">
                  {runs.map((run) => <TriggerRunRow key={run.run_id} run={run} timezone={displayTimezone} onOpen={() => selectRun(run.run_id)} />)}
                </ul>
              ) : null}
              {runsCursor ? (
                <button type="button" className="cds-btn cds-btn--secondary cds-btn--sm routine-history__more" disabled={runsLoading} onClick={() => void loadRuns(runsCursor)}>
                  {runsLoading ? "Loading…" : "Load earlier fires"}
                </button>
              ) : null}
            </section>
          )}
        </div>
      </aside>
    </div>
  );
}
