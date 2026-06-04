/**
 * Companion Console root.
 *
 * Mounts the router (which renders the AppLayout shell + the matched page). The
 * design tokens and global styles live in index.css; the API client and hooks
 * provide the data layer the pages consume.
 */

import { RouterProvider } from "react-router-dom";
import { router } from "./app/routes";

export default function App() {
  return <RouterProvider router={router} />;
}
