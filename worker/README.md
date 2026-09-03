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

```bash
npm --prefix worker install
npm --prefix worker run check     # parses, then starts and completes one pass
npm --prefix worker start         # the real loop; needs SUPABASE_URL + a key
```

`npm run check` runs `--selftest`, which boots the real config path and drives
one pass against stubs. It needs **no** database, no browser and no credential:
its job is to prove the workspace starts standalone, which is R1.2.1's
acceptance criterion.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `SUPABASE_URL` | — | **Required to start.** The queue to read. |
| `SUPABASE_SERVICE_ROLE_KEY` | — | **Required to start.** |
| `FLEET_ENGINES` | `perplexity` | Which surfaces this container drives. |
| `FLEET_BATCH_SIZE` | `5` | Tasks claimed per poll. |
| `FLEET_LEASE_MS` | `300000` | How long a claim is held before it can be reaped. |
| `FLEET_IDLE_POLL_MS` | `10000` | Gap between polls when the queue was empty. |
| `FLEET_WORKER_ID` | `worker-<pid>` | Identity on every claim and heartbeat. |

Starting without Supabase is fatal on purpose. A worker with no queue to read
would poll nothing forever and report itself perfectly healthy.

## What is not built

| Stage | Lands in | Today |
|---|---|---|
| `probe_tasks` queue + lease claiming | R1.2.2 | **built** — see *The claim* below |
| `scan_runs` ledger + heartbeats | R1.2.3 | not wired |
| Perplexity adapter | R1.3 | `probeBatch` throws |
| ChatGPT adapter | R1.4 | — |
| Evidence screenshots | R1.5 | — |

`probeBatch` **throws** rather than returning an empty result. A fleet
reporting "nothing to do" while its queue fills up is exactly the false success
this rebuild exists to remove. Standing rule 1: a skip is not a success.
`claimBatch` throws for the same reason when the queue is unreachable — an
unreachable queue and an empty one must not produce the same signal.

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
