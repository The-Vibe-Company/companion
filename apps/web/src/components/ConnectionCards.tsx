import { ExternalLink, LoaderCircle, Plus } from "lucide-react";
import type { PluginAccount, PluginServer } from "@/api";
import { CompanionAvatar } from "./CompanionAvatar";
import { ConnectionActions } from "./ConnectionActions";
import { PluginAccountNameForm } from "./PluginAccountNameForm";
import { markKey, ProviderMark } from "./ProviderMark";
import { Button } from "./ui/button";
import "./ConnectionCards.css";

export function ConnectionCards({ label, catalog, accounts, busy, namingServer, healthText, onConnect, onRequestConnection, onCancelNaming, onRename, onCheck, onDisconnect }: {
  label: string;
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
  const groups: Array<{ key: string; name: string; mark?: string; logo?: string | null; server?: PluginServer; accounts: PluginAccount[] }> = catalog.map(server => ({ key: server.id, name: server.name, mark: markKey(server), logo: server.logo, server, accounts: accounts.filter(account => account.serverId === server.id) }));
  for (const account of accounts) {
    if (catalog.some(server => server.id === account.serverId)) continue;
    const key = account.serverId ?? "custom";
    const group = groups.find(item => item.key === key);
    const name = account.appName ?? (account.provider === "custom" ? "Custom MCP" : account.provider);
    // Accounts for toolkits outside the featured list keep Reconnect and Add account.
    const server: PluginServer | undefined = account.provider === "composio" && account.serverId ? { id: account.serverId, provider: "composio", kind: "composio", name, toolkit: markKey(account), logo: account.appLogo ?? undefined, available: true } : undefined;
    if (group) group.accounts.push(account);
    else groups.push({ key, name, mark: markKey(account), logo: account.appLogo, server, accounts: [account] });
  }
  return <section className="connection-cards" aria-label={label}>
    {groups.map(group => <article key={group.key} className={`connection-card${group.accounts.length ? " connection-card--connected" : ""}`} aria-label={group.name}>
      <header><ProviderMark provider={group.mark} name={group.name} logo={group.logo} /><div><h2>{group.name}</h2><p>{group.server?.description ?? (group.mark === "custom" ? "Your own tools and servers" : "Tools and events")}</p></div></header>
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
      {group.server && <Button className="connection-card-connect" variant="ghost" size="sm" disabled={!group.server.available || !!busy} onClick={() => onRequestConnection(group.server!)}>
        {busy === group.key ? <LoaderCircle className="spin" /> : group.accounts.length > 0 && group.server.available ? <Plus /> : null}
        {!group.server.available ? "Unavailable" : group.accounts.length ? "Add account" : "Connect"}{group.server.available && !group.accounts.length && <ExternalLink />}
      </Button>}
      {group.server && namingServer?.id === group.key && <PluginAccountNameForm providerName={group.name} busy={busy === group.key} submitLabel="Connect account" onCancel={onCancelNaming} onSubmit={value => onConnect(group.server!, value)} />}
    </article>)}
  </section>;
}
