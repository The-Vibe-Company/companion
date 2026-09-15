import { Fragment, useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, FileText, LoaderCircle, Maximize2, MessageCircle, Minimize2, UserPlus, Users, X } from "lucide-react";
import { discussionApi, type AccountUser, type Companion, type DiscussionFolder, type DiscussionSnapshot } from "@/api";
import { CompanionAvatar } from "../CompanionAvatar";
import { Button } from "../ui/button";
import { cn } from "@/lib/utils";
import { ActivityLine, StopControl } from "./ActivityLine";
import { Composer } from "./Composer";
import { EmptyState } from "./EmptyState";
import { InvitationCard } from "./InvitationCard";
import { DaySeparator, MessageItem } from "./MessageItem";
import { ThreadHeader } from "./ThreadHeader";
import { QuestionCard } from "./QuestionCard";
import { CompanionWorkbench, WorkspaceOverview } from "./Workbench";
import { useThreadScroll } from "./useThreadScroll";
import { activeStatus, groupMessages, mergeMessages, orderedTasks } from "./shared";

type WorkspaceView = "results" | "files" | "machine" | "settings";

export function Thread({ user, snapshot, olderMessages, companions, folders, onMenu, onDetails, onRefresh, onListRefresh, onArchive, onLoadOlder, loadingOlder, onError }: { user: AccountUser; snapshot: DiscussionSnapshot; olderMessages: DiscussionSnapshot["messages"]; companions: Companion[]; folders: DiscussionFolder[]; onMenu: () => void; onDetails: () => void; onRefresh: () => Promise<void>; onListRefresh: () => Promise<unknown>; onArchive: () => Promise<void>; onLoadOlder: () => Promise<void>; loadingOlder: boolean; onError: (cause: unknown, fallback?: string) => void }) {
  const discussion = snapshot.discussion;
  const participants = snapshot.participants.filter(item => !item.removedAt);
  const companionMap = new Map([...companions, ...snapshot.participants.map(p => p.companion)].map(companion => [companion.id, companion]));
  const direct = discussion.directCompanionId ? companionMap.get(discussion.directCompanionId) : null;
  const [tab, setTab] = useState<string>("conversation");
  const [expanded, setExpanded] = useState(false);
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>("files");
  const workspaceTrigger = useRef<HTMLElement | null>(null);
  function openWorkspace(id: string, view: WorkspaceView = "files") {
    if (tab === "conversation") workspaceTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setWorkspaceView(view);
    setExpanded(view === "machine");
    setTab(id);
  }
  function closeWorkspace() {
    setTab("conversation");
    requestAnimationFrame(() => { if (workspaceTrigger.current?.isConnected) workspaceTrigger.current.focus(); });
  }
  const [starter, setStarter] = useState<string | null>(null);
  const { timelineRef, awayFromLatest, onScroll, jumpToLatest } = useThreadScroll([snapshot, olderMessages, tab], olderMessages.length);

  const allMessages = mergeMessages(olderMessages, snapshot.messages);
  const latestId = allMessages.at(-1)?.id ?? null;
  const knownLatest = useRef(latestId);
  const [arrived, setArrived] = useState(false);
  useEffect(() => {
    if (latestId === knownLatest.current) return;
    const known = knownLatest.current;
    knownLatest.current = latestId;
    if (awayFromLatest && known !== null) setArrived(true);
  }, [latestId, awayFromLatest]);
  useEffect(() => { if (!awayFromLatest) setArrived(false); }, [awayFromLatest]);

  // Terminal work is the workbench's business unless it is the answer to what you just asked.
  const latestUserTime = allMessages.reduce((latest, message) => message.role === "user" ? Math.max(latest, Date.parse(message.createdAt)) : latest, 0);
  const isEarlierActivity = (run: { status: string; finishedAt: string | null }) => !activeStatus(run.status) && run.finishedAt !== null && Date.parse(run.finishedAt) < latestUserTime;
  const activeCentral = snapshot.centralRuns.find(run => activeStatus(run.status));
  const activeTasks = orderedTasks(snapshot.tasks).filter(task => activeStatus(task.status));
  const centralFailures = snapshot.centralRuns.filter(run => ['failed', 'interrupted', 'cancelled'].includes(run.status) && !isEarlierActivity(run));
  const taskFailures = orderedTasks(snapshot.tasks).filter(task => ['failed', 'interrupted'].includes(task.status) && !isEarlierActivity(task));

  return <section className="discussion-view">
    <ThreadHeader discussion={discussion} direct={direct} participants={participants.map(item => item.companion)} tab={tab} onMenu={onMenu} onDetails={onDetails} onOpenView={id => openWorkspace(id)} onCloseView={closeWorkspace} onRefresh={onRefresh} onListRefresh={onListRefresh} onError={onError} />
    <div className={cn("discussion-stage", tab!=="conversation"&&"discussion-stage--workspace", tab!=="conversation"&&"discussion-stage--activity-open", expanded&&"discussion-stage--expanded")}><div className="discussion-timeline" ref={timelineRef} onScroll={event => onScroll(event.currentTarget)} role="log" aria-label="Discussion messages" aria-live="polite">
      {snapshot.beforeCursor && <Button className="load-older" variant="outline" size="sm" disabled={loadingOlder} onClick={() => void onLoadOlder()}>{loadingOlder ? <LoaderCircle className="spin" /> : <ArrowUp />}Load earlier messages</Button>}
      {!allMessages.length && !snapshot.proposals.length && !activeCentral && !activeTasks.length && <EmptyState direct={direct} onStarter={setStarter} />}
      {groupMessages(allMessages.filter(message => !(message.role === "assistant" && message.delegated))).map(({ message, day, header }) => <Fragment key={message.id}>
        {day && <DaySeparator value={day} />}
        <MessageItem message={message} user={user} companions={companionMap} header={header} />
      </Fragment>)}
      {snapshot.proposals.filter(proposal => proposal.status === "pending").map(proposal => <InvitationCard key={proposal.id} discussionId={discussion.id} proposal={proposal} companion={companionMap.get(proposal.companionId)} onRefresh={onRefresh} onError={onError} />)}
      {activeCentral && <ActivityLine key={activeCentral.id} name="Companion" status={activeCentral.status} mark={<span className="central-mark central-mark--small">c.</span>} stop={<StopControl label="Stop chat" onStop={() => discussionApi.cancel(discussion.id)} onRefresh={onRefresh} onError={onError}/>} />}
      {centralFailures.map(run => <ActivityLine key={run.id} name="Companion" status={run.status} error={run.error} mark={<span className="central-mark central-mark--small">c.</span>} />)}
      {activeTasks.map(task => { const companion = companionMap.get(task.companionId); const name = companion?.name ?? "Companion"; return <Fragment key={task.id}>
        <ActivityLine
          name={name}
          status={task.status}
          mark={companion ? <CompanionAvatar name={name} avatar={companion.avatar} size={30}/> : <span className="central-mark central-mark--small">c.</span>}
          onOpen={() => openWorkspace(task.companionId, "results")}
          stop={<StopControl label={`Stop ${name}`} onStop={() => discussionApi.cancelCompanion(discussion.id, task.companionId)} onRefresh={onRefresh} onError={onError}/>}
        />
        {task.questions.filter(question => question.answer === null).map(question => <QuestionCard key={question.id} discussionId={discussion.id} question={question} companionName={name} onRefresh={onRefresh} onError={onError} />)}
      </Fragment>; })}
      {taskFailures.map(task => { const companion = companionMap.get(task.companionId); const name = companion?.name ?? "Companion"; return <ActivityLine
        key={task.id}
        name={name}
        status={task.status}
        error={task.error}
        mark={companion ? <CompanionAvatar name={name} avatar={companion.avatar} size={30}/> : <span className="central-mark central-mark--small">c.</span>}
        onOpen={() => openWorkspace(task.companionId, "results")}
      />; })}
    </div>{tab !== "conversation" && <aside className="discussion-workbench" aria-label={tab === "work" ? "Discussion files" : tab === "machines" ? "Discussion computers" : `${companionMap.get(tab)?.name ?? "Companion"} workbench`} onKeyDown={event => { if (event.key === "Escape" && !event.defaultPrevented) { event.stopPropagation(); closeWorkspace(); } }}>
      <div className="workbench-controls"><Button className="workbench-expand" variant="ghost" size="icon" static aria-label={expanded ? "Reduce workspace" : "Expand workspace"} aria-pressed={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? <Minimize2 /> : <Maximize2 />}</Button><Button variant="ghost" size="icon" aria-label="Close workbench" onClick={closeWorkspace}><X /></Button></div>
      {tab === "work" || tab === "machines" ? <WorkspaceOverview snapshot={{...snapshot, messages: allMessages}} machines={tab === "machines"} onOpen={openWorkspace} /> : <CompanionWorkbench key={tab} snapshot={{...snapshot, messages: allMessages}} companionId={tab} view={workspaceView} onView={view => { setWorkspaceView(view); if (view === "machine") setExpanded(true); }} onRefresh={onRefresh} onError={onError}/>}
    </aside>}
    {awayFromLatest && <button className="discussion-jump-latest" aria-label="Latest messages" onClick={() => { setArrived(false); jumpToLatest(); }}><ArrowDown />Latest messages{arrived && <span className="jump-badge">New</span>}</button>}
    {!discussion.archivedAt ? <Composer userId={user.id} snapshot={snapshot} companions={companions} initialDraft={starter} onInitialDraftApplied={()=>setStarter(null)} onRefresh={onRefresh} onError={onError}/> : <p className="discussion-archived-note">This discussion is archived. Restore it to send a message.</p>}</div>
    <nav className="discussion-mobile-nav" aria-label="Mobile workspace"><button aria-label="Show discussion" aria-current={tab==="conversation"?"page":undefined} onClick={()=>setTab("conversation")}><MessageCircle/>Thread</button><button aria-label="Show files" aria-current={tab==="work"?"page":undefined} onClick={()=>openWorkspace("work")}><FileText/>Files</button><details className="mobile-participant-picker" onKeyDown={event => { if (event.key === "Escape") { event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); } }}>
      <summary aria-label="Choose discussion companion"><Users/>Companions</summary>
      <div className="mobile-participant-options" role="group" aria-label="Discussion workspaces">
        <strong>In this discussion</strong>
        {snapshot.participants.map(participant => <button key={participant.companionId} aria-label={`View ${participant.companion.name} workspace`} aria-current={tab === participant.companionId ? "page" : undefined} onClick={event => { openWorkspace(participant.companionId); event.currentTarget.closest("details")?.removeAttribute("open"); }}><CompanionAvatar name={participant.companion.name} avatar={participant.companion.avatar} size={28}/><span>{participant.companion.name}{participant.removedAt && <small>Previous participant</small>}</span></button>)}
        {snapshot.tasks.length > 0 && <button onClick={event => { setTab("work"); event.currentTarget.closest("details")?.removeAttribute("open"); }}><FileText/>All files in this discussion</button>}
        <button onClick={event => { event.currentTarget.closest("details")?.removeAttribute("open"); onDetails(); }}><UserPlus/>Manage participants</button>
      </div>
    </details></nav>
  </section>;
}
