import { ClawdLogo } from "./ClawdLogo";
import { InstallBlock } from "./InstallBlock";

export function Hero() {
  return (
    <section className="pt-14 sm:pt-20 pb-16 px-5 sm:px-7">
      <div className="max-w-[1060px] mx-auto">
        <div className="cc-label animate-fade-up-1 mb-5 text-center">The Companion</div>
        <div className="animate-fade-up-2 mb-7 inline-flex w-full justify-center">
          <div className="cc-card rounded-2xl p-2 bg-cc-card">
            <div className="bg-[#efe3cd] rounded-xl px-4 py-2.5">
              <ClawdLogo size={72} />
            </div>
          </div>
        </div>

        <h1 className="font-condensed text-center text-[clamp(54px,13vw,126px)] uppercase tracking-tight leading-[0.86] mb-6 animate-sweep">
          Codex + Claude Code
          <br />
          <span className="text-cc-primary">One WebUI</span>
        </h1>

        <p className="text-center text-[clamp(16px,2.5vw,20px)] text-cc-muted max-w-[760px] mx-auto mb-10 leading-relaxed animate-fade-up-3">
          Pilot your coding agents in one browser workspace: connect MCP servers, open a terminal, create model-specific
          environments, and run sessions locally or on a remote server.
        </p>

        <div className="animate-fade-up-4 text-center">
          <InstallBlock />
        </div>

        <p className="mt-4 text-center text-sm text-cc-muted animate-fade-up-4">
          Then open{" "}
          <code className="font-mono-code text-[13px] bg-cc-card border border-cc-border px-1.5 py-0.5 rounded">
            localhost:3456
          </code>
        </p>

        <div className="mt-8 mx-auto max-w-[860px] cc-card bg-cc-card rounded-2xl p-4 sm:p-5 animate-fade-up-4">
          <p className="text-xs uppercase tracking-[0.16em] text-cc-muted text-center mb-3">Works With</p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <span className="inline-flex items-center gap-2 border border-cc-border rounded-full px-3 py-1.5 bg-[#f3e6d1]">
              <img src="/logos/codex.svg" alt="Codex" className="w-4 h-4" />
              <span className="font-mono-code text-xs">Codex</span>
            </span>
            <span className="inline-flex items-center gap-2 border border-cc-border rounded-full px-3 py-1.5 bg-[#f3e6d1]">
              <img src="/logos/anthropic.ico" alt="Anthropic" className="w-4 h-4 rounded-sm" />
              <span className="font-mono-code text-xs">Claude Code</span>
            </span>
            <span className="inline-flex items-center gap-2 border border-cc-border rounded-full px-3 py-1.5 bg-[#f3e6d1]">
              <img src="/logos/tailscale.svg" alt="Tailscale" className="w-4 h-4" />
              <span className="font-mono-code text-xs">Tailscale</span>
            </span>
            <span className="inline-flex items-center border border-cc-border rounded-full px-3 py-1.5 bg-cc-card">
              <span className="font-mono-code text-xs">GLM 5</span>
            </span>
            <span className="inline-flex items-center border border-cc-border rounded-full px-3 py-1.5 bg-cc-card">
              <span className="font-mono-code text-xs">Minimax 2.5</span>
            </span>
            <span className="inline-flex items-center border border-cc-border rounded-full px-3 py-1.5 bg-cc-card">
              <span className="font-mono-code text-xs">Kimi K2.5</span>
            </span>
          </div>
        </div>

        <div className="mt-8 mx-auto max-w-[760px] cc-card bg-cc-card rounded-2xl p-5 sm:p-6 animate-fade-up-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-center">
            {[
              ["MCP Native", "Attach MCP servers and expose tools/resources directly to Codex and Claude Code sessions."],
              ["Web Terminal", "Open terminal tabs in the UI for logs, scripts, and quick ops next to agent output."],
              ["Env Profiles", "Create launch profiles with model/provider settings and reuse them across projects."],
            ].map(([title, body]) => (
              <div key={title}>
                <h3 className="font-condensed text-xl uppercase tracking-wide">{title}</h3>
                <p className="text-sm text-cc-muted leading-relaxed mt-1.5">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
