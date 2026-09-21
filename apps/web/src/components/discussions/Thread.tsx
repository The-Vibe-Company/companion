import { Fragment, useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, FileText, LoaderCircle, Maximize2, MessageCircle, Minimize2, UserPlus, Users, X } from "lucide-react";
import { discussionApi, type AccountUser, type Companion, type DiscussionSnapshot } from "@/api";
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
import { PANEL_SCOPE_ALL, WorkspacePanel, type PanelTab } from "./Workbench";
import { useThreadScroll } from "./useThreadScroll";
import { activeStatus, groupMessages, mergeMessages, orderedTasks } from "./shared";

export function Thread({ user, snapshot, olderMessages, companions, onMenu, onRefresh, onListRefresh, onArchive, onLoadOlder, loadingOlder, onError }: { user: AccountUser; snapshot: DiscussionSnapshot; olderMessages: DiscussionSnapshot["messages"]; companions: Companion[]; onMenu: () => void; onRefresh: () => Promise<void>; onListRefresh: () => Promise<unknown>; onArchive: () => Promise<void>; onLoadOlder: () => Promise<void>; loadingOlder: boolean; onError: (cause: unknown, fallback?: string) => void }) {
  const discussion = snapshot.discussion;
  const participants = snapshot.participants.filter(item => !item.removedAt);
  const companionMap = new Map([...companions, ...snapshot.participants.map(p => p.companion)].map(companion => [companion.id, companion]));
  const direct = discussion.directCompanionId ? companionMap.get(discussion.directCompanionId) : null;
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelScope, setPanelScope] = useState<string>(PANEL_SCOPE_ALL);
  const [panelTab, setPanelTab] = useState<PanelTab>("files");
  const [expanded, setExpanded] = useState(false);
  const panelTrigger = useRef<HTMLElement | null>(null);
  function openPanel(tab: PanelTab = panelTab, scope: string = panelScope) {
    if (!panelOpen) panelTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPanelScope(scope);
    setPanelTab(tab);
    setPanelOpen(true);
  }
  function openCompanion(companionId: string, tab: PanelTab = "results") { openPanel(tab, companionId); }
  function closePanel() {
    setPanelOpen(false);
    requestAnimationFrame(() => { if (panelTrigger.current?.isConnected) panelTrigger.current.focus(); });
  }
  // The computer view needs the wider split; the user can still reduce it.
  useEffect(() => { if (panelTab === "computer") setExpanded(true); }, [panelTab]);
  const [starter, setStarter] = useState<string | null>(null);
  const { timelineRef, awayFromLatest, onScroll, jumpToLatest } = useThreadScroll([snapshot, olderMessages, panelOpen, panelScope, panelTab], olderMessages.length);

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

  async function addParticipant(companionId: string) {
    try { await discussionApi.addParticipant(discussion.id, companionId); await onRefresh(); await onListRefresh(); }
    catch (cause) { onError(cause, "Could not add this companion."); }
  }

  // Terminal work is the workbench's business unless it is the answer to what you just asked.
  const latestUserTime = allMessages.reduce((latest, message) => message.role === "user" ? Math.max(latest, Date.parse(message.createdAt)) : latest, 0);
  const isEarlierActivity = (run: { status: string; finishedAt: string | null }) => !activeStatus(run.status) && run.finishedAt !== null && Date.parse(run.finishedAt) < latestUserTime;
  const activeCentral = snapshot.centralRuns.find(run => activeStatus(run.status));
  const activeTasks = orderedTasks(snapshot.tasks).filter(task => activeStatus(task.status));
  const centralFailures = snapshot.centralRuns.filter(run => ['failed', 'interrupted', 'cancelled'].includes(run.status) && !isEarlierActivity(run));
  const taskFailures = orderedTasks(snapshot.tasks).filter(task => ['failed', 'interrupted'].includes(task.status) && !isEarlierActivity(task));

  return <section className="discussion-view">
    <ThreadHeader
      discussion={discussion}
      direct={direct}
      participants={participants.map(item => item.companion)}
      companions={companions}
      workspaceOpen={panelOpen}
      onMenu={onMenu}
      onToggleWorkspace={() => panelOpen ? closePanel() : openPanel()}
      onAddParticipant={addParticipant}
      onRefresh={onRefresh}
      onListRefresh={onListRefresh}
      onError={onError}
    />
    <div className={cn("discussion-stage", panelOpen&&"discussion-stage--workspace", panelOpen&&"discussion-stage--activity-open", expanded&&"discussion-stage--expanded")}><div className="discussion-timeline" ref={timelineRef} onScroll={event => onScroll(event.currentTarget)} role="log" aria-label="Conversation messages" aria-live="polite">
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
          onOpen={() => openCompanion(task.companionId, "results")}
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
        onOpen={() => openCompanion(task.companionId, "results")}
      />; })}
    </div>{panelOpen && <aside className="discussion-workbench" aria-label={panelScope === PANEL_SCOPE_ALL ? (panelTab === "files" ? "Conversation files" : panelTab === "computer" ? "Conversation computers" : panelTab === "results" ? "Conversation results" : "Conversation details") : `${companionMap.get(panelScope)?.name ?? "Companion"} workspace`} onKeyDown={event => { if (event.key === "Escape" && !event.defaultPrevented) { event.stopPropagation(); closePanel(); } }}>
      <div className="workbench-controls"><Button className="workbench-expand" variant="ghost" size="icon" static aria-label={expanded ? "Reduce workspace" : "Expand workspace"} aria-pressed={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? <Minimize2 /> : <Maximize2 />}</Button><Button variant="ghost" size="icon" aria-label="Close workbench" onClick={closePanel}><X /></Button></div>
      <WorkspacePanel snapshot={{...snapshot, messages: allMessages}} companions={companions} scope={panelScope} tab={panelTab} onScope={setPanelScope} onTab={setPanelTab} onOpenCompanion={openCompanion} onRefresh={onRefresh} onListRefresh={onListRefresh} onArchive={onArchive} onError={onError}/>
    </aside>}
    {awayFromLatest && <button className="discussion-jump-latest" aria-label="Latest messages" onClick={() => { setArrived(false); jumpToLatest(); }}><ArrowDown />Latest messages{arrived && <span className="jump-badge">New</span>}</button>}
    {!discussion.archivedAt ? <Composer userId={user.id} snapshot={snapshot} companions={companions} initialDraft={starter} onInitialDraftApplied={()=>setStarter(null)} onRefresh={onRefresh} onError={onError}/> : <p className="discussion-archived-note">This conversation is archived. Restore it to send a message.</p>}</div>
    <nav className="discussion-mobile-nav" aria-label="Mobile workspace">
      <button aria-label="Show conversation" aria-current={!panelOpen?"page":undefined} onClick={()=>setPanelOpen(false)}><MessageCircle/>Thread</button>
      <button aria-label="Show files" aria-current={panelOpen&&panelScope===PANEL_SCOPE_ALL&&panelTab==="files"?"page":undefined} onClick={()=>openPanel("files", PANEL_SCOPE_ALL)}><FileText/>Files</button>
      <button aria-label="Show details" aria-current={panelOpen&&panelScope===PANEL_SCOPE_ALL&&panelTab==="details"?"page":undefined} onClick={()=>openPanel("details", PANEL_SCOPE_ALL)}><Users/>Details</button>
      <details className="mobile-participant-picker" onKeyDown={event => { if (event.key === "Escape") { event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); } }}>
        <summary aria-label="Choose conversation companion"><Users/>Companions</summary>
        <div className="mobile-participant-options" role="group" aria-label="Conversation workspaces">
          <strong>In this conversation</strong>
          {snapshot.participants.map(participant => <button key={participant.companionId} aria-label={`View ${participant.companion.name} workspace`} aria-current={panelOpen&&panelScope===participant.companionId?"page":undefined} onClick={event => { openCompanion(participant.companionId); event.currentTarget.closest("details")?.removeAttribute("open"); }}><CompanionAvatar name={participant.companion.name} avatar={participant.companion.avatar} size={28}/><span>{participant.companion.name}{participant.removedAt && <small>Previous participant</small>}</span></button>)}
          <button onClick={event => { openPanel("details", PANEL_SCOPE_ALL); event.currentTarget.closest("details")?.removeAttribute("open"); }}><UserPlus/>Manage participants</button>
        </div>
      </details>
    </nav>
  </section>;
}
