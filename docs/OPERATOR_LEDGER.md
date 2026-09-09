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
- **The free-scan rate limit is five variables, not one.** `SCAN_RATE_LIMIT`
  (scans per window per client), `SCAN_RATE_LIMIT_WINDOW_MS` (the window),
  `SCAN_RATE_LIMIT_SALT` (per-deployment salt for the hashed bucket key — the
  table is a counter, not a visitor log), `SCAN_RATE_LIMIT_IP_HEADER` and
  `SCAN_RATE_LIMIT_UNVERIFIED_CEILING`, the last two below. `.env.example` carries
  the long form of each. Which knobs exist is not maintained by hand: a guard in
  `src/lib/rateLimit.test.mjs` extracts every `env.SCAN_RATE_LIMIT_*` read out of
  `src/lib/rateLimit.js` and fails if any of them is missing from `.env.example`
  **or from this file** — find it with
  `git grep -n 'rateLimitKnobsReadBy' src/lib`.
- **`SCAN_RATE_LIMIT_IP_HEADER` should stay unset unless you know the answer.**
  It must name the one header your proxy *overwrites*, not appends. Known-forgeable
  names are refused outright. On Vercel you do not need it.
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
  `git grep -n 'warnedCeilingExhausted' src/lib/rateLimit.js`. The answer to
  hitting it is a declared proxy header, not a bigger number.
  *This variable existed undocumented from R0.1.22 until 2026-09-09 (R6.2.4)* —
  in neither this file nor `.env.example`, while the guard that should have caught
  it asserted only the one knob it was written for. It is recorded rather than
  quietly added, because "the operator had no documented lever over a limit that
  can refuse every scan" is the kind of gap this section exists to surface.
- **`LLM_MODEL_PRICES`** — a paid model id that nothing can price is refused
  before the request is sent, because recording $0 for paid inference is how the
  content pipeline's `CONTENT_MAX_COST_PER_ITEM` cap became a cap that could
  never trip.

---

## C. Migrations

`supabase/migrations/` holds thirteen files. They are named individually rather
than as a range, and `src/lib/docStatus.test.mjs` fails this document if a file
on disk is missing from the list — the previous revision wrote "`001` … `012`"
in the same commit that added `013`, and nothing caught it:

`001_initial_schema`, `002_content_os`, `003_content_agents`,
`004_crew_canvas_knowledge`, `005_analytics_platform`, `006_agent_control_plane`,
`007_scan_seal`, `008_system_heartbeats`, `009_scan_rate_limit`,
`010_probe_tasks`, `011_scan_runs`, `012_scan_job_attempts`,
`013_brand_metrics_sov_state`.

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
  can read the production catalog, so no agent has confirmed it either way. It is
  the newest file on disk and it carries the worst consequence of the thirteen if
  it is missing: per the `013` row of `docs/PROD_MIGRATIONS.md`
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

**The per-migration verification queries now exist.** `docs/PROD_MIGRATIONS.md`
landed under R6.1.2 in commit `156c21b` — it did not exist when this section was
first written, and the earlier revision of this file said so. Go there for the
catalog query that settles each file, including the `012` and `013` questions
above: it lists `012`'s four objects (`scan_jobs.attempts`,
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

**1. Approval is not publication, but the code treats it as if it were.**
On an `approved` verdict for a `geo_article`, the route writes a `content_events`
row (`src/app/api/content-items/[id]/decision/route.js:93-98`) whose URL is
**synthesized, not real** — `contentEventUrl` at `:19` builds
`https://studio.perceev.app/content/<slug>` at `:26`. That host is a fabrication.
The fabricated URL then feeds real lift attribution. R5.2.1 deletes it, R5.2.2
adds an explicit publish step where the operator pastes the **real** live URL and
the system verifies the page resolves and matches before the stage flips to
`PUBLISHED`, and R5.2.3 makes the lift copy read "since approval" with the
correlation caveat until then. All three are open.

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
| R1.1.2 | Browser-infrastructure spike: a Bright Data Scraping Browser / Browserless / residential-proxy account to measure block rate and cost per probe against. Also `needs-decision` — the ADR must record measured numbers, not preferences. |
| R1.3.1, R1.4.1 | Spike credentials + IN egress to capture Perplexity and logged-out ChatGPT fixtures, including block and login-wall pages. |
| R1.5.1 | Create the Supabase Storage bucket `probe-evidence` with a 90-day retention policy. |
| R1.6.1 | Verify Indian egress per engine — rupee pricing, Indian brands, `.in` citations. Needs the actual egress path, not a claim about it. |
| R1.7.1 | Production data access to dual-run the reference corpus through the API and UI paths for `docs/PARITY.md`. |
| R2.5.1 | Production `prompt_results` access, and the R0.4.2 labels, to point the calibration harness at the live judge. |
| R3.3.5 | A reachable Postgres (the Supabase service-role credentials plus migration `011`) so the reaper's idempotence is exercised against the real `close_scan_run`, not against a JS fake that re-implements what the migration is *believed* to do. Today `classifyReapCloseFailure` sorts a close failure by text-matching the plpgsql `RAISE` strings and that SQL has never been executed here. The test must skip **loudly and countably** with no database, never silently. |
| R4.1.1 | A Search Console property with the (rotated) service-account email added as a Restricted user. Today the account is on zero properties, which is why the GSC client is orphaned. |
| R4.4.1 | GA4 read access or permission to place a first-party snippet, for AI-referral attribution. |

### Needs a Vercel action (`needs-vercel`)

| Task | What the operator must do |
| --- | --- |
| R0.1.12 | See § A item 2. |
| R0.1.20 | **CLOSED in the ledger (verified pass, 2026-09-08) — the operator action is unchanged and still not done.** Curl the **deployed** `POST /api/scan` with a forged `x-vercel-forwarded-for` and assert the rate-limit bucket does not move. What closing the task changed is the *claim*, not the check: see below the table. |
| R3.1.1 | `vercel.json` currently schedules `/api/scan/worker` at `0 0 * * *` — once a day. Rescue of a stalled job therefore depends on someone having a browser tab open. It needs a 10-minute schedule. It is a compensation, not the fix — see R3.1.5. |
| R3.1.2 | `vercel.json` has no `?batch=1` entry, so the one automated scan-to-content chain is unreachable. Also `needs-llm`. |
| R3.1.5 | Decide where the post-response scan work lives, and record it. `git grep -n waitUntil -- src package.json` returns nothing and `@vercel/functions` is not a dependency, so the fire-and-forget `runScanChunk(job.id).catch(...)` after the response in `src/app/api/scan/route.js` has **no platform mechanism keeping the function alive** and can be frozen mid-scan. Three independent compensations hide this: `HEARTBEAT_STALE_MS` staleness inference, the poll-driven rescue in `GET /api/scan/[job_id]/status` (which makes an open browser tab part of the execution guarantee), and the daily crons. This is the root cause R3.1.1 above and R3.3.2 are each treating a symptom of; fixing them does not fix it. Needs a Vercel-level answer (`waitUntil`, or a worker that owns its own lifetime) plus the ADR. |

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
| R1.1.3 | Name the worker host (long-lived container), and rule out Vercel functions for this workload **in writing**. |
| R4.5.1 | Decide-or-delete, per item, on the schema-only subsystems: `topics`, `content_feedback` reads, the phantom `analyzing` status. Wire with a test, or delete with the schema. |
| R6.1.9 | **One sentence of approval is the whole ask.** Where the secrets-hygiene rule lives for agents outside the `rebuild-*` family: the guard covers six agent definitions, roughly forty other tracked instruction files under `.claude/` carry nothing, and both credential leaks came from agents running unscoped searches — nothing about that failure mode is specific to `rebuild-*`. The controller re-examined this on 2026-09-08 and **deliberately left it blocked**: copying the rule into forty files multiplies the thing that drifts, and the correct answer — move it to `CLAUDE.md`, which every session loads by construction, and reduce the six copies to a pointer — means editing the operator's own project-instruction file, which no agent has standing to do on another agent's say-so. Approve option A and the change is about ten minutes' work. |

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
- The scan work that runs **after** the HTTP response has **no platform
  keepalive** — `git grep -n waitUntil -- src package.json` returns nothing and
  `@vercel/functions` is not a dependency — so a scan can be frozen mid-run and
  three compensations are all that stand between that and silent abandonment
  (§ E, R3.1.5). Do not read "scans complete" as evidence against this; the
  compensations are what make it look fine.
- Migrations `012` **and `013`** have an **unverified** applied state in
  production (§ C). `013` is the one to check first: without it every scan
  finalize hard-fails with PostgREST `PGRST204`.
- The rebuild branch is many commits ahead of `main` and PR #1 is unmerged —
  `git rev-list --count main..HEAD` for the number, which changes hourly and is
  therefore not written down here. (It was 120 at `1a5ed81` and 123 at `04e80db`,
  in one working session; that rate is the reason.) Which commit the Vercel
  deployment actually serves is **not established by anything in this
  repository**; check the Vercel dashboard rather than inferring it.
