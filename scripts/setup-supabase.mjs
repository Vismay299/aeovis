#!/usr/bin/env node
/**
 * Apply Supabase schema migrations.
 *
 * Requires one of:
 *   DATABASE_URL=postgresql://postgres:[PASSWORD]@db.[PROJECT].supabase.co:5432/postgres
 *   SUPABASE_DB_PASSWORD=[your database password]
 *
 * Get the password from: Supabase Dashboard → Project Settings → Database → Database password
 */

import { readFileSync, readdirSync, realpathSync } from "fs";
import { fileURLToPath, pathToFileURL } from "url";
import { dirname, join } from "path";
import { createHash } from "crypto";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * R6.1.1 — the ledger. Before this, nothing recorded what had been applied.
 *
 * On 2026-08-30 the live database was found to be missing 007, 008 AND 009
 * while `npm run setup:db` would have reported success, because its verify list
 * stopped at 005 and it kept no record of its own runs. A migration runner that
 * cannot say what it applied is not a migration runner.
 */
const SCHEMA_MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename         text PRIMARY KEY,
  checksum         text NOT NULL,
  applied_at       timestamptz NOT NULL DEFAULT now(),
  first_applied_at timestamptz
);
-- NULLABLE, and deliberately no default. Rows written before this column
-- existed have an UNKNOWN first-apply time, and backfilling them with now()
-- would claim they first landed on whatever day the column was added. An
-- unknown must read as unknown; that is the whole point of this ledger.
ALTER TABLE schema_migrations
  ADD COLUMN IF NOT EXISTS first_applied_at timestamptz;
-- R6.1.5. Also NULLABLE and also deliberately undefaulted, for the same
-- reason: rows recorded before this column existed have no comment-independent
-- checksum, so for those rows the runner CANNOT tell a comment edit from a SQL
-- edit and must say exactly that rather than guess either way. Backfilling it
-- from today's file would assert the file matches the database, which is the
-- claim under dispute.
ALTER TABLE schema_migrations
  ADD COLUMN IF NOT EXISTS sql_checksum text;`;

/**
 * What each migration must leave behind, checked against the Postgres catalog.
 *
 * Keyed by migration file so a new migration without an entry fails the guard
 * test in src/lib/migrationsLedger.test.mjs — the stale-list failure (finding
 * C10) was this list silently ending at 005 while four more migrations shipped.
 *
 * `to_regclass` covers tables and indexes; functions need pg_proc, because a
 * table can exist while the function that makes it usable does not — exactly
 * the state 009 was found in.
 */
const EXPECTED_OBJECTS = {
  "050_f03_cost_ledger.sql": [
    { kind: "column", name: "spend_ledger.subject_kind" },
    { kind: "column", name: "spend_ledger.answer_ref" },
    { kind: "table", name: "cost_reconciliations" },
    { kind: "function", name: "sync_probe_attempt_costs" },
    { kind: "function", name: "settle_scan_hold" },
    { kind: "function", name: "settle_finished_scan_holds" },
    { kind: "function", name: "resolve_cost_reconciliation" },
    { kind: "function", name: "engine_cost_stats" },
    { kind: "function", name: "f03_upsert_attempt_rows" },
    { kind: "function", name: "prune_cost_reconciliations" },
    { kind: "function", name: "resolve_unknown_cost_backlog" },
  ],
  "051_f03_usage.sql": [
    { kind: "function", name: "workspace_usage_days" },
    { kind: "function", name: "workspace_spend_position" },
    { kind: "function", name: "operator_costs_by_workspace" },
    { kind: "function", name: "operator_costs_by_endpoint" },
  ],
  "070_f07_project_memory.sql": [
    { kind: "table", name: "project_context_sections" },
    { kind: "table", name: "project_competitors" },
    { kind: "table", name: "project_key_pages" },
    { kind: "table", name: "project_research_log" },
    { kind: "table", name: "project_memory_state" },
    { kind: "function", name: "apply_project_context_ops" },
    { kind: "function", name: "claim_project_brief_import" },
    { kind: "function", name: "release_project_brief_import_claim" },
    { kind: "function", name: "prune_project_research_log" },
    { kind: "index", name: "project_research_log_retention_idx" },
    { kind: "constraint", name: "project_competitors_no_ipv4" },
    { kind: "constraint", name: "project_research_log_job_id_fkey" },
  ],
  "080_f09_price_approvals.sql": [
    { kind: "table", name: "price_approvals" },
    { kind: "column", name: "scan_jobs.approved_max_usd" },
    { kind: "column", name: "scan_jobs.price_quote" },
    { kind: "function", name: "prune_price_approvals" },
  ],
  "040_f01_jobs.sql": [
    { kind: "table", name: "jobs" },
    { kind: "table", name: "job_steps" },
    { kind: "table", name: "job_periodic" },
    { kind: "function", name: "enqueue_job" },
    { kind: "function", name: "claim_due_jobs" },
    { kind: "function", name: "job_step_begin" },
    { kind: "function", name: "job_step_complete" },
    { kind: "function", name: "job_step_fail" },
    { kind: "function", name: "job_sleep" },
    { kind: "function", name: "job_yield" },
    { kind: "function", name: "job_progress" },
    { kind: "function", name: "job_finish" },
    { kind: "function", name: "cancel_job" },
    { kind: "function", name: "reconcile_stale_jobs" },
    { kind: "function", name: "claim_due_periodic" },
    { kind: "function", name: "prune_jobs" },
    { kind: "index", name: "jobs_single_active_idx" },
  ],
  "041_f01_spend.sql": [
    { kind: "table", name: "paid_feature_controls" },
    { kind: "table", name: "workspace_spend_limits" },
    { kind: "table", name: "spend_holds" },
    { kind: "table", name: "spend_ledger" },
    { kind: "function", name: "reserve_spend" },
    { kind: "function", name: "settle_spend" },
    { kind: "function", name: "release_spend" },
    { kind: "function", name: "expire_spend_holds" },
    { kind: "function", name: "f01_expire_due_holds" },
    { kind: "function", name: "prune_spend" },
    { kind: "function", name: "f01_committed_usd" },
  ],
  "042_f01_provider_cache.sql": [
    { kind: "table", name: "provider_cache" },
    { kind: "function", name: "prune_provider_cache" },
    { kind: "bucket", name: "provider-cache" },
  ],
  "043_f01_jobs_cron.sql": [{ kind: "function", name: "jobs_tick_http" }],
  "045_f02_queued_dispatch.sql": [
    { kind: "function", name: "post_probe_dispatch" },
    { kind: "function", name: "reschedule_probe_collection" },
    { kind: "function", name: "collect_probe_dispatch" },
    { kind: "function", name: "expire_posted_probe_dispatch" },
  ],
  "170_f27_onboarding.sql": [
    { kind: "table", name: "user_onboarding" },
    { kind: "table", name: "workspace_setup_dismissals" },
    { kind: "column", name: "gsc_oauth_attempts.return_path" },
  ],
  "165_f26_privacy_and_telemetry_ids.sql": [
    { kind: "column", name: "customer_brands.telemetry_id" },
    { kind: "table", name: "user_privacy_choices" },
  ],
  "155_f24_signup_guard.sql": [
    { kind: "table", name: "disposable_email_domains" },
    { kind: "function", name: "is_disposable_email_domain" },
    { kind: "function", name: "hook_before_user_created" },
  ],
  "085_f10_customer_schedules.sql": [
    { kind: "column", name: "scan_schedules.managed_by" },
    { kind: "column", name: "scan_schedules.schedule_interval" },
    { kind: "column", name: "scan_schedules.approved_max_usd" },
    { kind: "column", name: "scan_schedules.last_skip_reason" },
    { kind: "column", name: "scan_schedules.schedule_time" },
    { kind: "column", name: "scan_schedules.last_skip_at" },
    { kind: "column", name: "scan_schedules.approval_id" },
    { kind: "column", name: "scan_schedules.customer_updated_by" },
    { kind: "column", name: "scan_schedules.customer_updated_at" },
    { kind: "constraint", name: "scan_schedules_f10_checks" },
    { kind: "index", name: "scan_schedules_customer_due_idx" },
    { kind: "function", name: "start_customer_window" },
    { kind: "function", name: "block_customer_window" },
  ],
  "035_scoped_provider_rollout.sql": [
    {kind:"function",name:"set_probe_rollout"},
    {kind:"column",name:"probe_dispatch_control.brand_allowlist"},
  ],
  "034_measurement_storage_contract.sql": [
    {kind:"function",name:"measurement_storage_ready"},
  ],
  "028_measurement_evidence.sql": [
    {kind:"table",name:"measurement_evidence"},
    {kind:"table",name:"measurement_incidents"},
    {kind:"function",name:"record_measurement_incident"},
  ],
  "029_repair_workflow.sql": [
    {kind:"table",name:"repair_artifacts"},
    {kind:"table",name:"repair_artifact_heads"},
    {kind:"function",name:"append_repair_artifact"},
    {kind:"function",name:"decide_checked_content"},
    {kind:"function",name:"record_verified_publication"},
    {kind:"function",name:"repair_content_hash"},
  ],
  "030_scan_finalize_identity.sql": [
    {kind:"column",name:"scans.origin_job_id"},
    {kind:"constraint",name:"scans_origin_job_key"},
  ],
  "031_content_check_budget.sql": [
    {kind:"table",name:"content_check_claims"},
    {kind:"function",name:"claim_content_check"},
    {kind:"function",name:"finish_content_check"},
  ],
  "032_durable_schedule_windows.sql": [
    {kind:"table",name:"measurement_windows"},
    {kind:"function",name:"enqueue_measurement_window"},
    {kind:"column",name:"scan_jobs.panel_snapshot"},
    {kind:"column",name:"scan_jobs.measurement_context"},
  ],
  "033_atomic_scan_materialization.sql": [
    {kind:"function",name:"materialize_scan_report"},
  ],

  "027_durable_probe_dispatch.sql": [
    { kind: "table", name: "probe_observations" },
    { kind: "table", name: "probe_dispatch_control" },
    { kind: "table", name: "probe_reconciliations" },
    { kind: "table", name: "provider_canary_budgets" },
    { kind: "function", name: "reconcile_probe_dispatch" },
    { kind: "table", name: "probe_attempts" },
    { kind: "table", name: "probe_late_receipts" },
    { kind: "table", name: "provider_dispatch_circuits" },
    { kind: "function", name: "seed_probe_observations" },
    { kind: "function", name: "claim_probe_dispatch" },
    { kind: "function", name: "finish_probe_dispatch" },
    { kind: "function", name: "block_probe_dispatch" },
    { kind: "function", name: "renew_probe_dispatch" },
  ],
  "001_initial_schema.sql": [
    { kind: "table", name: "scans" },
    { kind: "table", name: "brand_prompts" },
    { kind: "table", name: "scan_jobs" },
    { kind: "table", name: "content_events" },
  ],
  "002_content_os.sql": [
    { kind: "table", name: "content_jobs" },
    { kind: "table", name: "content_items" },
    { kind: "table", name: "content_feedback" },
    { kind: "table", name: "brand_briefs" },
    { kind: "table", name: "content_lessons" },
  ],
  "003_content_agents.sql": [{ kind: "table", name: "content_agents" }],
  "004_crew_canvas_knowledge.sql": [{ kind: "table", name: "knowledge_blocks" }],
  "005_analytics_platform.sql": [
    { kind: "table", name: "prompt_results" },
    { kind: "table", name: "result_brands" },
    { kind: "table", name: "citations" },
    { kind: "table", name: "brand_metrics_daily" },
    { kind: "table", name: "scan_schedules" },
    { kind: "table", name: "topics" },
  ],
  "006_agent_control_plane.sql": [{ kind: "index", name: "content_jobs_heartbeat_idx" }],
  "007_scan_seal.sql": [{ kind: "index", name: "scan_jobs_one_running_per_brand" }],
  "008_system_heartbeats.sql": [{ kind: "table", name: "system_heartbeats" }],
  "009_scan_rate_limit.sql": [
    { kind: "table", name: "scan_rate_limits" },
    { kind: "index", name: "scan_rate_limits_window_idx" },
    { kind: "function", name: "increment_scan_rate_limit" },
  ],
  "010_probe_tasks.sql": [
    { kind: "table", name: "probe_tasks" },
    { kind: "index", name: "probe_tasks_claim_idx" },
    { kind: "index", name: "probe_tasks_batch_idx" },
    { kind: "index", name: "probe_tasks_lease_idx" },
    // The claim IS the migration. A probe_tasks table without
    // claim_probe_tasks is a queue nothing can take work from, and that is
    // exactly the shape 009 was found in — table present, function absent.
    { kind: "function", name: "claim_probe_tasks" },
    { kind: "function", name: "complete_probe_tasks" },
    { kind: "function", name: "renew_probe_lease" },
    { kind: "function", name: "release_probe_tasks" },
  ],
  // Added by R6.1.5/R6.1.6, not by R1.2.3 which authored 011, because this file
  // was owned by this task for the round;
  // the names below are read off supabase/migrations/011_scan_runs.sql
  // (CREATE TABLE line 78, the four CREATE INDEX at 163/169/176/183, the three
  // CREATE OR REPLACE FUNCTION at 220/257/299), not inferred from the title.
  "011_scan_runs.sql": [
    { kind: "table", name: "scan_runs" },
    { kind: "index", name: "scan_runs_job_idx" },
    { kind: "index", name: "scan_runs_batch_idx" },
    { kind: "index", name: "scan_runs_open_idx" },
    { kind: "index", name: "scan_runs_runner_idx" },
    // A ledger nothing can write to is not a ledger: 009 was found as a table
    // with its function missing, and 011 has three of them.
    { kind: "function", name: "open_scan_run" },
    { kind: "function", name: "heartbeat_scan_run" },
    { kind: "function", name: "close_scan_run" },
  ],
  // R3.3.1. The catalog probe below can see tables, indexes and functions —
  // not columns — and `scan_jobs.attempts` is the point of this migration. The
  // index is what makes it checkable: an index ON the column cannot exist
  // unless the column does. Verifying only the function would not do it, since
  // a plpgsql body does not resolve its column references until it runs.
  // R6.1.12 — also verify the column directly via pg_attribute, so a database
  // with the index but without the column is caught.
  "012_scan_job_attempts.sql": [
    { kind: "column", name: "scan_jobs.attempts" },
    { kind: "index", name: "scan_jobs_attempts_idx" },
    { kind: "function", name: "claim_scan_job_attempt", signature: "uuid, integer" },
  ],
  // R4.3.2. Same column-invisibility problem as 012, same answer: the probe
  // cannot see `brand_metrics_daily.sov_state` / `.sov_state_reason`, but it can
  // see a partial index whose predicate references them, and that index cannot
  // exist unless they do. Both columns come from one ALTER inside this
  // migration's own transaction, so the index proves the pair.
  //
  // This one matters more than a schema tick: without these columns every scan
  // finalize fails its brand_metrics_daily upsert (PGRST204), because
  // upsertBrandMetricsDaily sends the rollup row through verbatim.
  // R6.1.12 — also verify the columns directly via pg_attribute.
  "013_brand_metrics_sov_state.sql": [
    { kind: "column", name: "brand_metrics_daily.sov_state" },
    { kind: "column", name: "brand_metrics_daily.sov_state_reason" },
    { kind: "index", name: "brand_metrics_daily_sov_unverified_idx" },
  ],
  // R3.5.4, registering the file R3.5.1 left orphaned. THE EMPTY LIST IS THE
  // FINDING, not an oversight — read this before "fixing" it.
  //
  // 014 is one statement, read off supabase/migrations/014_content_job_checkpoints.sql
  // line 11, which is the only non-comment line in the file:
  //
  //   ALTER TABLE content_jobs ADD COLUMN IF NOT EXISTS checkpoint jsonb;
  //
  // It creates no table, no index and no function. objectExists() below asks
  // to_regclass and pg_proc, and neither can see a column, so there is no
  // object name that could honestly go here. Empty beats wrong.
  //
  // Why not the 012/013 move: both of those ship an index whose definition
  // references the new column, so the index stands in for what the probe
  // cannot see. 014 ships no such index, and the migration file belongs to
  // R3.5.1 (in verification), so this task may not add one to it.
  //
  // Why not { kind: "table", name: "content_jobs" }: that table is 002's and
  // is present on every database that ever ran 002. It would print a ✓ under
  // the 014 heading on a database that has never seen 014 — a false green,
  // which is C10, the exact defect this list exists to prevent. Printing
  // nothing is the honest output.
  //
  // THE RESIDUAL GAP, STATED PLAINLY: `npm run setup:db` cannot tell you
  // whether 014 is applied: it reaches its final green verdict on a database
  // that is missing this migration. (That verdict sentence is deliberately not
  // quoted here — a guard in src/lib/migrationsLedger.test.mjs requires the
  // only occurrence of it in this file to sit after the catalog check, and a
  // comment repeating it above would be indistinguishable from a claim.)
  // The query that settles 014 by hand is in
  // docs/OPERATOR_LEDGER.md § C (information_schema.columns; the one-query
  // block in docs/PROD_MIGRATIONS.md has no 014 row yet).
  "014_content_job_checkpoints.sql": [],
  // R4.3.3. Same column-invisibility problem as 012/013, same answer, and
  // deliberately NOT 014's empty list: this migration ships its own partial
  // index (`WHERE citation_state IS NULL AND citation_share_pct IS NOT NULL`),
  // whose predicate names two of the three new columns, so the index cannot
  // exist unless they do. All three columns come from one ALTER inside this
  // migration's own transaction, so the index proves the set.
  //
  // Same blast radius as 013 if it is missing: upsertBrandMetricsDaily sends
  // the rollup row through verbatim, so every scan finalize fails its
  // brand_metrics_daily write with PGRST204, and scripts/backfill-analytics.mjs
  // refuses to start.
  "015_brand_metrics_citation_state.sql": [
    { kind: "index", name: "brand_metrics_daily_citation_unverified_idx" },
  ],
  // R4.3.1 — crawlability audit history and change detection. Ships a table
  // with two indexes: domain+audited_at for history queries, and a per-minute
  // unique constraint for upsert deduplication. The catalog probe can see
  // tables and indexes but not columns, so the table entry proves existence
  // and the domain_idx proves the index was created.
  "016_crawlability_audit_history.sql": [
    { kind: "table", name: "crawlability_audits" },
    { kind: "index", name: "crawlability_audits_domain_idx" },
  ],
  "016_content_items_natural_key.sql": [
    { kind: "constraint", name: "content_items_job_id_cycle_key" },
  ],
  "017_cost_unmeasured_calls.sql": [
    { kind: "column", name: "scans.cost_unmeasured_calls" },
  ],
  // R4.1.1 — weekly GSC ingest: the brand->property connection and the
  // per-day, per-query rows it writes.
  "018_gsc_daily.sql": [
    { kind: "table", name: "gsc_connections" },
    { kind: "table", name: "gsc_daily" },
    { kind: "index", name: "gsc_daily_brand_date_idx" },
  ],
  // R1.5.1 — private Storage bucket for probe screenshots + gzipped HTML.
  "019_probe_evidence_bucket.sql": [
    { kind: "bucket", name: "probe-evidence" },
  ],
  // R3.5.5 — recreates 016's key as UNIQUE NULLS NOT DISTINCT. Same constraint
  // NAME, so presence alone cannot tell 016 from 020; the definition check is
  // the query in the file's header (pg_get_constraintdef LIKE '%NULLS NOT DISTINCT%').
  "020_content_items_key_nulls_not_distinct.sql": [
    { kind: "constraint", name: "content_items_job_id_cycle_key" },
  ],
  // R1.5.2 — the Probe Result Contract v2 §3.7 evidence ids, promoted out of
  // `raw` so R1.5.3 can sign a URL per answer row. Columns, not a table: the
  // catalog probe checks each one by name, because a prompt_results that
  // exists without them is exactly the state the ingest would fail in
  // (PGRST204 on every fleet batch).
  "021_prompt_results_evidence.sql": [
    { kind: "column", name: "prompt_results.evidence_screenshot_id" },
    { kind: "column", name: "prompt_results.evidence_dom_id" },
    { kind: "column", name: "prompt_results.evidence_har_id" },
    { kind: "column", name: "prompt_results.evidence_raw_id" },
    { kind: "column", name: "prompt_results.evidence_captured_at" },
  ],
  // R1.2.23a — scan_runs retention. Both objects matter and for different
  // reasons: without the FUNCTION the nightly cron calls an RPC that does not
  // exist and the table keeps growing (the 009 shape — table present, function
  // absent — is exactly this failure, and 022 shipped in that shape for part of
  // one afternoon), and without the INDEX each batch sequentially scans the
  // whole ledger.
  "022_scan_runs_retention.sql": [
    { kind: "index", name: "scan_runs_noop_retention_idx" },
    { kind: "function", name: "prune_noop_scan_runs" },
  ],
  "023_customer_auth_and_tenant_rls.sql": [
    { kind: "table", name: "customer_brands" },
    { kind: "table", name: "customer_brand_memberships" },
    { kind: "table", name: "customer_brand_aliases" },
    { kind: "function", name: "customer_can_access_brand" },
    { kind: "function", name: "customer_can_access_scan" },
  ],
  "024_customer_workspace_ownership.sql": [
    { kind: "table", name: "customer_team_invites" },
    { kind: "function", name: "create_customer_workspace" },
    { kind: "function", name: "prevent_last_owner_removal" },
  ],
  "025_gsc_customer_oauth.sql": [
    { kind: "table", name: "gsc_oauth_attempts" },
    { kind: "table", name: "gsc_oauth_credentials" },
    { kind: "table", name: "gsc_sync_jobs" },
    { kind: "index", name: "gsc_daily_brand_key_gen_idx" },
  ],
  "026_customer_uat_repairs.sql": [
    { kind: "column", name: "scans.brand_key" },
    { kind: "column", name: "scan_jobs.brand_key" },
    { kind: "index", name: "scan_jobs_one_running_per_workspace" },
    { kind: "function", name: "activate_customer_gsc" },
    { kind: "function", name: "disconnect_customer_gsc" },
    { kind: "function", name: "write_gsc_generation" },
    { kind: "function", name: "accept_customer_team_invites" },
    { kind: "function", name: "claim_customer_gsc_job" },
    { kind: "function", name: "commit_customer_gsc_page" },
    { kind: "function", name: "enqueue_customer_gsc_syncs" },
    { kind: "function", name: "decide_customer_content" },
  ],
  "075_f08_workspace_questions.sql": [
    { kind: "table", name: "workspace_question_settings" },
    { kind: "table", name: "workspace_questions" },
    { kind: "column", name: "workspace_questions.text_normalized" },
    { kind: "table", name: "workspace_question_events" },
    { kind: "function", name: "normalize_question_text" },
    { kind: "function", name: "add_workspace_question" },
    { kind: "function", name: "save_workspace_questions" },
    { kind: "function", name: "sync_panel_questions" },
    { kind: "function", name: "prune_workspace_question_events" },
  ],
  "076_f08_question_backfill.sql": [
    { kind: "function", name: "backfill_workspace_questions" },
    { kind: "function", name: "append_approved_panel_with_questions" },
  ],
  "160_f25_email_tables.sql": [
    { kind: "table", name: "user_email_preferences" },
    { kind: "table", name: "email_outbox" },
    { kind: "table", name: "workspace_milestones" },
  ],
  "161_f25_email_functions.sql": [
    { kind: "function", name: "claim_email_outbox" },
    { kind: "function", name: "close_exhausted_email_outbox" },
    { kind: "function", name: "email_milestone_candidates" },
    { kind: "function", name: "prune_email_outbox" },
  ],
  "130_f19_indexnow.sql": [
    { kind: "table", name: "indexnow_keys" },
    { kind: "table", name: "indexnow_submissions" },
    { kind: "table", name: "indexnow_key_checks" },
    { kind: "function", name: "indexnow_ensure_key" },
    { kind: "function", name: "indexnow_usage" },
    { kind: "function", name: "indexnow_recently_submitted" },
    { kind: "function", name: "prune_indexnow" },
  ],
  "135_f20_ga4.sql": [
    { kind: "table", name: "ga4_oauth_attempts" },
    { kind: "table", name: "ga4_grants" },
    { kind: "table", name: "ga4_connections" },
  ],
  "136_f20_ga4_functions.sql": [
    { kind: "function", name: "ga4_upsert_grant" },
    { kind: "function", name: "ga4_purge_cache" },
    { kind: "function", name: "ga4_set_connection" },
    { kind: "function", name: "ga4_disconnect" },
    { kind: "function", name: "ga4_grant_impact" },
    { kind: "function", name: "ga4_remove_grant" },
    { kind: "function", name: "ga4_list_unused_grants" },
    { kind: "function", name: "ga4_delete_unused_grant" },
    { kind: "function", name: "prune_ga4_oauth_attempts" },
  ],
  "125_f18_site_audit.sql": [
    { kind: "table", name: "site_audits" },
    { kind: "table", name: "site_audit_pages" },
    { kind: "table", name: "site_audit_issues" },
    { kind: "table", name: "site_audit_lighthouse" },
    { kind: "table", name: "site_audit_frontier" },
    { kind: "table", name: "site_audit_links" },
    { kind: "bucket", name: "site-audit-lighthouse" },
  ],
  "126_f18_site_audit_functions.sql": [
    { kind: "function", name: "site_audit_create" },
    { kind: "function", name: "site_audit_seed" },
    { kind: "function", name: "site_audit_frontier_stats" },
    { kind: "function", name: "site_audit_claim_chunk" },
    { kind: "function", name: "site_audit_record_batch" },
    { kind: "function", name: "site_audit_release" },
    { kind: "function", name: "site_audit_abandon_chunk" },
    { kind: "function", name: "site_audit_broken_links" },
    { kind: "function", name: "site_audit_orphan_pages" },
    { kind: "function", name: "site_audit_issue_summary" },
    { kind: "function", name: "site_audit_destroy_scratch" },
    { kind: "function", name: "prune_site_audits" },
  ],
  "100_f13_saved_keywords.sql": [
    { kind: "table", name: "saved_keywords" },
    { kind: "table", name: "saved_keyword_tags" },
    { kind: "table", name: "saved_keyword_tag_assignments" },
  ],
  "101_f13_keyword_metrics.sql": [
    { kind: "table", name: "keyword_metrics" },
    { kind: "function", name: "upsert_keyword_metrics" },
    { kind: "function", name: "prune_keyword_metrics" },
  ],
  "102_f13_saved_keyword_functions.sql": [
    { kind: "function", name: "save_keywords" },
    { kind: "function", name: "list_saved_keywords" },
    { kind: "function", name: "update_saved_keyword_tags" },
    { kind: "function", name: "delete_saved_keyword_tag" },
    { kind: "function", name: "remove_saved_keywords" },
    { kind: "function", name: "f13_filtered_saved_keywords" },
  ],
  "090_f11_explore_dispatch.sql": [
    { kind: "column", name: "probe_observations.brand_key" },
    { kind: "constraint", name: "probe_observations_purpose_check" },
    { kind: "constraint", name: "probe_observations_explore_shape" },
    { kind: "index", name: "probe_observations_explore_run_idx" },
    { kind: "index", name: "probe_observations_explore_reuse_idx" },
    { kind: "function", name: "seed_explore_observations" },
    { kind: "function", name: "claim_probe_dispatch" },
  ],
  "091_f11_explore_runs.sql": [
    { kind: "table", name: "explore_runs" },
    { kind: "index", name: "explore_runs_brand_idx" },
    { kind: "index", name: "explore_runs_user_idx" },
    { kind: "index", name: "explore_runs_active_idx" },
    { kind: "function", name: "f11_upsert_explore_attempt_rows" },
    { kind: "function", name: "settle_explore_hold" },
    { kind: "function", name: "settle_finished_explore_holds" },
    { kind: "function", name: "prune_explore_runs" },
  ],
  "095_f12_question_answer_links.sql": [
    { kind: "table", name: "question_answer_links" },
    { kind: "function", name: "link_question_answers" },
    { kind: "function", name: "prune_question_answer_links" },
  ],
  "120_f17_local_seo.sql": [
    { kind: "table", name: "local_businesses" },
    { kind: "table", name: "local_fetches" },
    { kind: "table", name: "local_fetch_items" },
    { kind: "table", name: "local_grid_runs" },
    { kind: "table", name: "local_searches" },
  ],
  "121_f17_local_seo_functions.sql": [
    { kind: "function", name: "save_local_business" },
    { kind: "function", name: "find_local_reuse" },
    { kind: "function", name: "claim_local_poll" },
    { kind: "function", name: "prune_local_seo" },
  ],
  "110_f15_rank_tracking.sql": [
    { kind: "table", name: "rank_tracking_configs" },
    { kind: "table", name: "rank_tracking_keywords" },
    { kind: "table", name: "rank_check_runs" },
    { kind: "table", name: "rank_snapshots" },
    { kind: "table", name: "rank_check_tasks" },
  ],
  "111_f15_rank_tracking_functions.sql": [
    { kind: "function", name: "add_rank_tracking_keywords" },
    { kind: "function", name: "claim_rank_config" },
    { kind: "function", name: "try_create_rank_run" },
    { kind: "function", name: "rank_check_reserve" },
    { kind: "function", name: "rank_latest_snapshots" },
    { kind: "function", name: "rank_earliest_snapshots" },
    { kind: "function", name: "rank_best_positions" },
    { kind: "function", name: "rank_config_trend" },
    { kind: "function", name: "rank_position_matrix" },
    { kind: "function", name: "rank_config_summaries" },
    { kind: "function", name: "prune_rank_tracking" },
  ],
  "112_f15_rank_keyword_questions.sql": [
    { kind: "table", name: "rank_keyword_questions" },
    { kind: "function", name: "rank_question_aio_status" },
  ],
  "065_f06_exports.sql": [
    { kind: "bucket", name: "exports" },
    { kind: "table", name: "export_requests" },
    { kind: "index", name: "export_requests_brand_created_idx" },
    { kind: "index", name: "export_requests_cleanup_idx" },
    { kind: "constraint", name: "export_requests_kind_ck" },
    { kind: "constraint", name: "export_requests_format_ck" },
    { kind: "constraint", name: "export_requests_status_ck" },
    { kind: "constraint", name: "export_requests_counts_ck" },
    { kind: "constraint", name: "export_requests_path_ck" },
  ],
  "066_f06_scan_history_columns.sql": [
    { kind: "function", name: "scan_engines" },
    { kind: "function", name: "scan_collection_partial" },
    { kind: "function", name: "scans_derive_history_columns" },
    { kind: "constraint", name: "scans_started_by_ck" },
    { kind: "index", name: "scans_brand_listed_idx" },
    { kind: "index", name: "scans_brand_visibility_idx" },
    { kind: "index", name: "scans_engines_gin_idx" },
  ],
  "145_f22_assistant_sessions.sql": [
    { kind: "table", name: "assistant_sessions" },
    { kind: "table", name: "assistant_messages" },
    { kind: "table", name: "assistant_turns" },
    { kind: "function", name: "begin_assistant_turn" },
    { kind: "function", name: "rewind_assistant_session" },
    { kind: "function", name: "prune_assistant_sessions" },
  ],
  "146_f22_assistant_stream_chunks.sql": [
    { kind: "table", name: "assistant_stream_chunks" },
    { kind: "function", name: "prune_assistant_stream_chunks" },
  ],
  "147_f22_assistant_approvals.sql": [
    { kind: "table", name: "assistant_approvals" },
    { kind: "function", name: "claim_assistant_approval" },
    { kind: "function", name: "expire_assistant_approvals" },
  ],
  "148_f22_gsc_query_summary.sql": [
    { kind: "function", name: "assistant_gsc_query_summary" },
  ],
  "149_f22_assistant_milestone_fix.sql": [
    { kind: "column", name: "assistant_turns.created_at" },
  ],
};

/**
 * A dollar-quote opener: `$$`, `$fn$`, `$policy$`. The tag may not START with a
 * digit, which is what keeps `$1` (a positional parameter) from being read as
 * the beginning of a quoted block.
 */
// Assembled rather than written as a literal so the non-ASCII range carries no
// escape ambiguity: PostgreSQL allows any letter above U+007F in a tag.
const HIGH = String.fromCharCode(0x80) + "-" + String.fromCharCode(0xffff);
const DOLLAR_TAG = new RegExp(`^[$]([A-Za-z_${HIGH}][A-Za-z0-9_${HIGH}]*)?[$]`);

/**
 * R6.1.5 — the migration text with COMMENTS REMOVED, or an honest refusal.
 *
 * Why this exists: the ledger checksum hashes the whole file, so correcting a
 * comment moved 010_probe_tasks.sql from be27ae10f9467429 to ed5bc223145c0461
 * (commit 39af3a9) while the SQL was byte-identical, and the runner announced
 * "The file no longer describes what is in the database." That warning was
 * false, and a warning that is false often is a warning an operator learns to
 * wave through — which is how the next real drift gets missed.
 *
 * WHY A LEXER AND NOT `sql.replace(/--.*$/gm, "")`. A naive strip eats `--`
 * inside a string literal and inside the `$fn$ ... $fn$` bodies that 010 is
 * mostly made of. That is the dangerous direction of error: over-stripping
 * makes a REAL SQL change hash identically to the text it replaced, which turns
 * this from a noisy warning into a silent one. So this walks the four PostgreSQL
 * lexical contexts that can contain a `--`: single-quoted strings (with '' and,
 * after an E prefix, backslash escapes), double-quoted identifiers, nestable
 * slash-star block comments, and dollar-quoted blocks.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: it does not strip comments INSIDE a
 * dollar-quoted body. Lexically that body is a string literal; that PL/pgSQL
 * reads `--` inside it as a comment is a second grammar, and guessing at it is
 * exactly the over-stripping this function refuses to do. The consequence is
 * that editing a comment inside a function body still trips the loud warning.
 * That is the safe direction: under-stripping degrades to the behaviour we
 * already had.
 *
 * Returns { text, reliable, reason }. `reliable: false` means the file ended
 * inside a literal or a comment, i.e. this function does not understand it — and
 * an unparsed file must fall back to the loud message, never to a reassuring one.
 */
export function semanticSql(sql) {
  const s = sql.replace(/\r\n/g, "\n");
  const parts = [];
  let code = "";
  // Whitespace OUTSIDE literals is collapsed, so that removing a trailing
  // comment (and the blank line it leaves) cannot itself change the hash.
  // Whitespace inside a literal is preserved verbatim: it is data.
  const flushCode = () => {
    if (code) {
      parts.push(code.replace(/\s+/g, " "));
      code = "";
    }
  };
  const unreadable = (reason) => ({ text: null, reliable: false, reason });

  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];

    if (c === "-" && s[i + 1] === "-") {
      const nl = s.indexOf("\n", i);
      i = nl === -1 ? n : nl;
      code += " "; // a space, never nothing, so `a-/**/-b` cannot become `a--b`
      continue;
    }

    if (c === "/" && s[i + 1] === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (s[i] === "/" && s[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (s[i] === "*" && s[i + 1] === "/") {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      if (depth > 0) return unreadable("unterminated block comment");
      code += " ";
      continue;
    }

    if (c === "'") {
      // With standard_conforming_strings on (the default) a backslash is an
      // ordinary character in '...'; only E'...' gives it escape meaning.
      const prev = i > 0 ? s[i - 1] : "";
      const prev2 = i > 1 ? s[i - 2] : "";
      const backslashEscapes = (prev === "e" || prev === "E") && !/[A-Za-z0-9_]/.test(prev2);
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (backslashEscapes && s[j] === "\\") {
          j += 2;
          continue;
        }
        if (s[j] === "'") {
          if (s[j + 1] === "'") {
            j += 2;
            continue;
          }
          j++;
          closed = true;
          break;
        }
        j++;
      }
      if (!closed) return unreadable("unterminated string literal");
      flushCode();
      parts.push(s.slice(i, j));
      i = j;
      continue;
    }

    if (c === '"') {
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (s[j] === '"') {
          if (s[j + 1] === '"') {
            j += 2;
            continue;
          }
          j++;
          closed = true;
          break;
        }
        j++;
      }
      if (!closed) return unreadable("unterminated quoted identifier");
      flushCode();
      parts.push(s.slice(i, j));
      i = j;
      continue;
    }

    if (c === "$") {
      const m = DOLLAR_TAG.exec(s.slice(i));
      if (m) {
        const tag = m[0];
        const close = s.indexOf(tag, i + tag.length);
        if (close === -1) return unreadable(`unterminated dollar-quoted block ${tag}`);
        flushCode();
        parts.push(s.slice(i, close + tag.length));
        i = close + tag.length;
        continue;
      }
    }

    code += c;
    i++;
  }
  flushCode();
  return { text: parts.join("").trim(), reliable: true, reason: null };
}

const shortHash = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/**
 * Both checksums for one migration file.
 *
 * `checksum` is unchanged from before this task, on purpose: it is the ledger's
 * existing identity, and redefining it would make the first run after this merge
 * print a drift warning for EVERY migration at once — the same desensitisation
 * this task exists to stop. The comment-independent hash is recorded ALONGSIDE
 * it, in `sql_checksum`.
 */
export function checksumsFor(sql) {
  // Hash the NORMALISED text. 001 and 006 are CRLF in the main working tree and
  // LF in any fresh, Linux or CI checkout (.gitattributes pins eol=lf), so
  // hashing raw bytes made setup:db warn that files nobody had touched "had
  // CHANGED" — purely because of where it ran. Normalising line endings and
  // trailing whitespace means the checksum describes the SQL, not the checkout.
  // See R6.4.7 for the mixed-line-endings tree.
  const checksum = shortHash(sql.replace(/\r\n/g, "\n").replace(/\s+$/, ""));

  const stripped = semanticSql(sql);
  // Idempotence is the cheap self-check on the lexer: stripping an already
  // stripped file must be a no-op. If it is not, the lexer has misread
  // something, and a misread file must not be allowed to reassure anyone.
  const reliable =
    stripped.reliable &&
    (() => {
      const again = semanticSql(stripped.text);
      return again.reliable && again.text === stripped.text;
    })();

  return {
    checksum,
    sqlChecksum: reliable ? shortHash(stripped.text) : null,
    strippedReason: reliable ? null : stripped.reason || "the comment stripper could not re-read its own output",
  };
}

/**
 * R6.1.5 — classify a checksum difference instead of asserting a schema drift.
 *
 * Three outcomes, three DIFFERENT sentences, because they are three different
 * facts and collapsing them is the bug:
 *   sql      — the SQL itself changed. The file really does not describe the DB.
 *   comment  — only comment or layout text changed. Say so; claim nothing about
 *              the schema, because nothing about the schema is in question.
 *   unknown  — the row predates `sql_checksum`, or this file could not be
 *              parsed. We do not know which of the two it is, and an unknown
 *              must read as unknown rather than borrow either verdict.
 */
export function classifyDrift({ prior, priorSqlChecksum, checksum, sqlChecksum, strippedReason }) {
  if (!prior || prior === checksum) return { kind: "none" };
  // Absent for either reason — the stripper refused, or a caller passed nothing —
  // is "not known", never "fine".
  if (sqlChecksum === null || sqlChecksum === undefined) {
    return { kind: "unknown", why: strippedReason || "this migration could not be parsed" };
  }
  if (priorSqlChecksum === null || priorSqlChecksum === undefined) {
    return {
      kind: "unknown",
      why: "the ledger row was written before this runner recorded a comment-independent checksum",
    };
  }
  if (priorSqlChecksum === sqlChecksum) return { kind: "comment" };
  return { kind: "sql" };
}

/** The operator-facing line for each verdict. One sentence per fact. */
export function driftMessage(file, verdict, { prior, checksum }) {
  if (verdict.kind === "sql") {
    return (
      `  ! ${file}: the SQL has CHANGED since it was applied (${prior} -> ${checksum}). ` +
      `The file no longer describes what is in the database.`
    );
  }
  if (verdict.kind === "comment") {
    return (
      `  - ${file}: COMMENTS ONLY changed since it was applied (${prior} -> ${checksum}). ` +
      `The SQL is unchanged, so this is not a schema drift.`
    );
  }
  return (
    `  ? ${file}: the file TEXT changed since it was applied (${prior} -> ${checksum}), ` +
    `but whether the SQL changed is UNKNOWN — ${verdict.why}. ` +
    `Diff the file against git before deciding; this run cannot tell you.`
  );
}

async function objectExists(client, { kind, name, signature }) {
  if (kind === "function") {
    // R6.1.12 — match on signature, not just name. A CREATE OR REPLACE that
    // changed a signature and created an overload reads as present under a
    // name-only check. `oidvectortypes(proargtypes)` returns only the input
    // argument types, which are the function's identity. Do not compare an
    // unnamed signature such as "uuid, integer" with
    // pg_get_function_identity_arguments(): that formatter includes parameter
    // names ("p_job_id uuid, p_max_attempts integer") and caused production's
    // real 012 function to be reported missing on 2026-09-22.
    const sig = signature || null;
    if (sig) {
      const { rows } = await client.query(
        `SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = $1
            AND oidvectortypes(p.proargtypes) = $2 LIMIT 1`,
        [name, sig]
      );
      return rows.length > 0;
    }
    const { rows } = await client.query(
      `SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = $1 LIMIT 1`,
      [name]
    );
    return rows.length > 0;
  }
  if (kind === "column") {
    // R6.1.12 — pg_attribute sees columns, which to_regclass and pg_proc
    // cannot. The name is "table.column"; split on the first dot.
    const dot = name.indexOf(".");
    if (dot === -1) return false;
    const table = name.slice(0, dot);
    const column = name.slice(dot + 1);
    const { rows } = await client.query(
      `SELECT 1 FROM pg_attribute a
         JOIN pg_class c     ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = $1
          AND a.attname = $2
          AND a.attnum > 0
          AND NOT a.attisdropped LIMIT 1`,
      [table, column]
    );
    return rows.length > 0;
  }
  if (kind === "bucket") {
    // R1.5.1 — a Storage bucket is a row in storage.buckets, invisible to
    // to_regclass and pg_proc alike.
    const { rows } = await client.query(`SELECT 1 FROM storage.buckets WHERE id = $1 LIMIT 1`, [name]);
    return rows.length > 0;
  }
  if (kind === "constraint") {
    const { rows } = await client.query(
      `SELECT 1 FROM pg_constraint k JOIN pg_namespace n ON n.oid = k.connamespace
        WHERE n.nspname = 'public' AND k.conname = $1 LIMIT 1`,
      [name]
    );
    return rows.length > 0;
  }
  const { rows } = await client.query("SELECT to_regclass($1) AS regclass", [`public.${name}`]);
  return rows[0]?.regclass !== null;
}

function getConnectionString() {
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }

  const password = process.env.SUPABASE_DB_PASSWORD;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;

  if (!password || !url) {
    console.error("\nMissing database credentials.\n");
    console.error("Add one of these to .env.local:\n");
    console.error("  SUPABASE_DB_PASSWORD=your_database_password");
    console.error("  DATABASE_URL=postgresql://postgres:PASSWORD@db.PROJECT.supabase.co:5432/postgres\n");
    console.error("Find the password: Supabase Dashboard → Settings → Database → Database password\n");
    process.exit(1);
  }

  const ref = new URL(url).hostname.replace(".supabase.co", "");

  if (process.env.SUPABASE_DB_HOST) {
    const user = process.env.SUPABASE_DB_USER || `postgres.${ref}`;
    const port = process.env.SUPABASE_DB_PORT || "5432";
    return `postgresql://${user}:${encodeURIComponent(password)}@${process.env.SUPABASE_DB_HOST}:${port}/postgres`;
  }

  // Default: session pooler (direct db.* host is not available on all projects)
  return `postgresql://postgres.${ref}:${encodeURIComponent(password)}@aws-1-ap-southeast-2.pooler.supabase.com:5432/postgres`;
}

async function main() {
  const migrationsDir = join(__dirname, "../supabase/migrations");
  // Apply every .sql migration in filename order (001_, 002_, ...). All
  // migrations are idempotent (IF NOT EXISTS), so re-running is safe.
  const migrationFiles = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const connectionString = getConnectionString();

  console.log("Connecting to Supabase Postgres...");
  const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });

  try {
    await client.connect();
    await client.query(SCHEMA_MIGRATIONS_DDL);

    const { rows: recorded } = await client.query(
      "SELECT filename, checksum, sql_checksum FROM schema_migrations"
    );
    const priorRows = new Map(recorded.map((r) => [r.filename, r]));

    for (const file of migrationFiles) {
      const sql = readFileSync(join(migrationsDir, file), "utf8");
      const { checksum, sqlChecksum, strippedReason } = checksumsFor(sql);

      // A migration edited AFTER it was applied MAY be a silent schema drift.
      // R6.1.5: which of the three it is decides what gets said, because
      // "the file no longer describes what is in the database" was printed for
      // a comment fix that changed no SQL at all, and a warning that cries wolf
      // is a warning the next operator waves through. Loud, and not fatal — the
      // operator decides.
      const priorRow = priorRows.get(file);
      const prior = priorRow?.checksum;
      const verdict = classifyDrift({
        prior,
        priorSqlChecksum: priorRow ? priorRow.sql_checksum ?? null : null,
        checksum,
        sqlChecksum,
        strippedReason,
      });
      if (verdict.kind !== "none") {
        console.warn(driftMessage(file, verdict, { prior, checksum }));
      }

      // One transaction per file. Without this a migration that fails halfway
      // leaves the schema in a state no file describes, and the next run
      // re-applies from the top over that wreckage.
      process.stdout.write(`Applying migration: ${file} ... `);
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(
          // `first_applied_at` is never overwritten, so the ledger keeps when a
          // migration FIRST landed as well as when it was last re-applied.
          // Without it every row carried one timestamp — the last run — and
          // "when did 007 actually reach production" became unanswerable.
          //
          // THE CHECKSUM OVERWRITE BELOW IS ACCEPTED, NOT FIXED. Say it in the
          // present tense, because it is still true: this DO UPDATE replaces
          // the recorded checksum with the new one, so the drift warning above
          // fires ONCE — on the first run after an edit — and the next run is
          // silent. `first_applied_at` does not cover this; it preserves a
          // timestamp, not the prior checksum. Nothing tests the drift path.
          //
          // Accepted because the row is written INSIDE the transaction that
          // just applied this file: after COMMIT the database really does match
          // the new text, and a row still carrying the old checksum would claim
          // the opposite on every subsequent run. Keeping the prior value would
          // need a second column and a rule for which of N prior checksums to
          // keep — a bigger change than this task, and one nothing yet needs.
          // Treat the warning as a one-shot notification, not durable state:
          // `git log` on the migration file is the record that survives.
          //
          // `sql_checksum` is written as NULL when the comment stripper could
          // not read the file, rather than falling back to the full-text hash.
          // A NULL here means "not known", and the next run says so; storing
          // the full hash in that column would make the run after this one
          // compare two different kinds of number and call the answer a fact.
          `INSERT INTO schema_migrations (filename, checksum, sql_checksum, applied_at, first_applied_at)
           VALUES ($1, $2, $3, now(), now())
           ON CONFLICT (filename) DO UPDATE SET
             checksum = EXCLUDED.checksum,
             sql_checksum = EXCLUDED.sql_checksum,
             applied_at = now()`,
          [file, checksum, sqlChecksum]
        );
        await client.query("COMMIT");
        console.log("ok");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        console.log("FAILED");
        throw new Error(`${file}: ${err.message}`);
      }
    }
    // NOT a success sentence, deliberately. Every file executed; whether the
    // DATABASE is correct is what the next section decides. Saying anything
    // conclusive at this point is how the old runner made a broken run look
    // fine — it printed "Migrations applied successfully." and 17 ticks over a
    // database missing four migrations.
    console.log("\nAll migration files executed. Verifying the result...\n");

    console.log("Verifying schema against the catalog:\n");
    let missing = 0;
    for (const [migration, expectations] of Object.entries(EXPECTED_OBJECTS)) {
      const results = [];
      for (const obj of expectations) {
        const exists = await objectExists(client, obj);
        if (!exists) missing++;
        results.push(`${exists ? "✓" : "✗"} ${obj.kind} ${obj.name}`);
      }
      console.log(`  ${migration}`);
      for (const r of results) console.log(`    ${r}`);
    }

    if (missing > 0) {
      console.error(
        `\n${missing} expected object(s) missing. The database is INCOMPLETE — ` +
          `do not read the "All migration files executed" line above as success.`
      );
      process.exitCode = 1;
    } else {
      console.log("\nAll expected objects present.");
    }
  } catch (err) {
    console.error("Migration failed:", err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

/**
 * R6.1.5 — run only when this file IS the command, so the checksum helpers above
 * can be imported and tested without opening a database connection.
 *
 * The dangerous failure of an entrypoint guard is that it silently declines to
 * run and the operator reads exit 0 as "migrations applied", so the mismatch
 * branch below is loud and fatal instead of quiet. The guard itself is exercised
 * on every run of src/lib/migrationsRunner.test.mjs, which spawns this script as
 * a subprocess: if the comparison ever stops matching, those tests go red rather
 * than the runner going quiet in production.
 */
const invokedPath = process.argv[1] || "";
const sameFile = (a, b) => {
  try {
    return pathToFileURL(realpathSync(a)).href === pathToFileURL(realpathSync(b)).href;
  } catch {
    return false;
  }
};

if (invokedPath && sameFile(invokedPath, fileURLToPath(import.meta.url))) {
  main();
} else if (/setup-supabase\.mjs$/i.test(invokedPath)) {
  console.error(
    `Refusing to run: ${invokedPath} was invoked as the entrypoint but does not resolve to ` +
      `${fileURLToPath(import.meta.url)}. Nothing has been applied.`
  );
  process.exit(1);
}
