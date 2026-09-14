import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, CircleAlert, LoaderCircle } from "lucide-react";
import { api, ApiError, type Companion } from "@/api";
import { CompanionAvatar } from "./CompanionAvatar";
import { CompanionConfiguration } from "./CompanionConfiguration";
import { DesktopSheet } from "./CompanionAccount";
import { Button } from "./ui/button";

export function CompanionSettingsPage({ id, onBack, onUnauthorized, onApplications }: { id: string; onBack: () => void; onUnauthorized: () => void; onApplications?: () => void }) {
  const [companion, setCompanion] = useState<Companion | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try { const result = await api.getCompanion(id); setCompanion(result.companion); setError(""); }
    catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) onUnauthorized();
      setError(cause instanceof Error ? cause.message : "Could not load settings.");
    } finally { setLoading(false); }
  }, [id, onUnauthorized]);
  useEffect(() => { void refresh(); }, [refresh]);
  return <main className="account-page companion-settings-page">
    <header className="standalone-header"><Button variant="ghost" size="icon" onClick={onBack} aria-label="Back to discussions"><ArrowLeft/></Button><div><h1>{companion ? `${companion.name} settings` : "Companion settings"}</h1><p>Identity, application access and computer controls.</p></div></header>
    <div className="account-inner">
      {error && <div className="application-access-error" role="alert"><CircleAlert/><span>{error}</span><Button variant="outline" onClick={() => void refresh()}>Try again</Button></div>}
      {loading ? <p className="detail-loading" role="status"><LoaderCircle className="spin"/>Loading settings…</p> : companion && <>
        <div className="settings-portrait"><CompanionAvatar name={companion.name} avatar={companion.avatar} size={72}/><div><strong>{companion.name}</strong><p>{companion.retiredAt ? "Retired" : "Your personal Companion"}</p></div></div>
        {companion.retiredAt ? <p>This Companion has been retired. Its discussion history remains available.</p> : <>
          <CompanionConfiguration key={id} companion={companion} onRefresh={refresh} onRetired={onBack} onApplications={onApplications}/>
          {companion.provider === "box" && <section className="settings-computer"><h2>Computer</h2><DesktopSheet companion={companion} onClose={() => {}} onRefresh={refresh} embedded/></section>}
        </>}
      </>}
    </div>
  </main>;
}
