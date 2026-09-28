import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, CircleAlert, LoaderCircle, Search } from "lucide-react";
import { workspaceApi, type PluginAccount, type PluginServer } from "@/api";
import { Button } from "./ui/button";
import { ConnectionCards } from "./ConnectionCards";

export function ConnectionsPage({ onBack }: { onBack: () => void }) {
  const [catalog, setCatalog] = useState<PluginServer[]>([]);
  const [accounts, setAccounts] = useState<PluginAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [naming, setNaming] = useState<PluginServer | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ search: string; items: PluginServer[]; nextCursor: string | null } | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const oauthPopup = useRef<Window | null>(null);
  const oauthWatch = useRef<number | null>(null);
  const searchRequest = useRef<AbortController | null>(null);
  const reload = useCallback(async () => {
    setError("");
    try { const result = await workspaceApi.plugins(); setCatalog(result.catalog); setAccounts(result.accounts); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load applications."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  const search = useCallback(async (value: string, cursor?: string | null) => {
    searchRequest.current?.abort();
    const request = new AbortController(); searchRequest.current = request;
    setSearching(true); setSearchError("");
    try {
      const page = await workspaceApi.searchToolkits(value, cursor, request.signal);
      setResults(current => ({ search: value, items: cursor && current?.search === value ? [...current.items, ...page.items] : page.items, nextCursor: page.nextCursor }));
    } catch (cause) { if (!request.signal.aborted) setSearchError(cause instanceof Error ? cause.message : "Could not search applications."); }
    finally { if (searchRequest.current === request) { searchRequest.current = null; setSearching(false); } }
  }, []);
  const term = query.trim();
  useEffect(() => {
    searchRequest.current?.abort(); searchRequest.current = null; setSearching(false); setSearchError("");
    if (term.length < 2) { setResults(null); return; }
    const timer = window.setTimeout(() => void search(term), 250);
    return () => window.clearTimeout(timer);
  }, [term, search]);
  useEffect(() => () => searchRequest.current?.abort(), []);
  useEffect(() => {
    const completion = new URLSearchParams(window.location.search).get("connection");
    if (!["connected", "cancelled", "error"].includes(completion ?? "")) return;
    if (window.opener && window.opener !== window) {
      window.opener.postMessage({ type: "companions:plugin-oauth", status: completion }, window.location.origin);
      window.close(); return;
    }
    window.history.replaceState({}, "", "/connections");
    if (completion === "connected") { setNotice("Connection added."); void reload(); }
    else if (completion === "cancelled") setNotice("Connection cancelled.");
    else setError("Connection could not be completed. Try again.");
  }, [reload]);
  useEffect(() => {
    const complete = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== oauthPopup.current || event.data?.type !== "companions:plugin-oauth") return;
      if (oauthWatch.current !== null) window.clearInterval(oauthWatch.current);
      oauthWatch.current = null; oauthPopup.current = null; setBusy(""); setError(""); setNotice("");
      if (event.data.status === "connected") { setNotice("Connection added."); void reload(); }
      else if (event.data.status === "cancelled") setNotice("Connection cancelled.");
      else setError("Connection could not be completed. Try again.");
    };
    window.addEventListener("message", complete);
    return () => { window.removeEventListener("message", complete); if (oauthWatch.current !== null) window.clearInterval(oauthWatch.current); };
  }, [reload]);
  function healthText(account: PluginAccount) { return account.healthStatus === "ok" ? "Connected" : account.healthStatus === "unchecked" ? "Not checked" : account.healthCode === "authorization_required" ? "Reconnect required" : account.healthStatus === "requires_agent" ? "Companion check required" : "Connection issue"; }
  async function connect(server: PluginServer, label: string) {
    setBusy(server.id); setError(""); setNotice("");
    const popup = window.open("about:blank", "companions-plugin-oauth", "popup,width=620,height=760");
    oauthPopup.current = popup;
    if (popup) oauthWatch.current = window.setInterval(() => {
      if (!popup.closed) return;
      if (oauthWatch.current !== null) window.clearInterval(oauthWatch.current);
      oauthWatch.current = null; oauthPopup.current = null; setBusy(""); setNotice("Connection window closed.");
    }, 500);
    try {
      const result = await workspaceApi.connectPlugin(server.id, label); setNaming(null);
      if (result.url) { if (popup && !popup.closed) popup.location.href = result.url; else window.location.assign(result.url); }
      else { if (oauthWatch.current !== null) window.clearInterval(oauthWatch.current); oauthWatch.current = null; popup?.close(); oauthPopup.current = null; setBusy(""); await reload(); }
    } catch (cause) {
      if (oauthWatch.current !== null) window.clearInterval(oauthWatch.current);
      oauthWatch.current = null; popup?.close(); oauthPopup.current = null; setBusy(""); setError(cause instanceof Error ? cause.message : "Could not connect.");
    }
  }
  async function rename(account: PluginAccount, label: string) { setBusy(account.id); try { await workspaceApi.renamePlugin(account.id, label); await reload(); return true; } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not rename account."); return false; } finally { setBusy(""); } }
  async function check(account: PluginAccount) { setBusy(account.id); try { const result = await workspaceApi.checkPlugin(account.id); setAccounts(current => current.map(item => item.id === account.id ? { ...item, ...result.account } : item)); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not check account."); } finally { setBusy(""); } }
  async function disconnect(account: PluginAccount) { setBusy(account.id); try { await workspaceApi.deletePlugin(account.id); await reload(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not disconnect account."); } finally { setBusy(""); } }
  const native = catalog.filter(server => server.kind === "native");
  const nativeAccounts = accounts.filter(account => native.some(server => server.id === account.serverId));
  const apps = catalog.filter(server => server.kind !== "native");
  const appAccounts = accounts.filter(account => !nativeAccounts.includes(account));
  const cards = { busy, namingServer: naming, healthText, onConnect: connect, onRequestConnection: setNaming, onCancelNaming: () => setNaming(null), onRename: rename, onCheck: check, onDisconnect: disconnect };
  return <main className="connections-page"><header className="standalone-header"><Button variant="ghost" size="icon" onClick={onBack} aria-label="Back to discussions"><ArrowLeft/></Button><div><h1>Applications</h1><p>Connect your accounts here, then choose who can use them in each Companion’s settings.</p></div></header><div className="connections-inner">{loading ? <div className="detail-loading" role="status"><LoaderCircle className="spin"/>Loading applications…</div> : !catalog.length && !accounts.length && !error ? <div className="application-access-state"><h2>No applications available</h2><p>Applications are not available in this workspace yet.</p><Button variant="outline" onClick={() => void reload()}>Check again</Button></div> : <>
    <label className="connection-search"><Search aria-hidden="true"/><input type="search" value={query} maxLength={80} placeholder="Search hundreds of apps" aria-label="Search apps" onChange={event => setQuery(event.target.value)}/>{searching && <LoaderCircle className="spin" aria-label="Searching"/>}</label>
    {term.length >= 2 ? <>
      {results && (results.items.length ? <ConnectionCards label="Search results" catalog={results.items} accounts={appAccounts.filter(account => results.items.some(server => server.id === account.serverId))} {...cards}/> : <p className="connection-notice" role="status">No apps match “{results.search}”.</p>)}
      {results?.nextCursor && <Button className="connection-more" variant="outline" disabled={searching} onClick={() => void search(results.search, results.nextCursor)}>Show more apps</Button>}
      {searchError && <div className="application-access-error" role="alert"><CircleAlert/>{searchError}<Button variant="outline" size="sm" onClick={() => void search(term)}>Retry</Button></div>}
    </> : <ConnectionCards label="Apps" catalog={apps} accounts={appAccounts} {...cards}/>}
    {!!native.length && <div className="connection-git"><h2>Git access</h2><p>Lets git clone and push from each Companion’s computer. App tools come from the connections above.</p><ConnectionCards label="Git access" catalog={native} accounts={nativeAccounts} {...cards}/></div>}
  </>} {notice && <p className="connection-notice" role="status">{notice}</p>}{error && <div className="application-access-error" role="alert"><CircleAlert/>{error}<Button variant="outline" size="sm" onClick={() => void reload()}>Retry</Button></div>}</div></main>;
}
