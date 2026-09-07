/* oxlint-disable anti-slop/no-known-value-widening, anti-slop/require-safety-comment-for-type-assertion -- Hosted Companion removal preserves the existing Skills Hub implementation; these patterns predate this change. */
"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  CreateSecretInput,
  OrgSettingsMember,
  SecretAudience,
  SecretRow,
} from "@companion/contracts";
import type { MeVM, OrgVM } from "@/lib/types";
import {
  createSecret as createSecretRpc,
  deleteSecret as deleteSecretRpc,
  rotateSecret as rotateSecretRpc,
  updateSecret as updateSecretRpc,
} from "@/lib/secrets";
import { Icon } from "../Icon";
import { Onboarding } from "../org/Onboarding";
import { useOrgActions } from "../org/useOrgActions";
import { UserAvatar } from "../UserAvatar";
import { useModalA11y } from "../skills/UploadDialog";
import { Sidebar } from "../skills/Sidebar";
import { skillsRouteHref, type SkillsLibrary } from "../skills/route";
import type { TreeRow } from "../skills/sidebarTree";

const AUDIENCE_LABEL: Record<SecretAudience, string> = {
  personal: "Personal",
  restricted: "Selected members",
  organization: "Organization",
};

type SecretForm = {
  name: string;
  key: string;
  value: string;
  audience: SecretAudience;
  recipientIds: string[];
};

const EMPTY_FORM: SecretForm = {
  name: "",
  key: "",
  value: "",
  audience: "personal",
  recipientIds: [],
};

function audienceDescription(audience: SecretAudience): string {
  if (audience === "personal") return "Only you can use this secret.";
  if (audience === "restricted") return "Only you and selected members can use this secret.";
  return "Every current and future member of this workspace can use this secret.";
}

function formatRotation(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function replaceRow(rows: SecretRow[], row: SecretRow): SecretRow[] {
  const next = rows.some((item) => item.id === row.id)
    ? rows.map((item) => (item.id === row.id ? row : item))
    : [row, ...rows];
  return next.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

function MemberPicker({
  members,
  ownerId,
  selected,
  onChange,
}: {
  members: OrgSettingsMember[];
  ownerId: string;
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const available = members.filter((member) => member.userId !== ownerId);
  return (
    <fieldset className="sec-members">
      <legend>Members</legend>
      {available.length === 0 ? (
        <p className="sec-muted">Invite another member before using selected access.</p>
      ) : available.map((member) => {
        const checked = selected.includes(member.userId);
        return (
          <label className="sec-member" key={member.userId}>
            <input
              type="checkbox"
              checked={checked}
              onChange={() => onChange(checked ? selected.filter((id) => id !== member.userId) : [...selected, member.userId])}
            />
            <UserAvatar className="sec-avatar" size={24} initials={member.initials} avatarUrl={member.avatarUrl} />
            <span><b>{member.name}</b><small>{member.email}</small></span>
          </label>
        );
      })}
    </fieldset>
  );
}

function SecretEditor({
  form,
  setForm,
  members,
  ownerId,
  submitLabel,
  busy,
  onSubmit,
  onCancel,
}: {
  form: SecretForm;
  setForm: (form: SecretForm) => void;
  members: OrgSettingsMember[];
  ownerId: string;
  submitLabel: string;
  busy: boolean;
  onSubmit: () => void;
  onCancel?: () => void;
}) {
  const valueInputId = useId();
  const [valueVisible, setValueVisible] = useState(false);
  const valid = form.name.trim().length > 0
    && /^[A-Za-z_][A-Za-z0-9_]*$/.test(form.key)
    && form.value.length > 0
    && (form.audience !== "restricted" || form.recipientIds.length > 0);
  return (
    <div className="sec-form">
      <label>
        <span>Name</span>
        <input autoFocus value={form.name} maxLength={120} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Production API key" />
      </label>
      <label>
        <span>Environment key</span>
        <input className="sec-mono" value={form.key} maxLength={128} onChange={(event) => setForm({ ...form, key: event.target.value.toUpperCase() })} placeholder="SERVICE_API_KEY" spellCheck={false} />
      </label>
      <div className="sec-field">
        <label htmlFor={valueInputId}>Secret value</label>
        <div className="sec-secret-value">
          <input
            id={valueInputId}
            type={valueVisible ? "text" : "password"}
            value={form.value}
            onChange={(event) => setForm({ ...form, value: event.target.value })}
            placeholder="Enter once — it cannot be revealed later"
            autoComplete="new-password"
            spellCheck={false}
          />
          <button
            type="button"
            onClick={() => setValueVisible((visible) => !visible)}
            aria-label={valueVisible ? "Hide secret value" : "Show secret value"}
            aria-pressed={valueVisible}
            title={valueVisible ? "Hide secret value" : "Show secret value"}
          >
            <Icon name={valueVisible ? "eye-off" : "eye"} size={15} />
          </button>
        </div>
        <small>The value is encrypted immediately and is never shown again.</small>
      </div>
      <label>
        <span>Who can use it</span>
        <select value={form.audience} onChange={(event) => setForm({ ...form, audience: event.target.value as SecretAudience, recipientIds: [] })}>
          <option value="personal">Personal</option>
          <option value="restricted">Selected members</option>
          <option value="organization">Organization</option>
        </select>
        <small>{audienceDescription(form.audience)}</small>
      </label>
      {form.audience === "restricted" && (
        <MemberPicker members={members} ownerId={ownerId} selected={form.recipientIds} onChange={(recipientIds) => setForm({ ...form, recipientIds })} />
      )}
      <div className="sec-actions">
        {onCancel && <button className="cds-btn cds-btn--md cds-btn--secondary" onClick={onCancel}>Cancel</button>}
        <button className="cds-btn cds-btn--md cds-btn--primary" disabled={!valid || busy} onClick={onSubmit}>
          {busy && <Icon name="loader" size={14} />} {submitLabel}
        </button>
      </div>
    </div>
  );
}

export function SecretsApp({
  initialSecrets,
  members,
  me,
  orgs,
  currentOrg,
  initialCreateKey,
  navigation,
}: {
  initialSecrets: SecretRow[];
  members: OrgSettingsMember[];
  me: MeVM;
  orgs: OrgVM[];
  currentOrg: OrgVM;
  initialCreateKey: string | null;
  navigation: {
    mineTreeRows: TreeRow[];
    orgTreeRows: TreeRow[];
    mineCount: number;
    orgCount: number;
    installedCount: number;
    installedUpdateCount: number;
    localUpdateCount: number;
    archivedCount: number;
  };
}) {
  const router = useRouter();
  const orgActions = useOrgActions();
  const [rows, setRows] = useState(initialSecrets);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(initialCreateKey !== null);
  const [form, setForm] = useState<SecretForm>(initialCreateKey ? { ...EMPTY_FORM, key: initialCreateKey } : EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rotateValue, setRotateValue] = useState("");
  const [editingAccess, setEditingAccess] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [audience, setAudience] = useState<SecretAudience>("personal");
  const [recipientIds, setRecipientIds] = useState<string[]>([]);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const selected = rows.find((row) => row.id === selectedId) ?? null;
  const drawerOpen = creating || Boolean(selected);
  const drawerRef = useRef<HTMLElement>(null);
  const drawerOpenerRef = useRef<HTMLElement>(null);
  const sideRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const closeDrawer = useCallback(() => {
    setCreating(false);
    setSelectedId(null);
    setEditingAccess(false);
    setConfirmingDelete(false);
    setForm(EMPTY_FORM);
    setRotateValue("");
  }, []);
  useModalA11y(drawerRef, closeDrawer, drawerOpen, drawerOpenerRef);

  useEffect(() => {
    const background = [sideRef.current, mainRef.current].filter((element): element is HTMLElement => Boolean(element));
    for (const element of background) element.inert = drawerOpen;
    if (drawerRef.current) drawerRef.current.inert = !drawerOpen;
    return () => {
      for (const element of background) element.inert = false;
    };
  }, [drawerOpen]);

  useEffect(() => {
    router.prefetch("/skills");
  }, [router]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? rows.filter((row) => `${row.name} ${row.key} ${row.owner.name}`.toLowerCase().includes(needle)) : rows;
  }, [query, rows]);
  const owned = filtered.filter((row) => row.owner.id === me.id);
  const shared = filtered.filter((row) => row.owner.id !== me.id);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await action(); } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); } finally { setBusy(false); }
  };

  const openDetail = (row: SecretRow, opener?: HTMLElement) => {
    if (opener) drawerOpenerRef.current = opener;
    setSelectedId(row.id);
    setCreating(false);
    setEditingAccess(false);
    setConfirmingDelete(false);
    setRotateValue("");
    setAudience(row.audience);
    setRecipientIds(row.recipients.map((recipient) => recipient.id));
  };

  const create = () => void run(async () => {
    const input: CreateSecretInput = {
      name: form.name.trim(),
      key: form.key.trim(),
      value: form.value,
      audience: form.audience,
      recipient_ids: form.audience === "restricted" ? form.recipientIds : [],
    };
    const row = await createSecretRpc(currentOrg.id, input);
    setRows((current) => replaceRow(current, row));
    setForm(EMPTY_FORM);
    setCreating(false);
    openDetail(row);
  });

  const saveAccess = () => selected && void run(async () => {
    const row = await updateSecretRpc(currentOrg.id, selected.id, {
      audience,
      recipient_ids: audience === "restricted" ? recipientIds : [],
    });
    setRows((current) => replaceRow(current, row));
    setEditingAccess(false);
  });

  const rotate = () => selected && void run(async () => {
    const row = await rotateSecretRpc(currentOrg.id, selected.id, rotateValue);
    setRows((current) => replaceRow(current, row));
    setRotateValue("");
  });

  const remove = () => selected && void run(async () => {
    await deleteSecretRpc(currentOrg.id, selected.id);
    setRows((current) => current.filter((row) => row.id !== selected.id));
    setConfirmingDelete(false);
    setSelectedId(null);
  });

  const navigateToLabel = (lib: SkillsLibrary, path: string) => {
    router.push(skillsRouteHref({ lib, kind: "label", label: path }));
  };
  const toggleExpanded = (path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };
  const noop = () => {};

  useEffect(() => {
    if (!mobileSidebarOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setMobileSidebarOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mobileSidebarOpen]);

  return (
    <div className={"app app--skills sec-app" + (mobileSidebarOpen ? " app--side-open" : "")}>
      <Sidebar
        asideRef={sideRef}
        orgs={orgs}
        currentOrg={currentOrg}
        onSwitchOrg={orgActions.switchOrg}
        onOnboard={orgActions.setOnboarding}
        onOpenSettings={() => router.push("/settings")}
        onWarmSettings={noop}
        mineTreeRows={navigation.mineTreeRows}
        orgTreeRows={navigation.orgTreeRows}
        expanded={expanded}
        onToggleExpand={toggleExpanded}
        selection={null}
        mineCount={navigation.mineCount}
        orgCount={navigation.orgCount}
        installedCount={navigation.installedCount}
        installedUpdateCount={navigation.installedUpdateCount}
        onOpenPalette={() => router.push("/skills")}
        onSelectMineAll={() => router.push(skillsRouteHref({ lib: "mine", kind: "all" }))}
        onSelectOrgAll={() => router.push(skillsRouteHref({ lib: "org", kind: "all" }))}
        onSelectInstalled={() => router.push(skillsRouteHref({ lib: "mine", kind: "installed" }))}
        onSelectLabel={navigateToLabel}
        onCreateLabel={noop}
        onSetLabelColor={noop}
        onSetLabelIcon={noop}
        onRenameLabel={noop}
        onDeleteLabel={noop}
        drag={null}
        hovered={null}
        openPendingPath={null}
        dropDone={null}
        onReparentLabel={noop}
        onLabelStartDrag={noop}
        onSelectLocal={() => router.push(skillsRouteHref({ kind: "local" }))}
        onSelectArchived={() => router.push(skillsRouteHref({ kind: "archived" }))}
        onSelectSecrets={noop}
        secretsActive
        navigationOnly
        localActive={false}
        localUpdateCount={navigation.localUpdateCount}
        archivedActive={false}
        archivedCount={navigation.archivedCount}
        mobileOpen={mobileSidebarOpen}
        onToggleMobile={() => setMobileSidebarOpen((open) => !open)}
        onCloseMobile={() => setMobileSidebarOpen(false)}
      />
      {mobileSidebarOpen && (
        <button type="button" className="side-scrim" aria-label="Close navigation" onClick={() => setMobileSidebarOpen(false)} />
      )}

      <main className="sec-main" ref={mainRef} aria-hidden={mobileSidebarOpen || undefined} inert={mobileSidebarOpen ? true : undefined}>
        <header className="sec-head">
          <div>
            <p className="sec-kicker">Workspace vault</p>
            <h1>Secrets</h1>
            <p>Store and share the credentials declared by your skills.</p>
          </div>
          <button className="cds-btn cds-btn--md cds-btn--primary" onClick={(event) => { drawerOpenerRef.current = event.currentTarget; setCreating(true); setSelectedId(null); setForm(EMPTY_FORM); }}>
            <Icon name="plus" size={15} /> New secret
          </button>
        </header>
        <div className="sec-toolbar">
          <Icon name="search" size={15} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search names, keys, or owners…" aria-label="Search secrets" />
          <span>{filtered.length} secret{filtered.length === 1 ? "" : "s"}</span>
        </div>
        {error && <div className="sec-error" role="alert"><Icon name="alert-triangle" size={15} />{error}<button onClick={() => setError(null)} aria-label="Dismiss"><Icon name="x" size={14} /></button></div>}
        {filtered.length === 0 ? (
          <div className="sec-empty"><Icon name="key-round" size={24} /><h2>{query ? "No matching secrets" : "Your vault is empty"}</h2><p>{query ? "Try a different search." : "Create a secret to bind it to a skill without exposing its value."}</p></div>
        ) : (
          <div className="sec-groups">
            {[{ title: "Owned", rows: owned }, { title: "Shared with me", rows: shared }].map((group) => group.rows.length > 0 && (
              <section className="sec-group" key={group.title}>
                <div className="sec-group__head"><h2>{group.title}</h2><span>{group.rows.length}</span></div>
                <div className="sec-table" role="list">
                  {group.rows.map((row) => (
                    <button className="sec-row" key={row.id} onClick={(event) => openDetail(row, event.currentTarget)} role="listitem">
                      <span className="sec-keyicon"><Icon name="key" size={15} /></span>
                      <span className="sec-row__main"><b>{row.name}</b><code>{row.key}</code></span>
                      <span className={`sec-audience sec-audience--${row.audience}`}>{AUDIENCE_LABEL[row.audience]}</span>
                      <span className="sec-row__owner">{row.owner.id === me.id ? "You" : row.owner.name}</span>
                      <span className="sec-row__version">v{row.current_version}</span>
                      <Icon name="chevron-right" size={15} />
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </main>

      {drawerOpen && <button className="sec-scrim" aria-label="Close secret drawer" tabIndex={-1} onClick={closeDrawer} />}
      <aside
        className={`sec-drawer${drawerOpen ? " is-open" : ""}`}
        aria-hidden={!drawerOpen}
        aria-labelledby="secret-drawer-title"
        aria-modal="true"
        role="dialog"
        ref={drawerRef}
        tabIndex={-1}
      >
        <div className="sec-drawer__head">
          <div><span>{creating ? "New secret" : "Secret details"}</span><h2 id="secret-drawer-title">{creating ? "Store a credential" : selected?.name}</h2></div>
          <button className="cds-iconbtn cds-iconbtn--md" onClick={closeDrawer} aria-label="Close"><Icon name="x" /></button>
        </div>
        <div className="sec-drawer__body">
          {creating ? (
            <SecretEditor form={form} setForm={setForm} members={members} ownerId={me.id} submitLabel="Create secret" busy={busy} onSubmit={create} />
          ) : selected ? (
            <>
              <div className="sec-no-reveal"><Icon name="shield-check" size={16} /><span><b>Value protected</b><small>Companion never reveals or copies this value after creation.</small></span></div>
              <dl className="sec-meta">
                <div><dt>Environment key</dt><dd><code>{selected.key}</code></dd></div>
                <div><dt>Owner</dt><dd><UserAvatar className="sec-avatar" size={22} initials={selected.owner.initials} avatarUrl={selected.owner.avatar_url} />{selected.owner.name}</dd></div>
                <div><dt>Last rotation</dt><dd>{formatRotation(selected.last_rotated_at)} · v{selected.current_version}</dd></div>
                <div><dt>Skill bindings</dt><dd>{selected.can_manage ? selected.usage_count : "Private"}</dd></div>
              </dl>
              <section className="sec-panel">
                <div className="sec-panel__head"><div><h3>Access</h3><p>{audienceDescription(selected.audience)}</p></div>{selected.can_manage && !editingAccess && <button onClick={() => { setAudience(selected.audience); setRecipientIds(selected.recipients.map((recipient) => recipient.id)); setEditingAccess(true); }}>Edit</button>}</div>
                {!editingAccess ? (
                  <div className="sec-access-summary"><span className={`sec-audience sec-audience--${selected.audience}`}>{AUDIENCE_LABEL[selected.audience]}</span>{selected.audience === "restricted" && selected.can_manage && <small>{selected.recipients.length} selected</small>}</div>
                ) : (
                  <div className="sec-access-edit">
                    <select value={audience} onChange={(event) => { setAudience(event.target.value as SecretAudience); setRecipientIds([]); }}>
                      <option value="personal">Personal</option><option value="restricted">Selected members</option><option value="organization">Organization</option>
                    </select>
                    <p>{audienceDescription(audience)}</p>
                    {audience === "restricted" && <MemberPicker members={members} ownerId={me.id} selected={recipientIds} onChange={setRecipientIds} />}
                    <div className="sec-actions"><button className="cds-btn cds-btn--sm cds-btn--secondary" onClick={() => { setAudience(selected.audience); setRecipientIds(selected.recipients.map((recipient) => recipient.id)); setEditingAccess(false); }}>Cancel</button><button className="cds-btn cds-btn--sm cds-btn--primary" disabled={busy || (audience === "restricted" && recipientIds.length === 0)} onClick={saveAccess}>Save access</button></div>
                  </div>
                )}
              </section>
              {selected.can_manage && (
                <section className="sec-panel">
                  <div className="sec-panel__head"><div><h3>Rotate value</h3><p>Existing retrieval plans keep their exact version; new syncs use the rotation.</p></div></div>
                  <label className="sec-rotate"><span>New value</span><input type="password" autoComplete="new-password" value={rotateValue} onChange={(event) => setRotateValue(event.target.value)} placeholder="Enter replacement value" /></label>
                  <div className="sec-actions"><button className="cds-btn cds-btn--sm cds-btn--secondary" disabled={!rotateValue || busy} onClick={rotate}><Icon name="refresh-cw" size={13} /> Rotate</button></div>
                </section>
              )}
              {selected.can_manage && (
                <section className="sec-danger" aria-live="polite">
                  <div>
                    <h3>{confirmingDelete ? `Delete “${selected.name}”?` : "Delete secret"}</h3>
                    <p>{confirmingDelete
                      ? "This cannot be undone. Every binding is revoked, and local projections receive an opaque tombstone on the next sync."
                      : "Bindings are invalidated and local projections receive an opaque tombstone on the next sync."}</p>
                  </div>
                  {confirmingDelete ? (
                    <div className="sec-danger__actions">
                      <button disabled={busy} onClick={() => setConfirmingDelete(false)}>Cancel</button>
                      <button disabled={busy} onClick={remove}><Icon name="trash-2" size={14} />Delete permanently</button>
                    </div>
                  ) : (
                    <button disabled={busy} onClick={() => setConfirmingDelete(true)}><Icon name="trash-2" size={14} />Delete</button>
                  )}
                </section>
              )}
            </>
          ) : null}
        </div>
      </aside>

      {orgActions.onboarding && <Onboarding mode={orgActions.onboarding} onMode={orgActions.setOnboarding} onCreate={orgActions.createOrg} onJoin={orgActions.joinOrg} busy={orgActions.busy} />}
      {orgActions.error && <div className="og-toast" role="alert" onClick={() => orgActions.setError(null)}>{orgActions.error}</div>}
    </div>
  );
}
