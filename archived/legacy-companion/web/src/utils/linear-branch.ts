import type { LinearIssue } from "../api.js";

/**
 * Generate a fallback branch name from a Linear issue identifier and title.
 * Example: "THE-123" + "Fix auth flow" → "the-123-fix-auth-flow"
 */
export function linearBranchSlug(identifier: string, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${identifier.toLowerCase()}-${slug}`;
}

/**
 * Resolve the branch name for a Linear issue.
 * Uses Linear's recommended branchName, falling back to identifier-title-slug.
 */
export function resolveLinearBranch(issue: LinearIssue): string {
  if (issue.branchName && issue.branchName.trim()) {
    return issue.branchName.trim();
  }
  return linearBranchSlug(issue.identifier, issue.title);
}
