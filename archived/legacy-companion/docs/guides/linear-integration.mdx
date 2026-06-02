---
title: Linear Integration
description: Connect Linear for issue-driven development workflows
---

# Linear Integration

The Companion integrates with [Linear](https://linear.app) to let you search issues, create new ones, link them to sessions, and automatically transition issue status as you work.

## Setup

1. Navigate to **Integrations** in the sidebar, then click **Linear Settings**
2. Enter your **Linear API key** (starts with `lin_api_`)
   - Get one from [Linear Settings > API](https://linear.app/settings/api)
3. Click **Verify** to test the connection
4. On success, you'll see your name, email, and connected workspace

## Search and browse issues

On the **Home page**, the Linear section lets you:

- **Search issues**: Type an issue key (e.g., `ENG-123`) or title to find issues across your workspace. Results exclude completed issues and are sorted with active issues first.
- **Browse project issues**: If you've attached a Linear project to the current repository, recent issues from that project are shown automatically.

Toggle between project-scoped and global search with the search button.

## Create issues

Click **Create Issue** on the Home page to create a new Linear issue:

| Field | Description |
|---|---|
| **Title** | Issue title (required) |
| **Description** | Markdown description |
| **Team** | Which Linear team to assign to (required) |
| **Priority** | None, Urgent, High, Medium, or Low |
| **Assign to me** | Self-assign the issue |

If you have a project attached to the current repo, the issue is automatically added to that project.

## Link issues to sessions

1. On the Home page, search for or create an issue
2. Select the issue — it appears as a **Context** badge
3. Create the session — the issue details (identifier, title, state, description, labels, assignees, URL) are prepended to your first message as context
4. The **branch name** is auto-populated from the issue (e.g., `ENG-123` + "Fix auth flow" becomes `eng-123-fix-auth-flow`)

You can also link or unlink issues after a session is created.

## Auto-transition

Automatically move a linked issue to a specific status when a session starts.

### Configure

1. Go to **Linear Settings**
2. Toggle **Auto-transition** on
3. Select the **team** (if you have multiple teams)
4. Choose the **target status** from the team's workflow states (e.g., "In Progress")

Every time you create a session with a linked Linear issue, the issue automatically moves to the configured status.

## Archive transition

When you archive a session that has a linked Linear issue (and the issue isn't already "done"), a modal asks what to do:

- **Keep current status**: Leave the issue as-is
- **Move to backlog**: Transition to the team's backlog state
- **Move to configured status**: Transition to a status you've pre-configured in settings

### Configure archive transition

1. Go to **Linear Settings**
2. Toggle **Archive transition** on
3. Select the target status for archived sessions

## Project-repo mapping

Associate git repositories with Linear projects so that project-scoped issue search works automatically:

1. On the Home page, click the **attach project** icon in the Linear section
2. Select a Linear project from the dropdown
3. The mapping is saved — when you open the Home page in that repo, project issues are shown automatically

Mappings are stored in `~/.companion/linear-projects.json`.

## Rate limiting

Linear has a 5,000 requests/hour rate limit. The Companion manages this with built-in caching:

| Data | Cache TTL |
|---|---|
| Connection info | 5 minutes |
| Workflow states | 5 minutes |
| Issue searches | 30 seconds |
| Project issues | 60 seconds |
| Projects list | 5 minutes |

Concurrent duplicate requests are deduplicated to a single API call.
