/**
 * AgentsPage — fleet agent list (route "/").
 *
 * Lists the workspace's agents in a dense table (lifecycle, health, Fly state,
 * model, vault, Tailscale URL, last deploy) with each row linking to the agent
 * detail view. Below the agents, any non-agent support services from the live
 * status snapshot (Open WebUI, the dashboard) are surfaced in their own section.
 *
 * Data comes from two sources that are merged here:
 *   - `listAgents()` is the config-derived source of truth (always available,
 *     no live network). Its rows already carry health/fly_state/url when the
 *     server had a snapshot at request time.
 *   - `useStatus()` polls the live fleet snapshot; we use it to enrich each
 *     agent row by id (health / fly_state / url) when the list row is missing
 *     those fields, and to populate the support-services section.
 *
 * Every list state is handled: loading (spinner), error (retryable banner), and
 * empty (a call-to-action to create the first agent).
 */

import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { listAgents } from "../../api/client";
import type { AgentSummary, ServiceStatus } from "../../api/types";
import { usePolling, useStatus } from "../hooks";
import {
  Badge,
  Card,
  EmptyState,
  ErrorBanner,
  HealthBadge,
  PageHeader,
  Spinner,
} from "../components";

/** Shared primary-action styling for links rendered as accent buttons. */
const PRIMARY_LINK_CLASS =
  "inline-flex h-9 items-center justify-center gap-2 rounded-md bg-accent " +
  "px-4 text-sm font-medium text-accent-fg transition-colors hover:bg-accent-muted " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/** Agents change rarely; poll the config-derived list on a calm interval. */
const AGENTS_POLL_MS = 15000;

export default function AgentsPage() {
  const {
    data: agents,
    error,
    loading,
    refresh,
  } = usePolling<AgentSummary[]>(() => listAgents(), AGENTS_POLL_MS);

  // Live snapshot is best-effort enrichment; its own failure must not blank the
  // page, so we read only its data and ignore its error/loading here.
  const { data: status } = useStatus();
  const serviceById = indexServices(status?.services);
  const supportServices = (status?.services ?? []).filter(
    (svc) => !isAgentKind(svc.kind),
  );

  return (
    <>
      <PageHeader
        title="Agents"
        description="Your fleet's agents, their health, and lifecycle."
        actions={
          // Render the primary action as a real <a>-backed Link so it is
          // keyboard- and screen-reader-operable as a navigation control.
          <Link to="/agents/new" className={PRIMARY_LINK_CLASS}>
            New agent
          </Link>
        }
      />

      <AgentsSection
        agents={agents}
        loading={loading}
        error={error}
        onRetry={refresh}
        serviceById={serviceById}
      />

      <SupportSection services={supportServices} />
    </>
  );
}

/* --- Agents table -------------------------------------------------------- */

interface AgentsSectionProps {
  agents: AgentSummary[] | null;
  loading: boolean;
  error: Error | null;
  onRetry: () => void;
  serviceById: Map<string, ServiceStatus>;
}

function AgentsSection({
  agents,
  loading,
  error,
  onRetry,
  serviceById,
}: AgentsSectionProps) {
  // Error wins over a stale list so failures are never silently hidden.
  if (error) {
    return (
      <ErrorBanner
        title="Could not load agents"
        error={error}
        onRetry={onRetry}
      />
    );
  }

  // Initial load (no data yet): show a spinner, not an empty table.
  if (loading && agents === null) {
    return (
      <Card>
        <div className="flex items-center justify-center py-12">
          <Spinner label="Loading agents" className="size-5" />
        </div>
      </Card>
    );
  }

  const rows = agents ?? [];
  if (rows.length === 0) {
    return (
      <EmptyState
        title="No agents yet"
        description="Create your first agent to start building out the fleet."
        action={
          <Link to="/agents/new" className={PRIMARY_LINK_CLASS}>
            Create an agent
          </Link>
        }
      />
    );
  }

  return (
    <Card bare title="Fleet agents" description={`${rows.length} configured`}>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">Fleet agents</caption>
          <thead>
            <tr className="border-b border-line text-left text-xs text-muted">
              <Th>Agent</Th>
              <Th>Lifecycle</Th>
              <Th>Health</Th>
              <Th>Fly state</Th>
              <Th>Model</Th>
              <Th>Vault</Th>
              <Th>URL</Th>
              <Th>Last deploy</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((agent) => (
              <AgentRow
                key={agent.id}
                agent={enrichAgent(agent, serviceById.get(agent.id))}
              />
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function AgentRow({ agent }: { agent: AgentSummary }) {
  return (
    <tr className="border-b border-line/60 last:border-0 hover:bg-surface-raised/60">
      <td className="px-3 py-2.5">
        <Link
          to={`/agents/${encodeURIComponent(agent.id)}`}
          className="font-medium text-fg underline-offset-2 hover:text-accent hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {agent.id}
        </Link>
      </td>
      <td className="px-3 py-2.5">
        <LifecycleBadge lifecycle={agent.lifecycle} />
      </td>
      <td className="px-3 py-2.5">
        <HealthBadge health={agent.health} />
      </td>
      <td className="px-3 py-2.5 text-muted">
        <Mono value={agent.fly_state} />
      </td>
      <td className="px-3 py-2.5 text-muted">
        <Mono value={agent.model} />
      </td>
      <td className="px-3 py-2.5 text-muted">
        {agent.vault ? <Mono value={agent.vault} /> : <Dash />}
      </td>
      <td className="px-3 py-2.5">
        {agent.url ? (
          <a
            href={agent.url}
            target="_blank"
            rel="noreferrer"
            className="text-accent underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {hostOf(agent.url)}
          </a>
        ) : (
          <Dash />
        )}
      </td>
      <td className="px-3 py-2.5 text-muted">
        {agent.last_deploy ? <Mono value={agent.last_deploy} /> : <Dash />}
      </td>
    </tr>
  );
}

/* --- Support services ---------------------------------------------------- */

function SupportSection({ services }: { services: ServiceStatus[] }) {
  if (services.length === 0) {
    return null;
  }
  return (
    <section className="mt-8" aria-labelledby="support-services-heading">
      <h2
        id="support-services-heading"
        className="mb-3 text-sm font-semibold text-fg"
      >
        Support services
      </h2>
      <Card bare>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">Support services</caption>
            <thead>
              <tr className="border-b border-line text-left text-xs text-muted">
                <Th>Service</Th>
                <Th>Kind</Th>
                <Th>Health</Th>
                <Th>URL</Th>
              </tr>
            </thead>
            <tbody>
              {services.map((svc) => (
                <tr
                  key={svc.id}
                  className="border-b border-line/60 last:border-0 hover:bg-surface-raised/60"
                >
                  <td className="px-3 py-2.5 font-medium text-fg">{svc.id}</td>
                  <td className="px-3 py-2.5">
                    <Badge tone="neutral">{labelForKind(svc.kind)}</Badge>
                  </td>
                  <td className="px-3 py-2.5">
                    <HealthBadge health={svc.health} />
                  </td>
                  <td className="px-3 py-2.5">
                    {svc.url ? (
                      <a
                        href={svc.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-accent underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                      >
                        {hostOf(svc.url)}
                      </a>
                    ) : (
                      <Dash />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </section>
  );
}

/* --- Local presentational + data helpers --------------------------------- */

function Th({ children }: { children: ReactNode }) {
  return <th className="px-3 py-2 font-medium">{children}</th>;
}

function Mono({ value }: { value?: string }) {
  if (!value) return <Dash />;
  return <span className="font-mono text-xs text-muted">{value}</span>;
}

function Dash() {
  return (
    <span className="text-faint" aria-hidden="true">
      —
    </span>
  );
}

/** Lifecycle pill: present is calm/neutral, absent (pending destroy) is danger. */
function LifecycleBadge({ lifecycle }: { lifecycle: string }) {
  const absent = lifecycle === "absent";
  return (
    <Badge tone={absent ? "danger" : "neutral"}>{lifecycle || "unknown"}</Badge>
  );
}

/** Builds a by-id lookup of snapshot services for O(1) enrichment. */
function indexServices(
  services: ServiceStatus[] | undefined,
): Map<string, ServiceStatus> {
  const map = new Map<string, ServiceStatus>();
  for (const svc of services ?? []) {
    map.set(svc.id, svc);
  }
  return map;
}

/**
 * Enriches a config-derived agent row with live snapshot fields by id, filling
 * only the values the list row lacks. The server already enriches when it has a
 * snapshot, so this covers the case where the live poll is fresher than the list
 * response.
 */
function enrichAgent(
  agent: AgentSummary,
  svc: ServiceStatus | undefined,
): AgentSummary {
  if (!svc) return agent;
  return {
    ...agent,
    health: agent.health ?? svc.health,
    fly_state: agent.fly_state ?? svc.machine_state,
    url: agent.url ?? svc.url,
  };
}

/** Status snapshot kind for fleet agents (vs. support services). */
function isAgentKind(kind: string): boolean {
  return kind === "agent";
}

function labelForKind(kind: string): string {
  switch (kind) {
    case "openwebui":
      return "Open WebUI";
    case "dashboard":
      return "Dashboard";
    default:
      return kind || "service";
  }
}

/** Renders a friendlier host label for a URL, falling back to the raw value. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
