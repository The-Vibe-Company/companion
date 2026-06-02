import { useEffect, type RefObject } from "react";

/**
 * Calls `onClickOutside` when a pointer event occurs outside all provided refs.
 * Each ref in the array is checked — if the click target is inside any of them,
 * the callback is not fired.
 *
 * @param refs - Array of refs whose elements are considered "inside"
 * @param onClickOutside - Callback fired when click is outside all refs
 * @param enabled - Optional flag to conditionally enable/disable the listener (default: true)
 */
export function useClickOutside(
  refs: RefObject<HTMLElement | null>[],
  onClickOutside: () => void,
  enabled = true,
): void {
  useEffect(() => {
    if (!enabled) return;
    function handlePointerDown(e: PointerEvent) {
      const isInside = refs.some(
        (ref) => ref.current && ref.current.contains(e.target as Node),
      );
      if (!isInside) {
        onClickOutside();
      }
    }
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [refs, onClickOutside, enabled]);
}
