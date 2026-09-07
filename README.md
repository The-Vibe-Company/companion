# Companion

Companion is a self-hostable Skills Hub for organizations and external coding agents.
Create, validate, version, organize, share, install, and publish portable `SKILL.md` packages.

Personal skills are creator-only; organization skills are shared with every member. Labels organize
libraries without changing access. The web app and CLI provide the same Skills Hub workflows,
including dependencies, comments, immutable public releases, GitHub mirrors, write-only secrets,
and declared tenant-scoped SQLite Skill Databases. External agents connect through delegated Agent Auth.

## Repository

- `apps/web`: Next.js interface.
- `apps/api`: REST/tRPC authorization and Skills Hub APIs.
- `apps/worker`: GitHub sync, billing, and Skill Database object cleanup.
- `cli`: Companion CLI.
- `packages`: shared contracts, domain services, auth, database, packages, storage, and bundled skill.

See [vision](docs/vision.md), [product](docs/product.md), [architecture](docs/design.md),
[requirements](docs/PRD.md), and [testing](docs/testing.md).

## Local development

Requirements: Node.js 20.19+ or 22.12+, pnpm 9, PostgreSQL 17, and optionally MinIO/Mailpit.

```bash
corepack enable
pnpm install
pnpm dev:conductor
```

Conductor starts per-workspace PostgreSQL, optional MinIO/Mailpit, API, worker, and web. It configures
isolated cookies and ports, applies migrations, and seeds the local test user. `.env.example`
documents optional integrations. `pnpm dev` provides the Docker-backed development stack.

## Deployment

Build with `pnpm build`. Run the migration owner entrypoint before starting API, worker, and web
from that build. `pnpm db:migrate` preserves historical migration compatibility, including the
legacy role variables required to replay earlier releases; these do not launch a runtime service.
Use separate NOBYPASSRLS credentials for API and worker. See [Railway deployment](deploy/railway/README.md).

Hosted Companions are retired. Existing installations must clean up external resources using the
previous release before applying the retirement migration; see [retirement](docs/companions-runtime.md).

## Verification

Run `pnpm verify:change` and complete its printed follow-up gates. Frontend changes also require
`APP_URL=http://127.0.0.1:<port> pnpm browser:smoke` and manual browser checks.
