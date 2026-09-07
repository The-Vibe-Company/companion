# Railway deployment

Deploy `api`, `worker`, `web`, and the one-shot `release` service with the supplied configs.
The backend Dockerfile accepts only api, worker, or release. Release runs the migration-owner
entrypoint; API and worker boot directly from the same build after migration succeeds.

API receives its restricted DATABASE_URL, auth, email, object storage, and skill secret encryption
configuration. Worker receives its own restricted DATABASE_URL and only configured GitHub, billing,
and Skill Database cleanup credentials. Web receives the API origin and public client settings.
No service needs Box, Pi, APNs, provider MCP, or desktop-HMAC credentials.

For historical migration replay, release receives DATABASE_MIGRATION_URL, DATABASE_API_ROLE,
DATABASE_WORKER_ROLE, and DATABASE_COMPANION_RUNTIME_ROLE. The last variable identifies only a
legacy compatibility role; no hosted runtime service is deployed. A retired union role may additionally
require DATABASE_RETIRED_RUNTIME_ROLE during historical cutover. See `.env.example`.

An existing hosted installation must complete [external resource retirement](../../docs/companions-runtime.md)
with its previous release before upgrading. Migration 0186 refuses to erase live ownership inventory.
