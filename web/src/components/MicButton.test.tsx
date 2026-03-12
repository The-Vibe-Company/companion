// @vitest-environment jsdom
/**
 * Tests for the MicButton component.
 * Validates rendering states (idle, listening, unsupported, disabled),
 * click handling, and accessibility attributes.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MicButton } from "./MicButton.js";

describe("MicButton", () => {
  // -- Render tests --

  it("renders a button when isSupported is true", () => {
    render(<MicButton isListening={false} isSupported={true} onClick={vi.fn()} />);
    expect(screen.getByRole("button", { name: /toggle voice input/i })).toBeInTheDocument();
  });

  it("renders nothing when isSupported is false", () => {
    const { container } = render(
      <MicButton isListening={false} isSupported={false} onClick={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  // -- Click handling --

  it("calls onClick when clicked", () => {
    const onClick = vi.fn();
    render(<MicButton isListening={false} isSupported={true} onClick={onClick} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("does not fire onClick when disabled", () => {
    const onClick = vi.fn();
    render(<MicButton isListening={false} isSupported={true} onClick={onClick} disabled />);
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).not.toHaveBeenCalled();
  });

  // -- Accessibility --

  it("has aria-pressed=false when not listening", () => {
    render(<MicButton isListening={false} isSupported={true} onClick={vi.fn()} />);
    expect(screen.getByRole("button")).toHaveAttribute("aria-pressed", "false");
  });

  it("has aria-pressed=true when listening", () => {
    render(<MicButton isListening={true} isSupported={true} onClick={vi.fn()} />);
    expect(screen.getByRole("button")).toHaveAttribute("aria-pressed", "true");
  });

  it("has descriptive title with keyboard shortcut", () => {
    render(<MicButton isListening={false} isSupported={true} onClick={vi.fn()} />);
    expect(screen.getByRole("button")).toHaveAttribute("title", "Voice input (Ctrl+Shift+M)");
  });

  it("passes axe accessibility checks", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(
      <MicButton isListening={false} isSupported={true} onClick={vi.fn()} />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("passes axe accessibility checks in listening state", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(
      <MicButton isListening={true} isSupported={true} onClick={vi.fn()} />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  // -- Visual states --

  it("shows pulsing dot when listening", () => {
    const { container } = render(
      <MicButton isListening={true} isSupported={true} onClick={vi.fn()} />,
    );
    // The pulsing dot is a span with animate-pulse class
    const dots = container.querySelectorAll(".animate-pulse");
    expect(dots.length).toBeGreaterThan(0);
  });

  it("does not show pulsing dot when idle", () => {
    const { container } = render(
      <MicButton isListening={false} isSupported={true} onClick={vi.fn()} />,
    );
    const dots = container.querySelectorAll(".animate-pulse");
    expect(dots.length).toBe(0);
  });

  it("does not show pulsing dot when listening but disabled", () => {
    const { container } = render(
      <MicButton isListening={true} isSupported={true} onClick={vi.fn()} disabled />,
    );
    const dots = container.querySelectorAll(".animate-pulse");
    expect(dots.length).toBe(0);
  });
});
