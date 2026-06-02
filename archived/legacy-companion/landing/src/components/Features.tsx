import { FadeIn } from "./FadeIn";

const features = [
  {
    title: "Codex + Claude Code",
    description: "Run both agents side by side with independent contexts, permissions, and process isolation.",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="3" width="20" height="14" rx="2" />
        <path d="M8 21h8" />
        <path d="M12 17v4" />
        <path d="M12 10V3" />
      </svg>
    ),
  },
  {
    title: "MCP Integration",
    description: "Add and manage MCP servers from the UI so sessions can use your custom tools and data sources.",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3v18" />
        <path d="M3 12h18" />
        <circle cx="12" cy="12" r="9" />
      </svg>
    ),
  },
  {
    title: "Integrated Terminal",
    description: "Open terminal sessions in the browser to run commands without leaving your agent workspace.",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <polyline points="8 9 11 12 8 15" />
        <line x1="13" y1="15" x2="17" y2="15" />
      </svg>
    ),
  },
  {
    title: "Environment Profiles",
    description: "Create dedicated environments for specific providers and models, then launch in one click.",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 7h16" />
        <path d="M7 3v4" />
        <path d="M17 3v4" />
        <rect x="4" y="7" width="16" height="14" rx="2" />
        <path d="M9 13h6" />
      </svg>
    ),
  },
  {
    title: "Model Routing",
    description: "Launch Claude Code with different backends like GLM 5, Minimax 2.5, or Kimi K2.5 via env configuration.",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M3 12h6" />
        <path d="M15 12h6" />
        <path d="M12 3v6" />
        <path d="M12 15v6" />
      </svg>
    ),
  },
  {
    title: "Secure Remote Ops",
    description: "Run Companion on a calm remote server and expose it safely over Tailscale for private access.",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7l8-4z" />
        <path d="M9 12l2 2 4-4" />
      </svg>
    ),
  },
];

export function Features() {
  return (
    <section className="py-24 px-5 sm:px-7">
      <div className="max-w-[1060px] mx-auto">
        <div className="cc-label mb-3">Capabilities</div>
        <h2 className="font-condensed text-[clamp(40px,6vw,72px)] uppercase leading-[0.92] mb-10 tracking-tight">
          Built For
          <br />
          Real Work
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {features.map((f) => (
            <FadeIn key={f.title}>
              <div className="cc-card bg-cc-card rounded-[16px] p-6 sm:p-7 transition-all duration-200 hover:-translate-y-1 hover:shadow-[0_16px_24px_rgba(34,25,17,0.14)] h-full">
                <div className="w-10 h-10 rounded-[10px] bg-[color-mix(in_srgb,var(--color-cc-primary)_14%,white)] flex items-center justify-center mb-4">
                  <div className="w-[18px] h-[18px] text-cc-primary">{f.icon}</div>
                </div>
                <h3 className="font-condensed text-[26px] uppercase tracking-wide leading-none mb-2">{f.title}</h3>
                <p className="text-[15px] text-cc-muted leading-relaxed">{f.description}</p>
              </div>
            </FadeIn>
          ))}
        </div>
      </div>
    </section>
  );
}
