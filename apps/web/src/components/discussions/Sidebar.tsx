import { useRef, useState, type FormEvent, type MouseEvent, type RefObject } from "react";
import { Archive, ChevronRight, Plus, Settings, X } from "lucide-react";
import { discussionApi, type AccountUser, type Companion, type Discussion, type DiscussionFolder } from "@/api";
import { CompanionAvatar } from "../CompanionAvatar";
import { Button } from "../ui/button";
import { cn } from "@/lib/utils";
import { useModalFocus } from "@/hooks/useModalFocus";
import { RowMenu, RowMenuTrigger, type RowMenuItem, type RowMenuRequest } from "./RowMenu";
import { fullDateLabel, stripPreview, timeLabel } from "./shared";

const FOLDER_STATE_KEY = "companions.build:discussion-folders";

type SidebarProps = {
  panelRef: RefObject<HTMLElement | null>;
  open: boolean;
  user: AccountUser;
  companions: Companion[];
  discussions: Discussion[];
  folders: DiscussionFolder[];
  selectedId: string | null;
  onClose: () => void;
  onOpen: (id: string) => void;
  onArchive: (id: string) => Promise<void>;
  onCreate: (input?: { title?: string; folderId?: string; directCompanionId?: string }) => Promise<unknown>;
  onListRefresh: () => Promise<unknown>;
  onShowArchived: () => void;
  onCreateCompanion: () => void;
  onApplications: () => void;
  onAccount: () => void;
  onCompanionSettings?: (id: string) => void;
  onError: (cause: unknown, fallback?: string) => void;
};

export function Sidebar({ panelRef, open, user, companions, discussions, folders, selectedId, onClose, onOpen, onArchive, onCreate, onListRefresh, onShowArchived, onCreateCompanion, onApplications, onAccount, onCompanionSettings, onError }: SidebarProps) {
  const [menu, setMenu] = useState<RowMenuRequest | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [defaultsFor, setDefaultsFor] = useState<DiscussionFolder | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [collapsed, setCollapsed] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem(FOLDER_STATE_KEY) ?? "[]") as string[]; } catch { return []; } });

  function toggleFolder(id: string, folderOpen: boolean) {
    setCollapsed(current => {
      const next = folderOpen ? current.filter(item => item !== id) : [...new Set([...current, id])];
      try { localStorage.setItem(FOLDER_STATE_KEY, JSON.stringify(next)); } catch { /* the rail still works */ }
      return next;
    });
  }

  function requestMenu(id: string, label: string, items: RowMenuItem[]) {
    return (anchor: HTMLElement) => setMenu(current => current?.id === id ? null : { id, label, items, anchor });
  }

  const groups = discussions.filter(item => !item.directCompanionId);
  const grouped = folders.map(folder => ({ folder, discussions: groups.filter(item => item.folderId === folder.id) }));
  const ungrouped = groups.filter(item => !item.folderId || !folders.some(folder => folder.id === item.folderId));

  async function mutate(action: () => Promise<unknown>) { try { await action(); await onListRefresh(); } catch (cause) { onError(cause); } }

  async function openDirect(companion: Companion, existing?: Discussion) {
    if (existing) { onOpen(existing.id); return; }
    try {
      const result = await discussionApi.directForCompanion(companion.id);
      const found = result.discussions.find(item => !item.archivedAt);
      if (found) onOpen(found.id); else await onCreate({ directCompanionId: companion.id, title: companion.name });
    } catch (cause) { onError(cause); }
  }

  const createItems: RowMenuItem[] = [
    { label: "New discussion", accessibleName: "New discussion", onSelect: () => void onCreate().catch(onError) },
    { label: "New folder", onSelect: () => setCreatingFolder(true) },
    { label: "New companion", onSelect: onCreateCompanion },
  ];

  return <aside ref={panelRef} tabIndex={-1} className={cn("discussion-sidebar", open && "discussion-sidebar--open")} aria-label="Discussions">
    <header>
      <button className="discussion-wordmark" onClick={() => { const latest = groups[0] ?? discussions[0]; if (latest && latest.id !== selectedId) onOpen(latest.id); onClose(); }} aria-label="Back to discussions"><img src="/favicon.svg" alt="" /></button>
      <button type="button" className="sidebar-create" aria-label="Create" aria-haspopup="menu" aria-expanded={menu?.id === "create"} onClick={event => requestMenu("create", "Create", createItems)(event.currentTarget)}><Plus /></button>
      <Button className="discussion-sidebar-close" variant="ghost" size="icon" onClick={onClose} aria-label="Close navigation"><X /></Button>
    </header>

    <nav className="discussion-nav">
      <section className="discussion-group">
        <h2>Companions</h2>
        {companions.filter(item => !item.retiredAt).map(companion => {
          const direct = discussions.find(item => item.directCompanionId === companion.id && !item.archivedAt);
          return <CompanionRow
            key={companion.id}
            companion={companion}
            direct={direct}
            active={Boolean(direct && direct.id === selectedId)}
            menuOpen={menu?.id === `companion:${companion.id}`}
            onOpen={() => void openDirect(companion, direct)}
            onMenu={requestMenu(`companion:${companion.id}`, `Options for ${companion.name}`, [
              ...(onCompanionSettings ? [{ label: "Settings", accessibleName: `Settings for ${companion.name}`, onSelect: () => onCompanionSettings(companion.id) }] : []),
              { label: "Archive chat", danger: true, onSelect: () => { if (direct) void onArchive(direct.id); } },
            ])}
          />;
        })}
      </section>

      <section className="discussion-group">
        <h2>Discussions</h2>
        {ungrouped.sort(byRecency).map(item => <DiscussionRow
          key={item.id}
          discussion={item}
          companions={companions}
          folders={folders}
          active={selectedId === item.id}
          renaming={renaming === `discussion:${item.id}`}
          menuOpen={menu?.id === `discussion:${item.id}`}
          onOpen={onOpen}
          onArchive={onArchive}
          onRename={() => setRenaming(`discussion:${item.id}`)}
          onRenamed={() => setRenaming(null)}
          onMutate={mutate}
          onMenu={requestMenu}
        />)}
      </section>

      {grouped.map(({ folder, discussions: items }) => <FolderGroup
        key={folder.id}
        folder={folder}
        items={items}
        companions={companions}
        folders={folders}
        selectedId={selectedId}
        open={!collapsed.includes(folder.id)}
        onToggle={folderOpen => toggleFolder(folder.id, folderOpen)}
        renaming={renaming}
        menuId={menu?.id}
        onRename={setRenaming}
        onRenamed={() => setRenaming(null)}
        onOpen={onOpen}
        onArchive={onArchive}
        onCreate={() => void onCreate({ folderId: folder.id }).catch(onError)}
        onDefaults={() => setDefaultsFor(folder)}
        onMutate={mutate}
        onMenu={requestMenu}
      />)}

      {creatingFolder && <FolderCreator onCreated={() => { setCreatingFolder(false); void onListRefresh(); }} onCancel={() => setCreatingFolder(false)} onError={onError} />}

      <button className="archived-link" onClick={onShowArchived}><Archive />Archived discussions</button>
    </nav>

    <footer>
      <button onClick={onApplications}><Settings />Applications</button>
      <button onClick={onAccount} aria-label={`Account, ${user.email}`}><span>{(user.name || user.email).slice(0, 1).toUpperCase()}</span>{user.name || user.email}</button>
    </footer>

    {menu && <RowMenu request={menu} onClose={() => setMenu(null)} />}
    {defaultsFor && <FolderDefaultsDialog folder={defaultsFor} companions={companions} onClose={() => setDefaultsFor(null)} onSaved={() => { setDefaultsFor(null); void onListRefresh(); }} onError={onError} />}
  </aside>;
}

function byRecency(a: Discussion, b: Discussion) { return Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id); }

/** A right click opens the same menu as the row's own trigger, when it has one. */
function openFromRow(event: MouseEvent<HTMLElement>, open: (anchor: HTMLElement) => void) {
  const trigger = event.currentTarget.querySelector<HTMLElement>(".row-menu-trigger");
  if (!trigger) return;
  event.preventDefault();
  open(trigger);
}

function CompanionRow({ companion, direct, active, menuOpen, onOpen, onMenu }: {
  companion: Companion; direct?: Discussion; active: boolean; menuOpen: boolean;
  onOpen: () => void; onMenu: (anchor: HTMLElement) => void;
}) {
  const last = direct?.lastMessage ?? null;
  const preview = last ? stripPreview(last.preview) : companion.instructions;
  const menuLabel = `Options for ${companion.name}`;
  return <div className="discussion-row" data-menu-open={menuOpen || undefined} onContextMenu={event => openFromRow(event, onMenu)}>
    <button className={cn("discussion-link", active && "discussion-link--active")} aria-current={active ? "page" : undefined} onClick={onOpen}>
      <span className="discussion-row-mark">
        <CompanionAvatar name={companion.name} avatar={companion.avatar} sleeping={companion.status === "archived"} size={28}/>
        <i className={`companion-presence companion-presence--${companion.status}`} />
      </span>
      <span className="discussion-row-copy">
        <span className="discussion-row-title">{companion.name}</span>
        <span className="discussion-row-preview">{preview || "No messages yet"}</span>
      </span>
      {last && <time className="discussion-row-time" dateTime={last.createdAt} title={fullDateLabel(last.createdAt)}>{timeLabel(last.createdAt)}</time>}
    </button>
    <div className="discussion-row-actions">
      <RowMenuTrigger label={menuLabel} expanded={menuOpen} onOpen={onMenu} />
    </div>
  </div>;
}

function DiscussionRow({ discussion, companions, folders, active, renaming, menuOpen, onOpen, onArchive, onRename, onRenamed, onMutate, onMenu }: {
  discussion: Discussion; companions: Companion[]; folders: DiscussionFolder[]; active: boolean; renaming: boolean; menuOpen: boolean;
  onOpen: (id: string) => void; onArchive: (id: string) => Promise<void>; onRename: () => void; onRenamed: () => void;
  onMutate: (action: () => Promise<unknown>) => Promise<void>;
  onMenu: (id: string, label: string, items: RowMenuItem[]) => (anchor: HTMLElement) => void;
}) {
  const title = discussion.title || "Untitled discussion";
  const last = discussion.lastMessage ?? null;
  const author = last?.companionId ? companions.find(item => item.id === last.companionId)?.name : last?.role === "user" ? "You" : "Companion";
  const preview = last ? `${author}: ${stripPreview(last.preview)}` : "No messages yet";
  const requestMenu = onMenu(`discussion:${discussion.id}`, `Options for ${title}`, [
    { label: "Rename", onSelect: onRename },
    ...folders.filter(folder => folder.id !== discussion.folderId).map(folder => ({ label: `Move to ${folder.name}`, onSelect: () => void onMutate(() => discussionApi.update(discussion.id, { folderId: folder.id })) })),
    ...(discussion.folderId ? [{ label: "Remove from folder", onSelect: () => void onMutate(() => discussionApi.update(discussion.id, { folderId: null })) }] : []),
    { label: "Archive", danger: true, onSelect: () => void onArchive(discussion.id) },
  ]);
  if (renaming) return <RenameRow value={title} label="Discussion name" onCancel={onRenamed} onSave={async name => { await onMutate(() => discussionApi.update(discussion.id, { title: name })); onRenamed(); }} />;
  return <div className="discussion-row" data-menu-open={menuOpen || undefined} onContextMenu={event => openFromRow(event, requestMenu)}>
    <button className={cn("discussion-link", active && "discussion-link--active")} aria-current={active ? "page" : undefined} onClick={() => onOpen(discussion.id)}>
      <span className="discussion-row-mark"><DiscussionCompanions discussion={discussion} companions={companions}/></span>
      <span className="discussion-row-copy">
        <span className="discussion-row-title">{title}</span>
        <span className="discussion-row-preview">{preview}</span>
      </span>
      {last && <time className="discussion-row-time" dateTime={last.createdAt} title={fullDateLabel(last.createdAt)}>{timeLabel(last.createdAt)}</time>}
    </button>
    <div className="discussion-row-actions">
      <button className="discussion-archive" title="Archive discussion" aria-label={`Archive ${title}`} onClick={() => void onArchive(discussion.id)}><Archive /></button>
      <RowMenuTrigger label={`Options for ${title}`} expanded={menuOpen} onOpen={requestMenu} />
    </div>
  </div>;
}

export function DiscussionCompanions({ discussion, companions }: { discussion: Discussion; companions: Companion[] }) {
  const ids = discussion.participantIds ?? (discussion.directCompanionId ? [discussion.directCompanionId] : []);
  const participants = ids.map(id => companions.find(companion => companion.id === id && !companion.retiredAt)).filter((companion): companion is Companion => Boolean(companion));
  if (!participants.length) return null;
  const names = participants.map(companion => companion.name).join(", ");
  return <span className="discussion-row-companions" aria-label={`Companions: ${names}`} title={names}>{participants.slice(0, 3).map(companion => <CompanionAvatar key={companion.id} name={companion.name} avatar={companion.avatar} size={20}/>)}{participants.length > 3 && <small>+{participants.length - 3}</small>}</span>;
}

function FolderGroup({ folder, items, companions, folders, selectedId, open, onToggle, renaming, menuId, onRename, onRenamed, onOpen, onArchive, onCreate, onDefaults, onMutate, onMenu }: {
  folder: DiscussionFolder; items: Discussion[]; companions: Companion[]; folders: DiscussionFolder[]; selectedId: string | null;
  open: boolean; onToggle: (open: boolean) => void; renaming: string | null; menuId?: string;
  onRename: (key: string) => void; onRenamed: () => void;
  onOpen: (id: string) => void; onArchive: (id: string) => Promise<void>; onCreate: () => void; onDefaults: () => void;
  onMutate: (action: () => Promise<unknown>) => Promise<void>;
  onMenu: (id: string, label: string, items: RowMenuItem[]) => (anchor: HTMLElement) => void;
}) {
  const menuOpen = menuId === `folder:${folder.id}`;
  const defaults = companions.filter(item => folder.companionIds.includes(item.id));
  const requestMenu = onMenu(`folder:${folder.id}`, `Options for ${folder.name}`, [
    { label: "Rename", onSelect: () => onRename(`folder:${folder.id}`) },
    { label: "Default companions", onSelect: onDefaults },
    { label: `New in ${folder.name}`, onSelect: onCreate },
    { label: "Delete", danger: true, onSelect: () => void onMutate(() => discussionApi.deleteFolder(folder.id)) },
  ]);
  return <details className="discussion-folder" open={open} onToggle={event => onToggle(event.currentTarget.open)}>
    <summary onContextMenu={event => openFromRow(event, requestMenu)}>
      <ChevronRight />
      {renaming === `folder:${folder.id}`
        ? <RenameRow inline value={folder.name} label="Folder name" onCancel={onRenamed} onSave={async name => { await onMutate(() => discussionApi.updateFolder(folder.id, { name })); onRenamed(); }} />
        : <><span>{folder.name}</span><i className="folder-companions" aria-label={`${defaults.length} default companions`}>{defaults.slice(0, 3).map(companion => <CompanionAvatar key={companion.id} name={companion.name} avatar={companion.avatar} size={18}/>)}</i>
          <RowMenuTrigger label={`Edit ${folder.name}`} expanded={menuOpen} onOpen={requestMenu} /></>}
    </summary>
    <div className="discussion-group">
      {[...items].sort(byRecency).map(item => <DiscussionRow
        key={item.id}
        discussion={item}
        companions={companions}
        folders={folders}
        active={selectedId === item.id}
        renaming={renaming === `discussion:${item.id}`}
        menuOpen={menuId === `discussion:${item.id}`}
        onOpen={onOpen}
        onArchive={onArchive}
        onRename={() => onRename(`discussion:${item.id}`)}
        onRenamed={onRenamed}
        onMutate={onMutate}
        onMenu={onMenu}
      />)}
    </div>
  </details>;
}

function RenameRow({ value, label, onSave, onCancel, inline = false }: { value: string; label: string; onSave: (name: string) => Promise<void>; onCancel: () => void; inline?: boolean }) {
  const [name, setName] = useState(value);
  return <form
    className={cn("rename-row", inline && "rename-row--inline")}
    onSubmit={event => { event.preventDefault(); if (name.trim()) void onSave(name.trim()); }}
    onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onCancel(); } }}
    // Renaming a folder happens inside its summary; typing must not fold it.
    onClick={event => event.stopPropagation()}
  >
    <input aria-label={label} autoFocus value={name} onChange={event => setName(event.target.value)} onBlur={onCancel} />
  </form>;
}

function FolderCreator({ onCreated, onCancel, onError }: { onCreated: () => void; onCancel: () => void; onError: (cause: unknown) => void }) {
  const creationId = useRef(crypto.randomUUID());
  async function save(name: string) {
    try { await discussionApi.createFolder({ clientCreationId: creationId.current, name, companionIds: [] }); creationId.current = crypto.randomUUID(); onCreated(); }
    catch (cause) { onError(cause); }
  }
  return <RenameRow value="" label="New folder name" onSave={save} onCancel={onCancel} />;
}

function FolderDefaultsDialog({ folder, companions, onClose, onSaved, onError }: { folder: DiscussionFolder; companions: Companion[]; onClose: () => void; onSaved: () => void; onError: (cause: unknown) => void }) {
  const modalRef = useModalFocus(true, onClose);
  const [selected, setSelected] = useState(new Set(folder.companionIds));
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try { await discussionApi.updateFolder(folder.id, { companionIds: [...selected] }); onSaved(); }
    catch (cause) { onError(cause); setSaving(false); }
  }
  return <><button className="details-scrim" onClick={onClose} aria-label="Close default companions" />
    <section ref={modalRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={`Default companions for ${folder.name}`} className="folder-defaults">
      <h2>Default companions</h2>
      <p>Companions listed here may be delegated work in {folder.name} without a new invitation.</p>
      <form onSubmit={submit}>
        <fieldset>
          <legend>Companions</legend>
          {companions.filter(item => !item.retiredAt).map(companion => <label key={companion.id}>
            <input type="checkbox" checked={selected.has(companion.id)} onChange={() => setSelected(current => { const next = new Set(current); if (next.has(companion.id)) next.delete(companion.id); else next.add(companion.id); return next; })} />
            <CompanionAvatar name={companion.name} avatar={companion.avatar} size={24}/>{companion.name}
          </label>)}
        </fieldset>
        <div><Button size="sm" type="submit" disabled={saving}>Save</Button><Button size="sm" variant="ghost" type="button" onClick={onClose}>Cancel</Button></div>
      </form>
    </section></>;
}
