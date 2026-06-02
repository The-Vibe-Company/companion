import { FadeIn } from "./FadeIn";
import { InstallBlock } from "./InstallBlock";

export function GetStarted() {
  return (
    <section className="py-24 px-5 sm:px-7">
      <div className="max-w-[1060px] mx-auto text-center">
        <div className="w-full max-w-[160px] h-0.5 bg-cc-border rounded-full mx-auto mb-11" />
        <div className="cc-label mb-4">Get Running</div>

        <h2 className="font-condensed text-[clamp(44px,8vw,76px)] uppercase leading-[0.9] mb-10 tracking-tight">
          Local Or Remote
          <br />
          Same Workflow
        </h2>

        <FadeIn>
          <InstallBlock large />
        </FadeIn>

        <FadeIn className="mt-8">
          <div className="flex justify-center gap-6 flex-wrap text-sm text-cc-muted">
            {[
              "Bun runtime",
              "Codex CLI or Claude Code",
              "Optional Tailscale for secure remote access",
            ].map((req) => (
              <span key={req} className="flex items-center gap-2 bg-cc-card border border-cc-border rounded-full px-4 py-2">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="#1e5e73" strokeWidth="1.5">
                  <polyline points="13 4 6 11 3 8" />
                </svg>
                {req}
              </span>
            ))}
          </div>
        </FadeIn>
      </div>
    </section>
  );
}
