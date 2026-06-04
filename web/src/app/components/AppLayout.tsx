/**
 * AppLayout — the console application shell: a fixed sidebar with primary
 * navigation and a scrolling content region that renders the matched route via
 * <Outlet/>.
 *
 * Navigation is a real <nav> with NavLinks so active state, keyboard focus, and
 * the current-page indication (aria-current) are correct. The brand mark + the
 * "local admin" affordance reinforce that this is a single-operator tool.
 */

import { NavLink, Outlet } from "react-router-dom";
import type { ReactNode } from "react";

interface NavItem {
  to: string;
  label: string;
  /** Exact match (used for "/" so it isn't active on every route). */
  end?: boolean;
  icon: ReactNode;
}

const NAV: NavItem[] = [
  { to: "/", label: "Agents", end: true, icon: <AgentsIcon /> },
  { to: "/agents/new", label: "Create", icon: <PlusIcon /> },
  { to: "/plan", label: "Plan & Apply", icon: <PlanIcon /> },
  { to: "/settings", label: "Settings", icon: <GearIcon /> },
];

export interface AppLayoutProps {
  /** Optional override of the workspace label shown in the sidebar header. */
  workspaceName?: string;
}

export function AppLayout({ workspaceName }: AppLayoutProps) {
  return (
    <div className="flex min-h-full bg-canvas text-fg">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-accent focus:px-3 focus:py-1.5 focus:text-sm focus:text-accent-fg"
      >
        Skip to content
      </a>

      <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-surface">
        <div className="flex h-14 items-center gap-2.5 border-b border-line px-4">
          <span
            aria-hidden="true"
            className="grid size-7 place-items-center rounded-md bg-accent text-sm font-semibold text-accent-fg"
          >
            C
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold tracking-tight">
              Companion
            </p>
            {workspaceName && (
              <p className="truncate text-[11px] text-faint">{workspaceName}</p>
            )}
          </div>
        </div>

        <nav aria-label="Primary" className="flex-1 space-y-0.5 p-2">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors " +
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent " +
                (isActive
                  ? "bg-surface-raised font-medium text-fg"
                  : "text-muted hover:bg-surface-raised hover:text-fg")
              }
            >
              <span aria-hidden="true" className="text-faint">
                {item.icon}
              </span>
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-line px-4 py-3">
          <span className="text-[11px] text-faint">local admin</span>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <main
          id="main"
          className="mx-auto w-full max-w-5xl flex-1 px-6 py-8"
        >
          <Outlet />
        </main>
      </div>
    </div>
  );
}

/* --- inline icons (decorative; aria-hidden via parent) -------------------- */

function iconProps() {
  return {
    width: 16,
    height: 16,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
}

function AgentsIcon() {
  return (
    <svg {...iconProps()}>
      <rect x="3" y="4" width="18" height="6" rx="1.5" />
      <rect x="3" y="14" width="18" height="6" rx="1.5" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg {...iconProps()}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function PlanIcon() {
  return (
    <svg {...iconProps()}>
      <path d="M4 6h16M4 12h10M4 18h7" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg {...iconProps()}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-2.82 1.17V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 8 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 3.6 14H3.5a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 8a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 3.6h.09A1.65 1.65 0 0 0 10 2v0a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 20.4 9v.09A1.65 1.65 0 0 0 22 10a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </svg>
  );
}
