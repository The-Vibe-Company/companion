# Companion architecture

Companion is a self-hostable Skills Hub.

- `apps/web`: Next.js skill libraries, package detail, secrets, and workspace settings.
- `apps/api`: REST/tRPC authentication, authorization, and domain services.
- `apps/worker`: GitHub mirrors, billing, and Skill Database object cleanup.
- `cli`: external Skills Hub client.
- `packages/contracts`: shared API and package contracts.
- `packages/db`: Drizzle schema, forward migrations, tenant RLS, and role grants.
- `packages/core`: shared authorization and services, without Next.js dependencies.
- `packages/skills`: package parsing, validation, dependencies, and versioning.
- `packages/skilldb`: declared tenant-scoped SQLite state.
- `packages/storage`: S3-compatible archives, releases, images, and database objects.
- `packages/companion-skill`: bundled workflow for delegated external agents.

Every tenant-owned query is scoped by org_id. Forced RLS is defense in depth. Personal skills,
labels, and Skill Database realms remain creator-only with no administrator override.
API and worker use separate NOBYPASSRLS roles; migration ownership is isolated from both.
Historical migrations and their compatibility role-grant support remain replayable.

## Skills Hub

Packages are validated without executing scripts. Publication writes immutable version/file
metadata, dependency edges, secret slots, database declarations, and an audit event. Share performs
the only personal-to-org transition and includes required private dependencies after an explicit
plan. Install records are per member and do not copy skill rows.

Public release promotion pins one exact organization skill version and checksum. Upload/download
transfer tickets are short-lived, purpose-specific, non-replayable where required, and revalidated
at redemption. GitHub sync writes deterministic, digest-verifiable repository state.

Skills may declare bounded SQLite tables. Core validates additive schema evolution and access,
`packages/skilldb` executes parameterized statements, and object storage persists realms with
conditional generation checks. The worker cleans queued database objects only.

## Secrets and delegated Agent Auth

Secret plaintext is accepted only on write or rotation, envelope-encrypted, and never returned by
ordinary CRUD. Skill bindings refer to stable slots. External clients retrieve authorized values
only through preflight and short-lived, non-replayable grants. Logs and audit metadata remain
value-free.

Agent Auth connects external coding agents to the Skills Hub. Tenant capabilities are limited to
skill, Skill Database, and skill-secret operations constrained to one exact workspace;
`public-skills:install` remains instance-wide. Agent Auth never grants Companion chat, provider,
desktop, or lifecycle access.

An Agent Auth child PAT snapshots only active exact-workspace grants, caps expiry at seven days and
the earliest source expiry, and stores value-free provenance. Callers cannot choose scopes or
organizations, PATs cannot mint child PATs, and a target-bound token requires the matching declared
target. Possession remains bearer authority until expiry or revocation.
