/**
 * AgentForm — the controlled create/edit form for a fleet agent.
 *
 * It is fully controlled: the parent owns the `AgentInput` value and receives
 * `onChange` patches. On submit it runs client-side validation and only calls
 * `onSubmit(value)` when the input is valid; otherwise it surfaces per-field
 * errors and moves focus to the first invalid control. The server is the final
 * authority (it re-validates and rolls back), but catching obvious mistakes
 * here keeps the round-trip tight.
 *
 * Validation rules (mirroring the Companion id contract):
 *   - id    : must match ^[a-z0-9][a-z0-9-]*[a-z0-9]$ (single-char [a-z0-9] ok)
 *   - name  : required, non-empty
 *   - model : required, non-empty
 *   - cpus  : a positive integer
 *
 * In edit mode the id is immutable (it keys the TOML file + state), so the id
 * field is read-only.
 */

import { useId, useRef, useState } from "react";
import type { AgentInput } from "../../api/types";
import { Button } from "./Button";
import { TextField } from "./TextField";
import { SelectField } from "./SelectField";
import { Toggle } from "./Toggle";

/** The agent id contract shared with the Go workspace loader. */
export const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

const RUNTIME_OPTIONS = [{ value: "fly.default" }];
const NETWORK_OPTIONS = [{ value: "tailscale.default" }];
const PROVIDER_OPTIONS = [{ value: "openrouter.default" }];
const LIFECYCLE_OPTIONS = [
  { value: "present", label: "present (deploy)" },
  { value: "absent", label: "absent (destroy)" },
];

/** A blank AgentInput with the console defaults that mirror examples/minimal. */
export function emptyAgentInput(): AgentInput {
  return {
    id: "",
    name: "",
    model: "",
    memory: "",
    cpus: 1,
    region: "",
    tailscale_hostname: "",
    fly_app: "",
    runtime: "fly.default",
    network: "tailscale.default",
    model_provider: "openrouter.default",
    lifecycle: "present",
    soul: "",
    companion_soul_enabled: true,
    vault_name: "",
  };
}

export type AgentFormErrors = Partial<Record<keyof AgentInput, string>>;

/** Pure validator: returns a map of field -> message for any invalid fields. */
export function validateAgentInput(
  value: AgentInput,
  mode: "create" | "edit",
): AgentFormErrors {
  const errors: AgentFormErrors = {};

  if (mode === "create") {
    const id = value.id.trim();
    if (!id) {
      errors.id = "An id is required.";
    } else if (!AGENT_ID_PATTERN.test(id)) {
      errors.id =
        "Use lowercase letters, digits and hyphens; must start and end with a letter or digit.";
    }
  }

  if (!value.name.trim()) {
    errors.name = "A display name is required.";
  }
  if (!value.model.trim()) {
    errors.model = "A model is required.";
  }
  if (!Number.isInteger(value.cpus) || value.cpus <= 0) {
    errors.cpus = "CPUs must be a positive whole number.";
  }

  return errors;
}

export interface AgentFormProps {
  value: AgentInput;
  onChange: (next: AgentInput) => void;
  onSubmit: (value: AgentInput) => void;
  submitLabel: string;
  disabled?: boolean;
  mode: "create" | "edit";
}

export function AgentForm({
  value,
  onChange,
  onSubmit,
  submitLabel,
  disabled = false,
  mode,
}: AgentFormProps) {
  const [errors, setErrors] = useState<AgentFormErrors>({});
  const formRef = useRef<HTMLFormElement>(null);
  const headingId = useId();

  function patch<K extends keyof AgentInput>(key: K, val: AgentInput[K]) {
    onChange({ ...value, [key]: val });
    // Clear a field's error as soon as the user edits it.
    if (errors[key]) {
      setErrors((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const found = validateAgentInput(value, mode);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      // Move focus to the first invalid control for keyboard/SR users.
      const first = Object.keys(found)[0];
      const el = formRef.current?.querySelector<HTMLElement>(
        `[name="${first}"]`,
      );
      el?.focus();
      return;
    }
    onSubmit(value);
  }

  return (
    <form
      ref={formRef}
      onSubmit={handleSubmit}
      aria-labelledby={headingId}
      className="space-y-8"
      noValidate
    >
      <h2 id={headingId} className="sr-only">
        Agent configuration
      </h2>

      {/* Identity ------------------------------------------------------- */}
      <fieldset className="space-y-4" disabled={disabled}>
        <legend className="text-xs font-semibold tracking-wide text-muted uppercase">
          Identity
        </legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            name="id"
            label="Agent id"
            mono
            required={mode === "create"}
            readOnly={mode === "edit"}
            value={value.id}
            onChange={(e) => patch("id", e.target.value)}
            error={errors.id ?? null}
            hint={
              mode === "edit"
                ? "The id is immutable once created."
                : "Lowercase, digits, hyphens. e.g. research-agent"
            }
            placeholder="research-agent"
            autoComplete="off"
            spellCheck={false}
          />
          <TextField
            name="name"
            label="Display name"
            required
            value={value.name}
            onChange={(e) => patch("name", e.target.value)}
            error={errors.name ?? null}
            placeholder="Research Agent"
          />
        </div>
        <TextField
          name="model"
          label="Model"
          mono
          required
          value={value.model}
          onChange={(e) => patch("model", e.target.value)}
          error={errors.model ?? null}
          hint="OpenRouter model slug, e.g. anthropic/claude-3.5-sonnet"
          placeholder="anthropic/claude-3.5-sonnet"
          autoComplete="off"
          spellCheck={false}
        />
        <SelectField
          name="model_provider"
          label="Model provider"
          options={PROVIDER_OPTIONS}
          value={value.model_provider}
          onChange={(e) => patch("model_provider", e.target.value)}
        />
      </fieldset>

      {/* Runtime -------------------------------------------------------- */}
      <fieldset className="space-y-4" disabled={disabled}>
        <legend className="text-xs font-semibold tracking-wide text-muted uppercase">
          Runtime
        </legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            name="runtime"
            label="Runtime"
            options={RUNTIME_OPTIONS}
            value={value.runtime}
            onChange={(e) => patch("runtime", e.target.value)}
          />
          <SelectField
            name="network"
            label="Network"
            options={NETWORK_OPTIONS}
            value={value.network}
            onChange={(e) => patch("network", e.target.value)}
          />
          <TextField
            name="region"
            label="Region"
            mono
            value={value.region}
            onChange={(e) => patch("region", e.target.value)}
            hint="Fly region, e.g. cdg. Blank uses the workspace default."
            placeholder="cdg"
            autoComplete="off"
          />
          <TextField
            name="memory"
            label="Memory"
            mono
            value={value.memory}
            onChange={(e) => patch("memory", e.target.value)}
            hint="e.g. 512mb, 1gb. Blank uses the default."
            placeholder="512mb"
            autoComplete="off"
          />
          <TextField
            name="cpus"
            label="CPUs"
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            required
            value={String(value.cpus)}
            onChange={(e) => patch("cpus", e.target.valueAsNumber || 0)}
            error={errors.cpus ?? null}
          />
          <SelectField
            name="lifecycle"
            label="Lifecycle"
            options={LIFECYCLE_OPTIONS}
            value={value.lifecycle}
            onChange={(e) => patch("lifecycle", e.target.value)}
            hint="absent renders an explicit destroy in the next plan."
          />
        </div>
      </fieldset>

      {/* Networking ----------------------------------------------------- */}
      <fieldset className="space-y-4" disabled={disabled}>
        <legend className="text-xs font-semibold tracking-wide text-muted uppercase">
          Networking & vault
        </legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            name="fly_app"
            label="Fly app"
            mono
            value={value.fly_app}
            onChange={(e) => patch("fly_app", e.target.value)}
            hint="Blank derives from the id."
            placeholder="research-agent"
            autoComplete="off"
            spellCheck={false}
          />
          <TextField
            name="tailscale_hostname"
            label="Tailscale hostname"
            mono
            value={value.tailscale_hostname}
            onChange={(e) => patch("tailscale_hostname", e.target.value)}
            hint="Blank derives from the id."
            placeholder="research-agent"
            autoComplete="off"
            spellCheck={false}
          />
          <TextField
            name="vault_name"
            label="Default vault"
            mono
            value={value.vault_name}
            onChange={(e) => patch("vault_name", e.target.value)}
            hint="Granite vault label this agent writes to."
            placeholder="memory"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
      </fieldset>

      {/* Soul ----------------------------------------------------------- */}
      <fieldset className="space-y-4" disabled={disabled}>
        <legend className="text-xs font-semibold tracking-wide text-muted uppercase">
          Identity & soul
        </legend>
        <SoulField
          value={value.soul}
          onChange={(v) => patch("soul", v)}
        />
        <Toggle
          label="Append companion soul"
          checked={value.companion_soul_enabled}
          onChange={(v) => patch("companion_soul_enabled", v)}
          hint="Adds the fleet-wide companion SOUL.md (e.g. Granite memory rules) after this agent's identity."
        />
      </fieldset>

      <div className="flex items-center justify-end gap-3 border-t border-line pt-5">
        <Button type="submit" variant="primary" loading={disabled}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

/** A labelled multi-line SOUL.md editor. Split out for readability. */
function SoulField({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-xs font-medium text-muted">
        SOUL.md
      </label>
      <textarea
        id={id}
        name="soul"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={hintId}
        rows={6}
        spellCheck={false}
        placeholder="# Identity&#10;You are a focused research agent…"
        className="rounded-md border border-line bg-canvas p-3 font-mono text-xs leading-relaxed text-fg placeholder:text-faint focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      />
      <p id={hintId} className="text-xs text-faint">
        Optional. Written to the agent&apos;s SOUL.md; leave blank to keep the
        existing identity.
      </p>
    </div>
  );
}
