# ADR — the probe workload runs on a long-lived container, not a Vercel function

> <!-- doc-status -->
> **Status: LIVE.** Supersedes nothing; the first decision written down about
> where the probe fleet runs. **All three parts are now decided.** The operator
> ratified the vendor on 2026-09-16 — see
> [§5](#5-the-vendor--ratified-2026-09-16-zeabur) — and it is **not** one of the
> three this document originally compared.
> **Amended 2026-09-18:** §2.9 was one of the arguments for §1 and is now
> **false** — the post-response keepalive gap it described was closed for the
> Vercel-hosted API pipeline by R3.1.5, which took the *platform* mechanism, not
> the worker. See [`2026-09-18-post-response-keepalive.md`](./2026-09-18-post-response-keepalive.md).
> §§1–5 about the probe fleet are unaffected and still LIVE.

**Date:** 2026-09-05 · **Vendor ratified:** 2026-09-16
**Task:** R1.1.3 (`needs-decision`), depends on R1.1.1
(`docs/contracts/probe-result.md`).
**Status:** parts 1, 2 and 3 accepted.
**Citation baseline:** every `file:line` below was read in the working tree at
commit `95b190d`. Four files this document cites were **dirty in the working
tree** when it was written — `src/lib/workers/scanWorker.js`, `src/lib/db.js`,
`src/lib/scoring/enginePipeline.js`, `src/app/api/content/worker/route.js` — and
are therefore cited **by exported symbol or greppable string, never by line**,
per [the anchor rule](../vendors/README.md#a-note-on-citing-check-secretsmjs).
Everything cited with a line number was clean at `95b190d`. To find out whether
the numbers have gone stale:

```bash
git log --oneline 95b190d..HEAD -- vercel.json worker src/app/api/scan src/lib/liveDbGate.js src/lib/liveWriteGuard.js src/lib/workerIsolation.test.mjs scripts/setup-supabase.mjs .github/workflows/ci.yml
```

Empty means they still resolve. Non-empty means re-derive before trusting them.

---

## Context

The rebuild's probes are supposed to drive **real consumer surfaces** —
perplexity.ai and chatgpt.com as a logged-out human sees them — which needs a
persistent browser and minutes of wall clock per batch. The app they would feed
runs on Vercel.

There is no ADR saying where those probes execute. In its absence the
repository has drifted into answering the question twice, in two places, and
the two answers disagree about almost everything except that a function cannot
do it:

- `src/lib/workers/scanWorker.js` runs the *current* (API-based) scan pipeline
  inside Vercel functions, and has grown a large amount of machinery whose only
  purpose is to survive a process that will be killed mid-work.
- `worker/` is a second, separate Node workspace with its own `package.json`,
  its own Playwright dependency and a `while (running)` loop, added by R1.2.1 —
  and **nothing in this repository deploys it**. There is no `Dockerfile`, no
  `fly.toml`, no `railway.json`, no `Procfile`, no `docker-compose.yml`, no
  `render.yaml`; `git ls-files` matches none of those names at `95b190d`. Its
  own `npm test` script matches no files, and `.github/workflows/ci.yml` runs
  `npm run test:scoring` and `npm run build` and never enters `worker/`.

So the fleet exists as source and as nothing else. This ADR closes the part of
that gap that can be closed by argument, and names precisely the part that
cannot.

---

## 1. Decision — the class of host

**The probe workload runs as a long-lived process on a container host.** It is
not a Vercel function, not a Vercel cron, not an Edge function, and not a
scheduled invocation of any request-scoped runtime.

This is a statement about the **execution model**, not about a vendor. The
vendor is §5 and is not settled here.

`worker/` is already built to that shape and is deliberately host-agnostic:

- it is its own npm workspace with its own dependency set —
  `worker/package.json` declares `playwright` and `@supabase/supabase-js`, and
  `playwright` is **absent from the root `package.json`**, so the browser never
  enters the Next deploy bundle;
- `start()` at `worker/src/index.js:247` is a `while (running)` loop
  (`worker/src/index.js:263`) that sleeps `config.idlePollMs` between empty
  passes (`worker/src/index.js:273`) and installs SIGTERM/SIGINT handlers
  (`worker/src/index.js:258`) whose comment states the reason plainly: *"A
  container host stops the process with SIGTERM. Finishing the pass in flight
  rather than dying mid-batch is what keeps a lease from being orphaned for its
  full duration on every deploy."*
- nothing under `worker/` may import from the web app, and that is enforced by
  a test in the **main** suite — `src/lib/workerIsolation.test.mjs:55` and
  `:72` — not by a convention.

The consequence of that isolation is what makes §5 deferrable: a workspace of
Node + Playwright with no Next imports differs between Railway, Fly and Hetzner
only in its image definition and its secret plumbing. **The class decision
unblocks everything; the vendor decision unblocks only the deploy.**

---

## 2. Why Vercel functions cannot serve this workload

Not argued from what serverless is generally bad at. Argued from the code this
repository has already written to work around it. Each item below is machinery
that exists **only** because a function is request-scoped and stateless; on a
long-lived process, each is either unnecessary or ceases to be load-bearing.

### 2.1 The scan chunk is chopped into slices to fit under a wall-clock ceiling

`src/app/api/scan/route.js:11`, `src/app/api/scan/worker/route.js:20` and the
`export const maxDuration = 300` in `src/app/api/content/worker/route.js` all
declare a five-minute ceiling. `scanWorker.js`'s `CHUNK_TIME_BUDGET_MS` is a
**soft** budget sized against it, and its own docstring says so — grep
`Soft per-chunk time budget`:

> *"Governs when a chunk stops STARTING new probe batches and instead
> checkpoints + self-continues, leaving headroom under the routes'
> `maxDuration = 300` for the last batch to finish, the checkpoint write, and
> (on the probing path) the fire-and-forget self-continue fetch."*

`runProbingPhase` returns `{ budgetHit: true, ... }` when
`nowFn() - chunkStartMs >= budgetMs` (grep `budgetHit: true`), and `runScanChunk`
turns that into a persisted checkpoint plus a hand-off (grep
`reason: "checkpointed"`). A scan is therefore *deliberately many executions*,
and the number of executions is a function of the platform's clock, not of the
work.

The new workload is strictly worse against that ceiling than the existing one.
The existing chunk's slowest unit is an HTTP call to a vendor — the same
docstring records a 60s internal timeout for Bright Data probes and 45s with up
to two retries for ChatGPT/Perplexity. A real-surface probe is a browser
navigation plus render plus extraction, and `FLEET_BATCH_SIZE` defaults to 5
(`worker/src/config.js`, `batchSize`), with `FLEET_LEASE_MS` defaulting to
**300000** — a lease exactly as long as the entire function ceiling.

### 2.2 The continuation is an HTTP call to itself, and it is explicitly best-effort

`resolveSelfContinueUrl` / `defaultSelfContinue` in `scanWorker.js` fire a
`fetch` at `/api/scan/worker?job_id=…` to re-enter the same handler in a fresh
invocation. Its own docstring calls it *"an optimization only — correctness
never depends on it"*, and it authenticates with `CRON_SECRET` because the
route it is calling is secret-gated. A process that can simply continue
executing needs none of this: no self-addressed HTTP call, no shared secret to
call yourself with, and no base-URL resolution that falls through
`NEXT_PUBLIC_APP_URL` → `VERCEL_URL` → `localhost`.

### 2.3 Liveness is inferred from a timestamp because the process cannot be observed

`src/lib/db.js` exports `HEARTBEAT_STALE_MS` (3 minutes) and `isJobAlive`,
which decides a job is alive purely from how recently `heartbeat_at` moved
(grep `HEARTBEAT_STALE_MS` and `export function isJobAlive`). `updateScanJob`
stamps `heartbeat_at` on every call (grep `heartbeat_at: new Date()`). On top
of that, `shouldRescueJob` in `scanWorker.js` reads "not terminal and not
alive" as "resume it".

That whole apparatus is a substitute for the thing a container gives you for
free: a process you can see, whose exit is an event. Vercel hands the caller a
response and takes the process away; the only evidence left behind is a
timestamp in Postgres.

### 2.4 A browser tab is part of the execution guarantee

`src/app/api/scan/[job_id]/status/route.js:56` calls `shouldRescueJob(job)` and
fires `runScanChunk(job.id)` from inside a **status poll**, with a comment that
states the design outright: *"this route is already polled every ~2s by the
client, so piggyback the staleness check here instead of relying solely on the
cron sweep."* Whether a scan finishes therefore depends in part on whether
someone left a tab open. That is not a property any product wants, and it is
not a property a long-lived worker can have.

### 2.5 The cron cadence is set by the plan, not by the work

`vercel.json:4-5` schedules `/api/scan/worker` at `0 0 * * *` and
`vercel.json:8-9` schedules `/api/content/worker` at `30 0 * * *` — **once a
day each**. `docs/plans/production-plan.md` (status **SUPERSEDED-BY** the
rebuild roadmap; §C2) states the constraint as *"Vercel Hobby permits only
daily crons"* and works out the consequence: rescue latency up to 24h,
throughput of three jobs a day, and every configured cadence ("72h", "daily",
"weekly") collapsing into "checked once a day". `docs/OPERATOR_LEDGER.md`'s
R3.1.1 row records the same thing as outstanding operator work. The sweep is
additionally capped at `MAX_CONCURRENT_RESUMES = 3`
(`src/app/api/scan/worker/route.js:22`).

*(The plan-tier claim itself is a Vercel billing fact, not a repository fact.
It is repeated here with its source named rather than asserted; what the
repository proves is that the crons are daily and that the code is built around
them being daily.)*

A polling container sets its own cadence from `FLEET_IDLE_POLL_MS`
(default 10 s) with no plan involved. `docs/HANDOFF-2026-08-30.md:147-149`
makes exactly this point in the other direction: once the fleet container
exists, R3.1.1's 10-minute loop no longer needs a Vercel plan change.

### 2.6 A dead executor had to be given a counter, because nothing else could count it

`MAX_JOB_ATTEMPTS = 3` and migration `012_scan_job_attempts.sql` exist because,
in the words of the block that introduces them in `scanWorker.js` (grep
`R3.3.1 — the attempt cap`):

> *"A job whose worker dies at the same point every time — a finalize that
> outruns maxDuration, a container killed mid-probe — was therefore resumed
> forever, every cron tick, every day, spending real vendor budget on an
> execution that has never once finished."*

Note the first of those two failure modes names `maxDuration` directly. The cap
is a real safety net and should survive the move, but the *frequency* of the
condition it catches is a function of the execution model.

### 2.7 The ledger exists because an invocation leaves no other trace

`supabase/migrations/011_scan_runs.sql` and the `CHUNK_PHASES` /
`chunkRunOutcome` machinery in `scanWorker.js` were built on the finding that
*"a chunk that ran and did nothing, a chunk that never ran, a chunk that died
halfway and a chunk that declined for a good reason all leave the same
evidence"* (grep `WHAT THIS REPLACES`). This one is **not** an argument against
functions specifically — `worker/src/lib/runLedger.js` writes the same rows
from the fleet on purpose, and `worker/README.md` explains why even idle passes
get a row. It is listed here because it is the cost of *inferring* execution
from database state, and that inference is unavoidable when the executor
vanishes with its logs.

### 2.8 In-process state cannot be process-local, and once was

`createScanJob` in `src/lib/db.js` fail-softs into `global.memoryJobs`, which
is per-process and therefore invisible to the status poll, the cron worker and
every other instance. That produced a 201 for a scan nobody could read back;
`docs/decisions/2026-09-05-unpersisted-scan-jobs.md` is the ADR that closed it
at the route. The lesson generalises: on a fleet of ephemeral instances,
**every** piece of state must round-trip through Postgres, including state
whose only reader is the next line of the same logical operation.

### 2.9 ~~The one that is still open:~~ CLOSED 2026-09-18 — nothing kept the work alive after the response

> **Correction, 2026-09-18 (R3.1.5).** Everything below was true at `95b190d`
> and is **false now**. It is struck through rather than deleted because it was
> one of the arguments this ADR's §1 rested on, and a reader auditing that
> argument needs to see which leg moved. The decision that closed it is
> [`2026-09-18-post-response-keepalive.md`](./2026-09-18-post-response-keepalive.md):
> the **platform mechanism** was taken, not the long-lived worker this section
> argued for. Next is 14.2 so there is no `after()`; `@vercel/functions`
> `waitUntil` (`package.json:52`, `^3.9.7`) is used through exactly one helper,
> `src/lib/keepAlive.js:36`, at nine post-response sites — including
> `src/app/api/scan/route.js:142`, the very line cited below.
> **§2.9 no longer supports §1.** The fleet decision stands on its own grounds
> (a real-surface probe needs a persistent browser and minutes of wall clock,
> §§2.10 and 1); it no longer stands on this.

~~`src/app/api/scan/route.js:128` starts the first chunk and returns:~~

```js
runScanChunk(job.id).catch(err => {   // gone; now keepAlive(() => runScanChunk(job.id), …)
```

~~**There is no `waitUntil` anywhere in this repository.**~~
~~`git grep -n waitUntil -- src/ package.json` returns nothing at `95b190d`, and~~
~~`@vercel/functions` is not a dependency.~~ `docs/plans/production-plan.md` §C1
identified this as the fix and prescribed it; ~~it was never applied. So today,
on Vercel, the continuation of a scan past its own HTTP response is
**unprotected** and is rescued only by §2.3's heartbeat plus §2.4's browser tab
plus §2.5's daily cron.~~ **it was applied on 2026-09-18 in `53995fa`.** §2.3's
heartbeat, §2.4's poll-driven rescue and §2.5's daily cron all **remain** and
were deliberately not removed — they are now the backstop rather than the only
thing between a scan and silent abandonment.

~~This is the sharpest form of the argument. The platform's own escape hatch for
"work that outlives the response" is not in use, and the system stays upright
on three independent compensations instead. That is not a bug to fix before
moving the workload — it is the reason to move it.~~

**What remains unproven** is narrower than what this section claimed, and it is
worth stating because the strikethrough above could be over-read: that Vercel
*actually* holds the instance longer is observable only on a deployed scan and
is **not** proven by any test in this repository. R3.1.5 stays tagged
`needs-vercel` for that reason. See the new ADR's *What is NOT verified*.

### 2.10 And the browser was never going to fit

`worker/README.md`'s *Why it is a separate workspace* says it in one line:
*"The probes need a persistent browser and minutes of wall clock. A Vercel
function has neither: it is request-scoped, and Playwright's browsers do not
belong in a deploy bundle."* The root `package.json` has no `playwright`
entry, and `src/lib/workerIsolation.test.mjs:44` asserts that the fleet's
manifest does.

### What this does *not* claim

Vercel remains correct for the Next app, the API routes, and the two daily
crons. This ADR moves **probe execution**, not the web tier. It also does not
claim the compensations above should be deleted: several of them (checkpointed
resume, the attempt cap, the ledger, database-owned state) are good properties
for a container too, and `worker/src/index.js` already reimplements the shape
of most of them. What changes is that they stop being *forced*, and stop being
the only thing standing between a scan and silence.

---

## 3. Decision — the laptop worker is dev mode, from day one

**There is no separate "development fleet".** The dev fleet is the production
fleet's source, run on a developer's machine against a non-production database,
and that is the intended path from the first day rather than a later
convenience. `worker/README.md`'s *Running it* section already documents it:

```bash
npm --prefix worker install
npm --prefix worker run check     # parses, then starts and completes one pass
npm --prefix worker start         # the real loop; needs SUPABASE_URL + a key
```

Three properties make that honest today:

1. **It starts standalone.** `npm --prefix worker check` runs
   `node --check src/index.js && node src/index.js --selftest`
   (`worker/package.json`). `selftest()` in `worker/src/index.js` resolves the
   **real** config path with `strict: false`, drives one pass against stubs,
   and then asserts the pass left a *closed* ledger row — it throws
   `"selftest pass left no closed scan_runs row — every pass must account for
   itself"` rather than exiting 0 on a pass that did nothing. It needs no
   database, no browser and no credential.
2. **It refuses rather than faking.** `probeBatch` in `worker/src/lib/probe.js`
   throws at `:27`. Its message is assembled from two string literals, so grep
   the second half — *"which would score as real non-mentions"* — rather than
   the whole sentence. A developer running the loop today gets
   a loud stub, not a green fleet producing invented data. `claimBatch` refuses
   the same way for an unreachable queue.
3. **It cannot accidentally become the web app.** The isolation guard
   (`src/lib/workerIsolation.test.mjs:55`, `:72`) runs in the main CI suite, so
   a laptop worker and a container worker are provably the same program.

`worker/README.md`'s *What is not built* table is the current truth: the
workspace, the claim (R1.2.2) and the ledger (R1.2.3) are built; the Perplexity
adapter (R1.3), the ChatGPT adapter (R1.4) and evidence capture (R1.5) are not.
**A laptop fleet run today claims tasks, writes ledger rows, and throws at the
probe.** The dev *runbook* is R1.2.5 and is `todo`; this ADR does not pre-empt
it.

### 3.1 The live-write boundary, stated exactly

The repository has a hard, tested boundary that keeps *test* processes off the
production database, and it is worth being precise about where its edge is,
because a laptop fleet sits just outside it.

**What is enforced.** `src/lib/liveDbGate.js` and `src/lib/liveWriteGuard.js`
exist because an earlier draft of R3.2.1's live test wrote two real rows into
`scans` and two into `brand_metrics_daily` on production. Since R3.2.4:

- `armedLiveDbGate({ label, allow })` installs a **default-deny** write guard
  *before* it reports whether a live database is configured, so no ordering
  exists in which a test is pointed at a real database unguarded.
- `liveDbGate()` **throws** if a live database is configured and no guard is
  armed — see `requireArmedGuard` — and R3.2.10 widened "the real environment"
  from object identity to *value*, comparing host + database path, so
  `liveDbGate({ ...process.env })` is refused the same way `liveDbGate()` is.
- Armed-but-blind does not read as armed: both `requireArmedGuard` and
  `armedLiveDbGate` throw when `covers.supabase` or `covers.pg` is false.
- `NEVER_WRITABLE` in `src/lib/liveWriteGuard.js:126` refuses 20 customer
  tables — the frozen list runs `:126-147`, `scans` through `content_lessons`,
  and includes `brand_metrics_daily`, `scan_jobs`, `prompt_results`,
  `citations` and `result_brands` — *even when a test names them*.
- `src/lib/liveWriteGuardAuto.mjs` preloads the guard into every process
  started by `npm test`, `npm run test:scoring` and `npm run test:live`.

**Where its edge is, stated because it matters here.** That module's own
docstring ends: *"Not wired into `next dev`, `next build` or the workers: this
is a test-only preload, named only in the `test`, `test:scoring` and
`test:live` scripts in package.json."* Two consequences follow, and neither is
a defect in the guard — the guard is a **test-harness** boundary and was never
claimed to be more:

- **`npm --prefix worker start` is not guarded.** The fleet builds its own
  Supabase client in `worker/src/lib/queue.js:64` from its own copy of
  `@supabase/supabase-js`; nothing preloads a patch into that process.
- **Even if it were, the fleet's two tables are the opt-in-writable ones.**
  `WRITABLE_BY_OPT_IN` is `["scan_runs", "probe_tasks"]`
  (`src/lib/liveWriteGuard.js`), which is exactly what a fleet pass writes.

So the only thing that decides which database a laptop fleet writes is **which
credentials that process was given.** Two sharp edges in the current code make
that worth an explicit rule rather than an assumption:

- `worker/src/config.js:33` and `:35` fall back
  `SUPABASE_URL || NEXT_PUBLIC_SUPABASE_URL` and
  `SUPABASE_SERVICE_ROLE_KEY || NEXT_PUBLIC_SUPABASE_ANON_KEY`. In a shell
  where the app's production values are exported, the fleet inherits
  production.
- Neither `SUPABASE_SERVICE_ROLE_KEY` nor any `FLEET_*` variable appears in
  `.env.example` — verified: `grep -c` returns 0 for both at `95b190d`. They
  are documented only in `worker/README.md`'s *Configuration* table. An
  operator following `.env.example` therefore has no place to put the fleet's
  credentials and will reach for the app's.

**The rule this ADR sets, therefore:** a laptop fleet is started with an
explicit `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` naming a **non-production
project**, exported into that process and no other. It is never started by
sourcing the app's `.env.local`. Enforcing that in code — a boot-time refusal
when the fleet's target matches production and no explicit opt-in is present —
belongs to **R1.2.6 ("Fleet config validated at boot")**, which is `todo`;
`liveDbGate`'s `isRealEnvironment` / `dbTarget` host+path comparison is the
right shape to copy, and copying rather than importing is what
`src/lib/workerIsolation.test.mjs` requires. **Until R1.2.6 lands, this is a
convention and not a guard, and this ADR says so rather than implying
otherwise.**

---

## 4. Criteria the vendor must be judged against

Derived from this workload, not from a features matrix.

| # | Criterion | Why it comes from this repo | Decisive? |
|---|---|---|---|
| C1 | Long-lived process; no request ceiling; SIGTERM with a grace period | `worker/src/index.js:247-273` is a `while` loop with a SIGTERM handler that finishes the pass in flight | **Yes** — but all three candidates satisfy it |
| C2 | Egress identity and geography (IN) | `SERP_GEO=in` in `.env.example`; the target market is India | **Conditional** — see below |
| C3 | Can run a persistent headless browser | `worker/package.json` declares `playwright`; needs an OS image with the browser's system libraries, not a plain Node buildpack | **Yes** |
| C4 | Memory and CPU headroom at `FLEET_BATCH_SIZE` concurrency | default 5 concurrent probes (`worker/src/config.js`), each a Chromium context | **Yes, and unmeasured** |
| C5 | Cost at the expected probe volume | volume is itself unresolved — see below | **Yes, and the input is missing** |
| C6 | How migrations get applied | — | **No — see C6 below** |
| C7 | Secret handling for a service-role credential | the fleet needs `SUPABASE_SERVICE_ROLE_KEY`, the first component in the repo that does | Tie-breaker |
| C8 | Log retention / observability | the fleet's per-pass narration is `describeRun` / `describeClaim` on **stdout** — `worker/src/index.js:38` defines `const log = (msg) => console.log(...)` and every narration call site (`:88`, `:121`, `:144`, `:242`) goes through it; the failed-pass line at `:270` is the exception and uses `console.error` (stderr). The durable record is `scan_runs` in Postgres | Tie-breaker |

**C2 is conditional on R1.1.2, and R1.1.2 is blocked.** If R1.1.2 chooses the
Bright Data Scraping Browser, the browsing egress is Bright Data's residential
network and the container's region stops mattering for block rate — which is
exactly the argument `docs/HANDOFF-2026-08-30.md:133-137` makes. If R1.1.2
chooses self-hosted Playwright plus proxies, the container's own egress is in
the path and region becomes a first-order criterion. R1.1.2's ledger entry is
`blocked: needs-secrets` and its own blocking note says it *"depends on R1.1.3
being settled first, since the worker host determines where the spike runs."*
**That is a genuine cycle and it is named here rather than papered over.** §5's
recommendation is written to break it in the cheapest direction: ratify a host
for the *spike*, let the spike's measurement confirm or reverse it.

**C5's input does not exist yet either.** `docs/HANDOFF-2026-08-30.md:139-142`
states the open question as five brands *tracked and scanned weekly*
(~1,300 probes/month, steady) versus five *new* brands onboarded weekly
(~17,000/month by Q2, which changes the queue design). Its cost figures
(~$27–68/month on Bright Data Scraping Browser at the low volume) are repeated
here **with their source named and unverified by this ADR** — they are not
derived from anything in the repository, and no probe has ever run.

**C6 does not discriminate, and that is a useful finding.** Migrations are
already decoupled from every deploy target. `npm run setup:db` runs
`scripts/setup-supabase.mjs` with `--env-file=.env.local` from an operator's
machine, connecting over `pg` with `DATABASE_URL` or `SUPABASE_DB_PASSWORD`;
R6.1.1 gave it a `schema_migrations` ledger, and `docs/PROD_MIGRATIONS.md` is
the per-migration verification procedure. There is **no** migration step in
`.github/workflows/ci.yml`, no deploy hook, and no `postinstall`. The database
is managed Supabase and is reached identically from Railway, Fly, Hetzner and a
laptop. **No candidate earns or loses a point on C6, and no candidate should be
chosen for its migration story.**

---

## 5. The vendor — ratified 2026-09-16: Zeabur

**Decision: the fleet runs on the operator's existing Zeabur server.** Ratified
by the operator on 2026-09-16. It is **not** one of the three candidates §5.1
compared; it won on the one ground §5.1 named last and could not see —
*"the operator already has an account and paid capacity somewhere."*

| | |
|---|---|
| Server | `server-6a527fe7e33921bfb5d0fa29`, "Tencent Tokyo 2C 2GB" |
| Provider / region | Tencent Cloud · Tokyo, JP |
| Runtime | ZeaburOS + **K3s** |
| Spec | 2 vCPU · 2 GB RAM · 39.3 GB disk · 512 GB/mo egress |
| Cost | US$3/mo, paid through 2026-10-11 |
| Observed at ratification | CPU 6% (120m/2000m) · **memory 1084 MB of 1935 MB already in use** · disk 15.0 GB of 39.3 GB |
| Upgrade path | US$4/mo → 4 GB / 60 GB / 1.536 TB · US$6/mo → 8 GB / 80 GB / 2.56 TB |

*Every figure above is read from the operator's Zeabur dashboard on 2026-09-16
and is not verified by anything in this repository.*

**Grounds, in order of weight:**

1. **Paid capacity already exists**, and the marginal cost of using it is zero.
   §5.1's ground 1 — that the near-term dominant cost is time-to-first-container
   rather than the box — argues *more* strongly for a box already running than
   it did for Railway.
2. **K3s satisfies C1 better than a generic PaaS does.** §1's whole argument
   rests on a process that gets SIGTERM and finishes the pass in flight rather
   than orphaning a lease (`worker/src/index.js:258`). On K3s that grace period
   is an explicit `terminationGracePeriodSeconds` on the Deployment, set by us,
   rather than a platform default we would have to discover empirically.
3. **Reversal still costs one image definition.** The isolation rule
   (`src/lib/workerIsolation.test.mjs:55`, `:72`) is what makes this true, and it
   is as true for Zeabur as it was for the three candidates.

### 5.1.a What ratification changes about C4, and what it does not

**At the ratified 2 GB, roughly 850 MB is free** (1935 − 1084; the consumed
portion is ZeaburOS and K3s, not our workload).

> **CORRECTED 2026-09-16, hours after this section was first written.** The
> first draft said 850 MB "does not host `FLEET_BATCH_SIZE`'s default of 5
> concurrent Chromium contexts" and concluded that R1.1.2's spike must run on
> the US$6/mo 8 GB tier. **Both halves were wrong, and the error was reading a
> documented default instead of resolving the config.** It is corrected in place
> rather than deleted, because a memory ceiling asserted from a number nobody
> executed is exactly the class of claim this ADR is otherwise careful about.

Resolve the config and the real concurrency is far lower than the raw defaults
suggest — `resolveConfig` with only the two required variables set yields:

- **`batchSize: 2`, not 5.** The resolver refuses 5 and says why in its own
  `adjustments` output: `FLEET_BATCH_SIZE × (probeDelayMaxMs + probeTimeoutMs)`
  must fit inside `FLEET_LEASE_MS` (300 000), and at perplexity.ai's delays it
  does not. A batch that outlives its lease has its results refused.
- **`maxConcurrency: 1` per surface**, from `SURFACE_BUDGETS` in
  `worker/src/config.js`. This is a **politeness** ceiling from R1.1.5, not a
  resource one — its stated reason is that "a logged-out consumer UI is a claim
  to be one person, and two simultaneous requests from one session is the
  cheapest possible contradiction of it." It will not be raised to buy
  throughput.

So the ceiling on concurrent Chromium contexts is **the number of enabled
surfaces — one by default (`engines: ["perplexity"]`), two if ChatGPT is also
enabled — not `FLEET_BATCH_SIZE`.** One context fits in ~850 MB with room; two
is tight but not obviously impossible.

**What follows for R1.1.2:** the 2 GB tier is a legitimate place to *begin* the
spike, and the upgrade is a response to a measured footprint rather than a
precondition for measuring one. What must not happen is the other failure: if
self-hosted Playwright is observed to thrash or OOM at 2 GB, that is a signal to
raise the tier and re-measure, **not** evidence that self-hosted browsing loses.
Ruling it out on a constraint the operator can lift for US$6/mo would be
choosing on the box rather than on the measurement, which is the failure
R1.1.2's acceptance criterion exists to prevent.

### 5.1.b What ratification changes about C2

The egress is **Tencent Cloud datacenter IPs in Tokyo**, against a market whose
target geography is India (`SERP_GEO=in` in `.env.example`).

Per §4, C2 is conditional on R1.1.2 and remains so. If R1.1.2 picks managed
browsing, browsing egress is the vendor's residential network and Tokyo stops
mattering for block rate. If R1.1.2 picks self-hosted Playwright, then Tokyo
datacenter IPs are in the path, and that is a **measurement R1.1.2 must take,
not an assumption this ADR may make in either direction.** Datacenter IPs are
commonly blocked harder than residential ones; whether these are, against
perplexity.ai and chatgpt.com, is unknown and cheap to find out.

### 5.1.c What ratification does not settle

- **Nothing here verifies Zeabur's platform capabilities.** Whether it deploys
  from a Dockerfile, how it injects secrets, what its log retention is, and
  whether a K3s workload can be given the grace period §1 needs are all
  **unconfirmed by this document** and must be established by the first deploy.
  This is the same rule §5.1's table was marked with, applied to the winner.
- **1084 MB was already in use at ratification with none of our workload
  deployed.** If other projects are running on this server, the free figure is
  lower than 850 MB and §5.1.a's arithmetic moves.
- **No probe has ever run** (`worker/src/lib/probe.js:27` throws). Every
  statement about memory footprint per Chromium context remains an estimate.

**Reversal conditions — any one of these should reopen the vendor question:**

- **R1.1.2 measures an unacceptable block rate from Tokyo datacenter egress
  *and* picks self-hosted Playwright.** Then IN-region egress becomes
  first-order and Zeabur's Tokyo region is disqualifying for the browsing path
  specifically — though it may still host the fleet process while browsing goes
  elsewhere.
- **The 8 GB tier proves insufficient at the measured footprint**, or volume
  resolves to the onboarding case (~17k probes/month per
  `docs/HANDOFF-2026-08-30.md:139-142`). Re-run §5.1's C4/C5 comparison with
  real numbers.
- **Zeabur cannot give a K3s workload the SIGTERM grace period §1 requires.**
  Then C1 — the one criterion §5.1 called decisive and assumed all candidates
  met — fails, and this decision was made on a false premise.

**What ratification unblocks:** an image definition (a Dockerfile with
Playwright's system libraries), a K3s manifest carrying
`terminationGracePeriodSeconds` and the `FLEET_*` / `SUPABASE_SERVICE_ROLE_KEY`
environment, and `npm --prefix worker run check` in CI. R1.2.5's runbook and
R1.2.6's boot validation have both since landed and no longer wait on this.

---

### 5.1 What was compared before ratification — superseded, kept as record

**Which of Railway, Fly and Hetzner runs the fleet is a spend-and-vendor
commitment and belongs to the operator.** This section was a recommendation with
its reasoning and its reversal conditions. It is **superseded by the ratification
above** and is kept because the reasoning is what the ratification was judged
against, not because it still stands.

*(**Every cell below the C1 row is a vendor capability or pricing claim, and
none of it is verified by this document.** It is undated recollection, not
sourced to any vendor page, and it is not derived from anything in this
repository — unlike §§1–3, which are argued from files here. No cell
should be relied on until the operator has confirmed it against each vendor's
current pricing page and region list at ratification time. This matters because
these cells are load-bearing and not decorative: "Fly has a Mumbai region" is
the whole of ground 2 and reversal condition 1, "cheapest per GB" is ground 3
and reversal condition 2, and "datacenter IPs" underwrites reversal condition 3.
If a cell is wrong, the recommendation below moves.)*

| | Railway | Fly.io | Hetzner |
|---|---|---|---|
| C1 long-lived process | yes | yes | yes |
| C3 browser image | Dockerfile | Dockerfile | Dockerfile |
| C2 IN egress | region choice; **only decisive if R1.1.2 picks self-hosted browsing** | has a Mumbai region — the one candidate-specific advantage on C2 | datacenter IPs; region depends on the plan bought |
| C4 memory headroom | priced per GB-hour | priced per GB-hour | cheapest per GB by a wide margin |
| C5 cost at low volume | dominated by the browsing bill, not the box | same | same |
| C7 secrets | managed | managed | operator's own — you build it |
| C8 ops burden | least | middle | most (patching, restarts, backups are yours) |
| Reversal cost | one image definition | one image definition | one image definition |

**Recommendation, provisional: Railway** — *superseded 2026-09-16 by §5; the
operator ratified Zeabur, which this comparison did not consider.* Recorded on
three grounds and no others.

1. **The near-term dominant cost is time-to-first-container, not the box.** The
   repository has zero deploy artifacts of any kind, `probeBatch` still throws,
   and the first thing the host must do is carry R1.3.1's Playwright spike. On
   C5 at the low-volume figure, the box is not what the money goes to.
2. **C2 — Fly's one distinguishing advantage — may not apply**, and cannot be
   known until R1.1.2 measures. If browsing goes through a managed residential
   network, Mumbai buys nothing that matters. Choosing Fly *for* its region
   today is choosing on an unmeasured hypothesis, which is the failure mode
   R1.1.2's acceptance criterion was written to prevent.
3. **Hetzner's advantage is a volume advantage** (C4/C5 at scale) bought with
   C7 and C8 ops burden, and the volume question (C5) is unanswered. Self-hosting
   to save a fixed monthly amount is the wrong trade while the variable cost is
   the browsing bill.

**Reversal conditions for the superseded Railway recommendation** — kept because
the fourth is the one that actually fired:

- **R1.1.2 measures an unacceptable block rate from managed browsing, or picks
  self-hosted Playwright + residential proxies.** C2 becomes first-order and
  IN-region egress becomes decisive. → **Fly (Mumbai)**, or Hetzner in a region
  the spike measured.
- **Volume resolves to the onboarding case** (~17k probes/month by Q2 per
  `docs/HANDOFF-2026-08-30.md:139-142`) **and the fleet's measured memory
  footprint at `FLEET_BATCH_SIZE` makes per-GB price dominate.** → **Hetzner**,
  and budget the ops burden explicitly.
- **A managed host's egress IP range turns out to be pre-blocked by a target
  surface.** This is measurable and unmeasured; if it happens, the criterion
  becomes "an IP we control", which points away from the managed options.
- **The operator already has an account and paid capacity somewhere.** Named
  last because it is the most likely deciding factor in practice and the one
  this document has no visibility into. **This is the condition that fired**, on
  2026-09-16, and the capacity was on a vendor this table does not list.

**What ratification meant, and what happened:** the operator names one and it is
recorded in `docs/OPERATOR_LEDGER.md`. Done on 2026-09-16 — see §5. Of the
follow-on work this paragraph listed, `SUPABASE_SERVICE_ROLE_KEY` and the
`FLEET_*` variables have since been added to `.env.example`, R1.2.5's runbook
landed (`docs/runbooks/fleet-dev.md`) and R1.2.6's boot validation landed
(`worker/src/config.js`). What remains is the image definition.

---

## Consequences

- **`worker/` is confirmed as the fleet's home**, and the "no imports from
  `src/`" rule (`src/lib/workerIsolation.test.mjs`) is confirmed as load-bearing
  rather than stylistic: it is what makes §5 reversible for the price of one
  image definition.
- **The Vercel tier stays as it is.** With a polling fleet, R3.1.1's 10-minute
  cadence is the fleet's business; `vercel.json`'s daily crons remain a
  backstop for the *existing* API-based pipeline, and the OPERATOR_LEDGER row
  for R3.1.1 stays open on its own terms.
- **The compensations in §2 are not deleted by this ADR.** Checkpointed resume,
  the attempt cap, `scan_runs` and database-owned state remain correct for a
  container and are already mirrored in `worker/src/index.js` and
  `worker/src/lib/runLedger.js`. ~~§2.9's missing `waitUntil` is a live gap in
  the *current* Vercel-hosted pipeline and is untouched by this decision.~~
  **Corrected 2026-09-18:** that gap was closed by R3.1.5 in the Vercel-hosted
  pipeline (see §2.9 and
  [`2026-09-18-post-response-keepalive.md`](./2026-09-18-post-response-keepalive.md));
  it remains untouched by *this* decision, which is about `worker/`.
- **The fleet has no CI.** `.github/workflows/ci.yml` never enters `worker/`,
  and `npm --prefix worker test` matches no files at `95b190d`. The only
  automated check on the fleet today is the isolation guard, which runs in the
  main suite. Whoever owns the deploy should own adding
  `npm --prefix worker run check` to CI; this ADR does not claim a task for it.
- **`.env.example` is incomplete for the fleet.** `SUPABASE_SERVICE_ROLE_KEY`
  and every `FLEET_*` variable are absent from it. That is a live trap for the
  boundary in §3.1 and should be fixed by whoever lands the deploy or R1.2.6.

## What this ADR does NOT decide

- ~~**The vendor.**~~ **Decided 2026-09-16: Zeabur.** See §5.
- **Browser infrastructure.** Bright Data Scraping Browser vs self-hosted
  Playwright + residential proxies vs Browserless is **R1.1.2**, which requires
  a measured block rate and cost per probe from IN egress and is `blocked:
  needs-secrets`. Nothing here should be read as pre-judging it. **Ratifying
  Zeabur does not decide it**, and §5.1.a states the condition explicitly: the
  spike is run at a memory tier where self-hosted Playwright can execute, so
  that it is ruled in or out by measurement rather than by the 2 GB tier.
- **Probe volume, cadence or politeness budget.** R1.1.5 and R3.1.
- **Whether the *existing* API-based scan pipeline moves off Vercel.** It stays
  where it is. This ADR moves real-surface probe execution only.
- ~~**The `waitUntil` fix (§2.9).** Identified, cited, unowned by this task.~~
  **Owned and closed 2026-09-18 by R3.1.5** — the answer is the platform
  mechanism, recorded in
  [`2026-09-18-post-response-keepalive.md`](./2026-09-18-post-response-keepalive.md).
  It is still not decided *by this ADR*; it is decided by that one.

## Reversal conditions for §§1–3

1. **A real-surface probe turns out to fit inside a request-scoped
   invocation** — a hosted-browser API that returns a full extracted result in
   seconds, with no persistent process. Then §1's premise (minutes of wall
   clock, a persistent browser) is false and a function becomes viable again.
   Note this is *not* the same as R1.1.2 picking a managed browser: a managed
   browser still needs a process to drive it, hold a lease and report.
2. **The isolation rule is abandoned** and `worker/` starts importing from
   `src/`. Then the fleet is no longer host-agnostic, §5's "reversal costs one
   image definition" stops being true, and the vendor choice becomes expensive
   and therefore urgent.
3. **R1.2.6 lands a boot-time production guard for the fleet.** §3.1's closing
   paragraph is then out of date and should be rewritten from "convention" to
   "enforced, by <symbol>".

## Evidence

Read at `95b190d`. Line numbers only where the file was clean; symbols and
greppable strings where it was not.

**Cited by line (clean at `95b190d`):**
`vercel.json:2-9` · `src/app/api/scan/route.js:11`, `:128` ·
`src/app/api/scan/worker/route.js:20`, `:22` ·
`src/app/api/scan/[job_id]/status/route.js:56` ·
`worker/src/index.js:247`, `:258`, `:263`, `:273` ·
`worker/src/config.js:33`, `:35` · `worker/src/lib/probe.js:27` ·
`worker/src/lib/queue.js:64` · `src/lib/workerIsolation.test.mjs:44`, `:55`,
`:72` · `src/lib/liveWriteGuard.js:126` (`NEVER_WRITABLE`) ·
`docs/HANDOFF-2026-08-30.md:133-137`, `:139-142`, `:147-149`.

**Cited by symbol or greppable string (dirty in the working tree at
`95b190d` — `src/lib/workers/scanWorker.js`, `src/lib/db.js`,
`src/app/api/content/worker/route.js`):**
`CHUNK_TIME_BUDGET_MS` and its `Soft per-chunk time budget` docstring ·
`budgetHit: true` · `reason: "checkpointed"` · `resolveSelfContinueUrl` ·
`defaultSelfContinue` · `shouldRescueJob` · `MAX_JOB_ATTEMPTS` ·
`an optimization only` ·
`R3.3.1 — the attempt cap` · `CHUNK_PHASES` · `chunkRunOutcome` ·
`WHAT THIS REPLACES` · `HEARTBEAT_STALE_MS` · `isJobAlive` ·
`createScanJob` / `global.memoryJobs` · `export const maxDuration = 300`.

**Whole-file / structural evidence:** `worker/README.md` · `worker/package.json`
· root `package.json` (no `playwright`, no `@vercel/functions`) ·
`.github/workflows/ci.yml` · `src/lib/liveDbGate.js` (`armedLiveDbGate`,
`liveDbGate`, `requireArmedGuard`, `isRealEnvironment`, `dbTarget`) ·
`src/lib/liveWriteGuardAuto.mjs` · `scripts/setup-supabase.mjs` ·
`docs/PROD_MIGRATIONS.md` · `docs/plans/production-plan.md` §C1/§C2 (status
**SUPERSEDED**) · `docs/OPERATOR_LEDGER.md` rows R1.1.2, R1.1.3, R3.1.1 ·
`docs/contracts/engine-surface-matrix.md` §4.1, §7 ·
`docs/decisions/2026-09-05-unpersisted-scan-jobs.md`.

**Negative evidence (absence, verified at `95b190d`):**

```bash
git ls-files | grep -iE 'dockerfile|fly\.toml|railway|nixpacks|procfile|docker-compose|render\.yaml'   # no output
git grep -n waitUntil -- src/ package.json                                                             # no output  <- STALE, see below
grep -c 'FLEET_\|SUPABASE_SERVICE_ROLE_KEY' .env.example                                               # 0
```

> **The second command no longer reproduces (2026-09-18, R3.1.5).** It now
> returns `src/lib/keepAlive.js` and `package.json:52`. The absence it recorded
> was real at `95b190d` and is the finding R3.1.5 closed; it is annotated rather
> than edited so the derivation of §2.9 stays readable. The other two still
> reproduce as written.

## What is unproven

Stated plainly, because the value of an ADR written before a deploy is entirely
in what it refuses to claim.

- **No probe has ever run.** `probeBatch` throws (`worker/src/lib/probe.js:27`).
  Every statement here about browser memory, block rate, probe latency or cost
  per probe is a criterion to measure, not a measurement. C4 and C5 have no
  numbers.
- **The `maxDuration = 300` ceiling and the Hobby daily-cron cap are Vercel
  platform/billing facts**, sourced to `docs/plans/production-plan.md` §C2 and
  `docs/HANDOFF-2026-08-30.md`, not verified against Vercel by this document.
  What *is* verified from source is that the code declares 300 and that the
  crons are daily.
- **The `~$27–68/month` and `~1,300 / ~17,000 probes per month` figures are
  quoted from `docs/HANDOFF-2026-08-30.md` and are not derived from anything in
  the repository.** They are the operator's numbers to confirm.
- **The R1.1.2 ⇄ R1.1.3 cycle was broken by siting, not by resolving** — the
  host is now named (§5) so the spike has somewhere to run, but C2 is still
  conditional on R1.1.2's measurement and may yet reverse part of §5.
- **Nothing in this repository deploys `worker/`**, so no claim here has been
  tested on any host — including the ratified one. The first deploy is the
  first test, and §5.1.c says which Zeabur capabilities it will be testing.
- ~~**§3.1's rule is a convention, not a guard.**~~ **Obsolete since R1.2.6
  closed** (`worker/src/config.js` validates and refuses at boot). §3.1's
  closing paragraph still reads as though R1.2.6 were `todo` and should be
  rewritten from "convention" to "enforced, by `worker/src/config.js`"; it is
  left standing here rather than silently edited, per reversal condition 3.
- **Every cell of §5.1's vendor comparison table is unverified by this
  document.** Railway's, Fly's and Hetzner's capabilities, regions and pricing
  are undated recollection, sourced to no vendor page and to nothing in this
  repository. That table is now superseded and nothing turns on it — but it is
  the reasoning the ratification was judged against, so its unreliability is
  worth keeping in view rather than deleting along with the recommendation.
- **§5's Zeabur figures are the operator's dashboard, read once on 2026-09-16**,
  and Zeabur's platform behaviour — Dockerfile deploys, secret injection, K3s
  grace periods, log retention — is **entirely unverified**. §5.1.c enumerates
  what the first deploy has to settle.

---

## The decision this document left open — closed 2026-09-16

It asked for one sentence — *"the fleet runs on ⟨host⟩"* — and on 2026-09-16 the
operator supplied it:

> **The fleet runs on Zeabur** (`server-6a527fe7e33921bfb5d0fa29`, Tencent Cloud
> Tokyo, ZeaburOS + K3s).

Recorded in `docs/OPERATOR_LEDGER.md` under R1.1.3. §5 carries the grounds, what
it does and does not settle, and the conditions that would reopen it. §5.1 keeps
the superseded Railway / Fly / Hetzner comparison as the record of what the
choice was judged against.

**What is still open is the deploy, not the decision.** No Dockerfile, no K3s
manifest and no CI entry for `worker/` exist; `probeBatch` still throws. A first
deploy produces a fleet that claims tasks, writes `scan_runs` rows and refuses
loudly at the probe — which is the platform R1.1.2's spike needs, and the point
of naming a host now.
