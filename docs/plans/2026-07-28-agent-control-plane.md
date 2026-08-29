# Agent Control Plane — adopting Paperclip's orchestration patterns

> <!-- doc-status -->
> **Status: HISTORICAL.** A record of work done at the time, not an authority for current decisions. It predates the 2026-08-29 honesty audit, so any claim it makes about what is finished must be checked against [docs/BUILD_JOURNAL.md](../BUILD_JOURNAL.md) and [2026-08-29-rebuild-roadmap.md](./2026-08-29-rebuild-roadmap.md).

**Date:** 2026-07-28
**Branch:** `feat/agent-control-plane`
**Trigger:** "Why can't we use Paperclip-style agent management for our AEO/GEO platform?"
**Status:** researched → planned → implemented (T1–T4). Deferred items listed in §7.

---

## 1. What was researched

Source: `github.com/paperclipai/paperclip` (default branch `master`, TypeScript monorepo:
`server/` + `ui/` + `cli/` + `packages/shared/`). Read directly via the GitHub contents API —
`docs/agents-runtime.md`, `docs/pipelines-tutorial.md`, `DESIGN.md`, `adapter-plugin.md`,
`server/src/services/{pipelines,issues,agent-start-lock}.ts`, and the full `server/src/services/`
inventory (~200 modules).

Paperclip's self-description: *"If OpenClaw is an employee, Paperclip is the company."* It is an
operational control plane for coordinating arbitrary third-party agents, not an agent itself.

### 1.1 Their agent model

| Concept | Mechanism |
|---|---|
| **Agent** | A row: role, title, budget, **adapter** (`claude_local`, `codex_local`, `cursor`, `opencode_local`, `process`, `http`, `openclaw_gateway`, …) + `cwd`, `timeoutSec`, `graceSec`, env, extra args, prompt template |
| **Execution** | **Heartbeats** — short windows, never continuous. Wakeup sources: `timer`, `assignment`, `on_demand`, `automation`. Concurrent wakeups are **coalesced**, not duplicated |
| **Continuity** | Adapter session IDs persisted; next heartbeat resumes the same session. Manual session reset for drift |
| **Work** | Issues/tasks moving through **pipelines** — declared stage lists, not code |
| **Exclusivity** | `issues.checkoutRunId` — a task is leased by the heartbeat run holding it. Acquired with `SELECT … FOR UPDATE` + a conditional `UPDATE … WHERE checkoutRunId IS NULL` (or `= expectedCheckoutRunId`). Released when the owning run goes terminal |
| **Accounting** | Per-run rows: status, token usage, cost, stderr excerpt, full logs offloaded from the run row |
| **Isolation** | Project workspaces + git worktrees per agent |
| **Skills** | First-class org assets, injected at runtime (`skills/`, `.agents/skills/`) — no retraining |

### 1.2 Their stage machine (confirmed from `services/pipelines.ts`)

```ts
type PipelineStageKind = "open" | "working" | "review" | "done" | "cancelled";

type PipelineStageConfig = {
  autonomy?: "manual" | "suggest" | "auto";
  autoAdvanceOnChildrenTerminal?: string;   // stage key to jump to when all children are terminal
  approveToStageKey?: string;               // REQUIRED on review stages (validated)
  rejectToStageKey?: string;
  requestChangesToStageKey?: string;
  reviewerKind?: "human" | "any";           // validated to exactly these two
};

type PipelineReviewDecision = "approve" | "reject" | "request_changes";
```

Plus `enforceTransitions` + an explicit `transitions` allowlist per pipeline, and lease ownership
checks (`leaseOwnerType` / `leaseAgentId` / `leaseUserId`) gating who may act on a row.

Their `docs/pipelines-tutorial.md` worked example is **release → feature → content-piece**, three
linked pipelines rolling up via `autoAdvanceOnChildrenTerminal`. That is structurally identical to
our **scan → gap → article** flow.

---

## 2. Why we cannot adopt it wholesale

Three blockers, in severity order. These are the "why can't we" answer.

**B1 — Their adapter layer assumes a machine you own.** Every non-trivial adapter spawns a local
CLI with a `cwd`, a kill timer, a git worktree, and session state on local disk. We are Next.js 14
on Vercel functions + Supabase. There is no persistent host to heartbeat, no `claude` binary, no
worktree, no process to `SIGTERM` after `graceSec`. Paperclip is a **self-hosted control plane for
your own dev machine**; we are multi-tenant SaaS. Porting the adapter layer is not a refactor, it
is a change of deployment species.

**B2 — Inverted cost model.** "Wake the agent, let it work until it exits or times out" is
unbounded by design; budget ceilings are the backstop and drift is tolerated because a human
reviews on the board. Our contract is the opposite: `CONTENT_MAX_COST_PER_ITEM` ($0.15 default) is
checked after *every* block, each step has a typed schema (`content/schemas.js`), prompt sets are
frozen, and failures are loud. Beyond cost, this is a **measurement product**: "your visibility
score moved +6" is only sellable if the pipeline that produced it is reproducible week over week.
An open-ended heartbeat agent breaks reproducibility, which is the asset.

**B3 — Multi-tenancy.** One company, one org chart, host-level secrets, local disk logs. We are
per-brand tenants and auth/tenancy is still deferred (see `docs/plans/production-plan.md`).
"The agent has a shell in a working directory" is a non-starter when the agent touches customer
data.

**Also relevant:** their in-process `withAgentStartLock` (`services/agent-start-lock.ts`) is a
`Map<agentId, promise>` — correct for one long-lived server, useless for us. On serverless every
invocation is a fresh process, so exclusivity has to live in Postgres. Their *durable* answer
(`checkoutRunId`) is the one we can use.

---

## 3. What we already have (the overlap)

Adopting "Paperclip style" is less of a leap than it sounds — the shape is already here:

| Paperclip | aeovis today |
|---|---|
| Agent = config, not process | `content_agents` table + `agents/model.js`; `agent_snapshot` frozen onto each job/item for provenance |
| Pipelines as data | `agents/blocks.js` — `BLOCKS` registry with kinds (`context`/`draft`/`transform`/`check`) + `validatePipeline()` + `resolvePipeline()` |
| Runtime skill injection | `content/skills/*.md`, per step × format, loaded by `skills/loader.js` |
| Human review gate | `awaiting_approval` is mandatory and terminal for the automated path |
| Budget ceiling | `assertUnderCostCap()` after every block |
| Live run visibility | `agents/trace.js` + `agent_trace` jsonb → the Studio "theater" |
| Durable lease (CAS) | **`claimJobStatus()` in `db.js` — but only for `scan_jobs`** |
| Heartbeat staleness | **`isJobAlive()` / `HEARTBEAT_STALE_MS` — but only for `scan_jobs`** |

The real finding: **the scan pipeline already learned these lessons (P0.0 / P0.2 / D8). The content
pipeline never got them.** Paperclip is not a new paradigm for us; it is confirmation of the
direction the scan worker already went, plus two things neither pipeline has yet (a per-run ledger
and a declarative stage machine).

---

## 4. Live defects this work fixes

**D1 — content job double-run / double-spend.** `listResumableContentJobs()`
(`src/lib/db/content.js`) re-picks any running job whose **`created_at`** is older than 5 minutes.
But `content_jobs.heartbeat_at` exists (migration 005) and is stamped on every
`updateContentJob()`, and the file's own `isContentJobFresh()` reads it. The resume path does not.
So a job that has been healthily running for 6 minutes, writing progress after every block, is
still eligible for re-pick — and `/api/content/worker` dispatches `startContentJob(job.id)`
fire-and-forget with no claim written first. Two executions then race on one job row, each spending
up to the full `$0.15` cap and each inserting a `content_items` row. The `heartbeat_at` freshness
helper that would prevent this is present but unused on the resume path.

**D2 — `/api/content/worker` is unauthenticated.** `/api/scan/worker` has a `CRON_SECRET` gate
(reviewer D4) precisely because it spends real budget. The content worker route — which resumes
jobs *and*, with `?batch=1`, creates new ones — has no gate at all. It is a public
"burn the owner's model budget" button. Same class as the audit's T0 "seal public routes".

**D3 — no `maxDuration` on the content worker route.** `/api/scan/worker` declares
`maxDuration = 300`. The content route inherits the platform default, so a resumed job can be
killed mid-block with no checkpoint.

**D4 — cost is un-attributable.** `stats.cost` accumulates in a closure and one total lands on the
job row. There is no way to answer "which block eats the $0.15", which blocks both optimisation and
tier pricing.

**D5 — transitions are imperative and duplicated.** `statusForBlock()`'s hardcoded map, the
`while (cycles < MAX_DRAFT_REVIEW_CYCLES)` loop, the YMYL `break`, and a bespoke
`reviseContentItem()` path all encode lifecycle rules in control flow. The verdict → status mapping
is re-derived by hand in `content-items/[id]/decision/route.js` with a nested ternary, and the
job-status mirror there can write a status the worker would never produce.

---

## 5. Design decisions (locked)

**L1 — Lease, not status-CAS, for the content pipeline.** `claimJobStatus()` works for scans
because sourcing/finalize are claimed by *entering* a phase. Content jobs pass through eight
statuses and must be resumable *in place*, so a status CAS would degenerate to `drafting→drafting`
(always wins, no exclusivity). Instead: a time-bounded lease pair (`lease_owner`,
`lease_expires_at`) acquired with a single conditional `UPDATE … WHERE id = $id AND (lease_owner IS
NULL OR lease_expires_at < now()) RETURNING *`. Postgres re-evaluates the qual after taking the row
lock (EvalPlanQual), so of two racing callers exactly one matches — same atomicity argument as
`claimJobStatus()`'s doc comment.

**L2 — The lease primitive is table-agnostic.** It lands in `src/lib/jobLease.js` keyed by table
name, so `scan_jobs` can adopt it later without a second implementation. Content uses it now; scan
keeps its existing heartbeat + status-CAS single-flight (changing the most expensive path is out of
scope — see §7).

**L3 — Lease TTL > heartbeat window, renewed on every job write.** TTL 180s (matching
`HEARTBEAT_STALE_MS`), renewed by `writeJob()`. A crashed worker's lease expires one window later
and the job becomes rescuable; a live worker never loses its lease.

**L4 — Fail-loud on writes, fail-open on read-side checks.** Matches the house rule in `db.js`: a
lease acquisition error throws (correctness-critical); a *losing* acquisition returns `null` and is
an expected, non-error outcome.

**L5 — The stage machine describes the lifecycle; it does not re-implement block execution.**
`blocks.js` already models composition well. `stages.js` models *status transitions* only —
kinds, terminality, the legal-transition allowlist, and review-decision routing. No rewrite of the
pipeline loop, so the change cannot destabilise a working pipeline.

**L6 — Illegal transitions warn, not throw, at the call site.** An `assertTransition` that throws
inside a fire-and-forget worker would convert a bookkeeping bug into a lost job. The stage machine
exposes `isLegalTransition()`; the worker logs a loud warning and proceeds, and the *tests* assert
legality. (Route handlers, which have a caller to answer to, return 409.)

**L7 — Memory mode keeps working.** Every new primitive mirrors the `hasDb === false` branch
convention so `npm run test:scoring` and local dev without Supabase behave exactly as before.

---

## 6. Implementation tracks

### T1 — Lease-based single-flight + cron auth (fixes D1, D2, D3)

- **`src/lib/jobLease.js`** (new): `acquireLease`, `renewLease`, `releaseLease`,
  `LEASE_TTL_MS`, `newLeaseOwner()`. Table-agnostic, memory-mode aware, `deps.client` injectable.
- **`src/lib/db/content.js`**: export `CONTENT_HEARTBEAT_STALE_MS`, `isContentJobAlive()`,
  `shouldRescueContentJob()`; rewrite `listResumableContentJobs()` to select all running jobs and
  filter on **heartbeat** staleness (mirroring `/api/scan/worker`'s approach) instead of the
  `created_at` 5-minute window.
- **`src/app/api/content/worker/route.js`**: `isAuthorized()` `CRON_SECRET` gate mirroring the scan
  worker exactly (Bearer / `x-cron-secret` / `?secret=` / `x-vercel-cron`, warn-once when unset);
  `maxDuration = 300`; acquire the lease *before* dispatch and skip jobs we lose.
- **`src/lib/content/contentWorker.js`**: accept an optional pre-acquired lease owner, acquire one
  if absent, renew on every `writeJob()`, release on terminal (success and failure).
- **`supabase/migrations/006_agent_control_plane.sql`**: lease columns + `content_jobs.heartbeat_at`
  index.

### T2 — Declarative stage machine (fixes D5)

- **`src/lib/content/stages.js`** (new): `JOB_STAGES` and `ITEM_STAGES` keyed by status, each with
  `kind` (`open`|`working`|`review`|`done`|`cancelled`), `terminal`, `next`, and — on review stages —
  `approveTo` / `rejectTo` / `requestChangesTo` / `reviewerKind`, following Paperclip's
  `PipelineStageConfig` shape. Plus `stageForBlock()`, `isLegalTransition()`, `decideItemStatus()`,
  `jobStatusForItemStatus()`, and a self-validation pass asserting every review stage declares
  `approveTo` and every referenced key exists.
- **`contentWorker.js`**: `statusForBlock()` derives from `stageForBlock()`; `writeJob()` checks
  legality and warns on violation.
- **`content-items/[id]/decision/route.js`**: verdict → status via `decideItemStatus()`; job mirror
  via `jobStatusForItemStatus()`; 409 on a decision against a non-review stage.

### T3 — Per-block run ledger (fixes D4)

- **Migration 006**: `content_runs` (job_id, brand, block, cycle, status, started_at, ended_at,
  duration_ms, cost, tokens, error) + indexes.
- **`src/lib/db/content.js`**: `insertContentRun()`, `finishContentRun()`, `listContentRunsForJob()`.
- **`contentWorker.js`**: one ledger row per block execution, cost captured as the `stats.cost`
  delta across the block, `failed` written with the error when a block throws.
- **`/api/content/[job_id]/status`**: expose `runs` so Studio can show per-block spend.

### T4 — Query coverage rollup (Paperclip's `autoAdvanceOnChildrenTerminal`, our version)

Gaps are computed pure (`analytics/gaps.js`, `dailyBatch.selectGapsForBatch`) — there are no
persisted gap rows to advance. The equivalent is a **derived** rollup over the stable join key that
already exists: `content_jobs.input.query` ↔ `content_items.target_queries`.

- **`src/lib/content/coverage.js`** (new): pure `rollupCoverage({ queries, jobs, items })` →
  per-query state `covered` | `awaiting_approval` | `in_progress` | `rejected` | `uncovered`, with
  precedence resolved highest-first, plus `summarizeCoverage()` totals.
- **`/api/brands/[brand]/coverage`** (new route): gap queries from the latest scan joined against
  jobs + items.

### Test plan

New `.test.mjs` files colocated per house convention (`node:test` + `assert/strict`, run by
`npm run test:scoring`): `src/lib/jobLease.test.mjs`, `src/lib/content/stages.test.mjs`,
`src/lib/content/coverage.test.mjs`, plus content-job lease/staleness cases appended to the
existing `src/lib/dbContent.test.mjs`.

---

## 6a. Deploy order (REQUIRED — read before shipping)

**Run `supabase/migrations/006_agent_control_plane.sql` BEFORE deploying this code.**

`acquireLease` writes `lease_owner` / `lease_expires_at`. Against a database
without those columns the write errors, and the worker deliberately **fails
closed** (L4 — never spend budget without proven exclusivity), so *every*
content job would stop starting. This is exactly the failure migration 005's own
comment records for `content_jobs.heartbeat_at`: code and migration authored
separately, shipped out of order, whole subsystem 500s.

`content_runs` is safer by construction — the ledger is fail-soft, so a missing
table only loses per-block attribution and logs a warning.

Set `CRON_SECRET` in the Vercel project before or with this deploy. The route
still works without it (warn-once, matching `/api/scan/worker`), but the whole
point of D2 is to stop shipping it open.

Verify after migrating:

```bash
curl -s "$DEPLOY_URL/api/content/worker" -H "x-cron-secret: $CRON_SECRET" | jq
```

Expect `{"resumed":0,"skipped_leased":0,...}` on a healthy system — no stale
jobs to rescue is the correct steady state. A 401 without the header confirms D2
is sealed.

---

## 7. Deliberately deferred

| Item | Why not now |
|---|---|
| Org chart, roles, delegation, per-agent budgets | Solves "coordinate arbitrary autonomous agents"; we run one fixed crew per job |
| Heartbeat scheduler + adapter plugin system | Blocked by B1 — no host to run adapters on |
| `scan_jobs` lease adoption | The most expensive path already has heartbeat + status-CAS single-flight. A 3-line change once T1's primitive is proven; not worth destabilising now (L2) |
| `enforceTransitions` as a hard throw | L6 — needs the warn-mode telemetry first |
| Approvals board UI / audit-event table | Needs the tenancy model that is still deferred |
| Multi-stage approval chains | The single human gate is correct until a customer asks for two |

---

## 8. What this buys us

1. The content pipeline stops being able to double-spend or be triggered by anyone on the internet.
2. Per-block cost attribution — the input to both optimisation and tier pricing.
3. Lifecycle rules become data, so multi-stage review is a table edit rather than a worker rewrite.
4. Coverage becomes a first-class read: "of the 30 prompts we track, N are covered by approved
   content" — the sentence the whole GEO product is trying to earn.
