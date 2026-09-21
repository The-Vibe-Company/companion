import { ChevronRight, Computer, FileText, ListChecks, MessageCircle, Users } from "lucide-react";
import { discussionApi, type Companion, type DiscussionSnapshot } from "@/api";
import { CompanionAvatar } from "../CompanionAvatar";
import { DesktopSheet } from "../CompanionAccount";
import { MessageResponse } from "../ai-elements/message";
import { Button } from "../ui/button";
import { cn } from "@/lib/utils";
import { CompanionConfiguration, CompanionRetirement } from "../CompanionConfiguration";
import { FileList } from "./MessageItem";
import { QuestionCard } from "./QuestionCard";
import { StopControl, WorkStatus } from "./ActivityLine";
import { DiscussionDetailsBody } from "./DetailsPanel";
import { activeStatus, orderedTasks } from "./shared";

/** The panel shows one conversation or one companion; the scope never changes what a tab means. */
export type PanelTab = "results" | "files" | "computer" | "details";
export const PANEL_SCOPE_ALL = "all";

/** Shared by the panel tabs, so the scope is always one click away. */
export function conversationFiles(snapshot: DiscussionSnapshot) {
  return [...new Map([...snapshot.messages.flatMap(message => message.files), ...snapshot.tasks.flatMap(task => task.files)].map(file => [file.id, file])).values()];
}

export function companionFiles(snapshot: DiscussionSnapshot, companionId: string) {
  return [...new Map([
    ...snapshot.tasks.filter(task => task.companionId === companionId).flatMap(task => task.files),
    ...snapshot.messages.filter(message => message.companionId === companionId).flatMap(message => message.files),
  ].map(file => [file.id, file])).values()];
}

/** Delegated replies whose run is outside the task page still belong to that companion's record. */
export function companionDelegated(snapshot: DiscussionSnapshot, companionId: string) {
  return snapshot.messages.filter(message => message.role === "assistant" && message.delegated && message.companionId === companionId && !snapshot.tasks.some(task => task.id === message.runId));
}

export function WorkspacePanel({ snapshot, companions, scope, tab, onScope, onTab, onOpenCompanion, onRefresh, onListRefresh, onArchive, onError }: {
  snapshot: DiscussionSnapshot; companions: Companion[];
  scope: string; tab: PanelTab;
  onScope: (scope: string) => void; onTab: (tab: PanelTab) => void;
  onOpenCompanion: (companionId: string, tab?: PanelTab) => void;
  onRefresh: () => Promise<void>; onListRefresh: () => Promise<unknown>;
  onArchive: () => Promise<void>; onError: (cause: unknown) => void;
}) {
  const participants = snapshot.participants;
  const activeParticipants = participants.filter(item => !item.removedAt);
  const direct = snapshot.discussion.directCompanionId;
  // A scout whose companion just left the conversation falls back to the whole-conversation scope.
  const selected = scope === PANEL_SCOPE_ALL ? null : participants.find(item => item.companionId === scope) ?? null;
  const computers = participants.filter(item => item.companion.provider === "box");
  const files = selected ? companionFiles(snapshot, selected.companionId) : conversationFiles(snapshot);
  const tasks = selected ? orderedTasks(snapshot.tasks.filter(task => task.companionId === selected.companionId)) : orderedTasks(snapshot.tasks);
  const delegated = selected ? companionDelegated(snapshot, selected.companionId) : [];
  const scopeLabel = selected ? selected.companion.name : "conversation";

  async function removeFromConversation() {
    if (!selected) return;
    try { await discussionApi.removeParticipant(snapshot.discussion.id, selected.companionId); onScope(PANEL_SCOPE_ALL); await onRefresh(); await onListRefresh(); }
    catch (cause) { onError(cause); }
  }

  const tabs: Array<{ id: PanelTab; label: string; icon: typeof FileText; count?: number }> = [
    { id: "results", label: "Results", icon: ListChecks, count: selected ? tasks.length + delegated.length : tasks.length },
    { id: "files", label: "Files", icon: FileText, count: files.length },
    { id: "computer", label: "Computer", icon: Computer, count: selected ? undefined : computers.length },
    { id: "details", label: "Details", icon: Users, count: selected ? undefined : activeParticipants.length },
  ];

  return <div className="work-panel">
    <header className="workbench-context">
      <div className="workbench-scope" role="tablist" aria-label="Workspace scope">
        <button role="tab" aria-selected={scope === PANEL_SCOPE_ALL} className={cn("scope-chip", scope === PANEL_SCOPE_ALL && "scope-chip--active")} onClick={() => onScope(PANEL_SCOPE_ALL)}>
          <span className="scope-chip-all" aria-hidden="true">c.</span>All
        </button>
        {participants.map(participant => <button key={participant.companionId} role="tab" aria-selected={scope === participant.companionId} aria-label={`${participant.companion.name}${participant.removedAt ? ", previous participant" : ""}`} className={cn("scope-chip", scope === participant.companionId && "scope-chip--active")} onClick={() => onScope(participant.companionId)}>
          <CompanionAvatar name={participant.companion.name} avatar={participant.companion.avatar} size={20}/>{participant.companion.name}
        </button>)}
      </div>
    </header>
    <nav className="workbench-tabs" aria-label="Workspace views">
      {tabs.map(({ id, label, icon: Icon, count }) => <button key={id} aria-current={tab === id ? "page" : undefined} onClick={() => onTab(id)}>
        <Icon aria-hidden="true" />{label}{count ? <span>{count}</span> : null}
      </button>)}
    </nav>
    <div className="workbench-body">
      {tab === "results" && <section className="workbench-section" aria-label={`${scopeLabel} results`}>
        {tasks.map(task => <TaskCard key={task.id} discussionId={snapshot.discussion.id} task={task} companion={selected?.companion ?? companions.find(item => item.id === task.companionId)} onRefresh={onRefresh} onError={onError}/>)}
        {delegated.map(message => <section className="discussion-task" key={message.id} aria-label={`${selected?.companion.name ?? "Companion"} delegated response`}>
          <header>{selected && <CompanionAvatar name={selected.companion.name} avatar={selected.companion.avatar} size={28}/>}<div><strong>{selected?.companion.name ?? "Companion"}</strong><span className="work-status" data-status="succeeded"><i className="status-dot" aria-hidden="true"/>Earlier delegated response</span></div></header>
          <MessageResponse>{message.content}</MessageResponse>
          <FileList files={message.files} />
        </section>)}
        {!tasks.length && !delegated.length && <div className="workbench-empty"><MessageCircle/><h3>{selected ? `No work from ${selected.companion.name} yet` : "No work yet"}</h3><p>{selected ? "Results from this companion will appear here." : "Work your companions produce in this conversation will appear here."}</p></div>}
      </section>}

      {tab === "files" && <section className="workbench-section" aria-label={`${scopeLabel} files`}>
        {files.length ? <FileList files={files} /> : <div className="workbench-empty"><FileText/><h3>No files yet</h3><p>{selected ? `Files shared by ${selected.companion.name} will appear here.` : "Attachments and files in this conversation will appear here."}</p></div>}
      </section>}

      {tab === "computer" && <section className="workbench-section" aria-label={`${scopeLabel} computer`}>
        {selected
          ? (selected.companion.provider === "box"
            ? <DesktopSheet companion={selected.companion} embedded onClose={() => onTab("results")} onRefresh={onRefresh}/>
            : <div className="workbench-empty"><Computer/><h3>No cloud computer</h3><p>{selected.companion.name} runs on the local development runtime.</p></div>)
          : (computers.length
            ? <div className="workspace-companions"><h3>Computers in this conversation</h3>{computers.map(({ companion, removedAt }) => <button key={companion.id} aria-label={companion.name} onClick={() => onOpenCompanion(companion.id, "computer")}><CompanionAvatar name={companion.name} avatar={companion.avatar} size={32}/><span><strong>{companion.name}</strong><small>{removedAt ? "Previous participant" : "Open computer"}</small></span><ChevronRight/></button>)}</div>
            : <div className="workbench-empty"><Computer/><h3>No computer available</h3><p>Companions with a cloud computer in this conversation will appear here.</p></div>)}
      </section>}

      {tab === "details" && (selected
        ? <section className="workbench-section" aria-label={`${selected.companion.name} details`}>
          <div className="panel-identity">
            <CompanionAvatar name={selected.companion.name} avatar={selected.companion.avatar} size={40}/>
            <div><strong>{selected.companion.name}</strong><small>{selected.removedAt ? "Previous participant · history remains" : selected.companion.instructions}</small></div>
          </div>
          {selected.removedAt
            ? <p className="muted-copy">This Companion was removed from the conversation. Its accepted work and files remain above.</p>
            : <>
              <div className="panel-actions">
                {selected.companion.provider === "box" && <Button variant="outline" size="sm" onClick={() => onTab("computer")}><Computer/>Open computer</Button>}
                {!direct && <Button variant="ghost" size="sm" onClick={() => void removeFromConversation()}>Remove from conversation</Button>}
              </div>
              <CompanionRetirement companion={selected.companion} onRetired={async () => { onScope(PANEL_SCOPE_ALL); await onRefresh(); await onListRefresh(); }}/>
              <CompanionConfiguration companion={selected.companion} onRefresh={onRefresh} showRetirement={false}/>
            </>}
        </section>
        : <section className="workbench-section" aria-label="Conversation details">
          <DiscussionDetailsBody snapshot={snapshot} companions={companions} onRefresh={onRefresh} onListRefresh={onListRefresh} onArchive={onArchive} onError={onError}/>
        </section>)}
    </div>
  </div>;
}

export function TaskCard({ discussionId, task, companion, onRefresh, onError }: {
  discussionId: string; task: DiscussionSnapshot["tasks"][number]; companion?: Companion;
  onRefresh: () => Promise<void>; onError: (cause: unknown) => void;
}) {
  const active = activeStatus(task.status);
  const name = companion?.name ?? "Companion";
  return <section className="discussion-task" aria-label={`${name} task`}>
    <header>{companion ? <CompanionAvatar name={companion.name} avatar={companion.avatar} size={28}/> : <span className="central-mark central-mark--small">c.</span>}
      <div><strong>{name}</strong><WorkStatus status={task.status} /></div>
      {active && <StopControl label={`Stop ${name}`} onStop={() => discussionApi.cancelCompanion(discussionId, task.companionId)} onRefresh={onRefresh} onError={onError}/>}
    </header>
    <p className="task-prompt">{task.content}</p>
    {task.previewText && active && <details className="task-detail" open><summary>Latest update</summary><MessageResponse>{task.previewText}</MessageResponse></details>}
    {task.resultText && <details className="task-detail" open><summary>Result</summary><MessageResponse>{task.resultText}</MessageResponse><FileList files={task.files} /></details>}
    {task.error && <p className="task-error">{task.error}</p>}
    {!task.resultText && <FileList files={task.files} />}
    {task.questions.filter(question => active && question.answer === null).map(question => <QuestionCard key={question.id} discussionId={discussionId} question={question} companionName={name} onRefresh={onRefresh} onError={onError} />)}
  </section>;
}
