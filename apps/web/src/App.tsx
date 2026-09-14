import {AccountProduct} from '@/components/CompanionAccount';
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, CircleAlert, LoaderCircle, Mail } from "lucide-react";
import { api, ApiError, type AccountUser, type AppConfig, type Companion } from "@/api";
import { Button } from "@/components/ui/button";
import { CompanionAvatar } from "@/components/CompanionAvatar";
import { DiscussionsWorkspace } from "@/components/DiscussionsWorkspace";
import { LandingPage } from "@/components/LandingPage";
import { LegalPage, type LegalPageKind } from "@/components/LegalPage";
import { ConnectionsPage } from "@/components/WorkspaceConnections";
import { CompanionSettingsPage } from "@/components/CompanionSettingsPage";
import "./StandalonePages.css";

const CreateCompanion = lazy(() => import("@/components/CreateCompanion").then(module => ({ default: module.CreateCompanion })));

function legalPageFromPath(pathname = window.location.pathname): LegalPageKind | null {
  if (/^\/privacy\/?$/.test(pathname)) return "privacy";
  if (/^\/terms\/?$/.test(pathname)) return "terms";
  return null;
}

function discussionIdFromPath() { return window.location.pathname.match(/^\/discussions\/([^/]+)$/)?.[1] ?? null; }
function legacyCompanionIdFromPath() { return window.location.pathname.match(/^\/companions\/([^/]+)$/)?.[1] ?? null; }

export function AccessGate() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const localInbox = ["127.0.0.1", "localhost"].includes(window.location.hostname)
    ? `${window.location.protocol}//${window.location.hostname}:${Number(window.location.port || (window.location.protocol === "https:" ? 443 : 80)) + 6}` : null;
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!email.trim() || submitting) return; setSubmitting(true); setError("");
    try { await api.requestMagicLink(email.trim()); setSent(true); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not sign in"); }
    finally { setSubmitting(false); }
  }
  return <main className="access-page"><form className="access-form" onSubmit={submit}><div className="signin-mark" aria-hidden="true"><CompanionAvatar name="companions.build" avatar={{ shape: 6, color: 7, face: 1 }} size={76}/></div><div className="wordmark wordmark--center">companions.build</div>{sent ? <div className="signin-sent" role="status"><h1>Check your inbox</h1><p>We sent a sign-in link to <strong>{email.trim()}</strong>.</p>{localInbox && <a className="inbox-link" href={localInbox} target="_blank" rel="noreferrer"><Mail/>Open local inbox</a>}<button type="button" className="text-button" onClick={() => setSent(false)}>Use another email</button></div> : <><div className="signin-copy"><h1>Your Companions,<br/>ready when you are.</h1><p>Sign in with a private link. No password to remember.</p></div><label htmlFor="signin-email">Email</label><input id="signin-email" type="email" required disabled={submitting} autoComplete="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="you@example.com" aria-describedby={error ? "access-error" : undefined} aria-invalid={Boolean(error)} autoFocus/>{error && <p className="field-error" role="alert" id="access-error">{error}</p>}<Button type="submit" disabled={!email.trim() || submitting}>{submitting ? <LoaderCircle className="spin"/> : <Mail/>}{submitting ? "Sending sign-in link…" : "Email me a sign-in link"}</Button></>}</form></main>;
}

function LoadingApp() { return <div role="status" className="discussion-loading" aria-label="Loading companions.build"><div/><div/><main><span/><span/></main></div>; }

export function AccountPage({ user, onBack, onSignOut }: { user: AccountUser; onBack: () => void; onSignOut: () => Promise<void> }) {
  return <main className="account-page"><header className="standalone-header"><Button variant="ghost" size="icon" onClick={onBack} aria-label="Back to discussions"><ArrowLeft/></Button><span className="wordmark">companions.build</span></header><div className="account-inner"><h1>Account</h1><AccountProduct user={user} onSignOut={onSignOut}/></div></main>;
}

export function App() {
  const publicLegalPage = legalPageFromPath();
  const publicHomepage = /^\/about\/?$/.test(window.location.pathname);
  const [route, setRoute] = useState(window.location.pathname);
  const [authRequired, setAuthRequired] = useState(false);
  const [loading, setLoading] = useState(!publicLegalPage && !publicHomepage);
  const [error, setError] = useState("");
  const [user, setUser] = useState<AccountUser | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [companions, setCompanions] = useState<Companion[]>([]);

  const returnPath = useRef("/");
  const onUnauthorized = useCallback(() => setAuthRequired(true), []);
  const navigate = useCallback((path: string, replace = false) => { window.history[replace ? "replaceState" : "pushState"]({}, "", path); setRoute(path); }, []);
  const openPage = (path: string) => {
    if (/^\/discussions\/[^/]+$/.test(window.location.pathname)) returnPath.current = window.location.pathname;
    navigate(path);
  };
  const backToDiscussion = () => navigate(returnPath.current);
  const bootstrap = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const [me, nextConfig, list] = await Promise.all([api.getMe(), api.getConfig(), api.getCompanions()]);
      setUser(me.user); setConfig(nextConfig); setCompanions(list.companions.filter(item => !item.retiredAt)); setAuthRequired(false);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) setAuthRequired(true);
      else setError(cause instanceof Error ? cause.message : "Could not load companions.build.");
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { if (!publicLegalPage && !publicHomepage) void bootstrap(); }, [bootstrap, publicLegalPage, publicHomepage]);
  useEffect(() => { const pop = () => setRoute(window.location.pathname); window.addEventListener("popstate", pop); return () => window.removeEventListener("popstate", pop); }, []);
  useEffect(() => {
    if (!user || authRequired) return;
    let active = true;
    const timer = window.setInterval(() => {
      void api.getCompanions().then(result => {
        if (active) setCompanions(result.companions.filter(item => !item.retiredAt));
      }).catch(cause => {
        if (active && cause instanceof ApiError && cause.status === 401) setAuthRequired(true);
      });
    }, 5_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [user, authRequired]);
  useEffect(() => {
    const root = document.documentElement;
    const keyboard = () => { root.dataset.input = "keyboard"; };
    const pointer = () => { root.dataset.input = "pointer"; };
    document.addEventListener("keydown", keyboard, true);
    document.addEventListener("pointerdown", pointer, true);
    return () => { document.removeEventListener("keydown", keyboard, true); document.removeEventListener("pointerdown", pointer, true); delete root.dataset.input; };
  }, []);
  async function signOut() { await api.signOut(); setUser(null); setAuthRequired(true); setCompanions([]); navigate("/", true); }

  if (publicLegalPage) return <LegalPage kind={publicLegalPage}/>;
  if (publicHomepage) return <LandingPage onLogin={() => navigate("/login")}/>;
  if (authRequired) return route === "/" ? <LandingPage onLogin={() => navigate("/login")}/> : <AccessGate/>;
  if (loading) return <LoadingApp/>;
  if (!user || !config) return <main className="load-failure"><CircleAlert/><h1>Couldn’t load companions.build</h1><p>{error || "The service did not return its configuration."}</p><Button onClick={() => void bootstrap()}>Try again</Button></main>;

  if (route === "/new") return <main className="onboarding" id="main-content"><div className="onboarding-mobile-header"><Button variant="ghost" size="icon" onClick={backToDiscussion} aria-label="Back to discussions"><ArrowLeft/></Button><span className="wordmark">companions.build</span></div><Suspense fallback={<div className="detail-loading" role="status">Opening creation…</div>}><CreateCompanion ownerId={user.id} config={config} compact={companions.length > 0} onCreated={companion => { setCompanions(current => [companion, ...current]); navigate(`/companions/${companion.id}`, true); }}/></Suspense></main>;
  if (route === "/connections") return <ConnectionsPage onBack={backToDiscussion}/>;
  if (route === "/account") return <AccountPage user={user} onBack={backToDiscussion} onSignOut={signOut}/>;
  const settingsId = route.match(/^\/companions\/([^/]+)\/settings\/?$/)?.[1];
  if (settingsId) return <CompanionSettingsPage key={settingsId} id={settingsId} onBack={backToDiscussion} onUnauthorized={onUnauthorized} onApplications={() => openPage("/connections")}/>;
  return <DiscussionsWorkspace user={user} companions={companions} initialDiscussionId={discussionIdFromPath()} legacyCompanionId={legacyCompanionIdFromPath()} onUnauthorized={onUnauthorized} onCreateCompanion={() => openPage("/new")} onApplications={() => openPage("/connections")} onAccount={() => openPage("/account")} onCompanionSettings={id => openPage(`/companions/${id}/settings`)}/>;
}
