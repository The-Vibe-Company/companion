import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useStore } from "../store.js";
import { api } from "../api.js";
import type { PortStatusInfo, ServiceInfo } from "../store/environment-slice.js";
import { SessionBrowserPane } from "./SessionBrowserPane.js";

const EMPTY_PORTS: PortStatusInfo[] = [];
const EMPTY_SERVICES: ServiceInfo[] = [];
const EMPTY_SERVICE_LOGS = new Map<string, string[]>();
const MIN_SIDEBAR = 220;
const MAX_SIDEBAR = 420;
const DEFAULT_SIDEBAR = 280;

/** Right panel mode: either viewing service logs or a browser preview. */
type RightPanelMode =
  | { kind: "none" }
  | { kind: "service"; serviceName: string }
  | { kind: "browser" };

/**
 * Unified Environment panel — vertical split layout.
 * Left: services + ports + config controls.
 * Right: service log view or browser preview.
 */
export function EnvironmentPanel({ sessionId }: { sessionId: string }) {
  const portStatuses = useStore((s) => s.portStatuses.get(sessionId) ?? EMPTY_PORTS);
  const serviceStatuses = useStore((s) => s.serviceStatuses.get(sessionId) ?? EMPTY_SERVICES);
  const activePort = useStore((s) => s.activePort.get(sessionId) ?? null);
  const setActivePort = useStore((s) => s.setActivePort);
  const isSandbox = useStore((s) => s.sessions.get(sessionId)?.is_containerized ?? false);
  const setPendingBrowserUrl = useStore((s) => s.setPendingBrowserUrl);
  const setServiceStatuses = useStore((s) => s.setServiceStatuses);
  const serviceLogs = useStore((s) => s.serviceLogs.get(sessionId) ?? EMPTY_SERVICE_LOGS);

  const [iframeUrl, setIframeUrl] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR);
  const [reloading, setReloading] = useState(false);
  const [pendingServiceActions, setPendingServiceActions] = useState<Record<string, "restart" | "stop" | undefined>>({});
  const [panelMode, setPanelMode] = useState<RightPanelMode>({ kind: "none" });

  // Fetch configured services on mount (includes stopped/not-yet-started services from launch.json)
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.getServices(sessionId).catch(() => null),
      api.getPortStatuses(sessionId).catch(() => null),
    ]).then(([services, ports]) => {
      if (cancelled) return;
      if (services && services.length > 0) {
        setServiceStatuses(sessionId, services as ServiceInfo[]);
      }
      if (ports && ports.length > 0) {
        useStore.getState().setPortStatuses(sessionId, ports as PortStatusInfo[]);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [sessionId, setServiceStatuses]);

  // Build proxy URL for a given port
  const proxyUrlForPort = useCallback(
    (port: number, path = "/") =>
      `/api/sessions/${encodeURIComponent(sessionId)}/browser/host-proxy/${port}${path}`,
    [sessionId],
  );

  // Open a port in the browser preview
  const openPort = useCallback(
    (port: number) => {
      if (isSandbox) {
        setActivePort(sessionId, port);
        setPendingBrowserUrl(sessionId, `http://localhost:${port}`);
        setPanelMode({ kind: "browser" });
      } else {
        setActivePort(sessionId, port);
        setIframeUrl(proxyUrlForPort(port));
        setPanelMode({ kind: "browser" });
      }
    },
    [sessionId, isSandbox, setActivePort, setPendingBrowserUrl, proxyUrlForPort],
  );

  // Select a service for log viewing
  const selectService = useCallback((serviceName: string) => {
    setPanelMode({ kind: "service", serviceName });
  }, []);

  // Manual health check
  const refreshPort = useCallback(
    async (port: number) => {
      try { await api.checkPort(sessionId, port); } catch { /* ignore */ }
    },
    [sessionId],
  );

  // Reload config
  const reloadConfig = useCallback(async () => {
    setReloading(true);
    try { await api.reloadLaunchConfig(sessionId); } catch { /* ignore */ }
    finally { setReloading(false); }
  }, [sessionId]);

  // Restart a service
  const handleRestart = useCallback(async (serviceName: string) => {
    setPendingServiceActions((current) => ({ ...current, [serviceName]: "restart" }));
    try { await api.restartService(sessionId, serviceName); } catch { /* ignore */ }
    finally {
      setPendingServiceActions((current) => {
        const next = { ...current };
        delete next[serviceName];
        return next;
      });
    }
  }, [sessionId]);

  // Stop a service
  const handleStop = useCallback(async (serviceName: string) => {
    setPendingServiceActions((current) => ({ ...current, [serviceName]: "stop" }));
    try { await api.stopService(sessionId, serviceName); } catch { /* ignore */ }
    finally {
      setPendingServiceActions((current) => {
        const next = { ...current };
        delete next[serviceName];
        return next;
      });
    }
  }, [sessionId]);

  // Auto-navigate on openOnReady
  const prevStatusRef = useRef<Map<number, string>>(new Map());
  useEffect(() => {
    for (const ps of portStatuses) {
      const prev = prevStatusRef.current.get(ps.port);
      if (ps.openOnReady && ps.status === "healthy" && prev !== "healthy") {
        openPort(ps.port);
        break;
      }
    }
    const next = new Map<number, string>();
    for (const ps of portStatuses) next.set(ps.port, ps.status);
    prevStatusRef.current = next;
  }, [portStatuses, openPort]);

  // Resize handle drag
  const isDragging = useRef(false);
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    const startX = e.clientX;
    const startW = sidebarWidth;
    const onMove = (ev: MouseEvent) => {
      if (!isDragging.current) return;
      const delta = ev.clientX - startX;
      setSidebarWidth(Math.min(MAX_SIDEBAR, Math.max(MIN_SIDEBAR, startW + delta)));
    };
    const onUp = () => {
      isDragging.current = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [sidebarWidth]);

  const hasServices = serviceStatuses.length > 0;
  const hasPorts = portStatuses.length > 0;
  const hasContent = hasServices || hasPorts;
  const showBrowser = panelMode.kind === "browser";
  const canOpenSandboxBrowser = isSandbox && (!hasPorts || !showBrowser);

  const openSandboxBrowser = useCallback(() => {
    setPendingBrowserUrl(sessionId, "http://localhost:3000");
    setPanelMode({ kind: "browser" });
  }, [sessionId, setPendingBrowserUrl]);

  const selectedService = useMemo(
    () =>
      panelMode.kind === "service"
        ? serviceStatuses.find((service) => service.name === panelMode.serviceName)
        : undefined,
    [panelMode, serviceStatuses],
  );

  const selectedServiceLogCount = useMemo(
    () =>
      panelMode.kind === "service"
        ? serviceLogs.get(panelMode.serviceName)?.length ?? 0
        : 0,
    [panelMode, serviceLogs],
  );

  return (
    <div className="flex h-full bg-cc-bg">
      {/* -- Left sidebar -- */}
      <div
        className="shrink-0 flex flex-col border-r border-cc-border overflow-hidden"
        style={{ width: sidebarWidth }}
      >
        {/* Header */}
        <div className="shrink-0 px-3 py-2 border-b border-cc-border flex items-center justify-between">
          <span className="text-[11px] font-semibold tracking-wide uppercase text-cc-muted">
            Environment
          </span>
          <button
            onClick={reloadConfig}
            disabled={reloading}
            title="Reload .companion/launch.json"
            className="p-1 text-cc-muted hover:text-cc-fg rounded transition-colors disabled:opacity-40 cursor-pointer"
          >
            <svg className={`w-3.5 h-3.5 ${reloading ? "animate-spin" : ""}`} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M13.5 8a5.5 5.5 0 0 1-10.39 2.5M2.5 8a5.5 5.5 0 0 1 10.39-2.5" />
              <path d="M13.5 3v3h-3M2.5 13v-3h3" />
            </svg>
          </button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto overflow-x-hidden">
          {/* Services section */}
          {hasServices && (
            <div className="px-2 py-2">
              <div className="px-1 pb-1.5 text-[10px] font-medium tracking-wider uppercase text-cc-muted/70">
                Services
              </div>
              <div className="space-y-0.5">
                {serviceStatuses.map((svc) => (
                  <ServiceCard
                    key={svc.name}
                    service={svc}
                    pendingAction={pendingServiceActions[svc.name]}
                    isSelected={panelMode.kind === "service" && panelMode.serviceName === svc.name}
                    onClick={() => selectService(svc.name)}
                    onRestart={() => handleRestart(svc.name)}
                    onStop={() => handleStop(svc.name)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Ports section */}
          {hasPorts && (
            <div className="px-2 py-2">
              <div className="px-1 pb-1.5 text-[10px] font-medium tracking-wider uppercase text-cc-muted/70">
                Ports
              </div>
              <div className="space-y-0.5">
                {portStatuses.map((ps) => (
                  <PortRow
                    key={ps.port}
                    portStatus={ps}
                    isActive={activePort === ps.port && showBrowser}
                    onClick={() => ps.protocol === "http" ? openPort(ps.port) : refreshPort(ps.port)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Empty state */}
          {!hasContent && (
            <div className="px-4 py-8 text-center">
              <div className="text-cc-muted text-xs leading-relaxed">
                {isSandbox
                  ? "No services configured yet. Open the browser preview or add a launch config to make this sandbox feel automatic."
                  : <>No services or ports configured. Add a <code className="px-1 py-0.5 bg-cc-hover rounded text-[10px]">.companion/launch.json</code> to your project.</>
                }
              </div>
              {canOpenSandboxBrowser && !showBrowser && (
                <button
                  type="button"
                  onClick={openSandboxBrowser}
                  className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-cc-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-cc-primary-hover transition-colors cursor-pointer"
                >
                  Open browser preview
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* -- Resize handle -- */}
      <div
        className="w-0 relative shrink-0 cursor-col-resize group z-10"
        onMouseDown={handleMouseDown}
      >
        <div className="absolute inset-y-0 -left-[2px] w-[4px] group-hover:bg-cc-primary/30 transition-colors" />
      </div>

      {/* -- Right panel -- */}
      <div className="flex-1 min-w-0 flex flex-col">
        {panelMode.kind === "service" ? (
          <ServiceLogView
            sessionId={sessionId}
            serviceName={panelMode.serviceName}
            service={selectedService}
            isRestarting={pendingServiceActions[panelMode.serviceName] === "restart"}
            initialLogCount={selectedServiceLogCount}
            onRestart={() => handleRestart(panelMode.serviceName)}
            onStop={() => handleStop(panelMode.serviceName)}
          />
        ) : showBrowser && isSandbox ? (
          <SessionBrowserPane sessionId={sessionId} />
        ) : showBrowser && iframeUrl ? (
          <BrowserPreview
            sessionId={sessionId}
            iframeUrl={iframeUrl}
            onUrlChange={setIframeUrl}
            proxyUrlForPort={proxyUrlForPort}
          />
        ) : (
          <EmptyBrowserState
            isSandbox={isSandbox}
            hasPorts={hasPorts}
            onOpenSandboxBrowser={canOpenSandboxBrowser ? openSandboxBrowser : undefined}
          />
        )}
      </div>
    </div>
  );
}

// -- Service Log View --------------------------------------------------------

function ServiceLogView({
  sessionId,
  serviceName,
  service,
  isRestarting,
  initialLogCount,
  onRestart,
  onStop,
}: {
  sessionId: string;
  serviceName: string;
  service?: ServiceInfo;
  isRestarting: boolean;
  initialLogCount: number;
  onRestart: () => void;
  onStop: () => void;
}) {
  const logLines = useStore((s) => s.serviceLogs.get(sessionId)?.get(serviceName) ?? []);
  const setServiceLogs = useStore((s) => s.setServiceLogs);
  const logContainerRef = useRef<HTMLPreElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [historicalLoaded, setHistoricalLoaded] = useState(false);
  const hydratedRef = useRef(false);

  // Fetch historical logs on mount / service change
  useEffect(() => {
    setHistoricalLoaded(false);
    if (hydratedRef.current) {
      setHistoricalLoaded(true);
      return;
    }
    let cancelled = false;
    api.getServiceLogs(sessionId, serviceName).then((res) => {
      if (cancelled) return;
      if (res.logs && (initialLogCount === 0 || res.logs.length > initialLogCount)) {
        setServiceLogs(sessionId, serviceName, res.logs);
      }
      hydratedRef.current = true;
      setHistoricalLoaded(true);
    }).catch(() => {
      hydratedRef.current = true;
      if (!cancelled) setHistoricalLoaded(true);
    });
    return () => { cancelled = true; };
  }, [sessionId, serviceName, initialLogCount, setServiceLogs]);

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (autoScroll && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logLines, autoScroll]);

  // Detect if user scrolled away from bottom
  const handleScroll = useCallback(() => {
    const el = logContainerRef.current;
    if (!el) return;
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(isAtBottom);
  }, []);

  const status = service?.status ?? "stopped";
  const isRunning = status === "ready" || status === "started" || status === "starting";
  const statusColor = STATUS_COLORS[status] ?? "bg-cc-muted/40";

  return (
    <div className="flex flex-col h-full">
      {/* Header with service info and action buttons */}
      <div className="shrink-0 px-3 py-2 border-b border-cc-border flex items-center gap-2">
        <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${statusColor}`} />
        <span className="font-medium text-sm text-cc-fg truncate">{serviceName}</span>
        {service?.port && (
          <span className="text-[11px] text-cc-muted tabular-nums">:{service.port}</span>
        )}
        <span className="text-[10px] text-cc-muted uppercase tracking-wider">{status}</span>

        <div className="ml-auto flex items-center gap-1.5">
          {isRunning && (
            <button
              onClick={onStop}
              title={`Stop ${serviceName}`}
              className="px-2 py-1 text-[11px] font-medium rounded bg-cc-hover text-cc-muted hover:text-cc-error hover:bg-red-500/10 transition-colors cursor-pointer"
            >
              Stop
            </button>
          )}
          <button
            onClick={onRestart}
            disabled={isRestarting}
            title={`Restart ${serviceName}`}
            className="px-2 py-1 text-[11px] font-medium rounded bg-cc-hover text-cc-muted hover:text-cc-primary hover:bg-cc-primary/10 transition-colors disabled:opacity-40 cursor-pointer flex items-center gap-1"
          >
            <svg className={`w-3 h-3 ${isRestarting ? "animate-spin" : ""}`} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M13.5 8a5.5 5.5 0 0 1-10.39 2.5M2.5 8a5.5 5.5 0 0 1 10.39-2.5" />
              <path d="M13.5 3v3h-3M2.5 13v-3h3" />
            </svg>
            Restart
          </button>
        </div>
      </div>

      {/* Log output area */}
      <pre
        ref={logContainerRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 overflow-auto px-3 py-2 bg-[#1a1a1a] font-mono text-[11px] leading-[1.6] text-[#d4d4d4] whitespace-pre-wrap break-all"
      >
        {!historicalLoaded && logLines.length === 0 && (
          <span className="text-cc-muted italic">Loading logs...</span>
        )}
        {historicalLoaded && logLines.length === 0 && (
          <span className="text-cc-muted italic">No log output yet.</span>
        )}
        {logLines.map((line, i) => (
          <div key={i}>{line}</div>
        ))}
      </pre>

      {/* Scroll-to-bottom indicator when not auto-scrolling */}
      {!autoScroll && (
        <button
          onClick={() => {
            setAutoScroll(true);
            if (logContainerRef.current) {
              logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
            }
          }}
          className="absolute bottom-4 right-4 px-2 py-1 text-[10px] rounded bg-cc-primary/90 text-white hover:bg-cc-primary transition-colors cursor-pointer shadow-lg"
        >
          Scroll to bottom
        </button>
      )}
    </div>
  );
}

// -- Service Card ------------------------------------------------------------

const STATUS_COLORS: Record<string, string> = {
  ready: "bg-emerald-400",
  started: "bg-amber-400",
  starting: "bg-amber-400 animate-pulse",
  failed: "bg-red-400",
  stopped: "bg-cc-muted/40",
};

function ServiceCard({
  service,
  pendingAction,
  isSelected,
  onClick,
  onRestart,
  onStop,
}: {
  service: ServiceInfo;
  pendingAction?: "restart" | "stop";
  isSelected: boolean;
  onClick: () => void;
  onRestart: () => void;
  onStop: () => void;
}) {
  const isRunning = service.status === "ready" || service.status === "started" || service.status === "starting";
  const isRestarting = pendingAction === "restart";
  const isStopping = pendingAction === "stop";

  return (
    <div
      className={`group flex items-center gap-2 px-2 py-1.5 rounded text-xs transition-colors cursor-pointer ${
        isSelected ? "bg-cc-primary/10 text-cc-primary" : "hover:bg-cc-hover"
      }`}
      onClick={onClick}
    >
      {/* Status indicator */}
      <span className={`w-2 h-2 rounded-full shrink-0 ${STATUS_COLORS[service.status] ?? "bg-cc-muted/40"}`} />

      {/* Name + port */}
      <div className="flex-1 min-w-0">
        <span className={`font-medium truncate block ${isSelected ? "text-cc-primary" : "text-cc-fg"}`}>{service.name}</span>
      </div>
      {service.port && (
        <span className="text-[10px] text-cc-muted tabular-nums shrink-0">:{service.port}</span>
      )}

      {/* Actions (visible on hover) */}
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
        {isRunning && (
          <button
            onClick={(e) => { e.stopPropagation(); onStop(); }}
            disabled={isStopping}
            title={`Stop ${service.name}`}
            className="p-0.5 text-cc-muted hover:text-cc-error rounded transition-colors disabled:opacity-40 cursor-pointer"
          >
            <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor">
              <rect x="4" y="4" width="8" height="8" rx="1" />
            </svg>
          </button>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); onRestart(); }}
          disabled={isRestarting}
          title={`Restart ${service.name}`}
          className="p-0.5 text-cc-muted hover:text-cc-primary rounded transition-colors disabled:opacity-40 cursor-pointer"
        >
          <svg className={`w-3 h-3 ${isRestarting ? "animate-spin" : ""}`} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M13.5 8a5.5 5.5 0 0 1-10.39 2.5M2.5 8a5.5 5.5 0 0 1 10.39-2.5" />
            <path d="M13.5 3v3h-3M2.5 13v-3h3" />
          </svg>
        </button>
      </div>
    </div>
  );
}

// -- Port Row ----------------------------------------------------------------

const PORT_STATUS_COLORS: Record<string, string> = {
  healthy: "bg-emerald-400",
  unhealthy: "bg-red-400",
  unknown: "bg-amber-400",
};

function PortRow({
  portStatus,
  isActive,
  onClick,
}: {
  portStatus: PortStatusInfo;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs transition-colors cursor-pointer ${
        isActive
          ? "bg-cc-primary/10 text-cc-primary"
          : "text-cc-fg hover:bg-cc-hover"
      }`}
      title={`${portStatus.label} (:${portStatus.port}) — ${portStatus.status}${portStatus.service ? ` (${portStatus.service})` : ""}${portStatus.protocol === "tcp" ? " (TCP)" : ""}`}
    >
      <span className={`w-2 h-2 rounded-full shrink-0 ${PORT_STATUS_COLORS[portStatus.status] ?? "bg-amber-400"}`} />
      <span className="font-medium truncate">{portStatus.label}</span>
      <span className="text-[10px] text-cc-muted tabular-nums ml-auto shrink-0">:{portStatus.port}</span>
      {portStatus.protocol === "tcp" && (
        <span className="text-[9px] text-cc-muted/60 uppercase tracking-wider">tcp</span>
      )}
    </button>
  );
}

// -- Browser Preview (local/host mode) ---------------------------------------

function BrowserPreview({
  sessionId,
  iframeUrl,
  onUrlChange,
  proxyUrlForPort,
}: {
  sessionId: string;
  iframeUrl: string;
  onUrlChange: (url: string) => void;
  proxyUrlForPort: (port: number, path?: string) => string;
}) {
  // sessionId used for future per-session URL history; suppress lint
  void sessionId;
  const [navUrl, setNavUrl] = useState("");
  const [previewError, setPreviewError] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    setPreviewError(null);
  }, [iframeUrl]);

  const handleNavigate = useCallback(() => {
    if (!navUrl.trim()) return;
    setPreviewError(null);
    const url = navUrl.startsWith("http") ? navUrl : `http://${navUrl}`;
    try {
      const parsed = new URL(url);
      const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
      const subPath = parsed.pathname + parsed.search;
      onUrlChange(proxyUrlForPort(Number(port), subPath));
    } catch {
      onUrlChange(navUrl);
    }
  }, [navUrl, onUrlChange, proxyUrlForPort]);

  const detectEmbeddedChromeError = useCallback(() => {
    if (!iframeUrl.includes("/browser/host-proxy/")) return false;

    try {
      const doc = iframeRef.current?.contentDocument;
      const title = doc?.title?.trim();
      const bodyText = doc?.body?.textContent ?? "";
      if (
        title === "localhost" &&
        /ERR_CONNECTION_REFUSED|Ce site est inaccessible|n'autorise pas la connexion/i.test(bodyText)
      ) {
        setPreviewError("Preview request failed — the localhost app is not reachable from the Environment preview right now.");
        return true;
      }
    } catch {
      // Cross-origin access should not block the preview.
    }
    return false;
  }, [iframeUrl]);

  const handleReload = useCallback(() => {
    setPreviewError(null);
    if (iframeRef.current) {
      iframeRef.current.src = iframeUrl;
    }
  }, [detectEmbeddedChromeError, iframeUrl]);

  const handleIframeLoad = useCallback(() => {
    detectEmbeddedChromeError();
  }, [detectEmbeddedChromeError]);

  return (
    <div className="flex flex-col h-full">
      {/* URL bar */}
      <div className="shrink-0 px-3 py-2 border-b border-cc-border flex items-center gap-2">
        <button
          type="button"
          onClick={handleReload}
          className="flex items-center justify-center w-6 h-6 rounded text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
          title="Reload"
          aria-label="Reload preview status"
        >
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
            <path d="M13.65 2.35a1 1 0 0 0-1.3 0L11 3.7A5.99 5.99 0 0 0 2 8a1 1 0 1 0 2 0 4 4 0 0 1 6.29-3.29L8.65 6.35a1 1 0 0 0 .7 1.7H13a1 1 0 0 0 1-1V3.4a1 1 0 0 0-.35-.7z M14 8a1 1 0 1 0-2 0 4 4 0 0 1-6.29 3.29l1.64-1.64a1 1 0 0 0-.7-1.7H3.05a1 1 0 0 0-1 1v3.65a1 1 0 0 0 1.7.7L5 11.7A5.99 5.99 0 0 0 14 8z" />
          </svg>
        </button>
        <input
          type="text"
          value={navUrl}
          onChange={(e) => setNavUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleNavigate(); }}
          placeholder="localhost:3000"
          className="flex-1 px-2 py-1 text-xs rounded bg-cc-bg border border-cc-border text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary"
        />
        <button
          type="button"
          onClick={handleNavigate}
          className="px-2.5 py-1 rounded text-xs font-medium bg-cc-primary text-white hover:bg-cc-primary-hover transition-colors cursor-pointer"
        >
          Go
        </button>
      </div>

      {previewError && (
        <div className="shrink-0 px-3 py-2 text-xs text-amber-300 bg-amber-500/10 border-b border-amber-500/20">
          <div>{previewError}</div>
          <div className="mt-1 text-cc-muted">
            Vérifie que le serveur local répond bien et réessaie la preview.
          </div>
        </div>
      )}

      {/* iframe */}
      <div className="flex-1 min-h-0">
        <iframe
          ref={iframeRef}
          src={iframeUrl}
          className="w-full h-full border-0"
          sandbox="allow-scripts allow-forms allow-popups allow-same-origin"
          title="Environment preview"
          onLoad={handleIframeLoad}
        />
      </div>
    </div>
  );
}

// -- Empty Browser State -----------------------------------------------------

function EmptyBrowserState({
  isSandbox,
  hasPorts,
  onOpenSandboxBrowser,
}: {
  isSandbox: boolean;
  hasPorts: boolean;
  onOpenSandboxBrowser?: () => void;
}) {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="text-center px-6">
        <div className="w-10 h-10 mx-auto mb-3 rounded-lg bg-cc-hover flex items-center justify-center">
          <svg className="w-5 h-5 text-cc-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M3 9h18" />
            <circle cx="7" cy="6" r="0.5" fill="currentColor" />
            <circle cx="10" cy="6" r="0.5" fill="currentColor" />
          </svg>
        </div>
        <p className="text-xs text-cc-muted leading-relaxed max-w-[200px]">
          {hasPorts
            ? "Select a service or port to preview"
            : isSandbox
              ? "No services configured yet — you can still open the sandbox browser now."
              : <>Add a <code className="px-1 py-0.5 bg-cc-hover rounded text-[10px]">.companion/launch.json</code> to get started</>
          }
        </p>
        {onOpenSandboxBrowser && !hasPorts && (
          <button
            type="button"
            onClick={onOpenSandboxBrowser}
            className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-cc-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-cc-primary-hover transition-colors cursor-pointer"
          >
            Open browser preview
          </button>
        )}
      </div>
    </div>
  );
}
