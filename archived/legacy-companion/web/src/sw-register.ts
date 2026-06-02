/**
 * Service Worker registration for production builds.
 *
 * Uses vite-plugin-pwa's autoUpdate mode: when a new SW is detected,
 * it downloads, installs, and activates immediately (skipWaiting + clientsClaim).
 *
 * In dev mode the virtual:pwa-register module is a no-op, so importing
 * this file has no effect during development.
 *
 * Edge cases:
 * - Multiple tabs: skipWaiting activates the new SW across all tabs immediately.
 *   WebSocket connections are unaffected (SW never intercepts /ws/* routes).
 * - First-time visitors: app loads from network; SW installs in background.
 * - SW update during active session: only static assets are cached. API calls
 *   and WebSocket connections go directly to network.
 */
import { registerSW } from "virtual:pwa-register";

registerSW({
  onRegisteredSW(_swUrl: string, registration: ServiceWorkerRegistration | undefined) {
    if (registration) {
      // Check for SW updates every 60 minutes while the app is open.
      // Catches deployments that happen while a user has the app open.
      setInterval(() => {
        registration.update();
      }, 60 * 60 * 1000);
    }
  },
  onOfflineReady() {
    console.log("[SW] Offline-ready: all assets precached");
  },
});
