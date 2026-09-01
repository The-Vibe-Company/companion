"use client";

import { useState } from "react";
import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import type {
  CompanionConfigProposal,
  CompanionDecisionKind,
  CompanionDecisionStatus,
  CompanionRoutineProposal,
  CompanionTriggerProposal,
} from "@companion/contracts";
import { companionConfigProposalConnectProviderSchema } from "@companion/contracts";
import {
  AlertTriangleIcon,
  CalendarClockIcon,
  CheckIcon,
  BoxesIcon,
  FilePenLineIcon,
  LoaderIcon,
  MessageSquareIcon,
  Settings2Icon,
  TerminalIcon,
  WebhookIcon,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  useDecisionActions,
  type DecisionAction,
  type DecisionNamedResource,
} from "./decisionActions";
import type { CompanionDecisionArgs } from "./transcriptMessages";

/**
 * One permission card in the thread.
 *
 * Pi is blocked while this is pending — the Box extension is holding a shell command, a file edit, or
 * a question open — so the card is the loudest thing the transcript ever shows, and it stays in place
 * once it is decided rather than disappearing: who allowed what, and when, is part of the record.
 * Only an Owner or Editor is offered the controls; a Viewer reads the same card and is told who the
 * thread is waiting on. A card that timed out reads as denied, because that is what fail-closed did.
 *
 * Config cards name the Companion as the proposer so prompt-injected copy cannot impersonate the
 * operator. Resource names come from data this surface already loaded, never from the Pi payload.
 */

const DECISION_ICONS = {
  shell: TerminalIcon,
  file: FilePenLineIcon,
  question: MessageSquareIcon,
  config: Settings2Icon,
  routine: CalendarClockIcon,
  trigger: WebhookIcon,
  control: BoxesIcon,
} satisfies Record<CompanionDecisionKind, LucideIcon>;

const DECISION_KIND_LABELS = {
  shell: "run a command",
  file: "edit a file",
  question: "asks",
  config: "these settings",
  routine: "this routine",
  trigger: "this trigger",
  control: "this Companion change",
} satisfies Record<CompanionDecisionKind, string>;

const DECISION_STATUS_LABELS = {
  pending: "waiting",
  allowed: "allowed",
  denied: "denied",
  answered: "answered",
  expired: "timed out",
  cancelled: "closed without approval",
} satisfies Record<CompanionDecisionStatus, string>;

const UNKNOWN_RESOURCE = "a resource owned by another member";

function namedLabel(
  id: string,
  catalog: readonly DecisionNamedResource[],
): { label: string; known: boolean } {
  const match = catalog.find((item) => item.id === id);
  return match ? { label: match.label, known: true } : { label: UNKNOWN_RESOURCE, known: false };
}

function ConfigChangeList({
  proposal,
  skills,
  plugins,
  models,
}: {
  proposal: CompanionConfigProposal;
  skills: readonly DecisionNamedResource[];
  plugins: readonly DecisionNamedResource[];
  models: readonly DecisionNamedResource[];
}) {
  if (proposal.connect_plugin) {
    const server = proposal.connect_plugin.server_name;
    return (
      <div className="mt-1.5 space-y-1.5 text-sm">
        <p>
          Connect <span className="font-medium capitalize">{server}</span>
          {proposal.connect_plugin.reason ? ` — ${proposal.connect_plugin.reason}` : ""}
        </p>
        <a className="text-primary underline-offset-2 hover:underline" href="/companions?view=plugins">
          Finish this connection in Plugins
        </a>
      </div>
    );
  }

  const rows: { sign: string; label: string; known: boolean }[] = [];
  for (const id of proposal.add_skill_ids ?? []) {
    const named = namedLabel(id, skills);
    rows.push({ sign: "+", label: named.label, known: named.known });
  }
  for (const id of proposal.remove_skill_ids ?? []) {
    const named = namedLabel(id, skills);
    rows.push({ sign: "−", label: named.label, known: named.known });
  }
  for (const id of proposal.attach_plugin_ids ?? []) {
    const named = namedLabel(id, plugins);
    rows.push({ sign: "+", label: `plugin ${named.label}`, known: named.known });
  }
  for (const id of proposal.detach_plugin_ids ?? []) {
    const named = namedLabel(id, plugins);
    rows.push({ sign: "−", label: `plugin ${named.label}`, known: named.known });
  }
  if (proposal.model_id) {
    const named = namedLabel(proposal.model_id, models);
    rows.push({
      sign: "→",
      label: `model ${named.known ? named.label : proposal.model_id}`,
      known: true,
    });
  }

  return (
    <div className="mt-1.5 space-y-1.5">
      {rows.length > 0 && (
        <ul className="text-foreground space-y-0.5 text-sm">
          {rows.map((row, index) => (
            <li key={`${row.sign}:${row.label}:${index}`} className="flex gap-2">
              <span className="text-muted-foreground w-3 shrink-0 font-mono" aria-hidden="true">
                {row.sign}
              </span>
              <span className={row.known ? undefined : "text-muted-foreground"}>{row.label}</span>
            </li>
          ))}
        </ul>
      )}
      {proposal.persona !== undefined && (
        <details className="text-sm">
          <summary className="text-muted-foreground cursor-pointer select-none">Persona</summary>
          <p className="text-foreground mt-1 whitespace-pre-wrap">
            {proposal.persona?.trim() ? proposal.persona : "(empty)"}
          </p>
        </details>
      )}
    </div>
  );
}

function TriggerProposal({ proposal }: { proposal: CompanionTriggerProposal }) {
  return (
    <div className="mt-1.5 space-y-1.5 text-sm">
      <p>
        <span className="font-medium">{proposal.name}</span>
        <span className="text-muted-foreground"> · </span>
        <span className="font-mono text-xs">{proposal.provider}</span>
      </p>
      <details>
        <summary className="text-muted-foreground cursor-pointer select-none">Prompt</summary>
        <p className="text-foreground mt-1 max-h-40 overflow-auto whitespace-pre-wrap">
          {proposal.prompt}
        </p>
      </details>
    </div>
  );
}

function RoutineProposal({ proposal }: { proposal: CompanionRoutineProposal }) {
  return (
    <div className="mt-1.5 space-y-1.5 text-sm">
      <p>
        <span className="font-medium">{proposal.name}</span>
        <span className="text-muted-foreground"> · </span>
        <span className="font-mono text-xs">{proposal.cron}</span>
        <span className="text-muted-foreground"> · {proposal.timezone}</span>
      </p>
      <details>
        <summary className="text-muted-foreground cursor-pointer select-none">Prompt</summary>
        <p className="text-foreground mt-1 max-h-40 overflow-auto whitespace-pre-wrap">
          {proposal.prompt}
        </p>
      </details>
    </div>
  );
}

export const DecisionToolCard: ToolCallMessagePartComponent<CompanionDecisionArgs> = ({ args }) => {
  const { canAct, access, companionId, companionName, skills, plugins, models, onDecide } = useDecisionActions();
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decision = args?.decision;
  if (!decision) return null;

  const control = decision.kind === "control";
  const pending = decision.status === "pending" || (control && decision.control_status === "applying");
  const canApprove = canAct && (decision.required_access !== "owner" || access === "owner");
  const interactive = decision.status === "pending" && canApprove && !busy;
  const settledWell = control
    ? decision.control_status === "applied"
    : decision.status === "allowed" || decision.status === "answered";
  const status = DECISION_STATUS_LABELS[decision.status];
  const KindIcon = DECISION_ICONS[decision.kind];
  const requestId = decision.request_id;
  const config = decision.kind === "config";
  const routine = decision.kind === "routine";
  const trigger = decision.kind === "trigger";
  const controlPluginProvider = control
    && decision.proposal?.kind === "control"
    && decision.proposal.request_kind === "plugin_connection"
      ? companionConfigProposalConnectProviderSchema.safeParse(decision.proposal.payload.provider).data ?? null
      : null;

  async function act(input: DecisionAction) {
    if (!interactive) return;
    setBusy(true);
    setError(null);
    try {
      await onDecide(requestId, input);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "This change could not be applied.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      data-slot="companion-decision"
      className={cn(
        "my-2 w-full rounded-md border p-2.5 text-sm",
        // Full-alpha accent: Pi is blocked on this, so it has to out-weigh the hairline every
        // ordinary tool run gets, not sit under it.
        pending && "border-primary bg-primary/10",
        !pending && settledWell && "border-border bg-muted/40",
        !pending && !settledWell && "border-destructive/40 bg-destructive/5",
      )}
      aria-busy={pending || undefined}
    >
      <div className="flex items-center gap-2">
        <KindIcon className="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
        <span className="text-foreground font-medium">
          {decision.kind === "question"
            ? "Question"
            : config
              ? `${companionName} proposes these changes`
              : routine
                ? `${companionName} proposes this routine`
                : trigger
                  ? `${companionName} proposes this trigger`
                  : control
                    ? `${companionName} requests a change`
                  : `Allow ${DECISION_KIND_LABELS[decision.kind]}`}
        </span>
        {!config && !routine && !trigger && !control && (
          <span className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-xs">
            {decision.name}
          </span>
        )}
        {pending
          ? (
            <LoaderIcon
              className="text-muted-foreground ml-auto size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          )
          : settledWell
            ? <CheckIcon className="ml-auto size-3.5 shrink-0 text-(--color-ok)" aria-hidden="true" />
            : <AlertTriangleIcon className="text-destructive ml-auto size-3.5 shrink-0" aria-hidden="true" />}
        <span className="sr-only">{status}</span>
      </div>

      {config && decision.proposal?.kind === "config"
        ? (
          <ConfigChangeList
            proposal={decision.proposal}
            skills={skills}
            plugins={plugins}
            models={models}
          />
        )
        : routine && decision.proposal?.kind === "routine"
          ? <RoutineProposal proposal={decision.proposal} />
        : trigger && decision.proposal?.kind === "trigger"
          ? <TriggerProposal proposal={decision.proposal} />
        : control && decision.proposal?.kind === "control"
          ? (
            <div className="mt-1.5 space-y-1.5 text-sm">
              <p className="font-medium">{decision.proposal.summary}</p>
              <p className="text-muted-foreground font-mono text-xs">
                {decision.proposal.request_kind} · {decision.proposal.action}
              </p>
              {Object.keys(decision.proposal.payload).length > 0 && (
                <details>
                  <summary className="text-muted-foreground cursor-pointer select-none">Details</summary>
                  <pre className="text-foreground mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-xs">
                    {JSON.stringify(decision.proposal.payload, null, 2)}
                  </pre>
                </details>
              )}
            </div>
          )
        : (
          <pre className="text-foreground mt-1.5 max-h-40 overflow-auto font-mono text-xs leading-relaxed whitespace-pre-wrap">
            {decision.title}
          </pre>
        )}

      {decision.kind === "question" && decision.answer && (
        <p className="text-foreground mt-1.5 text-sm">{decision.answer}</p>
      )}
      {trigger && decision.status === "allowed" && canAct && (
        <p className="text-muted-foreground mt-1.5 text-xs">
          Approved — Companion handled the provider setup. Check Triggers for its registration status.
        </p>
      )}
      {control && decision.control_status === "applying" && (
        <p className="text-muted-foreground mt-1.5 text-xs">Approved — applying asynchronously</p>
      )}
      {control && decision.control_status === "failed" && (
        <p className="text-destructive mt-1.5 text-xs">Approved, but the change could not be applied</p>
      )}
      {controlPluginProvider && decision.control_status === "applied" && canApprove && (
        <a
          className="text-primary mt-1.5 inline-block text-xs underline-offset-2 hover:underline"
          href={`/companions?view=plugins&control_companion=${encodeURIComponent(companionId)}&connect=${encodeURIComponent(controlPluginProvider)}&control_request=${encodeURIComponent(requestId)}`}
        >
          Connect {controlPluginProvider} and attach it automatically
        </a>
      )}
      {!pending && decision.decided_by_name && (
        <p className="text-muted-foreground mt-1.5 text-xs">
          {status} by {decision.decided_by_name}
        </p>
      )}
      {decision.status === "expired" && !decision.decided_by_name && (
        <p className="text-muted-foreground mt-1.5 text-xs">Timed out, denied</p>
      )}
      {decision.status === "cancelled" && !decision.decided_by_name && (
        <p className="text-muted-foreground mt-1.5 text-xs">Closed without approval</p>
      )}
      {error && (
        <p className="text-destructive mt-1.5 text-xs" role="alert">{error}</p>
      )}

      {interactive && decision.kind === "question" && (
        <form
          className="mt-2 flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const value = answer.trim();
            if (!value) return;
            void act({ action: "answer", answer: value });
          }}
        >
          <input
            className="border-input focus-visible:ring-ring/50 min-w-40 flex-1 rounded-md border px-2.5 py-1.5 text-sm outline-none focus-visible:ring-[3px]"
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            placeholder="Your answer"
            aria-label="Answer"
            disabled={busy}
          />
          <Button type="submit" size="sm" disabled={busy || !answer.trim()}>Answer</Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => void act({ action: "deny" })}
          >
            Deny
          </Button>
        </form>
      )}
      {interactive && decision.kind !== "question" && (
        <div className="mt-2 flex items-center gap-2">
          <Button type="button" size="sm" disabled={busy} onClick={() => void act({ action: "allow" })}>
            {config || routine || trigger ? "Approve" : "Allow"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => void act({ action: "deny" })}
          >
            Deny
          </Button>
        </div>
      )}
      {decision.status === "pending" && !canApprove && (
        <p className="text-muted-foreground mt-1.5 text-xs">
          Waiting for {decision.required_access === "owner" ? "the Owner" : "an Owner or Editor"}
        </p>
      )}
    </section>
  );
};
