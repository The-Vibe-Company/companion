# Hosted Companion retirement

Companion now provides only the Skills Hub. Hosted Companions, chat, Box/Pi runtime, routines,
triggers, provider/plugin accounts, notifications, and native Apple chat clients are removed.
External coding agents continue to use Agent Auth, the CLI, and the bundled Companion skill.

Migration 0186 deletes runtime-minted PATs, removes the hosted database tables and functions,
and removes the unused organization provider preference. It retains skills, versions, labels,
installs, releases, secrets, Skill Databases, users, organizations, billing, GitHub, Agent Auth,
and queued object deletions. Cleanup of already queued objects remains the worker's responsibility.

The migration fails closed if Companions, runtime Boxes, duplicate-cleanup targets, image records,
or triggers remain. Before upgrading an existing installation, use the previous release to remove
its Companions and external resources, then stop its runtime and worker. Do not bypass the guard or
manually discard ownership rows: they identify the external resources that must be cleaned up.
No production resource or deployed service is modified by this repository change.

Earlier migrations and their historical grant runner remain for upgrade compatibility. Fresh
installs replay them before retirement; post-retirement runs do not regrant the deleted runtime
surface. Never use raw drizzle-kit migrate to bypass those historical checks.
