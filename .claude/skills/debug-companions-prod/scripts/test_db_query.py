#!/usr/bin/env python3
"""Tests for db_query SQL assembly: read-only wrapper, -v parameterization,
no interpolation of values into SQL, and no free-SQL mode."""

from __future__ import annotations

import argparse
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import db_query  # noqa: E402
import prodlib  # noqa: E402

COMPANION_ID = "2f111883-7f11-42e0-81fa-359e5b7b9727"
TURN_ID = "9112f048-26f0-4d8d-9112-f04826f04d8d"


def make_args(**overrides) -> argparse.Namespace:
    defaults = {"companion": None, "turn": None, "since": "24h", "limit": 50}
    defaults.update(overrides)
    return argparse.Namespace(**defaults)


class SqlAssemblyTest(unittest.TestCase):
    def build(self, name: str, args=None, as_json: bool = False):
        params = db_query.collect_params(name, args or make_args(
            companion=COMPANION_ID, turn=TURN_ID,
        ))
        return db_query.build_invocation(name, params, as_json)

    def test_every_query_is_wrapped_read_only(self):
        for name in db_query.QUERIES:
            argv, sql = self.build(name)
            self.assertTrue(
                sql.startswith("BEGIN TRANSACTION READ ONLY;\n"),
                f"{name} is not wrapped read-only",
            )
            self.assertTrue(sql.rstrip().endswith("ROLLBACK;"), f"{name} does not roll back")
            self.assertNotIn("commit", sql.lower())

    def test_every_query_is_select_only(self):
        forbidden = ("insert ", "update ", "delete ", "truncate", "alter ", "drop ",
                     "create ", "grant ", "revoke ", "vacuum", "copy ")
        for name, spec in db_query.QUERIES.items():
            for statement in spec["statements"]:
                lowered = statement.lower()
                for keyword in forbidden:
                    self.assertNotIn(keyword, lowered, f"{name} contains {keyword!r}")

    def test_ids_are_passed_via_psql_vars_not_interpolated(self):
        argv, sql = self.build("turn")
        self.assertNotIn(TURN_ID, sql, "turn id was interpolated into SQL")
        self.assertIn(":'turn_id'::uuid", sql)
        self.assertIn("-v", argv)
        self.assertIn(f"turn_id={TURN_ID}", argv)

        argv, sql = self.build("ops")
        self.assertNotIn(COMPANION_ID, sql)
        self.assertIn(":'companion_id'::uuid", sql)
        self.assertIn(f"companion_id={COMPANION_ID}", argv)

    def test_since_and_limit_are_parameterized(self):
        args = make_args(companion=COMPANION_ID, since="30m", limit=25)
        params = db_query.collect_params("decisions", args)
        argv, sql = db_query.build_invocation("decisions", params, False)
        self.assertIn("since_seconds=1800", argv)
        self.assertIn("limit=25", argv)
        self.assertNotIn("1800", sql)
        self.assertIn(":'since_seconds'::int", sql)
        self.assertIn(":'limit'::int", sql)

    def test_argv_never_contains_a_database_url(self):
        for name in db_query.QUERIES:
            argv, _sql = self.build(name)
            for part in argv:
                self.assertNotIn("postgres://", part)
                self.assertNotIn("postgresql://", part)
                self.assertNotIn("@", part.split("=")[-1] if "=" in part else part)

    def test_psql_safety_flags(self):
        argv, _sql = self.build("gate")
        self.assertEqual(argv[0], "psql")
        self.assertIn("-X", argv)
        self.assertIn("ON_ERROR_STOP=1", argv)
        self.assertIn("pager=off", argv)

    def test_unknown_query_name_is_rejected(self):
        with self.assertRaises(prodlib.ProdToolError):
            db_query.build_invocation("free_sql", {}, False)

    def test_there_is_no_free_sql_mode(self):
        # The module exposes only the named-query registry; no API accepts SQL text.
        self.assertFalse(hasattr(db_query, "run_sql"))
        for name in db_query.QUERIES:
            self.assertIsInstance(db_query.QUERIES[name]["statements"], list)

    def test_bad_uuid_is_rejected(self):
        with self.assertRaises(prodlib.ProdToolError):
            db_query.collect_params("turn", make_args(turn="not-a-uuid"))
        with self.assertRaises(prodlib.ProdToolError):
            db_query.collect_params("ops", make_args(companion="'; drop table x; --"))

    def test_missing_required_id_is_rejected(self):
        with self.assertRaises(prodlib.ProdToolError):
            db_query.collect_params("turn", make_args())
        with self.assertRaises(prodlib.ProdToolError):
            db_query.collect_params("instance", make_args())

    def test_limit_bounds(self):
        with self.assertRaises(prodlib.ProdToolError):
            db_query.collect_params("health", make_args(limit=0))
        with self.assertRaises(prodlib.ProdToolError):
            db_query.collect_params("health", make_args(limit=99999))

    def test_json_mode_wraps_each_statement(self):
        argv, sql = self.build("turn", as_json=True)
        self.assertEqual(sql.count("json_agg(row_to_json(q))"), 2)
        self.assertIn("-t", argv)
        self.assertIn("-A", argv)

    def test_gate_uses_the_definer_status_function(self):
        _argv, sql = self.build("gate")
        self.assertIn("public.companion_runtime_gate_status()", sql)

    def test_decisions_never_select_response_text(self):
        for statement in db_query.QUERIES["decisions"]["statements"]:
            self.assertNotIn("response_text", statement)

    def test_recovery_queries_expose_exact_lane_operation_and_lease(self):
        _argv, ops_sql = self.build("ops")
        self.assertIn("to_jsonb(o)->>'execution_lane'", ops_sql)
        self.assertIn("source_turn.routine_snapshot_id", ops_sql)
        self.assertIn("o.source_turn_id", ops_sql)
        self.assertIn("lease.work_id = o.id", ops_sql)
        self.assertIn("operation_age", ops_sql)

        _argv, stuck_sql = self.build("stuck")
        self.assertIn("o.trigger = 'recovery'", stuck_sql)
        self.assertIn("recovery.attempt_count", stuck_sql)
        self.assertIn("recovery_lease_expires_at", stuck_sql)
        self.assertNotIn("o.execution_lane", stuck_sql)


if __name__ == "__main__":
    unittest.main()
