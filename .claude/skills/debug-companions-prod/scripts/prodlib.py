#!/usr/bin/env python3
"""Shared helpers for the debug-companions-prod operator skill.

Read-only production debugging support. This module owns the three safety
contracts every script in this skill relies on:

- credentials come from the process environment first, with
  ``~/.companion-prod.env`` as an optional local fallback whose mode must be
  0600 when present;
- ``redact()`` is applied to every output path, so tokens, signed URLs, and
  database credentials cannot leak into a transcript;
- secrets are passed to subprocesses via the environment, never argv.

Standard library only. Python 3.9+.
"""

from __future__ import annotations

import json
import os
import re
import stat
import sys
import time
import urllib.error
import urllib.request

ENV_FILE = os.path.expanduser("~/.companion-prod.env")

DEFAULTS = {
    "COMPANION_BOX_API_BASE": "https://ascii.dev/api/box/v1",
}

KNOWN_KEYS = (
    "RAILWAY_API_TOKEN",
    "RAILWAY_PROJECT_ID",
    "RAILWAY_ENVIRONMENT_ID",
    "COMPANION_BOX_API_BASE",
    "COMPANION_BOX_API_KEY",
    "PROD_DATABASE_READ_URL",
    "DEBUG_PROD_ALLOW_RESTART",
)

# Mirrors companion_runtime_instances_box_id_check in packages/db/src/schema.ts.
BOX_ID_RE = re.compile(r"^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$")
UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
)
SINCE_RE = re.compile(r"^(\d+)\s*([smhd])$")


class ProdToolError(Exception):
    """A safe, already-redactable operator-facing failure."""


def fail(message: str, code: int = 2) -> None:
    """Print a redacted error and exit. Exit 2 is the refusal/configuration code."""
    print(redact(f"error: {message}"), file=sys.stderr)
    raise SystemExit(code)


# --- redaction ------------------------------------------------------------
# The contract is documented in references/redaction.md. Order matters:
# structured shapes first, then broad entropy heuristics.

_SENSITIVE_HEADER = re.compile(r"\b(authorization|cookie|x-api-key)\s*:\s*[^\r\n]*", re.IGNORECASE)
_DB_URL_CREDS = re.compile(r"\b(postgres(?:ql)?://)[^\s/@:]+:[^\s@]+@", re.IGNORECASE)
_SIGNED_QUERY = re.compile(
    r"([?&](?:X-Amz-[A-Za-z-]+|sig|signature|token|access_token|api_key|apikey|key)=)"
    r"[^&\s\"'<>]+",
    re.IGNORECASE,
)
_JWT = re.compile(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b")
_BEARER = re.compile(r"\bbearer\s+[A-Za-z0-9._~+/=-]{4,}", re.IGNORECASE)
_SECRET_ASSIGNMENT = re.compile(
    r"\b(access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret|private[_-]?key"
    r"|token|secret|password|passwd|credential)(\"?'?\s*[:=]\s*)"
    r"(\"(?:\\.|[^\"\\])*\"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)",
    re.IGNORECASE,
)
_CREDENTIAL_SHAPE = re.compile(
    r"\b(?:sk|ghp|gho|github_pat|xox[baprs]|cmp_pat|railway)[-_][A-Za-z0-9_-]{8,}\b",
)
_LONG_HEX = re.compile(r"\b[0-9a-fA-F]{40,}\b")
_BASE64_CANDIDATE = re.compile(r"\b[A-Za-z0-9+/=_-]{40,}\b")


def _redact_base64_candidate(match: "re.Match[str]") -> str:
    """Redact long base64-looking runs, but keep digit-free identifiers.

    Real secrets essentially always mix digits into a 40+ character run, while
    long snake_case identifiers (for example PostgreSQL constraint names) do
    not. Requiring two digits keeps schema names readable in psql errors.
    """
    value = match.group(0)
    if sum(ch.isdigit() for ch in value) >= 2:
        return "[secret redacted]"
    return value


def redact(text: str) -> str:
    """Strip credentials and signed material from any operator-facing string."""
    if not isinstance(text, str):
        text = str(text)
    text = _SENSITIVE_HEADER.sub(lambda m: f"{m.group(1)}: [redacted]", text)
    text = _DB_URL_CREDS.sub(lambda m: f"{m.group(1)}[redacted]@", text)
    text = _SIGNED_QUERY.sub(lambda m: f"{m.group(1)}[redacted]", text)
    text = _JWT.sub("[token redacted]", text)
    text = _BEARER.sub("Bearer [redacted]", text)
    text = _SECRET_ASSIGNMENT.sub(lambda m: f"{m.group(1)}{m.group(2)}[redacted]", text)
    text = _CREDENTIAL_SHAPE.sub("[credential redacted]", text)
    text = _LONG_HEX.sub("[hex redacted]", text)
    text = _BASE64_CANDIDATE.sub(_redact_base64_candidate, text)
    return text


def print_redacted(text: str = "") -> None:
    print(redact(text))


def print_json(data: object) -> None:
    print(redact(json.dumps(data, indent=2, sort_keys=True, default=str)))


# --- credentials ----------------------------------------------------------

def load_env(path: str = ENV_FILE, process_env: dict | None = None) -> dict:
    """Load allowlisted credentials from the environment and optional file.

    Process variables override file values. A present file must still be mode
    0600, so a group- or world-readable credential file is never used. A
    missing file is accepted when at least one allowlisted process variable is
    present; individual scripts then require only the values they consume.
    """
    source_env = os.environ if process_env is None else process_env
    process_values = {key: source_env[key] for key in KNOWN_KEYS if key in source_env}
    env = dict(DEFAULTS)
    try:
        info = os.stat(path)
    except FileNotFoundError:
        if not process_values:
            fail(
                "Production debug credentials are unavailable. Set the required "
                "allowlisted process variables, or create "
                f"{path} with KEY=VALUE lines and run chmod 600 {path}. "
                "See SKILL.md → Prerequisites.",
            )
    else:
        mode = stat.S_IMODE(info.st_mode)
        if mode != 0o600:
            fail(
                f"{path} has mode {oct(mode)}; it must be exactly 0600. "
                f"Run: chmod 600 {path}",
            )
        with open(path, encoding="utf-8") as handle:
            for line_number, raw_line in enumerate(handle, start=1):
                line = raw_line.strip()
                if not line or line.startswith("#"):
                    continue
                if "=" not in line:
                    fail(f"{path}:{line_number} is not a KEY=VALUE line")
                key, _, value = line.partition("=")
                key = key.strip()
                value = value.strip()
                if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
                    value = value[1:-1]
                if key in KNOWN_KEYS:
                    env[key] = value
    env.update(process_values)
    return env


def require(env: dict, key: str) -> str:
    value = env.get(key, "")
    if not value:
        fail(f"{key} is not set in the process environment or {ENV_FILE}")
    return value


# --- small parsers --------------------------------------------------------

def parse_since(text: str) -> int:
    """Parse a duration such as 30m / 24h / 7d / 90s into seconds."""
    match = SINCE_RE.match(text.strip())
    if not match:
        raise ProdToolError(
            f"invalid --since value {text!r}; use <number><s|m|h|d>, for example 30m or 24h",
        )
    amount = int(match.group(1))
    unit = {"s": 1, "m": 60, "h": 3600, "d": 86400}[match.group(2)]
    return amount * unit


def parse_iso_timestamp(value: str) -> float:
    """Best-effort ISO-8601 → epoch seconds; returns 0.0 when unparseable."""
    from datetime import datetime

    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except (ValueError, AttributeError, TypeError):
        return 0.0


def format_age(seconds: float) -> str:
    seconds = max(0, int(seconds))
    if seconds < 120:
        return f"{seconds}s"
    if seconds < 7200:
        return f"{seconds // 60}m"
    if seconds < 172800:
        return f"{seconds // 3600}h"
    return f"{seconds // 86400}d"


# --- HTTP -----------------------------------------------------------------

RETRYABLE_STATUSES = frozenset({429, 500, 502, 503, 504})


def http_json(
    method: str,
    url: str,
    headers: dict | None = None,
    body: object | None = None,
    timeout: int = 30,
    retries: int = 3,
    backoff: float = 1.0,
    sleep=time.sleep,
    opener=None,
):
    """Perform one JSON HTTP call and return ``(status, parsed_body)``.

    Bounded retries (``retries`` total tries with exponential backoff) apply
    only to GET requests that fail with a network error, 429, or 5xx —
    mutating verbs are never replayed. HTTP error statuses are returned to the
    caller, not raised; only exhausted network failures raise ProdToolError.
    """
    method = method.upper()
    payload = None if body is None else json.dumps(body).encode("utf-8")
    # Railway/Cloudflare and some providers reject the default urllib User-Agent
    # (HTTP 403), so always send an explicit one.
    request_headers = {
        "Accept": "application/json",
        "User-Agent": "companion-debug-prod/1.0",
        **(headers or {}),
    }
    if payload is not None:
        request_headers["Content-Type"] = "application/json"
    open_fn = opener or urllib.request.urlopen
    tries = max(1, retries) if method == "GET" else 1

    last_error: Exception | None = None
    for attempt in range(1, tries + 1):
        request = urllib.request.Request(url, data=payload, headers=request_headers, method=method)
        status: int | None = None
        raw = b""
        try:
            with open_fn(request, timeout=timeout) as response:
                status = getattr(response, "status", None) or getattr(response, "code", 200)
                raw = response.read()
        except urllib.error.HTTPError as error:
            status = error.code
            try:
                raw = error.read()
            except Exception:
                raw = b""
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            last_error = error
            if attempt < tries:
                sleep(backoff * (2 ** (attempt - 1)))
                continue
            raise ProdToolError(
                f"{method} {redact(url)} failed after {tries} tries: {redact(str(error))}",
            ) from None

        if status in RETRYABLE_STATUSES and attempt < tries:
            sleep(backoff * (2 ** (attempt - 1)))
            continue
        try:
            parsed = json.loads(raw.decode("utf-8")) if raw else None
        except (ValueError, UnicodeDecodeError):
            parsed = raw.decode("utf-8", errors="replace")
        return status, parsed

    raise ProdToolError(
        f"{method} {redact(url)} failed after {tries} tries: {redact(str(last_error))}",
    )
