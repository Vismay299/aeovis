# F01 — Platform foundations: TypeScript, durable jobs, spend guard, provider cache, LLM helper

> <!-- doc-status -->
> **Status: LIVE.** Implementation spec. Not built yet.

| Field | Value |
|---|---|
| ID | F01 |
| Wave | 0 |
| Comparison rows covered | "Backend patterns worth taking": *One metering wrapper with a mandatory price*; *Billed steps never retry; free reads do*; *Scheduler moves the next-run time before starting*; *Soft-expiry cache for expensive research*; *One tool layer … every tool has an output schema checked by a contract test* (contract-test half only; the tool layer is F21/F22) |
| Depends on | none |
| Blocks | F02, F03, F07, F09, F10, F13, F15, F18, F19, F20, F21, F22 (everything that uses §5 of the conventions) |
| Reserved migrations | 040–044 (040 jobs, 041 spend, 042 provider cache, 043 jobs cron; 044 deliberately unused) |
| Feature flag | `FEATURE_JOBS_TICK` (gates the tick route). The spend guard, cache, LLM helper and `safeFetch` are libraries and have no flag. |
| Spend features | `platform.selftest` (the owner-run LLM live check only). Every other `SpendFeature` value is added by its own spec. |
| OpenSEO reference | `openseo:src/server/workflows/*`, `openseo:src/server/lib/dataforseo/client.ts`, `openseo:src/server/billing/subscription.ts`, `openseo:src/server/lib/r2-cache.ts`, `openseo:src/server/lib/openrouter.ts`, `openseo:src/server/lib/audit/url-policy.ts`, `openseo:src/server/mcp/output-schema-contract.test.ts` at `c5f8db1` |

## 1. Summary

F01 gives every later feature the same five building blocks: TypeScript and zod in the repo, one way to authenticate a customer route and return errors, a durable step-based job runner on Postgres (our replacement for Cloudflare Workflows), a spend guard that reserves an estimate before every paid call and settles the real cost after it (OpenSEO's metering seam without Autumn), and a schema-validated provider cache, an OpenRouter LLM helper and an SSRF-safe fetch. Nothing here is customer-visible on its own; it is what makes the 26 feature specs safe to build in parallel without each one reinventing spend control, retries or background work on Vercel.

## 2. What OpenSEO does (observed)

**Durable workflows**

1. Long work runs as Cloudflare Workflows. Each step is `step.do(name, config, fn)`; the engine persists the step's return value and replays it instead of re-running the step when an instance resumes. Steps must return serialisable values (`openseo:src/server/workflows/pgStep.ts:15-28`).
2. Paid steps run exactly once: `SINGLE_ATTEMPT = { retries: { limit: 0 }, timeout: "2 minutes" }` with the comment "Metered and paid steps run once: a retry could post (and bill) twice" (`openseo:src/server/workflows/AiVisibilityWorkflow.ts:29-33`). Free reads retry: `COLLECT_STEP = { retries: { limit: 2, delay: "10 seconds" }, timeout: "5 minutes" }` because "task_get is free" (`AiVisibilityWorkflow.ts:34-39`). A live step is billed per call and also runs once (`AiVisibilityWorkflow.ts:40-43`).
3. Polling waits are explicit sleeps, each under 5 minutes because "the engine cancels an invocation idling in a longer sleep" (`AiVisibilityWorkflow.ts:44-58`, used at `:160-176`).
4. Step names encode the step shape; a renamed step prevents an in-flight run from replaying an output of a different shape across a deploy (`AiVisibilityWorkflow.ts:92-95`).
5. Site-audit step configs give every step an explicit timeout and a small retry budget, because the platform default (10 minutes, several retries) "burned ~65 minutes replaying a doomed step" (`openseo:src/server/workflows/auditStepConfigs.ts:3-10`). Paid Lighthouse calls and lock settlement have `retries: 0` (`auditStepConfigs.ts:30-46`); idempotent persistence retries 3 times with exponential backoff (`:48-52`).
6. A watchdog reconciles runs stuck in `running` whose workflow died without reaching its own `mark-failed` step: OOM/CPU kills or expired instances. It runs every cron tick, oldest first, 100 per batch, with a 10-minute grace for a just-created instance and a 15-minute staleness threshold, and one bad row never stops the sweep (`openseo:src/server/features/audit/services/auditReconciler.ts:25-35`, `:95-130`, `:138-166`). Reads also reconcile lazily (`auditReconciler.ts:7-11`; `aiVisibilityRuns.ts:63-69`).
7. The cron handler runs the watchdog first, holds its failure until the other scheduled work has run, then rethrows (`openseo:src/server.ts:235-259`).
8. One active run per tracker is enforced by a partial unique index (`ai_runs_one_active_idx … WHERE status IN ('queued','running')`, `openseo:src/db/pg/ai-visibility.schema.ts:62-93`). A failed insert is the "already running" signal; the service then checks whether the blocker is stale, reconciles it once and retries (`openseo:src/server/features/ai-visibility/services/aiVisibilityRuns.ts:126-187`).
9. The scheduler advances `nextCheckAt` with a compare-and-set **before** starting the run, "so a tracker that fails or is busy moves on instead of staying due" (`openseo:src/server/features/ai-visibility/services/scheduledAiVisibility.ts:40-53`; CAS at `openseo:src/server/features/ai-visibility/repositories/AiVisibilityRepository.ts:225-243`). Each tick has a 2-minute deadline and an answer budget (`scheduledAiVisibility.ts:9-14`, `:26-39`).
10. Run status carries `pollAfterSeconds` (5 for manual runs, 20 for scheduled: `openseo:src/server/features/ai-visibility/services/aiVisibilityResults.ts:50`).

**Metering and reservations**

11. Every DataForSEO call is wrapped by `meter(customer, fetcher, estimateRawUsd, defaultFeature)`. The estimate is required, "so an entry cannot be added without a price" (`openseo:src/server/lib/dataforseo/client.ts:71-98`).
12. `meterDataforseoCalls` reserves before calling, runs the calls, then settles each hold on the provider-reported cost. A batch shares one hold, and each call is credited separately (`client.ts:321-414`). Failures that DataForSEO did not bill are not charged. An "Invalid Field" failure that was billed is charged, so spend stays visible (`client.ts:365-382`).
13. The calls and the settle are registered with `waitUntil`, so a client disconnect after dispatch cannot skip the deduction (`client.ts:404-413`).
14. Holds are atomic in the billing provider, so concurrent calls cannot all pass on one stale balance reading. A hold has a 30-minute TTL; an orphaned hold releases at the TTL (`openseo:src/server/billing/subscription.ts:209-298`).
15. Settlement never throws: a failed finalize is logged with everything needed to reconcile (`subscription.ts:477-520`). An actual cost above the estimate is logged as `[billing] estimate undershoot` because "an undershoot means a price constant in pricing.ts is stale and the spend bound has a hole" (`subscription.ts:534-542`).
16. When several holds are needed and a later one fails, the earlier ones are released rather than stranded (`subscription.ts:390-397`).
17. Long jobs hold the worst case up front with a long TTL (24 h minus 1 minute) and settle the actual at the end, capped at the hold (`openseo:src/server/lib/audit/rendering-billing.ts:24-26`, `:39-93`, `:110-161`).
18. LLM research cost cannot be known up front, so OpenSEO settles it after the fact from OpenRouter's reported cost (`openseo:src/server/billing/researchSpend.ts:16-53`). The cost is read from `providerMetadata.openrouter.usage.cost`, which requires OpenRouter's `usage: { include: true }` (`openseo:src/server/lib/chatAgent.ts:26-40`; `openseo:src/server/lib/openrouter.ts:47-51`, `:99-113`).
19. Credits use one formula for estimate and charge, so the two cannot drift (`openseo:src/shared/billing.ts:78-87`). **(Not adopted: we have no credits; USD only.)**

**Cache, URL policy, contract test**

20. R2 cache: SHA-256 key over sorted params under a namespace prefix (`openseo:src/server/lib/r2-cache.ts:21-34`). The TTL is soft, kept in object metadata; an expired read returns `null` (`:36-53`, `:55-71`). Callers must validate the value with zod on read because "schema drift between writes and reads is otherwise silent" (`:37-40`; example at `openseo:src/server/features/ai-visibility/services/aiPromptResearch.ts:250-256`). Cache writes are background work (`aiPromptResearch.ts:285-289`).
21. The URL policy blocks named hosts (`localhost`, `metadata.google.internal`, `metadata`, `169.254.169.254`, `100.100.100.200`) and suffixes (`.localhost`, `.local`, `.localdomain`, `.internal`, `.home.arpa`) (`openseo:src/server/lib/audit/url-policy.ts:4-18`). It blocks private, loopback, CGNAT, benchmark and multicast IPv4 (`:36-58`), private and link-local IPv6 including IPv4-mapped addresses (`:60-111`), and resolves names over DNS-over-HTTPS (`:143-188`). A DNS failure or empty answer **fails open** (`:155`, `:180`, `:185-187`). Every redirect hop of the start URL is re-validated, up to 5 hops at 10 s each (`:257-311`).
22. The contract test lists every MCP tool, requires an output schema on each, and walks the JSON Schema keywords to reject `additionalProperties: false` / `unevaluatedProperties: false` anywhere, because "cached clients must accept added fields" (`openseo:src/server/mcp/output-schema-contract.test.ts:14-102`). It has its own unit test for nested arrays, unions and `$defs` (`:104-139`).

## 3. What Perceev has today

- **Language and validation.** All code is JS/JSX/MJS. `jsconfig.json` has only the `@/*` path. `typescript@6.0.3` is a devDependency but no `tsconfig.json` exists. `zod`, `ai` and `@openrouter/ai-sdk-provider` are not dependencies (`package.json`). Node is pinned `>=22.22.0 <23`. Node 22.22.3 runs erasable-syntax `.ts` files directly; this was checked during spec writing (`node t.ts` printed `ok 1` with no ExperimentalWarning).
- **Tests.** `npm test` and `npm run test:scoring` run `node --import ./src/lib/liveWriteGuardAuto.mjs --test "src/**/*.test.mjs"`. `src/lib/testCoverageGuard.test.mjs:24-49` asserts that the `test:scoring` glob collects every `*.test.mjs` under `src/`, and `:69-89` asserts that `npm test` equals `test:scoring` and that CI runs `npm run test:scoring`. Route tests use loader hooks (`src/lib/customerRoutes.test.hooks.mjs`, `src/lib/cronAuth.route.hooks.mjs`). The DB harness pattern refuses any database that is not a loopback `_qa`/`_uat` database (`scripts/qa/check-repair-workflows.mjs:13-18`). CI's `customer-database` job applies every migration in order to Postgres 16, then runs `scripts/qa/check-probe-dispatch.mjs` and `scripts/qa/check-repair-workflows.mjs` (`.github/workflows/ci.yml:16-59`).
- **Customer auth.** `getCustomerContext()` and `findCustomerBrand()` (`src/lib/supabase/customer.js:31-37`, `src/lib/supabase/customerContext.js:1-30`) resolve the Supabase session and active memberships (`brandKey`, `role`, `display_name`, `website`, `website_host`, `aliases`). `customerRouteContext()` (`src/lib/supabase/customerRoute.js:4-18`) adds the 503/401/503/403 cross-site/404 mapping. `getSupabaseAdmin()` (`src/lib/supabase/admin.js:10-24`) returns the service-role client or `null`. Several routes repeat the mapping by hand (for example `src/app/api/customer/scan/route.js:16-27`).
- **Cron auth and background work.** `isCronAuthorized()` (`src/lib/cronAuth.js:126-166`) fails closed in production without `CRON_SECRET`. `keepAlive()` (`src/lib/keepAlive.js:36-73`) wraps `@vercel/functions` `waitUntil`. `makeSelfContinue()` (`src/lib/selfContinue.js:146-201`) fires a fire-and-forget request back at a worker route with `x-cron-secret` and the deployment-protection bypass header. Worker routes that authenticate themselves are listed in `SELF_GATED` (`src/lib/operatorPerimeter.js:72-91`). `vercel.json` has daily crons only.
- **Scan worker (NOT migrated by F01).** Scans run on `scan_jobs` through `runScanChunk` (`src/lib/workers/scanWorker.js:2872`), with a 150 s chunk budget (`:111`), a 300 s worker limit (`:1174`), its own self-continue copy (`:1216-1260`), a run reaper (`:3752`), a scheduler tick (`:3308`) and per-brand single-flight through the partial index `scan_jobs_one_running_per_brand` (migration 007) plus `jobLease.js`. Answer-engine calls are claimed one attempt at a time through `claim_probe_dispatch` (migrations 027 and 035), from `runDurableProbing` (`src/lib/workers/durableProbing.js:62-329`).
- **Spend control today.** It is specific to scans. `claim_probe_dispatch(p_id, p_reserve, p_scan_cap, p_day_cap, p_lease_seconds)` reserves `p_reserve` per attempt in `probe_attempts.reserved_usd`, allows at most 3 attempts per observation, and refuses when `scan_spend + p_reserve > p_scan_cap` or `day_spend + p_reserve > p_day_cap`, where spend sums `coalesce(charged_usd, reserved_usd)` (`supabase/migrations/035_scoped_provider_rollout.sql:36-89`). `dispatchBudget()` reads `SCAN_PROBE_RESERVATION_USD` (default 1 in code; the owner states production runs at 0.20), `SCAN_MAX_COST_PER_SCAN` and `SCAN_MAX_COST_PER_DAY` (`src/lib/workers/durableProbing.js:26-41`). Content checks have their own `claim_content_check` (`supabase/migrations/031_content_check_budget.sql:13-27`). LLM pricing has named cost sources and fails loud on unpriced models (`src/lib/llmPricing.js:20-45`, `resolveCost` at `:651-713`). There is **no** generic reservation, no per-workspace cap and no paid-feature switch.
- **SSRF.** `src/lib/ssrfGuard.js` already resolves names with `node:dns` (`:518-526`) and checks every address in every notation (`:542-608`). It refuses DNS failures (fail closed), follows redirects by hand and re-validates each hop (`:612-647`). It names its own gap: the second resolution inside `fetch()` (TOCTOU / DNS rebinding) is narrowed but not closed (`:27-40`). It has no hostname-suffix blocklist, no body-size cap and no timeout. `src/lib/crawlabilitySsrf.route.test.mjs` covers the crawlability route's use of it.
- **LLM paths.** `src/lib/llm.js` and `src/lib/openrouter.js` (`generateContent`) remain for existing features and are not changed.
- **Must not break.** P0 dispatch controls and functions (027–035), `scan_jobs` behaviour, the 3,558-test suite, `testCoverageGuard`, the CI database job, existing routes' markup and status codes.

## 4. Target behaviour and acceptance criteria

| ID | Statement | Verified by |
|---|---|---|
| F01-AC-01 | `tsconfig.json` exists with `allowJs`, `strict`, `noEmit`, `erasableSyntaxOnly`, `allowImportingTsExtensions` and `paths {"@/*":["./src/*"]}`; `npm run typecheck` exits 0 on `main` plus F01. | CI step `typecheck`; unit `src/lib/platform/tsSetup.test.mjs` |
| F01-AC-02 | `npm test` runs `src/**/*.test.mjs` and `src/**/*.test.ts`; `testCoverageGuard` fails if a `*.test.ts` file is not collected. | `src/lib/testCoverageGuard.test.mjs` (extended) |
| F01-AC-03 | `THIRD_PARTY_NOTICES.md` contains OpenSEO's MIT licence text verbatim and lists every COPY/PORT file; every file whose header says "Portions ported from every-app/open-seo" is listed. | unit `src/lib/platform/thirdPartyNotices.test.mjs` |
| F01-AC-04 | `toErrorResponse()` returns `{error, code, recovery?, details?}` with the error's status and `Cache-Control: no-store`; zod errors become 400 `invalid_request`; unknown errors become 500 `internal_error` without leaking the message. | unit `src/lib/http/errors.test.ts` |
| F01-AC-05 | `requireWorkspace()` maps no-auth-config→503 `auth_not_configured`, no user→401 `unauthenticated`, membership read failure→503 `membership_unavailable`, cross-site write→403 `cross_site`, unknown brand→404 `workspace_not_found`, member on owner-only→403 `owner_required`, missing service client→503 `storage_unavailable`; success returns the §5 shape. | unit `src/lib/workspace/requireWorkspace.test.ts` |
| F01-AC-06 | `reserveSpend` refuses with `feature_disabled` when the feature has no enabled `paid_feature_controls` row (or the brand is not on its allowlist), `over_approved_max` when `estimateUsd > maxUsd`, `daily_cap` when the workspace daily cap or the feature's platform daily cap would be exceeded, and `workspace_cap` when the workspace monthly cap would be exceeded. Refusals create no hold. | DB `scripts/qa/check-f01-db.mjs` group `spend-refusals` |
| F01-AC-07 | 20 concurrent reservations of USD 1 against a USD 10 daily cap grant exactly 10. | DB group `spend-concurrency` |
| F01-AC-08 | A second `reserveSpend` with the same `(brandKey, idempotencyKey)` returns the same `holdId` while held, and throws `AppError 409 duplicate_paid_call` after settle or release. | DB group `spend-idempotency`; unit `src/lib/spend/spend.test.ts` |
| F01-AC-09 | `metered()` settles on `actualUsd`, releases when `billed === false` or the call throws `UnbilledCallError`, settles at actual on `ChargedCallError`, and records an unknown cost (counted at the estimate) for any other thrown error. Settlement still happens if the caller has already returned (keepAlive). | unit `src/lib/spend/metered.test.ts` |
| F01-AC-10 | An actual cost above the estimate writes the ledger row with `meta.undershoot = true` and logs `[spend] estimate undershoot` with feature, provider, endpoint, estimate and actual. Nothing else is logged. | unit `metered.test.ts`; DB group `spend-settle` |
| F01-AC-11 | Holds past `expires_at` become `expired` and write one ledger row with `actual_usd NULL`, `accounted_usd = estimate_usd`, `cost_source = 'reservation'`. | DB group `spend-expiry` |
| F01-AC-12 | Every paid feature ships disabled: a fresh database has no enabled `paid_feature_controls` row; `isFeatureEnabled()` is false in production for any flag whose env var is unset. | DB group `spend-defaults`; unit `src/lib/features/flags.test.ts` |
| F01-AC-13 | `enqueueJob` with the same `dedupeKey` returns `{jobId: <same>, deduped: true}`; with a `singleActiveKey` already queued or running it throws `AppError 409 job_already_running` with `details.activeJobId`. | DB group `jobs-enqueue`; unit `src/lib/jobs/runner.test.ts` |
| F01-AC-14 | `step.do` memoises: a completed step's function is never called again on replay, and its output is returned. | unit `runner.test.ts` "memoises completed steps" |
| F01-AC-15 | A step with `billed: true` and `retries: 2` is rejected at definition time (`AppError 500 billed_step_retries`); a billed step found `running` on replay (crash mid-step) fails with `billed_step_interrupted` and its function is not called again. | unit `runner.test.ts`; DB group `jobs-steps` |
| F01-AC-16 | A non-billed step that throws is retried up to `retries` times with backoff (`run_at` moves forward, the job yields), then fails with `step_attempts_exhausted`. | unit `runner.test.ts` |
| F01-AC-17 | `step.sleep(name, s)` yields the job with `run_at = now + s`, and the tick resumes it after the delay without re-running earlier steps. | unit `runner.test.ts`; DB group `jobs-steps` |
| F01-AC-18 | A step whose `timeoutMs` exceeds the remaining invocation budget is not started; the job yields and a self-continue to `/api/jobs/tick?job_id=` is fired. | unit `runner.test.ts` "yields before a step that cannot finish" |
| F01-AC-19 | Step outputs over 64 KB or not JSON-serialisable fail the step with `step_output_too_large` / `step_output_not_json`. | unit `runner.test.ts` |
| F01-AC-20 | Two ticks claiming at once never run the same job (SKIP LOCKED + lease); a writer whose lease expired is fenced (its step completion returns `lost_lease`, no state change). | DB group `jobs-leases` |
| F01-AC-21 | The watchdog fails jobs past `deadline_at` (`deadline_exceeded`) and past `max_invocations` (`invocation_limit`), oldest first, at most 100 per tick, and one failing row does not stop the sweep. | DB group `jobs-watchdog`; unit `src/lib/jobs/watchdog.test.ts` |
| F01-AC-22 | `cancelJob` cancels a queued job immediately; a running job finishes its current step, then ends `cancelled` before the next step starts. | unit `runner.test.ts`; DB group `jobs-cancel` |
| F01-AC-23 | `getJobStatus` returns `pollAfterSeconds` 5 for running manual jobs, 20 for running scheduled jobs (both overridable per kind), `clamp(run_at − now, 5, 60)` for a sleeping or queued job, and `null` for terminal jobs. | unit `src/lib/jobs/status.test.ts` |
| F01-AC-24 | `POST /api/jobs/tick` returns 401 without the cron secret, 200 `{skipped:"disabled"}` when `FEATURE_JOBS_TICK` is not `on`, and 202 `{accepted:true}` otherwise. Work continues in `keepAlive`. | route `src/lib/jobs/tick.route.test.mjs` |
| F01-AC-25 | `GET /api/customer/jobs/[jobId]` returns 404 for a job of another workspace and for system jobs, and the §5 status shape for its own. | route `src/lib/jobs/jobsRoutes.route.test.mjs` |
| F01-AC-26 | Periodic tasks advance `next_run_at` before running; a task that throws is not retried until its next slot, and missed slots collapse into one catch-up run. | DB group `jobs-periodic`; unit `src/lib/jobs/periodic.test.ts` |
| F01-AC-27 | Migration 043 applies cleanly on a database without `pg_cron`/`pg_net` (CI) and, where they exist, installs exactly one `perceev-jobs-tick` schedule running every minute. | CI `customer-database` job; DB group `jobs-cron` |
| F01-AC-28 | `cached()` returns `hit:false` and stores on miss, `hit:true` within TTL, refetches after TTL and when the stored value fails the schema; workspace-scoped keys differ per brand; values over 256 KB go to Storage bucket `provider-cache`. | unit `src/lib/cache/providerCache.test.ts`; DB group `cache` |
| F01-AC-29 | `llmObject`/`llmText` reserve an estimate, call OpenRouter with `usage.include` and `maxRetries: 0`, settle on `providerMetadata.openrouter.usage.cost` (or the `llmPricing` price table on other gateways), and never log the prompt or the answer. | unit `src/lib/llm/llm.test.ts` |
| F01-AC-30 | `safeFetch` refuses OpenSEO's blocked host names and suffixes, all private/metadata addresses (via `ssrfGuard`), more than 5 redirects, bodies over `maxBytes`, and connects only to the address it vetted (a resolver that later answers a private address cannot redirect the connection). | unit `src/lib/http/safeFetch.test.ts` |
| F01-AC-31 | The route contract test fails when any registered response schema is closed (`additionalProperties:false`) or missing, and its walker finds closed objects inside arrays, unions and `$defs`. | unit `src/lib/http/routeContract.test.ts` |
| F01-AC-32 | No F01 change alters P0 dispatch: migrations 027–035 functions are untouched; `scripts/qa/check-probe-dispatch.mjs` still passes. | CI `customer-database` job |

## 5. Scope

**In scope**
- TypeScript enablement, zod v4, `ai` v6, `@openrouter/ai-sdk-provider`, `undici` (for connection pinning), type packages.
- `THIRD_PARTY_NOTICES.md`.
- `src/lib/http/errors.ts`, `src/lib/workspace/requireWorkspace.ts`, `src/lib/http/routeContract.ts` + contract test.
- Durable job runner `src/lib/jobs/` with tables `jobs`, `job_steps`, `job_periodic`, tick route, customer status/cancel routes, watchdog, retention, pg_cron schedule.
- Spend guard `src/lib/spend/` with tables `paid_feature_controls`, `workspace_spend_limits`, `spend_holds`, `spend_ledger`, operator APIs to set controls and limits.
- Feature flags `src/lib/features/`.
- Provider cache `src/lib/cache/` with table `provider_cache` and bucket `provider-cache`.
- LLM helper `src/lib/llm/`.
- `safeFetch` `src/lib/http/safeFetch.ts` on top of `src/lib/ssrfGuard.js`.

**Out of scope**
- Moving the scan worker, `scan_jobs`, `claim_probe_dispatch` or the scan caps onto the job runner or spend guard (see §6.3.8; scan accounting in the ledger is F03, scan approval is F09).
- Price tables, per-answer cost, the Usage page and the operator cost view (F03).
- Estimate/confirm UI and the `409 price_changed` contract (F09).
- DataForSEO client and its pricing (F02/F03).
- Tool registry for MCP/assistant (F21/F22); F01 only provides the schema contract walker they reuse.
- Billing, credits, markup (excluded by owner decision).
- Customer-facing UI of any kind; F01 has none.
- Deferred Mixed rows: none touched.

## 6. Design

### 6.1 Data model

All four migration files are idempotent and are applied by the existing runner in number order. 041 does not reference 040 (no foreign key from spend tables to `jobs`), so phases may merge in either order.

#### `supabase/migrations/040_f01_jobs.sql`

```sql
-- F01: durable step-based job runner (Cloudflare Workflows semantics on Postgres).
-- Service-role writes only. Customers may read their own workspace's jobs.

CREATE TABLE IF NOT EXISTS public.jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key text REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  trigger text NOT NULL DEFAULT 'manual'
    CHECK (trigger IN ('manual','scheduled','baseline','system')),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','completed','partial','failed','cancelled')),
  dedupe_key text CHECK (dedupe_key IS NULL OR length(dedupe_key) BETWEEN 1 AND 200),
  single_active_key text CHECK (single_active_key IS NULL OR length(single_active_key) BETWEEN 1 AND 200),
  run_at timestamptz NOT NULL DEFAULT now(),
  deadline_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  invocations integer NOT NULL DEFAULT 0,
  max_invocations integer NOT NULL DEFAULT 200 CHECK (max_invocations BETWEEN 1 AND 10000),
  lease_owner text,
  lease_until timestamptz,
  progress_done integer,
  progress_total integer,
  progress_label text CHECK (progress_label IS NULL OR length(progress_label) <= 120),
  result jsonb CHECK (result IS NULL OR pg_column_size(result) < 65536),
  error_code text,
  error_message text CHECK (error_message IS NULL OR length(error_message) <= 500),
  cancel_requested_at timestamptz,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  heartbeat_at timestamptz,
  finished_at timestamptz,
  -- A job without a workspace exists only for platform maintenance.
  CONSTRAINT jobs_brand_or_system CHECK (brand_key IS NOT NULL OR trigger = 'system'),
  CONSTRAINT jobs_progress_ck CHECK (
    (progress_done IS NULL AND progress_total IS NULL)
    OR (progress_done >= 0 AND progress_total >= 0 AND progress_done <= progress_total)),
  CONSTRAINT jobs_terminal_finished CHECK (
    (status IN ('completed','partial','failed','cancelled')) = (finished_at IS NOT NULL))
);
COMMENT ON COLUMN public.jobs.invocations IS 'Handler entries (claims), not step retries.';
COMMENT ON COLUMN public.jobs.single_active_key IS 'At most one queued/running job per (kind, single_active_key).';

CREATE UNIQUE INDEX IF NOT EXISTS jobs_dedupe_idx
  ON public.jobs (kind, brand_key, dedupe_key) NULLS NOT DISTINCT
  WHERE dedupe_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS jobs_single_active_idx
  ON public.jobs (kind, single_active_key)
  WHERE single_active_key IS NOT NULL AND status IN ('queued','running');
CREATE INDEX IF NOT EXISTS jobs_due_idx ON public.jobs (run_at, created_at)
  WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS jobs_brand_created_idx ON public.jobs (brand_key, created_at DESC);
CREATE INDEX IF NOT EXISTS jobs_finished_idx ON public.jobs (finished_at)
  WHERE finished_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.job_steps (
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  step_kind text NOT NULL CHECK (step_kind IN ('do','sleep')),
  status text NOT NULL CHECK (status IN ('running','retry_wait','sleeping','completed','failed')),
  billed boolean NOT NULL DEFAULT false,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 6),
  timeout_ms integer NOT NULL CHECK (timeout_ms BETWEEN 1 AND 230000),
  output jsonb CHECK (output IS NULL OR pg_column_size(output) < 65536),
  error_code text,
  error_message text CHECK (error_message IS NULL OR length(error_message) <= 500),
  wake_at timestamptz,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  PRIMARY KEY (job_id, name),
  CONSTRAINT job_steps_billed_once CHECK (NOT billed OR max_attempts = 1),
  CONSTRAINT job_steps_wake CHECK ((status IN ('retry_wait','sleeping')) = (wake_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS public.job_periodic (
  name text PRIMARY KEY CHECK (name ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  interval_seconds integer NOT NULL CHECK (interval_seconds >= 60),
  next_run_at timestamptz NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  last_started_at timestamptz,
  last_finished_at timestamptz,
  last_error text CHECK (last_error IS NULL OR length(last_error) <= 500)
);

CREATE OR REPLACE FUNCTION public.f01_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
DROP TRIGGER IF EXISTS jobs_touch_updated_at ON public.jobs;
CREATE TRIGGER jobs_touch_updated_at BEFORE UPDATE ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.f01_touch_updated_at();

ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_periodic ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.jobs, public.job_steps, public.job_periodic FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.jobs, public.job_steps, public.job_periodic TO service_role;
GRANT SELECT ON public.jobs TO authenticated;
DROP POLICY IF EXISTS jobs_customer_read ON public.jobs;
CREATE POLICY jobs_customer_read ON public.jobs FOR SELECT TO authenticated
  USING (brand_key IS NOT NULL AND public.customer_can_access_brand(brand_key));

-- Enqueue with dedupe and single-active handling in one statement path.
CREATE OR REPLACE FUNCTION public.enqueue_job(
  p_kind text, p_brand text, p_payload jsonb, p_trigger text,
  p_dedupe text, p_single_active text, p_run_at timestamptz,
  p_created_by uuid, p_deadline_seconds integer, p_max_invocations integer)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  IF p_deadline_seconds IS NULL OR p_deadline_seconds < 60 OR p_deadline_seconds > 7*86400 THEN
    RAISE EXCEPTION 'invalid job deadline'; END IF;
  IF p_dedupe IS NOT NULL THEN
    SELECT id INTO v_id FROM jobs
     WHERE kind = p_kind AND brand_key IS NOT DISTINCT FROM p_brand AND dedupe_key = p_dedupe;
    IF FOUND THEN RETURN jsonb_build_object('job_id', v_id, 'deduped', true); END IF;
  END IF;
  BEGIN
    INSERT INTO jobs(kind, brand_key, payload, trigger, dedupe_key, single_active_key,
                     run_at, deadline_at, created_by, max_invocations)
    VALUES (p_kind, p_brand, coalesce(p_payload, '{}'::jsonb), p_trigger, p_dedupe, p_single_active,
            coalesce(p_run_at, now()), coalesce(p_run_at, now()) + make_interval(secs => p_deadline_seconds),
            p_created_by, coalesce(p_max_invocations, 200))
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    IF p_dedupe IS NOT NULL THEN
      SELECT id INTO v_id FROM jobs
       WHERE kind = p_kind AND brand_key IS NOT DISTINCT FROM p_brand AND dedupe_key = p_dedupe;
      IF FOUND THEN RETURN jsonb_build_object('job_id', v_id, 'deduped', true); END IF;
    END IF;
    SELECT id INTO v_id FROM jobs
     WHERE kind = p_kind AND single_active_key = p_single_active AND status IN ('queued','running');
    RETURN jsonb_build_object('job_id', NULL, 'deduped', false, 'conflict_job_id', v_id);
  END;
  RETURN jsonb_build_object('job_id', v_id, 'deduped', false);
END $$;

-- Claim due jobs. SKIP LOCKED: two ticks never take the same row.
CREATE OR REPLACE FUNCTION public.claim_due_jobs(
  p_owner text, p_limit integer, p_lease_seconds integer, p_job_id uuid DEFAULT NULL)
RETURNS SETOF public.jobs LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF p_limit < 1 OR p_limit > 50 OR p_lease_seconds < 30 OR p_lease_seconds > 900 THEN
    RAISE EXCEPTION 'invalid claim'; END IF;
  RETURN QUERY
  WITH due AS (
    SELECT id FROM jobs
     WHERE status IN ('queued','running') AND run_at <= now()
       AND (lease_until IS NULL OR lease_until < now())
       AND (p_job_id IS NULL OR id = p_job_id)
     ORDER BY run_at, created_at
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED)
  UPDATE jobs j SET status = 'running', lease_owner = p_owner,
         lease_until = now() + make_interval(secs => p_lease_seconds),
         invocations = j.invocations + 1, started_at = coalesce(j.started_at, now()),
         heartbeat_at = now()
    FROM due WHERE j.id = due.id
  RETURNING j.*;
END $$;

-- Fence helper: true when p_owner still holds an unexpired lease.
CREATE OR REPLACE FUNCTION public.f01_job_fenced(p_job uuid, p_owner text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM jobs WHERE id = p_job AND lease_owner = p_owner AND lease_until >= now()
                 AND status = 'running');
$$;

-- Begin (or resume) a step. Returns {action: run|memoised|failed|wait|lost_lease, ...}.
CREATE OR REPLACE FUNCTION public.job_step_begin(
  p_job uuid, p_owner text, p_name text, p_billed boolean, p_max_attempts integer, p_timeout_ms integer)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE s job_steps;
BEGIN
  PERFORM 1 FROM jobs WHERE id = p_job FOR UPDATE;
  IF NOT f01_job_fenced(p_job, p_owner) THEN RETURN jsonb_build_object('action','lost_lease'); END IF;
  IF p_billed AND p_max_attempts <> 1 THEN RAISE EXCEPTION 'billed step must have one attempt'; END IF;
  SELECT * INTO s FROM job_steps WHERE job_id = p_job AND name = p_name FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO job_steps(job_id, name, step_kind, status, billed, attempts, max_attempts, timeout_ms)
    VALUES (p_job, p_name, 'do', 'running', p_billed, 1, p_max_attempts, p_timeout_ms);
    RETURN jsonb_build_object('action','run','attempt',1);
  END IF;
  IF s.step_kind <> 'do' THEN RAISE EXCEPTION 'step name % already used by a sleep', p_name; END IF;
  IF s.status = 'completed' THEN RETURN jsonb_build_object('action','memoised','output',s.output); END IF;
  IF s.status = 'failed' THEN
    RETURN jsonb_build_object('action','failed','error_code',s.error_code,'error_message',s.error_message);
  END IF;
  IF s.status = 'retry_wait' AND s.wake_at > now() THEN
    RETURN jsonb_build_object('action','wait','wake_at',s.wake_at);
  END IF;
  -- status 'running' here means the invocation that started it died mid-step.
  IF s.status = 'running' AND s.billed THEN
    UPDATE job_steps SET status = 'failed', error_code = 'billed_step_interrupted',
      error_message = 'A billed step was interrupted; it is never re-run.', finished_at = now()
     WHERE job_id = p_job AND name = p_name;
    RETURN jsonb_build_object('action','failed','error_code','billed_step_interrupted',
      'error_message','A billed step was interrupted; it is never re-run.');
  END IF;
  IF s.attempts >= s.max_attempts THEN
    UPDATE job_steps SET status = 'failed', error_code = 'step_attempts_exhausted', finished_at = now(),
      wake_at = NULL WHERE job_id = p_job AND name = p_name;
    RETURN jsonb_build_object('action','failed','error_code','step_attempts_exhausted',
      'error_message',coalesce(s.error_message,'Step failed after its retry budget.'));
  END IF;
  UPDATE job_steps SET status = 'running', attempts = s.attempts + 1, wake_at = NULL, started_at = now()
   WHERE job_id = p_job AND name = p_name;
  RETURN jsonb_build_object('action','run','attempt',s.attempts + 1);
END $$;

CREATE OR REPLACE FUNCTION public.job_step_complete(
  p_job uuid, p_owner text, p_name text, p_output jsonb, p_lease_seconds integer)
RETURNS boolean LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  PERFORM 1 FROM jobs WHERE id = p_job FOR UPDATE;
  IF NOT f01_job_fenced(p_job, p_owner) THEN RETURN false; END IF;
  UPDATE job_steps SET status = 'completed', output = p_output, finished_at = now(),
         error_code = NULL, error_message = NULL
   WHERE job_id = p_job AND name = p_name AND status = 'running';
  UPDATE jobs SET lease_until = now() + make_interval(secs => p_lease_seconds), heartbeat_at = now()
   WHERE id = p_job;
  RETURN true;
END $$;

-- Record a failed attempt. p_retry_at NULL (or budget used) = permanent failure.
CREATE OR REPLACE FUNCTION public.job_step_fail(
  p_job uuid, p_owner text, p_name text, p_code text, p_message text, p_retry_at timestamptz)
RETURNS text LANGUAGE plpgsql SET search_path = public AS $$
DECLARE s job_steps;
BEGIN
  PERFORM 1 FROM jobs WHERE id = p_job FOR UPDATE;
  IF NOT f01_job_fenced(p_job, p_owner) THEN RETURN 'lost_lease'; END IF;
  SELECT * INTO s FROM job_steps WHERE job_id = p_job AND name = p_name FOR UPDATE;
  IF p_retry_at IS NOT NULL AND NOT s.billed AND s.attempts < s.max_attempts THEN
    UPDATE job_steps SET status = 'retry_wait', wake_at = p_retry_at, error_code = p_code,
           error_message = left(p_message, 500) WHERE job_id = p_job AND name = p_name;
    RETURN 'retry_wait';
  END IF;
  UPDATE job_steps SET status = 'failed', error_code = p_code, error_message = left(p_message, 500),
         finished_at = now(), wake_at = NULL WHERE job_id = p_job AND name = p_name;
  RETURN 'failed';
END $$;

-- Sleep: returns NULL when the sleep is over (continue), else the wake time (yield).
CREATE OR REPLACE FUNCTION public.job_sleep(p_job uuid, p_owner text, p_name text, p_seconds integer)
RETURNS timestamptz LANGUAGE plpgsql SET search_path = public AS $$
DECLARE s job_steps; v_wake timestamptz;
BEGIN
  IF p_seconds < 1 OR p_seconds > 86400 THEN RAISE EXCEPTION 'invalid sleep'; END IF;
  PERFORM 1 FROM jobs WHERE id = p_job FOR UPDATE;
  IF NOT f01_job_fenced(p_job, p_owner) THEN RAISE EXCEPTION 'lost_lease'; END IF;
  SELECT * INTO s FROM job_steps WHERE job_id = p_job AND name = p_name FOR UPDATE;
  IF NOT FOUND THEN
    v_wake := now() + make_interval(secs => p_seconds);
    INSERT INTO job_steps(job_id, name, step_kind, status, attempts, max_attempts, timeout_ms, wake_at)
    VALUES (p_job, p_name, 'sleep', 'sleeping', 1, 1, 1, v_wake);
    RETURN v_wake;
  END IF;
  IF s.step_kind <> 'sleep' THEN RAISE EXCEPTION 'step name % already used by a do', p_name; END IF;
  IF s.status = 'completed' THEN RETURN NULL; END IF;
  IF s.wake_at > now() THEN RETURN s.wake_at; END IF;
  UPDATE job_steps SET status = 'completed', wake_at = NULL, finished_at = now()
   WHERE job_id = p_job AND name = p_name;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.job_yield(p_job uuid, p_owner text, p_run_at timestamptz)
RETURNS boolean LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  UPDATE jobs SET lease_owner = NULL, lease_until = NULL, run_at = p_run_at, heartbeat_at = now()
   WHERE id = p_job AND lease_owner = p_owner AND status = 'running';
  RETURN FOUND;
END $$;

CREATE OR REPLACE FUNCTION public.job_progress(
  p_job uuid, p_owner text, p_done integer, p_total integer, p_label text, p_lease_seconds integer)
RETURNS boolean LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  UPDATE jobs SET progress_done = p_done, progress_total = p_total, progress_label = left(p_label, 120),
         lease_until = now() + make_interval(secs => p_lease_seconds), heartbeat_at = now()
   WHERE id = p_job AND lease_owner = p_owner AND lease_until >= now() AND status = 'running';
  RETURN FOUND;
END $$;

CREATE OR REPLACE FUNCTION public.job_finish(
  p_job uuid, p_owner text, p_status text, p_result jsonb, p_error_code text, p_error_message text)
RETURNS boolean LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF p_status NOT IN ('completed','partial','failed','cancelled') THEN RAISE EXCEPTION 'invalid terminal status'; END IF;
  UPDATE jobs SET status = p_status, result = p_result, error_code = p_error_code,
         error_message = left(p_error_message, 500), finished_at = now(),
         lease_owner = NULL, lease_until = NULL
   WHERE id = p_job AND lease_owner = p_owner AND status = 'running';
  RETURN FOUND;
END $$;

CREATE OR REPLACE FUNCTION public.cancel_job(p_job uuid) RETURNS text
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE j jobs;
BEGIN
  SELECT * INTO j FROM jobs WHERE id = p_job FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF j.status IN ('completed','partial','failed','cancelled') THEN RETURN j.status; END IF;
  IF j.status = 'queued' OR (j.lease_until IS NULL OR j.lease_until < now()) THEN
    UPDATE jobs SET status = 'cancelled', cancel_requested_at = coalesce(cancel_requested_at, now()),
           finished_at = now(), lease_owner = NULL, lease_until = NULL,
           error_code = 'cancelled', error_message = 'Cancelled.'
     WHERE id = p_job;
    RETURN 'cancelled';
  END IF;
  UPDATE jobs SET cancel_requested_at = coalesce(cancel_requested_at, now()) WHERE id = p_job;
  RETURN 'cancel_requested';
END $$;

-- Watchdog (port of auditReconciler). Oldest first, bounded batch.
CREATE OR REPLACE FUNCTION public.reconcile_stale_jobs(p_limit integer DEFAULT 100)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_deadline integer := 0; v_invocations integer := 0;
BEGIN
  WITH stale AS (
    SELECT id FROM jobs WHERE status IN ('queued','running') AND deadline_at < now()
       AND (lease_until IS NULL OR lease_until < now())
     ORDER BY deadline_at LIMIT p_limit FOR UPDATE SKIP LOCKED)
  UPDATE jobs j SET status = 'failed', error_code = 'deadline_exceeded',
         error_message = 'The job did not finish before its deadline.', finished_at = now(),
         lease_owner = NULL, lease_until = NULL
    FROM stale WHERE j.id = stale.id;
  GET DIAGNOSTICS v_deadline = ROW_COUNT;
  WITH runaway AS (
    SELECT id FROM jobs WHERE status IN ('queued','running') AND invocations >= max_invocations
       AND (lease_until IS NULL OR lease_until < now())
     ORDER BY created_at LIMIT p_limit FOR UPDATE SKIP LOCKED)
  UPDATE jobs j SET status = 'failed', error_code = 'invocation_limit',
         error_message = 'The job resumed too many times without finishing.', finished_at = now(),
         lease_owner = NULL, lease_until = NULL
    FROM runaway WHERE j.id = runaway.id;
  GET DIAGNOSTICS v_invocations = ROW_COUNT;
  RETURN jsonb_build_object('deadline_exceeded', v_deadline, 'invocation_limit', v_invocations);
END $$;

-- "Advance next-run before starting" (port of claimDueTracker). One catch-up only.
CREATE OR REPLACE FUNCTION public.claim_due_periodic(p_name text, p_interval_seconds integer, p_now timestamptz)
RETURNS boolean LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_next timestamptz; v_step interval := make_interval(secs => p_interval_seconds);
BEGIN
  INSERT INTO job_periodic(name, interval_seconds, next_run_at) VALUES (p_name, p_interval_seconds, p_now)
  ON CONFLICT (name) DO UPDATE SET interval_seconds = excluded.interval_seconds;
  SELECT next_run_at INTO v_next FROM job_periodic WHERE name = p_name AND enabled FOR UPDATE;
  IF NOT FOUND OR v_next > p_now THEN RETURN false; END IF;
  WHILE v_next <= p_now LOOP v_next := v_next + v_step; END LOOP;
  UPDATE job_periodic SET next_run_at = v_next, last_started_at = p_now, last_error = NULL WHERE name = p_name;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.prune_jobs(p_before timestamptz, p_limit integer DEFAULT 1000)
RETURNS integer LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v integer;
BEGIN
  WITH old AS (SELECT id FROM jobs WHERE finished_at < p_before ORDER BY finished_at LIMIT p_limit)
  DELETE FROM jobs j USING old WHERE j.id = old.id;
  GET DIAGNOSTICS v = ROW_COUNT; RETURN v;
END $$;

REVOKE ALL ON FUNCTION public.enqueue_job(text,text,jsonb,text,text,text,timestamptz,uuid,integer,integer),
  public.claim_due_jobs(text,integer,integer,uuid), public.f01_job_fenced(uuid,text),
  public.job_step_begin(uuid,text,text,boolean,integer,integer),
  public.job_step_complete(uuid,text,text,jsonb,integer),
  public.job_step_fail(uuid,text,text,text,text,timestamptz), public.job_sleep(uuid,text,text,integer),
  public.job_yield(uuid,text,timestamptz), public.job_progress(uuid,text,integer,integer,text,integer),
  public.job_finish(uuid,text,text,jsonb,text,text), public.cancel_job(uuid),
  public.reconcile_stale_jobs(integer), public.claim_due_periodic(text,integer,timestamptz),
  public.prune_jobs(timestamptz,integer), public.f01_touch_updated_at()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_job(text,text,jsonb,text,text,text,timestamptz,uuid,integer,integer),
  public.claim_due_jobs(text,integer,integer,uuid), public.f01_job_fenced(uuid,text),
  public.job_step_begin(uuid,text,text,boolean,integer,integer),
  public.job_step_complete(uuid,text,text,jsonb,integer),
  public.job_step_fail(uuid,text,text,text,text,timestamptz), public.job_sleep(uuid,text,text,integer),
  public.job_yield(uuid,text,timestamptz), public.job_progress(uuid,text,integer,integer,text,integer),
  public.job_finish(uuid,text,text,jsonb,text,text), public.cancel_job(uuid),
  public.reconcile_stale_jobs(integer), public.claim_due_periodic(text,integer,timestamptz),
  public.prune_jobs(timestamptz,integer)
  TO service_role;
NOTIFY pgrst, 'reload schema';
```

#### `supabase/migrations/041_f01_spend.sql`

```sql
-- F01: spend guard. Estimate -> hold -> call -> settle on real cost.
-- Answer-engine collection is NOT reserved here: claim_probe_dispatch (027/035) stays authoritative.

CREATE TABLE IF NOT EXISTS public.paid_feature_controls (
  feature text PRIMARY KEY CHECK (feature ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  enabled boolean NOT NULL DEFAULT false,
  mode text NOT NULL DEFAULT 'allowlist' CHECK (mode IN ('all','allowlist')),
  brand_allowlist text[] NOT NULL DEFAULT '{}',
  daily_cap_usd numeric(12,6) CHECK (daily_cap_usd IS NULL OR daily_cap_usd >= 0),
  max_call_usd numeric(12,6) CHECK (max_call_usd IS NULL OR max_call_usd > 0),
  note text CHECK (note IS NULL OR length(note) <= 500),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);
COMMENT ON COLUMN public.paid_feature_controls.daily_cap_usd IS 'Platform-wide UTC-day cap for this feature across all workspaces.';
COMMENT ON COLUMN public.paid_feature_controls.max_call_usd IS 'Refuse any single estimate above this.';

CREATE TABLE IF NOT EXISTS public.workspace_spend_limits (
  brand_key text PRIMARY KEY REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  daily_cap_usd numeric(12,6) CHECK (daily_cap_usd IS NULL OR daily_cap_usd >= 0),
  monthly_cap_usd numeric(12,6) CHECK (monthly_cap_usd IS NULL OR monthly_cap_usd >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);
COMMENT ON TABLE public.workspace_spend_limits IS 'No row = env defaults SPEND_DEFAULT_DAILY_CAP_USD / SPEND_DEFAULT_MONTHLY_CAP_USD; unset = no cap.';

CREATE TABLE IF NOT EXISTS public.spend_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  feature text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 300),
  job_id uuid,
  subject_kind text CHECK (subject_kind IS NULL OR subject_kind ~ '^[a-z_]+$'),
  subject_id text,
  estimate_usd numeric(12,6) NOT NULL CHECK (estimate_usd > 0),
  max_usd numeric(12,6) CHECK (max_usd IS NULL OR max_usd > 0),
  status text NOT NULL DEFAULT 'held' CHECK (status IN ('held','settled','released','expired')),
  actual_usd numeric(12,6) CHECK (actual_usd IS NULL OR actual_usd >= 0),
  release_reason text CHECK (release_reason IS NULL OR length(release_reason) <= 200),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  CONSTRAINT spend_holds_idem UNIQUE (brand_key, idempotency_key),
  CONSTRAINT spend_holds_closed CHECK ((status = 'held') = (closed_at IS NULL))
);
COMMENT ON COLUMN public.spend_holds.job_id IS 'jobs.id when reserved inside a job step. No FK: jobs are pruned after 30 days.';
COMMENT ON COLUMN public.spend_holds.subject_kind IS 'Optional link, e.g. scan_job (F03/F09).';
CREATE INDEX IF NOT EXISTS spend_holds_open_idx ON public.spend_holds (brand_key, created_at) WHERE status = 'held';
CREATE INDEX IF NOT EXISTS spend_holds_feature_open_idx ON public.spend_holds (feature, created_at) WHERE status = 'held';
CREATE INDEX IF NOT EXISTS spend_holds_expiry_idx ON public.spend_holds (expires_at) WHERE status = 'held';
CREATE INDEX IF NOT EXISTS spend_holds_subject_idx ON public.spend_holds (subject_kind, subject_id) WHERE subject_kind IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.spend_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  feature text NOT NULL,
  hold_id uuid REFERENCES public.spend_holds(id) ON DELETE SET NULL,
  job_id uuid,
  source_ref text NOT NULL UNIQUE CHECK (length(source_ref) BETWEEN 1 AND 300),
  provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 60),
  endpoint text NOT NULL CHECK (length(endpoint) BETWEEN 1 AND 200),
  units numeric(14,4) CHECK (units IS NULL OR units >= 0),
  estimate_usd numeric(12,6) CHECK (estimate_usd IS NULL OR estimate_usd >= 0),
  actual_usd numeric(12,6) CHECK (actual_usd IS NULL OR actual_usd >= 0),
  accounted_usd numeric(12,6) NOT NULL CHECK (accounted_usd >= 0),
  cost_source text NOT NULL CHECK (cost_source IN ('provider_reported','price_table','reservation','none')),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  meta jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(meta) < 8192),
  CONSTRAINT spend_ledger_accounting CHECK (
    (cost_source = 'none' AND accounted_usd = 0 AND coalesce(actual_usd, 0) = 0)
    OR (cost_source IN ('provider_reported','price_table') AND actual_usd IS NOT NULL AND accounted_usd = actual_usd)
    OR (cost_source = 'reservation' AND actual_usd IS NULL AND accounted_usd = coalesce(estimate_usd, 0)))
);
COMMENT ON COLUMN public.spend_ledger.accounted_usd IS 'What counts against caps: the actual cost, or the estimate when the cost is unknown.';
COMMENT ON COLUMN public.spend_ledger.source_ref IS 'Idempotency: hold:<uuid>[:<n>] (F01) or probe_attempt:<observation>:<attempt> (F03).';
CREATE INDEX IF NOT EXISTS spend_ledger_brand_time_idx ON public.spend_ledger (brand_key, occurred_at DESC);
CREATE INDEX IF NOT EXISTS spend_ledger_feature_time_idx ON public.spend_ledger (feature, occurred_at DESC);
CREATE INDEX IF NOT EXISTS spend_ledger_hold_idx ON public.spend_ledger (hold_id) WHERE hold_id IS NOT NULL;

ALTER TABLE public.paid_feature_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_spend_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.spend_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.spend_ledger ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.paid_feature_controls, public.workspace_spend_limits, public.spend_holds, public.spend_ledger
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.paid_feature_controls, public.workspace_spend_limits, public.spend_holds, public.spend_ledger
  TO service_role;
GRANT SELECT ON public.workspace_spend_limits, public.spend_holds, public.spend_ledger TO authenticated;
DROP POLICY IF EXISTS workspace_spend_limits_read ON public.workspace_spend_limits;
CREATE POLICY workspace_spend_limits_read ON public.workspace_spend_limits FOR SELECT TO authenticated
  USING (public.customer_can_access_brand(brand_key));
DROP POLICY IF EXISTS spend_holds_read ON public.spend_holds;
CREATE POLICY spend_holds_read ON public.spend_holds FOR SELECT TO authenticated
  USING (public.customer_can_access_brand(brand_key));
DROP POLICY IF EXISTS spend_ledger_read ON public.spend_ledger;
CREATE POLICY spend_ledger_read ON public.spend_ledger FOR SELECT TO authenticated
  USING (public.customer_can_access_brand(brand_key));

-- Seed F01's only feature, disabled.
INSERT INTO public.paid_feature_controls(feature, enabled, mode, note)
VALUES ('platform.selftest', false, 'allowlist', 'Owner-run LLM helper live check (scripts/qa/check-f01-live.mjs).')
ON CONFLICT (feature) DO NOTHING;

-- Committed spend = settled/expired ledger + open holds (at estimate).
CREATE OR REPLACE FUNCTION public.f01_committed_usd(p_brand text, p_feature text, p_since timestamptz)
RETURNS numeric LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT coalesce((SELECT sum(accounted_usd) FROM spend_ledger
                    WHERE occurred_at >= p_since
                      AND (p_brand IS NULL OR brand_key = p_brand)
                      AND (p_feature IS NULL OR feature = p_feature)), 0)
       + coalesce((SELECT sum(estimate_usd) FROM spend_holds
                    WHERE status = 'held'
                      AND (p_brand IS NULL OR brand_key = p_brand)
                      AND (p_feature IS NULL OR feature = p_feature)), 0);
$$;

CREATE OR REPLACE FUNCTION public.reserve_spend(
  p_brand text, p_feature text, p_estimate numeric, p_max numeric, p_idempotency text,
  p_job uuid, p_subject_kind text, p_subject_id text, p_ttl_seconds integer,
  p_default_daily numeric, p_default_monthly numeric)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE c paid_feature_controls; l workspace_spend_limits; h spend_holds;
  v_day timestamptz := date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  v_month timestamptz := date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  v_daily numeric; v_monthly numeric; v_id uuid;
BEGIN
  IF p_estimate IS NULL OR p_estimate <= 0 THEN RAISE EXCEPTION 'estimate must be positive'; END IF;
  IF p_ttl_seconds < 60 OR p_ttl_seconds > 86340 THEN RAISE EXCEPTION 'invalid hold ttl'; END IF;
  -- Serialise per workspace and per feature: reservations race on caps, never on the network.
  PERFORM pg_advisory_xact_lock(hashtext('f01:spend:brand:' || p_brand));
  PERFORM pg_advisory_xact_lock(hashtext('f01:spend:feature:' || p_feature));
  SELECT * INTO h FROM spend_holds WHERE brand_key = p_brand AND idempotency_key = p_idempotency;
  IF FOUND THEN
    IF h.status = 'held' THEN RETURN jsonb_build_object('granted', true, 'hold_id', h.id, 'existing', true); END IF;
    RETURN jsonb_build_object('granted', false, 'reason', 'duplicate_paid_call', 'hold_id', h.id);
  END IF;
  SELECT * INTO c FROM paid_feature_controls WHERE feature = p_feature;
  IF NOT FOUND OR NOT c.enabled OR (c.mode = 'allowlist' AND NOT (p_brand = ANY(c.brand_allowlist))) THEN
    RETURN jsonb_build_object('granted', false, 'reason', 'feature_disabled');
  END IF;
  IF p_max IS NOT NULL AND p_estimate > p_max THEN
    RETURN jsonb_build_object('granted', false, 'reason', 'over_approved_max', 'estimate_usd', p_estimate);
  END IF;
  IF c.max_call_usd IS NOT NULL AND p_estimate > c.max_call_usd THEN
    RETURN jsonb_build_object('granted', false, 'reason', 'over_approved_max', 'estimate_usd', p_estimate,
                              'limit_usd', c.max_call_usd);
  END IF;
  IF c.daily_cap_usd IS NOT NULL AND f01_committed_usd(NULL, p_feature, v_day) + p_estimate > c.daily_cap_usd THEN
    RETURN jsonb_build_object('granted', false, 'reason', 'daily_cap', 'scope', 'feature');
  END IF;
  SELECT * INTO l FROM workspace_spend_limits WHERE brand_key = p_brand;
  v_daily := CASE WHEN FOUND THEN l.daily_cap_usd ELSE p_default_daily END;
  v_monthly := CASE WHEN FOUND THEN l.monthly_cap_usd ELSE p_default_monthly END;
  IF v_daily IS NOT NULL AND f01_committed_usd(p_brand, NULL, v_day) + p_estimate > v_daily THEN
    RETURN jsonb_build_object('granted', false, 'reason', 'daily_cap', 'scope', 'workspace', 'limit_usd', v_daily);
  END IF;
  IF v_monthly IS NOT NULL AND f01_committed_usd(p_brand, NULL, v_month) + p_estimate > v_monthly THEN
    RETURN jsonb_build_object('granted', false, 'reason', 'workspace_cap', 'limit_usd', v_monthly);
  END IF;
  INSERT INTO spend_holds(brand_key, feature, idempotency_key, job_id, subject_kind, subject_id,
                          estimate_usd, max_usd, expires_at)
  VALUES (p_brand, p_feature, p_idempotency, p_job, p_subject_kind, p_subject_id, p_estimate, p_max,
          now() + make_interval(secs => p_ttl_seconds))
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('granted', true, 'hold_id', v_id, 'existing', false);
END $$;

-- Settle a hold with one or more cost rows (OpenSEO: one hold, each call credited separately).
-- p_costs: [{provider, endpoint, units?, actual_usd|null, cost_source, suffix?, meta?}]
CREATE OR REPLACE FUNCTION public.settle_spend(p_hold uuid, p_costs jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE h spend_holds; r jsonb; i integer := 0; v_actual numeric := 0; v_unknown boolean := false;
  v_rows integer; v_est numeric; v_cost numeric; v_src text;
BEGIN
  SELECT * INTO h FROM spend_holds WHERE id = p_hold FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'hold not found'; END IF;
  IF h.status <> 'held' THEN RETURN jsonb_build_object('settled', false, 'status', h.status); END IF;
  v_rows := jsonb_array_length(p_costs);
  IF v_rows < 1 OR v_rows > 200 THEN RAISE EXCEPTION 'settle needs 1..200 cost rows'; END IF;
  FOR r IN SELECT value FROM jsonb_array_elements(p_costs) LOOP
    i := i + 1;
    v_cost := (r->>'actual_usd')::numeric;
    v_src := r->>'cost_source';
    IF v_cost IS NOT NULL AND v_cost < 0 THEN RAISE EXCEPTION 'negative cost'; END IF;
    -- Unknown cost rows are counted at their share of the estimate.
    v_est := round(h.estimate_usd / v_rows, 6);
    IF v_cost IS NULL THEN v_unknown := true; v_src := 'reservation'; ELSE v_actual := v_actual + v_cost; END IF;
    INSERT INTO spend_ledger(brand_key, feature, hold_id, job_id, source_ref, provider, endpoint, units,
                             estimate_usd, actual_usd, accounted_usd, cost_source, meta)
    VALUES (h.brand_key, h.feature, h.id, h.job_id,
            'hold:' || h.id || CASE WHEN v_rows > 1 THEN ':' || i ELSE '' END,
            r->>'provider', r->>'endpoint', (r->>'units')::numeric, v_est, v_cost,
            coalesce(v_cost, v_est), v_src, coalesce(r->'meta', '{}'::jsonb)
              || jsonb_build_object('undershoot', v_cost IS NOT NULL AND v_cost > v_est))
    ON CONFLICT (source_ref) DO NOTHING;
  END LOOP;
  UPDATE spend_holds SET status = 'settled', actual_usd = CASE WHEN v_unknown THEN NULL ELSE v_actual END,
         closed_at = now() WHERE id = p_hold;
  RETURN jsonb_build_object('settled', true, 'actual_usd', v_actual, 'unknown', v_unknown,
    'undershoot', v_actual > h.estimate_usd, 'over_max', h.max_usd IS NOT NULL AND v_actual > h.max_usd);
END $$;

CREATE OR REPLACE FUNCTION public.release_spend(p_hold uuid, p_reason text)
RETURNS boolean LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  UPDATE spend_holds SET status = 'released', release_reason = left(p_reason, 200), closed_at = now(),
         actual_usd = 0 WHERE id = p_hold AND status = 'held';
  RETURN FOUND;
END $$;

CREATE OR REPLACE FUNCTION public.expire_spend_holds(p_limit integer DEFAULT 500)
RETURNS integer LANGUAGE plpgsql SET search_path = public AS $$
DECLARE h spend_holds; v integer := 0;
BEGIN
  FOR h IN SELECT * FROM spend_holds WHERE status = 'held' AND expires_at < now()
            ORDER BY expires_at LIMIT p_limit FOR UPDATE SKIP LOCKED LOOP
    INSERT INTO spend_ledger(brand_key, feature, hold_id, job_id, source_ref, provider, endpoint,
                             estimate_usd, actual_usd, accounted_usd, cost_source, meta)
    VALUES (h.brand_key, h.feature, h.id, h.job_id, 'hold:' || h.id, 'unknown', 'expired_hold',
            h.estimate_usd, NULL, h.estimate_usd, 'reservation', jsonb_build_object('expired', true))
    ON CONFLICT (source_ref) DO NOTHING;
    UPDATE spend_holds SET status = 'expired', closed_at = now() WHERE id = h.id;
    v := v + 1;
  END LOOP;
  RETURN v;
END $$;

CREATE OR REPLACE FUNCTION public.prune_spend(p_holds_before timestamptz, p_ledger_before timestamptz, p_limit integer DEFAULT 5000)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_l integer; v_h integer;
BEGIN
  WITH old AS (SELECT id FROM spend_ledger WHERE occurred_at < p_ledger_before ORDER BY occurred_at LIMIT p_limit)
  DELETE FROM spend_ledger s USING old WHERE s.id = old.id;
  GET DIAGNOSTICS v_l = ROW_COUNT;
  WITH old AS (SELECT id FROM spend_holds WHERE status <> 'held' AND closed_at < p_holds_before
                ORDER BY closed_at LIMIT p_limit)
  DELETE FROM spend_holds s USING old WHERE s.id = old.id;
  GET DIAGNOSTICS v_h = ROW_COUNT;
  RETURN jsonb_build_object('ledger', v_l, 'holds', v_h);
END $$;

REVOKE ALL ON FUNCTION public.f01_committed_usd(text,text,timestamptz),
  public.reserve_spend(text,text,numeric,numeric,text,uuid,text,text,integer,numeric,numeric),
  public.settle_spend(uuid,jsonb), public.release_spend(uuid,text), public.expire_spend_holds(integer),
  public.prune_spend(timestamptz,timestamptz,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.f01_committed_usd(text,text,timestamptz),
  public.reserve_spend(text,text,numeric,numeric,text,uuid,text,text,integer,numeric,numeric),
  public.settle_spend(uuid,jsonb), public.release_spend(uuid,text), public.expire_spend_holds(integer),
  public.prune_spend(timestamptz,timestamptz,integer) TO service_role;
NOTIFY pgrst, 'reload schema';
```

Retention: `spend_ledger` keeps 13 months (OpenSEO keeps 13 months of AI runs); closed `spend_holds` keep 90 days.

#### `supabase/migrations/042_f01_provider_cache.sql`

```sql
-- F01: soft-TTL, schema-validated provider cache (port of OpenSEO r2-cache.ts to Postgres + Storage).
CREATE TABLE IF NOT EXISTS public.provider_cache (
  key text PRIMARY KEY CHECK (key ~ '^[0-9a-f]{64}$'),
  namespace text NOT NULL CHECK (namespace ~ '^[a-z][a-z0-9_.:-]{1,80}$'),
  version integer NOT NULL CHECK (version >= 1),
  scope text NOT NULL CHECK (scope IN ('workspace','global')),
  brand_key text REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  value jsonb,
  storage_path text,
  size_bytes integer NOT NULL CHECK (size_bytes >= 0),
  fetched_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT provider_cache_one_body CHECK ((value IS NULL) <> (storage_path IS NULL)),
  CONSTRAINT provider_cache_scope CHECK ((scope = 'workspace') = (brand_key IS NOT NULL))
);
COMMENT ON COLUMN public.provider_cache.storage_path IS 'provider-cache bucket object for bodies over 256 KB.';
CREATE INDEX IF NOT EXISTS provider_cache_expires_idx ON public.provider_cache (expires_at);
CREATE INDEX IF NOT EXISTS provider_cache_ns_idx ON public.provider_cache (namespace, version);
ALTER TABLE public.provider_cache ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.provider_cache FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.provider_cache TO service_role;
-- Service-only by design: cached provider payloads are never read by browsers.

INSERT INTO storage.buckets(id, name, public) VALUES ('provider-cache', 'provider-cache', false)
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.prune_provider_cache(p_expired_before timestamptz, p_limit integer DEFAULT 1000)
RETURNS SETOF text LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RETURN QUERY
  WITH old AS (SELECT key FROM provider_cache WHERE expires_at < p_expired_before ORDER BY expires_at LIMIT p_limit)
  DELETE FROM provider_cache p USING old WHERE p.key = old.key RETURNING p.storage_path;
END $$;
REVOKE ALL ON FUNCTION public.prune_provider_cache(timestamptz,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_provider_cache(timestamptz,integer) TO service_role;
NOTIFY pgrst, 'reload schema';
```

#### `supabase/migrations/043_f01_jobs_cron.sql`

```sql
-- F01: drive /api/jobs/tick every minute from Supabase pg_cron + pg_net.
-- URL and secret live in Supabase Vault (names below); this file holds no secret.
-- Databases without pg_cron/pg_net (CI, local QA) skip the schedule and still apply.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron')
     AND EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_net') THEN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
    CREATE EXTENSION IF NOT EXISTS pg_net;
  ELSE
    RAISE NOTICE 'F01: pg_cron/pg_net unavailable; jobs tick schedule not installed';
  END IF;
END $$;

-- plpgsql resolves vault/net at call time, so this compiles without them.
CREATE OR REPLACE FUNCTION public.jobs_tick_http() RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_url text; v_secret text; v_request bigint;
BEGIN
  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'perceev_jobs_tick_url';
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'perceev_cron_secret';
  IF v_url IS NULL OR v_secret IS NULL THEN
    RAISE NOTICE 'F01: jobs tick not configured (vault secrets missing)';
    RETURN NULL;
  END IF;
  SELECT net.http_post(
    url := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 5000) INTO v_request;
  RETURN v_request;
END $$;
REVOKE ALL ON FUNCTION public.jobs_tick_http() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.jobs_tick_http() TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'perceev-jobs-tick';
    PERFORM cron.schedule('perceev-jobs-tick', '* * * * *', 'SELECT public.jobs_tick_http()');
  END IF;
END $$;
```

**044** is reserved and intentionally unused.

`scripts/setup-supabase.mjs` required objects (append):

```js
"040_f01_jobs.sql": [
  {kind:"table",name:"jobs"},{kind:"table",name:"job_steps"},{kind:"table",name:"job_periodic"},
  {kind:"function",name:"enqueue_job"},{kind:"function",name:"claim_due_jobs"},
  {kind:"function",name:"job_step_begin"},{kind:"function",name:"job_step_complete"},
  {kind:"function",name:"job_step_fail"},{kind:"function",name:"job_sleep"},{kind:"function",name:"job_yield"},
  {kind:"function",name:"job_progress"},{kind:"function",name:"job_finish"},{kind:"function",name:"cancel_job"},
  {kind:"function",name:"reconcile_stale_jobs"},{kind:"function",name:"claim_due_periodic"},
  {kind:"function",name:"prune_jobs"},{kind:"index",name:"jobs_single_active_idx"},
],
"041_f01_spend.sql": [
  {kind:"table",name:"paid_feature_controls"},{kind:"table",name:"workspace_spend_limits"},
  {kind:"table",name:"spend_holds"},{kind:"table",name:"spend_ledger"},
  {kind:"function",name:"reserve_spend"},{kind:"function",name:"settle_spend"},
  {kind:"function",name:"release_spend"},{kind:"function",name:"expire_spend_holds"},
  {kind:"function",name:"prune_spend"},{kind:"function",name:"f01_committed_usd"},
],
"042_f01_provider_cache.sql": [
  {kind:"table",name:"provider_cache"},{kind:"function",name:"prune_provider_cache"},
],
"043_f01_jobs_cron.sql": [{kind:"function",name:"jobs_tick_http"}],
```

### 6.2 Server modules

**Import rule for all new server code (binding for every spec).** Modules under `src/lib/**` import other modules with **relative paths and explicit extensions** (`./store.ts`, `../keepAlive.js`), never `@/`, so `node --test` runs them without a bundler. `@/` stays for `src/app/**` and `src/components/**`. TypeScript must be erasable-only (no `enum`, `namespace`, parameter properties, `import =`); `erasableSyntaxOnly` enforces this.

#### `src/lib/http/errors.ts` (PATTERN, `openseo:src/server/lib/errors.ts`)

```ts
export class AppError extends Error {
  readonly status: number; readonly code: string; readonly recovery?: string;
  readonly details?: Record<string, unknown>;
  constructor(status: number, code: string, message: string,
              opts?: { recovery?: string; details?: Record<string, unknown>; cause?: unknown });
}
export class WorkspaceError extends AppError {}          // status 401 | 403 | 404 | 503
export function isAppError(e: unknown): e is AppError;
export function toErrorResponse(err: unknown): Response;
export const NO_STORE: HeadersInit;                      // { "Cache-Control": "no-store" }
export function jsonOk(body: unknown, status?: number): Response; // JSON + NO_STORE
```

`toErrorResponse` rules, in order:
1. `AppError` → `status`, body `{ error: message, code, recovery?, details? }`.
2. `ZodError` (zod v4 `z.ZodError`) → 400 `{ error: "The request was not valid.", code: "invalid_request", details: { issues: [{ path: "a.b", message }] } }` (path and message only; never the received value).
3. `SpendRefused` (from `src/lib/spend/errors.ts`) → `feature_disabled` 403 "This feature is not enabled for your workspace."; `daily_cap` 402 "Today's spend limit for this workspace has been reached." recovery "Try again tomorrow or ask the workspace owner to raise the limit."; `workspace_cap` 402 "This month's spend limit for this workspace has been reached."; `over_approved_max` 409 "This now costs more than you approved. Review the new price." with `details.estimateUsd`.
4. `SyntaxError` from `request.json()` → 400 `invalid_json` "The request body must be JSON."
5. Anything else → 500 `{ error: "Something went wrong. Please retry.", code: "internal_error" }` and `console.error("[http] unhandled", err instanceof Error ? err.name + ": " + err.message.slice(0, 200) : typeof err)`.

Every response carries `Cache-Control: no-store` and `Content-Type: application/json`.

#### `src/lib/workspace/requireWorkspace.ts`

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
export type CustomerBrand = { brandKey: string; role: "owner" | "member"; display_name: string;
  website: string; website_host: string; aliases: string[]; is_active: boolean };
export type Workspace = { user: { id: string; email: string }; brandKey: string; brand: CustomerBrand;
  role: "owner" | "member"; admin: SupabaseClient };
export async function requireWorkspace(request: Request,
  opts?: { brandKey?: string; role?: "owner" | "member" },
  deps?: { getCustomerContext?: () => Promise<CustomerContext>; getSupabaseAdmin?: () => SupabaseClient | null }
): Promise<Workspace>;
```

Built on `getCustomerContext()` (`../supabase/customer.js`) and `getSupabaseAdmin()` (`../supabase/admin.js`). Order of checks and errors (exact copy reused from `customerRouteContext`):

| Check | Throws |
|---|---|
| `context.error === "auth_not_configured"` | `WorkspaceError(503, "auth_not_configured", "Customer login is not configured.")` |
| no `context.user` | `WorkspaceError(401, "unauthenticated", "Please sign in.")` |
| other `context.error` | `WorkspaceError(503, "membership_unavailable", "Could not load workspace access.")` |
| method not GET/HEAD and `Origin` differs from the request origin, or `Sec-Fetch-Site: cross-site` | `WorkspaceError(403, "cross_site", "Cross-site requests are not allowed.")` |
| brand key = `opts.brandKey` ?? `?brand_key=` ?? first membership; not a membership | `WorkspaceError(404, "workspace_not_found", "Workspace not found.")` |
| `opts.role === "owner"` and membership role is `member` | `WorkspaceError(403, "owner_required", "Only the workspace owner can do this.")` |
| `getSupabaseAdmin()` returns null | `WorkspaceError(503, "storage_unavailable", "Workspace storage is unavailable.")` |

`user.email` is `context.user.email ?? ""`. `deps` exists for unit tests only; route code never passes it. Existing routes are not migrated by F01. New routes must use it.

#### `src/lib/http/routeContract.ts` and `src/lib/http/schemaContract.ts`

```ts
// schemaContract.ts — PORT of output-schema-contract.test.ts:16-65
export function closedOutputPaths(schema: unknown, path: string): string[];
// routeContract.ts
import type { ZodType } from "zod";
export type RouteContract = { id: string; method: "GET"|"POST"|"PUT"|"PATCH"|"DELETE"; path: string;
  file: string; auth: "workspace" | "workspace_owner" | "cron" | "operator";
  request?: ZodType; query?: ZodType; response: ZodType; errorCodes: string[];
  examples: { response: unknown }[] };
export function defineRouteContract(c: RouteContract): RouteContract;
```

Each feature declares contracts in `src/lib/<feature>/<name>.contract.ts` and exports `export const contracts: RouteContract[]`. No central list; the test discovers files by glob, so parallel PRs never conflict.

Rules the test enforces (`src/lib/http/routeContract.test.ts`):
- every discovered contract has a `response` schema and at least one example;
- `closedOutputPaths(z.toJSONSchema(response, { io: "output" }), id)` is empty, so responses use `z.looseObject`;
- every example parses with `response`;
- `file` exists on disk and exports a handler named `method`;
- `request` and `query` schemas are closed (use `z.strictObject`; §9 "reject unknown fields"), checked with `z.toJSONSchema(request, { io: "input" })` having `additionalProperties: false` at the root.

#### `src/lib/features/flags.ts`, `src/lib/features/names.ts`

```ts
// names.ts — each spec appends one entry in its own PR.
export const FEATURES = {
  jobs_tick: { spend: [] as const },
} as const;
export type FeatureName = keyof typeof FEATURES;
// flags.ts
export async function isFeatureEnabled(name: FeatureName, brandKey?: string,
  deps?: { env?: Record<string, string | undefined>; admin?: SupabaseClient | null; now?: () => number }): Promise<boolean>;
export function featureEnvName(name: FeatureName): string; // "jobs_tick" -> "FEATURE_JOBS_TICK"
```

Semantics:
1. Read `FEATURE_<NAME>`: `on`, `off`, or `allowlist` (case-insensitive, trimmed). With `allowlist`, the brand must be in `FEATURE_<NAME>_BRANDS` (comma-separated brand keys); no brand → false.
2. Unset or any other value → `off` when `resolveNodeEnv({NODE_ENV, VERCEL_ENV}) === "production"` (imported from `../operatorPerimeter.js`), else `on`.
3. If the entry lists spend features, every one must have an enabled `paid_feature_controls` row that admits the brand (`mode = 'all'` or brand in `brand_allowlist`). A missing row, missing service client or read error → false (fail closed).
4. Results are cached in-process for 30 s per `(name, brandKey)`.

#### `src/lib/spend/`

| File | Exports |
|---|---|
| `features.ts` | `export const SPEND_FEATURES = ["platform.selftest"] as const; export type SpendFeature = typeof SPEND_FEATURES[number]; export function isSpendFeature(v: string): v is SpendFeature;` Each spec appends its values. |
| `errors.ts` | `export class SpendRefused extends AppError { reason: "feature_disabled"\|"workspace_cap"\|"daily_cap"\|"over_approved_max"; scope?: "feature"\|"workspace"; limitUsd?: number }`; `export class ChargedCallError extends Error { actualUsd: number; provider: string; endpoint: string }` (provider failed after billing); `export class UnbilledCallError extends Error {}` (provider rejected without billing); `export class AmbiguousCallError extends Error {}` (sent, outcome unknown). |
| `money.ts` | `export function usd6(n: number): number` (round half-up to 6 decimals via integer micro-dollars); `export function toMicros(n: number): number; export function fromMicros(m: number): number;` |
| `store.ts` | `export function createSpendStore(admin: SupabaseClient): SpendStore`; `SpendStore` = `{ reserve(args): Promise<ReserveResult>; settle(holdId, costs): Promise<SettleResult>; release(holdId, reason): Promise<boolean>; expire(limit): Promise<number>; prune(holdsBefore, ledgerBefore): Promise<{ledger:number;holds:number}> }` — thin RPC wrappers over §6.1 functions. `src/lib/spend/memoryStore.ts` implements the same interface in memory for unit tests (same refusal order). |
| `index.ts` | §5 API below. |

```ts
// src/lib/spend/index.ts  (§5 names, plus two additive options and one additive export)
export async function reserveSpend(i: { brandKey: string; feature: SpendFeature; estimateUsd: number; maxUsd?: number;
  jobId?: string; idempotencyKey: string; ttlSeconds?: number; subject?: { kind: string; id: string } },
  deps?: SpendDeps): Promise<{ holdId: string }>;
export async function settleSpend(holdId: string, actualUsd: number | null,
  meta?: { provider: string; endpoint: string; units?: number; providerCostReported?: boolean }, deps?: SpendDeps): Promise<void>;
export async function settleSpendBatch(holdId: string, costs: SpendCost[], deps?: SpendDeps): Promise<void>;
export async function releaseSpend(holdId: string, reason: string, deps?: SpendDeps): Promise<void>;
export async function metered<T>(i: { brandKey: string; feature: SpendFeature; estimateUsd: number; maxUsd?: number;
  idempotencyKey: string; jobId?: string; ttlSeconds?: number },
  call: () => Promise<{ value: T; actualUsd: number | null; provider: string; endpoint: string; billed: boolean; units?: number }>,
  deps?: SpendDeps): Promise<T>;
export type SpendCost = { provider: string; endpoint: string; units?: number; actualUsd: number | null;
  costSource: "provider_reported" | "price_table"; meta?: Record<string, string | number | boolean> };
type SpendDeps = { store?: SpendStore; env?: Record<string, string | undefined>; keepAlive?: typeof keepAlive; logger?: Pick<Console, "error" | "warn"> };
```

Behaviour:
- `reserveSpend` validates the input (`estimateUsd` finite and > 0, at most USD 1,000; `ttlSeconds` 60–86,340, default 1,800, which is OpenSEO's 30-minute `HOLD_TTL_MS`; `idempotencyKey` 1–300 chars). It calls `reserve_spend` with `p_default_daily = env.SPEND_DEFAULT_DAILY_CAP_USD` and `p_default_monthly = env.SPEND_DEFAULT_MONTHLY_CAP_USD` (each `null` when unset or blank; a non-numeric value throws `AppError(500,"spend_config_invalid")`). `granted:false` maps to `SpendRefused(reason)`, except `duplicate_paid_call`, which maps to `AppError(409,"duplicate_paid_call","This paid request was already made.")`. A database error throws `AppError(503,"spend_unavailable","Spend control is unavailable, so paid work is paused.")`: the guard fails closed.
- `settleSpend(holdId, actual, meta)` calls `settleSpendBatch` with one cost: `costSource = meta.providerCostReported === false ? "price_table" : "provider_reported"`. When `actual` is null, `settle_spend` records `reservation`.
- `settleSpendBatch` **never throws**, following OpenSEO `subscription.ts:477-520`. A failed RPC is retried once after 250 ms. If it still fails, it logs `console.error("[spend] settle failed", { holdId, rows: costs.length })`, and the hold later expires and is counted at its estimate. When the result says `undershoot`, it logs `console.error("[spend] estimate undershoot", { feature, provider, endpoint, estimateUsd, actualUsd })`. When it says `over_max`, it logs `console.error("[spend] over approved max", { holdId, maxUsd, actualUsd })`. Never log payloads, prompts, answers or headers.
- `metered` order: `reserveSpend` → `call()` → settle or release. The work after `reserveSpend` is one promise registered with `keepAlive(work, { label: "metered:" + feature })` and also awaited, so a caller whose HTTP response has gone still settles (OpenSEO `client.ts:404-413`). Outcomes:

| `call()` outcome | Spend action | Returned / thrown |
|---|---|---|
| resolves, `billed === false` | `release(hold, "not_billed")` | `value` |
| resolves, `billed === true` | `settle(hold, actualUsd)`; `null` = unknown, counted at estimate | `value` |
| throws `UnbilledCallError` | `release(hold, "unbilled_error")` | rethrow |
| throws `ChargedCallError` | `settle(hold, err.actualUsd)` | rethrow |
| throws `AmbiguousCallError` or any other error | `settle(hold, null)`; logs `[spend] unclassified call error` (name only) | rethrow |

There are no retries inside `metered`. Billed calls run once (§6.4 of the conventions).

#### `src/lib/jobs/`

| File | Exports and responsibility |
|---|---|
| `types.ts` | `JobStatus`, `JobContext<P>` (includes optional-to-use `cancelRequested(): Promise<boolean>`, rule 10a), `JobResult = { status?: "completed" \| "partial"; result?: unknown }`, `JobDefinition`, `StepOptions = { timeoutMs: number; retries: number; billed?: boolean }` |
| `registry.ts` | `defineJob<P>(kind: string, handler: (ctx: JobContext<P>) => Promise<JobResult>, opts?: { payloadSchema?: ZodType<P>; pollAfterSeconds?: number; deadlineSeconds?: number; maxInvocations?: number; leaseSeconds?: number }): void`; `getJobDefinition(kind)`; `listJobKinds()`. Throws `AppError(500,"duplicate_job_kind")` on re-definition. Kind regex as in SQL. |
| `kinds.ts` | Side-effect imports of every feature's job module (`import "./maintenance.ts";` then one line per spec). The tick route imports this file. |
| `stepConfigs.ts` | PORT of OpenSEO's step presets: `SINGLE_ATTEMPT = { retries: 0, timeoutMs: 120_000, billed: true }`, `READ_STEP = { retries: 2, timeoutMs: 120_000 }`, `DB_STEP = { retries: 3, timeoutMs: 60_000 }`, `LONG_PAID_STEP = { retries: 0, timeoutMs: 220_000, billed: true }`. |
| `store.ts` | `createJobStore(admin)` → `JobStore` RPC wrappers for every §6.1 jobs function plus `getJob(id)`; `memoryStore.ts` implements the same semantics in memory for unit tests. |
| `enqueue.ts` | `enqueueJob<P>(kind, payload, opts: { brandKey: string; dedupeKey?: string; singleActiveKey?: string; runAt?: Date; trigger?: "manual"\|"scheduled"\|"baseline"; createdBy?: string })` → `{ jobId, deduped }`; `enqueueSystemJob<P>(kind, payload, opts: { dedupeKey?: string; singleActiveKey?: string; runAt?: Date })`. Validates the kind is registered and the payload with `payloadSchema`, and that `JSON.stringify(payload).length < 32_768`. A single-active conflict throws `AppError(409,"job_already_running","This is already running.", { details: { activeJobId } })`. After a fresh enqueue with `runAt` ≤ now + 5 s, it fires one self-continue to `/api/jobs/tick?job_id=<id>` via `makeSelfContinue({ routePath: "/api/jobs/tick", label: "jobs" })`, so manual jobs start at once rather than at the next minute. |
| `runner.ts` | `runJob(job: JobRow, env: RunEnv): Promise<RunOutcome>`; `RunEnv = { store; owner: string; deadlineMs: number; now(): number; selfContinue(jobId): void; logger }`; `RunOutcome = "completed"\|"partial"\|"failed"\|"cancelled"\|"yielded"\|"lost_lease"`. Builds `JobContext`, replays the handler and implements the step semantics below. |
| `status.ts` | `getJobStatus(jobId, deps?)` (§5 shape); `pollAfterFor(job, def, now)` |
| `cancel.ts` | `cancelJob(jobId, deps?)`: calls `cancel_job`; `not_found` → `AppError(404,"job_not_found")`. |
| `periodic.ts` | `definePeriodic({ name: string; everySeconds: number; run: (now: Date) => Promise<void> })`; `runDuePeriodics(now, deps)` |
| `watchdog.ts` | `runWatchdog(deps)`: `reconcile_stale_jobs(100)` then `expire_spend_holds(500)`. Each is wrapped and its error recorded, never thrown (port of `server.ts:235-259`: run all, then report). |
| `maintenance.ts` | Registers system job kinds `jobs.retention` and `spend.retention` and `cache.retention` and their periodics (§6.3.6). |
| `tick.ts` | `runTick({ jobId?: string; startedAt: number }, deps?)` → `TickReport` |

**Step semantics in `runner.ts`** (the Cloudflare Workflows contract, on Postgres):

1. *Replay model.* Each invocation calls the handler from the top. `step.do` returns memoised outputs for completed steps, so code outside steps must be deterministic and free of side effects. Read time inside a step if it must be stable.
2. *Definition checks* (before any DB call): `billed === true` with `retries > 0` → `AppError(500,"billed_step_retries")`; `retries` must be 0–5; `timeoutMs` 1–230,000; a step name 1–200 characters, unique within the job, and not reused between `do` and `sleep`.
3. *Cancellation check.* Before each `step.do`/`step.sleep` the runner re-reads `cancel_requested_at` (cached for 5 s). If set, it throws the internal `JobCancelled`, and the job finishes `cancelled` with `error_code = "cancelled"`.
4. *Budget check.* If `deadlineMs − now() < timeoutMs + 10_000`, the step is not started. The runner calls `job_yield(run_at = now)`, fires `selfContinue(jobId)` and throws the internal `JobYield`.
5. `job_step_begin` → `memoised` returns `output`; `failed` throws `StepFailedError { code, message }` to the handler (which may catch it and continue, e.g. to finish `partial`); `wait` yields until `wake_at`; `lost_lease` stops the run without writes; `run` executes `fn()` raced against `timeoutMs`.
6. On success the output is checked (`JSON.stringify` must succeed, round-trip equal and be < 65,536 bytes; otherwise the step fails with `step_output_not_json` / `step_output_too_large`, never retried), then `job_step_complete` (renews the lease).
7. On error or timeout: for a billed step, `job_step_fail(retry_at = NULL)` and `StepFailedError` is thrown (no retry, even on 5xx; conventions §6.4). For a non-billed step with attempts left, `job_step_fail(retry_at = now + min(2^attempt × 2 s, 60 s))`; if the wait is ≤ 10 s and the budget allows, the runner waits in-process and re-begins, otherwise it yields to `retry_at`. With none left it fails with `step_attempts_exhausted`. Error messages stored are `err.message.slice(0, 500)` with URLs' query strings removed by `redactForLog()` in `runner.ts`.
8. `step.sleep(name, seconds)` → `job_sleep`; a non-null wake time yields with `run_at = wake`. Sleeps longer than the remaining budget always yield; there is no in-process sleep over 10 s.
9. Handler return → `job_finish(status = result.status ?? "completed", result = result.result ?? null)`; a result over 64 KB → `failed`/`result_too_large`. A thrown `AppError` → `failed` with its code. Any other error → `failed`/`job_failed` with the message trimmed.
10. `progress(done, total, label)` → `job_progress`; it also renews the lease. Called at most once per second (extra calls are coalesced).
10a. `cancelRequested(): Promise<boolean>` lets a long-running step poll for cancellation mid-step (F18 crawls). It reads `cancel_requested_at` through the same 5 s cache as rule 3 and never throws; the handler decides how to stop (e.g. return `partial`).
11. Unknown kind → `job_finish(failed, "unknown_job_kind")`. Payload failing `payloadSchema` → `failed`/`invalid_payload`.

`idempotencyKey` convention for paid calls inside jobs: `jobStepKey(ctx, stepName) = \`job:${ctx.jobId}:${stepName}\``, exported from `runner.ts`.

#### `src/lib/cache/providerCache.ts` (PORT of `r2-cache.ts`)

```ts
export async function cached<T>(i: { namespace: string; version: number; keyParts: unknown[]; ttlSeconds: number;
  schema: ZodType<T>; scope: "workspace" | "global"; brandKey?: string },
  fetcher: () => Promise<T>, deps?: CacheDeps): Promise<{ value: T; hit: boolean; fetchedAt: string }>;
export function cacheKey(i: { namespace: string; version: number; keyParts: unknown[]; scope: "workspace"|"global"; brandKey?: string }): string;
export function stableStringify(v: unknown): string; // sorted object keys, recursive; arrays keep order
export const CACHE_INLINE_MAX_BYTES = 262_144;
```

- `cacheKey` = sha256 hex of `stableStringify([namespace, version, keyParts, scope === "workspace" ? brandKey : ""])`. `scope:"workspace"` without `brandKey` → `AppError(500,"cache_scope_invalid")`. `ttlSeconds` 60–2,592,000.
- Read: `select … where key = $1`. If `expires_at > now()` and `schema.safeParse(value)` succeeds, return `hit: true`. An expired row is a miss (soft TTL: the row is not deleted on read). A row that fails the schema is a miss and logs `console.warn("[cache] schema mismatch", { namespace, version })`.
- Miss: in-process single-flight per key (a `Map<string, Promise>`), then `fetcher()`, then `schema.parse(result)` (a fetcher returning invalid data throws, so nothing invalid is cached), then upsert. Bodies over 256 KB go to Storage `provider-cache/<namespace>/<key>.json` with the row holding `storage_path`. Writes run in `keepAlive` and only log failures (`[cache] write failed`, namespace only).
- Cache read failure (DB down) → treated as a miss; the fetcher still runs (and is metered by the caller).
- A cached value is not spend: callers must call `metered()` **inside** `fetcher`, so a hit costs nothing.

#### `src/lib/llm/` (PORT of `openseo:src/server/lib/openrouter.ts`, `chatAgent.ts:26-40`)

```ts
// src/lib/llm/index.ts — §5 names, plus optional maxOutputTokens/timeoutMs
export async function llmObject<T>(i: { brandKey: string; feature: SpendFeature; schema: ZodType<T>; system: string;
  prompt: string; model?: string; maxUsd?: number; idempotencyKey: string; maxOutputTokens?: number; timeoutMs?: number },
  deps?: LlmDeps): Promise<{ object: T; usd: number | null; model: string }>;
export async function llmText(i: { brandKey: string; feature: SpendFeature; system: string; prompt: string; model?: string;
  maxUsd?: number; idempotencyKey: string; maxOutputTokens?: number; timeoutMs?: number },
  deps?: LlmDeps): Promise<{ text: string; usd: number | null; model: string }>;
// src/lib/llm/openrouter.ts
export function openRouterCostUsd(providerMetadata: unknown): number | null; // zod-parsed providerMetadata.openrouter.usage.cost
export function buildModel(modelId: string, env): LanguageModel;             // createOpenRouter({ apiKey, baseURL }) + { usage: { include: true } }
export function estimateLlmUsd(modelId: string, promptChars: number, maxOutputTokens: number, env): number;
type LlmDeps = { env?; model?: LanguageModel; spend?: SpendDeps; generateText?: typeof generateText };
```

- Configuration: key `LLM_API_KEY`, gateway `LLM_BASE_URL` (existing names). Missing key → `AppError(503,"llm_not_configured")`. Model = `i.model ?? env.LLM_HELPER_MODEL ?? getContentModel()` (from `../llm.js`).
- Pre-flight: `assertModelPriceable(model, provider)` from `../llmPricing.js` (fails loud on an unpriced id, standing rule 3). Estimate = `lookupModelPrice(model)` rates × (`ceil(promptChars/3)` input tokens + `maxOutputTokens` output tokens), or `LLM_HELPER_UNPRICED_ESTIMATE_USD` (default 0.05) when the gateway reports cost and the id has no rate. The estimate is rounded up to 6 dp with a 0.000001 floor.
- Call: AI SDK v6 `generateText({ model, system, prompt, maxOutputTokens (default 4000), maxRetries: 0, abortSignal: AbortSignal.timeout(timeoutMs ?? 60_000), output: Output.object({ schema }) })` for `llmObject` (OpenSEO's `aiPromptResearch.ts:258-268` shape), plain text otherwise. `maxRetries: 0` is mandatory: the SDK default retries billed calls.
- Cost: `openRouterCostUsd(result.providerMetadata)`. If null and the gateway is not OpenRouter, use `resolveCost({ model, provider, usage: { prompt_tokens, completion_tokens } })` (`cost_source` price_table). If neither works, `null` (unknown). Wrapped in `metered({ feature, estimateUsd, maxUsd, idempotencyKey, ... })` returning `{ value, actualUsd, provider: "openrouter", endpoint: "chat:" + model, billed: true }`. An aborted request throws `AmbiguousCallError`; HTTP 400/401/402/403/404 from the gateway throws `UnbilledCallError`; an output that fails the schema is billed (`ChargedCallError` with the reported cost), then rethrown as `AppError(502,"llm_bad_output")`.
- Never logs `system`, `prompt`, output text or headers. The only log lines are `[llm] call failed { model, code }`.

#### `src/lib/http/safeFetch.ts` and `src/lib/http/hostPolicy.ts`

```ts
// hostPolicy.ts — PORT of url-policy.ts:4-34 (names and normalisation only)
export const BLOCKED_HOSTS: ReadonlySet<string>;   // localhost, metadata.google.internal, metadata, 169.254.169.254, 100.100.100.200
export const BLOCKED_HOST_SUFFIXES: readonly string[]; // .localhost, .local, .localdomain, .internal, .home.arpa
export function normalizeHost(hostname: string): string;
export function isBlockedHostName(hostname: string): boolean;
// safeFetch.ts
export async function safeFetch(url: string, init?: Omit<RequestInit, "redirect"> & {
  maxBytes?: number; timeoutMs?: number; maxRedirects?: number; truncate?: boolean }, deps?: { lookup?: (h: string) => Promise<string[]>; fetchImpl?: typeof fetch }
): Promise<{ url: string; status: number; headers: Headers; body: Uint8Array; truncated: boolean; text(): string; json<T>(): T }>;
```

- Core checks come from `../ssrfGuard.js` `assertPublicUrl` (Node DNS, every notation, fail closed). `hostPolicy` names are checked first, which adds defence in depth for `*.internal` and similar names.
- Connection pinning closes the TOCTOU gap that `ssrfGuard.js:27-40` documents. Each hop builds an `undici` `Agent({ connect: { lookup } })` whose `lookup` answers only with the addresses `assertPublicUrl` vetted for that hostname. `fetch` is `undici.fetch` with `dispatcher`. The agent is closed after the response body has been read.
- Redirects are handled manually as in `ssrfGuard.safeFetch`, with at most `maxRedirects` (default 5) hops, each re-validated. `maxRedirects: 0` does not follow: a 3xx is returned as-is with its `Location` header intact (F19 uses this to tell `moved` from `redirects`). With `maxRedirects ≥ 1`, exceeding the limit throws as before.
- Timeout: `timeoutMs` (default 15,000) across the whole chain; body capped at `maxBytes` (default 5,242,880). Exceeding the cap aborts and throws `AppError(422,"response_too_large")`, unless `truncate: true`, in which case reading stops at `maxBytes` and the result has `truncated: true` (F18 page analysis). `truncated` is `false` on every other response.
- Refusals throw the existing `SsrfBlockedError`. Callers map `isPolicyRefusal` to 422 `url_blocked` ("That address cannot be fetched.") and unusable targets to 422 `url_unreachable`.
- Comparison recorded for reviewers: OpenSEO's DoH lookup fails **open** on DNS errors (`url-policy.ts:155`, `:180`, `:185-187`) and is only applied to the start URL (`:204-210`). Ours fails closed on every hop. We take only their host-name lists.

### 6.3 Jobs

#### 6.3.1 Tick route and cadence

- `pg_cron` job `perceev-jobs-tick` runs `SELECT public.jobs_tick_http()` every minute. That function POSTs to the URL in Vault secret `perceev_jobs_tick_url` (production: `https://perceev.xyz/api/jobs/tick`, the custom domain, which deployment protection does not cover) with `Authorization: Bearer <perceev_cron_secret>`.
- `src/app/api/jobs/tick/route.ts` (`GET` and `POST`, `maxDuration = 300`, `dynamic = "force-dynamic"`):
  1. `isCronAuthorized(request, searchParams, { label: "jobs-tick", warned })` → 401 `{error:"Unauthorized", code:"unauthorized"}`.
  2. `isFeatureEnabled("jobs_tick")` false → 200 `{ skipped: "disabled" }`.
  3. `keepAlive(runTick({ jobId: searchParams.get("job_id") ?? undefined, startedAt }), { label: "jobs-tick" })` and return 202 `{ accepted: true }` immediately, so `pg_net`'s 5 s timeout never cuts the work.
- `/api/jobs/tick` is added to `SELF_GATED` in `src/lib/operatorPerimeter.js` (it authenticates itself with `CRON_SECRET`).

#### 6.3.2 `runTick` order (port of `openseo:src/server.ts:235-259`)

1. `owner = "tick:" + crypto.randomUUID()`, `deadlineMs = startedAt + 240_000`.
2. Watchdog: `reconcile_stale_jobs(100)`, then `expire_spend_holds(500)`. Errors are held.
3. `runDuePeriodics(now)`: for each registered periodic, `claim_due_periodic(name, everySeconds, now)`; if claimed, `run(now)` (which only enqueues system jobs; no heavy work inline), and record `last_finished_at` or `last_error`.
4. `claim_due_jobs(owner, JOBS_TICK_CLAIM_LIMIT (default 8, max 50), leaseSeconds = 300, jobId)`.
5. Run claimed jobs with concurrency `JOBS_TICK_CONCURRENCY` (default 4, max 8) until `deadlineMs`. Jobs not started by then are released with `job_yield(run_at = now)`.
6. If any job yielded with `run_at ≤ now + 5 s`, fire **one** self-continue to `/api/jobs/tick` (no `job_id`).
7. Log one line, `[jobs-tick] claimed=N completed=N partial=N failed=N yielded=N cancelled=N lost=N watchdog=<json>`, then rethrow the first held maintenance error so the invocation reports failure.

Vercel limits: the function is capped at 300 s. The 240 s soft deadline plus the step budget check leaves 60 s for settles in `keepAlive` and for the final writes.

#### 6.3.3 Single active run

`enqueueJob(..., { singleActiveKey })` uses the partial unique index `jobs_single_active_idx`, which is the equivalent of `ai_runs_one_active_idx`. A conflict returns the active job id (`details.activeJobId`). Because the watchdog fails jobs past their deadline, a dead blocker cannot hold the key for longer than the job's deadline. Features should set short deadlines (`deadlineSeconds`) for interactive jobs.

#### 6.3.4 Leases and fencing

- Lease 300 s on claim, renewed by every step completion and progress write.
- Every write function checks `f01_job_fenced` and is a no-op for a stale owner, which returns `lost_lease`. A paid call made by a fenced invocation still settles through `metered()` (the spend ledger is not fenced). Its step is left `running`; on the next claim, `job_step_begin` fails it as `billed_step_interrupted`. The job sees `StepFailedError` and can finish `partial`.

#### 6.3.5 Status and polling

`getJobStatus(jobId)` reads the row and returns:

```json
{ "status": "running", "progress": { "done": 3, "total": 10, "label": "Fetching keyword ideas" },
  "pollAfterSeconds": 5, "result": null, "error": null }
```

`pollAfterSeconds`: terminal → `null`; `run_at > now` (queued later or sleeping) → `clamp(ceil((run_at − now)/1000), 5, 60)`; otherwise the kind's `pollAfterSeconds`, else `trigger === "scheduled" ? 20 : 5` (OpenSEO `aiVisibilityResults.ts:50`). `error` is `{ code, message }` for `failed` and `cancelled`, else `null`. `result` is returned only for `completed` and `partial`.

#### 6.3.6 Retention (system jobs)

| Periodic | Every | Enqueues | Job kind steps |
|---|---|---|---|
| `jobs.retention` | 86,400 s | `enqueueSystemJob("jobs.retention", {}, { dedupeKey: "jobs.retention:" + YYYY-MM-DD })` | `step.do("prune", DB_STEP, () => prune_jobs(now − 30 days, 1000))`, looped ≤ 20 times with step names `prune-1`…`prune-20` while 1,000 rows were deleted |
| `spend.retention` | 86,400 s | same pattern | `prune_spend(now − 90 days, now − 395 days, 5000)` |
| `cache.retention` | 3,600 s | same pattern (key per hour) | `prune_provider_cache(now − 7 days, 1000)`, then delete returned Storage paths from `provider-cache` in batches of 100 |

#### 6.3.7 Cancellation

`POST /api/customer/jobs/[jobId]/cancel` → `cancel_job`. A queued job, or a running one whose lease has expired, is cancelled at once. A running one gets `cancel_requested_at` and stops before its next step. An in-flight paid call completes and is settled. Cancelling never refunds or undoes spend.

#### 6.3.8 Coexistence with the scan worker (not migrated)

- Scans keep their own machinery: `scan_jobs`, `runScanChunk` (150 s chunks), its self-continue, `/api/scan/worker` (daily Vercel cron and poll-driven rescue from `/api/scan/[job_id]/status`), the reaper, the scheduler tick, `scan_jobs_one_running_per_brand`, `jobLease.js` and `claim_probe_dispatch`. F01 does not import, call or schedule any of them, and does not change `vercel.json`.
- The two runners share only `keepAlive()`, `makeSelfContinue()` and `CRON_SECRET`. Their tables and lock keys are disjoint: scan dispatch uses advisory lock `270027`, the spend guard uses `hashtext('f01:spend:…')`, and jobs use row locks.
- The pg_cron tick must not drive `/api/scan/worker`: scan cadence is a P0 control and stays as it is.
- Answer-engine spend is never reserved through `reserveSpend`. It stays per attempt in `probe_attempts`, authorised by `claim_probe_dispatch` with `SCAN_PROBE_RESERVATION_USD`, `SCAN_MAX_COST_PER_SCAN` and `SCAN_MAX_COST_PER_DAY`. F01's caps and P0's caps are independent, and both must pass. F03 mirrors settled probe attempts into `spend_ledger` (`source_ref = probe_attempt:…`) so the Usage page and workspace caps can see answer spend. F09 adds a scan-level accounting hold (`subject_kind = 'scan_job'`) so workspace caps apply before a scan starts. Neither changes how `claim_probe_dispatch` reserves.
- Future work: moving scans onto `jobs` is a separate, owner-approved project after P0 acceptance. Nothing in F01 assumes it.

### 6.4 Provider calls and cost

F01 makes no customer-triggered provider calls. The LLM helper's only F01-owned use is `scripts/qa/check-f01-live.mjs` (feature `platform.selftest`): one `llmText` call with prompt "Reply with the single word: ok", `maxOutputTokens: 5` and `maxUsd: 0.01`. The script refuses to run unless `--max-spend-usd 0.01` is passed and `paid_feature_controls('platform.selftest')` is enabled for the named `--brand`. It prints the ledger row's `cost_source` and `accounted_usd` only. Fixtures: `tests/fixtures/f01/openrouter-generate-usage.json` (a recorded AI SDK `providerMetadata` with `openrouter.usage.cost = 0.000042`, all text replaced by "ok") and `tests/fixtures/f01/openrouter-no-usage.json`.

Cache namespaces: F01 defines none.

### 6.5 API routes

All customer routes use `requireWorkspace` and `toErrorResponse`, and declare a contract in `src/lib/jobs/jobs.contract.ts` or `src/lib/spend/spend.contract.ts`.

**`GET /api/customer/jobs/[jobId]?brand_key=<key>`** (auth: workspace)

```ts
const query = z.strictObject({ brand_key: z.string().min(1).max(200).optional() });
const params = z.strictObject({ jobId: z.uuid() });
const response = z.looseObject({
  jobId: z.uuid(), kind: z.string(), trigger: z.enum(["manual","scheduled","baseline"]),
  status: z.enum(["queued","running","completed","partial","failed","cancelled"]),
  progress: z.looseObject({ done: z.int().min(0), total: z.int().min(0), label: z.string().optional() }).nullable(),
  pollAfterSeconds: z.int().min(5).max(60).nullable(),
  result: z.unknown().nullable(),
  error: z.looseObject({ code: z.string(), message: z.string() }).nullable(),
  createdAt: z.iso.datetime(), finishedAt: z.iso.datetime().nullable() });
```

200 example:

```json
{ "jobId": "5b0d6f6e-9a8b-4a45-9a51-0e7e8f1c2d3a", "kind": "keywords.research", "trigger": "manual",
  "status": "running", "progress": { "done": 3, "total": 10, "label": "Fetching keyword ideas" },
  "pollAfterSeconds": 5, "result": null, "error": null,
  "createdAt": "2026-10-21T09:00:00.000Z", "finishedAt": null }
```

Errors: 400 `invalid_request` (bad uuid); 401/403/404/503 from `requireWorkspace`; 404 `job_not_found` "This job does not exist in this workspace." for another workspace's job or a system job (the same response, so existence is not disclosed). Idempotent; `Cache-Control: no-store`.

**`POST /api/customer/jobs/[jobId]/cancel`** (auth: workspace; members may cancel jobs they or a teammate started)

Request body: `z.strictObject({ brand_key: z.string().min(1).max(200).optional() })`. Response 200: `z.looseObject({ jobId: z.uuid(), status: z.enum(["cancelled","cancel_requested","completed","partial","failed"]) })`.

```json
{ "jobId": "5b0d6f6e-9a8b-4a45-9a51-0e7e8f1c2d3a", "status": "cancel_requested" }
```

Errors: as above, plus 403 `cross_site`. Idempotent: repeating returns the current status.

**`GET|POST /api/jobs/tick[?job_id=<uuid>]`** (auth: cron). Responses: 202 `{ "accepted": true }`; 200 `{ "skipped": "disabled" }`; 401 `{ "error": "Unauthorized", "code": "unauthorized" }`; 400 `invalid_request` when `job_id` is not a uuid.

**Operator routes** (auth: operator token, enforced by the existing middleware perimeter because the paths are neither public nor self-gated):

- `GET /api/ops/spend/controls` → `{ controls: [{ feature, enabled, mode, brandAllowlist, dailyCapUsd, maxCallUsd, note, updatedAt }] }`.
- `PUT /api/ops/spend/controls/[feature]` body `z.strictObject({ enabled: z.boolean(), mode: z.enum(["all","allowlist"]), brandAllowlist: z.array(z.string().min(1)).max(50), dailyCapUsd: z.number().min(0).max(10000).nullable(), maxCallUsd: z.number().positive().max(1000).nullable(), note: z.string().max(500).nullable(), confirm: z.literal(feature) })`. `confirm` must equal the feature key, which stops a mistyped feature from being enabled. Response is the updated control. 404 `unknown_spend_feature` when the key is not in `SPEND_FEATURES`.
- `GET /api/ops/spend/limits?brand_key=` and `PUT /api/ops/spend/limits/[brandKey]` body `z.strictObject({ dailyCapUsd: z.number().min(0).max(10000).nullable(), monthlyCapUsd: z.number().min(0).max(100000).nullable() })`.
- `GET /api/ops/jobs?status=&kind=&brand_key=&limit=50` → the most recent jobs (no payloads; `payload` keys only).

All operator writes set `updated_by = "operator"` and log `[ops] spend control changed { feature, enabled }`. These routes change paid controls. Under conventions §11 they are used only on the owner's instruction, and no PR, test or script calls them against production.

### 6.6 UI

None. F01 ships no customer or operator screens. F03 builds the Usage page and the operator cost view on top of these tables and routes. F09 builds the cost dialog. F05 builds the client polling hook that reads `pollAfterSeconds`.

### 6.7 Permissions, privacy, observability

- **Customers** can read their own workspace's `jobs`, `spend_holds`, `spend_ledger` and `workspace_spend_limits` through RLS. All writes go through service-role routes after `requireWorkspace`. `job_steps`, `job_periodic`, `paid_feature_controls` and `provider_cache` are service-only.
- **Members and owners** can view status and cancel jobs. Changing spend limits and paid controls is operator-only in F01.
- **Logs.** Only the fixed lines named in this spec are logged, with ids, codes, features, providers, endpoints and amounts. Never log payloads, prompts, answers, cached bodies, headers, URLs with query strings, cookies or secrets (CLAUDE.md secrets hygiene; conventions §6.9).
- **PostHog.** No events (F26 owns telemetry). F01 exposes counts in the tick log line.
- **Telemetry and email hooks (F25, F26).** F01 accepts one-line calls, added by those specs' PRs, into `src/lib/telemetry/context.ts` from `requireWorkspace` (sets server-event identity), `toErrorResponse` (5xx error capture), `reserveSpend` (cap-reached refusals, which F25 turns into the spend-cap email) and the job runner (job identity and terminal status). F01 itself ships none of these calls; each hook must be a no-op when F26/F25 are disabled and must never throw into the caller.
- **Vault.** The cron secret is stored once in Supabase Vault by the owner (§10). The migration never contains it.

## 7. Code reuse map

| OpenSEO source | Perceev target | Mode | Adaptation notes |
|---|---|---|---|
| `openseo:LICENSE` | `THIRD_PARTY_NOTICES.md` | COPY | Verbatim MIT text, "Copyright (c) 2026 Ben Senescu". |
| `openseo:src/server/workflows/pgStep.ts:1-29` | `src/lib/jobs/runner.ts` (`step.do`) | PATTERN | Steps memoised in `job_steps` instead of the Workflows engine. No per-step DB client scoping needed (supabase-js is stateless). |
| `openseo:src/server/workflows/AiVisibilityWorkflow.ts:29-58` | `src/lib/jobs/stepConfigs.ts` | PORT | `SINGLE_ATTEMPT`/`COLLECT_STEP`/`LIVE_STEP` become `SINGLE_ATTEMPT`/`READ_STEP`/`LONG_PAID_STEP`. Timeouts capped at 230 s (Vercel), not 10 minutes. `POLL_INTERVALS` style sleeps become `step.sleep`. |
| `openseo:src/server/workflows/auditStepConfigs.ts:1-64` | `src/lib/jobs/stepConfigs.ts` | PORT | Explicit timeout and small retry budget per step; `DB_STEP` retries 3 with exponential backoff (capped at 60 s). |
| `openseo:src/server/features/audit/services/auditReconciler.ts:25-176` | `src/lib/jobs/watchdog.ts` + SQL `reconcile_stale_jobs` | PORT | There is no external instance to query: staleness = lease expired + deadline passed or invocation limit. Oldest first, 100 per batch, per-row isolation kept. |
| `openseo:src/server.ts:235-259` | `src/lib/jobs/tick.ts` | PATTERN | Watchdog first; hold its error; run the rest; rethrow. Triggered by pg_cron, not Worker `scheduled`. |
| `openseo:src/server/features/ai-visibility/repositories/AiVisibilityRepository.ts:225-243` | SQL `claim_due_periodic` | PORT | CAS on `next_run_at` before start; bounded catch-up as in our migration 032. |
| `openseo:src/server/features/ai-visibility/services/scheduledAiVisibility.ts:16-83` | `src/lib/jobs/periodic.ts` | PATTERN | Advance first, then start; per-tick deadline; failures recorded on the schedule row, never block the queue. |
| `openseo:src/db/pg/ai-visibility.schema.ts:62-93` | `jobs_single_active_idx` | PATTERN | Generalised to `(kind, single_active_key)`. |
| `openseo:src/server/features/ai-visibility/services/aiVisibilityRuns.ts:126-187` | `src/lib/jobs/enqueue.ts` | PATTERN | Insert conflict = "already running"; return the blocker's id. |
| `openseo:src/server/lib/dataforseo/client.ts:71-98, 321-430` | `src/lib/spend/index.ts` (`metered`) | PORT | Generic over providers. USD instead of credits. Hold in Postgres instead of Autumn. Settle/release classification via `ChargedCallError`/`UnbilledCallError`/`AmbiguousCallError` (theirs: `DataforseoChargedTaskError`). `waitUntil` → `keepAlive`. |
| `openseo:src/server/billing/subscription.ts:209-298` | SQL `reserve_spend` | PORT | Atomic hold under advisory locks instead of Autumn locks; 30-minute default TTL; same "refuse rather than pass on a stale reading" rule. |
| `openseo:src/server/billing/subscription.ts:313-420` | `settleSpendBatch` + SQL `settle_spend` | PORT | One hold, many cost rows, each recorded separately; earlier holds released on later failure (callers holding several holds use `releaseSpend` in a `finally`). |
| `openseo:src/server/billing/subscription.ts:435-543` | `settleSpendBatch` | PORT | Never throws; one retry; undershoot logging verbatim in intent (`[spend] estimate undershoot`). |
| `openseo:src/server/lib/audit/rendering-billing.ts:24-161` | `reserveSpend({ ttlSeconds })` usage pattern | PATTERN | Long-lived job hold (TTL up to 86,340 s) for worst-case jobs (F18 audits, F09 scans). |
| `openseo:src/server/billing/researchSpend.ts:16-53` | `src/lib/llm/index.ts` | PATTERN | We still reserve an estimate before LLM calls (theirs settles after); settlement uses OpenRouter's reported cost. |
| `openseo:src/server/lib/r2-cache.ts:1-85` | `src/lib/cache/providerCache.ts` | PORT | R2 → `provider_cache` row (inline ≤ 256 KB) or Storage object; soft TTL in `expires_at`; schema validation built into `cached()` instead of left to callers; workspace scoping added. |
| `openseo:src/server/lib/openrouter.ts:47-114` | `src/lib/llm/openrouter.ts` | PORT | Keep `usage: { include: true }`. Drop the chat-agent defaults, region fallback and MiniMax routing (not needed here). Model from our env. |
| `openseo:src/server/lib/chatAgent.ts:26-40` | `src/lib/llm/openrouter.ts` (`openRouterCostUsd`) | COPY | Same zod schema; returns `null` instead of `0` when absent (unknown is not zero, conventions §6.10). |
| `openseo:src/server/lib/audit/url-policy.ts:4-34` | `src/lib/http/hostPolicy.ts` | PORT | Host-name lists and normalisation only; address checks stay in our `ssrfGuard.js`, which is stricter (fails closed, every hop). |
| `openseo:src/server/lib/audit/url-policy.test.ts:8-38` | `src/lib/http/safeFetch.test.ts` | PORT | Same cases (`localhost:3000`, `192.168.0.10` blocked; hash stripped) run against our implementation. |
| `openseo:src/server/mcp/output-schema-contract.test.ts:14-139` | `src/lib/http/schemaContract.ts` + `src/lib/http/routeContract.test.ts` | PORT | Walker copied; applied to route response schemas (and later F21/F22 tools) instead of an MCP server listing. Their walker unit cases ported unchanged. |

## 8. Implementation plan

### Phase 1 — Stack enablement, errors, workspace auth, contract harness

**Goal:** TypeScript, zod and the shared HTTP helpers are in place and tested, with no behaviour change.

- [x] **P1.T1 TypeScript and dependencies**
  - [x] **P1.T1.S1** Add dependencies. *Files:* `package.json`, `package-lock.json`. *Do:* `npm install zod@^4.1.0 ai@^6.0.0 @openrouter/ai-sdk-provider@^1.2.0 undici@^7.0.0` and `npm install -D @types/node@^22.0.0 @types/react@^19.0.0 @types/react-dom@^19.0.0`. Keep `typescript@6.0.3`. The React 19 type packages match F04's React 19 upgrade; until F04 lands, `skipLibCheck` keeps the React 18 runtime building. Commit the lockfile with the exact resolved versions. If `@openrouter/ai-sdk-provider@^1.2.0` does not declare a peer range that includes `ai@6`, install the newest release whose peer range does, and record the version in the PR. *Verify:* `node -e "import('zod').then(m=>console.log(typeof m.z.looseObject))"` → `function`; `node -e "import('ai').then(m=>console.log(typeof m.generateText))"` → `function`.
  - [x] **P1.T1.S2** Create `tsconfig.json`. *Files:* `tsconfig.json` (new); `jsconfig.json` unchanged. *Do:* `{"compilerOptions":{"target":"ES2022","lib":["dom","dom.iterable","esnext"],"allowJs":true,"checkJs":false,"skipLibCheck":true,"strict":true,"noEmit":true,"esModuleInterop":true,"module":"esnext","moduleResolution":"bundler","resolveJsonModule":true,"isolatedModules":true,"jsx":"preserve","incremental":true,"allowImportingTsExtensions":true,"erasableSyntaxOnly":true,"verbatimModuleSyntax":false,"plugins":[{"name":"next"}],"paths":{"@/*":["./src/*"]}},"include":["next-env.d.ts","src/**/*.ts","src/**/*.tsx",".next/types/**/*.ts"],"exclude":["node_modules","worker","scripts"]}`. Run `npm run build` once and commit the `next-env.d.ts` it generates, plus any edits Next makes to `tsconfig.json`. *Verify:* `npm run build` → exit 0; `git diff --stat` shows only `tsconfig.json`, `next-env.d.ts`, `package*.json`.
  - [x] **P1.T1.S3** Add scripts. *Files:* `package.json`. *Do:* set `"test"` and `"test:scoring"` to `node --import ./src/lib/liveWriteGuardAuto.mjs --test-concurrency=4 --test "src/**/*.test.mjs" "src/**/*.test.ts"`; add `"typecheck": "tsc --noEmit -p tsconfig.json"`. *Verify:* `npm test` → same pass count as before plus 0 failures; `npm run typecheck` → exit 0.
  - [x] **P1.T1.S4** Extend the coverage guard. *Files:* `src/lib/testCoverageGuard.test.mjs`. *Do:* `testFilesOnDisk` collects names ending `.test.mjs` **or** `.test.ts`; update the comment and failure message. *Verify:* create a temporary `src/lib/zz.test.ts` with `import test from "node:test"; test("x",()=>{});`, run `node --test src/lib/testCoverageGuard.test.mjs` → pass; temporarily remove `"src/**/*.test.ts"` from the script → guard fails naming `src/lib/zz.test.ts`; restore both and delete the temp file.
  - [x] **P1.T1.S5** CI. *Files:* `.github/workflows/ci.yml`. *Do:* in job `test`, add a step `typecheck` running `npm run typecheck` before `unit tests`. *Verify:* `node --test src/lib/testCoverageGuard.test.mjs` still passes (it asserts that CI runs `npm run test:scoring`).
  - [x] **P1.T1.S6** TS setup guard test. *Files:* `src/lib/platform/tsSetup.test.mjs`. *Do:* assert `tsconfig.json` has `allowJs`, `strict`, `noEmit`, `erasableSyntaxOnly`, `allowImportingTsExtensions` true and `paths["@/*"]` equal to `["./src/*"]`; assert `jsconfig.json` still exists; run `node --input-type=module -e` importing `src/lib/http/errors.ts` to prove Node runs `.ts` directly. *Verify:* `node --test src/lib/platform/tsSetup.test.mjs` → pass.
- [x] **P1.T2 Licence notice**
  - [x] **P1.T2.S1** *Files:* `THIRD_PARTY_NOTICES.md` (new). *Do:* sections "every-app/open-seo (MIT)" with the full text of `openseo:LICENSE` (MIT License / Copyright (c) 2026 Ben Senescu / permission paragraph / conditions paragraph / warranty paragraph, verbatim), the pinned commit `c5f8db19c7ca9e750836b6ed5c8a6491d4f967f4`, and a "Files containing ported portions" list (empty in this phase, then appended per PR). *Verify:* `node --test src/lib/platform/thirdPartyNotices.test.mjs` → pass.
  - [x] **P1.T2.S2** *Files:* `src/lib/platform/thirdPartyNotices.test.mjs`. *Do:* assert the file contains the exact strings "Permission is hereby granted, free of charge" and "Copyright (c) 2026 Ben Senescu"; walk `src/` (no `.env*`, use `readdir`, skip `node_modules`) for files whose first 5 lines contain "Portions ported from every-app/open-seo@c5f8db1" and assert each path appears in the notices list. *Verify:* adding a dummy header to a temp file without listing it fails the test.
- [x] **P1.T3 Errors and workspace auth**
  - [x] **P1.T3.S1** *Files:* `src/lib/http/errors.ts`. *Do:* implement §6.2 exactly (`SpendRefused` mapping via `instanceof` on a class imported from `../spend/errors.ts`, created in this phase with only the class definitions). *Verify:* `node --test src/lib/http/errors.test.ts` → pass.
  - [x] **P1.T3.S2** *Files:* `src/lib/http/errors.test.ts`. *Do:* cases: AppError with recovery and details; ZodError → 400 with `issues[].path` joined by "."; each SpendRefused reason → status/code/copy in §6.2; `SyntaxError` → 400 `invalid_json`; plain `Error("secret-ish")` → 500 body not containing `secret-ish`; every response has `cache-control: no-store`. *Verify:* covered by S1.
  - [x] **P1.T3.S3** *Files:* `src/lib/workspace/requireWorkspace.ts`, `src/lib/workspace/requireWorkspace.test.ts`. *Do:* implement §6.2; tests inject `deps` and cover each table row plus success (`brandKey` from opts, from query, defaulting to first membership; `role`). *Verify:* `node --test src/lib/workspace/requireWorkspace.test.ts` → 9 cases pass (F01-AC-05).
- [x] **P1.T4 Route contract harness**
  - [x] **P1.T4.S1** *Files:* `src/lib/http/schemaContract.ts` (licence header), `src/lib/http/routeContract.ts`. *Do:* port `closedOutputPaths` (`output-schema-contract.test.ts:16-65`) unchanged in logic; `defineRouteContract` returns its argument after validating `id` is unique per process. *Verify:* S2.
  - [x] **P1.T4.S2** *Files:* `src/lib/http/routeContract.test.ts`. *Do:* (a) port the two walker cases from `output-schema-contract.test.ts:104-139` verbatim; (b) `globSync("src/lib/**/*.contract.ts")`, dynamic-import each, collect `contracts`, and assert the §6.2 rules; (c) a fixture contract in `src/lib/http/__fixtures__/closed.contract.fixture.ts` (not matching the glob) proving the test catches `z.object` responses. *Verify:* `node --test src/lib/http/routeContract.test.ts` → pass (F01-AC-31).

**Checkpoint:** `npm test`, `npm run typecheck`, `npm run build` all exit 0; test count ≥ previous count + new tests; ACs F01-AC-01..05, F01-AC-31 covered.

### Phase 2 — Spend guard and feature flags

**Goal:** paid calls can be estimated, held, settled and capped per workspace and per feature, with every paid feature disabled by default.

- [ ] **P2.T1 Migration 041**
  - [ ] **P2.T1.S1** *Files:* `supabase/migrations/041_f01_spend.sql`. *Do:* §6.1 verbatim. *Verify:* on a loopback `perceev_qa` database: `psql -X -v ON_ERROR_STOP=1 -f tests/supabase-bootstrap.sql`, then every migration in order, twice (idempotency) → exit 0 both times.
  - [ ] **P2.T1.S2** *Files:* `scripts/setup-supabase.mjs`. *Do:* add the `041_f01_spend.sql` required-objects entry from §6.1. *Verify:* `node --test src/lib/migrationsLedger.test.mjs src/lib/migrationsRunner.test.mjs` → pass.
  - [ ] **P2.T1.S3** *Files:* `tests/customer-uat.sql`. *Do:* add a block inserting one `spend_ledger` and one `workspace_spend_limits` row per workspace (as postgres), then as user `…0001` assert `count(*) = 1` in each table, and as `…0002` likewise. *Verify:* the CI `customer-database` step passes locally with the same commands.
  - [ ] **P2.T1.S4** Migration paperwork. *Files:* `README.md` (migration table), `docs/OPERATOR_LEDGER.md` § C, `docs/PROD_MIGRATIONS.md`. *Do:* add a row for `041_f01_spend.sql` in each (purpose, objects, apply order, not yet applied to production). *Verify:* `npm test` → migration-ledger guard tests pass.
- [ ] **P2.T2 Spend modules**
  - [ ] **P2.T2.S1** *Files:* `src/lib/spend/features.ts`, `src/lib/spend/errors.ts` (completed), `src/lib/spend/money.ts`, `src/lib/spend/store.ts`, `src/lib/spend/memoryStore.ts`, `src/lib/spend/index.ts`. *Do:* §6.2. *Verify:* `node --test src/lib/spend/` → pass.
  - [ ] **P2.T2.S2** *Files:* `src/lib/spend/spend.test.ts`. *Do:* memory-store cases for reserve validation (estimate ≤ 0, > 1000, ttl bounds), refusal mapping, idempotent reserve, duplicate after settle → 409, default caps from env (`"5"` → 5, `""` → null, `"abc"` → 500 `spend_config_invalid`), DB error → 503 `spend_unavailable`. *Verify:* pass.
  - [ ] **P2.T2.S3** *Files:* `src/lib/spend/metered.test.ts`. *Do:* table-driven over the five outcome rows in §6.2; assert the store calls and the thrown value; undershoot logs exactly one `console.error` whose first argument is `"[spend] estimate undershoot"` and whose second contains only `feature, provider, endpoint, estimateUsd, actualUsd`; `keepAlive` injected and asserted called once; caller rejection after `keepAlive` still settles. *Verify:* pass (F01-AC-09, F01-AC-10).
- [ ] **P2.T3 Feature flags**
  - [ ] **P2.T3.S1** *Files:* `src/lib/features/names.ts`, `src/lib/features/flags.ts`, `src/lib/features/flags.test.ts`. *Do:* §6.2; tests: production + unset → false; dev + unset → true; `on`/`off`/`allowlist` with and without brand; linked spend feature disabled → false; read error → false; 30 s cache honoured with injected `now`. *Verify:* `node --test src/lib/features/flags.test.ts` → pass (F01-AC-12).
- [ ] **P2.T4 DB harness (spend)**
  - [ ] **P2.T4.S1** *Files:* `scripts/qa/check-f01-db.mjs` (new, same loopback guard as `check-repair-workflows.mjs:13-18`). *Do:* groups `spend-defaults` (no enabled control rows), `spend-refusals` (each reason, no hold created), `spend-concurrency` (20 parallel `reserve_spend(1)` against daily cap 10 on separate pool clients → exactly 10 granted, `sum(estimate_usd) = 10`), `spend-idempotency`, `spend-settle` (multi-row settle; unknown row counted at estimate share; undershoot flag), `spend-expiry` (`expires_at` back-dated → `expire_spend_holds` writes one `reservation` row), `spend-rls` (customer reads own rows only). Each test uses fresh `qa-<uuid>.example` brands and deletes them at the end. *Verify:* `PGHOST=localhost PGDATABASE=perceev_qa node scripts/qa/check-f01-db.mjs --only spend` → `PASS` per group, exit 0 (F01-AC-06..08, F01-AC-11, F01-AC-12).
  - [ ] **P2.T4.S2** *Files:* `.github/workflows/ci.yml`. *Do:* add `node scripts/qa/check-f01-db.mjs` after `check-repair-workflows.mjs` in the `customer-database` job. *Verify:* CI green on the PR.
- [ ] **P2.T5 Operator spend routes**
  - [ ] **P2.T5.S1** *Files:* `src/app/api/ops/spend/controls/route.ts`, `src/app/api/ops/spend/controls/[feature]/route.ts`, `src/app/api/ops/spend/limits/route.ts`, `src/app/api/ops/spend/limits/[brandKey]/route.ts`, `src/lib/spend/spend.contract.ts`. *Do:* §6.5. *Verify:* `node --test src/lib/http/routeContract.test.ts` → pass; `node --test src/lib/operatorPerimeter.middleware.test.mjs` → pass (paths are perimeter-gated, not public).
  - [ ] **P2.T5.S2** *Files:* `src/lib/spend/opsRoutes.route.test.mjs` (hooks: `src/lib/customerRoutes.test.hooks.mjs` pattern with a fake admin). *Do:* PUT with `confirm` mismatch → 400; unknown feature → 404; valid PUT → upsert called with exact columns. *Verify:* `node --import ./src/lib/liveWriteGuardAuto.mjs --test src/lib/spend/opsRoutes.route.test.mjs` → pass.
- [ ] **P2.T6 Env names**
  - [ ] **P2.T6.S1** *Files:* `.env.example`. *Do:* add commented names with one-line explanations: `# SPEND_DEFAULT_DAILY_CAP_USD=`, `# SPEND_DEFAULT_MONTHLY_CAP_USD=`. *Verify:* `npm run check:secrets` → pass.

**Checkpoint:** `npm test`, `npm run typecheck`, `npm run build`, `node scripts/qa/check-f01-db.mjs --only spend` (loopback) pass. ACs F01-AC-06..12 covered.

### Phase 3 — Durable job runner, tick, status and cancel

**Goal:** features can define jobs with memoised, billed-once steps that survive Vercel's 300 s limit.

- [ ] **P3.T1 Migrations 040 and 043**
  - [ ] **P3.T1.S1** *Files:* `supabase/migrations/040_f01_jobs.sql`, `supabase/migrations/043_f01_jobs_cron.sql`. *Do:* §6.1 verbatim. *Verify:* apply all migrations twice on the loopback QA DB → exit 0; `psql -c "select count(*) from pg_proc where proname='jobs_tick_http'"` → 1.
  - [ ] **P3.T1.S2** *Files:* `scripts/setup-supabase.mjs`, `tests/customer-uat.sql`. *Do:* required objects for 040 and 043; RLS block: a job per workspace plus one system job; user `…0001` sees exactly 1 job, user `…0002` sees exactly 1. *Verify:* CI database step commands locally → pass.
  - [ ] **P3.T1.S3** Migration paperwork. *Files:* `README.md` (migration table), `docs/OPERATOR_LEDGER.md` § C, `docs/PROD_MIGRATIONS.md`. *Do:* rows for `040_f01_jobs.sql` and `043_f01_jobs_cron.sql`; the 043 row notes the Vault secrets the owner must create before the cron schedule fires. *Verify:* `npm test` → migration-ledger guard tests pass.
- [ ] **P3.T2 Runner modules**
  - [ ] **P3.T2.S1** *Files:* `src/lib/jobs/types.ts`, `registry.ts`, `stepConfigs.ts` (licence header), `store.ts`, `memoryStore.ts`, `enqueue.ts`, `runner.ts`, `status.ts`, `cancel.ts`, `periodic.ts`, `watchdog.ts` (licence header), `tick.ts`, `maintenance.ts`, `kinds.ts`, `index.ts` (re-exports §5 names: `defineJob`, `enqueueJob`, `enqueueSystemJob`, `getJobStatus`, `cancelJob`, `definePeriodic`, `jobStepKey`, `STEP` presets). *Do:* §6.2 and §6.3. *Verify:* `node --test src/lib/jobs/` → pass.
  - [ ] **P3.T2.S2** *Files:* `src/lib/jobs/runner.test.ts`. *Do:* with `memoryStore` and an injected clock: memoise; billed+retries rejected; billed interrupted on replay; retry with backoff then exhausted; sleep yields and resumes; budget yield + self-continue fired once; output too large / not JSON; cancellation before next step; `ctx.cancelRequested()` false then true after `cancelJob` (cache expired via injected clock); `StepFailedError` caught by handler → `partial`; unknown kind; invalid payload; lost lease stops without writes. *Verify:* pass (F01-AC-13..19, F01-AC-22).
  - [ ] **P3.T2.S3** *Files:* `src/lib/jobs/status.test.ts`, `src/lib/jobs/periodic.test.ts`, `src/lib/jobs/watchdog.test.ts`. *Do:* poll rules table in §6.3.5; periodic advance-before-run with a throwing `run` (next slot still advanced; `last_error` set); watchdog continues after one store call throws and rethrows after. *Verify:* pass (F01-AC-21, F01-AC-23, F01-AC-26).
- [ ] **P3.T3 Routes**
  - [ ] **P3.T3.S1** *Files:* `src/app/api/jobs/tick/route.ts`, `src/lib/operatorPerimeter.js` (add `/^\/api\/jobs\/tick\/?$/` to `SELF_GATED` with a comment "F01 — cronAuth gate, pg_cron every minute"). *Verify:* `node --test src/lib/operatorPerimeter.test.mjs src/lib/operatorPerimeter.middleware.test.mjs` → pass.
  - [ ] **P3.T3.S2** *Files:* `src/app/api/customer/jobs/[jobId]/route.ts`, `src/app/api/customer/jobs/[jobId]/cancel/route.ts`, `src/app/api/ops/jobs/route.ts`, `src/lib/jobs/jobs.contract.ts`. *Do:* §6.5. *Verify:* `node --test src/lib/http/routeContract.test.ts` → pass.
  - [ ] **P3.T3.S3** *Files:* `src/lib/jobs/tick.route.test.mjs` (hooks: `src/lib/cronAuth.route.hooks.mjs`), `src/lib/jobs/jobsRoutes.route.test.mjs` (hooks: `customerRoutes.test.hooks.mjs`). *Do:* tick 401 / disabled / 202 and `keepAlive` called; status 404 for other workspace and system job, 200 shape for own; cancel idempotent. *Verify:* `node --import ./src/lib/liveWriteGuardAuto.mjs --test src/lib/jobs/*.route.test.mjs` → pass (F01-AC-24, F01-AC-25).
- [ ] **P3.T4 DB harness (jobs)**
  - [ ] **P3.T4.S1** *Files:* `scripts/qa/check-f01-db.mjs`. *Do:* groups `jobs-enqueue` (dedupe, single-active conflict returns blocker), `jobs-leases` (two concurrent `claim_due_jobs` with limit 5 over 6 due jobs → disjoint sets; fenced `job_step_complete` returns false after back-dating `lease_until`), `jobs-steps` (billed `running` row → `billed_step_interrupted`; sleep/wake), `jobs-watchdog`, `jobs-cancel`, `jobs-periodic` (two concurrent `claim_due_periodic` → one true), `jobs-cron` (`jobs_tick_http()` returns NULL with a NOTICE when vault is absent; skipped if `vault` schema missing). *Verify:* `node scripts/qa/check-f01-db.mjs --only jobs` → PASS per group (F01-AC-13, F01-AC-15, F01-AC-17, F01-AC-20..22, F01-AC-26, F01-AC-27).
- [ ] **P3.T5 Env names**
  - [ ] **P3.T5.S1** *Files:* `.env.example`. *Do:* add `# FEATURE_JOBS_TICK=off`, `# JOBS_TICK_CONCURRENCY=4`, `# JOBS_TICK_CLAIM_LIMIT=8` with explanations. *Verify:* `npm run check:secrets` → pass.

**Checkpoint:** all tests, typecheck, build and `check-f01-db.mjs` pass; F01-AC-13..27 covered; `scripts/qa/check-probe-dispatch.mjs` still passes (F01-AC-32).

### Phase 4 — Provider cache, safeFetch, LLM helper

**Goal:** features can cache expensive results, fetch customer URLs safely and call an LLM with metered, reported cost.

- [ ] **P4.T1 Cache**
  - [ ] **P4.T1.S1** *Files:* `supabase/migrations/042_f01_provider_cache.sql`, `scripts/setup-supabase.mjs`. *Do:* §6.1. *Verify:* migrations apply twice → exit 0.
  - [ ] **P4.T1.S1a** Migration paperwork. *Files:* `README.md` (migration table), `docs/OPERATOR_LEDGER.md` § C, `docs/PROD_MIGRATIONS.md`. *Do:* row for `042_f01_provider_cache.sql`. *Verify:* `npm test` → migration-ledger guard tests pass.
  - [ ] **P4.T1.S2** *Files:* `src/lib/cache/providerCache.ts` (licence header), `src/lib/cache/store.ts`, `src/lib/cache/memoryStore.ts`, `src/lib/cache/providerCache.test.ts`. *Do:* §6.2; tests: key stability across key order (`{b:1,a:2}` vs `{a:2,b:1}`), different brands → different keys, global ignores brand, miss→store, hit, expired→refetch, schema-invalid→refetch, fetcher-invalid→throw and nothing stored, > 256 KB → storage path, single-flight (two concurrent misses call fetcher once), read error → miss. *Verify:* `node --test src/lib/cache/providerCache.test.ts` → pass (F01-AC-28).
  - [ ] **P4.T1.S3** *Files:* `scripts/qa/check-f01-db.mjs`. *Do:* group `cache` (check constraints: both bodies → error; workspace without brand → error; prune returns storage paths). *Verify:* `--only cache` → PASS.
- [ ] **P4.T2 safeFetch**
  - [ ] **P4.T2.S1** *Files:* `src/lib/http/hostPolicy.ts` (licence header), `src/lib/http/safeFetch.ts`. *Do:* §6.2. *Verify:* S2.
  - [ ] **P4.T2.S2** *Files:* `src/lib/http/safeFetch.test.ts`. *Do:* ported OpenSEO cases; every `BLOCKED_HOSTS` and suffix; redirect to `http://169.254.169.254/` refused at the hop; 6 redirects refused; `maxRedirects: 0` against a local 301 → returns status 301 with `location` header and makes no second request; body over `maxBytes` → 422 `response_too_large`; same body with `truncate: true` → `truncated: true` and `body.length === maxBytes`; pinning: inject `lookup` that returns `93.184.216.34` for the vetting call and `127.0.0.1` for any later call, run a local `node:http` server bound to 127.0.0.1, assert the connection target used is the vetted address (the request does not reach the local server). *Verify:* `node --test src/lib/http/safeFetch.test.ts` → pass (F01-AC-30); `node --test src/lib/ssrfGuard.test.mjs src/lib/crawlabilitySsrf.route.test.mjs` → still pass.
- [ ] **P4.T3 LLM helper**
  - [ ] **P4.T3.S1** *Files:* `src/lib/llm/openrouter.ts` (licence header), `src/lib/llm/index.ts`. *Do:* §6.2. *Verify:* S2.
  - [ ] **P4.T3.S2** *Files:* `src/lib/llm/llm.test.ts`, `tests/fixtures/f01/openrouter-generate-usage.json`, `tests/fixtures/f01/openrouter-no-usage.json`. *Do:* inject `generateText` stub returning fixture metadata; assert `maxRetries: 0`, `maxOutputTokens: 4000`, the `usage.include` model setting, settle with 0.000042 `provider_reported`; no-usage on OpenRouter → `null` settle (reservation); non-OpenRouter gateway with token counts → `price_table`; schema failure → settled then `llm_bad_output`; abort → ambiguous; 401 → released; missing key → 503; spy on `console.*` and assert no call contains the prompt or answer strings. *Verify:* `node --test src/lib/llm/llm.test.ts` → pass (F01-AC-29).
  - [ ] **P4.T3.S3** *Files:* `scripts/qa/check-f01-live.mjs`, `.env.example` (`# LLM_HELPER_MODEL=`, `# LLM_HELPER_UNPRICED_ESTIMATE_USD=0.05`). *Do:* §6.4; refuses without `--max-spend-usd 0.01 --brand <key>`; never run in CI. *Verify:* `node scripts/qa/check-f01-live.mjs` (no flags) → exits 2 with "refusing: --max-spend-usd 0.01 and --brand are required".
- [ ] **P4.T4 Notices**
  - [ ] **P4.T4.S1** *Files:* `THIRD_PARTY_NOTICES.md`. *Do:* list every file with a licence header added in phases 1–4. *Verify:* `node --test src/lib/platform/thirdPartyNotices.test.mjs` → pass (F01-AC-03).

**Checkpoint:** full suite, typecheck, build, `check-f01-db.mjs` (all groups) pass; F01-AC-28..30, F01-AC-03 covered; `features/README.md` F01 status set to **Merged** in the last PR.

## 9. Test plan

| Test file | Cases | ACs |
|---|---|---|
| `src/lib/platform/tsSetup.test.mjs` | tsconfig flags; jsconfig kept; Node imports a `.ts` module | 01 |
| `src/lib/testCoverageGuard.test.mjs` | `.test.ts` collected; npm test == test:scoring; CI runs suite | 02 |
| `src/lib/platform/thirdPartyNotices.test.mjs` | MIT text present; every ported file listed | 03 |
| `src/lib/http/errors.test.ts` | mapping table, no-store, no leak | 04 |
| `src/lib/workspace/requireWorkspace.test.ts` | 7 error rows + 2 success | 05 |
| `src/lib/spend/spend.test.ts` | validation, refusals, idempotency, env defaults, fail-closed | 06, 08 |
| `src/lib/spend/metered.test.ts` | five outcomes, undershoot log, keepAlive settle | 09, 10 |
| `src/lib/features/flags.test.ts` | env modes, prod default, linked spend features, cache | 12 |
| `src/lib/jobs/runner.test.ts` | step semantics (§6.2 runner list) | 13–19, 22 |
| `src/lib/jobs/status.test.ts` | `pollAfterSeconds` rules | 23 |
| `src/lib/jobs/periodic.test.ts`, `watchdog.test.ts` | advance-first, error isolation | 21, 26 |
| `src/lib/jobs/tick.route.test.mjs` | 401, disabled, 202 + keepAlive | 24 |
| `src/lib/jobs/jobsRoutes.route.test.mjs` | tenant 404, shape, cancel | 25 |
| `src/lib/cache/providerCache.test.ts` | keys, TTL, schema, storage, single-flight | 28 |
| `src/lib/llm/llm.test.ts` | cost sources, retries 0, no body logging | 29 |
| `src/lib/http/safeFetch.test.ts` | host policy, redirects, size, pinning | 30 |
| `src/lib/http/routeContract.test.ts` | walker, discovered contracts | 31 |
| `scripts/qa/check-f01-db.mjs` | groups `spend-*`, `jobs-*`, `cache` | 06–08, 11–13, 15, 17, 20–22, 26–28 |
| CI `customer-database` (existing + new steps) | migrations without pg_cron; P0 checks unchanged | 27, 32 |

Fixtures: `tests/fixtures/f01/openrouter-generate-usage.json` and `openrouter-no-usage.json`, hand-written from the AI SDK result shape with all text replaced by `"ok"`. No live recording is needed. Tests never call OpenRouter.

## 10. Rollout and rollback

- **Env vars (names only):** `FEATURE_JOBS_TICK`, `JOBS_TICK_CONCURRENCY`, `JOBS_TICK_CLAIM_LIMIT`, `SPEND_DEFAULT_DAILY_CAP_USD`, `SPEND_DEFAULT_MONTHLY_CAP_USD`, `LLM_HELPER_MODEL`, `LLM_HELPER_UNPRICED_ESTIMATE_USD`. Existing, reused: `CRON_SECRET`, `LLM_API_KEY`, `LLM_BASE_URL`, `NEXT_PUBLIC_APP_URL`, `VERCEL_AUTOMATION_BYPASS_SECRET`.
- **Defaults:** `FEATURE_JOBS_TICK` unset → off in production. No paid feature is enabled. Workspace caps are unset, so there is no workspace cap until the owner sets one; P0 scan caps are unchanged.
- **Migration order:** 041 (phase 2), 040 + 043 (phase 3), 042 (phase 4). All additive and idempotent.
- **Owner enabling steps (phase 3, production):**
  1. Apply migrations through the usual `npm run setup:db` path.
  2. In the Supabase SQL editor, create the two Vault secrets **without echoing them anywhere**: `select vault.create_secret('<paste CRON_SECRET from Vercel>', 'perceev_cron_secret');` and `select vault.create_secret('https://perceev.xyz/api/jobs/tick', 'perceev_jobs_tick_url');`. Do not paste the secret into chat, tickets or a terminal.
  3. Set `FEATURE_JOBS_TICK=on` in Vercel production and redeploy.
  4. Check: `select status_code from net._http_response order by created desc limit 5;` shows 202 (or 200 `skipped` before step 3).
- **Turn off:** set `FEATURE_JOBS_TICK=off` (the tick returns 200 `skipped`), or `select cron.unschedule('perceev-jobs-tick');`. Jobs stay queued and resume when the tick is re-enabled. Paid features are switched off per feature with `PUT /api/ops/spend/controls/<feature>` `{enabled:false,…}`.
- **Rollback:** the code can be reverted without dropping tables. The tables are inert without callers. Dropping them is unnecessary and not part of rollback.
- **Data cleanup:** retention jobs as in §6.3.6.

## 11. Risks and open questions

| # | Risk / question | Default chosen |
|---|---|---|
| 1 | The owner states production reserves USD 0.20 per probe attempt, but code and `.env.example` default `SCAN_PROBE_RESERVATION_USD` to 1. This could not be verified (production env not read). | F01 does not touch it. F09 reads the live value through `dispatchBudget()` so its quote always equals the real reservation, whatever it is. |
| 2 | `ai@6` / `@openrouter/ai-sdk-provider` exact versions and the `Output.object` API name could not be verified offline. | Use `Output.object` (as OpenSEO at `aiPromptResearch.ts:263`). If v6 renames it, use the v6 equivalent and keep the `llmObject` signature. |
| 3 | `undici` Agent passed to `undici.fetch` must match its own version; Node's global `fetch` is not used for pinned requests. | Use `undici.fetch` only inside `safeFetch`; elsewhere keep global `fetch`. |
| 4 | Next.js 15 may rewrite `tsconfig.json` on first build. | Commit Next's edits in P1.T1.S2; the guard test asserts only the keys listed. |
| 5 | pg_net request logs (`net._http_response`) store response bodies for 6 h; our tick body contains no secrets. | Accept. The Authorization header is not stored in responses. |
| 6 | Supabase Vault availability on the project tier. | If `vault` is unavailable, the owner instead creates a one-row `private.jobs_tick_config` table (service-only) and a follow-up PR switches `jobs_tick_http()` to read it. Until then the tick does nothing (NOTICE only). |
| 7 | Concurrent cache misses across instances can double a paid fetch. | Accept for v1. Single-flight is per process. Features with expensive calls also pass `idempotencyKey`s, so a duplicate is visible in the ledger. |
| 8 | Default workspace caps are unset. | Chosen to keep today's scan behaviour. The owner should set `SPEND_DEFAULT_*` before enabling any paid feature for a customer workspace. |
| 9 | Unclassified provider errors are counted at the estimate (conservative), whereas OpenSEO treats them as unbilled. | Keep the conservative rule. F02 adapters must classify known unbilled failures with `UnbilledCallError`. |

**Changes to `00-CONVENTIONS.md` §5 this spec needs (additive, backward compatible):**

1. `enqueueJob` opts gain `singleActiveKey?: string` and `createdBy?: string`. A conflict throws `AppError 409 job_already_running` with `details.activeJobId`.
2. New `enqueueSystemJob(kind, payload, { dedupeKey?, singleActiveKey?, runAt? })` for platform jobs with no workspace.
3. `defineJob` gains a third optional argument `{ payloadSchema?, pollAfterSeconds?, deadlineSeconds?, maxInvocations?, leaseSeconds? }`.
4. New `definePeriodic({ name, everySeconds, run })`.
5. `reserveSpend`/`metered` inputs gain `ttlSeconds?: number` (default 1,800, max 86,340). `reserveSpend` also gains `subject?: { kind: string; id: string }`.
6. New `settleSpendBatch(holdId, costs[])`.
7. `AppError` constructor is `(status, code, message, { recovery?, details?, cause? })`. Error bodies may include `details`.
8. New error classes in `src/lib/spend/errors.ts`: `ChargedCallError`, `UnbilledCallError`, `AmbiguousCallError`.
9. `isFeatureEnabled` feature names are registered in `src/lib/features/names.ts` with their linked spend features.
10. Import rule: modules under `src/lib/**` use relative imports with explicit extensions (no `@/`).
11. Route contracts live in `src/lib/<feature>/*.contract.ts` and export `contracts`. Response schemas use `z.looseObject`; request schemas use `z.strictObject`.

## 12. Definition of done

- [ ] Phases 1–4 merged, each with its checkpoint commands green.
- [ ] F01-AC-01 … F01-AC-32 each covered by a passing test listed in §9.
- [ ] `npm test`, `npm run typecheck`, `npm run build` green on `main`; CI `customer-database` job runs `check-f01-db.mjs`.
- [ ] `THIRD_PARTY_NOTICES.md` lists every ported file.
- [ ] `00-CONVENTIONS.md` §5 updated with the eleven additive changes above, in the phase-3 PR.
- [ ] `features/README.md` F01 status updated (In progress at first PR, Merged at last).
- [ ] Owner-run checks recorded in the last PR description: Vault secrets created (yes/no, never the value), `FEATURE_JOBS_TICK` state, last five `net._http_response` status codes, and, if run, `check-f01-live.mjs` ledger row (`cost_source`, `accounted_usd`).
