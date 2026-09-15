import { useRef, useState, type FormEvent, type RefObject } from "react";
import { Archive, ChevronRight, Folder, FolderPlus, MessageCircle, MoreHorizontal, Plus, Settings, Trash2, X } from "lucide-react";
import { discussionApi, type AccountUser, type Companion, type Discussion, type DiscussionFolder } from "@/api";
import { CompanionAvatar } from "../CompanionAvatar";
import { Button } from "../ui/button";
import { cn } from "@/lib/utils";

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
  onFolderCreated: (folder: DiscussionFolder) => void;
  onListRefresh: () => Promise<unknown>;
  onShowArchived: () => void;
  onCreateCompanion: () => void;
  onApplications: () => void;
  onAccount: () => void;
  onCompanionSettings?: (id: string) => void;
  onError: (cause: unknown, fallback?: string) => void;
};

export function Sidebar({ panelRef, open, user, companions, discussions, folders, selectedId, onClose, onOpen, onArchive, onCreate, onFolderCreated, onListRefresh, onShowArchived, onCreateCompanion, onApplications, onAccount, onCompanionSettings, onError }: SidebarProps) {
  const grouped = folders.map(folder => ({ folder, discussions: discussions.filter(item => item.folderId === folder.id) }));
  const ungrouped = discussions.filter(item => !item.folderId || !folders.some(folder => folder.id === item.folderId));
  async function openDirect(companion: Companion) {
    try {
      const result = await discussionApi.directForCompanion(companion.id);
      const existing = result.discussions.find(item => !item.archivedAt);
      if (existing) onOpen(existing.id); else await onCreate({ directCompanionId: companion.id, title: companion.name });
    } catch (cause) { onError(cause); }
  }
  return <aside ref={panelRef} tabIndex={-1} className={cn("discussion-sidebar", open && "discussion-sidebar--open")} aria-label="Discussions">
    <header><button className="discussion-wordmark" onClick={() => { const latest = discussions.find(item => !item.directCompanionId) ?? discussions[0]; if (latest && latest.id !== selectedId) onOpen(latest.id); onClose(); }} aria-label="Back to discussions"><img src="/favicon.svg" alt="" /></button><Button variant="ghost" size="icon" onClick={() => void onCreate().catch(onError)} aria-label="New discussion"><Plus /></Button><Button className="discussion-sidebar-close" variant="ghost" size="icon" onClick={onClose} aria-label="Close navigation"><X /></Button></header>
    <nav className="discussion-nav">
      <DiscussionGroup title="Discussions" companions={companions} items={ungrouped.filter(item => !item.directCompanionId)} selectedId={selectedId} onOpen={onOpen} onArchive={onArchive} />
      {ungrouped.some(item => item.directCompanionId) && <DiscussionGroup title="Direct chats" companions={companions} items={ungrouped.filter(item => item.directCompanionId)} selectedId={selectedId} onOpen={onOpen} onArchive={onArchive} />}
      {grouped.map(group => <FolderGroup key={group.folder.id} folder={group.folder} items={group.discussions} companions={companions} selectedId={selectedId} onOpen={onOpen} onArchive={onArchive} onCreate={() => void onCreate({ folderId: group.folder.id }).catch(onError)} onChanged={onListRefresh} onError={onError} />)}
      <FolderCreator companions={companions} onCreated={onFolderCreated} onError={onError} />
      <button className="archived-link" onClick={onShowArchived}><Archive />Archived discussions</button>
    </nav>
    <div className="companion-dock" aria-label="Direct companion chats">
      <span>Companions</span>
      <div>{companions.filter(item => !item.retiredAt).map(companion => <div className="dock-companion" key={companion.id}><button title={`Chat with ${companion.name}`} aria-label={`Chat with ${companion.name}`} onClick={() => void openDirect(companion)}><CompanionAvatar name={companion.name} avatar={companion.avatar} sleeping={companion.status === "archived"} size={38}/><i className={`companion-presence companion-presence--${companion.status}`} /></button><span className="dock-companion-name">{companion.name}</span>{onCompanionSettings && <Button variant="ghost" size="icon-sm" aria-label={`Settings for ${companion.name}`} onClick={() => onCompanionSettings(companion.id)}><Settings/></Button>}</div>)}<button className="dock-create" onClick={onCreateCompanion} aria-label="Create companion"><Plus />Create companion</button></div>
    </div>
    <footer><button onClick={onApplications}><Settings />Applications</button><button onClick={onAccount} aria-label={`Account, ${user.email}`}><span>{(user.name || user.email).slice(0, 1).toUpperCase()}</span>{user.name || user.email}</button></footer>
  </aside>;
}

function DiscussionGroup({ title, companions, items, selectedId, onOpen, onArchive }: { title: string; companions: Companion[]; items: Discussion[]; selectedId: string | null; onOpen: (id: string) => void; onArchive: (id: string) => Promise<void> }) {
  return <section className="discussion-group"><h2>{title}</h2>{[...items].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id)).map(item => <div className="discussion-row" key={item.id}><button className={cn("discussion-link", selectedId === item.id && "discussion-link--active")} aria-current={selectedId === item.id ? "page" : undefined} onClick={() => onOpen(item.id)}><MessageCircle /><span>{item.title || "Untitled discussion"}</span><DiscussionCompanions discussion={item} companions={companions}/></button><button className="discussion-archive" title="Archive discussion" aria-label={`Archive ${item.title || "Untitled discussion"}`} onClick={() => void onArchive(item.id)}><Archive /></button></div>)}</section>;
}

export function DiscussionCompanions({ discussion, companions }: { discussion: Discussion; companions: Companion[] }) {
  const ids = discussion.participantIds ?? (discussion.directCompanionId ? [discussion.directCompanionId] : []);
  const participants = ids.map(id => companions.find(companion => companion.id === id && !companion.retiredAt)).filter((companion): companion is Companion => Boolean(companion));
  if (!participants.length) return null;
  const names = participants.map(companion => companion.name).join(", ");
  return <span className="discussion-row-companions" aria-label={`Companions: ${names}`} title={names}>{participants.slice(0, 3).map(companion => <CompanionAvatar key={companion.id} name={companion.name} avatar={companion.avatar} size={20}/>)}{participants.length > 3 && <small>+{participants.length - 3}</small>}</span>;
}

function FolderGroup({ folder, items, companions, selectedId, onOpen, onArchive, onCreate, onChanged, onError }: { folder: DiscussionFolder; items: Discussion[]; companions: Companion[]; selectedId: string | null; onOpen: (id: string) => void; onArchive: (id: string) => Promise<void>; onCreate: () => void; onChanged: () => Promise<unknown>; onError: (cause: unknown) => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(folder.name);
  const [defaults, setDefaults] = useState(new Set(folder.companionIds));
  async function save() { try { await discussionApi.updateFolder(folder.id, { name: name.trim(), companionIds: [...defaults] }); setEditing(false); await onChanged(); } catch (cause) { onError(cause); } }
  async function remove() { try { await discussionApi.deleteFolder(folder.id); await onChanged(); } catch (cause) { onError(cause); } }
  const folderCompanions = companions.filter(item => folder.companionIds.includes(item.id));
  return <details className="discussion-folder" open><summary><ChevronRight /><Folder /><span>{folder.name}</span><i className="folder-companions" aria-label={`${folderCompanions.length} default companions`}>{folderCompanions.slice(0,3).map(companion=><CompanionAvatar key={companion.id} name={companion.name} avatar={companion.avatar} size={18}/>)}</i><button type="button" aria-label={`Edit ${folder.name}`} onClick={event => { event.preventDefault(); setEditing(value => !value); }}><MoreHorizontal /></button></summary>
    {editing && <div className="folder-editor"><label>Name<input value={name} onChange={event => setName(event.target.value)} /></label><fieldset><legend>Default companions</legend>{companions.filter(item => !item.retiredAt).map(companion => <label key={companion.id}><input type="checkbox" checked={defaults.has(companion.id)} onChange={() => setDefaults(current => { const next = new Set(current); if (next.has(companion.id)) next.delete(companion.id); else next.add(companion.id); return next; })}/><CompanionAvatar name={companion.name} avatar={companion.avatar} size={24}/>{companion.name}</label>)}</fieldset><div><Button size="sm" onClick={() => void save()} disabled={!name.trim()}>Save</Button><Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button><Button size="sm" variant="ghost" className="danger-text" onClick={() => void remove()}><Trash2 />Delete</Button></div></div>}
    <DiscussionGroup title="" companions={companions} items={items} selectedId={selectedId} onOpen={onOpen} onArchive={onArchive} />
    <button className="folder-new-discussion" onClick={onCreate}><Plus />New in {folder.name}</button>
  </details>;
}

function FolderCreator({ companions, onCreated, onError }: { companions: Companion[]; onCreated: (folder: DiscussionFolder) => void; onError: (cause: unknown) => void }) {
  const [open, setOpen] = useState(false); const [name, setName] = useState(""); const [ids, setIds] = useState(new Set<string>());
  const creationId = useRef(crypto.randomUUID());
  async function submit(event: FormEvent) { event.preventDefault(); try { const result = await discussionApi.createFolder({ clientCreationId: creationId.current, name: name.trim(), companionIds: [...ids] }); onCreated(result.folder); setName(""); setIds(new Set()); creationId.current = crypto.randomUUID(); setOpen(false); } catch (cause) { onError(cause); } }
  if (!open) return <button className="folder-create-button" onClick={() => setOpen(true)}><FolderPlus />New folder</button>;
  return <form className="folder-editor folder-creator" onSubmit={submit}><label>Folder name<input autoFocus value={name} onChange={event => setName(event.target.value)} /></label><fieldset><legend>Default companions</legend>{companions.filter(item => !item.retiredAt).map(companion => <label key={companion.id}><input type="checkbox" checked={ids.has(companion.id)} onChange={() => setIds(current => { const next = new Set(current); if (next.has(companion.id)) next.delete(companion.id); else next.add(companion.id); return next; })}/>{companion.name}</label>)}</fieldset><div><Button size="sm" type="submit" disabled={!name.trim()}>Create</Button><Button size="sm" variant="ghost" type="button" onClick={() => setOpen(false)}>Cancel</Button></div></form>;
}
