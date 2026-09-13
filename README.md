# Perceev — Answer Engine Intelligence

Perceev measures whether AI assistants recommend your brand when buyers ask.

It probes answer engines with a frozen set of **unbranded** buyer prompts — the
prompts never name your brand, so the verdict reflects what buyers actually hear
rather than what vanity queries return — then reports a **share-of-AI** score,
which rivals the engines name instead, which sources they cite, and where the
gaps are. An agent-driven Content Studio turns those gaps into drafted content
behind a mandatory human approval gate.

> Design and product authority live in [`DESIGN.md`](DESIGN.md) (the dark
> "Results Night" visual world) and [`PRODUCT.md`](PRODUCT.md). Active
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

- **Share-of-AI** per engine = prompts where the brand is visible ÷ non-branded
  prompts that produced an answer.
- **Visibility index** = weighted mean across engines that produced enough
  answers to be eligible (`ENGINE_WEIGHTS`, relative and renormalized).
- Visible = mentioned in the answer text **or** cited by domain.
- Coverage / error-rate gates mark a scan `data_source_issue` or
  `insufficient_sample` rather than reporting a misleading number.

### Prompt-set contract

Prompt sets are keyed by **domain** (not the typed brand name), frozen, and only
ever extended additively. A scan aborts loudly rather than silently regenerating
prompts, because scoring a different set of questions would quietly break score
comparability. `prompt_set_id` travels with every scan and every daily rollup so
the UI can mark the point where a tracked set changed.

---

## Tech stack

- **Next.js 14** (App Router, JS) · **Tailwind** + a token-driven CSS design
  system in `src/app/globals.css` (shadcn HSL vars stay mapped)
- **Supabase** (Postgres) — schema in `supabase/migrations/`
- **Engines**: Google AI Overview via Bright Data SERP · ChatGPT via the OpenAI
  Responses API with `web_search` · Perplexity `sonar`
- **Utility LLM**: a free model on any OpenAI-compatible gateway (`LLM_BASE_URL`)
  for prompt generation, competitor extraction, and classification chores
- **Content OS**: a paid model (`CONTENT_MODEL`) with a hard per-item cost cap

---

## Setup

```bash
npm install
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
ENGINES=aio,perplexity
BRIGHTDATA_API_KEY=...        # Google AI Overview
BRIGHTDATA_SERP_ZONE=...      # optional; auto-discovered when omitted
PERPLEXITY_API_KEY=...
OPENAI_API_KEY=...            # required for the `chatgpt` engine

# --- Utility LLM (prompt gen, competitor extraction, classification) ---
# Provider-neutral: any OpenAI-compatible gateway. The model id must be valid
# on THIS gateway (docs/vendors/mimo.md). OPENROUTER_* still works as a
# deprecated alias and warns once.
LLM_API_KEY=...
LLM_BASE_URL=...               # default https://openrouter.ai/api/v1
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

RLS is enabled on every table with permissive anon policies — the app is
currently **single-operator with no authentication**. Add auth before exposing
a deployment publicly.

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
