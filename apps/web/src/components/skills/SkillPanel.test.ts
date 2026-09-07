/* oxlint-disable anti-slop/no-module-mocking, anti-slop/require-safety-comment-for-type-assertion -- Hosted Companion removal preserves the existing Skills Hub implementation; these patterns predate this change. */
// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillVM } from "@/lib/types";
import { SkillPanel } from "./SkillPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const queryMocks = vi.hoisted(() => ({ fetchSkillVersionFiles: vi.fn() }));
vi.mock("@/lib/queries", () => queryMocks);

const roots: Root[] = [];

function skill(overrides: Partial<SkillVM> = {}): SkillVM {
  return {
    uuid: "skill-1",
    id: "seo-helper",
    shareToken: "share-seo-helper",
    version: "1.0.0",
    validation: "valid",
    description: "Helps with SEO checks.",
    display: {},
    icon: null,
    notes: null,
    error: null,
    scope: "org",
    source: null,
    labels: ["growth/seo"],
    authorId: "user-1",
    authorName: "Ada Lovelace",
    authorInitials: "AL",
    authorAvatarUrl: null,
    updaterId: "user-1",
    updaterName: "Ada Lovelace",
    updaterInitials: "AL",
    updaterAvatarUrl: null,
    modifiers: [],
    tools: [],
    requirements: [],
    compatibility: null,
    metadata: {},
    size: "1 KB",
    license: "MIT",
    checksum: null,
    created: "Jun 1, 2026",
    updated: "just now",
    installStatus: "none",
    installedVersion: null,
    requiresCount: 0,
    usedByCount: 0,
    depWarn: false,
    archived: false,
    ...overrides,
  };
}

async function mount(overrides: Partial<SkillVM> = {}, props: {
  onOpen?: (slug: string) => void;
  onAction?: ReturnType<typeof vi.fn>;
  onClose?: () => void;
} = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(React.createElement(SkillPanel, {
      skill: skill(overrides),
      labels: [],
      actorId: "user-1",
      onOpen: props.onOpen ?? (() => {}),
      onAction: props.onAction ?? vi.fn(),
      onClose: props.onClose ?? (() => {}),
    }));
  });
  return container;
}

function buttonNamed(container: HTMLElement, label: string) {
  return [...container.querySelectorAll("button")]
    .find((button) => button.getAttribute("aria-label") === label
      || button.textContent?.trim() === label);
}

describe("SkillPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryMocks.fetchSkillVersionFiles.mockResolvedValue({ version: "1.0.0", files: [] });
  });

  afterEach(() => {
    act(() => roots.splice(0).forEach((root) => root.unmount()));
    document.body.innerHTML = "";
  });

  it("names the skill by its slug, its version, and where it is filed", async () => {
    const container = await mount();

    expect(container.querySelector(".skpanel__name")?.textContent).toBe("seo-helper");
    expect(container.querySelector(".skpanel__eyebrow")?.textContent)
      .toBe("v1.0.0 · Organization / growth/seo");
    expect(container.textContent).toContain("Helps with SEO checks.");
    expect(container.textContent).toContain("Ada Lovelace");
    expect(container.textContent).toContain("1 KB");
  });

  it("carries the one action the skill is currently for, and Open for everything else", async () => {
    const onAction = vi.fn();
    const onOpen = vi.fn();

    const fresh = await mount({}, { onAction, onOpen });
    act(() => buttonNamed(fresh, "Install skill seo-helper")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({ id: "seo-helper" }),
      expect.objectContaining({ id: "install" }),
    );

    act(() => buttonNamed(fresh, "Open")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onOpen).toHaveBeenCalledWith("seo-helper");
  });

  it("follows the shared action matrix rather than inventing its own", async () => {
    const upToDate = await mount({ installStatus: "installed", installedVersion: "1.0.0" });
    expect(buttonNamed(upToDate, "Install skill seo-helper")).toBeUndefined();
    expect(upToDate.textContent).toContain("Installed");

    const stale = await mount({ installStatus: "update", installedVersion: "0.9.0" });
    expect(buttonNamed(stale, "Update skill seo-helper")).toBeDefined();

    const personal = await mount({ scope: "personal", source: "authored" });
    expect(buttonNamed(personal, "Share to organization seo-helper")).toBeDefined();
  });

  it("shows the opening of SKILL.md rather than the whole file", async () => {
    queryMocks.fetchSkillVersionFiles.mockResolvedValue({
      version: "1.0.0",
      files: [{
        path: "SKILL.md",
        size: 100,
        content: [...Array(40)].map((_, index) => `line ${index + 1}`).join("\n"),
        binary: false,
        truncated: false,
        preview_kind: "text",
        content_type: "text/markdown",
      }],
    });

    const container = await mount();
    const excerpt = container.querySelector(".skpanel__excerpt")?.textContent ?? "";

    expect(excerpt).toContain("line 1");
    expect(excerpt).toContain("line 20");
    expect(excerpt).not.toContain("line 21");
  });

  it("keeps the panel when its side reads fail", async () => {
    queryMocks.fetchSkillVersionFiles.mockRejectedValue(new Error("archive unavailable"));

    const container = await mount();
    expect(container.querySelector(".skpanel__name")?.textContent).toBe("seo-helper");
    expect(container.querySelector(".skpanel__excerpt")).toBeNull();
    expect(container.textContent).not.toContain("Used by");
  });
});
