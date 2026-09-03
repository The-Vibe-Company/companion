import { describe, expect, it } from "vitest";
import { integrationSql } from "./testDatabase";

/**
 * Product promise: an upgraded Companion database contains Skills Hub data and no internal
 * agent-execution schema that an old route, flag, or worker could reactivate.
 *
 * Regression caught: omitting a runtime table, function or enum from the forward cleanup migration.
 *
 * Why integrated: dependency-order and CASCADE behavior can only be proven on migrated PostgreSQL.
 *
 * Failure proof: restoring any named runtime object makes its catalog count non-zero.
 */
describe("Skills Hub-only database migration", () => {
  it("keeps skill data while removing every runtime object family", async () => {
    const [catalog] = await integrationSql<Array<{
      skills: string | null;
      runtimeTables: number;
      runtimeFunctions: number;
      runtimeTypes: number;
    }>>`
      select
        to_regclass('public.skills')::text as skills,
        (
          select count(*)::int
          from pg_catalog.pg_class c
          join pg_catalog.pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public'
            and c.relkind in ('r', 'p')
            and (c.relname like 'skill_run%' or c.relname like 'project%' or c.relname like 'model_provider%' or c.relname in ('sandbox_usage_sessions', 'user_run_preferences', 'user_model_preferences', 'org_model_preferences'))
        ) as "runtimeTables",
        (
          select count(*)::int
          from pg_catalog.pg_proc p
          join pg_catalog.pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and (
              p.proname like 'companion%skill_run%'
              or p.proname ~ '^companion_run_'
              or p.proname in ('companion_reject_run_snapshot_update', 'companion_detach_deleted_run_config')
              or p.proname like 'companion%project%'
              or p.proname like 'companion%model_provider%'
              or p.proname like 'companion%sandbox%'
            )
            -- Companion runtimes project correlated broker events and terminal Turn state. Those
            -- verbs contain the English word "project" but are unrelated to the removed generic
            -- Projects product. Keep the historical-runtime assertion exact instead of treating
            -- every future use of "projection" as a resurrected Project function.
            and p.proname not in (
              'companion_runtime_get_attempt_terminal_projection',
              'companion_runtime_project_event_batch',
              'companion_runtime_project_event_batch_v2',
              'companion_runtime_project_automatic_decision_close',
              'companion_runtime_reconcile_projected_decision_with_member_turn',
              'companion_api_read_thread_projection_sequence',
              'companion_thread_allocate_projection_sequence',
              'companion_v3_api_read_projection',
              'companion_v3_runtime_project_page',
              'companion_v3_runtime_project_native_page',
              'companion_v3_runtime_project_native_page_v4',
              'companion_v3_runtime_project_native_page_v5',
              'companion_v3_runtime_project_native_page_v6',
              'companion_v3_runtime_project_native_page_v7',
              'companion_v3_runtime_project_routine_page',
              'companion_v3_runtime_project_background_page_v7',
              'companion_v3_runtime_project_background_page_v8',
              'companion_v3_runtime_project_background_page_v9'
            )
        ) as "runtimeFunctions",
        (
          select count(*)::int
          from pg_catalog.pg_type t
          join pg_catalog.pg_namespace n on n.oid = t.typnamespace
          where n.nspname = 'public'
            and (t.typname like 'skill_run%' or t.typname like 'project_%' or t.typname like 'sandbox_%' or t.typname = 'model_provider_connection_scope')
        ) as "runtimeTypes"
    `;

    expect(catalog).toEqual({
      skills: "skills",
      runtimeTables: 0,
      runtimeFunctions: 0,
      runtimeTypes: 0,
    });
  });
});
