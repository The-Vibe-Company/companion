# Plan: per-tenant integrations (`tenant_integrations` table) for GSC + GA4

## Context

The previous commit (`b0da6f2`) added platform-level credentials for GSC + GA4 — service-account JSON, encrypted, superadmin-managed. But these credentials can't actually be *used* end-to-end yet, because every collector needs two pieces of information:

1. **What account is allowed to make the call** → the platform credential (done).
2. **Which property/site does this tenant care about** → not yet stored anywhere.

Without #2, you can authenticate to Google Search Console but you don't know which `site_url` to query for Tenant Foo, and you can authenticate to GA4 but don't know which `property_id` to pull. This is the per-tenant routing layer.

User-confirmed design (2026-05-13):
- Per-tenant config goes in its own `tenant_integrations` table — NOT on the platform credential and NOT as columns on `tenants`. Same separation we already documented in `docs/memory/project_credentials_architecture.md`.
- UI: a new page `/t/:slug/integrations`, with sidebar entry. Not a section of the global Settings page.
- Test button must do BOTH: validate format at PUT time (400 on bad), and a separate POST `/test` that hits the real Google API combining platform cred + tenant config.
- Permission: `owner / admin / superadmin` (reuse existing `require_tenant_admin` dep). Viewers can read, not edit.

## Data model

New table `tenant_integrations` (NOT encrypted — `site_url` / `property_id` are identifiers, not secrets; encryption would only complicate queries):

```
id                  bigint PK (BIGSERIAL)
tenant_id           bigint NOT NULL FK→tenants(id) ON DELETE CASCADE
kind                text   NOT NULL          -- 'gsc' | 'ga4'
config              jsonb  NOT NULL          -- {"site_url": "..."} or {"property_id": "..."}
enabled             boolean NOT NULL DEFAULT true
last_tested_at      timestamptz NULL
last_test_status    text NULL                -- 'ok' | 'failed'
last_test_error     text NULL
created_at          timestamptz NOT NULL DEFAULT now()
updated_at          timestamptz NOT NULL DEFAULT now()

UNIQUE (tenant_id, kind)
INDEX  (tenant_id)
CHECK  last_test_status IN ('ok','failed') OR last_test_status IS NULL
```

New SQLAlchemy model `TenantIntegration` in `seo_agents/db/models.py`. Distinct from the existing `TenantCredential` model (which is for tenant-scoped OAuth refresh tokens — different lifecycle, encrypted, no `config` payload).

Migration: `alembic/versions/0004_tenant_integrations.py` mirroring the style of `0003_platform_credentials.py` (op.create_table + CheckConstraint + server_default=sa.text("now()")). Also append to `seo_agents/db/schema.sql` if that file is still being maintained.

## Service layer — `seo_agents/services/tenant_integrations.py`

Mirror the structure of `services/credentials.py`:

```python
@dataclass
class IntegrationField:
    name: str
    label: str
    placeholder: str
    # raises ValueError on bad input — called from set_integration()
    validate: Callable[[str], None]

@dataclass
class IntegrationSchema:
    kind: str
    display_name: str
    requires_credential_kind: str    # which CREDENTIAL_SCHEMAS entry this depends on
    fields: list[IntegrationField]

INTEGRATION_SCHEMAS = {
    "gsc": IntegrationSchema(
        kind="gsc", display_name="Google Search Console",
        requires_credential_kind="gsc",
        fields=[IntegrationField(
            "site_url", "Site URL",
            "https://example.com/   or   sc-domain:example.com",
            _validate_site_url)],
    ),
    "ga4": IntegrationSchema(
        kind="ga4", display_name="Google Analytics 4",
        requires_credential_kind="ga4",
        fields=[IntegrationField(
            "property_id", "Property ID",
            "123456789",
            _validate_property_id)],
    ),
}
```

Public functions:
- `schema(kind) -> IntegrationSchema` (raises `UnknownIntegrationKind`)
- `set_integration(db, *, tenant_id, kind, config) -> TenantIntegration` — upserts, runs field-level `validate`, clears `last_test_status` (mirrors `credentials.set_value` behaviour)
- `clear_integration(db, *, tenant_id, kind) -> bool`
- `get_integration(db, *, tenant_id, kind) -> dict | None` — returns the stored `config` or None
- `status(db, *, tenant_id, kind) -> dict` — returns kind, display_name, fields-with-current-values, configured bool, `credential_configured: bool` (cross-references `services.credentials.status`), `last_tested_at`, `last_test_status`, `last_test_error`
- `list_statuses(db, *, tenant_id) -> list[dict]` — all kinds for one tenant
- `test_integration(db, *, tenant_id, kind, timeout=15.0) -> dict`:
  1. Fetch tenant integration config; fail with `"missing site_url"` if absent
  2. Fetch platform credential (`credentials.get_resolved(db, kind=schema.requires_credential_kind)`); fail with `"platform credential not configured"` if SA JSON absent
  3. Call the appropriate per-kind tester (defined locally in this module):
     - **GSC**: `GET https://searchconsole.googleapis.com/webmasters/v3/sites/{url-encoded site_url}` — 200 means the SA can read that specific site, 403/404 means it can't
     - **GA4**: `GET https://analyticsadmin.googleapis.com/v1beta/properties/{property_id}` — 200 means SA has access to that property
  4. Persist `last_test_status` / `last_tested_at` / `last_test_error` on the row
  5. Return `{"ok": bool, "detail": str, "tested_at": iso}`

Reuse `credentials._google_access_token(sa_json, scopes)` for token minting (already exists, no need to duplicate).

Validators:
- `_validate_site_url`: must start with `https://` (URL property) OR `sc-domain:` (domain property — that's a real GSC convention). Reject anything else with a clear message.
- `_validate_property_id`: must be all digits, 8–12 chars. GA4 property IDs are numeric.

## Web router — `seo_agents/web/routers/tenant_integrations.py`

Mounted under existing `/tenants` prefix (or a new prefix — choose whichever keeps `seo_agents/web/main.py` cleanest; matches `routers/users.py` pattern which is tenant-scoped under `/tenants`).

| Method | Path                                                  | Auth                  |
|--------|-------------------------------------------------------|-----------------------|
| GET    | `/tenants/{slug}/integrations`                        | `require_tenant_access` (any role) |
| GET    | `/tenants/{slug}/integrations/{kind}`                 | `require_tenant_access` |
| PUT    | `/tenants/{slug}/integrations/{kind}`                 | `require_tenant_admin` |
| DELETE | `/tenants/{slug}/integrations/{kind}`                 | `require_tenant_admin` |
| POST   | `/tenants/{slug}/integrations/{kind}/test`            | `require_tenant_admin` |

Body for PUT: `{"site_url": "..."}` (gsc) / `{"property_id": "..."}` (ga4). Use a Pydantic model with optional fields and let the service-layer validate per-kind, same pattern as `CredentialPayload`.

Error mapping (same as credentials router):
- `UnknownIntegrationKind` → 404
- `ValueError` (validation) → 400

Register in `seo_agents/web/main.py` next to the credentials router.

## Frontend

New page **`frontend/src/pages/IntegrationsPage.tsx`** (one page, lists both GSC and GA4 cards for the current tenant). UI pattern lifted from `SettingsPage.tsx`'s `CredentialsPanel`:

- Top of card: kind display name + a small chip showing **credential status** (green = platform cred configured, red = "platform credential missing — ask superadmin")
- Form fields per the schema (just one for both kinds in v1)
- Edit / Save / Test / Remove buttons (Test disabled when platform credential is missing)
- Last-tested timestamp + last error

Sidebar entry: add `Integrations` link to the tenant nav (find it next to `members`, mirror its style). Bilingual label needed.

API surface in **`frontend/src/lib/api.ts`**:

```ts
export type IntegrationFieldStatus = {
  name: string; label: string; placeholder: string;
  current_value: string | null;
};

export type IntegrationStatus = {
  kind: "gsc" | "ga4" | string;
  display_name: string;
  fields: IntegrationFieldStatus[];
  configured: boolean;
  credential_configured: boolean;   // is the platform credential present?
  requires_credential_kind: string;
  last_tested_at: string | null;
  last_test_status: "ok" | "failed" | null;
  last_test_error: string | null;
};

export const apiIntegrations = {
  list:  (slug: string)                          => api.get<IntegrationStatus[]>(`/tenants/${slug}/integrations`),
  get:   (slug: string, kind: string)            => api.get<IntegrationStatus>(`/tenants/${slug}/integrations/${kind}`),
  put:   (slug: string, kind: string, body: Record<string, string>) =>
                                                    api.put<IntegrationStatus>(`/tenants/${slug}/integrations/${kind}`, body),
  clear: (slug: string, kind: string)            => api.del<{ kind: string; removed: boolean }>(`/tenants/${slug}/integrations/${kind}`),
  test:  (slug: string, kind: string)            => api.post<CredentialTestResult>(`/tenants/${slug}/integrations/${kind}/test`),
};
```

i18n: new `integrations` section in **`frontend/src/lib/i18n.tsx`** (T_ZH + T_EN) — title, hint, save/test/edit/clear labels, "platform credential missing" warning, "site URL is invalid" / "property ID must be numeric" client-side error messages.

Routing: register `/t/:slug/integrations` in the existing tenant router (wherever `/t/:slug/members` etc. is wired).

## Tests (TDD, Red→Green per Rule 01)

Each test file is written first, run to confirm RED, then implementation lands GREEN.

### Backend
- **`tests/unit/services/test_tenant_integrations.py`** (~15 tests):
  - Schema: gsc + ga4 present, `requires_credential_kind` set, fields advertised
  - `set_integration` round-trip
  - `set_integration` rejects: missing field, malformed site_url, non-numeric property_id
  - `clear_integration` is idempotent
  - `status()` reports `credential_configured` correctly (toggle via monkeypatching env for the platform cred)
  - Update clears `last_test_status`
  - `test_integration` returns failed when platform credential missing (mock `credentials.get_resolved` to return `{}`)
  - `test_integration` returns failed when tenant config missing
  - `test_integration` with both configured: monkeypatch `_google_access_token` and `httpx.get`, assert correct URL + bearer token
  - Verify GSC URL embeds the encoded `site_url`, GA4 URL embeds the `property_id`
- **`tests/unit/web/test_integrations_routes.py`** (~10 tests):
  - 401 no auth
  - 403 for non-member user
  - 200 GET as viewer; 403 PUT as viewer; 200 PUT as owner (use `auth_header` fixture from web conftest + create a viewer user)
  - 404 unknown tenant slug; 404 unknown integration kind
  - PUT round-trip → re-GET shows the value
  - PUT bad payload → 400
  - DELETE → clears
  - POST `/test` records status on the row (monkeypatch the service-layer tester)

### Frontend
- **`frontend/src/lib/api.test.ts`**: extend with ~6 cases for `apiIntegrations.{list,get,put,clear,test}` (fetch-mock pattern already in the file).
- **`frontend/src/lib/i18n.test.tsx`**: assert new `integrations.*` keys exist in both T_ZH and T_EN.
- **`frontend/e2e/integrations.spec.ts`** (new spec): login → navigate to `/t/_pytest_tenant/integrations` → see GSC card → click Edit → fill `https://example.com/` → Save → assert the value persists across reload. (No real Google API call — the test verifies the UI path; the real API call is verified at the unit level.)

## Files to change

**New**:
- `alembic/versions/0004_tenant_integrations.py`
- `seo_agents/services/tenant_integrations.py`
- `seo_agents/web/routers/tenant_integrations.py`
- `tests/unit/services/test_tenant_integrations.py`
- `tests/unit/web/test_integrations_routes.py`
- `frontend/src/pages/IntegrationsPage.tsx`
- `frontend/e2e/integrations.spec.ts`

**Modified**:
- `seo_agents/db/models.py` — add `TenantIntegration`
- `seo_agents/db/schema.sql` (if maintained) — append DDL
- `seo_agents/web/main.py` — register router
- `frontend/src/lib/api.ts` — add `apiIntegrations` + types
- `frontend/src/lib/i18n.tsx` — add `integrations` section (T_ZH + T_EN)
- `frontend/src/lib/i18n.test.tsx` + `frontend/src/lib/api.test.ts` — extend
- Whatever file wires `/t/:slug/*` routes + sidebar (find during impl: likely `frontend/src/App.tsx` or `frontend/src/components/Sidebar.tsx`)

## Verification

1. `SEO_TEST_DATABASE_URL=... make test` — all backend tests pass; the 15+10 new ones included.
2. `SEO_TEST_DATABASE_URL=... make coverage-gate` — backend ≥55%, frontend lib thresholds unchanged. Ideally backend climbs a point or two.
3. `make frontend-test` — vitest 34 → ~40 green.
4. `make frontend-e2e` — Playwright runs login flow + new integrations flow green.
5. Manual smoke (after `make api` + `make frontend`):
   - Log in as `admin@blocksec.com`
   - Visit `/t/phalcon/integrations` → see GSC + GA4 cards
   - Edit GSC, enter `https://blocksec.com/`, Save → source badge flips
   - Click Test → without real SA JSON expect "platform credential not configured" failure; with valid SA JSON expect ok
6. Commit in 3 parts (matches the K-phase pattern of small atomic commits):
   - `feat(db): add tenant_integrations table + model + migration`
   - `feat(integrations): per-tenant GSC/GA4 routing — service + routes + tests`
   - `feat(frontend): /t/:slug/integrations page + sidebar + i18n + e2e`

## Out of scope (not in this plan)

- Wiring the real GSC/GA4 collectors to actually consume these integrations (separate task — currently mock).
- Bing Webmaster / Yandex Metrica etc. (just add new entries to `INTEGRATION_SCHEMAS` later — no schema change needed).
- The per-tenant integration `enabled` toggle UI — model field is included for future use, but the v1 UI doesn't expose it (simpler).

