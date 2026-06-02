// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { PublicUrlBanner } from "./PublicUrlBanner.js";

const DISMISS_KEY = "companion_public_url_dismissed";

describe("PublicUrlBanner", () => {
  // Clean up localStorage before each test so dismiss state doesn't leak
  // between tests and each test starts with a fresh slate.
  beforeEach(() => {
    localStorage.removeItem(DISMISS_KEY);
  });

  // Verifies the banner renders its warning text when no publicUrl is provided,
  // which is the primary use case — alerting the user that webhooks may not work.
  it("renders warning banner when publicUrl is empty", () => {
    render(<PublicUrlBanner publicUrl="" />);
    expect(screen.getByText(/No public URL configured/)).toBeInTheDocument();
    expect(
      screen.getByText(/Webhook URLs currently use your browser address/)
    ).toBeInTheDocument();
  });

  // When publicUrl is set, there is nothing to warn about — the banner should
  // not appear at all.
  it("does NOT render when publicUrl is set", () => {
    const { container } = render(
      <PublicUrlBanner publicUrl="https://example.com" />
    );
    expect(container.innerHTML).toBe("");
  });

  // If the user previously dismissed the banner, localStorage retains that
  // preference. The banner should stay hidden on subsequent renders.
  it("does NOT render when previously dismissed via localStorage", () => {
    localStorage.setItem(DISMISS_KEY, "1");
    const { container } = render(<PublicUrlBanner publicUrl="" />);
    expect(container.innerHTML).toBe("");
  });

  // Clicking the dismiss button should immediately hide the banner and persist
  // the dismissal to localStorage so it stays hidden across page reloads.
  it("clicking dismiss hides the banner and writes to localStorage", () => {
    render(<PublicUrlBanner publicUrl="" />);

    // Banner should be visible before dismissal
    expect(screen.getByRole("alert")).toBeInTheDocument();

    // Click the dismiss button
    const dismissBtn = screen.getByLabelText("Dismiss public URL banner");
    fireEvent.click(dismissBtn);

    // Banner should disappear from the DOM
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    // localStorage should record the dismissal
    expect(localStorage.getItem(DISMISS_KEY)).toBe("1");
  });

  // The banner should contain a link to the settings page so the user can
  // easily navigate to configure their public URL.
  it("contains a link to #/settings", () => {
    render(<PublicUrlBanner publicUrl="" />);
    const link = screen.getByRole("link", {
      name: /Set your public URL in Settings/,
    });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute("href", "#/settings");
  });

  // The banner uses role="alert" so screen readers announce it immediately
  // when it appears, ensuring accessibility for users relying on assistive tech.
  it("has role='alert' for screen readers", () => {
    render(<PublicUrlBanner publicUrl="" />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  // axe accessibility scan — ensures the rendered banner has no detectable
  // WCAG violations (color contrast, ARIA attributes, semantic structure, etc.).
  it("passes axe accessibility scan", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<PublicUrlBanner publicUrl="" />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
