# Redaction contract

Every output path in this skill — stdout, stderr, JSON mode, error messages —
passes through `prodlib.redact()`. The scripts never print credential values,
never place them in argv (visible in `ps`), and pass them to subprocesses only
via the environment (`PGDATABASE` for psql, `Authorization` headers built
in-process for HTTP).

This mirrors the runtime's own rules: persisted runtime errors carry only a
stable code, an expurgated message of at most 500 characters, and an allowed
action; provider payloads, tokens, signed URLs, and raw Pi lines are never
persisted (`packages/companion-runtime/src/credentialRedaction.ts`,
`docs/runbooks/companions-runtime.md` → Safety rules).

## What `redact()` strips

Applied in order:

1. **Sensitive header values** — `Authorization:`, `Cookie:`, `X-Api-Key:`
   lines lose their entire value.
2. **Database URL credentials** — `postgres://user:pass@` and
   `postgresql://user:pass@` become `postgres://[redacted]@`; host, port, and
   database name survive for diagnosis.
3. **Signed query parameters** — every `X-Amz-*` parameter value, plus
   `sig`, `signature`, `token`, `access_token`, `api_key`, `apikey`, and
   `key` parameter values.
4. **JWTs** — `eyJ...` three-segment tokens.
5. **Bearer tokens** — `Bearer <anything>`.
6. **Secret assignments** — `password=...`, `"client_secret": "..."`, and
   similar key/value pairs for token/secret/password/credential-named keys.
7. **Vendor credential shapes** — `sk-`, `ghp_`, `gho_`, `github_pat_`,
   `xox[baprs]-`, `cmp_pat_` (Companion delegation tokens), `railway_`.
8. **Long hex runs** — 40+ hex characters (SHA-1/SHA-256-sized material).
9. **Long base64-like runs containing digits** — 40+ characters of the
   base64/url-safe alphabet with at least two digits. The digit requirement
   deliberately keeps long digit-free identifiers readable (for example
   PostgreSQL constraint names such as
   `companion_decision_deliveries_delivery_check`).

## What deliberately survives

- UUIDs (companion/turn/attempt/operation ids) — diagnostic identifiers.
- Box ids (`bx_` + 8 chars) and generation-qualified Box names.
- Stable error codes, checkpoints, states, timestamps.
- Hostnames and paths of URLs (only credentials and signed parameters are
  removed).

## What the scripts refuse to read at all

- `db_query.py decisions` never selects `response_text` (member content).
- `db_query.py` has no free-SQL mode, so a transcript can never contain an
  ad-hoc `select *` over member data.
- Process credentials are loaded only from the skill's allowlist. The optional
  `~/.companion-prod.env` fallback is refused unless it is mode `0600`, and no
  credential value is ever echoed.

## Rules for the operator

- Do not bypass the scripts with raw `curl -H "Authorization: ..."` or
  `psql postgres://user:pass@...` — both put secrets in argv/transcript.
- If a secret does leak into a transcript, treat it as exposed: follow the
  runbook's "Suspected secret exposure" section (fence claims first, then
  rotate).
