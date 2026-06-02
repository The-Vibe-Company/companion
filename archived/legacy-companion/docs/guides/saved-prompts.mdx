---
title: Saved Prompts
description: Create reusable prompts and insert them into sessions with @mentions
---

# Saved Prompts

Saved prompts let you store reusable instructions that can be inserted into any session. Navigate to **Prompts** in the sidebar (or go to `#/prompts`).

## Create a prompt

1. Click **New Prompt**
2. Enter a **name** (e.g., `review-pr`, `fix-tests`, `explain-code`)
3. Write the **prompt content** — the actual instructions the agent will receive
4. Choose a **scope**:
   - **Global**: Available in all sessions regardless of working directory
   - **Project**: Only appears in sessions whose working directory matches one of the associated folders
5. For project-scoped prompts, click **Add Folder** to associate one or more project paths
6. Click **Save**

## Edit and delete

- Click the **pencil icon** on any prompt card to edit its name, content, scope, or associated folders
- Click the **trash icon** to delete a prompt
- Use the **search bar** at the top to filter prompts by name or content

## Scope: global vs project

| Scope | Visible in | Use case |
|---|---|---|
| Global | All sessions | General instructions like "review this PR" or "explain this code" |
| Project | Sessions whose cwd matches an associated folder | Project-specific instructions like "use our ESLint config" or "follow our API conventions" |

A single prompt can be associated with multiple project folders. For example, a "run tests" prompt could be linked to both your frontend and backend repos with different test commands.

## Grouped view

The Prompts page groups prompts by scope:

- **Global** section at the top with all global prompts
- **Per-folder** sections below, one for each unique project path

## Using prompts in sessions

Once you've created prompts, insert them into any session using the `@` mention syntax.

### How to use

1. Open a session and click in the **composer** (message input)
2. Type `@` followed by the prompt name (e.g., `@review-pr`)
3. A **mention menu** appears with matching prompts
4. Select the prompt — its content is inserted inline into your message
5. Press Enter to send

### How filtering works

- The mention menu shows prompts matching your text using fuzzy search on the prompt title
- **Global prompts** always appear
- **Project-scoped prompts** only appear when the session's working directory matches one of the prompt's associated folders

### Example workflow

**1. Create a "review-pr" prompt:**

- **Name**: `review-pr`
- **Content**: `Review this pull request. Check for bugs, security issues, and code style. Suggest improvements. Run the test suite and report any failures.`
- **Scope**: Global

**2. Use it in a session:**

Type `@review-pr` in the composer. It expands to the full prompt content. You can add extra context before sending:

```
@review-pr Focus especially on the authentication changes in auth.ts.
```

**3. Project-specific variant:**

Create another prompt with the same name scoped to your backend project:

- **Name**: `review-pr`
- **Content**: `Review this pull request. Run "bun run test" and "bun run typecheck". Check that all API routes have input validation. Ensure SQL queries use parameterized statements.`
- **Scope**: Project (`/home/user/backend`)

When you're in a session with cwd `/home/user/backend`, the project-scoped version appears first in the mention menu. In other sessions, only the global version appears.

## Storage

Prompts are stored at `~/.companion/prompts.json` as a JSON array. Each prompt has a unique ID, name, content, scope, and timestamps.

## REST API

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/prompts` | List all prompts (optional `?cwd=` and `?scope=` filters) |
| `GET` | `/api/prompts/:id` | Get a single prompt |
| `POST` | `/api/prompts` | Create a prompt |
| `PUT` | `/api/prompts/:id` | Update a prompt |
| `DELETE` | `/api/prompts/:id` | Delete a prompt |
