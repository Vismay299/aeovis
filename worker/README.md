# Probe fleet (`worker/`)

> <!-- doc-status -->
> **Status: LIVE.** The workspace and its loop exist (R1.2.1). The queue,
> ledger and adapters do not yet — see *What is not built* below. Nothing here
> probes anything today, and the stubs refuse rather than pretend.

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
| `probe_tasks` queue + lease claiming | R1.2.2 | `claimBatch` throws |
| `scan_runs` ledger + heartbeats | R1.2.3 | not wired |
| Perplexity adapter | R1.3 | `probeBatch` throws |
| ChatGPT adapter | R1.4 | — |
| Evidence screenshots | R1.5 | — |

Each stub **throws** rather than returning an empty result. An empty batch and
an unbuilt queue would otherwise look identical, and a fleet reporting "nothing
to do" while its queue fills up is exactly the false success this rebuild
exists to remove. Standing rule 1: a skip is not a success.

## Typed outcomes

`PROBE_OUTCOMES` in `src/lib/probe.js` is the closed vocabulary every adapter
reports into:

`answered` · `no_answer` · `blocked` · `captcha` · `login_wall` · `timeout` ·
`parse_error` · `skipped`

The distinction that matters is **`blocked` is not `no_answer`**. A bot check
we tripped is not evidence the brand was absent, and scoring it as a
non-mention would manufacture exactly the confident zero this rebuild is here
to stop (decision D2).
