# ADR — the in-memory scan-job store is never reachable from a response

> <!-- doc-status -->
> **Status: LIVE.** Supersedes nothing; the first decision written down about
> the `global.memoryJobs` fallback.

**Date:** 2026-09-05
**Task:** R0.1.21 (`needs-decision`), which the R2.8.6 implementer identified as
the actual mechanism behind R0.1.4.
**Status:** accepted, shipped in the same commit as the code and the test.
**Scope:** `POST /api/scan` only. `src/lib/db.js` is deliberately unchanged — see
*What this decision does NOT do*.

---

## Context

`createScanJob` in `src/lib/db.js` fail-softs: with no Supabase client it writes
the job into `global.memoryJobs` and returns it, indistinguishable in shape from
a persisted row. `src/app/api/scan/route.js` then answered **201 Created** off
that object and fired `runScanChunk(job.id)`.

On a deployment with no credentials — or one whose credentials stopped loading —
that is three failures at once:

1. An anonymous stranger receives 201 and a job id for a scan that was never
   persisted. Nothing can read it back: `global.memoryJobs` is per-process, so
   the status poll, the cron worker and every other serverless instance see
   nothing. The caller polls a job that does not exist.
2. `runScanChunk` proceeds to spend real Bright Data + Perplexity + LLM budget
   on results with nowhere to land. This is an unauthenticated spend path.
3. It is silent. A totally unconfigured deployment answered exactly like a
   healthy one — standing rule 1's "an empty state is not a clean one", on the
   route where it costs money.

R0.1.4's negative control hit precisely this: 201, an in-memory scan started,
and nothing billed only because no vendor credentials had loaded either. Its own
author called that luck rather than design.

## What the memory store is legitimately for

It is not simply a bug, which is why this needed a decision rather than a
deletion. `global.memoryJobs` is load-bearing for:

- **the test suite** — `npm run test:scoring` runs with the Supabase vars unset,
  and dozens of suites drive `createScanJob` / `getScanJob` / `updateScanJob`
  against the map directly. Removing it would break the tree.
- **local development against `src/lib/db.js` directly**, where a scratch job
  never has to outlive the process it was created in.

Both of those are *in-process* uses. Neither one requires the map to be visible
to an HTTP caller. That is the distinction this ADR draws: the memory store is a
legitimate **library** fallback and an illegitimate **response**.

## Decision

`POST /api/scan` refuses when `db.js` built no client. Concretely, in
`src/app/api/scan/route.js`:

- It imports the module-level `supabase` export and checks `!supabase`
  immediately before `createScanJob`. That is the exact condition
  `createScanJob`'s fallback tests (`resolveClient` with no injected deps), so
  the route and the library cannot disagree about whether a write will persist.
- The refusal is **503** with `{ detail, code: "scan_store_unavailable" }`. Not a
  4xx: nothing about the request is wrong, the deployment is. Not a
  201-with-a-warning: a caller cannot poll a job that does not exist, so a
  degraded success is only a slower failure. No `Retry-After` — a missing
  credential does not heal on a timer, and a guessed number would be a lie.
- It fires **before** `createScanJob` and therefore before `runScanChunk`. No
  job is created, no vendor call is made.
- The operator-facing detail goes to `console.error`, naming
  `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` as the vars to
  check — names only, never values. The wire body names no vendor and no
  infrastructure (R6.4.3): "supabase" in an anonymous 503 is free
  reconnaissance.
- A second, currently-unreachable check after `createScanJob` refuses the same
  way if the returned job turns up in `global.memoryJobs` anyway. It exists so
  that a future divergence in `db.js`'s fallback condition surfaces as a loud
  503 rather than quietly restoring the 201 this task removed.

Ordering is deliberate: **validation (400) and the rate limit (429) still run
first.** Both are free, neither touches the database, and a malformed body is
still a malformed body on a broken deployment. The line that must not be crossed
without a database is job creation, so the guard sits exactly there.

## Consequences

- **`npm run dev` with no Supabase configured can no longer start a scan through
  the HTTP route.** It returns 503 with the missing variable names in the log.
  This is accepted: it is the price of the memory store being dev-only *by
  assertion* instead of dev-only *by accident*, and the log line tells a
  developer exactly what to set. Note that this path was already half-dead —
  `/api/scan/worker` has returned `mode: "no-db"` and dispatched nothing without
  a client for some time, so a no-Supabase scan could never be resumed or swept
  anyway.
- The test suite is unaffected: it calls `db.js` directly and never through this
  route. The two existing route suites (`scanRoute.route.test.mjs`,
  `scanRateLimitSpoof.route.test.mjs`) both return 400/429 before reaching the
  guard, which the new suite's two control tests pin in place.
- A client that exists but whose credentials have been revoked is a different
  path and already correct: `createScanJob` throws on the insert error and the
  handler's catch answers 500. This ADR does not change it.

## What this decision does NOT do

- It does not touch `src/lib/db.js`. The memory fallback still exists and still
  behaves identically for in-process callers; only the HTTP route refuses to
  build a response on top of it. `db.js` was owned by another task in the same
  round, and a route-side refusal is sufficient for the criterion.
- It does not add an environment escape hatch (`ALLOW_IN_MEMORY_SCANS` or
  similar). An opt-in that production could set is the same bug with an extra
  step, and the file set for this task did not include `.env.example`, so the
  variable could not have been documented where an operator would find it.
- It does not gate on `NODE_ENV`. "Refuse unless we think we are in production"
  fails open on every environment that forgets to set it; "refuse whenever there
  is no store" cannot.

## Reversal conditions

Revisit this if any of these becomes true:

1. **Developing without Supabase becomes a real, recurring need.** The
   replacement is not this ADR undone but an explicit opt-in that production
   cannot satisfy — an env var documented in `.env.example`, asserted false when
   `NODE_ENV === "production"`, and surfaced in the 201 response body so an
   in-memory job is never mistaken for a persisted one.
2. **`db.js` gains a durable non-Supabase store.** Then the guard's premise
   ("no Supabase client means nothing persists") is wrong and the check must
   move behind whatever capability flag the new store exposes.
3. **The 503 starts firing in production.** That is not a reason to soften the
   guard; it is the alarm working. It means the deployment lost its credentials,
   and the fix is the credentials.

## Evidence

- `src/app/api/scan/route.js` — the guard, the 503 helper, and the ordering
  comment that explains why 400 and 429 still come first.
- `src/lib/scanRoute.unpersisted.route.test.mjs` — drives the real `POST`
  handler with the Supabase vars unset and fails if it returns 201. Its teeth
  were checked by disabling both guards and observing the failure message *"the
  route issued 201 Created for a scan job that was never persisted"*, then
  restoring them.
- `src/lib/db.js` (`createScanJob`, `resolveClient`) — read, not modified; the
  source of the `!client` condition the route mirrors.
