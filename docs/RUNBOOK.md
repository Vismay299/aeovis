# Operator runbook — symptom → diagnostic

> <!-- doc-status -->
> **Status: LIVE.** Quick-reference for the ten most common production
> symptoms. Each row names what the operator sees and where to look first.

**Date:** 2026-09-15 · **Task:** R6.2.2 (finding S27)

---

## How to use this table

When a customer or an internal check reports a symptom, find it in the table
and follow the "look at" column. Every query and file cited is a SELECT or a
read — nothing in this document writes.

| # | Symptom | Look at | What to check |
|---|---------|---------|---------------|
| 1 | **Dashboard empty — no data at all** | `brand_metrics_daily` row count | `SELECT count(*) FROM brand_metrics_daily;` — zero rows means `upsertBrandMetricsDaily` never ran or the scan pipeline (`/api/scan/worker` cron) never finalized. Check the cron log and `scan_runs.outcome` for the brand. |
| 2 | **Score is 0 %** | `result_brands.score` for the brand | `SELECT score, engine FROM result_brands WHERE brand = '<name>' ORDER BY created_at DESC LIMIT 5;` — all zeros means the scoring engine returned no visible results. Check `prompt_results` for the same queries; if prompt_results are empty the probe fleet never wrote outcomes. |
| 3 | **SOV is 100 %** | `brand_metrics_daily.sov_state` and `.sov_state_reason` | `SELECT sov_state, sov_state_reason FROM brand_metrics_daily WHERE brand = '<name>' ORDER BY date DESC LIMIT 3;` — `NOT_ASSESSED` with reason `self_only_roster` means the brand prompt list contains only the brand itself. Add competitor prompts. `MEASURED_ZERO` with `brand_not_visible` means the brand genuinely got zero mentions — that is a real score, not a bug. |
| 4 | **Costs show $0** | `llmPricing` in `src/lib/llmPricing.js` | The LLM pricing table may lack an entry for the model ID being used. An unpriced model ID fails loud (Standing Rule 5) — check `llm.js` for a thrown `PricingError`. If no error appears, the content pipeline was not invoked. |
| 5 | **Job never runs** | `scan_jobs.status` and `content_jobs.status` | `SELECT status, count(*) FROM scan_jobs GROUP BY status;` — a row stuck in `pending` with no `lease_owner` means the cron sweep (`/api/scan/worker`) did not pick it up. Check `system_heartbeats` for the scan worker tick. For content: `SELECT status, count(*) FROM content_jobs GROUP BY status;` and check the content cron (`/api/content/worker`). |
| 6 | **Probe block spike** | `probe_tasks.outcome = 'blocked'` | `SELECT outcome, count(*) FROM probe_tasks GROUP BY outcome;` — a spike in `blocked` means the probe surface (Perplexity, ChatGPT) returned captcha or login walls. Check `result_brands.raw_answer` for the affected queries; if most are empty or contain captcha text the surface has changed its bot detection. |
| 7 | **Split brand history — duplicate or diverging rows per brand** | `brand_metrics_daily` unique constraint and `scan_jobs` duplicate index | `SELECT brand, date, engine, count(*) FROM brand_metrics_daily GROUP BY brand, date, engine HAVING count(*) > 1;` — duplicates mean `upsertBrandMetricsDaily` failed its upsert key. Check the `prompt_results` table for duplicate `(job_id, engine, query)` rows, which indicates the chunk-idempotency key was violated. |
| 8 | **Content stuck — items never reach "published"** | `content_jobs.status` and `content_items.status` | `SELECT j.status, i.status, j.error_message FROM content_jobs j LEFT JOIN content_items i ON i.job_id = j.id WHERE j.status IN ('pending','generating','running') ORDER BY j.created_at DESC LIMIT 5;` — stuck in `pending` means the content cron never picked it up. Stuck in `generating` with no items means the LLM call failed silently. Check `content_runs.outcome` for the cron heartbeat. |
| 9 | **Citations count is zero** | `citations` table and `result_brands.scan_id` join | `SELECT count(*) FROM citations WHERE brand = '<name>';` — zero citations with non-zero `result_brands` rows means the citation extractor did not run for this brand's scans. Check the scan finalize path in `src/lib/workers/scanWorker.js` for errors during citation extraction. A missing `005_analytics_platform.sql` migration (see `docs/PROD_MIGRATIONS.md`) also causes this. |
| 10 | **Sources count is 0 but domains is 14** | `citations.source` vs `citations.domain` columns | `SELECT count(DISTINCT source) AS sources, count(DISTINCT domain) AS domains FROM citations WHERE brand = '<name>';` — sources are domain+path while domains are domain-only. If sources is zero but domains is non-zero, the `source` column is NULL for all rows, meaning the citation extractor writes `domain` but not `source`. Check the Bright Data response parser in `src/lib/engines/brightdata.js`. |

---

## See also

- `docs/PROD_MIGRATIONS.md` — per-migration verification queries.
- `docs/OPERATOR_LEDGER.md` § C — migration deployment order.
- `docs/runbooks/fleet-dev.md` — probe fleet local development runbook.
- Standing rules in `docs/plans/2026-08-29-rebuild-roadmap.md` § Standing rules.
