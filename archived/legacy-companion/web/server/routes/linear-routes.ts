import type { Hono } from "hono";
import { getSettings } from "../settings-manager.js";
import { linearCache } from "../linear-cache.js";
import * as sessionLinearIssues from "../session-linear-issues.js";
import * as linearProjectManager from "../linear-project-manager.js";
import { resolveApiKey, getConnection } from "../linear-connections.js";

function linearIssueStateCategory(issue: { stateType?: string; stateName?: string }): 0 | 1 | 2 {
  const stateType = (issue.stateType || "").trim().toLowerCase();
  const stateName = (issue.stateName || "").trim().toLowerCase();
  const isDone = stateType === "completed" || stateType === "canceled" || stateType === "cancelled"
    || stateName === "done" || stateName === "completed" || stateName === "canceled" || stateName === "cancelled";
  if (isDone) return 2;
  if (stateType === "started") return 1;
  return 0;
}

/**
 * Transition a Linear issue to a specific workflow state.
 * Returns a result object — never throws.
 */
export async function transitionLinearIssue(
  issueId: string,
  stateId: string,
  linearApiKey: string,
  connectionId?: string,
): Promise<{
  ok: boolean;
  error?: string;
  issue?: { id: string; identifier: string; stateName: string; stateType: string };
}> {
  try {
    const updateResponse = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: linearApiKey,
      },
      body: JSON.stringify({
        query: `
          mutation CompanionTransitionIssue($issueId: String!, $stateId: String!) {
            issueUpdate(id: $issueId, input: { stateId: $stateId }) {
              success
              issue {
                id
                identifier
                state { name type }
              }
            }
          }
        `,
        variables: { issueId, stateId },
      }),
    });

    const updateJson = await updateResponse.json().catch(() => ({})) as {
      data?: {
        issueUpdate?: {
          success?: boolean;
          issue?: {
            id?: string;
            identifier?: string;
            state?: { name?: string; type?: string };
          };
        };
      };
      errors?: Array<{ message?: string }>;
    };

    if (!updateResponse.ok || (updateJson.errors && updateJson.errors.length > 0)) {
      const errMsg = updateJson.errors?.[0]?.message || updateResponse.statusText || "Failed to update issue state";
      return { ok: false, error: errMsg };
    }

    const updatedIssue = updateJson.data?.issueUpdate?.issue;

    // Invalidate cached issue data so the next fetch picks up the new state
    const cachePrefix = connectionId ? `${connectionId}:` : "";
    linearCache.invalidate(`${cachePrefix}issue:${issueId}`);

    return {
      ok: true,
      issue: {
        id: updatedIssue?.id || issueId,
        identifier: updatedIssue?.identifier || "",
        stateName: updatedIssue?.state?.name || "",
        stateType: updatedIssue?.state?.type || "",
      },
    };
  } catch (e: unknown) {
    const errMsg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Linear transition failed: ${errMsg}` };
  }
}

export interface LinearTeamState {
  id: string;
  name: string;
  type: string;
}

export interface LinearTeam {
  id: string;
  key: string;
  name: string;
  states: LinearTeamState[];
}

/**
 * Fetch all Linear team workflow states (cached for 5 minutes).
 * Returns empty array on error.
 */
export async function fetchLinearTeamStates(linearApiKey: string, cachePrefix?: string): Promise<LinearTeam[]> {
  try {
    const cacheKey = cachePrefix ? `${cachePrefix}:states` : "states";
    return await linearCache.getOrFetch(cacheKey, 300_000, async () => {
      const response = await fetch("https://api.linear.app/graphql", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: linearApiKey,
        },
        body: JSON.stringify({
          query: `
            query CompanionWorkflowStates {
              teams {
                nodes {
                  id
                  key
                  name
                  states {
                    nodes {
                      id
                      name
                      type
                    }
                  }
                }
              }
            }
          `,
        }),
      });

      const json = await response.json().catch(() => ({})) as {
        data?: {
          teams?: {
            nodes?: Array<{
              id?: string;
              key?: string | null;
              name?: string | null;
              states?: {
                nodes?: Array<{
                  id?: string;
                  name?: string | null;
                  type?: string | null;
                }>;
              };
            }>;
          };
        };
        errors?: Array<{ message?: string }>;
      };

      if (!response.ok || (json.errors && json.errors.length > 0)) {
        const firstError = json.errors?.[0]?.message || response.statusText || "Linear request failed";
        throw new Error(firstError);
      }

      return (json.data?.teams?.nodes || []).map((team) => ({
        id: team.id || "",
        key: team.key || "",
        name: team.name || "",
        states: (team.states?.nodes || []).map((state) => ({
          id: state.id || "",
          name: state.name || "",
          type: state.type || "",
        })),
      }));
    });
  } catch {
    return [];
  }
}

export function registerLinearRoutes(api: Hono): void {
  api.get("/linear/issues", async (c) => {
    const query = (c.req.query("query") || "").trim();
    const limitRaw = Number(c.req.query("limit") || "8");
    const limit = Math.min(20, Math.max(1, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 8));
    if (!query) return c.json({ issues: [] });

    const connectionId = c.req.query("connectionId") || undefined;
    const resolved = resolveApiKey(connectionId);
    if (!resolved) {
      return c.json({ error: "No Linear connection configured" }, 400);
    }
    const { apiKey: linearApiKey, connectionId: resolvedId } = resolved;

    try {
      const cacheKey = `${resolvedId}:search:${query}:${limit}`;
      const issues = await linearCache.getOrFetch(cacheKey, 30_000, async () => {
        const response = await fetch("https://api.linear.app/graphql", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: linearApiKey,
          },
          body: JSON.stringify({
            query: `
              query CompanionIssueSearch($term: String!, $first: Int!) {
                searchIssues(term: $term, first: $first) {
                  nodes {
                    id
                    identifier
                    title
                    description
                    url
                    branchName
                    priorityLabel
                    state { name type }
                    team { id key name }
                  }
                }
              }
            `,
            variables: { term: query, first: limit },
          }),
        }).catch((e: unknown) => {
          throw new Error(`Failed to connect to Linear: ${e instanceof Error ? e.message : String(e)}`);
        });

        const json = await response.json().catch(() => ({})) as {
          data?: {
            searchIssues?: {
              nodes?: Array<{
                id: string;
                identifier: string;
                title: string;
                description?: string | null;
                url: string;
                branchName?: string | null;
                priorityLabel?: string | null;
                state?: { name?: string | null; type?: string | null } | null;
                team?: { id?: string | null; key?: string | null; name?: string | null } | null;
              }>;
            };
          };
          errors?: Array<{ message?: string }>;
        };

        if (!response.ok || (json.errors && json.errors.length > 0)) {
          const firstError = json.errors?.[0]?.message || response.statusText || "Linear request failed";
          throw new Error(firstError);
        }

        return (json.data?.searchIssues?.nodes || []).map((issue) => ({
          id: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          description: issue.description || "",
          url: issue.url,
          branchName: issue.branchName || "",
          priorityLabel: issue.priorityLabel || "",
          stateName: issue.state?.name || "",
          stateType: issue.state?.type || "",
          teamName: issue.team?.name || "",
          teamKey: issue.team?.key || "",
          teamId: issue.team?.id || "",
        }))
          .filter((issue) => linearIssueStateCategory(issue) !== 2)
          .sort((a, b) => linearIssueStateCategory(a) - linearIssueStateCategory(b));
      });

      return c.json({ issues });
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : "Linear request failed" }, 502);
    }
  });

  // ─── Create a new Linear issue ──────────────────────────────────────

  api.post("/linear/issues", async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;

    if (typeof body.title !== "string" || !body.title.trim()) {
      return c.json({ error: "title is required" }, 400);
    }
    if (typeof body.teamId !== "string" || !body.teamId.trim()) {
      return c.json({ error: "teamId is required" }, 400);
    }

    const connectionId = typeof body.connectionId === "string" ? body.connectionId : undefined;
    const resolved = resolveApiKey(connectionId);
    if (!resolved) {
      return c.json({ error: "No Linear connection configured" }, 400);
    }
    const { apiKey: linearApiKey, connectionId: resolvedId } = resolved;

    try {
      const input: Record<string, unknown> = {
        title: (body.title as string).trim(),
        teamId: (body.teamId as string).trim(),
      };
      if (typeof body.description === "string" && body.description.trim()) {
        input.description = body.description.trim();
      }
      if (typeof body.priority === "number" && body.priority >= 0 && body.priority <= 4) {
        input.priority = body.priority;
      }
      if (typeof body.projectId === "string" && body.projectId.trim()) {
        input.projectId = body.projectId.trim();
      }
      if (typeof body.assigneeId === "string" && body.assigneeId.trim()) {
        input.assigneeId = body.assigneeId.trim();
      }
      if (typeof body.stateId === "string" && body.stateId.trim()) {
        input.stateId = body.stateId.trim();
      }

      const response = await fetch("https://api.linear.app/graphql", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: linearApiKey,
        },
        body: JSON.stringify({
          query: `
            mutation CompanionCreateIssue($input: IssueCreateInput!) {
              issueCreate(input: $input) {
                success
                issue {
                  id
                  identifier
                  title
                  description
                  url
                  branchName
                  priorityLabel
                  state { name type }
                  team { id key name }
                  assignee { name displayName }
                }
              }
            }
          `,
          variables: { input },
        }),
      }).catch((e: unknown) => {
        throw new Error(`Failed to connect to Linear: ${e instanceof Error ? e.message : String(e)}`);
      });

      const json = await response.json().catch(() => ({})) as {
        data?: {
          issueCreate?: {
            success?: boolean;
            issue?: {
              id: string;
              identifier: string;
              title: string;
              description?: string | null;
              url: string;
              branchName?: string | null;
              priorityLabel?: string | null;
              state?: { name?: string | null; type?: string | null } | null;
              team?: { id?: string | null; key?: string | null; name?: string | null } | null;
              assignee?: { name?: string | null; displayName?: string | null } | null;
            };
          };
        };
        errors?: Array<{ message?: string }>;
      };

      if (!response.ok || (json.errors && json.errors.length > 0)) {
        const firstError = json.errors?.[0]?.message || response.statusText || "Issue creation failed";
        return c.json({ error: firstError }, 502);
      }

      const result = json.data?.issueCreate;
      if (!result?.success || !result.issue) {
        return c.json({ error: "Issue creation failed" }, 502);
      }

      const issue = result.issue;

      // Invalidate caches so the new issue appears in lists
      if (typeof body.projectId === "string" && body.projectId.trim()) {
        linearCache.invalidate(`${resolvedId}:project-issues:${body.projectId}`);
      }
      linearCache.invalidate(`${resolvedId}:search:`);

      return c.json({
        ok: true,
        issue: {
          id: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          description: issue.description || "",
          url: issue.url,
          branchName: issue.branchName || "",
          priorityLabel: issue.priorityLabel || "",
          stateName: issue.state?.name || "",
          stateType: issue.state?.type || "",
          teamName: issue.team?.name || "",
          teamKey: issue.team?.key || "",
          teamId: issue.team?.id || "",
          assigneeName: issue.assignee?.displayName || issue.assignee?.name || "",
        },
      });
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : "Issue creation failed" }, 502);
    }
  });

  api.get("/linear/connection", async (c) => {
    const connectionId = c.req.query("connectionId") || undefined;
    const resolved = resolveApiKey(connectionId);
    if (!resolved) {
      return c.json({ error: "No Linear connection configured" }, 400);
    }
    const { apiKey: linearApiKey, connectionId: resolvedId } = resolved;

    try {
      const result = await linearCache.getOrFetch(`${resolvedId}:connection`, 300_000, async () => {
        const response = await fetch("https://api.linear.app/graphql", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: linearApiKey,
          },
          body: JSON.stringify({
            query: `
              query CompanionLinearConnection {
                viewer { id name email }
                teams(first: 1) { nodes { id key name } }
              }
            `,
          }),
        }).catch((e: unknown) => {
          throw new Error(`Failed to connect to Linear: ${e instanceof Error ? e.message : String(e)}`);
        });

        const json = await response.json().catch(() => ({})) as {
          data?: {
            viewer?: { id?: string; name?: string | null; email?: string | null } | null;
            teams?: { nodes?: Array<{ id?: string; key?: string | null; name?: string | null }> } | null;
          };
          errors?: Array<{ message?: string }>;
        };

        if (!response.ok || (json.errors && json.errors.length > 0)) {
          const firstError = json.errors?.[0]?.message || response.statusText || "Linear request failed";
          throw new Error(firstError);
        }

        const firstTeam = json.data?.teams?.nodes?.[0];
        return {
          connected: true as const,
          viewerId: json.data?.viewer?.id || "",
          viewerName: json.data?.viewer?.name || "",
          viewerEmail: json.data?.viewer?.email || "",
          teamName: firstTeam?.name || "",
          teamKey: firstTeam?.key || "",
        };
      });

      return c.json(result);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : "Linear request failed" }, 502);
    }
  });

  // ─── Linear issue <-> session association ───────────────────────────

  api.put("/sessions/:id/linear-issue", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    if (!body.id || !body.identifier || !body.title || !body.url) {
      return c.json({ error: "id, identifier, title, and url are required" }, 400);
    }
    sessionLinearIssues.setLinearIssue(id, {
      id: String(body.id),
      identifier: String(body.identifier),
      title: String(body.title),
      description: String(body.description || ""),
      url: String(body.url),
      branchName: String(body.branchName || ""),
      priorityLabel: String(body.priorityLabel || ""),
      stateName: String(body.stateName || ""),
      stateType: String(body.stateType || ""),
      teamName: String(body.teamName || ""),
      teamKey: String(body.teamKey || ""),
      teamId: String(body.teamId || ""),
      assigneeName: body.assigneeName ? String(body.assigneeName) : undefined,
      updatedAt: body.updatedAt ? String(body.updatedAt) : undefined,
      connectionId: body.connectionId ? String(body.connectionId) : undefined,
    });
    return c.json({ ok: true });
  });

  api.get("/sessions/:id/linear-issue", async (c) => {
    const id = c.req.param("id");
    const stored = sessionLinearIssues.getLinearIssue(id);
    if (!stored) return c.json({ issue: null });

    const refresh = c.req.query("refresh") === "true";
    if (!refresh) return c.json({ issue: stored });

    // Fetch fresh data from Linear API using the stored connection
    const resolved = resolveApiKey(stored.connectionId);
    if (!resolved) return c.json({ issue: stored });
    const { apiKey: linearApiKey, connectionId: resolvedId } = resolved;

    try {
      const cacheKey = `${resolvedId}:issue:${stored.id}`;
      const result = await linearCache.getOrFetch(cacheKey, 30_000, async () => {
        const response = await fetch("https://api.linear.app/graphql", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: linearApiKey,
          },
          body: JSON.stringify({
            query: `
              query CompanionIssueFetch($id: String!) {
                issue(id: $id) {
                  id identifier title description url branchName priorityLabel
                  state { name type }
                  team { id key name }
                  comments(last: 5) {
                    nodes {
                      id body createdAt
                      user { id name displayName avatarUrl }
                    }
                  }
                  assignee { id name displayName avatarUrl }
                  labels { nodes { id name color } }
                }
              }
            `,
            variables: { id: stored.id },
          }),
        });

        const json = await response.json().catch(() => ({})) as {
          data?: {
            issue?: {
              id: string;
              identifier: string;
              title: string;
              description?: string | null;
              url: string;
              branchName?: string | null;
              priorityLabel?: string | null;
              state?: { name?: string | null; type?: string | null } | null;
              team?: { id?: string | null; key?: string | null; name?: string | null } | null;
              comments?: { nodes?: Array<{
                id: string;
                body: string;
                createdAt: string;
                user?: { name?: string | null; displayName?: string | null; avatarUrl?: string | null } | null;
              }> } | null;
              assignee?: { name?: string | null; displayName?: string | null; avatarUrl?: string | null } | null;
              labels?: { nodes?: Array<{ id: string; name: string; color: string }> } | null;
            } | null;
          };
          errors?: Array<{ message?: string }>;
        };

        return json.data?.issue ?? null;
      });

      if (result) {
        const updated = {
          id: result.id,
          identifier: result.identifier,
          title: result.title,
          description: result.description || "",
          url: result.url,
          branchName: result.branchName || "",
          priorityLabel: result.priorityLabel || "",
          stateName: result.state?.name || "",
          stateType: result.state?.type || "",
          teamName: result.team?.name || "",
          teamKey: result.team?.key || "",
          teamId: result.team?.id || "",
          assigneeName: result.assignee?.displayName || result.assignee?.name || "",
          updatedAt: new Date().toISOString(),
        };
        sessionLinearIssues.setLinearIssue(id, updated);
        return c.json({
          issue: updated,
          comments: (result.comments?.nodes || []).map((comment) => ({
            id: comment.id,
            body: comment.body,
            createdAt: comment.createdAt,
            userName: comment.user?.displayName || comment.user?.name || "Unknown",
            userAvatarUrl: comment.user?.avatarUrl || null,
          })),
          assignee: result.assignee ? {
            name: result.assignee.displayName || result.assignee.name || "",
            avatarUrl: result.assignee.avatarUrl || null,
          } : null,
          labels: (result.labels?.nodes || []).map((l) => ({
            id: l.id,
            name: l.name,
            color: l.color,
          })),
        });
      }
    } catch {
      // Fall through to return stored data on error
    }

    return c.json({ issue: stored });
  });

  api.delete("/sessions/:id/linear-issue", (c) => {
    const id = c.req.param("id");
    sessionLinearIssues.removeLinearIssue(id);
    return c.json({ ok: true });
  });

  api.post("/linear/issues/:issueId/comments", async (c) => {
    const issueId = c.req.param("issueId");
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    if (typeof body.body !== "string" || !body.body.trim()) {
      return c.json({ error: "body is required" }, 400);
    }

    const connectionId = typeof body.connectionId === "string" ? body.connectionId : undefined;
    const resolved = resolveApiKey(connectionId);
    if (!resolved) {
      return c.json({ error: "No Linear connection configured" }, 400);
    }
    const { apiKey: linearApiKey, connectionId: resolvedConnId } = resolved;

    const response = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: linearApiKey,
      },
      body: JSON.stringify({
        query: `
          mutation CompanionAddComment($issueId: String!, $body: String!) {
            commentCreate(input: { issueId: $issueId, body: $body }) {
              success
              comment { id body createdAt user { name displayName } }
            }
          }
        `,
        variables: { issueId, body: body.body.trim() },
      }),
    }).catch((e: unknown) => {
      throw new Error(`Failed to connect to Linear: ${e instanceof Error ? e.message : String(e)}`);
    });

    const json = await response.json().catch(() => ({})) as {
      data?: {
        commentCreate?: {
          success?: boolean;
          comment?: {
            id: string;
            body: string;
            createdAt: string;
            user?: { name?: string | null; displayName?: string | null } | null;
          };
        };
      };
      errors?: Array<{ message?: string }>;
    };

    if (!response.ok || (json.errors && json.errors.length > 0)) {
      const firstError = json.errors?.[0]?.message || response.statusText || "Comment creation failed";
      return c.json({ error: firstError }, 502);
    }

    const result = json.data?.commentCreate;
    if (!result?.success || !result.comment) {
      return c.json({ error: "Comment creation failed" }, 502);
    }

    // Invalidate cached issue data so the next poll picks up the new comment
    linearCache.invalidate(`${resolvedConnId}:issue:${issueId}`);

    return c.json({
      ok: true,
      comment: {
        id: result.comment.id,
        body: result.comment.body,
        createdAt: result.comment.createdAt,
        userName: result.comment.user?.displayName || result.comment.user?.name || "You",
        userAvatarUrl: null,
      },
    });
  });

  api.get("/linear/states", async (c) => {
    const connectionId = c.req.query("connectionId") || undefined;
    const resolved = resolveApiKey(connectionId);
    if (!resolved) {
      return c.json({ error: "No Linear connection configured" }, 400);
    }
    const { apiKey: linearApiKey, connectionId: resolvedId } = resolved;

    try {
      const teams = await fetchLinearTeamStates(linearApiKey, resolvedId);
      if (teams.length === 0) {
        return c.json({ error: "Failed to fetch Linear workflow states" }, 502);
      }
      return c.json({ teams });
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : "Linear request failed" }, 502);
    }
  });

  // ─── Linear projects ────────────────────────────────────────────────

  api.get("/linear/projects", async (c) => {
    const connectionId = c.req.query("connectionId") || undefined;
    const resolved = resolveApiKey(connectionId);
    if (!resolved) {
      return c.json({ error: "No Linear connection configured" }, 400);
    }
    const { apiKey: linearApiKey, connectionId: resolvedId } = resolved;

    try {
      const projects = await linearCache.getOrFetch(`${resolvedId}:projects`, 300_000, async () => {
        const response = await fetch("https://api.linear.app/graphql", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: linearApiKey,
          },
          body: JSON.stringify({
            query: `
              query CompanionListProjects {
                projects(first: 50, orderBy: updatedAt) {
                  nodes { id name state }
                }
              }
            `,
          }),
        }).catch((e: unknown) => {
          throw new Error(`Failed to connect to Linear: ${e instanceof Error ? e.message : String(e)}`);
        });

        const json = await response.json().catch(() => ({})) as {
          data?: {
            projects?: { nodes?: Array<{ id?: string; name?: string | null; state?: string | null }> } | null;
          };
          errors?: Array<{ message?: string }>;
        };

        if (!response.ok || (json.errors && json.errors.length > 0)) {
          const firstError = json.errors?.[0]?.message || response.statusText || "Linear request failed";
          throw new Error(firstError);
        }

        return (json.data?.projects?.nodes || []).map((p) => ({
          id: p.id || "",
          name: p.name || "",
          state: p.state || "",
        }));
      });

      return c.json({ projects });
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : "Linear request failed" }, 502);
    }
  });

  // ─── Linear project issues (recent, non-done) ─────────────────────

  api.get("/linear/project-issues", async (c) => {
    const projectId = (c.req.query("projectId") || "").trim();
    const limitRaw = Number(c.req.query("limit") || "15");
    const limit = Math.min(50, Math.max(1, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 15));
    if (!projectId) return c.json({ error: "projectId is required" }, 400);

    const connectionId = c.req.query("connectionId") || undefined;
    const resolved = resolveApiKey(connectionId);
    if (!resolved) {
      return c.json({ error: "No Linear connection configured" }, 400);
    }
    const { apiKey: linearApiKey, connectionId: resolvedId } = resolved;

    try {
      const cacheKey = `${resolvedId}:project-issues:${projectId}:${limit}`;
      const issues = await linearCache.getOrFetch(cacheKey, 60_000, async () => {
        const response = await fetch("https://api.linear.app/graphql", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: linearApiKey,
          },
          body: JSON.stringify({
            query: `
              query CompanionProjectIssues($projectId: ID!, $first: Int!) {
                issues(
                  filter: {
                    project: { id: { eq: $projectId } }
                    state: { type: { nin: ["completed", "cancelled"] } }
                  }
                  orderBy: updatedAt
                  first: $first
                ) {
                  nodes {
                    id
                    identifier
                    title
                    description
                    url
                    priorityLabel
                    state { name type }
                    team { key name }
                    assignee { name }
                    updatedAt
                  }
                }
              }
            `,
            variables: { projectId, first: limit },
          }),
        }).catch((e: unknown) => {
          throw new Error(`Failed to connect to Linear: ${e instanceof Error ? e.message : String(e)}`);
        });

        const json = await response.json().catch(() => ({})) as {
          data?: {
            issues?: {
              nodes?: Array<{
                id: string;
                identifier: string;
                title: string;
                description?: string | null;
                url: string;
                priorityLabel?: string | null;
                state?: { name?: string | null; type?: string | null } | null;
                team?: { key?: string | null; name?: string | null } | null;
                assignee?: { name?: string | null } | null;
                updatedAt?: string | null;
              }>;
            };
          };
          errors?: Array<{ message?: string }>;
        };

        if (!response.ok || (json.errors && json.errors.length > 0)) {
          const firstError = json.errors?.[0]?.message || response.statusText || "Linear request failed";
          throw new Error(firstError);
        }

        return (json.data?.issues?.nodes || []).map((issue) => ({
          id: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          description: issue.description || "",
          url: issue.url,
          priorityLabel: issue.priorityLabel || "",
          stateName: issue.state?.name || "",
          stateType: issue.state?.type || "",
          teamName: issue.team?.name || "",
          teamKey: issue.team?.key || "",
          assigneeName: issue.assignee?.name || "",
          updatedAt: issue.updatedAt || "",
        }))
          .filter((issue) => linearIssueStateCategory(issue) !== 2)
          .sort((a, b) => linearIssueStateCategory(a) - linearIssueStateCategory(b));
      });

      return c.json({ issues });
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : "Linear request failed" }, 502);
    }
  });

  // ─── Linear project mappings ──────────────────────────────────────

  api.get("/linear/project-mappings", (c) => {
    const repoRoot = c.req.query("repoRoot");
    if (repoRoot) {
      const mapping = linearProjectManager.getMapping(repoRoot);
      return c.json({ mapping: mapping || null });
    }
    return c.json({ mappings: linearProjectManager.listMappings() });
  });

  api.put("/linear/project-mappings", async (c) => {
    const body = await c.req.json().catch(() => ({})) as {
      repoRoot?: string;
      projectId?: string;
      projectName?: string;
    };
    if (!body.repoRoot || !body.projectId || !body.projectName) {
      return c.json({ error: "repoRoot, projectId, and projectName are required" }, 400);
    }
    const mapping = linearProjectManager.upsertMapping(body.repoRoot, {
      projectId: body.projectId,
      projectName: body.projectName,
    });
    return c.json({ mapping });
  });

  api.delete("/linear/project-mappings", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { repoRoot?: string };
    if (!body.repoRoot) return c.json({ error: "repoRoot is required" }, 400);
    const removed = linearProjectManager.removeMapping(body.repoRoot);
    if (!removed) return c.json({ error: "Mapping not found" }, 404);
    return c.json({ ok: true });
  });

  api.post("/linear/issues/:id/transition", async (c) => {
    const issueId = c.req.param("id");
    if (!issueId) {
      return c.json({ error: "Issue ID is required" }, 400);
    }

    const reqConnectionId = c.req.query("connectionId") || undefined;
    const resolved = resolveApiKey(reqConnectionId);
    if (!resolved) {
      return c.json({ error: "No Linear connection configured" }, 400);
    }
    const { apiKey: linearApiKey, connectionId: resolvedConnId } = resolved;

    // Check auto-transition setting: prefer connection-level, fall back to global settings
    const conn = resolvedConnId !== "legacy" ? getConnection(resolvedConnId) : null;
    const autoTransitionEnabled = conn ? conn.autoTransition : getSettings().linearAutoTransition;
    const autoTransitionStateId = conn ? conn.autoTransitionStateId : getSettings().linearAutoTransitionStateId;

    if (!autoTransitionEnabled) {
      return c.json({ ok: true, skipped: true, reason: "auto_transition_disabled" });
    }

    const stateId = autoTransitionStateId.trim();
    if (!stateId) {
      return c.json({ ok: true, skipped: true, reason: "no_target_state_configured" });
    }

    const result = await transitionLinearIssue(issueId, stateId, linearApiKey, resolvedConnId);
    if (!result.ok) {
      return c.json({ error: result.error }, 502);
    }

    return c.json({
      ok: true,
      skipped: false,
      issue: result.issue,
    });
  });

}
