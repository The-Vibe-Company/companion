// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { createRef } from "react";
import { MentionMenu } from "./MentionMenu.js";
import type { SavedPrompt } from "../api.js";

const samplePrompts: SavedPrompt[] = [
  { id: "1", name: "review", content: "Please review this code", scope: "global", createdAt: Date.now(), updatedAt: Date.now() },
  { id: "2", name: "refactor", content: "Refactor this module", scope: "project", createdAt: Date.now(), updatedAt: Date.now() },
];

describe("MentionMenu", () => {
  const onSelect = vi.fn();
  const menuRef = createRef<HTMLDivElement>();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders nothing when open is false", () => {
    const { container } = render(
      <MentionMenu
        open={false}
        loading={false}
        prompts={samplePrompts}
        selectedIndex={0}
        onSelect={onSelect}
        menuRef={menuRef}
      />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("shows loading state", () => {
    render(
      <MentionMenu
        open={true}
        loading={true}
        prompts={[]}
        selectedIndex={0}
        onSelect={onSelect}
        menuRef={menuRef}
      />,
    );
    expect(screen.getByText("Searching prompts...")).toBeInTheDocument();
  });

  it("shows empty state when no prompts match", () => {
    render(
      <MentionMenu
        open={true}
        loading={false}
        prompts={[]}
        selectedIndex={0}
        onSelect={onSelect}
        menuRef={menuRef}
      />,
    );
    expect(screen.getByText("No prompts found.")).toBeInTheDocument();
  });

  it("renders prompt items with names and content", () => {
    render(
      <MentionMenu
        open={true}
        loading={false}
        prompts={samplePrompts}
        selectedIndex={0}
        onSelect={onSelect}
        menuRef={menuRef}
      />,
    );
    expect(screen.getByText("@review")).toBeInTheDocument();
    expect(screen.getByText("Please review this code")).toBeInTheDocument();
    expect(screen.getByText("@refactor")).toBeInTheDocument();
    expect(screen.getByText("Refactor this module")).toBeInTheDocument();
  });

  it("shows the scope label for each prompt", () => {
    render(
      <MentionMenu
        open={true}
        loading={false}
        prompts={samplePrompts}
        selectedIndex={0}
        onSelect={onSelect}
        menuRef={menuRef}
      />,
    );
    expect(screen.getByText("global")).toBeInTheDocument();
    expect(screen.getByText("project")).toBeInTheDocument();
  });

  it("highlights the selected item", () => {
    render(
      <MentionMenu
        open={true}
        loading={false}
        prompts={samplePrompts}
        selectedIndex={1}
        onSelect={onSelect}
        menuRef={menuRef}
      />,
    );
    const buttons = screen.getAllByRole("button");
    // Second button (index 1) should have the selected class
    expect(buttons[1].className).toContain("bg-cc-hover");
    // First button should not have the solid highlight
    expect(buttons[0].className).not.toContain("bg-cc-hover ");
  });

  it("calls onSelect when a prompt is clicked", () => {
    render(
      <MentionMenu
        open={true}
        loading={false}
        prompts={samplePrompts}
        selectedIndex={0}
        onSelect={onSelect}
        menuRef={menuRef}
      />,
    );
    fireEvent.click(screen.getByText("@refactor"));
    expect(onSelect).toHaveBeenCalledWith(samplePrompts[1]);
  });

  it("passes axe accessibility checks", async () => {
    const { container } = render(
      <MentionMenu
        open={true}
        loading={false}
        prompts={samplePrompts}
        selectedIndex={0}
        onSelect={onSelect}
        menuRef={menuRef}
      />,
    );
    const { axe } = await import("vitest-axe");
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("applies custom className", () => {
    render(
      <MentionMenu
        open={true}
        loading={false}
        prompts={samplePrompts}
        selectedIndex={0}
        onSelect={onSelect}
        menuRef={menuRef}
        className="absolute bottom-full"
      />,
    );
    const menu = screen.getByText("@review").closest("[class*='max-h']");
    expect(menu?.className).toContain("absolute bottom-full");
  });
});
