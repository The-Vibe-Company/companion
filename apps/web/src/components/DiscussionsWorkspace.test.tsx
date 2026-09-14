import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiscussionsWorkspace } from "./DiscussionsWorkspace";

const user = { id: "user-1", email: "stan@example.com", name: "Stan" };
const ada = { id: "ada", name: "Ada", instructions: "Research", provider: "box" as const, status: "ready" as const, error: null, createdAt: "2026-09-11T09:00:00.000Z", avatar: { shape: 1, color: 2, face: 0 } };
const june = { ...ada, id: "june", name: "June", instructions: "Write" };
const discussion = { id: "discussion-1", title: "Launch", folderId: null, directCompanionId: null, archivedAt: null, createdAt: "2026-09-11T09:00:00.000Z", updatedAt: "2026-09-11T09:00:00.000Z" };
const snapshot = {
  discussion,
  participants: [{ companionId: "ada", removedAt: null, companion: ada }],
  messages: [], tasks: [], centralRuns: [], proposals: [], beforeCursor: null,
};

function response(body: unknown, status = 200) { return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })); }

function setupFetch(custom?: (path: string, options?: RequestInit) => Promise<Response> | undefined) {
  const fetchMock = vi.fn((input: RequestInfo | URL, options?: RequestInit) => {
    const path = String(input);
    const result = custom?.(path, options); if (result) return result;
    if (path === "/api/discussions") return response({ discussions: [discussion], folders: [] });
    if (path === "/api/discussions/discussion-1") return response(snapshot);
    throw new Error(`Unexpected request ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock); return fetchMock;
}

function renderWorkspace() {
  return render(<DiscussionsWorkspace user={user} companions={[ada, june]} initialDiscussionId="discussion-1" legacyCompanionId={null} onUnauthorized={vi.fn()} onCreateCompanion={vi.fn()} onApplications={vi.fn()} onAccount={vi.fn()}/>);
}

beforeEach(() => { window.history.replaceState({}, "", "/discussions/discussion-1"); localStorage.clear(); sessionStorage.clear(); });

describe("discussions workspace", () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("persists an explicit companion recipient and sends it with a stable request id", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    setupFetch((path, options) => {
      if (path.endsWith("/messages") && options?.method === "POST") { bodies.push(JSON.parse(String(options.body))); return response({ runId: "run-1", discussionId: discussion.id, companionId: "june" }); }
      return undefined;
    });
    const actor = userEvent.setup(); renderWorkspace();
    const recipient = await screen.findByRole("combobox", { name: "Message recipient" });
    await actor.selectOptions(recipient, "june");
    expect(localStorage.getItem("companions.build:discussion-target:user-1:discussion-1")).toBe("june");
    const composer = screen.getByRole("textbox", { name: "Message June" });
    await actor.type(composer, "Draft the announcement");
    await actor.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({ clientMessageId: expect.stringMatching(/^[0-9a-f-]{36}$/), content: "Draft the announcement", targetCompanionId: "june", attachmentCount: 0 });
  });

  it("selects an @ recipient by keyboard without sending and keeps the thread beside the workbench", async () => {
    const existing = { id: "existing", sequence: "1", role: "assistant" as const, content: "Existing context", companionId: null, runId: "run-existing", createdAt: discussion.createdAt, complete: true, files: [] };
    const fetchMock = setupFetch(path => path === "/api/discussions/discussion-1" ? response({ ...snapshot, messages: [existing] }) : undefined);
    const actor = userEvent.setup();
    renderWorkspace();
    const composer = await screen.findByRole("textbox", { name: "Message Companion" });
    await actor.type(composer, "Ask @Ad");
    const suggestions = screen.getByRole("listbox", { name: "Companion suggestions" });
    expect(composer).toHaveAttribute("aria-controls", suggestions.id);
    expect(document.getElementById(composer.getAttribute("aria-activedescendant")!)).toHaveAttribute("aria-selected", "true");
    await actor.keyboard("{Enter}");
    expect(composer).toHaveValue("Ask ");
    expect(screen.getByRole("textbox", { name: "Message Ada" })).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
    await actor.click(screen.getByRole("button", { name: "Ada" }));
    expect(await screen.findByRole("heading", { name: "Ada" })).toBeInTheDocument();
    expect(screen.getByText("Existing context")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message Ada" })).toBeInTheDocument();
  });

  it("downloads documents without opening a popup", async () => {
    const file = { id:"document-1", name:"result.txt", url:"/files/result.txt", mimeType:"text/plain", size:12 };
    setupFetch(path => path === "/api/discussions/discussion-1" ? response({ ...snapshot, messages:[{ id:"m1", sequence:"1", role:"assistant", content:"Ready", companionId:"ada", runId:"r1", createdAt:discussion.createdAt, complete:true, files:[file] }] }) : undefined);
    renderWorkspace();
    const link = await screen.findByRole("link", { name:"result.txt" });
    expect(link).toHaveAttribute("download", "result.txt");
    expect(link).not.toHaveAttribute("target");
  });

  it("preserves composing text and dismisses mentions without altering the draft", async () => {
    const fetchMock = setupFetch(); renderWorkspace();
    const composer = await screen.findByRole("textbox", { name: "Message Companion" });
    fireEvent.change(composer, { target: { value: "@Ad" } });
    fireEvent.keyDown(composer, { key: "Enter", isComposing: true });
    expect(composer).toHaveValue("@Ad");
    expect(screen.getByRole("combobox", { name: "Message recipient" })).toHaveValue("");
    fireEvent.keyDown(composer, { key: "Escape" });
    expect(composer).toHaveValue("@Ad");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
  });

  it("shows persisted companion files without changing the recipient or losing the draft", async () => {
    const file = { id: "file-1", name: "design.png", url: "/files/design.png", mimeType: "image/png", size: 123 };
    setupFetch(path => path === "/api/discussions/discussion-1" ? response({ ...snapshot, tasks: [{ id: "task-1", companionId: "ada", status: "succeeded", content: "Design", resultText: "Design ready", previewText: null, error: null, createdAt: discussion.createdAt, finishedAt: discussion.createdAt, files: [file], questions: [] }] }) : undefined);
    const actor = userEvent.setup(); renderWorkspace();
    const composer = await screen.findByRole("textbox", { name: "Message Companion" });
    await actor.type(composer, "Keep this draft");
    await actor.click(screen.getByRole("button", { name: "Ada" }));
    await actor.click(screen.getByRole("button", { name: /Files.*1/ }));
    const links = screen.getAllByRole("link", { name: "design.png" });
    expect(links.at(-1)).toHaveAttribute("href", "/files/design.png");
    expect(screen.getByRole("combobox", { name: "Message recipient" })).toHaveValue("");
    await actor.click(screen.getByRole("button", { name: "Close workbench" }));
    expect(composer).toHaveValue("Keep this draft");
  });

  it("opens later and removed participant workspaces from the mobile picker", async () => {
    const third = { ...ada, id: "third", name: "Third" };
    const removed = { ...ada, id: "removed", name: "Previous" };
    setupFetch(path => path === "/api/discussions/discussion-1" ? response({ ...snapshot, participants: [snapshot.participants[0], { companionId: june.id, companion: june, removedAt: null }, { companionId: third.id, companion: third, removedAt: null }, { companionId: removed.id, companion: removed, removedAt: discussion.createdAt }] }) : undefined);
    const actor = userEvent.setup(); renderWorkspace();
    const composer = await screen.findByRole("textbox", { name: "Message Companion" });
    await actor.type(composer, "A draft for Central");
    await actor.click(screen.getByLabelText("Choose discussion companion"));
    await actor.click(screen.getByRole("button", { name: "View Third workspace" }));
    expect(screen.getByRole("heading", { name: "Third" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Message recipient" })).toHaveValue("");
    await actor.click(screen.getByLabelText("Choose discussion companion"));
    await actor.click(screen.getByRole("button", { name: "View Previous workspace" }));
    expect(screen.getByRole("heading", { name: "Previous" })).toBeInTheDocument();
    expect(composer).toHaveValue("A draft for Central");
  });

  it("moves the active mention descendant while focus stays in the composer", async () => {
    setupFetch(); renderWorkspace();
    const composer = await screen.findByRole("textbox", { name: "Message Companion" });
    const actor = userEvent.setup(); await actor.type(composer, "@");
    const first = composer.getAttribute("aria-activedescendant");
    await actor.keyboard("{ArrowDown}");
    expect(composer).toHaveFocus();
    expect(composer.getAttribute("aria-activedescendant")).not.toBe(first);
    expect(document.getElementById(composer.getAttribute("aria-activedescendant")!)).toHaveTextContent("Ada");
  });

  it("loads older messages before the current snapshot without duplicating the page", async () => {
    const old = { id: "old", sequence: 4, role: "assistant", content: "Earlier", companionId: null, runId: "run-old", createdAt: "2026-09-11T08:00:00.000Z", complete: true, files: [] };
    const current = { ...old, id: "current", sequence: 55, content: "Current" };
    setupFetch((path) => {
      if (path === "/api/discussions/discussion-1") return response({ ...snapshot, messages: [current], beforeCursor: "55" });
      if (path === "/api/discussions/discussion-1?before=55") return response({ ...snapshot, messages: [old], beforeCursor: null });
      return undefined;
    });
    const actor = userEvent.setup(); renderWorkspace();
    expect(await screen.findByText("Current")).toBeInTheDocument();
    await actor.click(screen.getByRole("button", { name: /Load earlier messages/ }));
    expect(await screen.findByText("Earlier")).toBeInTheDocument();
    expect(screen.getAllByText("Current")).toHaveLength(1);
  });

  it("keeps stop chat and stop companion as separate admissions", async () => {
    const calls: string[] = [];
    setupFetch((path, options) => {
      if (path === "/api/discussions/discussion-1") return response({ ...snapshot, centralRuns: [{ id: "central-1", status: "running", previewText: "Planning", error: null, createdAt: discussion.createdAt, finishedAt: null }], tasks: [{ id: "task-1", companionId: "ada", status: "running", content: "Research", previewText: null, resultText: null, error: null, createdAt: discussion.createdAt, finishedAt: null, questions: [], files: [] }] });
      if (options?.method === "POST" && path.endsWith("/cancel")) { calls.push(path); return response({ ok: true }); }
      return undefined;
    });
    const actor = userEvent.setup(); renderWorkspace();
    await actor.click(await screen.findByRole("button", { name: "Stop chat" }));
    await actor.click(screen.getByRole("button", { name: "Stop Ada" }));
    expect(calls).toContain("/api/discussions/discussion-1/cancel");
    expect(calls).toContain("/api/discussions/discussion-1/participants/ada/cancel");
  });

  it("accepts dropped attachments and preserves their client ids when a send is retried", async () => {
    const uploadIds: string[] = []; let attempts = 0;
    setupFetch((path, options) => {
      if (path.endsWith("/messages") && options?.method === "POST") { attempts++; return attempts === 1 ? response({ error: "uncertain" }, 503) : response({ runId: "run-2", discussionId: discussion.id, companionId: null }); }
      if (path.endsWith("/files") && options?.method === "POST") { uploadIds.push(String((options.body as FormData).get("clientFileId"))); return response({ file: {} }); }
      return undefined;
    });
    const actor = userEvent.setup(); const { container } = renderWorkspace();
    const composer = await screen.findByRole("textbox", { name: "Message Companion" });
    const form = container.querySelector(".discussion-composer")!;
    const file = new File(["notes"], "notes.txt", { type: "text/plain" });
    fireEvent.drop(form, { dataTransfer: { files: [file] } });
    await actor.type(composer, "Read this");
    await actor.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByText("uncertain");
    await actor.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(uploadIds).toHaveLength(1));
    await waitFor(() => expect(sessionStorage.getItem("companions.build:discussion-draft:user-1:discussion-1")).toBeNull());
    expect(uploadIds[0]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("reattaches every saved file id at its immutable original position",async()=>{
    sessionStorage.setItem("companions.build:discussion-draft:user-1:discussion-1",JSON.stringify({attempted:true,content:"Retry files",targetCompanionId:null,clientMessageId:"11111111-1111-4111-8111-111111111111",files:[
      {id:"file-a",name:"same.txt",size:1,position:0},{id:"file-b",name:"same.txt",size:1,position:1},{id:"file-c",name:"last.txt",size:1,position:2},
    ]}));
    const uploads:Array<[string,string]>=[];
    setupFetch((path,options)=>{
      if(path.endsWith("/messages")&&options?.method==="POST")return response({runId:"run-files",discussionId:discussion.id,companionId:null});
      if(path.endsWith("/files")&&options?.method==="POST"){const body=options.body as FormData;uploads.push([String(body.get("clientFileId")),String(body.get("position"))]);return response({file:{}});}
      return undefined;
    });
    const actor=userEvent.setup(),{container}=renderWorkspace();await screen.findByRole("textbox",{name:"Message Companion"});
    fireEvent.drop(container.querySelector(".discussion-composer")!,{dataTransfer:{files:[new File(["x"],"last.txt"),new File(["a"],"same.txt"),new File(["b"],"same.txt")]}});
    await actor.click(screen.getByRole("button",{name:"Send message"}));
    await waitFor(()=>expect(uploads).toEqual([["file-a","0"],["file-b","1"],["file-c","2"]]));
  });
});

it('retains messages displaced by polling and orders large decimal sequences exactly',async()=>{
 let poll:(()=>void)|undefined;
 vi.spyOn(window,'setInterval').mockImplementation(((callback:TimerHandler,delay?:number)=>{if(delay===2500)poll=callback as ()=>void;return 42;}) as typeof window.setInterval);
 const message=(id:string,sequence:string)=>({id,sequence,role:'assistant' as const,content:id,companionId:null,runId:id,createdAt:discussion.createdAt,complete:true,files:[]});
 let snapshots=0;
 const fetchMock=setupFetch(path=>{
  if(path==='/api/discussions/discussion-1'){snapshots++;return response({...snapshot,messages:snapshots===1?[message('Current A','9007199254740993'),message('Current B','9007199254740994')]:[message('Current B','9007199254740994'),message('Newest','9007199254740995')],beforeCursor:'9007199254740993'});}
  if(path.endsWith('?before=9007199254740993'))return response({...snapshot,messages:[message('Older','9007199254740992')],beforeCursor:'9007199254740992'});
  if(path.endsWith('?before=9007199254740992'))return response({...snapshot,messages:[message('Oldest','1')],beforeCursor:null});
 });
 const actor=userEvent.setup(),view=renderWorkspace();await screen.findByText('Current A');
 await actor.click(screen.getByRole('button',{name:/Load earlier/}));await screen.findByText('Older');
 poll?.();await waitFor(()=>expect(fetchMock.mock.calls.filter(c=>c[0]==='/api/discussions/discussion-1').length).toBeGreaterThan(1));
 expect(screen.getByText('Current A')).toBeInTheDocument();expect(await screen.findByText('Newest')).toBeInTheDocument();
 expect([...view.container.querySelectorAll<HTMLElement>('.discussion-message')].map(node=>node.dataset.sequence)).toEqual(['9007199254740992','9007199254740993','9007199254740994','9007199254740995']);
 await actor.click(screen.getByRole('button',{name:/Load earlier/}));await screen.findByText('Oldest');
 expect(screen.queryByRole('button',{name:/Load earlier/})).not.toBeInTheDocument();
 cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();
});

it('shows a failed central turn and keeps companion work available in its own tab',async()=>{
 setupFetch(path=>path==='/api/discussions/discussion-1'?response({...snapshot,centralRuns:[{id:'failure',status:'interrupted',error:'Send a new message to continue.',previewText:null,createdAt:discussion.createdAt,finishedAt:discussion.createdAt}]}):undefined);
 const actor=userEvent.setup();renderWorkspace();
 expect(await screen.findByText('Send a new message to continue.')).toBeInTheDocument();
 await actor.click(screen.getByRole('button',{name:'Ada'}));
 expect(await screen.findByRole('heading',{name:'Ada'})).toBeInTheDocument();
 expect(screen.getByRole('textbox',{name:'Message Companion'})).toBeInTheDocument();
 cleanup();vi.unstubAllGlobals();
});


it('collapses earlier terminal failures while keeping current and concurrent failures visible', async () => {
 const task=(id:string,status:string,finishedAt:string|null)=>({id,companionId:'ada',status,content:id,previewText:null,resultText:null,error:status==='running'?null:`Error ${id}`,createdAt:'2026-09-11T09:00:00.000Z',finishedAt,questions:[],files:[]});
 const state={...snapshot,messages:[{id:'latest',sequence:'2',role:'user',content:'Try again',companionId:null,runId:'latest',createdAt:'2026-09-11T10:00:00.000Z',complete:true,files:[]}],tasks:[task('old-failure','failed','2026-09-11T09:30:00.000Z'),task('recent-failure','failed','2026-09-11T10:01:00.000Z'),task('still-running','running',null)],centralRuns:[{id:'old-central',status:'interrupted',previewText:null,error:'Old central failure',createdAt:'2026-09-11T09:00:00.000Z',finishedAt:'2026-09-11T09:30:00.000Z'}]};
 setupFetch(path=>path==='/api/discussions/discussion-1'?response(state):undefined);
 const actor=userEvent.setup(),view=renderWorkspace();
 const summary=await screen.findByText('Earlier activity (2)');
 const history=summary.closest('details')!;
 expect(history).not.toHaveAttribute('open');
 expect(within(history).getByText('Error old-failure')).toBeInTheDocument();
 expect(within(history).getByText('Old central failure')).toBeInTheDocument();
 expect(screen.getByText('Error recent-failure').closest('details')).toBeNull();
 expect(screen.getByRole('button',{name:'Stop Ada'})).toBeInTheDocument();
 await actor.click(summary);
 expect(history).toHaveAttribute('open');
 view.unmount();renderWorkspace();
 expect((await screen.findByText('Earlier activity (2)')).closest('details')).not.toHaveAttribute('open');
 cleanup();vi.unstubAllGlobals();
});


it('archives a folder discussion from the sidebar, restores it, and archives the selected discussion', async () => {
 const other={...discussion,id:'discussion-2',title:'Folder discussion',folderId:'folder-1'};
 let archivedAt:string|null=null;
 const updates:Array<unknown>=[];
 const fetchMock=setupFetch((path,options)=>{
  if(path==='/api/discussions/discussion-2'&&options?.method==='PATCH') { const body=JSON.parse(String(options.body)); updates.push(body);archivedAt=body.archived?discussion.createdAt:null;return response({discussion:{...other,archivedAt}}); }
  if(path==='/api/discussions'||path==='/api/discussions?archived=true')return response({discussions:[discussion,...(!archivedAt||path.includes('?')?[{...other,archivedAt}]:[])],folders:[{id:'folder-1',name:'Project',companionIds:[],createdAt:discussion.createdAt}]});
  if(path==='/api/discussions/discussion-2')return response({...snapshot,discussion:{...other,archivedAt}});
 });
 const actor=userEvent.setup();renderWorkspace();
 await actor.click(await screen.findByRole('button',{name:'Archive Folder discussion'}));
 await waitFor(()=>expect(screen.queryByRole('button',{name:'Archive Folder discussion'})).not.toBeInTheDocument());
 expect(screen.getByRole('heading',{name:'Launch'})).toBeInTheDocument();
 await actor.click(screen.getByRole('button',{name:'Archived discussions'}));
 await actor.click(await screen.findByRole('button',{name:/Folder discussion Archived.*Restore/}));
 expect(await screen.findByRole('heading',{name:'Folder discussion'})).toBeInTheDocument();
 await actor.click(screen.getByRole('button',{name:'Archive Folder discussion'}));
 expect(await screen.findByRole('heading',{name:'Launch'})).toBeInTheDocument();
 expect(updates).toEqual([{archived:true},{archived:false},{archived:true}]);
 expect(fetchMock.mock.calls.some(([path])=>String(path).endsWith('/cancel'))).toBe(false);
 cleanup();vi.unstubAllGlobals();
});


it('shows companion avatars next to inactive and folder discussion rows',async()=>{
 const other={...discussion,id:'other',title:'Other discussion',participantIds:['june'],folderId:'folder-1'};
 setupFetch(path=>path==='/api/discussions'?response({discussions:[{...discussion,participantIds:['ada']},other],folders:[{id:'folder-1',name:'Project',companionIds:[],createdAt:discussion.createdAt}]}):undefined);
 renderWorkspace();
 const sidebar=await screen.findByRole('complementary',{name:'Discussions'});
 expect(await within(sidebar).findByLabelText('Companions: Ada')).toBeInTheDocument();
 expect(within(sidebar).getByLabelText('Companions: June').closest('.discussion-row')).toHaveTextContent('Other discussion');
 expect(within(within(sidebar).getByLabelText('Companions: June')).getByRole('img',{name:'June, Companion'})).toBeInTheDocument();
 cleanup();vi.unstubAllGlobals();
});


it('lets Central present delegated results once while direct replies stay in the thread',async()=>{
 const message=(id:string,content:string,companionId:string|null,delegated=false)=>({id,sequence:id,role:'assistant',content,companionId,delegated,runId:id,createdAt:discussion.createdAt,complete:true,files:[]});
 setupFetch(path=>path==='/api/discussions/discussion-1'?response({...snapshot,messages:[message('1','Delegated detail','ada',true),message('2','Central summary',null),message('3','Direct answer','ada')],tasks:[{id:'1',companionId:'ada',status:'succeeded',content:'Research for Central',previewText:null,resultText:'Delegated detail',error:null,createdAt:discussion.createdAt,finishedAt:discussion.createdAt,questions:[],files:[]}]}):undefined);
 const actor=userEvent.setup();renderWorkspace();
 const timeline=await screen.findByRole('log');
 expect(await within(timeline).findByText('Central summary')).toBeInTheDocument();
 expect(within(timeline).getByText('Direct answer')).toBeInTheDocument();
 expect(within(timeline).queryByText('Delegated detail')).not.toBeInTheDocument();
 await actor.click(screen.getByRole('button',{name:'Ada'}));
 expect(await within(screen.getByRole('complementary',{name:'Ada workbench'})).findByText('Delegated detail')).toBeInTheDocument();
 cleanup();vi.unstubAllGlobals();
});


it('keeps older delegated responses inspectable when their tasks are outside the workbench page',async()=>{
 setupFetch(path=>path==='/api/discussions/discussion-1'?response({...snapshot,messages:[{id:'old',sequence:'1',role:'assistant',content:'Older delegated result',companionId:'ada',delegated:true,runId:'outside-task-window',createdAt:discussion.createdAt,complete:true,files:[]}]}):undefined);
 const actor=userEvent.setup();renderWorkspace();
 const summary=await screen.findByText('Earlier delegated response');
 expect(summary.closest('details')).not.toHaveAttribute('open');
 await actor.click(summary);
 expect(summary.closest('details')).toHaveAttribute('open');
 expect(screen.getByText('Older delegated result')).toBeInTheDocument();
 cleanup();vi.unstubAllGlobals();
});


it('returns from a companion to the discussion agent using only keyboard mentions',async()=>{
 const bodies:Array<Record<string,unknown>>=[];
 setupFetch((path,options)=>path.endsWith('/messages')&&options?.method==='POST'?(bodies.push(JSON.parse(String(options.body))),response({runId:'central-return',discussionId:discussion.id,companionId:null})):undefined);
 const actor=userEvent.setup();renderWorkspace();
 const composer=await screen.findByRole('textbox',{name:'Message Companion'});
 await actor.type(composer,'@Ad');await actor.keyboard('{Enter}');
 expect(screen.getByRole('combobox',{name:'Message recipient'})).toHaveValue('ada');
 await actor.type(composer,'merci. @Comp');
 const option=screen.getByRole('option',{name:/Companion Coordinates this discussion/});
 expect(composer).toHaveAttribute('aria-activedescendant',option.id);
 await actor.keyboard('{Enter}');
 expect(screen.getByRole('combobox',{name:'Message recipient'})).toHaveValue('');
 expect(screen.getByRole('textbox',{name:'Message Companion'})).toHaveFocus();
 expect(bodies).toHaveLength(0);
 await actor.type(composer,'reprends la suite');await actor.keyboard('{Enter}');
 await waitFor(()=>expect(bodies).toHaveLength(1));
 expect(bodies[0]).toMatchObject({content:'merci. reprends la suite',targetCompanionId:null});
 expect(localStorage.getItem('companions.build:discussion-target:user-1:discussion-1')).toBeNull();
 cleanup();vi.unstubAllGlobals();
});

it('uses the last complete mention without changing the work being inspected',async()=>{
 setupFetch();const actor=userEvent.setup();renderWorkspace();
 await actor.click(await screen.findByRole('button',{name:'Ada'}));
 const composer=screen.getByRole('textbox',{name:'Message Companion'});
 fireEvent.change(composer,{target:{value:'@Ada continue puis @Companion, résume'}});
 expect(screen.getByRole('complementary',{name:'Ada workbench'})).toBeInTheDocument();
 expect(screen.getByRole('combobox',{name:'Message recipient'})).toHaveValue('');
 fireEvent.change(composer,{target:{value:'@Companion merci. @Ada continue'}});
 expect(screen.getByRole('combobox',{name:'Message recipient'})).toHaveValue('ada');
 cleanup();vi.unstubAllGlobals();
});


it('retries a failed message ending in @Companion with Enter and unchanged routing',async()=>{
 const bodies:Array<Record<string,unknown>>=[];
 setupFetch((path,options)=>{
  if(path.endsWith('/messages')&&options?.method==='POST'){bodies.push(JSON.parse(String(options.body)));return bodies.length===1?response({error:'Temporary send failure'},503):response({runId:'retry-mention',discussionId:discussion.id,companionId:null});}
 });
 const actor=userEvent.setup();renderWorkspace();
 const composer=await screen.findByRole('textbox',{name:'Message Companion'});
 await actor.type(composer,'Help @Companion');
 await actor.click(screen.getByRole('button',{name:'Send message'}));
 await screen.findByText('Temporary send failure');
 expect(screen.queryByRole('listbox',{name:'Companion suggestions'})).not.toBeInTheDocument();
 await actor.click(composer);await actor.keyboard('{Enter}');
 await waitFor(()=>expect(bodies).toHaveLength(2));
 expect(bodies[1]).toEqual(bodies[0]);
 expect(bodies[1].targetCompanionId).toBeNull();
 cleanup();vi.unstubAllGlobals();
});

describe("clear addressing and persisted activity", () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("keeps an explicit recipient selection when editing text containing an older mention", async () => {
    setupFetch(); const actor = userEvent.setup(); renderWorkspace();
    const composer = await screen.findByRole("textbox", { name: "Message Companion" });
    fireEvent.change(composer, { target: { value: "@Ada research this" } });
    expect(screen.getByRole("combobox", { name: "Message recipient" })).toHaveValue("ada");
    await actor.selectOptions(screen.getByRole("combobox", { name: "Message recipient" }), "june");
    await actor.type(composer, " carefully");
    expect(screen.getByRole("combobox", { name: "Message recipient" })).toHaveValue("june");
    expect(screen.getByRole("textbox", { name: "Message June" })).toHaveValue("@Ada research this carefully");
  });

  it("restores an uncertain central send without applying an unrelated saved recipient", async () => {
    sessionStorage.setItem("companions.build:discussion-draft:user-1:discussion-1", JSON.stringify({ attempted: true, content: "Continue planning", targetCompanionId: null, clientMessageId: "11111111-1111-4111-8111-111111111111", files: [] }));
    localStorage.setItem("companions.build:discussion-target:user-1:discussion-1", "ada");
    const bodies: Array<Record<string, unknown>> = [];
    setupFetch((path, options) => path.endsWith("/messages") && options?.method === "POST" ? (bodies.push(JSON.parse(String(options.body))), response({ runId: "retry", discussionId: discussion.id, companionId: null })) : undefined);
    const actor = userEvent.setup(); renderWorkspace();
    expect(await screen.findByRole("textbox", { name: "Message Companion" })).toHaveValue("Continue planning");
    await actor.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ clientMessageId: "11111111-1111-4111-8111-111111111111", targetCompanionId: null });
  });

  it("shows task reception, progress and completion from successive snapshots without navigating away", async () => {
    let poll: (() => void) | undefined;
    vi.spyOn(window, "setInterval").mockImplementation(((callback: TimerHandler, delay?: number) => { if (delay === 2500) poll = callback as () => void; return 42; }) as typeof window.setInterval);
    let status = "queued";
    setupFetch(path => path === "/api/discussions/discussion-1" ? response({ ...snapshot, tasks: [{ id: "delegation", companionId: "ada", status, content: "Compare the three suppliers", previewText: status === "running" ? "Reading supplier documentation" : null, resultText: status === "succeeded" ? "Supplier B meets the requirements." : null, error: null, createdAt: discussion.createdAt, finishedAt: status === "succeeded" ? discussion.createdAt : null, files: [], questions: [] }] }) : undefined);
    renderWorkspace();
    const activity = await screen.findByRole("complementary", { name: "Discussion activity" });
    expect(within(activity).getByText("Task received")).toBeInTheDocument();
    expect(within(activity).queryByText("Completed")).not.toBeInTheDocument();
    status = "running"; poll?.();
    expect(await within(activity).findByText("Reading supplier documentation")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message Companion" })).toBeInTheDocument();
    status = "succeeded"; poll?.();
    expect(await within(activity).findByText("Completed")).toBeInTheDocument();
    expect(within(activity).getByText("Supplier B meets the requirements.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop Ada" })).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Ada workbench" })).not.toBeInTheDocument();
  });

  it("puts a question ahead of an agent's completed work and keeps it answerable", async () => {
    const task = { companionId: "ada", content: "Research suppliers", previewText: null, resultText: null, error: null, createdAt: discussion.createdAt, finishedAt: null, files: [] };
    setupFetch(path => path === "/api/discussions/discussion-1" ? response({ ...snapshot, tasks: [
      { ...task, id: "newer", status: "succeeded", createdAt: "2026-09-11T10:00:00Z", questions: [], resultText: "A different task is done" },
      { ...task, id: "waiting", status: "needs_input", questions: [{ id: "q", question: "Which market should I cover?", options: ["France", "Europe"], answer: null }] },
    ] }) : undefined);
    renderWorkspace();
    const activity = await screen.findByRole("complementary", { name: "Discussion activity" });
    expect(within(activity).getByText("Needs your answer")).toBeInTheDocument();
    expect(within(activity).getByText("Which market should I cover?")).toBeInTheDocument();
    expect(within(screen.getByRole("log")).getByRole("button", { name: "France" })).toBeInTheDocument();
  });

  it("acknowledges a stop request without claiming the task has already stopped", async () => {
    setupFetch((path, options) => {
      if (path.endsWith("/cancel") && options?.method === "POST") return response({ ok: true });
      if (path === "/api/discussions/discussion-1") return response({ ...snapshot, centralRuns: [{ id: "central", status: "running", previewText: null, error: null, createdAt: discussion.createdAt, finishedAt: null }] });
    });
    const actor = userEvent.setup(); renderWorkspace();
    await actor.click(await screen.findByRole("button", { name: "Stop chat" }));
    expect(await screen.findByText("Stop requested")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop chat" })).toBeDisabled();
    expect(screen.getByText("Companion · Working")).toBeInTheDocument();
    expect(screen.queryByText("Stopped")).not.toBeInTheDocument();
  });
});

it("keeps an accepted answer disabled until the persisted question disappears", async () => {
  let resolveAnswer!: (value: Response) => void;
  const fetchMock = setupFetch((path) => {
    if (path.endsWith('/questions/question-1/answer')) return new Promise(resolve => { resolveAnswer = resolve; });
    if (path === '/api/discussions/discussion-1') return response({ ...snapshot, tasks: [{
      id:'task-1',companionId:'ada',status:'needs_input',content:'Choose a direction',previewText:null,resultText:null,error:null,
      createdAt:discussion.createdAt,finishedAt:null,files:[],questions:[{id:'question-1',question:'Which audience?',options:['Customers'],answer:null}],
    }] });
  });
  renderWorkspace();
  const choice = await screen.findByRole('button',{name:'Customers'});
  fireEvent.click(choice);
  expect(choice).toBeDisabled();
  fireEvent.click(choice);
  expect(fetchMock.mock.calls.filter(([path]) => String(path).endsWith('/questions/question-1/answer'))).toHaveLength(1);
  resolveAnswer(new Response(JSON.stringify({ok:true}),{headers:{'content-type':'application/json'}}));
  expect(await screen.findByText('Answer received.')).toBeInTheDocument();
  expect(choice).toBeDisabled();
});


it("keeps the archive modal isolated when navigation crosses its responsive breakpoint", async () => {
  let change = () => {};
  const query = { matches: true, addEventListener: (_: string, listener: () => void) => { change = listener; }, removeEventListener: () => {} };
  vi.stubGlobal("matchMedia", () => query);
  setupFetch(path => path === "/api/discussions?archived=true" ? response({ discussions: [], folders: [] }) : undefined);
  const view = renderWorkspace();
  await screen.findByRole("heading", { name: "Launch" });
  const main = view.container.querySelector<HTMLElement>(".discussion-main")!;
  fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
  fireEvent.click(screen.getByRole("button", { name: "Archived discussions" }));
  const archives = await screen.findByRole("dialog", { name: "Archived discussions" });
  expect(main.inert).toBe(true);
  act(() => { query.matches = false; change(); });
  expect(main.inert).toBe(true);
  act(() => { query.matches = true; change(); });
  expect(archives.inert).not.toBe(true);
  expect(archives.contains(document.activeElement)).toBe(true);
  expect(main.inert).toBe(true);
  act(() => { query.matches = false; change(); });
  fireEvent.click(within(archives).getByRole("button", { name: "Close archived discussions" }));
  expect(main.inert).not.toBe(true);
  cleanup(); vi.unstubAllGlobals();
});
