# Probe fleet (`worker/`)

> <!-- doc-status -->
> **Status: LIVE.** The workspace, its loop and its queue claim exist (R1.2.1,
> R1.2.2). The ledger and the adapters do not yet — see *What is not built*
> below. **Nothing here probes anything today**: `probeBatch` refuses rather
> than pretend.

A long-lived Node process that drives **real consumer surfaces** —
perplexity.ai and chatgpt.com as a logged-out human sees them — and reports
typed outcomes.

## Why it is a separate workspace

The probes need a persistent browser and minutes of wall clock. A Vercel
function has neither: it is request-scoped, and Playwright's browsers do not
belong in a deploy bundle. So the fleet runs on a container host and this
workspace has its own `package.json`, its own dependencies, and no knowledge of
Next.

**Nothing under `worker/` may import from the web app.** Not `src/app`, not
`next/*`, and not by climbing out with `../../src`. The container image does
not ship `src/`, and an import that escapes this directory fails at runtime on
the host, after a deploy — the worst place to find out.

Shared logic is **copied**, not imported. That duplication is the deliberate
price of the fleet being independently deployable. `src/lib/workerIsolation.test.mjs`
runs in the main CI suite and fails the build if a crossing import appears.

## Running it

For a complete step-by-step operator guide to starting dev Supabase, seeding tasks, running the loop on a laptop, and observing ledger state, see the **[Dev runbook for the fleet](../docs/runbooks/fleet-dev.md)** (R1.2.5).

```bash
npm --prefix worker install
npm --prefix worker run check     # parses, then starts and completes one pass
npm --prefix worker start         # the real loop; needs SUPABASE_URL + a key
```

Or from the repository root:
```bash
npm run fleet:check               # pre-flight selftest
npm run fleet:dev                 # runs against dev Supabase (.env.fleet.local)
```

`npm run check` runs `--selftest`, which boots the real config path and drives
one pass against stubs. It needs **no** database, no browser and no credential:
its job is to prove the workspace starts standalone, which is R1.2.1's
acceptance criterion.

## Configuration

| Variable | Required | Default | Range | Meaning |
|---|---|---|---|---|
| `SUPABASE_URL` | **yes** | — | http(s) URL | The queue to read. `NEXT_PUBLIC_SUPABASE_URL` also accepted. |
| `SUPABASE_SERVICE_ROLE_KEY` | **yes** | — | — | Credentials for it. `NEXT_PUBLIC_SUPABASE_ANON_KEY` also accepted. |
| `FLEET_ALLOW_PRODUCTION_DB` | no | `false` | `true`, `false` | Explicit arming flag required to run the fleet against the production database (R1.2.12). `FLEET_ARM_PRODUCTION_DB` also accepted. |
| `FLEET_ENGINES` | no | `perplexity` | `perplexity`, `chatgpt` | Which surfaces this container drives. |
| `FLEET_BATCH_SIZE` | no | `5`, narrowed to what one lease can pay for | 1–50 | Tasks claimed per poll. See *the lease arithmetic* below: on the shipped defaults it runs at **2**, announced at boot. |
| `FLEET_LEASE_MS` | no | `300000` | 30000–3600000 | How long a claim is held before it can be reaped. |
| `FLEET_IDLE_POLL_MS` | no | `10000` | 1000–300000 | Gap between polls when the queue was empty. |
| `FLEET_HEARTBEAT_MS` | no | `30000` | 5000–600000, and ≤ half `FLEET_LEASE_MS` | How often an in-flight run says it is alive. |
| `FLEET_WORKER_ID` | no | `worker-<pid>` | non-blank | Identity on every claim and heartbeat. |
| `FLEET_MAX_CONCURRENCY` | no | per surface (**1** for both today) | 1–2, and never above the surface's own ceiling | In-flight probes of one surface, per egress IP. |
| `FLEET_PROBE_DELAY_MIN_MS` | no | per surface (`perplexity.ai` 20000, `chatgpt.com` 30000) | 0–600000 | Lower bound of the random inter-probe delay. |
| `FLEET_PROBE_DELAY_MAX_MS` | no | per surface (`perplexity.ai` 45000, `chatgpt.com` 90000) | 0–600000, and **strictly greater** than the minimum | Upper bound of that delay. |
| `FLEET_DAILY_CAP` | no | per surface (`perplexity.ai` 400, `chatgpt.com` 200) | 1–100000 | Probe attempts against one surface per UTC day. **Not enforced** — see below. |
| `FLEET_CANARY_INTERVAL_MS` | no | `3600000` | 300000–86400000 | Gap between canary probes of one surface. |
| `FLEET_PROBE_TIMEOUT_MS` | no | `60000` | 5000–600000 | How long one probe may run before it is abandoned. |

Starting without Supabase is fatal on purpose. A worker with no queue to read
would poll nothing forever and report itself perfectly healthy.

### The politeness budget (R1.1.5)

The last six rows are `docs/contracts/politeness-budget.md` §3.2, made settable.
The **per-surface defaults live in exactly one place** — `SURFACE_BUDGETS` in
`worker/src/config.js`, keyed by engine id — and an unset variable means "each
surface takes its own number", not zero. A variable that *is* set overrides
every surface this container drives.

**Read the boot log before believing any of it.** The numbers are resolved,
range-checked and printed; **nothing paces a probe with them yet**, because
`probeBatch` has no adapter until R1.3/R1.4. The `config:` block says
`VALIDATED, NOT APPLIED` for exactly as long as that is true.

**The daily cap is printed as `cap NOT ENFORCED`, and that is a fact about the
schema, not a TODO.** §3.5's cap is *fleet-wide*; a per-container variable
checked in-process gives N containers N × the cap, and no shared counter exists
to check instead (§5.3 walks the two candidate tables and why neither answers).
It is settable so the intended number is recorded and visible, never so a log
line can imply a limit that is not there.

**Two surface rules are refusals, not preferences.** `FLEET_MAX_CONCURRENCY=2`
is inside its own 1–2 range and is still refused while the container drives a
logged-out consumer UI: §3.3 caps those at 1, and that ceiling is held per
surface in `SURFACE_BUDGETS` rather than as a second copy of the rule. A delay
window whose maximum is not *strictly* above its minimum is refused too — equal
bounds are a fixed delay, which is perfectly periodic and therefore a signature.

**The lease arithmetic.** `FLEET_BATCH_SIZE × (delay max + FLEET_PROBE_TIMEOUT_MS)`
must not exceed `FLEET_LEASE_MS`. A batch that outlives its lease has every
result refused by `complete_probe_tasks` — the requests were made, the surface
was bothered, and the work is thrown away (contract §6, V6). The shipped
defaults do **not** satisfy it: 5 × (45s + 60s) is 525s against a 300s lease. So
a `FLEET_BATCH_SIZE` **you set** that cannot fit is a refusal naming both
variables, and the **default** 5 is narrowed to 2 with a `NOTE:` line — the same
rule the heartbeat follows. The throughput term gives way and the politeness
term never does: a delay narrowed to fit a lease is a budget that has quietly
stopped being one. If a single probe cannot fit the lease at all, the boot is
refused outright, because there is nothing left to narrow.

### The config is validated at boot, or the fleet does not boot (R1.2.6)

`resolveConfig` refuses — non-zero exit, every problem named on its own line —
when any variable is **absent and required**, **present but blank**,
**unparseable**, **out of range**, or **names an engine that does not exist**.
It reports *all* the problems at once, because a validator that stops at the
first one makes an operator with five wrong values redeploy five times.

**Optional does not mean lenient.** An *absent* optional variable takes the
default in the table above — that is the deliberate choice this file documents.
A *present* one is a value someone typed, so it is checked. The rejected
alternative was the original behaviour: fall back on a parse failure and clamp
on a range failure, which turned `FLEET_BATCH_SIZE=abc` into 5, `=9999` into 50
and `=0` into 1. Each of those ran on a number nobody chose while the boot log
read as healthy. `FLEET_ENGINES=,` was the worst of them: an empty engine list
is read by `claim_probe_tasks` as *no filter*, so a container configured for one
surface would claim every surface.

**A misspelt engine is a dead surface.** `FLEET_ENGINES=gogle` claims nothing,
forever, while every pass writes a perfectly honest `queue_empty` idle row — at
which point an idle fleet and a misconfigured one are indistinguishable in the
ledger. Boot is the last place they can still be told apart, so the engine
vocabulary is closed and checked there.

**Nothing narrows a value the operator set.** `FLEET_HEARTBEAT_MS` must still
beat at least twice per lease (R3.3.2's stale sweep depends on it), but where
the old code silently `Math.min`'d the two together, a heartbeat *you set* that
conflicts with a lease *you set* is now a refusal naming both. Only the
*default* heartbeat may be narrowed by a short lease, and that narrowing is
printed at boot as a `NOTE:` line rather than happening invisibly.

**No credential value is ever printed.** `SUPABASE_SERVICE_ROLE_KEY` is marked
`secret` in the field table, so neither a validation error nor the boot's
`config:` line can echo it — they say `set` or `MISSING`. Validation messages
are the classic place a key leaks into a container log.

`--selftest` relaxes **only** the two credentials. A malformed `FLEET_*` value
still refuses there, so `npm run check` cannot go green on a config the real
boot would reject.

### Production database protection (R1.2.12)

A laptop fleet started in a shell that carries the web app's credentials (`NEXT_PUBLIC_SUPABASE_URL` or app production values) will **refuse to boot** by default. Because `scan_runs` and `probe_tasks` are writable tables, an unguarded worker booting against production would immediately write rows into the production database.

The worker process checks if the target database matches the application's production database credentials or was inherited via fallback. If so, it requires explicit arming:
`FLEET_ALLOW_PRODUCTION_DB=true` (or `FLEET_ARM_PRODUCTION_DB=true`).
Without this explicit variable, the boot halts with a non-zero exit code and an explanatory error.

## What is not built

| Stage | Lands in | Today |
|---|---|---|
| `probe_tasks` queue + lease claiming | R1.2.2 | **built** — see *The claim* below |
| `scan_runs` ledger + heartbeats | R1.2.3 | **built** — see *The ledger* below |
| Perplexity adapter | R1.3 | `probeBatch` throws |
| ChatGPT adapter | R1.4 | — |
| Evidence screenshots | R1.5 | — |

`probeBatch` **throws** rather than returning an empty result. A fleet
reporting "nothing to do" while its queue fills up is exactly the false success
this rebuild exists to remove. Standing rule 1: a skip is not a success.
`claimBatch` throws for the same reason when the queue is unreachable — an
unreachable queue and an empty one must not produce the same signal.

## The ledger (R1.2.3)

**Every pass writes exactly one `scan_runs` row** — including the passes that
claim nothing. `runLedger.js` calls the three Postgres functions migration 011
created: `open_scan_run` before the work, `heartbeat_scan_run` on a timer while
it is in flight, `close_scan_run` after it.

| Pass | phase | outcome | reason | counters |
|---|---|---|---|---|
| claimed a batch, all written | `probe_batch` | `succeeded` | — | attempted / answered-and-landed / errors |
| claimed a batch, some writes refused | `probe_batch` | `failed` | `lease_lost` | same, refused ones excluded from succeeded |
| probe threw | `probe_batch` | `failed` | `probe_failed` | attempted, 0 succeeded |
| report threw | `probe_batch` | `failed` | `report_failed` | attempted, 0 succeeded |
| queue was empty | `idle` | `noop` | `queue_empty` | 0 / 0 / 0 |
| every task held by someone else | `idle` | `noop` | `all_leased` | 0 / 0 / 0 |

**Why the idle rows.** "The fleet is idle" and "the fleet is dead" leave exactly
the same evidence if only busy passes are recorded: no rows. The idle row's
`probes_attempted = 0` is a *measured* zero, and a measured zero is a different
row from no row at all. The volume that costs — roughly 8.6k rows a day at the
default poll interval — is stated in migration 011's *THE IDLE ROWS* note, and
retention is R3.2.3's to decide when it builds the reader.

**Why a blocked probe is not a success.** `probes_succeeded` counts only results
that both answered *and* landed in the database. A blocked or captcha'd probe
goes to `errors_recovered`; an answer whose write was refused because the lease
had lapsed counts as neither. See `summarizeBatchRun`.

**Counters are NULL when they were not measured**, never 0. The columns have no
`DEFAULT 0` for that reason: a column that cannot say "unknown" forces every
reader above it to report a confident zero.

**If the ledger cannot be written, the pass does not run.** `openRun` throws
rather than continuing unrecorded, and the batch is handed back to the queue.
A heartbeat that fails is logged instead — the consequence there is not silence
but the run going stale and being reaped, which is a state something else acts
on.

## The claim (R1.2.2)

`claimBatch` calls the Postgres function `claim_probe_tasks` (migration 010).
The race is settled by `FOR UPDATE SKIP LOCKED` **in the database**, not by two
JS processes agreeing to be careful.

It is SQL and not `src/lib/jobLease.js` because this workspace may not import
from `src/`. The alternatives were to copy the lease in here (a second copy that
drifts) or to extract a shared package (heavier than the task warrants). A
database function is one implementation with two callers and nothing to
duplicate. jobLease remains the authority for the **lease itself**: the
`lease_owner` / `lease_expires_at` columns, the free/expired predicate, the
3-minute TTL and the acquire/renew/release triple are its semantics. The one
deliberate divergence is that a queue does **not** treat "my own live lease" as
free — re-handing a worker the batch it is still probing is not idempotence.

`claimBatch` returns a **report**, not an array:

| field | meaning |
|---|---|
| `tasks` | the rows claimed |
| `claimedCount` | how many |
| `outstanding` | non-terminal tasks in scope, including the ones just claimed |
| `leasedElsewhere` | of those, how many another worker holds a live lease on |
| `reason` | `claimed` · `queue_empty` · `all_leased` |

`reason` is the point. "0 claimed because the queue is empty" and "0 claimed
because every task is leased" are different facts, and an array says neither.
Every pass logs `describeClaim(...)`, including the empty ones — a measured zero
has to look different from never having run.

The race itself is proven against a real Postgres in
`src/lib/probeTasksRace.test.mjs`, which skips **loudly** when no database is
configured.

## Typed outcomes

`PROBE_OUTCOMES` in `src/lib/probe.js` is the closed vocabulary every adapter
reports into:

`answered` · `no_answer` · `blocked` · `captcha` · `login_wall` · `timeout` ·
`parse_error` · `skipped`

The distinction that matters is **`blocked` is not `no_answer`**. A bot check
we tripped is not evidence the brand was absent, and scoring it as a
non-mention would manufacture exactly the confident zero this rebuild is here
to stop (decision D2).
