#!/usr/bin/env python3
"""Tests for prodlib: redaction, env-file refusal, parsing, HTTP retry bounds."""

from __future__ import annotations

import io
import os
import sys
import tempfile
import unittest
import urllib.error

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import prodlib  # noqa: E402


class RedactTest(unittest.TestCase):
    def assert_hidden(self, text: str, secret: str) -> None:
        redacted = prodlib.redact(text)
        self.assertNotIn(secret, redacted, f"secret survived redaction: {redacted!r}")

    def test_bearer_token(self):
        self.assert_hidden(
            "Authorization: Bearer abc123SECRETtoken.value",
            "abc123SECRETtoken",
        )

    def test_postgres_url_credentials(self):
        for scheme in ("postgres", "postgresql"):
            text = f"{scheme}://runtime_user:Sup3rS3cret@db.internal:5432/companion"
            self.assert_hidden(text, "Sup3rS3cret")
            self.assert_hidden(text, "runtime_user:")
            self.assertIn("db.internal:5432/companion", prodlib.redact(text))

    def test_x_amz_signed_params(self):
        url = (
            "https://bucket.s3.amazonaws.com/key?X-Amz-Algorithm=AWS4-HMAC-SHA256"
            "&X-Amz-Credential=AKIA123456%2Fus-east-1&X-Amz-Signature=deadbeef12345678"
        )
        self.assert_hidden(url, "AKIA123456")
        self.assert_hidden(url, "deadbeef12345678")

    def test_sig_token_signature_query_params(self):
        for param in ("sig", "token", "signature", "api_key"):
            self.assert_hidden(f"https://x.test/a?{param}=hunter2secret", "hunter2secret")

    def test_jwt(self):
        jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.sflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV"
        self.assert_hidden(f"got {jwt} back", jwt)

    def test_long_hex(self):
        secret = "a1" * 25
        self.assert_hidden(f"checksum leaked {secret}", secret)

    def test_long_base64_with_digits(self):
        secret = "Qm94S2V5U2VjcmV0MTIzNDU2Nzg5MEFCQ0RFRkdISUpLTA"
        self.assert_hidden(f"key={secret}", secret)

    def test_credential_shapes(self):
        for secret in ("ghp_abcdefgh12345", "xoxb-1234567890-abc", "cmp_pat_abcdef123456"):
            self.assert_hidden(f"found {secret} in output", secret.split("_")[-1])

    def test_secret_assignment(self):
        self.assert_hidden("password=topsecretvalue", "topsecretvalue")
        self.assert_hidden('"client_secret": "abc-123"', "abc-123")

    def test_identifiers_survive(self):
        # Long digit-free identifiers (constraint names) must stay readable.
        keep = "companion_decision_deliveries_delivery_check"
        self.assertIn(keep, prodlib.redact(f'violates check "{keep}"'))
        # uuids and box ids are diagnostic identifiers, not secrets.
        uuid = "2f111883-7f11-42e0-81fa-359e5b7b9727"
        self.assertIn(uuid, prodlib.redact(f"companion {uuid}"))
        self.assertIn("bx_abcdefgh", prodlib.redact("box bx_abcdefgh idle"))

    def test_non_string_input(self):
        self.assertEqual(prodlib.redact(42), "42")


class LoadEnvTest(unittest.TestCase):
    def _write_env(self, content: str, mode: int) -> str:
        handle = tempfile.NamedTemporaryFile("w", suffix=".env", delete=False)
        handle.write(content)
        handle.close()
        os.chmod(handle.name, mode)
        self.addCleanup(os.unlink, handle.name)
        return handle.name

    def test_missing_file_and_environment_refuses_with_exit_2(self):
        with self.assertRaises(SystemExit) as ctx:
            prodlib.load_env("/nonexistent/companion-prod.env", process_env={})
        self.assertEqual(ctx.exception.code, 2)

    def test_process_environment_works_without_file(self):
        env = prodlib.load_env(
            "/nonexistent/companion-prod.env",
            process_env={
                "RAILWAY_API_TOKEN": "cloud-token",
                "RAILWAY_PROJECT_ID": "cloud-project",
            },
        )
        self.assertEqual(env["RAILWAY_API_TOKEN"], "cloud-token")
        self.assertEqual(env["RAILWAY_PROJECT_ID"], "cloud-project")
        self.assertEqual(env["COMPANION_BOX_API_BASE"], "https://ascii.dev/api/box/v1")

    def test_group_readable_file_refuses_with_exit_2(self):
        path = self._write_env("RAILWAY_API_TOKEN=x\n", 0o640)
        with self.assertRaises(SystemExit) as ctx:
            prodlib.load_env(path)
        self.assertEqual(ctx.exception.code, 2)

    def test_world_readable_file_refuses_with_exit_2(self):
        path = self._write_env("RAILWAY_API_TOKEN=x\n", 0o644)
        with self.assertRaises(SystemExit) as ctx:
            prodlib.load_env(path)
        self.assertEqual(ctx.exception.code, 2)

    def test_0600_file_parses_and_applies_defaults(self):
        path = self._write_env(
            "# comment\n\nRAILWAY_API_TOKEN=tok\nRAILWAY_PROJECT_ID='proj'\n"
            'COMPANION_BOX_API_KEY="boxkey"\n',
            0o600,
        )
        env = prodlib.load_env(path, process_env={})
        self.assertEqual(env["RAILWAY_API_TOKEN"], "tok")
        self.assertEqual(env["RAILWAY_PROJECT_ID"], "proj")
        self.assertEqual(env["COMPANION_BOX_API_KEY"], "boxkey")
        self.assertEqual(env["COMPANION_BOX_API_BASE"], "https://ascii.dev/api/box/v1")

    def test_process_environment_overrides_file_and_file_fills_missing_values(self):
        path = self._write_env(
            "RAILWAY_API_TOKEN=file-token\n"
            "RAILWAY_PROJECT_ID=file-project\n"
            "DEBUG_PROD_ALLOW_RESTART=1\n",
            0o600,
        )
        env = prodlib.load_env(
            path,
            process_env={
                "RAILWAY_API_TOKEN": "cloud-token",
                "DEBUG_PROD_ALLOW_RESTART": "",
                "UNRELATED_SECRET": "must-not-be-copied",
            },
        )
        self.assertEqual(env["RAILWAY_API_TOKEN"], "cloud-token")
        self.assertEqual(env["RAILWAY_PROJECT_ID"], "file-project")
        self.assertEqual(env["DEBUG_PROD_ALLOW_RESTART"], "")
        self.assertNotIn("UNRELATED_SECRET", env)

    def test_require_refuses_missing_key(self):
        with self.assertRaises(SystemExit) as ctx:
            prodlib.require({}, "PROD_DATABASE_READ_URL")
        self.assertEqual(ctx.exception.code, 2)


class ParseSinceTest(unittest.TestCase):
    def test_units(self):
        self.assertEqual(prodlib.parse_since("90s"), 90)
        self.assertEqual(prodlib.parse_since("30m"), 1800)
        self.assertEqual(prodlib.parse_since("24h"), 86400)
        self.assertEqual(prodlib.parse_since("7d"), 604800)

    def test_invalid(self):
        for bad in ("", "30", "m30", "1w", "-5m"):
            with self.assertRaises(prodlib.ProdToolError):
                prodlib.parse_since(bad)


class _FakeResponse:
    def __init__(self, status: int, body: bytes):
        self.status = status
        self._body = body

    def read(self) -> bytes:
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class HttpJsonTest(unittest.TestCase):
    def test_get_retries_on_5xx_then_succeeds(self):
        calls = []
        responses = [_FakeResponse(500, b"{}"), _FakeResponse(200, b'{"ok": true}')]

        def opener(request, timeout):
            calls.append(request.get_method())
            return responses[len(calls) - 1]

        sleeps = []
        status, body = prodlib.http_json(
            "GET", "https://x.test/a", sleep=sleeps.append, opener=opener,
        )
        self.assertEqual(status, 200)
        self.assertEqual(body, {"ok": True})
        self.assertEqual(len(calls), 2)
        self.assertEqual(len(sleeps), 1)

    def test_get_retry_budget_is_bounded(self):
        calls = []

        def opener(request, timeout):
            calls.append(1)
            return _FakeResponse(429, b"{}")

        status, _ = prodlib.http_json(
            "GET", "https://x.test/a", retries=3, sleep=lambda _s: None, opener=opener,
        )
        self.assertEqual(status, 429)
        self.assertEqual(len(calls), 3)

    def test_post_is_never_retried(self):
        calls = []

        def opener(request, timeout):
            calls.append(1)
            return _FakeResponse(500, b"{}")

        status, _ = prodlib.http_json(
            "POST", "https://x.test/a", body={"q": 1}, sleep=lambda _s: None, opener=opener,
        )
        self.assertEqual(status, 500)
        self.assertEqual(len(calls), 1)

    def test_network_error_message_is_redacted(self):
        def opener(request, timeout):
            raise urllib.error.URLError("token=verysecretvalue refused")

        with self.assertRaises(prodlib.ProdToolError) as ctx:
            prodlib.http_json(
                "POST",
                "https://x.test/a?sig=SIGNEDSECRET",
                sleep=lambda _s: None,
                opener=opener,
            )
        message = str(ctx.exception)
        self.assertNotIn("verysecretvalue", message)
        self.assertNotIn("SIGNEDSECRET", message)

    def test_http_error_body_is_returned_not_raised(self):
        def opener(request, timeout):
            raise urllib.error.HTTPError(
                "https://x.test/a", 401, "unauthorized", None, io.BytesIO(b'{"errors": []}'),
            )

        status, body = prodlib.http_json("POST", "https://x.test/a", opener=opener)
        self.assertEqual(status, 401)
        self.assertEqual(body, {"errors": []})


if __name__ == "__main__":
    unittest.main()
