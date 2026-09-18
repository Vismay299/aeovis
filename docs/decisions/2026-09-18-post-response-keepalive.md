# ADR — post-response scan work is kept alive by the platform, through one helper

> <!-- doc-status -->
> **Status: LIVE.** Supersedes nothing; the first decision written down about
> what keeps a scan running after its own HTTP response. Closes the question
> [`2026-09-05-worker-host.md` §2.9](./2026-09-05-worker-host.md) raised and
> explicitly left unowned, and corrects that document's §2.9 and its
> "What this ADR does NOT decide" list.

**Date:** 2026-09-18
**Task:** R3.1.5 (`needs-vercel`), filed by the R1.1.3 scribe while writing the
worker-host ADR. Root cause of R3.1.1 and R3.3.2, which each treat a symptom.
**Status:** accepted; the code shipped in `53995fa`, this record in the commit
that closes R3.1.5.
**Scope:** the Vercel-hosted API pipeline only — `src/app/api/**` and
`src/lib/workers/scanWorker.js`. It does **not** touch `worker/`, the probe
fleet, whose host is decided by [the worker-host ADR](./2026-09-05-worker-host.md).
**Citation baseline:** every `file:line` below was read in the working tree at
`f733716`. Two files were dirty in the tree at the time of writing
(`src/lib/workers/scanWorker.js`, `src/lib/db.js`, under another task's
sabotage) and were therefore read with `git show HEAD:<path>`; their line
numbers are the committed ones. To find out whether the numbers have gone stale:

```bash
git log --oneline f733716..HEAD -- src/lib/keepAlive.js src/app/api/scan src/app/api/content src/lib/workers/scanWorker.js src/lib/db.js package.json vercel.json
```

---

## Context

`POST /api/scan` created a job, answered **201**, and then fired the first chunk
as a bare fire-and-forget promise. Eight other sites did the same thing. On
Vercel the instance may be frozen or recycled the moment the response is
flushed, so every one of those promises was a scan that could stop mid-run with
no error, no status change and no log line.

Nothing in the repository asked the platform to wait. At `95b190d`,
`git grep -n waitUntil -- src/ package.json` returned nothing and
`@vercel/functions` was not a dependency. `docs/plans/production-plan.md` §C1
had prescribed the fix and it was never applied.

What kept the system upright instead was three independent compensations — the
heartbeat staleness inference, a rescue driven by the browser's status poll, and
a **daily** cron. That combination makes an open browser tab part of the
execution guarantee and puts the worst case at up to 24 hours. It is not a
failure mode an operator can see: a scan that silently stopped and a scan that
is merely slow look identical from the outside.

## Decision

**Take the platform mechanism.** Register post-response work with the request
context so Vercel keeps the function alive until the work settles, instead of
moving this pipeline to a process that owns its own lifetime.

Concretely:

1. **`waitUntil` from `@vercel/functions`**, a dependency at `package.json:52`
   (`^3.9.7`). Next is pinned at **14.2** (`package.json:58`, `"next": "14.2.35"`),
   which has no `unstable_after` / `after`; `@vercel/functions` is the mechanism
   that exists at this version. If the app moves to Next 15+, see *Reversal
   conditions*.

2. **Exactly one helper: `src/lib/keepAlive.js`.** No route imports `waitUntil`
   directly. `keepAlive(work, { label, maxMs })` (`src/lib/keepAlive.js:36`):
   - resolves `work` (promise or thunk) inside a `try`, so a synchronous throw
     in the thunk becomes a handled rejection rather than a 500 on the response
     path (`:41-45`);
   - **attaches the rejection handler first, under `label`, before the cap**
     (`:47-52`). Order matters: if the cap wrapped an unhandled promise, a
     rejection arriving after the cap released would be an unhandled rejection
     with no name on it;
   - implements `maxMs` as a real `Promise.race` against a timer, with
     `clearTimeout` in a `.finally` so the cap never leaks a handle
     (`:55-63`). The cap releases the *platform hold*; it does not cancel the
     work, and the helper's docstring says so (`:28-31`);
   - `try/catch`es the registration itself (`:65-71`), so a platform helper that
     throws cannot take the response down with it.

3. **Applied at all post-response sites**, and only those (nine when this was
   written; ten as recounted under R3.1.14, which added the tenth caller and
   found `src/lib/selfContinue.js` — R3.1.10's helper, landed the same day as
   this record — missing from the list):
   `src/app/api/scan/route.js:142` · `src/app/api/scan/[job_id]/status/route.js:640`
   · `src/app/api/scan/worker/_lib/sweepExecution.js:69` ·
   `src/app/api/content/worker/route.js:161` (was `:71`; the call still wraps
   `startContentJob`, but since **R3.1.14** its only caller is the `?job_id=`
   direct-resume branch — the cron sweep and the daily batch no longer run a job in
   their own invocation, they fire one request per job through
   `src/lib/selfContinue.js:169`, which registers that fetch with `keepAlive`
   under the same 5 s cap as §4 — the same helper contentWorker's hand-off has
   used since R3.1.10) · `src/app/api/content/route.js:110` ·
   `src/app/api/content-items/[id]/decision/route.js:119` (learn) and `:138`
   (revise) · `src/lib/workers/scanWorker.js:3203` (scheduler `kickChunk`) and
   `:1227` (self-continue). The one remaining bare `.catch` in
   that scope — the in-chunk heartbeat at `src/lib/workers/scanWorker.js:574`,
   inside `startChunkHeartbeat` (`:568`) — is deliberately **not** wrapped: it
   runs inside a chunk the platform is already holding and its interval handle is
   `unref`'d on purpose (`:582`, *"Never hold a serverless invocation open for a
   heartbeat"*), so it is not post-response work.

4. **The self-continue hold is capped** at `SELF_CONTINUE_HOLD_MS = 5000`
   (`src/lib/workers/scanWorker.js:1173`, passed at `:1230`). The self-continue
   is a `fetch` to the next chunk; waiting for its *response* would hold the
   current invocation open for the whole of the next chunk and bill it twice.
   Five seconds is enough to get the request out on the wire, which is the only
   part that needs the instance alive.

5. **Off Vercel it is a genuine no-op.** The vendor's implementation is
   `getContext().waitUntil?.(promise)`
   (`node_modules/@vercel/functions/wait-until.js`) — optional-chained, so with
   no request context nothing is registered and the promise simply runs, exactly
   as before. `keepAlive`'s own `try/catch` (`:65-71`) is a second layer, for
   the case where the vendor throws rather than returning undefined. Local dev
   and the test suite are unchanged by design.

### Why NOT the worker option

[The worker-host ADR](./2026-09-05-worker-host.md) decided that the **probe
fleet** runs on a long-lived container (Zeabur, §5), and its §2.9 used this very
gap as an argument for moving work off functions. That conclusion is correct for
its own workload and is not adopted here: the fleet exists because a real-surface
probe needs a persistent browser and minutes of wall clock, while a scan chunk is
API calls that already fit inside `maxDuration = 300` and already checkpoint
between chunks (`CHUNK_TIME_BUDGET_MS`, `reason: "checkpointed"`). Moving the
API pipeline to the fleet would mean duplicating the whole chunk/checkpoint/lease
stack across the `src/` ↔ `worker/` isolation boundary that
`src/lib/workerIsolation.test.mjs` enforces, to solve a problem one import and
nine call sites solve. This ADR is scoped to the pipeline; the fleet decision
stands unchanged.

## What this decision does NOT do

**It does not remove the three compensations, and they must not be removed.**
They are now the backstop rather than the only guarantee, which is the whole
point:

- **Heartbeat staleness** — `HEARTBEAT_STALE_MS = 3 * 60 * 1000`
  (`src/lib/db.js:804`), consumed as `decideRescue`'s `staleAfterMs` default
  (`src/app/api/scan/[job_id]/status/route.js:457`).
- **The poll-driven rescue** — `src/app/api/scan/[job_id]/status/route.js:638-640`:
  `decideRescue(...)` and, when it says rescue, `keepAlive(() => runScanChunk(job.id), …)`.
  Note the rescue itself now goes through the helper.
- **The daily crons** — `vercel.json:3-6`, `/api/scan/worker` on `0 0 * * *`,
  plus `/api/content/worker` at `:7-10`.

None of these was touched by R3.1.5. R3.1.1's request to move the scan cron to a
10-minute schedule is still an open operator action and is still worth doing;
this ADR only demotes it from "the thing that saves the scan" to "the thing that
catches what the platform dropped".

## What is NOT verified

- **That Vercel actually holds the instance longer is not proven here.** Every
  claim above about the *code* is tested. The claim about the *platform* is not
  and cannot be from inside this repository: a unit test can prove `keepAlive`
  called its injected `waitUntil`, never that a real deployment deferred a
  freeze. R3.1.5 is tagged `needs-vercel` for exactly this. The check that would
  settle it is `production-plan.md` §C1.7 — deploy, `POST /api/scan`, close the
  tab immediately, and read the function logs for chunk progress after the
  response, three times. **It has not been run.** Do not read R3.1.6's
  production scan as a substitute; it was polled.
- **Two `keepAlive` call sites are on routes with no `maxDuration`.** A
  `waitUntil` hold is bounded by the invocation's limit, and only
  `/api/scan`, `/api/scan/worker`, `/api/content`, `/api/content/worker`,
  `/api/evidence/retention` and `/api/gsc/worker` declare
  `export const maxDuration = 300` — `/api/content` joined that list under
  R3.1.10, the same day this record was written, which is why it counts two
  where an earlier draft counted three. `/api/scan/[job_id]/status` and
  `/api/content-items/[id]/decision` still inherit the platform default, so the
  work they register is held for that default and no longer. This is
  `production-plan.md` §C1.6 left part-done; it is not claimed by R3.1.5 and
  has no task yet.
- **The guard has a known blind spot.** `src/lib/keepAlive.test.mjs:69` git-greps
  a fixed allowlist of function names
  (`runScanChunk|scanChunk|startContentJob|reviseContentItem|runLearn|kickChunk|start`)
  scoped to `src/app` plus `src/lib/workers/scanWorker.js`. A new fire-and-forget
  under a new name, or anywhere in `src/lib/content/`, passes it. It catches
  regressions of the exact shapes this task replaced; it does not catch the next
  shape. Worth widening in a later task.

## Reversal conditions

1. **The app moves to Next 15+.** `after()` becomes available in-framework and
   the `@vercel/functions` dependency can be dropped. Because there is exactly
   one helper, that is a one-file change — which is most of why the helper
   exists.
2. **The deploy leaves Vercel.** `waitUntil` no-ops off-platform by
   construction, so the pipeline would silently return to bare fire-and-forget
   with the three compensations as its only guarantee. Then the worker option
   this ADR declined becomes the answer and this document should be superseded,
   not edited.
3. **§C1.7 is run and fails** — a deployed scan is observed freezing after the
   response with `keepAlive` in place. Then the premise is wrong, and the
   compensations were load-bearing all along.
4. **A chunk stops fitting in `maxDuration`.** If chunk work grows past the
   invocation limit, no keepalive helps and the workload has to move.

## Evidence

- `src/lib/keepAlive.js` — the helper: `:22` (the import), `:36` (signature),
  `:41-45` (thunk throw), `:47-52` (rejection handled before the cap),
  `:55-63` (`Promise.race` + `clearTimeout`), `:65-71` (registration guarded).
- `src/lib/keepAlive.test.mjs` — 7 tests including `:69`, the GUARD that fails if
  any route or the scan worker kicks background work with a bare `.catch`. Its
  teeth were checked by reverting `src/app/api/content/route.js:110` to
  `startContentJob(job.id).catch(...)` (guard failed) and by disabling the
  `maxMs` branch (`not ok 4`), both restored green.
- `package.json:52` — `"@vercel/functions": "^3.9.7"`; `:58` — `"next": "14.2.35"`.
- `node_modules/@vercel/functions/wait-until.js` — `getContext().waitUntil?.(promise)`.
- Call sites as enumerated in *Decision* §3, each verified at `f733716`.
- Compensations as enumerated in *What this decision does NOT do*.
