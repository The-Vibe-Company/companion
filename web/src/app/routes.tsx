/**
 * Route table for the console.
 *
 * A single root layout (AppLayout) wraps all pages and renders the matched page
 * through its <Outlet/>. App Core wires the 5 routes to stub page components;
 * the Feature Pages step fleshes the pages out without changing this table.
 *
 *   "/"            → AgentsPage
 *   "/agents/new"  → CreateAgentPage
 *   "/agents/:id"  → AgentDetailPage
 *   "/plan"        → PlanApplyPage
 *   "/settings"    → SettingsPage
 */

import { createBrowserRouter } from "react-router-dom";
import { AppLayout } from "./components";
import AgentsPage from "./pages/AgentsPage";
import CreateAgentPage from "./pages/CreateAgentPage";
import AgentDetailPage from "./pages/AgentDetailPage";
import PlanApplyPage from "./pages/PlanApplyPage";
import SettingsPage from "./pages/SettingsPage";
import { NotFoundPage } from "./pages/NotFoundPage";

export const router = createBrowserRouter([
  {
    path: "/",
    element: <AppLayout />,
    children: [
      { index: true, element: <AgentsPage /> },
      { path: "agents/new", element: <CreateAgentPage /> },
      { path: "agents/:id", element: <AgentDetailPage /> },
      { path: "plan", element: <PlanApplyPage /> },
      { path: "settings", element: <SettingsPage /> },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
]);
