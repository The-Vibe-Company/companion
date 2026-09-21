import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";

export type RowMenuItem = { label: string; onSelect: () => void; accessibleName?: string; danger?: boolean };
export type RowMenuRequest = { id: string; label: string; items: RowMenuItem[]; anchor: HTMLElement };

/**
 * One accessible menu per rail, opened by a row's trigger or by a right click.
 * It is not a modal: focus moves into the menu, Escape gives it back to the trigger.
 */
export function RowMenu({ request, onClose }: { request: RowMenuRequest; onClose: () => void }) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<{ top: number; left: number; origin: string } | null>(null);
  const { anchor, items, label } = request;

  // The placement reads viewport pixels, so it is recomputed on resize as well as on open.
  const place = useCallback(() => {
    const menu = menuRef.current;
    const host = menu?.offsetParent as HTMLElement | null;
    if (!menu || !host) return;
    const trigger = anchor.getBoundingClientRect();
    const frame = host.getBoundingClientRect();
    const below = trigger.bottom + menu.offsetHeight + 8 <= window.innerHeight;
    // Align the right edge with the trigger, as rows expect, but keep the whole
    // menu on screen: near the rail's header a wide menu would slide off the left.
    const margin = 8;
    const width = menu.offsetWidth;
    const preferred = trigger.right - width;
    const left = Math.max(margin, Math.min(preferred, window.innerWidth - width - margin));
    const centre = trigger.left + trigger.width / 2;
    const originX = centre - left <= left + width - centre ? "left" : "right";
    setPlacement({
      top: (below ? trigger.bottom + 4 : trigger.top - menu.offsetHeight - 4) - frame.top,
      left: left - frame.left,
      origin: `${below ? "top" : "bottom"} ${originX}`,
    });
  }, [anchor]);

  useLayoutEffect(place, [place]);

  useEffect(() => {
    const entries = () => [...(menuRef.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
    entries()[0]?.focus();
    function dismiss(returnFocus: boolean) {
      if (returnFocus && anchor.isConnected) anchor.focus();
      onClose();
    }
    // Capture, so Escape closes this menu without also closing the drawer behind it.
    const keydown = (event: KeyboardEvent) => {
      const nodes = entries();
      if (!nodes.length) return;
      const index = nodes.indexOf(document.activeElement as HTMLElement);
      const handled = ["Escape", "ArrowDown", "ArrowUp", "Home", "End", "Tab"].includes(event.key);
      if (!handled) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape" || event.key === "Tab") dismiss(true);
      else if (event.key === "ArrowDown") nodes[(index + 1) % nodes.length].focus();
      else if (event.key === "ArrowUp") nodes[(index - 1 + nodes.length) % nodes.length].focus();
      else if (event.key === "Home") nodes[0].focus();
      else nodes[nodes.length - 1].focus();
    };
    const pointerdown = (event: Event) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !anchor.contains(target)) dismiss(false);
    };
    document.addEventListener("keydown", keydown, true);
    document.addEventListener("pointerdown", pointerdown);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("keydown", keydown, true);
      document.removeEventListener("pointerdown", pointerdown);
      window.removeEventListener("resize", place);
    };
  }, [anchor, onClose, place]);

  return <div
    ref={menuRef}
    className="row-menu"
    role="menu"
    aria-label={label}
    style={placement ? { top: placement.top, left: placement.left, transformOrigin: placement.origin } : { opacity: 0 }}
  >
    {items.map(item => <button
      key={item.label}
      type="button"
      role="menuitem"
      className={cn("row-menu-item", item.danger && "row-menu-item--danger")}
      aria-label={item.accessibleName}
      onClick={() => { if (anchor.isConnected) anchor.focus(); onClose(); item.onSelect(); }}
    >{item.label}</button>)}
  </div>;
}

/** The trigger a row shows for its menu; right clicking the row opens the same menu. */
export function RowMenuTrigger({ label, expanded, onOpen, className }: {
  label: string; expanded: boolean; onOpen: (anchor: HTMLElement) => void; className?: string;
}) {
  return <button
    type="button"
    className={cn("row-menu-trigger", className)}
    aria-label={label}
    aria-haspopup="menu"
    aria-expanded={expanded}
    onPointerDown={event => event.stopPropagation()}
    onClick={event => { event.preventDefault(); event.stopPropagation(); onOpen(event.currentTarget); }}
  ><MoreHorizontal /></button>;
}
