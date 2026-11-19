import {act,render,screen,waitFor,within} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {afterEach,expect,it,vi} from "vitest";
import {workspaceApi} from "@/api";
import {ConnectionsPage} from "./WorkspaceConnections";

afterEach(()=>vi.restoreAllMocks());

it("keeps the latest connections when an older OAuth reload finishes last",async()=>{
 const linear={id:"linear",name:"Linear",provider:"linear",available:true};
 const parallel={id:"ai.parallel/mcp",name:"Parallel Search",provider:"parallel",kind:"remote" as const,available:true};
 const catalog=[linear,parallel];
 const work={id:"work",serverId:linear.id,label:"Work",provider:"linear",healthStatus:"ok" as const,healthCode:null,checkedAt:null};
 const search={id:"parallel",serverId:parallel.id,label:"Default",provider:"parallel",healthStatus:"unchecked" as const,healthCode:null,checkedAt:null};
 let finishOAuthReload!:(value:Awaited<ReturnType<typeof workspaceApi.plugins>>)=>void;
 vi.spyOn(workspaceApi,"plugins").mockResolvedValueOnce({catalog,accounts:[]})
  .mockImplementationOnce(()=>new Promise(resolve=>{finishOAuthReload=resolve;}))
  .mockResolvedValueOnce({catalog,accounts:[work,search]});
 vi.spyOn(workspaceApi,"connectPlugin").mockResolvedValueOnce({url:"https://oauth.example/linear"}).mockResolvedValueOnce({account:search});
 const popup={closed:false,location:{href:""},close:vi.fn()};
 vi.spyOn(window,"open").mockReturnValue(popup as unknown as Window);
 const actor=userEvent.setup();
 render(<ConnectionsPage onBack={vi.fn()}/>);
 await actor.click(within(await screen.findByRole("article",{name:"Linear"})).getByRole("button",{name:"Connect"}));
 await actor.type(screen.getByLabelText("Account name"),"Work");
 await actor.click(screen.getByRole("button",{name:"Connect account"}));
 await waitFor(()=>expect(popup.location.href).toBe("https://oauth.example/linear"));
 await act(async()=>window.dispatchEvent(new MessageEvent("message",{
  origin:window.location.origin,source:popup as unknown as Window,data:{type:"companions:plugin-oauth",status:"connected"},
 })));
 const card=within(screen.getByRole("article",{name:"Parallel Search"}));
 await actor.click(card.getByRole("button",{name:"Connect"}));
 expect(await card.findByText("Default")).toBeInTheDocument();
 await act(async()=>finishOAuthReload({catalog,accounts:[work]}));
 expect(card.getByText("Default")).toBeInTheDocument();
});

it("adds an anonymous connection without opening an OAuth window",async()=>{
 const server={id:"ai.parallel/mcp",name:"Parallel Search",provider:"parallel",kind:"remote" as const,available:true,description:"Search queries and page URLs go to Parallel."};
 const linear={id:"linear",name:"Linear",provider:"linear",available:true};
 const catalog=[linear,server];
 const account={id:"parallel",serverId:server.id,label:"Default",provider:"parallel",healthStatus:"unchecked" as const,healthCode:null,checkedAt:null};
 let finishReload!:(value:Awaited<ReturnType<typeof workspaceApi.plugins>>)=>void;
 vi.spyOn(workspaceApi,"plugins").mockResolvedValueOnce({catalog,accounts:[]})
  .mockImplementationOnce(()=>new Promise(resolve=>{finishReload=resolve;}));
 let finishConnect!:(value:Awaited<ReturnType<typeof workspaceApi.connectPlugin>>)=>void;
 const connect=vi.spyOn(workspaceApi,"connectPlugin").mockImplementation(()=>new Promise(resolve=>{finishConnect=resolve;}));
 const open=vi.spyOn(window,"open");
 const actor=userEvent.setup();render(<ConnectionsPage onBack={vi.fn()}/>);
 expect(await screen.findByText(server.description)).toBeInTheDocument();
 await actor.click(within(screen.getByRole("article",{name:"Linear"})).getByRole("button",{name:"Connect"}));
 await actor.type(screen.getByLabelText("Account name"),"Linear workspace");
 const card=within(screen.getByRole("article",{name:"Parallel Search"}));
 const button=card.getByRole("button",{name:"Connect"});
 await actor.click(button);
 expect(connect).toHaveBeenCalledWith(server.id,"");
 expect(screen.queryByRole("button",{name:"Connect account"})).not.toBeInTheDocument();
 expect(button).toBeDisabled();
 finishConnect({account});
 await waitFor(()=>expect(finishReload).toBeDefined());
 expect(button).toBeDisabled();
 finishReload({catalog,accounts:[account]});
 expect(await screen.findByText("Connection added.")).toBeInTheDocument();
 expect(await screen.findByText("Default")).toBeInTheDocument();
 expect(card.queryByRole("button",{name:/^(Connect|Add account)$/})).not.toBeInTheDocument();
 expect(open).not.toHaveBeenCalled();
});

it("opens OAuth synchronously and reloads only for a trusted completion",async()=>{
 const server={id:"linear",name:"Linear",provider:"linear",available:true};
 const account={id:"work",serverId:"linear",label:"Work",provider:"linear",healthStatus:"ok" as const,healthCode:null,checkedAt:null};
 let connected=false,resolveConnect!:(value:{url:string})=>void;
 const plugins=vi.spyOn(workspaceApi,"plugins").mockImplementation(async()=>({catalog:[server],accounts:connected?[account]:[]}));
 vi.spyOn(workspaceApi,"connectPlugin").mockImplementation(()=>new Promise(resolve=>{resolveConnect=resolve;}));
 const popup={closed:false,location:{href:""},close:vi.fn()};const open=vi.spyOn(window,"open").mockReturnValue(popup as unknown as Window);
 const actor=userEvent.setup();render(<ConnectionsPage onBack={vi.fn()}/>);
 await actor.click(await screen.findByRole("button",{name:"Connect"}));
 await actor.type(screen.getByLabelText("Account name"),"Work");
 await actor.click(screen.getByRole("button",{name:"Connect account"}));
 expect(open).toHaveBeenCalledWith("about:blank","companions-plugin-oauth","popup,width=620,height=760");
 expect(popup.location.href).toBe("");
 resolveConnect({url:"https://oauth.example/linear"});await waitFor(()=>expect(popup.location.href).toBe("https://oauth.example/linear"));
 window.dispatchEvent(new MessageEvent("message",{origin:"https://attacker.invalid",source:popup as unknown as Window,data:{type:"companions:plugin-oauth",status:"connected"}}));
 expect(plugins).toHaveBeenCalledTimes(1);
 connected=true;window.dispatchEvent(new MessageEvent("message",{origin:window.location.origin,source:popup as unknown as Window,data:{type:"companions:plugin-oauth",status:"connected"}}));
 expect(await screen.findByText("Connection added.")).toBeInTheDocument();
 await waitFor(()=>expect(plugins).toHaveBeenCalledTimes(2));
 expect(await screen.findByText("Work")).toBeInTheDocument();
});
