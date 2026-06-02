import { describe, it, expect } from "vitest";
import { linearBranchSlug, resolveLinearBranch } from "./linear-branch.js";
import type { LinearIssue } from "../api.js";

// ─── linearBranchSlug ───────────────────────────────────────────────────────

describe("linearBranchSlug", () => {
  it("creates a slug from identifier and title", () => {
    // Standard case: identifier + title → lowercase kebab-case
    expect(linearBranchSlug("THE-123", "Fix auth flow")).toBe("the-123-fix-auth-flow");
  });

  it("strips special characters from title", () => {
    expect(linearBranchSlug("ENG-42", "Add OAuth2.0 (Google)")).toBe("eng-42-add-oauth2-0-google");
  });

  it("trims leading/trailing hyphens from slug", () => {
    expect(linearBranchSlug("THE-1", "---hello---")).toBe("the-1-hello");
  });

  it("truncates long titles to 60 chars", () => {
    const longTitle = "a".repeat(100);
    const result = linearBranchSlug("X-1", longTitle);
    // "x-1-" (4 chars) + 60 chars of slug = 64 chars max
    const slugPart = result.slice("x-1-".length);
    expect(slugPart.length).toBeLessThanOrEqual(60);
  });

  it("handles empty title", () => {
    expect(linearBranchSlug("THE-99", "")).toBe("the-99-");
  });

  it("collapses consecutive special chars into a single hyphen", () => {
    expect(linearBranchSlug("THE-5", "foo   bar!!!baz")).toBe("the-5-foo-bar-baz");
  });
});

// ─── resolveLinearBranch ────────────────────────────────────────────────────

function makeIssue(overrides: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: "id-1",
    identifier: "THE-138",
    title: "Auto-create the recommended Linear branch",
    description: "",
    url: "https://linear.app/test/issue/THE-138",
    branchName: "",
    priorityLabel: "Urgent",
    stateName: "Backlog",
    stateType: "backlog",
    teamName: "Engineering",
    teamKey: "ENG",
    teamId: "team-eng-1",
    ...overrides,
  };
}

describe("resolveLinearBranch", () => {
  it("returns branchName when provided by Linear", () => {
    // When Linear provides a recommended branch name, use it as-is
    const issue = makeIssue({ branchName: "the-138-auto-create-branch" });
    expect(resolveLinearBranch(issue)).toBe("the-138-auto-create-branch");
  });

  it("trims whitespace from branchName", () => {
    const issue = makeIssue({ branchName: "  feat/branch-name  " });
    expect(resolveLinearBranch(issue)).toBe("feat/branch-name");
  });

  it("falls back to identifier-title slug when branchName is empty", () => {
    // When branchName is empty, generate fallback from identifier + title
    const issue = makeIssue({ branchName: "" });
    expect(resolveLinearBranch(issue)).toBe("the-138-auto-create-the-recommended-linear-branch");
  });

  it("falls back to identifier-title slug when branchName is whitespace-only", () => {
    const issue = makeIssue({ branchName: "   " });
    expect(resolveLinearBranch(issue)).toBe("the-138-auto-create-the-recommended-linear-branch");
  });
});
