import {render,screen,waitFor,within} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {afterEach,expect,it,vi} from "vitest";
import {workspaceApi,type PluginAccount,type PluginServer} from "@/api";
import {ConnectionsPage} from "./WorkspaceConnections";

afterEach(()=>vi.restoreAllMocks());

const gmail:PluginServer={id:"composio:gmail",provider:"composio",kind:"composio",toolkit:"gmail",name:"Gmail",description:"Read, search and draft email",logo:"https://logos.example/gmail.svg",available:true};
const git:PluginServer={id:"io.github.github/github-mcp-server",provider:"github",name:"GitHub (git access)",kind:"native",description:"Lets git clone and push from the Companion computer.",available:true};
const account=(input:Partial<PluginAccount>):PluginAccount=>({id:"work",serverId:"composio:gmail",label:"Work",provider:"composio",appName:"Gmail",appLogo:"https://logos.example/gmail.svg",healthStatus:"ok",healthCode:null,checkedAt:null,...input});

it("opens OAuth synchronously and reloads only for a trusted completion",async()=>{
 let connected=false,resolveConnect!:(value:{url:string})=>void;
 const plugins=vi.spyOn(workspaceApi,"plugins").mockImplementation(async()=>({catalog:[gmail],accounts:connected?[account({})]:[]}));
 vi.spyOn(workspaceApi,"connectPlugin").mockImplementation(()=>new Promise(resolve=>{resolveConnect=resolve;}));
 const popup={closed:false,location:{href:""},close:vi.fn()};const open=vi.spyOn(window,"open").mockReturnValue(popup as unknown as Window);
 const actor=userEvent.setup();render(<ConnectionsPage onBack={vi.fn()}/>);
 await actor.click(await screen.findByRole("button",{name:"Connect"}));
 await actor.type(screen.getByLabelText("Account name"),"Work");
 await actor.click(screen.getByRole("button",{name:"Connect account"}));
 expect(open).toHaveBeenCalledWith("about:blank","companions-plugin-oauth","popup,width=620,height=760");
 expect(workspaceApi.connectPlugin).toHaveBeenCalledWith("composio:gmail","Work");
 expect(popup.location.href).toBe("");
 resolveConnect({url:"https://oauth.example/gmail"});await waitFor(()=>expect(popup.location.href).toBe("https://oauth.example/gmail"));
 window.dispatchEvent(new MessageEvent("message",{origin:"https://attacker.invalid",source:popup as unknown as Window,data:{type:"companions:plugin-oauth",status:"connected"}}));
 expect(plugins).toHaveBeenCalledTimes(1);
 connected=true;window.dispatchEvent(new MessageEvent("message",{origin:window.location.origin,source:popup as unknown as Window,data:{type:"companions:plugin-oauth",status:"connected"}}));
 expect(await screen.findByText("Connection added.")).toBeInTheDocument();
 await waitFor(()=>expect(plugins).toHaveBeenCalledTimes(2));
 expect(await screen.findByText("Work")).toBeInTheDocument();
});

it("shows featured apps with server logos, keeps non-featured accounts, and separates git access",async()=>{
 const hubspot=account({id:"crm",serverId:"composio:hubspot",label:"Sales",appName:"HubSpot",appLogo:"https://logos.example/hubspot.png",healthStatus:"error",healthCode:"authorization_required"});
 const custom=account({id:"internal",serverId:null,label:"Internal tools",provider:"custom",appName:null,appLogo:null});
 const gitAccount=account({id:"repos",serverId:git.id,label:"the-vibe-company",provider:"github",appName:null,appLogo:null});
 vi.spyOn(workspaceApi,"plugins").mockResolvedValue({catalog:[gmail,git],accounts:[hubspot,custom,gitAccount]});
 const connect=vi.spyOn(workspaceApi,"connectPlugin").mockResolvedValue({url:"https://oauth.example/hubspot"});
 vi.spyOn(window,"open").mockReturnValue({closed:false,location:{href:""},close:vi.fn()} as unknown as Window);
 const actor=userEvent.setup();const view=render(<ConnectionsPage onBack={vi.fn()}/>);
 const apps=await screen.findByRole("region",{name:"Apps"});
 const gmailCard=within(apps).getByRole("article",{name:"Gmail"});
 expect(within(gmailCard).getByText("Read, search and draft email")).toBeInTheDocument();
 expect(gmailCard.querySelector("img")).toHaveAttribute("src","https://logos.example/gmail.svg");
 const hubspotCard=within(apps).getByRole("article",{name:"HubSpot"});
 expect(hubspotCard.querySelector("img")).toHaveAttribute("src","https://logos.example/hubspot.png");
 expect(within(hubspotCard).getByText("Reconnect required")).toBeInTheDocument();
 expect(within(apps).getByRole("article",{name:"Custom MCP"})).toHaveTextContent("Internal tools");
 expect(within(apps).queryByRole("article",{name:"GitHub (git access)"})).not.toBeInTheDocument();
 const gitSection=screen.getByRole("region",{name:"Git access"});
 expect(within(gitSection).getByRole("article",{name:"GitHub (git access)"})).toHaveTextContent("the-vibe-company");
 expect(view.container.textContent).not.toContain("Issues, projects, cycles");
 await actor.click(within(hubspotCard).getByRole("button",{name:"Reconnect"}));
 expect(connect).toHaveBeenCalledWith("composio:hubspot","Sales");
});

it("searches the full catalog after two characters and returns to featured apps when cleared",async()=>{
 vi.spyOn(workspaceApi,"plugins").mockResolvedValue({catalog:[gmail],accounts:[account({id:"team",serverId:"composio:slack",label:"Team",appName:"Slack",appLogo:null})]});
 const slack:PluginServer={id:"composio:slack",provider:"composio",kind:"composio",toolkit:"slack",name:"Slack",description:"Channels and messages",available:true};
 const slab:PluginServer={id:"composio:slab",provider:"composio",kind:"composio",toolkit:"slab",name:"Slab",available:true};
 const search=vi.spyOn(workspaceApi,"searchToolkits").mockImplementation(async(_query,cursor)=>cursor?{items:[slab],nextCursor:null}:{items:[slack],nextCursor:"page-2"});
 const actor=userEvent.setup();render(<ConnectionsPage onBack={vi.fn()}/>);
 const input=await screen.findByRole("searchbox",{name:"Search apps"});
 await actor.type(input,"s");
 await new Promise(resolve=>setTimeout(resolve,300));
 expect(search).not.toHaveBeenCalled();
 await actor.type(input,"l");
 const results=await screen.findByRole("region",{name:"Search results"});
 expect(search).toHaveBeenCalledExactlyOnceWith("sl",undefined,expect.any(AbortSignal));
 expect(within(results).getByRole("article",{name:"Slack"})).toHaveTextContent("Team");
 expect(within(results).getByText("Channels and messages")).toBeInTheDocument();
 expect(screen.queryByRole("article",{name:"Gmail"})).not.toBeInTheDocument();
 await actor.click(screen.getByRole("button",{name:"Show more apps"}));
 expect(await within(results).findByRole("article",{name:"Slab"})).toBeInTheDocument();
 expect(search).toHaveBeenLastCalledWith("sl","page-2",expect.any(AbortSignal));
 await actor.clear(input);
 expect(await screen.findByRole("article",{name:"Gmail"})).toBeInTheDocument();
 expect(screen.queryByRole("region",{name:"Search results"})).not.toBeInTheDocument();
});
