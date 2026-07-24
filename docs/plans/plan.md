# Perceev Analytics Platform — Competitive Parity Plan

**Date:** 2026-07-23
**Status:** Reviewed — reviewer-agent findings (19 defects) incorporated. Pending user go/no-go.
**Owner:** Orchestrator (main session) · Developer agent (execution) · Reviewer agent (gates)

---

## 1. Goal

Close the analytics gap between Perceev and the answer-engine-intelligence incumbents
(Profound, Peec AI, RadarKit). Today Perceev produces a single-scan snapshot with a
share-of-AI score, verbatim answers, rivals, sources, and the Content Studio. The
competition delivers **time-series analytics, per-prompt intelligence, citation/source
intelligence, sentiment themes, gap analysis, crawlability audits, GSC integration,
and a typed action layer (content / outreach / Reddit agents)** — all in clean,
dense, filterable UIs.

This plan turns Perceev from "scan tool with a content studio" into a full
answer-engine analytics platform, while respecting our locked contracts:

- 30 unbranded prompts per scan; frozen, domain-keyed prompt sets; additive tier upgrades.
- Fail-loud (no silent fallbacks that fake data).
- Free OpenRouter model for classification/generation chores; paid models only where
  quality demands it (Content OS drafting, theme distillation if needed).
- Dark-only "Results Night" design world — `PRODUCT.md` / `DESIGN.md` are authority.
  Competitor UIs are light-mode; we adapt their *information design*, not their skin.

---

## 2. Competitive feature inventory (from teardown screenshots)

### Profound (platform.tryprofound.com)
| Feature | Detail |
|---|---|
| Overall Visibility Score | Time series (daily), delta, date-range + granularity selectors |
| Visibility Rank | Ranked table: you + competitors, visibility % each, "Owned" badge |
| Share of Voice | Separate metric from visibility; own trend, rank table, donut |
| Topic Performance | Per-topic: rank, visibility %, citation share |
| Sentiment | Positive-% trendline + LLM-distilled positive/negative theme headlines + themes table (theme → sentiment → occurrences) |
| Citations | Earned vs Social split bar; Top Citation Domains (rank, category, share, delta); export 4.2k citations |
| Agent Analytics | Connect domain → see how AI bots crawl/index your site |
| Opportunities | **Typed**: Outreach (pitch a named journalist at a cited domain, with their citation count), Content Optimization (specific URL + structural fixes: FAQ schema, comparison tables), Content Creation (net-new asset per topic). Each card carries a "Current Performance" evidence chip |
| Prompt quota | "9/100 used" framing; Manage Prompts |
| IA | Sidebar: Analytics (Overview, Answer Engine Insights, Prompt Volumes, Agent Analytics) / Action (Opportunities, Content, Brand Hub). Tabs: Visibility, Prompts, Platforms, Regions, Personas, Shopping, Sentiment, Citations |

### Peec AI (app.peec.ai)
| Feature | Detail |
|---|---|
| Prompt table | Per prompt: visibility % + Δ, sentiment 0–100 + Δ, avg position #x.x + Δ, per-model presence icons, 1–5 search-volume band, branded/non-branded, intent (transactional/informational), tags, location, SOV % + Δ, web-search % + Δ. States: Active / Suggested / Archived |
| Topics | Prompt grouping with per-topic rollups: Topic Visibility, Topic Sentiment, Topic Position, Topic Web Search |
| Sources → URLs | URL movers (Top / New / Trending / Losing, retrieval counts), URL-types donut (Listicle 41%, Comparison, Product Page, Homepage, Article, Category, Alternative), full URL table: URL type, domain type (Editorial / Institutional / Corporate / Reference), brand-mentioned Y/N, mentions, retrievals + Δ, citation rate, updated recency |
| Gap analysis | "Domains where competitors are mentioned but your brand is not" — Gap score 0–100, domain type (incl. Competitor / UGC), retrieval %, citation rate; Domains / Hosts / URLs tabs |
| Brand Insights | Narrative headline verdict ("You're #2 in AI Visibility — Microsoft leads…"), KPI row (Visibility, Sentiment, Position, SoV, Strongest model, Weakest model), dual-axis trend, **Performance matrix heatmap** (brands × AI models, switchable axes) |
| Crawlability | robots.txt audit: ~48 AI bots (GPTBot, anthropic-ai, Google-Extended, …) with bot type (training/search/agent), platform, status (Open/Partial/Blocked); URL tester; compare vs competitors |
| IA | General (Overview, Prompts, Fanouts) / Sources (Domains, URLs, Gap analysis) / Brand (Insights) / Actions (Earned·Off-page, Owned·On-page, Impact) / Agent analytics (Crawl insights, Crawlability) |

### RadarKit (radarkit.ai)
| Feature | Detail |
|---|---|
| Prompt drilldown | Per-prompt page, tabs Overview / Responses / Citation Data, 6 engines, "vs previous 7 days", geo flag, **Rerun Prompt** |
| Content Type Distribution | "94% of citations come from these 5 content types" — Listicle 55.7%, Product/Tool 18.8%, Social 10.9%, Forum 6.3%, Comparison 2.6% — with per-type **Leaders** (who wins each format) |
| Citation Rank | "#12 — your domain's rank among AI-cited sources" + top cited sources w/ counts + share; export 467 URLs |
| Offerings (ignore pricing) | Track all models, **Content Agent, Outreach Agent, Reddit Agent, Chat Agent**, **GSC integration**, 72h → daily refresh cadence, 50+ locations, AI Traffic Analytics, GA4 integration, Query Fanouts |

### Cross-tool patterns (the real spec)
1. **Time-series first** — everything is a daily trend with deltas, not a snapshot.
2. **Competitors are symmetric** — every metric is computed for rivals too (rank tables, SOV, matrix).
3. **Topics** are the grouping unit for prompts and rollups.
4. **Citations are a first-class dataset** — typed (content type, domain type, earned/owned/social), ranked, trended, exportable.
5. **Gap analysis** converts citations into a prioritized to-do list.
6. **Sentiment** = score trend + distilled themes with evidence counts.
7. **Crawlability** = cheap server-side robots.txt intelligence.
8. **Action layer** — typed opportunities with evidence chips, feeding agents.
9. **Refresh cadence** (72h/daily) is a product tier axis.
10. Dense, filterable tables: date range, engine/platform, topic, tags — everywhere.

---

## 3. Gap matrix — Perceev today vs target

| Capability | Today | Target (phase) |
|---|---|---|
| Trend analytics | ❌ per-scan snapshot; history strip with deltas | Daily rollups + trend charts (P1) |
| Scheduled re-scans | ❌ manual only; daily rescue cron | `scan_schedules` + cadence config (P0) |
| Competitor symmetric scoring | ⚠️ competitors detected in text only (`findCompetitorsInText`) | Per-rival mention/position/sentiment per answer (P1) |
| Share of Voice | ❌ (share-of-AI ≠ SOV) | SOV metric + rank (P1) |
| Performance matrix | ❌ | Brands × engines heatmap (P1) |
| Narrative verdict | ⚠️ static verdict module on landing | Metric-driven headline sentence (P1) |
| Sentiment in pipeline | ❌ `judge.js` has `detectSentiment` but the live v9 path imports only `detectMention` — sentiment is NOT computed today | Wire into `enginePipeline` (P1), surface (P4) |
| In-answer position | ❌ only `brand_organic_position` (AIO SERP rank) exists | New computation, defined in P1 |
| Topics | ⚠️ `brand_prompts.topic` text column populated by promptGen; `topics.js` helpers used server-side; nothing in UI | Topics table reconciled with existing column + rollups + filters (P2) |
| Per-prompt metrics table | ⚠️ QueryManager = CRUD only | Full metric table + drilldown + rerun-one (P2) |
| Suggested prompts | ❌ generation exists, coupled to scan-time top-up (persists `enabled:true` immediately) | Contained suggested queue, approval = tier raise (P2) |
| Citation typing | ⚠️ domains aggregated, untyped | content_type + domain_type + earned/owned/social (P3) |
| URL-level source intel | ❌ domains only | URL table, movers, content-type leaders (P3) |
| Gap analysis | ⚠️ implicit in AnswersView gap rows | Domain/URL gap tables + gap score (P3) |
| Sentiment UI | ❌ | Score trend + themes + summaries (P4) |
| Crawlability | ❌ | robots.txt audit + URL tester + rival compare (P5) |
| GSC integration | ⚠️ `src/lib/engines/gsc.js` built (service-account, query-level), unwired; no date dimension yet | Wire per-brand, add date dimension, organic-overlap column, AI-vs-organic view (P6) |
| Exports | ⚠️ print stylesheet only | CSV exports: answers, citations (P6) |
| Typed opportunities | ⚠️ one-line LLM recs | Typed cards w/ evidence chips (P7) |
| Outreach agent | ❌ | Author extraction + pitch, as `content_agents` base (P7) |
| Reddit agent | ❌ | Thread finder + human-in-loop drafts, as `content_agents` base (P7) |
| Chat agent | ❌ | Deferred — open question |
| Shareable dashboards | ❌ sessionStorage transport | Server-loaded by brand/scan id (P0) |

---

## 4. Phase 0 — Platform foundation (prerequisites everything else stands on)

The current storage model (one `raw_results` JSONB blob per scan, duplicated into
`scan_jobs.run_record`, ferried to the browser via sessionStorage) cannot power
trend charts, per-prompt tables, citation intelligence, or competitor symmetry.
Fix the foundation first. **Order inside P0 matters — packages are numbered.**

### P0.0 — Job-store rewrite in `src/lib/db.js` (hard prerequisite)

Today's job store poisons any checkpoint design (reviewer finding D4):

- `updateScanJob` (db.js:343-373): if the job is in `global.memoryJobs`, the DB is
  **never written** (early return). A single transient DB failure inserts the job
  into `memoryJobs`, after which all further updates are memory-only on that
  instance — checkpoints would silently stop persisting, and the next chunk
  invocation (different instance) resumes stale, reprocessing work.
- `getScanJob` (db.js:326-336) is memory-first, so polls landing on a poisoned
  warm instance report stale status.

**Work:** make `getScanJob`/`updateScanJob` DB-authoritative and fail-loud. A DB
write failure surfaces as a job error — it never falls back to memory. Memory maps
remain ONLY for the fully-Supabase-less dev mode (decided once at startup, not
per-call). Same treatment for the content-job twins. Add heartbeat writes.
`hasActiveScanForBrand` switches from its 15-min `created_at` window (db.js:288 —
breaks under long chunked scans, D13) to heartbeat-based staleness.

### P0.1 — Normalized schema — migration `005_analytics_platform.sql`

```sql
-- One row per prompt × engine per scan.
-- brand columns EVERYWHERE store resolveBrandKey() output (domain-first key),
-- never the typed display name — display name lives on scans/scan_jobs (D7).
CREATE TABLE IF NOT EXISTS prompt_results (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  job_id uuid NOT NULL,                -- scan_jobs.id — chunks write against this
  scan_id uuid REFERENCES scans(id) ON DELETE CASCADE,  -- stamped at finalize (D3)
  brand text NOT NULL,
  prompt_id uuid,
  query text NOT NULL,
  engine text NOT NULL,                -- aio | chatgpt | perplexity
  answered boolean,
  mentioned boolean,
  brand_cited boolean,
  position numeric,                    -- in-answer position (defined in P1.1); null if unlisted
  sentiment int,                       -- 0-100 (mapping defined in P1.1); null when not mentioned
  intent text,
  is_branded_query boolean DEFAULT false,
  answer_text text,
  raw jsonb,                           -- engine extras (organic rank, refs, errors)
  created_at timestamptz DEFAULT now(),
  UNIQUE (job_id, engine, query)       -- chunk idempotency: re-runs upsert, never duplicate (D5)
);
CREATE INDEX IF NOT EXISTS prompt_results_brand_idx ON prompt_results (brand, created_at);
CREATE INDEX IF NOT EXISTS prompt_results_scan_idx ON prompt_results (scan_id);

-- Per-answer brand mentions: you AND every tracked rival (symmetric scoring)
CREATE TABLE IF NOT EXISTS result_brands (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  result_id uuid REFERENCES prompt_results(id) ON DELETE CASCADE,
  scan_id uuid,
  brand text NOT NULL,                 -- tenant key (resolveBrandKey)
  name text NOT NULL,                  -- the mentioned brand (display)
  is_self boolean DEFAULT false,
  mentioned boolean,
  position numeric,
  sentiment int
);
CREATE INDEX IF NOT EXISTS result_brands_scan_idx ON result_brands (scan_id, name);

-- One row per cited URL per result
CREATE TABLE IF NOT EXISTS citations (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  result_id uuid REFERENCES prompt_results(id) ON DELETE CASCADE,
  job_id uuid,
  scan_id uuid,
  brand text NOT NULL,
  engine text,
  url text NOT NULL,
  domain text NOT NULL,
  rank int,                            -- order in the engine's reference list
  content_type text,                   -- listicle|comparison|product|social|forum|article|homepage|category|alternative|other
  domain_type text,                    -- editorial|corporate|reference|competitor|ugc|social|institutional|owned
  citation_class text,                 -- earned|owned|social
  is_self boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS citations_brand_domain_idx ON citations (brand, domain);
CREATE INDEX IF NOT EXISTS citations_scan_idx ON citations (scan_id);

-- Daily rollups powering every trend chart
CREATE TABLE IF NOT EXISTS brand_metrics_daily (
  brand text NOT NULL,
  date date NOT NULL,
  engine text NOT NULL DEFAULT 'all',
  visibility_pct numeric,
  sov_pct numeric,
  sentiment_avg numeric,
  position_avg numeric,
  citation_share_pct numeric,
  prompts_total int,
  prompts_answered int,
  prompts_mentioned int,
  scan_id uuid,
  prompt_set_id text,                  -- contract-mandated "prompt list changed" marker (D14)
  PRIMARY KEY (brand, date, engine)
);

-- Recurring cadence + per-brand prompt target (replaces global PROMPT_TARGET slice, D10)
CREATE TABLE IF NOT EXISTS scan_schedules (
  brand text PRIMARY KEY,              -- resolveBrandKey
  display_name text,
  cadence text NOT NULL DEFAULT '72h', -- 72h | daily | weekly | off
  enabled boolean DEFAULT true,
  engines text,
  geo text DEFAULT 'in',
  prompt_target int DEFAULT 30,        -- raised on suggested-prompt approval (additive tiers)
  last_run_at timestamptz,
  next_run_at timestamptz,
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS topics (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  brand text NOT NULL,
  name text NOT NULL,
  UNIQUE (brand, name)
);
ALTER TABLE brand_prompts ADD COLUMN IF NOT EXISTS topic_id uuid;
ALTER TABLE brand_prompts ADD COLUMN IF NOT EXISTS status text DEFAULT 'active';  -- active|suggested|archived
ALTER TABLE brand_prompts ADD COLUMN IF NOT EXISTS search_volume_band int;
ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS checkpoint jsonb;
ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz;          -- rescue staleness (D8)

-- RLS: house style until auth lands — every new table gets ENABLE ROW LEVEL
-- SECURITY + an "Allow anon all" policy, matching 001:107-138 / 004 (D6).
```

Later-phase migrations get numbers now: `006_sentiment_themes.sql` (P4 `themes`),
`007_crawlability.sql` (P5 `crawlability_audits`), `008_gsc.sql` (P6
`gsc_connections`, `gsc_daily`), `009_opportunities.sql` (P7 `opportunities`).

**Backfill** `scripts/backfill-analytics.mjs`: explode historical
`scans.raw_results.results` (rows carry engine, prompt, intent_tier, topic,
is_branded_query, full text, ordered references with domain → rank) into the new
tables; **recompute** mention deterministically and sentiment/position via the
P1.1 modules from stored text; normalize historical `scans.brand` display strings
through `resolveBrandKey`; materialize `brand_metrics_daily` (one row per
scan-day; `prompt_set_id` from raw_results).

### P0.2 — Resumable chunk worker

Replace run-to-completion `startScanJob` with **checkpointed chunks**:

1. `runScanChunk(jobId)`: load job + checkpoint → process the next slice of
   (engine × query) work within a ~240s budget → **upsert** results into
   `prompt_results`/`result_brands`/`citations` keyed by `(job_id, engine, query)`
   → save checkpoint + progress + `heartbeat_at`. Engines run in parallel inside
   a chunk with existing per-engine concurrency caps.
2. **Poll-driven advancement is the primary mechanism** (D17): the status route
   (`force-dynamic`, already polled every 2s) re-kicks `runScanChunk` when
   `heartbeat_at` is stale (> 3 min). The fire-and-forget self-`fetch` after each
   chunk is an optimization only — correctness never depends on it (a frozen
   instance drops it).
3. **Cron rescue resumes, never restarts** (D5): `/api/scan/worker` switches from
   `startScanJob(job.id, …)` (today restarts probing from query 0 —
   worker/route.js:39-50) to `runScanChunk(job.id)`. Cron also becomes the
   scheduler tick: enqueue scans for due `scan_schedules` brands.
4. **Finalize is fail-loud** (D16): scoring + `insertScan` + stamping `scan_id`
   onto the job's normalized rows happen in the last chunk. `insertScan` loses its
   silent column-dropping cascade; a failed finalize marks the job `error` — never
   `complete` with `result_id: null` (today scanWorker.js:375-381 swallows this).
5. **Provider throttling is DB-backed** (D12): an in-process semaphore can't span
   serverless instances. Concurrent-chunk admission checks active jobs per
   provider via `scan_jobs` (heartbeat-fresh count) — same pattern as
   `hasActiveScanForBrand`.
6. Worker + status routes export `maxDuration` (none set anywhere in the repo
   today) sized to plan limits; verify Fluid Compute is enabled (open Q6).

### P0.3 — Server-backed dashboard + client handoff (sequenced!)

**Order inside this package (D11):**
1. New endpoints first: `GET /api/scans/[brand]/latest`, `GET /api/scans/by-id/[scanId]`
   (canonical normalized shape — `normalizeResult` moves server-side).
2. New routes `/dashboard/[brand]` and `/dashboard/[brand]/[scanId]`; the existing
   single-page shell's state tabs become nested views; old `/dashboard?view=…&item=…`
   deep links redirect (Studio links in the wild depend on them). This is a real
   shell refactor — its own work package, not a bullet.
3. Migrate `runScan` (services/api.js) to complete via `result_id` + fetch-by-id.
   Only THEN stop duplicating `run_record` into `scan_jobs` — today the client
   hard-fails without it (`api.js:753` throws "Scan finished but no record was
   returned").
4. sessionStorage: one-time migration read → redirect to `/dashboard/[brand]`,
   then clear. The v7 co-mention fallback stays server-side for pre-P0 scans only.

### P0.4 — Paginated APIs + schedule endpoint

```
GET /api/brands/[brand]/metrics?from&to&engine        → brand_metrics_daily series
GET|PUT /api/brands/[brand]/schedule                  → cadence + prompt_target
GET /api/brands/[brand]/prompts/metrics?scan|range    → per-prompt rows (P2 consumes)
GET /api/brands/[brand]/citations?scan|range&group=domain|url|type   (P3)
GET /api/brands/[brand]/gaps?level=domain|url         (P3)
GET /api/brands/[brand]/sentiment?range               (P4)
GET /api/brands/[brand]/crawlability                  (P5)
GET /api/brands/[brand]/export?kind=answers|citations (P6)
```
All brand-scoped (resolveBrandKey), all paginated; list endpoints never return
`raw_results`.

**Acceptance (P0):** job store is DB-authoritative + fail-loud with heartbeats;
new scan writes normalized rows idempotently chunk by chunk and survives a killed
invocation (resume < 5 min via poll rescue, verified by test); cron rescue resumes
instead of restarting; historical scans backfilled with normalized brand keys;
dashboard loads by URL with zero sessionStorage reads and old deep links redirect;
scheduled brands re-scan on cadence; `npm run test:scoring` green + new worker
checkpoint/idempotency tests.

---

## 5. Analytics phases

### Phase 1 — Time-series core + competitor symmetry
- **P1.1 — Sentiment + position modules (new pipeline computation, D1/D2).** The
  live v9 path imports only `detectMention` (enginePipeline.js:6); `judge.js`'s
  `detectSentiment`/`judgeDeterministic` are dead in the scan path (only
  probe.js/test_calibration use them). Work:
  - Wire per-answer sentiment into `enginePipeline` for self + every tracked
    rival: deterministic pass (adapted `detectSentiment`) with optional free-LLM
    batch refinement (one call scores all brands per answer). **Numeric mapping
    defined:** positive=100, neutral=50, negative=0 per probe; `sentiment` =
    mean across probe runs; engine/day averages from rollups (Peec-style 0–100).
  - **Position defined:** rank of a brand's first alias occurrence among the
    ordered distinct brand mentions in the answer text (1 = first brand named);
    null when unlisted. `brand_organic_position` stays separate (AIO SERP rank).
- **P1.2 — Symmetric judging → `result_brands`**: extend the existing
  `findCompetitorsInText` alias machinery (enginePipeline.js:170-178) to emit
  mention/position/sentiment per rival per answer.
- **P1.3 — Rollups** `src/lib/scoring/rollups.js`: visibility (share-of-AI,
  definition unchanged — `ENGINE_WEIGHTS`/`computeHeadline` untouched per
  contract), **SOV** = self mentions ÷ all brand mentions, position avg,
  sentiment avg — per engine + blended → `brand_metrics_daily` (with
  `prompt_set_id`).
- **P1.4 — Overview v2 UI** (Results Night idiom):
  - Visibility trend chart (dark SVG line; teal = you; rivals on compare toggle
    in red; dashed threshold line), date-range + granularity selector, Δ chips.
  - Rank table: you + rivals, visibility % + Δ, teal "YOU" tag.
  - SOV block: score + rank + donut.
  - **Performance matrix** (brands × engines): **self row uses the teal ramp;
    rival rows use a neutral luminance ramp** — teal/red are role colors and
    never encode magnitude for rivals (DESIGN.md role rule, D15).
  - **Narrative verdict**: deterministic template over metrics ("You're #2 in AI
    visibility — {leader} leads. Strongest: {engine}. Weakest: {engine}.");
    optional free-LLM polish, fail-loud to template.
- Chart infra: one shared `<TrendChart>`/`<Heatmap>`/`<Donut>` set (hand-rolled
  SVG or recharts token-styled — Developer proposes, Reviewer approves; no
  default-styled chart lib output allowed).

### Phase 2 — Prompts & Topics intelligence
- **Topics reconciliation (D17):** `brand_prompts.topic` (text) is already
  populated per angle by promptGen (lines 83-85). Seed the `topics` table from
  distinct existing values per brand, map `topic_id`, keep the text column as
  legacy read-only. Free-LLM merge pass groups near-duplicate topic strings.
  Topics are metadata — prompt texts never mutate; `prompt_set_hash` (sorted
  lowercase texts, scanWorker.js:324-329) unaffected.
- Per-topic rollups: visibility, sentiment, position, citation share.
- **Prompt metrics table** (QueryManager successor): per prompt — visibility %
  + Δ, sentiment + Δ, position + Δ, engine presence icons, intent,
  branded/non-branded, SOV, organic-overlap % (P6 fills), volume band
  (heuristic from PAA/autocomplete presence, 1–5), status chips. Filters: topic,
  engine, intent, status. CRUD preserved.
- **Suggested prompts — containment rules (D9/D10):**
  - Suggested rows are inserted `enabled=false, status='suggested'` — they must
    NEVER enter the scan set silently. `sourceUnbrandedQueries` (today filters
    only branded rows, scanWorker.js:114-121; `getPromptsForBrand` returns all
    enabled) additionally filters `status='active'`.
  - `upsertPrompts` conflict logic (prompts.js:75-91) learns to preserve `status`.
  - **Approval mechanism:** flips `enabled=true, status='active'` AND increments
    `scan_schedules.prompt_target` — sourcing slices to the per-brand target
    (global `PROMPT_TARGET` env becomes the default for new brands only).
    Without the target raise, an approved 31st prompt sits past the slice and is
    never scanned. Score continuity surfaces via the `prompt_set_id` marker.
- **Prompt drilldown** `/dashboard/[brand]/prompts/[id]`: metric header, response
  history per engine (verbatim, brand-highlighted), citations, **Rerun prompt**
  (single-query mini-job through the chunk worker).

### Phase 3 — Citations, sources & gap analysis
- **Citation enrichment** (post-scan chunk): `content_type` — heuristics first
  (URL/title patterns: "best/top N" → listicle, "vs|compare" → comparison,
  reddit/youtube → social/forum, path shape → product/category/homepage),
  free-LLM batch for the remainder, cached by (domain, path-hash). `domain_type`
  — static registry + owned (brand domain) + competitor (tracked rival domains)
  + free-LLM fallback. `citation_class` — owned / social (registry) / earned.
- **Sources views**: Domains (rank, share %, Δ, category chip, earned/owned/social
  split bar) · URLs (type, domain type, mentioned Y/N, retrievals + Δ, citation
  rate, last seen) · **URL movers** (Top / New / Trending / Losing vs previous
  period) · **Content-type distribution** with per-type leaders · **Citation
  rank** ("your domain is #N among AI-cited sources").
- **Gap analysis**: domains & URLs where ≥1 rival is mentioned/cited and you are
  not; `gap_score` = normalized(retrieval share × rival presence × citation
  rate) 0–100. Row actions → "Generate content" / "Pitch outreach" (P7 feeds).

### Phase 4 — Sentiment & themes (UI)
- Pipeline work landed in P1.1; this phase is rollout + distillation.
- **Theme distillation** (per scan; free-LLM first, `CONTENT_MODEL` fallback if
  review fails): cluster mention contexts into named themes with sentiment +
  occurrence counts + verbatim evidence → `themes` (migration 006).
- UI: positive-% trend, green/red split bar, positive & negative headline
  strings, themes table (theme → sentiment → occurrences → expandable quotes).

### Phase 5 — Crawlability (independent; zero API cost)
- Registry `src/lib/crawlers/bots.js`: ~50 AI bots (name, operator, purpose:
  training/search/agent) — GPTBot, OAI-SearchBot, ChatGPT-User, anthropic-ai,
  ClaudeBot, Google-Extended, PerplexityBot, Bytespider, CCBot, Amazonbot,
  Applebot-Extended, Meta-ExternalAgent, cohere-ai, DeepSeekBot, ….
- Fetch + parse robots.txt (+ llms.txt presence) for brand + rival domains;
  per-bot status Open/Partial/Blocked; store in `crawlability_audits` (007) for
  change tracking.
- UI: verdict headline, filterable bot table, **URL tester**, rival comparison.

### Phase 6 — Integrations & exports
- **GSC**: extend `gsc.js` with a date dimension (`dimensions: ["query","date"]` —
  today query-only, D17); brand settings page (property URL + copy-paste
  instructions to add the service-account email as Restricted user + verify);
  nightly sync via scheduler tick → `gsc_daily` (008). Join to prompts via
  token-overlap → **"Organic overlap %"** column (note: deliberately NOT Peec's
  "web search %", which means "answer used web search" — ours measures
  organic-rank overlap; label honestly in UI) + **AI vs Organic** panel (where
  AI visibility lags organic rank = highest-leverage gaps).
- **Refresh cadence UI**: schedule editor over `scan_schedules` (72h default),
  with projected per-cycle probe cost displayed.
- **Exports**: CSV endpoints + buttons (answers, citations).

### Phase 7 — Action layer: typed opportunities + new agents
- **Opportunities v2** (`opportunities`, migration 009): typed cards —
  `content_creation` | `content_optimization` | `outreach` | `reddit` — each with
  an evidence chip (current visibility / citation share / "Not mentioned")
  computed from real metrics; sourced from gap analysis + prompt metrics;
  dismiss/complete states. Replaces the one-shot `/api/opportunities` LLM route.
- **Agents integrate the EXISTING architecture (D18)** — migrations 003/004 give
  `content_agents` a `base`, composable `pipeline` block slugs, and
  `knowledge_blocks`. Outreach/Reddit ship as new bases with pipeline blocks,
  not free-floating playbooks:
  - **Outreach** (`base='outreach_pitch'`): from top earned gap domains →
    Firecrawl winning pages → extract author bylines + their citation counts
    from our `citations` data → personalized pitch draft; human-gated in Studio.
  - **Reddit** (`base='reddit_engage'`): find threads via Reddit public JSON
    search on gap topics, rank by reddit's share in our citations, draft
    **suggested comments/posts for a human to review and post manually** — we
    never auto-post (TOS + trust).
- **Chat Agent**: deferred — open question.

---

## 6. Design constraints (binding)

- Dark-only Results Night; tokens in `src/app/globals.css` are the API; shadcn HSL
  mapping preserved; Barlow Condensed tallies, Geist body, Geist Mono stamps.
- Role colors: teal = you, red = rivals/trailing, gold = declarations/CTAs only,
  dashed white = thresholds. **Ramps encode magnitude only for the self row;
  rival magnitudes use neutral luminance ramps** (D15).
- Every view: verdict-first — one headline sentence, one supporting visual, one
  dense table. Executive-legible in seconds.
- Preserve existing `data-testid`s; add testids for every new view
  (`overview-trend`, `prompts-table`, `citations-table`, `gaps-table`,
  `sentiment-themes`, `crawlability-table`, …).
- **Docs amendment package (D19):** PRODUCT.md's "30 unbranded prompts" and
  "~60 seconds to verdict" go stale under per-brand targets + chunked
  multi-engine scans; DESIGN.md gains the heatmap-ramp rule. Ships with P1.

---

## 7. Cost & model policy

| Job | Model | Notes |
|---|---|---|
| Topic/intent/citation classification | Free OpenRouter (`OPENROUTER_MODEL`) | Batched, cached by (brand, url/text hash) |
| Sentiment refinement | Deterministic first; free-LLM batch optional | One call scores all brands per answer |
| Theme distillation | Free first; `CONTENT_MODEL` only if review fails | Per scan, 1–2 calls |
| Narrative verdict | Deterministic template; optional free-LLM polish | Fail-loud to template |
| Outreach/Reddit drafts | `CONTENT_MODEL` (existing cost cap) | Human-gated |
| Probing | Existing engine costs; cadence multiplies them | Projected cost shown in schedule UI |

No new paid dependencies. Crawlability, gap analysis, SOV, matrix, movers,
exports are pure computation over data we already collect.

---

## 8. Execution protocol — three-agent model

- **Orchestrator** (main session, Opus): owns this plan, sequences work packages,
  spawns agents, resolves conflicts, merges. Holds the competitor-teardown context.
- **Developer** (subagent, Sonnet): one work package at a time, scoped spec from
  the orchestrator (files, schema, acceptance criteria). Writes code + unit tests
  (`node --test`, existing `*.test.mjs` conventions). Never touches locked
  contracts (prompt-set freeze, scoring definitions) without flagging.
- **Reviewer** (subagent): reviews each package diff against (a) this plan's
  acceptance criteria, (b) DESIGN.md/PRODUCT.md, (c) regression risk to scoring
  invariants and tests. Verdict: approve / request changes (max 2 cycles, then
  orchestrator arbitrates).

Package granularity: one migration, one pipeline module, or one view per package.
Every phase ends: tests green, `npm run build` clean, browser smoke-check, plan
checkbox updated here.

### Sequencing
```
P0.0 job store ─► P0.1 schema+backfill ─► P0.2 chunk worker ─► P0.3 dashboard handoff ─► P0.4 APIs
   ─► P1 (sentiment/position modules → symmetric judging → rollups → Overview v2)
   ─► P2 prompts/topics ─► P3 citations/gaps ─► P4 sentiment UI (P4 ∥ P3)
P5 crawlability — independent, any time after P0
P6 integrations — after P2 (organic-overlap column)
P7 action layer — after P3 (needs gap + citation data)
```

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| Job-store memory poison pill breaks checkpoints | P0.0 rewrite: DB-authoritative, fail-loud, heartbeats |
| Vercel timeout mid-chunk | 240s budget, checkpoint per batch, poll-driven rescue as primary, `maxDuration` set, idempotent upserts |
| Cron rescue double-probes | Rescue calls `runScanChunk` (resume); UNIQUE (job_id, engine, query) |
| Daily cadence cost blow-up | Cost projection in schedule UI; 72h default; per-brand engine toggle |
| Score continuity on prompt-set change | Texts frozen; additions additive via per-brand `prompt_target`; `prompt_set_id` marker on rollups |
| Backfill storage blow-up | Backfill normalizes mentions/citations, not duplicate answer blobs; `raw_results` retained as archive |
| Symmetric judging cost | Regex/alias pass covers most; LLM batched (one call, all brands) |
| Brand-key fragmentation ("Sleepy Owl" vs "sleepy owl") | All new tables keyed by `resolveBrandKey`; backfill normalizes history |
| Reddit/Outreach TOS + spam optics | Human-in-the-loop only; never auto-posted |
| Two chart systems creep in | Single shared chart component set; Reviewer enforces |
| No auth while adding write endpoints | Unchanged single-operator trust model; RLS anon policies consistent; flagged open question |

---

## 10. Open questions

**Decided (2026-07-23):**
1. **Auth/multi-tenancy** — ❌ DEFERRED. Single-operator model stays; brand
   (resolveBrandKey) remains the tenant key. New tables are NOT tenant-scoped
   beyond brand. Retrofit later if external users are onboarded.
2. **Engine expansion** — ❌ NO. Keep the current engine set. No new adapters.
   ⚠️ **Config reality (found 2026-07-23):** `.env.local` has `ENGINES=aio,perplexity`
   and `OPENAI_API_KEY` is UNSET — so only **2 engines actually run today**, not 3.
   The performance matrix (P1) will show aio + perplexity + blended until the user
   adds `OPENAI_API_KEY` and sets `ENGINES=aio,chatgpt,perplexity`. Build the matrix
   engine-count-agnostic (render whatever engines report); do not hardcode 3.

**Still open (none block P0):**
3. **Chat Agent** (RadarKit) — analytics Q&A assistant over brand data. Later, or drop?
4. **GA4 / AI-referral traffic** — needs GA4 OAuth. Phase 8 candidate.
5. **Locations** — multi-geo probing (competitors offer 50+). Per-brand geo
   override ships in P0 schema; a full Regions view multiplies probe cost.
6. **Vercel plan tier** — determines cron frequency, `maxDuration` ceiling, Fluid
   Compute. Poll-driven advancement removes the hard dependency, but confirm.

---

## 11. Phase checklists (living)

- [x] **P0.0** db.js job-store rewrite (DB-authoritative, fail-loud, heartbeat) — reviewed, content-job heartbeat blocker fixed
- [x] **P0.1** migration 005 (+content_jobs.heartbeat_at, indexes) · backfill (upsert, IST buckets, union 'all' row, guarded deletes) · setup-db self-verify · dry-run clean (55 scans, 0 errors, 674 pr/3667 cit/82 metrics)
- [x] **P0.1b** analytics DB access layer (src/lib/db/analytics.js) — 40 tests, wired into test:scoring glob (257 green)
- [x] **DB APPLY** migration 005 applied (17 tables ✓, both heartbeat_at cols verified) · backfill live (674 pr / 3667 cit / 34 metrics, 0 errors) · D4 union proven in data
- [x] **P0.2** chunk worker · poll rescue · cron resume+scheduler · maxDuration — 24 tests, build clean · reviewed (scoring parity + prompt-set hash parity CONFIRMED)
- [x] **P0.2-hardening** ALL 7 reviewer defects closed. D5 (api.js `?? r.references` — new AIO scans rendered empty sources) · D4 (CRON_SECRET gate on /api/scan/worker + self-continue auth) · D1+D2 (citations materialized at finalize from `raw`, delete-by-job_id — the loss window no longer exists and duplication is impossible) · D3+D6 (`claimJobStatus` compare-and-set single-flight for sourcing/finalize + heartbeat before the finalize LLM call; concurrency test empirically fails against unfixed code) · D7 (scheduler bumps next_run_at BEFORE the kick).
- [x] **Consolidation** `summarizeEngineSlice`/`domainMatches` exported from enginePipeline (worker copies deleted) · new `src/lib/analytics/rollup.js` is the single source of truth for brand_metrics_daily math, imported by BOTH worker and backfill — live-vs-backfill drift is now structurally impossible. 343 tests green.
- [x] **P1.4a** Results Night chart library — TrendChart (dashed-white threshold), RankTable (tally bars, transform-animated), PerformanceMatrix (self=teal ramp / rivals=neutral ramp, verified 0 role-color leaks), Donut, DeltaChip + 46 chartMath tests. Zero hardcoded hex. Verified live in DOM against DESIGN.md.
- [ ] **Cleanup** remove/dev-gate the temporary `/chart-preview` harness once charts are wired into real views
- [x] **Docs** README rewritten to real architecture (was describing the dead v1 SerpAPI/Gemini pipeline) · PRODUCT.md capabilities amended (per-brand prompt_target, chunked scans, real engine set)
- [x] **P0.3** `/api/scans/by-id/[scanId]` + `/[brand]/latest` · DashboardShell extracted · `/dashboard/[brand]/[scanId]` routes · legacy one-time sessionStorage migration + redirect (sample report preserved) · runScan completes via `result_id`. Verified live incl. a real end-to-end scan; fixed a useParams double-encoding 404 on multi-word brands.
- [x] **P0.4** paginated APIs · schedule endpoint

### ✅ P0 FOUNDATION COMPLETE — 343 tests green, build clean, migration + backfill live.

- [~] **P1.4** Overview v2 — wiring TrendChart/RankTable/Donut + narrative verdict to the live metrics API
- [x] **P1.1+P1.2** sentiment (`detectSentimentScore`: positive 100 / neutral 50 / negative 0, **null when unmentioned — never 0**) · in-answer position (`findFirstMentionIndex` → rank among mentioned brands) · `judgeBrandsSymmetric` scores self + every tracked rival on both engines · `result_brands` materialized at finalize (delete-then-insert idempotent, joined via prompt_results since it has no job_id) · `computeBrandRollups` fills sov_pct/sentiment_avg/position_avg. Deterministic, no LLM. Visibility scoring proven unchanged. 383 tests green.
  - ⚠️ Populates on NEW scans only — the 55 backfilled historical scans keep null sentiment/position/sov (that data never existed).
- [~] **P3a** citation enrichment (content_type/domain_type/citation_class over the 3667 existing rows) · gap scoring · citations + gaps endpoints
- [ ] **P1** sentiment+position modules · symmetric judging · rollups · Overview v2 · docs amendment
- [ ] **P2** topics reconciliation · prompt metrics table · suggested queue containment + target raise · drilldown · rerun-one
- [ ] **P3** citation enrichment · sources views · movers · gap analysis
- [ ] **P4** themes distillation (006) · sentiment UI
- [ ] **P5** crawlability (007) + URL tester
- [ ] **P6** GSC date-dimension + wiring (008) · schedule UI · CSV exports
- [ ] **P7** opportunities v2 (009) · outreach agent · reddit agent (as content_agents bases)
