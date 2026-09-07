# Contributing to Companion

Companion is pre-MVP. Start with `docs/vision.md`, `docs/product.md`, `docs/design.md`, `docs/PRD.md`, and
the repository guidance in `CLAUDE.md`. `docs/design.md` is authoritative for architecture and
`docs/testing.md` defines what a valuable test protects.

## Local setup

```bash
corepack enable
pnpm install
pnpm ci:quality
pnpm build
```

Changes to tenant boundaries, skills, labels, secrets, or RLS must also pass the disposable Postgres suite:

```bash
pnpm compose:up
pnpm db:migrate
DATABASE_URL=postgres://companion:companion@127.0.0.1:5432/companion pnpm test:integration
```

Frontend changes require `pnpm browser:smoke` and a manual browser check as described in `CLAUDE.md`.

## GitHub automation

- `CI` validates pull requests, `main` pushes, and merge-queue commits. Its risk classifier skips
  expensive jobs when a change cannot affect them.
## Pull requests

- Keep a pull request focused on one outcome.
- Use a Commitizen title such as `feat(skills): add dependency status` or
  `perf(ci): parallelize risk-based quality gates`.
- Add a behavior-level regression test for bug fixes.
- Update `docs/design.md` when architecture, RBAC, the data model, or integrations changes.
- Never commit credentials, `.env` files, production data, or plaintext secret values.

All required checks must pass before a pull request enters the merge queue.
