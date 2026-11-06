# Perceev — Answer Engine Intelligence

Perceev measures whether AI assistants recommend your brand when buyers ask.

It probes answer engines with a frozen set of **unbranded** buyer prompts — the
prompts never name your brand, so the verdict reflects what buyers actually hear
rather than what vanity queries return — then reports a **share-of-AI** score,
which rivals the engines name instead, which sources they cite, and where the
gaps are. An agent-driven Content Studio turns those gaps into drafted content
behind a mandatory human approval gate.

> Design and product authority live in [`DESIGN.md`](DESIGN.md) (the shared
> light visual system) and [`PRODUCT.md`](PRODUCT.md). Active
> engineering plan: [`docs/plans/plan.md`](docs/plans/plan.md).

---

## How a scan works

```
POST /api/scan
  └─ createScanJob → runScanChunk(jobId)          [checkpointed, resumable]
       1. sourcing   — reuse the brand's frozen unbranded prompt set, top up
                       additively only when short of target (free LLM + PAA/
                       autocomplete seeds + site scrape). Frozen into
                       scan_jobs.checkpoint so a resume never regenerates.
       2. probing    — (engine × query) pairs, per-engine concurrency, written
                       incrementally to prompt_results (upsert on
                       job_id+engine+query). Time-boxed per chunk; heartbeats
                       every batch; hands off to the next chunk.
       3. finalize   — reconstruct results from prompt_results.raw, score,
                       extract competitors, insert the scan, materialize
                       citations, roll up brand_metrics_daily.
Client polls GET /api/scan/[job_id]/status — a stale job self-resumes.
```

Because probing is checkpointed, a killed serverless invocation resumes within
minutes instead of stalling: the status poll and the cron sweep both re-enter
the same job by id and skip every `(engine, query)` pair already persisted.

### Scoring

- Versioned metrics (`r05-metric-v1`) carry their numerator, actual denominator,
  distinct eligible prompt IDs, surface and collection coverage. Raw `value_pct`
  is separate from the gated `qualified_pct`; unknown is null with a reason and
  measured zero remains zero.
- A headline requires 95% valid collection and 20 distinct eligible prompts in
  that metric's denominator (`eligibility-policy-v1`). Repeated observations
  do not satisfy the distinct-question minimum. Below the gate, results are
  exploratory or insufficient.
- Valid Google SERPs without an AI Overview count toward collection completion,
  but not the conditional AIO answer denominator. Failed or unattempted captures
  do not count as brand absence.
- Mentions, citations and positive recommendations are distinct measures.
  First textual mention is not recommendation rank. Historical rows retain
  their original scoring/policy versions; this does not requalify old scores.

### Prompt-set contract

Prompt sets are keyed by **domain** (not the typed brand name), frozen, and only
ever extended additively. A scan aborts loudly rather than silently regenerating
prompts, because scoring a different set of questions would quietly break score
comparability. `prompt_set_id` travels with every scan and every daily rollup so
the UI can mark the point where a tracked set changed.

---

## Tech stack

- **Next.js 15.5** (App Router, JS) · **Tailwind** + a token-driven CSS design
  system in `src/app/globals.css` (shadcn HSL vars stay mapped)
- **Supabase** (Postgres) — schema in `supabase/migrations/`
- **Engines**: Google AI Overview via Bright Data SERP · ChatGPT via its configured direct/shared gateway adapter · grounded Gemini via OpenRouter · Perplexity via its configured adapter. API/gateway results are not automatically consumer UI measurements
- **Utility LLM**: a free model on any OpenAI-compatible gateway (`LLM_BASE_URL`)
  for prompt generation, competitor extraction, and classification chores
- **Content OS**: a paid model (`CONTENT_MODEL`) with a hard per-item cost cap

---

## Setup

Use Node.js 22.22 or newer in the 22.x line (`nvm use` reads `.nvmrc`). CI,
the web app and the fleet use Node 22. Install each package from its lockfile:

```bash
npm ci
npm --prefix worker ci
```

Create `.env.local`:

```env
# --- Supabase ---
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
# For running migrations (scripts/setup-supabase.mjs):
SUPABASE_DB_PASSWORD=...
# optional: SUPABASE_DB_HOST / SUPABASE_DB_PORT / DATABASE_URL

# --- Engines (comma-separated; unconfigured engines are skipped) ---
ENGINES=aio,chatgpt,gemini,perplexity
NEXT_PUBLIC_ENGINES=aio,chatgpt,gemini,perplexity
BRIGHTDATA_API_KEY=...        # Google AI Overview
BRIGHTDATA_SERP_ZONE=...      # optional; auto-discovered when omitted
OPENROUTER_OPENAI_MODEL=openai/gpt-6-luna
OPENROUTER_PERPLEXITY_MODEL=perplexity/sonar
OPENROUTER_GEMINI_MODEL=google/gemini-3.8-flash

# --- Utility LLM (prompt gen, competitor extraction, classification) ---
# Provider-neutral: any OpenAI-compatible gateway. The model id must be valid
# on THIS gateway (docs/vendors/mimo.md). OPENROUTER_* still works as a
# deprecated alias and warns once.
LLM_API_KEY=...                # shared key for utility and answer-engine models
LLM_BASE_URL=https://openrouter.ai/api/v1
LLM_MODEL=...                  # default google/gemma-4-31b-it:free

# --- Content OS ---
CONTENT_MODEL=...
CONTENT_MAX_COST_PER_ITEM=0.15

# --- Optional ---
FIRECRAWL_API_KEY=...          # site scrape for prompt gen + research
GSC_SERVICE_ACCOUNT_KEY=...    # Search Console (service-account JSON or base64)
SERP_GEO=in                    # probe geography
PROMPT_TARGET=30               # default tracked-set size for new brands
CRON_SECRET=...                # REQUIRED in production — the ONLY credential for the worker cron routes
```

Apply the schema, then run:

```bash
npm run setup:db
```

```bash
npm run dev
```

> **`CRON_SECRET` matters.** `/api/scan/worker` resumes scans and, via the
> scheduler tick, creates new ones — each costing real SERP and LLM spend. When
> `CRON_SECRET` is set the route requires it (`Authorization: Bearer …`,
> `x-cron-secret`, or `?secret=`). It is left open only when the variable is
> unset, for local development.
>
> The `x-vercel-cron` header is no longer accepted as a credential (R0.1.8) —
> any client can set it. That means the cron entries in `vercel.json`
> authenticate **solely** by `CRON_SECRET`, which Vercel attaches as
> `Authorization: Bearer <CRON_SECRET>` when the variable is set on the
> project. **`CRON_SECRET` MUST be set in the deployment environment or every
> scheduled scan and content batch will 401 and silently never run.**

---

## Database

Migrations are idempotent and applied in filename order by `npm run setup:db`.

| Migration | Adds |
|---|---|
| `001_initial_schema` | `scans`, `brand_prompts`, `scan_jobs`, `content_events` |
| `002_content_os` | `content_jobs`, `content_items`, `content_feedback`, `brand_briefs`, `content_lessons` |
| `003_content_agents` | `content_agents` + agent columns on jobs/items |
| `004_crew_canvas_knowledge` | composable agent pipelines, `knowledge_blocks` |
| `005_analytics_platform` | `prompt_results`, `result_brands`, `citations`, `brand_metrics_daily`, `scan_schedules`, `topics`; job `checkpoint`/`heartbeat_at` |
| `006_agent_control_plane` | agent control-plane tables and the `content_jobs` heartbeat index |
| `007_scan_seal` | unique partial index enforcing one running scan per brand (closes the duplicate-scan race) |
| `008_system_heartbeats` | `system_heartbeats` — the "did the cron actually fire?" record behind `/api/health` |
| `009_scan_rate_limit` | `scan_rate_limits` + the atomic `increment_scan_rate_limit()` behind the free-scan per-IP cap |
| `010_probe_tasks` | `probe_tasks` — the probe fleet's queue — and `claim_probe_tasks()`, the `FOR UPDATE SKIP LOCKED` claim two workers cannot both win |
| `011_scan_runs` | `scan_runs` — one row per execution, fleet or web worker — and `open_scan_run()` / `heartbeat_scan_run()` / `close_scan_run()`, so a measured-zero pass and a never-ran pass leave different evidence |
| `012_scan_job_attempts` | `scan_jobs.attempts` and `claim_scan_job_attempt()` — a job resumed three times without finishing becomes terminal with `max_attempts:` in `error_message`, instead of being re-dispatched by the cron sweep forever |
| `013_brand_metrics_sov_state` | `brand_metrics_daily.sov_state` / `.sov_state_reason` — a stored share of voice now says whether it is a measurement, so a self-only roster records "not assessed" instead of a durable, exportable 100% |
| `014_content_job_checkpoints` | `content_jobs.checkpoint` (new here — the `checkpoint` in the `005` row above is on `scan_jobs`, a different table) — a content job killed mid-run resumes at the next block instead of re-paying for every LLM call it had already made, so a rescued job's recorded cost is what was actually spent once. **Unlike `012`/`013` it ships no index, so `npm run setup:db` cannot verify it** — see `docs/OPERATOR_LEDGER.md` § C |
| `015_brand_metrics_citation_state` | `brand_metrics_daily.citation_denominator` / `.citation_state` / `.citation_state_reason` — a stored citation share now says whether the pool it was divided by was measured (`0` is a real "no opportunities") or is simply unknown on a pre-R2.2.2 scan (`NULL`, never `0`), with a CHECK that will not let the two be stored as the same thing. Verifiable via `brand_metrics_daily_citation_unverified_idx`. **Applied state unverified from this environment** |
| `016_crawlability_audit_history` | `crawlability_audits` — history of robots.txt audits per domain, with per-bot diffs between runs. Enables "Your site started blocking GPTBot on Tuesday" as the first change detector. Verifiable via `crawlability_audits_domain_idx`. **Applied state unverified from this environment** |
| `016_content_items_natural_key` | `content_items` — natural key on `(job_id, cycle)` to prevent duplicate content items when a job crashes and resumes. Verifiable via unique constraint. **Applied state unverified from this environment** |
| `017_cost_unmeasured_calls` | `scans.cost_unmeasured_calls` — counter for pricing calls that fail to resolve a model id. A run where nothing could be priced now looks different from a run that genuinely cost nothing. Verifiable via column existence. Applied to production 2026-09-15 |
| `018_gsc_daily` | `gsc_connections` (brand → Search Console property) and `gsc_daily` (brand × date × query clicks/impressions/ctr/position), filled weekly by cron `/api/gsc/worker` (R4.1.1). Connect flow: `docs/vendors/gsc.md` |
| `019_probe_evidence_bucket` | Private Storage bucket `probe-evidence` (PNG + gzipped HTML per probe, 5 MiB/object) with anon policies scoped to it; 90-day retention by cron `/api/evidence/retention` (R1.5.1). Budget: `docs/runbooks/probe-evidence.md` |
| `020_content_items_key_nulls_not_distinct` | Recreates `content_items_job_id_cycle_key` as `UNIQUE NULLS NOT DISTINCT (job_id, cycle)` so a draft with no job is deduplicated too (R3.5.5). Not deferrable: `ON CONFLICT` refuses a deferrable arbiter. Pre-check + applied-check in `docs/PROD_MIGRATIONS.md` |
| `021_prompt_results_evidence` | `prompt_results.evidence_screenshot_id` / `.evidence_dom_id` / `.evidence_har_id` / `.evidence_raw_id` / `.evidence_captured_at` — the Probe Result Contract v2 §3.7 evidence ids promoted out of `raw`, so an answer row carries the object key in the private `probe-evidence` bucket that R1.5.3 signs a "View evidence" link from (R1.5.2). All nullable: NULL means no capture of that kind, never `''`. **NOT YET APPLIED to production** — see `docs/PROD_MIGRATIONS.md` |
| `022_scan_runs_retention` | `scan_runs_noop_retention_idx` (partial, `WHERE outcome = 'noop'`) and `prune_noop_scan_runs(p_cutoff, p_limit)` — 30-day retention for the fleet's idle rows, run nightly by cron `/api/scan-runs/retention` (R1.2.23). Measured 2026-09-22: 20,399 `probe-fleet` rows, ~8,250/day, on a FREE 500 MB project with nothing pruning them. The `outcome = 'noop'` filter is a literal inside the function, not an argument, so retention cannot reach a non-noop row; open rows (`ended_at IS NULL`) are never deleted. **NOT YET APPLIED to production** — see `docs/PROD_MIGRATIONS.md` |
| `023_customer_auth_and_tenant_rls` | Customer brand memberships, explicit scan workspace keys, legacy operator alias metadata, and row-level security for authenticated customer reads. Customers use Supabase Auth with verified email; GSC authorization is optional during workspace creation. **NOT YET APPLIED to production** — configure the server-only Supabase service-role key first; see `docs/PROD_MIGRATIONS.md` |
| `024_customer_workspace_ownership` | Drops `website_host` UNIQUE constraint, adds `idempotency_key` for retry-safe workspace creation, adds `customer_team_invites` table, adds transactional `create_customer_workspace` RPC, and adds a trigger to prevent removing the last owner. New workspaces use opaque UUID keys. |
| `025_gsc_customer_oauth` | Per-workspace OAuth credentials (`gsc_oauth_credentials`), short-lived OAuth attempts (`gsc_oauth_attempts`), durable sync jobs (`gsc_sync_jobs`), connection generation tracking on `gsc_connections` and `gsc_daily`, and expired attempt pruning. Enables the self-service GSC connector. |
| `026_customer_uat_repairs` | Explicit scan workspace ownership and RLS, generation-aware GSC storage and guarded writes, transactional OAuth activation/disconnect, verified team invite redemption, and sync lease recovery. Apply before deploying the repaired customer routes. |
| `027_durable_probe_dispatch` | Service-only observation/attempt ledger, fenced dispatch claims, shared provider circuits and spend reservations, bounded canaries and audited ambiguity reconciliation. Apply before deploying the P0 worker; see docs/runbooks/p0-provider-dispatch.md. |
| `028_measurement_evidence` | Private response capture metadata and durable parser incident inbox. |
| `029_repair_workflow` | Immutable reviewed panels and sources; exact-content approval and transactional verified publication. |
| `030_scan_finalize_identity` | One report identity per originating scan job, including crash recovery. |
| `031_content_check_budget` | Shared paid-check reservations, fenced completion, and approval guards. |
| `032_durable_schedule_windows` | Atomic scheduled-window enqueue, bounded catch-up, overlap and finalization records. |
| `033_atomic_scan_materialization` | Transactional report links, citations, brand judgments, daily rollups and terminal job state. |
| `034_measurement_storage_contract` | Private JSON response capture MIME support and a read-only storage contract check. |
| `035_scoped_provider_rollout` | Fenced pause/rollback with one owned QA workspace and bounded canaries allowed during qualification. |
| `040_f01_jobs` | `jobs`, `job_steps`, `job_periodic` and the `enqueue_job` / `claim_due_jobs` / `job_step_begin` / `job_step_complete` / `job_step_fail` / `job_sleep` / `job_yield` / `job_progress` / `job_finish` / `cancel_job` / `reconcile_stale_jobs` / `claim_due_periodic` / `prune_jobs` functions behind F01's durable job runner: named steps memoise their output, a lease fences a stale writer, billed steps run once, and a watchdog fails a job past its deadline or invocation limit. Customers may read their own workspace's jobs only. **NOT YET APPLIED to production** — see `docs/PROD_MIGRATIONS.md` |
| `041_f01_spend` | `paid_feature_controls`, `workspace_spend_limits`, `spend_holds`, `spend_ledger` and the `reserve_spend` / `settle_spend` / `release_spend` / `expire_spend_holds` / `f01_expire_due_holds` / `prune_spend` / `f01_committed_usd` functions behind F01's spend guard: an estimate becomes a hold, the call settles on its recorded cost, and caps are enforced per feature and per workspace. Every paid feature ships disabled. **NOT YET APPLIED to production** — see `docs/PROD_MIGRATIONS.md` |
| `042_f01_provider_cache` | `provider_cache` plus `prune_provider_cache` behind F01's provider cache: soft-TTL schema-validated rows inline up to 256 KB, larger bodies in the private Storage bucket `provider-cache`. Every record ships enabled-neutral (a cache, not a paid feature). **NOT YET APPLIED to production** — see `docs/PROD_MIGRATIONS.md` |
| `043_f01_jobs_cron` | `jobs_tick_http()` plus the `perceev-jobs-tick` pg_cron schedule that POSTs to `/api/jobs/tick` every minute with the `Authorization: Bearer` header built from the Vault secrets `perceev_jobs_tick_url` and `perceev_cron_secret`. Applies without `pg_cron`/`pg_net` (CI, local QA) and only installs the schedule where both extensions exist; the file itself holds no secret. **NOT YET APPLIED to production** — the owner creates the two Vault secrets first; see `docs/PROD_MIGRATIONS.md` |
| `050_f03_cost_ledger` | Per-answer cost ledger extensions (`subject_kind`, `subject_id`, `answer_ref`, `price_version` on `spend_ledger`), `cost_reconciliations` table, periodic attempt sync, scan hold settlement, and operator reconciliation functions. **NOT YET APPLIED to production** — see `docs/PROD_MIGRATIONS.md` |
| `051_f03_usage` | Read functions for the customer Usage page and the operator cost view: `workspace_usage_days` (spend binned by the viewer's local day and feature), `workspace_spend_position` (today and month spend, the workspace caps, the open holds) and `operator_costs_by_workspace` / `operator_costs_by_endpoint`. Service role only — every function is revoked from `PUBLIC`, `anon` and `authenticated`. **NOT YET APPLIED to production** — see `docs/PROD_MIGRATIONS.md` |
| `070_f07_project_memory` | Project memory tables, retention index, URL-parser IPv4 competitor guards, job-linked research, and retry-safe brief claims. |
| `080_f09_price_approvals` | `scan_jobs.approved_max_usd` / `price_quote` columns, `price_approvals` table with RLS, and `prune_price_approvals` retention function behind F09's price approval enforcement. **NOT YET APPLIED to production** — see `docs/PROD_MIGRATIONS.md` |
| `165_f26_privacy_and_telemetry_ids` | Opaque workspace ids for analytics groups; per-user analytics consent. | **NOT YET APPLIED to production** — see [`docs/PROD_MIGRATIONS.md`](docs/PROD_MIGRATIONS.md). |
| `155_f24_signup_guard` | Refuses disposable email domains at account creation through the Supabase Before User Created hook; invited addresses pass. **NOT YET APPLIED to production** — see `docs/PROD_MIGRATIONS.md` |
| `085_f10_customer_schedules` | Customer-managed scan schedules: interval, approved maximum, skip reasons; start/block window functions; legacy path ignores customer rows. **NOT YET APPLIED to production** — see `docs/PROD_MIGRATIONS.md` |
| `075_f08_workspace_questions` | Stable question identity under reviewed panels: questions, settings, events, normaliser. **NOT YET APPLIED to production** — see `docs/PROD_MIGRATIONS.md` |
| `076_f08_question_backfill` | One-time import of existing panel versions into workspace questions. **NOT YET APPLIED to production** — see `docs/PROD_MIGRATIONS.md` |

Migration 005 is the analytics foundation: one row per prompt×engine, one row
per cited URL, and a daily rollup per brand/day/engine that powers every trend.

Backfill historical scans into the normalized tables (idempotent, safe to
re-run, supports `--dry-run`):

```bash
node --env-file=.env.local scripts/backfill-analytics.mjs --dry-run
```

The backfill needs `015` applied first (it reads and writes those three
columns, and fails loudly naming the migration if they are absent). Its
"Citation denominator (R4.3.3)" report block is the record of what it could and
could not reconstruct: how many engine slices already carried a denominator,
how many were re-derived from surviving per-prompt rows, how many were a
measured zero, and how many are genuinely unrecoverable and were therefore
stored as unmeasured rather than as `0`.

Customer access uses tenant membership checks and the RLS policies in migrations 023–026. Older migrations contain permissive policies; do not infer production isolation from an old schema alone. Customer login,
invites, and tenant-scoped reads are implemented; production customer access
still depends on applying `023_customer_auth_and_tenant_rls` and configuring
`SUPABASE_SERVICE_ROLE_KEY` before deploying that migration.

---

## Scripts

| Command | What |
|---|---|
| `npm run dev` / `build` / `start` | Next.js |
| `npm run setup:db` | Apply all migrations, then verify every expected table |
| `npm run test:scoring` | Unit suite (scoring, engines, db, workers, content) |
| `npm run test:prompts` | Live prompt-generation smoke test |
| `npm run test:gsc` | Search Console connectivity check |
| `scripts/backfill-analytics.mjs` | Explode historical scans into analytics tables |

---

## Project layout

```
src/
  app/            App Router pages + /api routes
  components/     perceev/ (bespoke design system) · dashboard/ · studio/ · landing/
  lib/
    workers/      scanWorker.js — the checkpointed chunk worker
    scoring/      engine pipeline, prompt gen, judging, aliases, citations
    db/           analytics.js (005 tables) · prompts.js · content.js
    content/      Agent Content OS — steps, skills, agents, briefs
  services/api.js Client data layer
supabase/migrations/
docs/plans/       Dated implementation plans
```

## Local product acceptance

Open `/demo` to run a clearly labelled mock scan and configure a demo agent
on the crew canvas. Mock answers never enter customer history or call vendors.

`node scripts/verify-local-product.mjs` runs the real scan worker and scoring
against fixed four-engine fixtures.
`node --env-file=.env.local scripts/verify-local-product.mjs --live --content`
runs a 30-question Italica scan on all four configured providers and a real
content pipeline to human review. This uses provider credits; all persistence
is isolated in memory and the result is saved to `/tmp/aeo-local-acceptance.json`.
Customer browser testing additionally requires a signed-in local customer session
and `SUPABASE_SERVICE_ROLE_KEY` in the local server environment.

## Repair acceptance and release qualification

PR #8 implemented public indexing policy and the offline repair harness. The
R20–R21 follow-up adds methodology/use-case pages, browser acceptance and
commit-bound external evidence. Engineering checks passing does not mean the
release is qualified. See [the P2 runbook](docs/runbooks/p2-release-qualification.md)
for commands, the evidence schema, deployment checks and rollback, and
[the current status](docs/audits/2026-10-20-p2-qualification.md) for outstanding cases.

```bash
npm run qa:repair -- --repair R20 --suite offline --output
npm run qa:repair -- --repair R21 --suite offline --output
# Against a production build served locally, with placeholder Supabase config:
npx playwright install chromium
npm run qa:public-browser -- http://127.0.0.1:3328
# Exit 1 is expected until every required suite has current passing evidence:
npm run qa:repair -- --repair R20 --suite release --environment qa \
  --evidence test_reports/public-browser/evidence.json --output
```

The browser job uses Chromium and 1440px/390px viewports. CI retains JSON,
assertion logs and screenshots as an artifact. Offline tests require no provider
credentials. The release command accepts reviewed external evidence for D/B/L/M/S
cases and runs U/I itself; missing, blocked, skipped or failing cases keep it
unverified. A synthetic browser run cannot qualify live capture or human review.
