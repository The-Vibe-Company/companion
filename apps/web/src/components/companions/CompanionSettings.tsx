"use client";

import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type {
  Companion,
  CompanionProvidersResponse,
} from "@companion/contracts";
import { ApiFetchError } from "@/lib/apiClient";
import {
  deleteCompanion,
  getCompanionRuntime,
  restartCompanionRuntime,
  updateCompanion,
  updateCompanionMemberState,
} from "@/lib/companions";
import { Icon } from "../Icon";
import { Dialog } from "../org/primitives";
import {
  CompanionProviderModelPicker,
  providerSelectedModel,
  validProviderSelection,
} from "./CompanionProviderModelPicker";
import { CompanionSkillPicker } from "./CompanionSkillPicker";
import { CompanionPluginPicker } from "./CompanionPluginPicker";
import { CompanionSkillsSyncStatus } from "./CompanionSkillsSyncStatus";
import { CompanionIconPicker, type CompanionIconValue } from "./CompanionIconPicker";

/** How often to re-read the control-plane row while a skill apply is in flight on an awake Box. */
const SKILLS_SYNC_POLL_MS = 3_000;
/** A stalled apply stops moving on its own; cap the poll instead of reading forever. */
const SKILLS_SYNC_POLL_MAX_TICKS = 40;

export function CompanionSettings({
  orgId,
  companion,
  providers,
  onBack,
  onSaved,
  onDeleted,
}: {
  orgId: string;
  companion: Companion;
  providers: CompanionProvidersResponse;
  onBack: () => void;
  onSaved: (companion: Companion) => void;
  onDeleted: (companionId: string) => void;
}) {
  const initialProviderId = companion.runtime.provider_ids[0] ?? "";
  const [name, setName] = useState(companion.name);
  const [instructions, setInstructions] = useState(companion.persona ?? "");
  const [providerId, setProviderId] = useState(initialProviderId);
  const [modelId, setModelId] = useState(
    providerSelectedModel(providers, initialProviderId, companion.model_id),
  );
  const [selectedSkillIds, setSelectedSkillIds] = useState(companion.selected_skill_ids);
  const [selectedMcpAccountIds, setSelectedMcpAccountIds] = useState(
    companion.selected_mcp_account_ids,
  );
  const [icon, setIcon] = useState<CompanionIconValue>({
    // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- icon catalogs use geometric domain terms
    shape: companion.icon?.shape ?? 1,
    mouth: companion.icon?.mouth ?? 1,
    accessory: companion.icon?.accessory ?? 1,
    color: companion.icon?.color ?? 2,
  });
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmingRestart, setConfirmingRestart] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [runtimeSnapshot, setRuntimeSnapshot] = useState(companion.runtime);
  const [runtimeNotice, setRuntimeNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [hidden, setHidden] = useState(companion.hidden);
  // Freshest row this view has seen, for the skills sync line: save responses land here, and while
  // an apply is in flight on an awake Box a short poll keeps it moving without waking anything.
  const [latest, setLatest] = useState(companion);
  const syncReadRef = useRef(0);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const deleteRequestIdRef = useRef<string | null>(null);
  const restartRequestIdRef = useRef<string | null>(null);
  const onSavedRef = useRef(onSaved);
  const onDeletedRef = useRef(onDeleted);
  onSavedRef.current = onSaved;
  onDeletedRef.current = onDeleted;
  const canEdit = companion.access === "owner" || companion.access === "editor";
  const canDelete = companion.access === "owner";

  useEffect(() => {
    setRuntimeSnapshot(companion.runtime);
  }, [companion.runtime]);

  useEffect(() => {
    const selection = validProviderSelection(providers, providerId, modelId);
    if (selection.providerId !== providerId) setProviderId(selection.providerId);
    if (selection.modelId !== modelId) setModelId(selection.modelId);
  }, [modelId, providerId, providers]);

  useEffect(() => {
    setLatest(companion);
  }, [companion]);

  // A terminal model-error CTA lands here after provider settings load. Put keyboard focus on the
  // current model so the destination is immediate and the existing save flow remains unchanged.
  useEffect(() => {
    if (window.location.hash !== "#companion-model") return;
    modelPickerRef.current
      ?.querySelector<HTMLInputElement>('input[name="companion-settings-model"]:checked')
      ?.focus();
  }, []);

  const restartActive = runtimeSnapshot.lifecycle_intent === "recycle_pi";
  const deletionActive = runtimeSnapshot.lifecycle_intent === "delete";
  const deletionRetryable = deletionActive && runtimeSnapshot.state === "error";
  const durableLifecycleMessage = deletionActive
    ? "Deletion is in progress. This Companion remains until its Box is permanently deleted."
    : restartActive
      ? "Restart is in progress. It joins any recovery already running."
      : null;
  const lifecycleActive = restartActive || deletionActive
    || runtimeSnapshot.state === "provisioning"
    || runtimeSnapshot.state === "stopping";
  useEffect(() => {
    if (!lifecycleActive || deletionActive) return;
    let active = true;
    const read = async () => {
      try {
        const next = await getCompanionRuntime(orgId, companion.id);
        if (!active) return;
        setError(null);
        setRuntimeSnapshot(next.runtime);
        setLatest(next);
        onSavedRef.current(next);
        if (!restartActive
          || next.runtime.state === "provisioning"
          || next.runtime.state === "stopping") return;
        if (next.runtime.state === "error") {
          setError(next.runtime.last_error ?? "The accepted restart failed. Retry when it is safe.");
          setRuntimeNotice(null);
          return;
        }
        if (next.runtime.lifecycle_intent === "recycle_pi") {
          setRuntimeNotice(null);
          return;
        }
        setRuntimeNotice("Restart completed.");
      } catch (cause) {
        if (!active) return;
        setError(cause instanceof Error
          ? `Restart status could not be refreshed: ${cause.message}`
          : "Restart status could not be refreshed.");
      }
    };
    const timer = setInterval(() => void read(), SKILLS_SYNC_POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [companion.id, deletionActive, lifecycleActive, orgId, restartActive]);

  const skillsPending = latest.runtime.skills_applied_revision < latest.runtime.skills_revision;
  // A publication alone never starts a fast poll: only a lifecycle that actually stops Pi can
  // advance this watermark.
  const skillsApplying = skillsPending
    && !deletionActive
    && !latest.runtime.skills_last_error
    && (latest.runtime.lifecycle_intent === "recycle_pi"
      || latest.runtime.state === "provisioning");
  useEffect(() => {
    if (!skillsApplying) return;
    let ticks = 0;
    const interval = setInterval(() => {
      if (++ticks > SKILLS_SYNC_POLL_MAX_TICKS) {
        clearInterval(interval);
        return;
      }
      const readId = ++syncReadRef.current;
      void getCompanionRuntime(orgId, companion.id)
        .then((next) => {
          if (readId !== syncReadRef.current) return;
          setLatest(next);
        })
        .catch(() => undefined);
    }, SKILLS_SYNC_POLL_MS);
    return () => clearInterval(interval);
  }, [skillsApplying, orgId, companion.id]);

  // Permanent deletion is asynchronous. Keep this surface until PostgreSQL confirms the row is
  // gone, so a queued operation is never presented as if external Box deletion already succeeded.
  useEffect(() => {
    if (!deletionActive || deletionRetryable) return;
    let active = true;
    const read = async () => {
      try {
        const next = await getCompanionRuntime(orgId, companion.id);
        if (!active) return;
        setError(null);
        setRuntimeSnapshot(next.runtime);
        if (next.runtime.state === "error") setRuntimeNotice(null);
        setLatest(next);
        onSavedRef.current(next);
      } catch (cause) {
        if (!active) return;
        if (cause instanceof ApiFetchError && cause.status === 404) {
          onDeletedRef.current(companion.id);
          return;
        }
        setError(cause instanceof Error
          ? `Deletion is still queued, but its status could not be refreshed: ${cause.message}`
          : "Deletion is still queued, but its status could not be refreshed.");
      }
    };
    void read();
    const timer = setInterval(() => void read(), SKILLS_SYNC_POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [companion.id, deletionActive, deletionRetryable, orgId]);

  const changed = useMemo(
    () =>
      name.trim() !== companion.name
      || instructions.trim() !== (companion.persona ?? "")
      || providerId !== (companion.runtime.provider_ids[0] ?? "")
      || modelId !== companion.model_id
      || selectedSkillIds.length !== companion.selected_skill_ids.length
      || selectedSkillIds.some((id, index) => id !== companion.selected_skill_ids[index])
      || selectedMcpAccountIds.length !== companion.selected_mcp_account_ids.length
      || selectedMcpAccountIds.some((id, index) => id !== companion.selected_mcp_account_ids[index])
      // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- icon catalogs use geometric domain terms
      || icon.shape !== (companion.icon?.shape ?? 1)
      || icon.mouth !== (companion.icon?.mouth ?? 1)
      || icon.accessory !== (companion.icon?.accessory ?? 1)
      || icon.color !== (companion.icon?.color ?? 2),
    [
      companion,
      instructions,
      modelId,
      name,
      providerId,
      selectedMcpAccountIds,
      selectedSkillIds,
    ],
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canEdit || deletionActive || !name.trim() || !providerId || !modelId || !changed) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const updated = await updateCompanion(orgId, companion.id, {
        name: name.trim(),
        persona: instructions.trim() || null,
        provider_id: providerId,
        model_id: modelId,
        selected_skill_ids: selectedSkillIds,
        selected_mcp_account_ids: selectedMcpAccountIds,
        icon,
      });
      onSaved(updated);
      syncReadRef.current += 1;
      setLatest(updated);
      setName(updated.name);
      setInstructions(updated.persona ?? "");
      setIcon({
        // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- icon catalogs use geometric domain terms
        shape: updated.icon?.shape ?? 1,
        mouth: updated.icon?.mouth ?? 1,
        accessory: updated.icon?.accessory ?? 1,
        color: updated.icon?.color ?? 2,
      });
      const updatedProviderId = updated.runtime.provider_ids[0] ?? "";
      setProviderId(updatedProviderId);
      setModelId(providerSelectedModel(providers, updatedProviderId, updated.model_id));
      setSelectedSkillIds(updated.selected_skill_ids);
      setSelectedMcpAccountIds(updated.selected_mcp_account_ids);
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Companion settings could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!canDelete) return;
    setBusy(true);
    setError(null);
    const requestId = deleteRequestIdRef.current ?? crypto.randomUUID();
    deleteRequestIdRef.current = requestId;
    try {
      const accepted = await deleteCompanion(orgId, companion.id, requestId);
      deleteRequestIdRef.current = null;
      setConfirmingDelete(false);
      setRuntimeSnapshot((current) => ({ ...current, lifecycle_intent: accepted.intent }));
      setRuntimeNotice("Deletion accepted.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "This Companion could not be deleted.");
      setConfirmingDelete(false);
    } finally {
      setBusy(false);
    }
  };

  const restart = async () => {
    if (!canEdit || changed || deletionActive || restartActive) return;
    setBusy(true);
    setRestarting(true);
    setError(null);
    setRuntimeNotice(null);
    const requestId = restartRequestIdRef.current ?? crypto.randomUUID();
    restartRequestIdRef.current = requestId;
    try {
      const accepted = await restartCompanionRuntime(
        orgId,
        companion.id,
        { target: "pi" },
        requestId,
      );
      restartRequestIdRef.current = null;
      setRuntimeSnapshot((current) => ({ ...current, lifecycle_intent: accepted.intent }));
      setRuntimeNotice("Restart accepted.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "This Companion could not be restarted.");
    } finally {
      setBusy(false);
      setRestarting(false);
      setConfirmingRestart(false);
    }
  };

  return (
    <section className="companions-settings" aria-labelledby="companion-settings-title">
      <header className="companions-head companions-settings__head">
        <div className="companions-settings__title">
          <button type="button" className="iconbtn" aria-label="Back to Companions" onClick={onBack}>
            <Icon name="arrow-left" size={16} />
          </button>
          <div>
            <h1 id="companion-settings-title">Companion settings</h1>
            <p>{companion.name}</p>
          </div>
        </div>
      </header>

      <div className="companions-content companions-settings__content">
        {(error ?? runtimeSnapshot.last_error) && (
          <div className="companions-error" role="alert">
            {error ?? runtimeSnapshot.last_error}
          </div>
        )}
        {saved && <div className="companions-settings__saved" role="status">Settings saved.</div>}
        {(runtimeNotice ?? durableLifecycleMessage) && (
          <div className="companions-settings__saved" role="status">
            {runtimeNotice ?? durableLifecycleMessage}
          </div>
        )}

        <form
          className="companions-settings__form"
          aria-busy={busy || undefined}
          onSubmit={submit}
        >
          {/* The face leads the form, exactly where the creation dialog put it. */}
          {canEdit && (
            <CompanionIconPicker
              value={icon}
              onChange={(next) => {
                setIcon(next);
                setSaved(false);
              }}
            />
          )}

          <label>
            Name
            <input
              name="name"
              required
              maxLength={120}
              value={name}
              disabled={!canEdit || busy || deletionActive}
              onChange={(event) => {
                setName(event.target.value);
                setSaved(false);
              }}
            />
          </label>

          <label>
            Instructions
            <textarea
              name="instructions"
              maxLength={280}
              rows={4}
              value={instructions}
              disabled={!canEdit || busy || deletionActive}
              aria-describedby="companion-instructions-hint"
              onChange={(event) => {
                setInstructions(event.target.value);
                setSaved(false);
              }}
            />
          </label>
          <p className="companions-settings__hint" id="companion-instructions-hint">
            Applied after the active turn settles and before the next turn starts.
          </p>

          <div id="companion-model" ref={modelPickerRef}>
            <CompanionProviderModelPicker
              providers={providers}
              providerId={providerId}
              modelId={modelId}
              namePrefix="companion-settings"
              descriptionId="companion-provider-hint"
              disabled={!canEdit || busy || deletionActive}
              onChange={(selection) => {
                setProviderId(selection.providerId);
                setModelId(selection.modelId);
                setSaved(false);
              }}
            />
          </div>
          <p className="companions-settings__hint" id="companion-provider-hint">
            Provider, model, skills, and plugin changes are applied in order between turns.
          </p>

          <CompanionSkillPicker
            orgId={orgId}
            selectedSkillIds={selectedSkillIds}
            disabled={!canEdit || busy || deletionActive}
            footer={<CompanionSkillsSyncStatus companion={latest} />}
            onSelectedSkillIdsChange={(ids) => {
              setSelectedSkillIds(ids);
              setSaved(false);
            }}
          />

          <CompanionPluginPicker
            orgId={orgId}
            selectedMcpAccountIds={selectedMcpAccountIds}
            disabled={!canEdit || busy || deletionActive}
            onSelectedMcpAccountIdsChange={(ids) => {
              setSelectedMcpAccountIds(ids);
              setSaved(false);
            }}
          />

          {canEdit && (
            <div className="companions-settings__actions">
              <button
                type="submit"
                className="cds-btn cds-btn--primary cds-btn--md"
                disabled={busy || deletionActive || !changed || !name.trim() || !providerId || !modelId}
              >
                {busy ? "Saving..." : "Save changes"}
              </button>
            </div>
          )}
        </form>

        {canEdit && (
          <section className="companions-settings__runtime" aria-labelledby="restart-companion-title">
            <div>
              <h2 id="restart-companion-title">Advanced recovery</h2>
              <p>Restart recycles the Companion process asynchronously. The Box and its files stay in place.</p>
            </div>

            <div className="companions-settings__restart-action">
              <p className="companions-settings__hint" id="restart-companion-hint">
                {deletionActive
                  ? "Companion deletion is in progress. Runtime controls are unavailable."
                  : restartActive
                    ? "The accepted restart is still running. A concurrent automatic recovery is joined, not duplicated."
                  : changed
                      ? "Save your changes before restarting."
                      : runtimeSnapshot.state === "not_created" || runtimeSnapshot.state === "stopped"
                        ? "Pi-only recovery remains available while this Companion is offline. Sending remains the normal wake action."
                        : "Restart can interrupt active work. You will confirm before the Pi process is recycled."}
              </p>
              <button
                type="button"
                className="cds-btn cds-btn--secondary cds-btn--md"
                disabled={
                  busy
                  || changed
                  || deletionActive
                  || restartActive
                }
                onClick={() => setConfirmingRestart(true)}
              >
                {restarting ? "Restarting..." : restartActive ? "Restart queued..." : "Restart"}
              </button>
            </div>
          </section>
        )}

        {hidden && (
          <section className="companions-settings__danger" aria-labelledby="unhide-companion-title">
            <div>
              <h2 id="unhide-companion-title">Hidden from your list</h2>
              <p>This Companion stays available. Unhide it to put it back in your Companions list.</p>
            </div>
            <button
              type="button"
              className="cds-btn cds-btn--secondary cds-btn--md"
              disabled={busy || deletionActive}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  const next = await updateCompanionMemberState(orgId, companion.id, {
                    hidden: false,
                  });
                  setHidden(false);
                  onSaved(next);
                } catch (cause) {
                  setError(cause instanceof Error ? cause.message : "Could not unhide this Companion.");
                } finally {
                  setBusy(false);
                }
              }}
            >
              Unhide
            </button>
          </section>
        )}

        {canDelete && (
          <section className="companions-settings__danger" aria-labelledby="delete-companion-title">
            <div>
              <h2 id="delete-companion-title">Delete Companion</h2>
              <p>Permanently deletes its Box and transcript. This cannot be undone.</p>
            </div>
            <button
              type="button"
              className="cds-btn cds-btn--danger cds-btn--md"
              disabled={busy || (deletionActive && !deletionRetryable)}
              onClick={() => setConfirmingDelete(true)}
            >
              {deletionRetryable
                ? "Retry Delete"
                : deletionActive
                  ? "Deletion requested"
                  : "Delete Companion"}
            </button>
          </section>
        )}
      </div>

      {confirmingDelete && (
        <Dialog
          icon="trash-2"
          title={`Delete ${companion.name}?`}
          desc="Its Box, thread, and Companion record will be permanently deleted after runtime confirmation. This cannot be undone."
          onClose={() => setConfirmingDelete(false)}
          closeDisabled={busy}
          className="og-dialog companions-delete-dialog"
          foot={(
            <>
              <button
                type="button"
                className="cds-btn cds-btn--secondary cds-btn--md"
                disabled={busy}
                onClick={() => setConfirmingDelete(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="cds-btn cds-btn--danger cds-btn--md"
                disabled={busy}
                onClick={() => void remove()}
              >
                {busy ? "Deleting..." : "Delete Companion"}
              </button>
            </>
          )}
        />
      )}

      {confirmingRestart && (
        <Dialog
          icon="refresh-cw"
          title={`Restart ${companion.name}?`}
          desc="This asynchronously recycles Pi and joins any automatic recovery already running. Active work may be interrupted; the Box and saved files remain in place."
          onClose={() => setConfirmingRestart(false)}
          closeDisabled={busy}
          className="og-dialog companions-restart-dialog"
          foot={(
            <>
              <button
                type="button"
                className="cds-btn cds-btn--secondary cds-btn--md"
                disabled={busy}
                onClick={() => setConfirmingRestart(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="cds-btn cds-btn--primary cds-btn--md"
                disabled={busy}
                onClick={() => void restart()}
              >
                {restarting ? "Restarting..." : "Restart"}
              </button>
            </>
          )}
        />
      )}
    </section>
  );
}
