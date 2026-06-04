import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import App from "./App.tsx";

/**
 * App smoke test: mounting the root renders the layout shell and the index
 * (Agents) page. We assert on accessible landmarks/roles rather than markup so
 * the test reflects what a screen-reader user perceives.
 */
describe("App", () => {
  it("renders the primary navigation with the four console destinations", () => {
    render(<App />);
    const nav = screen.getByRole("navigation", { name: /primary/i });
    // All four sidebar links are present and reachable.
    expect(within(nav).getByRole("link", { name: "Agents" })).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: "Create" })).toBeInTheDocument();
    expect(
      within(nav).getByRole("link", { name: "Plan & Apply" }),
    ).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: "Settings" })).toBeInTheDocument();
  });

  it("renders the Agents page heading at the index route", () => {
    render(<App />);
    expect(
      screen.getByRole("heading", { level: 1, name: /agents/i }),
    ).toBeInTheDocument();
    // The content landmark exists for skip-link / SR navigation.
    expect(screen.getByRole("main")).toBeInTheDocument();
  });
});
