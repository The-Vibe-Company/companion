export function Footer() {
  return (
    <footer className="relative z-10 border-t border-cc-border py-10 px-5 sm:px-7 text-center text-sm text-cc-muted">
      <p className="font-mono-code tracking-wide">
        Built by{" "}
        <a href="https://thevibecompany.co" target="_blank" rel="noopener" className="hover:text-cc-fg transition-colors">
          The Vibe Company
        </a>
      </p>
      <div className="flex justify-center gap-6 mt-2">
        <a href="https://github.com/The-Vibe-Company/companion" target="_blank" rel="noopener" className="text-cc-muted hover:text-cc-fg transition-colors">
          GitHub
        </a>
        <a href="https://www.npmjs.com/package/the-companion" target="_blank" rel="noopener" className="text-cc-muted hover:text-cc-fg transition-colors">
          npm
        </a>
        <a href="https://github.com/The-Vibe-Company/companion/blob/main/LICENSE" target="_blank" rel="noopener" className="text-cc-muted hover:text-cc-fg transition-colors">
          MIT License
        </a>
      </div>
    </footer>
  );
}
