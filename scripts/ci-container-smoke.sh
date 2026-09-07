#!/usr/bin/env bash
set -euo pipefail

for image in companion-release:ci companion-api:ci companion-worker:ci companion-web:ci; do
  test "$(docker image inspect --format '{{.Config.User}}' "$image")" = "node"
done
docker run --rm companion-release:ci test -f dist/runtime-role-grants.sql

assert_container_env_unset() {
  local container_id="$1"
  local variable_name="$2"
  local process_name="$3"
  if docker exec "$container_id" printenv "$variable_name" >/dev/null 2>&1; then
    echo "$process_name container must not receive $variable_name" >&2
    exit 1
  fi
}

: "${DATABASE_MIGRATION_URL:?DATABASE_MIGRATION_URL is required}"
: "${DATABASE_API_URL:?DATABASE_API_URL is required}"
: "${DATABASE_WORKER_URL:?DATABASE_WORKER_URL is required}"

network_args=(--network host)
api_publish_args=()
web_publish_args=()
container_migration_url="$DATABASE_MIGRATION_URL"
container_api_url="$DATABASE_API_URL"
container_worker_url="$DATABASE_WORKER_URL"
if [ "$(uname -s)" = "Darwin" ]; then
  network_args=(--add-host host.docker.internal:host-gateway)
  api_publish_args=(-p 18082:18082)
  web_publish_args=(-p 18080:18080)
  container_migration_url="${container_migration_url/127.0.0.1/host.docker.internal}"
  container_api_url="${container_api_url/127.0.0.1/host.docker.internal}"
  container_worker_url="${container_worker_url/127.0.0.1/host.docker.internal}"
fi

runtime_role_args=(
  -e "DATABASE_API_ROLE=${DATABASE_API_ROLE:-companion_api}"
  -e "DATABASE_WORKER_ROLE=${DATABASE_WORKER_ROLE:-companion_worker}"
  -e "DATABASE_COMPANION_RUNTIME_ROLE=${DATABASE_COMPANION_RUNTIME_ROLE:-companion_runtime_v2}"
)

# The one-shot release entrypoints must execute, not merely re-export. A bundler that splits them
# into a shared chunk leaves `node dist/migrate.js` exiting 0 without applying anything, which
# Railway reports as a successful deploy onto an unmigrated database.
if docker run --rm companion-release:ci node dist/migrate.js; then
  echo "dist/migrate.js exited 0 without a database URL; the entrypoint did not run" >&2
  exit 1
fi
if docker run --rm companion-release:ci node dist/cutover.js; then
  echo "dist/cutover.js exited 0 without a command; the entrypoint did not run" >&2
  exit 1
fi

docker run --rm "${network_args[@]}" \
  -e DATABASE_MIGRATION_URL="$container_migration_url" \
  "${runtime_role_args[@]}" \
  companion-release:ci node dist/migrate.js

docker run --rm "${network_args[@]}" postgres:17-alpine \
  psql "$container_migration_url" -v ON_ERROR_STOP=1 -tAc \
  'select count(*) from drizzle.__drizzle_migrations' | grep -qE '^[1-9][0-9]*$'

worker_id="$(docker run -d "${network_args[@]}" \
  -e COMPANION_BILLING_MODE=off \
  -e DATABASE_URL="$container_worker_url" \
  companion-worker:ci)"
api_id=""
web_id=""
cleanup() {
  docker rm -f "$web_id" "$api_id" "$worker_id" >/dev/null 2>&1 || true
}
trap cleanup EXIT

for _ in $(seq 1 20); do
  if [ "$(docker inspect --format '{{.State.Running}}' "$worker_id")" = "true" ]; then
    break
  fi
  sleep 0.25
done
test "$(docker inspect --format '{{.State.Running}}' "$worker_id")" = "true"

sleep 2
test "$(docker inspect --format '{{.State.Running}}' "$worker_id")" = "true"

# Exercise the self-host package lifecycle with only the restricted API credential. `start` must
# launch the HTTP server directly; schema ownership remains in the completed release container.
api_id="$(docker run -d "${network_args[@]}" "${api_publish_args[@]}" \
  -e PORT=18082 \
  -e COMPANION_API_HOST=0.0.0.0 \
  -e DATABASE_URL="$container_api_url" \
  -e COMPANION_WEB_URL=http://127.0.0.1:18080 \
  -e COMPANION_API_URL=http://127.0.0.1:18080 \
  -e BETTER_AUTH_URL=http://127.0.0.1:18080 \
  -e BETTER_AUTH_SECRET=ci-railway-smoke-better-auth-secret-with-enough-entropy \
  -e EMAIL_PROVIDER=log \
  companion-api:ci npm start)"

for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:18082/health >/dev/null; then
    break
  fi
  sleep 0.5
done
curl -fsS http://127.0.0.1:18082/health
assert_container_env_unset "$api_id" COMPANION_RUNTIME_PRIVATE_URL API
assert_container_env_unset "$api_id" COMPANION_BOX_API_KEY API
assert_container_env_unset "$api_id" DATABASE_COMPANION_RUNTIME_URL API
assert_container_env_unset "$api_id" DATABASE_MIGRATION_URL API
assert_container_env_unset "$worker_id" COMPANION_BOX_API_KEY worker
assert_container_env_unset "$worker_id" DATABASE_COMPANION_RUNTIME_URL worker
assert_container_env_unset "$worker_id" COMPANION_RUNTIME_PRIVATE_URL worker
assert_container_env_unset "$worker_id" COMPANION_RUNTIME_DESKTOP_HMAC_SECRET worker
assert_container_env_unset "$worker_id" COMPANION_SECRETS_MASTER_KEY worker

web_id="$(docker run -d "${network_args[@]}" "${web_publish_args[@]}" \
  -e PORT=18080 \
  -e HOSTNAME=0.0.0.0 \
  companion-web:ci)"

for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:18080/login >/dev/null; then
    break
  fi
  sleep 0.5
done
curl -fsS http://127.0.0.1:18080/login >/dev/null
assert_container_env_unset "$web_id" COMPANION_BOX_API_KEY web
assert_container_env_unset "$web_id" DATABASE_COMPANION_RUNTIME_URL web
assert_container_env_unset "$web_id" COMPANION_RUNTIME_PRIVATE_URL web
assert_container_env_unset "$web_id" COMPANION_RUNTIME_DESKTOP_HMAC_SECRET web
