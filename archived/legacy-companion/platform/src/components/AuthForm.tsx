import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/utils";
import { Eye, EyeOff, Loader2 } from "lucide-react";

/**
 * Combined login/signup form with tab switching.
 * Uses Better Auth's signIn.email() and signUp.email() methods.
 */
export function AuthForm({
  onSuccess,
  defaultTab = "login",
}: {
  onSuccess?: () => void;
  defaultTab?: "login" | "signup";
}) {
  const [tab, setTab] = useState<"login" | "signup">(defaultTab);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      if (tab === "login") {
        const result = await authClient.signIn.email({ email, password });
        if (result.error) {
          setError(result.error.message || "Sign in failed");
          return;
        }
      } else {
        const result = await authClient.signUp.email({
          email,
          password,
          name: name || email.split("@")[0],
        });
        if (result.error) {
          setError(result.error.message || "Sign up failed");
          return;
        }
      }
      onSuccess?.();
    } catch (err: any) {
      setError(err?.message || "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="w-full max-w-sm mx-auto">
      {/* Tab bar */}
      <div className="flex mb-6 border-b border-cc-border">
        <button
          type="button"
          onClick={() => { setTab("login"); setError(null); }}
          className={cn(
            "flex-1 pb-3 text-sm font-medium transition-colors relative",
            tab === "login" ? "text-cc-fg" : "text-cc-muted hover:text-cc-fg",
          )}
        >
          Sign In
          {tab === "login" && (
            <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-cc-primary" />
          )}
        </button>
        <button
          type="button"
          onClick={() => { setTab("signup"); setError(null); }}
          className={cn(
            "flex-1 pb-3 text-sm font-medium transition-colors relative",
            tab === "signup" ? "text-cc-fg" : "text-cc-muted hover:text-cc-fg",
          )}
        >
          Create Account
          {tab === "signup" && (
            <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-cc-primary" />
          )}
        </button>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Name field (signup only) */}
        <div
          className={cn(
            "grid transition-all duration-200",
            tab === "signup" ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
          )}
        >
          <div className="overflow-hidden">
            <label className="block text-xs text-cc-muted mb-1.5">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
              tabIndex={tab === "signup" ? 0 : -1}
              className="w-full px-3 py-2.5 bg-cc-input-bg border border-cc-border rounded-lg text-sm text-cc-fg placeholder:text-cc-muted-fg focus:border-cc-primary focus:ring-1 focus:ring-cc-primary/20 outline-none transition-all"
            />
          </div>
        </div>

        {/* Email */}
        <div>
          <label className="block text-xs text-cc-muted mb-1.5">Email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            required
            className="w-full px-3 py-2.5 bg-cc-input-bg border border-cc-border rounded-lg text-sm text-cc-fg placeholder:text-cc-muted-fg focus:border-cc-primary focus:ring-1 focus:ring-cc-primary/20 outline-none transition-all font-[family-name:var(--font-display)] text-[13px]"
          />
        </div>

        {/* Password */}
        <div>
          <label className="block text-xs text-cc-muted mb-1.5">Password</label>
          <div className="relative">
            <input
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
              minLength={8}
              className="w-full px-3 py-2.5 pr-10 bg-cc-input-bg border border-cc-border rounded-lg text-sm text-cc-fg placeholder:text-cc-muted-fg focus:border-cc-primary focus:ring-1 focus:ring-cc-primary/20 outline-none transition-all"
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-cc-muted-fg hover:text-cc-muted transition-colors"
            >
              {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </div>

        {/* Error */}
        {error && (
          <p className="text-cc-error text-xs animate-fade-in">{error}</p>
        )}

        {/* Submit */}
        <button
          type="submit"
          disabled={loading}
          className={cn(
            "w-full py-2.5 rounded-lg font-medium text-sm transition-all",
            "bg-cc-primary text-white hover:bg-cc-primary-hover",
            "disabled:opacity-50 disabled:cursor-not-allowed",
            loading && "glow-primary",
          )}
        >
          {loading ? (
            <Loader2 size={16} className="animate-spin mx-auto" />
          ) : tab === "login" ? (
            "Sign In"
          ) : (
            "Create Account"
          )}
        </button>
      </form>
    </div>
  );
}
