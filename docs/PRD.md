# Companion requirements

Companion provides a self-hostable Skills Hub for members and external coding agents.

## Skills Hub requirements

### Identity and tenancy

- Better Auth, organizations, memberships, Owner/Admin/Developer RBAC, invitations, and
  tenant-scoped queries.
- Billing changes for runtime capacity are outside this program; existing Skills Hub entitlements
  remain unchanged.

### Skill lifecycle

- Personal and organization libraries with workspace-unique slugs.
- Safe ZIP upload, browser authoring, manifest validation, immutable versions, archive/restore,
  rename, and one-way Share.
- Dependencies, labels, comments, Activity, install/update reporting, and local inventory.
- Pinned public releases and safe package downloads for verified sessions, approved Agent Auth
  tickets, and exact `public-skills:install` PATs.
- GitHub App synchronization and REST/CLI workflows.

### Skill capabilities

- Write-only skill secrets with audience/recipient controls, stable bindings, redaction, preflight,
  and one-time redemption grants.
- Declared hosted Skill Databases with organization and personal realms, additive schemas,
  parameterized statements, and explicit personal-realm shares.
- Delegated Agent Auth limited to skills, Skill Databases, public installs, and skill secrets.
  Connected clients are external consumers, never hosted Companions.
- Short-lived child PATs inherit only the server-computed active exact-workspace Agent Auth grant
  snapshot; callers cannot choose broader scopes or organizations.

## Acceptance

Validate tenant isolation, personal-skill privacy, safe archives, exact-version releases, secret
grant replay prevention, Agent Auth scope constraints, and Skill Database serialization. Run
`pnpm verify:change` and complete its applicable follow-up gates before shipping.
