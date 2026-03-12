import { useEffect, useRef } from "react";
import { useStore } from "../store.js";
import { parseHash } from "../utils/routing.js";

interface NavItem {
  id: string;
  label: string;
  hash: string;
  viewBox: string;
  iconPath: string;
  activePages?: string[];
  fillRule?: "evenodd";
  clipRule?: "evenodd";
}

interface ExternalLink {
  label: string;
  url: string;
  viewBox: string;
  iconPath: string;
}

export const NAV_ITEMS: NavItem[] = [
  {
    id: "prompts",
    label: "Prompts",
    hash: "#/prompts",
    viewBox: "0 0 16 16",
    iconPath: "M3 2.5A1.5 1.5 0 014.5 1h5.879c.398 0 .779.158 1.06.44l1.621 1.62c.281.282.44.663.44 1.061V13.5A1.5 1.5 0 0112 15H4.5A1.5 1.5 0 013 13.5v-11zM4.5 2a.5.5 0 00-.5.5v11a.5.5 0 00.5.5H12a.5.5 0 00.5-.5V4.121a.5.5 0 00-.146-.353l-1.621-1.621A.5.5 0 0010.379 2H4.5zm1.25 4.25a.75.75 0 01.75-.75h3a.75.75 0 010 1.5h-3a.75.75 0 01-.75-.75zm0 3a.75.75 0 01.75-.75h3.5a.75.75 0 010 1.5H6.5a.75.75 0 01-.75-.75z",
  },
  {
    id: "integrations",
    label: "Integrations",
    hash: "#/integrations",
    activePages: ["integrations", "integration-linear", "integration-tailscale"],
    viewBox: "0 0 16 16",
    iconPath: "M2.5 3A1.5 1.5 0 001 4.5v2A1.5 1.5 0 002.5 8h2A1.5 1.5 0 006 6.5v-2A1.5 1.5 0 004.5 3h-2zm0 1h2a.5.5 0 01.5.5v2a.5.5 0 01-.5.5h-2a.5.5 0 01-.5-.5v-2a.5.5 0 01.5-.5zm9 0A1.5 1.5 0 0010 5.5v2A1.5 1.5 0 0011.5 9h2A1.5 1.5 0 0015 7.5v-2A1.5 1.5 0 0013.5 4h-2zm0 1h2a.5.5 0 01.5.5v2a.5.5 0 01-.5.5h-2a.5.5 0 01-.5-.5v-2a.5.5 0 01.5-.5zM2.5 10A1.5 1.5 0 001 11.5v2A1.5 1.5 0 002.5 15h2A1.5 1.5 0 006 13.5v-2A1.5 1.5 0 004.5 10h-2zm0 1h2a.5.5 0 01.5.5v2a.5.5 0 01-.5.5h-2a.5.5 0 01-.5-.5v-2a.5.5 0 01.5-.5zM8.5 12a.5.5 0 100 1h5a.5.5 0 100-1h-5zm0-2a.5.5 0 100 1h2a.5.5 0 100-1h-2z",
  },
  {
    id: "terminal",
    label: "Terminal",
    hash: "#/terminal",
    viewBox: "0 0 16 16",
    iconPath: "M2 3a1 1 0 011-1h10a1 1 0 011 1v10a1 1 0 01-1 1H3a1 1 0 01-1-1V3zm2 1.5l3 2.5-3 2.5V4.5zM8.5 10h3v1h-3v-1z",
  },
  {
    id: "environments",
    label: "Environments",
    hash: "#/environments",
    viewBox: "0 0 16 16",
    iconPath: "M8 1a2 2 0 012 2v1h2a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6a2 2 0 012-2h2V3a2 2 0 012-2zm0 1.5a.5.5 0 00-.5.5v1h1V3a.5.5 0 00-.5-.5zM4 5.5a.5.5 0 00-.5.5v6a.5.5 0 00.5.5h8a.5.5 0 00.5-.5V6a.5.5 0 00-.5-.5H4z",
    activePages: ["environments", "docker-builder"],
  },
  {
    id: "agents",
    label: "Agents",
    hash: "#/agents",
    activePages: ["agents", "agent-detail"],
    viewBox: "0 0 16 16",
    iconPath: "M8 1.5a2.5 2.5 0 00-2.5 2.5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5S9.38 1.5 8 1.5zM4 8a4 4 0 00-4 4v1.5a.5.5 0 00.5.5h15a.5.5 0 00.5-.5V12a4 4 0 00-4-4H4z",
  },
  {
    id: "runs",
    label: "Runs",
    hash: "#/runs",
    viewBox: "0 0 16 16",
    iconPath: "M8 1a7 7 0 100 14A7 7 0 008 1zm-.75 3.5a.75.75 0 011.5 0v3.19l2.03 2.03a.75.75 0 01-1.06 1.06l-2.25-2.25A.75.75 0 017.25 8V4.5z",
  },
  {
    id: "settings",
    label: "Settings",
    hash: "#/settings",
    viewBox: "0 0 20 20",
    iconPath: "M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.53 1.53 0 01-2.29.95c-1.35-.8-2.92.77-2.12 2.12.54.9.07 2.04-.95 2.29-1.56.38-1.56 2.6 0 2.98 1.02.25 1.49 1.39.95 2.29-.8 1.35.77 2.92 2.12 2.12.9-.54 2.04-.07 2.29.95.38 1.56 2.6 1.56 2.98 0 .25-1.02 1.39-1.49 2.29-.95 1.35.8 2.92-.77 2.12-2.12-.54-.9-.07-2.04.95-2.29 1.56-.38 1.56-2.6 0-2.98-1.02-.25-1.49-1.39-.95-2.29.8-1.35-.77-2.92-2.12-2.12-.9.54-2.04.07-2.29-.95zM10 13a3 3 0 100-6 3 3 0 000 6z",
    fillRule: "evenodd",
    clipRule: "evenodd",
  },
];

export const EXTERNAL_LINKS: ExternalLink[] = [
  {
    label: "Documentation",
    url: "https://docs.thecompanion.sh",
    viewBox: "0 0 16 16",
    iconPath: "M1 2.828c.885-.37 2.154-.769 3.388-.893 1.33-.134 2.458.063 3.112.752v9.746c-.935-.53-2.12-.603-3.213-.493-1.18.12-2.37.461-3.287.811V2.828zm7.5-.141c.654-.689 1.782-.886 3.112-.752 1.234.124 2.503.523 3.388.893v9.923c-.918-.35-2.107-.692-3.287-.81-1.094-.111-2.278-.039-3.213.492V2.687zM8 1.783C7.015.936 5.587.81 4.287.94c-1.514.153-3.042.672-3.994 1.105A.5.5 0 000 2.5v11a.5.5 0 00.707.455c.882-.4 2.303-.881 3.68-1.02 1.409-.142 2.59.087 3.223.877a.5.5 0 00.78 0c.633-.79 1.814-1.019 3.222-.877 1.378.139 2.8.62 3.681 1.02A.5.5 0 0016 13.5v-11a.5.5 0 00-.293-.455c-.952-.433-2.48-.952-3.994-1.105C10.413.809 8.985.936 8 1.783z",
  },
  {
    label: "GitHub",
    url: "https://github.com/The-Vibe-Company/companion",
    viewBox: "0 0 16 16",
    iconPath: "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z",
  },
  {
    label: "Website",
    url: "https://thecompanion.sh",
    viewBox: "0 0 16 16",
    iconPath: "M0 8a8 8 0 1116 0A8 8 0 010 8zm7.5-6.923c-.67.204-1.335.82-1.887 1.855A7.97 7.97 0 005.145 4H7.5V1.077zM4.09 4a9.267 9.267 0 01.64-1.539 6.7 6.7 0 01.597-.933A7.025 7.025 0 002.255 4H4.09zm-.582 3.5c.03-.877.138-1.718.312-2.5H1.674a6.958 6.958 0 00-.656 2.5h2.49zM4.847 5a12.5 12.5 0 00-.338 2.5H7.5V5H4.847zM8.5 5v2.5h2.99a12.495 12.495 0 00-.337-2.5H8.5zM4.51 8.5a12.5 12.5 0 00.337 2.5H7.5V8.5H4.51zm3.99 0V11h2.653c.187-.765.306-1.608.338-2.5H8.5zM5.145 12c.138.386.295.744.468 1.068.552 1.035 1.218 1.65 1.887 1.855V12H5.145zm.182 2.472a6.696 6.696 0 01-.597-.933A9.268 9.268 0 014.09 12H2.255a7.024 7.024 0 003.072 2.472zM3.82 11a13.652 13.652 0 01-.312-2.5h-2.49c.062.89.291 1.733.656 2.5H3.82zm6.853 3.472A7.024 7.024 0 0013.745 12H11.91a9.27 9.27 0 01-.64 1.539 6.688 6.688 0 01-.597.933zM8.5 12v2.923c.67-.204 1.335-.82 1.887-1.855.173-.324.33-.682.468-1.068H8.5zm3.68-1h2.146c.365-.767.594-1.61.656-2.5h-2.49a13.65 13.65 0 01-.312 2.5zm2.802-3.5a6.959 6.959 0 00-.656-2.5H12.18c.174.782.282 1.623.312 2.5h2.49zM11.27 2.461c.247.464.462.98.64 1.539h1.835a7.024 7.024 0 00-3.072-2.472c.218.284.418.598.597.933zM10.855 4a7.966 7.966 0 00-.468-1.068C9.835 1.897 9.17 1.282 8.5 1.077V4h2.355z",
  },
];

interface SidebarMenuProps {
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLButtonElement | null>;
}

/**
 * Dropdown menu for sidebar navigation items and external links.
 * Anchored below the gear icon button in the sidebar header.
 */
export function SidebarMenu({ open, onClose, anchorRef }: SidebarMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const hash = typeof window !== "undefined" ? window.location.hash : "";
  const route = parseHash(hash);
  const sidebarGroupByProject = useStore((s) => s.sidebarGroupByProject);
  const setSidebarGroupByProject = useStore((s) => s.setSidebarGroupByProject);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (
        menuRef.current && !menuRef.current.contains(e.target as Node) &&
        anchorRef.current && !anchorRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open, onClose, anchorRef]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
        anchorRef.current?.focus();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose, anchorRef]);

  if (!open) return null;

  return (
    <div
      ref={menuRef}
      role="menu"
      className="absolute top-full right-0 mt-1 z-50 w-52 rounded-lg border border-cc-border bg-cc-card shadow-xl animate-[menu-appear_150ms_ease-out] py-1"
    >
      {/* Navigation items */}
      {NAV_ITEMS.map((item) => {
        const isActive = item.activePages
          ? item.activePages.some((p) => route.page === p)
          : route.page === item.id;
        return (
          <button
            key={item.id}
            role="menuitem"
            aria-current={isActive ? "page" : undefined}
            onClick={() => {
              if (item.id !== "terminal") {
                useStore.getState().closeTerminal();
              }
              window.location.hash = item.hash;
              if (window.innerWidth < 768) {
                useStore.getState().setSidebarOpen(false);
              }
              onClose();
            }}
            className={`w-full flex items-center gap-2.5 px-3 py-2 text-left text-[12px] transition-colors cursor-pointer ${
              isActive
                ? "text-cc-fg bg-cc-active"
                : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
            }`}
          >
            <svg viewBox={item.viewBox} fill="currentColor" className="w-3.5 h-3.5 shrink-0">
              <path d={item.iconPath} fillRule={item.fillRule} clipRule={item.clipRule} />
            </svg>
            <span className="font-medium">{item.label}</span>
          </button>
        );
      })}

      {/* Divider */}
      <div className="my-1 border-t border-cc-border/50" />

      {/* Group by project toggle */}
      <button
        role="menuitem"
        onClick={() => {
          setSidebarGroupByProject(!sidebarGroupByProject);
        }}
        className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-[12px] text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
      >
        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 shrink-0">
          <path d="M1 2.5A1.5 1.5 0 012.5 1h3A1.5 1.5 0 017 2.5v3A1.5 1.5 0 015.5 7h-3A1.5 1.5 0 011 5.5v-3zm8 0A1.5 1.5 0 0110.5 1h3A1.5 1.5 0 0115 2.5v3A1.5 1.5 0 0113.5 7h-3A1.5 1.5 0 019 5.5v-3zm-8 8A1.5 1.5 0 012.5 9h3A1.5 1.5 0 017 10.5v3A1.5 1.5 0 015.5 15h-3A1.5 1.5 0 011 13.5v-3zm8 0A1.5 1.5 0 0110.5 9h3a1.5 1.5 0 011.5 1.5v3a1.5 1.5 0 01-1.5 1.5h-3A1.5 1.5 0 019 13.5v-3z" />
        </svg>
        <span className="font-medium">Group by project</span>
        {sidebarGroupByProject && (
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 ml-auto text-cc-primary">
            <path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" />
          </svg>
        )}
      </button>

      {/* Divider */}
      <div className="my-1 border-t border-cc-border/50" />

      {/* External links */}
      {EXTERNAL_LINKS.map((link) => (
        <a
          key={link.label}
          role="menuitem"
          href={link.url}
          target="_blank"
          rel="noopener noreferrer"
          className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-[12px] text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors"
        >
          <svg viewBox={link.viewBox} fill="currentColor" className="w-3.5 h-3.5 shrink-0">
            <path d={link.iconPath} />
          </svg>
          <span className="font-medium">{link.label}</span>
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 ml-auto opacity-40">
            <path d="M8.636 3.5a.5.5 0 00-.5-.5H1.5A1.5 1.5 0 000 4.5v10A1.5 1.5 0 001.5 16h10a1.5 1.5 0 001.5-1.5V7.864a.5.5 0 00-1 0V14.5a.5.5 0 01-.5.5h-10a.5.5 0 01-.5-.5v-10a.5.5 0 01.5-.5h6.636a.5.5 0 00.5-.5z" />
            <path d="M16 .5a.5.5 0 00-.5-.5h-5a.5.5 0 000 1h3.793L6.146 9.146a.5.5 0 10.708.708L15 1.707V5.5a.5.5 0 001 0v-5z" />
          </svg>
        </a>
      ))}
    </div>
  );
}
