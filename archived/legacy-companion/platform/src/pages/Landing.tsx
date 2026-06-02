import { AuthForm } from "@/components/AuthForm";
import { Terminal } from "lucide-react";

/**
 * Landing page for cloud.thecompanion.sh
 *
 * Simple auth-only page — hero/features/pricing live on the parent site
 * (thecompanion.sh). This just shows a centered sign-in / sign-up card.
 */
export function Landing() {
  return (
    <div className="min-h-screen bg-cc-bg text-cc-fg grain flex flex-col">
      {/* ── Nav ──────────────────────────────────────────────────────────── */}
      <nav className="bg-cc-bg/80 backdrop-blur-xl border-b border-cc-separator">
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
          <a href="https://thecompanion.sh" className="flex items-center gap-2">
            <span className="font-[family-name:var(--font-display)] font-bold text-sm tracking-tight">
              companion
              <span className="text-cc-primary">.</span>
              cloud
            </span>
          </a>
          <a
            href="https://thecompanion.sh"
            className="text-sm text-cc-muted hover:text-cc-fg transition-colors"
          >
            Back to thecompanion.sh
          </a>
        </div>
      </nav>

      {/* ── Auth Card (centered) ──────────────────────────────────────── */}
      <main className="flex-1 flex items-center justify-center px-6 py-16">
        <div className="w-full max-w-md">
          {/* Header */}
          <div className="text-center mb-8">
            <div className="inline-flex items-center gap-2 px-3 py-1.5 mb-6 rounded-full border border-cc-border bg-cc-card/50">
              <Terminal size={14} className="text-cc-primary" />
              <span className="font-[family-name:var(--font-display)] text-xs text-cc-muted">
                companion cloud
                <span className="animate-blink text-cc-primary">_</span>
              </span>
            </div>
            <h1 className="font-[family-name:var(--font-display)] text-2xl font-bold tracking-tight mb-2">
              Welcome to Companion Cloud
            </h1>
            <p className="text-cc-muted text-sm">
              Sign in to manage your Claude Code instances.
            </p>
          </div>

          {/* Auth Form Card */}
          <div className="rounded-2xl border border-cc-border bg-cc-card p-8">
            <AuthForm />
          </div>

          {/* Footer link */}
          <p className="text-center text-xs text-cc-muted-fg mt-6">
            Don&apos;t have an account?{" "}
            <a
              href="https://thecompanion.sh"
              className="text-cc-primary hover:text-cc-primary-hover transition-colors"
            >
              Learn more about Companion
            </a>
          </p>
        </div>
      </main>
    </div>
  );
}
