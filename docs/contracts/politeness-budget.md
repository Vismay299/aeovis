# Contract — Politeness & Risk Budget

> <!-- doc-status -->
> **Status: LIVE** as the normative budget the R1 probe fleet (`worker/`) must
> run under, and as the honest record of what the tree throttles today.
> §2 records what was configured and hard-coded when this was written; §6 lists
> every place the tree violates §3, and §8 says which numbers were measured
> (none) and which were chosen (all).
>
> **What code reads, and what it does not.** §3.2's numbers for the two
> surfaces the fleet drives are now real configuration — `SURFACE_BUDGETS` and
> six `FLEET_*` fields in `worker/src/config.js`, refused at boot when out of
> range, printed at start-up (§5.2). **No probe is paced by them**: `probeBatch`
> has no adapter until R1.3/R1.4, so the values are resolved and logged rather
> than applied, and the boot log says `VALIDATED, NOT APPLIED` for as long as
> that is true. The one rule enforced today is §5.2's lease arithmetic, which
> bounds `FLEET_BATCH_SIZE`. The scoring path in `src/` still hard-codes its
> concurrency and reads none of this (§5.4).

**Date:** 2026-09-09 · **Task:** R1.1.5 · **Consumes:** R1.1.4
([`engine-surface-matrix.md`](./engine-surface-matrix.md)), R1.1.1
([`probe-result.md`](./probe-result.md)) · **Consumed by:** **nobody, in the
ledger's own terms — see below**

> **No task in the orchestration ledger declares a dependency on R1.1.5.**
> Walking `.claude/orchestration/tasks.json` at `9e85cfe` for any task whose
> `deps` array contains `"R1.1.5"` returns **zero results**. The three tasks
> whose *text* depends on this document do not link to it: R1.3.4 (*Perplexity
> canary*, `deps: ["R1.3.3"]`), R1.4.3 (*ChatGPT adapter + canary + soak*,
> `deps: ["R1.4.2"]`) and R1.7.2 (*Cutover per engine behind the ENGINES flag*,
> `deps: ["R1.7.1", "R1.3.5"]`, and gated on "a quiet canary" — a term §4.4
> defines and nothing else does). All three are `todo`.
>
> Re-derive it yourself; do not cite a line number into that file, which is
> written continuously by the controller and every worker:
>
> ```
> node .claude/orchestration/orchestrate.mjs show R1.3.4
> node .claude/orchestration/orchestrate.mjs show R1.4.3
> node .claude/orchestration/orchestrate.mjs show R1.7.2
> ```
>
> This is recorded rather than papered over because `probe-result.md` §3.13
> established the standard: a "consumed by" list is a claim about declared
> dependencies, not a wish. **This document is currently unreferenced by the
> plan that needs it**, and adding those three links is a one-line ledger edit
> that this document cannot make.

## Baseline and citation policy

**Every claim in this document was resolved against `git show 9e85cfe:<path>`**
— the committed blob, never the working tree. There is one baseline and it is
`9e85cfe`.

**Citations here name a symbol, not a line**, following
`engine-surface-matrix.md` rather than `probe-result.md`. That sibling carries
155 line citations and has been re-baselined three times because some of them
rotted; one rotted between being written and being verified. **This document
contains no line citations at all.** Every claim points at a file plus a
function, constant, column or variable name, so `git grep` re-derives it at any
commit.

**How to tell whether this file has gone stale:**

```
git log --oneline 9e85cfe..HEAD -- worker/src/config.js worker/src/index.js \
  worker/src/lib/queue.js worker/src/lib/probe.js worker/README.md \
  src/shared/scoring/aioConstants.js src/shared/scoring/enginePipeline.js \
  src/server/workers/scanWorker.js src/shared/engines/ src/server/rateLimit.js \
  supabase/migrations/010_probe_tasks.sql supabase/migrations/011_scan_runs.sql \
  vercel.json .env.example
```

Empty output means every symbol below is still where it was read. Non-empty
means re-derive before trusting a number.

**Working-tree disclosure, true at the moment of writing.** This tree has
concurrent writers. `git status --short` reported these files modified and
uncommitted while this was written:

| File | Why it matters here |
|---|---|
| `src/shared/engines/perplexity.js` | §2.3's per-request retry shape is read from `9e85cfe`; the file is under edit and its cost/state vocabulary is moving. Cited by symbol only. |
| `src/shared/engines/gemini.js`, `src/shared/gemini.js` | Under edit. No claim here depends on either — `gemini` is dead code (`engine-surface-matrix.md` §3.4). |
| `src/app/api/scan/[job_id]/status/route.js` | Under edit; named here only as one of the three routes that reach `runScanChunk`. |
| `src/shared/scoring/enginePipeline.js` | **Clean when §2.1 was read at `9e85cfe`; modified by another agent before this file was submitted.** `CHATGPT_CONCURRENCY`, `PERPLEXITY_CONCURRENCY`, `ENGINE_REGISTRY`, `runWithConcurrency` and `runMultiEngineScan` are cited **by symbol only**, which is exactly the case this policy exists for. Re-grep the names before trusting §2.1 or §6 V3. |

Every other file cited was clean at `9e85cfe`. A drift table is worth writing
only if it is true when read: if you are reading this after those commits
landed, treat the table as history and run the tripwire above.

**One knock-on this document deepens and does not fix.** `probe-result.md`'s
Baseline section still states that it "is the only document in
`docs/contracts/`". `engine-surface-matrix.md` §"Baseline and citation policy"
already records that its own arrival made that false and left it for a one-line
follow-up. This is now the **third** file in that directory, so the sentence is
wrong by two. Not edited here: this document does not edit another agent's file,
and the follow-up is still unfiled.

---

## 1. Why this exists

Two failures recur. A budget is the cheapest thing that prevents both, and
writing it down is the only part of it that can be done before the fleet exists.

> **Throttling that is not decided is throttling that is discovered.** Nothing
> in this tree paces an outbound probe. The pacing that exists today is an
> accident of other constraints — a chunk time budget sized for a serverless
> function, a per-IP cap on the public scan route sized to protect *our* vendor
> spend, and three concurrency constants chosen to keep a browser tab from
> timing out. None of them is about the surface being probed. When a real
> browser starts driving `perplexity.ai`, the rate it drives it at will be
> whatever falls out of `FLEET_BATCH_SIZE`.

> **A probe that a budget stopped must not look like a probe that found
> nothing.** This is standing rule 1 applied to throttling, and it is the reason
> this document is a *contract* and not a config note. A daily cap that silently
> drops work produces a scan with fewer rows and no explanation, which scores
> exactly like a brand nobody talks about. `probe-result.md` §3.2 already has the
> value for this — `skipped`, with a `state_reason` — and §3.7 below makes using
> it mandatory.

## 2. What the tree actually throttles today

Read this section before §3. It is the baseline §3 departs from, and every claim
in it was executed, not reasoned.

### 2.1 Concurrency — three numbers, hard-coded, in a scoring module

| Engine | Constant | Value | Where |
|---|---|---|---|
| `aio` | `AIO_CONCURRENCY` | **6** | `src/shared/scoring/aioConstants.js` |
| `chatgpt` | `CHATGPT_CONCURRENCY` | **4** | `src/shared/scoring/enginePipeline.js` (module-private `const`, not exported) |
| `perplexity` | `PERPLEXITY_CONCURRENCY` | **4** | `src/shared/scoring/enginePipeline.js` (module-private `const`, not exported) |

They reach the probe loop as the `concurrency` property of each `ENGINE_REGISTRY`
entry in `src/shared/scoring/enginePipeline.js`. **None of the three is readable
from the environment**, none is validated, and none is printed at start-up.

`AIO_CONCURRENCY`'s own comment states its reasoning: 34 queries at ~45–60s each
at concurrency 3 takes ~10–12 minutes and "butts against the client's poll
timeout", and 6 halves it. That is a reason about **our** page, not about
Google's or Bright Data's tolerance. The comment's second clause — that Bright
Data retries 429s internally — is a claim about the vendor and **is not verified
in this repository**; what *is* verifiable here is that `brightDataSearch`
(`src/shared/engines/brightdata.js`) retries a 429 itself.

**Two loops read `concurrency`, and only one of them runs in production.**
`runProbingPhase` in `src/server/workers/scanWorker.js` slices the pending queries
into windows of `engine.concurrency` and `Promise.all`s each window. That is the
live path (`engine-surface-matrix.md` §2.1 traces it to the `vercel.json` cron).
`runMultiEngineScan` in `enginePipeline.js` has its own `runWithConcurrency`
helper and is **test-only** — its only importers are
`src/shared/scoring/citationDenominator.test.mjs` and
`src/shared/scoring/citationShareEmptyDenominator.test.mjs`.

### 2.2 Delay between probes — there is none, anywhere

- `runProbingPhase` goes from one `Promise.all` window straight into the next.
  There is no sleep, no wait and no pacing between batches.
- The fleet loop `start` in `worker/src/index.js` sleeps **only when it claimed
  nothing**: `if (handled === 0) await sleep(config.idlePollMs)`. A pass that
  handled work loops immediately into the next claim.
- **There is no jitter in the tree.** `git grep "Math.random" -- src/server/ src/shared/ worker/`
  returns matches in exactly two files: `src/server/landingProbeCounter.test.mjs`
  (a guard *against* fabricated randomness) and `src/server/workers/scanChunk.test.mjs`
  (a test fixture id). No engine adapter and no worker file uses randomness for
  anything.

### 2.3 Retry and backoff — the only pacing that exists, and it is per-request

| Adapter | Attempts | Delay between attempts | Jitter |
|---|---|---|---|
| `brightDataSearch` (`src/shared/engines/brightdata.js`) | `options.attempts ?? 2` | `backoffMs * attempt`, tripled for a 429; `backoffMs` defaults to 3000, so one 429 retry waits 9s | none |
| `probeChatGpt` (`src/shared/engines/openai.js`) | `MAX_RETRIES = 2` plus the first try | `delay(1000 * Math.pow(2, attempt))` on 429/5xx | none |
| `probePerplexity` (`src/shared/engines/perplexity.js`) | `MAX_RETRIES = 2` plus the first try | `RETRY_BASE_DELAY_MS * Math.pow(2, attempt)` | none |

Every one of these is **per request and deterministic**. Concurrency is 4 or 6.
So when a surface starts refusing, all four (or six) in-flight probes take the
same branch at roughly the same moment and re-fire after the *same* fixed
interval. Deterministic synchronised backoff from N concurrent callers is the
thundering-herd shape, and it is the strongest single argument for §3.4's
jitter rule. This is derived from the three expressions above; it has **not**
been observed against a live 429.

Bright Data's quota path is the exception and it is correct: an error whose text
matches `rate limit` / `quota` is thrown rather than retried
(`brightDataSearch`, and `isRetryableHttpStatus`'s callers).

### 2.4 Volume — no cap of any kind on outbound probes

`git grep -i "daily_cap|dailyCap|probe_cap|per_day"` over `src/server`, `src/shared`, `worker/`
and `supabase/migrations` returns nothing.

The only volume bound in the tree is **inbound**, and it protects our spend
rather than the surface: `src/server/rateLimit.js`'s `DEFAULTS` are 5 scans per
client per 3,600,000 ms window, overridable by `SCAN_RATE_LIMIT` and
`SCAN_RATE_LIMIT_WINDOW_MS` (both present in `.env.example`). Its own header
says what it is for: "one anonymous caller can start unlimited scans, each
spending real Bright Data + Perplexity + LLM budget."

That is not a politeness budget and must never be read as one:

- it is **per client**, so N callers are N × the limit;
- it bounds *scans*, not probes. One scan is up to `DEFAULT_UNBRANDED_TARGET`
  (30, `src/shared/scoring/promptSetSize.js`) plus `MAX_BRANDED` (4,
  `src/shared/scoring/aioQueryClassify.js`) = **34 queries per engine**, so a single
  allowed scan is up to 68 outbound requests with `ENGINES=aio,perplexity`;
- it does not apply to the cron path at all. `vercel.json` schedules
  `/api/scan/worker` at `0 0 * * *`, and that route reaches `runScanChunk`
  without passing through `checkScanRateLimit`.

### 2.5 The fleet's config has no politeness field

> **Superseded for the fleet, and left standing as the baseline it was.**
> Everything below was true at `9e85cfe` and is why §5.2 exists. `CONFIG_FIELDS`
> now holds **fourteen** entries: the eight named here plus
> `FLEET_MAX_CONCURRENCY`, `FLEET_PROBE_DELAY_MIN_MS`,
> `FLEET_PROBE_DELAY_MAX_MS`, `FLEET_DAILY_CAP`, `FLEET_CANARY_INTERVAL_MS` and
> `FLEET_PROBE_TIMEOUT_MS`, and `.env.example` now carries those six. The two
> near-misses below are still near-misses and still mean what they say.

`CONFIG_FIELDS` in `worker/src/config.js` is the complete list of variables the
fleet reads. At `9e85cfe` it holds eight entries: `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `FLEET_ENGINES`, `FLEET_BATCH_SIZE`,
`FLEET_LEASE_MS`, `FLEET_IDLE_POLL_MS`, `FLEET_HEARTBEAT_MS`, `FLEET_WORKER_ID`.
`git grep -oh "FLEET_[A-Z_]*" -- worker/ src/ .env.example | sort -u` returns
that same set (plus `FLEET_PHASES`, an unrelated ledger enum, and
`FLEET_NOT_A_VARIABLE`, a test fixture).

**None of them is a concurrency, a delay or a cap.** Two are near-misses that a
reader will reach for and that mean something else:

- `FLEET_BATCH_SIZE` (default 5, range 1–50) is how many tasks are **leased per
  poll** — it is `p_limit` on `claim_probe_tasks`. It says nothing about how many
  are in flight at once. §3.3 keeps them separate on purpose.
- `FLEET_IDLE_POLL_MS` (default 10,000) is the gap **only when the queue was
  empty**. It is not an inter-probe delay; a busy fleet never reaches it (§2.2).

`.env.example` contains **no** `FLEET_*` variable at all —
`grep -n "FLEET" .env.example` returns nothing. This is already recorded against
R1.1.3 and is repeated here because a budget nobody can set is not a budget.

### 2.6 There is no canary

`git grep -i canary` over `src/`, `worker/`, `supabase/` and `scripts/` returns
**zero matches in code**. Every hit is in `.claude/orchestration/tasks.json`,
`docs/OPERATOR_LEDGER.md` and `docs/plans/2026-08-29-rebuild-roadmap.md` — the
ledger tasks R1.3.4 (Perplexity canary), R1.4.3 (ChatGPT adapter + canary +
soak) and R1.7.2 (cutover, gated on "a quiet canary"), none of which has run.

**Nothing defines "quiet".** R1.7.2 gates a production cutover on a condition
that no document states and no code computes. §4.4 states it, and names that it
is being invented here rather than recovered from somewhere.

### 2.7 The task lease is never renewed

`renewBatch` is defined and exported in `worker/src/lib/queue.js`, and it wraps
migration 010's `renew_probe_lease`. **`worker/src/index.js` does not import
it** — its queue import list is `claimBatch, reportBatch, releaseBatch,
describeClaim, CLAIM_REASONS` — and `git grep renewBatch -- worker/` returns
only the definition in `queue.js` itself. Nothing else in the repository calls
it.

The heartbeat that *does* run (`startHeartbeat` → `heartbeatRun` →
`heartbeat_scan_run`) moves `scan_runs.heartbeat_at`. It does not touch
`probe_tasks.lease_expires_at`. So a batch's lease is fixed at claim time to
`FLEET_LEASE_MS` and cannot be extended.

This is inert today because `probeBatch` throws immediately. It stops being
inert the moment §3.4's delays exist — see §6, V6, which is the one violation in
this document that pacing itself *creates*.

---

## 3. The budget (normative)

"Must", "must not" and "never" below are requirements on code.

### 3.1 The unit the budget applies to

> **NORMATIVE.** A budget line applies to a **(surface, egress IP)** pair, and
> the caps in §3.5 apply to a **surface, fleet-wide**. Neither is per container
> and neither is per scan.

This is the distinction that makes a budget real. A concurrency of 1 enforced
per container is a concurrency of N when N containers run, and a daily cap held
in an environment variable is N × the cap for the same reason. Where §3 says
"fleet-wide" it means a single shared count that every container consults, and
§5.3 records that no such counter exists.

A container that drives more than one surface **must** apply each surface's line
independently. The simplest way to satisfy this document is one surface per
container — `FLEET_ENGINES` already defaults to a single engine
(`["perplexity"]`) — but that is a deployment convenience, not the rule.

### 3.2 The per-surface numbers

The surfaces are `engine-surface-matrix.md`'s rows. **Every number in this table
was chosen, not measured** (§8).

| Surface | Driven by | Concurrency, per egress IP | Inter-probe delay | Daily cap, fleet-wide |
|---|---|---|---|---|
| `perplexity.ai`, logged-out UI (matrix row 4) | `worker/`, browser | **1** | uniform random **20,000–45,000 ms** | **400** |
| `chatgpt.com`, logged-out UI (matrix row 5) | `worker/`, browser | **1** | uniform random **30,000–90,000 ms** | **200** |
| `api.perplexity.ai` (matrix row 3) | `src/`, HTTP | **2** | none required; §3.4's 429 rule applies | **2,000** |
| `api.openai.com` (matrix row 2) | `src/`, HTTP | **2** | none required; §3.4's 429 rule applies | **2,000** |
| Bright Data Unlocker → Google SERP (matrix row 1) | `src/`, HTTP | **6 — deliberately unchanged**, §3.3 | none required | **3,000** |

**Where the daily caps come from.** They are derived from demand, not from any
vendor's tolerance, because no vendor's tolerance is known to this repository.
One brand scan is at most 34 queries per engine (§2.4). So 400 on
`perplexity.ai` is ~11 brand-scans per day after the canary's 24 (§4.3); 200 on
`chatgpt.com` is ~5. **A cap's job here is to bound the blast radius of a
runaway loop, not to model a threshold nobody has measured.** If the product
needs more than 11 Perplexity scans a day, the cap is raised deliberately and
this table changes — which is the entire point of writing it down.

**That the caps and the delays are mutually consistent.** At concurrency 1 with
a mean delay of 32.5 s, `perplexity.ai` sustains roughly 65 probes/hour if a
probe itself takes ~30 s, so 400/day is about 6 hours of continuous probing —
the cap binds before the clock does, which is the correct ordering. On
`chatgpt.com` (mean delay 60 s) the same arithmetic gives ~40/hour and 200/day is
about 5 hours. The probe durations in that arithmetic are **assumed, not
measured**; only their ratio to the delays matters for the consistency check.

### 3.3 Concurrency

> **NORMATIVE.** A surface this fleet drives **directly** — a browser we run, or
> an HTTP client we write, against an endpoint the vendor did not sell us as a
> scraping product — **must not** exceed **2** concurrent in-flight probes per
> egress IP, and a logged-out consumer UI **must** be **1**.

`1` for the UI surfaces is not a tuning preference. A logged-out browser session
is a claim to be one person; two simultaneous requests from one session is the
cheapest possible contradiction of that claim, and it is a contradiction we would
be making for a saving of a few minutes per scan.

> **`aio` keeps its 6, and this document says so rather than writing a number
> nobody would implement.** The `aio` counterparty is Bright Data — a vendor we
> hold a contract and a quota with, whose Unlocker product exists to broker the
> relationship with Google. The 1–2 rule is about surfaces where *we* are the
> party being polite. Dropping `AIO_CONCURRENCY` to 2 would roughly triple the
> probing wall clock (its own comment costs concurrency 3 at ~10–12 minutes for
> 34 queries) against a `CHUNK_TIME_BUDGET_MS` of 150,000 ms, multiplying chunk
> self-continuations, and would buy politeness toward a party we never address.

What would change that: a measured Bright Data 429 or quota-rejection rate that
shows 6 is over the **vendor's** tolerance. `brightDataSearch` already types
that signal — a `rate limit` / `quota` error is thrown and not retried — so the
evidence is collectable without new instrumentation. It has not been collected.

> **Concurrency is not batch size.** `FLEET_BATCH_SIZE` leases tasks;
> concurrency governs how many of them are in flight. An implementation **must
> not** treat the claim size as a concurrency, and a batch of 5 at concurrency 1
> is five sequential probes with four delays between them. §6 V6 is what that
> costs.

### 3.4 Delay and jitter

> **NORMATIVE.** Between two consecutive probes of the same surface from the same
> egress IP, an implementation **must** wait a delay drawn **uniformly at random**
> from the surface's `[min, max]` window in §3.2. A fixed delay **must not** be
> used, and the delay **must not** be skipped for the first probe of a batch.

A fixed interval is a signature: it is perfectly periodic, it is trivially
distinguishable from a human, and it also synchronises every container that
started at the same time. The randomness is not decoration; it is the property
that makes the pacing worth paying for. Note that the tree contains a guard that
exists to *forbid* `Math.random` on the landing surface
(`src/server/landingProbeCounter.test.mjs`) — that rule is about fabricating a
displayed number and has nothing to do with this one. A jittered delay is not a
measurement of anything and is never rendered.

> **NORMATIVE — the 429 rule.** A rate-limit or block response **must** raise a
> **surface-level** cooldown, not only a per-request retry. While a surface is
> in cooldown, no probe of that surface may be started by any container.

Today's three adapters do the opposite (§2.3): each in-flight request retries
independently on a deterministic schedule, so a 429 that four concurrent probes
all receive produces four simultaneous retries. Per-request retry **may** remain,
but it **must** be jittered — the retry delay is drawn from `[d, 2d]` where `d`
is the current deterministic value — and it **must not** be the only response to
a 429.

### 3.5 Daily caps

> **NORMATIVE.** A daily cap is a count of **probe attempts against a surface**,
> fleet-wide, over a UTC day. It **must** be checked **before** a probe is
> started, never after it is reported. Canary probes (§4) count against it.

A cap enforced at report time has already made the request it was supposed to
prevent. A cap held in an environment variable and checked in-process is a
per-container cap and **must not** be described as a fleet-wide one (§3.1).

An attempt counts against the cap whether it answered or not. A blocked probe
consumed a request; excluding it would let a surface that is refusing us be
hammered hardest.

### 3.6 Retry ceilings

> **NORMATIVE.** Total attempts for one query on one surface, across all
> containers and all leases, **must not** exceed `probe_tasks.max_attempts`
> (default 3, migration 010). A retry **must** be a new attempt on the queue,
> not an in-process loop layered underneath one.

The queue already counts this correctly: `claim_probe_tasks` increments
`attempts` on every claim. An in-process retry loop is invisible to that counter,
so today's three adapters can each turn one queued attempt into three requests —
and a `max_attempts` of 3 into nine. That is the ceiling this rule closes.

### 3.7 What an exhausted budget must produce

> **THE RULE.** A probe that a budget prevented **must** be recorded as a probe
> result with `state: "skipped"` and a `state_reason` naming the budget. It
> **must not** be silently dropped, and the task **must not** be left `pending`
> with no record.

The vocabulary is `probe-result.md` §3.2's, and the closed `state_reason` list
this document adds to it:

| `state_reason` | Meaning |
|---|---|
| `daily_cap_exhausted` | §3.5's cap for this surface is spent for the UTC day. |
| `surface_cooldown` | §3.4's 429 cooldown is active for this surface. |
| `surface_quarantined` | §4.5's canary quarantine is active for this surface. |

Per `probe-result.md` §3.11, a `skipped` row enters **no** denominator and
**no** numerator, and appears only in the slice's mandatory `not_measured`
tally. That tally is what makes a throttled day legible: a scan that probed 12 of
34 prompts because the cap ran out reports `coverage_pct` over the 12 it measured
**and** `not_measured: { skipped: { daily_cap_exhausted: 22 } }` beside it.
Without the tally, §3.5 is a mechanism for quietly shrinking denominators, which
is the failure in `probe-result.md` §1 wearing a budget's clothes.

**The rejected alternative, named so it is not re-proposed.** The cheaper design
is for the *producer* to stop enqueueing once a cap is reached. It was rejected
because a task that was never created leaves no evidence: the scan simply has
fewer rows, and nothing distinguishes "the budget stopped us" from "the prompt
set was smaller". Enqueue everything; let the fleet type the refusal.

---

## 4. Canary policy

### 4.1 What a canary is here

A **canary** is a scheduled probe of one surface, with a fixed query, whose only
purpose is to detect that the surface has stopped being probeable **before a
customer scan discovers it**. It measures the fleet's access, not a brand.

### 4.2 The query

> **NORMATIVE.** A canary query **must** be brand-neutral, non-branded and
> evergreen, and **must** be committed as a fixture rather than generated. Its
> success condition **must** be `state: "answered"` — **never** a match against
> expected answer text.

A canary that asserts on answer content fails when the model's answer legitimately
changes, which produces an alert that means nothing and trains the operator to
ignore the channel. What the canary is testing is whether the surface will still
answer us at all.

### 4.3 Cadence

> **NORMATIVE.** One canary probe per surface per hour — **24 per surface per
> day** — counted against that surface's §3.5 daily cap.

A canary excluded from the cap is a cap that under-reports by 24. That leaves 376
and 176 probes per day for customer work on `perplexity.ai` and `chatgpt.com`
respectively, and those are the numbers a capacity plan must use.

> **NORMATIVE.** A canary task **must** be enqueued with a `priority` above the
> default so a long customer queue cannot starve it.

`probe_tasks.priority` exists (`DEFAULT 0`) and `probe_tasks_claim_idx` is
already `(engine, priority DESC, created_at)`, so this needs no migration. The
cost is bounded: a canary displaces at most one customer probe per hour per
surface.

### 4.4 The alert, and what "quiet" means

> **NORMATIVE.** **Two consecutive** canary probes on one surface whose `state`
> is anything other than `answered` **must** raise an alert naming the surface,
> both states and both `state_reason`s.

Two, not one, because a single failure on a consumer surface is ordinary; and
not three, because R1.3.4's acceptance criterion is that "a simulated two-failure
sequence produces an alert", and this document must not make that test
unsatisfiable.

> **NORMATIVE — "quiet canary".** A surface's canary is **quiet** when, over the
> trailing 7 days, at least **90%** of its canary probes returned `answered`,
> **and** no §4.4 alert has fired in the trailing **48 hours**. A surface whose
> canary has run for less than 7 days is **not quiet** — it is unmeasured, and
> those are different (`probe-result.md` §3.12).

This definition is **invented here**. R1.7.2 gates the production engine cutover
on "a quiet canary" and R1.4.3 on "canary quiet", and §2.6 establishes that
nothing in the tree defines it. 90% is deliberately the same figure as R1.4.3's
soak bar ("at least 90 percent answered across the soak") so that the two gates
cannot disagree with each other; it is not independently derived, and it is not
measured.

### 4.5 Quarantine

> **NORMATIVE.** **Three consecutive** non-`answered` canary probes **must**
> quarantine the surface: every customer probe of it is `skipped` with
> `state_reason: "surface_quarantined"` (§3.7).
>
> **The canary itself is exempt from quarantine and keeps running.** Quarantine
> lifts automatically on the first canary probe that returns `answered`.

A quarantine that also stops the canary is permanent, because the only signal
that could lift it is the one it stopped. This is the same failure shape as an
idle fleet that cannot be told from a starved one
(`describeClaim` in `worker/src/lib/queue.js` exists for that reason).

### 4.6 A canary result must never reach a customer denominator

> **NORMATIVE.** A canary probe result **must not** be written to
> `prompt_results`, and the R1.2.4 ingest route **must** reject a canary row
> that names a `scan_job_id`.

`probe_tasks.scan_job_id` is nullable by construction (migration 010 declares it
`uuid` with no `NOT NULL` and deliberately no foreign key), and migration 011's
header states that the ledger must be able to record executions with no job. So
"`scan_job_id IS NULL`" is a sufficient discriminator today and no migration is
needed to enqueue a canary. Whether that is the discriminator R1.2.4 should key
on, versus an explicit marker column, is a decision this document does not make.

---

## 5. Where the numbers must live

R1.1.5's acceptance criterion has two clauses. The numbers are §3. This section
is the second clause — "the fleet reads them from config rather than
hard-coding".

> **This section changed state.** It was written at `9e85cfe` as a proposal and
> recorded, in its own header and in §6, that **nothing** implemented it. The
> fleet half of it now ships: §5.2's fields are real entries in `CONFIG_FIELDS`
> in `worker/src/config.js`, the §3.2 numbers are one frozen `SURFACE_BUDGETS`
> table in that same file, and both boot-time checks refuse. The **scoring**
> path is unchanged and still hard-codes its concurrency — §5.4 states that gap
> rather than letting §5's new tense imply it closed. Everything below is
> present tense against the tree unless it says otherwise.

### 5.1 What "from config" is taken to mean

The phrase needs a checkable definition, because a frozen table inside
`worker/src/config.js` is still, literally, in code. The distinction that matters
is not where the literal sits but whether an operator can see it, set it, and be
refused when they set it wrong. So:

> **A number in §3 is "read from config" when all four hold:**
>
> 1. **One named module owns it.** Not a private `const` in a scoring module that
>    a different pipeline imports.
> 2. **A named environment variable overrides it**, and that variable is listed
>    in `.env.example` and in `worker/README.md`'s configuration table.
> 3. **An out-of-range or unparseable override refuses at boot** — non-zero exit,
>    every problem named — rather than clamping or falling back.
> 4. **The resolved value is printed at start-up**, so the container's own log
>    records what it ran on.

Points 3 and 4 are not aspirational: `resolveConfig` and `describeConfig` in
`worker/src/config.js` already do exactly this for the eight existing fields, and
`worker/README.md` already documents why clamping was rejected. This section asks
for more rows in a table that works, not a new mechanism.

By this test, today's three concurrency constants (§2.1) fail all four — and
**the fleet's own six fields now pass all four**: `SURFACE_BUDGETS` owns the
numbers, `CONFIG_FIELDS` names the variables and `worker/README.md` and
`.env.example` list them, an out-of-range value exits non-zero without
clamping, and `describeConfig` prints one resolved line per surface at boot.

### 5.2 The field shape this requires — **shipped**

Stated concretely so it is implementable. It was a proposal when written; the
table below is now what `CONFIG_FIELDS` in `worker/src/config.js` actually
holds. Four of the five have **no scalar default**: absent means "each surface
takes its own §3.2 row", and a value that *is* set overrides every surface the
container drives.

| Variable | Kind | Range | Default | Meaning |
|---|---|---|---|---|
| `FLEET_MAX_CONCURRENCY` | int | 1–2 | 1 | In-flight probes per surface, per container (§3.3). A value of 3 must be **refused**, not clamped. |
| `FLEET_PROBE_DELAY_MIN_MS` | int | 0–600,000 | per surface, §3.2 | Lower bound of the jitter window (§3.4). |
| `FLEET_PROBE_DELAY_MAX_MS` | int | 0–600,000 | per surface, §3.2 | Upper bound. Must be **> min**, or boot refuses — the same shape as the existing `FLEET_HEARTBEAT_MS` ≤ ½ `FLEET_LEASE_MS` conflict check. |
| `FLEET_DAILY_CAP` | int | 1–100,000 | per surface, §3.2 | Fleet-wide cap (§3.5). See §5.3 — an env var alone **cannot** enforce this. |
| `FLEET_CANARY_INTERVAL_MS` | int | 300,000–86,400,000 | 3,600,000 | §4.3 cadence. |
| `FLEET_PROBE_TIMEOUT_MS` | int | 5,000–600,000 | 60,000 | **Added by the implementation.** The check below needs "a probe's own timeout" and the tree had none — `probeBatch` throws before it can time out. A bare constant in `config.js` would have been the hard-coded term this whole section exists to remove, so it is a field like the rest. The value is **chosen, not measured** (§8). |

The per-surface defaults are a frozen `SURFACE_BUDGETS` table in
`worker/src/config.js` beside `FLEET_ENGINES`, keyed by engine id — which is
what `FLEET_ENGINES` names and what `probe_tasks.engine` stores, so a claimed
task indexes its budget directly.

> **It holds two of §3.2's five rows, and that is deliberate.** The other three
> (`api.perplexity.ai`, `api.openai.com`, Bright Data → Google SERP) are driven
> by `src/`, not by the fleet, and their concurrency already has a code
> representation. Copying those numbers into the fleet's table would give them
> **two** representations that nothing keeps in step — the defect a single table
> exists to prevent, not a fix for it. §5.4 records where they still live.

**The interaction validated at boot**, by the same machinery that already
refuses a heartbeat slower than half a lease:

> `FLEET_BATCH_SIZE × (FLEET_PROBE_DELAY_MAX_MS + a probe's own timeout)` must
> not exceed `FLEET_LEASE_MS`, or the batch outlives its lease and its results
> are refused (§6, V6).

Two consequences worth reading before deploying a container:

- **The shipped defaults do not satisfy it.** 5 × (45,000 + 60,000) is 525,000
  against a `FLEET_LEASE_MS` of 300,000. A `FLEET_BATCH_SIZE` *the operator set*
  that cannot fit is a refusal naming both variables; the **default** 5 is
  narrowed to 2 and announced as a `NOTE:` line, exactly as the default
  heartbeat already is. **The throughput term gives way and the politeness term
  never does** — a delay narrowed to fit a lease is a budget that has quietly
  stopped being one. If not even one probe fits, the boot is refused outright.
- **A `FLEET_MAX_CONCURRENCY` of 2 is refused today**, despite being inside its
  own 1–2 range, because both surfaces the fleet drives are logged-out consumer
  UIs and §3.3 caps those at **1**. That ceiling is held per surface in
  `SURFACE_BUDGETS` rather than as a second copy of the rule, so the range
  widens by itself the day the fleet drives a surface that is not a UI.

### 5.3 The one number an environment variable cannot hold

`FLEET_DAILY_CAP` is in the table above for completeness, and it **cannot**
enforce §3.5 on its own: a per-container variable checked in-process gives N
containers N × the cap (§3.1). A fleet-wide cap needs shared state, and this
document does not choose the mechanism. What it can do is record what the
existing schema can and cannot answer, so the next person does not rediscover it:

| Candidate source | Why it looks sufficient | Why it is not |
|---|---|---|
| `probe_tasks`, counting rows by `engine` and `completed_at` | It already has `engine`, `attempts`, `created_at` and `completed_at`, and needs no migration | It counts **completions**. A task claimed and lost (lease lapsed, results refused by `complete_probe_tasks`) made a real request and has no `completed_at`. `attempts` is cumulative over the task's whole life, so it cannot be bucketed by day either. Both errors run in the direction that under-counts, i.e. that lets the cap be exceeded. |
| `scan_runs`, summing `probes_attempted` | It has `probes_attempted`, `runner`, `phase` and `started_at`, and a fleet pass writes exactly one row | It has **no engine column**. The engines are in `detail->'engines'` jsonb, and a claim filtered by engine can span batches, so `batchSubject` in `worker/src/lib/runLedger.js` already returns nulls for a spanning batch. Per-surface attribution is not derivable from it. |

So a fleet-wide daily cap requires either a new column, a counter table, or the
check moving inside `claim_probe_tasks`. **That is a migration and a decision,
and neither exists.** Until one does, §3.5 is specified and unenforceable, and
§8 says so.

`FLEET_DAILY_CAP` therefore ships **settable and unenforced**, and the boot log
types that rather than leaving a number to be read as a limit: `describeConfig`
prints `dailyCap=400 (cap NOT ENFORCED: it is fleet-wide and no shared counter
exists)`, and `resolveConfig` returns `dailyCapEnforced: false` on every surface
so no caller can mistake the field for a guarantee. It is settable so the
intended number is recorded and visible, never so a log line can imply a limit
that is not there.

### 5.4 What is still hard-coded — the scoring path

**The fleet reads §3.2 from config. `src/` does not, and this section says so
rather than letting §5's new tense imply otherwise.**

The second accept clause names *the fleet*, and the fleet is `worker/`. The
scoring pipeline is a separate probe path with a separate owner, and its
concurrency constants are exactly where §2.1 and §6 V3 found them:

| Constant | Value | Where |
|---|---|---|
| `AIO_CONCURRENCY` | 6 | `src/shared/scoring/aioConstants.js`, line 9 |
| `CHATGPT_CONCURRENCY` | 4 | `src/shared/scoring/enginePipeline.js`, line 18 |
| `PERPLEXITY_CONCURRENCY` | 4 | `src/shared/scoring/enginePipeline.js`, line 19 |

Line numbers appear here against this document's own no-line-citations policy
because a remaining gap must be findable by someone who is not looking for it.
`enginePipeline.js` is under concurrent edit (see the working-tree disclosure in
the header), so those two are the working tree's at the time of writing and the
symbols are what to trust: re-derive with
`git grep -n "_CONCURRENCY" -- src/shared/scoring/`. All three still
fail every one of §5.1's four tests: none is readable from the environment, none
is validated, none is printed at start-up, and two are module-private. The
per-surface delay and cap have **no** representation in `src/` at all.

Two of the three are the `aio` and API rows of §3.2, which §3.3 exempts from the
1–2 rule anyway; the third pair drives `api.openai.com` and `api.perplexity.ai`
at 4, which is **above** §3.2's 2 for those rows. **That is a live violation of
§3.3, not a documentation gap**, and it is V3's, unowned and unfixed. Nothing in
this commit changed it, and no claim anywhere in this document should be read as
saying all of this repository's concurrency now comes from config. It does not —
only the fleet's does.

---

## 6. Where the code violates this budget today

Each row is a gap between §3 and the tree at `9e85cfe`. None is fixed by this
document. Where a ledger task owns it, the task is named; where none does, that
is said plainly.

| # | Violation | Where | Owning task |
|---|---|---|---|
| V1 | No inter-probe delay exists on any path. `runProbingPhase` runs `Promise.all` windows back to back; the fleet loop sleeps only when it claimed nothing. | `src/server/workers/scanWorker.js` (`runProbingPhase`); `worker/src/index.js` (`start`) | **none — needs one** |
| V2 | No jitter exists anywhere. All three retry backoffs are deterministic, and N concurrent probes therefore retry in lockstep after a shared 429 (§2.3). | `brightdata.js`, `openai.js`, `perplexity.js` | **none — needs one** |
| V3 | **Narrowed, not closed.** The **fleet** now reads its concurrency, delays and cap from `CONFIG_FIELDS` + `SURFACE_BUDGETS` in `worker/src/config.js`, validated at boot and printed at start-up, so it passes all four of §5.1's tests. The **scoring path** is untouched: three hard-coded constants, two module-private, none overridable, none validated, none logged — and its 4 for the two API rows is itself above §3.2's 2. See §5.4. | `AIO_CONCURRENCY` in `src/shared/scoring/aioConstants.js`; `CHATGPT_CONCURRENCY` / `PERPLEXITY_CONCURRENCY` in `src/shared/scoring/enginePipeline.js` | **none — needs one** (the fleet half shipped under R1.1.5) |
| V4 | No daily cap of any kind is **enforced** on outbound probes, and no schema could hold a fleet-wide one per surface (§5.3). `FLEET_DAILY_CAP` now carries the intended number and the boot log prints it as `cap NOT ENFORCED`, which makes the gap visible; it does not close it. | absence; `supabase/migrations/010_probe_tasks.sql`, `011_scan_runs.sql` | **none — needs one** |
| V5 | No canary, and no definition of "quiet" for the gate that depends on one. R1.7.2 gates a production cutover on a condition nothing computes. | absence (§2.6) | R1.3.4, R1.4.3 (build one); the **definition** is unowned |
| V6 | **Pacing creates this one; the boot check is the remedy taken.** `renewBatch` is still exported and still never called (§2.7), so a batch's lease is still fixed at claim time. What changed is that the batch can no longer be larger than one lease pays for: §5.2's arithmetic runs at boot, refuses a `FLEET_BATCH_SIZE` the operator set that cannot fit, and narrows the **default** 5 to 2 with an announced `NOTE:`. The underlying defect — no lease renewal — is untouched, and becomes load-bearing again the moment a probe runs longer than its timeout. | `worker/src/lib/queue.js` (`renewBatch`, uncalled); `worker/src/index.js` (import list); the boot check in `resolveConfig`, `worker/src/config.js` | **none — needs one** for the renewal |
| V7 | Retries are in-process loops underneath a single queued attempt, so `probe_tasks.max_attempts` (3) bounds up to nine real requests per query once an adapter exists (§3.6). | `MAX_RETRIES` in `openai.js` and `perplexity.js`; `options.attempts` in `brightdata.js`; `claim_probe_tasks` in migration 010 | **none — needs one** |
| V8 | **Partly closed.** §5.2's six budget variables are now in `.env.example`, under a *Probe fleet* block, and a guard test in `src/server/fleetConfig.test.mjs` fails if one is read at boot and absent there. The other six `FLEET_*` variables (engines, batch, lease, idle poll, heartbeat, worker id) are still absent from it. | `.env.example` | the remainder is still R1.1.3's |

**V6 is the one to read twice.** Every other row is a thing the tree does not do.
V6 is a latent defect that this contract's own §3.4 would *activate*: today
`probeBatch` throws immediately, so no batch is long enough to outlive its lease.
The first correct implementation of pacing is the commit that makes V6 bite. It
must land with the lease renewal, or with a `FLEET_BATCH_SIZE` of 1 for paced
surfaces, or with §5.2's boot-time arithmetic check — this document does not
choose which, but it does forbid shipping the delays without one of them.

**The third was taken.** The delay numbers reached `worker/src/config.js` in the
same change as the boot-time check, so no configuration that would outlive its
lease can start. The other two remain open and are still the better fixes:
lease renewal buys back the throughput the check spends.

---

## 7. What would change this document

- **R1.1.2 lands.** A measured India-egress block rate for a browser option is
  the first real evidence about any of §3.2's UI numbers. Every one of them should
  be re-derived against it, and this section replaced with the ADR's link.
- **A canary runs for a week.** §4.4's 90% / 48h definition is a guess until a
  surface's actual answered-rate distribution is known. The first seven days of
  canary data replaces it.
- **A surface starts refusing us.** A measured 429, block or login-wall rate is
  the evidence §3.3 and §3.5 were chosen in the absence of. A cap that is never
  approached is too high to be doing anything; a cap that binds daily is too low.
- **The fleet-wide cap mechanism is decided** (§5.3). §3.5 becomes enforceable
  and this document should name the migration.
- **`AIO_CONCURRENCY` is challenged by vendor data.** §3.3's exemption for
  Bright Data rests on the vendor brokering the relationship. A quota-rejection
  rate that says otherwise reverses it.
- **A surface adds a paid tier with a published rate limit.** Every number here
  is chosen precisely because no published limit is recorded in this repository
  (§8). A published one supersedes a chosen one immediately.

## 8. What is unproven

Stated plainly, because the value of a budget nobody has tested is entirely in
what it refuses to claim.

- **Every number in §3.2 was chosen, not measured.** No block rate, no
  rate-limit threshold, no login-wall frequency and no probe duration for any UI
  surface has been observed by this repository. R1.1.2 exists to measure the
  first of those and is `blocked` on operator-supplied credentials.
- **No vendor rate limit is documented anywhere in this repo.** `git grep -i`
  for rate-limit language across `docs/vendors/` returns retry *behaviour* —
  "2, on 429 and 5xx, exponential backoff" in `chatgpt.md` and `perplexity.md`,
  and Bright Data's quota error shapes in `brightdata.md` — and **no published
  requests-per-minute figure for any surface**. §3.2's API rows are therefore
  bounded by nothing but judgement.
- **Nothing enforces any rule in §3 at probe time.** There is still no
  concurrency limiter, no delay, no jitter, no cap, no cooldown and no canary in
  the tree (§2). The fleet now *resolves, validates and logs* the numbers
  (§5.2), which is a different thing and is labelled as such in every place it
  appears: `budgetsEnforced` is `false`, the boot log says `VALIDATED, NOT
  APPLIED`, and the daily cap prints as `NOT ENFORCED`. The single rule that
  does bind is the boot-time lease arithmetic. §6 is still the distance.
- **§2.3's thundering-herd claim is derived, not observed.** It follows from
  three deterministic backoff expressions and a concurrency of 4 or 6. It has not
  been reproduced against a live 429, and no test in the tree asserts it.
- **§3.2's rate arithmetic assumes a probe duration nobody has measured.** The
  ~30 s and ~55 s figures are assumptions carried through to show the caps and
  delays are mutually consistent; they are not measurements, and a UI probe that
  takes 90 s makes the caps unreachable rather than binding.
- **`FLEET_PROBE_TIMEOUT_MS`'s 60,000 is chosen and was invented by the
  implementation, not recovered from anywhere.** No probe has ever run, so no
  probe has ever timed out. It exists because §5.2's boot check needs the term,
  and it is a field rather than a constant so that the number is at least
  visible and settable while it is unjustified.
- **§4.4's definition of "quiet" is invented by this document.** Nothing
  previously defined it, and R1.7.2 gates a production cutover on it. The 90%
  figure is borrowed from R1.4.3's soak bar for consistency, not derived.
- **No probe has ever been paced, and no probe has ever been skipped for a
  budget.** §3.7's three `state_reason` values have never been emitted; nothing
  validates them; `probe-result.md` §9 already records that no adapter has ever
  emitted a v2 result at all.
- **Nothing in this repository deploys `worker/`.** As
  `engine-surface-matrix.md` §8 and the R1.1.3 ADR both record, there is no
  Dockerfile, Procfile, fly/render config or workflow that starts
  `worker/src/index.js`. A budget for a fleet that has no host is a budget for a
  process that has never run.
- **Nothing in the ledger consumes this contract.** Zero tasks declare
  `"R1.1.5"` in their `deps` (see the header). R1.1.1's equivalent claim was at
  least a *declared* dependency that had not been exercised; this one is not even
  declared. Until R1.3.4, R1.4.3 and R1.7.2 link to it, every number in §3 is a
  document nobody is obliged to read.
- **The approve-to-publish-to-lift loop has never run end to end.** Not once, not
  in staging, not with a stub at either end.
