/**
 * Stub for the virtual:pwa-register module provided by vite-plugin-pwa.
 * Used only during vitest runs so Vite's import analysis can resolve the module.
 * Tests override this with vi.mock("virtual:pwa-register", ...).
 */
export function registerSW(_options?: Record<string, unknown>) {
  return () => {};
}
