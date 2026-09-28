import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { CompanionTrigger, PluginAccount, TriggerType } from "@/api";
import { CompanionTriggers } from "./CompanionTriggers";

function response(body: unknown, status = 200) { return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })); }
const account = (id: string, label: string, appName: string | null, provider = "composio"): PluginAccount => ({ id, serverId: provider === "composio" ? `composio:${appName?.toLowerCase()}` : null, label, provider, appName, appLogo: appName ? `https://logos.example/${appName.toLowerCase()}.svg` : null, healthStatus: "ok", healthCode: null, checkedAt: null });
const accounts = [account("gh", "the-vibe-company", "GitHub"), account("mail", "Work inbox", "Gmail"), account("internal", "Internal tools", null, "custom")];
const trigger: CompanionTrigger = { id: "t1", accountId: "mail", accountLabel: "Work inbox", appName: "Gmail", appLogo: "https://logos.example/gmail.svg", triggerSlug: "GMAIL_NEW_GMAIL_MESSAGE", triggerName: "New Gmail message", config: {}, instructions: "Summarize the email and draft a reply.", status: "active", createdAt: "2026-09-28T10:00:00Z" };
const commitEvent: TriggerType = { slug: "GITHUB_COMMIT_EVENT", name: "New commit", description: "Runs when a commit is pushed.", instructions: "", type: "webhook", config: { type: "object", required: ["owner", "repo"], properties: {
  owner: { type: "string", title: "Owner", description: "Account or organization that owns the repository." },
  repo: { type: "string", title: "Repository" },
  interval: { type: "integer", title: "Interval", default: 5 },
  branch: { type: "string", title: "Branch", enum: ["main", "dev"] },
  include_merges: { type: "boolean", title: "Include merges" },
  paths: { type: "array", title: "Paths", items: { type: "string" } },
} } };

function installApi(initial: CompanionTrigger[] = []) {
  let triggers = [...initial];
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, options?: RequestInit) => {
    const path = String(input); const method = options?.method ?? "GET"; const body = options?.body ? JSON.parse(String(options.body)) : undefined;
    calls.push({ path, method, body });
    if (path === "/api/plugins") return response({ catalog: [], accounts });
    if (path === "/api/plugins/gh/trigger-types") return response({ items: [commitEvent] });
    if (path === "/api/companions/ada/triggers" && method === "GET") return response({ triggers });
    if (path === "/api/companions/ada/triggers" && method === "POST") { const created: CompanionTrigger = { ...trigger, id: "t2", accountId: "gh", accountLabel: "the-vibe-company", appName: "GitHub", appLogo: null, triggerSlug: body.triggerSlug, triggerName: body.triggerName, config: body.config, instructions: body.instructions, status: "active" }; triggers = [...triggers, created]; return response({ trigger: created }, 201); }
    if (path === "/api/companions/ada/triggers/t1" && method === "PATCH") { triggers = triggers.map(item => item.id === "t1" ? { ...item, status: body.enabled ? "active" as const : "disabled" as const } : item); return response({ trigger: triggers.find(item => item.id === "t1") }); }
    if (path === "/api/companions/ada/triggers/t1" && method === "DELETE") { triggers = triggers.filter(item => item.id !== "t1"); return response({ ok: true }); }
    throw Error(`Unexpected ${method} ${path}`);
  }));
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

it("lists triggers with their app, status and instructions, and explains the empty state", async () => {
  installApi([trigger, { ...trigger, id: "t3", triggerName: "New label", status: "error" }]);
  const view = render(<CompanionTriggers companionId="ada" companionName="Ada"/>);
  const list = await screen.findByRole("list", { name: "Triggers" });
  const [first, second] = within(list).getAllByRole("listitem");
  expect(first).toHaveTextContent("New Gmail message");
  expect(first).toHaveTextContent("Gmail · Work inbox");
  expect(first).toHaveTextContent("Summarize the email and draft a reply.");
  expect(within(first).getByText("Active")).toBeInTheDocument();
  expect(first.querySelector("img")).toHaveAttribute("src", "https://logos.example/gmail.svg");
  expect(within(second).getByText("Error")).toBeInTheDocument();
  view.unmount(); vi.unstubAllGlobals();
  installApi([]);
  render(<CompanionTriggers companionId="ada" companionName="Ada"/>);
  expect(await screen.findByText(/starts a background task on Ada whenever the event happens/)).toBeInTheDocument();
});

it("creates a trigger from the generated configuration form", async () => {
  const calls = installApi();
  const user = userEvent.setup(); render(<CompanionTriggers companionId="ada" companionName="Ada"/>);
  await user.click(await screen.findByRole("button", { name: "Add trigger" }));
  const account = screen.getByRole("combobox", { name: "App account" });
  expect(within(account).getAllByRole("option").map(option => option.textContent)).toEqual(["Choose an account", "GitHub · the-vibe-company", "Gmail · Work inbox"]);
  await user.selectOptions(account, "gh");
  await user.selectOptions(await screen.findByRole("combobox", { name: "Event" }), "GITHUB_COMMIT_EVENT");
  expect(screen.getByText("Runs when a commit is pushed.")).toBeInTheDocument();
  const owner = screen.getByRole("textbox", { name: "Owner" });
  expect(owner).toBeRequired();
  expect(owner).toHaveAccessibleDescription("Account or organization that owns the repository.");
  expect(screen.getByRole("spinbutton", { name: "Interval" })).toHaveValue(5);
  expect(screen.getByRole("button", { name: "Create trigger" })).toBeDisabled();
  await user.type(owner, "the-vibe-company");
  await user.type(screen.getByRole("textbox", { name: "Repository" }), "companion");
  await user.selectOptions(screen.getByRole("combobox", { name: "Branch" }), "main");
  await user.click(screen.getByRole("checkbox", { name: "Include merges" }));
  await user.type(screen.getByRole("textbox", { name: "Paths" }), '[["apps/web"');
  await user.type(screen.getByRole("textbox", { name: "Instructions" }), "Review the commit and report risky changes.");
  await user.click(screen.getByRole("button", { name: "Create trigger" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Paths must be valid JSON.");
  await user.type(screen.getByRole("textbox", { name: "Paths" }), "]");
  await user.click(screen.getByRole("button", { name: "Create trigger" }));
  expect(await screen.findByText("New commit")).toBeInTheDocument();
  expect(calls.filter(call => call.method === "POST")).toEqual([{ path: "/api/companions/ada/triggers", method: "POST", body: {
    accountId: "gh", triggerSlug: "GITHUB_COMMIT_EVENT", triggerName: "New commit",
    config: { owner: "the-vibe-company", repo: "companion", interval: 5, branch: "main", include_merges: true, paths: ["apps/web"] },
    instructions: "Review the commit and report risky changes.",
  } }]);
  expect(screen.queryByRole("form", { name: "New trigger" })).not.toBeInTheDocument();
});

it("pauses, resumes and deletes a trigger after confirmation", async () => {
  const calls = installApi([trigger]);
  const user = userEvent.setup(); render(<CompanionTriggers companionId="ada" companionName="Ada"/>);
  const toggle = await screen.findByRole("switch", { name: "Enable New Gmail message" });
  expect(toggle).toBeChecked();
  await user.click(toggle);
  await waitFor(() => expect(toggle).not.toBeChecked());
  expect(screen.getByText("Paused")).toBeInTheDocument();
  await user.click(toggle);
  await waitFor(() => expect(toggle).toBeChecked());
  expect(calls.filter(call => call.method === "PATCH").map(call => call.body)).toEqual([{ enabled: false }, { enabled: true }]);
  await user.click(screen.getByRole("button", { name: "Delete New Gmail message" }));
  await user.click(within(screen.getByRole("group", { name: "Delete New Gmail message?" })).getByRole("button", { name: "Keep trigger" }));
  expect(calls.some(call => call.method === "DELETE")).toBe(false);
  await user.click(screen.getByRole("button", { name: "Delete New Gmail message" }));
  await user.click(screen.getByRole("button", { name: "Delete trigger" }));
  await waitFor(() => expect(screen.queryByText("New Gmail message")).not.toBeInTheDocument());
  expect(calls.filter(call => call.method === "DELETE").map(call => call.path)).toEqual(["/api/companions/ada/triggers/t1"]);
  expect(screen.getByText(/No triggers yet/)).toBeInTheDocument();
});

it("retries a failed registration instead of pausing it", async () => {
  const calls = installApi([{ ...trigger, status: "error" }]);
  const user = userEvent.setup(); render(<CompanionTriggers companionId="ada" companionName="Ada"/>);
  await user.click(await screen.findByRole("button", { name: "Retry New Gmail message" }));
  await waitFor(() => expect(screen.getByText("Active")).toBeInTheDocument());
  expect(screen.queryByRole("button", { name: "Retry New Gmail message" })).not.toBeInTheDocument();
  expect(calls.filter(call => call.method === "PATCH").map(call => call.body)).toEqual([{ enabled: true }]);
});
