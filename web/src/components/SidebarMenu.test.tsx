// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { createRef } from "react";

// ─── Store mock ──────────────────────────────────────────────────────────────

const mockState = {
  closeTerminal: vi.fn(),
  setSidebarOpen: vi.fn(),
  sidebarGroupByProject: false,
  setSidebarGroupByProject: vi.fn(),
};

vi.mock("../store.js", () => {
  const useStoreFn = (selector: (state: typeof mockState) => unknown) => {
    return selector(mockState);
  };
  useStoreFn.getState = () => mockState;
  return { useStore: useStoreFn };
});

vi.mock("../utils/routing.js", () => ({
  parseHash: (hash: string) => {
    const page = hash.replace("#/", "") || "home";
    return { page, sessionId: null };
  },
}));

// ─── Import component after mocks ────────────────────────────────────────────

import { SidebarMenu, NAV_ITEMS, EXTERNAL_LINKS } from "./SidebarMenu.js";

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("SidebarMenu", () => {
  const anchorRef = createRef<HTMLButtonElement>();

  beforeEach(() => {
    vi.clearAllMocks();
    window.location.hash = "";
  });

  it("renders nothing when closed", () => {
    // Verifies that the menu is not rendered when open=false.
    const { container } = render(
      <SidebarMenu open={false} onClose={vi.fn()} anchorRef={anchorRef} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders all navigation items when open", () => {
    // Verifies that every NAV_ITEMS entry appears as a menu item.
    render(
      <SidebarMenu open={true} onClose={vi.fn()} anchorRef={anchorRef} />,
    );
    for (const item of NAV_ITEMS) {
      expect(screen.getByText(item.label)).toBeInTheDocument();
    }
  });

  it("renders all external links when open", () => {
    // Verifies that Documentation, GitHub, and Website links appear.
    render(
      <SidebarMenu open={true} onClose={vi.fn()} anchorRef={anchorRef} />,
    );
    for (const link of EXTERNAL_LINKS) {
      expect(screen.getByText(link.label)).toBeInTheDocument();
    }
  });

  it("external links open in new tab with secure attributes", () => {
    // Verifies that external links use target="_blank" and rel="noopener noreferrer".
    render(
      <SidebarMenu open={true} onClose={vi.fn()} anchorRef={anchorRef} />,
    );
    for (const link of EXTERNAL_LINKS) {
      const el = screen.getByText(link.label).closest("a");
      expect(el).toHaveAttribute("target", "_blank");
      expect(el).toHaveAttribute("rel", "noopener noreferrer");
      expect(el).toHaveAttribute("href", link.url);
    }
  });

  it("calls onClose when a navigation item is clicked", () => {
    // Verifies the menu closes after selecting a nav item.
    const onClose = vi.fn();
    render(
      <SidebarMenu open={true} onClose={onClose} anchorRef={anchorRef} />,
    );
    fireEvent.click(screen.getByText("Prompts"));
    expect(onClose).toHaveBeenCalled();
    expect(window.location.hash).toBe("#/prompts");
  });

  it("navigates to correct hash for each nav item", () => {
    // Verifies that clicking each nav item sets the correct hash route.
    const onClose = vi.fn();
    for (const item of NAV_ITEMS) {
      window.location.hash = "";
      const { unmount } = render(
        <SidebarMenu open={true} onClose={onClose} anchorRef={anchorRef} />,
      );
      fireEvent.click(screen.getByText(item.label));
      expect(window.location.hash).toBe(item.hash);
      unmount();
    }
  });

  it("closes on Escape key", () => {
    // Verifies that pressing Escape closes the menu.
    const onClose = vi.fn();
    render(
      <SidebarMenu open={true} onClose={onClose} anchorRef={anchorRef} />,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("has role=menu for accessibility", () => {
    // Verifies the dropdown has a menu role for assistive technology.
    render(
      <SidebarMenu open={true} onClose={vi.fn()} anchorRef={anchorRef} />,
    );
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("each nav item has role=menuitem", () => {
    // Verifies that each navigation item is a proper menuitem.
    render(
      <SidebarMenu open={true} onClose={vi.fn()} anchorRef={anchorRef} />,
    );
    const menuItems = screen.getAllByRole("menuitem");
    // NAV_ITEMS + "Group by project" toggle + EXTERNAL_LINKS
    expect(menuItems.length).toBe(NAV_ITEMS.length + 1 + EXTERNAL_LINKS.length);
  });

  it("passes axe accessibility checks", async () => {
    // Verifies the menu meets WCAG accessibility standards.
    const { axe } = await import("vitest-axe");
    const { container } = render(
      <SidebarMenu open={true} onClose={vi.fn()} anchorRef={anchorRef} />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
