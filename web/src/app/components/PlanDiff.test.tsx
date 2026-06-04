/**
 * PlanDiff tests: every change kind must render with a distinct, accessible
 * treatment (a marker glyph + an SR-readable verb), protected resources must be
 * flagged, and the empty case must show the "no changes" state. Colour is a
 * secondary cue, so we assert on the text/role signals a screen reader uses.
 */

import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { PlanDiff } from "./PlanDiff";
import type { PlanChange } from "../../api/types";

function change(over: Partial<PlanChange>): PlanChange {
  return {
    kind: "+",
    action: "create",
    address: "fly_app.example",
    message: "",
    protected: false,
    ...over,
  };
}

describe("PlanDiff", () => {
  it("renders a distinct accessible verb for each change kind", () => {
    const changes: PlanChange[] = [
      change({ kind: "+", address: "a.create" }),
      change({ kind: "~", address: "a.update" }),
      change({ kind: "-", address: "a.destroy" }),
      change({ kind: "=", address: "a.noop" }),
      change({ kind: "!", address: "a.blocked" }),
    ];
    render(<PlanDiff changes={changes} />);

    const list = screen.getByRole("list", { name: /planned changes/i });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(5);

    // Each kind exposes its semantic verb and tags the row via data-kind.
    expect(within(items[0]).getByText("create")).toBeInTheDocument();
    expect(items[0]).toHaveAttribute("data-kind", "+");
    expect(within(items[1]).getByText("update")).toBeInTheDocument();
    expect(items[1]).toHaveAttribute("data-kind", "~");
    expect(within(items[2]).getByText("destroy")).toBeInTheDocument();
    expect(items[2]).toHaveAttribute("data-kind", "-");
    expect(within(items[3]).getByText("no change")).toBeInTheDocument();
    expect(items[3]).toHaveAttribute("data-kind", "=");
    expect(within(items[4]).getByText("blocked")).toBeInTheDocument();
    expect(items[4]).toHaveAttribute("data-kind", "!");
  });

  it("applies a distinct text colour class per kind", () => {
    // Distinct styling is part of the contract; assert the colour classes the
    // component maps each kind to so a regression in the palette is caught.
    const { rerender } = render(
      <PlanDiff changes={[change({ kind: "+", message: "" })]} />,
    );
    expect(screen.getByText("create")).toHaveClass("text-ok");

    rerender(<PlanDiff changes={[change({ kind: "-", message: "" })]} />);
    expect(screen.getByText("destroy")).toHaveClass("text-danger");

    rerender(<PlanDiff changes={[change({ kind: "~", message: "" })]} />);
    expect(screen.getByText("update")).toHaveClass("text-warn");

    rerender(<PlanDiff changes={[change({ kind: "=", message: "" })]} />);
    expect(screen.getByText("no change")).toHaveClass("text-faint");
  });

  it("flags protected resources with a badge", () => {
    render(
      <PlanDiff
        changes={[change({ kind: "-", address: "fly_app.prod", protected: true })]}
      />,
    );
    expect(screen.getByText("protected")).toBeInTheDocument();
  });

  it("shows the message text when present", () => {
    render(
      <PlanDiff
        changes={[change({ kind: "~", message: "memory 256mb -> 512mb" })]}
      />,
    );
    expect(screen.getByText("memory 256mb -> 512mb")).toBeInTheDocument();
  });

  it("renders an empty state when there are no changes", () => {
    render(<PlanDiff changes={[]} />);
    expect(screen.getByText(/no changes/i)).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });
});
