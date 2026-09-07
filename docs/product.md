# Companion product

Companion is a Skills Hub organized as **Organization → User**. Organization roles are Owner,
Admin, and Developer. Members manage portable skills through the web and CLI; external coding
agents use exact-workspace delegated capabilities. Personal skills have no admin override.

## Libraries and ownership

- `org`: flat organization-wide library. Every member can read and manage its skills.
- `personal`: private **My Skills** library. Only `creator_id` can read or manage the skill; admins
  have no override.
- A slug is unique across both scopes in an organization.
- **Share** is the sole, owner-only, one-way `personal → org` transition.
- **Installed** is a view: a member's personal skills plus org skills with a `skill_installs` row.

Organization labels form a shared tree. Personal labels form a private per-member tree. Labels are
slash-separated, multi-assigned, and may exist without skills.

## Core journeys

1. Create or upload a package; validate archive safety, `SKILL.md`, manifest, dependencies, secrets,
   and database declarations.
2. Publish an immutable version and review its files, history, dependency graph, comments, and
   activity.
3. Share a personal skill to the organization with its required private dependency closure.
4. Install or update a skill into supported external coding tools and report the installed version.
5. Publish one pinned organization version as a checksum-addressed public release.
6. Mirror organization skills to GitHub deterministically.
7. Let an approved external coding agent read/write skills, use Skill Databases, or retrieve bound
   secrets through constrained grants.
