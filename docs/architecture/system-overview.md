# Perceev — system overview

**What this is.** The technical map of the product as it exists in `main` @ `5111219`,
plus a reading of the live database taken 2026-08-31. Diagrams are Mermaid so they
render in GitHub and diff like code. The prose companion with hand-drawn figures is
published separately; this file is the source of truth.

**Contents**

1. [System map](#1-system-map)
2. [The scan lifecycle](#2-the-scan-lifecycle)
3. [The probe grid](#3-the-probe-grid)
4. [Scoring — the denominator chain](#4-scoring--the-denominator-chain)
5. [Finalize — one read, five writes](#5-finalize--one-read-five-writes)
6. [Data model](#6-data-model)
7. [Content OS](#7-content-os)
8. [The daily loop](#8-the-daily-loop)
9. [Live reading, 2026-08-31](#9-live-reading-2026-08-31)

---

## 1. System map

One Next.js 14 app on Vercel. No separate backend, no queue, no worker dyno — the
"worker" is an API route that re-enters itself. Postgres on Supabase is the only
durable state, and every long-running job is a row in it.

```mermaid
flowchart LR
  subgraph browser["Browser — all client components"]
    L["/ landing"]
    S["/scan"]
    D["/dashboard/:brand"]
    ST["Studio tab"]
  end

  subgraph vercel["Vercel — Next.js 14 App Router"]
    WRITE["POST /api/scan<br/>POST /api/content"]
    POLL["GET /api/scan/:job_id/status"]
    CRON["GET /api/scan/worker<br/>GET /api/content/worker<br/>CRON_SECRET gated"]
    READ["GET /api/scans/:brand/latest<br/>/api/brands/:brand/metrics<br/>citations · gaps · coverage<br/>prompts/metrics · crawlability"]
    WORK["lib/workers/scanWorker.js<br/>lib/content/contentWorker.js"]
  end

  DB[("Supabase Postgres<br/>19 tables · RLS anon-permissive")]

  BD["Bright Data SERP<br/>Google AI Overview"]
  PX["Perplexity sonar"]
  OA["OpenAI Responses<br/>web_search"]
  OR["OpenRouter free model<br/>prompt gen · competitors · classify"]
  FC["Firecrawl"]
  PAID["CONTENT_MODEL<br/>paid, capped per item"]

  S -->|"POST brand, url"| WRITE
  S -->|"poll every 2s"| POLL
  L --> S
  D --> READ
  ST --> READ

  WRITE -->|"insert job, fire-and-forget"| WORK
  POLL -->|"stale job? rescue kick"| WORK
  CRON -->|"resume sweep + scheduler tick"| WORK

  WORK -->|"probe"| BD
  WORK -->|"probe"| PX
  WORK -.->|"probe, needs OPENAI_API_KEY"| OA
  WORK -->|"generate · extract · classify"| OR
  WORK -->|"scrape for prompt seeds"| FC
  WORK -->|"draft · review · fact-check"| PAID

  WORK <-->|"checkpoint · results · rollups"| DB
  READ --> DB
  POLL --> DB
```

Engines are resolved from the `ENGINES` env var against a registry; an engine whose
key is missing is skipped with a warning, never faked. Production currently runs
`aio` and `perplexity`; `chatgpt` is dark for want of `OPENAI_API_KEY`.

---

## 2. The scan lifecycle

The one mechanism worth understanding. A scan is **not** a request that runs to
completion — it is a job row advanced by repeated, time-boxed *chunks*, any of which
may be killed mid-flight without losing work.

```mermaid
stateDiagram-v2
  [*] --> pending: POST /api/scan inserts scan_jobs row
  pending --> generating_prompts: claimJobStatus CAS<br/>only one caller wins
  generating_prompts --> probing: checkpoint frozen, 25%
  probing --> probing: batch written, heartbeat, 25→85%
  probing --> scoring: all pairs persisted<br/>claim probing→scoring
  scoring --> complete: insertScan, stamp, rollup, 100%
  pending --> failed: any throw
  generating_prompts --> failed: sourcing short of target
  probing --> failed: any throw
  scoring --> failed: insertScan returned no id
  complete --> [*]
  failed --> [*]
```

### Why it survives being killed

```mermaid
flowchart TB
  START(["runScanChunk(jobId)"]) --> READJOB["read scan_jobs row"]
  READJOB --> DONE{"complete or failed?"}
  DONE -->|yes| STOP(["return — no work"])
  DONE -->|no| CP{"checkpoint present?"}

  CP -->|no| CLAIM1["claim pending|generating_prompts<br/>→ generating_prompts"]
  CLAIM1 -->|lost| STOP
  CLAIM1 -->|won| SRC["SOURCING<br/>reuse frozen prompt pool by domain key<br/>top up additively only if short<br/>freeze queries + engines into checkpoint"]
  SRC --> PROBE

  CP -->|yes| PROBE["PROBING<br/>skip pairs already in prompt_results<br/>batch = engine concurrency<br/>upsert rows, heartbeat, checkpoint"]

  PROBE --> BUDGET{"150s budget hit<br/>with pairs left?"}
  BUDGET -->|yes| SELF["fire-and-forget<br/>GET /api/scan/worker?job_id=…"]
  SELF --> STOP
  BUDGET -->|no| CLAIM2["claim probing → scoring"]
  CLAIM2 -->|lost| STOP
  CLAIM2 -->|won| FIN["FINALIZE — see §5"]
  FIN --> COMPLETE(["status complete, result_id set"])
```

Three independent things can re-enter a stalled job. None of them is trusted alone:

| Path | Trigger | Cadence |
|---|---|---|
| Self-continue | chunk hit its 150s budget | immediate, best-effort |
| Poll rescue | `/status` sees a stale heartbeat | every 2s while a tab is open |
| Cron sweep | `/api/scan/worker` with no `job_id` | **once a day, 00:00 UTC** |

"Stale" is one definition in one place: `isJobAlive` — a running status *and* a
heartbeat inside `HEARTBEAT_STALE_MS` (180s). `updateScanJob` stamps the heartbeat on
every call, and probing calls it after **every batch**, so a genuinely working chunk
can never look dead. The same predicate stops a crashed job from blocking new scans
for its brand.

Single-flight is structural, not advisory: `claimJobStatus` is a conditional UPDATE
whose `WHERE` includes the expected current status, so of two racing callers exactly
one matches a row. That guard sits in front of sourcing (or two workers generate two
divergent prompt batches) and in front of finalize (or two workers write two `scans`
rows for one job).

---

## 3. The probe grid

A scan's unit of work is an **(engine, query) pair**, and the pair is the idempotency
key. `prompt_results` carries `UNIQUE (job_id, engine, query)`, so a resumed chunk
re-reads what landed and skips it.

```mermaid
flowchart LR
  subgraph grid["queries × engines — 34 × 2 = 68 pairs"]
    direction TB
    G1["aio ▸ q1..q34<br/>concurrency 6, 60s timeout"]
    G2["perplexity ▸ q1..q34<br/>concurrency 4, 45s timeout, 2 retries"]
  end

  grid --> B["batch of N = engine concurrency"]
  B --> P["probe → answer text, references, organic rank"]
  P --> J["judge in-process:<br/>detectMention vs brand aliases<br/>judgeBrandsSymmetric vs roster<br/>brand_cited by domain match"]
  J --> U["upsertPromptResults<br/>raw = the WHOLE probe result"]
  U --> H["updateScanJob<br/>progress + heartbeat + checkpoint"]
  H --> B
```

Two deliberate choices are load-bearing:

- **`raw` stores the complete probe result**, so finalize can reconstruct the exact
  results array *and* materialize citations later from the same rows. Nothing about
  a probe needs re-fetching.
- **Citations are not written during probing.** "Pair completed" is defined solely by
  a `prompt_results` row; an instance dying between a results write and a citations
  write would skip the pair on resume and lose its citations forever. They are a
  finalize-derived artifact instead, rebuilt idempotently.

---

## 4. Scoring — the denominator chain

The score is not "mentions ÷ prompts". It is a chain of filters, and every step exists
because a naive denominator produced a misleading number in a real scan.

```mermaid
flowchart TB
  A["all pairs for one engine"] --> B["errored — excluded, feeds error_rate_pct"]
  A --> C["branded seeds — excluded from headline,<br/>reported as brand presence"]
  A --> D["non-branded"]
  D --> E["non-branded WITH an answer<br/>→ coverage_pct"]
  E --> F{"does any answer in this slice<br/>name a NON-SELF roster brand?"}
  F -->|no| G["keep the full answered pool<br/>absence of a rival roster is not evidence"]
  F -->|yes| H["ELICITING POOL<br/>answers naming ≥1 vendor"]
  G --> I
  H --> I["visible = mentioned in text OR cited by domain"]
  I --> J["share_of_ai_pct = visible ÷ pool"]
  J --> K["visibility_index_pct<br/>weighted mean over eligible engines"]
```

**Why the eliciting filter exists.** On a live tiles-brand scan, 40 of 56 answered
prompts were arithmetic, definitions and how-tos that named no vendor at all. Scoring
across them divided by impossibility and capped the achievable score at 16/56 before
the brand's real visibility was ever measured. **Why it is gated.** Competitors are
discovered at *finalize*, after probing — so during a live scan the roster holds only
the self brand, and "did this answer name any vendor" degenerates into "did it name
us", forcing 0/0 or a flattering 100%. The filter therefore applies only when a rival
actually appears in the slice.

Related: `share_of_voice_pct` is **null**, not 0 and not 100, without rivals — the
dashboard says "not available" rather than printing self ÷ self = 100%.

Two gates can suppress the number entirely rather than report it:

| Gate | Condition (aio) | Meaning |
|---|---|---|
| `data_source_issue` | error rate > 50%, or non-branded coverage < 15% | the feed is broken, not the brand |
| `insufficient_sample` | eliciting pool < 5 | too small a sample to claim anything |

Engine weights are relative and renormalized over whichever engines were eligible
(≥5 non-branded answers, no data-source issue), so aio + perplexity is a 50/50 blend
and a lone survivor is 100% of the index.

---

## 5. Finalize — one read, five writes

Finalize reads every persisted row once and fans out. Every write is idempotent,
because crash-recovery may run this phase more than once for one job.

```mermaid
flowchart TB
  R["read all prompt_results for job<br/>results = rows.map(r => r.raw)"] --> S1["summarizeEngineSlice per engine"]
  S1 --> S2["computeHeadline → visibility index"]
  R --> XC["extractCompetitors — LLM, up to ~75s<br/>heartbeat stamped immediately before"]
  XC --> ROSTER["fullRoster = self + user-supplied + auto-discovered"]
  R --> TD["aggregateAioTopDomains"]

  S2 --> INS
  XC --> INS
  TD --> INS["insertScan — FAIL LOUD<br/>reuse stamped id if a prior attempt got this far"]
  INS --> STAMP["stampScanIdForJob<br/>only touches scan_id IS NULL"]

  STAMP --> C1["delete citations for job<br/>rebuild from raw.references<br/>classify content/domain/class<br/>insert"]
  STAMP --> C2["delete result_brands for job<br/>RE-JUDGE every non-branded answer<br/>against fullRoster<br/>insert"]
  C1 --> ROLL
  C2 --> ROLL["buildMetricsRows → upsert brand_metrics_daily<br/>one row per brand × day × engine, plus 'all'"]
  ROLL --> OK["status complete, progress 100, result_id set"]
```

The re-judge in `C2` is the fix for a real scoring bug: probe-time judging only ever
knew the *user-typed* competitor list, so a brand scanned with no competitors got a
self-only roster, `sov_pct` came out 100% by construction, and gap analysis — which
needs rival mentions in `result_brands` — was always empty. Finalize now recomputes
the whole matrix against the discovered roster.

---

## 6. Data model

19 tables live. `brand` columns in the analytics tables store `resolveBrandKey()`
output — a **domain-first key** — never the typed display name. Display names live on
`scans` / `scan_jobs`. Mixing the two is the most common way to query nothing.

```mermaid
erDiagram
  scan_jobs ||--o| scans : "result_id"
  scan_jobs ||--o{ prompt_results : "job_id"
  scans ||--o{ prompt_results : "scan_id, stamped at finalize"
  prompt_results ||--o{ result_brands : "result_id"
  prompt_results ||--o{ citations : "result_id"
  scans ||--o{ brand_metrics_daily : "scan_id"
  brand_prompts }o--|| scan_schedules : "brand key"
  topics }o--|| scan_schedules : "brand key"

  content_jobs ||--o| content_items : "item_id"
  content_jobs ||--o{ content_runs : "job_id — NOT YET IN PROD"
  content_items ||--o{ content_feedback : "item_id"
  content_agents ||--o{ content_jobs : "agent_id + snapshot"
  brand_briefs ||--o{ content_jobs : "brand"
  content_lessons ||--o{ content_jobs : "brand + playbook"
  knowledge_blocks ||--o{ content_jobs : "brand"
```

| Group | Tables | Written by |
|---|---|---|
| Scan control | `scan_jobs`, `scan_schedules` | worker, scheduler tick |
| Prompt set | `brand_prompts`, `topics` | sourcing, additive only |
| Evidence | `prompt_results`, `result_brands`, `citations` | probing + finalize |
| Reporting | `scans`, `brand_metrics_daily` | finalize |
| Content OS | `content_jobs`, `content_items`, `content_runs`, `content_feedback`, `brand_briefs`, `content_lessons`, `content_agents`, `knowledge_blocks` | content worker + Studio |
| Lift | `content_events` | operator |

**Prompt-set contract.** Prompt sets are keyed by domain, frozen, and only ever
extended additively. A scan aborts loudly rather than silently regenerating prompts,
because scoring a different set of questions would quietly break comparability.
`prompt_set_id` (first 16 hex of a sha256 over the sorted unbranded set) rides on
every scan and every daily rollup so the UI can mark where a tracked set changed.

---

## 7. Content OS

A gap becomes a drafted asset through a composable block pipeline, behind a mandatory
human gate. Exclusivity here is a **durable lease**, not a status CAS, because a
content job passes through eight statuses and must be resumable in place.

```mermaid
flowchart TB
  IN["gap row in dashboard, or daily batch"] --> JOB["content_jobs row, pending"]
  JOB --> LEASE{"acquireLease — one conditional UPDATE"}
  LEASE -->|lost| SKIP(["another worker owns it"])
  LEASE -->|won| CO["coordinate — work order"]
  CO --> RE["research — sources, stats, quotes, PAA"]
  RE --> BE["benchmark — what currently wins"]
  BE --> DR["draft"]

  DR --> MID["first pass only:<br/>transforms — translate · tighten · voice_polish<br/>fact_check"]
  MID --> RV["review — rubric + verdict"]
  RV -->|"pass"| GATE
  RV -->|"YMYL violation"| GATE
  RV -->|"fail, cycle < 2"| DR
  RV -->|"fail, cycle = 2"| GATE

  GATE["content_items — awaiting_approval<br/>MANDATORY HUMAN GATE"]
  GATE -->|approve| AP["approved — terminal"]
  GATE -->|reject| RJ["rejected — terminal"]
  GATE -->|request changes| CR["changes_requested → revision pass<br/>returns to the same gate"]
  CR --> GATE
```

Guardrails, all enforced in code:

- **Cost cap** — `CONTENT_MAX_COST_PER_ITEM` (default $0.15) checked after *every*
  block; a job that crosses it throws with the block named.
- **Bounded loop** — at most 2 draft→review cycles, then the item goes to the human
  queue flagged `below_threshold` regardless.
- **YMYL is never auto-revised** — a flagged violation routes straight to the human
  with the violation named.
- **Stage table validates itself** — `stages.js` asserts its own transition graph at
  module load, so a typo is a startup error rather than a silent wrong status.
- **Per-block ledger** — `content_runs` records cost and tokens per block per cycle,
  so "which block eats the $0.15" is answerable. *(Table not yet in production.)*

---

## 8. The daily loop

Two Vercel cron entries, both daily, both `CRON_SECRET`-gated.

```mermaid
flowchart LR
  subgraph day["every 24h, UTC"]
    T0["00:00 — GET /api/scan/worker"]
    T30["00:30 — GET /api/content/worker"]
  end

  T0 --> SWEEP["rescue sweep<br/>up to 20 unfinished jobs<br/>resume ≤3 that fail isJobAlive"]
  T0 --> TICK["scheduler tick<br/>listDueSchedules by next_run_at"]
  TICK --> DUE{"due, cadence ≠ off,<br/>no live job for brand?"}
  DUE -->|yes| NEW["createScanJob → bump next_run_at → kick chunk"]
  DUE -->|no| SKIPD(["skip"])

  T30 --> CRES["rescue content jobs<br/>heartbeat stale AND lease free"]
  T30 -.->|"requires ?batch=1 — NOT SET in vercel.json"| BATCH["daily batch<br/>top gaps → geo_article jobs"]

  USER["operator runs a scan from /scan"] -.->|"any time of day"| ONDEMAND["same pipeline, poll-driven"]
```

Cadence per brand is `72h` (default), `daily`, `weekly` or `off`, stored on
`scan_schedules` and converted to `next_run_at` on each run. The schedule is bumped
**before** the fire-and-forget kick, so an instance dying mid-kick cannot leave a
schedule permanently "due" and pile up a job per tick.

Three properties of this loop are worth stating plainly:

1. **The cron is a floor, not the engine.** At daily cadence, a job abandoned with no
   browser open waits up to 24 hours for rescue. Poll-driven rescue is what actually
   recovers scans during working hours.
2. **The scheduler is the only thing that makes the product recurring.** With no rows
   in `scan_schedules`, the tick is a no-op and Perceev is an on-demand scanner.
3. **The content batch never fires from cron** as configured: `vercel.json` calls
   `/api/content/worker` with no `?batch=1`, and `CONTENT_DAILY_BATCH` defaults to 0.
   Two independent switches, both off.

---

## 9. Live reading, 2026-08-31

Taken from the production Supabase project. Numbers, not impressions.

| Reading | Value |
|---|---|
| Scans stored | 60, across 13 distinct brand strings |
| Scan jobs | 79 — 25 complete, 54 failed, 0 running |
| Most recent scan | **2026-07-30** — 32 days ago |
| Rows in `scan_schedules` | **0** |
| Prompt results | 1 070 — aio 828, perplexity 242 |
| aio answer coverage | 462 / 828 = 56% |
| perplexity answer coverage | 242 / 242 = 100% |
| Brand mentioned | aio 74, perplexity 37 |
| Citations | 6 631, **100% classified** — 0 unenriched |
| Result brands | 2 822 |
| Daily metric rows | 46 — `all` 20, `aio` 20, `perplexity` 6 |
| Content jobs / items | 4 / 2 |

### Job failures, by cause

| Cause | Count | Last seen |
|---|---|---|
| Marked failed by an `R0.1.11` reconcile on 2026-08-30 — jobs stranded in a running status | 43 | 2026-07-24 |
| `generateUnbrandedPrompts` produced too few unbranded prompts (OpenRouter) | 11 | 2026-07-24 |

The 43 are a **bookkeeping cleanup**, not 43 separate incidents: jobs orphaned before
the checkpointed worker landed, swept into `failed` by a later reconcile. The 11 are
real, and they share one root cause — the free utility model returning 3–4 usable
prompts against a target of 30, which the prompt-set contract correctly refuses to
paper over.

### Where the repo and production disagree

Both are facts about today, and both matter for reading anything above.

- **Migration 006 is not applied.** `content_runs` does not exist in the live
  database. The content worker's ledger writes are fail-soft, so the pipeline runs —
  it just records no per-block cost.
- **Production carries two tables this repo does not define:** `scan_rate_limits`
  (`bucket_key`, `window_start`, `hits`) and `system_heartbeats` (empty). Together
  with the `R0.1.11` reconcile stamp on those failed jobs, this says production is
  running a hardening branch that is not merged into this `main`.
- **`DESIGN.md` describes the dark "signal box" world; the shipped tokens in
  `src/app/globals.css` are light-first** — paper `#F7F7FA`, indigo `#3730CE`. The
  most recent commit ported a new design system; the design document has not caught up.

### The honest summary

Everything in sections 2–7 is built, tested and committed. What is *running* daily is
a rescue sweep over an empty active set and a scheduler tick over an empty schedule
table. The pipeline is sound and idle: to make the product recurring, the missing
piece is rows in `scan_schedules`, not code.
