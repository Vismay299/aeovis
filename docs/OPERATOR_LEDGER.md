# Operator ledger

> <!-- doc-status -->
> **Status: LIVE.** The list of things a human must do that no agent, test or
> CI job can do for them, and — for each — *why* it is not automated. If an item
> here is automatable and merely un-automated, that is a bug in this file; say so
> and move it.

**Date:** 2026-09-08 · **Task:** R6.2.1 (finding S27) · **Verified at:** `ea165ed`
**and the working tree on top of it** — see the next paragraph for why both.

**Amended 2026-09-09 (R6.2.4), unverified against a commit.** Two additions, both
labelled where they appear and neither re-checking the rest of the file: § B now
documents `SCAN_RATE_LIMIT_UNVERIFIED_CEILING`, which had been live and
undocumented since R0.1.22, and § E gained `R3.3.5` plus the guard that stops it
going stale again. Everything else here still carries the R6.2.1 sweep's
provenance and no more.

> **Citation anchoring — read before following a line number.** The previous
> revision of this file swept all 17 of its citations against commit `04e80db`,
> and every one of them held *there*. It then shipped in `220d93d` — the same
> commit that rewrote `src/lib/rateLimit.js` (192 lines), added migration `013`,
> and moved three cited statements in `scripts/setup-supabase.mjs`. Four claims
> in this document were false the moment it landed, and one of them asserted the
> **exact inverse** of the code it cited. The sweep was honest; the commit
> falsified the artefact.
>
> The lesson, which applies to anything written here next: **a citation sweep
> against the parent commit proves nothing about the commit the document ships
> in** — and no author can sweep against a commit that does not exist yet. The
> only durable fix is not to depend on line numbers. So where a symbol or a
> grep-able marker exists, this file names *that* and describes the mechanism in
> words. Treat a line number here as a hint about *which file*; the `git grep`
> given beside each claim is the lookup that survives.
>
> This revision was resolved against `ea165ed` **and** against the working tree,
> because roughly twenty source files are dirty from concurrent agents and the
> next commit will contain their edits too. Where the two disagreed (they do for
> `src/lib/rateLimit.js`, which has moved again), this file states only what is
> true in both.

---

## Rules for this file

1. **Names, never values.** Every credential below appears as a *variable name*.
   No value, no prefix, no partial redaction, no realistic-looking example. If
   you need a placeholder, write `EXAMPLE-NOT-A-REAL-KEY`. This is not decoration:
   two agents leaked real credentials into transcripts on 2026-09-03 by running
   unscoped recursive searches, and one of those leaks is [item 1](#1-rotate-the-gsc-service-account-key--r0115) below.
2. **The ledger of record is `.claude/orchestration/tasks.json`, not this file.**
   Task statuses change hourly while agents work. This file names *which* tasks
   need a human and *what the human must do*; it deliberately states no totals,
   because a total is stale the moment it is written. Re-derive the live list:

   ```
   node .claude/orchestration/orchestrate.mjs status
   node .claude/orchestration/orchestrate.mjs show <id>
   ```

   The five human-gate tags are `needs-secrets`, `needs-vercel`, `needs-decision`,
   `needs-llm` and `needs-soak`. Everything in this document carries one of them,
   or is a standing operational duty (§ D, § E).
3. **Searching for a credential is itself the hazard.** Exclude `.env*` from every
   recursive search, every time: `rg --glob '!.env*'`, `grep -r --exclude='.env*'`.
   Prefer `git grep`, which only sees tracked files and therefore cannot reach
   `.env.local`. Never add `--no-ignore`, `-uu` or `--hidden` at the repo root.
   `.env.example` holds placeholder names only and is safe to read.

---

## A. Open right now, in the order they should be done

These four are the items an agent has explicitly stopped on and filed rather than
worked around. Item 1 is a live security ticket; items 2 and 3 unblock whole
phases behind them.

### 1. ROTATE the GSC service-account key — R0.1.15

**Status in the ledger:** `blocked`, tag `needs-secrets`.

On 2026-09-03 a verifier working R0.1.6 ran an unscoped recursive search for the
variable name `GSC_SERVICE_ACCOUNT_KEY`. It matched `.env.local` and printed the
entire value — a base64 service-account JSON that decodes to a complete RSA
private key — into its own transcript. The agent disclosed it immediately. It was
the **second** credential leak by a verifier on that same task; an earlier one
printed most of a retired LLM-gateway key.

Do this:

1. Revoke the key for the service account in the Google Cloud project's IAM →
   Service Accounts → Keys. Revoke, do not merely replace — the old key stays
   valid until it is deleted.
2. Issue a new JSON key, base64-encode it (the one-line form `.env.example`
   documents), and set `GSC_SERVICE_ACCOUNT_KEY` in `.env.local` **and** in the
   Vercel project.
3. `npm run check:secrets` and confirm the `gsc` row authenticates with the new
   credential. That is the acceptance criterion on R0.1.15.
4. `node .claude/orchestration/orchestrate.mjs unblock R0.1.15 --note "..."` once
   the catalogue shows the old key gone.

**Mitigating, not excusing.** The account's granted scope is read-only —
`webmasters.readonly`, `src/lib/engines/gsc.js:17` — and R0.1.6 established live
that the account is a user on **zero** Search Console properties, so its current
read authority is nil. But it authenticates as a service account inside the
project, and a service-account identity is not a scope. Treat it as compromised.

**Why not automated:** revoking and reissuing a Google Cloud key requires an
authenticated human in the Cloud console. Nothing in this repo holds credentials
that could do it, and giving an agent a credential-minting credential to automate
credential rotation is a worse trade than the manual step.

### 2. Confirm `CRON_SECRET` and `OPERATOR_TOKEN` are live on Vercel — R0.1.12

**2026-09-18 partial:** `vercel env ls production` lists both `CRON_SECRET` and `OPERATOR_TOKEN` (names only were read), so *set* is confirmed. *Works* is half-confirmed: the production alias answers `401` to an unauthenticated `GET /api/scan/worker`. Still owed: the bearer call returning `200` and the `POST /api/content` no-token `401` — the agent's attempts were refused by its own permission policy on production reads, which is the right refusal. Run them yourself; the commands are below. **Later the same day:** `CRON_SECRET` rotated on `aeo-vis` production and redeployed; the Zeabur CronJob's bearer call answers `200` (R3.1.12). Still owed: rotate `OPERATOR_TOKEN`, then the `POST /api/content` no-token `401` and the two `200`s.

**Status in the ledger:** `blocked`, tag `needs-vercel`. **Both values were also
pasted into a session transcript and are due for rotation, so the confirmation
and the rotation are one job.**

The *code* for both gates is settled and proven over HTTP against a local
production-mode server (R0.1.1, R0.1.3). What is unproven is the *deployment*.
Standing rule 3 applies: **set** and **works** are different claims, and
`check:secrets` reports the `cron` row unconfigured in this environment.

There is an ordering constraint here that will take a dashboard down if it is
missed. `src/middleware.js` — the operator perimeter — **does not exist on
`main`**; it exists only on the rebuild branch, well over a hundred commits
ahead. (Confirm both facts rather than trusting a number that rots:
`git cat-file -e main:src/middleware.js` fails, and `git rev-list --count
main..HEAD` gives today's distance.) It reads `process.env.OPERATOR_TOKEN`
(`src/middleware.js:36`) and, in production with the variable unset, **refuses
every operator route** with `401` and logs
`[perimeter] REFUSING ... OPERATOR_TOKEN is not set in production.`
(`src/middleware.js:66`). So:

> **Set `OPERATOR_TOKEN` in Vercel BEFORE PR #1 merges, not after.** It fails
> closed by design. The anonymous free-scan flow, `/api/industries` and
> `/api/health` stay open, so a smoke test of the landing page will look fine
> while every operator **API** 401s.

Read that last word exactly. The matcher is `matcher: ["/api/:path*"]`
(`src/middleware.js:83`) — API routes only. Page routes never reach the
middleware, so an operator screen still **renders**; what fails is each data
fetch it makes. Smoke-testing by loading a dashboard and seeing a page is
therefore not evidence the perimeter is off, and an empty-looking dashboard with
no error banner is the expected shape of a missing `OPERATOR_TOKEN`. Test with a
request to an operator API, not with a browser tab.

Acceptance, against the **deployed** instance and with **freshly rotated** values:

| Request | Expected |
| --- | --- |
| `GET /api/scan/worker`, no header | `401` |
| `GET /api/scan/worker`, bearer `CRON_SECRET` | `200` |
| `POST /api/content`, no token | `401` |
| `GET /api/industries` | `200` |
| `GET /api/health` | `200` |

**Why not automated:** no Vercel credentials exist on the build machine and the
Vercel MCP server is unauthorised in these sessions. A test can prove the gate
function rejects a bad secret; only a real request to the real origin can prove
the deployment has the value.

### 3. Provide one OpenRouter API key — R5.1.3

**Status in the ledger:** `blocked`, tag `needs-llm`. **Everything except the key
is done.**

The long-standing bug is closed: the gateway was Xiaomi MiMo while every variable
was named `OPENROUTER_*`, so a week of "OpenRouter billing failure" was actually
MiMo reporting an empty MiMo balance, and both proposed fixes would have changed
nothing. The configuration has been switched to the canonical provider-neutral
names, the deprecated `OPENROUTER_*` aliases are retired, and the model id was
verified against OpenRouter's live catalogue rather than assumed.

What remains is one credential:

- Set `LLM_API_KEY` to a real OpenRouter key (`sk-or-v1-` shape) in `.env.local`
  and in Vercel. `LLM_BASE_URL` and `LLM_MODEL` are already set.
- `npm run check:secrets` must report the `llm` row **PASS naming openrouter as
  the gateway it called** — not merely "configured". Today it correctly reports
  `UNCONFIGURED missing LLM_API_KEY`, which is the honest distinction between an
  absent credential and a broken one.
- Confirm no `OPENROUTER_*` alias remains set in either environment.

**This unblocks the entire R5 lane.** R5.1.2 (key re-enable checklist) gates all
of R5 by construction, and R5.3.x, R5.4.x and R4.1.2 sit behind it.

**Why not automated:** an agent cannot open a billing account or accept a
vendor's terms.

### 4. Hand-label 60–100 calibration answers — R0.4.2

**Status in the ledger:** `blocked`, tag `needs-secrets`. **Zero labels exist.**

The schema, the validator and the protocol are written and tested; the judgement
is the part that cannot be delegated. What is on disk:

- `test_reports/baseline-2026-08/LABELLING-PROTOCOL.md` — the stratified sampling
  table, five conventions decided once, and the rule that a truncated or errored
  answer is **dropped**, never labelled a non-mention. Its own status header says
  no labels have been produced.
- `test_reports/baseline-2026-08/` holds the three archived reference scans
  (`italicatiles.com.json`, `snitch.com.json`, `zouk.co.in.json`) from R0.4.1 —
  the "before" corpus. There is no `*.labels.json`.
- `src/lib/scoring/calibrationFixture.js:84` — `validateCalibrationFixture`. A
  missing `mentioned` field is **rejected**, never coerced to `false`, so an
  unfilled label cannot silently become a negative training example.
- `src/lib/scoring/calibrationFixture.js:123` — the set is refused if fewer than
  15% or more than 85% are `mentioned`. A one-sided set cannot distinguish a good
  judge from a constant one; this is the calibration equivalent of the false 100%.

Labels must be drawn from real persisted `prompt_results` rows, so this needs
production database access as well as a human reader.

**Why not automated:** the labels are the ground truth the judge is measured
against. Generating them with the judge under test, or with another model, would
measure agreement rather than accuracy — the entire point of R2.5 is lost. Human
reading is the deliverable, not an obstacle to it.

---

## B. Secrets — what must exist, where, and what verifies it

`npm run check:secrets` (`scripts/check-secrets.mjs`) calls the same
`credentialStatus` function `/api/health` uses, so the two surfaces cannot
disagree about what "configured" means. The credential table is
`src/lib/vendorRegistry.js:51-67`:

| Vendor row | Variable(s) | Required |
| --- | --- | --- |
| `supabase` | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes |
| `llm` | `LLM_API_KEY` (deprecated alias `OPENROUTER_API_KEY` still satisfies it) | yes |
| `brightdata` | `BRIGHTDATA_API_KEY` | yes |
| `firecrawl` | `FIRECRAWL_API_KEY` | no |
| `perplexity` | `PERPLEXITY_API_KEY` | no |
| `openai` | `OPENAI_API_KEY` | no |
| `gemini` | `GEMINI_API_KEY` | no |
| `gsc` | `GSC_SERVICE_ACCOUNT_KEY` | no |
| `cron` | `CRON_SECRET` | yes |

Set in `.env.local` for local work and in the Vercel project for the deployment.
`.env.example` documents every one with its shape and its consequences; read it
first, and read it instead of `.env.local`.

**Three things `check:secrets` does not tell you, and one of them will bite:**

1. **`OPERATOR_TOKEN` is not in that table at all.** It is a perimeter token, not
   a vendor credential, and nothing in `scripts/check-secrets.mjs` mentions it. A
   fully green `check:secrets` says nothing about whether the operator perimeter
   is armed. See item 2 above.
2. **`UNCONFIGURED` is not a failure and is not a pass.** The run distinguishes
   absent from broken on purpose. Only `PASS` means a live call succeeded.
3. **`/api/health` checks presence, not liveness, for some rows.** It reported
   `llm configured:true` throughout the period the key was returning HTTP 402.
   The liveness distinction lives in `check:secrets`, which actually calls out.

Also environment-shaped and easy to get silently wrong:

- **`ENGINES` and `NEXT_PUBLIC_ENGINES` must be kept in step.** `check:secrets`
  fails the run on a mismatch, and fails again when an advertised engine has no
  API key — otherwise the landing page names an engine that every scan silently
  skips.
- **The free-scan rate limit is six variables, not one.** `SCAN_RATE_LIMIT`
  (scans per window per client), `SCAN_RATE_LIMIT_WINDOW_MS` (the window),
  `SCAN_RATE_LIMIT_SALT` (per-deployment salt for the hashed bucket key — the
  table is a counter, not a visitor log), `SCAN_RATE_LIMIT_IP_HEADER`,
  `SCAN_RATE_LIMIT_UNVERIFIED_CEILING` and `SCAN_RATE_LIMIT_ATTESTED_CEILING`,
  the last three below. `.env.example` carries
  the long form of each. Which knobs exist is not maintained by hand: a guard in
  `src/lib/rateLimit.test.mjs` extracts every `env.SCAN_RATE_LIMIT_*` read out of
  `src/lib/rateLimit.js` and fails if any of them is missing from `.env.example`
  **or from this file** — find it with
  `git grep -n 'rateLimitKnobsReadBy' src/lib`.
- **`SCAN_RATE_LIMIT_IP_HEADER` should stay unset unless you know the answer.**
  It must name the one header your proxy *overwrites*, not appends. Known-forgeable
  names are refused outright. On Vercel, `x-vercel-forwarded-for` is read as the
  platform header but remains untrusted-pending-proof (`RESTORE-TRUST-R0.1.20`).
- **`SCAN_RATE_LIMIT_UNVERIFIED_CEILING` is the only lever over the
  deployment-wide ceiling, and it has no off switch.** Where no address source
  exists that the caller cannot set — the knob above unset and not on Vercel — the
  per-address limit is bypassable by rotating a header, so R0.1.22 added a second
  bucket keyed by a constant that caps *the whole deployment* per window. Unset,
  it derives as 5× `SCAN_RATE_LIMIT` (25/hour at the defaults). A non-numeric or
  `<= 0` value is **ignored**, not honoured: `0` would refuse every anonymous scan,
  so it falls back to the derived default instead. Raising it buys the same
  throughput for honest anonymous clients and for one rotating attacker. When it
  is exhausted the product is down for anonymous callers and the log says so once
  per process — the latch is
  `git grep -n 'warnedCeilingsExhausted' src/lib/rateLimit.js`. The answer to
  hitting it is a declared proxy header, not a bigger number.
  *This variable existed undocumented from R0.1.22 until 2026-09-09 (R6.2.4)* —
  in neither this file nor `.env.example`, while the guard that should have caught
  it asserted only the one knob it was written for. It is recorded rather than
  quietly added, because "the operator had no documented lever over a limit that
  can refuse every scan" is the kind of gap this section exists to surface.
- **`SCAN_RATE_LIMIT_ATTESTED_CEILING` bounds the address sources this code
  cannot prove, and it also has no off switch (R0.1.24).** A declared proxy
  header and `x-vercel-forwarded-for` on Vercel are assertions made *outside* the
  request: Vercel is documented to strip an inbound copy of its own header and
  nobody here has forged it against the deployed origin to confirm
  (`git grep -n RESTORE-TRUST-R0.1.20 src/lib`), and a declared header is only
  unforgeable if your proxy really overwrites it. R0.1.22 exempted both from any
  ceiling; measured at the module, 60 requests rotating `x-vercel-forwarded-for`
  under `VERCEL=1` were allowed 60/60 and 60 rotating a declared header were
  allowed 60/60, from an unauthenticated caller, each allowed request spending
  scrape + probe + LLM budget. They now answer to a ceiling of their own — a
  separate bucket, not the unverified one, so a correctly configured deployment
  is not capped at 25/hour. Unset it derives as 40× `SCAN_RATE_LIMIT` (200/hour
  at the defaults): deliberately far above honest traffic, because it is a
  catastrophe bound rather than a per-IP limit. Same ignore rules as the knob
  above (`0` is not "off"). If you hit it, the one-per-process log says which
  address source ran out and names this variable; honest traffic reaching it means
  raise it, and traffic you do not recognise reaching it means that header is
  being forged and this ceiling is the only thing between a stranger and the
  vendor bill.
- **`LLM_MODEL_PRICES`** — a paid model id that nothing can price is refused
  before the request is sent, because recording $0 for paid inference is how the
  content pipeline's `CONTENT_MAX_COST_PER_ITEM` cap became a cap that could
  never trip.

---

## C. Migrations

`supabase/migrations/` holds fifteen files. They are named individually rather
than as a range, and `src/lib/docStatus.test.mjs` fails this document if a file
on disk is missing from the list — the previous revision wrote "`001` … `012`"
in the same commit that added `013`, and nothing caught it. It happened again
with `014`, which landed on disk registered nowhere and turned three guards red
until R3.5.4 added the three rows:

`001_initial_schema`, `002_content_os`, `003_content_agents`,
`004_crew_canvas_knowledge`, `005_analytics_platform`, `006_agent_control_plane`,
`007_scan_seal`, `008_system_heartbeats`, `009_scan_rate_limit`,
`010_probe_tasks`, `011_scan_runs`, `012_scan_job_attempts`,
`013_brand_metrics_sov_state`, `014_content_job_checkpoints`,
`015_brand_metrics_citation_state`, `016_crawlability_audit_history`,
`016_content_items_natural_key`, `017_cost_unmeasured_calls`, `018_gsc_daily`, `019_probe_evidence_bucket`,
`020_content_items_key_nulls_not_distinct` (applied 2026-09-18 — R3.5.5).

`npm run setup:db` applies them in filename order, one transaction per file,
recording each in the `schema_migrations` ledger. The `BEGIN`, the ledger
`INSERT` and the `COMMIT` all sit inside a single per-file `try` in
`scripts/setup-supabase.mjs`; find the block with
`git grep -n 'INSERT INTO schema_migrations' scripts/setup-supabase.mjs` and read
outwards from it. Line numbers are deliberately withheld here: this file cited
`:473`/`:502`/`:510` for those three statements, an edit to the same function
moved all three, and the stale numbers landed an operator on unrelated text.

**Applied state — what is actually known, and what is not.** Verified against the
live AEO project `nggyizuwqepxaqnpcqqj` by agents at the dates given, read out of
the Postgres catalog:

- `001`–`010`: present in `schema_migrations` as of 2026-08-30.
- `007`, `008`, `009`: applied 2026-08-30 under R0.1.11, catalog-verified.
- `011`: applied under R1.2.3 — `npm run setup:db` exited 0 with 40/40 objects
  present.
- `012_scan_job_attempts.sql`: **applied state unverified from this environment.**
  Do not assume. Check the catalog before relying on it.
- `013_brand_metrics_sov_state.sql`: **applied state unverified from this
  environment, and this is the one to check first.** Nothing in this repository
  can read the production catalog, so no agent has confirmed it either way. It
  carries the worst consequence of the fourteen if it is missing (it was also
  the newest file on disk until `014` landed): per the `013` row of
  `docs/PROD_MIGRATIONS.md`
  (`git grep -n 'PGRST204' docs/PROD_MIGRATIONS.md`), **every scan finalize
  hard-fails its `brand_metrics_daily` upsert with PostgREST `PGRST204`
  ("column sov_state ... does not exist")**. Confirmed in the code, not taken on
  the other document's word: `git grep -n 'export async function
  upsertBrandMetricsDaily' src/lib/db/analytics.js` — it passes `rows` to
  `.upsert()` verbatim and then does `if (error) throw error`. So an unknown
  column is a hard throw, not a dropped field: the finalize does not silently
  lose a column, it fails. Its only non-test caller is `runFinalizePhase`
  (`git grep -n 'export async function runFinalizePhase'
  src/lib/workers/scanWorker.js`), i.e. the end of every scan. There is a second
  writer on the same columns: `scripts/backfill-analytics.mjs` imports
  `buildMetricsRows` from `src/lib/analytics/rollup.js` — the function that emits
  `sov_state`/`sov_state_reason` — and upserts the result into
  `brand_metrics_daily`, so a backfill against a pre-013 database fails the same
  way. `GET /api/brands/[brand]/metrics` only reads the table (`select("*")`), so
  it degrades rather than throwing.
- `014_content_job_checkpoints.sql`: **applied state unverified from this
  environment.** Do not assume. Check the catalog before relying on it. It is
  the newest file on disk, and it is the only one `npm run setup:db` cannot
  answer for you — see the gap below. The whole migration is one statement
  (line 11 of the file, the only non-comment line):
  `ALTER TABLE content_jobs ADD COLUMN IF NOT EXISTS checkpoint jsonb;`. Note
  this is `content_jobs`; the `checkpoint` column `005` adds is on `scan_jobs`,
  so a database that ran `005` still needs `014`. **If it is missing, content
  jobs do not merely lose the ability to resume — they fail.** Read from the
  code, not inferred: `updateContentJob` ends `if (error) throw error`
  (`git grep -n 'export async function updateContentJob'
  src/lib/db/content.js`, the throw is the last one in that function), so
  PostgREST `PGRST204` on an unknown column is a hard throw; and every
  checkpoint write goes through `writeJob({ checkpoint: … })` inside the
  pipeline's own `try` (`git grep -n 'persist checkpoint after each completed
  block' src/lib/content/contentWorker.js`), the first of them at the first
  block boundary. So on a pre-`014` database the first block that finishes
  throws, not the first rescue.
- `015_brand_metrics_citation_state.sql`: **applied state unverified from this
  environment.** Do not assume. Check the catalog before relying on it — the
  `pg_attribute` query is in the file's own header. It is the newest file on
  disk and it carries the SAME blast radius as `013`, for the same reason: it
  adds three columns (`brand_metrics_daily.citation_denominator`,
  `.citation_state`, `.citation_state_reason`) that `src/lib/analytics/rollup.js`
  now puts on every row it builds, and `upsertBrandMetricsDaily` sends the row
  through verbatim and then does `if (error) throw error`. So on a pre-`015`
  database **every scan finalize hard-fails its `brand_metrics_daily` upsert
  with PostgREST `PGRST204`**, exactly as it would without `013`. Unlike `014`
  this one IS answerable by `npm run setup:db`: it ships
  `brand_metrics_daily_citation_unverified_idx`, a partial index whose
  predicate references two of the three columns, and that index is its
  `EXPECTED_OBJECTS` entry. `scripts/backfill-analytics.mjs` also reads those
  three columns before it writes anything, so it aborts with a message naming
  this migration rather than discovering the gap halfway through. After
  applying it, run the backfill and read its "Citation denominator (R4.3.3)"
  block: the migration deliberately ships no SQL re-derivation (the evidence
  that decides whether a pre-R2.2.2 slice is reconstructible lives in
  `scans.raw_results`, not in a joinable table — the reasoning is in the file),
  so until the backfill runs, existing rows keep `citation_state` NULL, which
  means "unverified", not "measured", and
  `brand_metrics_daily_citation_unverified_idx` enumerates exactly the rows
  that still carry a share nobody has re-checked.

**The `014` verification gap — `setup:db` will lie to you about this one.**
`objectExists()` in `scripts/setup-supabase.mjs` asks `to_regclass` for tables
and indexes and `pg_proc` for functions. None of the three sees a column, and
`014` creates only a column — unlike `012` and `013`, which each ship an index
that references the new column and so stand in for it. `014`'s entry in
`EXPECTED_OBJECTS` is therefore an empty list, deliberately: the alternative was
to tick `content_jobs`, which `002` creates and which is present on databases
that have never seen `014`. The consequence is that **`npm run setup:db` prints
"All expected objects present" on a database missing `014`.** Settle it by hand
instead:

```sql
select column_name, data_type
  from information_schema.columns
 where table_schema = 'public'
   and table_name   = 'content_jobs'
   and column_name  = 'checkpoint';
```

Zero rows means `014` has not been applied. `docs/PROD_MIGRATIONS.md` has no
`014` section and no `014` rows in its one-query block as of 2026-09-13
(`git grep -c '014_content_job_checkpoints' docs/PROD_MIGRATIONS.md`); adding
them is out of R3.5.4's scope and is filed as follow-up work, so until then this
bullet is the only place the `014` check is written down.

**The per-migration verification queries now exist.** `docs/PROD_MIGRATIONS.md`
landed under R6.1.2 in commit `156c21b` — it did not exist when this section was
first written, and the earlier revision of this file said so. Go there for the
catalog query that settles each file **except `014`, which it does not cover at
all** — including the `012` and `013` questions above: it lists `012`'s four objects (`scan_jobs.attempts`,
`scan_jobs_attempts_chk`, `scan_jobs_attempts_idx`, `claim_scan_job_attempt`) and
`013`'s six (two columns, three constraints and
`brand_metrics_daily_sov_unverified_idx`) as the things to look for. R6.1.2 was
verified and closed on 2026-09-05; its verifier re-derived the expected object
counts from the DDL independently for all **twelve** migrations then on disk and
every one matched. `013`'s row was appended afterwards, in `220d93d`
(`git log -S'013_brand_metrics_sov_state' -- docs/PROD_MIGRATIONS.md`), so treat
that one row as reviewed-by-one and the twelve above it as settled. The operator
rule behind all of them is the one R0.1.11 established the hard way:

> **Verify schema state from the Postgres catalog, never from a head-probe.**
> Query `to_regclass` for tables and indexes and `pg_proc` for functions. An
> endpoint returning 200 is not evidence a table exists; `/api/health` returned
> healthy while the heartbeat table it reads did not exist.

**The R0.1.11 precedent — read this before running `setup:db` against production.**
`007` creates a unique partial index on `scan_jobs(brand)` while running.
`setup:db` could not apply it unaided: 44 `scan_jobs` rows were stranded in the
four statuses `007` indexes, so `CREATE UNIQUE INDEX` failed on duplicate keys.
The fix was a **mutation of production data** — retiring those rows to a terminal
status — and that is precisely why it needed an operator. When it was done, it was
scoped three ways so no live job could be caught (running status **and** no
heartbeat in the last day **and** created before a cutoff date), each row's
`error_message` was appended to rather than replaced, and the full 44-row
before-state was captured first. Reuse that shape.

**Why not automated:** a migration that requires reconciling existing production
rows is a data-loss decision wearing a schema-change costume. The reconcile
predicate is a judgement about which rows are genuinely dead, and it is
irreversible. Applying idempotent DDL is automatable; deciding that 44 rows are
abandoned is not.

---

## D. Content approval — the human gate, and what it does not yet do

The content pipeline is human-in-the-loop by design. `POST /api/content-items/[id]/decision`
takes `{ verdict, comment }` where verdict is one of `approved`,
`changes_requested`, `rejected`, and `changes_requested` / `rejected` require a
comment. That gate is the operator's standing duty: nothing publishes without it.

**Two things about it are not true yet, and the copy around it must not pretend
otherwise.**

**1. Approval is not publication. The code used to treat it as if it were; that
part is now deleted.**
On an `approved` verdict for a `geo_article`, the route used to write a
`content_events` row whose URL was **synthesized, not real** — a
`contentEventUrl` helper built `https://studio.perceev.app/<path>`, a host that
is a fabrication, and that fabricated URL then fed real lift attribution.
**R5.2.1 deleted the synthesizer and the write** (`src/app/api/content-items/[id]/decision/route.js`):
approval now records no URL and no content event, and the decision response
carries an explicit `publication: { published: false, url: null, reason:
"approved_not_published" }` so a caller can tell "approved, not published" from
"published at a URL". **Rows written before that deletion can still exist in
`content_events`**; `GET /api/content-events` now returns any row on the
fabricated host with its lift fields null plus `fabricated_url: true` and
`lift_unavailable_reason: "fabricated_url"` rather than serving a lift number
computed against a page that never existed. No migration deletes those rows —
if you want them gone, that is an operator decision, and the same care § C
demands of a reconcile applies.
Still open: R5.2.2 adds the explicit publish step where the operator pastes the
**real** live URL and the system verifies the page resolves and matches before
the stage flips to `PUBLISHED`, and R5.2.3 makes the lift copy read "since
approval" with the correlation caveat until then.

**2. The approve → publish → lift loop has never run end to end.**
This is stated plainly because softening it is the failure mode this whole
document exists to prevent. R5.4.3 — "Scan, gap, batch, draft, approval, manual
publish, next-scan lift readout" — is the acceptance test for the chain, and its
own detail records that **the chain has never run whole**. Until R5.4.3 closes on
a real brand with each stage evidenced, any lift number the product shows is a
correlation across an unverified link, not a measurement.

Until then the operator's publish step is entirely manual and entirely outside
the system: take the approved draft, publish it wherever it actually goes, and
keep your own record of the URL and the date. The system cannot currently store
that fact.

**Why not automated:** publication targets are the client's CMS, which this
system has no credentials for and should not. Verification of a live URL is
automatable and is exactly what R5.2.2 builds; the *decision to publish* is not.

---

## E. Standing gates by task id

Everything below needs a human and is not in § A. Grouped by what the human
supplies. Re-check status with `orchestrate.mjs show <id>` — these move, and two
of them moved while this file was being corrected.

**Two entries here are CLOSED in the ledger and are kept deliberately**, each
labelled as closed where it appears: R0.1.20, because closing it withdrew a false
claim and left the operator's deploy-time check entirely undone, and R0.1.21,
because what shipped changed how a developer's machine behaves. Nothing else in
this section is closed. If you are counting open work, count from
`orchestrate.mjs status`, not from this table.

**Completeness is enforced, not promised (R6.2.4).** The previous revision of
this section was missing `R3.3.5`, which was filed twelve seconds before that
revision was submitted — nothing here was false, but a gated task was invisible
in the operator's own list of gated tasks, and the next hand-maintained list
would have rotted the same way within the hour. So it is no longer maintained by
hand alone: `src/lib/operatorLedgerGates.test.mjs` reads
`.claude/orchestration/tasks.json`, takes every task that is **not done** and
carries one of the five gate tags, and fails if its id appears nowhere in this
document. It also fails when a table row here is about a task the ledger records
as `done` and the row does not say `CLOSED`. Find it with
`git grep -n 'every OPEN gated task' src/lib`. What the guard cannot check is
whether the sentence beside an id is *true*; that is still on the author.

### Needs a credential or a vendor account (`needs-secrets`)

| Task | What the operator must supply |
| --- | --- |
| R1.1.2 | Browser-infrastructure spike: a Bright Data Scraping Browser / Browserless / residential-proxy account to measure block rate and cost per probe against. Also `needs-decision` — the ADR must record measured numbers, not preferences. **Now sited (2026-09-16): the spike runs on the Zeabur box R1.1.3 ratified.** That removes "where does it run", not "what does it cost" — a funded Scraping Browser zone is still the operator's to open, and it is a different product from the SERP zone `BRIGHTDATA_SERP_ZONE` already names. **CORRECTED the same day:** this row briefly said the spike required the 8 GB tier because 2 GB cannot host five Chromium contexts. Resolving the config rather than reading the documented defaults shows `batchSize` self-adjusts to 2 (five does not fit one lease) and `maxConcurrency` is **1 per surface** — a politeness ceiling from R1.1.5, not a resource one. Concurrent browsers therefore equal enabled surfaces: one by default, two with ChatGPT on. **Start the spike on the current 2 GB tier.** Upgrade if a measured footprint demands it; an OOM at 2 GB means raise the tier and re-measure, never that self-hosted browsing lost. |
| R1.3.1, R1.4.1 | Spike credentials + IN egress to capture Perplexity and logged-out ChatGPT fixtures, including block and login-wall pages. |
| R1.2.19 | **SUPERSEDED by R1.2.20 on the day it was filed — no operator action; it is held `blocked` only because its accept is immutable and cannot be reworded.** It required the first pass to run against a *non-production* Supabase. That imported the ADR §3.1 rule, which governs a **laptop dev fleet** and never governed the deployed one, and the operator has since named the live project as the target. |
| R1.2.20 | Deploy access to the ratified Zeabur server (`server-6a527fe7e33921bfb5d0fa29`), and the live project's `SUPABASE_SERVICE_ROLE_KEY` set as a K3s secret or in Zeabur's environment UI — **never pasted into a transcript**; it bypasses row-level security. **Stage 1 needs no credential at all**: the image plus `--selftest` settles every Zeabur capability the ADR left unverified, so run it first and keep a platform failure distinguishable from a credential failure. **Stage 2 requires `FLEET_ALLOW_PRODUCTION_DB=true`** — R1.2.12 refuses the live database without it, and R1.2.17 strips the credentials from an unarmed process rather than letting it hold live keys. Expect a first pass that claims nothing, writes a closed `scan_runs` row and refuses at the probe: `probeBatch` throws until R1.3. |
| R3.1.12 | **CLOSED in the ledger (verified pass, 2026-09-18) — two things still owed, and the close does not claim them: (1) decide whether to pause or delete the duplicate Vercel project `aeovis`; (2) the "stale job rescued within 10 minutes" clause was never observed live, because no stale job existed — seed one and read the next Job log if you want it seen.** Applied by the operator 2026-09-18 ~18:58 UTC, from the pasted log: `scan-worker sweep: HTTP 200` with the sweep JSON; `kubectl get cronjob` shows `*/10 * * * *`. Manifest `worker/k8s/scan-cron.yaml`; Secret `perceev-cron` on the Zeabur host (`CRON_SECRET`, `SCAN_WORKER_URL`). Lesson recorded: the first two runs answered `401` because the rotated `CRON_SECRET` had been saved on the **wrong Vercel project** — two projects (`aeovis`, older, and `aeo-vis`, the live one serving `aeo-vis.vercel.app`) are linked to the same GitHub repo and both build every push. Decision owed: pause or delete `aeovis` so a secret cannot be set on the wrong one again and Hobby build minutes stop being spent twice. Check the box once a week: `sudo k3s kubectl get jobs -l app=perceev-scan-cron`. |
| R1.5.1 | **CLOSED in the ledger (verified pass, 2026-09-18) — nothing further owed.** The bucket exists on the live project (migration `019`, private, 5 MiB cap, png/gzip/html only) and retention runs from the `/api/evidence/retention` cron because Supabase's `protect_objects_delete` trigger refuses SQL deletes. Kept so the row's history is legible: the ask was *create the Supabase Storage bucket `probe-evidence` with a 90-day retention policy*. |
| R1.6.1 | Verify Indian egress per engine — rupee pricing, Indian brands, `.in` citations. Needs the actual egress path, not a claim about it. |
| R1.7.1 | Production data access to dual-run the reference corpus through the API and UI paths for `docs/PARITY.md`. |
| R2.5.1 | Production `prompt_results` access, and the R0.4.2 labels, to point the calibration harness at the live judge. |
| R3.5.5 | **CLOSED in the ledger (verified pass, 2026-09-18) — nothing further owed.** Pre-check 2026-09-18: `select count(*) from content_items where job_id is null` → `0`. Migration `020_content_items_key_nulls_not_distinct.sql` applied by the operator the same day ~19:10 UTC; applied-check returned `UNIQUE NULLS NOT DISTINCT (job_id, cycle)`. Recorded in `docs/PROD_MIGRATIONS.md`. Original ask, kept: migration 016 made `(job_id, cycle)` unique on `content_items`, but `job_id` is nullable (002: `ON DELETE SET NULL`) and Postgres treats NULLs as distinct, so a row with no job was never deduplicated; both fixes fail mid-transaction on a table already holding NULL-job duplicates, which is why the count came first and was yours. |
| R3.3.5 | **CLOSED in the ledger (verified pass, 2026-09-18) — nothing further owed.** `src/lib/workers/reaperCloseLive.test.mjs` ran 4/4 against the live project under `npm run test:live` on 2026-09-15 and skips loudly, countably, without a database. The original ask, kept for the record: a reachable Postgres (the Supabase service-role credentials plus migration `011`) so the reaper's idempotence is exercised against the real `close_scan_run`, not against a JS fake that re-implements what the migration is *believed* to do. Today `classifyReapCloseFailure` sorts a close failure by text-matching the plpgsql `RAISE` strings and that SQL has never been executed here. The test must skip **loudly and countably** with no database, never silently. |
| R4.1.1 | A Search Console property with the (rotated) service-account email added as a Restricted user. Today the account is on zero properties, which is why the GSC client is orphaned. |
| R4.4.1 | GA4 read access or permission to place a first-party snippet, for AI-referral attribution. |
| R3.1.6 | **CLOSED in the ledger (verified pass, 2026-09-18) — the operator check below is still worth doing once, on the next real scan.** Both defects were fixed and observed in production on 2026-09-16 (self-continue now carries `x-vercel-protection-bypass`; a finalize claim held by a dead instance expires). What closing did not change: the on-Vercel warning when the bypass secret is absent is a log line, not a refusal, so confirm Protection Bypass for Automation is enabled on the Vercel project, so `VERCEL_AUTOMATION_BYPASS_SECRET` reaches the deployment and a scan chunk can call the next one. This project runs `ssoProtection` with `deploymentType: all_except_custom_domains`, so without that secret every self-continue fetch is answered by an SSO redirect and scans advance only on a browser poll or the daily cron. Verify by watching a production scan move between chunks with no client polling. |

### Needs a Vercel action (`needs-vercel`)

| Task | What the operator must do |
| --- | --- |
| R0.1.12 | See § A item 2. |
| R0.1.20 | **CLOSED in the ledger (verified pass, 2026-09-08) — the operator action is unchanged and still not done.** Curl the **deployed** `POST /api/scan` with a forged `x-vercel-forwarded-for` and assert the rate-limit bucket does not move. What closing the task changed is the *claim*, not the check: see below the table. |
| R3.1.1 | **Superseded by R3.1.12 (2026-09-18).** Operator decision 2026-09-15: not upgrading from Hobby, and Hobby runs a cron once a day, so the 10-minute schedule this task's acceptance names (`vercel.json`) cannot ship. The same sweep now comes from a K3s CronJob on the Zeabur box — see R3.1.12 under `needs-secrets`. Nothing further owed here. |
| R3.1.2 | `vercel.json` has no `?batch=1` entry, so the one automated scan-to-content chain is unreachable. Also `needs-llm`. |
| R3.1.10 | **CLOSED in the ledger (verified pass, 2026-09-18) — one production observation is still owed, and the close does not claim it.** A content job now self-continues (`src/lib/selfContinue.js`, fired from `handOff` in `src/lib/content/contentWorker.js`) the same way a scan chunk does: through `keepAlive`, carrying `x-cron-secret` and `x-vercel-protection-bypass`. Proven by reading and by tests, not in production. What you owe: after the next deploy, watch one `daily_batch` job in the Vercel function logs and confirm it reaches a `content_items` row the **same day**, with no cron tick in between. If it still takes a day, the bypass secret is not reaching the deployment — see R3.1.6. **Found 2026-09-18 while checking this:** the project has **no** Protection Bypass secret (the panel is empty), `NEXT_PUBLIC_APP_URL` is not set in production, and Vercel Authentication is on for every deployment URL. So the self-continue resolved to `VERCEL_URL` and hit the SSO wall — every self-continue on production, scan and content alike, has been dying there. Fixed in code by R3.1.13 (the production alias `VERCEL_PROJECT_PRODUCTION_URL` now wins on production deployments; the alias is not behind SSO). The observation above is owed **after that deploy**, not before. |
| R3.1.5 | **CLOSED in the ledger (verified pass, 2026-09-18). The decision is made and the code shipped (`53995fa`); what is left for you is one observation.** ~~Decide where the post-response scan work lives, and record it. `git grep -n waitUntil -- src package.json` returns nothing and `@vercel/functions` is not a dependency, so the fire-and-forget `runScanChunk(job.id).catch(...)` after the response in `src/app/api/scan/route.js` has **no platform mechanism keeping the function alive**~~ — **corrected 2026-09-18:** `@vercel/functions` **is** a dependency (`package.json:52`, `^3.9.7`) and `waitUntil` is used through one helper, `src/lib/keepAlive.js:36`, at nine post-response sites; the answer chosen was the platform mechanism, recorded in [`docs/decisions/2026-09-18-post-response-keepalive.md`](decisions/2026-09-18-post-response-keepalive.md). The three compensations (`HEARTBEAT_STALE_MS` staleness, the poll-driven rescue in `GET /api/scan/[job_id]/status`, the daily crons) **remain on purpose** as the backstop. **Your action:** deploy, `POST /api/scan`, close the tab immediately, and confirm from the Vercel function logs that the chunk continued past the response — 3×. **Nothing in this repository can prove the platform defers the freeze; only that observation can, and it has not been done.** |

#### R0.1.20 — the label was withdrawn; the check that would earn it back is not run

**Read this before quoting the rate limiter's trust label anywhere.** Until
2026-09-08 this document told operators the limiter reports `trusted: true` for a
source it cannot vouch for, and cited a `"NOT VERIFIED HERE"` comment for it.
That was the **inverse** of the code by then, and it is recorded here rather than
quietly deleted: R0.1.20 shipped in the same commit that this file's last
revision shipped in, so the sweep that checked those citations against the parent
commit could not have caught it.

What is true now, anchored on a marker instead of a line number —
`git grep -n 'RESTORE-TRUST-R0.1.20' src/lib/rateLimit.js`:

- The constant is `PLATFORM_IP_HEADER` (`x-vercel-forwarded-for`). The old name
  `TRUSTED_IP_HEADER` is gone, and the comment above the rename says why: it was
  "a promise this module cannot keep". `git grep -i "not verified" --
  src/lib/rateLimit.js` returns nothing.
- On a Vercel runtime that header is still read **first**, so the bucket key and
  the strength of the limit are byte-identical to before. Only the claim changed.
- It is now reported `trusted: false` with `trustBasis: "platform-unproven"`, and
  a warn line fires carrying the `RESTORE-TRUST-R0.1.20` marker. A spoofable
  identity no longer carries a confidence label.
- The deferral is written into the code as the exported string
  `TRUST_RESTORE_CHECK`, whose text *is* the operator ask.

**The operator ask is therefore unchanged and still outstanding:** a deploy-time
check that forges `x-vercel-forwarded-for` against the **deployed** origin and
asserts the rate-limit bucket does not move, run somewhere an operator sees the
result. Nothing inside a request handler can distinguish a header the edge wrote
from one the caller typed, so no unit test can settle it — the closing verifier
proved the withdrawal is total over an eight-case battery, which is a different
claim. Passing that check is exactly what would let `trusted: true` be taken
back; writing the script without running it is a partial result.

### Needs a decision recorded (`needs-decision`)

| Task | The judgement call |
| --- | --- |
| R0.1.21 | **CLOSED in the ledger (verified pass, 2026-09-05) — read the note below the table for the consequence, not for an ask.** The judgement call it used to describe no longer reproduces; what it shipped changed how a machine with no Supabase behaves. |
| R1.1.3 | **CLOSED in the ledger (verified pass, 2026-09-18) — nothing further owed. RATIFIED 2026-09-16.** The sentence supplied: *"the fleet runs on Zeabur"* — `server-6a527fe7e33921bfb5d0fa29`, Tencent Cloud Tokyo, ZeaburOS + K3s, 2 vCPU / 2 GB / 39.3 GB, US$3/mo paid through 2026-10-11, upgradeable to 8 GB at US$6/mo. Recorded in `docs/decisions/2026-09-05-worker-host.md` §5, which supersedes its own provisional Railway recommendation. Two consequences the operator should hold on to: (1) at the 2 GB tier roughly 850 MB is free, which hosts a Node process driving a **remote** browser but not five local Chromium contexts — so R1.1.2's spike must be run on the 8 GB tier if self-hosted Playwright is to be measured rather than ruled out by the box; (2) egress is Tencent Tokyo **datacenter** IPs against an India-target market, which is a block-rate measurement R1.1.2 must take, not an assumption. Nothing verifies Zeabur's Dockerfile support, secret injection, K3s grace periods or log retention — the first deploy settles those. |
| R4.5.1 | Decide-or-delete, per item, on the schema-only subsystems: `topics`, `content_feedback` reads, the phantom `analyzing` status. Wire with a test, or delete with the schema. |
| R6.1.9 | **CLOSED in the ledger (verified pass, 2026-09-18) — nothing further owed.** Option A was approved on 2026-09-15 and shipped: the secrets rule lives once in `CLAUDE.md`, the six `rebuild-*` definitions point at it, and `src/lib/agentSecretsGuard.test.mjs` fails if either side drifts. The original ask, kept for the record — one sentence of approval was the whole of it. Where the secrets-hygiene rule lives for agents outside the `rebuild-*` family: the guard covers six agent definitions, roughly forty other tracked instruction files under `.claude/` carry nothing, and both credential leaks came from agents running unscoped searches — nothing about that failure mode is specific to `rebuild-*`. The controller re-examined this on 2026-09-08 and **deliberately left it blocked**: copying the rule into forty files multiplies the thing that drifts, and the correct answer — move it to `CLAUDE.md`, which every session loads by construction, and reduce the six copies to a pointer — means editing the operator's own project-instruction file, which no agent has standing to do on another agent's say-so. Approve option A and the change is about ten minutes' work. |

#### R0.1.21 — the unpersisted-scan 201 no longer reproduces

The earlier revision of this file listed R0.1.21 as an open judgement call, cited
`src/lib/db.js:577` for `createScanJob` with the fallback at `:600-602`, and
`src/app/api/scan/route.js:57-70` for the `201 Created` built on it. **All three
were wrong** — `createScanJob` has never been on line 577 in that file's history;
at `1a5ed81`, the commit the earlier revision declared, it was at `:542` and
`:577`/`:600-602` are the migration-007 duplicate-reclaim path. Worse, that
citation was presented as a *correction* of a stale roadmap anchor. Correcting it
is the reason this revision exists; the entry is rewritten rather than
renumbered, because the substance moved too.

**What is true today.** Anchor on the symbol:
`git grep -n 'export async function createScanJob' src/lib/db.js`. It still
fail-softs — the `if (!hasDb)` branch immediately after the job object is built
writes it into `global.memoryJobs` and returns it, shaped exactly like a
persisted row. What changed is the route. `POST /api/scan` now imports the
module-level `supabase` client and returns **503** `{ code:
"scan_store_unavailable" }` when it is null, *before* `createScanJob` runs, so no
job is created and `runScanChunk` never fires. A second, currently unreachable
guard refuses the same way if a returned job turns up in `global.memoryJobs`
anyway, so a future divergence in `db.js`'s fallback condition fails loud instead
of quietly restoring the 201. Both are found with
`git grep -n 'scanStoreUnavailable' src/app/api/scan/route.js` — the earlier
revision of this section gave them as `:105` and `:119`, and they are not there
any more, which is the whole argument for the grep.

It shipped in commit `156c21b` with its test
(`src/lib/scanRoute.unpersisted.route.test.mjs`) and its decision record,
`docs/decisions/2026-09-05-unpersisted-scan-jobs.md`. **The ledger task is
`done`** — verified pass on 2026-09-05 by a verifier who reproduced the original
defect by execution rather than by reading: with both guards neutralised the
route returned 201 with a job id and `runScanChunk` entered; with them restored,
503, no job, worker never entered. It then walked all six `createScanJob` failure
modes against the real handler and found no path that still yields a 201.

**What the operator still needs to know.**

1. **`npm run dev` with no Supabase can no longer start a scan over HTTP.** It
   returns 503 by design. That is the recorded cost of the fix, not a
   regression; the ADR names it. Set the Supabase variables locally, or drive
   `src/lib/db.js` directly as the test suite does.
2. **`src/lib/db.js` was deliberately not touched.** The memory store is still a
   legitimate in-process fallback — the test suite runs with the Supabase vars
   unset and dozens of suites depend on it. The decision drawn was that the map
   is a valid *library* fallback and an invalid *response*, enforced at the route
   rather than by an assertion inside `db.js`. So the perimeter here is one
   guard on one route, not a property of the store.
3. **There is a second live caller of `createScanJob`, and it is not behind that
   guard:** `runSchedulerTick` (`src/lib/workers/scanWorker.js`, `const createJob
   = deps.createScanJob || createScanJob`), reached from `GET /api/scan/worker`
   — the cron route in `vercel.json`. It is cron-authenticated, so it is not the
   anonymous spend path R0.1.21 closed; the closing verifier independently
   enumerated the callers and reached the same two, which settles the *census*.
   On an unconfigured instance it also appears unreachable, because
   `listDueSchedules` reads `global.memoryScanSchedules`, which is empty in a
   cold process — **that second argument is still reasoned, not exercised**, no
   test drives it, and closing the task did not change that. Anyone adding a
   third caller should assume the guard does not cover them.

### Needs an LLM key (`needs-llm`)

R5.1.2, R5.3.1, R5.3.2, R5.4.1, R5.4.2, R5.4.3, R4.1.2, R3.1.2 — all downstream
of § A item 3. R5.1.2 is the gate: `check:secrets` passes, then one metered call
proves cost lands non-zero in the price table, then the share-of-voice surfaces
exit "not assessed". Nothing else in R5 starts before it.

### Needs elapsed real time (`needs-soak`)

These cannot be shortened by working harder; they are measurements of a system's
behaviour over days.

| Task | The wait |
| --- | --- |
| R1.3.5 | Perplexity soak, 3+ days at ~30 prompts/day, to characterise real answer and block rates before the adapter is trusted. |
| R1.4.3 | The same for ChatGPT: adapter, canary, soak, all eight outcomes reachable. |
| R1.7.2 | Per-engine cutover behind the `ENGINES` flag — only after 7+ days of soak at ≥90% answered with a quiet canary. Reversible, and the trend chart gets an "engine surface changed" marker. |
| R3.5.3 | Promote `enforceTransitions` from warn-only to throwing, but only after a **quiet telemetry week**, recorded in the build journal before the flip. |

**Why the soaks are not automated:** they are. The waiting is the point. What a
human must do is refuse to promote early — the failure mode is an operator who
sees three clean days and flips the flag on day four.

---

## F. Known-open, stated without softening

- The approve → publish → lift chain has **never run end to end** (§ D, R5.4.3).
- No calibration label exists, so the judge's precision and recall are **unmeasured**
  (§ A item 4, R2.5.1).
- Whether Vercel strips an inbound `x-vercel-forwarded-for` is **assumed, not
  proven**. Nothing in the repository can settle it and the deploy-time forge
  check that would has **not been run** (§ E, R0.1.20). What the code says about
  it is no longer an overclaim: since R0.1.20 that source is reported
  `trusted: false` with `trustBasis: "platform-unproven"` and a warn line, so the
  unproven thing is the platform behaviour, not the label.
  *This bullet asserted the opposite until 2026-09-08* — it told operators the
  limiter reports `trusted: true` — and it is corrected in place rather than
  silently, because a known-open section that has drifted into describing a fixed
  state is the exact failure this section exists to catch.
- Whether `CRON_SECRET` and `OPERATOR_TOKEN` are set on the deployment is
  **unconfirmed** (R0.1.12).
- ~~The scan work that runs **after** the HTTP response has **no platform
  keepalive** — `git grep -n waitUntil -- src package.json` returns nothing and
  `@vercel/functions` is not a dependency — so a scan can be frozen mid-run and
  three compensations are all that stand between that and silent abandonment
  (§ E, R3.1.5).~~
  *This bullet asserted the opposite of the code from 2026-09-18* — R3.1.5
  shipped `waitUntil` through `src/lib/keepAlive.js` at nine post-response sites
  in `53995fa`, and it is corrected in place rather than deleted for the same
  reason as the bullet above it.
  **What is still open is narrower, and it is still open.** The three
  compensations are no longer the *only* thing standing between a scan and
  silent abandonment — but whether Vercel **actually** holds the instance longer
  is **unproven**. No test here can settle it; the deploy-time observation that
  would (§ E, R3.1.5) has **not been run**. Do not read "scans complete" as
  evidence either way: the compensations are still in place and are still enough
  to make it look fine. The decision itself is recorded in
  [`docs/decisions/2026-09-18-post-response-keepalive.md`](decisions/2026-09-18-post-response-keepalive.md).
- Migrations `012` **and `013`** have an **unverified** applied state in
  production (§ C). `013` is the one to check first: without it every scan
  finalize hard-fails with PostgREST `PGRST204`.
- The rebuild branch is many commits ahead of `main` and PR #1 is unmerged —
  `git rev-list --count main..HEAD` for the number, which changes hourly and is
  therefore not written down here. (It was 120 at `1a5ed81` and 123 at `04e80db`,
  in one working session; that rate is the reason.) Which commit the Vercel
  deployment actually serves is **not established by anything in this
  repository**; check the Vercel dashboard rather than inferring it.
