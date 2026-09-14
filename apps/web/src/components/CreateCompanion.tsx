import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Check, LoaderCircle } from "lucide-react";
import { api, workspaceApi, type AppConfig, type Companion, type PluginAccount, type PluginServer } from "@/api";
import { AccountTiles } from "./ApplicationAccess";
import { AvatarPicker, CompanionAvatar, randomizeAvatar, type CompanionAvatarValue } from "./CompanionAvatar";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import "./CreateCompanion.css";

type Props = { config: AppConfig; onCreated: (companion: Companion) => void; compact?: boolean; ownerId?: string; onSetupLockedChange?: (locked: boolean) => void };
type Frozen = Parameters<typeof api.createCompanion>[0];
type Stored = { request: Frozen; accountIds: string[]; completedAccountIds: string[]; companionId?: string };
function key(ownerId: string) { return `companions.create.pending.${ownerId}`; }
function read(ownerId?: string): Stored | null { try { const value = ownerId ? JSON.parse(sessionStorage.getItem(key(ownerId)) ?? "null") as Stored | null : null; return value?.request?.clientCreationId ? value : null; } catch { return null; } }

export function CreateCompanion({ config, onCreated, compact = false, ownerId, onSetupLockedChange }: Props) {
  const restored = useRef(read(ownerId));
  const [name, setName] = useState(restored.current?.request.name ?? "");
  const [instructions, setInstructions] = useState(restored.current?.request.instructions ?? "");
  const [provider, setProvider] = useState<"local" | "box">(restored.current?.request.provider ?? config.defaultProvider ?? (config.boxAvailable ? "box" : "local"));
  const [avatar, setAvatar] = useState<CompanionAvatarValue>(restored.current?.request.avatar ?? randomizeAvatar());
  const [appearance, setAppearance] = useState(false);
  const [accounts, setAccounts] = useState<PluginAccount[]>([]);
  const [catalog, setCatalog] = useState<PluginServer[]>([]);
  const [selected, setSelected] = useState(new Set(restored.current?.accountIds ?? []));
  const [loadingSetup, setLoadingSetup] = useState(true);
  const [setupError, setSetupError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const frozen = useRef<Frozen | null>(restored.current?.request ?? null);
  const completed = useRef(new Set(restored.current?.completedAccountIds ?? []));
  const created = useRef<Companion | null>(null);

  const loadSetup = useCallback(async () => { setLoadingSetup(true); setSetupError(""); try { const result = await workspaceApi.plugins(); setAccounts(result.accounts); setCatalog(result.catalog); } catch (cause) { setSetupError(cause instanceof Error ? cause.message : "Could not load applications."); } finally { setLoadingSetup(false); } }, []);
  useEffect(() => { void loadSetup(); }, [loadSetup]);
  useEffect(() => { if (!restored.current?.companionId) return; void api.getCompanion(restored.current.companionId).then(result => { created.current = result.companion; }).catch(() => {}); }, []);
  useEffect(() => { onSetupLockedChange?.(submitting); return () => onSetupLockedChange?.(false); }, [submitting, onSetupLockedChange]);
  const canSubmit = name.trim() && instructions.trim() && !submitting && !loadingSetup && !setupError;
  const persist = (companionId?: string) => { if (!ownerId || !frozen.current) return; try { sessionStorage.setItem(key(ownerId), JSON.stringify({ request: frozen.current, accountIds: [...selected], completedAccountIds: [...completed.current], ...(companionId ? { companionId } : {}) } satisfies Stored)); } catch {} };

  async function submit(event: FormEvent) {
    event.preventDefault(); if (!canSubmit) return; setSubmitting(true); setError("");
    frozen.current ??= { clientCreationId: crypto.randomUUID(), name: name.trim(), instructions: instructions.trim(), provider, avatar, prepare: true };
    persist(restored.current?.companionId);
    try {
      if (!created.current) { const result = await api.createCompanion(frozen.current); created.current = result.companion; persist(result.companion.id); }
      const granted = await workspaceApi.companionPlugins(created.current.id);
      completed.current = new Set(granted.accounts.map(account => account.id)); persist(created.current.id);
      for (const accountId of [...completed.current]) { if (selected.has(accountId)) continue; await workspaceApi.unselectPlugin(created.current.id, accountId); completed.current.delete(accountId); persist(created.current.id); }
      for (const accountId of selected) { if (completed.current.has(accountId)) continue; await workspaceApi.selectPlugin(created.current.id, accountId); completed.current.add(accountId); persist(created.current.id); }
      if (ownerId) try { sessionStorage.removeItem(key(ownerId)); } catch {}
      onCreated(created.current);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create this companion. Retry to continue the same request."); }
    finally { setSubmitting(false); }
  }

  return <div className={`create-form${compact ? " create-form--compact" : ""}`}><header className="create-heading"><CompanionAvatar name={name || "New companion"} avatar={avatar} size={70}/><div><h1>{compact ? "Create a Companion" : "Create your first Companion"}</h1><p>Give your Companion a name and a role. You can adjust everything later.</p></div></header><form onSubmit={submit}><fieldset disabled={submitting}>
    <div className="field"><label htmlFor="companion-name">Name</label><input id="companion-name" value={name} onChange={event => setName(event.target.value)} maxLength={80} autoFocus/></div>
    <div className="field"><label htmlFor="companion-role">Role</label><Textarea id="companion-role" value={instructions} onChange={event => setInstructions(event.target.value)} maxLength={20_000} rows={3} placeholder="For example: Research our market and help me plan each launch."/></div>
    <button className="appearance-toggle" type="button" aria-expanded={appearance} onClick={() => setAppearance(value => !value)}>Appearance <span>{appearance ? "Hide" : "Change"}</span></button>
    {appearance && <AvatarPicker value={avatar} onChange={setAvatar}/>}
    {config.localAvailable && config.boxAvailable && <details className="settings-advanced"><summary>Advanced</summary><div className="field"><label htmlFor="companion-computer">Computer</label><select id="companion-computer" value={provider} onChange={event => setProvider(event.target.value as "local" | "box")}><option value="box">Own Box computer</option><option value="local">Local development computer</option></select></div></details>}
    <section className="create-setup-section"><h2>Applications</h2><p>Optional. Choose the accounts this Companion may use. You can change access later.</p>{loadingSetup ? <div className="application-access-loading" role="status" aria-label="Loading applications"><span/><span/><span/></div> : setupError ? <div className="application-access-state" role="alert"><p>{setupError}</p><Button type="button" variant="outline" onClick={() => void loadSetup()}>Try again</Button></div> : accounts.length ? <AccountTiles accounts={accounts} catalog={catalog} selectedIds={selected} disabled={submitting} onToggle={id => setSelected(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; })}/> : <p className="muted-copy">No accounts connected yet. You can continue without one.</p>}</section>
  </fieldset>{error && <p className="field-error" role="alert">{error}</p>}<Button className="create-submit" type="submit" disabled={!canSubmit}>{submitting ? <LoaderCircle className="spin"/> : <Check/>}{submitting ? "Creating…" : "Create companion"}</Button></form></div>;
}
