# Contributor guidance

Companion is a self-hostable, multi-tenant Skills Hub. Read `docs/vision.md`, `docs/product.md`,
`docs/design.md`, `docs/PRD.md`, and `docs/testing.md` before non-trivial changes. Frontend work
follows root `DESIGN.md`.

## Product and architecture

- Organization → User; organization roles are Owner, Admin, Developer.
- Skills use personal or org scope. Personal skills are creator-only with no admin override.
  Every member can manage organization skills. Share is the sole owner-only personal → org transition.
- Organization and personal label trees organize skills without changing access.
- External coding agents are delegated Skills Hub clients. Companion never launches them.
- Hosted Companions, Box/Pi, chat, routines, triggers, plugin accounts, and native chat clients are retired.
- Complete authorized workflows end to end. Do not ask users to configure integrations manually
  when Companion can do that with credentials it already holds.
- TypeScript, pnpm workspaces, Turborepo, Drizzle, tRPC/REST, Better Auth, S3-compatible storage.
- `packages/db/src/schema.ts` is the data source of truth. Scope every tenant row/query by org_id.
  RLS is defense in depth. `packages/core` has no Next.js dependency; contracts live in `packages/contracts`.
- Secrets are envelope-encrypted, write-only, referenced by id, and never logged as plaintext.
- Never execute skill package scripts on the control plane. Archives and transfer tickets fail closed.
- Public releases pin exact immutable versions and checksums. GitHub sync and database cleanup are idempotent.
- Keep architecture, product docs, and the bundled Companion skill aligned with behavior.

## Development and completion

Use `.conductor/settings.toml`. Setup installs PostgreSQL 17 and lsof, plus optional local MinIO
and Mailpit, then runs `corepack enable && pnpm install`. Run starts per-workspace PostgreSQL,
optional storage/mail, API, worker, and web. Ports derive from CONDUCTOR_PORT: web +0, API +1,
PostgreSQL +2, MinIO +3/+4, SMTP +5, Mailpit +6. Internal services bind loopback.

Follow `docs/testing.md`. Authorization tests cover non-members, cross-tenant access, revocation,
and personal privacy. Run `pnpm verify:change`; exit 2 means its printed gates remain required.
Frontend changes require `APP_URL=http://127.0.0.1:<port> pnpm browser:smoke` and manual agent-browser checks.
Changes under `packages/companion-skill/skill/` require a version bump, top changelog entry, and
`pnpm --filter @companion/companion-skill update:integrity`.
Before adding a CI workflow, job, required check, or trigger, obtain explicit repository-owner approval.
Apple Quality retains only the Darwin-specific bundled skill guards. Never install or invoke XcodeBuildMCP in CI.
PR titles use Commitizen style, for example `feat(skills): add package validation`.

## Agent references

Issues live in Linear, project Companions; confirm the team with the user on first write.
Use LINEAR_TVC_API_KEY, falling back to LINEAR_API_KEY. See `docs/agents/issue-tracker.md`.
Triage labels: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix;
see `docs/agents/triage-labels.md`. Domain context lives in root CONTEXT.md and docs/adr/;
see `docs/agents/domain.md`.
