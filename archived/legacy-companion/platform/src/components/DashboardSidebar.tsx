import { LayoutGrid, Settings, Users, LogOut } from "lucide-react";
import { cn } from "@/lib/utils";
import { authClient } from "@/lib/auth-client";

export type DashboardPage = "instances" | "settings" | "team";

const NAV_ITEMS = [
  { id: "instances" as const, label: "Instances", icon: LayoutGrid },
  { id: "settings" as const, label: "Settings", icon: Settings },
  { id: "team" as const, label: "Team", icon: Users },
];

interface DashboardSidebarProps {
  page: DashboardPage;
  onNavigate: (page: DashboardPage) => void;
  open: boolean;
  onClose: () => void;
}

export function DashboardSidebar({ page, onNavigate, open, onClose }: DashboardSidebarProps) {
  const session = authClient.useSession();

  return (
    <aside
      className={cn(
        "fixed lg:static inset-y-0 left-0 z-50 w-64 bg-cc-sidebar border-r border-cc-separator flex flex-col",
        "transition-transform duration-200 lg:translate-x-0",
        open ? "translate-x-0" : "-translate-x-full",
      )}
    >
      {/* Logo */}
      <div className="h-14 flex items-center px-5 border-b border-cc-separator">
        <span className="font-[family-name:var(--font-display)] font-bold text-sm tracking-tight">
          companion<span className="text-cc-primary">.</span>cloud
        </span>
      </div>

      {/* Nav */}
      <nav className="flex-1 p-3 space-y-1">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            onClick={() => { onNavigate(item.id); onClose(); }}
            className={cn(
              "w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors",
              page === item.id
                ? "bg-cc-primary/10 text-cc-primary"
                : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover",
            )}
          >
            <item.icon size={18} />
            {item.label}
          </button>
        ))}
      </nav>

      {/* User section */}
      <div className="p-3 border-t border-cc-separator">
        <div className="flex items-center gap-3 px-3 py-2">
          <div className="w-8 h-8 rounded-full bg-cc-primary/20 text-cc-primary flex items-center justify-center text-xs font-bold">
            {session.data?.user?.name?.[0]?.toUpperCase() || "?"}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">
              {session.data?.user?.name || "User"}
            </p>
            <p className="text-xs text-cc-muted-fg truncate">
              {session.data?.user?.email}
            </p>
          </div>
          <button
            onClick={() => authClient.signOut()}
            className="text-cc-muted-fg hover:text-cc-error transition-colors"
            title="Sign out"
          >
            <LogOut size={16} />
          </button>
        </div>
      </div>
    </aside>
  );
}
