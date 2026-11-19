import { ExternalLink, LoaderCircle, Plus } from "lucide-react";
import type { PluginAccount, PluginServer } from "@/api";
import { CompanionAvatar } from "./CompanionAvatar";
import { ConnectionActions } from "./ConnectionActions";
import { PluginAccountNameForm } from "./PluginAccountNameForm";
import { ProviderMark } from "./ProviderMark";
import { Button } from "./ui/button";
import "./ConnectionCards.css";

const descriptions: Record<string, string> = {
  linear: "Issues, projects, cycles",
  github: "Repositories, pull requests",
  notion: "Pages and databases",
  conductor: "Tasks and workflows",
  slack: "Channels and messages",
  gmail: "Email and drafts",
  sentry: "Errors and performance",
  skillpack: "Skills, labels, secrets",
};

export function ConnectionCards({ catalog, accounts, busy, namingServer, healthText, onConnect, onRequestConnection, onCancelNaming, onRename, onCheck, onDisconnect }: {
  catalog: PluginServer[];
  accounts: PluginAccount[];
  busy: string;
  namingServer: PluginServer | null;
  healthText: (account: PluginAccount) => string;
  onConnect: (server: PluginServer, label: string) => Promise<void>;
  onRequestConnection: (server: PluginServer) => void;
  onCancelNaming: () => void;
  onRename: (account: PluginAccount, label: string) => Promise<boolean>;
  onCheck: (account: PluginAccount) => void;
  onDisconnect: (account: PluginAccount) => void;
}) {
  const groups: Array<{ key: string; name: string; provider?: string; server?: PluginServer; accounts: PluginAccount[] }> = catalog.map(server => ({ key: server.id, name: server.name, provider: server.provider, server, accounts: accounts.filter(account => account.serverId === server.id) }));
  for (const account of accounts) {
    if (catalog.some(server => server.id === account.serverId)) continue;
    const key = account.serverId ?? "custom";
    const group = groups.find(item => item.key === key);
    if (group) group.accounts.push(account);
    else groups.push({ key, name: account.provider === "custom" ? "Custom MCP" : account.provider ?? "Connection", provider: account.provider ?? "custom", server: undefined, accounts: [account] });
  }
  return <section className="connection-cards" aria-label="Apps">
    {groups.map(group => <article key={group.key} className={`connection-card${group.accounts.length ? " connection-card--connected" : ""}`} aria-label={group.name}>
      <header><ProviderMark provider={group.provider} name={group.name} /><div><h2>{group.name}</h2><p>{group.server?.description ?? descriptions[group.provider ?? ""] ?? (group.provider === "custom" ? "Your own tools and servers" : "Tools and events")}</p></div></header>
      <div className="connection-card-accounts">{group.accounts.map(account => <div key={account.id} className={`connection-chip connection-chip--${account.healthStatus}`}>
        <span className="connection-chip-dot" aria-hidden="true" />
        <div className="connection-chip-copy"><strong title={account.label}>{account.label}</strong><small role="status" title={healthText(account)}>{healthText(account)}</small></div>
        {account.usedBy && <div className="connection-used-by" role="group" aria-label={account.usedBy.length ? `Allowed companions: ${account.usedBy.map(companion => companion.name).join(", ")}` : "No companions have access"}>
          {account.usedBy.slice(0, 3).map(companion => <a key={companion.id} href={`/companions/${companion.id}`} aria-label={`Open ${companion.name}`} title={companion.name}><CompanionAvatar name={companion.name} avatar={companion.avatar} size={24} /></a>)}
          {account.usedBy.length > 3 && <span title={account.usedBy.slice(3).map(companion => companion.name).join(", ")}>+{account.usedBy.length - 3}</span>}
          {!account.usedBy.length && <span className="connection-unused" title="No companions have access" />}
        </div>}
        <ConnectionActions label={account.label} providerName={group.name} busy={!!busy} onRename={value => onRename(account, value)} onCheck={account.provider === "custom" ? undefined : () => onCheck(account)} onDisconnect={() => onDisconnect(account)} />
        {account.healthCode === "authorization_required" && group.server?.available && <Button className="connection-chip-reconnect" variant="ghost" size="sm" disabled={!!busy} onClick={() => void onConnect(group.server!, account.label)}>Reconnect</Button>}
      </div>)}</div>
      {group.server && (group.server.kind !== "remote" || !group.accounts.length) && <Button className="connection-card-connect" variant="ghost" size="sm" disabled={!group.server.available || !!busy} onClick={() => onRequestConnection(group.server!)}>
        {busy === group.key ? <LoaderCircle className="spin" /> : group.accounts.length > 0 && group.server.available ? <Plus /> : null}
        {!group.server.available ? "Unavailable" : group.accounts.length ? "Add account" : "Connect"}{group.server.available && group.server.kind !== "remote" && !group.accounts.length && <ExternalLink />}
      </Button>}
      {group.server && namingServer?.id === group.key && <PluginAccountNameForm providerName={group.name} busy={!!busy} submitLabel="Connect account" onCancel={onCancelNaming} onSubmit={value => onConnect(group.server!, value)} />}
    </article>)}
  </section>;
}
