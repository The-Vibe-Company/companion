// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "vitest-axe/extend-expect";
import { axe } from "vitest-axe";

import {
  IdeDisconnectBanner,
  IDE_DISCONNECT_BANNER_TEXT,
} from "./IdeDisconnectBanner.js";

describe("IdeDisconnectBanner (BIND-05)", () => {
  // Validates the banner renders the EXACT spec copy (em-dash preserved).
  it("renders the exact spec copy including em-dash", () => {
    render(<IdeDisconnectBanner onDismiss={() => {}} />);
    // Literal check to catch any future copy drift.
    expect(screen.getByText("IDE disconnected \u2014 rebind via /ide")).toBeTruthy();
    // Belt-and-suspenders: ensure the exported constant matches the literal.
    expect(IDE_DISCONNECT_BANNER_TEXT).toBe(
      "IDE disconnected \u2014 rebind via /ide"
    );
  });

  // Verifies dismiss callback fires on click.
  it("calls onDismiss when the Dismiss button is clicked", () => {
    const onDismiss = vi.fn();
    render(<IdeDisconnectBanner onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  // a11y scan — the banner is in-chat (not a dialog) so it must use role=status.
  it("has no axe violations and exposes role=status", async () => {
    const { container } = render(<IdeDisconnectBanner onDismiss={() => {}} />);
    expect(screen.getByRole("status")).toBeTruthy();
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
