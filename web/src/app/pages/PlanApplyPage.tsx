/**
 * PlanApplyPage — plan + apply workflow (route "/plan").
 *
 * The flow is deliberately two-staged and explicit, because applying mutates a
 * real fleet:
 *
 *   1. "Run plan" calls `plan()` and renders the computed PlanDiff, the human
 *      plan text, and the plan hash. The hash is the apply guard.
 *   2. Apply is gated behind an explicit confirmation toggle AND a current plan.
 *      Confirming + clicking "Apply" calls `apply(hash)`; the returned operation
 *      id drives <OperationProgress/>, which polls until terminal and lists the
 *      changed resources.
 *   3. "Recent applies" shows the workspace apply history (newest first) and
 *      refreshes once an apply completes.
 *
 * A 409 from apply means the plan went stale (the workspace changed, or another
 * apply is in flight). We surface that distinctly with a prompt to re-run plan,
 * since a blind retry of the same hash would just 409 again.
 *
 * This page only consumes the shared App Core surface (client + hooks +
 * components); it adds no shared primitives and does not touch the router.
 */

import { useCallback, useState } from "react";
import { apply, ConsoleError, listApplies, plan } from "../../api/client";
import type {
  ApplyHistoryEntry,
  OperationStatus,
  PlanResponse,
} from "../../api/types";
import {
  Badge,
  Button,
  Card,
  CodeBlock,
  EmptyState,
  ErrorBanner,
  OperationProgress,
  PageHeader,
  PlanDiff,
  Spinner,
  Toggle,
  type BadgeTone,
} from "../components";
import { usePolling } from "../hooks";

/** Map an apply-history status string to a calm status tone. */
function applyStatusTone(status: string): BadgeTone {
  switch (status.toLowerCase()) {
    case "succeeded":
    case "success":
    case "applied":
    case "ok":
      return "ok";
    case "failed":
    case "error":
      return "danger";
    case "running":
    case "pending":
    case "in_progress":
      return "accent";
    default:
      return "neutral";
  }
}

/** True for a ConsoleError carrying HTTP 409 (stale plan / apply in flight). */
function isConflict(err: unknown): err is ConsoleError {
  return err instanceof ConsoleError && err.status === 409;
}

/** Short, monospace presentation of the plan hash with an explicit label. */
function PlanHash({ hash }: { hash: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs font-medium text-muted">Plan hash</span>
      <code
        className="rounded bg-canvas px-1.5 py-0.5 font-mono text-xs text-fg"
        data-testid="plan-hash"
      >
        {hash}
      </code>
    </div>
  );
}

export default function PlanApplyPage() {
  // --- Plan state ---------------------------------------------------------
  const [planResult, setPlanResult] = useState<PlanResponse | null>(null);
  const [planError, setPlanError] = useState<unknown>(null);
  const [planning, setPlanning] = useState(false);

  // --- Apply state --------------------------------------------------------
  const [confirmed, setConfirmed] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<unknown>(null);
  const [operationId, setOperationId] = useState<string | null>(null);

  // --- Destroy confirmations (drive the plan request) ---------------------
  // Off by default, so a plain plan reports protected destructions as blocked
  // rather than performing them. Toggling either re-plans with the new scope.
  const [allowProtectedDestroy, setAllowProtectedDestroy] = useState(false);
  const [destroyData, setDestroyData] = useState(false);

  // --- Apply history (polled, refreshed on completion) --------------------
  const {
    data: applies,
    error: appliesError,
    loading: appliesLoading,
    refresh: refreshApplies,
  } = usePolling<ApplyHistoryEntry[]>(() => listApplies(), 0, []);

  const runPlan = useCallback(
    async (flags?: { allowProtectedDestroy: boolean; destroyData: boolean }) => {
      const effective = flags ?? { allowProtectedDestroy, destroyData };
      setPlanning(true);
      setPlanError(null);
      // A fresh plan invalidates any prior apply intent: the old hash is stale,
      // so reset the confirmation gate, the apply error, and any tracked op.
      setConfirmed(false);
      setApplyError(null);
      setOperationId(null);
      try {
        const result = await plan(effective);
        setPlanResult(result);
      } catch (err) {
        setPlanError(err);
        setPlanResult(null);
      } finally {
        setPlanning(false);
      }
    },
    [allowProtectedDestroy, destroyData],
  );

  // Toggling a destroy confirmation re-plans immediately with the new scope, so
  // the rendered diff (and the hash apply is bound to) always reflect exactly
  // what apply will do.
  const onToggleProtected = useCallback(
    (next: boolean) => {
      setAllowProtectedDestroy(next);
      void runPlan({ allowProtectedDestroy: next, destroyData });
    },
    [runPlan, destroyData],
  );
  const onToggleDestroyData = useCallback(
    (next: boolean) => {
      setDestroyData(next);
      void runPlan({ allowProtectedDestroy, destroyData: next });
    },
    [runPlan, allowProtectedDestroy],
  );

  const runApply = useCallback(async () => {
    if (!planResult || !confirmed) return;
    setApplying(true);
    setApplyError(null);
    setOperationId(null);
    try {
      const res = await apply(planResult.hash);
      setOperationId(res.operation_id);
    } catch (err) {
      setApplyError(err);
    } finally {
      setApplying(false);
    }
  }, [planResult, confirmed]);

  // When an apply reaches a terminal state, refresh the history so the new row
  // appears, and drop the confirmation gate so a further apply is deliberate.
  const handleApplyDone = useCallback(
    (_status: OperationStatus) => {
      setConfirmed(false);
      refreshApplies();
    },
    [refreshApplies],
  );

  const hasPlan = planResult !== null;
  const hasChanges = (planResult?.changes.length ?? 0) > 0;
  const hasBlocked = (planResult?.changes ?? []).some((c) => c.kind === "!");
  const needsProtected = planResult?.requires_protected_confirm ?? false;
  const needsData = planResult?.requires_destroy_data ?? false;
  // A destructive plan is "ready" once every required confirmation is given and
  // the plan no longer reports blocked resources.
  const destroyReady =
    !hasBlocked &&
    (!needsProtected || allowProtectedDestroy) &&
    (!needsData || destroyData);
  // Apply is only meaningful with a current plan, an explicit confirmation, no
  // apply already in flight, and — for destructive plans — every destroy
  // confirmation satisfied.
  const applyDisabled =
    !hasPlan || !confirmed || applying || operationId !== null || !destroyReady;

  return (
    <>
      <PageHeader
        title="Plan & apply"
        description="Preview changes against recorded state, then apply them."
        actions={
          <Button
            variant="primary"
            onClick={() => void runPlan()}
            loading={planning}
          >
            {hasPlan ? "Re-run plan" : "Run plan"}
          </Button>
        }
      />

      <div className="space-y-6">
        {/* Plan output --------------------------------------------------- */}
        <Card
          title="Plan"
          description="A dry run of the changes Companion would make."
          actions={hasPlan ? <PlanHash hash={planResult.hash} /> : undefined}
        >
          {planError ? (
            <ErrorBanner
              title="Plan failed"
              error={planError}
              onRetry={() => void runPlan()}
            />
          ) : planning && !hasPlan ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted">
              <Spinner label="Running plan" />
              <span>Computing plan…</span>
            </div>
          ) : !hasPlan ? (
            <EmptyState
              title="No plan yet"
              description="Use “Run plan” above to preview what would change before applying."
            />
          ) : (
            <div className="space-y-4">
              <PlanDiff changes={planResult.changes} />
              {planResult.text.trim() !== "" && (
                <details className="group">
                  <summary className="cursor-pointer text-xs font-medium text-muted select-none hover:text-fg">
                    Plan output
                  </summary>
                  <CodeBlock
                    ariaLabel="Plan output"
                    className="mt-2"
                  >
                    {planResult.text}
                  </CodeBlock>
                </details>
              )}
            </div>
          )}
        </Card>

        {/* Destroy confirmation ------------------------------------------ */}
        {hasPlan && needsProtected && (
          <Card
            title="Destroy confirmation"
            description="This plan removes protected resources. Confirm explicitly to unblock them."
          >
            <div className="space-y-4 rounded-md border border-danger/40 bg-danger/10 px-4 py-3">
              <p className="text-xs text-danger">
                Protected resources (Fly app, volume, secrets, config, rollout)
                are blocked by default. Destroying them is irreversible — to back
                out, set the agent’s lifecycle back to “present” and re-plan.
              </p>
              <Toggle
                label="Destroy protected resources"
                hint="Allows removing resources marked protect = true."
                checked={allowProtectedDestroy}
                onChange={onToggleProtected}
                disabled={planning || applying || operationId !== null}
              />
              {needsData && (
                <Toggle
                  label="Also destroy persistent data (Fly volumes)"
                  hint="A backup is taken before the volume is removed."
                  checked={destroyData}
                  onChange={onToggleDestroyData}
                  disabled={planning || applying || operationId !== null}
                />
              )}
            </div>
          </Card>
        )}

        {/* Apply --------------------------------------------------------- */}
        {hasPlan && (
          <Card
            title="Apply"
            description="Confirm to apply the plan above to the live fleet."
          >
            <div className="space-y-4">
              {isConflict(applyError) ? (
                <ErrorBanner
                  title="Plan is no longer current"
                  error={applyError}
                  onRetry={() => void runPlan()}
                />
              ) : applyError ? (
                <ErrorBanner
                  title="Apply failed"
                  error={applyError}
                  onRetry={() => void runApply()}
                />
              ) : null}

              {!hasChanges && (
                <p className="text-xs text-muted">
                  This plan makes no changes. Applying is a safe no-op.
                </p>
              )}

              <Toggle
                label="I understand this applies changes to the live fleet."
                hint="Required before applying."
                checked={confirmed}
                onChange={setConfirmed}
                disabled={applying || operationId !== null}
              />

              <div className="flex items-center gap-3">
                <Button
                  variant="danger"
                  onClick={() => void runApply()}
                  disabled={applyDisabled}
                  loading={applying}
                >
                  Apply plan
                </Button>
                {operationId === null && !applying && applyDisabled && (
                  <span className="text-xs text-faint">
                    {!destroyReady
                      ? "Resolve the destroy confirmations above to enable apply."
                      : "Tick the confirmation to enable apply."}
                  </span>
                )}
              </div>

              {operationId !== null && (
                <OperationProgress
                  operationId={operationId}
                  onDone={handleApplyDone}
                />
              )}
            </div>
          </Card>
        )}

        {/* Recent applies ------------------------------------------------ */}
        <Card
          title="Recent applies"
          description="History of apply runs for this workspace."
          actions={
            <Button
              size="sm"
              variant="ghost"
              onClick={refreshApplies}
              loading={appliesLoading && applies !== null}
            >
              Refresh
            </Button>
          }
          bare
        >
          <RecentApplies
            entries={applies}
            error={appliesError}
            loading={appliesLoading}
            onRetry={refreshApplies}
          />
        </Card>
      </div>
    </>
  );
}

/** The "Recent applies" body: loading, error, empty, and list states. */
function RecentApplies({
  entries,
  error,
  loading,
  onRetry,
}: {
  entries: ApplyHistoryEntry[] | null;
  error: Error | null;
  loading: boolean;
  onRetry: () => void;
}) {
  if (error && entries === null) {
    return (
      <div className="p-4">
        <ErrorBanner
          title="Could not load apply history"
          error={error}
          onRetry={onRetry}
        />
      </div>
    );
  }
  if (loading && entries === null) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-muted">
        <Spinner label="Loading apply history" />
        <span>Loading history…</span>
      </div>
    );
  }
  if (!entries || entries.length === 0) {
    return (
      <EmptyState
        className="m-4 border-0"
        title="No applies yet"
        description="Apply a plan and the run will be recorded here."
      />
    );
  }

  return (
    <ul aria-label="Recent applies" className="divide-y divide-line">
      {entries.map((entry) => (
        <li
          key={entry.id}
          className="flex items-center justify-between gap-4 px-4 py-3"
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-fg">#{entry.id}</span>
              <Badge tone={applyStatusTone(entry.status)} dot>
                {entry.status}
              </Badge>
            </div>
            <p className="mt-0.5 text-xs text-muted">
              Started {entry.started_at}
              {entry.finished_at ? ` · finished ${entry.finished_at}` : ""}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}
