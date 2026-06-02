import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.js";
import { initAnalytics } from "./analytics.js";
import { AppErrorBoundary } from "./components/AppErrorBoundary.js";
import "./index.css";

initAnalytics();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>
);

// Register Service Worker in production (no-op in dev).
// Dynamic import ensures SW registration never blocks initial render.
import("./sw-register.js").catch(() => {});
