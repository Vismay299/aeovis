# Production migrations — is this one applied to THIS database?

> <!-- doc-status -->
> **Status: LIVE.** The per-migration verification queries for
> `supabase/migrations/`. One row per migration file on disk; for each, a
> catalog query that answers "applied here, yes or no" against the database you
> are actually pointed at.

**Date:** 2026-09-05 · **Task:** R6.1.2 (finding S26) · **Verified at:** `1a5ed81`

---

## Baseline, and what that stamp does and does not claim

Every line citation into `supabase/migrations/*.sql` and
`scripts/setup-supabase.mjs` below was read at commit `1a5ed81`, and both of
those paths were clean in the working tree when it was read — so those numbers
describe committed blobs.

Four files this document also names were **dirty in the working tree** at the
time of writing (other tasks in flight): `src/lib/db.js`,
`src/lib/workers/scanWorker.js`, `src/lib/scoring/enginePipeline.js`,
`src/app/api/scan/route.js`. They are therefore cited by **greppable symbol,
never by line**, because a line number read out of a tree nobody has committed
is a number that is wrong by the time you read it.

**`013_brand_metrics_sov_state.sql` was appended after `1a5ed81`** (R4.3.2), so
the paragraph above does not cover it and `git log 1a5ed81..HEAD -- supabase/migrations`
is now non-empty by construction. Its rows below are therefore cited by
migration name and object name only — no `file:line` — and its own header
carries the catalog query for it. Nothing else in this file was re-derived when
it was added; treat the pre-013 line numbers with the same suspicion the check
below asks for.

To find out whether the migration citations have gone stale:

```bash
git log --oneline 1a5ed81..HEAD -- supabase/migrations scripts/setup-supabase.mjs
```

Empty means every `file:line` below is still the line that was read.
**Non-empty means re-derive before trusting this file** — in particular, a new
`013_*.sql` will not be in the query below, and this document will silently
report a complete database while missing the newest migration. That is exactly
the failure `scripts/setup-supabase.mjs`'s own list had (finding C10, closed by
R6.1.1), so it is worth saying out loud that this file can acquire it too.

---

## Rule 1 — read the catalog. Never head-probe.

**A head-probe is `select … from some_table limit 0` (or a PostgREST `GET`)
run to see whether it errors, and it must never be used to decide whether a
migration is applied.** It cannot distinguish these four states:

| Actual state | What a head-probe shows |
|---|---|
| Table missing | error |
| Table present, RLS denies you | error, or an empty result |
| Table present, wrong columns | success, if you only selected `*` with `limit 0` |
| Table present, its **function** missing | success — the probe never touches functions |

The fourth row is not hypothetical here. On 2026-08-30 the live database was
found to be missing 007, 008 **and** 009 while `npm run setup:db` reported
success, and 009 in particular has been seen as a table that exists with its
function absent. `scripts/setup-supabase.mjs:57-59` records that reason in the
source:

> `to_regclass` covers tables and indexes; functions need `pg_proc`, because a
> table can exist while the function that makes it usable does not — exactly
> the state 009 was found in.

The same rule is asserted in a live test at `src/lib/scanRunsLive.test.mjs:110`
("pg_class, not `SELECT ... LIMIT 0`: a head probe against PostgREST cannot
tell a missing table from a permissions error").

So: **every query in this file reads `pg_catalog` or `information_schema`.**
Two further consequences, both derived rather than stylistic:

- **Columns are checked via `pg_attribute`, not `information_schema.columns`.**
  `information_schema` filters its output by the privileges of the calling
  role, so a column you cannot select on is reported as not existing. That is a
  head-probe wearing a catalog's clothes. `pg_catalog` has no such filter. (The
  migrations themselves guard with `information_schema.columns` — e.g.
  `supabase/migrations/001_initial_schema.sql:90` — which is correct *there*,
  because the runner connects as the table owner.)
- **Reading data to answer a data question is fine.** The 007 pre-flight below
  counts rows in `scan_jobs`. That is not a head-probe: it asks a question about
  rows, and gets a real answer about rows. The banned move is inferring
  *schema* from whether a *data* query threw.

## Rule 2 — never verify a function by calling it. Every one of them writes.

Calling a function to see if it exists is a head-probe with side effects. All
nine functions these migrations create mutate rows:

| Function | Migration | What calling it does |
|---|---|---|
| `increment_scan_rate_limit` | `009_scan_rate_limit.sql:41` | `INSERT … ON CONFLICT DO UPDATE` — consumes a rate-limit hit for that bucket |
| `claim_probe_tasks` | `010_probe_tasks.sql:124` | Claims up to `p_limit` tasks, sets a lease, **increments `attempts`** |
| `renew_probe_lease` | `010_probe_tasks.sql:240` | Pushes lease expiry out |
| `complete_probe_tasks` | `010_probe_tasks.sql:279` | Writes outcomes, drops leases |
| `release_probe_tasks` | `010_probe_tasks.sql:351` | Resets tasks to `pending` |
| `open_scan_run` | `011_scan_runs.sql:220` | Inserts a ledger row |
| `heartbeat_scan_run` | `011_scan_runs.sql:257` | Updates, and **raises** if the run is closed |
| `close_scan_run` | `011_scan_runs.sql:299` | Closes a run, and **raises** on a second close |
| `claim_scan_job_attempt` | `012_scan_job_attempts.sql:124` | Increments `scan_jobs.attempts`; at the cap it **flips a live job to `status='failed'`, `progress_pct=100`** (`012_scan_job_attempts.sql:189`) |

The last one is the dangerous one: a curious `select claim_scan_job_attempt(...)`
against a customer's in-flight scan can kill it. Check `pg_proc`; do not dial
the number.

The repo's own enumeration of which RPCs write which tables is in
`src/lib/liveWriteGuard.js` (grep for `claim_scan_job_attempt:` and
`increment_scan_rate_limit:` — that file was dirty in the working tree, so it is
cited by symbol).

---

## Standing rule 4 — run the SQL with the merge, never after

> 4. Run the SQL with the merge, never after.
> — `docs/plans/2026-08-29-rebuild-roadmap.md:18`

This repository has paid for ignoring it twice. The table below is the reason
the rule is checkable: it names, per migration, the shipped code path that
breaks if the migration is absent. **If a deploy went out and one of these
migrations did not, this is where you look to predict the symptom.**

| Migration | Depended on by | Reached from | If missing |
|---|---|---|---|
| `001` | everything | every route | Nothing works |
| `002` | `src/lib/db/content.js` | `/api/content*`, `/api/content-items`, `/api/brand-briefs`, `/api/lessons` | Content OS 500s |
| `003` | agent config + provenance snapshot | `/api/agents` | Agent create/read fails; `content_jobs.agent_*` writes fail |
| `004` | knowledge blocks + custom pipelines | `/api/knowledge` | Knowledge routes fail; agent `pipeline`/`block_config` writes fail |
| `005` | `src/lib/db/analytics.js` (analytics tables), `scan_jobs.checkpoint`/`heartbeat_at` | the scan pipeline and every dashboard trend | Chunked probing cannot checkpoint; rescue cannot see staleness; all trends empty |
| `006` | `acquireLease("content_jobs", …)` at `src/app/api/content/worker/route.js:55` and `src/lib/content/contentWorker.js:169`; `content_runs` writes at `src/lib/db/content.js:342` | cron `/api/content/worker` (`vercel.json`, `30 0 * * *`) | Content jobs lose single-flight — two executions race one row, each spending a full per-item cost cap |
| `007` | `DUPLICATE_SCAN_INDEX` at `src/lib/duplicateScan.js:19`, caught in `src/lib/db.js` (`createScanJob`) | `POST /api/scan` | The duplicate-scan TOCTOU reopens; each duplicate spends a full Bright Data + LLM budget |
| `008` | `recordCronTick` / `getCronTicks`, `src/lib/db/analytics.js:555` and `:571` | cron `/api/scan/worker:279`, cron `/api/content/worker:91`, read by `/api/health:48` | `/api/health` cannot answer "did the cron fire"; heartbeat writes warn and return `null` |
| `009` | `incrementScanRateLimit`, `src/lib/db/analytics.js:523`; `checkScanRateLimit` at `src/lib/rateLimit.js:332` | `POST /api/scan` | The anonymous free scan has no cap at all |
| `010` | `src/lib/probeQueue.js` and the fleet's copy `worker/src/lib/queue.js` | **nothing deployed** — see below | No observable symptom today |
| `011` | `openScanRun`/`closeScanRun`, `src/lib/scanRuns.js:223`/`:280`, imported by `src/lib/workers/scanWorker.js`; `RUN_OUTCOMES` at `src/app/api/scan/worker/route.js:12` | `POST /api/scan`, `/api/scan/[job_id]/status`, cron `/api/scan/worker` | The chunk worker's ledger writes fail; a measured-zero pass and a never-ran pass become indistinguishable again |
| `012` | `claim_scan_job_attempt` RPC, called from `src/lib/workers/scanWorker.js` (grep `claimJobAttempt`) | same three entry points as 011 | A poison job is resumed forever by the cron sweep, spending real vendor budget every tick |
| `013` | `sov_state`/`sov_state_reason` on every row `buildMetricsRows` produces (`src/lib/analytics/rollup.js`), written verbatim by `upsertBrandMetricsDaily` (`src/lib/db/analytics.js`) | scan finalize (cron `/api/scan/worker`), `scripts/backfill-analytics.mjs`, read by `GET /api/brands/[brand]/metrics` | **Every scan finalize fails its `brand_metrics_daily` upsert with PostgREST `PGRST204` ("column sov_state ... does not exist")** — the upsert passes the row object through unfiltered, so this is a hard failure, not a dropped field |

**Two honest gaps in that table.**

1. **`010` is required by nothing that runs.** `git grep probeQueue -- src worker`
   at `1a5ed81` returns only its own test, comments in `src/lib/liveDbGate.js` /
   `src/lib/workerIsolation.test.mjs`, and the deliberate copy in
   `worker/src/lib/queue.js`. The fleet in `worker/` is not deployed —
   `011_scan_runs.sql:373` says so in the file ("the fleet is not deployed until
   R1.3 lands a real adapter"). So a database missing 010 will look perfectly
   healthy. There is no behavioural check for it; the catalog query below is the
   only one there is.
2. **`006`'s `scan_jobs.lease_owner` / `scan_jobs.lease_expires_at` are still
   unwritten.** `006_agent_control_plane.sql:22-23` says they are added so that
   adopting the primitive later is a code-only change, and
   `git grep 'acquireLease(' -- src/app src/lib/content` confirms the only two
   call sites both pass `"content_jobs"`. Their absence would therefore also be
   invisible.

---

## Before you run anything: which database is this?

The repo does **not** record which Supabase project is live. `git grep` for
`supabase.co` across tracked files finds only placeholders in `.env.example`
(`https://your-project.supabase.co`) and test fixtures. Confirm the project ref
in the Supabase dashboard header before you paste anything.

Credentials are referenced here by **variable name only**, never by value:

- `scripts/setup-supabase.mjs` connects with `DATABASE_URL`, or builds one from
  `SUPABASE_DB_PASSWORD` + `NEXT_PUBLIC_SUPABASE_URL` (optionally
  `SUPABASE_DB_HOST`, `SUPABASE_DB_USER`, `SUPABASE_DB_PORT`).
- The app reads/writes over PostgREST with the anon key; the fleet uses the
  service role key. Names only: `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY`.

**Never paste a connection string, a password or a key into this file, into a
ticket, or into an agent transcript.** If one appears in your terminal, stop and
raise a rotation ticket naming the variable, not the value.

Everything below is a `SELECT`. Nothing in this document writes.

---

## The one query — every migration at once

Paste this into the Supabase SQL editor. One row per migration file, with a
verdict and the names of anything missing.

```sql
WITH expected(migration, kind, name) AS (
  VALUES
    -- 001_initial_schema.sql
    ('001_initial_schema'::text, 'table'::text,      'scans'::text),
    ('001_initial_schema', 'table',      'brand_prompts'),
    ('001_initial_schema', 'table',      'scan_jobs'),
    ('001_initial_schema', 'table',      'content_events'),
    ('001_initial_schema', 'constraint', 'brand_prompts_brand_text_idx'),
    ('001_initial_schema', 'constraint', 'content_events_brand_url_idx'),
    ('001_initial_schema', 'column',     'brand_prompts.source'),
    ('001_initial_schema', 'column',     'scan_jobs.query_source'),
    ('001_initial_schema', 'column',     'scan_jobs.gsc_queries'),
    ('001_initial_schema', 'column',     'scans.query_source'),
    -- 002_content_os.sql
    ('002_content_os', 'table',      'content_jobs'),
    ('002_content_os', 'table',      'content_items'),
    ('002_content_os', 'table',      'content_feedback'),
    ('002_content_os', 'table',      'brand_briefs'),
    ('002_content_os', 'table',      'content_lessons'),
    ('002_content_os', 'constraint', 'content_jobs_item_id_fkey'),
    -- 003_content_agents.sql
    ('003_content_agents', 'table',      'content_agents'),
    ('003_content_agents', 'constraint', 'content_agents_brand_slug_idx'),
    ('003_content_agents', 'column',     'content_jobs.agent_id'),
    ('003_content_agents', 'column',     'content_jobs.agent_snapshot'),
    ('003_content_agents', 'column',     'content_jobs.agent_trace'),
    ('003_content_agents', 'column',     'content_items.agent_id'),
    ('003_content_agents', 'column',     'content_items.agent_snapshot'),
    -- 004_crew_canvas_knowledge.sql
    ('004_crew_canvas_knowledge', 'table',  'knowledge_blocks'),
    ('004_crew_canvas_knowledge', 'column', 'content_agents.pipeline'),
    ('004_crew_canvas_knowledge', 'column', 'content_agents.block_config'),
    -- 005_analytics_platform.sql
    ('005_analytics_platform', 'table',  'prompt_results'),
    ('005_analytics_platform', 'table',  'result_brands'),
    ('005_analytics_platform', 'table',  'citations'),
    ('005_analytics_platform', 'table',  'brand_metrics_daily'),
    ('005_analytics_platform', 'table',  'scan_schedules'),
    ('005_analytics_platform', 'table',  'topics'),
    ('005_analytics_platform', 'index',  'prompt_results_brand_idx'),
    ('005_analytics_platform', 'index',  'prompt_results_scan_idx'),
    ('005_analytics_platform', 'index',  'result_brands_scan_idx'),
    ('005_analytics_platform', 'index',  'citations_brand_domain_idx'),
    ('005_analytics_platform', 'index',  'citations_scan_idx'),
    ('005_analytics_platform', 'index',  'scan_jobs_heartbeat_idx'),
    ('005_analytics_platform', 'index',  'scan_schedules_next_run_idx'),
    ('005_analytics_platform', 'column', 'brand_prompts.topic_id'),
    ('005_analytics_platform', 'column', 'brand_prompts.status'),
    ('005_analytics_platform', 'column', 'brand_prompts.search_volume_band'),
    ('005_analytics_platform', 'column', 'scan_jobs.checkpoint'),
    ('005_analytics_platform', 'column', 'scan_jobs.heartbeat_at'),
    ('005_analytics_platform', 'column', 'content_jobs.heartbeat_at'),
    -- 006_agent_control_plane.sql
    ('006_agent_control_plane', 'table',  'content_runs'),
    ('006_agent_control_plane', 'index',  'content_jobs_heartbeat_idx'),
    ('006_agent_control_plane', 'index',  'content_jobs_lease_idx'),
    ('006_agent_control_plane', 'index',  'content_runs_job_idx'),
    ('006_agent_control_plane', 'index',  'content_runs_brand_block_idx'),
    ('006_agent_control_plane', 'column', 'content_jobs.lease_owner'),
    ('006_agent_control_plane', 'column', 'content_jobs.lease_expires_at'),
    ('006_agent_control_plane', 'column', 'scan_jobs.lease_owner'),
    ('006_agent_control_plane', 'column', 'scan_jobs.lease_expires_at'),
    -- 007_scan_seal.sql
    ('007_scan_seal', 'index', 'scan_jobs_one_running_per_brand'),
    -- 008_system_heartbeats.sql
    ('008_system_heartbeats', 'table', 'system_heartbeats'),
    -- 009_scan_rate_limit.sql
    ('009_scan_rate_limit', 'table',    'scan_rate_limits'),
    ('009_scan_rate_limit', 'index',    'scan_rate_limits_window_idx'),
    ('009_scan_rate_limit', 'function', 'increment_scan_rate_limit'),
    -- 010_probe_tasks.sql
    ('010_probe_tasks', 'table',      'probe_tasks'),
    ('010_probe_tasks', 'index',      'probe_tasks_claim_idx'),
    ('010_probe_tasks', 'index',      'probe_tasks_batch_idx'),
    ('010_probe_tasks', 'index',      'probe_tasks_lease_idx'),
    ('010_probe_tasks', 'constraint', 'probe_tasks_status_chk'),
    ('010_probe_tasks', 'constraint', 'probe_tasks_outcome_chk'),
    ('010_probe_tasks', 'function',   'claim_probe_tasks'),
    ('010_probe_tasks', 'function',   'renew_probe_lease'),
    ('010_probe_tasks', 'function',   'complete_probe_tasks'),
    ('010_probe_tasks', 'function',   'release_probe_tasks'),
    -- 011_scan_runs.sql
    ('011_scan_runs', 'table',      'scan_runs'),
    ('011_scan_runs', 'index',      'scan_runs_job_idx'),
    ('011_scan_runs', 'index',      'scan_runs_batch_idx'),
    ('011_scan_runs', 'index',      'scan_runs_open_idx'),
    ('011_scan_runs', 'index',      'scan_runs_runner_idx'),
    ('011_scan_runs', 'constraint', 'scan_runs_runner_chk'),
    ('011_scan_runs', 'constraint', 'scan_runs_outcome_chk'),
    ('011_scan_runs', 'constraint', 'scan_runs_open_chk'),
    ('011_scan_runs', 'constraint', 'scan_runs_reason_chk'),
    ('011_scan_runs', 'constraint', 'scan_runs_subject_chk'),
    ('011_scan_runs', 'constraint', 'scan_runs_counts_chk'),
    ('011_scan_runs', 'function',   'open_scan_run'),
    ('011_scan_runs', 'function',   'heartbeat_scan_run'),
    ('011_scan_runs', 'function',   'close_scan_run'),
    -- 012_scan_job_attempts.sql
    ('012_scan_job_attempts', 'column',     'scan_jobs.attempts'),
    ('012_scan_job_attempts', 'constraint', 'scan_jobs_attempts_chk'),
    ('012_scan_job_attempts', 'index',      'scan_jobs_attempts_idx'),
    ('012_scan_job_attempts', 'function',   'claim_scan_job_attempt'),
    -- 013_brand_metrics_sov_state.sql
    ('013_brand_metrics_sov_state', 'column',     'brand_metrics_daily.sov_state'),
    ('013_brand_metrics_sov_state', 'column',     'brand_metrics_daily.sov_state_reason'),
    ('013_brand_metrics_sov_state', 'constraint', 'brand_metrics_daily_sov_state_check'),
    ('013_brand_metrics_sov_state', 'constraint', 'brand_metrics_daily_sov_state_reason_check'),
    ('013_brand_metrics_sov_state', 'constraint', 'brand_metrics_daily_sov_state_pct_agreement_check'),
    ('013_brand_metrics_sov_state', 'index',      'brand_metrics_daily_sov_unverified_idx'),
    -- 014_content_job_checkpoints.sql
    -- Same column-invisibility problem as 012/013 but without a proxy index.
    -- The only non-comment line is:
    --   ALTER TABLE content_jobs ADD COLUMN IF NOT EXISTS checkpoint jsonb;
    -- Unlike 012/013, this migration ships no index that references the new
    -- column, so there is no catalog object whose existence proves the column
    -- was added. The column check below uses pg_attribute directly.
    ('014_content_job_checkpoints', 'column',     'content_jobs.checkpoint')
),
checked AS (
  SELECT e.migration, e.kind, e.name,
         CASE e.kind
           WHEN 'table' THEN EXISTS (
             SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relname = e.name AND c.relkind = 'r')
           WHEN 'index' THEN EXISTS (
             SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relname = e.name AND c.relkind = 'i')
           WHEN 'function' THEN EXISTS (
             SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = e.name)
           WHEN 'constraint' THEN EXISTS (
             SELECT 1 FROM pg_constraint k JOIN pg_namespace n ON n.oid = k.connamespace
              WHERE n.nspname = 'public' AND k.conname = e.name)
           WHEN 'column' THEN EXISTS (
             SELECT 1 FROM pg_attribute a
               JOIN pg_class c     ON c.oid = a.attrelid
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public'
                AND c.relname = split_part(e.name, '.', 1)
                AND a.attname = split_part(e.name, '.', 2)
                AND a.attnum > 0
                AND NOT a.attisdropped)
           -- An unrecognised kind is UNKNOWN, and unknown must never read as
           -- present. The COALESCE below is what makes NULL count as missing.
           ELSE NULL
         END AS present
    FROM expected e
)
SELECT migration,
       count(*) FILTER (WHERE present) AS found,
       count(*)                        AS expected,
       CASE
         WHEN bool_and(coalesce(present, false)) THEN 'APPLIED'
         WHEN bool_or (coalesce(present, false)) THEN 'PARTIAL -- investigate'
         ELSE 'NOT APPLIED'
       END AS verdict,
       coalesce(string_agg(kind || ' ' || name, ', ' ORDER BY kind, name)
                  FILTER (WHERE NOT coalesce(present, false)), '') AS missing
  FROM checked
 GROUP BY migration
 ORDER BY migration;
```

**To see every object rather than the summary**, replace the final `SELECT …
GROUP BY … ORDER BY` with:

```sql
SELECT * FROM checked ORDER BY coalesce(present, false), migration, kind, name;
```

**Reading the result.**

- `APPLIED` — every object this file creates is in the catalog. It does **not**
  prove the *bodies* match the file; see "What this cannot tell you" below.
- `PARTIAL` — the dangerous one, and the state 009 was found in. Something ran
  and something did not. Do not assume the missing half is harmless: read the
  per-migration section for what depends on it.
- `NOT APPLIED` — nothing from this file is here.

---

## The runner's own ledger — a hint, never the answer

R6.1.1 added a `schema_migrations` table, written by `scripts/setup-supabase.mjs`
(`scripts/setup-supabase.mjs:28-48`):

```sql
SELECT filename, checksum, sql_checksum, applied_at, first_applied_at
  FROM schema_migrations
 ORDER BY filename;
```

If that query errors with `relation "schema_migrations" does not exist`, the
runner has never run against this database — everything was applied by hand, or
not at all.

**Why this is a hint and not the answer, in four specific ways:**

1. A migration pasted into the SQL editor by hand leaves **no row**. Absence is
   not evidence of absence.
2. A row records that the file **executed**, not that its objects still exist.
   Anyone can drop an index afterwards; the row stays.
3. `applied_at` is overwritten on every re-run (`ON CONFLICT (filename) DO
   UPDATE … applied_at = now()`, `scripts/setup-supabase.mjs:502-507`).
   `first_applied_at` is the one that is never overwritten, and it is
   **nullable with no default on purpose** — rows written before that column
   existed have an unknown first-apply time and read as `NULL`, which means
   unknown, not "today".
4. The drift warning is **one-shot**. The `DO UPDATE` replaces the stored
   checksum inside the same transaction that applied the file, so an edit to a
   migration warns on the first run after the edit and is silent thereafter.
   The source says so in the present tense at
   `scripts/setup-supabase.mjs:481-495`: *"Nothing tests the drift path… `git
   log` on the migration file is the record that survives."*

So: use `schema_migrations` to see what the runner believes, and the catalog
query above to see what is true. When they disagree, the catalog wins.

---

## Row-level security and policies — one query for the house rule

Every table since 001 gets `ENABLE ROW LEVEL SECURITY` plus one `Allow anon all
on <table>` policy. The app holds only the anon key, so **a table with RLS on
and no policy is invisible to the app** — reads return empty and writes fail,
which is a silent-wrong-number shape, not a crash.

```sql
SELECT c.relname                                   AS table_name,
       c.relrowsecurity                            AS rls_enabled,
       coalesce(array_agg(p.policyname::text ORDER BY p.policyname)
                  FILTER (WHERE p.policyname IS NOT NULL), '{}'::text[]) AS policies
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_policies p
         ON p.schemaname = n.nspname AND p.tablename = c.relname
 WHERE n.nspname = 'public'
   AND c.relkind = 'r'
 GROUP BY c.relname, c.relrowsecurity
 ORDER BY c.relrowsecurity, c.relname;
```

Expected, from the DDL: `rls_enabled = true` and exactly one
`Allow anon all on <table>` policy for `scans`, `brand_prompts`, `scan_jobs`,
`content_events` (001:108-137), `content_jobs`, `content_items`,
`content_feedback`, `brand_briefs`, `content_lessons` (002:92-116),
`content_agents` (003:66), `knowledge_blocks` (004:36), `prompt_results`,
`result_brands`, `citations`, `brand_metrics_daily`, `scan_schedules`, `topics`
(005:133-163), `content_runs` (006:74), `system_heartbeats` (008:24),
`scan_rate_limits` (009:30), `probe_tasks` (010:93), `scan_runs` (011:197).

`schema_migrations` is created by the runner, not by a migration, and has **no**
RLS — it is only ever touched over a direct Postgres connection.

---

# Per-migration

Each section states what the file creates, the query that answers "applied
here", and what re-running it would do. **All twelve are re-runnable** — every
one opens with a "safe to re-run" comment and uses `IF NOT EXISTS` / guarded
`DO` blocks / `CREATE OR REPLACE`. That is not the same as "re-running converges
the schema", and the three ways it does not are stated once here:

- **`CREATE TABLE IF NOT EXISTS` will not add a column to an existing table.**
  If a `CREATE TABLE` in an already-applied migration is edited to add a column,
  re-running that file is a **no-op** on any database that already has the
  table. The new column will never arrive. This is why 001, 003, 004 and 005
  carry separate `ADD COLUMN` blocks for columns added after the fact, and it is
  the single most likely way this schema drifts silently.
- **`CREATE OR REPLACE FUNCTION` does overwrite** — so re-running 009/010/011/012
  replaces those function bodies with whatever the file currently says. Rolling
  the repo back to an older commit and re-running is therefore a live downgrade
  of those functions, not a no-op.
- **`CREATE OR REPLACE FUNCTION` cannot rename a parameter or change its type**
  — it errors (`cannot change name of input parameter`), or, if the argument
  *list* changes, it creates a **second overload** rather than replacing.
  A name-only `pg_proc` check — which is what `scripts/setup-supabase.mjs:382-388`
  does, and what the master query above does — cannot see either case. The
  signature query at the end of this file can.

None of the twelve contains a `DROP`, a `TRUNCATE`, a `DELETE`, or a
destructive `ALTER`. The only migration that can *fail* on live data is 007;
see its section.

---

## `001_initial_schema.sql`

**Creates:** tables `scans` (:5), `brand_prompts` (:29), `scan_jobs` (:52),
`content_events` (:69); unique constraints `brand_prompts_brand_text_idx` (:47)
and `content_events_brand_url_idx` (:83); a retro-fit `DO` block adding
`brand_prompts.source` (:91), `scan_jobs.query_source` (:95),
`scan_jobs.gsc_queries` (:99), `scans.query_source` (:103); RLS + four anon
policies (:108-137).

```sql
SELECT 'table' AS kind, c.relname AS name
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r'
   AND c.relname IN ('scans','brand_prompts','scan_jobs','content_events')
UNION ALL
SELECT 'constraint', k.conname
  FROM pg_constraint k JOIN pg_namespace n ON n.oid = k.connamespace
 WHERE n.nspname = 'public'
   AND k.conname IN ('brand_prompts_brand_text_idx','content_events_brand_url_idx')
UNION ALL
SELECT 'column', c.relname || '.' || a.attname
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND a.attnum > 0 AND NOT a.attisdropped
   AND (c.relname, a.attname) IN
       (('brand_prompts','source'), ('scan_jobs','query_source'),
        ('scan_jobs','gsc_queries'), ('scans','query_source'))
 ORDER BY 1, 2;
```

**Applied ⇔ 10 rows.** Fewer rows names exactly what is absent.

**Re-run:** safe and a full no-op on an existing database. The `DO` block's
column adds are guarded by `information_schema.columns` (:88-105), which is
correct because the runner connects as the owner.

## `002_content_os.sql`

**Creates:** `content_jobs` (:5), `content_items` (:19), `content_feedback`
(:38), `brand_briefs` (:48), `content_lessons` (:57); the deferred FK
`content_jobs_item_id_fkey` (:75); RLS + five policies (:92-116).

```sql
SELECT 'table' AS kind, c.relname AS name
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r'
   AND c.relname IN ('content_jobs','content_items','content_feedback',
                     'brand_briefs','content_lessons')
UNION ALL
SELECT 'constraint', k.conname
  FROM pg_constraint k JOIN pg_namespace n ON n.oid = k.connamespace
 WHERE n.nspname = 'public' AND k.conname = 'content_jobs_item_id_fkey'
 ORDER BY 1, 2;
```

**Applied ⇔ 6 rows.** The FK is listed separately on purpose: 002 declares
`content_jobs.item_id` as a plain `uuid` (:12) and adds the constraint after
both tables exist, so a database can have all five tables and no FK if the
`DO` block at :70-79 failed.

`brand_briefs.brand` also carries an inline `UNIQUE` (:50). PostgreSQL
auto-names that constraint; the name is **not** stated in the DDL, so this
document does not assert one. To see it: `SELECT conname FROM pg_constraint k
JOIN pg_class c ON c.oid = k.conrelid WHERE c.relname = 'brand_briefs';`

**Re-run:** safe, no-op.

## `003_content_agents.sql`

**Creates:** `content_agents` (:5); columns `content_jobs.agent_id` (:33),
`content_jobs.agent_snapshot` (:36), `content_jobs.agent_trace` (:39),
`content_items.agent_id` (:42), `content_items.agent_snapshot` (:45); unique
constraint `content_agents_brand_slug_idx` (:55); RLS + policy (:66).

```sql
SELECT 'table' AS kind, c.relname AS name
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = 'content_agents'
UNION ALL
SELECT 'constraint', k.conname
  FROM pg_constraint k JOIN pg_namespace n ON n.oid = k.connamespace
 WHERE n.nspname = 'public' AND k.conname = 'content_agents_brand_slug_idx'
UNION ALL
SELECT 'column', c.relname || '.' || a.attname
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND a.attnum > 0 AND NOT a.attisdropped
   AND (c.relname, a.attname) IN
       (('content_jobs','agent_id'), ('content_jobs','agent_snapshot'),
        ('content_jobs','agent_trace'), ('content_items','agent_id'),
        ('content_items','agent_snapshot'))
 ORDER BY 1, 2;
```

**Applied ⇔ 7 rows.** The five columns are the discriminator: `content_agents`
existing proves only that the `CREATE TABLE` ran. 002's `content_jobs` does not
declare `agent_id`, so its presence can only have come from this file.

**Re-run:** safe, no-op.

## `004_crew_canvas_knowledge.sql`

**Creates:** columns `content_agents.pipeline` (:8) and
`content_agents.block_config` (:11); table `knowledge_blocks` (:16); RLS +
policy (:36).

```sql
SELECT 'table' AS kind, c.relname AS name
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = 'knowledge_blocks'
UNION ALL
SELECT 'column', c.relname || '.' || a.attname
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND a.attnum > 0 AND NOT a.attisdropped
   AND c.relname = 'content_agents' AND a.attname IN ('pipeline','block_config')
 ORDER BY 1, 2;
```

**Applied ⇔ 3 rows.** `scripts/setup-supabase.mjs:76` checks only
`knowledge_blocks` for this migration, so the runner would call a database
"complete" with neither column present. This query does not.

**Re-run:** safe, no-op.

## `005_analytics_platform.sql`

**Creates:** six tables — `prompt_results` (:8), `result_brands` (:32),
`citations` (:46), `brand_metrics_daily` (:66), `scan_schedules` (:84),
`topics` (:97); seven indexes (:28, :29, :43, :62, :63, :116, :117); six
retro-fit columns on tables from 001/002 (:104-113); RLS + six policies
(:133-163).

```sql
SELECT 'table' AS kind, c.relname AS name
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r'
   AND c.relname IN ('prompt_results','result_brands','citations',
                     'brand_metrics_daily','scan_schedules','topics')
UNION ALL
SELECT 'index', c.relname
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'i'
   AND c.relname IN ('prompt_results_brand_idx','prompt_results_scan_idx',
                     'result_brands_scan_idx','citations_brand_domain_idx',
                     'citations_scan_idx','scan_jobs_heartbeat_idx',
                     'scan_schedules_next_run_idx')
UNION ALL
SELECT 'column', c.relname || '.' || a.attname
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND a.attnum > 0 AND NOT a.attisdropped
   AND (c.relname, a.attname) IN
       (('brand_prompts','topic_id'), ('brand_prompts','status'),
        ('brand_prompts','search_volume_band'), ('scan_jobs','checkpoint'),
        ('scan_jobs','heartbeat_at'), ('content_jobs','heartbeat_at'))
 ORDER BY 1, 2;
```

**Applied ⇔ 19 rows.** `scan_jobs.checkpoint` and `scan_jobs.heartbeat_at` are
the two that matter operationally: without them chunked probing cannot
checkpoint and the rescue sweep cannot see staleness, and both failures look
like a scan that is quietly stuck rather than one that errored.
`content_jobs.heartbeat_at` (:113) is the column the migration's own comment
says was authored by a different agent than the code that writes it — its
absence 500s every Content OS create/update.

`prompt_results` also carries an inline `UNIQUE (job_id, engine, query)` (:26) —
the chunk-idempotency key. Auto-named, so not asserted here; list it with
`SELECT conname FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
WHERE c.relname = 'prompt_results';` and confirm exactly one unique constraint
exists. **If it is missing, chunk re-runs duplicate rows instead of upserting**,
which inflates every downstream count.

**Re-run:** safe, no-op.

## `006_agent_control_plane.sql`

**Creates:** lease columns on `content_jobs` (:18, :19) and `scan_jobs`
(:24, :25); indexes `content_jobs_heartbeat_idx` (:29), `content_jobs_lease_idx`
(:32), `content_runs_job_idx` (:62), `content_runs_brand_block_idx` (:63);
table `content_runs` (:46); RLS + policy (:74).

```sql
SELECT 'table' AS kind, c.relname AS name
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = 'content_runs'
UNION ALL
SELECT 'index', c.relname
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'i'
   AND c.relname IN ('content_jobs_heartbeat_idx','content_jobs_lease_idx',
                     'content_runs_job_idx','content_runs_brand_block_idx')
UNION ALL
SELECT 'column', c.relname || '.' || a.attname
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND a.attnum > 0 AND NOT a.attisdropped
   AND (c.relname, a.attname) IN
       (('content_jobs','lease_owner'), ('content_jobs','lease_expires_at'),
        ('scan_jobs','lease_owner'), ('scan_jobs','lease_expires_at'))
 ORDER BY 1, 2;
```

**Applied ⇔ 9 rows.**

`scripts/setup-supabase.mjs:85` verifies **one** object for this migration —
`content_jobs_heartbeat_idx`. A database with that index and no `content_runs`
table, and no `content_jobs.lease_owner`, passes `npm run setup:db`'s check and
loses content-job single-flight entirely. **This is a live gap in the runner's
list, not a hypothetical**; the query above is the one to trust.

**Re-run:** safe, no-op.

## `007_scan_seal.sql`

**Creates:** one unique partial index, `scan_jobs_one_running_per_brand` (:25),
on `lower(btrim(brand))` where `status IN ('pending','generating_prompts',
'probing','scoring')`.

```sql
SELECT i.relname                                   AS index_name,
       x.indisunique                               AS is_unique,
       x.indisvalid                                AS is_valid,
       pg_get_expr(x.indpred, x.indrelid)          AS predicate,
       pg_get_indexdef(x.indexrelid)               AS definition
  FROM pg_index x
  JOIN pg_class i     ON i.oid = x.indexrelid
  JOIN pg_class t     ON t.oid = x.indrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
 WHERE n.nspname = 'public'
   AND i.relname = 'scan_jobs_one_running_per_brand';
```

**Applied ⇔ exactly one row, with `is_unique = true` and `is_valid = true`.**
Zero rows means not applied. `is_unique = false` means something with that name
exists that seals nothing. `is_valid = false` means the build did not complete —
treat it as not applied and re-run.

The `predicate` column is the point of checking the definition rather than just
the name: the four statuses in the index **must** match `SCAN_JOB_RUNNING` in
`src/lib/db.js` (grep `export const SCAN_JOB_RUNNING`). A status added in JS
and not here reopens the race. *(The migration's own header cites
`src/lib/db.js:318` for that constant; at `1a5ed81` it is at `src/lib/db.js:556`.
The stated values still match — `pending`, `generating_prompts`, `probing`,
`scoring` — only the line number in the comment has gone stale.)*

**This is the one migration that can fail on live data.** `CREATE UNIQUE INDEX`
on a table that already violates the constraint aborts with `could not create
unique index … Key … is duplicated`. Run this pre-flight **first**:

```sql
SELECT lower(btrim(brand)) AS brand_key,
       count(*)            AS running_jobs,
       array_agg(id)       AS job_ids
  FROM scan_jobs
 WHERE status IN ('pending','generating_prompts','probing','scoring')
 GROUP BY 1
HAVING count(*) > 1
 ORDER BY 2 DESC;
```

Any rows and the index build will fail. Retire the stranded jobs first —
setting them to `failed` with an explanatory `error_message`, so the customer
sees an abandoned scan rather than a scan that is silently gone. This is a
**human decision and a write**; it is not part of the verification here, and it
is a step for `docs/OPERATOR_LEDGER.md`, not for this document.

**Re-run:** safe once the index exists (`IF NOT EXISTS`). Note that
`CREATE UNIQUE INDEX` without `CONCURRENTLY` takes a lock on `scan_jobs` for the
duration of the build.

## `008_system_heartbeats.sql`

**Creates:** table `system_heartbeats` (:11) — `name` PK, `last_tick_at`
`NOT NULL`, `detail` jsonb; RLS + policy (:24).

```sql
SELECT c.relname                AS table_name,
       c.relrowsecurity         AS rls_enabled,
       array_agg(a.attname::text ORDER BY a.attnum) AS columns
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
 WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = 'system_heartbeats'
 GROUP BY c.relname, c.relrowsecurity;
```

**Applied ⇔ one row with `columns = {name, last_tick_at, detail}`.** Zero rows
means not applied.

Worth knowing while you diagnose: the heartbeat write is **deliberately
non-fatal**. `recordCronTick` (`src/lib/db/analytics.js:555`) logs
`[heartbeat] could not record the "<name>" tick: …` and returns `null` rather
than failing the run it is only observing. So a missing 008 does not break the
cron — it makes `/api/health` unable to tell a cron that stopped from a cron
with nothing to do, which is the exact ambiguity 008 was created to remove.

**Re-run:** safe, no-op.

## `009_scan_rate_limit.sql`

**Creates:** table `scan_rate_limits` (:11) with PK `(bucket_key,
window_start)`; index `scan_rate_limits_window_idx` (:20); function
`increment_scan_rate_limit(text, timestamptz)` (:41); RLS + policy (:30).

```sql
SELECT 'table' AS kind, c.relname AS name, NULL::text AS detail
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = 'scan_rate_limits'
UNION ALL
SELECT 'index', c.relname, NULL::text
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'i'
   AND c.relname = 'scan_rate_limits_window_idx'
UNION ALL
SELECT 'function', p.proname, pg_get_function_identity_arguments(p.oid)
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'increment_scan_rate_limit'
 ORDER BY 1, 2;
```

**Applied ⇔ 3 rows**, with the function's `detail` reading exactly
`text, timestamp with time zone`.

**Check all three.** This migration is the reason rule 1 exists in this
repository: it has been observed in production as *table present, function
absent*, and a head-probe of `scan_rate_limits` reports that state as fine.
With the function missing, the free-scan cap does not apply.

**Do not test it by calling it** — see rule 2. `increment_scan_rate_limit` is
an `INSERT … ON CONFLICT DO UPDATE … RETURNING hits` (:45-49) and consumes a
real hit against whatever bucket key you pass.

**Re-run:** safe. The table and index are `IF NOT EXISTS`; the function is
`CREATE OR REPLACE`, so re-running overwrites the body with the file's version.

## `010_probe_tasks.sql`

**Creates:** table `probe_tasks` (:30) with `probe_tasks_status_chk` (:55) and
`probe_tasks_outcome_chk` (:57); three partial indexes (:68, :73, :78); four
functions — `claim_probe_tasks` (:124), `renew_probe_lease` (:240),
`complete_probe_tasks` (:279), `release_probe_tasks` (:351); RLS + policy (:93).

```sql
SELECT 'table' AS kind, c.relname AS name, NULL::text AS detail
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = 'probe_tasks'
UNION ALL
SELECT 'index', c.relname, pg_get_expr(x.indpred, x.indrelid)
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_index x ON x.indexrelid = c.oid
 WHERE n.nspname = 'public' AND c.relkind = 'i'
   AND c.relname IN ('probe_tasks_claim_idx','probe_tasks_batch_idx',
                     'probe_tasks_lease_idx')
UNION ALL
SELECT 'constraint', k.conname, pg_get_constraintdef(k.oid)
  FROM pg_constraint k JOIN pg_namespace n ON n.oid = k.connamespace
 WHERE n.nspname = 'public'
   AND k.conname IN ('probe_tasks_status_chk','probe_tasks_outcome_chk')
UNION ALL
SELECT 'function', p.proname, pg_get_function_identity_arguments(p.oid)
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('claim_probe_tasks','renew_probe_lease',
                     'complete_probe_tasks','release_probe_tasks')
 ORDER BY 1, 2;
```

**Applied ⇔ 10 rows.** Expected signatures:

| Function | Identity arguments |
|---|---|
| `claim_probe_tasks` | `text, text[], integer, integer, uuid` |
| `renew_probe_lease` | `text, uuid[], integer` |
| `complete_probe_tasks` | `text, jsonb` |
| `release_probe_tasks` | `text, uuid[]` |

More than one row per function name means an overload was created by an edited
signature, and PostgREST's `rpc/` dispatch on an ambiguous name is not something
to leave in place.

`probe_tasks_outcome_chk` should read as the eight-value closed vocabulary
(`answered, no_answer, blocked, captcha, login_wall, timeout, parse_error,
skipped`). That CHECK is the single place a `blocked` probe cannot be written as
`no_answer`, which is the whole point of the constraint.

**Nothing deployed needs this migration.** See the gap note above the
dependency table. A missing 010 has **no** observable symptom today, so this
query is the only detector there is.

**Re-run:** safe. Table, indexes and constraints are guarded; the four functions
are `CREATE OR REPLACE` and will be overwritten from the file.

## `011_scan_runs.sql`

**Creates:** table `scan_runs` (:78) with six CHECK constraints (:138, :139,
:142, :144, :148, :153); four indexes, three of them partial (:163, :169, :176,
:183); three functions — `open_scan_run` (:220), `heartbeat_scan_run` (:257),
`close_scan_run` (:299); RLS + policy (:197).

```sql
SELECT 'table' AS kind, c.relname AS name, NULL::text AS detail
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = 'scan_runs'
UNION ALL
SELECT 'index', c.relname, pg_get_expr(x.indpred, x.indrelid)
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_index x ON x.indexrelid = c.oid
 WHERE n.nspname = 'public' AND c.relkind = 'i'
   AND c.relname IN ('scan_runs_job_idx','scan_runs_batch_idx',
                     'scan_runs_open_idx','scan_runs_runner_idx')
UNION ALL
SELECT 'constraint', k.conname, pg_get_constraintdef(k.oid)
  FROM pg_constraint k JOIN pg_namespace n ON n.oid = k.connamespace
 WHERE n.nspname = 'public'
   AND k.conname IN ('scan_runs_runner_chk','scan_runs_outcome_chk',
                     'scan_runs_open_chk','scan_runs_reason_chk',
                     'scan_runs_subject_chk','scan_runs_counts_chk')
UNION ALL
SELECT 'function', p.proname, pg_get_function_identity_arguments(p.oid)
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('open_scan_run','heartbeat_scan_run','close_scan_run')
 ORDER BY 1, 2;
```

**Applied ⇔ 14 rows.** Expected signatures:

| Function | Identity arguments |
|---|---|
| `open_scan_run` | `text, text, text, uuid, uuid, text, jsonb` |
| `heartbeat_scan_run` | `uuid` |
| `close_scan_run` | `uuid, text, text, integer, integer, integer, text, jsonb` |

**The constraints are load-bearing, not decoration**, so check them by
definition rather than by name:

- `scan_runs_open_chk` — `(outcome IS NULL) = (ended_at IS NULL)`. Without it a
  run can be `ended_at` set with no outcome, which every reader rounds up to
  "fine".
- `scan_runs_reason_chk` — a non-`succeeded` outcome must carry a reason. This is
  the constraint that abolishes the unexplained skip.
- `scan_runs_counts_chk` — `probes_succeeded <= probes_attempted`. A >100%
  success rate is the arithmetic signature of the false-100% bug this rebuild is
  named after.

**Do not `DEFAULT 0` the counters.** `probes_attempted`, `probes_succeeded` and
`errors_recovered` are deliberately nullable with no default (:115-121): NULL
means *not measured*. A helpful-looking `ALTER TABLE … SET DEFAULT 0` on this
table would turn "never counted" into "counted zero" across the whole ledger.
Verify with:

```sql
SELECT a.attname, a.attnotnull, pg_get_expr(d.adbin, d.adrelid) AS column_default
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
 WHERE n.nspname = 'public' AND c.relname = 'scan_runs'
   AND a.attname IN ('probes_attempted','probes_succeeded','errors_recovered');
```

All three must show `attnotnull = false` and `column_default = NULL`.

**Re-run:** safe. But note the general warning above — if a CHECK is ever added
to the `CREATE TABLE` block after this file shipped, re-running will **not** add
it to an existing `scan_runs`.

## `012_scan_job_attempts.sql`

**Creates:** column `scan_jobs.attempts integer NOT NULL DEFAULT 0` (:81);
constraint `scan_jobs_attempts_chk` (:88); partial index
`scan_jobs_attempts_idx` (:104); function `claim_scan_job_attempt` (:124).

```sql
SELECT 'column' AS kind, a.attname AS name,
       format_type(a.atttypid, a.atttypmod) || ' notnull=' || a.attnotnull::text
         || ' default=' || coalesce(pg_get_expr(d.adbin, d.adrelid), 'none') AS detail
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
 WHERE n.nspname = 'public' AND c.relname = 'scan_jobs' AND a.attname = 'attempts'
   AND a.attnum > 0 AND NOT a.attisdropped
UNION ALL
SELECT 'constraint', k.conname, pg_get_constraintdef(k.oid)
  FROM pg_constraint k JOIN pg_namespace n ON n.oid = k.connamespace
 WHERE n.nspname = 'public' AND k.conname = 'scan_jobs_attempts_chk'
UNION ALL
SELECT 'index', c.relname, pg_get_indexdef(c.oid)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'i'
   AND c.relname = 'scan_jobs_attempts_idx'
UNION ALL
SELECT 'function', p.proname, pg_get_function_identity_arguments(p.oid)
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'claim_scan_job_attempt'
 ORDER BY 1, 2;
```

**Applied ⇔ 4 rows**, with the function's `detail` reading `uuid, integer`.

**The index is the discriminator, and that is by design.** The migration says so
at :97-103, and `scripts/setup-supabase.mjs:123-127` repeats it: the runner's
catalog probe can see tables, indexes and functions but **not columns**, and an
index *on* the column cannot exist unless the column does. Checking only
`claim_scan_job_attempt` would not work — a plpgsql body does not resolve its
column references until it runs, so the function can exist and be broken.

**Do not call `claim_scan_job_attempt` to test it.** At the cap it writes
`status='failed'`, `progress_pct=100` and a `max_attempts:` message onto a live
job (:189-194).

Two behaviours worth knowing when a customer asks why their scan stopped:

- An abandoned job's `error_message` starts with the marker `max_attempts:`, and
  that string is what `/api/scan/[job_id]/status` hands the browser. To find
  them: `SELECT id, brand, error_message FROM scan_jobs WHERE error_message LIKE
  'max_attempts:%' ORDER BY created_at DESC;`
- The cap counts **consecutive resumes that achieved nothing**; measured
  progress resets `attempts` to 0 (:43-52). A job with `attempts = 2` is not
  two chunks in, it is two dead executors in.

**Re-run:** safe. `ADD COLUMN … NOT NULL DEFAULT 0` does **not** rewrite the
table on PostgreSQL 11+ (the default is stored in the catalog), so the
`ACCESS EXCLUSIVE` lock on `scan_jobs` lasts for a catalog write, not a table
scan. It does not backfill or retire jobs already stranded in a running status —
they start at `attempts = 0` and get three fresh chances. Retiring existing
 corpses is an operator action.

## `014_content_job_checkpoints.sql`

**Creates:** column `content_jobs.checkpoint jsonb`.

The only non-comment line in the file is (line 11):
`ALTER TABLE content_jobs ADD COLUMN IF NOT EXISTS checkpoint jsonb;`

This is a column-only migration with no index, no constraint and no function —
the same column-invisibility problem as 012 and 013, but without a proxy index
whose existence could stand in for the column.

```sql
SELECT 'column' AS kind, a.attname AS name,
       format_type(a.atttypid, a.atttypmod) || ' notnull=' || a.attnotnull::text
         || ' default=' || coalesce(pg_get_expr(d.adbin, d.adrelid), 'none') AS detail
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
 WHERE n.nspname = 'public' AND c.relname = 'content_jobs' AND a.attname = 'checkpoint'
   AND a.attnum > 0 AND NOT a.attisdropped;
```

**Applied ⇔ 1 row.** Zero rows means not applied.

**Why this matters.** Without `checkpoint`, content jobs do not merely lose the
ability to resume — they fail. `updateContentJob` throws on a PostgREST `PGRST204`
for an unknown column, and the first checkpoint write goes out at the first block
boundary. On a pre-`014` database the first block that finishes throws, not the
first rescue.

**Re-run:** safe. `ADD COLUMN IF NOT EXISTS` is a no-op on a database that
already has the column.

---

## `015_brand_metrics_citation_state.sql` … `019_probe_evidence_bucket.sql`

Applied to production (`nggyizuwqepxaqnpcqqj`) on 2026-09-15 through the
Supabase MCP, in filename order, immediately before PR #1 merged to `main`,
and verified from `pg_attribute` / `pg_class` / `pg_constraint` — not from a
head probe. Each file's own header carries its catalog query.

| File | Creates | Applied ⇔ |
|---|---|---|
| `015_brand_metrics_citation_state.sql` | `brand_metrics_daily.citation_denominator` / `.citation_state` / `.citation_state_reason`, four CHECKs, `brand_metrics_daily_citation_unverified_idx` | 3 columns + 4 `brand_metrics_daily_citation%` constraints |
| `016_content_items_natural_key.sql` | `content_items.cycle`, constraint `content_items_job_id_cycle_key` | column + constraint |
| `016_crawlability_audit_history.sql` | table `crawlability_audits`, `crawlability_audits_domain_idx`, unique `crawlability_audits_domain_minute_idx` | table + both indexes. The minute index truncates `audited_at AT TIME ZONE 'UTC'`: `date_trunc` on `timestamptz` is STABLE and Postgres refuses it in an index |
| `017_cost_unmeasured_calls.sql` | `scans.cost_unmeasured_calls` | column |
| `018_gsc_daily.sql` | tables `gsc_connections`, `gsc_daily`, index `gsc_daily_brand_date_idx` (R4.1.1) | both tables + index |
| `019_probe_evidence_bucket.sql` | Storage bucket `probe-evidence` (private, 5 MiB, png/gzip/html) + three `storage.objects` policies `probe-evidence anon *` (R1.5.1) | 1 row in `storage.buckets` + 3 policies — see `docs/runbooks/probe-evidence.md` |

**015 has no SQL backfill.** Run `scripts/backfill-analytics.mjs` afterwards;
until then pre-015 rows keep `citation_state` NULL (unverified).

---

## Function signatures — the check the runner cannot make

`scripts/setup-supabase.mjs:382-388` checks functions by **name only**. Two
things that check cannot see: a function whose parameter list changed (which
`CREATE OR REPLACE` turns into a *second* overload rather than a replacement),
and a function replaced with a different body. This catches the first:

```sql
SELECT p.proname,
       pg_get_function_identity_arguments(p.oid) AS identity_args,
       pg_get_function_result(p.oid)             AS returns,
       l.lanname                                 AS language,
       p.prosecdef                               AS security_definer
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_language  l ON l.oid = p.prolang
 WHERE n.nspname = 'public'
   AND p.proname IN ('increment_scan_rate_limit','claim_probe_tasks',
                     'renew_probe_lease','complete_probe_tasks',
                     'release_probe_tasks','open_scan_run',
                     'heartbeat_scan_run','close_scan_run',
                     'claim_scan_job_attempt')
 ORDER BY p.proname, identity_args;
```

**Expect exactly nine rows, one per name.** Ten or more means an overload.
`security_definer` must be `false` for all nine — `claim_scan_job_attempt` is
`SECURITY INVOKER` deliberately (`012_scan_job_attempts.sql:120-123`), so that
the function never has more authority than the anon key the app calls it with.

To compare a body against the file, hash it and diff against the migration by
eye — there is no automated body check anywhere in this repo:

```sql
SELECT proname, md5(prosrc) FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND proname = 'claim_scan_job_attempt';
```

---

## What this document cannot tell you

Stated plainly, because a verification doc that implies completeness is worse
than none:

1. **It has never been run against the production database.** These queries were
   derived from the DDL and reviewed as SQL; no live execution result backs any
   expected row count here. The first operator to run them should record what
   came back — and, if a query is wrong, fix it here in the same commit.
2. **`APPLIED` does not mean "matches the file".** A table can exist with the
   right name and the wrong columns if its `CREATE TABLE` was edited after it
   shipped; `CREATE TABLE IF NOT EXISTS` will never notice. The per-migration
   sections check the columns that were *added separately*, which is where most
   post-hoc edits land, but not every column of every table.
3. **Auto-named constraints are not asserted.** `brand_briefs.brand UNIQUE` and
   `prompt_results UNIQUE (job_id, engine, query)` are declared inline with no
   name in the DDL, so this file gives you a query to *list* them rather than a
   name to match. Asserting a name PostgreSQL happened to generate would be
   plausible-looking SQL that was never derived from anything.
4. **Row counts assume nothing else in this schema shares those object names.**
   All the queries are scoped to `public`; a duplicate object in another schema
   is out of scope.
5. **No migration in this set is reversible.** There are no down-migrations
   anywhere in `supabase/migrations/`. "Rolling back" means writing a new
   migration; checking out an older commit and re-running `setup:db` will
   silently overwrite the four `CREATE OR REPLACE` function sets with older
   bodies while leaving every table exactly as it is.

## See also

- `README.md` § Database — the one-line summary table of what each migration
  adds. That table is guarded: `src/lib/docStatus.test.mjs` fails if a migration
  on disk is missing from it.
- `scripts/setup-supabase.mjs:61-132` — `EXPECTED_OBJECTS`, the runner's own
  post-apply catalog check. Narrower than this file for 001-006; identical in
  spirit.
- `src/lib/migrationsLedger.test.mjs`, `src/lib/migrationsRunner.test.mjs` — the
  guards that stop `EXPECTED_OBJECTS` going stale again (finding C10).
- `docs/plans/2026-08-29-rebuild-roadmap.md:13-25` — the eleven standing rules,
  of which rule 4 is the one this file serves.
