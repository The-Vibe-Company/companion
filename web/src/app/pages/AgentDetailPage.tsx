/**
 * AgentDetailPage — single agent view + edit (route "/agents/:id").
 *
 * Loads the agent via getAgent(id) and presents:
 *   - a status card (HealthBadge, fly_state, url, last_deploy + key facts);
 *   - an editable AgentForm (mode="edit") that PUTs via updateAgent(id, input);
 *   - the server-rendered SOUL.md preview as read-only context (CodeBlock), with
 *     the form's `soul` textarea left blank by default so saving preserves the
 *     existing SOUL.md (the API only overwrites SOUL.md when `soul` is non-empty);
 *   - Granite/vault settings: the companion-soul toggle (inside the form) plus a
 *     read-only list of vault_connections;
 *   - recent offline state events via getAgentLogs(id) with the offline note;
 *   - a per-agent Plan & Apply flow (plan() -> PlanDiff -> hash-gated apply());
 *   - a Delete action gated by ConfirmDialog that calls deleteAgent(id), which
 *     marks the agent lifecycle="absent" (destroyed on the next apply), not an
 *     instant delete.
 *
 * Security: provider secrets never appear here; only config-derived agent fields
 * and offline state events are shown.
 */

import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  apply as applyPlan,
  deleteAgent,
  getAgent,
  getAgentLogs,
  plan as runPlan,
  updateAgent,
} from "../../api/client";
import type {
  AgentDetail,
  AgentInput,
  LogsResponse,
  PlanResponse,
} from "../../api/types";
import { usePolling } from "../hooks";
import {
  AgentForm,
  Badge,
  Button,
  Card,
  CodeBlock,
  ConfirmDialog,
  EmptyState,
  ErrorBanner,
  HealthBadge,
  OperationProgress,
  PageHeader,
  PlanDiff,
  Spinner,
} from "../components";

/** Maps an AgentDetail (read view) to the AgentInput the edit form mutates.
 *
 * AgentDetail carries no `name` and only a truncated `soul_preview`, so:
 *  - `name` is seeded from the id (the user can rename in the form);
 *  - `soul` starts blank so a plain save keeps the existing SOUL.md intact
 *    (the preview is shown separately, read-only).
 */
function detailToInput(detail: AgentDetail): AgentInput {
  return {
    id: detail.id,
    name: detail.id,
    model: detail.model,
    memory: detail.memory,
    cpus: detail.cpus,
    region: detail.region,
    tailscale_hostname: detail.tailscale_hostname,
    fly_app: detail.fly_app,
    runtime: detail.runtime,
    network: detail.network,
    model_provider: detail.model_provider,
    lifecycle: detail.lifecycle,
    soul: "",
    companion_soul_enabled: detail.companion_soul_enabled,
    vault_name: detail.vault,
  };
}

export default function AgentDetailPage() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();

  // Single fetch of the agent detail (interval 0 = load once + manual refresh).
  const {
    data: agent,
    error: loadError,
    loading,
    refresh,
  } = usePolling<AgentDetail>(() => getAgent(id), 0, [id]);

  return (
    <>
      <PageHeader
        eyebrow={
          <Button
            size="sm"
            variant="ghost"
            onClick={() => navigate("/")}
            className="-ml-2"
          >
            ← All agents
          </Button>
        }
        title={<span className="font-mono">{id || "Agent"}</span>}
        description="Agent configuration, status, and recent activity."
        actions={
          agent ? (
            <Badge tone={agent.lifecycle === "absent" ? "danger" : "neutral"}>
              {agent.lifecycle}
            </Badge>
          ) : undefined
        }
      />

      {loading && !agent && (
        <div className="py-16">
          <Spinner label={`Loading ${id}`} />
        </div>
      )}

      {loadError && !agent && (
        <ErrorBanner
          title={`Could not load agent "${id}"`}
          error={loadError}
          onRetry={refresh}
        />
      )}

      {agent && (
        <AgentDetailBody
          id={id}
          agent={agent}
          onSaved={refresh}
          onDeleted={() => navigate("/")}
        />
      )}
    </>
  );
}

interface BodyProps {
  id: string;
  agent: AgentDetail;
  /** Called after a successful edit so the page re-reads the agent. */
  onSaved: () => void;
  /** Called after the agent is marked absent (navigates away). */
  onDeleted: () => void;
}

function AgentDetailBody({ id, agent, onSaved, onDeleted }: BodyProps) {
  // Edit form value. Re-seeded whenever the loaded agent identity changes.
  const [input, setInput] = useState<AgentInput>(() => detailToInput(agent));
  useEffect(() => {
    setInput(detailToInput(agent));
    // Re-seed only on a genuinely new load (id or server-side fields), not on
    // every keystroke (those flow through onChange below).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    agent.id,
    agent.model,
    agent.memory,
    agent.cpus,
    agent.region,
    agent.lifecycle,
    agent.companion_soul_enabled,
  ]);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const handleSubmit = useCallback(
    async (value: AgentInput) => {
      setSaving(true);
      setSaveError(null);
      try {
        await updateAgent(id, value);
        setSavedAt(Date.now());
        onSaved();
      } catch (err) {
        setSaveError(err);
      } finally {
        setSaving(false);
      }
    },
    [id, onSaved],
  );

  return (
    <div className="space-y-6">
      <StatusCard agent={agent} />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card
            title="Configuration"
            description="Edit and save to rewrite this agent's TOML; the change lands on the next plan & apply."
          >
            {saveError != null && (
              <ErrorBanner
                title="Could not save changes"
                error={saveError}
                className="mb-4"
              />
            )}
            {savedAt != null && saveError == null && !saving && (
              <div
                role="status"
                className="mb-4 rounded-md border border-ok/30 bg-ok/10 px-3 py-2 text-xs text-ok"
              >
                Saved. Run plan &amp; apply below to deploy the change.
              </div>
            )}
            <AgentForm
              value={input}
              onChange={setInput}
              onSubmit={handleSubmit}
              submitLabel="Save changes"
              disabled={saving}
              mode="edit"
            />
          </Card>

          <SoulPreviewCard preview={agent.soul_preview} />
        </div>

        <div className="space-y-6">
          <GraniteCard agent={agent} />
          <LogsCard id={id} />
          <PlanApplyCard agentId={id} />
          <DangerCard id={id} onDeleted={onDeleted} />
        </div>
      </div>
    </div>
  );
}

/** Top status strip: health, fly state, deploy time, and a link to the agent. */
function StatusCard({ agent }: { agent: AgentDetail }) {
  return (
    <Card>
      <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Fact label="Health">
          <HealthBadge health={agent.health} />
        </Fact>
        <Fact label="Fly state">
          {agent.fly_state ? (
            <span className="font-mono text-sm text-fg">{agent.fly_state}</span>
          ) : (
            <span className="text-sm text-faint">unknown</span>
          )}
        </Fact>
        <Fact label="Model">
          <span className="font-mono text-sm text-fg">{agent.model || "—"}</span>
        </Fact>
        <Fact label="Last deploy">
          <span className="text-sm text-muted">{agent.last_deploy || "—"}</span>
        </Fact>
      </dl>
      {agent.url && (
        <div className="mt-4 border-t border-line pt-4">
          <a
            href={agent.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 font-mono text-xs text-accent hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {agent.url}
            <span aria-hidden="true">↗</span>
          </a>
        </div>
      )}
    </Card>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium tracking-wide text-muted uppercase">
        {label}
      </dt>
      <dd className="mt-1 truncate">{children}</dd>
    </div>
  );
}

/** Read-only SOUL.md preview (truncated server-side). */
function SoulPreviewCard({ preview }: { preview: string }) {
  return (
    <Card
      title="SOUL.md preview"
      description="A truncated preview of the effective identity. Edit the SOUL.md field above to replace it; leaving it blank keeps the current soul."
    >
      {preview.trim() ? (
        <CodeBlock ariaLabel="SOUL.md preview">{preview}</CodeBlock>
      ) : (
        <EmptyState
          title="No identity soul"
          description="This agent has no SOUL.md identity, or it is empty."
        />
      )}
    </Card>
  );
}

/** Granite vault settings: companion soul state + read-only vault connections. */
function GraniteCard({ agent }: { agent: AgentDetail }) {
  const connections = agent.vault_connections ?? [];
  return (
    <Card title="Granite & vaults">
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm text-fg">Companion soul</p>
            <p className="text-xs text-muted">
              Fleet-wide SOUL.md appended after this agent&apos;s identity.
            </p>
          </div>
          <Badge tone={agent.companion_soul_enabled ? "ok" : "neutral"} dot>
            {agent.companion_soul_enabled ? "enabled" : "disabled"}
          </Badge>
        </div>

        <div>
          <p className="mb-1.5 text-xs font-medium tracking-wide text-muted uppercase">
            Default vault
          </p>
          {agent.vault ? (
            <span className="font-mono text-xs text-fg">{agent.vault}</span>
          ) : (
            <span className="text-xs text-faint">none</span>
          )}
        </div>

        <div>
          <p className="mb-1.5 text-xs font-medium tracking-wide text-muted uppercase">
            Shared vault connections
          </p>
          {connections.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5">
              {connections.map((vc) => (
                <li key={vc}>
                  <Badge tone="accent">{vc}</Badge>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-faint">
              No shared vault connections (read-only).
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}

/** Recent offline state events for the agent. */
function LogsCard({ id }: { id: string }) {
  const {
    data: logs,
    error,
    loading,
    refresh,
  } = usePolling<LogsResponse>(() => getAgentLogs(id), 0, [id]);

  return (
    <Card
      title="Recent activity"
      actions={
        <Button size="sm" variant="ghost" onClick={refresh} disabled={loading}>
          Refresh
        </Button>
      }
    >
      {loading && !logs && (
        <div className="py-4">
          <Spinner label="Loading activity" />
        </div>
      )}
      {error && !logs && (
        <ErrorBanner title="Could not load activity" error={error} onRetry={refresh} />
      )}
      {logs && (
        <div className="space-y-2">
          {logs.lines.length > 0 ? (
            <CodeBlock ariaLabel="Recent state events">
              {logs.lines.join("\n")}
            </CodeBlock>
          ) : (
            <EmptyState
              title="No recent events"
              description="No offline state events have been recorded for this agent yet."
            />
          )}
          {logs.note && (
            <p className="text-xs text-faint">
              <span className="font-medium">Note:</span> {logs.note}
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

type ApplyPhase = "idle" | "planning" | "planned" | "applying";

/** Per-agent plan & apply: plan(), show the diff, then a hash-gated apply(). */
function PlanApplyCard({ agentId }: { agentId: string }) {
  const [phase, setPhase] = useState<ApplyPhase>("idle");
  const [planResult, setPlanResult] = useState<PlanResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [operationId, setOperationId] = useState<string | null>(null);

  const handlePlan = useCallback(async () => {
    setPhase("planning");
    setError(null);
    setPlanResult(null);
    setOperationId(null);
    try {
      const result = await runPlan();
      setPlanResult(result);
      setPhase("planned");
    } catch (err) {
      setError(err);
      setPhase("idle");
    }
  }, []);

  const handleConfirmApply = useCallback(async () => {
    if (!planResult) return;
    setPhase("applying");
    setError(null);
    try {
      const res = await applyPlan(planResult.hash);
      setOperationId(res.operation_id);
      setConfirmOpen(false);
    } catch (err) {
      // A 409 here means the plan went stale (concurrent change / in-flight
      // apply): drop the diff and ask the user to re-plan.
      setError(err);
      setConfirmOpen(false);
      setPhase("idle");
      setPlanResult(null);
    }
  }, [planResult]);

  const planning = phase === "planning";
  const applying = phase === "applying";

  return (
    <Card
      title="Plan & apply"
      description="Preview and deploy pending changes for the whole workspace."
    >
      <div className="space-y-3">
        {error != null && (
          <ErrorBanner title="Plan or apply failed" error={error} />
        )}

        <Button
          variant="secondary"
          onClick={handlePlan}
          loading={planning}
          disabled={planning || applying}
        >
          {planResult ? "Re-plan" : "Plan changes"}
        </Button>

        {planResult && (
          <>
            <PlanDiff changes={planResult.changes} />
            {planResult.changes.length > 0 && (
              <div className="flex items-center justify-end">
                <Button
                  variant="primary"
                  onClick={() => setConfirmOpen(true)}
                  disabled={applying || operationId != null}
                >
                  Apply
                </Button>
              </div>
            )}
          </>
        )}

        {operationId && (
          <OperationProgress
            operationId={operationId}
            onDone={() => setPhase("idle")}
          />
        )}
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="Apply planned changes?"
        confirmLabel="Apply"
        confirmVariant="primary"
        pending={applying}
        onConfirm={handleConfirmApply}
        onCancel={() => setConfirmOpen(false)}
      >
        This deploys the {planResult?.changes.length ?? 0} planned change
        {planResult?.changes.length === 1 ? "" : "s"} to the live fleet over
        Tailscale. This affects real Fly resources for{" "}
        <span className="font-mono">{agentId}</span> and the rest of the
        workspace.
      </ConfirmDialog>
    </Card>
  );
}

/** Destructive zone: mark the agent absent (destroyed on next apply). */
function DangerCard({ id, onDeleted }: { id: string; onDeleted: () => void }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const handleConfirmDelete = useCallback(async () => {
    setDeleting(true);
    setError(null);
    try {
      await deleteAgent(id);
      setConfirmOpen(false);
      onDeleted();
    } catch (err) {
      setError(err);
      setDeleting(false);
      setConfirmOpen(false);
    }
  }, [id, onDeleted]);

  return (
    <Card title="Danger zone" className="border-danger/30">
      <div className="space-y-3">
        {error != null && (
          <ErrorBanner title="Could not mark agent absent" error={error} />
        )}
        <p className="text-xs text-muted">
          Marks this agent as <span className="font-mono">absent</span>. It is
          not deleted immediately — the next plan renders an explicit destroy and
          apply tears it down.
        </p>
        <Button variant="danger" onClick={() => setConfirmOpen(true)}>
          Delete agent
        </Button>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="Mark agent absent?"
        confirmLabel="Mark absent"
        confirmVariant="danger"
        pending={deleting}
        onConfirm={handleConfirmDelete}
        onCancel={() => setConfirmOpen(false)}
      >
        This sets <span className="font-mono">{id}</span> to lifecycle{" "}
        <span className="font-mono">absent</span>. The TOML is kept so the next
        plan shows an explicit destroy; nothing is torn down until you apply.
      </ConfirmDialog>
    </Card>
  );
}
