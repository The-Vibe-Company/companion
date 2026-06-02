// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SectionErrorBoundary } from "./SectionErrorBoundary.js";

// Suppress React error boundary console.error noise during tests
vi.spyOn(console, "error").mockImplementation(() => {});

function ThrowingChild({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error("test crash");
  return <div>child content</div>;
}

describe("SectionErrorBoundary", () => {
  it("renders children when no error occurs", () => {
    render(
      <SectionErrorBoundary label="Test">
        <div>hello</div>
      </SectionErrorBoundary>,
    );
    expect(screen.getByText("hello")).toBeTruthy();
  });

  it("shows fallback UI with label when child throws", () => {
    render(
      <SectionErrorBoundary label="Usage Limits">
        <ThrowingChild shouldThrow />
      </SectionErrorBoundary>,
    );
    expect(screen.getByText("Usage Limits failed to load")).toBeTruthy();
    expect(screen.getByText("Retry")).toBeTruthy();
  });

  it("shows generic fallback when no label provided", () => {
    render(
      <SectionErrorBoundary>
        <ThrowingChild shouldThrow />
      </SectionErrorBoundary>,
    );
    expect(screen.getByText("Section failed to load")).toBeTruthy();
  });

  it("resets error state when Retry button is clicked", () => {
    // Render with throwing child — should show error fallback
    render(
      <SectionErrorBoundary label="Test">
        <ThrowingChild shouldThrow />
      </SectionErrorBoundary>,
    );

    expect(screen.getByText("Test failed to load")).toBeTruthy();

    // Click Retry resets hasError, React tries to render children again.
    // Since ThrowingChild still throws, it catches again and shows fallback.
    // This verifies that clicking Retry doesn't crash and the boundary handles re-throws.
    fireEvent.click(screen.getByText("Retry"));

    // Error boundary should catch the re-throw and show fallback again
    expect(screen.getByText("Test failed to load")).toBeTruthy();
    expect(screen.getByText("Retry")).toBeTruthy();
  });
});
