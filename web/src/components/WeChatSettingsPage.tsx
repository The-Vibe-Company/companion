import { useEffect, useState, useCallback, useRef } from "react";
import { api, type AppSettings } from "../api.js";

interface WeChatStatus {
  running: boolean;
  starting: boolean;
  error: string | null;
  connectedUsers: number;
  qrCode: string | null;
  reconnecting: boolean;
}

interface WeChatUserSession {
  userId: string;
  activeSession: string | null;
  sessionCount: number;
}

interface WeChatSettingsPageProps {
  embedded?: boolean;
}

export function WeChatSettingsPage({ embedded = false }: WeChatSettingsPageProps) {
  const [status, setStatus] = useState<WeChatStatus | null>(null);
  const [sessions, setSessions] = useState<WeChatUserSession[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const [s, sess, sett] = await Promise.all([
        api.getWeChatStatus(),
        api.getWeChatSessions(),
        api.getSettings(),
      ]);
      setStatus(s);
      setSessions(sess.sessions);
      setSettings(sett);
      // Show start error from backend
      if (s.error && !s.running && !s.starting) {
        setError(s.error);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // Poll while starting (waiting for QR scan / login)
  useEffect(() => {
    if (status?.starting && !pollRef.current) {
      pollRef.current = setInterval(loadStatus, 2000);
    }
    if (!status?.starting && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [status?.starting, loadStatus]);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const handleStart = async () => {
    setLoading(true);
    setError("");
    try {
      await api.startWeChat();
      await loadStatus();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setLoading(false);
  };

  const handleStop = async () => {
    setLoading(true);
    try {
      await api.stopWeChat();
      await loadStatus();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setLoading(false);
  };

  const handleRelogin = async () => {
    setLoading(true);
    setError("");
    try {
      await api.reloginWeChat();
      await loadStatus();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setLoading(false);
  };

  const handleToggle = async (field: string, value: boolean) => {
    try {
      await api.updateSettings({ [field]: value });
      await loadStatus();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleSettingChange = async (patch: Record<string, unknown>) => {
    try {
      await api.updateSettings(patch);
      await loadStatus();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleDeleteSession = async (userId: string) => {
    try {
      await api.deleteWeChatSession(userId);
      await loadStatus();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className={`${embedded ? "h-full" : "h-[100dvh]"} bg-cc-bg text-cc-fg font-sans-ui antialiased overflow-y-auto`}>
      <div className="max-w-3xl mx-auto px-4 sm:px-8 py-6 sm:py-10 pb-safe">
        <h1 className="text-xl font-semibold text-cc-fg mb-1">WeChat Bot</h1>
        <p className="text-sm text-cc-muted mb-6">
          Control Claude Code sessions from WeChat. Scan a QR code to connect, then send messages and commands.
        </p>

        {error && (
          <div className="mb-4 px-3 py-2 rounded-lg bg-cc-error/10 border border-cc-error/20 text-xs text-cc-error">
            {error}
          </div>
        )}

        {/* Bot Status */}
        <section className="mb-6 p-4 rounded-xl border border-cc-border/80 bg-cc-card">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className={`inline-block h-2.5 w-2.5 rounded-full ${status?.running ? "bg-cc-success" : status?.reconnecting ? "bg-orange-400 animate-pulse" : status?.starting ? "bg-yellow-400 animate-pulse" : "bg-cc-muted/40"}`} />
              <span className="text-sm font-medium">
                {status?.running ? "Running" : status?.reconnecting ? "Reconnecting..." : status?.starting ? "Starting..." : "Stopped"}
              </span>
              {status?.running && (
                <span className="text-xs text-cc-muted">
                  {status.connectedUsers} user{status.connectedUsers !== 1 ? "s" : ""} connected
                </span>
              )}
            </div>
            <div className="flex gap-2">
              {!status?.running && !status?.starting && !status?.reconnecting ? (
                <button
                  onClick={handleStart}
                  disabled={loading}
                  className="px-3 py-1.5 text-xs font-medium rounded-lg bg-cc-primary/15 border border-cc-primary/30 text-cc-fg hover:bg-cc-primary/25 transition-colors disabled:opacity-50 cursor-pointer"
                >
                  Start
                </button>
              ) : status?.running ? (
                <>
                  <button
                    onClick={handleStop}
                    disabled={loading}
                    className="px-3 py-1.5 text-xs font-medium rounded-lg bg-cc-error/15 border border-cc-error/30 text-cc-fg hover:bg-cc-error/25 transition-colors disabled:opacity-50 cursor-pointer"
                  >
                    Stop
                  </button>
                  <button
                    onClick={handleRelogin}
                    disabled={loading}
                    className="px-3 py-1.5 text-xs font-medium rounded-lg bg-yellow-500/15 border border-yellow-500/30 text-cc-fg hover:bg-yellow-500/25 transition-colors disabled:opacity-50 cursor-pointer"
                  >
                    Re-login
                  </button>
                </>
              ) : null}
            </div>
          </div>
          {status?.error && !status.running && !status.starting && (
            <p className="mt-2 text-xs text-cc-error">{status.error}</p>
          )}
        </section>

        {/* QR Code */}
        {status?.qrCode && (
          <section className="mb-6 p-4 rounded-xl border border-cc-border/80 bg-cc-card">
            <h2 className="text-sm font-medium mb-2">Scan to Login</h2>
            <p className="text-xs text-cc-muted mb-3">Open WeChat and scan this QR code to connect.</p>
            <div className="p-3 bg-white rounded-lg inline-block">
              <img src={status.qrCode} alt="WeChat QR Code" className="w-48 h-48" />
            </div>
          </section>
        )}

        {/* Settings */}
        <section className="mb-6 p-4 rounded-xl border border-cc-border/80 bg-cc-card">
          <h2 className="text-sm font-medium mb-3">Settings</h2>
          <div className="space-y-3">
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={Boolean(settings?.wechatEnabled)}
                onChange={(e) => handleToggle("wechatEnabled", e.target.checked)}
                className="accent-cc-primary"
              />
              <div>
                <div className="text-sm">Enable WeChat Bot</div>
                <div className="text-xs text-cc-muted">Auto-start the bot when the server starts</div>
              </div>
            </label>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={Boolean(settings?.wechatAutoApproveSafe)}
                onChange={(e) => handleToggle("wechatAutoApproveSafe", e.target.checked)}
                className="accent-cc-primary"
              />
              <div>
                <div className="text-sm">Auto-approve safe tools</div>
                <div className="text-xs text-cc-muted">Read, Glob, Grep, etc. are approved automatically</div>
              </div>
            </label>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={Boolean(settings?.wechatForwardDangerous)}
                onChange={(e) => handleToggle("wechatForwardDangerous", e.target.checked)}
                className="accent-cc-primary"
              />
              <div>
                <div className="text-sm">Forward dangerous permissions</div>
                <div className="text-xs text-cc-muted">Bash (rm), Write, Edit are sent to WeChat for approval</div>
              </div>
            </label>
            <div className="pt-2">
              <label htmlFor="wechat-allowed-users" className="block text-sm mb-1">Allowed Users</label>
              <p className="text-xs text-cc-muted mb-1.5">Comma-separated WeChat user IDs. Leave empty to allow all users.</p>
              <input
                id="wechat-allowed-users"
                type="text"
                value={settings?.wechatAllowedUsers ?? ""}
                placeholder="e.g. wxid_abc123,wxid_def456"
                onBlur={(e) => handleSettingChange({ wechatAllowedUsers: e.target.value })}
                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                onChange={(e) => setSettings((prev) => prev ? { ...prev, wechatAllowedUsers: e.target.value } : prev)}
                className="w-full px-3 py-1.5 text-sm rounded-lg border border-cc-border bg-cc-bg text-cc-fg placeholder:text-cc-muted/50 focus:outline-none focus:ring-1 focus:ring-cc-primary/50"
              />
            </div>
            <div className="pt-2">
              <label htmlFor="wechat-permission-mode" className="block text-sm mb-1">Default Permission Mode</label>
              <p className="text-xs text-cc-muted mb-1.5">Permission mode for new WeChat sessions.</p>
              <select
                id="wechat-permission-mode"
                value={settings?.wechatDefaultPermissionMode ?? "acceptEdits"}
                onChange={(e) => handleSettingChange({ wechatDefaultPermissionMode: e.target.value })}
                className="w-full px-3 py-1.5 text-sm rounded-lg border border-cc-border bg-cc-bg text-cc-fg focus:outline-none focus:ring-1 focus:ring-cc-primary/50"
              >
                <option value="acceptEdits">Accept Edits</option>
                <option value="bypassPermissions">Bypass Permissions</option>
                <option value="plan">Plan</option>
                <option value="default">Default</option>
              </select>
            </div>
            <div className="pt-2">
              <label htmlFor="wechat-default-cwd" className="block text-sm mb-1">Default Working Directory</label>
              <p className="text-xs text-cc-muted mb-1.5">Base directory for /new and /dir commands. /new &lt;folder&gt; will create subdirectories under this path.</p>
              <input
                id="wechat-default-cwd"
                type="text"
                value={settings?.wechatDefaultCwd ?? ""}
                placeholder="e.g. /home/user/projects"
                onBlur={(e) => handleSettingChange({ wechatDefaultCwd: e.target.value })}
                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                onChange={(e) => setSettings((prev) => prev ? { ...prev, wechatDefaultCwd: e.target.value } : prev)}
                className="w-full px-3 py-1.5 text-sm rounded-lg border border-cc-border bg-cc-bg text-cc-fg placeholder:text-cc-muted/50 focus:outline-none focus:ring-1 focus:ring-cc-primary/50"
              />
            </div>
          </div>
        </section>

        {/* Active Sessions */}
        {sessions.length > 0 && (
          <section className="p-4 rounded-xl border border-cc-border/80 bg-cc-card">
            <h2 className="text-sm font-medium mb-3">Active WeChat Sessions</h2>
            <div className="space-y-2">
              {sessions.map((s) => (
                <div key={s.userId} className="flex items-center justify-between px-3 py-2 rounded-lg bg-cc-hover/50">
                  <div>
                    <div className="text-xs font-mono text-cc-fg">{s.userId.slice(0, 20)}...</div>
                    <div className="text-xs text-cc-muted">
                      {s.sessionCount} session{s.sessionCount !== 1 ? "s" : ""}
                      {s.activeSession ? ` (active: ${s.activeSession.slice(0, 8)}...)` : ""}
                    </div>
                  </div>
                  <button
                    onClick={() => handleDeleteSession(s.userId)}
                    className="px-2 py-1 text-xs rounded border border-cc-error/30 text-cc-error hover:bg-cc-error/10 transition-colors cursor-pointer"
                  >
                    Kill
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
