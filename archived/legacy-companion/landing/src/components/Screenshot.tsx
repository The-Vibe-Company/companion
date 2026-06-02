import { FadeIn } from "./FadeIn";

export function Screenshot() {
  return (
    <section className="pb-24 px-5 sm:px-7">
      <div className="max-w-[1060px] mx-auto">
        <div className="cc-label mb-4">WebUI Overview</div>
        <FadeIn>
          <div className="cc-card bg-cc-card rounded-[20px] overflow-hidden">
            <div className="flex items-center justify-between gap-4 px-4 sm:px-5 py-3 border-b border-cc-border bg-[#f3e6d1]">
              <div className="flex items-center gap-2">
                <div className="w-2.5 h-2.5 rounded-full bg-[#bc7f67]" />
                <div className="w-2.5 h-2.5 rounded-full bg-[#c09f59]" />
                <div className="w-2.5 h-2.5 rounded-full bg-[#5c8e83]" />
              </div>
              <span className="font-mono-code text-[11px] text-cc-muted tracking-wide">companion.session.dashboard</span>
            </div>
            <img
              src="/screenshot.png"
              alt="Companion WebUI with multi-session agent output, MCP controls, and integrated terminal"
              className="w-full block object-cover"
              loading="lazy"
            />
          </div>
        </FadeIn>
      </div>
    </section>
  );
}
