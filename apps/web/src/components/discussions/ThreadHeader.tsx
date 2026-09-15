import { useState } from "react";
import { Computer, FileText, Menu, MoreHorizontal, Pencil } from "lucide-react";
import { discussionApi, type Companion, type Discussion } from "@/api";
import { CompanionAvatar } from "../CompanionAvatar";
import { Button } from "../ui/button";

export function ThreadHeader({ discussion, direct, participantCount, tab, onMenu, onDetails, onOpenView, onCloseView, onRefresh, onListRefresh, onError }: {
  discussion: Discussion; direct: Companion | null | undefined; participantCount: number; tab: string;
  onMenu: () => void; onDetails: () => void; onOpenView: (id: string) => void; onCloseView: () => void;
  onRefresh: () => Promise<void>; onListRefresh: () => Promise<unknown>; onError: (cause: unknown) => void;
}) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [title, setTitle] = useState(discussion.title);
  async function saveTitle() { if (!title.trim()) return; try { await discussionApi.update(discussion.id, { title: title.trim() }); setEditingTitle(false); await onListRefresh(); await onRefresh(); } catch (cause) { onError(cause); } }
  return <header className="discussion-header">
    <Button className="discussion-mobile-menu" variant="ghost" size="icon" onClick={onMenu} aria-label="Open navigation"><Menu /></Button>
    <div className="discussion-title">
      {direct && <CompanionAvatar name={direct.name} avatar={direct.avatar} sleeping={direct.status === "archived"} size={34}/>}
      <div>{editingTitle ? <form onSubmit={event => { event.preventDefault(); void saveTitle(); }}><input aria-label="Discussion title" value={title} onChange={event => setTitle(event.target.value)} autoFocus /><Button size="sm" type="submit">Save</Button></form> : <button onClick={() => setEditingTitle(true)} aria-label="Rename discussion"><h1>{discussion.title || "Untitled discussion"}</h1><Pencil /></button>}<span>{direct ? `Direct with ${direct.name}` : participantCount ? `${participantCount} companion${participantCount === 1 ? "" : "s"} invited` : "Companion discussion"}</span></div>
    </div>
    <nav aria-label="Discussion views">
      <button aria-label="Open files" aria-expanded={tab === "work"} onClick={() => tab === "work" ? onCloseView() : onOpenView("work")}><FileText /><span>Files</span></button>
      <button aria-label="Open computers" aria-expanded={tab === "machines"} onClick={() => tab === "machines" ? onCloseView() : onOpenView("machines")}><Computer /><span>Computer</span></button>
    </nav>
    <Button variant="ghost" size="icon" onClick={onDetails} aria-label="Discussion details"><MoreHorizontal /></Button>
  </header>;
}
