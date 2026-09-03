"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  CompanionTrigger,
  CompanionTriggerTarget,
  CreateCompanionTriggerInput,
  UpdateCompanionTriggerInput,
} from "@companion/contracts";
import { COMPANION_TRIGGER_NAME_MAX_CHARACTERS } from "@companion/contracts";
import {
  createCompanionTrigger,
  deleteCompanionTrigger,
  retryCompanionTriggerRegistration,
  rotateCompanionTriggerSecret,
  updateCompanionTrigger,
} from "@/lib/companions";
import { Dialog } from "../org/primitives";
import { Badge } from "../cds";
import { Icon } from "../Icon";
import { PluginMark } from "./PluginMark";
import { detectedBrowserTimeZone, formatMemberDateTime } from "@/lib/timezones";
import {
  type CompanionTriggerAccountOption,
  type CompanionTriggerMode,
  type CompanionTriggerProvider,
} from "./CompanionTriggerTypes";

export interface CompanionTriggersApi {
  createCompanionTrigger: typeof createCompanionTrigger;
  deleteCompanionTrigger: typeof deleteCompanionTrigger;
  rotateCompanionTriggerSecret: typeof rotateCompanionTriggerSecret;
  updateCompanionTrigger: typeof updateCompanionTrigger;
  retryCompanionTriggerRegistration?: typeof retryCompanionTriggerRegistration;
}

const defaultCompanionTriggersApi: CompanionTriggersApi = {
  createCompanionTrigger,
  deleteCompanionTrigger,
  rotateCompanionTriggerSecret,
  updateCompanionTrigger,
  retryCompanionTriggerRegistration,
};

/** UI names only: the provider picks the row's mark, never an authentication scheme. */
const PROVIDER_LABELS = {
  webhook: "Webhook",
  linear: "Linear",
  github: "GitHub",
  sentry: "Sentry",
  custom: "Custom",
} satisfies Record<CompanionTriggerProvider, string>;

const MODE_LABELS = {
  notify: "Notify me",
  relay: "Ask the Companion",
} satisfies Record<CompanionTriggerMode, string>;

const MODE_DESCRIPTIONS = {
  notify: "Show the event in the thread without starting a main Companion turn.",
  relay: "Show the event and ask the main Companion to do the requested work.",
} satisfies Record<CompanionTriggerMode, string>;

const TRIGGER_MODES = ["notify", "relay"] satisfies CompanionTriggerMode[];
const REMOTE_TRIGGER_PROVIDERS = ["github", "linear", "sentry"] satisfies CompanionTriggerProvider[];
type RemoteTriggerProvider = (typeof REMOTE_TRIGGER_PROVIDERS)[number];

type TriggerEditorValue = CompanionTrigger;
type TriggerChangeHandler = (triggers: CompanionTrigger[]) => void;

function providerLabel(provider: CompanionTriggerProvider): string {
  return PROVIDER_LABELS[provider];
}

function providerMark(provider: CompanionTriggerProvider) {
  return provider === "webhook"
    ? <Icon name="link-2" size={15} />
    : <PluginMark provider={provider} variant="glyph" />;
}

function isProvider(provider: string): provider is CompanionTriggerProvider {
  return provider === "webhook" || provider === "linear" || provider === "github"
    || provider === "sentry" || provider === "custom";
}

function isRemoteTriggerProvider(provider: string): provider is RemoteTriggerProvider {
  return provider === "github" || provider === "linear" || provider === "sentry";
}

function eligibleAccountsFor(
  provider: CompanionTriggerProvider,
  accounts: readonly CompanionTriggerAccountOption[],
): CompanionTriggerAccountOption[] {
  // Generic/custom webhooks are not backed by a connected member account. Provider-backed triggers
  // silently reuse the sole shared account and only expose a chooser when there is a real choice.
  if (provider === "webhook" || provider === "custom") return [];
  return accounts.filter((account) => account.status === "connected" && account.provider === provider);
}

function triggerProviderConnected(
  trigger: CompanionTrigger,
  accounts: readonly CompanionTriggerAccountOption[],
): boolean {
  if (!isRemoteTriggerProvider(trigger.provider)) return true;
  return accounts.some((account) => account.status === "connected"
    && (trigger.provider_account_id
      ? account.id === trigger.provider_account_id
      : account.provider.toLocaleLowerCase("en-US") === trigger.provider));
}

function selectableProvidersFor(
  initial: TriggerEditorValue | null,
  accounts: readonly CompanionTriggerAccountOption[],
): CompanionTriggerProvider[] {
  const providers: CompanionTriggerProvider[] = REMOTE_TRIGGER_PROVIDERS.filter((provider) => (
    accounts.some((account) => account.status === "connected" && account.provider === provider)
  ));
  // Existing legacy/manual triggers remain inspectable and editable, but those providers are not
  // offered for new triggers because they cannot complete remote registration end to end.
  if (initial && !providers.includes(initial.provider)) providers.push(initial.provider);
  return providers;
}

function triggerTarget(
  provider: CompanionTriggerProvider,
  repo: string,
  organization: string,
  project: string,
  events: string,
): CompanionTriggerTarget | null {
  const parsedEvents = events.split(",").map((event) => event.trim()).filter(Boolean);
  if (provider === "github") return { repo: repo.trim() || undefined, events: parsedEvents };
  if (provider === "sentry") {
    return {
      organization: organization.trim() || undefined,
      project: project.trim() || undefined,
      events: parsedEvents,
    };
  }
  return null;
}

function registrationLabel(trigger: CompanionTrigger): string {
  if (trigger.registration_status === "registered") return "Registered";
  if (trigger.registration_status === "failed") return "Registration failed";
  if (trigger.registration_status === "unregistered") return "Unregistered";
  return "Manual fallback";
}

function registrationTone(trigger: CompanionTrigger): "neutral" | "ok" | "danger" {
  if (trigger.registration_status === "registered") return "ok";
  if (trigger.registration_status === "failed") return "danger";
  return "neutral";
}

function TriggerEditor({
  orgId,
  companionId,
  api,
  initial,
  accountOptions,
  onSaved,
  onClose,
}: {
  orgId: string;
  companionId: string;
  api: CompanionTriggersApi;
  initial: TriggerEditorValue | null;
  accountOptions: readonly CompanionTriggerAccountOption[];
  onSaved: (trigger: CompanionTrigger) => void;
  onClose: () => void;
}) {
  const selectableProviders = useMemo(
    () => selectableProvidersFor(initial, accountOptions),
    [accountOptions, initial],
  );
  const defaultProvider = selectableProviders[0] ?? "github";
  const [name, setName] = useState(initial?.name ?? "");
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [provider, setProvider] = useState<CompanionTriggerProvider>(
    initial?.provider ?? defaultProvider,
  );
  const [mode, setMode] = useState<CompanionTriggerMode>(initial?.mode ?? "relay");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [repo, setRepo] = useState(initial?.target?.repo ?? "");
  const [organization, setOrganization] = useState(initial?.target?.organization ?? "");
  const [project, setProject] = useState(initial?.target?.project ?? "");
  const [events, setEvents] = useState(initial?.target?.events?.join(", ") ?? "push");
  const [providerAccountId, setProviderAccountId] = useState(initial?.provider_account_id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const eligibleAccounts = useMemo(
    () => eligibleAccountsFor(provider, accountOptions),
    [accountOptions, provider],
  );

  // A single member account is an implementation detail, not an extra setup step. Preserve an
  // explicit choice when editing, otherwise select the only eligible account automatically.
  useEffect(() => {
    if (provider === initial?.provider && initial?.provider_account_id && eligibleAccounts.some(
      (account) => account.id === initial.provider_account_id,
    )) {
      setProviderAccountId(initial.provider_account_id);
      return;
    }
    if (eligibleAccounts.length === 1) {
      setProviderAccountId(eligibleAccounts[0]!.id);
      return;
    }
    setProviderAccountId(eligibleAccounts.some((account) => account.id === providerAccountId)
      ? providerAccountId
      : "");
    // `providerAccountId` is intentionally omitted: this effect should react to provider/account
    // catalog changes, not reset a user's in-progress account choice on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eligibleAccounts, initial?.provider, initial?.provider_account_id, provider]);

  const accountChoiceRequired = eligibleAccounts.length > 1 && !providerAccountId;
  const providerAccountMissing = isRemoteTriggerProvider(provider) && eligibleAccounts.length === 0;
  const githubTargetIncomplete = provider === "github" && (!repo.trim() || !events.trim());
  const sentryTargetIncomplete = provider === "sentry"
    && (!organization.trim() || !project.trim() || !events.trim());
  const canSave = !busy
    && Boolean(name.trim())
    && Boolean(prompt.trim())
    && selectableProviders.length > 0
    && !accountChoiceRequired
    && !providerAccountMissing
    && !githubTargetIncomplete
    && !sentryTargetIncomplete;

  async function save() {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    const target = triggerTarget(provider, repo, organization, project, events);
    const request: Omit<CreateCompanionTriggerInput, "id"> = {
      name: name.trim(),
      prompt: prompt.trim(),
      provider,
      target,
      mode,
      enabled,
    };
    if (providerAccountId) request.provider_account_id = providerAccountId;
    try {
      const trigger = initial
        ? await api.updateCompanionTrigger(
          orgId,
          companionId,
          initial.id,
          request satisfies UpdateCompanionTriggerInput,
        )
        : await api.createCompanionTrigger(
          orgId,
          companionId,
          {
            id: crypto.randomUUID(),
            ...request,
          } satisfies CreateCompanionTriggerInput,
        );
      onSaved(trigger);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "This trigger could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      icon="zap"
      title={initial ? "Edit trigger" : "New trigger"}
      desc="A provider event will be registered for this Companion. Connected provider accounts are reused automatically."
      onClose={onClose}
      closeDisabled={busy}
      className="og-dialog companions-trigger-dialog"
      foot={(
        <>
          <button type="button" className="cds-btn cds-btn--secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="cds-btn cds-btn--primary"
            onClick={() => void save()}
            disabled={!canSave}
            aria-busy={busy}
          >
            {busy ? "Saving…" : initial ? "Save trigger" : "Create trigger"}
          </button>
        </>
      )}
    >
      <label className="og-field">
        <span>Name</span>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={COMPANION_TRIGGER_NAME_MAX_CHARACTERS}
          autoFocus
        />
      </label>

      {selectableProviders.length > 0 ? (
        <label className="og-field">
          <span>Provider</span>
          <select
            value={provider}
            onChange={(event) => {
              if (isProvider(event.target.value)) setProvider(event.target.value);
            }}
          >
            {selectableProviders.map((option) => (
              <option key={option} value={option}>
                {PROVIDER_LABELS[option]}{option === "webhook" || option === "custom" ? " (legacy)" : ""}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <div className="companions-trigger-provider-required" role="status">
          <strong>Connect a provider first</strong>
          <span>Connect GitHub, Sentry, or Linear once. Every Companion can then use it immediately.</span>
        </div>
      )}

      {eligibleAccounts.length === 1 && (
        <p className="companions-trigger-field-hint" role="status">
          Using the shared {providerLabel(provider)} account “{eligibleAccounts[0]!.label}”. No Companion attachment is required.
        </p>
      )}
      {eligibleAccounts.length > 1 && (
        <label className="og-field">
          <span>{providerLabel(provider)} account</span>
          <select
            value={providerAccountId}
            onChange={(event) => setProviderAccountId(event.target.value)}
            aria-describedby="companion-trigger-account-hint"
          >
            <option value="">Choose a shared account</option>
            {eligibleAccounts.map((account) => (
              <option key={account.id} value={account.id}>{account.label}</option>
            ))}
          </select>
          <span id="companion-trigger-account-hint" className="companions-trigger-field-hint">
            Choose which member account should register this webhook. This does not attach it to the Companion&apos;s MCP tools.
          </span>
        </label>
      )}
      {selectableProviders.length > 0
        && eligibleAccounts.length === 0
        && isRemoteTriggerProvider(provider) && (
        <p className="companions-trigger-field-hint" role="status">
          Connect {providerLabel(provider)} once in Trigger providers. It will become available to every Companion.
        </p>
      )}

      {provider === "github" && (
        <div className="companions-trigger-target">
          <p className="companions-trigger-field-label">GitHub event</p>
          <label className="og-field">
            <span>Repository</span>
            <input
              value={repo}
              onChange={(event) => setRepo(event.target.value)}
              placeholder="owner/repository"
              autoComplete="off"
            />
          </label>
          <label className="og-field">
            <span>Events</span>
            <input
              value={events}
              onChange={(event) => setEvents(event.target.value)}
              placeholder="push, pull_request"
              autoComplete="off"
              aria-describedby="companion-trigger-events-hint"
            />
            <span id="companion-trigger-events-hint" className="companions-trigger-field-hint">
              Separate event names with commas. Use * for every event.
            </span>
          </label>
        </div>
      )}

      {provider === "sentry" && (
        <div className="companions-trigger-target">
          <p className="companions-trigger-field-label">Sentry event</p>
          <div className="companions-plugin-form__pair">
            <label className="og-field">
              <span>Organization slug</span>
              <input value={organization} onChange={(event) => setOrganization(event.target.value)} autoComplete="off" />
            </label>
            <label className="og-field">
              <span>Project slug</span>
              <input value={project} onChange={(event) => setProject(event.target.value)} autoComplete="off" />
            </label>
          </div>
          <label className="og-field">
            <span>Events</span>
            <input value={events} onChange={(event) => setEvents(event.target.value)} placeholder="error" autoComplete="off" />
            <span className="companions-trigger-field-hint">Separate event names with commas.</span>
          </label>
        </div>
      )}

      <fieldset className="companions-trigger-mode">
        <legend>When an event arrives</legend>
        {TRIGGER_MODES.map((option) => (
          <label key={option} className={mode === option ? "companions-trigger-mode__option companions-trigger-mode__option--selected" : "companions-trigger-mode__option"}>
            <input
              type="radio"
              name="companion-trigger-mode"
              value={option}
              checked={mode === option}
              onChange={() => setMode(option)}
            />
            <span>
              <strong>{MODE_LABELS[option]}</strong>
              <small>{MODE_DESCRIPTIONS[option]}</small>
            </span>
          </label>
        ))}
      </fieldset>

      <label className="og-field">
        <span>Processing prompt</span>
        <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={5} />
      </label>

      <label className="companions-trigger-enabled">
        <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
        <span>
          <strong>Enable trigger</strong>
          <small>Provider events can fire this trigger immediately after it is saved.</small>
        </span>
      </label>

      {error && <p className="text-destructive" role="alert">{error}</p>}
    </Dialog>
  );
}

export function CompanionTriggers({
  orgId,
  companionId,
  triggers,
  memberTimezone,
  canEdit,
  accountOptions = [],
  onChange,
  onOpenHistory,
  onManageProviders,
  api = defaultCompanionTriggersApi,
}: {
  orgId: string;
  companionId: string;
  triggers: readonly CompanionTrigger[];
  memberTimezone?: string | null;
  canEdit: boolean;
  /** All credential-free member account projections; never filter by Companion MCP attachments. */
  accountOptions?: readonly CompanionTriggerAccountOption[];
  onChange: TriggerChangeHandler;
  onOpenHistory?: (trigger: CompanionTrigger) => void;
  onManageProviders?: () => void;
  api?: CompanionTriggersApi;
}) {
  const displayTimezone = memberTimezone ?? detectedBrowserTimeZone();
  const [editing, setEditing] = useState<CompanionTrigger | null | "new">(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmingRotateId, setConfirmingRotateId] = useState<string | null>(null);
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const emitChange = (next: CompanionTrigger[]) => onChange(next);
  const connectedProviderAccounts = useMemo(
    () => accountOptions.filter((account) => account.status === "connected"),
    [accountOptions],
  );

  useEffect(() => () => {
    if (copyResetRef.current) clearTimeout(copyResetRef.current);
  }, []);

  async function toggle(trigger: CompanionTrigger) {
    if (!canEdit || busyId) return;
    setBusyId(trigger.id);
    setActionError(null);
    setConfirmingRotateId(null);
    try {
      const updated = await api.updateCompanionTrigger(orgId, companionId, trigger.id, {
        enabled: !trigger.enabled,
      });
      emitChange(triggers.map((item) => item.id === updated.id ? updated : item));
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "This trigger could not be updated.");
    } finally {
      setBusyId(null);
    }
  }

  async function remove(trigger: CompanionTrigger) {
    if (!canEdit || busyId) return;
    setBusyId(trigger.id);
    setActionError(null);
    setConfirmingRotateId(null);
    try {
      await api.deleteCompanionTrigger(orgId, companionId, trigger.id);
      emitChange(triggers.filter((item) => item.id !== trigger.id));
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "This trigger could not be deleted.");
    } finally {
      setBusyId(null);
    }
  }

  // Rotation silently breaks the external service still posting to the old URL, so it takes a
  // second explicit click rather than firing on the first.
  async function rotate(trigger: CompanionTrigger) {
    if (!canEdit || busyId) return;
    if (confirmingRotateId !== trigger.id) {
      setConfirmingRotateId(trigger.id);
      return;
    }
    setBusyId(trigger.id);
    setActionError(null);
    setConfirmingRotateId(null);
    try {
      const updated = await api.rotateCompanionTriggerSecret(orgId, companionId, trigger.id);
      emitChange(triggers.map((item) => item.id === updated.id ? updated : item));
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "The secret could not be rotated.");
    } finally {
      setBusyId(null);
    }
  }

  async function retryRegistration(trigger: CompanionTrigger) {
    if (!canEdit || busyId) return;
    if (!api.retryCompanionTriggerRegistration) {
      setActionError("Registration retry is not available yet.");
      return;
    }
    setBusyId(trigger.id);
    setActionError(null);
    try {
      const updated = await api.retryCompanionTriggerRegistration(orgId, companionId, trigger.id);
      emitChange(triggers.map((item) => item.id === updated.id ? updated : item));
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "This provider registration could not be retried.");
    } finally {
      setBusyId(null);
    }
  }

  async function copy(trigger: CompanionTrigger) {
    if (!trigger.webhook_url) return;
    try {
      await navigator.clipboard.writeText(trigger.webhook_url);
    } catch {
      setActionError("The webhook URL could not be copied.");
      return;
    }
    setCopiedId(trigger.id);
    if (copyResetRef.current) clearTimeout(copyResetRef.current);
    copyResetRef.current = setTimeout(() => setCopiedId(null), 2_000);
  }

  return (
    <section className="chat-context__block">
      <div className="chat-context__titlerow">
        <div>
          <h3 className="chat-context__title">Triggers</h3>
          <p className="chat-context__section-hint">Provider events that notify or ask this Companion to work.</p>
        </div>
        {canEdit && (
          <button
            type="button"
            className="iconbtn chat-context__add"
            aria-label="Add a trigger"
            onClick={() => setEditing("new")}
          >
            <Icon name="plus" size={14} />
          </button>
        )}
      </div>
      <div className="chat-context__trigger-providers" aria-label="Member trigger providers">
        <div className="chat-context__trigger-providers-head">
          <strong>Shared providers</strong>
          {onManageProviders && (
            <button type="button" className="chat-context__link" onClick={onManageProviders}>
              {connectedProviderAccounts.length === 0 ? "Connect" : "Manage"}
            </button>
          )}
        </div>
        {accountOptions.length === 0 ? (
          <p>No trigger provider connected. Connect once for every Companion.</p>
        ) : (
          <ul>
            {accountOptions.map((account) => (
              <li key={account.id}>
                {providerMark(account.provider)}
                <span>{providerLabel(account.provider)} · {account.label}</span>
                <Badge tone={account.status === "connected" ? "ok" : "danger"} dot>
                  {account.status === "connected" ? "Connected" : "Disconnected"}
                </Badge>
              </li>
            ))}
          </ul>
        )}
        <small>Member-wide and immediately available here. No Companion attachment is required; MCP tool attachments are managed separately.</small>
      </div>
      {triggers.length === 0 ? (
        <p className="chat-context__empty">
          No triggers connected. Add a provider event to notify or wake this Companion.
        </p>
      ) : (
        <ul className="chat-context__resources">
          {triggers.map((rawTrigger) => {
            const trigger = rawTrigger;
            const registrationError = trigger.last_registration_error
              ?? (trigger.registration_status === "failed" ? trigger.last_error_message : null);
            const mode = trigger.mode;
            const providerConnected = triggerProviderConnected(trigger, accountOptions);
            return (
              <li key={trigger.id} className="chat-context__resource chat-context__trigger-resource">
                <div className="chat-context__routine-main">
                  <span className="chat-context__resource-head">
                    <span className="chat-context__routine-name chat-context__trigger-name">
                      {providerMark(trigger.provider)}
                      <span className="chat-context__trigger-name-text">{trigger.name}</span>
                    </span>
                    <Badge
                      tone={!trigger.enabled ? "neutral" : !providerConnected || trigger.last_error_message ? "danger" : "ok"}
                      dot
                    >
                      {!trigger.enabled ? "Disabled" : !providerConnected ? "Provider disconnected" : trigger.last_error_message ? "Error" : "Enabled"}
                    </Badge>
                  </span>
                  <span className="chat-context__resource-meta">
                    <span>{providerLabel(trigger.provider)}</span>
                    <span>{MODE_LABELS[mode]}</span>
                    <Badge tone={providerConnected ? registrationTone(trigger) : "danger"}>
                      {providerConnected ? registrationLabel(trigger) : "Registration blocked"}
                    </Badge>
                  </span>
                  {trigger.provider === "github" && trigger.target?.repo && (
                    <span className="chat-context__caption mono">
                      {trigger.target.repo} · {trigger.target.events?.join(", ")}
                    </span>
                  )}
                  {trigger.provider === "sentry" && trigger.target?.organization && trigger.target.project && (
                    <span className="chat-context__caption mono">
                      {trigger.target.organization}/{trigger.target.project} · {trigger.target.events?.join(", ")}
                    </span>
                  )}
                  {trigger.last_fired_at && (
                    <span className="chat-context__caption">
                      Last fired {formatMemberDateTime(trigger.last_fired_at, displayTimezone)} · {displayTimezone}
                    </span>
                  )}
                  {registrationError && (
                    <span className="chat-context__routine-error" role="status">
                      {registrationError}
                    </span>
                  )}
                  {!providerConnected && (
                    <span className="chat-context__routine-error" role="status">
                      Reconnect this member provider to resume registration and incoming events for every dependent Companion.
                    </span>
                  )}
                  {trigger.last_error_message && trigger.last_error_message !== registrationError && (
                    <span className="chat-context__routine-error" role="status">
                      {trigger.last_error_message}
                    </span>
                  )}
                </div>

                <div className="chat-context__routine-actions">
                  {onOpenHistory && (
                    <button
                      type="button"
                      className="chat-context__link"
                      onClick={() => onOpenHistory(trigger)}
                    >
                      History
                    </button>
                  )}
                  {canEdit && (
                    <>
                      {(trigger.registration_status === "failed" || trigger.registration_status === "unregistered")
                        && providerConnected && (
                        <button
                          type="button"
                          className="chat-context__link"
                          disabled={busyId === trigger.id}
                          onClick={() => void retryRegistration(trigger)}
                        >
                          {busyId === trigger.id ? "Retrying…" : "Retry registration"}
                        </button>
                      )}
                      <button
                        type="button"
                        className="chat-context__link"
                        disabled={busyId === trigger.id}
                        onClick={() => void toggle(trigger)}
                      >
                        {trigger.enabled ? "Turn off" : "Turn on"}
                      </button>
                      <button
                        type="button"
                        className="chat-context__link"
                        onClick={() => setEditing(trigger)}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="chat-context__link"
                        disabled={busyId === trigger.id}
                        onClick={() => void remove(trigger)}
                      >
                        Delete
                      </button>
                    </>
                  )}
                </div>

                {canEdit && trigger.webhook_url && (
                  <details className="chat-context__trigger-technical">
                    <summary>Technical details</summary>
                    <div className="chat-context__trigger-technical-body">
                      <span className="chat-context__caption">Fallback webhook URL (keep private)</span>
                      <code>{trigger.webhook_url}</code>
                      <div className="chat-context__routine-actions">
                        <button type="button" className="chat-context__link" onClick={() => void copy(trigger)}>
                          {copiedId === trigger.id ? "Copied" : "Copy URL"}
                        </button>
                        <button
                          type="button"
                          className="chat-context__link"
                          disabled={busyId === trigger.id}
                          onClick={() => void rotate(trigger)}
                        >
                          {confirmingRotateId === trigger.id ? "Confirm rotate" : "Rotate secret"}
                        </button>
                      </div>
                    </div>
                  </details>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {actionError && (
        <p className="chat-context__routine-error" role="alert">{actionError}</p>
      )}
      {editing !== null && (
        <TriggerEditor
          orgId={orgId}
          companionId={companionId}
          api={api}
          initial={editing === "new" ? null : editing}
          accountOptions={accountOptions}
          onSaved={(trigger) => {
            const exists = triggers.some((item) => item.id === trigger.id);
            emitChange(exists
              ? triggers.map((item) => item.id === trigger.id ? trigger : item)
              : [...triggers, trigger]);
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}
