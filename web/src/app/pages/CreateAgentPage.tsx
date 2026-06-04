/**
 * CreateAgentPage — the new-agent wizard (route "/agents/new").
 *
 * A linear, four-stage flow that takes an operator from an empty form to a
 * deployed agent without ever skipping the safety rails Companion cares about:
 *
 *   1. Template  — seed AgentInput defaults (mirroring examples/minimal) so the
 *                  common shapes ("Standard agent", "Memory-heavy") are one click.
 *   2. Configure — the shared AgentForm; its own client-side validation gates
 *                  advancing to review (we reuse its onSubmit as "next").
 *   3. Review    — a read-only summary of the assembled AgentInput.
 *   4. Plan      — createAgent(input) then plan(); render the PlanDiff + hash.
 *                  The Apply button stays DISABLED until the operator ticks an
 *                  explicit "I reviewed the plan" confirmation; on apply we call
 *                  apply(hash) and stream OperationProgress to a terminal state,
 *                  then offer a link to the freshly created agent.
 *
 * Security/UX: no secret values are ever shown (providers live in Settings);
 * every failure path surfaces a ConsoleError inline via ErrorBanner; the apply
 * is irreversible-by-intent and therefore gated behind the explicit checkbox.
 */

import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { apply, createAgent, plan } from "../../api/client";
import type {
  AgentDetail,
  AgentInput,
  OperationStatus,
  PlanResponse,
} from "../../api/types";
import {
  AgentForm,
  Badge,
  Button,
  Card,
  CodeBlock,
  emptyAgentInput,
  ErrorBanner,
  OperationProgress,
  PageHeader,
  PlanDiff,
  Spinner,
  Toggle,
} from "../components";

/** The wizard stages, in order. */
type Step = "template" | "configure" | "review" | "plan";

const STEP_ORDER: Step[] = ["template", "configure", "review", "plan"];

const STEP_LABELS: Record<Step, string> = {
  template: "Template",
  configure: "Configure",
  review: "Review",
  plan: "Plan & apply",
};

/**
 * A starting template: a label, blurb, and the AgentInput overrides it applies
 * on top of `emptyAgentInput()`. Defaults mirror examples/minimal so a fresh
 * agent lands on sensible, valid shapes.
 */
interface Template {
  id: string;
  name: string;
  description: string;
  patch: Partial<AgentInput>;
}

const TEMPLATES: Template[] = [
  {
    id: "standard",
    name: "Standard agent",
    description:
      "A balanced general-purpose agent. 1 CPU, 512mb, cdg region — mirrors examples/minimal.",
    patch: {
      model: "google/gemini-3.5-flash",
      memory: "512mb",
      cpus: 1,
      region: "cdg",
      companion_soul_enabled: true,
    },
  },
  {
    id: "memory-heavy",
    name: "Memory-heavy",
    description:
      "For long-context or retrieval-heavy work. 2 CPUs, 2gb, with the companion soul appended.",
    patch: {
      model: "google/gemini-3.5-flash",
      memory: "2gb",
      cpus: 2,
      region: "cdg",
      companion_soul_enabled: true,
    },
  },
];

export default function CreateAgentPage() {
  const navigate = useNavigate();

  const [step, setStep] = useState<Step>("template");
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [input, setInput] = useState<AgentInput>(emptyAgentInput());

  // Plan stage state.
  const [planResult, setPlanResult] = useState<PlanResponse | null>(null);
  const [created, setCreated] = useState<AgentDetail | null>(null);
  const [planPending, setPlanPending] = useState(false);
  const [planError, setPlanError] = useState<unknown>(null);

  // Apply stage state.
  const [reviewed, setReviewed] = useState(false);
  const [applyPending, setApplyPending] = useState(false);
  const [applyError, setApplyError] = useState<unknown>(null);
  const [operationId, setOperationId] = useState<string | null>(null);
  const [finished, setFinished] = useState<OperationStatus | null>(null);

  /** Pick a template, seed the form, and advance to Configure. */
  function chooseTemplate(template: Template) {
    setTemplateId(template.id);
    setInput({ ...emptyAgentInput(), ...template.patch });
    setStep("configure");
  }

  /**
   * AgentForm.onSubmit only fires when the form's own client-side validation
   * passes, so this is the gate from Configure → Review.
   */
  function handleConfigured(value: AgentInput) {
    setInput(value);
    setStep("review");
  }

  /**
   * Create the agent, then immediately compute a plan. Both run on entering the
   * Plan stage. A ConsoleError from either call (e.g. a 400 validation
   * rejection) is captured and shown inline.
   */
  async function createThenPlan() {
    setPlanPending(true);
    setPlanError(null);
    setPlanResult(null);
    try {
      const detail = await createAgent(input);
      setCreated(detail);
      const planned = await plan();
      setPlanResult(planned);
    } catch (err) {
      setPlanError(err);
    } finally {
      setPlanPending(false);
    }
  }

  /** Advance to the Plan stage and kick off create + plan. */
  function goToPlan() {
    setStep("plan");
    void createThenPlan();
  }

  /**
   * Apply the reviewed plan. Guarded by `reviewed` (the explicit confirmation)
   * and a present plan hash. On success we hold the operation id so
   * OperationProgress can stream the apply to completion.
   */
  async function handleApply() {
    if (!planResult || !reviewed) return;
    setApplyPending(true);
    setApplyError(null);
    try {
      const res = await apply(planResult.hash);
      setOperationId(res.operation_id);
    } catch (err) {
      setApplyError(err);
    } finally {
      setApplyPending(false);
    }
  }

  const agentId = created?.id ?? input.id;

  return (
    <>
      <PageHeader
        title="Create agent"
        description="Define a task-optimized agent, review the exact plan, then apply it to the fleet."
        eyebrow={
          <Link
            to="/"
            className="text-xs font-medium text-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            ← Back to agents
          </Link>
        }
      />

      <Stepper current={step} />

      <div className="mt-6 space-y-6">
        {step === "template" && (
          <TemplateStep selected={templateId} onChoose={chooseTemplate} />
        )}

        {step === "configure" && (
          <Card
            title="Configure the agent"
            description="Fields are validated before you can continue."
          >
            <AgentForm
              value={input}
              onChange={setInput}
              onSubmit={handleConfigured}
              submitLabel="Review configuration"
              mode="create"
            />
            <div className="mt-4 flex justify-start">
              <Button variant="ghost" onClick={() => setStep("template")}>
                ← Back to templates
              </Button>
            </div>
          </Card>
        )}

        {step === "review" && (
          <ReviewStep
            input={input}
            onBack={() => setStep("configure")}
            onConfirm={goToPlan}
          />
        )}

        {step === "plan" && (
          <PlanStep
            agentId={agentId}
            pending={planPending}
            error={planError}
            plan={planResult}
            created={created}
            reviewed={reviewed}
            onReviewedChange={setReviewed}
            applyPending={applyPending}
            applyError={applyError}
            operationId={operationId}
            finished={finished}
            onRetryPlan={createThenPlan}
            onApply={handleApply}
            onDone={setFinished}
            onViewAgent={() => navigate(`/agents/${encodeURIComponent(agentId)}`)}
          />
        )}
      </div>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Step indicator                                                              */
/* -------------------------------------------------------------------------- */

function Stepper({ current }: { current: Step }) {
  const currentIndex = STEP_ORDER.indexOf(current);
  return (
    <ol
      aria-label="Progress"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs"
    >
      {STEP_ORDER.map((s, i) => {
        const state =
          i < currentIndex ? "done" : i === currentIndex ? "current" : "upcoming";
        return (
          <li key={s} className="flex items-center gap-2">
            <span
              aria-current={state === "current" ? "step" : undefined}
              className={
                "inline-flex items-center gap-1.5 rounded-md px-2 py-1 font-medium " +
                (state === "current"
                  ? "bg-accent-muted/15 text-accent"
                  : state === "done"
                    ? "text-fg"
                    : "text-faint")
              }
            >
              <span
                aria-hidden="true"
                className={
                  "grid size-4 place-items-center rounded-full text-[10px] " +
                  (state === "upcoming"
                    ? "border border-line text-faint"
                    : "bg-accent text-accent-fg")
                }
              >
                {state === "done" ? "✓" : i + 1}
              </span>
              {STEP_LABELS[s]}
            </span>
            {i < STEP_ORDER.length - 1 && (
              <span aria-hidden="true" className="text-faint">
                →
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/* -------------------------------------------------------------------------- */
/* Step 1 — template                                                           */
/* -------------------------------------------------------------------------- */

function TemplateStep({
  selected,
  onChoose,
}: {
  selected: string | null;
  onChoose: (template: Template) => void;
}) {
  return (
    <Card
      title="Choose a starting template"
      description="Templates seed sensible defaults. You can change every field in the next step."
    >
      <ul className="grid gap-3 sm:grid-cols-2">
        {TEMPLATES.map((template) => {
          const isSelected = selected === template.id;
          return (
            <li key={template.id}>
              <button
                type="button"
                onClick={() => onChoose(template)}
                aria-pressed={isSelected}
                className={
                  "flex h-full w-full flex-col items-start gap-1 rounded-md border p-4 text-left transition-colors " +
                  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent " +
                  (isSelected
                    ? "border-accent bg-accent-muted/10"
                    : "border-line bg-surface hover:border-line-strong hover:bg-surface-raised")
                }
              >
                <span className="text-sm font-semibold text-fg">
                  {template.name}
                </span>
                <span className="text-xs text-muted">{template.description}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Step 3 — review                                                             */
/* -------------------------------------------------------------------------- */

/** One row in the review summary. Blank values render as a muted placeholder. */
function SummaryRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  const empty = value.trim() === "";
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <dt className="text-xs text-muted">{label}</dt>
      <dd
        className={
          "text-right text-xs " +
          (empty ? "text-faint italic" : "text-fg ") +
          (mono && !empty ? "font-mono" : "")
        }
      >
        {empty ? "default" : value}
      </dd>
    </div>
  );
}

function ReviewStep({
  input,
  onBack,
  onConfirm,
}: {
  input: AgentInput;
  onBack: () => void;
  onConfirm: () => void;
}) {
  return (
    <Card
      title="Review configuration"
      description="This is exactly what will be written to the workspace. Nothing is applied yet."
    >
      <dl className="divide-y divide-line">
        <SummaryRow label="Agent id" value={input.id} mono />
        <SummaryRow label="Display name" value={input.name} />
        <SummaryRow label="Model" value={input.model} mono />
        <SummaryRow label="Model provider" value={input.model_provider} mono />
        <SummaryRow label="Memory" value={input.memory} mono />
        <SummaryRow label="CPUs" value={String(input.cpus)} mono />
        <SummaryRow label="Region" value={input.region} mono />
        <SummaryRow label="Runtime" value={input.runtime} mono />
        <SummaryRow label="Network" value={input.network} mono />
        <SummaryRow label="Fly app" value={input.fly_app} mono />
        <SummaryRow
          label="Tailscale hostname"
          value={input.tailscale_hostname}
          mono
        />
        <SummaryRow label="Default vault" value={input.vault_name} mono />
        <SummaryRow label="Lifecycle" value={input.lifecycle} mono />
        <div className="flex items-baseline justify-between gap-4 py-1.5">
          <dt className="text-xs text-muted">Companion soul</dt>
          <dd className="text-right text-xs">
            <Badge tone={input.companion_soul_enabled ? "accent" : "neutral"}>
              {input.companion_soul_enabled ? "appended" : "disabled"}
            </Badge>
          </dd>
        </div>
      </dl>

      {input.soul.trim() !== "" && (
        <div className="mt-4">
          <p className="mb-1.5 text-xs font-medium text-muted">SOUL.md</p>
          <CodeBlock ariaLabel="SOUL.md preview">{input.soul}</CodeBlock>
        </div>
      )}

      <div className="mt-6 flex items-center justify-between gap-3 border-t border-line pt-5">
        <Button variant="ghost" onClick={onBack}>
          ← Edit configuration
        </Button>
        <Button variant="primary" onClick={onConfirm}>
          Create &amp; plan
        </Button>
      </div>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Step 4 — plan & apply                                                       */
/* -------------------------------------------------------------------------- */

interface PlanStepProps {
  agentId: string;
  pending: boolean;
  error: unknown;
  plan: PlanResponse | null;
  created: AgentDetail | null;
  reviewed: boolean;
  onReviewedChange: (checked: boolean) => void;
  applyPending: boolean;
  applyError: unknown;
  operationId: string | null;
  finished: OperationStatus | null;
  onRetryPlan: () => void;
  onApply: () => void;
  onDone: (status: OperationStatus) => void;
  onViewAgent: () => void;
}

function PlanStep({
  agentId,
  pending,
  error,
  plan,
  created,
  reviewed,
  onReviewedChange,
  applyPending,
  applyError,
  operationId,
  finished,
  onRetryPlan,
  onApply,
  onDone,
  onViewAgent,
}: PlanStepProps) {
  // Once the apply has started, the plan is locked in: hide the gate and show
  // live progress instead.
  const applyStarted = operationId !== null;
  const succeeded = finished?.state === "succeeded";

  return (
    <div className="space-y-6">
      <Card
        title="Plan"
        description="The agent file was written; this is the change Companion will apply."
        actions={
          plan ? (
            <Badge tone="accent" className="font-mono" data-testid="plan-hash">
              {plan.hash.slice(0, 12)}
            </Badge>
          ) : undefined
        }
      >
        {pending && (
          <div className="flex items-center gap-3 py-6 text-sm text-muted">
            <Spinner label="Creating agent and computing plan" />
            <span>Creating {agentId} and computing the plan…</span>
          </div>
        )}

        {!pending && error != null && (
          <ErrorBanner
            error={error}
            title="Could not create the agent or compute a plan"
            onRetry={onRetryPlan}
          />
        )}

        {!pending && error == null && plan && (
          <div className="space-y-3">
            {created && (
              <p className="text-xs text-muted">
                Created{" "}
                <span className="font-mono text-fg">{created.id}</span>. Review
                the plan below before applying.
              </p>
            )}
            <PlanDiff changes={plan.changes} />
            {plan.changes.length > 0 && (
              <details className="rounded-md border border-line bg-surface">
                <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-muted select-none">
                  Raw plan text
                </summary>
                <div className="px-3 pb-3">
                  <CodeBlock ariaLabel="Raw plan text">{plan.text}</CodeBlock>
                </div>
              </details>
            )}
          </div>
        )}
      </Card>

      {/* Apply gate + progress. Only meaningful once a plan exists. */}
      {!pending && error == null && plan && (
        <Card title="Apply">
          {!applyStarted ? (
            <div className="space-y-4">
              <Toggle
                label="I reviewed the plan above"
                checked={reviewed}
                onChange={onReviewedChange}
                hint="Apply mutates the fleet. Confirm you have read the planned changes before continuing."
              />

              {applyError != null && (
                <ErrorBanner error={applyError} title="Apply could not start" />
              )}

              <div className="flex items-center justify-end gap-3 border-t border-line pt-4">
                <Button
                  variant="primary"
                  onClick={onApply}
                  disabled={!reviewed}
                  loading={applyPending}
                >
                  Apply plan
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <OperationProgress operationId={operationId} onDone={onDone} />
              {succeeded && (
                <div className="flex items-center justify-end gap-3 border-t border-line pt-4">
                  <Button variant="primary" onClick={onViewAgent}>
                    View {agentId} →
                  </Button>
                </div>
              )}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
