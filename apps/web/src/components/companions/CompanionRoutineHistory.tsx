"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  ArrowLeftIcon,
  BellIcon,
  ChevronRightIcon,
  CornerDownRightIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import type {
  CompanionRoutineRunDetail,
  CompanionRoutineRunEntry,
  CompanionRoutineRunOutcome,
  CompanionRoutineRunStatus,
  CompanionRoutineRunSummary,
} from "@companion/contracts";
import {
  listCompanionRoutineRuns,
  readCompanionRoutineRun,
} from "@/lib/companions";
import { detectedBrowserTimeZone, formatMemberDateTime } from "@/lib/timezones";
import { Badge } from "../cds";

export interface RoutineHistoryTarget {
  routineId: string | null;
  runId: string | null;
  name: string;
}

type StatusTone = "neutral" | "ok" | "warn" | "danger";

const FOCUSABLE =
  'a[href], button:not([disabled]), details > summary, [tabindex]:not([tabindex="-1"])';

const STATUS_LABELS = {
  queued: "Queued",
  starting: "Starting",
  dispatching: "Dispatching",
  running: "Running",
  needs_input: "Needs input",
  succeeded: "Completed",
  failed: "Failed",
  interrupted: "Interrupted",
  cancelled: "Cancelled",
} satisfies Record<CompanionRoutineRunStatus, string>;

function statusTone(status: CompanionRoutineRunStatus): StatusTone {
  if (status === "succeeded") return "ok";
  if (status === "failed" || status === "cancelled") return "danger";
  if (status === "interrupted" || status === "needs_input") return "warn";
  return "neutral";
}

function outcomeLabel(run: CompanionRoutineRunSummary | CompanionRoutineRunDetail): string {
  if (run.outcome === "surfaced") {
    return run.surface_mode === "relay" ? "Relayed to main Companion" : "Notified in main chat";
  }
  if (run.outcome === "no_output") return "Completed silently";
  if (run.outcome === "error") return STATUS_LABELS[run.status];
  return STATUS_LABELS[run.status];
}

function outcomeIcon(outcome: CompanionRoutineRunOutcome, mode: "relay" | "notify" | null) {
  if (outcome !== "surfaced") return null;
  return mode === "relay"
    ? <CornerDownRightIcon aria-hidden="true" className="size-3.5" />
    : <BellIcon aria-hidden="true" className="size-3.5" />;
}

function RunRow({
  run,
  timezone,
  onOpen,
}: {
  run: CompanionRoutineRunSummary;
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
        <Badge tone={statusTone(run.status)} dot>{STATUS_LABELS[run.status]}</Badge>
        <ChevronRightIcon aria-hidden="true" className="routine-history__chevron" />
      </button>
    </li>
  );
}

function TranscriptEntry({
  entry,
  timezone,
}: {
  entry: CompanionRoutineRunEntry;
  timezone: string;
}) {
  const label = entry.role === "assistant"
    ? "Routine Pi"
    : entry.role === "user"
      ? "Routine task"
      : entry.role === "system"
        ? "System"
        : entry.role === "tool"
          ? entry.tool?.name ?? "Tool"
          : entry.decision?.name ?? "Decision";

  return (
    <li className={`routine-history__entry routine-history__entry--${entry.role}`}>
      <div className="routine-history__entry-head">
        {entry.role === "tool" ? <WrenchIcon aria-hidden="true" className="size-3.5" /> : null}
        <strong>{label}</strong>
        <time dateTime={entry.created_at}>{formatMemberDateTime(entry.created_at, timezone)}</time>
      </div>

      {entry.tool ? (
        <div className="routine-history__event-card">
          <div className="routine-history__event-head">
            <span>{entry.tool.title || entry.tool.name}</span>
            <Badge tone={entry.tool.status === "ok" ? "ok" : entry.tool.status === "running" ? "neutral" : "danger"}>
              {entry.tool.status}
            </Badge>
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
            <span>{entry.decision.title || entry.decision.name}</span>
            <Badge tone={entry.decision.status === "pending" ? "warn" : "neutral"}>
              {entry.decision.status}
            </Badge>
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

export function CompanionRoutineHistory({
  orgId,
  companionId,
  target,
  memberTimezone,
  onClose,
}: {
  orgId: string;
  companionId: string;
  target: RoutineHistoryTarget;
  memberTimezone?: string | null;
  onClose: () => void;
}) {
  const titleId = useId();
  const drawerRef = useRef<HTMLElement>(null);
  const [runs, setRuns] = useState<CompanionRoutineRunSummary[]>([]);
  const [runsCursor, setRunsCursor] = useState<string | null>(null);
  const [runsLoading, setRunsLoading] = useState(target.routineId !== null);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(target.runId);
  const [detail, setDetail] = useState<CompanionRoutineRunDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(target.runId !== null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const selectedRunIdRef = useRef<string | null>(target.runId);
  const detailRequestGenerationRef = useRef(0);
  const displayTimezone = memberTimezone ?? detectedBrowserTimeZone();

  const loadRuns = useCallback(async (cursor?: string) => {
    if (!target.routineId) return;
    setRunsLoading(true);
    setRunsError(null);
    try {
      const page = await listCompanionRoutineRuns(orgId, companionId, target.routineId, {
        limit: 20,
        cursor,
      });
      setRuns((current) => cursor ? [...current, ...page.runs] : page.runs);
      setRunsCursor(page.next_cursor);
    } catch (cause) {
      setRunsError(cause instanceof Error ? cause.message : "Routine history could not be loaded.");
    } finally {
      setRunsLoading(false);
    }
  }, [companionId, orgId, target.routineId]);

  const loadDetail = useCallback(async (runId: string, cursor?: number) => {
    const generation = ++detailRequestGenerationRef.current;
    const requestIsCurrent = () => (
      detailRequestGenerationRef.current === generation
      && selectedRunIdRef.current === runId
    );
    setDetailLoading(true);
    setDetailError(null);
    try {
      const page = await readCompanionRoutineRun(orgId, companionId, runId, {
        entryLimit: 50,
        entryCursor: cursor,
      });
      if (!requestIsCurrent()) return;
      setDetail((current) => cursor !== undefined && current?.run_id === page.run_id
        ? { ...page, internal_entries: [...current.internal_entries, ...page.internal_entries] }
        : page);
    } catch (cause) {
      if (!requestIsCurrent()) return;
      setDetailError(cause instanceof Error ? cause.message : "This routine run could not be loaded.");
    } finally {
      if (requestIsCurrent()) setDetailLoading(false);
    }
  }, [companionId, orgId]);

  const selectRun = useCallback((runId: string | null) => {
    selectedRunIdRef.current = runId;
    detailRequestGenerationRef.current += 1;
    setSelectedRunId(runId);
  }, []);

  useEffect(() => {
    if (!target.routineId) return;
    void loadRuns();
  }, [loadRuns, target.routineId]);

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
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [onClose]);

  const selectedSummary = detail ?? runs.find((run) => run.run_id === selectedRunId) ?? null;
  const canReturnToList = selectedRunId !== null && target.routineId !== null;

  return (
    <div className="routine-history-layer">
      <button
        type="button"
        className="routine-history__scrim"
        aria-label="Close routine history"
        onClick={onClose}
      />
      <aside
        ref={drawerRef}
        className="routine-history"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className="routine-history__head">
          {canReturnToList ? (
            <button
              type="button"
              className="iconbtn"
              aria-label={`Back to ${target.name} runs`}
              onClick={() => selectRun(null)}
            >
              <ArrowLeftIcon aria-hidden="true" className="size-4" />
            </button>
          ) : null}
          <div className="routine-history__identity">
            <h2 id={titleId}>{target.name}</h2>
            <p>{selectedRunId ? "Routine run" : "Run history"}</p>
          </div>
          <button type="button" className="iconbtn" aria-label="Close routine history" onClick={onClose}>
            <XIcon aria-hidden="true" className="size-4" />
          </button>
        </header>

        <div className="routine-history__body">
          {selectedRunId ? (
            <>
              {selectedSummary ? (
                <section className="routine-history__summary" aria-label="Run summary">
                  <div>
                    <span>Started</span>
                    <strong>
                      <time dateTime={selectedSummary.created_at}>
                        {formatMemberDateTime(selectedSummary.created_at, displayTimezone)}
                      </time>
                    </strong>
                  </div>
                  <div>
                    <span>Status</span>
                    <Badge tone={statusTone(selectedSummary.status)} dot>
                      {STATUS_LABELS[selectedSummary.status]}
                    </Badge>
                  </div>
                  <div>
                    <span>Result</span>
                    <strong className="routine-history__result">
                      {outcomeIcon(selectedSummary.outcome, selectedSummary.surface_mode)}
                      {outcomeLabel(selectedSummary)}
                    </strong>
                  </div>
                  {selectedSummary.error ? (
                    <p className="routine-history__error" role="alert">
                      {selectedSummary.error.message}
                    </p>
                  ) : null}
                  {selectedSummary.status === "interrupted" ? (
                    <div className="routine-history__recovery">
                      <p>
                        Earlier routine effects may already have succeeded. This occurrence will
                        not be replayed; later routine work continues automatically.
                      </p>
                    </div>
                  ) : null}
                </section>
              ) : null}

              <section className="routine-history__transcript" aria-labelledby={`${titleId}-transcript`}>
                <h3 id={`${titleId}-transcript`}>Internal transcript</h3>
                {detailLoading && !detail ? <HistorySkeleton label="Loading routine transcript…" /> : null}
                {detailError ? (
                  <div className="routine-history__error" role="alert">
                    <p>{detailError}</p>
                    <button type="button" className="cds-btn cds-btn--secondary cds-btn--sm" onClick={() => void loadDetail(selectedRunId)}>
                      Retry
                    </button>
                  </div>
                ) : null}
                {detail && detail.internal_entries.length === 0 ? (
                  <div className="routine-history__empty">
                    <strong>No internal transcript</strong>
                    <p>This run finished without recorded private activity.</p>
                  </div>
                ) : null}
                {detail && detail.internal_entries.length > 0 ? (
                  <ol className="routine-history__entries">
                    {detail.internal_entries.map((entry) => (
                      <TranscriptEntry key={entry.event_id} entry={entry} timezone={displayTimezone} />
                    ))}
                  </ol>
                ) : null}
                {detail?.next_entry_cursor !== null && detail?.next_entry_cursor !== undefined ? (
                  <button
                    type="button"
                    className="cds-btn cds-btn--secondary cds-btn--sm routine-history__more"
                    disabled={detailLoading}
                    onClick={() => void loadDetail(selectedRunId, detail.next_entry_cursor ?? undefined)}
                  >
                    {detailLoading ? "Loading…" : "Load more transcript"}
                  </button>
                ) : null}
              </section>
            </>
          ) : (
            <section className="routine-history__list" aria-label={`${target.name} runs`}>
              {runsLoading && runs.length === 0 ? <HistorySkeleton label="Loading routine history…" /> : null}
              {runsError ? (
                <div className="routine-history__error" role="alert">
                  <p>{runsError}</p>
                  <button type="button" className="cds-btn cds-btn--secondary cds-btn--sm" onClick={() => void loadRuns()}>
                    Retry
                  </button>
                </div>
              ) : null}
              {!runsLoading && !runsError && runs.length === 0 ? (
                <div className="routine-history__empty">
                  <strong>No runs yet</strong>
                  <p>The first scheduled run will appear here with its status and transcript.</p>
                </div>
              ) : null}
              {runs.length > 0 ? (
                <ul className="routine-history__runs">
                  {runs.map((run) => (
                    <RunRow
                      key={run.run_id}
                      run={run}
                      timezone={displayTimezone}
                      onOpen={() => selectRun(run.run_id)}
                    />
                  ))}
                </ul>
              ) : null}
              {runsCursor ? (
                <button
                  type="button"
                  className="cds-btn cds-btn--secondary cds-btn--sm routine-history__more"
                  disabled={runsLoading}
                  onClick={() => void loadRuns(runsCursor)}
                >
                  {runsLoading ? "Loading…" : "Load earlier runs"}
                </button>
              ) : null}
            </section>
          )}
        </div>
      </aside>
    </div>
  );
}
