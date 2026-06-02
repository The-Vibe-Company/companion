import { ClawdLogo } from "./ClawdLogo";

export function Nav() {
  return (
    <nav className="sticky top-0 z-50 h-16 flex items-center px-5 sm:px-7 bg-cc-bg/75 backdrop-blur-xl border-b border-cc-border">
      <div className="max-w-[1060px] mx-auto w-full flex items-center justify-between">
        <a href="/" className="flex items-center gap-2.5 font-semibold text-[15px] text-cc-fg no-underline">
          <ClawdLogo size={28} />
          <span className="font-condensed text-xl tracking-wide">The Companion</span>
        </a>
        <div className="flex items-center gap-5 sm:gap-6">
          <a
            href="https://github.com/The-Vibe-Company/companion"
            target="_blank"
            rel="noopener"
            className="text-sm text-cc-muted hover:text-cc-fg transition-colors hidden sm:block font-mono-code"
          >
            GitHub
          </a>
          <a
            href="https://www.npmjs.com/package/the-companion"
            target="_blank"
            rel="noopener"
            className="text-sm text-cc-muted hover:text-cc-fg transition-colors hidden sm:block font-mono-code"
          >
            npm
          </a>
          <a
            href="https://github.com/The-Vibe-Company/companion"
            target="_blank"
            rel="noopener"
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-cc-primary text-[#fff4eb] rounded-lg text-[13px] font-medium font-mono-code hover:bg-cc-primary-hover transition-all hover:-translate-y-px border border-[#8e3518] shadow-[0_3px_0_0_#8e3518]"
          >
            Open Repo
          </a>
        </div>
      </div>
    </nav>
  );
}
