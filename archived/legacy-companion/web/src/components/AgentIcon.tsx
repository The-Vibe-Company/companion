// SVG agent icon definitions — each value is a key used by <AgentIcon>
export const AGENT_ICON_OPTIONS = [
  "bot", "terminal", "pencil", "search", "shield", "chart", "flask",
  "rocket", "wrench", "clipboard", "lightbulb", "code", "globe", "zap",
  "database", "git-branch", "mail", "cpu",
] as const;

/** Renders an SVG icon for agent cards and the picker */
export function AgentIcon({ icon, className = "w-5 h-5" }: { icon: string; className?: string }) {
  const cls = `${className} shrink-0`;
  const props = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, className: cls, role: "img" as const, "aria-label": icon || "bot" };

  switch (icon) {
    case "bot":
      return <svg {...props}><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="9" cy="16" r="1"/><circle cx="15" cy="16" r="1"/><path d="M12 2v4"/><path d="M8 7h8"/><circle cx="12" cy="2" r="1"/></svg>;
    case "terminal":
      return <svg {...props}><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>;
    case "pencil":
      return <svg {...props}><path d="M17 3a2.83 2.83 0 114 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>;
    case "search":
      return <svg {...props}><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>;
    case "shield":
      return <svg {...props}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>;
    case "chart":
      return <svg {...props}><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>;
    case "flask":
      return <svg {...props}><path d="M9 3h6V8l5 10a1 1 0 01-.9 1.4H4.9A1 1 0 014 18L9 8V3z"/><line x1="9" y1="3" x2="15" y2="3"/></svg>;
    case "rocket":
      return <svg {...props}><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 00-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 012-3.95A12.88 12.88 0 0122 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 01-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></svg>;
    case "wrench":
      return <svg {...props}><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/></svg>;
    case "clipboard":
      return <svg {...props}><path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/></svg>;
    case "lightbulb":
      return <svg {...props}><path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 00-3 13.33V17h6v-1.67A7 7 0 0012 2z"/></svg>;
    case "code":
      return <svg {...props}><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>;
    case "globe":
      return <svg {...props}><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>;
    case "zap":
      return <svg {...props}><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>;
    case "database":
      return <svg {...props}><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>;
    case "git-branch":
      return <svg {...props}><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 01-9 9"/></svg>;
    case "mail":
      return <svg {...props}><rect x="2" y="4" width="20" height="16" rx="2"/><polyline points="22 7 12 13 2 7"/></svg>;
    case "cpu":
      return <svg {...props}><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></svg>;
    default:
      // Fallback for legacy emoji values — render as text
      if (icon) return <span className={className}>{icon}</span>;
      return <svg {...props}><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="9" cy="16" r="1"/><circle cx="15" cy="16" r="1"/><path d="M12 2v4"/><path d="M8 7h8"/><circle cx="12" cy="2" r="1"/></svg>;
  }
}
