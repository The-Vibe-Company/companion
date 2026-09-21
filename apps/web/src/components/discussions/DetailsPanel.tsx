import { useState } from "react";
import { Archive, ChevronDown, Computer, Square, UserMinus, X } from "lucide-react";
import { discussionApi, type Companion, type Discussion, type DiscussionSnapshot } from "@/api";
import { CompanionAvatar } from "../CompanionAvatar";
import { DesktopSheet } from "../CompanionAccount";
import { Button } from "../ui/button";
import { cn } from "@/lib/utils";
import { useModalFocus } from "@/hooks/useModalFocus";
import { FileList } from "./MessageItem";
import { activeStatus, dateLabel, statusLabel } from "./shared";

/** Participants and archive, rendered inside the workspace panel rather than a modal. */
export function DiscussionDetailsBody({ snapshot, companions, onRefresh, onListRefresh, onArchive, onError }: {
  snapshot: DiscussionSnapshot; companions: Companion[];
  onRefresh: () => Promise<void>; onListRefresh: () => Promise<unknown>;
  onArchive: () => Promise<void>; onError: (cause: unknown) => void;
}) {
  const participants = snapshot.participants;
  const activeIds = new Set(participants.filter(item => !item.removedAt).map(item => item.companionId));
  const direct = snapshot.discussion.directCompanionId;
  async function mutate(action: () => Promise<unknown>) { try { await action(); await onRefresh(); await onListRefresh(); } catch (cause) { onError(cause); } }
  return <div className="discussion-details-body">
    <h3>In this conversation</h3>
    {participants.map(participant => <CompanionDetailRow key={participant.companionId} participant={participant} tasks={snapshot.tasks.filter(task => task.companionId === participant.companionId)} discussionId={snapshot.discussion.id} removable={!direct} onRemove={() => mutate(() => discussionApi.removeParticipant(snapshot.discussion.id, participant.companionId))} onRefresh={onRefresh} onError={onError}/>)}
    {!direct && <>
      <h3>Add a companion</h3>
      {companions.filter(item => !item.retiredAt && !activeIds.has(item.id)).map(companion => <button className="add-participant" key={companion.id} onClick={() => void mutate(() => discussionApi.addParticipant(snapshot.discussion.id, companion.id))}><CompanionAvatar name={companion.name} avatar={companion.avatar} size={34}/><span><strong>{companion.name}</strong><small>{companion.instructions}</small></span><span aria-hidden="true">Add</span></button>)}
    </>}
    <button className="archive-discussion" onClick={() => void onArchive()}><Archive /><span><strong>Archive conversation</strong><small>Work keeps running. You can restore it later.</small></span></button>
  </div>;
}

export function CompanionDetailRow({ participant, tasks, discussionId, onRemove, onRefresh, onError, removable = true }: { removable?: boolean; participant: DiscussionSnapshot["participants"][number]; tasks: DiscussionSnapshot["tasks"]; discussionId: string; onRemove: () => Promise<void>; onRefresh: () => Promise<void>; onError: (cause: unknown) => void }) {
  const [open, setOpen] = useState(false);
  const [showDesktop, setShowDesktop] = useState(false);
  const files = tasks.flatMap(task => task.files);
  const active = tasks.some(task => activeStatus(task.status));
  return <section className={cn("participant-row", participant.removedAt && "participant-row--removed")}>
    <button aria-expanded={open} onClick={() => setOpen(value => !value)}><CompanionAvatar name={participant.companion.name} avatar={participant.companion.avatar} size={36}/><span><strong>{participant.companion.name}</strong><small>{participant.removedAt ? "Removed · history remains" : active ? "Working in this conversation" : statusLabel(participant.companion.status)}</small></span><ChevronDown /></button>
    {open && <div className="participant-capabilities"><div className="participant-actions">
      {participant.companion.provider === "box" && <Button variant="outline" size="sm" onClick={() => setShowDesktop(true)}><Computer />Open desktop</Button>}
      {active && <Button variant="outline" size="sm" onClick={async () => { try { await discussionApi.cancelCompanion(discussionId, participant.companionId); await onRefresh(); } catch (cause) { onError(cause); } }}><Square />Stop</Button>}
      {removable && !participant.removedAt && <Button variant="ghost" size="sm" onClick={() => void onRemove()}><UserMinus />Remove</Button>}
    </div>{removable && <p className="muted-copy">Removing a Companion leaves accepted work and history here.</p>}
    <section><h4>Files from this conversation</h4>{files.length ? <FileList files={files} /> : <p>No files from {participant.companion.name} yet.</p>}</section>
    {!participant.removedAt && <p className="muted-copy">Select {participant.companion.name} above to edit its settings or retire it.</p>}
    </div>}
    {showDesktop && <DesktopSheet companion={participant.companion} onClose={() => setShowDesktop(false)} onRefresh={onRefresh}/>}</section>;
}

export function ArchivedPanel({ discussions, onClose, onRestore, loading, error, onRetry }: { loading?: boolean; error?: string; onRetry?: () => void; discussions: Discussion[]; onClose: () => void; onRestore: (discussion: Discussion) => void }) {
  const modalRef = useModalFocus(true, onClose);
  return <><button className="details-scrim" onClick={onClose} aria-label="Close archived discussions"/><aside ref={modalRef} tabIndex={-1} role="dialog" aria-modal="true" className="discussion-details" aria-label="Archived discussions"><header><div><h2>Archived discussions</h2><p>Archiving never cancels active work.</p></div><Button variant="ghost" size="icon" onClick={onClose} aria-label="Close archived discussions"><X /></Button></header><div className="details-content">{loading ? <p role="status">Loading archived discussions…</p> : error ? <div role="alert"><p>{error}</p><Button onClick={onRetry}>Try again</Button></div> : discussions.length ? discussions.map(discussion => <button className="archived-discussion" key={discussion.id} onClick={() => onRestore(discussion)}><Archive /><span><strong>{discussion.title}</strong><small>Archived {discussion.archivedAt ? dateLabel(discussion.archivedAt) : ""}</small></span><span>Restore</span></button>) : <div className="work-empty"><Archive/><h2>No archived discussions</h2></div>}</div></aside></>;
}
