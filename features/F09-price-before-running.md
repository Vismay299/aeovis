# F09 — Price before running

> <!-- doc-status -->
> **Status: LIVE.** Implementation spec. Not built yet.

| Field | Value |
|---|---|
| ID | F09 |
| Wave | 1 |
| Comparison rows covered | "Price before running" (OpenSEO: every run opens a cost dialog; the run carries an approved maximum and refuses if the price rose; settings show monthly projections. Perceev: server-side reservations and caps per scan and per day; the customer never sees a price) |
| Depends on | F01 and F03 (merged). Phase 3 (UI) also needs F04 and F05 merged, and the run-scan fix (`fix/run-scan-unapproved-panel`) merged into `main`, because it introduced the `panel_not_approved` / `scan_already_running` codes this spec extends. |
| Blocks | F10 (schedule approval and monthly projection), F13, F15, F18 and F22 (each registers a priced action) |
| Reserved migrations | 080–084 (080 used; 081–084 unused) |
| Feature flag | `FEATURE_PRICE_REVIEW` (shows the cost dialog before Run scan). The server-side price check and the approved-maximum cap are **always on**; they need no flag. |
| Spend features | none new (uses F03's `ai_visibility.scan`; later specs bring their own) |
| OpenSEO reference | `openseo:src/server/features/ai-visibility/services/aiVisibilityCost.ts:60-109`, `openseo:src/server/features/ai-visibility/services/aiVisibilityRuns.ts:190-208`, `openseo:src/types/schemas/ai-visibility.ts:97-106`, `openseo:src/client/features/ai-visibility/TrackingCostReview.tsx`, `openseo:src/client/features/ai-visibility/TrackerSetupReview.tsx` at `c5f8db1` |

## 1. Summary

Before any paid run, the customer sees what it can cost and approves that amount. The run then carries the approved maximum. If the price has risen in the meantime, the server refuses with `409 price_changed` and returns the new quote for re-approval. For scans, the approved maximum becomes the scan's hard spend cap inside `claim_probe_dispatch`: the quote is exactly what dispatch will reserve, and the scan can never spend more than the customer approved. The same estimate → confirm → run-with-`maxUsd` mechanism is shared by rank checks, JS-rendered audits and keyword research as those features land.

## 2. What OpenSEO does (observed)

1. **Three figures per estimate.** `estimateCost` prices a check once queued (`costUsd`, scheduled runs), once live (`runNowCostUsd`, Run now), and per month (`monthlyCostUsd = costUsd × checksPerMonth`). It also returns prompt, engine and observation counts and the schedule interval (`openseo:src/server/features/ai-visibility/services/aiVisibilityCost.ts:60-91`; type `openseo:src/shared/ai-visibility.ts:124-139`). Checks per month are 30 daily, 4 weekly and 1 monthly (`openseo:src/shared/rank-tracking.ts:186-195`).
2. **Warnings travel with the price.** "One fresh answer per prompt and engine. The weekly estimate assumes 4 checks per month."; which engines use costlier live API pricing; and "provider not configured" (`aiVisibilityCost.ts:92-107`).
3. **Estimates can price unsaved changes.** An optional `patch` lets the setup review price proposed prompts and engines before saving (`aiVisibilityCost.ts:63-71`).
4. **Approval is part of the run request.** `maxCostUsd` is required, positive and at most 100, described as "the most the user approved for this one check … refused if its current cost is higher" (`openseo:src/types/schemas/ai-visibility.ts:97-106`).
5. **The server re-prices at run time.** `runCheck` recomputes the live cost from the current configuration and refuses with `COST_LIMIT_EXCEEDED` ("This check now costs $X, more than the approved maximum. Review the new estimate before running it.") when `round(cost·1e6) > round(maxCostUsd·1e6)`. Nothing is created and nothing is charged (`openseo:src/server/features/ai-visibility/services/aiVisibilityRuns.ts:190-208`; test "refuses a check that now costs more than the approved maximum", `aiVisibilityRuns.test.ts:111-115`).
6. **Credits are checked before start.** A run whose required credits exceed the balance is refused with `INSUFFICIENT_CREDITS` and the tracker records why (`aiVisibilityRuns.ts:98-124`). **(Not adopted: no credits. Our equivalent is F01's workspace caps.)**
7. **Dialog behaviour.** The page prefetches the Run-now estimate so the dialog opens on a price (`openseo:src/client/features/ai-visibility/TrackingCostReview.tsx:69-84`). The estimate query uses `staleTime: 0`, `retry: false` and no refetch on focus, so it re-prices each time the dialog opens while showing the preloaded price (`:35-67`). The approve button is disabled while the estimate is refreshing ("Approve only the current price, not the preloaded one still being refreshed"), while starting, or when there are 0 observations (`:174-183`). The dialog cannot be closed while starting (`:166-168`). Copy: title "Run now", label "Cost", large tabular amount, sub-line "{n} answers · live answers, ready in a few minutes"; schedule mode adds "Cost per run" and "about $X a month (N runs)". There is deliberately no per-answer price because engines cost different amounts (`:157-237`). The approved amount sent is exactly the displayed `runNowCostUsd` (`:146-152`).
8. **Setup review** shows "Each run collects **N** answers for **$X**" and "**$Y** estimated per month if it runs weekly." with Back / Save buttons (`openseo:src/client/features/ai-visibility/TrackerSetupReview.tsx:100-150`).
9. **Money format.** USD, 2 decimals, up to 4 below $1 (`openseo:src/client/features/ai-visibility/shared.tsx:208-215`).
10. **Agents get the same contract.** The MCP tool tells agents to "show the customer the relevant cost before … running a paid check, and pass the approved runNowCostUsd … as maxCostUsd" (`openseo:src/server/mcp/tools/ai-visibility-tools.ts:233`, `:260`).

## 3. What Perceev has today

- **Run scan.** `POST /api/customer/scan` reads the approved panel and creates the job via `createScanJob`, then fires `runScanChunk` in `keepAlive` (`src/app/api/customer/scan/route.js:16-65`). Since the run-scan fix, the 409s carry codes `panel_not_approved` and `scan_already_running` (`src/app/api/customer/scan/route.js`, `fail(status, error, code)`). There is no price, approval or `maxUsd`.
- **Client.** `useScanTracker().start()` POSTs `{ brand_key }` and handles 401/409/errors (`src/components/portal/useScanTracker.js` on `main` after the run-scan fix). `start` is wired to seven buttons: Overview (`src/app/portal/page.jsx:53`), Scans page (`src/app/portal/scans/page.jsx:129,159,207`), Measurement (the "Run scan" button F04 phase 5 adds to `src/app/portal/measurement/page.jsx`), Getting started (`src/components/portal/overview/GettingStarted.jsx:31`), and the progress card's idle CTA and "Try again" (`src/components/portal/ScanProgressCard.jsx:67,85`). Tests on the fix branch call `start()` and expect a POST (`src/components/portal/portalRegressions.test.mjs:112-175`) and look for `onClick === scan.start` (`:549-619`).
- **What dispatch actually reserves.** `claim_probe_dispatch(p_id, p_reserve, p_scan_cap, p_day_cap, …)` reserves `p_reserve` per **attempt** (up to 3 attempts per observation). It refuses when `scan_spend + p_reserve > p_scan_cap` or `day_spend + p_reserve > p_day_cap`, where spend sums `coalesce(charged_usd, reserved_usd)` plus the scan's `context.sourcing_cost` (`supabase/migrations/035_scoped_provider_rollout.sql:36-89`). `p_reserve`, `p_scan_cap` and `p_day_cap` come from `dispatchBudget(env)`: `SCAN_PROBE_RESERVATION_USD` (code default 1; the owner states production uses 0.20), `SCAN_MAX_COST_PER_SCAN`, `SCAN_MAX_COST_PER_DAY` (`src/lib/workers/durableProbing.js:26-41`, used at `:144-147`, `:169`).
- **Which observations a scan reserves for.** Rows = frozen engines × panel queries (`durableProbing.js:116-142`). Panel queries are all `payload.prompts`, non-diagnostic first then diagnostic (`src/lib/workers/scanWorker.js:1475-1479` and the diagnostic merge after it). Engines resolve from the brand's `scan_schedules.engines`, else `ENGINES` (`scanWorker.js:1463-1465`, `:1635-1644`; `src/lib/scoring/enginePipeline.js:2238-2271`). Unconfigured engines are frozen but blocked without a claim (`durableProbing.js:157-167`), so they reserve nothing. A panel scan makes no other paid call: sourcing comes from the panel (`stats.cost = 0`, `scanWorker.js:1450, 1475-1480`), and finalize uses the deterministic judge.
- **Single-flight.** `scan_jobs_one_running_per_brand` (migration 007) and `DuplicateScanError` (`src/lib/db.js:840-900`).
- **From F01 and F03:** `reserveSpend` with `subject` and `ttlSeconds`, `toErrorResponse`, `requireWorkspace`, `AppError(details)`; F03 settles scan holds (`settle_scan_hold`), exposes `engine_cost_stats(30)` for typical cost, and seeds `ai_visibility.scan` enabled.
- **Must not break:** P0 functions (unchanged), the private owner demo script that POSTs `/api/customer/scan` without any price field (`docs/audits/2026-10-16/HANDOFF-2026-10-20-demo-and-consolidation.md:50-52`), existing 201/409 shapes, and the portal tests listed above (updated only where §8 says so).

## 4. Target behaviour and acceptance criteria

| ID | Statement | Verified by |
|---|---|---|
| F09-AC-01 | The scan quote's `totalUsd` equals `observations × SCAN_PROBE_RESERVATION_USD` exactly, computed in integer micro-dollars, where observations = all approved-panel prompts × configured engines from the same resolution the worker uses. | unit `src/lib/pricing/actions/scanRun.test.ts` |
| F09-AC-02 | With `p_scan_cap = quote.totalUsd`, `claim_probe_dispatch` grants every first attempt of every observation, and the sum of `reserved_usd` equals `quote.totalUsd` in SQL `numeric` (reserve values 0.2, 1, 0.15, 0.333333; N = 1, 7, 120, 800). | DB `scripts/qa/check-f09-db.mjs` group `quote-equals-reservation` |
| F09-AC-03 | A scan started with approved maximum `M` never has committed probe spend above `M`: with `p_scan_cap = min(SCAN_MAX_COST_PER_SCAN, M)`, the claim that would exceed `M` is refused `spend_reservation_refused`. | DB group `approved-cap` |
| F09-AC-04 | `POST /api/customer/scan` with `maxUsd` below the fresh quote returns `409 price_changed` with `details.quote` and `details.approvedMaxUsd`. No `scan_jobs` row, no spend hold and no approval row is created. | route `src/lib/pricing/scanRoute.route.test.mjs` |
| F09-AC-05 | `POST /api/customer/scan` with `maxUsd ≥` quote creates the job with `approved_max_usd = maxUsd` and `price_quote = quote`, reserves an F01 hold (`feature ai_visibility.scan`, `subject scan_job/<jobId>`, TTL 86,340 s, estimate = quote, max = `maxUsd`) and records a `price_approvals` row. | route test; DB group `approval-records` |
| F09-AC-06 | `POST /api/customer/scan` without `maxUsd` (legacy callers) behaves as before, except that the scan is capped at the fresh quote (`approved_max_usd = quote.totalUsd`, approval `source = 'implicit'`). | route test |
| F09-AC-07 | Workspace cap refusals from `reserveSpend` (`daily_cap`, `workspace_cap`, `feature_disabled`) return the F01 status/code and create no scan job. `DuplicateScanError` after the hold releases the hold (`scan_already_running`). | route test |
| F09-AC-08 | `runDurableProbing` uses `p_scan_cap = min(env SCAN_MAX_COST_PER_SCAN, checkpoint.approved_max_usd)`, or whichever is set, or `null` when neither is. A checkpoint without the field behaves exactly as today. | unit `src/lib/workers/approvedCap.test.mjs` |
| F09-AC-09 | Quotes are blocked, not priced, when there is no approved panel (`panel_not_approved`), no configured engine (`no_engines`), or the quote exceeds `SCAN_MAX_COST_PER_SCAN` (`over_scan_limit`). Each has the exact copy in §6.2. | unit `scanRun.test.ts` |
| F09-AC-10 | Quotes carry warnings `collection_paused` (dispatch paused and the brand not allowlisted), `daily_capacity_low` (remaining platform day budget below the quote) and `workspace_limit_low` (workspace daily or monthly headroom below the quote) with the exact copy in §6.2, without blocking. | unit `scanRun.test.ts` |
| F09-AC-11 | `expectedUsd` is `Σ engines (prompts × median_usd)` from `engine_cost_stats(30)` only when every configured engine has a row, else `null`. It is never shown as the approved amount. | unit `scanRun.test.ts` |
| F09-AC-12 | `POST /api/customer/price/estimate` returns the quote for a registered action, 404 `unknown_price_action` otherwise, and validates input with the action's strict schema. | route `src/lib/pricing/estimateRoute.route.test.mjs` |
| F09-AC-13 | `requireApprovedPrice` compares in micro-dollars (`toMicros(fresh) > toMicros(max)` refuses; equal passes), mirroring OpenSEO's `Math.round(x*1e6)`. | unit `src/lib/pricing/pricedActions.test.ts` |
| F09-AC-14 | Clicking any "Run scan" entry point opens the cost dialog (`scan.start()` sends no request). Confirming sends `maxUsd` equal to the displayed `totalUsd`. Approve is disabled while the quote is loading or refetching, while starting, when blocked, or when there are 0 answers. | unit `src/components/portal/portalRegressions.test.mjs` (updated); browser `scripts/qa/check-f09-browser.mjs` |
| F09-AC-15 | On `409 price_changed` the dialog stays open, shows "The price changed" with old and new amounts, replaces the quote with `details.quote`, and the next approval sends the new amount. | browser `check-f09-browser.mjs` |
| F09-AC-16 | With `FEATURE_PRICE_REVIEW` off for the workspace, `scan.start()` behaves as today (immediate POST without `maxUsd`). | unit `portalRegressions.test.mjs` |
| F09-AC-17 | The quote includes `monthly` (`runsPerMonth` 30/4/1 for daily/weekly/monthly and `totalUsd = per-run × runs`) when `scheduleInterval` is passed. | unit `scanRun.test.ts` |
| F09-AC-18 | The priced-action registry rejects a duplicate key and an action whose input schema is not strict. Later features register through `definePricedAction`, and the contract test covers their routes' `maxUsd` and `409 price_changed` documentation. | unit `pricedActions.test.ts`; `src/lib/http/routeContract.test.ts` |

## 5. Scope

**In scope**
- Generic priced-action mechanism: quote type, registry, estimate route, `requireApprovedPrice`, approval records, `409 price_changed` contract, generic `CostReviewDialog` and quote hooks.
- Scan run as the first priced action, end to end: quote equal to dispatch reservations; approved maximum as the scan cap; F01 accounting hold; dialog on every Run scan entry point.
- Monthly projection data in the quote (for F10's settings).
- The documented pattern that F13, F15 and F18 follow.

**Out of scope**
- Schedule settings UI and scheduled-run approval storage (F10). F09 defines the contract in §6.2.5.
- Rank, audit and keyword actions themselves (F15, F18, F13 register their own).
- Changing `SCAN_PROBE_RESERVATION_USD` or any P0 function or control.
- Credits, billing, payment (excluded).
- Mixed rows: untouched.

## 6. Design

### 6.1 Data model

#### `supabase/migrations/080_f09_price_approvals.sql`

```sql
-- F09: approved maxima for paid runs. Additive; P0 functions untouched.
ALTER TABLE public.scan_jobs ADD COLUMN IF NOT EXISTS approved_max_usd numeric(12,6)
  CHECK (approved_max_usd IS NULL OR approved_max_usd > 0);
ALTER TABLE public.scan_jobs ADD COLUMN IF NOT EXISTS price_quote jsonb
  CHECK (price_quote IS NULL OR pg_column_size(price_quote) < 16384);
COMMENT ON COLUMN public.scan_jobs.approved_max_usd IS 'Customer-approved maximum; becomes p_scan_cap (min with SCAN_MAX_COST_PER_SCAN).';

CREATE TABLE IF NOT EXISTS public.price_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  approved_max_usd numeric(12,6) NOT NULL CHECK (approved_max_usd > 0),
  quoted_usd numeric(12,6) NOT NULL CHECK (quoted_usd >= 0),
  source text NOT NULL CHECK (source IN ('dialog','implicit','schedule')),
  quote jsonb NOT NULL CHECK (pg_column_size(quote) < 16384),
  price_version text NOT NULL,
  subject_kind text CHECK (subject_kind IS NULL OR subject_kind ~ '^[a-z_]+$'),
  subject_id text,
  approved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS price_approvals_brand_idx ON public.price_approvals (brand_key, created_at DESC);
CREATE INDEX IF NOT EXISTS price_approvals_subject_idx ON public.price_approvals (subject_kind, subject_id)
  WHERE subject_kind IS NOT NULL;
ALTER TABLE public.price_approvals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.price_approvals FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.price_approvals TO service_role;
GRANT SELECT ON public.price_approvals TO authenticated;
DROP POLICY IF EXISTS price_approvals_read ON public.price_approvals;
CREATE POLICY price_approvals_read ON public.price_approvals FOR SELECT TO authenticated
  USING (public.customer_can_access_brand(brand_key));

CREATE OR REPLACE FUNCTION public.prune_price_approvals(p_before timestamptz, p_limit integer DEFAULT 5000)
RETURNS integer LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v integer;
BEGIN
  WITH old AS (SELECT id FROM price_approvals WHERE created_at < p_before ORDER BY created_at LIMIT p_limit)
  DELETE FROM price_approvals p USING old WHERE p.id = old.id;
  GET DIAGNOSTICS v = ROW_COUNT; RETURN v;
END $$;
REVOKE ALL ON FUNCTION public.prune_price_approvals(timestamptz,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_price_approvals(timestamptz,integer) TO service_role;
NOTIFY pgrst, 'reload schema';
```

`scripts/setup-supabase.mjs` additions: `"080_f09_price_approvals.sql": [{kind:"table",name:"price_approvals"},{kind:"column",name:"scan_jobs.approved_max_usd"},{kind:"column",name:"scan_jobs.price_quote"},{kind:"function",name:"prune_price_approvals"}]`. The tenant RLS block in `tests/customer-uat.sql` gets one approval per workspace; each user sees exactly 1.

Retention: 13 months, via the job kind `pricing.retention` (daily periodic, `prune_price_approvals(now − 395 days)`).

### 6.2 Server modules

#### 6.2.1 Quote type (`src/shared/pricing.ts`)

```ts
import { z } from "zod";
export const priceQuoteSchema = z.looseObject({
  action: z.string(),
  currency: z.literal("USD"),
  totalUsd: z.number().min(0),            // what the run may reserve; the amount the customer approves
  expectedUsd: z.number().min(0).nullable(), // typical cost; null when unknown. Never approved.
  units: z.array(z.looseObject({ key: z.string(), label: z.string(), count: z.int().min(0) })),
  lines: z.array(z.looseObject({ label: z.string(), quantity: z.int().min(0), unitUsd: z.number().min(0), totalUsd: z.number().min(0) })),
  monthly: z.looseObject({ interval: z.enum(["daily","weekly","monthly"]), runsPerMonth: z.int().min(1), totalUsd: z.number().min(0) }).nullable(),
  warnings: z.array(z.looseObject({ code: z.string(), message: z.string() })),
  blocked: z.looseObject({ code: z.string(), message: z.string(), recovery: z.string().optional() }).nullable(),
  priceVersion: z.string(),
  quotedAt: z.iso.datetime(),
  inputsHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type PriceQuote = z.infer<typeof priceQuoteSchema>;
export function quoteExceeds(freshUsd: number, approvedMaxUsd: number): boolean; // Math.round(f*1e6) > Math.round(m*1e6)
export { formatUsd } from "./money.ts";                                          // F03
```

`inputsHash` = sha256 of `stableStringify({ action, brandKey, input })` (F01 `stableStringify`). It lets logs and approvals tie a quote to its inputs without storing them twice.

#### 6.2.2 Priced-action registry (`src/lib/pricing/pricedActions.ts`)

```ts
export type PricingContext = { brandKey: string; admin: SupabaseClient; env: Record<string, string | undefined>; now: Date };
export type PricedAction<I> = {
  key: string;                  // e.g. "ai_visibility.scan.run"; same regex as spend features
  feature: SpendFeature;        // the spend feature the run will reserve under
  input: ZodType<I>;            // must be z.strictObject (checked at registration via z.toJSONSchema(..., {io:"input"}))
  requireApproval: boolean;     // true: a run without maxUsd → 400 approval_required
  estimate(ctx: PricingContext, input: I): Promise<Omit<PriceQuote, "action"|"currency"|"priceVersion"|"quotedAt"|"inputsHash">>;
};
export function definePricedAction<I>(a: PricedAction<I>): PricedAction<I>; // duplicate key → AppError(500,"duplicate_price_action")
export function getPricedAction(key: string): PricedAction<unknown> | null;
export async function quote<I>(key: string, ctx: PricingContext, rawInput: unknown): Promise<PriceQuote>;
export async function requireApprovedPrice<I>(key: string, ctx: PricingContext, rawInput: unknown, maxUsd: number | undefined):
  Promise<{ quote: PriceQuote; approvedMaxUsd: number; source: "dialog" | "implicit" }>;
export async function recordApproval(admin: SupabaseClient, a: { brandKey: string; action: string; approvedMaxUsd: number;
  quote: PriceQuote; source: "dialog"|"implicit"|"schedule"; subject?: { kind: string; id: string }; approvedBy?: string }): Promise<string>;
```

`recordApproval` accepts any `subject.kind` matching `^[a-z_]+$`; the kinds in use are `scan_job` (F09), `schedule` (F10), `job` (F13–F18 job-backed actions) and `assistant_approval` (F22, `subject.id` = the `assistant_approvals` row id).

`requireApprovedPrice` rules, in order:
1. Unknown key → `AppError(404, "unknown_price_action", "This action cannot be priced.")`.
2. Input fails the schema → `ZodError` (400 via `toErrorResponse`).
3. Fresh quote `blocked` → `AppError(409, blocked.code, blocked.message, { recovery: blocked.recovery, details: { quote } })`.
4. `maxUsd === undefined`: if `requireApproval` → `AppError(400, "approval_required", "Review and approve the price before running this.", { details: { quote } })`; else return `{ approvedMaxUsd: quote.totalUsd, source: "implicit" }`.
5. `maxUsd` must be finite, > 0 and ≤ 1,000, else a 400 `invalid_request` via zod.
6. `quoteExceeds(quote.totalUsd, maxUsd)` → `AppError(409, "price_changed", \`This now costs up to ${formatUsd(quote.totalUsd)}, more than the ${formatUsd(maxUsd)} you approved. Review the new price.\`, { recovery: "Review the new price and approve it to continue.", details: { approvedMaxUsd: maxUsd, quote } })`.
7. Otherwise return `{ quote, approvedMaxUsd: maxUsd, source: "dialog" }`. The run's cap is the **approved** amount, not the quote. A customer who approved more keeps that headroom, as OpenSEO passes `maxCostUsd` through.

**The `409 price_changed` contract (binding for every paid action route):**

```json
{
  "error": "This now costs up to $26.40, more than the $24.00 you approved. Review the new price.",
  "code": "price_changed",
  "recovery": "Review the new price and approve it to continue.",
  "details": {
    "approvedMaxUsd": 24,
    "quote": { "action": "ai_visibility.scan.run", "currency": "USD", "totalUsd": 26.4, "expectedUsd": 7.92,
               "units": [{ "key": "answers", "label": "answers", "count": 132 }],
               "lines": [{ "label": "Answers reserved at $0.20 each", "quantity": 132, "unitUsd": 0.2, "totalUsd": 26.4 }],
               "monthly": null, "warnings": [], "blocked": null, "priceVersion": "2026-10-21.1",
               "quotedAt": "2026-10-21T09:30:00.000Z", "inputsHash": "<64 hex>" }
  }
}
```

Status 409, `Cache-Control: no-store`. The run did not start and nothing was reserved, charged or recorded. Clients must show `details.quote` and send its `totalUsd` (or more) as the next `maxUsd`. They never retry automatically.

**Second line of defence.** Inside the run, paid calls pass `maxUsd` to `metered()` / `reserveSpend()` (F01 refuses with `over_approved_max`). For scans, the approved maximum becomes the dispatch scan cap (§6.2.4).

#### 6.2.3 Scan action (`src/lib/pricing/actions/scanRun.ts`)

```ts
export const scanRunInput = z.strictObject({
  panelKey: z.literal("default").default("default"), // the worker only runs the default panel
  scheduleInterval: z.enum(["daily","weekly","monthly"]).optional(),
});
export const scanRunAction = definePricedAction({
  key: "ai_visibility.scan.run", feature: "ai_visibility.scan", input: scanRunInput, requireApproval: false,
  estimate: estimateScanRun });
export async function estimateScanRun(ctx: PricingContext, input: z.infer<typeof scanRunInput>, deps?: ScanQuoteDeps): Promise<…>;
export function resolveScanEngineNames(schedule: { engines?: string | null } | null, env): { configured: string[]; requested: string[] };
```

`estimateScanRun` steps:

1. **Panel.** `repairWorkflowStore(ctx.admin).list(brandKey, "panel")` → the artifact with `artifact_key === panelKey && state === "approved"`. If none, `blocked = { code: "panel_not_approved", message: "Scans ask the questions in your approved question panel. Review and approve it first.", recovery: "Open Questions & evidence to approve the panel." }`. `prompts = panel.payload.prompts.length` (diagnostics included: the worker probes them, `scanWorker.js` sourcing). With 0 prompts, `blocked = { code: "panel_empty", message: "Your approved question panel has no questions. Add questions and approve it first.", recovery: "Open Questions & evidence to add questions." }`.
2. **Engines.** `getScanSchedule(brandKey, { client: ctx.admin })` (`src/lib/db/analytics.js:742`). `resolveScanEngineNames` calls `resolveEnabledEngines({ engines: schedule?.engines, allowFallback: false })` (`src/lib/scoring/enginePipeline.js:2238`), the same call the worker makes (`scanWorker.js:1635-1639`). Only **configured** engines are counted, because unconfigured ones are blocked without a claim (`durableProbing.js:157-167`). With 0 engines, `blocked = { code: "no_engines", message: "No answer engines are set up for scans yet. Contact Perceev support." }`.
3. **Reservation.** `const b = dispatchBudget(ctx.env)` (`src/lib/workers/durableProbing.js:26`). `observations = prompts × engines`; `totalMicros = observations × toMicros(b.reserve)`; `totalUsd = fromMicros(totalMicros)`. One line: `{ label: \`Answers reserved at ${formatUsd(b.reserve)} each\`, quantity: observations, unitUsd: b.reserve, totalUsd }`. Units: `[{key:"questions",label:"questions",count:prompts},{key:"engines",label:"engines",count:engines},{key:"answers",label:"answers",count:observations}]`.
4. **Per-scan limit.** If `b.scanCap !== null && toMicros(totalUsd) > toMicros(b.scanCap)`, `blocked = { code: "over_scan_limit", message: \`This scan can reserve up to ${formatUsd(totalUsd)}, above the ${formatUsd(b.scanCap)} per-scan limit.\`, recovery: "Remove questions from the panel or contact Perceev support." }`. The same block applies above F01's `MAX_ESTIMATE_USD` ($1,000), the most any hold or approval can carry.
5. **Expected.** `engine_cost_stats(30)` rows. If every configured engine has a row, `expectedUsd = Σ prompts × median_usd`, rounded to 6 dp; else `null`.
6. **Warnings** (exact copy):
   - `collection_paused`: `probe_dispatch_control.paused` is true and `brandKey` is not in `brand_allowlist` → "Answer collection is paused for maintenance. A scan started now will wait, and may finish without answers."
   - `daily_capacity_low`: `b.dayCap !== null` and `dayCap − today's committed probe spend` (the same SQL sums as `claim_probe_dispatch` lines 75-84, exposed as F09 helper `probeDaySpendToday(admin)` running the three sums read-only) `< totalUsd` → "Today's collection capacity is nearly used. This scan may finish with fewer answers."
   - `workspace_limit_low`: the workspace's `workspace_spend_limits` row (or F01 `SPEND_DEFAULT_*` when there is none) minus `f01_committed_usd` since the UTC day / month start (F03's planned `workspace_spend_position` never shipped): daily or monthly headroom `< totalUsd` → "This scan needs more than your workspace's remaining {daily|monthly} limit ({formatUsd(headroom)})." This is a warning, not a block, because the run route's `reserveSpend` is authoritative and returns the 402.
   - `retry_note`, always: "Each question is asked once per engine. A failed answer may be retried within this amount."
   - `typical_cost`, when `expectedUsd !== null`: "Typical cost for this scan is about {formatUsd(expectedUsd)}, based on recent answers."
7. **Monthly** when `input.scheduleInterval` is set: `runsPerMonth = scheduledChecksPerMonth(interval)` (F03 `src/shared/ai-visibility-pricing.ts`), `totalUsd = fromMicros(totalMicros × runsPerMonth)`.

`ScanQuoteDeps` lets tests inject `listPanels`, `getSchedule`, `resolveEngines`, `engineStats`, `dispatchControl`, `daySpend`, `position`.

#### 6.2.4 Approved maximum as the dispatch cap

- `src/lib/workers/durableProbing.js`: `dispatchBudget(env = process.env, opts = {})` gains `opts.approvedMaxUsd`. It returns `scanCap = minNullable(envScanCap, approvedMaxUsd)` (null when both are null). `reserve` and `dayCap` are unchanged. `runDurableProbing` calls `dispatchBudget(env, { approvedMaxUsd: cp.approved_max_usd ?? null })` at line 144. No other change.
- `src/lib/workers/scanWorker.js` `runSourcingPhase`: the returned checkpoint gains `approved_max_usd: job.approved_max_usd == null ? null : Number(job.approved_max_usd)`. One property added in the object literal at `:1660-1700`.
- `src/lib/db.js` `createScanJob({ …, jobId, approvedMaxUsd, priceQuote })`: uses `jobId` when provided (validated UUID) instead of `crypto.randomUUID()`, and writes `approved_max_usd`/`price_quote` when provided. Memory mode stores them too.
- Exactness: `approvedMaxUsd` is sent to PostgREST as a JSON number produced from integer micro-dollars (`fromMicros`), so its shortest decimal form equals the intended `numeric` value. `claim_probe_dispatch` compares `numeric` sums of the same `p_reserve` values exactly, so the N-th first claim of an N-answer quote always fits (F09-AC-02).

#### 6.2.5 Contract for other priced actions (binding for F10, F13, F15, F18, F22)

| Action key (owner) | Estimate source | Approval | In-run enforcement |
|---|---|---|---|
| `ai_visibility.scan.run` (F09) | dispatch reservation × observations | optional (`implicit` when absent) | scan cap = approved |
| `ai_visibility.schedule.save` (F10) | the scan quote with `scheduleInterval` → `monthly` | required; stored with `source = 'schedule'` and the per-run `totalUsd` as the schedule's approved maximum | each scheduled window creates its job with `approved_max_usd` = stored per-run approval. If the fresh quote exceeds it, the window is recorded `blocked` with reason `price_changed` and the schedule still advances (OpenSEO `scheduledAiVisibility.ts:40-53` pattern) |
| `rank_tracking.check.run` (F15) | F03 `dataforseoPricing.serp.rankCheck` per keyword × device, plus OpenSEO's retry-round worst case (`openseo:src/shared/rank-tracking.ts:93-101`) | required | `metered({ maxUsd })` per batch; job-scoped hold with `ttlSeconds` up to 86,340 |
| `site_audit.run` (F18; renamed from `site_audit.render.run`) | crawl is free; JavaScript rendering (Firecrawl) and Lighthouse priced per page at the worst case (OpenSEO `rendering-billing.ts:39-93` pattern) | required when the quote is above zero | one long-TTL F01 hold for the worst case, settled at the end capped at the hold |
| `keywords.research.run` (F13) | F03 `dataforseoPricing.keywords.*` / `labs.*` for the requested limit and clickstream flag | optional (inline rule below) | `metered({ maxUsd })` |
| `keywords.serp.run` (F13) | `serp.live({ depth })` | optional (inline) | `metered({ maxUsd })` |
| `keywords.metrics_refresh.run` (F13) | Labs overview per stale-keyword batch of 700 per market | required | job; `metered({ maxUsd })` per batch |
| `keywords.clustering.run` (F13) | one `llmObject` call at the LLM helper estimate | required | job; `metered({ maxUsd })` |
| `domain.lookup.run`, `domain.keywords.page`, `domain.pages.page` (F14) | Labs domain overview / ranked keywords / pages rows | optional (inline) | `metered({ maxUsd })` |
| `domain.competitors.run` (F14) | SERP competitors per keyword set | required | `metered({ maxUsd })` |
| `backlinks.lookup.run`, `backlinks.page`, `backlinks.expand_domain` (F16) | Backlinks summary/history/rows per F16 §6.4 | optional (inline) | `metered({ maxUsd })` |
| `backlinks.snapshots.track` (F16) | per-run backlink summary × runs per month → `monthly` | required; stored like a schedule approval | each scheduled snapshot metered at the stored per-run maximum |
| `rank_tracking.config.save`, `rank_tracking.suggestions.run`, `rank_tracking.metrics.run` (F15) | F15 §6.2 lines (per-check quote × schedule; Labs suggestions; Labs stats per batch) | `config.save` required when scheduled with keywords; `suggestions.run` optional; `metrics.run` required | `metered({ maxUsd })`; schedule windows use the stored per-check maximum |
| `local.profile.lookup`, `local.listings.search`, `local.reviews.collect`, `local.updates.collect`, `local.questions.collect`, `local.serp.search` (F17) | F03 `dataforseoPricing.business.*` / `serp.local*` per F17 §6.2.9 | optional (inline) | `metered({ maxUsd })` |
| `local.grid.run` (F17) | grid points × local SERP page | required | job; `metered({ maxUsd })` per batch |
| `questions.generate.run`, `questions.research.run` (F08) | LLM helper estimate; LLM-mentions rows | optional (inline) | `metered({ maxUsd })` |
| `ai_visibility.explore.run` (F11) | one line per model: DataForSEO `llmResponseUsd(slug, webSearch)` or `EXPLORE_OPENROUTER_RESERVE_USD`; reused answers at $0 | required | answers dispatched only through `claim_probe_dispatch` with the approved maximum as cap |
| `content.draft.run` (F22, Content Studio) | Content Studio per-item cost (`CONTENT_MAX_COST_PER_ITEM`) | required | Content Studio's own cap; ships disabled |

**Inline approval rule (F13, used by F08, F14, F16, F17).** An interactive lookup whose fresh quote is at or under **USD 0.25** (`PricedActionButton` `dialogThresholdUsd`, default 0.25) may be approved by clicking a button that shows the price ("Run search · $0.04"); the click sends that `totalUsd` as `maxUsd`, so `requireApprovedPrice` still records `source: "dialog"` and `409 price_changed` still applies. Above the threshold, and for every bulk action, job-backed action, schedule or action with `requireApproval: true`, the client always opens `CostReviewDialog`. A zero quote (cache hit) runs without `maxUsd`.

Every such route takes `maxUsd` in its body, calls `requireApprovedPrice` before creating anything, documents `price_changed`, `approval_required` and its blocked codes in its `.contract.ts` `errorCodes`, and uses `CostReviewDialog`.

### 6.3 Jobs

| Kind | Trigger | Steps | Completion |
|---|---|---|---|
| `pricing.retention` | F01 periodic, daily (system) | `prune` (DB_STEP) → `prune_price_approvals(now − 395 days, 5000)` | `completed` |

F09 adds no scan job kinds. Scans stay on the scan worker (F01 §6.3.8).

### 6.4 Provider calls and cost

None. Quotes read only our own database and env. The estimate route is free and unmetered. Quotes reflect `SCAN_PROBE_RESERVATION_USD` at request time. Changing that env value changes quotes immediately, and approved runs whose quote rose return `409 price_changed`.

### 6.5 API routes

**`POST /api/customer/price/estimate`** (auth: workspace; members and owners)

```ts
const body = z.strictObject({
  brand_key: z.string().min(1).max(200).optional(),
  action: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/),
  input: z.unknown(),            // validated by the action's strict schema
});
// response: priceQuoteSchema
```

Example request `{ "action": "ai_visibility.scan.run", "input": { "panelKey": "default" } }`. Response 200:

```json
{ "action": "ai_visibility.scan.run", "currency": "USD", "totalUsd": 24, "expectedUsd": 7.2,
  "units": [ { "key": "questions", "label": "questions", "count": 30 }, { "key": "engines", "label": "engines", "count": 4 },
             { "key": "answers", "label": "answers", "count": 120 } ],
  "lines": [ { "label": "Answers reserved at $0.20 each", "quantity": 120, "unitUsd": 0.2, "totalUsd": 24 } ],
  "monthly": null,
  "warnings": [ { "code": "retry_note", "message": "Each question is asked once per engine. A failed answer may be retried within this amount." },
                { "code": "typical_cost", "message": "Typical cost for this scan is about $7.20, based on recent answers." } ],
  "blocked": null, "priceVersion": "2026-10-21.1", "quotedAt": "2026-10-21T09:30:00.000Z", "inputsHash": "<64 hex>" }
```

Errors: 400 `invalid_request`/`invalid_json`; 401/403/404/503 from `requireWorkspace`; 404 `unknown_price_action`; 503 `pricing_unavailable` "Prices could not be calculated. Please retry." on a database error. Blocked quotes return **200** with `blocked` set; only run routes turn `blocked` into 409. Not idempotency-sensitive (read-only); `Cache-Control: no-store`. Contract: `src/lib/pricing/pricing.contract.ts`.

**`POST /api/customer/scan`** (existing; converted to `route.ts` using `requireWorkspace` and `toErrorResponse`)

Request body. A loose object is kept on purpose (deviation, §11): this legacy route must keep accepting the fields existing callers send.

```ts
const body = z.looseObject({
  brand_key: z.string().min(1).max(200).optional(),
  panel_key: z.string().min(1).max(80).optional(),
  industry: z.string().max(200).optional(),
  competitors: z.string().max(2000).optional(),
  maxUsd: z.number().positive().max(1000).optional(),
});
```

Order of operations:
1. `requireWorkspace(request, { brandKey: body.brand_key })`.
2. `requireApprovedPrice("ai_visibility.scan.run", ctx, { panelKey: body.panel_key ?? "default" }, body.maxUsd)`.
3. `jobId = crypto.randomUUID()`.
4. `reserveSpend({ brandKey, feature: "ai_visibility.scan", estimateUsd: max(quote.totalUsd, 0.000001), maxUsd: approvedMaxUsd, idempotencyKey: "scan:" + jobId, ttlSeconds: 86340, subject: { kind: "scan_job", id: jobId } })`.
5. `createScanJob({ …existing args, jobId, approvedMaxUsd, priceQuote: quote })`. On `DuplicateScanError`, `releaseSpend(hold, "scan_already_running")` then 409 `scan_already_running`. On any other error, `releaseSpend(hold, "scan_create_failed")` then 500.
6. `recordApproval(admin, { brandKey, action, approvedMaxUsd, quote, source, subject: { kind: "scan_job", id: jobId }, approvedBy: user.id })`. A failure here is logged (`[pricing] approval record failed {jobId}`) and does not fail the scan.
7. `keepAlive(() => runScanChunk(jobId))`.

**Shared start function.** Steps 3–7 live in `src/lib/pricing/startCustomerScan.ts` as `startCustomerScan({ admin, brandKey, userId, quote, approvedMaxUsd, source, panelKey, legacy: { industry?, competitors? } }, deps?) → { jobId, approvedMaxUsd, quotedUsd }`, and the route calls it after steps 1–2. This is a pure move: same order, same errors, same log lines. F22 calls it from an approved assistant action with `source: "dialog"` and records its approval with `subject.kind = "assistant_approval"` in addition to the `scan_job` subject.

Response 201 (existing fields kept, two added):

```json
{ "job_id": "0c2a4b1e-8d1f-4f35-9b5e-2e0c6f1a7d90", "brand": "Offcult", "status": "pending",
  "approvedMaxUsd": 24, "quotedUsd": 24 }
```

Errors (each with `code`):

| Status | Code | Message |
|---|---|---|
| 400 | `invalid_request` | (zod) |
| 401/403/404/503 | from `requireWorkspace` | existing copy |
| 409 | `panel_not_approved` | "Review and approve a question panel before starting measurement." (existing copy kept) |
| 409 | `no_engines` | "No answer engines are set up for scans yet. Contact Perceev support." |
| 409 | `over_scan_limit` | as §6.2.3 |
| 409 | `price_changed` | as §6.2.2 |
| 402 | `daily_cap` / `workspace_cap` | F01 copy |
| 403 | `feature_disabled` | F01 copy |
| 409 | `scan_already_running` | "A scan is already running for this workspace." (existing) |
| 503 | `spend_unavailable` | F01 copy |
| 500 | `internal_error` | "Could not start the scan. Please retry." (existing copy kept by catching around steps 4–7) |

Idempotency: one running scan per workspace (existing index). A double click creates at most one job; the second request gets 409 `scan_already_running` and its hold is released. `GET /api/customer/scan` is unchanged.

### 6.6 UI

Built with F04 primitives (`Dialog`, `Button`, `Alert`, `Skeleton`, `Badge`, `Field`/label pattern, `Tooltip`) and F05's `QueryClient`. Money via `formatUsd` (F03). New files are TSX. The existing JSX shell imports them.

#### 6.6.1 Generic pieces

- `src/components/app/cost/usePriceQuote.ts` (PORT of `TrackingCostReview.tsx:35-84`):
  - `priceQuoteQueryOptions({ brandKey, action, input })`: key `["price", brandKey, action, stableStringify(input)]`, `staleTime: 0`, `retry: false`, `refetchOnWindowFocus: false`, POST `/api/customer/price/estimate`.
  - `prefetchPriceQuote(queryClient, args)`.
  - `usePriceQuote(args, { enabled })`, which uses `placeholderData: keepPreviousData`.
- `src/components/app/cost/CostReviewDialog.tsx` (PORT of `TrackingCostReview.tsx:86-239` and `TrackerSetupReview.tsx:100-110`). Props: `{ open: boolean; title: string; confirmLabel: string; pendingLabel: string; quote query; pending: boolean; priceChanged: { approvedMaxUsd: number; quote: PriceQuote } | null; error: string | null; blockedAction?: ReactNode; onConfirm(maxUsd: number): void; onClose(): void; detail?: (q: PriceQuote) => ReactNode }`.
- `src/components/app/cost/MonthlyProjection.tsx`, for F10: "**{formatUsd(monthly.totalUsd)}** estimated per month if it runs {interval}." (TrackerSetupReview copy.)

**Dialog states (exact copy for the scan use):**

| State | Content | Primary button |
|---|---|---|
| Loading (no data yet) | `Skeleton h-8 w-32` + two `Skeleton h-4` lines; `aria-busy` | "Run scan", disabled |
| Error | `Alert` destructive: "The price could not be calculated." + "Retry" button | disabled |
| Blocked | `Alert` destructive with `blocked.message`; `panel_not_approved` adds a secondary button "Review questions" → `/portal/measurement` | disabled |
| Ready | label "Cost"; amount "Up to {formatUsd(totalUsd)}" (`text-2xl font-semibold tabular-nums`); sub-line "{answers} answers ({questions} questions × {engines} engines)"; `lines[0].label` in muted text; each warning as a muted bullet; `collection_paused`, `daily_capacity_low` and `workspace_limit_low` as `Alert` warning instead | "Run scan" |
| Refreshing (placeholder shown) | as Ready plus a small spinner next to the amount, `aria-live="polite"` "Updating price…" | disabled (OpenSEO: approve only the current price) |
| Zero answers (`answers` = 0 and not blocked) | "This scan has no answers to collect." | disabled |
| Starting | buttons disabled; primary shows spinner + "Starting…"; the dialog cannot be closed (Escape and the overlay are ignored) | — |
| Price changed (409) | `Alert` warning title "The price changed", body "This scan now costs up to {formatUsd(new)}. You approved {formatUsd(old)}. Review the new price and run again."; amount shows the new quote | "Run scan" (sends the new `totalUsd`) |
| Start error (other) | `Alert` destructive with the API `error` | "Run scan" |

Secondary button "Cancel" (ghost), disabled while starting. Title "Run scan". The dialog shows no per-answer price, following OpenSEO (engines differ). The line "Answers reserved at $0.20 each" states the reservation unit, not a price per answer. Footer note under the amount: "You are only charged the provider cost of answers collected. Unused reservation is released when the scan finishes."

**Accessibility:** focus moves to the dialog title on open and returns to the triggering button on close. The amount is announced by an `aria-live` region. Buttons have text labels.

**Phone:** `CostReviewDialog` renders `DialogContent fullScreenOnMobile` (F04), so below 640 px it is full-screen; buttons stacked, primary first.

#### 6.6.2 Scan wiring (all seven Run scan entry points, no call-site changes)

- `src/components/portal/useScanTracker.js` (version on `main` after the run-scan fix and F05):
  - New exported constant `PRICE_CHANGED = "price_changed"`.
  - New state `review = { open: boolean, priceChanged: { approvedMaxUsd, quote } | null, error: string | null }`.
  - `start()`: when `priceReview` (a new hook argument, `true` when `FEATURE_PRICE_REVIEW` is on for the workspace; `PortalShell` reads it from F04's `GET /api/customer/features` (`features.price_review`; F09 appends `"price_review"` to `CLIENT_FEATURES`) is true, it only opens the dialog (`setReview({ open: true, priceChanged: null, error: null })`) and sends no request. Otherwise it calls `confirmStart(undefined)`, today's behaviour.
  - `confirmStart(maxUsd)`: F05's `postStart(maxUsd)` renamed and exported (F05 §6, `useScanTracker.js`); F09 edits sit on top of F05's version, not the pre-F05 one. The POST body is the old one plus `maxUsd` when defined. On `409 price_changed` it sets `review.priceChanged = { approvedMaxUsd: body.details.approvedMaxUsd, quote: body.details.quote }` and keeps the dialog open. On 402/403/409 others it sets `review.error = body.error` (except `scan_already_running` and `panel_not_approved`, which keep their existing handling and close the dialog). On success it closes the dialog.
  - `cancelReview()` closes and clears.
  - The hook also returns `review`, `confirmStart` and `cancelReview`.
- `src/components/portal/ScanCostReview.tsx`: renders `CostReviewDialog` from `usePortal().scan`, with query args `{ brandKey, action: "ai_visibility.scan.run", input: { panelKey: "default" } }`, `onConfirm = scan.confirmStart` and `pending = scan.starting`. It is mounted once in `src/components/portal/PortalShell.jsx` next to the existing children.
- Prefetch: `PortalShell` calls `prefetchPriceQuote` once the workspace is known and `priceReview` is true, so the dialog usually opens on a price (OpenSEO `prefetchRunNowCost`).
- `src/lib/features/clientFeatures.ts` (F04): append `"price_review"` to `CLIENT_FEATURES`. The overview route is not changed.

### 6.7 Permissions, privacy, observability

- Members and owners can quote and approve scans (today both can run scans). Approvals record `approved_by`.
- **Logs:** `[pricing] price_changed {action, brandKey, approvedMaxUsd, totalUsd}`, `[pricing] approval record failed {jobId}`. No panel text or prompts are logged.
- **PostHog (F26 names, when F26 exists):** `price:quote_shown {action, total_usd, blocked_code}`, `price:approved {action, approved_usd, source}`, `price:changed {action, old_usd, new_usd}`.
- Quotes never reveal other tenants' data. Platform capacity is shown only as a coarse warning, never as numbers.

## 7. Code reuse map

| OpenSEO source | Perceev target | Mode | Adaptation notes |
|---|---|---|---|
| `openseo:src/server/features/ai-visibility/services/aiVisibilityCost.ts:60-109` | `src/lib/pricing/actions/scanRun.ts` (`estimateScanRun`) | PORT | Counts and monthly projection kept. The unit price is our dispatch reservation (so the quote never under-quotes), not provider list prices. Hosted/credit warnings replaced by our warnings. The `patch` idea becomes `scheduleInterval` input; F08/F10 add panel patches later. |
| `openseo:src/server/features/ai-visibility/services/aiVisibilityRuns.ts:190-208` | `src/lib/pricing/pricedActions.ts` (`requireApprovedPrice`) | PORT | Same micro-dollar comparison and refusal before anything is created. `COST_LIMIT_EXCEEDED` → `409 price_changed` with the fresh quote in `details`. |
| `openseo:src/types/schemas/ai-visibility.ts:97-106` | scan route body `maxUsd` | PORT | Optional instead of required on the legacy scan route (back-compat); bound `≤ 1000` instead of `≤ 100`. New routes require it. |
| `openseo:src/server/features/ai-visibility/services/aiVisibilityRuns.test.ts:111-115` | `src/lib/pricing/scanRoute.route.test.mjs` | PORT | "refuses … more than the approved maximum" and "no run created" assertions. |
| `openseo:src/client/features/ai-visibility/TrackingCostReview.tsx:35-239` | `src/components/app/cost/usePriceQuote.ts`, `CostReviewDialog.tsx` | PORT | Generic over actions. Schedule mode moves to F10. Adds blocked, warning and price-changed states. "Run now" → "Run scan". |
| `openseo:src/client/features/ai-visibility/TrackerSetupReview.tsx:100-110` | `src/components/app/cost/MonthlyProjection.tsx` | PORT | Copy and structure for the monthly line. |
| `openseo:src/shared/rank-tracking.ts:186-195` | via F03 `scheduledChecksPerMonth` | PORT (in F03) | Reused, not re-ported. |
| `openseo:src/server/features/ai-visibility/services/scheduledAiVisibility.ts:40-53` | contract for F10 (§6.2.5) | PATTERN | Advance the schedule even when a run is refused for price. |
| `openseo:src/server/lib/audit/rendering-billing.ts:39-93` | contract for F18 (§6.2.5) | PATTERN | Worst-case long-TTL hold. |

## 8. Implementation plan

### Phase 1 — Priced-action core and scan quote

**Goal:** a correct, tested quote whose total equals what dispatch will reserve.

- [x] **P1.T1 Core**
  - [x] **P1.T1.S1** *Files:* `src/shared/pricing.ts`, `src/lib/pricing/pricedActions.ts`, `src/lib/pricing/pricedActions.test.ts`. *Do:* §6.2.1–6.2.2; tests: duplicate key; loose input schema rejected; unknown action 404; zod error; blocked → 409 with code; missing `maxUsd` → implicit or 400 per `requireApproval`; `quoteExceeds(0.0000015, 0.000001)` true and `quoteExceeds(24, 24)` false; 409 body has `details.quote` and `details.approvedMaxUsd`. *Verify:* `node --test src/lib/pricing/pricedActions.test.ts` → pass (F09-AC-13, 18).
  - [x] **P1.T1.S2** *Files:* `src/lib/pricing/actions/scanRun.ts`, `src/lib/pricing/actions/index.ts` (imports every action module), `src/lib/pricing/actions/scanRun.test.ts`, `src/lib/pricing/probeDaySpend.ts`. *Do:* §6.2.3 with `ScanQuoteDeps`; tests: reserve 0.2 × (30 prompts incl. 2 diagnostics) × 4 configured engines = 24.0 exactly; one unconfigured engine excluded; reserve `"1"` default; `0.333333 × 7` exact via micros; blocked panel/engines/limit with exact copy; each warning trigger with exact copy; expected null with 3 of 4 engines in stats; monthly 30/4/1. *Verify:* `node --test src/lib/pricing/actions/scanRun.test.ts` → pass (F09-AC-01, 09, 10, 11, 17).
- [x] **P1.T2 Estimate route**
  - [x] **P1.T2.S1** *Files:* `src/app/api/customer/price/estimate/route.ts`, `src/lib/pricing/pricing.contract.ts`, `src/lib/features/names.ts` (add `price_review: { spend: [] }`). *Do:* §6.5. *Verify:* `node --test src/lib/http/routeContract.test.ts` → pass.
  - [x] **P1.T2.S2** *Files:* `src/lib/pricing/estimateRoute.route.test.mjs` (hooks `src/lib/customerRoutes.test.hooks.mjs`). *Do:* 200 quote; unknown action 404; strict input rejects `{ panelKey: "x", extra: 1 }`; blocked returns 200 with `blocked`; tenant: brand not a membership → 404. *Verify:* `node --import ./src/lib/liveWriteGuardAuto.mjs --test src/lib/pricing/estimateRoute.route.test.mjs` → pass (F09-AC-12).

**Checkpoint:** `npm test`, `npm run typecheck`, `npm run build` pass; F09-AC-01, 09–13, 17, 18.

### Phase 2 — Approval enforcement on Run scan

**Goal:** a scan can never start above a stale approval, and never spend more than it was approved for.

- [ ] **P2.T1 Migration**
  - [ ] **P2.T1.S1** *Files:* `supabase/migrations/080_f09_price_approvals.sql`, `scripts/setup-supabase.mjs`, `tests/customer-uat.sql`. *Do:* §6.1. *Verify:* all migrations applied twice on loopback `perceev_qa` → exit 0; CI database step commands → pass.
- [ ] **P2.T2 Worker cap**
  - [ ] **P2.T2.S1** *Files:* `src/lib/workers/durableProbing.js` (`dispatchBudget` opts; call site at `:144`), `src/lib/workers/scanWorker.js` (checkpoint field), `src/lib/db.js` (`createScanJob` params). *Do:* §6.2.4 exactly; no other edits. *Verify:* `node --import ./src/lib/liveWriteGuardAuto.mjs --test src/lib/workers/*.test.mjs src/lib/repairs/r02-dispatch-integration.test.mjs` → all pass unchanged.
  - [ ] **P2.T2.S2** *Files:* `src/lib/workers/approvedCap.test.mjs`. *Do:* `dispatchBudget({SCAN_MAX_COST_PER_SCAN:"10"}, {approvedMaxUsd: 24})` → 10; `({}, {approvedMaxUsd: 24})` → 24; `({SCAN_MAX_COST_PER_SCAN:"30"}, {approvedMaxUsd: 24})` → 24; `({}, {})` → null; `runDurableProbing` with a fake store records `scanCap: 24` in its `claim` call when the checkpoint has `approved_max_usd: 24`, and `null` when absent; `createScanJob` memory mode keeps `jobId` and the new fields. *Verify:* `node --import ./src/lib/liveWriteGuardAuto.mjs --test src/lib/workers/approvedCap.test.mjs` → pass (F09-AC-08).
- [ ] **P2.T3 Scan route**
  - [ ] **P2.T3.S1** *Files:* `src/app/api/customer/scan/route.js` → `route.ts` (POST rewritten per §6.5; GET body unchanged, moved to `requireWorkspace`/`toErrorResponse` with identical messages), `src/lib/pricing/startCustomerScan.ts` (steps 3–7 extracted as a pure move), `src/lib/pricing/scanRoute.contract.ts`. *Verify:* `node --import ./src/lib/liveWriteGuardAuto.mjs --test src/lib/customerRoutes.test.mjs src/lib/scanRoute.route.test.mjs` → pass unchanged.
  - [ ] **P2.T3.S2** *Files:* `src/lib/pricing/scanRoute.route.test.mjs`. *Do:* fakes for admin, `reserveSpend`, `createScanJob`, `runScanChunk`; cases: price_changed (no create/reserve/approval), approved (hold args exact, job args exact, approval row), implicit (no `maxUsd`), each F01 refusal (no job), duplicate → hold released + 409 `scan_already_running`, create failure → hold released + 500, approval-record failure still 201. *Verify:* pass (F09-AC-04..07).
- [ ] **P2.T4 DB harness**
  - [ ] **P2.T4.S1** *Files:* `scripts/qa/check-f09-db.mjs` (loopback guard). *Do:* groups `quote-equals-reservation` (for each reserve/N pair: seed N observations for a QA job in an allowlisted QA brand with `probe_dispatch_control` set **inside the QA database only** to `paused = false`; this is a disposable local DB, never `set_probe_rollout` against a shared one; call `claim_probe_dispatch(id, reserve, cap = quote)` for all N → all granted; `sum(reserved_usd) = quote` exactly), `approved-cap` (finish k attempts with charged = reserve; the (N+1)-th claim, a retry, is refused `spend_reservation_refused`), `approval-records` (RLS: each user sees own approvals only). *Verify:* `node scripts/qa/check-f09-db.mjs` → PASS per group (F09-AC-02, 03, 05).
  - [ ] **P2.T4.S2** *Files:* `.github/workflows/ci.yml`. *Do:* run `check-f09-db.mjs` in `customer-database` after F03's harness. *Verify:* CI green.
- [ ] **P2.T5 Retention job**
  - [ ] **P2.T5.S1** *Files:* `src/lib/pricing/jobs.ts`, `src/lib/jobs/kinds.ts` (one import line). *Do:* §6.3. *Verify:* `node --test src/lib/pricing/jobs.test.ts` (periodic dedupe key per day; RPC args) → pass.

**Checkpoint:** all unit, route and DB suites pass, plus `check-probe-dispatch.mjs` unchanged; F09-AC-02..08.

### Phase 3 — Cost dialog (requires F04, F05 and the run-scan fix merged)

**Goal:** every Run scan shows the price and sends the approved maximum.

- [ ] **P3.T0 Precondition.** *Verify:* `git grep -c "PANEL_NOT_APPROVED" origin/main -- src/components/portal/useScanTracker.js` → at least 1 (the run-scan fix is merged), and F05 phase 3 (`postStart` in `useScanTracker.js`) is merged. If it is not merged, stop and report. Do not re-implement its changes.
- [ ] **P3.T1 Generic UI**
  - [ ] **P3.T1.S1** *Files:* `src/components/app/cost/usePriceQuote.ts`, `CostReviewDialog.tsx`, `MonthlyProjection.tsx` (licence headers on all three). *Do:* §6.6.1. *Verify:* `npm run build` → exit 0.
- [ ] **P3.T2 Scan wiring**
  - [ ] **P3.T2.S1** *Files:* `src/components/portal/useScanTracker.js` (on top of F05's `postStart`), `src/components/portal/ScanCostReview.tsx`, `src/components/portal/PortalShell.jsx`, `src/lib/features/clientFeatures.ts`. *Do:* §6.6.2. *Verify:* `npm run build` → exit 0.
  - [ ] **P3.T2.S2** *Files:* `src/components/portal/portalRegressions.test.mjs`. *Do:* in the three lifecycle tests at `:112-175`, call `lifecycle.output.confirmStart(24)` where they called `start()`, and assert the POST body includes `"maxUsd":24`; add tests: (a) `priceReview: true` → `start()` makes no fetch and sets `review.open`; (b) `priceReview: false` → `start()` POSTs without `maxUsd`; (c) 409 `price_changed` → `review.priceChanged.quote.totalUsd` equals the response's; (d) 402 `daily_cap` → `review.error` is the API message. The GettingStarted tests at `:549-619` stay unchanged (`onClick === scan.start` remains true). *Verify:* `node --test src/components/portal/portalRegressions.test.mjs src/components/portal/portalProgress.test.mjs` → pass (F09-AC-14 unit half, F09-AC-16).
- [ ] **P3.T3 Browser**
  - [ ] **P3.T3.S1** *Files:* `scripts/qa/check-f09-browser.mjs` (Playwright from `worker/node_modules/playwright`; the local app with route interception for `/api/customer/price/estimate`, `/api/customer/scan`, `/api/customer/features`). *Do:* from each of the seven entry points, the dialog opens; loading → ready copy; refreshing disables the button; blocked `panel_not_approved` shows "Review questions"; confirm sends `maxUsd` equal to the shown amount; 409 `price_changed` flow (F09-AC-15); Escape is ignored while starting; phone width 390 px; no request leaves `127.0.0.1`. *Verify:* `node scripts/qa/check-f09-browser.mjs http://127.0.0.1:3328` → all groups PASS (F09-AC-14, 15).
  - [ ] **P3.T3.S2** *Files:* `.github/workflows/ci.yml`, `.env.example` (`# FEATURE_PRICE_REVIEW=off`). *Do:* add the script to the browser job. *Verify:* CI green; `npm run check:secrets` → pass.

**Checkpoint:** all suites green; F09-AC-14..16; README status → Merged.

## 9. Test plan

| Test file | Cases | ACs |
|---|---|---|
| `src/lib/pricing/pricedActions.test.ts` | registry, approval rules, micro-dollar comparison, 409 body | 13, 18 |
| `src/lib/pricing/actions/scanRun.test.ts` | counts, reservation equality, blocks, warnings, expected, monthly | 01, 09, 10, 11, 17 |
| `src/lib/pricing/estimateRoute.route.test.mjs` | quote route | 12 |
| `src/lib/workers/approvedCap.test.mjs` | cap resolution, checkpoint plumbing, createScanJob params | 08 |
| `src/lib/pricing/scanRoute.route.test.mjs` | run route paths | 04–07 |
| `scripts/qa/check-f09-db.mjs` | reservation equality, cap enforcement, approvals RLS | 02, 03, 05 |
| `src/components/portal/portalRegressions.test.mjs` (updated) | start/confirm semantics, flag off | 14, 16 |
| `scripts/qa/check-f09-browser.mjs` | dialog states and flows | 14, 15 |
| `src/lib/http/routeContract.test.ts` (F01) | new contracts | 18 |

Fixtures: `tests/fixtures/f09/panel-30.json` (a synthetic approved panel: 28 questions + 2 diagnostics, no customer text), `tests/fixtures/f09/quote-24.json` and `quote-26_4.json` (the quotes used in the 409 examples). Nothing calls a provider.

## 10. Rollout and rollback

- **Env:** `FEATURE_PRICE_REVIEW` (new; default off in production). Existing `SCAN_PROBE_RESERVATION_USD`, `SCAN_MAX_COST_PER_SCAN`, `SCAN_MAX_COST_PER_DAY` are read, never written.
- **Order:** F03 merged (seeds `ai_visibility.scan` enabled) → phase 1 (quote; invisible) → phase 2 (server enforcement; every scan, including the owner's demo script, is now capped at its quote and holds workspace spend) → phase 3 (dialog behind the flag).
- **Owner steps:**
  1. After phase 2 deploys, run one owned scan through the existing demo flow (no `maxUsd`). Confirm in `/ops/costs` that its hold settled and that `scan_jobs.approved_max_usd` equals the quote.
  2. After phase 3, set `FEATURE_PRICE_REVIEW=allowlist` with `FEATURE_PRICE_REVIEW_BRANDS=<demo workspace key>`, then `on`.
- **Turn off:** `FEATURE_PRICE_REVIEW=off` restores the immediate Run scan (server enforcement stays; it is safe and invisible). To remove the approved cap in an emergency, revert the phase 2 PR. The columns can stay.
- **Data cleanup:** `pricing.retention` keeps 13 months of approvals.

## 11. Risks and open questions

| # | Risk / question | Default chosen |
|---|---|---|
| 1 | The owner states production reserves USD 0.20 per attempt; code and `.env.example` default to 1. This could not be verified. | Quotes read `dispatchBudget().reserve` live, so they equal the real reservation either way. With the code default of 1, a 120-answer scan quotes $120; the owner should confirm the production value before enabling the dialog. |
| 2 | The cap equals the first-pass reservation. Retries fit only within the headroom left by measured costs below the reservation (about $0.06 actual vs $0.20 reserved today). Many unknown-cost failures could leave a scan partial. | Accept. The partial scan is reported honestly (existing collection outcome), and the customer can approve a larger amount. A future option is a "retry headroom" multiplier shown as a separate line. |
| 3 | The quote's day-capacity warning reads platform-wide spend, which is shown only as a coarse warning. | Accept; it reveals no numbers. |
| 4 | The legacy scan route keeps a loose body schema and optional `maxUsd` (deviation from §9 "reject unknown fields"). | Needed for the owner's private demo script and existing clients. New routes are strict. |
| 5 | F04 `Dialog` responsive variant and `Field` names are assumed. | If F04 names differ, use F04's equivalents for the same primitives. The copy and states in §6.6 stay fixed. |
| 6 | `engine_cost_stats` medians are platform-wide, not per workspace. | Accept for "typical" wording. They are labelled "based on recent answers", not "your answers". |
| 7 | Scheduled scans (032 `enqueue_measurement_window`) do not set `approved_max_usd` until F10 ships. | They keep today's env caps. F10 implements §6.2.5. |

**Deviations from conventions:** risk 4. Also, the existing `/api/customer/scan` POST response keeps its snake_case fields and adds camelCase `approvedMaxUsd`/`quotedUsd`.

## 12. Definition of done

- [ ] Phases 1–3 merged with checkpoints green.
- [ ] F09-AC-01 … F09-AC-18 covered by passing tests in §9.
- [ ] `npm test`, `npm run typecheck`, `npm run build`, CI database and browser jobs green; `check-probe-dispatch.mjs` unchanged and passing.
- [ ] `THIRD_PARTY_NOTICES.md` lists the ported files.
- [ ] `features/README.md` F09 status updated.
- [ ] Owner check recorded: production `SCAN_PROBE_RESERVATION_USD` value confirmed (number only, not a secret), one owned scan's quote vs `sum(reserved_usd)` of its first attempts (equal), and its settled hold.
