import { useModalFocus } from "@/hooks/useModalFocus";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowUpRight, Check, CircleDollarSign, CopyPlus, LoaderCircle, MonitorUp, PackageOpen, Pause, Play, RotateCw, Send, ShieldCheck, Trash2, UsersRound, Wrench, X } from "lucide-react";
import { api, workspaceApi, type AccountUser, type BillingOverview, type Companion, type DeliveryReceived, type DeliverySent, type MaintenanceAction, type MaintenanceCompanion, type MaintenanceDetail } from "@/api";
import { AvatarPicker, CompanionAvatar, DEFAULT_AVATAR, type CompanionAvatarValue } from "@/components/CompanionAvatar";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

const errorText = (error: unknown) => error instanceof Error ? error.message : "Something went wrong.";
const deliveryReady = (item: DeliverySent | DeliveryReceived) => item.skillsStatus === "ready";
const deliveryState = (item: DeliverySent | DeliveryReceived) => {
  if (item.status === "accepted") return "Accepted";
  if (item.status === "revoked") return "Revoked";
  if (item.skillsStatus === "error") return item.skillsError || "Skills could not be prepared";
  if (item.skillsStatus === "pending") return "Preparing skills…";
  return "Ready for client";
};
const compactQuantity = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const exactQuantity = new Intl.NumberFormat();
function durationLabel(raw:string){
  const seconds=/^\d+$/.test(raw)?BigInt(raw):0n,hours=seconds/3600n,minutes=seconds%3600n/60n,remainder=seconds%60n;
  const parts:string[]=[];if(hours)parts.push(`${hours} hr`);if(minutes)parts.push(`${minutes} min`);if(remainder)parts.push(`${remainder} sec`);return parts.join(" ")||"0 sec";
}
function usagePresentation(item:BillingOverview["usage"][number]){
  const quantity=/^\d+$/.test(item.quantity)?BigInt(item.quantity):0n;
  if(item.category==="box_seconds")return {label:"Computer time",value:durationLabel(item.quantity),title:`${exactQuantity.format(quantity)} seconds`};
  if(item.category==="model_tokens")return {label:"Model usage",value:compactQuantity.format(quantity),title:`${exactQuantity.format(quantity)} tokens`};
  return {label:item.category.replaceAll("_"," "),value:exactQuantity.format(quantity),title:`${exactQuantity.format(quantity)} ${item.unit}`};
}

export function AccountProduct({ user, onSignOut }: { user: AccountUser; onSignOut: () => Promise<void> }) {
  const [billing, setBilling] = useState<BillingOverview | null>(null);
  const [sent, setSent] = useState<DeliverySent[]>([]);
  const [received, setReceived] = useState<DeliveryReceived[]>([]);
  const [maintenance, setMaintenance] = useState<MaintenanceCompanion[]>([]);
  const [maintaining, setMaintaining] = useState<MaintenanceCompanion | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [loadingAccount, setLoadingAccount] = useState(true);
  const [maintenanceError, setMaintenanceError] = useState("");
  const [checkoutPolling, setCheckoutPolling] = useState(() => new URLSearchParams(window.location.search).get("checkout") === "complete");
  const checkoutStartedAt = useRef(Date.now());
  const load = useCallback(async () => {
    try {
      const [nextBilling, deliveries] = await Promise.all([workspaceApi.billing(), workspaceApi.deliveries()]);
      setBilling(nextBilling); setSent(deliveries.sent); setReceived(deliveries.received); setError("");
    } catch (cause) { setError(errorText(cause)); } finally { setLoadingAccount(false); }
  }, []);
  const loadMaintenance = useCallback(async () => { try { const result = await workspaceApi.maintenance(); setMaintenance(result.companions); setMaintenanceError(""); } catch { setMaintenanceError("Could not load client maintenance access."); } }, []);
  useEffect(() => { void load(); void loadMaintenance(); }, [load, loadMaintenance]);
  const hasPendingDelivery = [...sent, ...received].some(item => item.status === "pending" && item.skillsStatus === "pending");
  useEffect(() => {
    if (checkoutPolling && billing?.active) {
      setCheckoutPolling(false);
      const next = new URL(window.location.href); next.searchParams.delete("checkout"); window.history.replaceState({}, "", `${next.pathname}${next.search}${next.hash}`);
      return;
    }
    if (!hasPendingDelivery && !checkoutPolling) return;
    const timer = window.setInterval(() => {
      if (checkoutPolling && Date.now() - checkoutStartedAt.current >= 60_000) { setCheckoutPolling(false); return; }
      void load();
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [billing?.active, checkoutPolling, hasPendingDelivery, load]);
  async function billingAction(kind: "checkout" | "portal") {
    setBusy(kind); setError("");
    try { const result = kind === "checkout" ? await workspaceApi.checkout() : await workspaceApi.billingPortal(); window.location.assign(result.url); }
    catch (cause) { setError(errorText(cause)); setBusy(""); }
  }
  async function accept(item: DeliveryReceived, grantMaintenance: boolean) {
    setBusy(item.id); setError("");
    try { await workspaceApi.acceptDelivery(item.id, grantMaintenance); await load(); }
    catch (cause) { setError(errorText(cause)); } finally { setBusy(""); }
  }
  const subscriptionActive = billing?.mode === "stripe" && billing.plan === "subscription" && billing.active;
  const visibleUsage=billing?.usage.filter(item=>item.category!=="box_lifecycle")??[];
  return <div className="account-product">
    <section className="account-identity"><span className="large-initial">{user.email.slice(0, 1).toUpperCase()}</span><div><strong>{user.name || "Your account"}</strong><small>{user.email}</small></div><Button variant="outline" disabled={!!busy} onClick={async () => { setBusy("signout"); try { await onSignOut(); } catch (cause) { setError(errorText(cause)); } finally { setBusy(""); } }}>{busy === "signout" ? "Signing out…" : "Sign out"}</Button></section>
    {error && <div className="application-access-error" role="alert"><p>{error}</p><Button variant="outline" onClick={() => void load()}>Reload account</Button></div>}
    <section className="product-section" aria-labelledby="plan-title">
      <div className="section-heading"><div><CircleDollarSign /><span><h2 id="plan-title">Plan</h2><p>{!billing ? (loadingAccount ? "Loading your plan…" : "Plan unavailable") : billing?.mode === "beta" ? (billing.active ? "Private beta access enabled" : "Private beta access unavailable") : billing?.mode === "test" ? "Local activation enabled" : subscriptionActive ? "Subscription active" : billing?.configured ? "Ready when you are" : "Unavailable on this installation"}</p></span></div>{(subscriptionActive || billing?.mode === "test" || (billing?.mode === "beta" && billing.active)) && <span className="status-pill status-pill--good"><Check />{billing?.mode === "beta" ? "Beta" : billing?.mode === "test" ? "Test" : "Active"}</span>}</div>
      {billing ? <div className="plan-line"><div><strong>{billing.mode === "beta" ? "Private beta" : billing.mode === "test" ? "Development access" : billing.plan === "subscription" ? "companions.build" : "No subscription"}</strong><small>{billing.mode === "beta" ? (billing.active ? "No subscription required for access." : "This account is not on the private beta list.") : billing.status ? `${billing.status.replaceAll("_", " ")} · subscription + usage` : billing.mode === "test" ? "No live subscription" : "Subscription + usage appear here."}</small></div>{billing.portalAvailable ? <Button variant="outline" onClick={() => void billingAction("portal")} disabled={!!busy}>{busy === "portal" ? <LoaderCircle className="spin" /> : <ArrowUpRight />}Manage</Button> : billing.mode !== "beta" && billing.configured && !billing.active ? <Button onClick={() => void billingAction("checkout")} disabled={!!busy}>{busy === "checkout" ? <LoaderCircle className="spin" /> : <ArrowUpRight />}Subscribe</Button> : null}</div> : loadingAccount ? <div className="skeleton skeleton--row" role="status" aria-label="Loading account" /> : null}
      {!!visibleUsage.length && <div className="usage-lines">{visibleUsage.map(item => {const view=usagePresentation(item);return <span key={`${item.category}-${item.unit}`} title={view.title}><strong>{view.value}</strong><small>{view.label}</small></span>;})}</div>}
    </section>
    <section className="product-section" aria-labelledby="deliveries-title">
      <div className="section-heading"><div><PackageOpen /><span><h2 id="deliveries-title">Deliveries</h2><p>Companions shared with clients.</p></span></div></div>
      {received.filter(item => item.status === "pending").map(item => <ReceivedDelivery key={item.id} item={item} busy={busy === item.id} onAccept={accept} />)}
      {[...received.filter(item => item.status !== "pending"), ...sent].map(item => <div className="compact-row" key={`${"clientEmail" in item ? "sent" : "received"}-${item.id}`}><div><strong>{"clientEmail" in item ? item.clientEmail : item.name}</strong><small>{deliveryState(item)}</small></div>{item.status === "accepted" && !("clientEmail" in item) && item.maintenanceRequested && <Button variant="ghost" size="sm" disabled={!!busy} onClick={async () => { setBusy(item.id); try { await workspaceApi.revokeMaintenance(item.id); await load(); } catch (cause) { setError(errorText(cause)); } finally { setBusy(""); } }}>Remove maintenance</Button>}</div>)}
      {!loadingAccount && !error && !received.length && !sent.length && <p className="settings-empty">No deliveries yet.</p>}
    </section>
    {maintenanceError && <div className="application-access-error" role="alert"><p>{maintenanceError}</p><Button variant="outline" onClick={() => void loadMaintenance()}>Retry maintenance</Button></div>}
    {!!maintenance.length && <section className="product-section" aria-labelledby="maintenance-title"><div className="section-heading"><div><Wrench /><span><h2 id="maintenance-title">Maintenance</h2><p>Client Companions you can help.</p></span></div></div>{maintenance.map(item => <button className="compact-row compact-row--button" key={item.id} onClick={() => setMaintaining(item)}><span><strong>{item.name}</strong><small>{item.error || item.status}</small></span><ArrowUpRight /></button>)}</section>}
    {maintaining && <MaintenanceSheet companion={maintaining} onClose={() => setMaintaining(null)} />}
  </div>;
}

function MaintenanceSheet({ companion, onClose }: { companion: MaintenanceCompanion; onClose: () => void }) {
  const modalRef = useModalFocus(true, onClose);
  const [detail, setDetail] = useState<MaintenanceDetail | null>(null); const [actions, setActions] = useState<MaintenanceAction[]>([]);
  const [name, setName] = useState(companion.name); const [instructions, setInstructions] = useState(""); const [prompt, setPrompt] = useState(""); const [busy, setBusy] = useState(""); const [error, setError] = useState("");
  const taskIntent = useRef<{ prompt: string; id: string } | null>(null);
  const load = useCallback(async () => { try { const [next, history] = await Promise.all([workspaceApi.maintenanceDetail(companion.id), workspaceApi.maintenanceActions(companion.id)]); setDetail(next.companion); setName(next.companion.name); setInstructions(next.companion.instructions); setActions(history.actions); setError(""); } catch (cause) { setError(errorText(cause)); } }, [companion.id]);
  useEffect(() => { void load(); }, [load]);
  async function save(event: FormEvent) { event.preventDefault(); setBusy("save"); try { await workspaceApi.updateMaintenanceCompanion(companion.id, { name: name.trim(), instructions: instructions.trim(), modelId: detail?.modelId }); await load(); } catch (cause) { setError(errorText(cause)); } finally { setBusy(""); } }
  async function prepare() { setBusy("prepare"); try { await workspaceApi.prepareMaintenanceCompanion(companion.id); await load(); } catch (cause) { setError(errorText(cause)); } finally { setBusy(""); } }
  async function assign(event: FormEvent) { event.preventDefault(); const nextPrompt = prompt.trim(); if (taskIntent.current?.prompt !== nextPrompt) taskIntent.current = { prompt: nextPrompt, id: crypto.randomUUID() }; setBusy("task"); try { await workspaceApi.createMaintenanceTask(companion.id, taskIntent.current.id, nextPrompt); taskIntent.current = null; setPrompt(""); await load(); } catch (cause) { setError(errorText(cause)); } finally { setBusy(""); } }
  return <div className="sheet-layer"><button className="sheet-scrim" onClick={onClose} aria-label="Close maintenance" /><aside ref={modalRef} tabIndex={-1} className="settings-sheet" role="dialog" aria-modal="true" aria-labelledby="maintenance-sheet-title"><header className="sheet-header"><div><span>Client maintenance</span><h2 id="maintenance-sheet-title">{companion.name}</h2></div><Button variant="ghost" size="icon" onClick={onClose} aria-label="Close maintenance"><X /></Button></header><div className="settings-body maintenance-body"><p className="consent-note"><ShieldCheck />The client allowed configuration, diagnostics, and maintenance tasks. Their chat and files stay private.</p>{detail ? <><div className="maintenance-status"><span className={`status-dot status-dot--${detail.error ? "error" : detail.status}`} /><div><strong>{detail.error || detail.status}</strong><small>{detail.readyAt ? `Ready ${new Date(detail.readyAt).toLocaleString()}` : "Runtime status"}</small></div><Button variant="outline" size="sm" disabled={!!busy} onClick={() => void prepare()}>{busy === "prepare" ? <LoaderCircle className="spin" /> : <Play />}Prepare</Button></div><form className="inline-create" onSubmit={save}><h3>Configuration</h3><div className="field"><label htmlFor="maintenance-name">Name</label><input id="maintenance-name" value={name} onChange={event => setName(event.target.value)} /></div><div className="field"><label htmlFor="maintenance-instructions">Instructions</label><Textarea id="maintenance-instructions" rows={4} value={instructions} onChange={event => setInstructions(event.target.value)} /></div><Button disabled={!!busy || !name.trim()}>{busy === "save" ? <LoaderCircle className="spin" /> : <Check />}Save</Button></form><form className="inline-create" onSubmit={assign}><h3>Maintenance task</h3><div className="field"><label htmlFor="maintenance-task">What should improve?</label><Textarea id="maintenance-task" rows={3} value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="Check the setup and fix…" /></div><Button disabled={!!busy || !prompt.trim()}>{busy === "task" ? <LoaderCircle className="spin" /> : <Wrench />}Assign task</Button></form><div className="maintenance-history"><span className="detail-label">Recent actions</span>{actions.length ? actions.map(action => <div className="history-row" key={action.id}><span className={`history-dot history-dot--${action.status}`} /><div><strong>{action.operation} · {action.status}</strong><small>{new Date(action.createdAt).toLocaleString()}</small>{action.error && <p>{action.error}</p>}</div></div>) : <p className="settings-empty">No maintenance actions yet.</p>}</div></> : !error && <div className="skeleton skeleton--row" />}{error && <p className="field-error" role="alert">{error}</p>}</div></aside></div>;
}

function ReceivedDelivery({ item, busy, onAccept }: { item: DeliveryReceived; busy: boolean; onAccept: (item: DeliveryReceived, grant: boolean) => Promise<void> }) {
  const [grant, setGrant] = useState(false);
  const ready = deliveryReady(item);
  return <div className="delivery-invite"><CompanionAvatar name={item.name} size={42} /><div><strong>{item.name}</strong><small>{deliveryState(item)}</small></div>{ready && item.maintenanceRequested && <label><input type="checkbox" checked={grant} onChange={event => setGrant(event.target.checked)} />Allow maintenance</label>}<Button size="sm" disabled={!ready || busy} onClick={() => void onAccept(item, grant)}>{busy ? <LoaderCircle className="spin" /> : <Check />}Accept</Button></div>;
}

export function DesktopSheet({ companion, onClose, onRefresh, embedded = false, active = true }: { companion: Companion; onClose: () => void; onRefresh: () => Promise<void>; embedded?: boolean; active?: boolean }) {
  const modalRef = useModalFocus(!embedded && active, onClose);
  const [waiting, setWaiting] = useState<"pause" | "release" | "prepare" | "">(""); const [error, setError] = useState("");
  const [desktopUrl, setDesktopUrl] = useState<string | null>(null);
  const desktopPoll = useRef<{ cancelled: boolean; popup: Window | null; timer?: number } | null>(null);
  useEffect(() => {
    setDesktopUrl(null);
    if (!active) setWaiting("");
    return () => {
      // Only the pending viewer belongs to this panel; human control stays durable.
      if (!desktopPoll.current) return;
      desktopPoll.current.cancelled = true;
      if (desktopPoll.current.timer) window.clearTimeout(desktopPoll.current.timer);
      if (desktopPoll.current.popup && !desktopPoll.current.popup.closed) desktopPoll.current.popup.close();
      desktopPoll.current = null;
    };
  }, [active, companion.id]);
  useEffect(() => {
    if (!active || !waiting || waiting === "prepare") return;
    if ((waiting === "pause" && companion.desktopPausedAt) || (waiting === "release" && !companion.desktopPausedAt)) { setWaiting(""); return; }
    if (companion.error) { setError(companion.error); setWaiting(""); return; }
    const timer = window.setInterval(() => void onRefresh(), 1_200); return () => window.clearInterval(timer);
  }, [active, waiting, companion.desktopPausedAt, companion.error, onRefresh]);
  async function open() {
    const popup = window.open("about:blank", "_blank"); setError(""); setDesktopUrl(null);
    if (popup && !popup.closed) {
      popup.document.title = `Preparing ${companion.name}`;
      popup.document.body.textContent = "Preparing desktop…";
      popup.document.body.style.cssText = "font:16px system-ui;display:grid;place-items:center;min-height:100vh;margin:0;color:#444;background:#fafafa";
    }
    if (desktopPoll.current) { desktopPoll.current.cancelled = true; if (desktopPoll.current.timer) window.clearTimeout(desktopPoll.current.timer); }
    const poll = { cancelled: false, popup } as { cancelled: boolean; popup: Window | null; timer?: number };
    desktopPoll.current = poll; setWaiting("prepare"); const startedAt = Date.now();
    const attempt = async () => {
      if (poll.cancelled) return;
      try {
        const result = await api.openDesktop(companion.id);
        if (poll.cancelled) return;
        if (result.url) { poll.cancelled = true; desktopPoll.current = null; setDesktopUrl(result.url); setWaiting("");
          // A browser may block navigation even after returning a popup handle.
          try { if (popup && !popup.closed) popup.location.replace(result.url); } catch { /* The same-tab link remains available. */ }
          void onRefresh(); return; }
        if (Date.now() - startedAt >= 5 * 60_000) { poll.cancelled = true; desktopPoll.current = null; popup?.close(); setWaiting(""); setError("The desktop is taking longer than expected. Try again shortly."); return; }
        poll.timer = window.setTimeout(() => void attempt(), 2_000);
      } catch (cause) { if (poll.cancelled) return; poll.cancelled = true; desktopPoll.current = null; popup?.close(); setWaiting(""); setError(errorText(cause)); }
    };
    await attempt();
  }
  async function toggle() { const releasing = !!companion.desktopTaken; setWaiting(releasing ? "release" : "pause"); setError(""); try { if (releasing) await workspaceApi.releaseDesktop(companion.id); else await workspaceApi.takeDesktop(companion.id); await onRefresh(); } catch (cause) { setWaiting(""); setError(errorText(cause)); } }
  const confirmedPaused = !!companion.desktopPausedAt;
  if (!active) return null;
  const content = <div className="desktop-content"><div className={`desktop-state ${confirmedPaused ? "desktop-state--paused" : ""}`}><CompanionAvatar name={companion.name} avatar={companion.avatar} size={68} /><span>{confirmedPaused ? <Pause /> : <MonitorUp />}</span></div><div><h3>{confirmedPaused ? "You have control" : waiting === "prepare" ? "Preparing desktop…" : waiting === "pause" ? "Taking control…" : "Open the computer"}</h3><p>{confirmedPaused ? "The desktop is yours. Chat and background work continue." : waiting === "prepare" ? "A desktop link will appear when the computer is ready." : "View the desktop, or take control to make changes."}</p></div>{error && <p className="field-error" role="alert">{error}</p>}<div className="desktop-actions"><Button variant="outline" onClick={() => void open()} disabled={!!waiting}>{waiting === "prepare" ? <LoaderCircle className="spin" /> : <ArrowUpRight />}{waiting === "prepare" ? "Preparing…" : "Open desktop"}</Button><Button onClick={() => void toggle()} disabled={!!waiting}>{waiting && waiting !== "prepare" ? <LoaderCircle className="spin" /> : confirmedPaused ? <Play /> : <Pause />}{waiting === "release" ? "Releasing…" : waiting === "pause" ? "Taking control…" : confirmedPaused ? "Release desktop" : "Take control"}</Button></div>{desktopUrl && <a className="desktop-current-tab" href={desktopUrl} rel="noreferrer">Open desktop in this tab</a>}<div className="trust-note"><ShieldCheck />Control is shown only after the computer confirms it.</div></div>;
  if (embedded) return <section aria-label="Computer controls">{content}</section>;
  return <div className="sheet-layer"><button className="sheet-scrim" onClick={onClose} aria-label="Close desktop controls" /><aside ref={modalRef} tabIndex={-1} className="desktop-sheet" role="dialog" aria-modal="true" aria-labelledby="desktop-title"><header className="sheet-header"><div><span>{companion.name}</span><h2 id="desktop-title">Desktop</h2></div><Button variant="ghost" size="icon" onClick={onClose} aria-label="Close desktop controls"><X /></Button></header>{content}</aside></div>;
}

export function DeliverySettings({companionId}:{companionId:string}){
 const [email,setEmail]=useState(''),[maintenance,setMaintenance]=useState(false),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
 const intent=useRef<{id:string;email:string;maintenance:boolean}|null>(null);
 async function submit(event:FormEvent){event.preventDefault();if(busy||!email.trim())return;setBusy(true);setNotice('');
  intent.current??={id:crypto.randomUUID(),email:email.trim(),maintenance};
  try{const frozen=intent.current;const {delivery}=await workspaceApi.createDelivery({clientDeliveryId:frozen.id,companionId,clientEmail:frozen.email,maintenanceRequested:frozen.maintenance,includeSkills:true});setNotice(deliveryState(delivery));intent.current=null;setEmail('');}
  catch(e){setNotice(errorText(e));}finally{setBusy(false);}
 }
 return <form className="participant-config" onSubmit={submit}><h4>Deliver this companion</h4><label>Client email<input type="email" value={email} disabled={busy||!!intent.current} onChange={e=>setEmail(e.target.value)} required/></label><label><input type="checkbox" checked={maintenance} disabled={busy||!!intent.current} onChange={e=>setMaintenance(e.target.checked)}/>Offer revocable maintenance access</label><Button type="submit" disabled={busy||!email.trim()}>{busy?<LoaderCircle className="spin"/>:<Send/>}Prepare invitation</Button>{notice&&<p role="status">{notice}</p>}</form>;
}
