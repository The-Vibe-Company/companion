import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";

// Apply dark mode based on system preference
if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
  document.documentElement.classList.add("dark");
}
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
  document.documentElement.classList.toggle("dark", e.matches);
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
