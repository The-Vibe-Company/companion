import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { LoaderCircle, Plus, Trash2, Zap } from "lucide-react";
import { workspaceApi, type CompanionTrigger, type JsonSchema, type PluginAccount, type TriggerType } from "@/api";
import { markKey, ProviderMark } from "./ProviderMark";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import "./CompanionTriggers.css";

type Field = { key: string; label: string; description?: string; required: boolean; kind: "string" | "number" | "integer" | "boolean" | "enum" | "json"; schema: JsonSchema };
type Values = Record<string, string | boolean>;
const statusText: Record<CompanionTrigger["status"], string> = { registering: "Setting up", active: "Active", disabled: "Paused", error: "Error" };
const failure = (cause: unknown, fallback: string) => cause instanceof Error ? cause.message : fallback;

function configFields(schema: JsonSchema): Field[] {
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties ?? {}).map(([key, property]) => {
    const type = Array.isArray(property.type) ? property.type.find(item => item !== "null") : property.type;
    const kind = property.enum?.length && property.enum.every(option => ["string", "number", "boolean"].includes(typeof option)) ? "enum"
      : type === "string" || type === "number" || type === "integer" || type === "boolean" ? type : "json";
    return { key, label: property.title ?? key.replace(/[_-]+/g, " ").replace(/^\w/, letter => letter.toUpperCase()), description: property.description, required: required.has(key), kind, schema: property };
  });
}

function initialValue(field: Field): string | boolean {
  const value = field.schema.default;
  if (field.kind === "boolean") return value === true;
  if (value === undefined || value === null) return "";
  return field.kind === "json" ? JSON.stringify(value, null, 2) : String(value);
}

function buildConfig(fields: Field[], values: Values) {
  const config: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = values[field.key];
    if (field.kind === "boolean") { config[field.key] = raw === true; continue; }
    const text = String(raw ?? "").trim();
    if (!text) { if (field.required) throw new Error(`${field.label} is required.`); continue; }
    if (field.kind === "number" || field.kind === "integer") {
      const number = Number(text);
      if (!Number.isFinite(number) || (field.kind === "integer" && !Number.isInteger(number))) throw new Error(`${field.label} must be ${field.kind === "integer" ? "a whole number" : "a number"}.`);
      config[field.key] = number;
    } else if (field.kind === "enum") config[field.key] = field.schema.enum?.find(option => String(option) === text);
    else if (field.kind === "json") { try { config[field.key] = JSON.parse(text); } catch { throw new Error(`${field.label} must be valid JSON.`); } }
    else config[field.key] = text;
  }
  return config;
}

function ConfigField({ field, value, onChange }: { field: Field; value: string | boolean; onChange: (value: string | boolean) => void }) {
  const help = useId();
  const described = field.description ? help : undefined;
  const text = String(value);
  const name = <span>{field.label}{field.required && <span className="trigger-required" aria-hidden="true">*</span>}</span>;
  return <div className="trigger-field">
    {field.kind === "boolean"
      ? <label><input type="checkbox" checked={value === true} aria-describedby={described} onChange={event => onChange(event.target.checked)}/>{field.label}</label>
      : <label>{name}{field.kind === "enum"
        ? <select value={text} required={field.required} aria-describedby={described} onChange={event => onChange(event.target.value)}>
          <option value="">{field.required ? "Choose…" : "None"}</option>{field.schema.enum?.map(option => <option key={String(option)} value={String(option)}>{String(option)}</option>)}
        </select>
        : field.kind === "json"
        ? <Textarea value={text} rows={3} required={field.required} spellCheck={false} placeholder={field.schema.type === "array" ? "[]" : "{}"} aria-describedby={described} onChange={event => onChange(event.target.value)}/>
        : <input type={field.kind === "string" ? "text" : "number"} step={field.kind === "integer" ? 1 : field.kind === "number" ? "any" : undefined} value={text} required={field.required} aria-describedby={described} onChange={event => onChange(event.target.value)}/>}
      </label>}
    {field.description && <small id={help}>{field.description}</small>}
  </div>;
}

function TriggerForm({ companionId, accounts, onCreated, onCancel }: { companionId: string; accounts: PluginAccount[]; onCreated: (trigger: CompanionTrigger) => void; onCancel: () => void }) {
  const [accountId, setAccountId] = useState(accounts.length === 1 ? accounts[0].id : "");
  const [types, setTypes] = useState<TriggerType[] | null>(null);
  const [typesError, setTypesError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [slug, setSlug] = useState("");
  const [values, setValues] = useState<Values>({});
  const [instructions, setInstructions] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setTypes(null); setSlug(""); setTypesError("");
    if (!accountId) return;
    let active = true;
    void workspaceApi.triggerTypes(accountId).then(result => { if (active) setTypes(result.items); }).catch(cause => { if (active) setTypesError(failure(cause, "Could not load events for this account.")); });
    return () => { active = false; };
  }, [accountId, attempt]);
  const type = types?.find(item => item.slug === slug);
  const fields = useMemo(() => type ? configFields(type.config) : [], [type]);
  function choose(next: string) {
    const chosen = types?.find(item => item.slug === next);
    setSlug(next); setError("");
    setValues(Object.fromEntries((chosen ? configFields(chosen.config) : []).map(field => [field.key, initialValue(field)])));
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!type || !instructions.trim() || saving) return;
    let config: Record<string, unknown>;
    try { config = buildConfig(fields, values); } catch (cause) { setError(failure(cause, "Check the event settings.")); return; }
    setSaving(true); setError("");
    try { const result = await workspaceApi.createTrigger(companionId, { accountId, triggerSlug: type.slug, triggerName: type.name, config, instructions: instructions.trim() }); onCreated(result.trigger); }
    catch (cause) { setError(failure(cause, "Could not create this trigger.")); }
    finally { setSaving(false); }
  }
  return <form className="participant-config trigger-form" aria-label="New trigger" onSubmit={submit}>
    <fieldset disabled={saving}>
      <label>App account<select required value={accountId} onChange={event => setAccountId(event.target.value)}>
        <option value="" disabled>Choose an account</option>{accounts.map(account => <option key={account.id} value={account.id}>{account.appName ? `${account.appName} · ${account.label}` : account.label}</option>)}
      </select></label>
      {accountId && (typesError
        ? <div className="application-access-error" role="alert"><span>{typesError}</span><Button type="button" size="sm" variant="outline" onClick={() => setAttempt(value => value + 1)}>Try again</Button></div>
        : !types ? <p className="detail-loading" role="status"><LoaderCircle className="spin"/>Loading events…</p>
        : !types.length ? <p className="muted-copy">This app has no events to follow.</p>
        : <label>Event<select required value={slug} onChange={event => choose(event.target.value)}>
          <option value="" disabled>Choose an event</option>{types.map(item => <option key={item.slug} value={item.slug}>{item.name}</option>)}
        </select></label>)}
      {type && <>
        {(type.description || type.instructions) && <div className="trigger-type-help">{type.description && <p>{type.description}</p>}{type.instructions && <p>{type.instructions}</p>}</div>}
        {fields.map(field => <ConfigField key={field.key} field={field} value={values[field.key] ?? initialValue(field)} onChange={value => setValues(current => ({ ...current, [field.key]: value }))}/>)}
        <label>Instructions<Textarea required value={instructions} maxLength={20_000} rows={4} placeholder="For example: Summarize the new email and draft a reply for me to review." onChange={event => setInstructions(event.target.value)}/></label>
      </>}
    </fieldset>
    {error && <p className="field-error" role="alert">{error}</p>}
    <div className="trigger-form-actions"><Button type="button" variant="ghost" disabled={saving} onClick={onCancel}>Cancel</Button><Button type="submit" disabled={!type || !instructions.trim() || saving}>{saving && <LoaderCircle className="spin"/>}{saving ? "Creating…" : "Create trigger"}</Button></div>
  </form>;
}

export function CompanionTriggers({ companionId, companionName, onApplications }: { companionId: string; companionName: string; onApplications?: () => void }) {
  const [triggers, setTriggers] = useState<CompanionTrigger[]>([]);
  const [accounts, setAccounts] = useState<PluginAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    let active = true;
    setLoading(true); setError("");
    void Promise.all([workspaceApi.companionTriggers(companionId), workspaceApi.plugins()])
      .then(([list, plugins]) => { if (!active) return; setTriggers(list.triggers); setAccounts(plugins.accounts.filter(account => account.provider === "composio")); })
      .catch(cause => { if (active) setError(failure(cause, "Could not load triggers.")); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [companionId, attempt]);
  const registering = triggers.some(trigger => trigger.status === "registering");
  useEffect(() => {
    if (!registering || busy) return;
    let active = true;
    const timer = window.setTimeout(() => void workspaceApi.companionTriggers(companionId).then(result => { if (active) setTriggers(result.triggers); }).catch(() => {}), 3000);
    return () => { active = false; window.clearTimeout(timer); };
  }, [companionId, registering, busy, triggers]);

  async function toggle(trigger: CompanionTrigger) {
    setBusy(trigger.id); setError("");
    try { const result = await workspaceApi.updateTrigger(companionId, trigger.id, { enabled: trigger.status === "disabled" }); setTriggers(current => current.map(item => item.id === trigger.id ? result.trigger : item)); }
    catch (cause) { setError(failure(cause, "Could not update this trigger.")); }
    finally { setBusy(""); }
  }
  async function remove(trigger: CompanionTrigger) {
    setBusy(trigger.id); setError("");
    try { await workspaceApi.deleteTrigger(companionId, trigger.id); setTriggers(current => current.filter(item => item.id !== trigger.id)); setConfirming(null); }
    catch (cause) { setError(failure(cause, "Could not delete this trigger.")); }
    finally { setBusy(""); }
  }

  if (loading) return <p className="detail-loading" role="status"><LoaderCircle className="spin"/>Loading triggers…</p>;
  return <div className="companion-triggers">
    {!triggers.length && !adding && !error && <div className="trigger-empty"><Zap aria-hidden="true"/><p>No triggers yet. A trigger starts a background task on {companionName} whenever the event happens in a connected app, like a new email or a new commit, and follows the instructions you give it.</p></div>}
    {!!triggers.length && <ul className="trigger-list" aria-label="Triggers">{triggers.map(trigger => {
      const app = trigger.appName ?? trigger.accountLabel;
      const enabled = trigger.status !== "disabled";
      const account = accounts.find(item => item.id === trigger.accountId);
      return <li key={trigger.id} className={`trigger-row${enabled ? "" : " trigger-row--paused"}`}>
        <ProviderMark provider={account ? markKey(account) : trigger.appName?.toLowerCase()} name={app} logo={trigger.appLogo}/>
        <div className="trigger-copy"><strong>{trigger.triggerName}</strong><small>{trigger.appName ? `${trigger.appName} · ${trigger.accountLabel}` : trigger.accountLabel}</small><p title={trigger.instructions}>{trigger.instructions}</p></div>
        <span className={`trigger-status trigger-status--${trigger.status}`}>{statusText[trigger.status]}</span>
        <label className="trigger-switch"><input type="checkbox" role="switch" checked={enabled} disabled={!!busy} aria-label={`Enable ${trigger.triggerName}`} onChange={() => void toggle(trigger)}/><span aria-hidden="true"/></label>
        <Button type="button" variant="ghost" size="icon-sm" disabled={!!busy} aria-label={`Delete ${trigger.triggerName}`} onClick={() => setConfirming(trigger.id)}>{busy === trigger.id && confirming === trigger.id ? <LoaderCircle className="spin"/> : <Trash2/>}</Button>
        {confirming === trigger.id && <div className="trigger-confirm" role="group" aria-label={`Delete ${trigger.triggerName}?`}>
          <p>{companionName} will stop reacting to this {app} event.</p>
          <Button type="button" variant="ghost" size="sm" disabled={!!busy} onClick={() => setConfirming(null)}>Keep trigger</Button>
          <Button type="button" variant="destructive" size="sm" disabled={!!busy} onClick={() => void remove(trigger)}>Delete trigger</Button>
        </div>}
      </li>;
    })}</ul>}
    {error && <div className="application-access-error" role="alert"><span>{error}</span><Button type="button" size="sm" variant="outline" onClick={() => setAttempt(value => value + 1)}>Reload</Button></div>}
    {adding
      ? accounts.length
        ? <TriggerForm companionId={companionId} accounts={accounts} onCancel={() => setAdding(false)} onCreated={trigger => { setTriggers(current => [...current, trigger]); setAdding(false); }}/>
        : <div className="trigger-empty"><p>Connect an app such as Gmail or GitHub before adding a trigger.</p><div>{onApplications && <Button type="button" variant="outline" size="sm" onClick={onApplications}>Manage connections</Button>}<Button type="button" variant="ghost" size="sm" onClick={() => setAdding(false)}>Cancel</Button></div></div>
      : <Button type="button" variant="outline" className="trigger-add" onClick={() => { setAdding(true); setConfirming(null); }}><Plus/>Add trigger</Button>}
  </div>;
}
