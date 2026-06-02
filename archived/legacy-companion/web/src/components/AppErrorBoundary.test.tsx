// @vitest-environment jsdom
import type { ReactElement } from "react";
import { render, screen } from "@testing-library/react";
import { AppErrorBoundary } from "./AppErrorBoundary.js";

const { captureExceptionMock } = vi.hoisted(() => ({
  captureExceptionMock: vi.fn(),
}));

vi.mock("../analytics.js", () => ({
  captureException: captureExceptionMock,
}));

function Crasher(): ReactElement {
  throw new Error("render failed");
}

describe("AppErrorBoundary", () => {
  beforeEach(() => {
    captureExceptionMock.mockReset();
  });

  it("shows fallback UI and reports exceptions", () => {
    // Validates React render-time crashes are both user-visible and reported to telemetry.
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <AppErrorBoundary>
        <Crasher />
      </AppErrorBoundary>,
    );

    expect(screen.getByText("A runtime error occurred")).toBeTruthy();
    expect(captureExceptionMock).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});
