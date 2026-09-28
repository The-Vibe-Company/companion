import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { workspaceApi, type PluginAccount } from "@/api";
import { ApplicationAccess } from "./ApplicationAccess";

const linearWork:PluginAccount={id:"linear-work",serverId:"composio:linear",label:"Work workspace",provider:"composio",appName:"Linear",appLogo:"https://logos.example/linear.svg",healthStatus:"ok",healthCode:null,checkedAt:null};
const linearPersonal:PluginAccount={...linearWork,id:"linear-personal",label:"Personal workspace"};
const github:PluginAccount={...linearWork,id:"github-work",serverId:"composio:github",label:"the-vibe-company",appName:"GitHub",appLogo:null};
const plugins={accounts:[linearWork,linearPersonal,github],catalog:[
  {id:"composio:linear",name:"Linear",provider:"composio",kind:"composio" as const,toolkit:"linear",logo:"https://logos.example/linear.svg",available:true},
  {id:"composio:github",name:"GitHub",provider:"composio",kind:"composio" as const,toolkit:"github",available:true},
]};

afterEach(()=>vi.restoreAllMocks());

describe("ApplicationAccess",()=>{
  it("does not let a late StrictMode load undo a completed grant",async()=>{
    let resolveOld!:(value:{accounts:PluginAccount[]})=>void;
    vi.spyOn(workspaceApi,"plugins").mockResolvedValue(plugins);
    vi.spyOn(workspaceApi,"companionPlugins")
      .mockImplementationOnce(()=>new Promise(resolve=>{resolveOld=resolve;}))
      .mockResolvedValueOnce({accounts:[]})
      .mockResolvedValue({accounts:[linearWork]});
    const grant=vi.spyOn(workspaceApi,"selectPlugin").mockResolvedValue({ok:true});
    render(<StrictMode><ApplicationAccess companionId="ada"/></StrictMode>);
    const checkbox=await screen.findByRole("checkbox",{name:"Work workspace"});
    fireEvent.click(checkbox);
    await waitFor(()=>expect(checkbox).toBeChecked());
    await act(async()=>{resolveOld({accounts:[]});});
    expect(checkbox).toBeChecked();
    expect(grant).toHaveBeenCalledExactlyOnceWith("ada","linear-work");
  });

  it("ignores a load from the previous companion after switching identity",async()=>{
    let resolveOld!:(value:{accounts:PluginAccount[]})=>void;
    vi.spyOn(workspaceApi,"plugins").mockResolvedValue(plugins);
    vi.spyOn(workspaceApi,"companionPlugins")
      .mockImplementationOnce(()=>new Promise(resolve=>{resolveOld=resolve;}))
      .mockResolvedValue({accounts:[linearWork]});
    const view=render(<ApplicationAccess companionId="ada"/>);
    view.rerender(<ApplicationAccess companionId="grace"/>);
    const checkbox=await screen.findByRole("checkbox",{name:"Work workspace"});
    expect(checkbox).toBeChecked();
    await act(async()=>{resolveOld({accounts:[]});});
    expect(checkbox).toBeChecked();
  });

  it("keeps distinct custom MCP servers separate", async () => {
    const first={...linearWork,id:"internal",serverId:null,provider:"custom",appName:null,appLogo:null,label:"Internal tools"};
    const second={...linearWork,id:"reports",serverId:null,provider:"custom",appName:null,appLogo:null,label:"Reports"};
    vi.spyOn(workspaceApi,"plugins").mockResolvedValue({catalog:[],accounts:[first,second]});
    vi.spyOn(workspaceApi,"companionPlugins").mockResolvedValue({accounts:[first]});
    render(<ApplicationAccess companionId="ada"/>);
    expect(await screen.findByRole("heading",{name:"Internal tools"})).toBeInTheDocument();
    expect(screen.getByRole("heading",{name:"Reports"})).toBeInTheDocument();
    expect(screen.getByRole("checkbox",{name:"Internal tools"})).toBeChecked();
    expect(screen.getByRole("checkbox",{name:"Reports"})).not.toBeChecked();
  });

  it("names and marks Composio accounts outside the featured catalog from the account", async () => {
    const notion:PluginAccount={...linearWork,id:"notion-docs",serverId:"composio:notion",label:"Docs",appName:"Notion",appLogo:"https://logos.example/notion.png"};
    const hubspot:PluginAccount={...linearWork,id:"crm",serverId:"composio:hubspot",label:"Sales",appName:"HubSpot",appLogo:null};
    vi.spyOn(workspaceApi,"plugins").mockResolvedValue({catalog:plugins.catalog,accounts:[linearWork,notion,hubspot]});
    vi.spyOn(workspaceApi,"companionPlugins").mockResolvedValue({accounts:[notion]});
    const view=render(<ApplicationAccess companionId="ada"/>);
    expect(await screen.findByRole("heading",{name:"Notion"})).toBeInTheDocument();
    expect(screen.getByRole("heading",{name:"HubSpot"})).toBeInTheDocument();
    expect(screen.getByRole("heading",{name:"Linear"})).toBeInTheDocument();
    expect(screen.getByRole("checkbox",{name:"Docs"})).toBeChecked();
    expect(view.container.querySelector('img[src="https://logos.example/notion.png"]')).toHaveAttribute("alt","Notion");
    expect(view.container.querySelector('img[src="https://logos.example/linear.svg"]')).toHaveAttribute("alt","Linear");
  });

  it("groups several accounts per provider and grants each account separately",async()=>{
    let selected=[linearWork];
    vi.spyOn(workspaceApi,"plugins").mockResolvedValue(plugins);
    vi.spyOn(workspaceApi,"companionPlugins").mockImplementation(async()=>({accounts:selected}));
    const grant=vi.spyOn(workspaceApi,"selectPlugin").mockImplementation(async(_id,accountId)=>{selected=[...selected,plugins.accounts.find(account=>account.id===accountId)!];return {ok:true};});
    vi.spyOn(workspaceApi,"unselectPlugin");
    const user=userEvent.setup();render(<ApplicationAccess companionId="ada"/>);

    expect(await screen.findByRole("heading",{name:"Linear"})).toBeInTheDocument();
    expect(screen.getByRole("heading",{name:"GitHub"})).toBeInTheDocument();
    expect(screen.getByText("1 of 2")).toBeInTheDocument();
    expect(screen.getByRole("checkbox",{name:"Work workspace"})).toBeChecked();
    expect(screen.getByRole("checkbox",{name:"Personal workspace"})).not.toBeChecked();
    fireEvent.click(screen.getByRole("checkbox",{name:"Personal workspace"}));
    fireEvent.click(screen.getByRole("checkbox",{name:"Personal workspace"}));
    await waitFor(()=>expect(grant).toHaveBeenCalledTimes(1));
    await waitFor(()=>expect(screen.getByRole("checkbox",{name:"Personal workspace"})).toBeChecked());
    expect(screen.getByRole("checkbox",{name:"the-vibe-company"})).not.toBeChecked();
    expect(screen.getByText("2 of 2")).toBeInTheDocument();
  });

  it("disables every account while pending, reloads truth after failure, and retries",async()=>{
    let selected:PluginAccount[]=[];let rejectFirst!:(cause:Error)=>void;let attempts=0;
    vi.spyOn(workspaceApi,"plugins").mockResolvedValue(plugins);
    vi.spyOn(workspaceApi,"companionPlugins").mockImplementation(async()=>({accounts:selected}));
    vi.spyOn(workspaceApi,"selectPlugin").mockImplementation(async(_id,accountId)=>{attempts+=1;if(attempts===1)return new Promise((_resolve,reject)=>{rejectFirst=reject;});selected=[plugins.accounts.find(account=>account.id===accountId)!];return {ok:true};});
    vi.spyOn(workspaceApi,"unselectPlugin");
    const user=userEvent.setup();render(<ApplicationAccess companionId="ada"/>);
    const target=await screen.findByRole("checkbox",{name:"Work workspace"});
    fireEvent.click(target);
    await waitFor(()=>expect(screen.getAllByRole("checkbox").every(input=>(input as HTMLInputElement).disabled)).toBe(true));
    rejectFirst(new Error("Grant could not be saved."));
    expect(await screen.findByRole("alert")).toHaveTextContent("Grant could not be saved.");
    expect(target).not.toBeChecked();
    await user.click(target);
    await waitFor(()=>expect(target).toBeChecked());
    expect(attempts).toBe(2);
  });

  it("offers retry after load failure and the real connection action when empty",async()=>{
    vi.spyOn(workspaceApi,"plugins").mockRejectedValueOnce(new Error("Applications unavailable.")).mockResolvedValue({accounts:[],catalog:[]});
    vi.spyOn(workspaceApi,"companionPlugins").mockResolvedValue({accounts:[]});
    const onConnect=vi.fn();const user=userEvent.setup();render(<ApplicationAccess companionId="ada" onConnect={onConnect}/>);
    expect(await screen.findByRole("alert")).toHaveTextContent("Applications unavailable.");
    await user.click(screen.getByRole("button",{name:"Try again"}));
    await user.click(await screen.findByRole("button",{name:"Connect an account"}));
    expect(onConnect).toHaveBeenCalledOnce();
  });

  it("connects a provider inside a draft and then grants the persisted account",async()=>{
    let connected=false;let selected:PluginAccount[]=[];
    vi.spyOn(workspaceApi,"plugins").mockImplementation(async()=>({catalog:plugins.catalog,accounts:connected?[linearWork]:[]}));
    vi.spyOn(workspaceApi,"companionPlugins").mockImplementation(async()=>({accounts:selected}));
    vi.spyOn(workspaceApi,"connectPlugin").mockResolvedValue({url:"https://oauth.example/linear"});
    const grant=vi.spyOn(workspaceApi,"selectPlugin").mockImplementation(async()=>{selected=[linearWork];return {ok:true};});
    const popup={closed:false,location:{href:""},close:vi.fn()};vi.spyOn(window,"open").mockReturnValue(popup as unknown as Window);
    const user=userEvent.setup();render(<ApplicationAccess companionId="draft" inlineConnections compact/>);
    await waitFor(()=>expect(screen.getAllByRole("button",{name:/Connect/})).toHaveLength(2));
    await user.click(screen.getAllByRole("button",{name:/Connect/})[0]);
    await waitFor(()=>expect(popup.location.href).toBe("https://oauth.example/linear"));
    connected=true;window.dispatchEvent(new MessageEvent("message",{origin:window.location.origin,source:popup as unknown as Window,data:{type:"companions:plugin-oauth",status:"connected"}}));
    await user.click(await screen.findByRole("checkbox",{name:"Work workspace"}));
    await waitFor(()=>expect(grant).toHaveBeenCalledWith("draft","linear-work"));
  });
});
