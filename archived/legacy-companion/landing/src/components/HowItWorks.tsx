import { FadeIn } from "./FadeIn";

export function HowItWorks() {
  return (
    <section className="py-24 px-5 sm:px-7">
      <div className="max-w-[1060px] mx-auto">
        <div className="cc-label mb-3">Architecture</div>
        <h2 className="font-condensed text-[clamp(38px,6vw,64px)] uppercase leading-[0.92] mb-10 tracking-tight">
          One Bridge
          <br />
          Two Agents
        </h2>

        <FadeIn>
          <div className="cc-card rounded-2xl p-4 sm:p-6 mb-12 bg-cc-card">
            <div className="flex items-center justify-center gap-4 flex-wrap">
              <div className="bg-[#f0e5d2] border border-cc-border rounded-[10px] px-5 py-3.5 text-sm font-mono-code whitespace-nowrap">
                Codex + Claude Code CLI
              </div>
              <span className="text-cc-muted font-mono-code text-xs">&larr; WebSocket &rarr;</span>
              <div className="bg-cc-primary text-[#fff4eb] border border-[#8e3518] rounded-[10px] px-5 py-3.5 text-sm font-mono-code whitespace-nowrap">
                Companion Server
              </div>
              <span className="text-cc-muted font-mono-code text-xs">&larr; WebSocket &rarr;</span>
              <div className="bg-[#f0e5d2] border border-cc-border rounded-[10px] px-5 py-3.5 text-sm font-mono-code whitespace-nowrap">
                Browser UI + Terminal + MCP
              </div>
            </div>
          </div>
        </FadeIn>

        <FadeIn>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-5 max-w-[900px] mx-auto">
            {[
              {
                step: 1,
                title: "Launch",
                description: (
                  <>
                    Run <code className="font-mono-code text-xs bg-cc-code-bg text-cc-code-fg px-1.5 py-0.5 rounded">bunx the-companion</code>.
                  </>
                ),
              },
              {
                step: 2,
                title: "Configure",
                description: "Add MCP servers, define environment profiles, and select your model/provider backend.",
              },
              {
                step: 3,
                title: "Operate",
                description: "Work from one UI with live streams, tool visibility, terminal access, and permission control.",
              },
            ].map((s) => (
              <div key={s.step} className="cc-card rounded-[14px] p-5 bg-cc-card">
                <div className="w-9 h-9 rounded-md bg-cc-accent text-[#dbf4ff] inline-flex items-center justify-center text-sm font-semibold mb-3 font-mono-code">
                  0{s.step}
                </div>
                <h3 className="font-condensed text-2xl uppercase tracking-wide mb-1.5">{s.title}</h3>
                <p className="text-sm text-cc-muted leading-relaxed">{s.description}</p>
              </div>
            ))}
          </div>
        </FadeIn>
      </div>
    </section>
  );
}
