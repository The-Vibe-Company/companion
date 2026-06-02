// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";

import { ArchiveLinearModal } from "./ArchiveLinearModal.js";

const defaultProps = {
  issueIdentifier: "ENG-42",
  issueStateName: "In Progress",
  isContainerized: false,
  archiveTransitionConfigured: false,
  archiveTransitionStateName: undefined,
  hasBacklogState: true,
  onConfirm: vi.fn(),
  onCancel: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ArchiveLinearModal", () => {
  it("renders with issue identifier and state name", () => {
    render(<ArchiveLinearModal {...defaultProps} />);
    expect(screen.getByText("Archive session")).toBeInTheDocument();
    expect(screen.getByText("ENG-42")).toBeInTheDocument();
    expect(screen.getByText(/In Progress/)).toBeInTheDocument();
  });

  it("has 'Keep current status' selected by default", () => {
    render(<ArchiveLinearModal {...defaultProps} />);
    const keepRadio = screen.getByLabelText("Keep current status");
    expect(keepRadio).toBeChecked();
  });

  it("shows 'Move to Backlog' option enabled when hasBacklogState is true", () => {
    render(<ArchiveLinearModal {...defaultProps} hasBacklogState={true} />);
    const backlogRadio = screen.getByLabelText("Move to Backlog");
    expect(backlogRadio).not.toBeDisabled();
  });

  it("disables 'Move to Backlog' when hasBacklogState is false", () => {
    render(<ArchiveLinearModal {...defaultProps} hasBacklogState={false} />);
    const backlogRadio = screen.getByLabelText("Move to Backlog");
    expect(backlogRadio).toBeDisabled();
  });

  it("shows configured transition option when archiveTransitionConfigured is true", () => {
    render(
      <ArchiveLinearModal
        {...defaultProps}
        archiveTransitionConfigured={true}
        archiveTransitionStateName="Review"
      />,
    );
    expect(screen.getByLabelText("Move to Review")).toBeInTheDocument();
  });

  it("does not show configured transition option when archiveTransitionConfigured is false", () => {
    render(<ArchiveLinearModal {...defaultProps} archiveTransitionConfigured={false} />);
    expect(screen.queryByText(/Move to Review/)).not.toBeInTheDocument();
  });

  it("shows container warning when isContainerized is true", () => {
    render(<ArchiveLinearModal {...defaultProps} isContainerized={true} />);
    expect(screen.getByText(/remove the container/)).toBeInTheDocument();
  });

  it("does not show container warning when isContainerized is false", () => {
    render(<ArchiveLinearModal {...defaultProps} isContainerized={false} />);
    expect(screen.queryByText(/remove the container/)).not.toBeInTheDocument();
  });

  it("calls onConfirm with 'none' when Archive is clicked with default selection", () => {
    render(<ArchiveLinearModal {...defaultProps} />);
    fireEvent.click(screen.getByText("Archive"));
    expect(defaultProps.onConfirm).toHaveBeenCalledWith("none", undefined);
  });

  it("calls onConfirm with 'backlog' when Backlog is selected and Archive is clicked", () => {
    render(<ArchiveLinearModal {...defaultProps} />);
    fireEvent.click(screen.getByLabelText("Move to Backlog"));
    fireEvent.click(screen.getByText("Archive"));
    expect(defaultProps.onConfirm).toHaveBeenCalledWith("backlog", undefined);
  });

  it("calls onConfirm with 'configured' when configured option is selected", () => {
    render(
      <ArchiveLinearModal
        {...defaultProps}
        archiveTransitionConfigured={true}
        archiveTransitionStateName="Review"
      />,
    );
    fireEvent.click(screen.getByLabelText("Move to Review"));
    fireEvent.click(screen.getByText("Archive"));
    expect(defaultProps.onConfirm).toHaveBeenCalledWith("configured", undefined);
  });

  it("passes force=true when containerized and Archive is clicked", () => {
    render(<ArchiveLinearModal {...defaultProps} isContainerized={true} />);
    fireEvent.click(screen.getByText("Archive"));
    expect(defaultProps.onConfirm).toHaveBeenCalledWith("none", true);
  });

  it("calls onCancel when Cancel button is clicked", () => {
    render(<ArchiveLinearModal {...defaultProps} />);
    // There are 2 cancel triggers: button and close icon — click the button
    const cancelButtons = screen.getAllByText("Cancel");
    fireEvent.click(cancelButtons[0]);
    expect(defaultProps.onCancel).toHaveBeenCalled();
  });

  it("calls onCancel when backdrop overlay is clicked", () => {
    render(<ArchiveLinearModal {...defaultProps} />);
    // The backdrop is the outermost fixed div
    const backdrop = document.querySelector(".fixed.inset-0");
    if (backdrop) {
      fireEvent.click(backdrop);
      expect(defaultProps.onCancel).toHaveBeenCalled();
    }
  });

  it("passes accessibility audit", async () => {
    const { axe } = await import("vitest-axe");
    // axe needs the portal content to be inside a container it can scan
    render(<ArchiveLinearModal {...defaultProps} />);
    const results = await axe(document.body);
    expect(results).toHaveNoViolations();
  });
});
