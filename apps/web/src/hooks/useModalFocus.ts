import { useEffect, useRef } from "react";

const openModals: Array<{ token: symbol; order: number; panel: HTMLElement }> = [];
const isolated = new Map<HTMLElement, boolean>();
let nextOrder = 0;

// Only the top modal owns background isolation. Recompute it when a responsive
// drawer or nested sheet leaves the stack, even when they close out of order.
function updateIsolation() {
  const desired = new Set<HTMLElement>();
  let branch = openModals.at(-1)?.panel;
  while (branch?.parentElement && branch !== document.body) {
    for (const sibling of branch.parentElement.children) {
      if (sibling === branch || !(sibling instanceof HTMLElement) || sibling.matches('[class*="scrim"]')) continue;
      desired.add(sibling);
    }
    branch = branch.parentElement;
  }
  for (const [node, previous] of isolated) {
    if (!desired.has(node)) { node.inert = previous; isolated.delete(node); }
  }
  for (const node of desired) {
    if (!isolated.has(node)) isolated.set(node, node.inert);
    node.inert = true;
  }
}
const focusable = 'a[href],button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary,[tabindex]:not([tabindex="-1"])';

/** Modal focus and background isolation, including nested sheets. */
export function useModalFocus(active: boolean, onClose: () => void, media?: string) {
  const ref = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!active) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const token = Symbol();
    const order = ++nextOrder;
    const query = media ? window.matchMedia(media) : null;
    let release = () => {};
    const sync = () => {
      release();
      release = () => {};
      if (query && !query.matches) return;
      const panel = ref.current;
      if (!panel) return;
      const previousRole = panel.getAttribute('role');
      const previousModal = panel.getAttribute('aria-modal');
      panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true');
      openModals.push({ token, order, panel });
      openModals.sort((left, right) => left.order - right.order);
      updateIsolation();
      const targets = () => [...panel.querySelectorAll<HTMLElement>(focusable)].filter(node => !node.closest('[inert]') && !node.hidden && getComputedStyle(node).visibility !== 'hidden' && node.getClientRects().length > 0);
      const first = () => (targets()[0] ?? panel).focus();
      if (openModals.at(-1)?.token === token) first();
      const keydown = (event: KeyboardEvent) => {
        if (openModals.at(-1)?.token !== token) return;
        if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); close.current(); }
        if (event.key === 'Tab') {
          const items = targets(); const index = items.indexOf(document.activeElement as HTMLElement);
          if (!items.length) { event.preventDefault(); panel.focus(); }
          else if (event.shiftKey && index <= 0) { event.preventDefault(); items.at(-1)!.focus(); }
          else if (!event.shiftKey && (index === items.length - 1 || index === -1)) { event.preventDefault(); items[0].focus(); }
        }
      };
      const focusin = (event: FocusEvent) => { if (openModals.at(-1)?.token === token && !panel.contains(event.target as Node)) first(); };
      document.addEventListener('keydown', keydown);
      document.addEventListener('focusin', focusin);
      release = () => {
        document.removeEventListener('keydown', keydown); document.removeEventListener('focusin', focusin);
        const wasTop = openModals.at(-1)?.token === token;
        openModals.splice(openModals.findIndex(modal => modal.token === token), 1);
        updateIsolation();
        if (previousRole === null) panel.removeAttribute('role'); else panel.setAttribute('role', previousRole);
        if (previousModal === null) panel.removeAttribute('aria-modal'); else panel.setAttribute('aria-modal', previousModal);
        if (wasTop && previous?.isConnected && !previous.closest('[inert]')) previous.focus();
      };
    };
    sync(); query?.addEventListener('change', sync);
    return () => { query?.removeEventListener('change', sync); release(); };
  }, [active, media]);
  return ref;
}
