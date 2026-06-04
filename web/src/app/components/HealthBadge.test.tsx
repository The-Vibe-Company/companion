/**
 * HealthBadge tests: each known health string maps to its human label and tone,
 * and unknown/empty values degrade to a neutral "Unknown" pill so a row without
 * snapshot enrichment still reads cleanly.
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { HealthBadge } from "./HealthBadge";

describe("HealthBadge", () => {
  it("renders 'Healthy' for ok", () => {
    render(<HealthBadge health="ok" />);
    const badge = screen.getByText("Healthy");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveClass("text-ok");
  });

  it("renders 'Degraded' for degraded", () => {
    render(<HealthBadge health="degraded" />);
    expect(screen.getByText("Degraded")).toHaveClass("text-warn");
  });

  it("renders 'Down' for down", () => {
    render(<HealthBadge health="down" />);
    expect(screen.getByText("Down")).toHaveClass("text-danger");
  });

  it("falls back to 'Unknown' for an unrecognized value", () => {
    render(<HealthBadge health="weird" />);
    expect(screen.getByText("Unknown")).toBeInTheDocument();
  });

  it("falls back to 'Unknown' when health is missing", () => {
    render(<HealthBadge />);
    expect(screen.getByText("Unknown")).toBeInTheDocument();
  });

  it("is case-insensitive", () => {
    render(<HealthBadge health="OK" />);
    expect(screen.getByText("Healthy")).toBeInTheDocument();
  });
});
