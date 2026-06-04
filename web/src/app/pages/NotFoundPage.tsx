/**
 * NotFoundPage — fallback for unmatched routes, rendered inside the layout so
 * navigation stays available. Named export (it is not one of the five primary
 * page stubs the Feature Pages step owns).
 */

import { Link } from "react-router-dom";
import { EmptyState, PageHeader } from "../components";

export function NotFoundPage() {
  return (
    <>
      <PageHeader title="Not found" />
      <EmptyState
        title="This page does not exist"
        description="The route you followed has no matching view."
        action={
          <Link
            to="/"
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            Back to agents
          </Link>
        }
      />
    </>
  );
}
