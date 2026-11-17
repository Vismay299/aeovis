# P0 implementation status, 19 October 2026

> <!-- doc-status -->
> **Status: HISTORICAL.** PR #9 implementation snapshot. Current hosted execution is tracked in [P0 release qualification](./P0-RELEASE-QUALIFICATION.md).

This supplements [REPAIR-BACKLOG.md](./REPAIR-BACKLOG.md). Merged main baseline:
`c5530c9` (PRs #6/#7/#8). The new branch connects the previously standalone
R01/R02 policies to the executing scan worker. It does not close every P0
acceptance scenario or certify a production deployment.

## Implementation delivered here

| Scope | Executing code / effect | Verification |
|---|---|---|
| R01 readiness | `src/server/db/probeDispatch.js`, `/api/health`, `scripts/ops/provider-canary.mjs`: stored canary reads, separate deliberate canary dispatch, configuration rotation and expiry, fixed Gemini/OpenRouter selection. | Offline runtime tests; SQL concurrent canary claim, request ceiling and shared budget mismatch checks. |
| R02 observations/attempts | Migration 027 and `workers/durableProbing.js`: frozen identities, append-only settled attempts, fenced claims/renewals, typed due retries, atomic result projection and preserved legacy attempts. | Actual PostgreSQL claims, failed-pair resume and child termination before result commit; worker restart after result commit. |
| R02 circuits/spend | Account/provider circuit shared across engines/workers, one half-open recovery canary, atomic scan/day reservations, request units, retained unknown charges, global pause and audited reconciliation. | Actual SQL races, dependent-provider refusal, independent provider continuation, cost uncertainty, role denials and pause behavior. |
| R03/R04 | Frozen missing work remains in the outcome plan; request/body deadlines and durable dispatch envelope stop nested adapter retries. Failed Google requests keep unknown billing. | Worker/adapter/Google parser regressions and full existing suite. Dedicated finalizer/evidence-store/browser acceptance is still separate. |
| R05 | Qualified self exposure is independent of the legacy vendor-eliciting exploratory index. Thirty valid brand-free observations retain qualified zero. | Metric, normalization, hero and report regressions; historical v8 fixtures explicitly retain pre-contract behavior. |
| Operations | Migration catalog verification, production-write guard classification, CI PostgreSQL job, configuration example and rollout/rollback runbook. | Migration-runner tests, guard tests, actual full migration chain and supported-runtime build/fleet checks. |

## Dedicated database execution

Command (isolated loopback PostgreSQL 16; no provider/database production
settings loaded):

```sh
PGHOST=127.0.0.1 PGPORT=55439 PGDATABASE=aeovis_p0_qa \
  node scripts/qa/check-probe-dispatch.mjs
```

[Committed SQL execution evidence](./p0-database-evidence.json) records the source
commit, source hashes, timestamps and per-case results.

Applied `tests/supabase-bootstrap.sql` and the actual 001–027 migration chain
before execution. The job also runs in CI after customer RLS tests, using its
own disposable PostgreSQL service. It refuses non-loopback hosts, non-QA/UAT
database names and `DATABASE_URL` before writing.

Mapped named scenarios: **R01-13; R02-07, R02-08, R02-09, R02-10, R02-11,
R02-13, R02-14, R02-15, R02-16, R02-17, R02-18, R02-19, R02-20, R02-21,
R02-22, R02-23**. Additional runtime checks cover shared canary request/spend
ceilings, immutable budget mismatch refusal, dispatch pause and the real
worker's atomic report projection/restart path. Parallel batches race twenty
claimants; SQL locks and committed effects are checked, not stubbed RPC replies.

The interrupted child commits intent and reports a synthetic provider-return
boundary before the parent kills it. A late owner cannot overwrite a new
fenced result. This establishes our uncertainty/reconciliation behavior; it
does not establish real vendor idempotency or exactly-once billing.

Offline runtime tests live in
`src/server/repairs/r02-dispatch-integration.test.mjs`; existing R01–R05 tests remain
collected. The generic `run-repair.mjs` database/release mode still reports
unverified where its complete suite/evidence package is missing. This dedicated
job must not be presented as all 404 cases or all P0 database acceptance passing.

## Acceptance still open

- **R01:** operator status/browser rendering, actual bounded canaries and
  deployed selection/location evidence for every offered surface; real expiry
  and rollout/rollback sign-off.
- **R02:** adapter-idempotency fixture R02-12, browser execution detail R02-24,
  authorized workspace shadow/cutover and rollback with in-flight work. Offered
  adapters currently lack an idempotency guarantee; ambiguous calls stop for
  explicit reconciliation. No automatic duplicate billing claim is made.
- **R03:** real concurrent finalizer and citation/rollup crash recovery plus the
  three browser cases. The attempt/result transaction does not establish those
  different materialization boundaries.
- **R04:** durable raw-evidence write failure behavior, delivered parser-drift
  alerting and live India/no-AIO capture checks. Parser hashes alone are not a
  durable raw-capture store.
- **R05:** full intent/entity eligibility and uncertainty/cluster review,
  cohort/weight acceptance, methodology examples, two database and two browser
  cases. Existing synthetic metric tests are not population calibration.

No production migration, provider funding/credential change, paid vendor
request, browser acceptance, corpus adjudication or soak was performed for this
PR. Rollout sequence and caveats are in
[the provider dispatch runbook](../../runbooks/p0-provider-dispatch.md).

## Validation record

Local checks use Node 22.22.3 and disposable PostgreSQL 16:

- Full suite: **3,431 passed, 72 skipped, zero failed** (3,503 executions).
- Final readiness-circuit overlay and runtime/docs checks: **26 passed**;
  includes the additional readiness regression introduced after that full run.
- Actual migration chain and dedicated database dispatch checks: passed,
  including the 17 named cases above and two additional runtime contracts.
- `npm run build` and `npm run fleet:check`: passed.

The PR's CI runs the complete suite again against its final head. Existing
skipped cases stay skipped and keep the corresponding release acceptance open.
