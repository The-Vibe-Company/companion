"use client";

import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type {
  Companion,
  CompanionLatestOperation,
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

type RuntimeNotice = {
  operationId: string | null;
  message: string;
};

function operationNotice(
  operation: Pick<CompanionLatestOperation, "id" | "kind" | "status">,
): RuntimeNotice | null {
  const operationId = operation.id;
  if (operation.status === "pending") {
    switch (operation.kind) {
      case "delete":
        return {
          operationId,
          message: "Deletion accepted. This Companion remains visible until its Box is permanently deleted.",
        };
      case "restart_pi":
        return { operationId, message: "Restart accepted. It joins any recovery already in progress." };
      default:
        return null;
    }
  }
  if (operation.status !== "succeeded") return null;
  switch (operation.kind) {
    case "delete":
      return { operationId, message: "Deletion completed." };
    case "restart_pi":
      return { operationId, message: "Restart completed." };
    case "stop":
      return { operationId, message: "Stop completed." };
    case "start":
      return { operationId, message: "Start completed." };
    case "apply_settings":
      return { operationId, message: "Settings applied." };
  }
}

function operationFailureMessage(operation: CompanionLatestOperation | null): string | null {
  if (operation === null
    || !["failed", "interrupted", "cancelled"].includes(operation.status)) return null;
  if (operation.error?.message) return operation.error.message;
  const label = operation.kind === "delete"
    ? "Deletion"
    : operation.kind === "restart_pi"
      ? "Restart"
      : operation.kind === "apply_settings"
          ? "Settings apply"
          : operation.kind === "start"
            ? "Start"
            : "Stop";
  return operation.status === "failed"
    ? `${label} failed.`
    : operation.status === "interrupted"
      ? `${label} was interrupted. Retry when it is safe.`
      : `${label} was cancelled.`;
}

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
  const [latestOperation, setLatestOperation] = useState(companion.runtime.latest_operation ?? null);
  const [runtimeNotice, setRuntimeNotice] = useState<RuntimeNotice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [hidden, setHidden] = useState(companion.hidden);
  // Freshest row this view has seen, for the skills sync line: save responses land here, and while
  // an apply is in flight on an awake Box a short poll keeps it moving without waking anything.
  const [latest, setLatest] = useState(companion);
  const syncReadRef = useRef(0);
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
    const nextOperation = companion.runtime.latest_operation ?? null;
    setLatestOperation(nextOperation);
    if (nextOperation !== null && nextOperation.status !== "pending") {
      setRuntimeNotice(operationNotice(nextOperation));
    }
  }, [companion.runtime]);

  useEffect(() => {
    const selection = validProviderSelection(providers, providerId, modelId);
    if (selection.providerId !== providerId) setProviderId(selection.providerId);
    if (selection.modelId !== modelId) setModelId(selection.modelId);
  }, [modelId, providerId, providers]);

  useEffect(() => {
    setLatest(companion);
  }, [companion]);

  const operationActive = latestOperation !== null
    && (latestOperation.status === "pending" || latestOperation.status === "running");
  const restartActive = operationActive && latestOperation.kind === "restart_pi";
  const deletionActive = operationActive && latestOperation?.kind === "delete";
  const deletionRetryable = latestOperation?.kind === "delete"
    && (latestOperation.status === "failed"
      || latestOperation.status === "interrupted"
      || latestOperation.status === "cancelled");
  const operationPending = latestOperation?.status === "pending";
  const durableOperationMessage = operationActive
    ? latestOperation.kind === "delete"
      ? operationPending
        ? "Deletion is queued. This Companion remains until its Box is permanently deleted."
        : "Deletion is in progress. This Companion remains until its Box is permanently deleted."
      : latestOperation.kind === "stop"
        ? operationPending
          ? "Stop is queued. Status refreshes every three seconds."
          : "Stop is in progress. Status refreshes every three seconds."
        : latestOperation.kind === "restart_pi"
          ? operationPending
            ? "Restart is queued. It joins any recovery already in progress."
            : "Restart is in progress. Status refreshes automatically."
          : latestOperation.kind === "start"
              ? operationPending
                ? "Start is queued. Status refreshes every three seconds."
                : "Start is in progress. Status refreshes every three seconds."
              : operationPending
                ? "Settings apply is queued. Status refreshes every three seconds."
                : "Settings are being applied. Status refreshes every three seconds."
    : null;
  const runtimeMessage = runtimeNotice !== null
    && (latestOperation === null
      || runtimeNotice.operationId === null
      || runtimeNotice.operationId === latestOperation.id)
    ? runtimeNotice.message
    : null;
  const durableOperationError = operationFailureMessage(latestOperation);
  const lifecycleActive = operationActive
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
        const nextOperation = next.runtime.latest_operation ?? null;
        setLatestOperation(nextOperation);
        if (nextOperation !== null && nextOperation.status !== "pending") {
          setRuntimeNotice(operationNotice(nextOperation));
        }
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
        if (nextOperation !== null
          && (nextOperation.status === "pending" || nextOperation.status === "running")) return;
        if (nextOperation !== null
          && ["failed", "interrupted", "cancelled"].includes(nextOperation.status)) return;
        setRuntimeNotice({
          operationId: nextOperation?.id ?? null,
          message: "Restart completed.",
        });
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
  const skillApplyingOperation = latest.runtime.latest_operation;
  // A publication alone never starts a fast poll: only a lifecycle that actually stops Pi can
  // advance this watermark.
  const skillsApplying = skillsPending
    && !deletionActive
    && !latest.runtime.skills_last_error
    && skillApplyingOperation !== null
    && ["stop", "restart_pi", "apply_settings"].includes(
      skillApplyingOperation.kind,
    )
    && ["pending", "running"].includes(skillApplyingOperation.status);
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
    if (!deletionActive) return;
    let active = true;
    const read = async () => {
      try {
        const next = await getCompanionRuntime(orgId, companion.id);
        if (!active) return;
        setError(null);
        setRuntimeSnapshot(next.runtime);
        const nextOperation = next.runtime.latest_operation ?? null;
        setLatestOperation(nextOperation);
        if (nextOperation !== null && nextOperation.status !== "pending") {
          setRuntimeNotice(operationNotice(nextOperation));
        }
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
  }, [companion.id, deletionActive, orgId]);

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
      await deleteCompanion(orgId, companion.id, requestId);
      deleteRequestIdRef.current = null;
      setConfirmingDelete(false);
      setRuntimeNotice({ operationId: null, message: "Permanent deletion requested." });
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
      await restartCompanionRuntime(orgId, companion.id, { target: "pi" }, requestId);
      restartRequestIdRef.current = null;
      setRuntimeNotice({ operationId: null, message: "Pi restart requested." });
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
        {(error ?? durableOperationError) && (
          <div className="companions-error" role="alert">
            {error ?? durableOperationError}
          </div>
        )}
        {saved && <div className="companions-settings__saved" role="status">Settings saved.</div>}
        {(runtimeMessage ?? durableOperationMessage) && (
          <div className="companions-settings__saved" role="status">
            {runtimeMessage ?? durableOperationMessage}
          </div>
        )}

        <form className="companions-settings__form" onSubmit={submit}>
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
              disabled={busy || deletionActive}
              onClick={() => setConfirmingDelete(true)}
            >
              {deletionActive
                ? "Deletion requested"
                : deletionRetryable
                  ? "Retry Delete"
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
