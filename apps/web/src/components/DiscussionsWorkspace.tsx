import {DesktopSheet,DeliverySettings} from './CompanionAccount';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from "react";
import {
  Archive,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Square,
  Activity,
  Computer,
  FileText,
  Folder,
  FolderPlus,
  LoaderCircle,
  Menu,
  MessageCircle,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Plus,
  Settings,
  Trash2,
  UserMinus,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { ApiError, api, discussionApi, type AccountUser, type Companion, type Discussion, type DiscussionFolder, type DiscussionSnapshot, type ThreadFile } from "@/api";
import { AvatarPicker, CompanionAvatar, DEFAULT_AVATAR } from "./CompanionAvatar";
import { MessageResponse } from "./ai-elements/message";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { ApplicationAccess } from "./ApplicationAccess";
import { cn } from "@/lib/utils";
import "./DiscussionsWorkspace.css";

const POLL_INTERVAL = 2_500;
const MAX_FILES = 5;
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const ACCEPTED_FILES = "image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain,text/csv,text/markdown,application/json,.md,.markdown,.txt,.csv,.json";

type Props = {
  user: AccountUser;
  companions: Companion[];
  initialDiscussionId: string | null;
  legacyCompanionId: string | null;
  onUnauthorized: () => void;
  onCreateCompanion: () => void;
  onApplications: () => void;
  onAccount: () => void;
};

type PendingAttachment = { file: File; id: string; position: number };
type StoredDraft = { attempted?:boolean; content: string; targetCompanionId: string | null; clientMessageId: string; files: Array<{ id: string; name: string; size: number; position?: number }> };

function draftKey(userId: string, discussionId: string) { return `companions.build:discussion-draft:${userId}:${discussionId}`; }
function targetKey(userId: string, discussionId: string) { return `companions.build:discussion-target:${userId}:${discussionId}`; }

function readDraft(userId: string, discussionId: string): StoredDraft | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(draftKey(userId, discussionId)) ?? "null") as StoredDraft | null;
    return value && typeof value.content === "string" && typeof value.clientMessageId === "string" && Array.isArray(value.files) ? value : null;
  } catch { return null; }
}

function dateLabel(value: string) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function statusLabel(value: string) { return value.replaceAll("_", " ").replace(/^./, letter => letter.toUpperCase()); }
function workStatus(value: string) {
  return ({ queued: "Task received", preparing: "Getting ready", running: "Working", needs_input: "Needs your answer", succeeded: "Completed", failed: "Failed", interrupted: "Interrupted", cancelled: "Stopped" } as Record<string, string>)[value] ?? statusLabel(value);
}
function orderedTasks(tasks: DiscussionSnapshot["tasks"]) {
  return [...tasks].sort((a, b) => (a.status === "needs_input" ? 0 : activeStatus(a.status) ? 1 : 2) - (b.status === "needs_input" ? 0 : activeStatus(b.status) ? 1 : 2) || Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id));
}
function activeStatus(value: string) { return ["queued", "preparing", "running", "needs_input"].includes(value); }
function compareSequence(left: string, right: string) { const a=String(left).replace(/^0+(?=\d)/,""),b=String(right).replace(/^0+(?=\d)/,""); return a.length-b.length||a.localeCompare(b); }
function mergeMessages(...groups: DiscussionSnapshot["messages"][]) { const byId=new Map(groups.flat().map(message=>[message.id,message])); return [...byId.values()].sort((a,b)=>compareSequence(a.sequence,b.sequence)||a.id.localeCompare(b.id)); }
function fileList(files: ThreadFile[]) {
  return files.length ? <div className="discussion-files">{files.map(file => <a className={file.mimeType.startsWith("image/") ? "discussion-file discussion-file--image" : "discussion-file"} href={file.url} key={file.id} target={file.mimeType.startsWith("image/") ? "_blank" : undefined} download={file.mimeType.startsWith("image/") ? undefined : file.name} rel="noreferrer">{file.mimeType.startsWith("image/") ? <img src={file.url} alt="" loading="lazy" /> : <FileText />}<span>{file.name}</span></a>)}</div> : null;
}

export function DiscussionsWorkspace({ user, companions, initialDiscussionId, legacyCompanionId, onUnauthorized, onCreateCompanion, onApplications, onAccount }: Props) {
  const [discussions, setDiscussions] = useState<Discussion[]>([]);
  const [folders, setFolders] = useState<DiscussionFolder[]>([]);
  const [selectedId, setSelectedId] = useState(initialDiscussionId);
  const [snapshot, setSnapshot] = useState<DiscussionSnapshot | null>(null);
  const [olderMessages, setOlderMessages] = useState<DiscussionSnapshot["messages"]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingDiscussion, setLoadingDiscussion] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const olderCursor = useRef<string | null | undefined>(undefined);
  const [error, setError] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [archived, setArchived] = useState<Discussion[]>([]);
  const creationIntents = useRef(new Map<string, string>());
  const currentId = useRef(selectedId);
  const snapshotRef = useRef(snapshot);
  currentId.current = selectedId;
  snapshotRef.current = snapshot;

  const handleError = useCallback((cause: unknown, fallback = "Something went wrong.") => {
    if (cause instanceof ApiError && cause.status === 401) onUnauthorized();
    else setError(cause instanceof Error ? cause.message : fallback);
  }, [onUnauthorized]);

  const loadList = useCallback(async () => {
    const result = await discussionApi.list();
    setDiscussions(result.discussions);
    setFolders(result.folders);
    return result;
  }, []);

  const openDiscussion = useCallback((id: string, replace = false) => {
    setSelectedId(id);
    setSnapshot(null);
    setOlderMessages([]);
    olderCursor.current = undefined;
    currentId.current = id;
    setSidebarOpen(false);
    const path = `/discussions/${id}`;
    window.history[replace ? "replaceState" : "pushState"]({}, "", path);
  }, []);

  const createDiscussion = useCallback(async (input: { title?: string; folderId?: string; directCompanionId?: string } = {}) => {
    const signature = JSON.stringify(input);
    const clientCreationId = creationIntents.current.get(signature) ?? crypto.randomUUID();
    creationIntents.current.set(signature, clientCreationId);
    const result = await discussionApi.create({ clientCreationId, ...input });
    creationIntents.current.delete(signature);
    setDiscussions(current => [result.discussion, ...current.filter(item => item.id !== result.discussion.id)]);
    openDiscussion(result.discussion.id);
    return result.discussion;
  }, [openDiscussion]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const list = await loadList();
        if (!active) return;
        if (legacyCompanionId) {
          const direct = await discussionApi.directForCompanion(legacyCompanionId);
          if (!active) return;
          const latest = direct.discussions.find(item => !item.archivedAt) ?? await createDiscussion({ directCompanionId: legacyCompanionId }).catch(() => null);
          if (latest) openDiscussion(latest.id, true);
        } else if (initialDiscussionId) {
          setSelectedId(initialDiscussionId);
        } else if (list.discussions.find(item => !item.directCompanionId)) {
          openDiscussion(list.discussions.find(item => !item.directCompanionId)!.id, true);
        } else {
          await createDiscussion({ title: "New discussion" });
        }
      } catch (cause) { if (active) handleError(cause, "Could not load discussions."); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, []);

  const refresh = useCallback(async (quiet = false) => {
    const id = currentId.current;
    if (!id) return;
    if (!quiet) setLoadingDiscussion(true);
    try {
      const result = await discussionApi.snapshot(id);
      if (currentId.current !== id) return;
      if (olderCursor.current !== undefined && snapshotRef.current?.discussion.id === id) setOlderMessages(current => mergeMessages(current, snapshotRef.current!.messages.filter(message => !result.messages.some(next => next.id === message.id))));
      setSnapshot({...result,beforeCursor:olderCursor.current===undefined?result.beforeCursor:olderCursor.current});
      setDiscussions(current => current.map(item => item.id === result.discussion.id ? { ...result.discussion, participantIds: result.participants.filter(participant => !participant.removedAt).map(participant => participant.companionId) } : item));
      setError("");
    } catch (cause) { if (currentId.current === id) handleError(cause, "Could not open this discussion."); }
    finally { if (currentId.current === id && !quiet) setLoadingDiscussion(false); }
  }, [handleError]);

  useEffect(() => { void refresh(); }, [selectedId, refresh]);
  useEffect(() => {
    if (!selectedId) return;
    const timer = window.setInterval(() => { void refresh(true); void loadList().catch(cause => handleError(cause)); }, POLL_INTERVAL);
    return () => window.clearInterval(timer);
  }, [selectedId, refresh, loadList, handleError]);
  useEffect(() => {
    const pop = () => { const id = window.location.pathname.match(/^\/discussions\/([^/]+)$/)?.[1] ?? null; setSelectedId(id); currentId.current=id; olderCursor.current=undefined; setSnapshot(null); setOlderMessages([]); };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);

  async function loadOlder() {
    if (!snapshot?.beforeCursor || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const id=snapshot.discussion.id;
      const page = await discussionApi.snapshot(id, snapshot.beforeCursor);
      if(currentId.current!==id)return;
      olderCursor.current=page.beforeCursor;
      setOlderMessages(current => mergeMessages(page.messages, current));
      setSnapshot(current => current ? { ...current, beforeCursor: page.beforeCursor } : current);
    } catch (cause) { handleError(cause, "Could not load older messages."); }
    finally { setLoadingOlder(false); }
  }

  async function showArchived() {
    setArchivedOpen(true);
    try { setArchived((await discussionApi.list(true)).discussions.filter(item => item.archivedAt)); }
    catch (cause) { handleError(cause); }
  }

  async function archiveDiscussion(id: string) {
    try {
      await discussionApi.update(id, { archived: true });
      setDiscussions(current => current.filter(item => item.id !== id));
      if (currentId.current === id) {
        setDetailOpen(false);
        const next = discussions.find(item => item.id !== id);
        if (next) openDiscussion(next.id, true); else await createDiscussion({ title: "New discussion" });
      }
    } catch (cause) { handleError(cause, "Could not archive this discussion."); }
  }
  async function archiveCurrent() { if (snapshot) await archiveDiscussion(snapshot.discussion.id); }

  const grouped = useMemo(() => folders.map(folder => ({ folder, discussions: discussions.filter(item => item.folderId === folder.id) })), [folders, discussions]);
  const ungrouped = discussions.filter(item => !item.folderId || !folders.some(folder => folder.id === item.folderId));

  if (loading) return <div className="discussion-loading" role="status"><div/><div/><main><span/><span/></main></div>;

  return <div className="discussion-shell">
    <a className="skip-link" href="#discussion-main">Skip to discussion</a>
    {sidebarOpen && <button className="discussion-scrim" aria-label="Close navigation" onClick={() => setSidebarOpen(false)} />}
    <aside className={cn("discussion-sidebar", sidebarOpen && "discussion-sidebar--open")} aria-label="Discussions">
      <header><button className="discussion-wordmark" onClick={() => void createDiscussion()} aria-label="New Companion discussion"><img src="/favicon.svg" alt="" /></button><Button variant="ghost" size="icon" onClick={() => void createDiscussion()} aria-label="New discussion"><Plus /></Button><Button className="discussion-sidebar-close" variant="ghost" size="icon" onClick={() => setSidebarOpen(false)} aria-label="Close navigation"><X /></Button></header>
      <nav className="discussion-nav">
        <DiscussionGroup title="Discussions" companions={companions} items={ungrouped.filter(item => !item.directCompanionId)} selectedId={selectedId} onOpen={openDiscussion} onArchive={archiveDiscussion} />
        {ungrouped.some(item => item.directCompanionId) && <DiscussionGroup title="Direct chats" companions={companions} items={ungrouped.filter(item => item.directCompanionId)} selectedId={selectedId} onOpen={openDiscussion} onArchive={archiveDiscussion} />}
        {grouped.map(group => <FolderGroup key={group.folder.id} folder={group.folder} items={group.discussions} companions={companions} selectedId={selectedId} onOpen={openDiscussion} onArchive={archiveDiscussion} onCreate={() => void createDiscussion({ folderId: group.folder.id })} onChanged={loadList} onError={handleError} />)}
        <FolderCreator companions={companions} onCreated={folder => setFolders(current => [...current, folder])} onError={handleError} />
        <button className="archived-link" onClick={() => void showArchived()}><Archive />Archived discussions</button>
      </nav>
      <div className="companion-dock" aria-label="Direct companion chats">
        <span>Companions</span>
        <div>{companions.filter(item => !item.retiredAt).map(companion => <button key={companion.id} title={`Chat with ${companion.name}`} aria-label={`Chat with ${companion.name}`} onClick={async () => {
          try {
            const result = await discussionApi.directForCompanion(companion.id);
            const existing = result.discussions.find(item => !item.archivedAt);
            if (existing) openDiscussion(existing.id); else await createDiscussion({ directCompanionId: companion.id, title: companion.name });
          } catch (cause) { handleError(cause); }
        }}><CompanionAvatar name={companion.name} avatar={companion.avatar} sleeping={companion.status === "archived"} size={38}/><i className={`companion-presence companion-presence--${companion.status}`} /></button>)}<button className="dock-create" onClick={onCreateCompanion} aria-label="Create companion"><Plus />Create companion</button></div>
      </div>
      <footer><button onClick={onApplications}><Settings />Applications</button><button onClick={onAccount} aria-label={`Account, ${user.email}`}><span>{(user.name || user.email).slice(0, 1).toUpperCase()}</span>{user.name || user.email}</button></footer>
    </aside>
    {error && <div className="discussion-error" role="alert"><CircleAlert />{error}<button onClick={() => setError("")} aria-label="Dismiss error"><X /></button></div>}
    <main className="discussion-main" id="discussion-main">
      {loadingDiscussion && !snapshot ? <div className="discussion-opening" role="status"><LoaderCircle className="spin" />Opening discussion…</div> : snapshot ? <DiscussionView
        key={snapshot.discussion.id}
        user={user}
        snapshot={snapshot}
        olderMessages={olderMessages}
        companions={companions}
        folders={folders}
        onMenu={() => setSidebarOpen(true)}
        onDetails={() => setDetailOpen(true)}
        onRefresh={() => refresh(true)}
        onListRefresh={loadList}
        onArchive={archiveCurrent}
        onLoadOlder={loadOlder}
        loadingOlder={loadingOlder}
        onError={handleError}
      /> : <div className="discussion-opening" role="status">Choose a discussion</div>}
    </main>
    {detailOpen && snapshot && <DiscussionDetails snapshot={snapshot} companions={companions} folders={folders} onClose={() => setDetailOpen(false)} onRefresh={() => refresh(true)} onListRefresh={loadList} onArchive={archiveCurrent} onError={handleError} />}
    {archivedOpen && <ArchivedPanel discussions={archived} onClose={() => setArchivedOpen(false)} onRestore={async discussion => { try { await discussionApi.update(discussion.id, { archived: false }); setArchived(current => current.filter(item => item.id !== discussion.id)); await loadList(); openDiscussion(discussion.id); setArchivedOpen(false); } catch (cause) { handleError(cause); } }} />}
  </div>;
}

function DiscussionGroup({ title, companions, items, selectedId, onOpen, onArchive }: { title: string; companions: Companion[]; items: Discussion[]; selectedId: string | null; onOpen: (id: string) => void; onArchive: (id: string) => Promise<void> }) {
  return <section className="discussion-group"><h2>{title}</h2>{[...items].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id)).map(item => <div className="discussion-row" key={item.id}><button className={cn("discussion-link", selectedId === item.id && "discussion-link--active")} aria-current={selectedId === item.id ? "page" : undefined} onClick={() => onOpen(item.id)}><MessageCircle /><span>{item.title || "Untitled discussion"}</span><DiscussionCompanions discussion={item} companions={companions}/></button><button className="discussion-archive" title="Archive discussion" aria-label={`Archive ${item.title || "Untitled discussion"}`} onClick={() => void onArchive(item.id)}><Archive /></button></div>)}</section>;
}

function DiscussionCompanions({ discussion, companions }: { discussion: Discussion; companions: Companion[] }) {
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
  const folderCompanions=companions.filter(item=>folder.companionIds.includes(item.id));
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

function DiscussionView({ user, snapshot, olderMessages, companions, folders, onMenu, onDetails, onRefresh, onListRefresh, onArchive, onLoadOlder, loadingOlder, onError }: { user: AccountUser; snapshot: DiscussionSnapshot; olderMessages: DiscussionSnapshot["messages"]; companions: Companion[]; folders: DiscussionFolder[]; onMenu: () => void; onDetails: () => void; onRefresh: () => Promise<void>; onListRefresh: () => Promise<unknown>; onArchive: () => Promise<void>; onLoadOlder: () => Promise<void>; loadingOlder: boolean; onError: (cause: unknown, fallback?: string) => void }) {
  const discussion = snapshot.discussion;
  const participants = snapshot.participants.filter(item => !item.removedAt);
  const companionMap = new Map([...companions,...snapshot.participants.map(p=>p.companion)].map(companion => [companion.id, companion]));
  const direct = discussion.directCompanionId ? companionMap.get(discussion.directCompanionId) : null;
  const [editingTitle, setEditingTitle] = useState(false);
  const [title, setTitle] = useState(discussion.title);
  const [tab, setTab] = useState<string>("conversation");
  const [starter, setStarter] = useState<string | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const previousScroll = useRef({ height: 0, olderCount: 0 });
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  useLayoutEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline || !timeline.clientHeight) return;
    if (followLatest.current) timeline.scrollTop = timeline.scrollHeight;
    else if (olderMessages.length !== previousScroll.current.olderCount) timeline.scrollTop += timeline.scrollHeight - previousScroll.current.height;
    previousScroll.current = { height: timeline.scrollHeight, olderCount: olderMessages.length };
  }, [snapshot, olderMessages, tab]);

  async function saveTitle() { if (!title.trim()) return; try { await discussionApi.update(discussion.id, { title: title.trim() }); setEditingTitle(false); await onListRefresh(); await onRefresh(); } catch (cause) { onError(cause); } }
  const allMessages = mergeMessages(olderMessages, snapshot.messages);
  const activeCentral = snapshot.centralRuns.find(run => activeStatus(run.status));
  const activeTasks = snapshot.tasks.filter(task => activeStatus(task.status));
  const latestUserTime = allMessages.reduce((latest, message) => message.role === "user" ? Math.max(latest, Date.parse(message.createdAt)) : latest, 0);
  const isEarlierActivity = (run: { status: string; finishedAt: string | null }) => !activeStatus(run.status) && run.finishedAt !== null && Date.parse(run.finishedAt) < latestUserTime;
  const centralFailures = snapshot.centralRuns.filter(run => ['failed', 'interrupted', 'cancelled'].includes(run.status));
  const visibleTasks = orderedTasks(snapshot.tasks).filter(task => !allMessages.some(message => message.runId === task.id && message.role === 'assistant' && message.delegated) && (activeStatus(task.status) || task.status !== 'succeeded' || !allMessages.some(message => message.runId === task.id && message.role === 'assistant')));
  const earlierCentral = centralFailures.filter(isEarlierActivity);
  const earlierTasks = visibleTasks.filter(isEarlierActivity);
  const earlierCount = earlierCentral.length + earlierTasks.length;
  const centralCard = (run: DiscussionSnapshot["centralRuns"][number]) => <section className="discussion-task" key={run.id}><strong>Companion · {statusLabel(run.status)}</strong>{run.previewText && <MessageResponse>{run.previewText}</MessageResponse>}{run.error && <p className="task-error" role="status">{run.error}</p>}</section>;
  const taskCard = (task: DiscussionSnapshot["tasks"][number]) => <TaskCard key={task.id} discussionId={discussion.id} task={task} companion={companionMap.get(task.companionId)} compact onOpen={() => setTab(task.companionId)} onRefresh={onRefresh} onError={onError} />;

  const participantIds=new Set(snapshot.participants.filter(item=>!item.removedAt).map(item=>item.companionId));
  const authorized=(folders.find(folder=>folder.id===discussion.folderId)?.companionIds??[]).map(id=>companionMap.get(id)).filter((companion):companion is Companion=>Boolean(companion&&!companion.retiredAt&&!participantIds.has(companion.id)));
  return <section className="discussion-view">
    <header className="discussion-header"><Button className="discussion-mobile-menu" variant="ghost" size="icon" onClick={onMenu} aria-label="Open navigation"><Menu /></Button><div className="discussion-title">
      {direct && <CompanionAvatar name={direct.name} avatar={direct.avatar} sleeping={direct.status === "archived"} size={34}/>}<div>{editingTitle ? <form onSubmit={event => { event.preventDefault(); void saveTitle(); }}><input aria-label="Discussion title" value={title} onChange={event => setTitle(event.target.value)} autoFocus /><Button size="sm" type="submit">Save</Button></form> : <button onClick={() => setEditingTitle(true)} aria-label="Rename discussion"><h1>{discussion.title || "Untitled discussion"}</h1><Pencil /></button>}<span>{direct ? `Direct with ${direct.name}` : participants.length ? `${participants.length} companion${participants.length === 1 ? "" : "s"} invited` : "Companion discussion"}</span></div>
    </div><nav aria-label="Discussion views"><button className="activity-toggle" aria-current={tab !== "conversation" ? "page" : undefined} onClick={() => setTab(tab === "conversation" ? "work" : "conversation")}><Activity /><span>Activity</span>{activeTasks.length > 0 && <i>{activeTasks.length}</i>}</button></nav><Button variant="ghost" size="icon" onClick={onDetails} aria-label="Discussion details"><MoreHorizontal /></Button></header>
    <div className={cn("discussion-stage", "discussion-stage--workspace", tab!=="conversation"&&"discussion-stage--activity-open")}><div className="discussion-timeline" ref={timelineRef} onScroll={event => {
      const node = event.currentTarget;
      followLatest.current = node.scrollHeight - node.scrollTop - node.clientHeight < 64;
      setAwayFromLatest(!followLatest.current);
    }} role="log" aria-label="Discussion messages" aria-live="polite">
      {snapshot.beforeCursor && <Button className="load-older" variant="outline" size="sm" disabled={loadingOlder} onClick={() => void onLoadOlder()}>{loadingOlder ? <LoaderCircle className="spin" /> : <ArrowUp />}Load earlier messages</Button>}
      {!allMessages.length && !snapshot.proposals.length && !activeCentral && !activeTasks.length && <div className="discussion-empty"><div className="central-mark">c.</div><h2>{direct ? `Start a conversation with ${direct.name}` : "What are we working on?"}</h2><p>{direct ? `This is a private, direct history with ${direct.name}.` : "Describe the outcome you want. Companion can bring in the right companions as the work develops."}</p>{!direct&&<div className="discussion-starters">{["Plan a new project","Research a decision","Turn an idea into a draft"].map(value=><button key={value} onClick={()=>setStarter(value)}>{value}</button>)}</div>}</div>}
      {allMessages.map(message => {
        const delegatedTask = message.role === "assistant" && message.delegated ? snapshot.tasks.find(task => task.id === message.runId) : undefined;
        if (delegatedTask) {
          const lastReply = allMessages.filter(item => item.runId === message.runId && item.role === "assistant" && item.delegated).at(-1);
          return lastReply?.id === message.id ? taskCard(delegatedTask) : null;
        }
        const author = message.role === "user" ? null : message.companionId ? companionMap.get(message.companionId) : null; return <article className={cn("discussion-message", message.role === "user" && "discussion-message--user")} key={message.id} data-sequence={message.sequence}><div className="discussion-message-avatar">{message.role === "user" ? <span>{(user.name || user.email).slice(0, 1).toUpperCase()}</span> : author ? <CompanionAvatar name={author.name} avatar={author.avatar} size={32}/> : <span className="central-mark central-mark--small">c.</span>}</div><div><header><strong>{message.role === "user" ? "You" : author?.name ?? "Companion"}</strong>{message.role === "user" && <span className="message-recipient">to @{message.companionId ? companionMap.get(message.companionId)?.name ?? "companion" : "Companion"}</span>}<time dateTime={message.createdAt}>{dateLabel(message.createdAt)}</time>{!message.complete && <em>In progress</em>}</header><>{message.role === "assistant" && message.delegated ? <details className="discussion-delegated-history"><summary>Earlier delegated response</summary><MessageResponse>{message.content}</MessageResponse>{fileList(message.files)}</details> : <><MessageResponse>{message.content}</MessageResponse>{fileList(message.files)}</>}</></div></article>; })}
      {snapshot.proposals.filter(proposal => proposal.status === "pending").map(proposal => { const companion = companionMap.get(proposal.companionId); return <section className="invitation-proposal" key={proposal.id}><UserPlus /><div><strong>Invite {companion?.name ?? "this companion"}?</strong><p>{proposal.reason}</p>{proposal.prompt && <blockquote>{proposal.prompt}</blockquote>}<div><Button size="sm" onClick={async () => { try { await discussionApi.answerProposal(discussion.id, proposal.id, true); await onRefresh(); } catch (cause) { onError(cause); } }}><Check />Accept</Button><Button size="sm" variant="outline" onClick={async () => { try { await discussionApi.answerProposal(discussion.id, proposal.id, false); await onRefresh(); } catch (cause) { onError(cause); } }}>Decline</Button></div></div></section>; })}
      {activeCentral && <div className="discussion-working"><div className="central-working-label" role="status"><span className="work-status" data-status={activeCentral.status}><Activity />Companion · {workStatus(activeCentral.status)}</span></div><StopControl key={activeCentral.id} label="Stop chat" onStop={() => discussionApi.cancel(discussion.id)} onRefresh={onRefresh} onError={onError}/>{activeCentral.previewText && <details><summary>View current activity</summary><MessageResponse>{activeCentral.previewText}</MessageResponse></details>}</div>}
      {earlierCount > 0 && <details className="discussion-earlier-activity"><summary>Earlier activity ({earlierCount})</summary>{earlierCentral.map(centralCard)}{earlierTasks.map(taskCard)}</details>}
      {centralFailures.filter(run => !isEarlierActivity(run)).map(centralCard)}
      {visibleTasks.filter(task => !isEarlierActivity(task)).map(taskCard)}
    </div><aside className="discussion-workbench" aria-label={tab==="conversation"||tab==="work"?"Discussion activity":`${companionMap.get(tab)?.name??"Companion"} workbench`}>
      {tab!=="conversation"&&tab!=="work" ? <><button className="workbench-close" onClick={()=>setTab("conversation")} aria-label="Close workbench"><X /></button><CompanionWorkbench key={tab} snapshot={snapshot} companionId={tab} onRefresh={onRefresh} onError={onError}/></> : <ActivityPanel snapshot={snapshot} onOpen={setTab} onDetails={onDetails} authorized={authorized} onRefresh={onRefresh} onError={onError}/>}
    </aside>
    {awayFromLatest && <button className="discussion-jump-latest" onClick={() => { const node = timelineRef.current; if (node) node.scrollTop = node.scrollHeight; followLatest.current = true; setAwayFromLatest(false); }}><ArrowDown />Latest messages</button>}
    {!discussion.archivedAt ? <DiscussionComposer userId={user.id} snapshot={snapshot} companions={companions} initialDraft={starter} onInitialDraftApplied={()=>setStarter(null)} onRefresh={onRefresh} onError={onError}/> : <p className="discussion-archived-note">This discussion is archived. Restore it to send a message.</p>}</div>
    <nav className="discussion-mobile-nav" aria-label="Mobile workspace"><button aria-label="Show discussion" aria-current={tab==="conversation"?"page":undefined} onClick={()=>setTab("conversation")}><MessageCircle/>Thread</button><button aria-label="Show activity" aria-current={tab!=="conversation"?"page":undefined} onClick={()=>setTab("work")}><Activity/>Activity{activeTasks.length > 0 && <span className="mobile-activity-count">{activeTasks.length}</span>}</button><details className="mobile-participant-picker" onKeyDown={event => { if (event.key === "Escape") { event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); } }}>
      <summary aria-label="Choose discussion companion"><Users/>Companions</summary>
      <div className="mobile-participant-options" role="group" aria-label="Discussion workspaces">
        <strong>In this discussion</strong>
        {snapshot.participants.map(participant => <button key={participant.companionId} aria-label={`View ${participant.companion.name} workspace`} aria-current={tab === participant.companionId ? "page" : undefined} onClick={event => { setTab(participant.companionId); event.currentTarget.closest("details")?.removeAttribute("open"); }}><CompanionAvatar name={participant.companion.name} avatar={participant.companion.avatar} size={28}/><span>{participant.companion.name}{participant.removedAt && <small>Previous participant</small>}</span></button>)}
        {snapshot.tasks.length > 0 && <button onClick={event => { setTab("work"); event.currentTarget.closest("details")?.removeAttribute("open"); }}><FileText/>All work in this discussion</button>}
        <button onClick={event => { event.currentTarget.closest("details")?.removeAttribute("open"); onDetails(); }}><UserPlus/>Manage participants</button>
      </div>
    </details></nav>
  </section>;
}

function StopControl({ label, onStop, onRefresh, onError }: {
  label: string; onStop: () => Promise<unknown>; onRefresh: () => Promise<void>; onError: (cause: unknown) => void;
}) {
  const [state, setState] = useState<"idle" | "sending" | "requested">("idle");
  async function stop() {
    if (state !== "idle") return;
    setState("sending");
    try { await onStop(); setState("requested"); }
    catch (cause) { setState("idle"); onError(cause); return; }
    try { await onRefresh(); } catch (cause) { onError(cause); }
  }
  return <div className="stop-control">
    {state !== "idle" && <span role="status">{state === "sending" ? "Requesting stop…" : "Stop requested"}</span>}
    <button type="button" className="quiet-stop" disabled={state !== "idle"} aria-label={label} title={label} onClick={() => void stop()}><Square aria-hidden="true" /></button>
  </div>;
}

function ActivityPanel({ snapshot, onOpen, onDetails, authorized, onRefresh, onError }: {
  snapshot: DiscussionSnapshot; onOpen: (id: string) => void; onDetails: () => void; authorized: Companion[];
  onRefresh: () => Promise<void>; onError: (cause: unknown) => void;
}) {
  const tasks = orderedTasks(snapshot.tasks);
  const working = tasks.filter(task => activeStatus(task.status));
  const participants = [...snapshot.participants].sort((a, b) => {
    const aTask = tasks.find(task => task.companionId === a.companionId);
    const bTask = tasks.find(task => task.companionId === b.companionId);
    return Number(Boolean(bTask && activeStatus(bTask.status))) - Number(Boolean(aTask && activeStatus(aTask.status)));
  });
  return <div className="discussion-activity">
    <header><div><h2>Activity</h2><p role="status">{working.length ? `${working.length} task${working.length === 1 ? "" : "s"} in progress` : "Work in this discussion"}</p></div><button className="activity-manage" onClick={onDetails} aria-label="Manage participants" title="Manage participants"><UserPlus /></button></header>
    <div className="activity-agents">
      {participants.map(participant => {
        const { companion } = participant;
        const ownTasks = tasks.filter(task => task.companionId === companion.id);
        const task = ownTasks[0];
        const count = ownTasks.filter(item => activeStatus(item.status)).length;
        const question = ownTasks.flatMap(item => activeStatus(item.status) ? item.questions.filter(question => question.answer === null) : [])[0];
        return <button className="activity-agent" key={companion.id} aria-label={companion.name} onClick={() => onOpen(companion.id)}>
          <CompanionAvatar name={companion.name} avatar={companion.avatar} size={32}/>
          <span className="activity-agent-content"><span className="activity-agent-heading"><strong>{companion.name}</strong><ChevronRight /></span>
            <span className="work-status" data-status={question ? "needs_input" : task?.status ?? "idle"}>{question ? "Needs your answer" : task ? workStatus(task.status) : participant.removedAt ? "Previous participant" : "No task assigned"}{count > 1 ? ` · ${count} tasks` : ""}</span>
            {task && <span className="activity-task-title">{task.content}</span>}
            {(question || task?.previewText || task?.resultText || task?.error) && <span className="activity-task-preview">{question?.question ?? task?.error ?? (task && activeStatus(task.status) ? task.previewText : task?.resultText)}</span>}
            {task?.status === "succeeded" && <span className="activity-result-link">View result{task.files.length ? ` · ${task.files.length} file${task.files.length === 1 ? "" : "s"}` : ""}</span>}
          </span>
        </button>;
      })}
    </div>
    {!participants.length && <div className="activity-empty"><Users /><h3>Bring in a companion</h3><p>Type @ in your message to choose who helps. Their tasks and results will appear here.</p></div>}
    {authorized.length > 0 && <section className="activity-available"><h3>Available in this folder</h3>{authorized.map(companion => <button key={companion.id} aria-label={`Invite ${companion.name}`} onClick={async () => { try { await discussionApi.addParticipant(snapshot.discussion.id, companion.id); await onRefresh(); } catch (cause) { onError(cause); } }}><CompanionAvatar name={companion.name} avatar={companion.avatar} size={26}/><span>{companion.name}</span><Plus /></button>)}</section>}
    {participants.length > 0 && <p className="activity-footnote">Open a companion to see tasks, replies and files.</p>}
  </div>;
}

function TaskCard({ discussionId, task, companion, compact = false, onOpen, onRefresh, onError }: {
  discussionId: string; task: DiscussionSnapshot["tasks"][number]; companion?: Companion; compact?: boolean;
  onOpen?: () => void; onRefresh: () => Promise<void>; onError: (cause: unknown) => void;
}) {
  const active = activeStatus(task.status);
  return <section className={cn("discussion-task", compact && "discussion-task--receipt")} aria-label={`${companion?.name ?? "Companion"} task`}>
    <header>{companion ? <CompanionAvatar name={companion.name} avatar={companion.avatar} size={28}/> : <span className="central-mark central-mark--small">c.</span>}
      <div><strong>{companion?.name ?? "Companion"}</strong><span className="work-status" data-status={task.status}>{workStatus(task.status)}</span></div>
      {active && <StopControl label={`Stop ${companion?.name ?? "companion"}`} onStop={() => discussionApi.cancelCompanion(discussionId, task.companionId)} onRefresh={onRefresh} onError={onError}/>}
      {compact && <button className="task-open" aria-label={`View ${companion?.name ?? "companion"} task`} title="View task" onClick={onOpen}><ChevronRight /></button>}
    </header>
    <p className="task-prompt">{task.content}</p>
    {!compact && task.previewText && active && <details className="task-detail" open><summary>Latest update</summary><MessageResponse>{task.previewText}</MessageResponse></details>}
    {!compact && task.resultText && <details className="task-detail" open><summary>Result</summary><MessageResponse>{task.resultText}</MessageResponse>{fileList(task.files)}</details>}
    {task.error && <p className="task-error">{task.error}</p>}
    {!compact && !task.resultText && fileList(task.files)}
    {task.questions.filter(question => active && question.answer === null).map(question => <QuestionCard key={question.id} discussionId={discussionId} question={question} onRefresh={onRefresh} onError={onError} />)}
  </section>;
}

function QuestionCard({ discussionId, question, onRefresh, onError }: { discussionId: string; question: DiscussionSnapshot["tasks"][number]["questions"][number]; onRefresh: () => Promise<void>; onError: (cause: unknown) => void }) {
  const [answer, setAnswer] = useState("");
  async function submit(value: string) { if (!value.trim()) return; try { await discussionApi.answerQuestion(discussionId, question.id, value.trim()); await onRefresh(); } catch (cause) { onError(cause); } }
  return <form className="discussion-question" onSubmit={event => { event.preventDefault(); void submit(answer); }}><strong>{question.question}</strong>{question.options.length > 0 && <div>{question.options.map(option => <Button type="button" variant="outline" size="sm" key={option} onClick={() => void submit(option)}>{option}</Button>)}</div>}<label><span>Your answer</span><input value={answer} onChange={event => setAnswer(event.target.value)} /><Button size="sm" type="submit" disabled={!answer.trim()}>Answer</Button></label></form>;
}

function DiscussionComposer({ userId, snapshot, companions, initialDraft, onInitialDraftApplied, onRefresh, onError }: { userId: string; snapshot: DiscussionSnapshot; companions: Companion[]; initialDraft:string|null; onInitialDraftApplied:()=>void; onRefresh: () => Promise<void>; onError: (cause: unknown, fallback?: string) => void }) {
  const id = snapshot.discussion.id;
  const restored = useRef(readDraft(userId, id));
  const [draft, setDraft] = useState(restored.current?.content ?? "");
  const directId = snapshot.discussion.directCompanionId;
  const available = companions.filter(companion => !companion.retiredAt && companion.id !== directId);
  const mentionTargets: Array<{id: string | null; name: string; instructions: string; avatar?: Companion["avatar"]}> = directId ? [] : [{id:null,name:"Companion",instructions:"Your discussion agent"}, ...available];
  const savedTarget = (() => { try { return localStorage.getItem(targetKey(userId, id)); } catch { return null; } })();
  const [target, setTarget] = useState<string | null>(directId ?? (restored.current ? restored.current.targetCompanionId : available.some(companion => companion.id === savedTarget) ? savedTarget : null));
  const [files, setFiles] = useState<PendingAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const [attempted,setAttempted]=useState(restored.current?.attempted??false);
  const [fileError, setFileError] = useState(restored.current?.files.length ? "Reattach the saved draft’s files before retrying." : "");
  const clientMessageId = useRef(restored.current?.clientMessageId ?? crypto.randomUUID());
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [mentionIndex,setMentionIndex]=useState(0);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const persist = useCallback((content = draft, nextTarget = target, nextFiles = files) => {
    try {
      if (!content && nextFiles.length === 0) sessionStorage.removeItem(draftKey(userId, id));
      else sessionStorage.setItem(draftKey(userId, id), JSON.stringify({ attempted, content, targetCompanionId: nextTarget, clientMessageId: clientMessageId.current, files: [...(restored.current?.files??[]).filter(saved=>!nextFiles.some(f=>f.id===saved.id)),...nextFiles.map(item => ({ id: item.id, name: item.file.name, size: item.file.size, position:item.position }))].sort((a,b)=>(a.position??0)-(b.position??0)) } satisfies StoredDraft));
    } catch { /* in-memory state remains usable */ }
  }, [draft, target, files, userId, id, attempted]);
  useEffect(() => { persist(); }, [draft, target, files, persist]);
  useEffect(()=>{if(initialDraft&&!attempted){setDraft(initialDraft);onInitialDraftApplied();requestAnimationFrame(()=>textarea.current?.focus());}},[initialDraft,attempted,onInitialDraftApplied]);

  function chooseTarget(next: string | null) { if(attempted)return;setTarget(next); try { if (next) localStorage.setItem(targetKey(userId, id), next); else localStorage.removeItem(targetKey(userId, id)); } catch { /* optional preference */ } }
  function addFiles(next: File[]) {
    setFileError("");
    setFiles(current => {
      const accepted: PendingAttachment[] = [],used=new Set(current.map(item=>item.id));
      const saved=(restored.current?.files??[]).map((item,index)=>({...item,position:item.position??index})).sort((a,b)=>a.position-b.position);
      for (const file of next) {
        const match=saved.find(item=>item.name===file.name&&item.size===file.size&&!used.has(item.id));
        if(attempted&&!match){setFileError("Retry this message with the same files, or start another message.");continue;}
        if (current.length + accepted.length >= MAX_FILES) { setFileError(`You can attach up to ${MAX_FILES} files.`); break; }
        if (file.size > MAX_FILE_SIZE) { setFileError(`${file.name} is larger than 10 MiB.`); continue; }
        const id=match?.id??crypto.randomUUID(),position=match?.position??Math.max(-1,...current.map(item=>item.position),...accepted.map(item=>item.position))+1;
        used.add(id);accepted.push({file,id,position});
      }
      return [...current,...accepted].sort((a,b)=>a.position-b.position);
    });
  }
  function mention(companion: (typeof mentionTargets)[number]) {
    if(attempted)return;
    setDraft(current => current.replace(/(^|\s)@[^\s@]*$/, "$1"));
    chooseTarget(companion.id);
    setMentionIndex(0);
    requestAnimationFrame(() => textarea.current?.focus());
  }
  function updateDraft(content: string) {
    setDraft(content);
    const normalized = content.toLocaleLowerCase();
    const mentioned = mentionTargets.map(companion => {
      const token = '@' + companion.name.toLocaleLowerCase(), index = normalized.lastIndexOf(token);
      const matched = index >= 0 && (index === 0 || /\s/.test(normalized[index - 1])) && (index + token.length === normalized.length || /[\s.,!?;:]/.test(normalized[index + token.length]));
      return {companion,index:matched?index:-1};
    }).filter(match=>match.index>=0).sort((a,b)=>b.index-a.index||b.companion.name.length-a.companion.name.length)[0];
    if (mentioned && content.slice(0, mentioned.index + mentioned.companion.name.length + 1) !== draft.slice(0, mentioned.index + mentioned.companion.name.length + 1)) chooseTarget(mentioned.companion.id);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if ((!draft.trim() && !files.length) || sending) return;
    if(restored.current?.files.some(saved=>!files.some(f=>f.id===saved.id))){setFileError("Reattach all saved files before retrying.");return;}
    setSending(true); setAttempted(true); setFileError(""); persist();
    try {
      await discussionApi.sendMessage(id, { clientMessageId: clientMessageId.current, content: draft.trim(), targetCompanionId: directId ? undefined : target, files: [...files].sort((a,b)=>a.position-b.position) });
      setAttempted(false); setDraft(""); setFiles([]); clientMessageId.current = crypto.randomUUID(); restored.current = null;
      try { sessionStorage.removeItem(draftKey(userId, id)); } catch { /* no-op */ }
      await onRefresh();
    } catch (cause) { onError(cause, "Could not send. Your draft is saved; retry sends the same request."); }
    finally { setSending(false); }
  }
  const targetCompanion = companions.find(companion => companion.id === target);
  const mentionMatch=!attempted&&!directId&&!mentionDismissed?draft.match(/(?:^|\s)@([^\s@]*)$/):null;
  const mentionOptions=mentionMatch?mentionTargets.filter(companion=>companion.name.toLocaleLowerCase().startsWith(mentionMatch[1].toLocaleLowerCase())):[];
  return <form className="discussion-composer" onSubmit={submit} onDrop={(event: DragEvent) => { event.preventDefault(); addFiles(Array.from(event.dataTransfer.files)); }} onDragOver={event => event.preventDefault()}>
    {files.length > 0 && <div className="composer-files">{files.map(item => <span key={item.id}><FileText />{item.file.name}<button type="button" disabled={attempted} aria-label={`Remove ${item.file.name}`} onClick={() => setFiles(current => current.filter(file => file.id !== item.id))}><X /></button></span>)}</div>}
    {attempted&&!sending&&<p className="composer-file-error">Retry sends the same message. <button type="button" onClick={()=>{setAttempted(false);setDraft('');setFiles([]);setFileError('');restored.current=null;clientMessageId.current=crypto.randomUUID();}}>Start another message</button></p>}
    {fileError && <p className="composer-file-error" role="alert">{fileError}</p>}
    <div className="composer-recipient"><span>To</span><div className="recipient-control">{targetCompanion ? <CompanionAvatar name={targetCompanion.name} avatar={targetCompanion.avatar} size={22}/> : <span className="central-mark central-mark--pill" aria-hidden="true">c</span>}{directId ? <strong>@{targetCompanion?.name ?? "companion"}</strong> : <select disabled={attempted} aria-label="Message recipient" value={target ?? ""} onChange={event => chooseTarget(event.target.value || null)}><option value="">@Companion</option>{available.map(companion => <option value={companion.id} key={companion.id}>@{companion.name}</option>)}</select>}</div><span className="recipient-hint">{directId ? "Direct conversation" : targetCompanion && !snapshot.participants.some(participant => participant.companionId === target && !participant.removedAt) ? "Joins when you send" : "Replies in this thread"}</span></div>
    {mentionOptions.length>0&&<div id={`${id}-mention-list`} className="mention-autocomplete" role="listbox" aria-label="Companion suggestions">{mentionOptions.map((companion,index)=><button id={`${id}-mention-${companion.id??"coordinator"}`} type="button" role="option" aria-selected={index===mentionIndex} key={companion.id??"coordinator"} onMouseDown={event=>event.preventDefault()} onClick={()=>mention(companion)}><>{companion.id ? <CompanionAvatar name={companion.name} avatar={companion.avatar} size={30}/> : <span className="central-mark central-mark--small">c.</span>}</><span><strong>{companion.name}</strong><small>{companion.id === null ? "Your discussion agent" : snapshot.participants.some(participant => participant.companionId === companion.id && !participant.removedAt) ? "In this discussion" : "Invite and message"}</small></span>{index===mentionIndex&&<kbd>Enter</kbd>}</button>)}</div>}
    <Textarea aria-autocomplete={directId ? undefined : "list"} aria-controls={mentionOptions.length ? `${id}-mention-list` : undefined} aria-activedescendant={mentionOptions.length ? `${id}-mention-${(mentionOptions[mentionIndex] ?? mentionOptions[0]).id??"coordinator"}` : undefined} readOnly={attempted} ref={textarea} value={draft} onChange={event => {updateDraft(event.target.value);setMentionIndex(0);setMentionDismissed(false);}} onPaste={event => addFiles(Array.from(event.clipboardData.items).filter(item => item.kind === "file").map(item => item.getAsFile()).filter((file): file is File => Boolean(file)))} onKeyDown={event => { if(event.nativeEvent.isComposing)return; if(mentionOptions.length&&(event.key==="ArrowDown"||event.key==="ArrowUp")){event.preventDefault();setMentionIndex(current=>(current+(event.key==="ArrowDown"?1:-1)+mentionOptions.length)%mentionOptions.length);return;} if(mentionOptions.length&&(event.key==="Enter"||event.key==="Tab")&&!event.shiftKey){event.preventDefault();mention(mentionOptions[mentionIndex]??mentionOptions[0]);return;} if(event.key==="Escape"&&mentionOptions.length){event.preventDefault();setMentionDismissed(true);return;} if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} aria-label={directId ? `Message ${targetCompanion?.name ?? "companion"}` : targetCompanion ? `Message ${targetCompanion.name}` : "Message Companion"} placeholder={targetCompanion ? `Message ${targetCompanion.name}…` : "Ask Companion… Type @ to choose an agent"} rows={2}/>
    <footer><span>Enter to send · @ to choose an agent</span><label aria-label="Attach files"><Paperclip /><input type="file" multiple accept={ACCEPTED_FILES} onChange={event => { addFiles(Array.from(event.target.files ?? [])); event.currentTarget.value = ""; }}/></label><Button className="composer-send" type="submit" size="icon" disabled={(!draft.trim() && !files.length) || sending} aria-label="Send message">{sending ? <LoaderCircle className="spin" /> : <ArrowUp />}</Button></footer>
  </form>;
}

function CompanionWorkbench({ snapshot, companionId, onRefresh, onError }: {
  snapshot: DiscussionSnapshot; companionId: string;
  onRefresh: () => Promise<void>; onError: (cause: unknown) => void;
}) {
  const [view, setView] = useState<"results" | "files" | "machine" | "settings">("results");
  const participant = snapshot.participants.find(item => item.companionId === companionId);
  if (!participant) return <div className="work-empty"><p>This companion's invitation is being recorded.</p></div>;
  const companion = participant.companion;
  const tasks = orderedTasks(snapshot.tasks.filter(task => task.companionId === companionId));
  const files = [...new Map(tasks.flatMap(task => task.files).map(file => [file.id, file])).values()];
  const direct = snapshot.discussion.directCompanionId === companionId;
  return <div className="work-panel companion-workbench">
    <header className="companion-workbench-header">
      <CompanionAvatar name={companion.name} avatar={companion.avatar} size={42}/>
      <div><h2>{companion.name}</h2><p>{participant.removedAt ? "Removed from this discussion · previous work remains available" : companion.instructions}</p></div>
    </header>
    <nav className="workbench-tabs" aria-label="Companion workspace views">
      <button aria-current={view === "results" ? "page" : undefined} onClick={() => setView("results")}>Activity</button>
      <button aria-current={view === "files" ? "page" : undefined} onClick={() => setView("files")}>Files{files.length > 0 && <span>{files.length}</span>}</button>
      {companion.provider === "box" && <button aria-current={view === "machine" ? "page" : undefined} onClick={() => setView("machine")}>Machine</button>}
      {direct && <button aria-current={view === "settings" ? "page" : undefined} onClick={() => setView("settings")}>Configuration</button>}
    </nav>
    {view === "results" && (tasks.length ? tasks.map(task => <TaskCard key={task.id} discussionId={snapshot.discussion.id} task={task} companion={companion} onRefresh={onRefresh} onError={onError}/>) : <div className="workbench-empty"><MessageCircle/><h3>Ready for your next idea</h3><p>Work from {companion.name} in this discussion will appear here.</p></div>)}
    {view === "files" && (files.length ? fileList(files) : <div className="workbench-empty"><FileText/><h3>No files yet</h3><p>Files shared by {companion.name} in this discussion will appear here.</p></div>)}
    {view === "machine" && companion.provider === "box" && <DesktopSheet companion={companion} embedded onClose={() => setView("results")} onRefresh={onRefresh}/>}
    {view === "settings" && direct && <section className="workbench-settings"><h3>Identity and configuration</h3><CompanionDetailRow participant={participant} tasks={tasks} discussionId={snapshot.discussion.id} removable={false} onRemove={async () => {}} onRefresh={onRefresh} onError={onError}/></section>}
  </div>;
}

function DiscussionDetails({ snapshot, companions, folders, onClose, onRefresh, onListRefresh, onArchive, onError }: { snapshot: DiscussionSnapshot; companions: Companion[]; folders: DiscussionFolder[]; onClose: () => void; onRefresh: () => Promise<void>; onListRefresh: () => Promise<unknown>; onArchive: () => Promise<void>; onError: (cause: unknown) => void }) {
  const [section, setSection] = useState<"people" | "settings">("people");
  const participants = snapshot.participants;
  const activeIds = new Set(participants.filter(item => !item.removedAt).map(item => item.companionId));
  async function mutate(action: () => Promise<unknown>) { try { await action(); await onRefresh(); } catch (cause) { onError(cause); } }
  return <><button className="details-scrim" onClick={onClose} aria-label="Close discussion details"/><aside className="discussion-details" aria-label="Discussion details"><header><div><h2>Discussion details</h2><p>{snapshot.discussion.title}</p></div><Button variant="ghost" size="icon" onClick={onClose} aria-label="Close details"><X /></Button></header><nav><button aria-current={section === "people" ? "page" : undefined} onClick={() => setSection("people")}><Users />People</button><button aria-current={section === "settings" ? "page" : undefined} onClick={() => setSection("settings")}><Settings />Settings</button></nav>
    {section === "people" ? <div className="details-content"><h3>In this discussion</h3>{participants.map(participant => <CompanionDetailRow key={participant.companionId} participant={participant} tasks={snapshot.tasks.filter(task => task.companionId === participant.companionId)} discussionId={snapshot.discussion.id} removable={!snapshot.discussion.directCompanionId} onRemove={() => mutate(() => discussionApi.removeParticipant(snapshot.discussion.id, participant.companionId))} onRefresh={onRefresh} onError={onError}/>)}{!snapshot.discussion.directCompanionId&&<><h3>Add a companion</h3>{companions.filter(item => !activeIds.has(item.id)).map(companion => <button className="add-participant" key={companion.id} onClick={() => void mutate(() => discussionApi.addParticipant(snapshot.discussion.id, companion.id))}><CompanionAvatar name={companion.name} avatar={companion.avatar} size={34}/><span><strong>{companion.name}</strong><small>{companion.instructions}</small></span><UserPlus /></button>)}</>}</div> : <div className="details-content"><label className="details-field">Folder<select value={snapshot.discussion.folderId ?? ""} onChange={async event => { try { await discussionApi.update(snapshot.discussion.id, { folderId: event.target.value || null }); await onListRefresh(); await onRefresh(); } catch (cause) { onError(cause); } }}><option value="">No folder</option>{folders.map(folder => <option value={folder.id} key={folder.id}>{folder.name}</option>)}</select></label><button className="archive-discussion" onClick={() => void onArchive()}><Archive /><span><strong>Archive discussion</strong><small>Work keeps running. You can restore the discussion later.</small></span></button></div>}
  </aside></>;
}

function CompanionDetailRow({ participant, tasks, discussionId, onRemove, onRefresh, onError, removable=true }: { removable?:boolean; participant: DiscussionSnapshot["participants"][number]; tasks: DiscussionSnapshot["tasks"]; discussionId: string; onRemove: () => Promise<void>; onRefresh: () => Promise<void>; onError: (cause: unknown) => void }) {
  const [open, setOpen] = useState(false); const [name, setName] = useState(participant.companion.name); const [instructions, setInstructions] = useState(participant.companion.instructions); const [saving, setSaving] = useState(false); const files = tasks.flatMap(task => task.files); const active = tasks.some(task => activeStatus(task.status));
  const [models,setModels]=useState<Array<{id:string;name:string}>>([]);
  const [modelId,setModelId]=useState(participant.companion.modelId??'');
  const [avatar,setAvatar]=useState(participant.companion.avatar??DEFAULT_AVATAR);
  const [showDesktop,setShowDesktop]=useState(false);
  const [confirmRetire,setConfirmRetire]=useState(false);
  const avatarChanged=JSON.stringify(avatar)!==JSON.stringify(participant.companion.avatar??DEFAULT_AVATAR);
  useEffect(()=>{if(open)void api.getConfig().then(c=>setModels(c.models??[])).catch(onError);},[open]);
  async function configure(event: FormEvent) { event.preventDefault(); if (!name.trim() || saving) return; setSaving(true); try { await api.updateCompanion(participant.companionId, { name: name.trim(), instructions: instructions.trim(),avatar,modelId:modelId||null }); await onRefresh(); } catch (cause) { onError(cause); } finally { setSaving(false); } }
  return <section className={cn("participant-row", participant.removedAt && "participant-row--removed")}><button onClick={() => setOpen(value => !value)}><CompanionAvatar name={participant.companion.name} avatar={participant.companion.avatar} size={36}/><span><strong>{participant.companion.name}</strong><small>{participant.removedAt ? "Removed · history remains" : active ? "Working in this discussion" : statusLabel(participant.companion.status)}</small></span><ChevronDown /></button>{open && <div className="participant-capabilities"><div className="participant-actions">{participant.companion.provider === "box" && <Button variant="outline" size="sm" onClick={() => setShowDesktop(true)}><Computer />Open desktop</Button>}{active && <Button variant="outline" size="sm" onClick={async () => { try { await discussionApi.cancelCompanion(discussionId, participant.companionId); await onRefresh(); } catch (cause) { onError(cause); } }}><Square />Stop in discussion</Button>}{removable && !participant.removedAt && <Button variant="ghost" size="sm" onClick={() => void onRemove()}><UserMinus />Remove</Button>}</div><section><h4>Files from this discussion</h4>{files.length ? fileList(files) : <p>No files from {participant.companion.name} yet.</p>}</section>{!participant.removedAt && !participant.companion.retiredAt && <><form className="participant-config" onSubmit={configure}><h4>Companion configuration</h4><AvatarPicker value={avatar} onChange={setAvatar}/>{!!models.length&&<label>Model<select value={modelId} onChange={e=>setModelId(e.target.value)}><option value="">Default</option>{models.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></label>}<label>Name<input value={name} maxLength={80} onChange={event => setName(event.target.value)}/></label><label>Role<Textarea value={instructions} maxLength={20_000} rows={3} onChange={event => setInstructions(event.target.value)}/></label><Button type="submit" size="sm" disabled={saving || !name.trim() || (name === participant.companion.name && instructions === participant.companion.instructions && modelId===(participant.companion.modelId??'') && !avatarChanged)}>{saving && <LoaderCircle className="spin"/>}Save configuration</Button></form><section><h4>Applications {participant.companion.name} can use</h4><ApplicationAccess companionId={participant.companionId} compact /></section><DeliverySettings companionId={participant.companionId}/><section><h4>Retire companion</h4>{confirmRetire ? <><p>Retiring {participant.companion.name} stops its work in every discussion and archives its machine.</p><Button variant="destructive" size="sm" disabled={saving} onClick={async()=>{setSaving(true);try{await api.deleteCompanion(participant.companionId);setConfirmRetire(false);await onRefresh();}catch(cause){onError(cause);}finally{setSaving(false);}}}>Confirm retirement</Button><Button variant="ghost" size="sm" onClick={()=>setConfirmRetire(false)}>Keep companion</Button></> : <Button variant="ghost" size="sm" onClick={()=>setConfirmRetire(true)}>Retire {participant.companion.name}</Button>}</section></>}</div>}{showDesktop&&<DesktopSheet companion={participant.companion} onClose={()=>setShowDesktop(false)} onRefresh={onRefresh}/>}</section>;
}

function ArchivedPanel({ discussions, onClose, onRestore }: { discussions: Discussion[]; onClose: () => void; onRestore: (discussion: Discussion) => void }) {
  return <><button className="details-scrim" onClick={onClose} aria-label="Close archived discussions"/><aside className="discussion-details" aria-label="Archived discussions"><header><div><h2>Archived discussions</h2><p>Archiving never cancels active work.</p></div><Button variant="ghost" size="icon" onClick={onClose} aria-label="Close archived discussions"><X /></Button></header><div className="details-content">{discussions.length ? discussions.map(discussion => <button className="archived-discussion" key={discussion.id} onClick={() => onRestore(discussion)}><Archive /><span><strong>{discussion.title}</strong><small>Archived {discussion.archivedAt ? dateLabel(discussion.archivedAt) : ""}</small></span><span>Restore</span></button>) : <div className="work-empty"><Archive/><h2>No archived discussions</h2></div>}</div></aside></>;
}
