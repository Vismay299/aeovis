# Repair backlog: implementation tasks, test cases, and release acceptance

> <!-- doc-status -->
> **Status: LIVE.** Acceptance plan for the repairs identified by the 16 October 2026 audit.

Updated: **20 October 2026, Asia/Kolkata**. Historical audited source baseline: `a2c97ddf12e332807c960e776eeae8de4550a210`.

This is the execution specification and current implementation status for 21 repairs. The original audit baseline is historical: its 3,209 passing tests, 30 skipped tests, 120 isolated mock answers and 11 reproduced unwanted behaviors describe that baseline, not today's release. See [the audit](./AUDIT.md) and [reproduction evidence](./adversarial-results.json).

## Current status: implemented code versus accepted repairs

Verified against merged main `af69523`, including PRs [#6](https://github.com/Vismay299/aeovis/pull/6), [#7](https://github.com/Vismay299/aeovis/pull/7), [#8](https://github.com/Vismay299/aeovis/pull/8), [#9](https://github.com/Vismay299/aeovis/pull/9) and [#11](https://github.com/Vismay299/aeovis/pull/11), plus the current P0 qualification follow-on. There are **102 implemented subtasks and 112 open/partial subtasks**. Hosted rollout progress and deployment limits are tracked in [P0 release qualification](./P0-RELEASE-QUALIFICATION.md). **No priority group is release accepted at this checkpoint.** R01–R11 are numbered repairs across P0/P1, not eleven completed P1 tasks.

Checkboxes mean an entire implementation subtask is present, not deployed, live qualified or release accepted. Unchecked items may have substantial partial code. The inventory remains 404 named scenarios / 214 implementation subtasks; partial database/browser suites cannot close the full inventory.

| Repair | Priority | Implementation actually present | Work still owed |
|---|---|---|---|
| R01 | P0 | Durable canaries, stored readiness, config identities, shared reservations and incident/recovery operator view. Actual configured adapters exercised in authorized local QA. | Hosted configuration/cutover/rollback qualification. Latest Google canary measured provider capacity failure; three gateway surfaces answered. Readiness is time-limited evidence, not a permanent certification. |
| R02 | P0 | Production durable observations/attempts, fenced claims, persisted retry times, circuits, reservations and ambiguity reconciliation in #9; operator attempt/cost/recovery display and browser checks added here. | Authorized shadow/cutover and full rollback exercise. Offered adapters do not promise provider idempotency; unsupported capability cannot be fabricated to pass R02-12. |
| R03 | P0 | Frozen matrix/outcome propagation plus natural report identity and transactional materialization of links, citations, judgments, rollups and terminal job. Actual SQL races/crash rollback/recovery and browser reload/JSON totals verified. | Hosted deployment/rollback qualification and the remaining complete browser inventory. |
| R04 | P0 | Strict Google parsing, whole-response deadlines, no nested durable retries, private capture state, parser incident inbox and operator display. Live AIO/no-AIO and provider failures recorded. | Hosted Storage upload/retention/signing and full live/manual Google fidelity acceptance. Preserve the first live harness's four actual attempts and its corrected two-request rerun; neither failure is hidden. |
| R05 | P0 | Fixed self denominators; frozen pre-answer purpose, panel/version/equal weights and full context; recommendation eligibility; clustered uncertainty; unreviewed-panel headline refusal; shared metric propagation and numerical methodology. | Full independent entity-resolution/calibration acceptance, all cluster/cohort scenarios and hosted rollup/browser release checks. |
| R06 | P1 | Runtime context/model identity, explicit unreported returned models, observed/unknown search telemetry, attempt IDs/times, sanitized private captures and tenant-scoped signed access endpoint. | Hosted Auth/Storage/retention tests and complete adapter/error/export inventory. Local filesystem captures are explicitly not hosted Storage acceptance. |
| R07 | P1 | Fixed sample and isolation foundations; actual mobile sample reload with no measurement requests verified. | Remaining storage/navigation/banner/download/version browser cases and complete sample-contract acceptance. |
| R08 | P1 | Merged relationships, contextual sentiment, evidence spans and first-mention/list-rank distinction. | Full entity-resolution/escalation, label persistence and browser inspection acceptance. |
| R09 | P1 | Calibration tooling/protocol and synthetic tests. | Actual 240-answer adjudicated corpus, held-out evidence, disagreement/leakage review and human sign-off. No real corpus or qualification is invented. |
| R10 | P1 | Full frozen context through sourcing, durable dispatch and adapters; accurate model unknowns; context-aware comparison refusal and explicit unverified egress. | Complete outgoing capability validation, all market/browser tests and real non-India qualification. Unsupported city/egress controls are not advertised. |
| R11 | P1 | Actual SQL window/job enqueue transaction, immutable panel/context, bounded catch-up, overlap/block records, finalization trigger and history UI. Concurrent database enqueue tested. | Full schedule settings/measurement alert integration, fault/rollout acceptance and seven real elapsed days. **Acceptance soak has not started**; a short canary is not the required 840-observation window. |
| R12 | P1 | API/Google methods remain explicitly separate. Consumer fleet stub still refuses. | Actual consumer adapter selection/execution, bounded production queue integration, 90 manual fidelity comparisons and three-/seven-day trials. This is still implementation work, not merely missing tests. |
| R13 | P1 | Read-state contract, cancellation, opaque denial, retained retry URL, partial/failure counts and JSON export. Actual Next/Chromium error/retry/reload/download tests. | Full authenticated customer/history/mobile/keyboard/slow-navigation browser matrix. |
| R14 | P1 | Immutable reviewed panels, source/provenance/intent/diagnostic separation, equal weights, duplicate review, tenant-scoped editor, approval and worker/scheduler snapshot integration. SQL edit races/RLS tested. | Remaining role/import/topic-review and full customer browser acceptance. Approval does not establish representative AI demand. |
| R15 | P1 | Owned scoped URL audit with bounded requests, robots/search-vs-training separation, HTTP/redirect/directive/canonical/text/structured-data evidence and reviewer actions in customer UI. | Rendered-vs-source comparison, authorized property/inclusion controls, complete live/browser/manual scope and stale-evidence acceptance. Fetching a page does not prove indexing or crawler visits. |
| R16 | P1 | Source snapshots, exact passage/offset verification, honest retrieval hypotheses, tenant-scoped opportunities and immutable accept/dismiss/correct decisions/UI. | Complete observed citation/entity joins, dedupe/priority model, reviewed work-order integration and full browser acceptance. |
| R17 | P1 | Captured research/skips, missing-evidence blocking, exact draft/dependency checks, edit invalidation, bounded paid rechecks, combined revision costs and exact-version approval in both routes. Default pipelines without a check deliver explicitly unchecked drafts; approval requires a fresh saved-draft check. | Full claim/support/conflict review, native worker-wide check scheduling and the complete browser/fault inventory. |
| R18 | P1 | Exact approved hash/version, meaningful body match, publication/event/item/job transaction, immutable publication record and separate unknown indexing/crawl/citation states; real rollback/idempotency SQL tests. | Approved external-domain policy, withdrawn/changed page observation history, bounded follow-up scheduler and full browser/live acceptance. |
| R19 | P1 | Item observations anchored to verified publication, actual target counts, compatible cohorts, uncertainty and small-sample withholding. Conventional GSC rows explicitly labeled; current Google Generative AI reporting capabilities checked against primary sources. | Complete replacement of remaining legacy prompt_score reports, preregistered treatment/control windows, referral/conversion ingestion, correction/export integration and full acceptance. |
| R20 | P2 | Merged hostname/canonical/robots/sitemap/private-noindex foundations; built-site HTTP checks pass. | Public navigation/mobile/claims review, real owned-site study and deployed/Search Console evidence. |
| R21 | P2/bootstrap | Existing honest 404-case harness and isolated SQL job; follow-on SQL/browser/live executables and evidence manifests added here. | Complete evidence ingestion for every suite, architecture/semantic mutation checks, manual/soak evidence and end-to-end rollout/rollback sign-off. |

**Evidence.** See [follow-on verification and limits](./REPAIR-IMPLEMENTATION-STATUS.md), [database workflow results](./repair-workflow-database-evidence.json), [actual browser results](./repair-browser-evidence.json), [durable live canaries](./repair-provider-live-evidence.json), [Google checks](./repair-google-live-evidence.json), and the [historical first Google run](./repair-google-live-first-run.json). The initial credential assessment looked at legacy names; the configured canonical `LLM_API_KEY` was subsequently verified through all three actual gateway routes. No production application database was migrated or written.

P0 remains first: qualify hosted evidence and deployment behavior, resolve the measured Google capacity failure with bounded recovery, then shadow/cut over and exercise rollback. R09 human adjudication, R11/R12 elapsed soak, the consumer fleet, remaining P1 integration and P2 acceptance stay open. This branch is substantial implementation progress, not completion of every scope in the requested table.

The plan contains **404 named acceptance scenarios**. Counts reflect distinct behaviors and failure boundaries; they are minimum coverage, not a target for inflating assertion counts. Reuse an existing behavioral test if it establishes the entire scenario and link its result. Table-driven variants expand runtime executions without changing the scenario inventory. Corpus examples and daily observations are counted separately.

## Execution index

| Repair | Priority | Named scenarios | Depends on |
|---|---|---:|---|
| R01 Provider readiness | P0 | 16 | Test-harness bootstrap from R21 |
| R02 Attempts, leases, circuit breakers | P0 | 24 | R01, R06 contract |
| R03 Honest terminal outcomes | P0 | 18 | R02, R04 |
| R04 Google payload validation | P0 | 24 | Harness bootstrap |
| R05 Metric denominators and eligibility | P0 | 24 | R03, R04, R08 label contract |
| R06 Provenance | P1 | 16 | Harness bootstrap; implement alongside R01/R02 |
| R07 Sample isolation | P1 | 16 | R03/R05 output contracts |
| R08 Entity relationships and sentiment | P1 | 20 | R06; implement contract before finalizing R05 |
| R09 Judge calibration | P1 | 18 | R05, R08 |
| R10 Geography and surface | P1 | 16 | R06 |
| R11 Continuous measurement | P1 | 18 | R01–R06, R10 |
| R12 Consumer collection validation | P1 | 20 | R01–R06, R10; integrate with R11 |
| R13 Dashboard states | P1 | 16 | R03/R06 response contracts |
| R14 Reviewed question panels | P1 | 18 | R05, R10 |
| R15 Technical eligibility | P1 | 24 | R06, R10 |
| R16 Verified source opportunities | P1 | 18 | R05, R06, R14, R15 |
| R17 Research and revision checks | P1 | 20 | R06, R16 |
| R18 Publication and observations | P1 | 20 | R17, R15 |
| R19 Attribution and reporting | P1 | 24 | R05, R11, R14, R18 |
| R20 Perceev public website | P2 | 16 | R07; methodology waits for R05/R12 |
| R21 Consolidation and release checks | P2, with early bootstrap | 18 | Bootstrap first; cleanup after affected repairs |

Dependencies distinguish shared contracts from finished implementations. R05/R08 and R11/R12 are joint design checkpoints, not circular release blockers. Agree on schemas first, then implement independent components. R20 discovery/hostname work can start early; claims must wait for evidence.

## Rules shared by every repair

### A. Test levels and environments

- **U — unit/property:** pure functions; seeded randomness and fake clock; no network or database. Test output and invariants, not presence of a source-code string.
- **I — integration/contract:** real modules wired together with controlled HTTP/storage/provider substitutes. Capture outgoing requests and durable effects. A stubbed database does not establish SQL locking or RLS.
- **D — database:** real isolated PostgreSQL for constraints/transactions/leases; use local Supabase or a disposable test project when Auth, Storage, or PostgREST behavior matters. Apply the actual migrations. Seed tenants A/B and roles; prove both allowed and denied operations.
- **B — browser:** actual Next app in a disposable test environment. Use separate authenticated browser contexts for A/B and an anonymous context. Assert visible states, enabled controls, navigation, and requests. Server rendering alone does not prove effects, sessionStorage, or asynchronous UI behavior.
- **L — live integration:** narrowly scoped vendor or authorized-property checks with explicit request/spend limits. Preserve sanitized request IDs, surface, date, and result. Missing access is **blocked/unverified**, never pass. No automatic credential, account, funding, or billing changes.
- **M — manual/adjudication:** documented human review with a rubric, reviewer, source evidence, disagreement resolution, and a signed outcome.
- **S — soak:** repeated scheduled observations across the stated real elapsed period. Accelerated clocks prove scheduling logic only. Record every scheduled opportunity, including outages and missed runs.

Every case table specifies Given/input, When/action, and Then/pass criteria. Each row is one independently reportable scenario. A case may contain several assertions that jointly establish that behavior.

### B. Harness and commands — implementation and remaining suites

The merged `scripts/qa/run-repair.mjs` and inventory execute offline U/I and refuse unverified required suites. The commands below define the full target interface; DB/browser/live/soak/release acceptance remains open. P0 dispatch SQL has a separate CI job and executable documented above:

```powershell
# Runner rejects unsupported combinations, empty selections and missing required evidence.
node scripts/qa/run-repair.mjs --repair R01 --suite offline
node scripts/qa/run-repair.mjs --repair R02 --suite database --environment qa
node scripts/qa/run-repair.mjs --repair R07 --suite browser --environment qa
node scripts/qa/run-repair.mjs --repair R01 --suite live --environment qa --max-requests 8 --max-spend-usd 1.00
node scripts/qa/run-repair.mjs --repair R11 --suite soak --environment qa --days 7
node scripts/qa/run-repair.mjs --suite release --environment qa
```

The live numbers are **example hard ceilings**, not a statement about vendor prices or permission to fund an account. Configure the concrete approved test budget before execution; stop when exhausted. `offline` runs U/I only; `database` runs D; `browser` runs B; `live` runs L; `soak` collects/evaluates S; `release` aggregates required evidence, including M. A request exceeding a ceiling is refused before dispatch. A required missing suite makes release fail as unverified, even if the runner allows an explicit local skip.

Put discoverable Node U/I tests under `src/lib/repairs/rNN-*.test.mjs` so the existing `npm test` glob includes them. Add browser/DB/live suites to dedicated manifests and explicit CI jobs; do not let a naming convention hide them. Preserve `liveWriteGuardAuto.mjs`. Child test environments must clear production provider/database settings, use an allowlisted QA database identity, and explicitly scope fixture writes. A transaction rollback is insufficient isolation for tests of committed writes and concurrent workers.

Existing commands remain useful: `npm test`, `npm run build`, `npm run fleet:check`, and `node scripts/verify-local-product.mjs`. None substitutes for the new evidence. The original adversarial script asserts the **old unwanted behavior**; preserve it as historical reproduction and translate A01–A11 into tests asserting corrected behavior. Do not make the old failure assertions a release gate after repairs.

### C. Fixtures and identifiers

Maintain `tests/fixtures/repairs/` and a manifest with hashes, origin, consent/usage status, surface, capture date, and redaction state. Use synthetic Acme/Rival data for fault injection. Real calibration/consumer captures must be permitted and minimized. Example credential strings must be unmistakably fake; never output real values or raw credential-bearing provider bodies.

Required shared fixtures: 30 unique unbranded prompts; four separately tagged branded diagnostics; four engine configurations; two tenant workspaces; valid AIO/no-AIO payloads; timeout/auth/budget/schema failures; citation-only/negative/ambiguous mentions; a local HTTP site with redirects/robots/noindex/canonical variants; and a timestamped publication/observation history. Register request counts, database row counts, console logs, evidence objects, and cost counters as assertions where relevant.

### D. Proposed v1 policy — explicit product choices, not observed capabilities

- A logical observation key includes workspace, immutable prompt/version, panel/version, surface, location/language/device/session policy, scheduled time, replicate, and diagnostic/scoring purpose. Attempts are children of that observation.
- Terminal observation dispositions are exclusive. For a closed scan: `planned = answered + valid_no_aio + failed + not_attempted`. Attempt counts may exceed planned counts; repeated attempts do not expand the denominator.
- **Collection completion** is valid observations/planned; valid no-AIO is valid collection. **AIO trigger rate** is AIO-present/valid SERPs. Provider failures never mean brand absence.
- A production headline requires at least **95% valid collection** for its frozen offered surface and at least **20 distinct eligible prompt IDs** in the metric's actual denominator. Replicates do not satisfy that distinct-prompt minimum. These are proposed initial release thresholds, versioned and configurable through a reviewed policy. Below them show counts, intervals, and an exploratory/insufficient label; no unqualified headline or ranking verdict. Low natural AIO trigger rate may therefore yield no qualified conditional-AIO headline despite healthy collection.
- Denominators are defined before outcomes. Self mention/citation rates do not change when a user adds a tracked rival. Separate recommendation from neutral/negative mention. First textual occurrence is `first_mention_order`, not recommendation rank.
- Show raw measured ratios with explicit denominators separately from qualified headline eligibility. Empty/unknown is null with a reason; measured zero remains zero. Report 95% uncertainty appropriate to prompt clustering; do not count correlated observations as independent people or imply market-wide sampling.
- Provider canaries establish readiness only. Healthy provider state cannot override failed observed collection; a historical good run cannot establish current readiness.

### E. Evidence, definition of done, and rollout

For each case save `repair_id`, `case_id`, suite/environment, commit/build, policy/schema/parser/model version where applicable, seed, fixture hash, start/end timestamps, outcome (`pass/fail/blocked/skipped`), expected/actual result, and sanitized artifacts. Use `test_reports/repairs/<commit>/RNN/` with JSON plus readable summary. Link actual test code and execution evidence back to this document's case IDs.

A repair closes only when its listed cases pass at the required levels, outputs agree across API/storage/UI/export, migrations have been tested forward from existing data, and the rollout/rollback exercise succeeds. An unimplemented or skipped required case keeps it open. Keep historical evidence/version boundaries; do not overwrite old raw captures or recompute old scores without a labeled backfill. Canary the new path on an owned/authorized workspace; compare both paths before cutover. Scope changes update the inventory and count explicitly.

### F. Test allocation and implementation traceability

This is the allocation of the **404 scenarios**, not a record of tests already implemented or run. There are **372 U/I/D/B scenarios**, **16 live checks**, **10 manual reviews**, and **6 soak scenarios**. A live case can expand into multiple provider executions; a soak case requires many observations; neither should be represented as one paid request. The separate R09 corpus contains 240 answers and is not added to the scenario count.

| Repair | U | I | D | B | L | M | S | Total |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| R01 | 8 | 5 | 1 | 1 | 1 | 0 | 0 | 16 |
| R02 | 6 | 4 | 13 | 1 | 0 | 0 | 0 | 24 |
| R03 | 8 | 5 | 2 | 3 | 0 | 0 | 0 | 18 |
| R04 | 14 | 7 | 1 | 0 | 2 | 0 | 0 | 24 |
| R05 | 16 | 4 | 2 | 2 | 0 | 0 | 0 | 24 |
| R06 | 4 | 7 | 4 | 1 | 0 | 0 | 0 | 16 |
| R07 | 5 | 3 | 0 | 8 | 0 | 0 | 0 | 16 |
| R08 | 15 | 2 | 1 | 2 | 0 | 0 | 0 | 20 |
| R09 | 6 | 8 | 0 | 0 | 0 | 4 | 0 | 18 |
| R10 | 5 | 6 | 1 | 2 | 2 | 0 | 0 | 16 |
| R11 | 4 | 4 | 4 | 2 | 0 | 0 | 4 | 18 |
| R12 | 4 | 5 | 0 | 5 | 3 | 1 | 2 | 20 |
| R13 | 0 | 5 | 0 | 11 | 0 | 0 | 0 | 16 |
| R14 | 7 | 4 | 3 | 4 | 0 | 0 | 0 | 18 |
| R15 | 8 | 10 | 0 | 2 | 3 | 1 | 0 | 24 |
| R16 | 7 | 6 | 2 | 3 | 0 | 0 | 0 | 18 |
| R17 | 7 | 7 | 3 | 3 | 0 | 0 | 0 | 20 |
| R18 | 3 | 6 | 7 | 4 | 0 | 0 | 0 | 20 |
| R19 | 10 | 6 | 4 | 2 | 2 | 0 | 0 | 24 |
| R20 | 3 | 4 | 0 | 4 | 3 | 2 | 0 | 16 |
| R21 | 3 | 8 | 3 | 2 | 0 | 2 | 0 | 18 |
| **Total** | **143** | **116** | **51** | **62** | **16** | **10** | **6** | **404** |

The backlog also contains **214 implementation subtasks**, each with a stable `RNN.Na` or `RNN.Nb` ID. When implementing a repair, map each subtask to its change/commit and the case IDs proving it; several subtasks may share a behavioral case. Documentation and operational subtasks require their review or runbook evidence as well. An unmapped subtask stays open even when the numerical test count is satisfied.

For each case, the implementer must supply: fixture/setup and cleanup; the actual action against the system; assertions for every clause in its pass condition; evidence capture; and a mapping to its required suite. Name the test with the case ID. The proposed runner should support `--case R05-02` for reproduction as well as the complete `--repair R05` selection. Single-case success does not satisfy repair acceptance. Where a row lists multiple variants, enumerate all variants in the test registration; passing one variant cannot pass the entire row.

## R01. Diagnose and recover provider readiness

**Current status:** Production adapter/configuration selection has been inspected. The current P0 release record tracks the hosted migration, bounded provider, Storage, browser and rollout qualification; configured credentials alone still do not establish readiness.

**Priority/dependencies:** P0; harness bootstrap. **Primary code:** `src/lib/vendorRegistry.js`, `health.js`, `engines/httpFailureKind.js`, engine adapters, `scripts/check-secrets.mjs`. **Problem:** configured credentials were reported healthy while persisted calls failed authentication or key limits.

### Implementation tasks and subtasks

1. **Trace configuration to the actual adapter.**
   - [x] R01.1a Inventory each offered surface, selected gateway/model, credential variable name, fallback rule, and deployed environment. The hosted production health read and current P0 rollout record verify the actual gateway selections.
   - [x] R01.1b Record configuration identity/version without recording credential values; flag unsupported model/gateway combinations before spending.
2. **Create one failure classifier.**
   - [x] R01.2a Parse status plus allowlisted provider codes into authentication, permission/challenge, spend limit, rate limit, transient, timeout, and parse outcomes.
   - [x] R01.2b Preserve retry eligibility/reset information; sanitize operator messages. A generic 403 or 429 must not imply one universal cause.
3. **Separate readiness from liveness.**
   - [x] R01.3a Store canary start/end, observation time, surface, location status, config version, outcome, and request ID.
   - [x] R01.3b Return configured/unverified/ready/degraded/blocked/stale distinctly; credential changes invalidate old readiness.
4. **Implement bounded canaries and operator recovery.**
   - [x] R01.4a Dispatch canaries separately from health polling, with shared budget/request reservation and no concurrent duplicate canaries.
   - [x] R01.4b Document the action for each failure: repair selection/credentials, review limits, wait for reset, or investigate provider capacity. Do not auto-fund.
5. **Deploy and validate narrowly.**
   - [ ] R01.5a Start with one authorized QA workspace and preserve sanitized evidence for all offered surfaces.
   - [ ] R01.5b Confirm readiness expiry and rollback to the previous status schema without treating stale results as current.

### Test plan — 16 named cases

| Case | Level | Given / fixture | When | Exact pass condition |
|---|---|---|---|---|
| R01-01 | U | Credential presence only | Resolve readiness | `configured` is true; readiness is unverified; no successful timestamp is invented. |
| R01-02 | U | Missing required variable | Validate engine configuration | Engine is blocked with variable name; zero provider requests and no credential value in output. |
| R01-03 | U | Unsupported gateway/model pair | Prepare canary | Refusal occurs before dispatch; selected pair and corrective action are explicit. |
| R01-04 | I | Valid shared gateway; no direct vendor keys | Probe configured engine | Shared adapter is selected once; missing direct keys do not incorrectly disable it. |
| R01-05 | U | HTTP 401 fixture | Classify response | Credential rejection; no automatic retry; safe message names the affected provider. |
| R01-06 | U | Credit/key-limit provider code | Classify response | Budget-blocked differs from temporary rate limiting; reset is unknown unless observed. |
| R01-07 | U | 429 with Retry-After | Classify response | Retryable throttling with parsed retry time; no invented account-credit failure. |
| R01-08 | U | 403 challenge and permission variants | Classify each variant | Correct distinct failure kinds; challenge is not a brand non-mention. |
| R01-09 | I | Bright Data no-ready-cookies envelope | Execute canary | Provider-capacity failure retained; no no-AIO success and no silent geography change. |
| R01-10 | I | 503 followed by valid fixture | Execute bounded retry | Attempt history contains both calls; readiness reflects final valid measurement within budget. |
| R01-11 | I | Hanging body / malformed 200 | Execute canary | Deadline aborts or parser rejects; readiness cannot become ready. |
| R01-12 | I | Canary already exists | Send 100 health reads | Exactly zero additional provider requests; last observed canary remains unchanged. |
| R01-13 | D | Two concurrent canary dispatchers | Claim same scheduled canary | One claim/reservation; one active dispatch; no duplicate readiness rows. |
| R01-14 | U | Previously ready config A, rotated to B | Read readiness | A's result is historical; B is unverified until its own check succeeds. |
| R01-15 | B | Stale/blocked readiness fixtures | Open operator status | Age, affected surface, and recovery action are visible; no blanket healthy badge. |
| R01-16 | L | Actual offered engines in bounded QA run | Perform one current canary per surface | Each stores real request/capture evidence and correct surface; failures block readiness rather than being skipped. |

**How to test:** `--repair R01 --suite offline`, then `database`, `browser`, and bounded `live`. Freeze time for expiry cases; collect request counts and sanitized logs. Each offered adapter instantiates R01-16 separately, with the request ceiling adjusted before running.

**Repair acceptance:** All 16 scenarios pass; API/UI agree on current readiness; health remains free of probe dispatch; no provider is advertised ready solely because a variable exists. Attach the live evidence and credential-selection map. Roll back UI/schema compatibly while retaining canary history.

## R02. Add durable per-pair attempts, leases, and provider circuit breakers

**Current status:** Implementation is connected in this change and tested against real disposable PostgreSQL. Attempts are immutable once settled; dispatch/reconciliation transitions append evidence. Lease renewal is fenced; expired intents require explicit reconciliation. R02-12 remains unverified because offered adapters do not expose provider idempotency.

**Priority/dependencies:** P0; R01 classification and R06 identity contract. **Primary code:** `src/lib/workers/scanWorker.js`, `db/analytics.js`, `probeQueue.js`, lease helpers, new additive migrations. **Regression:** A08.

### Implementation tasks and subtasks

1. **Separate observations from attempts.**
   - [x] R02.1a Add immutable observation identity and append-only attempt records; preserve provider errors and retry history.
   - [x] R02.1b Define unique constraints for logical observation and attempt number; migrate legacy failed rows as historical attempts, not successes.
2. **Implement atomic claims and fenced leases.**
   - [x] R02.2a Claim due work transactionally, issue a lease token/generation, and renew only for the current owner.
   - [x] R02.2b Reject stale completion writes after lease expiry; preserve late provider evidence for reconciliation without overriding a newer result.
3. **Make retry policy explicit.**
   - [x] R02.3a Calculate bounded backoff with seeded jitter and provider retry time; stop at attempt/deadline limits.
   - [x] R02.3b Keep valid no-AIO and successful answers terminal; retry typed transient failures only.
4. **Handle the external-call uncertainty window.**
   - [x] R02.4a Persist dispatch intent and provider idempotency key where supported; distinguish not-dispatched from dispatched-but-result-unknown.
   - [x] R02.4b Do not promise exactly-once billing without provider support. Reconcile ambiguous calls or require a bounded explicit retry policy with possible spend disclosed.
5. **Share circuit and spend state across workers.**
   - [x] R02.5a Scope circuits to provider/config/account identity; open on permanent credential/budget failures and use one half-open canary.
   - [x] R02.5b Reserve estimated spend atomically, reconcile actual/unknown cost, and isolate unrelated providers and tenants as policy requires.
6. **Roll out with a kill/restart exercise.**
   - [ ] R02.6a Shadow legacy completion decisions, inspect differences, then switch one workspace to new claims.
   - [ ] R02.6b Keep old rows readable; rollback stops new dispatch while in-flight attempts are reconciled.

### Test plan — 24 named cases

| Case | Level | Given / fixture | When | Exact pass condition |
|---|---|---|---|---|
| R02-01 | U | Transient timeout | Calculate retry | Retry time is bounded, jitter seeded, attempt count incremented once. |
| R02-02 | U | Permanent credential rejection | Calculate retry | No automatic question retry; circuit action is emitted. |
| R02-03 | U | Valid no-AIO | Calculate retry | Terminal valid observation; no retry to force an overview. |
| R02-04 | U | Max attempts already reached | Evaluate dispatch | Terminal exhausted failure; no extra request. |
| R02-05 | U | Retry-After beyond scan deadline | Evaluate dispatch | Work becomes explicitly not retryable within this window; no early call. |
| R02-06 | U | Randomized backoff inputs | Run seeded property checks | Delay remains within limits and monotonic policy; reproducible seed explains failures. |
| R02-07 | D | Two workers, one due observation | Race claim transactions | Exactly one current lease and one dispatch authorization. |
| R02-08 | D | Twenty due observations | Claim batches concurrently | No observation is claimed twice; remaining work stays claimable. |
| R02-09 | D | Active lease | Attempt reclaim | Another worker cannot take it before expiry. |
| R02-10 | D | Expired lease | Reclaim and complete | New generation owns completion; stale owner cannot overwrite it. |
| R02-11 | D | Provider returns before result commit | Kill worker before commit | Dispatch-unknown state survives; reconciliation policy prevents an unqualified duplicate retry. |
| R02-12 | D | Provider idempotency support fixture | Retry ambiguous dispatch | Same provider key reused; one accepted logical operation in provider stub ledger. |
| R02-13 | D | No provider idempotency support | Recover ambiguous dispatch | Outcome is flagged ambiguous; automatic behavior follows documented bounded policy, never an exactly-once claim. |
| R02-14 | D | Successful attempt already committed | Resume job | Zero further requests for that observation; result and history unchanged. |
| R02-15 | D | Persisted transient failure | Recover provider and resume | Only due failed pairs retry; successful pairs are untouched. |
| R02-16 | D | Repeated result delivery | Ingest same attempt twice | One durable attempt/result effect; duplicate delivery does not inflate denominators. |
| R02-17 | I | Shared gateway fails authentication | Run dependent engines | Circuit stops subsequent dependent dispatch; reason references the shared provider/config. |
| R02-18 | I | Gateway circuit open; Google independent | Run scan | Google work proceeds; unrelated provider is not blocked. |
| R02-19 | D | Multiple half-open contenders | Schedule recovery check | One canary claim; no recovery stampede. |
| R02-20 | D | Workers near shared spend ceiling | Race reservations | Authorized reservations stay within cap; refusals are recorded before network calls. |
| R02-21 | I | Failed request may be billed | Reconcile cost | Unknown charge stays unknown; it is not reported as free. |
| R02-22 | D | Tenant A/B observations | Query/claim under customer roles | Neither tenant can inspect or mutate the other's attempts/circuit details. |
| R02-23 | I | Crash after batch result persistence | Restart worker | Previously committed rows remain; no duplicate final observation; retry history retained. |
| R02-24 | B | Retried/ambiguous/exhausted observations | Open execution detail | Attempt count, current disposition, cost uncertainty, and operator action agree with storage. |

**How to test:** U/I with fake time; D with actual committed concurrent transactions and process termination, not mock RPC responses. Run two child workers against disposable fixtures and a local provider ledger. Use barriers to place crashes precisely before dispatch, after dispatch, and after persistence. Then browser-check the resulting ledger.

**Repair acceptance:** All 24 cases pass, including real locking and crash boundaries. A08's corrected test retries only eligible failed work. No fabricated exactly-once billing guarantee. Produce migration/backfill evidence and a rollback record with no lost attempt history.

## R03. Make terminal scan outcomes reflect collection quality

**Current status:** Core implementation merged; the new ledger closes the dispatch/result persistence gap. Transactional finalizer rollback/recovery now has actual isolated PostgreSQL and browser reload/export evidence; hosted rollout and the full case inventory remain open.

**Priority/dependencies:** P0; R02/R04. **Primary code:** scan worker/finalizer, scan job storage, status routes, public/customer report adapters. **Regression:** A07.

### Implementation tasks and subtasks

1. **Freeze the work matrix.**
   - [x] R03.1a Persist all prompt/surface observation IDs before execution, with branded diagnostics separately tagged.
   - [x] R03.1b Reject missing/duplicate IDs; retain planned work when a surface becomes unavailable.
2. **Define two state machines.**
   - [x] R03.2a Keep execution phase separate from collection outcome; specify allowed transitions and terminal reasons.
   - [x] R03.2b Use complete for fully valid collection, partial for mixed usable/failing outcomes, failed for no usable collection, and blocked for configuration/budget stops; retain explicit reason codes.
3. **Finalize from durable observations.**
   - [x] R03.3a Derive exclusive dispositions and engine summaries from persisted data; do not use array length as success.
   - [x] R03.3b Preserve successful surfaces and classify never-dispatched work; avoid deleting failed rows during finalize retries.
4. **Propagate the contract.**
   - [x] R03.4a Update polling, persisted reports, customer/public dashboards, history, and export schemas together.
   - [x] R03.4b Show partial evidence and recovery actions; prevent “complete” animations or success emails for all-error scans. Public completion notices and portal banners now use collection outcome, with actual browser checks for complete/partial/failed notices; this application has no scan-success email sender.
5. **Protect finalization under concurrency.**
   - [x] R03.5a Finalize atomically or through a fenced idempotent operation; reconcile interrupted materialization.
   - [x] R03.5b Mark historical records as legacy where quality cannot be reconstructed; do not invent modern outcome counts.

### Test plan — 18 named cases

| Case | Level | Given / fixture | When | Exact pass condition |
|---|---|---|---|---|
| R03-01 | U | Thirty answered observations | Classify scan | Complete; planned/valid/answered all 30; failed/not-attempted zero. |
| R03-02 | U | Thirty valid no-AIO SERPs | Classify scan | Complete collection, zero trigger rate; no conditional AIO headline. |
| R03-03 | U | 120 failed pairs, no answer | Classify scan | Failed collection; never complete; usable count zero. |
| R03-04 | U | 119 valid plus one exhausted failure | Classify scan | Partial with exact counts; incomplete coverage remains visible. |
| R03-05 | U | Permanent failure before remaining dispatch | Classify scan | Blocked reason and explicit not-attempted count; no erased planned work. |
| R03-06 | U | 30 unbranded plus four diagnostics, four engines | Build work matrix | 120 scoring observations and 16 diagnostics; distinct counts remain separate. |
| R03-07 | U | Duplicate observation result | Aggregate counts | One logical disposition; attempts may increase without inflating planned/valid counts. |
| R03-08 | U | Zero planned prompts | Start/finalize | Invalid configuration or no-work state; no successful percentage or divide-by-zero score. |
| R03-09 | D | Two finalizers, same completed work | Race commits | One report identity and materialization; equivalent terminal outcome. |
| R03-10 | D | Crash during citation/rollup materialization | Resume finalize | Complete durable reconstruction with no duplicate citations or missing result links. |
| R03-11 | I | Frozen engine loses configuration mid-scan | Continue | Original engine retained as blocked/not-attempted; no silent substitute surface. |
| R03-12 | I | One engine healthy, three fail | Finalize/export | Partial report retains all four engines and their exact outcomes. |
| R03-13 | I | Legacy record lacks expected matrix | Read report | Legacy/unknown quality explicitly shown; no fabricated 100% collection. |
| R03-14 | B | All-error report | View completion | Failure explanation and retry conditions; no success celebration or ranking verdict. |
| R03-15 | B | Partial report | Inspect matrix and export | All planned questions visible; screen and downloaded totals agree. |
| R03-16 | B | Scan running, browser closes | Reopen after worker finishes | Durable terminal outcome loads without requiring the original polling tab. |
| R03-17 | I | Spend cap reached between batches | Finalize | Skipped work is not-attempted with cap reason; no measured non-mentions. |
| R03-18 | I | Status endpoint and final report read same scan | Compare responses | One versioned outcome vocabulary and identical counters, including diagnostics. |

**How to test:** Integrate the actual worker with fixture providers; test D finalization against real committed storage. B tests close the client process while server-side work continues. For every fixture assert the terminal count equation, API/report/export equality, and allowed state transitions.

**Repair acceptance:** All 18 pass; A07 now ends failed; valid no-AIO never requires a synthetic answer. Quality survives reload/export and failures remain auditable. Historical uncertainty is preserved through migration/rollback.

## R04. Validate Google payloads before classifying AIO absence

**Current status:** Parser/transport implementation merged. Private capture metadata/upload state and a durable operator parser-drift inbox are connected. Local live captures and browser delivery are verified; hosted Storage and complete fidelity acceptance remain open.

**Priority/dependencies:** P0; harness bootstrap. **Primary code:** `engines/brightdata.js`, `scoring/enginePipeline.js`, fixtures, evidence retention. **Regressions:** A01/A10.

### Implementation tasks and subtasks

1. **Specify parsing stages.**
   - [x] R04.1a Separate transport envelope, recognizable Google SERP, AIO detection, answer blocks, and citations into explicit parse results.
   - [x] R04.1b Require affirmative valid-SERP evidence before `valid_no_aio`; unknown schema is not absence.
2. **Handle supported shapes.**
   - [x] R04.2a Preserve block order and reference-index mappings; validate and deduplicate safe citation URLs.
   - [x] R04.2b Preserve partial fields with per-field quality; a references-only capture cannot establish a complete text measurement.
3. **Classify provider/access failures.**
   - [x] R04.3a Recognize proxy/session, challenge, consent/login, truncated, and malformed results independent of HTTP 200.
   - [x] R04.3b Exhaust retry policy before terminal parse failure; the last attempt must satisfy the same validation as the first.
4. **Bound the whole request.**
   - [x] R04.4a Apply deadlines to zone lookup, connection, headers, body reading, decoding, and retry delays.
   - [x] R04.4b Check remaining chunk/lease budget before dispatch; stop before a probe cannot finish within its envelope.
5. **Preserve evidence and monitor drift.**
   - [x] R04.5a Save sanitized raw payload/evidence identity, parser version, validation errors, and provider request ID.
   - [x] R04.5b Version fixture coverage and alert on newly unknown shapes without falling back to manufactured Google text.

### Test plan — 24 named cases

| Case | Level | Given / fixture | When | Exact pass condition |
|---|---|---|---|---|
| R04-01 | U | Canonical AIO texts/references | Parse | Ordered text, references, and presence match fixture exactly. |
| R04-02 | U | Valid organic SERP without AIO | Parse | Valid-no-AIO; no parse failure and no answer text invented. |
| R04-03 | U | Supported direct versus string-body envelope | Parse both | Equivalent normalized fields; original evidence retained. |
| R04-04 | U | Nested list/paragraph AIO blocks | Parse | All supported blocks remain in reading order; no dropped content. |
| R04-05 | U | Duplicate references and tracking URL forms | Normalize | Stable deduplication; citation-to-block links remain correct. |
| R04-06 | U | Reference-only AIO | Parse | Citation observation preserved; missing text explicitly partial, never a complete mention measurement. |
| R04-07 | U | Text-only AIO | Parse | Text measured; citation availability distinguished from a verified empty list. |
| R04-08 | U | Unexpected JSON object | Parse final attempt | Typed parse error; no valid-no-AIO classification. |
| R04-09 | U | Empty body or null payload | Parse | Failure with a specific reason; no normal empty answer. |
| R04-10 | U | Truncated JSON | Decode | Decode error retained with evidence identity; malformed bytes never become a SERP. |
| R04-11 | U | HTTP-200 proxy-session failure | Classify | Provider-capacity/session failure, not valid Google output. |
| R04-12 | U | CAPTCHA/consent/login HTML | Classify | Access-state outcome; no generated or substituted answer. |
| R04-13 | U | Invalid/unsafe reference scheme | Extract references | Invalid link rejected; remaining safe links preserved with validation reason. |
| R04-14 | U | Out-of-range reference indexes | Parse block links | Mapping issue recorded; no incorrect supporting-source assignment. |
| R04-15 | I | First response malformed, second valid | Run adapter | Two attempts; valid final parse; both evidence records retained. |
| R04-16 | I | Every attempt malformed | Exhaust retries | Final outcome parse_error; never silently accepted on last attempt. |
| R04-17 | I | Headers arrive, body hangs | Await body | Shared deadline aborts body read; timer is not cleared prematurely. |
| R04-18 | I | Zone lookup hangs | Resolve configuration | Lookup ends within configured deadline; no paid SERP dispatch follows. |
| R04-19 | I | Remaining lease/chunk time too short | Start next probe | Dispatch refused/yielded with reason; no abandoned provider work. |
| R04-20 | I | 30 valid no-AIO fixtures | Run worker and summarize | Healthy collection/zero trigger; unavailable conditional score is explicit. |
| R04-21 | D | Evidence write fails after provider response | Persist result | Evidence incompleteness remains durable; result is not represented as fully auditable. |
| R04-22 | I | Unknown schema appears during canary | Evaluate monitoring | Parser-drift alert includes version/shape metadata without secrets or full private payload. |
| R04-23 | L | Fixed authorized India corpus | Collect/manual compare | Real capture, AIO state, citations, and requested market recorded; mismatch is investigated, not auto-passed. |
| R04-24 | L | Real query with no AIO at observation time | Collect and inspect evidence | Valid SERP supports no-AIO; low trigger is not labeled transport failure. |

**How to test:** Parse committed provider-shape fixtures, then use a local HTTP server capable of hanging headers/body and returning malformed/challenge responses. Fake time handles retry timing; a real bounded integration test proves abort behavior. D uses the QA evidence store. Live cases require dated matching observations and record natural variation; a later Google answer is not assumed identical.

**Repair acceptance:** All 24 pass; A01/A10 are corrected, every terminal shape is classified, and deadlines cover body/configuration fetches. A new unknown schema blocks qualification while raw evidence survives for repair.

## R05. Fix denominator invariance and sample eligibility

**Current status:** Core metric/qualification propagation merged; brand-free observed panels now retain exposure zero. The legacy vendor-eliciting exploratory index remains separate. Pre-answer purpose, clustered uncertainty and frozen context/cohort integration are implemented in this follow-on; independent entity-resolution/calibration and full acceptance remain open.

**Priority/dependencies:** P0; R03/R04 and agreed R08 labels. **Primary code:** `scoring/enginePipeline.js`, analytics rollups, normalization, dashboard metrics/export. **Regressions:** A02–A04.

### Implementation tasks and subtasks

1. **Write and version the metric contract.**
   - [x] R05.1a Define mention, citation, recommendation, conditional share, trigger, completion, and observed exposure separately.
   - [x] R05.1b Store numerator, denominator, unit, panel/surface/policy version, collection window, and exclusion reasons for each value.
2. **Freeze eligibility before observing answers.**
   - [x] R05.2a Classify panel intent in advance; do not drop brand-free answers to improve a headline.
   - [x] R05.2b Resolve entities independently of the selected rival list; preserve citation-only evidence in the appropriate metric. Registered identity/text/owned-host evidence is resolved before roster display; generic/short aliases remain ambiguous, and the entity-policy boundary prevents mixed/historical comparisons from qualifying.
3. **Implement qualification and uncertainty.**
   - [x] R05.3a Apply distinct-prompt minimum and collection gate to the metric's actual denominator, not a larger answered pool.
   - [x] R05.3b Keep raw exploratory ratios labeled; compute suitable confidence intervals and cluster repeated observations by prompt.
4. **Make comparisons compatible.**
   - [x] R05.4a Freeze cross-engine cohort/weights; reject incompatible panel, surface, market, model-policy, and metric versions.
   - [x] R05.4b Backfill only from surviving evidence; preserve original historical values and show version boundaries.
5. **Propagate one calculation everywhere.**
   - [x] R05.5a Use shared metric DTOs in storage, rollups, API, dashboard, history, and export.
   - [x] R05.5b Add numerical examples to methodology; separate rounded display from unrounded stored counts.

### Test plan — 24 named cases

| Case | Level | Given / fixture | When | Exact pass condition |
|---|---|---|---|---|
| R05-01 | U | Six self mentions among 30 valid answers | Calculate mention rate | 6/30 = 20%; all 30 remain in the declared panel. |
| R05-02 | U | Same answers, add unmentioned rival | Recalculate | Self mention/citation values and denominators unchanged. |
| R05-03 | U | Same answers, remove tracked rival | Recalculate | No jump caused by selected roster metadata. |
| R05-04 | U | One owned citation, no self text mention | Calculate | Citation numerator one; mention zero; declared combined visibility counts the citation. |
| R05-05 | U | Thirty answers, only one eligible recommendation | Qualify headline | Raw 1/1 may be displayed exploratory; qualified headline is null/insufficient. |
| R05-06 | U | Actual denominator 19 then 20 distinct prompts | Apply v1 sample gate | Exact boundary respected; all other qualification conditions also required. |
| R05-07 | U | One prompt repeated 30 times | Apply sample gate | Distinct-prompt count one; replicates cannot unlock a headline. |
| R05-08 | U | 29/30 valid versus 28/30 valid | Apply 95% collection gate | First clears collection gate; second fails; raw counts remain visible. |
| R05-09 | U | Zero eligible observations | Calculate ratios | Null with reason; no 0/0 coercion or fabricated zero. |
| R05-10 | U | Twenty valid eligible answers, zero mentions | Calculate | Measured raw zero; qualified zero only if every gate passes. |
| R05-11 | U | Thirty brand-free answers in fixed mention panel | Calculate | Mention rate zero; answers are not removed after observation. |
| R05-12 | U | No citation telemetry | Calculate citation rate | Unknown citation measurement, not verified uncited zero. |
| R05-13 | U | Negative mention and separate recommendation label | Calculate | Mention increases; positive-recommendation numerator does not. |
| R05-14 | U | Duplicate ingestion / retries | Calculate denominator | Each logical observation counted once. |
| R05-15 | U | Randomized valid counts | Property-check ratios | Bounds 0–100, numerator ≤ denominator, stable rounding, null only for declared reasons. |
| R05-16 | U | Complete baseline versus correlated replicates | Estimate uncertainty | Replicates do not masquerade as independent prompt samples; seed/method recorded. |
| R05-17 | I | One frozen engine fails | Calculate index | Missing engine is explicit; no silently comparable reweighted historical headline. |
| R05-18 | I | Panel/market/surface version changes | Compute delta | Incompatible comparison suppressed with specific boundary reason. |
| R05-19 | D | Re-run same daily rollup | Persist metrics | Idempotent counts/value/version; no duplicated observations. |
| R05-20 | D | Historical row lacks raw evidence | Backfill | Legacy/unknown preserved; no invented denominator or modern qualified score. |
| R05-21 | I | Stored counts and contradictory percentage | Read/validate DTO | Contradiction is rejected or flagged; display cannot silently prefer the flattering field. |
| R05-22 | B | Insufficient but high raw ratio | Open report | Counts, confidence/quality label, and withheld headline visibly agree. |
| R05-23 | B | Measured zero versus unknown | Compare report/export | Zero and unavailable are distinct on screen and in machine data. |
| R05-24 | I | Same scan across finalizer/API/UI/export | Compare values | Numerator, denominator, units, versions, and qualification state match exactly. |

**How to test:** Start with hand-calculated golden fixtures, then seeded property tests. Exercise real rollup storage and browser displays. Replay the A02–A04 inputs against corrected calculations. Test raw data equality before display rounding and verify historical boundary annotations.

**Repair acceptance:** All 24 pass; no selected-roster dependence for self metrics; no citation-only disappearance; no unqualified tiny-sample 100%. Publish the versioned formulas, proposed thresholds, uncertainty method, migration rules, and evidence of matching API/UI/export outputs.

## R06. Preserve provenance through every adapter

**Current status:** Core envelope propagation merged. Full context, observed-model accuracy and private evidence lifecycle are not yet accepted.

**Priority/dependencies:** P1; shared contract lands alongside R01/R02. **Primary code:** `engines/openRouterProbe.js`, `openai.js`, `perplexity.js`, `scoring/enginePipeline.js`, prompt-result storage and export. **Regression:** A11.

### Implementation tasks and subtasks

1. **Define a versioned observation envelope.**
   - [x] R06.1a Include observation/attempt IDs, requested/returned model, gateway, surface, requested/observed location, language/device/session policy, and capture window.
   - [x] R06.1b Add search state (`observed_used/observed_not_used/unknown`), parser version, provider request ID, evidence identities, and cost source/state.
2. **Remove field-dropping wrappers.**
   - [ ] R06.2a Return the shared envelope from direct and gateway paths; validate at adapter and persistence boundaries.
   - [x] R06.2b Preserve actual response identity separately from request configuration; never substitute requested model as observed model.
3. **Persist field quality.**
   - [x] R06.3a Add nullable columns/JSON schema and explicit reasons for unavailable fields; migrate without inventing historic values.
   - [x] R06.3b Retain provenance when an answer or citation leg fails independently and when the engine later retries.
4. **Protect evidence access and retention.**
   - [ ] R06.4a Keep raw captures private; scope signed access to the owning workspace/observation and record expiration.
   - [ ] R06.4b Redact secrets/private session artifacts before export; report retention deletion as expired evidence, not missing historical measurement.
5. **Surface the method to users.**
   - [ ] R06.5a Display model API versus consumer capture and location-verification state beside the observation.
   - [ ] R06.5b Include versioned provenance in exports and compatibility checks, including legacy unknowns.

### Test plan — 16 named cases

| Case | Level | Given / fixture | When | Exact pass condition |
|---|---|---|---|---|
| R06-01 | U | Fully populated provider envelope | Validate schema | Every field/unit accepted; IDs and versions remain stable. |
| R06-02 | U | Requested model differs from returned | Normalize | Both identities retained; actual model is not overwritten. |
| R06-03 | U | No response model | Normalize | Observed model unknown with reason; request model remains separately available. |
| R06-04 | U | Search telemetry absent versus explicit zero | Normalize | Unknown and observed-not-used remain distinct. |
| R06-05 | I | ChatGPT gateway fixture | Run wrapper → probe | Model, request ID, search usage, capture time, and cost state survive; A11 corrected. |
| R06-06 | I | Perplexity direct/gateway variants | Run both paths | Same contract; native-search capability is not fabricated per-request usage telemetry. |
| R06-07 | I | Answer survives failed citation leg | Persist observation | Answer evidence retained; citation quality unknown/failed independently. |
| R06-08 | I | Timed-out body after request ID received | Record failure | Request identity and partial evidence survive without claiming a complete answer. |
| R06-09 | D | Envelope round trip through database | Save/read/export | Exact provenance values and null reasons retained; no JSON-field loss. |
| R06-10 | D | Legacy rows without metadata | Apply migration | Fields remain unknown/legacy; no present-day model or timestamp invented. |
| R06-11 | D | Tenant B names A's evidence object | Request signed access | Denied; no object key or signed URL leaked. |
| R06-12 | I | Provider body contains fake secret/header/cookie | Produce logs/export | Forbidden values absent; safe category/request ID remains. |
| R06-13 | D | Evidence retention expires | Read historical observation | Measurement survives; evidence is explicitly expired with retention date/reason. |
| R06-14 | B | API and browser observations side by side | Inspect details | Surface/method/location state visible; API row never labeled browser capture. |
| R06-15 | I | Timestamp ordering invalid | Validate envelope | Invalid interval flagged/rejected; no negative duration or invented correction. |
| R06-16 | I | Retry uses different provider/model | Finalize/export history | Each attempt preserves its identity; incompatible measurement change is flagged. |

**How to test:** Round-trip the same rich fixture through actual adapters, storage mappers, and export; compare a canonical metadata object. Use real QA Storage/RLS for D evidence access. Browser-check method labels and evidence-expiry behavior.

**Repair acceptance:** All 16 pass; no wrapper loses required fields; unknown remains unknown; customer-facing evidence access is tenant-scoped. Schema rollback preserves raw envelopes and historical traceability.

## R07. Repair sample isolation and cardinality

**Current status:** Sample manifest/isolation code merged. Eight named browser cases remain required; offline guards do not prove sessionStorage/navigation effects.

**Priority/dependencies:** P1; R03/R05 contracts. **Primary code:** `src/data/mockData.js`, `services/api.js`, dashboard/sample routes, `/demo`, content/scan action handlers. **Regression:** A06.

### Implementation tasks and subtasks

1. **Create one immutable sample manifest.**
   - [x] R07.1a Assign 30 fixed unbranded prompt IDs, four surfaces, fixed illustrative time, fictional entities, and a simulation origin.
   - [x] R07.1b Generate 120 observation rows from the Cartesian product; keep diagnostics optional and separate.
2. **Preserve sample metadata through normalization.**
   - [x] R07.2a Support sample flags in raw and already-normalized inputs, storage/handoff, refresh, and export.
   - [ ] R07.2b Compute sample metrics with the current contract; counted-engine labels and headline eligibility must agree.
3. **Isolate sample effects.**
   - [x] R07.3a Guard rerun, generation, publication, history, schedules, and provider calls at both UI and service boundaries.
   - [x] R07.3b Offer explicit navigation to a real scan rather than converting a synthetic record into real history.
4. **Make sample status unmistakable.**
   - [x] R07.4a Render the banner on all sample views and label export/downloads simulated.
   - [x] R07.4b Fix missing-history/first-reading text for samples; never imply a current measurement or actual clients.
5. **Test persistence and transition.**
   - [ ] R07.5a Version sessionStorage sample records and safely invalidate incompatible prior sample shapes.
   - [ ] R07.5b Verify sample-to-real navigation clears only the handoff state and cannot overwrite real reports.

### Test plan — 16 named cases

| Case | Level | Given / fixture | When | Exact pass condition |
|---|---|---|---|---|
| R07-01 | U | Sample manifest | Build rows | 30 unique prompts × four surfaces = 120 unique observations. |
| R07-02 | U | Per-engine sample rows | Compare prompt IDs | Each surface contains the same 30 IDs, not an 8/8/7/7 partition. |
| R07-03 | U | Raw sample with `isSample` | Normalize | Sample marker and fixed illustrative timestamp survive; A06 corrected. |
| R07-04 | U | Already-normalized sample | Normalize again | Idempotent fields, flags, counts, and metrics. |
| R07-05 | U | Sample metric fixture | Calculate summaries | Counted engines and displayed qualified headline satisfy R05; no contradictory zero-engine score. |
| R07-06 | I | Fake clock advanced by one day | Rebuild same sample | Illustrative timestamp stays fixed; it does not become “just measured.” |
| R07-07 | I | Sample route with network/write spies | Load and change views | Zero vendor, real-history, scheduling, and content mutation requests. |
| R07-08 | I | Forged sample action bypasses disabled UI | Invoke service action | Service boundary rejects real effects; no DB/provider call. |
| R07-09 | B | Landing-page sample link | Open dashboard | Prominent simulation banner and fictional-brand context visible immediately. |
| R07-10 | B | Sample loaded | Refresh and navigate Answers/Sources/Studio | Sample identity persists; no view loses the banner. |
| R07-11 | B | Sample 120 observations | Filter each surface | Each filter reports 30; all totals reconcile. |
| R07-12 | B | Sample export | Download report | Simulation label, fixed time, and 120 rows preserved. |
| R07-13 | B | Sample page | Try rerun/generate/publish | No real effect; allowed transition clearly leads to real-scan setup. |
| R07-14 | B | Real report already stored, then sample opened | Return to real report | Real identity/data remain intact; no sample written into real history. |
| R07-15 | B | Old/corrupted sample sessionStorage | Reload dashboard | Safe sample reset or explicit unavailable state; no crash or fake live report. |
| R07-16 | B | Narrow viewport and keyboard navigation | Inspect sample controls/banner | Label remains readable and keyboard-accessible; no hidden actionable real controls. |

**How to test:** Use actual browser sessionStorage and reloads; server-render tests alone cannot close R07. Intercept all vendor/mutation routes and assert zero requests. Compare sample export against the manifest rather than copying the displayed score into expectations.

**Repair acceptance:** All 16 pass; 120 observations demonstrate the real worklist shape; synthetic data cannot spend money or enter production history. Keep a versioned screenshot and exported sample as acceptance artifacts.

## R08. Separate recommendation, first mention, and sentiment

**Current status:** Core judge integration merged. Corpus calibration belongs to R09 and is not established by synthetic relationship fixtures.

**Priority/dependencies:** P1; R06; agree labels before R05 implementation. **Primary code:** `scoring/judge.js`, `aliases.js`, extraction schemas, result-brand storage, report labels. **Regression:** A05.

### Implementation tasks and subtasks

1. **Define independent labels.**
   - [x] R08.1a Store mentioned, relationship (`recommended/compared/discouraged/incidental/uncertain`), first mention order, and explicit list rank separately.
   - [x] R08.1b Attach text span offsets/hash, confidence, judge method/version, and null reasons; avoid inventing a rank when none exists.
2. **Resolve entities conservatively.**
   - [ ] R08.2a Use approved company/product aliases, verified domains, boundaries, and ambiguity context; support collisions and reused product names.
   - [ ] R08.2b Distinguish quoted user questions, source titles, and answer assertions so echoing a brand is not a recommendation.
3. **Classify relationships using evidence.**
   - [x] R08.3a Scope negation/comparison to the correct entity and clause; retain deterministic fast paths where demonstrably accurate.
   - [ ] R08.3b Escalate uncertain cases to a schema-validated model/human path; unsupported evidence causes abstention, not a confident invented label.
4. **Make sentiment contextual.**
   - [x] R08.4a Score entity-specific statements and mixed sentiment; do not borrow praise/criticism from nearby rivals.
   - [x] R08.4b Keep absent sentiment null and explicit negative distinct; document numeric mapping if retained.
5. **Deploy labels without rewriting history.**
   - [ ] R08.5a Version new labels, annotate old position semantics, and update every “rank” label/export consumer.
   - [ ] R08.5b Compare against R09 human evidence before qualifying the output; retain original text and legacy interpretation.

### Test plan — 20 named cases

| Case | Level | Given / fixture | When | Exact pass condition |
|---|---|---|---|---|
| R08-01 | U | “Acme is my recommendation.” | Judge Acme | Mentioned/recommended with valid supporting span; no fabricated list rank. |
| R08-02 | U | “Avoid Acme; choose Rival.” | Judge both | Acme discouraged, Rival recommended; Acme first mention is not recommendation rank 1. |
| R08-03 | U | “Acme is not recommended.” | Classify negation | No positive recommendation; negated predicate preserved. |
| R08-04 | U | “Acme is not a bad option.” | Judge | Contextual/uncertain treatment follows rubric; token counts alone cannot classify negative. |
| R08-05 | U | “Acme and Rival offer similar features.” | Judge | Compared/neutral, not an invented sole winner. |
| R08-06 | U | “Rival is excellent; Acme is unreliable.” | Judge sentiment | Praise/criticism assigned to the correct entity, with separate spans. |
| R08-07 | U | Numbered list with Acme at 3 | Extract rank | Explicit list rank 3 retained separately from first mention order. |
| R08-08 | U | Unranked paragraph | Extract rank | List/recommendation rank null with reason; first occurrence order may remain. |
| R08-09 | U | Generic English word matching brand alias | Resolve entity | Ambiguous common-word usage abstains or rejects without corroboration. |
| R08-10 | U | Substring in another company name | Detect mention | No false whole-brand match. |
| R08-11 | U | Approved product alias | Resolve entity | Correct canonical company/product identity, no duplicate self appearances. |
| R08-12 | U | Brand name only in quoted user question | Judge answer | Echo/quotation is not a positive answer recommendation. |
| R08-13 | U | Owned URL citation, no brand text | Judge | Citation measured separately; textual mention remains false. |
| R08-14 | U | Missing brand in answer | Judge sentiment/order | Mention false; sentiment and order null. |
| R08-15 | U | Mixed positives and limitations | Judge | Mixed/contextual result per rubric; rationale spans cover both statements. |
| R08-16 | I | Classifier returns invalid JSON / unsupported entity | Validate fallback | Schema/evidence error or abstention; no invented positive label enters storage. |
| R08-17 | I | Source text contains instructions to favor brand | Judge source as data | Instructions do not change labels absent supporting answer evidence. |
| R08-18 | D | New and legacy judge versions | Persist/read history | Semantics/version preserved; old first mention is not relabeled recommendation rank. |
| R08-19 | B | Negative-first fixture report | Inspect answer and metrics | Negative label and evidence visible; no “top recommendation” claim for Acme. |
| R08-20 | B | Uncertain/mixed/absent fixtures | Inspect filter/export | Distinct states preserved; null never becomes neutral certainty. |

**How to test:** Golden sentence fixtures exercise the exact production judge, not a legacy helper. Validate spans against immutable text and property-test offsets. Use model substitutes for fallback failures; evaluate actual label quality separately under R09. Browser-check semantic labels and sorting.

**Repair acceptance:** All 20 pass; A05 cannot produce a false recommendation; labels have valid evidence and version semantics. Quality targets in R09 must pass before presenting classifier conclusions as qualified metrics.

## R09. Calibrate the production judge and metric contract

**Current status:** Tooling implemented; real calibration and manual decisions remain open.

**Priority/dependencies:** P1; R05/R08. **Primary code:** calibration runner/schema/fixtures, production judge import, evaluation reports. This replaces legacy-helper-only calibration with an auditable evaluation.

### Implementation tasks and subtasks

1. **Define the evaluation protocol before tuning.**
   - [ ] R09.1a Freeze label rubric, inclusion/exclusion rules, uncertain handling, primary metrics, and proposed pass thresholds in a versioned protocol.
   - [ ] R09.1b Register the production function/config under evaluation; prevent a toy/legacy judge from satisfying release checks.
2. **Build a permitted corpus.**
   - [ ] R09.2a Initial target: 240 real permitted answers, 60 per offered surface; keep negative/ambiguous/brand-free and citation-only strata.
   - [ ] R09.2b Split by prompt cluster and near-duplicate content into 120 development, 60 calibration, and 60 locked holdout answers, balanced across surfaces. Store hashes; synthetic stress fixtures remain separately labeled.
3. **Establish human ground truth.**
   - [ ] R09.3a Two independent reviewers label the corpus using the rubric, blinded to classifier output; adjudicate disagreements and log reasons.
   - [ ] R09.3b Store entity-level labels/spans, reviewer/protocol versions, uncertainty, and source consent; answers and entity-label rows have separate counts.
4. **Measure the real system.**
   - [ ] R09.4a Report precision/recall/F1/confusion, abstention coverage, and intervals overall and by surface/class/ambiguity stratum.
   - [ ] R09.4b Tune on development/calibration only; lock holdout access and report every evaluated model/config rather than cherry-picking one favorable run.
5. **Set release decisions and maintenance.**
   - [ ] R09.5a Proposed point targets: entity mention precision/recall ≥95% overall, ≥90% per surface, relationship macro-F1 ≥90%; zero false positive recommendations on the explicit-negation safety fixture set.
   - [ ] R09.5b Require at least ten positive and ten negative held-out entity decisions for each claimed binary metric; otherwise mark that slice insufficient. Publish intervals and counts; meeting a point target is not proof of population accuracy. Re-evaluate on model/parser/policy changes.

### Test plan — 18 named cases, plus a separately counted 240-answer corpus

| Case | Level | Given / fixture | When | Exact pass condition |
|---|---|---|---|---|
| R09-01 | U | Label missing explicit boolean | Validate corpus | Rejected with field/row reason; absence cannot mean not mentioned. |
| R09-02 | U | Mention false but rank supplied | Validate label | Contradictory label rejected; no silent normalization. |
| R09-03 | U | Uncertain label without explanation | Validate | Rejected until uncertainty reason is documented. |
| R09-04 | U | Duplicate result/entity pair | Validate manifest | Duplicate rejected; corpus size not inflated. |
| R09-05 | U | Near-duplicate answers/prompt clusters | Split corpus | No cluster spans tuning and holdout sets. |
| R09-06 | U | Missing surface/class support | Evaluate adequacy | Insufficient slice; no extrapolated all-surface accuracy claim. |
| R09-07 | I | Legacy judge substituted | Execute calibration command | Runner rejects wrong production target/version. |
| R09-08 | I | Known confusion matrix | Calculate metrics | Exact hand-calculated precision/recall/F1 and intervals match selected method. |
| R09-09 | I | Abstentions on hard cases | Evaluate | Coverage and conditional accuracy both reported; abstentions do not disappear. |
| R09-10 | I | Repeated holdout IDs modified | Re-run evaluation | Locked hash mismatch fails; prior holdout remains auditable. |
| R09-11 | I | Threshold met overall, failed one surface | Decide release | Claimed surface fails; aggregate score cannot conceal it. |
| R09-12 | I | Missing live-permitted source records | Build evaluation | Corpus acquisition blocked/unverified; synthetic answers cannot be relabeled real. |
| R09-13 | M | Complete corpus and rubric | Independent dual labeling | Each answer has two reviewer decisions and valid evidence; disagreements explicitly adjudicated. |
| R09-14 | M | Disagreement sample | Review resolution | Rubric rationale recorded; no reviewer simply copies model output. |
| R09-15 | M | Locked holdout | Approve evaluation protocol | Reviewer confirms split, support counts, thresholds, and no tuning leakage. |
| R09-16 | I | Production model/judge config changes | Evaluate compatibility | Prior qualification invalidated or re-evaluation required; no stale pass reused. |
| R09-17 | M | Real evaluation report | Sign off user-facing claims | Claims name evaluated population/surfaces, counts, date, and uncertainty. |
| R09-18 | I | Explicit A01–A05 stress inputs | Run corrected regressions | Correct behavior asserted; old unwanted outcomes fail acceptance. |

**How to test:** Run schema/metric/runner U/I checks offline. Collect/label corpus through approved evidence workflows and record M decisions; then run the production judge on frozen sets. Use bootstrap by prompt cluster or another documented valid interval method, seeded and reproducible. The initial 240-answer target is acquisition/labeling work, not 240 additional automated acceptance scenarios or guaranteed statistical power.

**Repair acceptance:** All 18 scenarios plus corpus/protocol evidence complete; proposed thresholds pass for every advertised slice with adequate support. Unsupported language/market/class claims remain unqualified. No source-grounded human labels means this repair remains open regardless of synthetic test success.

## R10. Make geography, language, device, and surface explicit

**Current status:** New helpers implemented; complete production wiring remains open. The P0 observation context freezes the existing geo value, not the entire R10 contract.

**Priority/dependencies:** P1; R06. **Primary code:** `engines/serpGeo.js`, all engine adapters, checkpoint schema, UI/export filters.

### Implementation tasks and subtasks

1. **Freeze the requested measurement context.**
   - [x] R10.1a Add country/city where supported, language, device, surface, and session policy to panel/observation identity.
   - [ ] R10.1b Validate supported codes and explicit defaults; record inherited versus user-selected values.
2. **Map context through each adapter.**
   - [ ] R10.2a Remove hardcoded country assumptions; assert actual outgoing parameters for direct, gateway, and native-Sonar branches.
   - [ ] R10.2b Maintain a capability matrix: unsupported controls remain unsupported, never silently promised.
3. **Distinguish requests from observations.**
   - [ ] R10.3a Record provider attestation/egress verification separately from requested location; retain coarse evidence and age.
   - [ ] R10.3b Keep UI language, query language, model locale, and egress country distinct when they cannot be equated.
4. **Preserve compatibility and recovery.**
   - [x] R10.4a Resume with frozen context even if deployment defaults change; do not rescue failures by switching countries.
   - [x] R10.4b Block cross-context trend comparisons and mark fallback surfaces explicitly.
5. **Verify offered markets.**
   - [ ] R10.5a Run a small authorized check of India and one non-India configuration for supported adapters.
   - [ ] R10.5b Publish only verified capability statements, with limitations for provider routing/personalization.

### Test plan — 16 named cases

| Case | Level | Given / fixture | When | Exact pass condition |
|---|---|---|---|---|
| R10-01 | U | Valid India context | Resolve defaults | Explicit stored `in` plus language/surface policy; no missing identity dimensions. |
| R10-02 | U | Valid non-India context | Resolve | User selection retained; no unconditional India override. |
| R10-03 | U | Invalid/blank country or language | Validate | Documented default or explicit rejection with provenance; never an unlabeled guess. |
| R10-04 | I | Non-India Google observation | Capture outgoing request | Country/language/device parameters match frozen context. |
| R10-05 | I | Non-India ChatGPT direct/gateway | Capture both requests | Supported location control matches context; unknown observed location stays unknown. |
| R10-06 | I | Native Sonar branch | Prepare request | Supported location passed correctly or explicitly unsupported; omission is not labeled verified India. |
| R10-07 | I | Gateway ignores location control | Parse response | Requested context retained; observed context unverified, not assumed equal. |
| R10-08 | U | Device/session policy differs | Build observation keys | Distinct identities and comparison cohorts. |
| R10-09 | I | Defaults change after checkpoint | Resume | Original frozen context used; change does not rewrite in-flight identity. |
| R10-10 | I | India provider failure with US fallback available | Recover | No silent US substitution; failure/fallback is explicit and incompatible. |
| R10-11 | D | Same prompt/date, different markets | Persist observations | Both coexist without overwrite; tenant/context keys remain unique. |
| R10-12 | U | Requested/observed countries disagree | Qualify | Mismatch flag prevents verified-location claim; investigation evidence retained. |
| R10-13 | B | Unverified country fixture | Inspect report | “Requested India; location unverified” or equivalent accurate label visible. |
| R10-14 | B | Switch report market/surface | Inspect trend/export | Incompatible histories separated; selected context appears in export. |
| R10-15 | L | Authorized India collection | Verify context | Coarse provider/egress evidence supports offered claim or records unverified; no raw IP leaked publicly. |
| R10-16 | L | Supported non-India collection | Verify request and observation | Actual control/evidence documented; unsupported behavior fails capability qualification. |

**How to test:** Assert request payloads for every adapter branch, not merely checkpoint fields. Use real DB key tests and UI filtering. Live checks compare requested context with available provider/egress evidence; answer text mentioning India is not proof of Indian egress.

**Repair acceptance:** All 16 pass; context is stable end to end, capabilities are explicit, and no requested parameter is promoted to observed fact. Rollback keeps market/surface boundaries in existing records.

## R11. Recover continuous measurement

**Current status:** Policy helpers implemented; durable scheduled-window production integration and real seven-day soak remain open.

**Priority/dependencies:** P1; R01–R06/R10. **Primary code:** scheduler and worker routes, `scan_schedules`, scan-run ledger, health/alerts. **Problem:** both inspected schedules were disabled; a cron heartbeat did not establish a recurring baseline.

### Implementation tasks and subtasks

1. **Define an intentional schedule.**
   - [ ] R11.1a Configure an owned/authorized QA brand, fixed panel/context, cadence/timezone, surfaces, request/spend ceiling, and start/end dates.
   - [ ] R11.1b Keep customer scheduling opt-in; show enabled/off/paused and next due/last successful measurement separately.
2. **Make dispatch durable.**
   - [x] R11.2a Claim each scheduled window atomically; use a schedule-window idempotency key and immutable panel/context snapshot.
   - [x] R11.2b Implement bounded catch-up for missed windows and clear policy for overlapping active scans; do not create a dispatch storm.
3. **Measure schedule fulfillment.**
   - [ ] R11.3a Record due, claimed, started, finalized, delayed, missed, and blocked events with actual times.
   - [ ] R11.3b Alert on missed due work or stale successful measurement, not merely missing process heartbeats.
4. **Prove unattended recovery.**
   - [ ] R11.4a Run without browser polling; inject worker restart, delayed cron, provider block, and lease expiry.
   - [ ] R11.4b Resume eligible work without generating new panels or duplicate scheduled scans.
5. **Perform a seven-day soak.**
   - [ ] R11.5a Pre-register every scheduled opportunity and evaluate the full elapsed window, including outages.
   - [ ] R11.5b Proposed soak gates: ≥95% valid observations per surface across seven days, no day below 90%, no unexplained missing window; per-report headline gate remains R05's stricter 95% collection. Do not confuse AIO trigger with collection success.

### Test plan — 18 named cases

| Case | Level | Given / fixture | When | Exact pass condition |
|---|---|---|---|---|
| R11-01 | U | Disabled customer schedule | Scheduler ticks | No job created; off/no-work state accurately recorded. |
| R11-02 | U | Due schedule in Asia/Kolkata | Resolve next window | UTC dispatch and displayed local due time agree across midnight. |
| R11-03 | U | Supported DST timezone transition | Resolve cadence | Declared duplicate/missing-local-time policy applied once; no unbounded retry. |
| R11-04 | U | Three missed windows | Calculate catch-up | Bounded policy; missed windows retained, not silently erased. |
| R11-05 | D | Two cron invocations, same window | Race schedule claims | One scheduled scan identity; second records duplicate/no-op. |
| R11-06 | D | Active scan overlaps next due window | Dispatch | Explicit defer/skip policy and reason; no duplicate active work. |
| R11-07 | D | Panel changes after scheduled claim | Resume scan | Original panel/context snapshot retained for that window. |
| R11-08 | I | Healthy cron heartbeat, no completed scan | Assess operational health | Successful-measurement alert triggers independently of heartbeat. |
| R11-09 | I | Provider circuit opens | Process scheduled scan | Blocked outcome and affected surface reported; work does not loop endlessly. |
| R11-10 | I | Daily spend cap reached | Dispatch next due work | No excess call; blocked/missed disposition keeps scheduled denominator. |
| R11-11 | D | Worker killed after partial committed batch | Restart | R02 recovery preserves results and window identity. |
| R11-12 | B | No browser polling client | Start via QA scheduler and later open report | Server completes independently; durable report available after reload. |
| R11-13 | B | Paused schedule | Inspect settings/history | Enabled state, next due policy, and last measurement remain truthful. |
| R11-14 | I | Duplicate notification evaluations | Evaluate same missed window | One incident/alert identity; recovery closes it with evidence. |
| R11-15 | S | Seven real scheduled days | Collect all offered surfaces | Every window accounted for; aggregate ≥95% valid per surface and no day below 90%. |
| R11-16 | S | Planned worker restart during soak | Continue monitoring | No unexplained missed/duplicated window; recovery duration and outcomes recorded. |
| R11-17 | S | Natural AIO absence during soak | Evaluate quality | No-AIO contributes valid collection; trigger rate reported independently. |
| R11-18 | S | Soak evidence includes failures/gaps | Generate release summary | Full scheduled denominator used; outages cannot be removed retrospectively to meet target. |

**How to test:** Unit scheduling uses fake time; D tests real concurrent claims. Browser tests deliberately stop polling. Then run `--repair R11 --suite soak --days 7` over real time. Thirty prompts × seven days = 210 observations per surface; four surfaces create 840, excluding separately counted diagnostics/canaries/retries. At least 200/210 valid clears the aggregate 95% gate. Budget that workload before starting; an incomplete funded window is blocked, not passed.

**Repair acceptance:** All 18 pass, including seven elapsed days. Attach window ledger, per-day/per-surface quality, latency, failures, cost uncertainty, and incident recovery. Turning on a schedule alone does not close R11.

## R12. Validate consumer collection before advertising it

**Priority/dependencies:** P1; R01–R06/R10, coordinated with R11. **Primary code:** `worker/src/lib/probe.js`, collector integration, extractors, canaries, evidence storage, engine capability registry.

### Implementation tasks and subtasks

1. **Choose and document the collection route.**
   - [ ] R12.1a Compare a managed collector and/or maintained browser adapter using the same fixed corpus, market, evidence contract, and cost envelope.
   - [ ] R12.1b Record supported consumer surfaces and session modes; separate service-delivered browser captures from direct model-API responses.
2. **Implement the actual adapter.**
   - [ ] R12.2a Submit the exact frozen prompt in a fresh conversation; wait for answer completion and collect text, citations, and permitted capture evidence.
   - [ ] R12.2b Detect navigation/challenge/login/timeouts, partial answers, schema drift, and unsupported surfaces. Record blocks; do not bypass access barriers.
3. **Maintain extraction and evidence fidelity.**
   - [ ] R12.3a Preserve visible answer order, footnotes/source links, final versus streaming text, model/surface evidence, and capture timing.
   - [ ] R12.3b Validate provider-returned evidence belongs to the requested observation; prevent cross-prompt/session leakage.
4. **Integrate operational controls.**
   - [ ] R12.4a Use R02 queue/leases/cost controls, bounded concurrency, cancellation, and typed outcomes.
   - [ ] R12.4b Keep API research as a separate labeled surface; never substitute it silently when consumer collection is blocked.
5. **Qualify the collector with observations.**
   - [ ] R12.5a Run an initial three-day trial, then a seven-day acceptance window for ChatGPT, Perplexity, and Google AIO; offered Gemini needs the same qualification before a consumer claim.
   - [ ] R12.5b Manually compare at least ten preselected captures per surface on days 1, 4, and 7 (90 comparisons for three surfaces); include citation/access failures. Store variation/mismatch reasons, not guaranteed matching personalized answers.

### Test plan — 20 named cases

| Case | Level | Given / fixture | When | Exact pass condition |
|---|---|---|---|---|
| R12-01 | U | Completed saved consumer response | Extract | Text/order/citations match the approved fixture. |
| R12-02 | U | Streaming/incomplete saved response | Extract | Partial state; no premature complete-answer qualification. |
| R12-03 | U | Saved login/challenge/CAPTCHA surfaces | Classify | Correct access outcome; no answer fabricated and no barrier-bypass action. |
| R12-04 | U | No AIO on valid Google capture | Extract | Valid-no-AIO, independent of collection failure. |
| R12-05 | I | Managed service returns wrong prompt ID | Ingest | Rejected/quarantined; result cannot attach to another observation. |
| R12-06 | I | Current adapter stub selected | Validate capability | Consumer capability remains unavailable until real execution exists. |
| R12-07 | I | Consumer path blocked; API available | Apply fallback policy | No silent substitution; explicit distinct API research result if separately requested. |
| R12-08 | I | Collector retries / delayed delivery | Persist | One logical observation, immutable attempts, correct late-result fencing. |
| R12-09 | B | Fresh consumer conversation | Submit prompt | Exact prompt used once; no preceding conversation contamination. |
| R12-10 | B | Two unrelated prompt contexts | Collect sequentially | Outputs/evidence bind to correct context; no previous-brand leakage. |
| R12-11 | B | Answer completes with source drawer | Collect citations | Visible supporting references captured with canonical observation identity. |
| R12-12 | B | User/login/access intervention required | Execute adapter | Safe blocked/handoff state; no unsupported automatic completion. |
| R12-13 | B | Consumer UI layout changes | Run saved/live QA variant | Unknown extraction fails visibly; empty text is not a non-mention. |
| R12-14 | I | Collector exceeds request/spend/time ceiling | Dispatch | Further calls refused; incomplete work explicit and billable uncertainty retained. |
| R12-15 | L | Offered consumer ChatGPT surface | Run bounded real probes | Actual consumer evidence returned; model API output cannot satisfy the case. |
| R12-16 | L | Offered consumer Perplexity surface | Run bounded real probes | Answer and citation evidence captured; API/consumer identities distinct. |
| R12-17 | L | Google India SERP surface | Run bounded real probes | Market status, valid AIO/no-AIO, and provider/access errors correctly recorded. |
| R12-18 | M | Preselected 90 capture comparisons | Compare visible content to stored extraction | No critical wrong-prompt, invented-text, or lost-recommendation error; material citation mismatch investigated before qualification. |
| R12-19 | S | Three-day candidate trial | Compare reliability/cost/fidelity | Decision report includes all planned work and failure evidence; no unsupported winner claim. |
| R12-20 | S | Seven-day selected collector acceptance | Evaluate R11 quality and evidence | Meets declared collection gates; unresolved material extraction/location failures block consumer advertising. |

**How to test:** Saved UI/payload fixtures establish parser behavior; actual browser tests establish submission/completion handling. Live and soak verify the chosen collection route, not substitutes. Keep session mode/time/location controlled and documented. For manual comparisons, inspect the captured response itself rather than expecting a later personalized replay to be identical.

**Repair acceptance:** All 20 plus real capture comparisons and elapsed soaks complete. Publish the supported surface/session/location matrix, observed failure rate/cost, evidence retention, and operating runbook. A queue heartbeat or fixture extractor alone cannot close R12.

## R13. Replace false-empty dashboard states

**Priority/dependencies:** P1; R03/R06 response contracts. **Primary code:** pinned/brand dashboard pages, `DashboardShell`, customer scan routes, normalization/error mapping.

### Implementation tasks and subtasks

1. **Define a view-state contract.**
   - [x] R13.1a Distinguish loading, available, partial, authentication-required, unavailable/not-found, backend-error, offline, and expired evidence.
   - [x] R13.1b Preserve opaque tenant-denial responses: do not reveal a private scan exists to an anonymous or unrelated customer.
2. **Map route outcomes without dropping errors.**
   - [x] R13.2a Carry status/reason/retry state from fetch through page props instead of converting every non-OK result to `scan: null`.
   - [x] R13.2b Treat malformed successful payloads as a contract error, not as an empty customer account.
3. **Implement recovery actions.**
   - [x] R13.3a Offer sign-in/access guidance or retry appropriate to known state; preserve the current URL and workspace on recovery.
   - [x] R13.3b Do not prescribe another paid scan to repair a report-read outage.
4. **Protect asynchronous transitions.**
   - [x] R13.4a Cancel/ignore stale requests after navigation; avoid briefly rendering another workspace's prior report.
   - [ ] R13.4b Keep public/customer/history/export views consistent in partial/failure states.
5. **Verify visible behavior.**
   - [ ] R13.5a Use a fixture HTTP server to exercise status, latency, disconnect, and recovery sequences.
   - [ ] R13.5b Check keyboard/screen-reader status announcements and mobile layouts, including long error messages.

### Test plan — 16 named cases

| Case | Level | Given / fixture | When | Exact pass condition |
|---|---|---|---|---|
| R13-01 | I | Authorized 200 valid scan | Map response | Available state with scan identity, no false empty. |
| R13-02 | I | 200 malformed payload | Map response | Contract error; never “run your first scan.” |
| R13-03 | I | 500/503 database failure | Map response | Retryable read error preserved; no empty-account claim. |
| R13-04 | I | Network disconnect | Map fetch failure | Offline/retry state; stored report existence not contradicted. |
| R13-05 | I | Tenant-denied 404 versus absent 404 | Map anonymous response | Same non-disclosing unavailable state; no private existence inference. |
| R13-06 | B | Anonymous private-report URL | Open | Generic unavailability/sign-in guidance; no report contents leaked. |
| R13-07 | B | Signed-in authorized user, genuine absent scan | Open | Clear not-found state; existing workspace history remains available. |
| R13-08 | B | Valid report API slow | Wait for response | Loading state persists; no premature empty/error or invented progress. |
| R13-09 | B | Backend failure then recovery | Click retry | Same URL refetched; valid report appears; zero new scan POSTs. |
| R13-10 | B | Session expires during read | Refresh/sign in through authorized flow | Correct access state; return target preserved without leaking other tenant data. |
| R13-11 | B | Fast navigation A → B, A response late | Complete both requests | Only B rendered; late A cannot overwrite current context. |
| R13-12 | B | Partial scan with failed surfaces | Open report | All surface outcomes and collection warning visible; no missing-engine concealment. |
| R13-13 | B | No previous history versus history API failure | View trend | First reading differs from history unavailable; no invented flat trend. |
| R13-14 | B | Evidence signed URL expired | Open evidence | Expired/retry guidance; measurement remains visible and unchanged. |
| R13-15 | B | Narrow viewport/keyboard reader | Trigger error/retry | Message/action readable and focus/status behavior usable. |
| R13-16 | B | Same partial/error report in portal/public shell | Compare | Equivalent quality semantics; access-specific wording does not alter metrics. |

**How to test:** Use actual client fetch/effect behavior with controllable server delays/statuses. Separate anonymous/A/B contexts. Inspect visible content and network logs; source-string assertions cannot establish these states.

**Repair acceptance:** All 16 pass; server denials remain non-disclosing, backend failures never mean no account data, and recovery never creates unintended paid work.

## R14. Add a reviewed buyer-question panel

**Priority/dependencies:** P1; R05/R10. **Primary code:** prompt generation/quality/storage, customer panel routes/UI, panel snapshots and schedule selection.

### Implementation tasks and subtasks

1. **Create a panel schema and provenance model.**
   - [x] R14.1a Store buyer persona, use case, intent, topic, market/language, prompt origin, scoring purpose, reviewer, and version.
   - [x] R14.1b Distinguish actual user evidence, conventional search data, generated suggestions, and licensed panel estimates; preserve confidence/usage rights.
2. **Separate suggestions from approved tracking.**
   - [ ] R14.2a Generate common comparison and engine-appropriate conversational questions without restricting all text to search-bar wording.
   - [ ] R14.2b Review near-duplicates, leading self-brand terms, unsupported intent, and topic imbalance before activation.
3. **Implement review and edits.**
   - [x] R14.3a Support draft, approved, retired, and revised prompt/panel states with a durable change log.
   - [x] R14.3b Freeze the exact approved version for scheduled/in-flight scans; edits create a new version rather than mutating history.
4. **Make panel choice explainable.**
   - [ ] R14.4a Show business relevance and source evidence to the reviewer; require explicit weights if used and justify them before outcomes.
   - [x] R14.4b Preserve informational citation panels separately from recommendation-intent panels; do not retire prompts solely to remove poor brand outcomes.
5. **Test ownership and compatibility.**
   - [ ] R14.5a Scope prompt edits/imports to workspace membership and role; validate imported content/size/encoding.
   - [ ] R14.5b Mark panel-change boundaries in reports; allow like-for-like cohort analysis only with explicit compatible IDs.

### Test plan — 18 named cases

| Case | Level | Given / fixture | When | Exact pass condition |
|---|---|---|---|---|
| R14-01 | U | Generated suggestion | Store provenance | Origin generated; never labeled observed AI-user demand. |
| R14-02 | U | GSC query evidence | Create suggestion | Conventional search origin retained; no inferred AI volume number. |
| R14-03 | U | Conversational question over nine words | Validate panel | Valid contextual buyer question accepted; old length rule cannot reject it alone. |
| R14-04 | U | Self-brand leading question | Add to scoring panel | Rejected/diagnostic-tagged; not silently included as unbranded discovery. |
| R14-05 | U | Near-duplicate paraphrases | Review suggestions | Similarity flagged with explanation; reviewer can retain distinct justified intents. |
| R14-06 | U | Informational and recommendation questions | Classify before collection | Separate purpose/metric eligibility saved before answers exist. |
| R14-07 | U | Weight missing/unjustified | Activate weighted panel | Refused or explicit equal-weight default; no post-result optimization of weights. |
| R14-08 | D | Panel v1 currently scanned | Edit question | v2 created; v1 immutable and original scan unchanged. |
| R14-09 | D | Two simultaneous edits | Save versions | Revision conflict or ordered versions; no silent lost update. |
| R14-10 | D | Tenant B edits A panel | Submit mutation | Denied at API/DB boundaries; no cross-tenant change. |
| R14-11 | I | Unapproved suggestions | Schedule scan | Not tracked until activation; no paid automatic expansion. |
| R14-12 | I | Retired prompt in old report | Load history | Original text/version remains; historical denominator not rewritten. |
| R14-13 | I | Bad encoding/oversized CSV import | Import | Clear row/size errors and atomic/previewed behavior; no partial hidden activation. |
| R14-14 | B | Reviewer edits and approves draft | Activate panel | Approved persona/intent/market/provenance visible and version recorded. |
| R14-15 | B | Panel changed since previous scan | View trend | Compatibility boundary shown; automatic old/new score delta suppressed. |
| R14-16 | B | Poor-performing but relevant prompt | Review retirement | Retiring requires recorded relevance rationale; poor score alone does not mutate history. |
| R14-17 | B | Topic/intent imbalance | Review panel summary | Counts and gaps visible before activation; no fabricated buyer-demand evidence. |
| R14-18 | I | Same approved panel in API/worker/export | Compare | Exact prompt IDs/text/purpose/weights/version preserved across execution. |

**How to test:** Use curated buyer-context examples and counterexamples; property-test identity/version immutability. Execute actual QA import/review routes and real DB authorization. Browser-check draft-to-approved and historical boundary workflows.

**Repair acceptance:** All 18 pass; a reviewer can explain every tracked question's relevance and origin, and panel changes cannot silently inflate visibility or rewrite history.

## R15. Expand technical eligibility beyond robots.txt

**Priority/dependencies:** P1; R06/R10. **Primary code:** crawler audit/SSRF helpers, page fetch/render pipeline, GSC property integration, technical-opportunity UI.

### Implementation tasks and subtasks

1. **Inventory and prioritize URLs.**
   - [ ] R15.1a Select owned product/service/evidence pages from sitemap/internal links and approved inputs; record discovery source and canonical candidates.
   - [x] R15.1b Limit crawl depth/requests and honor the target audit scope; do not mistake a homepage-only check for site-wide eligibility.
2. **Collect URL-level facts.**
   - [ ] R15.2a Record status/redirect chain, robots path rules, meta/X-Robots directives, snippet controls, canonical, meaningful text, and internal discovery.
   - [ ] R15.2b Compare source HTML/rendered content where relevant; distinguish fetch visibility from actual search indexing.
3. **Check structured data and access context.**
   - [ ] R15.3a Parse supported structured data and check visible-content consistency; do not label markup as a guaranteed AI ranking boost.
   - [ ] R15.3b Separate search crawlers from training controls and allowlisting from an observed verified crawler fetch.
4. **Integrate first-party evidence where available.**
   - [ ] R15.4a Inspect authorized property/indexing information and effective generative-AI inclusion controls using currently supported API/UI/export methods.
   - [x] R15.4b Treat inaccessible property settings as unverified, not excluded; retain property inheritance and capture date.
5. **Produce evidence-backed repairs.**
   - [ ] R15.5a Emit target URL, observed issue, engine relevance, severity/confidence, owner, suggested action, and retest conditions.
   - [ ] R15.5b Preserve SSRF protection on DNS resolution and every redirect; display stale/missing evidence separately from a clean result.

### Test plan — 24 named cases

| Case | Level | Given / fixture | When | Exact pass condition |
|---|---|---|---|---|
| R15-01 | U | Robots wildcard/path allow-disallow | Evaluate URL | Correct most-specific applicable permission with rule evidence. |
| R15-02 | U | GPTBot blocked, OAI-SearchBot allowed | Evaluate search access | ChatGPT search not falsely blocked by training preference. |
| R15-03 | U | Missing robots file, HTTP 404 | Assess | Missing file recorded; no invented universal crawl block. |
| R15-04 | U | Meta noindex versus HTTP X-Robots | Combine directives | Restrictive applicable directive retained with source; not overwritten by a permissive duplicate. |
| R15-05 | U | nosnippet/max-snippet/data-nosnippet | Assess preview eligibility | Exact restriction recorded; no guaranteed inclusion prediction. |
| R15-06 | U | Canonical to another URL | Assess | Target/canonical mismatch reported; selected Google canonical remains unknown without evidence. |
| R15-07 | U | Matching structured data and visible text | Validate | Consistency passes; no fabricated ranking entitlement. |
| R15-08 | U | Hidden unsupported structured-data claims | Validate | Mismatch highlighted with field/path evidence. |
| R15-09 | I | Redirect loop / excessive hops | Fetch page | Bounded failure; full safe chain retained. |
| R15-10 | I | Public URL redirects to private address | Follow redirect | SSRF refusal before private fetch; clear scope/access error. |
| R15-11 | I | DNS changes to private IP | Resolve/fetch | Guard blocks unsafe resolved target; no metadata/service access. |
| R15-12 | I | 200 empty HTML versus meaningful page | Extract main content | Empty/insufficient content distinguished; no clean eligibility verdict. |
| R15-13 | I | JS-dependent page | Compare HTML/render fixture | Missing source text exposed; rendered finding does not prove all bots can render it. |
| R15-14 | I | 403 WAF response for bot | Fetch under audit policy | Access-block evidence, not noindex or no-AIO. |
| R15-15 | I | No internal links to important page | Build scoped link graph | Discovery gap supported by actual crawled scope; whole-site absence not overclaimed. |
| R15-16 | I | Sitemap declares URL returning 404 | Audit | URL/status mismatch and owner action emitted. |
| R15-17 | I | Inclusion control inaccessible | Read authorized-property state | Unverified, not excluded or included by assumption. |
| R15-18 | I | Inherited exclusion fixture | Resolve property control | Effective exclusion and inheritance evidence retained. |
| R15-19 | B | Multiple URL issues | Inspect opportunity | Each URL, evidence time, engine relevance, and retest action visible. |
| R15-20 | B | Stale audit and fresh audit conflict | View history | Both timestamps visible; fresh verified fact used without erasing history. |
| R15-21 | L | Authorized owned page | Fetch current technical evidence | Real status/directives/canonical/text recorded with scope and time. |
| R15-22 | L | Authorized Search Console property | Inspect available indexing evidence | Observed first-party state retained; API/UI/export method and limitations explicit. |
| R15-23 | M | Property inclusion setting and inheritance | Verify with owner-authorized access | Effective setting/date documented or remains unverified; no silent settings change. |
| R15-24 | L | Observed crawler request/log evidence | Verify fetch | Permission differs from verified successful access; authenticity/evidence quality recorded. |

**How to test:** Run a local HTTP fixture site containing all directives/redirect/WAF/content variants. Use a local renderer where needed and a DNS/fetch seam for SSRF tests. Deduced eligibility never substitutes for live first-party indexing evidence. L/M operate on an authorized property; unavailable access remains a release limitation for that feature.

**Repair acceptance:** All 24 pass; recommendations identify real URLs and evidence rather than generic bot checklists. Missing training access, robots files, or schema cannot be represented as proof of AI exclusion. Retest confirms the specific repaired directive/access behavior, not a guaranteed ranking gain.

## R16. Build source/page opportunities with verified evidence

**Priority/dependencies:** P1; R05/R06/R14/R15. **Primary code:** `analytics/gaps.js`, citation enrichment/stats, content work orders, source/opportunity views.

### Implementation tasks and subtasks

1. **Retain discovery signals without overstating them.**
   - [ ] R16.1a Join observed answers, citations, entities, prompts, surfaces, and dates by durable observation ID.
   - [x] R16.1b Label co-occurrence as a hypothesis; separate cited sources from actually observed retrieval and generated research suggestions.
2. **Verify the source page.**
   - [x] R16.2a Fetch a permitted page snapshot; record final URL/canonical, status, date/hash, and relevant quoted passage with offsets.
   - [x] R16.2b Verify the alleged competitor/client claim in the page itself; unavailable, paywalled, changed, or ambiguous content remains unverified.
3. **Classify actionable work.**
   - [ ] R16.3a Choose owned-page update, missing original proof, access repair, factual correction, or legitimate external opportunity.
   - [ ] R16.3b Store mechanism, owner, target URL, confidence, supporting observations, expected effect, and retest window. Outreach recommendations do not send messages.
4. **Prioritize without false authority claims.**
   - [ ] R16.4a Use repeat frequency, intent relevance, evidence quality, affected prompts, and estimated effort; publish score components/units.
   - [ ] R16.4b Deduplicate syndicated/canonical pages and repeated citation deliveries; do not call a gap score causal influence or universal source authority.
5. **Connect action to review and outcomes.**
   - [x] R16.5a Allow a reviewer to accept/dismiss/correct a hypothesis, retaining its evidence version.
   - [ ] R16.5b Create work orders only from reviewed evidence and route completed changes to R18/R19 observations.

### Test plan — 18 named cases

| Case | Level | Given / fixture | When | Exact pass condition |
|---|---|---|---|---|
| R16-01 | U | Rival mentioned in answer citing unrelated page | Discover opportunity | Co-occurrence hypothesis only; no assertion publisher recommends rival. |
| R16-02 | U | Snapshot explicitly discusses rival | Verify passage | Exact supporting passage/hash captured; claim scope matches text. |
| R16-03 | U | Citation without observed retrieval telemetry | Classify source relation | Cited status retained; retrieval is unknown rather than invented. |
| R16-04 | U | Repeated citation deliveries | Aggregate frequency | One logical observation contribution; no duplicate inflation. |
| R16-05 | U | Canonical and tracking variants | Group sources | Deterministic grouping with originals retained; no unrelated-page merging. |
| R16-06 | U | One observation versus repeated days | Score confidence | Evidence count/window visible; one hit cannot masquerade as repeated support. |
| R16-07 | U | Candidate owned page exists | Choose action | Existing-page update considered; new article not unconditional default. |
| R16-08 | I | Page fetch blocked/paywalled | Verify source | Unverified reason; no fabricated passage or claim of page absence. |
| R16-09 | I | Page changed since original capture | Compare snapshots | Both times/hashes retained; current evidence cannot silently rewrite past answer support. |
| R16-10 | I | Source text instructs models to recommend brand | Extract supporting facts | Instructions treated as source data, not authority to change scoring or trigger actions. |
| R16-11 | I | No reliable pages available | Create work order | Evidence gate blocks qualified factual action or marks exploratory; no invented support. |
| R16-12 | D | Tenant B requests A opportunity/source | Query/mutate | Denied; private snapshots and action notes scoped correctly. |
| R16-13 | D | Same evidence/action imported twice | Upsert opportunity | One versioned action identity; history not duplicated or erased. |
| R16-14 | B | Verified versus hypothesis rows | Inspect source detail | Status, passage, original answer, date, and confidence visibly distinct. |
| R16-15 | B | Reviewer dismisses incorrect rival claim | Save decision | Reason retained; dismissed claim no longer generates qualified work. |
| R16-16 | B | Reviewer accepts owned-page improvement | Create brief | Work order includes actual target/evidence/version/owner and expected mechanism. |
| R16-17 | I | External-source opportunity accepted | Process action | Draft task only; no unsolicited outreach or account mutation. |
| R16-18 | I | Source selection changes | Recompute priority/export | Components and evidence version explain change; historical action remains reproducible. |

**How to test:** Use local snapshots containing confirmed, absent, ambiguous, changing, and malicious claims. Assert joins and quote offsets directly; use real QA DB ownership tests. Browser-check reviewer decisions and the generated work order. No real outreach is needed for acceptance.

**Repair acceptance:** All 18 pass; every qualified opportunity has verifiable evidence and a concrete mechanism. Unverified co-citation cannot become a factual publisher claim or an automatic publishing/outreach instruction.

## R17. Require source quality and recheck every changed draft

**Priority/dependencies:** P1; R06/R16. **Primary code:** content research/benchmark/fact-check/review steps, `contentWorker.js`, checkpoints, schemas, human revision routes.

### Implementation tasks and subtasks

1. **Persist the research evidence contract.**
   - [ ] R17.1a Store source snapshots, skipped-source reasons, capture/freshness dates, supporting claims, and approved first-party client facts.
   - [x] R17.1b Define blocking inputs versus exploratory-only work; zero supported facts cannot silently fall back to general knowledge for a factual client draft.
2. **Bind checks to exact content.**
   - [x] R17.2a Hash the draft plus relevant fact/source versions; store each check's input hash, verdict, issues, and evidence references.
   - [x] R17.2b Invalidate checks after any substantive draft/fact/source change, including automatic and human-requested revisions.
3. **Verify claims independently.**
   - [ ] R17.3a Extract factual claims and map support/contradictions; competitor pages cannot establish the client's own prices/specifications.
   - [ ] R17.3b Handle stale, conflicting, inaccessible, or insufficient evidence with explicit unresolved issues and appropriate review routing.
4. **Make revision/check execution resumable.**
   - [ ] R17.4a Run fact-check on each changed draft before final review; checkpoint completed checks by content hash.
   - [ ] R17.4b Resume an unchanged verified draft without repaying for checks; enforce combined per-item budgets across revisions/retries.
5. **Protect human approval.**
   - [ ] R17.5a Display unresolved claims, failed source fetches, and cost/quality limitations to the reviewer.
   - [x] R17.5b Require approval for the exact checked draft version; an old approval cannot authorize a new changed body.

### Test plan — 20 named cases

| Case | Level | Given / fixture | When | Exact pass condition |
|---|---|---|---|---|
| R17-01 | U | Supported current client fact | Validate claim | Support references correct source/version/span. |
| R17-02 | U | Competitor price supplied as client fact | Validate | Unsupported client claim flagged; no source substitution. |
| R17-03 | U | No research sources or approved facts | Enter qualified drafting | Blocked or explicitly exploratory; cannot present a sourced final artifact. |
| R17-04 | U | Stale source beyond fact-specific policy | Validate | Freshness issue visible; stale price not treated as current. |
| R17-05 | U | Conflicting source assertions | Validate | Conflict retained for resolution; no arbitrary model certainty. |
| R17-06 | U | Draft hash changes | Read old check | Previous verdict invalidated; cannot inherit pass. |
| R17-07 | U | Source/fact version changes, body unchanged | Validate check identity | New evaluation required where relevant; dependency hash detects change. |
| R17-08 | I | Automatic second draft adds new specification | Execute loop | Fresh fact-check precedes final review; old first-cycle verdict not reused. |
| R17-09 | I | Human revision introduces unsupported price | Execute revision route | New check flags it; final approval screen shows issue. |
| R17-10 | I | Check provider fails/returns invalid schema | Continue pipeline | Check unverified/failed; no pass or silent skip. |
| R17-11 | I | Research scrape fails for two of three pages | Build research pack | Exact completeness/reasons persisted and visible downstream. |
| R17-12 | I | Untrusted source contains instruction injection | Research/draft/check | Source instructions cannot override client facts, approval gates, or evidence rules. |
| R17-13 | D | Worker crashes after checked draft checkpoint | Resume | Same hash/check reused once; no duplicate artifact or lost cost history. |
| R17-14 | D | Concurrent revision and approval | Commit decisions | Stale version approval rejected; only exact current checked version approvable. |
| R17-15 | I | Item budget reached before recheck | Execute revision | Pipeline stops with budget/unchecked state; no unverified approved output. |
| R17-16 | D | Tenant B requests A research snapshot | Read source/claim record | Access denied; snapshots and facts scoped correctly. |
| R17-17 | B | Draft has unresolved claims | Open reviewer screen | Evidence, missing facts, and limitations visible beside affected claims. |
| R17-18 | B | Reviewer edits approved text | Save edited draft | Approval/check status invalidated; new version returns through review. |
| R17-19 | B | Failed source retrieval after draft creation | Inspect artifact/export | Source completeness survives display/export; no “fully fact-checked” claim. |
| R17-20 | I | Healthy sourced revision cycle | Run through human gate | Research → changed draft → new check → review → awaiting approval recorded in order. |

**How to test:** Inject deterministic draft/research/check outputs into the actual worker, including all revision paths. Assert call order and hash-specific checkpoint identity. D tests race approval against edits. Browser-check unresolved claim presentation; a simulated passing model verdict alone does not prove real factual quality, which also requires R09-style evaluation/reviewer evidence.

**Repair acceptance:** All 20 pass; no changed draft inherits stale checks/approval; unsupported sources and spend stops remain visible. Keep an acceptance trace showing first draft, automatic revision, human revision, and the separate checks for each.

## R18. Distinguish approval, publication, indexing, and observed citation

**Priority/dependencies:** P1; R17/R15. **Primary code:** publish route/verification, content stage/coverage helpers, publication events, observation links, additive migrations.

### Implementation tasks and subtasks

1. **Separate editorial and search states.**
   - [x] R18.1a Keep draft/checked/approved states separate from publication, discoverability, indexing, verified crawl, and observed citation facts.
   - [ ] R18.1b Rename “covered” if it means editorial coverage; expose lifecycle evidence rather than one optimistic status.
2. **Verify the submitted live page.**
   - [x] R18.2a Capture approved version/hash, submitted/final/canonical URL, page body evidence, status, and verification time.
   - [ ] R18.2b Require meaningful content match, not title alone; define reviewable tolerance for editorial changes and approved external publishing domains.
3. **Make publication recording atomic.**
   - [x] R18.3a In one transaction/RPC write the publication event/URL/version and item/job transition, with an idempotency key.
   - [x] R18.3b Fail/reconcile if evidence/event storage cannot complete; never acknowledge a durable published state with no recoverable URL join.
4. **Observe downstream states independently.**
   - [ ] R18.4a Schedule bounded indexing/crawl/citation observation; record observed time/source and unknown states.
   - [ ] R18.4b Link only exact/compatible page and prompt versions; publication does not itself assert indexing or AI citation.
5. **Handle retries and subsequent edits.**
   - [ ] R18.5a Retry recording safely without duplicate events; preserve withdrawn/redirected/changed page history.
   - [x] R18.5b This ticket records/verifies publication at a submitted URL. It does not claim to deploy to a CMS; any future CMS action needs its own delivery/outbox contract.

### Test plan — 20 named cases

| Case | Level | Given / fixture | When | Exact pass condition |
|---|---|---|---|---|
| R18-01 | U | Approved draft, no live URL | Compute coverage/state | Editorial approved only; not published/indexed/cited. |
| R18-02 | U | Title matches, unrelated body | Verify page match | Rejected/unverified; matching title alone insufficient. |
| R18-03 | U | Approved meaningful body, edited title | Verify within declared tolerance | Match accepted or sent to documented review; no arbitrary title-only failure. |
| R18-04 | I | URL returns 404/403/challenge | Verify publication | Failure/access state; no published transition. |
| R18-05 | I | Redirect to unsafe/private host | Fetch page | SSRF refusal; no forbidden request or publication. |
| R18-06 | I | Unauthorized external domain | Submit publication URL | Ownership/approved-domain policy rejects or requires review; no false owned-page claim. |
| R18-07 | D | Valid approved version and verified page | Commit publication | Event/URL/item/job version committed together. |
| R18-08 | D | Event insertion fails | Commit transaction | All local state rolls back; published success not returned. |
| R18-09 | D | Item/job update fails | Commit transaction | No orphan publication event or contradictory statuses. |
| R18-10 | D | Client repeats same idempotency key | Retry recording | Same result/event; no duplicate publication. |
| R18-11 | D | Two requests race for same item version | Commit | One logical publication or explicit conflict; no duplicate outcome joins. |
| R18-12 | D | Body edited after approval | Publish stale version | Rejected; exact current approved/checked version required. |
| R18-13 | D | Tenant B names A item | Publish/read event | Denied with no item existence/content leakage. |
| R18-14 | I | Live page contains noindex | Record downstream eligibility | Publication can be observed; indexed/search-eligible state stays false/unknown with evidence. |
| R18-15 | I | URL becomes redirected/withdrawn later | Reobserve | New dated observation; original publication event retained. |
| R18-16 | I | Indexing evidence absent | Show lifecycle | Unknown/not observed; no implied indexed/cited success. |
| R18-17 | B | Approved but unpublished item | View coverage | Editorial coverage labeled; search gap not declared fixed. |
| R18-18 | B | Verified publication, no crawl/citation yet | View lifecycle | Published separate from unobserved downstream states. |
| R18-19 | B | Transaction fails and retry offered | Retry from UI | No false success toast; eventual event/state reconcile exactly once. |
| R18-20 | B | Later compatible answer cites published page | Inspect evidence chain | Specific observation/date/source linked; citation recorded without claiming causality. |

**How to test:** Serve approved/unrelated/redirected pages from the local fixture site. Test transaction failure points and races against real QA PostgreSQL/Supabase. Browser tests operate on QA publication records; no real external content publication is necessary. Verify every event joins a durable URL and approved version.

**Repair acceptance:** All 20 pass; publication/URL/event recording cannot split; editorial progress cannot masquerade as search impact. Rollback preserves publication events and leaves unobserved indexing/citation states explicit.

## R19. Repair attribution and first-party reporting

**Priority/dependencies:** P1; R05/R11/R14/R18. **Primary code:** `scoring/contentLift.js`, analytics rollups/reporting, GSC ingest/sync, referral/conversion adapters and views. **Regression:** A09.

### Implementation tasks and subtasks

1. **Replace the legacy impact input.**
   - [ ] R19.1a Read versioned mention/citation/recommendation counts and observation IDs; remove dependence on obsolete per-row `prompt_score`.
   - [ ] R19.1b Join publication/change IDs, exact URLs/versions, treatment prompt clusters, surfaces, markets, and observation windows.
2. **Define valid comparisons before results.**
   - [ ] R19.2a Pre-register baseline/post windows and comparison cohorts; flag panel/model/parser/market changes and insufficient observations.
   - [ ] R19.2b Report matched-panel differences and uncertainty; preserve missingness and control trends. Observational differences do not prove causal lift.
3. **Connect first-party data honestly.**
   - [ ] R19.3a Ingest authorized GSC and permitted referral/conversion data with pagination, watermarks, generations, and source types.
   - [x] R19.3b Verify current dedicated Google generative-AI report/API/export capabilities during implementation; conventional search rows cannot be relabeled AIO-specific.
4. **Resolve attribution and data quality.**
   - [ ] R19.4a Normalize landing URLs/canonical policy, known assistant referrers, event dedupe, timezone, currency/units, and delayed corrections.
   - [ ] R19.4b Preserve unknown/direct/referrer-stripped journeys and incomplete imports; count observed referrals rather than asserting total AI influence.
5. **Deliver an auditable report.**
   - [ ] R19.5a Show raw counts, compatible cohorts, publication/change history, exclusions, pipeline freshness, and qualified interpretation.
   - [ ] R19.5b Export machine-readable provenance; refresh/correct imports idempotently without modifying historical raw events.

### Test plan — 24 named cases

| Case | Level | Given / fixture | When | Exact pass condition |
|---|---|---|---|---|
| R19-01 | U | Baseline 10/30, post 16/30, compatible panel | Calculate difference | +20 percentage points from current metrics; no legacy score required. |
| R19-02 | U | Compatible measured zero baseline/post | Calculate | Real zeros retained; no conversion to unknown. |
| R19-03 | U | No pre-publication observations | Calculate lift | Null/insufficient baseline with reason; no fabricated zero baseline. |
| R19-04 | U | Changed panel/surface/market/policy | Compare | Incompatible estimate withheld; boundary/exclusions explicit. |
| R19-05 | U | One prompt has many repeated runs | Estimate uncertainty | Prompt clustering respected; repeats do not inflate independent sample count. |
| R19-06 | U | Treatment/control both improve | Compare cohorts | Both trends and descriptive adjusted difference shown; causal claim not automatic. |
| R19-07 | U | Publication occurs mid-day | Assign windows | Exact timezone/cutoff policy applied; pre-change observations not counted post-change. |
| R19-08 | U | Owned URL tracking/canonical variants | Join change to landing page | Stable documented mapping; unrelated pages cannot merge. |
| R19-09 | I | Current engine rows lack prompt_score | Compute impact report | Uses actual current counts/labels; A09 corrected. |
| R19-10 | I | Conventional GSC date/query rows | Ingest/report | Labeled conventional search; no fabricated AIO-specific impressions. |
| R19-11 | I | Dedicated generative report unavailable | Select reporting source | Feature remains unavailable/manual-export with provenance; no synthetic substitute. |
| R19-12 | I | Paginated import with final empty page | Ingest | All unique rows imported; truthful truncation/watermark state. |
| R19-13 | D | Import page fails after earlier committed pages | Retry sync | Idempotent recovery; successful watermark does not advance past missing data. |
| R19-14 | D | OAuth disconnect/reconnect changes generation | Load metrics | Stale in-flight writes rejected; correct property/generation ownership. |
| R19-15 | D | Tenant B requests A GSC/referral data | Read/export | Access denied; tokens/property data remain private. |
| R19-16 | D | Duplicate conversion/referral event | Ingest twice | One event/value contribution; transaction IDs scoped correctly. |
| R19-17 | U | Google organic referral only | Classify source | Not automatically labeled AI Overview traffic. |
| R19-18 | U | Known assistant versus missing referrer | Classify | Known observed assistant visits counted; missing remains unattributed. |
| R19-19 | I | Late provider correction | Reimport overlap | Corrected aggregate with source history; no double counting. |
| R19-20 | I | GSC/referral source missing or stale | Render report | Freshness/coverage warning and null metrics; no fake traffic growth. |
| R19-21 | B | Compatible improvement plus partial provider failure | View outcome | Raw/matched counts and quality visible; improvement not unqualified. |
| R19-22 | B | Outcome screen/export | Compare datasets | Same counts/units/windows/exclusions; interpretation distinguishes association and causality. |
| R19-23 | L | Authorized first-party property | Perform bounded read/import | Real property/source/date/page evidence stored; unavailable access remains blocked. |
| R19-24 | L | Owned QA landing session and permitted analytics source | Validate attribution observation | Actual observed session/landing/event reconciles, or latency/limits recorded without invented results. |

**How to test:** Use hand-calculated before/after datasets, late corrections, incompatible panels, duplicate events, and explicit missing data. Test SQL joins/idempotency in QA and adapters with controlled OAuth/import failures. Live cases use authorized first-party reads/test traffic, not a claim of real ranking improvement. A client impact study needs its own real observation window beyond these test fixtures.

**Repair acceptance:** All 24 pass; current rows support actual impact calculations; sources/units are honest; compatible cohorts and uncertainty are inspectable. No conventional Google referral or missing referrer can inflate measured AI traffic. Real ranking gains remain a separately evidenced outcome.

## R20. Repair Perceev's own public-site foundation

**Current status:** Technical indexing foundation merged; public proof, real study and deployment qualification remain open.

**Priority/dependencies:** P2; sample work R07; methodology publication depends on qualified R05/R12 behavior. **Primary code:** app metadata/routes, robots/sitemap, hostname configuration, marketing/sample/methodology/use-case pages.

### Implementation tasks and subtasks

1. **Establish public URL policy.**
   - [ ] R20.1a Confirm the configured preferred production hostname; map aliases/preview deployments and canonical/redirect behavior explicitly.
   - [x] R20.1b Set per-page metadata and absolute canonical URLs without treating robots rules as access control.
2. **Implement discovery and indexing intent.**
   - [x] R20.2a Serve valid robots/sitemap routes listing intended public URLs, actual update dates, and correct hostnames.
   - [x] R20.2b Define portal/account/private-report/preview indexing behavior while preserving real authentication and public report access policy.
3. **Publish accurate product evidence.**
   - [ ] R20.3a Explain sampling, surfaces, locations, failure handling, denominators, and limits based on implemented/deployed/qualified states.
   - [ ] R20.3b Provide focused use cases and substantiated comparisons; verify every competitive claim when authored and never invent clients/results.
4. **Create a defensible owned-site study.**
   - [ ] R20.4a Pre-register prompts, baseline, site changes, capture method, and evaluation window for an authorized property.
   - [ ] R20.4b Publish measured results/failures/uncertainty only after observation; an attractive mock chart cannot satisfy the study.
5. **Verify release behavior.**
   - [ ] R20.5a Check rendered metadata, mobile/keyboard discovery, public navigation, and sample labeling on the production-like build.
   - [ ] R20.5b After deployment perform bounded read-only checks of preferred/alias URLs and authorized Search Console evidence.

### Test plan — 16 named cases

| Case | Level | Given / fixture | When | Exact pass condition |
|---|---|---|---|---|
| R20-01 | U | Preferred hostname/page path | Generate canonical | Correct absolute production URL; no preview/local hostname leakage. |
| R20-02 | U | Public URL inventory | Generate sitemap | Only intended indexable URLs; valid locations and non-invented lastmod dates. |
| R20-03 | U | Public/private/preview route policies | Generate directives | Declared indexing intent matched; robots is not represented as authentication. |
| R20-04 | I | Production build | Fetch robots/sitemap | HTTP 200 and valid text/XML with correct host references. |
| R20-05 | I | Preferred and alias URL requests | Inspect status/canonical policy | Consistent chosen host policy; no redirect loop or contradictory canonical. |
| R20-06 | I | Private portal/account/report route | Check access and metadata | Actual access controls retained independently of indexing directives. |
| R20-07 | I | Capability not consumer-qualified | Build marketing claim data | Consumer capture claim withheld or explicitly limited; registry flags alone do not qualify it. |
| R20-08 | B | Homepage and focused product pages | Navigate desktop/mobile | Useful content/navigation accessible; no broken core links or unreadable controls. |
| R20-09 | B | Public page metadata | Inspect rendered document | Unique relevant title/description/canonical and visible content agreement. |
| R20-10 | B | Sample opened from marketing CTA | Inspect sample | R07 banner/cardinality/guards intact; no fictitious client proof. |
| R20-11 | M | Methodology/comparison drafts | Fact-check claims | Each material claim supported/currently verified; simulated or projected outcomes labeled. |
| R20-12 | M | Proposed owned-site study | Review protocol/results | Real authorized baseline/change/window and complete evidence; no invented success case. |
| R20-13 | L | Deployed preferred hostname | Fetch important public URLs | Current statuses/canonical/robots/sitemap match approved policy. |
| R20-14 | L | Deployed alias/preview hostname | Read-only check | Alias/preview indexing policy actually applied; no conflicting public canonical. |
| R20-15 | L | Authorized property evidence available | Verify discovery/indexing observations | Actual Search Console state recorded; sitemap submission alone not labeled indexing success. |
| R20-16 | B | Keyboard-only user, narrow viewport | Follow product → methodology → scan/sample | All essential links/actions usable with truthful destination and no inaccessible gate. |

**How to test:** Generate metadata/sitemaps from known inventories; test the built application over HTTP and in a browser. M reviews inspect citations and study evidence. L checks verify deployed behavior. Separate website engineering completion from the later measured study: if the study is missing, the public proof deliverable stays open.

**Repair acceptance:** All 16 pass; public technical intent and claims agree with deployed capability; methodology/sample content is accurate. Missing robots/sitemap repairs establish discovery hygiene, not guaranteed rankings.

## R21. Consolidate production contracts, documentation, and release checks

**Current status:** Bootstrap implemented; release acceptance remains open. Dedicated P0 SQL checks run separately from the generic runner and must not be presented as complete DB-suite/release acceptance.

**Priority/dependencies:** P2 cleanup, with test-harness bootstrap performed first. **Primary code:** package scripts, `.github/workflows/ci.yml`, registry/legacy scoring modules, docs/contracts/runbooks, QA inventory/runner.

### Implementation tasks and subtasks

1. **Bootstrap the execution harness before other repairs.**
   - [ ] R21.1a Implement the shared runner/modes, manifests, evidence schema, fixture registry, QA environment allowlisting, and budget guards defined above.
   - [ ] R21.1b Validate all 404 case IDs against test/evidence registrations. An absent test mapping is unimplemented, not a pass.
2. **Map the executing architecture.**
   - [ ] R21.2a Trace actual scan, scoring, content, customer, export, and scheduled execution imports; identify legacy-only/test-only paths explicitly.
   - [ ] R21.2b Select one production engine registry and metric DTO; keep temporary compatibility adapters documented with removal conditions.
3. **Remove dead paths safely.**
   - [ ] R21.3a Delete unused registries/scorers after import/runtime verification; migrate consumers before removal.
   - [x] R21.3b Preserve old data readers/version boundaries; historical values cannot silently adopt the new formulas.
4. **Make checks establish behavior.**
   - [ ] R21.4a Register U/I/D/B/L/M/S jobs; expose skips/blocks and aggregate release evidence without `continue-on-error` laundering.
   - [ ] R21.4b Exercise targeted semantic mutations: inverted quality gate, dropped sample flag, retry success marked incomplete, bypassed tenant filter. Required tests must detect the wrong behavior.
5. **Reconcile documentation and operations.**
   - [ ] R21.5a Update README/runtime/config examples, surface matrix, metric contracts, migration runbook, and operator incident actions.
   - [ ] R21.5b Distinguish proposed/implemented/deployed/qualified status. Run final scan → evidence → reviewed change → verified publication → later compatible observation acceptance on QA/authorized data.
6. **Control rollout and rollback.**
   - [ ] R21.6a Canary additive changes, dual-read/shadow calculations where possible, and retain forward-compatible old-data readers.
   - [ ] R21.6b Test rollback with in-flight work, new schema rows, and historical reports; rollback never rewrites evidence or claims a prior release passed new gates.

### Test plan — 18 named cases

| Case | Level | Given / fixture | When | Exact pass condition |
|---|---|---|---|---|
| R21-01 | U | Unknown repair/suite or empty test selection | Execute runner | Nonzero invalid/unimplemented result; zero tests cannot be reported passed. |
| R21-02 | U | Duplicate/missing case registration | Validate inventory | Exact inventory error; per-ticket counts reconcile to 404 unique scenarios. |
| R21-03 | I | QA runner given production DB identity | Start D/B suite | Refused before any write; a `qa` flag alone cannot bypass identity verification. |
| R21-04 | I | Paid/live call in offline suite | Execute test | Network/budget guard fails test before dispatch; no hidden provider dependency. |
| R21-05 | I | Required DB/browser/live suite skipped | Aggregate release | Release unverified/failed; skips visible and never counted as passes. |
| R21-06 | I | New test file outside default glob | Validate manifest/CI discovery | Explicit job or failure; orphaned required test cannot disappear. |
| R21-07 | I | Quality gate intentionally inverted in isolated mutation | Run targeted tests | At least one relevant behavioral test fails for the changed semantics. |
| R21-08 | I | Sample marker removed / citation metadata dropped | Run targeted mutations | R07/R06 tests fail, not merely a source-string guard. |
| R21-09 | D | Tenant filter bypass mutation in QA copy | Execute cross-tenant checks | Forbidden read/write detected; test fails with no production effect. |
| R21-10 | I | Dead scorer removed after consumer migration | Build/run fixtures | Executing path intact; no runtime/import regression or hidden fallback. |
| R21-11 | U | Advertised versus qualified engine matrix | Validate claim config | No advertised qualified capability without required evidence/version. |
| R21-12 | D | New schema, old reader/worker rollback | Exercise compatibility | Old compatible paths read safely or refuse explicitly; no silent data loss. |
| R21-13 | D | In-flight new attempt during rollback | Stop/restore worker path | Lease/evidence retained; duplicate or abandoned work explicitly reconciled. |
| R21-14 | M | Updated README/contracts/runbooks | Review against source/deployment | Status and commands accurately identify implemented versus deployed/qualified work. |
| R21-15 | B | Complete QA workflow | Scan → source action → reviewed publication | Exact versions/identities linked; no bypass of quality or human approval. |
| R21-16 | B | Later compatible observation | Open outcome report | Real linked observation and valid comparison; no synthetic causal success claim. |
| R21-17 | I | Clean supported runtime checkout | Install/build/test/fleet checks | Required jobs pass; runtime/dependencies declared; no reliance on another checkout's modules. |
| R21-18 | M | Complete release evidence package | Sign off deployment readiness | All required cases/soaks/corpus/manual decisions accounted for; unresolved limitations explicitly block affected claims. |

**How to test:** The runner tests itself using dummy fixture suites before running product cases. Use real QA database/process/browser jobs and isolated semantic mutations. Fresh CI checkout must include required history and declared dependencies; record actual supported runtime versions. Run the full release aggregate only after individual evidence exists; do not launch hundreds of paid calls as a default unit test.

**Repair acceptance:** All 18 pass, all affected documents agree with the executing product, and the release gate cannot turn missing evidence into green status. Close bootstrap separately from final consolidation; doing the bootstrap does not close all of R21.

## Cross-repair execution and sign-off

### 1. Bootstrap and contract review

Implement R21.1 first, create the shared fixtures and disposable environment, and review R03/R05/R06/R08/R10 schemas together. Resolve schema dependencies before parallel implementation work; the backlog does not itself authorize or start parallel agents. Record decisions and schema/metric versions.

### 2. Run deterministic repair checks on each change

For the touched repair, run its U/I cases and existing affected tests, then the relevant D/B cases. Verify failures against hand-calculated fixtures and real side effects. A fixed A01–A11 behavior should make the original unwanted-output assertion obsolete; the corrected regression is the gate. Record actual test names beside case IDs so reviewers can trace them.

### 3. Run release integration in a disposable environment

Use two customer accounts/workspaces plus anonymous access; apply the actual migrations and seed only fixture data. Complete: approved 30-question panel → 120 planned unbranded observations for four offered surfaces → fault/retry recovery → truthful report → verified source opportunity → checked/revised draft → human approval → atomic publication recording → later compatible observation → honest outcome/export. Use 136 total planned observations only when the four branded diagnostics are intentionally included per surface, and keep those 16 out of scoring denominators.

Execute both a fully valid collection and injected all-error/partial/blocked cases. Confirm no unintended paid requests, no cross-tenant data, no duplicate events, and no fabricated ranking win. This is end-to-end functional acceptance; it is not a live reliability or ranking study.

### 4. Add real-provider, corpus, and elapsed-time evidence

Run R01/R04/R10/R12 live cases under their request ceilings, R09 labeling/evaluation, R11/R12 real soaks, and authorized R15/R19/R20 property checks. A budget outage or missing customer/property access is a blocked result and remains in the record. Do not mark an affected feature qualified until its required evidence is complete.

### 5. Stage rollout and prove rollback

First deploy additive schema/compatible readers to QA, then canary an owned/authorized workspace with alerts. Compare old/new raw evidence and versioned metric outputs. Exercise worker interruption and rollback before broad cutover. Preserve read access to historical records and queue/attempt evidence. Retire old code only after its replacement is observed operating correctly.

### 6. Close repairs with a reviewable evidence packet

Each repair must contain: implementation change/commit links; migration and compatibility notes; mapped test files/results for every named case; required screenshots/HTTP/SQL/corpus/soak evidence; exact policy version; known limitations; rollback result; and a reviewer decision. Update the checklist as work completes, using separate `implemented`, `automated verified`, `live verified`, `soak verified`, and `release accepted` statuses. Never replace those statuses with one unqualified “done.”

## Traceability from original audit reproductions

| Original evidence | Corrected behavior required | Repairs |
|---|---|---|
| A01 Valid SERPs without AIO become failure | Valid-no-AIO collection; separate trigger/conditional metric | R03/R04/R05 |
| A02 Tiny denominator yields headline 100% | Actual-denominator eligibility and distinct-prompt gate | R05/R09 |
| A03 Citation-only presence disappears | Separate citation/mention metrics preserve evidence | R05/R08 |
| A04 Roster metadata changes self score | Self-metric denominator invariant to tracked rivals | R05/R09 |
| A05 Negative first mention appears rank 1 | Contextual relationships; first mention named accurately | R08/R09 |
| A06 Sample flag disappears | Sample identity/cardinality/effect isolation preserved | R07/R13 |
| A07 All errors still complete | Execution and collection outcomes separate | R02/R03 |
| A08 Failed persisted pairs never retried | Typed durable retry/reconciliation state | R02/R11 |
| A09 Impact needs obsolete prompt_score | Versioned current-metric outcome joins | R18/R19 |
| A10 Final malformed SERP accepted | All attempts meet parser contract, including last | R04 |
| A11 Wrapper drops model/search metadata | End-to-end provenance envelope | R06/R10 |

## Existing audit reproduction commands

These refer to the historical baseline, not the future runner. Use a complete checkout with its own installed dependencies. The original Google Drive source was incomplete during the audit, so a matching separate checkout was used.

```powershell
npm test
npm run build
node scripts/verify-local-product.mjs --output "J:\My Drive\Projects\AEO\docs\audits\2026-10-16\mock-acceptance.json"

node "J:\My Drive\Projects\AEO\docs\audits\2026-10-16\adversarial-reproductions.mjs" `
  --source-root "C:\Users\Vismay\AppData\Local\Temp\perceev-verification-20261016" `
  --output "J:\My Drive\Projects\AEO\docs\audits\2026-10-16\adversarial-results.json"
```

The forensic runner clears credentials in its own process and uses synthetic responses. Successful reproduction means the old unwanted behaviors were observed. `read-only-evidence.mjs` separately reads existing production records through read-only transactions; it is not a live-provider pass or a migration runner. Never print credential values when collecting evidence.
