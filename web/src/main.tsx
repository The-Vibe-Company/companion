import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error('Companion Console: #root element not found in document');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
