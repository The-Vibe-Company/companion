// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import "vitest-axe/extend-expect";
import { describe, expect, it } from "vitest";
import { IntegrationBreadcrumb } from "./IntegrationBreadcrumb.js";

describe("IntegrationBreadcrumb", () => {
  it("renders the integrations hierarchy and current page", () => {
    render(<IntegrationBreadcrumb current="Linear Settings" />);

    const breadcrumb = screen.getByLabelText("Breadcrumb");
    expect(breadcrumb).toHaveTextContent("Integrations>Linear Settings");
    expect(screen.getByRole("link", { name: "Integrations" })).toHaveAttribute("href", "#/integrations");
  });

  it("keeps the current page as plain text instead of a second link", () => {
    render(<IntegrationBreadcrumb current="Tailscale Settings" />);

    expect(screen.getByText("Tailscale Settings")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Tailscale Settings" })).not.toBeInTheDocument();
  });

  it("has no accessibility violations", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<IntegrationBreadcrumb current="Linear OAuth Apps" />);

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
