/**
 * SettingsPage — workspace details + provider credential status (route
 * "/settings").
 *
 * Loads {@link getWorkspace} and renders two read-only panels:
 *
 *  1. A workspace summary (name, root, agent count).
 *  2. A providers table listing each credential as **name + presence only**.
 *     Provider secret VALUES never cross the API boundary (the DTO carries no
 *     value field) and this view must never invent one — every provider row
 *     shows just its name and a Present / Missing badge.
 *
 * Editing workspace defaults is a later milestone; v1 is intentionally
 * view-only, called out with an inline note.
 */

import { getWorkspace } from "../../api/client";
import type { ProviderCred, WorkspaceInfo } from "../../api/types";
import { usePolling } from "../hooks";
import {
  Badge,
  Card,
  EmptyState,
  ErrorBanner,
  PageHeader,
  Spinner,
} from "../components";

export default function SettingsPage() {
  // Settings is near-static, so fetch once on mount with manual refresh
  // (a non-positive interval disables the repeat timer in usePolling).
  const { data, error, loading, refresh } = usePolling<WorkspaceInfo>(
    () => getWorkspace(),
    0,
  );

  return (
    <>
      <PageHeader
        title="Settings"
        description="Workspace details and provider credential status."
      />

      {/* Error takes precedence so a failed load is announced and retryable. */}
      {error && (
        <ErrorBanner
          title="Could not load workspace settings"
          error={error}
          onRetry={refresh}
          className="mb-6"
        />
      )}

      {/* First load with nothing yet: show a single status spinner. */}
      {loading && !data && !error && (
        <div className="flex justify-center py-16">
          <Spinner label="Loading workspace settings" className="size-6" />
        </div>
      )}

      {data && (
        <div className="space-y-6">
          <WorkspaceSummary workspace={data} />
          <ProvidersPanel providers={data.providers} />
        </div>
      )}
    </>
  );
}

/** A single label/value row in the workspace summary description list. */
function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-baseline sm:gap-4">
      <dt className="w-40 shrink-0 text-xs font-medium tracking-wide text-muted uppercase">
        {label}
      </dt>
      <dd className="min-w-0 font-mono text-sm break-words text-fg">{value}</dd>
    </div>
  );
}

function WorkspaceSummary({ workspace }: { workspace: WorkspaceInfo }) {
  return (
    <Card
      title="Workspace"
      description="The loaded Companion workspace this console manages."
      bare
    >
      <dl className="divide-y divide-line">
        <SummaryRow label="Name" value={workspace.name} />
        <SummaryRow label="Root" value={workspace.root} />
        <SummaryRow label="Agents" value={String(workspace.agent_count)} />
      </dl>
    </Card>
  );
}

/** Present / Missing pill for a single credential — status only, no value. */
function PresenceBadge({ present }: { present: boolean }) {
  return present ? (
    <Badge tone="ok" dot>
      Present
    </Badge>
  ) : (
    <Badge tone="warn" dot>
      Missing
    </Badge>
  );
}

function ProvidersPanel({ providers }: { providers: ProviderCred[] }) {
  return (
    <Card
      title="Providers"
      description="Credential environment variables, shown by name and presence only. Secret values are never read by the console."
      bare
    >
      {providers.length === 0 ? (
        <div className="p-4">
          <EmptyState
            title="No provider credentials"
            description="This workspace declares no provider credentials yet. Add an OpenRouter or other provider to your workspace configuration to see it here."
          />
        </div>
      ) : (
        <table className="w-full text-sm">
          <caption className="sr-only">
            Provider credentials and whether each is present
          </caption>
          <thead>
            <tr className="border-b border-line text-left">
              <th
                scope="col"
                className="px-4 py-2 text-xs font-medium tracking-wide text-muted uppercase"
              >
                Provider
              </th>
              <th
                scope="col"
                className="px-4 py-2 text-right text-xs font-medium tracking-wide text-muted uppercase"
              >
                Status
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {providers.map((p) => (
              <tr key={p.name}>
                <th
                  scope="row"
                  className="px-4 py-3 text-left font-mono text-sm font-normal break-words text-fg"
                >
                  {p.name}
                </th>
                <td className="px-4 py-3 text-right">
                  <PresenceBadge present={p.present} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
