import { ChevronRight, Computer, FileText, MessageCircle } from "lucide-react";
import { discussionApi, type Companion, type DiscussionSnapshot } from "@/api";
import { CompanionAvatar } from "../CompanionAvatar";
import { DesktopSheet } from "../CompanionAccount";
import { MessageResponse } from "../ai-elements/message";
import { Button } from "../ui/button";
import { cn } from "@/lib/utils";
import { FileList } from "./MessageItem";
import { QuestionCard } from "./QuestionCard";
import { StopControl, WorkStatus } from "./ActivityLine";
import { CompanionDetailRow } from "./DetailsPanel";
import { activeStatus, orderedTasks } from "./shared";

export function WorkspaceOverview({ snapshot, machines, onOpen }: {
  snapshot: DiscussionSnapshot; machines: boolean;
  onOpen: (id: string, view?: "files" | "machine") => void;
}) {
  const files = [...new Map([...snapshot.messages.flatMap(message => message.files), ...snapshot.tasks.flatMap(task => task.files)].map(file => [file.id, file])).values()];
  const participants = snapshot.participants.filter(item => !machines || item.companion.provider === "box");
  return <div className="discussion-resources">
    <header><h2>{machines ? "Computers" : "Files"}</h2><p>{machines ? "Open a companion’s computer." : "Shared in this discussion."}</p></header>
    {!machines && (files.length ? <FileList files={files} /> : <div className="workbench-empty"><FileText /><h3>No files yet</h3><p>Attachments and files from your companions will appear here.</p></div>)}
    {participants.length > 0 && <section className="workspace-companions"><h3>{machines ? "Available computers" : "Companion workspaces"}</h3>{participants.map(({ companion, removedAt }) => <button key={companion.id} aria-label={companion.name} onClick={() => onOpen(companion.id, machines ? "machine" : "files")}><CompanionAvatar name={companion.name} avatar={companion.avatar} size={32}/><span><strong>{companion.name}</strong><small>{removedAt ? "Previous participant" : machines ? "Computer" : "Files and results"}</small></span><ChevronRight /></button>)}</section>}
    {machines && !participants.length && <div className="workbench-empty"><Computer /><h3>No computer available</h3><p>Companions with computer access in this discussion will appear here.</p></div>}
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

export function CompanionWorkbench({ snapshot, companionId, view, onView: setView, onRefresh, onError }: {
  snapshot: DiscussionSnapshot; companionId: string;
  view: "results" | "files" | "machine" | "settings"; onView: (view: "results" | "files" | "machine" | "settings") => void;
  onRefresh: () => Promise<void>; onError: (cause: unknown) => void;
}) {
  const participant = snapshot.participants.find(item => item.companionId === companionId);
  if (!participant) return <div className="work-empty"><p>This companion's invitation is being recorded.</p></div>;
  const companion = participant.companion;
  const tasks = orderedTasks(snapshot.tasks.filter(task => task.companionId === companionId));
  // Delegated replies whose run is outside the task page still belong to this companion's record.
  const delegated = snapshot.messages.filter(message => message.role === "assistant" && message.delegated && message.companionId === companionId && !snapshot.tasks.some(task => task.id === message.runId));
  const files = [...new Map([...tasks.flatMap(task => task.files), ...snapshot.messages.filter(message => message.companionId === companionId).flatMap(message => message.files)].map(file => [file.id, file])).values()];
  const direct = snapshot.discussion.directCompanionId === companionId;
  return <div className="work-panel companion-workbench">
    <header className="companion-workbench-header">
      <CompanionAvatar name={companion.name} avatar={companion.avatar} size={42}/>
      <div><h2>{companion.name}</h2><p>{participant.removedAt ? "Removed from this discussion · previous work remains available" : companion.instructions}</p></div>
    </header>
    <nav className="workbench-tabs" aria-label="Companion workspace views">
      <button aria-current={view === "results" ? "page" : undefined} onClick={() => setView("results")}>Results</button>
      <button aria-current={view === "files" ? "page" : undefined} onClick={() => setView("files")}>Files{files.length > 0 && <span>{files.length}</span>}</button>
      {companion.provider === "box" && <button aria-current={view === "machine" ? "page" : undefined} onClick={() => setView("machine")}>Machine</button>}
      {direct && <button aria-current={view === "settings" ? "page" : undefined} onClick={() => setView("settings")}>Configuration</button>}
    </nav>
    {view === "results" && (tasks.length || delegated.length
      ? <>
        {tasks.map(task => <TaskCard key={task.id} discussionId={snapshot.discussion.id} task={task} companion={companion} onRefresh={onRefresh} onError={onError}/>)}
        {delegated.map(message => <section className="discussion-task" key={message.id} aria-label={`${companion.name} delegated response`}>
          <header><CompanionAvatar name={companion.name} avatar={companion.avatar} size={28}/><div><strong>{companion.name}</strong><span className="work-status" data-status="succeeded"><i className="status-dot" aria-hidden="true" />Earlier delegated response</span></div></header>
          <MessageResponse>{message.content}</MessageResponse>
          <FileList files={message.files} />
        </section>)}
      </>
      : <div className="workbench-empty"><MessageCircle/><h3>Ready for your next idea</h3><p>Work from {companion.name} in this discussion will appear here.</p></div>)}
    {view === "files" && (files.length ? <FileList files={files} /> : <div className="workbench-empty"><FileText/><h3>No files yet</h3><p>Files shared by {companion.name} in this discussion will appear here.</p></div>)}
    {view === "machine" && companion.provider === "box" && <DesktopSheet companion={companion} embedded onClose={() => setView("results")} onRefresh={onRefresh}/>}
    {view === "settings" && direct && <section className="workbench-settings"><h3>Identity and configuration</h3><CompanionDetailRow participant={participant} tasks={tasks} discussionId={snapshot.discussion.id} removable={false} onRemove={async () => {}} onRefresh={onRefresh} onError={onError}/></section>}
  </div>;
}
