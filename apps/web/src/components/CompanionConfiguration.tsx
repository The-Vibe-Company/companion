import { useEffect, useState, type FormEvent } from "react";
import { Check, LoaderCircle } from "lucide-react";
import { api, type Companion } from "@/api";
import { AvatarPicker, DEFAULT_AVATAR } from "./CompanionAvatar";
import { ApplicationAccess } from "./ApplicationAccess";
import { DeliverySettings } from "./CompanionAccount";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";

export function CompanionConfiguration({ companion, onRefresh, onRetired, onApplications, showRetirement = true }: {
  companion: Companion;
  onRefresh: () => Promise<void>;
  onRetired?: () => void;
  onApplications?: () => void;
  showRetirement?: boolean;
}) {
  const [name, setName] = useState(companion.name);
  const [instructions, setInstructions] = useState(companion.instructions);
  const [modelId, setModelId] = useState(companion.modelId ?? "");
  const [avatar, setAvatar] = useState(companion.avatar ?? DEFAULT_AVATAR);
  const [models, setModels] = useState<Array<{ id: string; name: string }>>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const changed = name !== companion.name || instructions !== companion.instructions ||
    modelId !== (companion.modelId ?? "") || JSON.stringify(avatar) !== JSON.stringify(companion.avatar ?? DEFAULT_AVATAR);
  const onError = (cause: unknown) => setError(cause instanceof Error ? cause.message : "Could not save changes.");
  useEffect(() => {
    let active = true;
    void api.getConfig().then(config => { if (active) setModels(config.models ?? []); }).catch(cause => { if (active) onError(cause); });
    return () => { active = false; };
  }, []);

  async function configure(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || saving) return;
    setSaving(true); setError(""); setSaved(false);
    try {
      const result = await api.updateCompanion(companion.id, { name: name.trim(), instructions: instructions.trim(), avatar, modelId: modelId || null });
      setName(result.companion.name); setInstructions(result.companion.instructions);
      setAvatar(result.companion.avatar ?? DEFAULT_AVATAR); setModelId(result.companion.modelId ?? "");
      setSaved(true);
      await onRefresh();
    } catch (cause) { onError(cause); } finally { setSaving(false); }
  }

  return <div className="companion-configuration">
    <form className="participant-config" onSubmit={configure}>
      <h2>Identity and role</h2>
      <p className="muted-copy">These settings apply everywhere this Companion works.</p>
      <fieldset disabled={saving} onChange={() => setSaved(false)}>
        <label>Name<input required value={name} maxLength={80} onChange={event => setName(event.target.value)}/></label>
        <label>Role<Textarea value={instructions} maxLength={20_000} rows={3} onChange={event => setInstructions(event.target.value)}/></label>
        <details className="settings-advanced"><summary>Appearance</summary>
          <AvatarPicker value={avatar} onChange={value => { setAvatar(value); setSaved(false); }}/>
        </details>
        {!!models.length && <details className="settings-advanced"><summary>Advanced</summary>
          <label>Model<select value={modelId} onChange={event => setModelId(event.target.value)}>
            <option value="">Default</option>{models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
          </select></label>
          <p className="muted-copy">Model changes apply to the next response.</p>
        </details>}
      </fieldset>
      <Button type="submit" disabled={saving || !name.trim() || !changed}>{saving && <LoaderCircle className="spin"/>}{saving ? "Saving…" : "Save configuration"}</Button>
      {saved && <p className="saved-notice" role="status"><Check/>Changes saved.</p>}
      {error && <p className="field-error" role="alert">{error}</p>}
    </form>
    <section>
      <h2>Applications {companion.name} can use</h2>
      <p className="muted-copy">Removing access here keeps the account connected for your other Companions.</p>
      <ApplicationAccess companionId={companion.id} onConnect={onApplications} compact/>
    </section>
    <details className="settings-advanced"><summary>Share with a client</summary><DeliverySettings companionId={companion.id}/></details>
    {showRetirement && <CompanionRetirement companion={companion} onRetired={onRetired}/>}
  </div>;
}

/** Destructive companion removal, kept in one place so every surface behaves the same. */
export function CompanionRetirement({ companion, onRetired }: { companion: Companion; onRetired?: () => void | Promise<void> }) {
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState("");
  async function retire() {
    if (saving) return;
    setSaving(true); setError("");
    try { await api.deleteCompanion(companion.id); setConfirm(false); await onRetired?.(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not retire this Companion."); }
    finally { setSaving(false); }
  }
  return <section className="companion-retirement" aria-label={`Retire ${companion.name}`}>
    <h2>Retire companion</h2>
    {error && <p className="field-error" role="alert">{error}</p>}
    {confirm
      ? <div className="retirement-confirmation">
        <p>Retiring {companion.name} stops its work in every discussion and archives its machine. Your conversations stay.</p>
        <Button variant="destructive" disabled={saving} onClick={() => void retire()}>{saving ? "Retiring…" : "Confirm retirement"}</Button>
        <Button variant="ghost" disabled={saving} onClick={() => setConfirm(false)}>Keep companion</Button>
      </div>
      : <><p className="muted-copy">It stops working everywhere and its computer is archived. Conversation history remains.</p><Button variant="ghost" onClick={() => setConfirm(true)}>Retire {companion.name}</Button></>}
  </section>;
}
