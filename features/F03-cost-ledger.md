# F03 — Cost ledger and per-answer cost

> <!-- doc-status -->
> **Status: LIVE.** Implementation spec. Not built yet.

| Field | Value |
|---|---|
| ID | F03 |
| Wave | 0 |
| Comparison rows covered | "Cost per answer" (OpenSEO: $0.0012 queued / $0.004 live for ChatGPT, Gemini, AI Overviews; Claude $0.18; Perplexity $0.04. Perceev: about $0.06 per answer on the Offcult run); the "Billing" row's *metering* half only (no payments, by owner decision) |
| Depends on | F01 (merged). F02 is listed in `README.md`, but F03 does not import F02 code: F02 binds its client to F03's price tables. Phase 4 (UI) also needs F04 (UI primitives, app shell, and **its phase 4 `src/server/features/clientFeatures.ts`**, which does not exist before then) and F05 (`QueryClient` provider) merged. |
| Blocks | F08, F09, F11, F13, F15, F22 (they read per-feature spend and use F03's price tables) |
| Reserved migrations | 050–054 (050 ledger extensions, 051 usage read functions; 052–054 unused) |
| Feature flag | `FEATURE_USAGE_PAGE` (customer Usage page and its route). The operator view and the background sync have no flag. |
| Spend features | `ai_visibility.scan` (accounting for scan answers collected through `claim_probe_dispatch`; no `metered()` call) |
| OpenSEO reference | `openseo:src/server/lib/dataforseo/pricing.ts`, `openseo:src/shared/ai-visibility.ts:21-40`, `openseo:src/server/billing/subscription.ts:477-543`, `openseo:src/server/billing/usage.ts`, `openseo:src/routes/_app/billing.tsx`, `openseo:src/client/features/billing/*`, `openseo:src/shared/billing-credit-features.ts` at `c5f8db1` |

## 1. Summary

Every answer Perceev collects and every paid provider call it makes gets a ledger row with its real cost. Each row says where the number came from: provider-reported, priced from our table, or unknown and counted at its reservation. Customers see what each scan and each answer cost, and a Usage page shows spend by day and feature against the workspace's limits. The operator sees where estimates undershoot real costs. This is what makes the comparison "OpenSEO costs a tenth of a cent per answer, we cost six cents" measurable per engine. It also gives the DataForSEO bake-off (F02) and any later billing a trustworthy base.

## 2. What OpenSEO does (observed)

1. **Price tables are code.** `pricing.ts` holds raw USD constants per DataForSEO endpoint, read from the provider's price table in Sep 2026. Shapes priced by page, depth or tokens are marked "measured" from billed costs (`openseo:src/server/lib/dataforseo/pricing.ts:63-78`). Examples: Labs $0.012 per task + $0.00012 per row, doubled with clickstream (`:80-85`); Google Ads live $0.09 (`:87-88`); Backlinks $0.024 + $0.000036 per row (`:90-92`); Lighthouse $0.005 (`:111-113`); LLM mentions $0.1 + $0.001 per row (`:115-121`); LLM responses at the 4,096-token cap, per model, with or without web search: chat_gpt 0.09/0.05, claude 0.18/0.08, gemini 0.11/0.05, perplexity 0.04/0.04 (`:122-145`); Maps/Local Finder $0.002 per page and $0.0012 per queued task (`:147-154`).
2. Each estimator is tied to its fetcher's input type (`priced()`, `pricing.ts:156-164`). Every client entry needs one (`dataforseoPricing`, `:187-326`). SERP is billed per page of 10, a partial page bills as a full page, and a keyword with a search operator bills 5× (`:174-180`; `openseo:src/shared/rank-tracking.ts:16-25`, `:69-91`).
3. AI-visibility answer prices: `AI_RECORD_COST_USD = 0.0012` (queued; AI Overviews = SERP page $0.0006 + async overview $0.0006) and `AI_LIVE_RECORD_COST_USD = 0.004` (live) (`openseo:src/shared/ai-visibility.ts:31-40`). Claude and Perplexity always use the model API at live prices (`ai-visibility.ts:21-30`; `openseo:src/server/features/ai-visibility/services/aiVisibilityCost.ts:25-32`).
4. Pricing tests pin estimates to real billed amounts, for example "Labs research, 500 rows with clickstream (incident shape)" = $0.144 and "live SERP for a keyword with a search operator (billed 5x)" = $0.0175 (`openseo:src/server/lib/dataforseo/pricing.test.ts:8-64`).
5. **Real cost comes from the provider.** Each DataForSEO task returns `cost` and `path`; one zod guard turns them into the billing envelope (`openseo:src/server/lib/dataforseo/envelope.ts:6-20`, `:53-113`). OpenRouter reports `providerMetadata.openrouter.usage.cost` (`openseo:src/server/lib/chatAgent.ts:26-40`).
6. **Reconciliation.** Settlement compares the actual against the held estimate. An undershoot is logged as `[billing] estimate undershoot` with paths, estimate and actual, because a stale price constant leaves "a hole" in the spend bound (`openseo:src/server/billing/subscription.ts:534-542`). A finalize that fails twice is logged for manual reconciliation (`:511-520`). Calls DataForSEO did not bill are not charged (`openseo:src/server/lib/dataforseo/client.ts:365-382`).
7. **Spend is attributed to features.** A credit feature is chosen per call or derived from the API path (`openseo:src/shared/billing-credit-features.ts:1-75`). Labels live in one map, and unknown keys show as "Other" (`:12-26`, `:77-79`).
8. **Usage tab.** `getOrganizationBillingUsage` returns the last 30 days binned per day in the viewer's timezone, plus totals by feature label. Ungrouped spend becomes "Other", and features at or below zero are hidden (`openseo:src/server/billing/usage.ts:10-81`). The client query key includes the timezone, with a 60 s stale time (`openseo:src/client/features/billing/useBillingUsage.ts:4-17`).
9. **Usage UI.** One card with a "Usage" section (total in large tabular numerals, a bar chart of USD per day, "No usage recorded yet" when the total is 0) and a "Usage by feature" section (label, `$x.xx`, a proportional bar per row, the same empty copy). Each section header says "Last 30 days" (`openseo:src/client/features/billing/BillingUsageChart.tsx:23-101`, `BillingFeatureBreakdown.tsx:7-58`, `BillingUsageSection.tsx:5-21`, `BillingTabs.tsx:13-54`). The page is `PageHeader title="Billing"` above a balance card and the tabs (`openseo:src/routes/_app/billing.tsx:142-330`). Members see usage; only owners see invoices (`BillingTabs.tsx:9-12`).
10. **What OpenSEO lacks.** There is no per-answer cost shown to the customer and no stored per-call ledger in its own database: usage is aggregated from Autumn events (`usage.ts:32-41`). Undershoots exist only in logs. **(inferred from the absence of any table or UI for them.)**

## 3. What Perceev has today

- **Per-attempt answer costs exist but are invisible.** `probe_attempts` stores `reserved_usd`, `charged_usd`, `cost_state` (`unknown_billed` → `measured` on finish, `confirmed_not_dispatched`/`reconciliation_conflict` after operator reconciliation), `dispatch_state` (`intent`, `recorded`, `unknown`, `historical`) and the full `result` (`supabase/migrations/027_durable_probe_dispatch.sql:27-42`, `:200-244`, `:291-311`). `charged_usd` is `result.cost`, a number only when measured and otherwise `null` (`src/shared/engines/openai.js:43-90`). The result carries `cost_source` (`gateway`, `price_table`, `tool_price_table`, `serp_price_table`, `free_tier`; `src/shared/llmPricing.js:20-75`) and `provenance.gateway` (`src/server/workers/durableProbing.js:221-227`). `probe_observations.total_cost`/`unknown_cost_calls` roll the attempts up (`027:22-23`, `:244`).
- **Price tables for our own providers** are in `src/shared/llmPricing.js`. Per-Mtok model rates: `anthropic/claude-sonnet-4.5` 3/15 and `gpt-4o-mini` 0.15/0.6 (`:85-98`). Per-call tool fees: `gpt-4o-mini` web_search $0.01 (`:124-132`). Per-query SERP prices: Bright Data $0.0015 and SerpAPI $0.01 (`:385-397`). All are overridable by env (`LLM_MODEL_PRICES`, `LLM_TOOL_FEES`, `SERP_QUERY_PRICES`). The deployed answer-engine models (`OPENROUTER_OPENAI_MODEL=openai/gpt-6-luna`, `OPENROUTER_PERPLEXITY_MODEL=perplexity/sonar`, `OPENROUTER_GEMINI_MODEL=google/gemini-3.8-flash`, per `.env.example:228-331`) have **no** table rate. They rely on OpenRouter's reported `usage.cost`.
- **Scan totals.** `scans.raw_results.cost_total` and `scans.cost_unmeasured_calls` (`supabase/migrations/017_cost_unmeasured_calls.sql`; written at `src/server/workers/scanWorker.js:2570-2572`). The customer report route returns neither (`src/app/api/customer/scan/report/[scan_id]/route.js:46-66`). The report page shows collection counts but no cost (`src/app/portal/scans/[scanId]/page.jsx:110-161`).
- **Link from report to dispatch.** `scans.origin_job_id` → `scan_jobs.id` (`supabase/migrations/030_scan_finalize_identity.sql:2`) → `probe_observations.job_id`. `prompt_results.raw.observation_id` names the observation behind each answer (`durableProbing.js:237-249`; `027:255-266`).
- **F01 provides** `spend_holds`, `spend_ledger` (with `accounted_usd`, `cost_source ∈ provider_reported|price_table|reservation|none`, unique `source_ref`), `paid_feature_controls`, `workspace_spend_limits`, `f01_committed_usd()`, `metered()` (settles every non-scan paid call into `spend_ledger`), the job runner and `definePeriodic`.
- **No customer usage view, no operator cost view.** Operator pages exist at `/ops/measurement` and call operator-token APIs (`src/app/ops/measurement/page.jsx:1-40`; the cookie `operator_token` is read in `src/server/operatorPerimeter.js:133-140`).
- **Must not break.** P0 dispatch functions and their reservations (027–035); **F01's `reserve_spend`, `settle_spend`, `expire_spend_holds` and `f01_expire_due_holds`**, into whose transactions migration 050 inserts the two `spend_ledger` triggers (`f01_expire_due_holds` runs *inside* `reserve_spend`, so a trigger failure there would refuse a paid action — `check-f01-db.mjs` must stay green with 050 applied, and the phase 2 checkpoint runs it); the report route's existing JSON fields, the report page's existing cards and their tests (`src/components/portal/portalRegressions.test.mjs`, `portalProgress.test.mjs`), and the "Mixed" rows (no change to trend, citation or competitor logic).

## 4. Target behaviour and acceptance criteria

| ID | Statement | Verified by |
|---|---|---|
| F03-AC-01 | `src/shared/pricing/dataforseo.ts` reproduces OpenSEO's estimates exactly for every case in `openseo:src/server/lib/dataforseo/pricing.test.ts` (raw USD, to 10 decimal places). | unit `src/shared/pricing/dataforseo.test.ts` |
| F03-AC-02 | `aiAnswerUsd(engine, mode)` returns 0.0012 queued and 0.004 live for chatgpt, gemini and google_ai_overview, and the model-API price with web search for perplexity (0.04) in both modes. It also keeps the ported `claude` slug at 0.18 for **pricing-table parity only** — Claude is not a Perceev engine (owner decision, 25 October 2026) and has no label or picker entry. | unit `src/shared/ai-visibility-pricing.test.ts` |
| F03-AC-03 | `src/shared/pricing/perceev.ts` reads Bright Data, SerpAPI and OpenRouter prices **from `src/shared/llmPricing.js`** (no second copy). A changed `SERP_QUERY_PRICES` env value changes the result. | unit `src/shared/pricing/perceev.test.ts` |
| F03-AC-04 | Every finished probe attempt of a workspace scan becomes exactly one `spend_ledger` row (`source_ref = probe_attempt:<observation>:<attempt>`, feature `ai_visibility.scan`). A measured gateway cost is `provider_reported`; a measured table cost is `price_table`; an unknown or `reconciliation_conflict` cost is `reservation` at `reserved_usd`; `confirmed_not_dispatched` is `none` at 0. Re-running the sync creates no duplicates and updates rows whose cost state changed. | DB `scripts/qa/check-f03-db.mjs` group `sync` |
| F03-AC-05 | Attempts of canaries and of scan jobs with no `brand_key` are never written to `spend_ledger`. | DB group `sync` |
| F03-AC-06 | A scan's open accounting hold (`subject_kind = 'scan_job'`) is settled only after the scan job is terminal. Its ledger rows are written at that moment with `hold_id` set, the hold's `actual_usd` equals their sum (or `NULL` if any is unknown), and committed spend never counts the same scan twice (hold estimate **or** attempt rows, never both). | DB group `scan-hold` |
| F03-AC-07 | An expired scan hold is replaced by its attempt rows when the scan finishes. The `hold:<id>` reservation row is removed in the same transaction. | DB group `scan-hold` |
| F03-AC-08 | Every ledger row with `actual_usd > estimate_usd` creates one `cost_reconciliations` row of kind `undershoot`; every `reservation` row creates one of kind `unknown_cost`; an unknown row later measured is auto-resolved `provider_confirmed`. | DB group `reconcile` |
| F03-AC-09 | The operator can resolve a reconciliation as `accepted`, `price_updated` or `not_billed`. `not_billed` zeroes the ledger row's `accounted_usd` (`cost_source = 'none'`) for non-probe rows and is refused for probe-attempt rows, which must go through `reconcile_probe_dispatch`. `resolve_unknown_cost_backlog` accepts open `unknown_cost` rows older than a cutoff in bulk, never rewrites a ledger amount, and refuses a note under 10 characters. | DB group `reconcile`; route `src/server/costs/opsRoutes.route.test.mjs` |
| F03-AC-10 | `GET /api/customer/scan/report/[scan_id]` adds `cost` (totals, per engine, unknown counts) and `results[].cost`, leaving every existing field unchanged. A scan with no dispatch ledger (legacy) returns `cost.state = "unavailable"`, never zeros. | route `src/server/costs/scanCostRoute.route.test.mjs` |
| F03-AC-11 | The scan report shows a "Cost" card: total, "x answers · about $y per answer", per-engine rows, and, when unknown attempts exist, the unknown-cost alert. Every string is **exactly** the copy in §6.6.2 — this AC does not restate it, because the browser check asserts §6.6.2 verbatim. Unknown is never drawn as $0. | browser `scripts/qa/check-f03-browser.mjs` |
| F03-AC-12 | `GET /api/customer/usage?range=30d&tz=…` returns day bins in the viewer's timezone covering every day of the range (days with no rows are measured `0`), totals by feature with labels, known vs unknown USD, the latest 50 ledger rows, and today's and this month's committed spend against the workspace's caps. | route `src/server/costs/usageRoute.route.test.mjs`; unit `src/server/costs/usage.test.ts` |
| F03-AC-13 | Usage is tenant-isolated: workspace A's request never returns B's rows (route filters by `brand_key`; RLS on `spend_ledger` also enforces it). | route test; DB group `rls` |
| F03-AC-14 | `/portal/usage` renders loading, empty ("No usage recorded yet"), error, partial (unknown costs) and populated states with the exact copy in §6.6, and the range picker updates `?range=`. | browser `check-f03-browser.mjs` |
| F03-AC-15 | `/ops/costs` shows spend by workspace × feature, estimate accuracy by provider × endpoint (calls, estimate, actual, ratio, undershoots), open holds, the reconciliation queue with resolve actions, and F01's paid-feature controls and workspace limits forms. All its data routes refuse requests without the operator token — enforced by the `/api/ops/*` perimeter, not by the routes themselves, and verified by `src/server/operatorPerimeter.test.mjs` plus the phase-4 browser check rather than by a route-level test. | route `opsRoutes.route.test.mjs`; perimeter `src/server/operatorPerimeter.test.mjs`; browser `check-f03-browser.mjs` |
| F03-AC-16 | `costs.sync` runs every 5 minutes as an F01 periodic job, settles at most 50 finished scan holds and syncs at most 1,000 attempts per run, and is idempotent. | unit `src/server/costs/jobs.test.ts`; DB group `sync` |
| F03-AC-17 | `paid_feature_controls('ai_visibility.scan')` is seeded `enabled = true, mode = 'all'` so existing scans are not refused. P0 controls (dispatch pause, brand allowlist) remain the gate on collection. | DB group `seed` |
| F03-AC-18 | Engine typical-cost statistics (`engine_cost_stats(30)`) return the median and p90 of measured `charged_usd` per engine across all scans, only for engines with at least 20 measured attempts. Fewer → no row, so no invented typical cost. | DB group `stats` |
| F03-AC-19 | The two cost paths agree: for a terminal scan job whose attempts have been synced, `getScanCost(admin, jobId, brandKey).totalAccountedUsd` equals the sum of `accounted_usd` over that job's `probe_attempt:%` ledger rows, and each `byEngine[].knownUsd` equals the same-engine ledger sum. A divergence fails the test rather than showing two numbers for one scan. | unit `src/server/costs/scanCost.test.ts` (fixture shared with the SQL mapping); DB group `sync` |

## 5. Scope

**In scope**
- Price tables in code: DataForSEO (port), AI-visibility answer prices (port), and adapters over our existing `llmPricing.js` tables for Bright Data, SerpAPI and OpenRouter.
- Ledger extensions: subject columns, reconciliation log, probe-attempt sync, scan-hold settlement, read functions.
- Per-scan and per-answer cost in the scan report (API + card).
- Customer Usage page `/portal/usage` (spend by day, by feature, recent activity, against caps). No payments, plans, credits, invoices or top-ups.
- Operator view `/ops/costs`, including UI for F01's paid-feature controls and workspace limits.
- Job kind `costs.sync`. Reconciliation retention is one more prune target inside F01's existing `spend.retention`, not a new kind.

**Out of scope**
- Collecting answers or changing reservations (`claim_probe_dispatch` untouched; F02 and F09).
- The cost confirmation dialog and `409 price_changed` (F09).
- Mirroring Content Studio costs (`content_jobs.cost_total`, `content_check_claims`) into the ledger. Those tables key by brand label, not `brand_key` (§11 risk 3).
- Invoice reconciliation against provider statements (DataForSEO `id_list`, OpenRouter generation lookup). Listed as follow-up in §11.
- Billing, markup and credits (excluded by owner decision).
- Deferred Mixed rows: untouched.

## 6. Design

### 6.1 Data model

#### `supabase/migrations/050_f03_cost_ledger.sql`

```sql
-- F03: per-answer and per-call cost ledger on top of F01's spend_ledger.
-- Never modifies probe_attempts/probe_observations or any P0 function.

ALTER TABLE public.spend_ledger ADD COLUMN IF NOT EXISTS subject_kind text
  CHECK (subject_kind IS NULL OR subject_kind ~ '^[a-z_]+$');
ALTER TABLE public.spend_ledger ADD COLUMN IF NOT EXISTS subject_id text;
ALTER TABLE public.spend_ledger ADD COLUMN IF NOT EXISTS answer_ref text;
ALTER TABLE public.spend_ledger ADD COLUMN IF NOT EXISTS price_version text
  CHECK (price_version IS NULL OR length(price_version) <= 40);
COMMENT ON COLUMN public.spend_ledger.answer_ref IS 'probe_observations.id for answer rows.';
CREATE INDEX IF NOT EXISTS spend_ledger_subject_idx ON public.spend_ledger (subject_kind, subject_id)
  WHERE subject_kind IS NOT NULL;
CREATE INDEX IF NOT EXISTS spend_ledger_answer_idx ON public.spend_ledger (answer_ref) WHERE answer_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS spend_ledger_endpoint_time_idx ON public.spend_ledger (provider, endpoint, occurred_at DESC);

-- Rows written by F01's settle_spend inherit the hold's subject and price version.
CREATE OR REPLACE FUNCTION public.f03_ledger_fill() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE h spend_holds;
BEGIN
  IF NEW.hold_id IS NOT NULL AND NEW.subject_kind IS NULL THEN
    SELECT * INTO h FROM spend_holds WHERE id = NEW.hold_id;
    IF FOUND THEN NEW.subject_kind := h.subject_kind; NEW.subject_id := h.subject_id; END IF;
  END IF;
  IF NEW.price_version IS NULL THEN NEW.price_version := NEW.meta->>'price_version'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS spend_ledger_fill ON public.spend_ledger;
CREATE TRIGGER spend_ledger_fill BEFORE INSERT ON public.spend_ledger
  FOR EACH ROW EXECUTE FUNCTION public.f03_ledger_fill();

CREATE TABLE IF NOT EXISTS public.cost_reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_id uuid NOT NULL REFERENCES public.spend_ledger(id) ON DELETE CASCADE,
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  feature text NOT NULL,
  provider text NOT NULL,
  endpoint text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('undershoot','unknown_cost')),
  estimate_usd numeric(12,6),
  actual_usd numeric(12,6),
  price_version text,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolution text CHECK (resolution IN ('accepted','price_updated','not_billed','provider_confirmed')),
  resolved_at timestamptz,
  resolved_by text,
  note text CHECK (note IS NULL OR length(note) <= 500),
  CONSTRAINT cost_reconciliations_one UNIQUE (ledger_id, kind),
  CONSTRAINT cost_reconciliations_resolved CHECK ((resolution IS NULL) = (resolved_at IS NULL))
);
CREATE INDEX IF NOT EXISTS cost_reconciliations_open_idx ON public.cost_reconciliations (created_at)
  WHERE resolution IS NULL;
ALTER TABLE public.cost_reconciliations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cost_reconciliations FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.cost_reconciliations TO service_role;
-- Operator-only: service role. Customers never see estimate accuracy.

CREATE OR REPLACE FUNCTION public.f03_ledger_reconcile() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.actual_usd IS NOT NULL AND NEW.estimate_usd IS NOT NULL AND NEW.actual_usd > NEW.estimate_usd THEN
    INSERT INTO cost_reconciliations(ledger_id, brand_key, feature, provider, endpoint, kind,
                                     estimate_usd, actual_usd, price_version)
    VALUES (NEW.id, NEW.brand_key, NEW.feature, NEW.provider, NEW.endpoint, 'undershoot',
            NEW.estimate_usd, NEW.actual_usd, NEW.price_version)
    ON CONFLICT (ledger_id, kind) DO NOTHING;
  END IF;
  IF NEW.cost_source = 'reservation' THEN
    INSERT INTO cost_reconciliations(ledger_id, brand_key, feature, provider, endpoint, kind,
                                     estimate_usd, actual_usd, price_version)
    VALUES (NEW.id, NEW.brand_key, NEW.feature, NEW.provider, NEW.endpoint, 'unknown_cost',
            NEW.estimate_usd, NULL, NEW.price_version)
    ON CONFLICT (ledger_id, kind) DO NOTHING;
  ELSIF TG_OP = 'UPDATE' AND OLD.cost_source = 'reservation' THEN
    UPDATE cost_reconciliations SET resolution = 'provider_confirmed', resolved_at = now(),
           resolved_by = 'sync', actual_usd = NEW.actual_usd
     WHERE ledger_id = NEW.id AND kind = 'unknown_cost' AND resolution IS NULL;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS spend_ledger_reconcile ON public.spend_ledger;
CREATE TRIGGER spend_ledger_reconcile AFTER INSERT OR UPDATE ON public.spend_ledger
  FOR EACH ROW EXECUTE FUNCTION public.f03_ledger_reconcile();

-- Scans exist today and are gated by P0 dispatch controls; this row only adds accounting and
-- workspace caps. Deliberate exception to "paid features ship disabled" (see Deviations).
INSERT INTO public.paid_feature_controls(feature, enabled, mode, note)
VALUES ('ai_visibility.scan', true, 'all',
        'Accounting for scan answers. Collection itself is gated by claim_probe_dispatch (P0).')
ON CONFLICT (feature) DO NOTHING;

-- One ledger row per finished probe attempt. Pure mapping; P0 tables are only read.
CREATE OR REPLACE FUNCTION public.f03_upsert_attempt_rows(p_job uuid, p_hold uuid, p_limit integer)
RETURNS integer LANGUAGE plpgsql SET search_path = public AS $$
DECLARE r record; v integer := 0; v_src text; v_actual numeric; v_accounted numeric;
BEGIN
  FOR r IN
    SELECT a.observation_id, a.attempt_no, a.reserved_usd, a.charged_usd, a.cost_state, a.dispatch_state,
           a.result->>'cost_source' AS reported_source, a.started_at, a.finished_at,
           coalesce(a.result->'provenance'->>'gateway', 'unknown') AS gateway,
           o.engine, o.job_id, j.brand_key, j.status AS job_status
      FROM probe_attempts a
      JOIN probe_observations o ON o.id = a.observation_id
      JOIN scan_jobs j ON j.id = o.job_id
     WHERE j.brand_key IS NOT NULL
       AND o.purpose = 'scan'
       AND (p_job IS NULL OR o.job_id = p_job)
       AND (a.dispatch_state IN ('recorded','unknown','historical')
            OR (a.dispatch_state = 'intent' AND j.status IN ('complete','failed','cancelled')))
       -- `expired` counts: F01's expiry turns the hold estimate into a `hold:<id>` reservation
       -- row, so until settlement runs the periodic sync must not add attempt rows beside it.
       AND (p_job IS NOT NULL OR NOT EXISTS (
            SELECT 1 FROM spend_holds h WHERE h.subject_kind = 'scan_job'
               AND h.subject_id = o.job_id::text AND h.status IN ('held','expired')))
       AND NOT EXISTS (
            SELECT 1 FROM spend_ledger l
             WHERE l.source_ref = 'probe_attempt:' || a.observation_id || ':' || a.attempt_no
               AND l.cost_source = CASE
                     WHEN a.cost_state = 'confirmed_not_dispatched' THEN 'none'
                     WHEN a.cost_state = 'reconciliation_conflict' THEN 'reservation'
                     WHEN a.charged_usd IS NULL THEN 'reservation'
                     WHEN a.result->>'cost_source' = 'gateway' THEN 'provider_reported'
                     ELSE 'price_table' END
               AND l.hold_id IS NOT DISTINCT FROM coalesce(p_hold, l.hold_id))
     ORDER BY a.started_at
     LIMIT p_limit
  LOOP
    v_feature := 'ai_visibility.scan';
    IF r.cost_state = 'confirmed_not_dispatched' THEN
      v_src := 'none'; v_actual := 0; v_accounted := 0;
    ELSIF r.cost_state = 'reconciliation_conflict' OR r.charged_usd IS NULL THEN
      -- A disputed cost is not a known cost. Hold it at the reservation so it stays in the queue.
      v_src := 'reservation'; v_actual := NULL; v_accounted := r.reserved_usd;
    ELSE
      v_src := CASE WHEN r.reported_source = 'gateway' THEN 'provider_reported' ELSE 'price_table' END;
      v_actual := r.charged_usd; v_accounted := r.charged_usd;
    END IF;
    INSERT INTO spend_ledger(brand_key, feature, hold_id, job_id, source_ref, provider, endpoint, units,
                             estimate_usd, actual_usd, accounted_usd, cost_source, occurred_at, meta,
                             subject_kind, subject_id, answer_ref)
    VALUES (r.brand_key, 'ai_visibility.scan', p_hold, NULL,
            'probe_attempt:' || r.observation_id || ':' || r.attempt_no,
            r.gateway, 'probe:' || r.engine, 1, r.reserved_usd, v_actual, v_accounted, v_src,
            coalesce(r.finished_at, r.started_at),
            jsonb_build_object('engine', r.engine, 'attempt_no', r.attempt_no, 'cost_state', r.cost_state,
                               'reported_source', r.reported_source),
            'scan_job', r.job_id::text, r.observation_id)
    ON CONFLICT (source_ref) DO UPDATE SET
      actual_usd = excluded.actual_usd, accounted_usd = excluded.accounted_usd,
      cost_source = excluded.cost_source, meta = excluded.meta,
      hold_id = coalesce(excluded.hold_id, spend_ledger.hold_id);
    v := v + 1;
  END LOOP;
  RETURN v;
END $$;

-- Periodic sync for scans with no open accounting hold (legacy, scheduled, operator scans,
-- and reconciliation changes after settlement).
CREATE OR REPLACE FUNCTION public.sync_probe_attempt_costs(p_limit integer DEFAULT 1000)
RETURNS integer LANGUAGE sql SET search_path = public AS $$
  SELECT f03_upsert_attempt_rows(NULL, NULL, p_limit);
$$;

-- Settle a scan's accounting hold (created by F09) once the scan is terminal.
CREATE OR REPLACE FUNCTION public.settle_scan_hold(p_job uuid)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE h spend_holds; v_status text; v_sum numeric; v_unknown boolean; v_rows integer; r record;
BEGIN
  SELECT * INTO h FROM spend_holds
   WHERE subject_kind = 'scan_job' AND subject_id = p_job::text AND status IN ('held','expired')
   ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('settled', false, 'reason', 'no_hold'); END IF;
  SELECT status INTO v_status FROM scan_jobs WHERE id = p_job;
  IF NOT FOUND THEN
    -- release_spend only updates a hold that is still 'held' (041:247-254). An expired hold
    -- already has its hold:<id> reservation row, so it must be closed here instead: otherwise
    -- settle_finished_scan_holds re-selects it on every run and starves real settlements.
    IF h.status = 'expired' THEN
      DELETE FROM spend_ledger WHERE source_ref = 'hold:' || h.id AND cost_source = 'reservation';
      UPDATE spend_holds SET status = 'settled', actual_usd = 0, closed_at = now() WHERE id = h.id;
    ELSE
      PERFORM release_spend(h.id, 'scan_missing');
    END IF;
    RETURN jsonb_build_object('settled', false, 'reason', 'scan_missing');
  END IF;
  IF v_status NOT IN ('complete','failed','cancelled') THEN
    RETURN jsonb_build_object('settled', false, 'reason', 'scan_running');
  END IF;
  IF h.status = 'expired' THEN
    DELETE FROM spend_ledger WHERE source_ref = 'hold:' || h.id AND cost_source = 'reservation';
  END IF;
  v_rows := f03_upsert_attempt_rows(p_job, h.id, 100000);
  SELECT coalesce(sum(actual_usd), 0), bool_or(cost_source = 'reservation')
    INTO v_sum, v_unknown
    FROM spend_ledger WHERE subject_kind = 'scan_job' AND subject_id = p_job::text
     AND source_ref LIKE 'probe_attempt:%';
  UPDATE spend_holds SET status = 'settled',
         actual_usd = CASE WHEN coalesce(v_unknown, false) THEN NULL ELSE v_sum END,
         closed_at = now() WHERE id = h.id;
  -- F09 creates one hold per scan. If a second slipped through, close it at zero too: attempt
  -- rows are the source of truth, and an open sibling would stay in f01_committed_usd forever.
  FOR r IN SELECT id, status FROM spend_holds
            WHERE subject_kind = 'scan_job' AND subject_id = p_job::text
              AND status IN ('held','expired') AND id <> h.id LOOP
    IF r.status = 'expired' THEN
      DELETE FROM spend_ledger WHERE source_ref = 'hold:' || r.id AND cost_source = 'reservation';
    END IF;
    UPDATE spend_holds SET status = 'settled', actual_usd = 0, release_reason = 'duplicate_scan_hold',
           closed_at = now() WHERE id = r.id;
  END LOOP;
  RETURN jsonb_build_object('settled', true, 'rows', v_rows, 'actual_usd', v_sum,
                            'unknown', coalesce(v_unknown, false));
END $$;

CREATE OR REPLACE FUNCTION public.settle_finished_scan_holds(p_limit integer DEFAULT 50)
RETURNS integer LANGUAGE plpgsql SET search_path = public AS $$
DECLARE r record; v integer := 0;
BEGIN
  -- One row per job, so a second hold on one scan cannot hide behind a settled sibling.
  FOR r IN
    WITH candidate AS (
      SELECT h.created_at,
             -- CASE guards the cast: one malformed subject_id must not break the whole sweep.
             CASE WHEN h.subject_id ~ '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$'
                  THEN h.subject_id::uuid END AS job_id
        FROM spend_holds h
       WHERE h.subject_kind = 'scan_job' AND h.status IN ('held','expired')
    )
    SELECT c.job_id FROM candidate c
      LEFT JOIN scan_jobs j ON j.id = c.job_id
     WHERE c.job_id IS NOT NULL AND (j.id IS NULL OR j.status IN ('complete','failed','cancelled'))
     ORDER BY c.created_at LIMIT p_limit
  LOOP
    -- Count settles, not candidates: costs.sync reports this number as `settled`. There is no
    -- "already settled" skip, so a job that somehow holds two open holds settles one per run
    -- instead of stranding the older one as 'held' in f01_committed_usd for ever.
    IF coalesce((settle_scan_hold(r.job_id)->>'settled')::boolean, false) THEN v := v + 1; END IF;
  END LOOP;
  RETURN v;
END $$;

CREATE OR REPLACE FUNCTION public.resolve_cost_reconciliation(
  p_id uuid, p_resolution text, p_note text, p_by text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE c cost_reconciliations; l spend_ledger;
BEGIN
  IF p_resolution NOT IN ('accepted','price_updated','not_billed') OR length(coalesce(trim(p_note), '')) < 10 THEN
    RAISE EXCEPTION 'resolution and a note of at least 10 characters are required'; END IF;
  SELECT * INTO c FROM cost_reconciliations WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'reconciliation not found'; END IF;
  IF c.resolution IS NOT NULL THEN RETURN jsonb_build_object('resolved', false, 'resolution', c.resolution); END IF;
  SELECT * INTO l FROM spend_ledger WHERE id = c.ledger_id FOR UPDATE;
  IF p_resolution = 'not_billed' THEN
    IF l.source_ref LIKE 'probe_attempt:%' THEN
      RAISE EXCEPTION 'probe attempts are reconciled with reconcile_probe_dispatch'; END IF;
    IF l.cost_source <> 'reservation' THEN RAISE EXCEPTION 'only unknown costs can be marked not billed'; END IF;
    UPDATE spend_ledger SET actual_usd = 0, accounted_usd = 0, cost_source = 'none',
           meta = meta || jsonb_build_object('reconciled', 'not_billed') WHERE id = l.id;
  END IF;
  UPDATE cost_reconciliations SET resolution = p_resolution, resolved_at = now(), resolved_by = left(p_by, 60),
         note = left(p_note, 500) WHERE id = p_id;
  RETURN jsonb_build_object('resolved', true);
END $$;

-- Typical engine cost from measured attempts (no tenant detail is exposed: per-engine aggregates).
CREATE OR REPLACE FUNCTION public.engine_cost_stats(p_days integer DEFAULT 30)
RETURNS TABLE(engine text, samples integer, median_usd numeric, p90_usd numeric)
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT o.engine, count(*)::integer,
         round(percentile_cont(0.5) WITHIN GROUP (ORDER BY a.charged_usd)::numeric, 6),
         round(percentile_cont(0.9) WITHIN GROUP (ORDER BY a.charged_usd)::numeric, 6)
    FROM probe_attempts a JOIN probe_observations o ON o.id = a.observation_id
   WHERE o.purpose = 'scan' AND a.cost_state = 'measured' AND a.charged_usd IS NOT NULL
     AND a.started_at >= now() - make_interval(days => p_days)
   GROUP BY o.engine HAVING count(*) >= 20;
$$;

-- Bulk accept for the unknown-cost backlog. Every attempt whose provider never reported a cost
-- opens one row, so at scan volumes the queue cannot be drained one row at a time. This resolves
-- only 'unknown_cost' rows and only as 'accepted': it never rewrites a ledger amount, so it cannot
-- be used to zero spend (that is 'not_billed', which stays one row at a time and is refused for
-- probe attempts).
CREATE OR REPLACE FUNCTION public.resolve_unknown_cost_backlog(
  p_before timestamptz, p_note text, p_by text, p_limit integer DEFAULT 1000)
RETURNS integer LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v integer;
BEGIN
  IF length(coalesce(trim(p_note), '')) < 10 THEN
    RAISE EXCEPTION 'resolution and a note of at least 10 characters are required'; END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 5000 THEN
    RAISE EXCEPTION 'bulk resolve limit must be 1..5000'; END IF;
  WITH open_rows AS (
    SELECT id FROM cost_reconciliations
     WHERE kind = 'unknown_cost' AND resolution IS NULL AND created_at < p_before
     ORDER BY created_at LIMIT p_limit FOR UPDATE)
  UPDATE cost_reconciliations c SET resolution = 'accepted', resolved_at = now(),
         resolved_by = left(p_by, 60), note = left(p_note, 500)
    FROM open_rows o WHERE c.id = o.id;
  GET DIAGNOSTICS v = ROW_COUNT; RETURN v;
END $$;

CREATE OR REPLACE FUNCTION public.prune_cost_reconciliations(p_before timestamptz, p_limit integer DEFAULT 5000)
RETURNS integer LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v integer;
BEGIN
  WITH old AS (SELECT id FROM cost_reconciliations WHERE resolution IS NOT NULL AND resolved_at < p_before
                ORDER BY resolved_at LIMIT p_limit)
  DELETE FROM cost_reconciliations c USING old WHERE c.id = old.id;
  GET DIAGNOSTICS v = ROW_COUNT; RETURN v;
END $$;

REVOKE ALL ON FUNCTION public.f03_ledger_fill(), public.f03_ledger_reconcile(),
  public.f03_upsert_attempt_rows(uuid,uuid,integer), public.sync_probe_attempt_costs(integer),
  public.settle_scan_hold(uuid), public.settle_finished_scan_holds(integer),
  public.resolve_cost_reconciliation(uuid,text,text,text), public.engine_cost_stats(integer),
  public.resolve_unknown_cost_backlog(timestamptz,text,text,integer),
  public.prune_cost_reconciliations(timestamptz,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.f03_upsert_attempt_rows(uuid,uuid,integer),
  public.sync_probe_attempt_costs(integer), public.settle_scan_hold(uuid),
  public.settle_finished_scan_holds(integer), public.resolve_cost_reconciliation(uuid,text,text,text),
  public.engine_cost_stats(integer), public.resolve_unknown_cost_backlog(timestamptz,text,text,integer),
  public.prune_cost_reconciliations(timestamptz,integer) TO service_role;
NOTIFY pgrst, 'reload schema';
```

**Explore attempts are not synced here.** `f03_upsert_attempt_rows` filters `o.purpose = 'scan'` and nothing else. Two facts force that: `probe_observations.purpose` is `CHECK (purpose IN ('scan','canary'))` until F11's migration widens it (`027_durable_probe_dispatch.sql:6`), and F11-AC-01 then requires `purpose = 'explore'` to carry `job_id IS NULL` — while this function inner-joins `scan_jobs`. An `'explore'` branch could therefore never fire, so there is none, and `ai_visibility.explore` is not written by F03. F11 writes its own `spend_ledger` rows for that feature using the same `source_ref` form `probe_attempt:<observation>:<attempt>`, and the unique `source_ref` keeps any later sync from double-counting. `SPEND_FEATURE_LABELS` does **not** carry the `ai_visibility.explore` label: F11 adds that key in the same PR that adds its `SpendFeature`, and F03 writes no row under it.

Why the double-counting rule holds: while a scan's hold is `held` **or `expired`**, its estimate counts in `f01_committed_usd` (F01's expiry writes a `hold:<id>` reservation row at the estimate) and **no** attempt rows exist for that job, because the periodic sync skips jobs with either status. Settlement writes the attempt rows and deletes an expired hold's reservation row in one transaction. A scan with no hold (scheduled scans before F10, operator scans) is synced as attempts finish.

#### `supabase/migrations/051_f03_usage.sql`

```sql
-- F03: read functions for the customer Usage page and the operator cost view. Service role only.
CREATE OR REPLACE FUNCTION public.workspace_usage_days(p_brand text, p_from timestamptz, p_to timestamptz, p_tz text)
RETURNS TABLE(day date, feature text, accounted_usd numeric, known_usd numeric, unknown_usd numeric, calls integer)
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT (occurred_at AT TIME ZONE p_tz)::date, feature,
         sum(accounted_usd),
         coalesce(sum(actual_usd) FILTER (WHERE cost_source IN ('provider_reported','price_table')), 0),
         coalesce(sum(accounted_usd) FILTER (WHERE cost_source = 'reservation'), 0),
         count(*) FILTER (WHERE cost_source <> 'none')::integer
    FROM spend_ledger
   WHERE brand_key = p_brand AND occurred_at >= p_from AND occurred_at < p_to
   GROUP BY 1, 2 ORDER BY 1, 2;
$$;

CREATE OR REPLACE FUNCTION public.workspace_spend_position(p_brand text, p_default_daily numeric, p_default_monthly numeric)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE l workspace_spend_limits; v_has boolean;
  v_day timestamptz := date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  v_month timestamptz := date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
BEGIN
  SELECT * INTO l FROM workspace_spend_limits WHERE brand_key = p_brand; v_has := FOUND;
  RETURN jsonb_build_object(
    'today_usd', f01_committed_usd(p_brand, NULL, v_day),
    'month_usd', f01_committed_usd(p_brand, NULL, v_month),
    'daily_cap_usd', CASE WHEN v_has THEN l.daily_cap_usd ELSE p_default_daily END,
    'monthly_cap_usd', CASE WHEN v_has THEN l.monthly_cap_usd ELSE p_default_monthly END,
    'open_holds_usd', coalesce((SELECT sum(estimate_usd) FROM spend_holds WHERE brand_key = p_brand AND status = 'held'), 0),
    'open_holds', (SELECT count(*) FROM spend_holds WHERE brand_key = p_brand AND status = 'held'),
    'day_starts_at', v_day, 'month_starts_at', v_month);
END $$;

CREATE OR REPLACE FUNCTION public.operator_costs_by_workspace(p_from timestamptz, p_to timestamptz)
RETURNS TABLE(brand_key text, feature text, accounted_usd numeric, known_usd numeric, unknown_usd numeric,
              calls integer, open_reconciliations integer)
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT l.brand_key, l.feature, sum(l.accounted_usd),
         coalesce(sum(l.actual_usd) FILTER (WHERE l.cost_source IN ('provider_reported','price_table')), 0),
         coalesce(sum(l.accounted_usd) FILTER (WHERE l.cost_source = 'reservation'), 0),
         count(*)::integer,
         (SELECT count(*)::integer FROM cost_reconciliations c
           WHERE c.brand_key = l.brand_key AND c.feature = l.feature AND c.resolution IS NULL)
    FROM spend_ledger l WHERE l.occurred_at >= p_from AND l.occurred_at < p_to
   GROUP BY l.brand_key, l.feature ORDER BY 3 DESC;
$$;

CREATE OR REPLACE FUNCTION public.operator_costs_by_endpoint(p_from timestamptz, p_to timestamptz)
RETURNS TABLE(provider text, endpoint text, calls integer, estimate_usd numeric, actual_usd numeric,
              unknown_calls integer, undershoots integer, max_ratio numeric)
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT provider, endpoint, count(*)::integer,
         coalesce(sum(estimate_usd), 0), coalesce(sum(actual_usd), 0),
         count(*) FILTER (WHERE cost_source = 'reservation')::integer,
         count(*) FILTER (WHERE actual_usd > estimate_usd)::integer,
         max(round(actual_usd / nullif(estimate_usd, 0), 4))
    FROM spend_ledger WHERE occurred_at >= p_from AND occurred_at < p_to AND cost_source <> 'none'
   GROUP BY provider, endpoint ORDER BY 7 DESC, 5 DESC;
$$;

REVOKE ALL ON FUNCTION public.workspace_usage_days(text,timestamptz,timestamptz,text),
  public.workspace_spend_position(text,numeric,numeric),
  public.operator_costs_by_workspace(timestamptz,timestamptz),
  public.operator_costs_by_endpoint(timestamptz,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.workspace_usage_days(text,timestamptz,timestamptz,text),
  public.workspace_spend_position(text,numeric,numeric),
  public.operator_costs_by_workspace(timestamptz,timestamptz),
  public.operator_costs_by_endpoint(timestamptz,timestamptz) TO service_role;
NOTIFY pgrst, 'reload schema';
```

Migrations 052–054 are reserved and unused.

`scripts/setup-supabase.mjs` additions:

```js
"050_f03_cost_ledger.sql": [
  {kind:"column",name:"spend_ledger.subject_kind"},{kind:"column",name:"spend_ledger.answer_ref"},
  {kind:"table",name:"cost_reconciliations"},{kind:"function",name:"sync_probe_attempt_costs"},
  {kind:"function",name:"settle_scan_hold"},{kind:"function",name:"settle_finished_scan_holds"},
  {kind:"function",name:"resolve_cost_reconciliation"},{kind:"function",name:"engine_cost_stats"},
  {kind:"function",name:"f03_upsert_attempt_rows"},{kind:"function",name:"prune_cost_reconciliations"},
  {kind:"function",name:"resolve_unknown_cost_backlog"},
],
"051_f03_usage.sql": [
  {kind:"function",name:"workspace_usage_days"},{kind:"function",name:"workspace_spend_position"},
  {kind:"function",name:"operator_costs_by_workspace"},{kind:"function",name:"operator_costs_by_endpoint"},
],
```

### 6.2 Server modules

**Price tables.** All are code, versioned by `PRICE_TABLE_VERSION`. They are pure, so the client and server can share them where noted. Each file that ports OpenSEO carries the licence header.

| File | Exports |
|---|---|
| `src/shared/pricing/version.ts` (F03 owns only the four files listed in this table; F09 also adds `startCustomerScan.ts` and its route test to `src/shared/pricing/`) | `export const PRICE_TABLE_VERSION = "2026-10-21.1";` Bump the date-sequence on any price change. Every estimate writes it to `meta.price_version`. |
| `src/shared/pricing/dataforseo.ts` (PORT of `pricing.ts:63-326` and `rank-tracking.ts:16-25, 69-91`) | Constants verbatim (`LABS_TASK_USD = 0.012`, `LABS_ROW_USD = 0.00012`, `GOOGLE_ADS_LIVE_TASK_USD = 0.09`, `BACKLINKS_TASK_USD = 0.024`, `BACKLINKS_ROW_USD = 0.000036`, `BUSINESS_LISTINGS_TASK_USD = 0.012`, `BUSINESS_LISTINGS_ROW_USD = 0.00036`, `MY_BUSINESS_INFO_LIVE_USD = 0.0054`, `QUESTIONS_ANSWERS_PER_20_USD = 0.0054`, `REVIEWS_PRIORITY_TASK_USD = 0.001`, `REVIEWS_PRIORITY_PER_10_USD = 0.0015`, `EXTENDED_REVIEWS_PRIORITY_PER_20_USD = 0.01`, `UPDATES_PRIORITY_TASK_USD = 0.003`, `UPDATES_PRIORITY_PER_10_USD = 0.0015`, `LIGHTHOUSE_LIVE_USD = 0.005`, `LLM_MENTIONS_TASK_USD = 0.1`, `LLM_MENTIONS_ROW_USD = 0.001`, `LOCAL_SERP_PAGE_USD = 0.002`, `LOCAL_SERP_TASK_USD = 0.0012`, SERP live 0.002/0.0015 and queued 0.0006/0.00045 per first/extra page, operator multiplier 5). `export function llmResponseUsd(slug: "chat_gpt"\|"claude"\|"gemini"\|"perplexity", webSearch: boolean): number`. `export const dataforseoPricing = { business: {...}, backlinks: {...}, keywords: {...}, domain: {...}, serp: {...}, labs: {...}, lighthouse: {...}, aiSearch: {...} }`. The structure matches theirs, but each estimator takes a **local input type** (for example `{ limit: number; includeClickstreamData?: boolean }`) instead of being bound to a fetcher; F02 binds them. Input shapes other specs rely on (frozen; change only with the consuming spec): F13 `labs.*({ limit, includeClickstreamData })`, `keywords.*({ limit, includeClickstreamData })`, `keywords.adsIdeas|adsSearchVolume({ dateFrom?, dateTo? })` (flat 0.09), and `({})` for flat-priced calls; F17 `business.*({ limit } | { depth } | { includeOtherSources })`, `serp.localTaskPost({ locationCoordinates })`, `labs.keywordOverview({ keywords })`. `export function clampSerpDepth(d: number): number` (10–100, as theirs), `export const SERP_ANALYSIS_DEPTH = 20`, `export const BACKLINKS_DEFAULT_LIMIT = 100`, `export function resolveLlmMentionsLimit(l?: number): number` (default 100, max 1000). |
| `src/shared/ai-visibility-pricing.ts` (PORT of `ai-visibility.ts:8-40` and `aiVisibilityCost.ts:25-32`) | `export type AiEngine = "chatgpt"\|"gemini"\|"google_ai_overview"\|"claude"\|"perplexity"` — `claude` stays in **this union only** because the ported price table and `llmResponseUsd` know that slug; it is not a Perceev engine (owner decision, 25 Oct 2026) and no caller may use it. `export type PerceevEngine = Exclude<AiEngine, "claude">`; `AI_RECORD_COST_USD = 0.0012`; `AI_LIVE_RECORD_COST_USD = 0.004`; `aiEngineUsesModelApi(e)`; `aiAnswerUsd(e, mode: "live"\|"queued")`; `AI_ENGINE_LABELS: Record<PerceevEngine, string>` — **four entries, no `claude` label**. The four-row LLM response table lives in this file (shared code cannot import `src/server/`), and `src/shared/pricing/dataforseo.ts` re-exports its `llmResponseUsd`, so there is exactly one copy. |
| `src/shared/pricing/perceev.ts` | Adapters over `../llmPricing.js`: `serpQueryUsd(provider: "brightdata"\|"serpapi", queries = 1, env)` → `resolveSerpQueryCost`; `modelCallUsd(model, inTok, outTok, env)` → `lookupModelPrice` rates or `null`; `toolFeeUsd(model, tool, calls, env)` → `resolveToolFee({ model, tool, provider: "openrouter", calls, env }).cost` (per-call table × `calls`; throws `UnpricedModelError` rather than returning a silent 0). `export const PERCEEV_ENGINE_PROVIDERS = { aio: "brightdata", chatgpt: "openrouter", gemini: "openrouter", perplexity: "openrouter" } as const` (from `src/shared/engines/*` defaults; an unknown engine maps to `"unknown"`). (Claude is not an engine for now, owner decision 25 Oct 2026; `llmResponseUsd` keeps the ported `claude` row verbatim, unused.) `export function engineProvider(engine: string, route?: "native" | "dataforseo"): string` returns `"dataforseo"` when the attempt was routed through DataForSEO (F02 records `result.provenance.gateway = "dataforseo"`), otherwise `PERCEEV_ENGINE_PROVIDERS[engine] ?? "unknown"`; the sync and the ops "engine stats" use it instead of reading the constant directly. DataForSEO-routed attempts write `result.cost_source = "gateway"` with the task's reported `cost`, so the sync maps them to `provider_reported` like OpenRouter rows. `aioMaxQueriesPerAttempt = 2` (rendered attempt plus same-deadline standard fallback, `docs/audits/2026-10-16/HANDOFF-2026-10-20-demo-and-consolidation.md:29`). No new numbers are introduced. |
| `src/shared/pricing/index.ts` | Re-exports the above plus `export function costAccuracy(estimateUsd: number, actualUsd: number \| null): "unknown"\|"within"\|"undershoot"` (`actual > estimate` is an undershoot, exact micro-dollar comparison via `toMicros`). |

**Costs services** (`src/server/costs/`):

```ts
// src/server/costs/types.ts — shared response shapes (also used by UI through src/shared/costs.ts)
export type CostSource = "provider_reported" | "price_table" | "reservation" | "none";
export type AnswerCost = { observationId: string; engine: string; attempts: number;
  knownUsd: number; unknownAttempts: number; reservedUnknownUsd: number; usd: number | null };
export type ScanCost = { state: "final" | "running" | "unavailable"; jobId: string | null;
  answers: number; attempts: number; knownUsd: number; unknownAttempts: number; reservedUnknownUsd: number;
  totalAccountedUsd: number; perAnswerUsd: number | null;
  byEngine: { engine: string; label: string; answers: number; attempts: number; knownUsd: number;
              unknownAttempts: number; perAnswerUsd: number | null }[];
  heldUsd: number | null };

// src/server/costs/scanCost.ts
export async function getScanCost(admin: SupabaseClient, jobId: string | null, brandKey: string): Promise<ScanCost>;
export async function getAnswerCosts(admin: SupabaseClient, jobId: string, brandKey: string): Promise<Map<string, AnswerCost>>;
```

`getScanCost` reads committed attempt costs straight from `probe_attempts` joined to `probe_observations` for `job_id` (service role; brand checked against `scan_jobs.brand_key` first, else `AppError(404,"scan_not_found")`). The live report must not wait for the 5-minute sync. The live read applies the same two filters as the SQL: the **row scope** is `probe_observations.purpose = 'scan'` (a canary or an explore observation is not this scan's answer), and the **attempt scope** is `dispatch_state IN ('recorded','unknown','historical')`, plus `'intent'` only once the job is terminal. The per-engine label comes from `AI_ENGINE_LABELS` (`src/shared/ai-visibility-pricing.ts`), with the database slug `aio` mapped to the `google_ai_overview` key; an unknown slug is its own label. Mapping per attempt is the same as SQL `f03_upsert_attempt_rows`, in the same order: `cost_state = confirmed_not_dispatched` → 0 and not counted as an attempt; `cost_state = reconciliation_conflict` → unknown (reserved) **even when `charged_usd` is set**, because a disputed cost is not a known one; `charged_usd` known → known; otherwise unknown (reserved). AC-19 asserts this read and the synced ledger agree, so the two copies of the mapping cannot drift. `state = "final"` when the job is terminal, `"running"` otherwise, and `"unavailable"` when `jobId` is null (legacy scan) or the job has no observations. Per-answer `usd` = `knownUsd` when `unknownAttempts = 0`, else `null`. `perAnswerUsd` = `knownUsd / answers` only when there are no unknown attempts and `answers > 0`; otherwise `null`. `answers` = observations in state `answered` or `valid_no_aio`. `heldUsd` = the open scan hold's estimate (`spend_holds` subject), else `null`.

```ts
// src/server/costs/usage.ts
export const USAGE_RANGES = { "7d": 7, "30d": 30, "90d": 90 } as const;
export async function getWorkspaceUsage(admin: SupabaseClient, brandKey: string,
  opts: { range: keyof typeof USAGE_RANGES; timeZone: string; now?: Date; env?: Record<string, string|undefined> }): Promise<WorkspaceUsage>;
export type WorkspaceUsage = { range: "7d"|"30d"|"90d"; timeZone: string; from: string; to: string;
  totals: { accountedUsd: number; knownUsd: number; unknownUsd: number; calls: number };
  days: { date: string; usd: number; knownUsd: number; unknownUsd: number }[]; // every day in range, oldest first
  // usd = knownUsd + unknownUsd (the accounted total). knownUsd is the series the chart stacks
  // under unknownUsd; stacking `usd` itself would draw every unknown dollar twice.
  features: { feature: string; label: string; usd: number; unknownUsd: number; calls: number }[]; // usd desc, usd > 0 only
  recent: { occurredAt: string; feature: string; label: string; provider: string; endpoint: string;
            usd: number; costSource: CostSource; notBilled: boolean }[];  // newest 50
  // 'none' rows carrying meta.reconciled are KEPT: a call the customer saw yesterday must not
  // vanish because the operator resolved it as not_billed. Such a row shows $0.00 and a
  // "Not billed" badge. A 'none' row that was never a paid call stays excluded.
  position: { todayUsd: number; monthUsd: number; dailyCapUsd: number | null; monthlyCapUsd: number | null;
              openHoldsUsd: number; openHolds: number; dayStartsAt: string; monthStartsAt: string };
  generatedAt: string };
```

`from` is the start of the viewer's local day `range − 1` days ago, and `to` is now. `days` are filled for every local date (missing = `{usd: 0, knownUsd: 0, unknownUsd: 0}`, a measured zero because every paid call writes a row; the page explains that scan answers appear when the scan finishes). Defaults for caps come from F01's `SPEND_DEFAULT_*` env through `workspace_spend_position`. Feature labels come from `src/shared/spend-features.ts`.

```ts
// src/shared/spend-features.ts (PATTERN of billing-credit-features.ts:12-79)
export const SPEND_FEATURE_LABELS: Record<string, string> = {
  "ai_visibility.scan": "AI visibility scans",
  "platform.selftest": "Platform check",
};
export function spendFeatureLabel(feature: string): string; // unknown → "Other"
```

Each later spec adds its label line in the same PR that adds its `SpendFeature`. The `SpendFeature` **union** entry for `ai_visibility.scan` is a cross-spec request: F01 asserts the union closed, so F03 ships only the label map, and the union member (with the matching F01 assertion) lands with the first spec that spends through the feature.

```ts
// src/server/costs/ops.ts
export async function getOperatorCosts(admin, opts: { from: Date; to: Date }): Promise<OperatorCosts>;
// { byWorkspace: rows of operator_costs_by_workspace, byEndpoint: rows of operator_costs_by_endpoint,
//   openHolds: [{ holdId, brandKey, feature, estimateUsd, createdAt, expiresAt, subjectKind, subjectId }] (≤ 200, oldest first),
//   reconciliations: [{ id, brandKey, feature, provider, endpoint, kind, estimateUsd, actualUsd, priceVersion, createdAt, isProbe }] (open, ≤ 200),
//   engineStats: rows of engine_cost_stats(30), priceVersion: PRICE_TABLE_VERSION }
export async function resolveReconciliation(admin, id: string, resolution: "accepted"|"price_updated"|"not_billed", note: string): Promise<void>;
export async function resolveUnknownCostBacklog(admin, opts: { beforeDays: number; note: string; by: string; limit?: number }): Promise<number>;
// → resolve_unknown_cost_backlog; same note rule, so 'note…' → AppError(400,"note_required")
// maps SQL exceptions: 'probe attempts are reconciled…' → AppError(409,"use_probe_reconciliation"); 'only unknown…' → AppError(409,"not_unknown_cost"); note rule → AppError(400,"note_required")
```

An `unknown_cost` row is opened for **every** reservation row, so the queue drains in batches: `resolveUnknownCostBacklog` calls `resolve_unknown_cost_backlog` and returns how many rows it resolved. The operator view lists at most 200 open rows and the bulk dialog works from a cutoff, not from the visible selection.

```ts
// src/server/costs/jobs.ts — called from registerCostJobs(), which src/server/jobs/kinds.ts invokes.
// The periodicDefined() guard and the { store: activeStore() } argument are F01's registration
// pattern (src/server/jobs/maintenance.ts:115-133); bare module-scope definePeriodic calls
// re-register under test.
export function registerCostJobs(): void {
  if (!periodicDefined("costs.sync")) {
    definePeriodic({ name: "costs.sync", everySeconds: 300,
      run: async (now) => {
        await enqueueSystemJob("costs.sync", {}, { dedupeKey: `costs.sync:${slot5m(now)}` },
                               { store: activeStore() });
      } });
  }
  if (!getJobDefinition("costs.sync")) {
    defineJob("costs.sync", async (ctx) => {
      const settled = await ctx.step.do("settle-scan-holds", STEP.DB_STEP, () => rpc("settle_finished_scan_holds", { p_limit: 50 }));
      const synced = await ctx.step.do("sync-attempts", STEP.DB_STEP, () => rpc("sync_probe_attempt_costs", { p_limit: 1000 }));
      return { result: { settled, synced } };
    }, { deadlineSeconds: 900 });
  }
}
```

**Retention has no job kind of its own.** `prune_cost_reconciliations` is added as one more prune target
inside F01's existing daily `spend.retention` job (`src/server/jobs/maintenance.ts:91-113`), beside the
`prune_spend` call, rather than as a second daily periodic that does one RPC. One retention clock for
the whole spend lane, one place to change it.

### 6.3 Jobs

| Kind | Trigger | Steps | Retries / billed | Completion |
|---|---|---|---|---|
| `costs.sync` | periodic every 300 s (system) | `settle-scan-holds` → `sync-attempts` | DB_STEP (3 retries), not billed | `completed` with `{settled, synced}`; any step exhausting retries → `failed`; the next slot runs anyway |

Ledger retention (13 months) is F01's `spend.retention`, and that same daily job gains a `prune_cost_reconciliations` step. Resolved reconciliations keep 13 months.

### 6.4 Provider calls and cost

F03 makes no provider calls. It defines prices others use:

| Provider | Unit | Source of number | Used by |
|---|---|---|---|
| DataForSEO (all endpoints) | per task/row/page/depth/token cap | `src/shared/pricing/dataforseo.ts` (ported constants) | F02 client `meter`, F09 estimates for F13/F14/F15/F16/F17/F18 |
| DataForSEO AI answers | per answer, queued/live | `src/shared/ai-visibility-pricing.ts` | F02 bake-off, F09 |
| Bright Data SERP | per query | `llmPricing.js` `SERP_QUERY_PRICES` (0.0015; env-overridable) | expected AIO cost, operator view |
| SerpAPI | per query | `llmPricing.js` (0.01) | same |
| OpenRouter models | provider-reported `usage.cost`; per-Mtok table only for ids in `llmPricing.js` | gateway / `LLM_MODEL_PRICES` | F01 LLM helper, answer engines |
| Answer attempts (P0) | per attempt reservation | `SCAN_PROBE_RESERVATION_USD` via `dispatchBudget()` (F09 reads it) | scan holds and quotes |

Fixtures for tests: `tests/fixtures/f03/probe-attempts.json` (14 synthetic attempts across 4 engines: 7 measured with `cost_source = gateway`, 1 `serp_price_table`, 2 `unknown_billed`, 1 `confirmed_not_dispatched`, 1 `historical`, 1 `reconciliation_conflict` with a `charged_usd` set, and 1 on an `explore`-purpose observation that must never be synced), and `tests/fixtures/f03/ledger-rows.json` (30 days of rows across 3 features, two timezones' day boundaries). All values are synthetic. No provider payloads are recorded.

### 6.5 API routes

**`GET /api/customer/usage?brand_key=&range=30d&tz=Asia%2FKolkata`** (auth: workspace, members and owners; flag `FEATURE_USAGE_PAGE`)

```ts
const query = z.strictObject({
  brand_key: z.string().min(1).max(200).optional(),
  range: z.enum(["7d","30d","90d"]).default("30d"),
  // Module-level Set: building the ~450-entry array inside the refine runs on every request.
  // The canonical list is the fast path, not the whole answer: any time zone
  // `Intl.DateTimeFormat` can format is accepted — canonical ids and legacy aliases such as
  // `Asia/Kolkata` alike — while offset-shaped values (`+05:30`) are refused.
  // const TIME_ZONES = new Set([...Intl.supportedValuesOf("timeZone"), "UTC"]);
  tz: z.string().min(1).max(64).refine(isKnownTimeZone, "Unknown time zone").default("UTC"),
});
const response = z.looseObject({
  range: z.enum(["7d","30d","90d"]), timeZone: z.string(), from: z.iso.datetime(), to: z.iso.datetime(),
  totals: z.looseObject({ accountedUsd: z.number().min(0), knownUsd: z.number().min(0), unknownUsd: z.number().min(0), calls: z.int().min(0) }),
  days: z.array(z.looseObject({ date: z.iso.date(), usd: z.number().min(0), knownUsd: z.number().min(0),
    unknownUsd: z.number().min(0) })),
  features: z.array(z.looseObject({ feature: z.string(), label: z.string(), usd: z.number().min(0), unknownUsd: z.number().min(0), calls: z.int().min(0) })),
  recent: z.array(z.looseObject({ occurredAt: z.iso.datetime(), feature: z.string(), label: z.string(), provider: z.string(),
    endpoint: z.string(), usd: z.number().min(0), notBilled: z.boolean(),
    costSource: z.enum(["provider_reported","price_table","reservation","none"]) })),
  position: z.looseObject({ todayUsd: z.number().min(0), monthUsd: z.number().min(0), dailyCapUsd: z.number().min(0).nullable(),
    monthlyCapUsd: z.number().min(0).nullable(), openHoldsUsd: z.number().min(0), openHolds: z.int().min(0),
    dayStartsAt: z.iso.datetime(), monthStartsAt: z.iso.datetime() }),
  generatedAt: z.iso.datetime(),
});
```

200 example (truncated arrays):

```json
{ "range": "30d", "timeZone": "Asia/Kolkata", "from": "2026-09-21T18:30:00.000Z", "to": "2026-10-21T09:12:00.000Z",
  "totals": { "accountedUsd": 7.412, "knownUsd": 7.012, "unknownUsd": 0.4, "calls": 122 },
  "days": [ { "date": "2026-09-22", "usd": 0, "knownUsd": 0, "unknownUsd": 0 },
             { "date": "2026-10-20", "usd": 7.412, "knownUsd": 7.012, "unknownUsd": 0.4 } ],
  "features": [ { "feature": "ai_visibility.scan", "label": "AI visibility scans", "usd": 7.412, "unknownUsd": 0.4, "calls": 122 } ],
  "recent": [ { "occurredAt": "2026-10-20T11:02:31.000Z", "feature": "ai_visibility.scan", "label": "AI visibility scans",
                "provider": "openrouter", "endpoint": "probe:chatgpt", "usd": 0.0612, "costSource": "provider_reported" } ],
  "position": { "todayUsd": 0, "monthUsd": 7.412, "dailyCapUsd": null, "monthlyCapUsd": 50, "openHoldsUsd": 0, "openHolds": 0,
                "dayStartsAt": "2026-10-21T00:00:00.000Z", "monthStartsAt": "2026-10-01T00:00:00.000Z" },
  "generatedAt": "2026-10-21T09:12:00.000Z" }
```

Errors: 400 `invalid_request` "Check the query and try again." (bad range or time zone); 401/403/404/503 from `requireWorkspace`; 404 `feature_unavailable` "Usage is not available for this workspace yet." when the flag is off; 503 `usage_unavailable` "Usage could not be loaded. Please retry." on a database error. `Cache-Control: no-store`. GET only, so it is idempotent. Contract in `src/server/costs/usage.contract.ts`.

**`GET /api/customer/scan/report/[scan_id]`** (existing route; additive change)

The response keeps every existing field. `scan.cost: ScanCost` is added, and each `results[i]` gains `cost: { usd: number | null; attempts: number; unknownAttempts: number } | null`, joined by `results[i].raw.observation_id`; `null` when absent. The scan's job id is `scans.origin_job_id`. The route is migrated to `requireWorkspace` + `toErrorResponse` with the same status codes and messages it returns today, except that a database error answers 500 "Could not load the scan report." (the pre-F03 route answered 404 for that failure): 400 "scan_id is required.", 404 "Scan not found.", and keeps `Cache-Control: no-store` (conventions §9). Response contract `src/server/costs/scanReport.contract.ts` (`z.looseObject`, so the existing fields stay permitted). Example `scan.cost`:

```json
{ "state": "final", "jobId": "0c2a…", "answers": 116, "attempts": 124, "knownUsd": 6.912, "unknownAttempts": 2,
  "reservedUnknownUsd": 0.4, "totalAccountedUsd": 7.312, "perAnswerUsd": null,
  "byEngine": [ { "engine": "chatgpt", "label": "ChatGPT", "answers": 32, "attempts": 33, "knownUsd": 2.21,
                  "unknownAttempts": 0, "perAnswerUsd": 0.0691 } ],
  "heldUsd": null }
```

**Operator routes** (auth: operator token through the existing `/api` perimeter; these paths are neither public nor self-gated — the refusal is the perimeter's, and it is verified by `src/server/operatorPerimeter.test.mjs` and the phase-4 browser check, not by a route-level test):

- `GET /api/ops/costs?from=<iso>&to=<iso>`: defaults to the last 30 days; `to − from` at most 400 days → otherwise 400 `invalid_range` "Choose a range of 400 days or less.". Response `OperatorCosts` (§6.2). Contract `src/server/costs/ops.contract.ts`.
- `POST /api/ops/costs/reconciliations/[id]` body `z.strictObject({ resolution: z.enum(["accepted","price_updated","not_billed"]), note: z.string().min(10).max(500) })` → 200 `{ "resolved": true }`; 404 `reconciliation_not_found`; 409 `use_probe_reconciliation` with recovery "Reconcile this attempt from Measurement operations with reconcile_probe_dispatch."; 409 `not_unknown_cost`; 400 `note_required` "Add a note of at least 10 characters.".
- `POST /api/ops/costs/reconciliations/bulk` body `z.strictObject({ kind: z.literal("unknown_cost"), beforeDays: z.int().min(1).max(400), note: z.string().min(10).max(500), limit: z.int().min(1).max(5000).default(1000) })` → 200 `{ "resolved": <count> }`; 400 `note_required` "Add a note of at least 10 characters."; 400 `invalid_request` "Check the highlighted fields and try again.". Resolves as `accepted` only; it cannot change an amount.
- The view also calls F01's `GET/PUT /api/ops/spend/controls…` and `/api/ops/spend/limits…`.

### 6.6 UI

All new UI is built from F04 primitives: `src/components/ui/{card,button,badge,skeleton,progress,table,tooltip,select,alert,chart}.tsx` and `src/components/app/{PageHeader,QueryState,EmptyState}.tsx`. Data comes through F05's `QueryClient`, with query keys added to `src/shared/query/keys.ts`: `usage: (brandKey, range, tz) => ["usage", brandKey, range, tz]` and `scanReport` (existing fetch kept). Money is formatted by `src/shared/money.ts` `formatUsd(v)`: `Intl.NumberFormat("en-US",{style:"currency",currency:"USD",minimumFractionDigits:2,maximumFractionDigits: v>0&&v<1?4:2})`, OpenSEO's `aiMoney`.

#### 6.6.1 Usage page `/portal/usage`

- **Navigation:** sidebar group **Settings**, item **Usage**, path `/portal/usage`, icon `lucide-react` `Gauge`. Registered in `src/components/app/navigation/items.ts` (this needs the §12 registry addition in §11). Hidden when `FEATURE_USAGE_PAGE` is off for the workspace. The page then renders `EmptyState` "Usage is not available for this workspace yet."
- **Files:** `src/app/portal/usage/page.tsx`, `src/components/portal/usage/UsagePage.tsx`, `UsageLimits.tsx`, `UsageChart.tsx` (PORT of `BillingUsageChart.tsx`), `UsageByFeature.tsx` (PORT of `BillingFeatureBreakdown.tsx`), `UsageRecent.tsx`, `UsageSection.tsx` (PORT of `BillingUsageSection.tsx`), `hooks/useUsage.ts`.
- **Layout (desktop):** `PageHeader title="Usage" description="What this workspace has spent on paid data and AI calls, and how that compares with its limits."`, right-aligned `Select` for range ("Last 7 days", "Last 30 days", "Last 90 days"; URL `?range=7d|30d|90d`, default `30d`, invalid → `30d`). Below it, a grid `md:grid-cols-2` with two limit cards, then one `Card` with `UsageSection title="Spend"` (chart) and `UsageSection title="Spend by feature"`, then `Card title="Recent activity"`.
- **Limit card ("Today" / "This month"):** large value `formatUsd(todayUsd)`, then "of {formatUsd(cap)} daily limit" and a `Progress` at `cap > 0 ? min(100, used/cap·100) : 100` — `cap = 0` is a valid "spend nothing" setting (`041_f01_spend.sql:25` allows `>= 0`) and must read as 100 %, not `NaN` — or "No daily limit set" with no bar when the cap is **null** (no row, or the column unset). The month card is the same with "monthly limit". Under both, when `openHolds > 0`: "{formatUsd(openHoldsUsd)} is reserved for work in progress and is included above." At ≥ 80 % the bar uses the warning tone and adds "You have used {pct}% of this limit." At ≥ 100 %: destructive tone and "Limit reached. Paid actions are paused until {resetText}." `resetText` is the **next reset instant formatted in the viewer's own zone** (daily: `position.dayStartsAt + 1 day`; monthly: `position.monthStartsAt + 1 month`), for example "22 Oct, 05:30". A bare "tomorrow" is wrong for any viewer east of UTC late in their local day, because the reset is 00:00 UTC. Footnote under the grid: "Limits reset at 00:00 UTC."
- **Spend section:** header right text "{Last 7|30|90 days}" (OpenSEO's "Last 30 days" pattern). Total `formatUsd(totals.accountedUsd)` in `text-2xl font-semibold tabular-nums`. Recharts `BarChart` of `days`, stacking **`knownUsd` then `unknownUsd`** (the latter hatched) so each bar totals `usd` — never stack `usd` itself, which already contains `unknownUsd`. Legend "Priced or reported" / "Estimated (cost not reported)", matching the Recent-activity badges, which split the known half into "Reported" and "Priced". The x-axis shows short dates in the viewer's locale; the tooltip says "{date}: {formatUsd(usd)} ({formatUsd(unknownUsd)} estimated)". Empty (total 0): centred "No usage recorded yet".
- **By feature:** rows `label` · `formatUsd(usd)` with a proportional bar; when `unknownUsd > 0` a `Badge variant="outline"` reads "includes {formatUsd(unknownUsd)} estimated" (tooltip: "Some providers did not report a cost. Those calls are counted at the amount reserved before they ran."). Empty: "No usage recorded yet".
- **Recent activity:** `Table` with columns When (relative time, absolute in tooltip), Feature, Provider, Cost (`formatUsd`), Source (`Badge`: "Reported" for `provider_reported`, "Priced" for `price_table`, "Estimated" for `reservation`, "Not billed" for a `none` row carrying `meta.reconciled`). Empty: "No paid calls yet." Footnote: "Scan answers are added here when each scan finishes."
- **States:**
  - Loading: two `Skeleton h-28` cards, `Skeleton h-40` chart, four `Skeleton h-4` rows, five table skeleton rows.
  - Error: `QueryState` error with "Usage could not be loaded." and a "Retry" button.
  - Partial (`totals.unknownUsd > 0`): an `Alert` above the chart: title "Some costs are estimates", body "{n} calls did not report a cost, so they are counted at the amount reserved before they ran. Reported costs replace them when available."
  - Populated: as described.
- **Polling:** none. `staleTime` 60 s, as OpenSEO. Refetch on window focus.
- **Accessibility:** the chart has an `aria-label` "Daily spend, {range}" and a visually hidden table of the same `days`. Progress bars have `aria-valuenow`/`aria-valuemax`. Badges have text, not colour only.
- **Phone layout:** the limit cards stack; the chart is full width at 160 px high; the recent-activity table becomes a list of rows (Feature + Cost on line 1, When · Source on line 2).

#### 6.6.2 Scan report cost card

- **File:** `src/components/portal/cost/ScanCostCard.tsx`, rendered in `src/app/portal/scans/[scanId]/page.jsx` **after** the engines/competitors block and before Questions (one import and one JSX line; existing cards untouched).
- **States:**
  - `cost` missing (old API) or `state = "unavailable"`: card body "Cost details are not available for this scan." No numbers.
  - `state = "running"`: title "Cost so far", body as below plus "This scan is still running. {formatUsd(heldUsd)} is reserved for it."
  - `state = "final"`: title "Cost". Headline `formatUsd(totalAccountedUsd)`; sub-line "{answers} answers · about {formatUsd(perAnswerUsd)} per answer" when `perAnswerUsd` is non-null, else "{answers} answers · per-answer cost not available while some costs are unknown".
  - Unknown attempts > 0: `Alert` variant warning, "{unknownAttempts} {attempt|attempts} did not report a cost. Each is counted at its {formatUsd(reservedUnknownUsd / unknownAttempts)} reservation, so the total may be lower."
  - Per-engine `Table`: Engine · Answers · Attempts · Cost · Per answer (an em dash "—" when null, tooltip "Not available while a cost is unknown").
  - A collapsible "Cost per answer" section (button "Show cost per answer" / "Hide cost per answer") lists Question · Engine · Attempts · Cost from `results[].cost`, 25 per page with "Show more". A `null` cost shows "Unknown", never $0.
- No polling of its own: the page already loads once and re-renders on retry.

#### 6.6.3 Operator view `/ops/costs`

- **Files:** `src/app/ops/costs/page.tsx`, `src/components/ops/costs/*.tsx`. Same access model as `/ops/measurement`: the page renders anywhere, but its data routes require the operator token cookie. A 401 shows "Operator sign-in required. Set the operator token and reload."
- **Sections (top to bottom):**
  1. Date range (from/to date inputs, default last 30 days).
  2. "Spend by workspace" table.
  3. "Estimate accuracy" table by provider × endpoint (calls, estimated, actual, unknown, undershoots, worst ratio; rows with undershoots > 0 highlighted with Badge "Price may be stale").
  4. "Typical answer cost" (engine, samples, median, p90; "Not enough samples (needs 20)" when absent).
  5. "Open holds" (oldest first; holds older than their `expiresAt` flagged "Expiring").
  6. "Reconciliation queue" with a Resolve dialog: radio Accepted / Price updated / Not billed, note textarea (min 10 chars), submit "Resolve". For probe rows "Not billed" is disabled with the hint "Use Measurement operations for answer attempts". Above the table, when open `unknown_cost` rows exist, a secondary button "Accept unknown costs older than…" opens a dialog with a day count (default 7, 1–400), the same note textarea and the count it will resolve; it posts to the bulk route and can only mark rows `accepted`. The queue header reads "{n} open · {m} unknown cost" so the backlog is visible without paging.
  7. "Paid features": the F01 controls table; each row has an "Edit" dialog with Enabled switch, Mode (All workspaces / Allowlist), Allowlist (comma-separated brand keys), Daily cap, Max per call, Note, and a confirmation field "Type {feature} to confirm".
  8. "Workspace limits": search by brand key, then daily and monthly cap inputs ("Leave empty for no limit") and Save.
- **Copy for success toasts (sonner):** "Saved", "Resolved". Errors show the API's `error` string.

### 6.7 Permissions, privacy, observability

- **Customers** (owner and member) see their own workspace's usage and scan costs. They never see estimate accuracy, other workspaces, engine statistics or reconciliation.
- **Operator** sees everything through operator-token routes. Paid-control changes are owner-instructed only (conventions §11).
- **Logs:** `[costs.sync] settled=N synced=N` per run; `[ops] reconciliation resolved {id, resolution}`. No payloads, answer text, prompts or URLs.
- **PostHog (F26 names, emitted only once F26 exists):** `usage:page_viewed {range}`, `usage:range_changed {from,to}`, `scan_report:cost_expanded`.

## 7. Code reuse map

| OpenSEO source | Perceev target | Mode | Adaptation notes |
|---|---|---|---|
| `openseo:src/server/lib/dataforseo/pricing.ts:63-326` | `src/shared/pricing/dataforseo.ts` | PORT | Constants and formulas verbatim. Estimators take local input types instead of `priced(fetcher, …)`. F02 binds them to fetchers. No credits or markup. |
| `openseo:src/shared/rank-tracking.ts:16-25, 69-91, 186-195` | `src/shared/pricing/dataforseo.ts` (`costPerSerpAtDepth`, `serpKeywordCostMultiplier`), `src/shared/ai-visibility-pricing.ts` (`scheduledChecksPerMonth`) | PORT | Same numbers; `scheduledChecksPerMonth` daily 30 / weekly 4 / monthly 1, used by F09. |
| `openseo:src/server/lib/dataforseo/pricing.test.ts:8-80` | `src/shared/pricing/dataforseo.test.ts` | PORT | Same cases, asserting raw USD only (credit assertions dropped). |
| `openseo:src/shared/ai-visibility.ts:8-40` | `src/shared/ai-visibility-pricing.ts` | PORT | Engine union, labels, the two answer prices. |
| `openseo:src/server/features/ai-visibility/services/aiVisibilityCost.ts:25-58` | `src/shared/ai-visibility-pricing.ts` (`aiAnswerUsd`, `aiCostForAnswers`) | PORT | Hosted/credits branch removed; returns `{ providerCostUsd }` only. |
| `openseo:src/server/features/ai-visibility/services/aiVisibilityCost.test.ts:10-41` | `src/shared/ai-visibility-pricing.test.ts` | PORT | Non-credit cases verbatim (12 queued ChatGPT = 0.0144; 3 live = 0.012; Claude + Perplexity = 0.22). |
| `openseo:src/server/billing/subscription.ts:477-543` | SQL trigger `f03_ledger_reconcile` + `cost_reconciliations` | PORT | Their log line becomes a durable, resolvable row. F01 keeps the log line too. |
| `openseo:src/server/billing/usage.ts:10-85` | `src/server/costs/usage.ts` + SQL `workspace_usage_days` | PORT | Autumn aggregate → Postgres group by local day and feature; "Other" fallback and positive-only feature rows kept; adds the unknown split and caps. |
| `openseo:src/shared/billing-credit-features.ts:1-79` | `src/shared/spend-features.ts` | PATTERN | Label map with "Other" fallback; keys are our `SpendFeature`s. No path mapping (each call names its feature). |
| `openseo:src/client/features/billing/useBillingUsage.ts:4-17` | `src/components/portal/usage/hooks/useUsage.ts` | PORT | Key includes brand, range and timezone; `staleTime` 60 s. |
| `openseo:src/client/features/billing/BillingUsageChart.tsx:19-101` | `src/components/portal/usage/UsageChart.tsx` | PORT | Same structure, total and empty copy; colour from F04 tokens (not `#7c3aed`); stacked unknown series added. |
| `openseo:src/client/features/billing/BillingFeatureBreakdown.tsx:7-58` | `src/components/portal/usage/UsageByFeature.tsx` | PORT | Same rows and bars; adds the estimated badge. |
| `openseo:src/client/features/billing/BillingUsageSection.tsx:5-21` | `src/components/portal/usage/UsageSection.tsx` | COPY | The right-hand text is a prop (range label). |
| `openseo:src/client/features/billing/BillingTabs.tsx:13-54` | `src/components/portal/usage/UsagePage.tsx` | PATTERN | One card, no tabs (no invoices). |
| `openseo:src/routes/_app/billing.tsx:142-330` | `src/app/portal/usage/page.tsx` | PATTERN | PageHeader + summary cards + usage card; plan, top-up and Stripe parts dropped; balance card replaced by limit cards. |
| `openseo:src/client/features/ai-visibility/shared.tsx:208-215` (`aiMoney`) | `src/shared/money.ts` (`formatUsd`) | COPY | Same formatting rule. |

## 8. Implementation plan

### Phase 1 — Price tables

**Goal:** one tested home for every provider price, with OpenSEO parity.

- [x] **P1.T1 Ported tables**
  - [x] **P1.T1.S1** *Files:* `src/shared/pricing/version.ts`, `src/shared/pricing/dataforseo.ts` (licence header), `src/shared/ai-visibility-pricing.ts` (licence header), `src/shared/money.ts` (licence header). *Do:* §6.2 tables, constants copied from the cited lines. `AI_ENGINE_LABELS` has four entries and no `claude` label; `claude` stays only in the `AiEngine` union for price-table parity. *Verify:* `node --test src/shared/pricing/dataforseo.test.ts src/shared/ai-visibility-pricing.test.ts` → pass.
  - [x] **P1.T1.S2** *Files:* `src/shared/pricing/dataforseo.test.ts`. *Do:* port the six `it.each` cases of `pricing.test.ts:8-64` (raw USD with `assert.ok(Math.abs(a-b) < 1e-10)`) and the reviews "holds at least the billed cost" cases; add SERP page rounding (`depth 25` bills 3 pages) and the operator multiplier. *Verify:* pass (F03-AC-01).
  - [x] **P1.T1.S3** *Files:* `src/shared/ai-visibility-pricing.test.ts`. *Do:* port `aiVisibilityCost.test.ts:10-41` non-credit cases; per-engine `aiAnswerUsd`; `scheduledChecksPerMonth`. *Verify:* pass (F03-AC-02).
- [x] **P1.T2 Perceev adapters**
  - [x] **P1.T2.S1** *Files:* `src/shared/pricing/perceev.ts`, `src/shared/pricing/index.ts`, `src/shared/pricing/perceev.test.ts`. *Do:* §6.2; tests: `serpQueryUsd("brightdata")` equals `BUILT_IN_SERP_QUERY_PRICES.brightdata`; with env `SERP_QUERY_PRICES={"brightdata":0.002}` → 0.002; unknown model → `null`; unknown tool → throws `UnpricedModelError` (via `resolveToolFee`); `costAccuracy` table. *Verify:* `node --test src/shared/pricing/perceev.test.ts` → pass (F03-AC-03).
  - [x] **P1.T2.S2** *Files:* `THIRD_PARTY_NOTICES.md`. *Do:* append the five ported paths (the guard test requires every headed file, including the two ported tests). *Verify:* `node --test src/server/platform/thirdPartyNotices.test.mjs` → pass.

**Checkpoint:** `npm test`, `npm run typecheck` pass. ACs 01–03.

### Phase 2 — Ledger sync, scan holds, reconciliation

**Goal:** answer costs land in the ledger exactly once, scan holds settle, undershoots are recorded.

- [x] **P2.T1 Migration 050**
  - [x] **P2.T1.S1** *Files:* `supabase/migrations/050_f03_cost_ledger.sql`, `scripts/setup-supabase.mjs`, `tests/customer-uat.sql`. *Do:* §6.1. In `tests/customer-uat.sql` add a **negative** tenant block for `cost_reconciliations` (insert one row per workspace as `postgres`, then assert each customer user's read is refused with `insufficient_privilege`), the way F01 added `spend_ledger` (`F01:1420`) and F09 adds `price_approvals` (`F09:135`). The table is operator-only by design, so the convention's read policy is deliberately absent — see Deviations (c). *Verify:* bootstrap + all migrations applied twice on loopback `perceev_qa` → exit 0; the CI `customer-database` step passes locally.
  - [x] **P2.T1.S2** *Files:* `scripts/qa/check-f03-db.mjs` (loopback guard as `check-repair-workflows.mjs:13-18`). *Do:* groups `seed` (scan control enabled/all), `sync` (load `tests/fixtures/f03/probe-attempts.json` into `scan_jobs`/`probe_observations`/`probe_attempts` for a QA brand plus one canary and one brandless job; run `sync_probe_attempt_costs` twice; assert row count, each `cost_source`, idempotency, update after flipping one attempt to `confirmed_not_dispatched`, a `reconciliation_conflict` attempt landing as `reservation` even though `charged_usd` is set, **no** row for the explore-purpose fixture, and AC-19's equality between `getScanCost` and the synced ledger), `scan-hold` (create hold via `reserve_spend(..., p_subject_kind => 'scan_job')`, job running → `scan_running` and zero attempt rows; set job `complete` → settled with sum; `f01_committed_usd` before/after equal to estimate/sum; expired-hold path removes the `hold:` row; **expire the hold while the job is still running and assert `sync_probe_attempt_costs` writes no attempt row** — the `hold:` reservation row and attempt rows must never coexist; **expired hold whose `scan_jobs` row was deleted settles at 0 and is not re-selected on the next `settle_finished_scan_holds` run**; a malformed `subject_id` does not break the sweep; a job with two open holds settles one per run and strands neither), `reconcile` (undershoot row, unknown row, auto-resolve, `not_billed` refused for probe rows and applied for a `hold:` row, `resolve_unknown_cost_backlog` accepting only open `unknown_cost` rows older than the cutoff and refusing a short note), `stats` (19 measured → no row; 20 → row), `rls` (customer sees own `spend_ledger` rows only). *Verify:* `node scripts/qa/check-f03-db.mjs` → `PASS` per group (F03-AC-04..09, 13, 17, 18, 19).
  - [x] **P2.T1.S3** *Files:* `.github/workflows/ci.yml`. *Do:* add `node scripts/qa/check-f03-db.mjs` after F01's harness in `customer-database`. *Verify:* CI green.
  - [x] **P2.T1.S4** Migration paperwork. *Files:* `README.md` (migration table), `docs/OPERATOR_LEDGER.md` § C, `docs/PROD_MIGRATIONS.md`. *Do:* row for `050_f03_cost_ledger.sql`. *Verify:* `npm test` → migration-ledger guard tests pass.
- [x] **P2.T2 Jobs**
  - [x] **P2.T2.S1** *Files:* `src/server/costs/jobs.ts`, `src/server/jobs/kinds.ts` (call `registerCostJobs()`), `src/server/jobs/maintenance.ts` (add the `prune_cost_reconciliations` step to the existing `spend.retention` job), `src/server/costs/jobs.test.ts`. *Do:* §6.2/§6.3; test with F01 `memoryStore` that `costs.sync` calls the two RPCs with limits 50 and 1000 in that order, that the periodic dedupe key is stable within a 5-minute slot, and that calling `registerCostJobs()` twice registers one periodic and one job kind. *Verify:* `node --import ./src/server/liveWriteGuardAuto.mjs --test src/server/costs/jobs.test.ts` → pass (F03-AC-16).

**Checkpoint:** tests, typecheck, build, `check-f01-db.mjs`, `check-f03-db.mjs`, `check-probe-dispatch.mjs` pass. ACs 04–09, 13, 16–19 (AC-19 DB half).

### Phase 3 — Read APIs

**Goal:** customers and the operator can read costs through tested routes.

- [x] **P3.T1 Migration 051 and services**
  - [x] **P3.T1.S1** *Files:* `supabase/migrations/051_f03_usage.sql`, `scripts/setup-supabase.mjs`, `scripts/qa/check-f03-db.mjs`, `tests/fixtures/f03/ledger-rows.json`. *Do:* §6.1. *Verify:* migrations apply twice → exit 0; `check-f03-db.mjs` group `usage` (day bins across a UTC/Asia-Kolkata boundary from `tests/fixtures/f03/ledger-rows.json`) → PASS.
  - [x] **P3.T1.S1a** Migration paperwork. *Files:* `README.md` (migration table), `docs/OPERATOR_LEDGER.md` § C, `docs/PROD_MIGRATIONS.md`, `scripts/setup-supabase.mjs` (`EXPECTED_OBJECTS`). *Do:* row for `051_f03_usage.sql`. *Verify:* `npm test` → migration-ledger guard tests pass.
  - [x] **P3.T1.S2** *Files:* `src/server/costs/types.ts`, `src/shared/costs.ts` (re-exports response types for UI), `src/shared/spend-features.ts`, `src/server/costs/scanCost.ts`, `src/server/costs/usage.ts`, `src/server/costs/ops.ts`. *Do:* §6.2. *Verify:* `node --import ./src/server/liveWriteGuardAuto.mjs --test "src/server/costs/*.test.ts" "src/server/costs/*.test.mjs"` → pass.
  - [x] **P3.T1.S3** *Files:* `src/server/costs/usage.test.ts`, `src/server/costs/scanCost.test.ts`. *Do:* fake admin returning fixture rows; assert gap-filled days, `usd = knownUsd + unknownUsd` on every day, feature ordering and "Other", the recent list keeping `not_billed` rows and excluding never-paid `none` rows; scan cost per-engine maths, `perAnswerUsd` null when unknown attempts exist, `confirmed_not_dispatched` excluded, `reconciliation_conflict` counted as unknown, `unavailable` for a null job. *Verify:* `node --import ./src/server/liveWriteGuardAuto.mjs --test src/server/costs/usage.test.ts src/server/costs/scanCost.test.ts` → pass (F03-AC-12 unit half).
- [x] **P3.T2 Routes**
  - [x] **P3.T2.S1** *Files:* `src/app/api/customer/usage/route.ts`, `src/server/costs/usage.contract.ts`, `src/server/features/names.ts` (add `usage_page: { spend: [] as const }`, matching `names.ts:2`). *Do:* §6.5. **Not here:** `src/server/features/clientFeatures.ts` already exists (F26 seeded `product_analytics`); F03 must not touch it, and F04 phase 4 owns `GET /api/customer/features` and the `CLIENT_FEATURES` entry — so appending `"usage_page"` to `CLIENT_FEATURES` is a phase 4 subtask (P4.T1.S1), not a phase 3 one. *Verify:* `node --import ./src/server/liveWriteGuardAuto.mjs --test src/shared/http/routeContract.test.ts` → pass.
  - [x] **P3.T2.S2** *Files:* `src/app/api/customer/scan/report/[scan_id]/route.js` → rename to `route.ts`, `src/server/costs/scanReport.contract.ts`. *Do:* keep the existing body; add `cost` and `results[].cost`; switch to `requireWorkspace` and `toErrorResponse` with identical statuses and messages, except that a database error answers 500 "Could not load the scan report." (the pre-F03 route answered 404 for that failure). *Verify:* `node --import ./src/server/liveWriteGuardAuto.mjs --test src/server/customerRoutes.test.mjs` → pass (one import specifier updated: `route.js` → `route.ts`).
  - [x] **P3.T2.S3** *Files:* `src/app/api/ops/costs/route.ts`, `src/app/api/ops/costs/reconciliations/[id]/route.ts`, `src/app/api/ops/costs/reconciliations/bulk/route.ts`, `src/server/costs/ops.contract.ts`. *Do:* §6.5. *Verify:* contract test passes.
  - [x] **P3.T2.S4** *Files:* `src/server/costs/usageRoute.route.test.mjs`, `src/server/costs/scanCostRoute.route.test.mjs`, `src/server/costs/opsRoutes.route.test.mjs` (hooks `src/server/customerRoutes.test.hooks.mjs`). *Do:* tenant isolation (workspace A cannot read B: the admin fake asserts every query filters `brand_key` = A); bad tz → 400; flag off → 404 `feature_unavailable`; report response deep-equals the pre-change fixture for every old key; ops 409 mapping. *Verify:* `node --import ./src/server/liveWriteGuardAuto.mjs --test src/server/costs/*.route.test.mjs` → pass (F03-AC-09, 10, 12, 13, 15 route half).
- [x] **P3.T3 Env**
  - [x] **P3.T3.S1** *Files:* `.env.example`. *Do:* add `# FEATURE_USAGE_PAGE=off`. *Verify:* `npm run check:secrets` → pass.

**Checkpoint:** all suites pass; ACs 09, 10, 12, 13, 15 (routes), 19 (unit half).

### Phase 4 — UI (requires F04 — including its phase 4 `clientFeatures.ts` — and F05 merged)

**Goal:** customers see usage and per-answer cost; the operator has a cost console.

- [x] **P4.T1 Usage page**
  - [x] **P4.T1.S1** *Files:* `src/app/portal/usage/page.tsx`, `src/components/portal/usage/{UsagePage,UsageLimits,UsageChart,UsageByFeature,UsageRecent,UsageSection}.tsx` (licence headers on the three ported files), `src/components/portal/usage/hooks/useUsage.ts`, `src/shared/query/keys.ts` (add `usage`), `src/server/features/clientFeatures.ts` (append `"usage_page"` to `CLIENT_FEATURES`; the file already exists — F26 seeded `product_analytics` — and F04 phase 4 owns `GET /api/customer/features` and the `CLIENT_FEATURES` entry), `src/components/app/navigation/items.ts` (add Settings → Usage with `flag: "usage_page"`, so the item is hidden while the flag is off). *Do:* §6.6.1. *Verify (extra):* `GET /api/customer/features` includes `usage_page`. *Verify:* `npm run build` → exit 0.
- [x] **P4.T2 Scan cost card**
  - [x] **P4.T2.S1** *Files:* `src/components/portal/cost/ScanCostCard.tsx`, `src/app/portal/scans/[scanId]/page.jsx` (one import, one element). *Do:* §6.6.2. *Verify:* `node --import ./src/server/liveWriteGuardAuto.mjs --test src/components/portal/portalRegressions.test.mjs src/components/portal/portalProgress.test.mjs` → pass unchanged.
- [x] **P4.T3 Operator console**
  - [x] **P4.T3.S1** *Files:* `src/app/ops/costs/page.tsx`, `src/components/ops/costs/{CostsByWorkspace,EstimateAccuracy,EngineStats,OpenHolds,ReconciliationQueue,BulkAcceptDialog,PaidFeatureControls,WorkspaceLimits}.tsx`. *Do:* §6.6.3. *Verify:* `npm run build` → exit 0.
- [x] **P4.T4 Browser checks**
  - [x] **P4.T4.S1** *Files:* `scripts/qa/check-f03-browser.mjs` (Playwright from `worker/node_modules/playwright`, local app with fixture API responses served by route interception for `/api/customer/usage`, `/api/customer/scan/report/*`, `/api/ops/*`). *Do:* Usage states (loading, empty, error, partial, populated, range change updates URL, phone width 390 px), report cost card (final, running, unavailable, unknown attempts), ops page (401 copy, resolve dialog validation, bulk-accept dialog validation, controls confirmation field). Assert exact copy strings from §6.6. *Verify:* `node scripts/qa/check-f03-browser.mjs http://127.0.0.1:3328` → all groups PASS, 0 network requests to non-local hosts (F03-AC-11, 14, 15).
  - [x] **P4.T4.S2** *Files:* `.github/workflows/ci.yml`. *Do:* add the script to the existing browser job after `check-repair-browser.mjs`. *Verify:* CI green.

**Checkpoint:** everything above plus the browser job pass; `features/README.md` F03 status → Merged.

## 9. Test plan

| Test file | Cases | ACs |
|---|---|---|
| `src/shared/pricing/dataforseo.test.ts` | ported pricing cases, SERP pages, operator ×5 | 01 |
| `src/shared/ai-visibility-pricing.test.ts` | answer prices, model-API engines, checks per month | 02 |
| `src/shared/pricing/perceev.test.ts` | llmPricing delegation, env override, accuracy | 03 |
| `scripts/qa/check-f03-db.mjs` | `seed`, `sync` (incl. conflict and explore exclusion), `scan-hold` (incl. expired-hold overlap, deleted scan, two holds), `reconcile` (incl. bulk accept), `stats`, `rls` (incl. `cost_reconciliations` seen by nobody), `usage` (day bins across a tz boundary) | 04–09, 12 (DB half), 13, 17, 18, 19 |
| `src/server/costs/jobs.test.ts` | periodic slot dedupe, RPC order and limits | 16 |
| `src/server/costs/usage.test.ts`, `scanCost.test.ts` | aggregation and honesty rules; the two cost paths agree | 10, 12, 19 |
| `src/server/costs/*.route.test.mjs` | tenancy, flags, validation, additive report, ops mapping | 09, 10, 12, 13, 15 |
| `scripts/qa/check-f03-browser.mjs` | UI states and copy | 11, 14, 15 |

Fixtures are synthetic JSON under `tests/fixtures/f03/`. No provider recordings are needed. Nothing calls a provider.

## 10. Rollout and rollback

- **Env vars:** `FEATURE_USAGE_PAGE` (new, default off in production). F01's `SPEND_DEFAULT_DAILY_CAP_USD` and `SPEND_DEFAULT_MONTHLY_CAP_USD` feed the limit cards.
- **Migration order:** 050 then 051. Both additive. 050 seeds `ai_visibility.scan` enabled (see Deviations).
- **Backfill:** none needed. The first `costs.sync` run after deploy mirrors historical probe attempts of workspace scans (ordered oldest first, 1,000 per 5 minutes) into `spend_ledger` with their original timestamps, so the Usage page shows past scans. With current volumes (hundreds of attempts) this completes within the first hour.
- **Enable (precondition, not optional):** the Usage page fills gap days with a measured `0`, which is only honest once the backfill has finished — until then a past day with rows still queued reads as zero spend, which §6 rule 10 forbids. So `FEATURE_USAGE_PAGE` stays off until `sync_probe_attempt_costs` returns `0` on two consecutive `costs.sync` runs (visible in the job results, and in `/ops/costs`, which has no flag and is safe to read during the backfill). Then the owner sets `FEATURE_USAGE_PAGE=on` (or `allowlist` with `FEATURE_USAGE_PAGE_BRANDS`) after checking `/ops/costs` totals against the Offcult run's known ≈ USD 7.
- **Turn off:** `FEATURE_USAGE_PAGE=off` hides the page and route. The cost card on scan reports stays (no flag; it only reads). To stop the sync, set the periodic `enabled = false`: `update job_periodic set enabled=false where name='costs.sync'` (operator SQL, owner-approved).
- **Rollback:** revert code. The tables and columns are additive and harmless. `cost_reconciliations` can stay.

## 11. Risks and open questions

| # | Risk / question | Default chosen |
|---|---|---|
| 1 | Engine provider names come from `result.provenance.gateway`. Rows without it show provider "unknown". | Accept. The operator view groups "unknown" separately, and F02 adapters must set `gateway`. |
| 2 | OpenRouter answer-engine models have no table rate, so "typical cost" depends on ≥ 20 measured attempts per engine. | No typical figure until then. No invented numbers. |
| 2a | Every attempt whose provider never reports a cost opens one `unknown_cost` row, so the queue grows with scan volume and cannot be cleared one row at a time. | `resolve_unknown_cost_backlog` accepts open `unknown_cost` rows past a cutoff in bulk (`accepted` only, never a ledger rewrite). Undershoots stay one-by-one. |
| 2b | `days[].usd` is the accounted total and already contains `unknownUsd`, so a chart that stacks the two draws every unknown dollar twice. | The response carries `knownUsd` explicitly and the chart stacks `knownUsd` + `unknownUsd`. Asserted by `usage.test.ts` (`usd = knownUsd + unknownUsd`). |
| 3 | Content Studio spend (`content_jobs.cost_total`, `content_check_claims`) is not in the ledger, so Usage under-reports total workspace spend if Content Studio is used. | Out of scope for v1. The Usage page footnote reads "Content Studio costs are not included yet." Follow-up spec needed once content tables carry `brand_key`. |
| 4 | Seeding `ai_visibility.scan` **enabled** deviates from "every paid feature ships disabled". | Required to avoid refusing existing scans once F09 adds scan holds. Collection stays gated by P0 controls. |
| 5 | Provider invoice reconciliation (DataForSEO `id_list`, OpenRouter generation lookup) is not built. | Follow-up after F02's bake-off. The undershoot queue is the interim signal. |
| 6 | F04 component names are assumed (shadcn defaults). | If F04 names differ, F03 phase 4 uses F04's names for the same primitives. The structure and copy in §6.6 stay fixed. |
| 6a | `src/server/features/clientFeatures.ts` already exists (F26 seeded `product_analytics`); F03 must not touch it, and F04 phase 4 owns `GET /api/customer/features` and the `CLIENT_FEATURES` entry, so F03 cannot register `usage_page` as a client feature in its own phase 3. | The route and its flag ship in phase 3 and work without the client registry (the flag is read server-side); the `CLIENT_FEATURES` entry and the nav item are both phase 4 subtasks. |
| 7 | Nav registry §12 has no Usage entry. | Proposed: Settings → Usage → `/portal/usage` (request to coordinator). |
| 8 | The live report (`getScanCost` over `probe_attempts`) and the Usage page (`spend_ledger`) compute cost independently, so the same scan could show two totals. | Pinned by F03-AC-19: a synced terminal job must produce identical totals on both paths. |
| 9 | An expired scan hold counts at its estimate in `f01_committed_usd` until `costs.sync` settles it; a long scan can outlive its 24-hour TTL. | The periodic sync skips jobs with a `held` **or `expired`** hold, so exactly one of the two counts. Settlement (or the scan-missing close at zero) ends the window. |

**Deviations from conventions:** (a) `ai_visibility.scan` ships enabled (risk 4). (b) The existing report route file is converted from `.js` to `.ts` in place, to use `requireWorkspace`; its URL and JSON are unchanged. (c) `cost_reconciliations` carries `brand_key NOT NULL REFERENCES customer_brands` but has **no** `customer_can_access_brand` read policy, which §6 rule 8 and §8 would otherwise require: estimate accuracy is operator-only data, and a customer must never learn that we underpriced their scan. RLS is enabled with no policy and all grants revoked from `authenticated`, and `tests/customer-uat.sql` asserts each customer user is refused outright (`insufficient_privilege`, P2.T1.S1) rather than reading exactly one row. (d) `cost_reconciliations` has no `updated_at` trigger; resolution is a one-way transition stamped by `resolved_at`.

## 12. Definition of done

- [ ] Phases 1–4 merged with checkpoints green.
- [ ] F03-AC-01 … F03-AC-19 covered by passing tests in §9.
- [ ] `npm test`, `npm run typecheck`, `npm run build`, CI database and browser jobs green.
- [ ] `THIRD_PARTY_NOTICES.md` updated with all ported files.
- [ ] `00-CONVENTIONS.md` §12 gains the Usage row, in the phase 4 PR.
- [ ] `features/README.md` F03 status updated.
- [ ] Owner check recorded: `/ops/costs` total for the Offcult scan compared with the recorded ≈ USD 7 reservation spend, and the number of unknown-cost attempts.
