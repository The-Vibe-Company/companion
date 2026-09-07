#!/usr/bin/env bash
set -euo pipefail

# Keep local development convenient without making the repo-root .env a shared
# trust boundary. Every child receives only the credentials needed by its
# process role; retired Box/Pi provider settings are discarded.

role="${1:-}"
if [ -z "$role" ] || [ "$#" -lt 2 ]; then
  printf 'Usage: %s <api|api-seed|worker|web|migration> <command> [args...]\n' "$0" >&2
  exit 64
fi
shift

unset_box_and_pi_env() {
  local name
  for name in $(compgen -v); do
    case "$name" in
      COMPANION_BOX_*|COMPANION_PI_*) unset "$name" ;;
    esac
  done
}

unset_database_env() {
  unset DATABASE_URL DATABASE_API_URL DATABASE_WORKER_URL DATABASE_MIGRATION_URL \
    DATABASE_COMPANION_RUNTIME_URL
  unset DATABASE_API_ROLE DATABASE_WORKER_ROLE DATABASE_COMPANION_RUNTIME_ROLE
}

# The repository-root .env belongs to the launcher, not to every child. Treat every application
# namespace as private by default and retain only the settings owned by the selected process. Shell,
# package-manager and terminal variables remain untouched. Provider keys such as OPENAI_API_KEY or
# ZAI_API_KEY match the explicit provider namespace or the credential-shape fallback and are removed:
# provider credentials enter the runtime through encrypted PostgreSQL material, never a shared env.
scrub_application_env() {
  local process_role="$1"
  local name
  for name in $(compgen -v); do
    case "$name" in
      COMPANION_*|DATABASE_*|BETTER_AUTH_*|S3_*|STRIPE_*|GITHUB_APP_*|GOOGLE_*|RESEND_*|EMAIL_*|MAILPIT_*|BOX_SIM_*|BOX_LAB_*|PI_SIM_*|NEXT_PUBLIC_*|OPENAI_*|ANTHROPIC_*|ZAI_*|AWS_*|*_API_KEY|*_CLIENT_SECRET|*_MASTER_KEY|*_PRIVATE_KEY|*_PASSWORD|*_TOKEN|*_WEBHOOK_SECRET|*_ACCESS_KEY_ID|*_ACCESS_KEY)
        case "$process_role:$name" in
          api:DATABASE_URL|api:COMPANION_DATABASE_POOL_MAX|api:COMPANION_API_HOST|api:COMPANION_API_PORT|api:COMPANION_API_URL|api:COMPANION_WEB_URL|api:COMPANION_SECRETS_MASTER_KEY|api:COMPANION_AUTH_MODE|api:COMPANION_BILLING_MODE|api:COMPANION_ENTITLEMENTS_MODE|api:COMPANION_ENTITLEMENT_PILOT_ORGS|api:COMPANION_PRO_ORG_ALLOWLIST|api:COMPANION_CHECKOUT_ENABLED|api:COMPANION_STRIPE_WEBHOOKS_ENABLED|api:COMPANION_GITHUB_SYNC_ENABLED|api:COMPANION_GITHUB_APP_MANAGED|api:COMPANION_SKILL_DATABASES_ENABLED|api:COMPANION_SKILL_DB_*|api:COMPANION_REQUIRE_VERIFIED_DOMAIN_JOIN|api:BETTER_AUTH_*|api:S3_*|api:STRIPE_*|api:GITHUB_APP_SLUG|api:GITHUB_APP_CLIENT_ID|api:GITHUB_APP_CLIENT_SECRET|api:GITHUB_APP_NAME|api:GOOGLE_*|api:RESEND_API_KEY|api:EMAIL_*|api:MAILPIT_SMTP_*) ;;
          api-seed:DATABASE_URL|api-seed:COMPANION_DATABASE_POOL_MAX|api-seed:COMPANION_ALLOW_TEST_USER_SEED|api-seed:COMPANION_SEED_EMAIL|api-seed:COMPANION_SEED_NAME|api-seed:COMPANION_SEED_PASSWORD|api-seed:S3_*) ;;
          worker:DATABASE_URL|worker:COMPANION_DATABASE_POOL_MAX|worker:COMPANION_WEB_URL64|worker:COMPANION_GITHUB_SYNC_ENABLED|worker:COMPANION_GITHUB_APP_MANAGED|worker:COMPANION_SKILL_DATABASES_ENABLED|worker:COMPANION_SKILL_DB_*|worker:COMPANION_BILLING_MODE|worker:COMPANION_ENTITLEMENTS_MODE|worker:COMPANION_ENTITLEMENT_PILOT_ORGS|worker:COMPANION_PRO_ORG_ALLOWLIST|worker:COMPANION_CHECKOUT_ENABLED|worker:COMPANION_STRIPE_WEBHOOKS_ENABLED|worker:S3_*|worker:STRIPE_*|worker:GITHUB_APP_ID|worker:GITHUB_APP_SLUG|worker:GITHUB_APP_PRIVATE_KEY|worker:GITHUB_APP_NAME) ;;
          web:COMPANION_API_URL|web:COMPANION_WEB_URL|web:NEXT_PUBLIC_*) ;;
          migration:DATABASE_URL|migration:DATABASE_MIGRATION_URL|migration:DATABASE_API_ROLE|migration:DATABASE_WORKER_ROLE|migration:DATABASE_COMPANION_RUNTIME_ROLE|migration:DATABASE_RETIRED_RUNTIME_ROLE|migration:DATABASE_RUNTIME_ROLE|migration:COMPANION_MIGRATIONS_DIR|migration:COMPANION_MIGRATION_LOCK_TIMEOUT_MS|migration:COMPANION_RUNTIME_GRANTS_FILE|migration:S3_*) ;;
          *) unset "$name" ;;
        esac
        ;;
    esac
  done
}

case "$role" in
  api|api-seed)
    unset_box_and_pi_env
    unset DATABASE_API_URL DATABASE_WORKER_URL DATABASE_MIGRATION_URL \
      DATABASE_COMPANION_RUNTIME_URL
    unset DATABASE_WORKER_ROLE DATABASE_COMPANION_RUNTIME_ROLE
    unset BOX_SIM_API_KEY BOX_SIM_CONTROL_TOKEN
    ;;
  worker)
    unset_box_and_pi_env
    if [ -n "${DATABASE_WORKER_URL:-}" ]; then
      export DATABASE_URL="$DATABASE_WORKER_URL"
    fi
    unset DATABASE_API_URL DATABASE_WORKER_URL DATABASE_MIGRATION_URL \
      DATABASE_COMPANION_RUNTIME_URL
    unset DATABASE_API_ROLE DATABASE_COMPANION_RUNTIME_ROLE
    unset COMPANION_RUNTIME_PRIVATE_URL COMPANION_RUNTIME_DESKTOP_HMAC_SECRET
    unset BOX_SIM_API_KEY BOX_SIM_CONTROL_TOKEN
    ;;
  web)
    unset_box_and_pi_env
    unset_database_env
    unset COMPANION_RUNTIME_PRIVATE_URL COMPANION_RUNTIME_DESKTOP_HMAC_SECRET
    unset COMPANION_SECRETS_MASTER_KEY BETTER_AUTH_SECRET GOOGLE_CLIENT_SECRET \
      RESEND_API_KEY S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY
    unset BOX_SIM_API_KEY BOX_SIM_CONTROL_TOKEN
    ;;
  migration)
    unset_box_and_pi_env
    if [ -n "${DATABASE_MIGRATION_URL:-}" ]; then
      export DATABASE_URL="$DATABASE_MIGRATION_URL"
    fi
    unset DATABASE_API_URL DATABASE_WORKER_URL DATABASE_COMPANION_RUNTIME_URL
    unset COMPANION_RUNTIME_PRIVATE_URL COMPANION_RUNTIME_DESKTOP_HMAC_SECRET
    unset BOX_SIM_API_KEY BOX_SIM_CONTROL_TOKEN
    ;;
  *)
    printf 'Unknown development process role: %s\n' "$role" >&2
    exit 64
    ;;
esac

scrub_application_env "$role"

exec "$@"
