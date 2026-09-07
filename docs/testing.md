# Testing standard

Tests protect observable product promises at the lowest layer that proves them. Mock external
providers and identities, not authorization, persistence, or tenant scoping.

## Required coverage

- Personal skills and database realms stay creator-only, including against same-org administrators.
- All tenant APIs reject non-members, cross-tenant access, and revoked authority.
- Archives and transfers reject unsafe paths, links, oversized files, and checksum substitution.
- Share is owner-only and includes its required private dependency closure atomically.
- Public releases pin one exact version; GitHub mirrors stay deterministic and idempotent.
- Secret grants cannot replay or leak plaintext through ordinary metadata, errors, logs, or audit.
- Agent Auth and child PATs remain exact-workspace and capability constrained.
- Skill Databases preserve additive schemas, serialization, realm privacy, and conditional storage.
- API and worker credentials remain separate NOBYPASSRLS roles.
- Retired hosted Companion routes and tokens cannot access the Skills Hub.

Schema, migration, RLS, and role changes require disposable PostgreSQL integration tests.
Historical migrations remain replayable. Never run test migrations against shared databases.

## Frontend gate

Run the application, then:

```bash
APP_URL=http://127.0.0.1:<port> pnpm browser:smoke
```

Changed Companion paths need focused manual `agent-browser` checks. Verify truthful status,
PostgreSQL-only Viewer reads, queue count, input-needed cards, automatic exact-cleanup status and
no-replay copy, an always-mounted composer, Pi-only Restart confirmation, attachment chips and
inline images inside the message they belong to, a metadata-only expired attachment with no download target, a
routine fire that shows `Routine: <name>` with the prompt hidden in the thread and on the list row,
a context-panel routine create,
an interrupted routine run whose history is passive and does not block the main chat,
and no excluded voice, multi-Bot, harness, deployment, or file-library chrome.

## Change verification

Run `pnpm verify:change`. Exit 2 lists follow-up gates that must still run. Record any external
prerequisite that prevents a required check. Run typechecking, behavior tests, the application build,
and browser checks for affected workflows. Apple Quality runs only the bundled skill's Darwin
private-transport guards; native Companion applications are retired.
