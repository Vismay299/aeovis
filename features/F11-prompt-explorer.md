# F11 — Prompt Explorer (ask one question now)

> <!-- doc-status -->
> **Owner decision, 25 October 2026:** Claude is not offered. Explore models are ChatGPT, Gemini and Perplexity (max 3). OpenSEO observations below that mention Claude describe their product, not ours.
>
> **Status: LIVE.** Implementation spec. Not built yet.

| Field | Value |
|---|---|
| ID | F11 |
| Wave | 1 |
| Comparison rows covered | "Ask one question now" (OpenSEO: Prompt Explorer, one prompt across up to 4 models with sources and fan-out queries; Perceev: not available) |
| Depends on | F01 (jobs, spend, flags, errors), F02 phase 3 (answer fetchers in `src/lib/providers/dataforseo/answers.ts`, `probeDataforseoModel`, `engineRoutes.ts`, `dispatchIdentity(engine, env, { route, model })`, Claude via OpenRouter), F03 (`llmResponseUsd`, `spend_ledger` columns, `ai_visibility.explore` label), F04 (UI primitives, app shell), F05 (`QueryClient`), F08 (`workspace_questions` and its add-question service) for phase 3, F09 (priced-action registry, estimate route, `CostReviewDialog`). |
| Blocks | F12 (shows explore answers in question history), F22 (assistant tool `explore_question` may wrap the same service) |
| Reserved migrations | 090–094. **090** `090_f11_explore_dispatch.sql`, **091** `091_f11_explore_runs.sql`. 092–094 unused. |
| Feature flag | `FEATURE_PROMPT_EXPLORER` (feature name `prompt_explorer`, linked spend features `["ai_visibility.explore"]`) |
| Spend features | `ai_visibility.explore` (label "Prompt Explorer", already in F03's `src/shared/spend-features.ts`) |
| OpenSEO reference | `openseo:src/server/features/ai-search/services/promptExplorer.ts`, `openseo:src/server/features/ai-search/services/access.ts`, `openseo:src/serverFunctions/ai-search.ts`, `openseo:src/types/schemas/ai-search.ts:156-303`, `openseo:src/shared/prompt-explorer-labels.ts`, `openseo:src/client/features/ai-search/{PromptExplorerPage.tsx,promptExplorerQuery.ts,components/PromptExplorerForm.tsx,components/PromptExplorerResults.tsx,components/PromptExplorerLoadingState.tsx,components/MarkdownAnswer.tsx,platformLabels.ts}`, `openseo:src/routes/_app/p/$projectId/prompt-explorer.tsx` at `c5f8db1` |

## 1. Summary

A customer types one buyer question, picks up to three models (ChatGPT, Gemini, Perplexity), sees the price, approves it, and gets each model's answer side by side: the answer as markdown, the token count, whether the model actually searched the web, whether it named their brand, the sources it cited, and the related searches it ran first. One click then adds the question to the tracked set. This is how a customer tries a question before tracking it, and every answer is collected inside Perceev's P0 dispatch fence, so it is paused, allow-listed, circuit-protected and capped exactly like a scan answer.

## 2. What OpenSEO does (observed)

1. `explorePrompt(input, customer)` asks one prompt across 1–4 models. Models are de-duplicated "so a request like ["claude","claude"] doesn't fan out to two paid upstream calls"; per-model failures are isolated with `Promise.allSettled` (`openseo:src/server/features/ai-search/services/promptExplorer.ts:29-94`).
2. Input: `prompt` trimmed, 1–500 chars; `models` 1–4 of `chat_gpt, claude, gemini, perplexity`, default `["chat_gpt"]`; `highlightBrand` optional; `webSearch` default `true`; `webSearchCountryCode` optional ISO code (`openseo:src/types/schemas/ai-search.ts:156-198`). Output per model is a discriminated union: success `{ model, modelName, text, citations[{url,domain,title,matchedBrand}], fanOutQueries, brandMentioned, outputTokens, webSearch, webSearchCountryCode }` or error `{ model, errorCode: UPSTREAM_ERROR | UNSUPPORTED_COUNTRY, message }` (`ai-search.ts:200-243`).
3. A model that does not support the chosen country is skipped before any spend, with the message "{Model} doesn’t support {Country} as a search country. Select “No country preference” above, then run again to include {Model}." (Gemini: "doesn’t support country selection") (`promptExplorer.ts:104-122`).
4. Every call is `llm_responses` with `max_output_tokens: 4096`, because reasoning models spend hidden tokens and "at 1024 ChatGPT regularly burns the whole budget on reasoning" (`promptExplorer.ts:43-49`, `:184-196`). The model name comes from the live catalogue and is part of the cache key (`:123-139`).
5. Answers are cached 7 days per (organisation, project, model, model name, whitespace-normalised prompt, web search, country, schema version 7). Casing is preserved on purpose (`promptExplorer.ts:40-41`, `:126-148`, `:330-332`). The highlight brand is not in the key and is re-applied on read (`:141-148`, `:229-247`).
6. When web search was requested but the model answered from memory, OpenSEO makes **one paid retry** and keeps it only if it searched (`promptExplorer.ts:150-167`; tests `promptExplorer.test.ts:102-151`).
7. Text = joined `message` sections; citations = annotations with safe http(s) URLs only, de-duplicated, at most 25; fan-out queries at most 20; `outputTokens` rounded (`promptExplorer.ts:198-290`; tests `promptExplorer.test.ts:52-100`).
8. Brand mention: a citation whose URL or title contains the brand (case-insensitive), else a regex on the text with word boundaries that handle brands ending in non-word characters ("C++", "AT&T") (`promptExplorer.ts:292-328`).
9. Account-level failures (credits, DataForSEO billing) fail the whole request; any other failure becomes a per-model `UPSTREAM_ERROR` "This model is temporarily unavailable. Please try again." with details logged server-side only (`promptExplorer.ts:334-359`).
10. Access: hosted mode requires a paid plan (`openseo:src/server/features/ai-search/services/access.ts:5-16`). The server function runs inside `requireProjectContext` (`openseo:src/serverFunctions/ai-search.ts:19-24`).
11. Route `/p/$projectId/prompt-explorer` keeps the whole search in the URL (`q`, `models`, `web`, `cc`, `hb`) so it is shareable (`openseo:src/types/schemas/ai-search.ts:270-303`; `openseo:src/routes/_app/p/$projectId/prompt-explorer.tsx:13-72`). The client query runs when the URL has a prompt, with `staleTime` one day, `retry: false`, no refetch on focus or reconnect, "Answers are billed per model" (`openseo:src/client/features/ai-search/promptExplorerQuery.ts:17-34`; `PromptExplorerPage.tsx:117-129`). Recent searches are kept per project in local storage (`openseo:src/client/hooks/usePromptExplorerSearchHistory.ts:39-45`).
12. Form: textarea with "{n}/500" counter and helper "What your customers might ask AI."; "Highlight brand (optional)" with "We'll flag whether each model mentions this brand."; model checkboxes with "Skipped for {Country}"; "Allow web search" checkbox; country combobox with "No country preference"; info tooltip; submit "Run {n} model(s)" (`openseo:src/client/features/ai-search/components/PromptExplorerForm.tsx:116-263`). Validation copy: "Enter a prompt", "Keep prompts under 500 characters", "Select at least one model" (`PromptExplorerPage.tsx:131-160`).
13. Results: one card per model with a coloured left border (ChatGPT emerald, Gemini sky, Perplexity violet), header with model label, model name, Error/Skipped badge, brand badge ("{brand}" success or "no {brand}"), "web search"/"no web search", "{n} tokens"; a line "Country hint sent: {Country}. This is not a verified search location." or "No country hint sent. Any search uses the provider’s default location."; the markdown answer; "Cited sources ({n})" list showing 3 then "+N more"; "Related queries the model considered" badges (`openseo:src/client/features/ai-search/components/PromptExplorerResults.tsx:28-254`; accents `openseo:src/client/features/ai-search/platformLabels.ts:18-35`; list limit `openseo:src/client/components/ExpandableList.tsx:4-37`).
14. Markdown answers collapse to 240 px with a fade and "Read more"/"Show less"; `<think>` blocks are shown separately as "Model Thinking"; malformed list markers are repaired; links are http(s) only; an empty answer shows "Model returned an empty response." (`openseo:src/client/features/ai-search/components/MarkdownAnswer.tsx:17-177`).
15. Loading: one skeleton card per selected model, named, `aria-busy` (`openseo:src/client/features/ai-search/components/PromptExplorerLoadingState.tsx:7-52`).
16. Costs: per-model DataForSEO estimates at the 4,096-token cap with web search: chat_gpt 0.09, claude 0.18, gemini 0.11, perplexity 0.04 USD (`openseo:src/server/lib/dataforseo/pricing.ts:122-145`). There is no price dialog for Prompt Explorer; the gate is the paid plan. **(Inferred)** spend shows up only in the billing history.

## 3. What Perceev has today

- No way to ask a single question. Answers are only collected inside scans (`src/lib/workers/durableProbing.js:62-329`) or operator canaries (`src/lib/ops/providerCanary.js:18-146`).
- The P0 fence: `probe_observations.purpose` is limited to `scan`/`canary` (`supabase/migrations/027_durable_probe_dispatch.sql:6`). `claim_probe_dispatch` admits a row while paused only if it is a canary with `canaries_allowed`, or if its **scan job's** `brand_key` is in `brand_allowlist` (`supabase/migrations/035_scoped_provider_rollout.sql:27-32`). The per-scan cap sums attempts by `job_id`, or by canary `budget_scope` (`035:60-63`); the per-day cap sums every attempt (`035:75-84`). An observation without a job has no brand, so today an explore row could never pass an allowlist.
- `finish_probe_dispatch` projects into `prompt_results` only when `job_id` is set (`027:255-267`), so an observation without a job stays out of scan reports.
- Customer routes that read observations join `scan_jobs!inner(brand_key)` (`src/app/api/customer/measurement/route.js:16-25`, `src/app/api/customer/measurement/evidence/route.js:12-19`), so explore observations never appear in measurement history.
- F03's periodic ledger sync joins `scan_jobs` (F03 §6.1 `f03_upsert_attempt_rows`), so it cannot see explore attempts; F11 writes their ledger rows itself (§6.1).
- F02 provides `probeDataforseoModel` (DataForSEO `llm_responses`), the OpenRouter path `probeOpenRouterEngine` (`src/lib/engines/openRouterProbe.js:127-237`, which always sends the web-search tool except for Sonar, `:143-174`), Claude as an engine, and route resolution.
- **Must not break:** every scan and canary claim outcome (F11 adds branches only for `purpose = 'explore'`), `scripts/qa/check-probe-dispatch.mjs`, `set_probe_rollout` semantics, the one-brand allowlist rule (`035:106-108`).

## 4. Target behaviour and acceptance criteria

| ID | Statement | Verified by |
|---|---|---|
| F11-AC-01 | `probe_observations` accepts `purpose = 'explore'` only with `job_id IS NULL`, `brand_key` set and a uuid `context.explore_run_id`; scan and canary rows are unaffected. | DB `scripts/qa/check-f11-db.mjs` group `explore-shape` |
| F11-AC-02 | While dispatch is paused, an explore claim is granted only when its `brand_key` is the allow-listed brand; `canaries_allowed` never admits an explore row; when not paused it is granted (other checks passing). | DB group `explore-fence` |
| F11-AC-03 | An explore claim requires `p_scan_cap` (the run's approved maximum) and refuses with `spend_reservation_refused` once the run's attempts plus the new reservation exceed it; attempts of other runs and scans do not count toward it. The global day cap includes explore attempts. | DB group `explore-fence` |
| F11-AC-04 | For a fixed matrix of 12 scan and canary situations (paused/unpaused, allowlisted/not, canary allowed/not, circuit open/closed, caps), `claim_probe_dispatch` after migration 090 returns exactly what it returned before. | DB group `claim-regression`; CI `check-probe-dispatch.mjs` |
| F11-AC-05 | An open provider circuit blocks explore claims (`provider_circuit_open`); an explore claim never acts as a recovery canary. | DB group `explore-fence` |
| F11-AC-06 | `seed_explore_observations` is idempotent and raises on any identity change (engine, query, context, config, circuit, brand). | DB group `explore-shape` |
| F11-AC-07 | The quote for `ai_visibility.explore.run` has one line per selected model: DataForSEO route at `llmResponseUsd(slug, webSearch)`, OpenRouter route at `EXPLORE_OPENROUTER_RESERVE_USD`; a model reused from the last 7 days at $0.00; a model unsupported for the chosen country is listed as skipped at $0.00; `totalUsd` is the sum in micro-dollars. Blocked codes: `collection_paused`, `no_models_available`. | unit `src/lib/pricing/actions/exploreRun.test.ts` |
| F11-AC-08 | `POST /api/customer/explore` checks, in order: workspace (F01), flag (`403 feature_disabled`), input (`400`), rate limits (`429 explore_rate_limited`), one active run per user (`409 explore_already_running`), price (`400 approval_required`, `409 price_changed`, `409 collection_paused`, `409 no_models_available`), accounting hold (`402`/`403` F01 copy), then creates the run and enqueues the job and returns `202`. A refusal at any step creates nothing and reserves nothing. | route `src/lib/explore/explore.route.test.mjs` |
| F11-AC-09 | Rate limits: at most `EXPLORE_MAX_RUNS_PER_USER_HOUR` (default 10) runs per user per rolling hour and `EXPLORE_MAX_RUNS_PER_WORKSPACE_DAY` (default 30) per workspace per UTC day; `details.retryAfterSeconds` is set. | unit `src/lib/explore/rateLimit.test.ts`; route test |
| F11-AC-10 | The `explore.run` job makes at most one claim and one provider call per non-reused model. A failed model is never re-asked automatically, including OpenSEO's paid retry for answers given without search. The ask step is `billed: true`, `retries: 0`. | unit `src/lib/explore/job.test.ts` |
| F11-AC-11 | Explore answers are stored as `purpose='explore'` observations with no `prompt_results` row; they do not appear in `GET /api/customer/measurement` or any scan report. | DB group `explore-isolation`; route test |
| F11-AC-12 | After the run, `settle_explore_hold` writes one `spend_ledger` row per attempt (`feature = 'ai_visibility.explore'`, `subject_kind = 'explore_run'`, `source_ref = 'probe_attempt:<obs>:<n>'`) and settles the hold at the known total (or `actual_usd NULL` if any attempt is unknown). Re-running creates no duplicates. | DB group `explore-ledger` |
| F11-AC-13 | A model answered in this workspace within `EXPLORE_REUSE_DAYS` (default 7) with the same prompt hash, engine, route, model name, web-search flag and country is reused without a claim; the card says so; `fresh: true` asks again. | unit `src/lib/explore/service.test.ts` |
| F11-AC-14 | Shaping parity with OpenSEO: text from message sections, citations de-duplicated, unsafe schemes dropped, max 25; fan-out max 20; tokens rounded; brand mention by citation URL/title or boundary-aware regex (`C++`, `AT&T`); the workspace brand's aliases also count. | unit `src/lib/explore/shape.test.ts` (port of `promptExplorer.test.ts:52-100`) |
| F11-AC-15 | `GET /api/customer/explore/[runId]` returns 404 `explore_run_not_found` for another workspace's run, `pollAfterSeconds` 3 while `queued`/`running` and `null` after. | route test |
| F11-AC-16 | `POST /api/customer/explore/[runId]/track` adds the question through F08's service (origin `manual`), is idempotent, stores `explore_runs.question_id`, and returns the question id and whether it was created. | route test |
| F11-AC-17 | The page renders every state in §6.6 with the exact copy, shows the price before any run, and never starts a paid run on page load or URL change. | browser `scripts/qa/check-f11-browser.mjs` |
| F11-AC-18 | No prompt, answer text, citation URL or highlight brand is written to logs or telemetry; telemetry events carry counts and booleans only. | unit `job.test.ts` and `service.test.ts` with console and telemetry spies |
| F11-AC-19 | Feature off: the sidebar item is hidden, the page shows the disabled state, the API returns `403 feature_disabled`, and no quote is priced as runnable. | route test; browser test |
| F11-AC-20 | `explore.retention` deletes `explore_runs` older than 395 days in batches of 1,000 and leaves probe rows untouched. | DB group `explore-retention` |

## 5. Scope

**In scope:** migration of the P0 fence for `purpose = 'explore'`; explore runs table; priced action; start/read/list/track routes; `explore.run` job; ledger settlement for explore; rate limits; the `/portal/explore` page and sidebar entry; the shared markdown answer component used by F12.

**Out of scope:**
- Google AI Overviews in the explorer (it is a search result, not a model; scans cover it).
- Consumer-app capture (scraper) answers in the explorer: the explorer is the model API with web search, as in OpenSEO, because only that path reports tokens, search use and fan-out queries.
- Brand Lookup / LLM-mentions database (OpenSEO hides it from navigation; not in the comparison row).
- Question curation and panels (F08), per-question history (F12), price dialog component (F09), engine adapters (F02).
- Sharing an explore result publicly (F23).
- Deferred Mixed rows (Stable question set, Citations and sources): "Track this question" only calls F08's add-question service and does not change panel rules.

## 6. Design

### 6.1 Data model

#### `supabase/migrations/090_f11_explore_dispatch.sql`

```sql
-- F11: Prompt Explorer answers are probe_observations with purpose 'explore', claimed through
-- claim_probe_dispatch. Pause, the one-brand allowlist, circuits, attempt/deadline limits and the
-- global day cap apply unchanged. claim_probe_dispatch below is 035's body with four changes,
-- each marked "F11". finish_probe_dispatch and every other function are unchanged.

-- No ON DELETE CASCADE: probe_attempts reference observations without cascade (027:28), so a
-- cascading brand delete would fail. Workspace deletion keeps P0 history, as scans do today.
ALTER TABLE public.probe_observations ADD COLUMN IF NOT EXISTS brand_key text
  REFERENCES public.customer_brands(brand_key);
COMMENT ON COLUMN public.probe_observations.brand_key IS
  'Workspace of an explore observation (purpose = explore). NULL for scan and canary rows, whose workspace is scan_jobs.brand_key.';

DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'public.probe_observations'::regclass AND contype = 'c'
              AND pg_get_constraintdef(oid) LIKE '%purpose%' AND pg_get_constraintdef(oid) LIKE '%canary%' LOOP
    EXECUTE format('ALTER TABLE public.probe_observations DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE public.probe_observations ADD CONSTRAINT probe_observations_purpose_check
  CHECK (purpose IN ('scan','canary','explore'));
ALTER TABLE public.probe_observations DROP CONSTRAINT IF EXISTS probe_observations_explore_shape;
ALTER TABLE public.probe_observations ADD CONSTRAINT probe_observations_explore_shape CHECK (
  purpose <> 'explore' OR (job_id IS NULL AND brand_key IS NOT NULL
    AND (context->>'explore_run_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'));
CREATE INDEX IF NOT EXISTS probe_observations_explore_run_idx
  ON public.probe_observations ((context->>'explore_run_id')) WHERE purpose = 'explore';
CREATE INDEX IF NOT EXISTS probe_observations_explore_reuse_idx
  ON public.probe_observations (brand_key, engine, (context->>'prompt_hash'), observed_at DESC)
  WHERE purpose = 'explore' AND state = 'answered';

CREATE OR REPLACE FUNCTION public.seed_explore_observations(p_rows jsonb) RETURNS void
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE r jsonb; prior probe_observations;
BEGIN
  FOR r IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    IF r->>'purpose' IS DISTINCT FROM 'explore' OR (r->>'job_id') IS NOT NULL THEN
      RAISE EXCEPTION 'explore rows only'; END IF;
    INSERT INTO probe_observations(id, job_id, purpose, engine, query, context, config_version, circuit_key,
                                   deadline_at, brand_key)
    VALUES (r->>'id', NULL, 'explore', r->>'engine', r->>'query', r->'context', r->>'config_version',
            r->>'circuit_key', (r->>'deadline_at')::timestamptz, r->>'brand_key')
    ON CONFLICT DO NOTHING;
    SELECT * INTO prior FROM probe_observations WHERE id = r->>'id';
    IF NOT FOUND OR prior.purpose <> 'explore' OR prior.context IS DISTINCT FROM r->'context'
       OR prior.engine <> r->>'engine' OR prior.query <> r->>'query'
       OR prior.config_version <> r->>'config_version' OR prior.circuit_key <> r->>'circuit_key'
       OR prior.brand_key IS DISTINCT FROM r->>'brand_key' THEN
      RAISE EXCEPTION 'immutable observation identity mismatch';
    END IF;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION claim_probe_dispatch(p_id text, p_reserve numeric,
  p_scan_cap numeric DEFAULT NULL, p_day_cap numeric DEFAULT NULL,
  p_lease_seconds integer DEFAULT 120) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE o probe_observations; c provider_dispatch_circuits; b provider_canary_budgets; token uuid := gen_random_uuid();
  at_time timestamptz; scan_spend numeric; day_spend numeric;
BEGIN
  IF p_reserve IS NULL OR p_reserve<=0 OR p_lease_seconds<1 OR p_lease_seconds>180
    OR p_scan_cap<0 OR p_day_cap<0 THEN RAISE EXCEPTION 'invalid dispatch budget'; END IF;
  PERFORM pg_advisory_xact_lock(270027);
  at_time := clock_timestamp();
  SELECT * INTO o FROM probe_observations WHERE id=p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'observation not found'; END IF;
  -- F11 (1/4): an explore claim always carries the run's approved maximum.
  IF o.purpose='explore' AND p_scan_cap IS NULL THEN RAISE EXCEPTION 'explore requires an approved run cap'; END IF;
  IF o.state='leased' AND o.lease_until<=at_time THEN
    UPDATE probe_attempts SET dispatch_state='unknown' WHERE observation_id=o.id AND lease_token=o.lease_token;
    UPDATE probe_observations SET state='ambiguous',reason='dispatch_unknown',lease_until=NULL WHERE id=o.id;
    RETURN jsonb_build_object('granted',false,'reason','dispatch_unknown');
  END IF;
  IF o.state NOT IN ('pending','retry') THEN
    RETURN jsonb_build_object('granted',false,'reason',o.state);
  END IF;
  -- F11 (2/4): an explore row is allow-listed by its own brand_key (it has no scan job).
  IF NOT EXISTS(SELECT 1 FROM probe_dispatch_control p WHERE p.singleton=true AND
    (NOT p.paused OR (p.canaries_allowed AND o.purpose='canary')
      OR (o.purpose='explore' AND o.brand_key=ANY(p.brand_allowlist))
      OR EXISTS(SELECT 1 FROM scan_jobs j WHERE j.id=o.job_id AND j.brand_key=ANY(p.brand_allowlist)))) THEN
    UPDATE probe_observations SET state='blocked',reason='dispatch_paused' WHERE id=o.id;
    RETURN jsonb_build_object('granted',false,'reason','dispatch_paused');
  END IF;
  IF o.next_attempt_at>at_time THEN
    RETURN jsonb_build_object('granted',false,'reason','not_due','next_attempt_at',o.next_attempt_at);
  END IF;
  IF o.attempt_count>=3 OR o.deadline_at<=at_time THEN
    UPDATE probe_observations SET state='failed',reason='attempt_or_deadline_limit' WHERE id=o.id;
    RETURN jsonb_build_object('granted',false,'reason','attempt_or_deadline_limit');
  END IF;
  IF at_time + make_interval(secs=>p_lease_seconds) > o.deadline_at THEN
    UPDATE probe_observations SET state='failed',reason='insufficient_deadline' WHERE id=o.id;
    RETURN jsonb_build_object('granted',false,'reason','insufficient_deadline');
  END IF;
  INSERT INTO provider_dispatch_circuits(circuit_key) VALUES(o.circuit_key) ON CONFLICT DO NOTHING;
  SELECT * INTO c FROM provider_dispatch_circuits WHERE circuit_key=o.circuit_key FOR UPDATE;
  IF c.open_until IS NOT NULL THEN
    IF o.purpose<>'canary' OR c.open_until>at_time OR c.recovery_until>at_time THEN
      UPDATE probe_observations SET state='blocked',reason='provider_circuit_open' WHERE id=o.id;
      RETURN jsonb_build_object('granted',false,'reason','provider_circuit_open');
    END IF;
  END IF;
  IF o.purpose='canary' THEN
    INSERT INTO provider_canary_budgets(scope,max_requests,max_spend_usd)
    VALUES(o.context->>'budget_scope',(o.context->>'max_requests')::integer,p_scan_cap) ON CONFLICT DO NOTHING;
    SELECT * INTO b FROM provider_canary_budgets WHERE scope=o.context->>'budget_scope' FOR UPDATE;
    IF b.max_requests<>(o.context->>'max_requests')::integer OR b.max_spend_usd IS DISTINCT FROM p_scan_cap THEN
      RAISE EXCEPTION 'canary shared budget mismatch'; END IF;
  END IF;
  -- F11 (3/4): an explore run's spend is the sum of its own attempts.
  SELECT coalesce(sum(coalesce(a.charged_usd,a.reserved_usd)),0) INTO scan_spend
    FROM probe_attempts a JOIN probe_observations x ON x.id=a.observation_id
    WHERE (o.job_id IS NOT NULL AND x.job_id=o.job_id)
      OR (o.purpose='canary' AND x.context->>'budget_scope'=o.context->>'budget_scope')
      OR (o.purpose='explore' AND x.purpose='explore' AND x.context->>'explore_run_id'=o.context->>'explore_run_id');
  IF o.purpose='canary' AND coalesce((o.context->>'max_requests')::integer,0) <
    coalesce((SELECT sum((x.context->>'request_units')::integer) FROM probe_attempts a JOIN probe_observations x ON x.id=a.observation_id
      WHERE x.context->>'budget_scope'=o.context->>'budget_scope'),0)+(o.context->>'request_units')::integer THEN
    UPDATE probe_observations SET state='blocked',reason='request_budget_refused' WHERE id=o.id;
    RETURN jsonb_build_object('granted',false,'reason','request_budget_refused');
  END IF;
  IF o.job_id IS NOT NULL THEN
    scan_spend := scan_spend+coalesce((o.context->>'sourcing_cost')::numeric,0);
  END IF;
  SELECT coalesce(sum(coalesce(charged_usd,reserved_usd)),0) INTO day_spend
    FROM probe_attempts WHERE started_at >= date_trunc('day',at_time AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  SELECT day_spend+coalesce(sum((s.raw_results->>'cost_total')::numeric),0) INTO day_spend FROM scans s
    WHERE s.created_at >= date_trunc('day',at_time AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
      AND NOT EXISTS (SELECT 1 FROM scan_jobs j JOIN probe_observations x ON x.job_id=j.id WHERE j.result_id=s.id);
  SELECT day_spend+coalesce(sum(seed_cost),0) INTO day_spend FROM (
    SELECT x.job_id,max(coalesce((x.context->>'sourcing_cost')::numeric,0)) AS seed_cost
      FROM probe_observations x WHERE x.job_id IS NOT NULL
        AND x.created_at >= date_trunc('day',at_time AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' GROUP BY x.job_id
  ) costs;
  IF (p_scan_cap IS NOT NULL AND scan_spend+p_reserve>p_scan_cap)
    OR (p_day_cap IS NOT NULL AND day_spend+p_reserve>p_day_cap) THEN
    UPDATE probe_observations SET state='blocked',reason='spend_reservation_refused' WHERE id=o.id;
    RETURN jsonb_build_object('granted',false,'reason','spend_reservation_refused');
  END IF;
  IF c.open_until IS NOT NULL THEN
    UPDATE provider_dispatch_circuits SET recovery_token=token,recovery_until=at_time+make_interval(secs=>p_lease_seconds)
      WHERE circuit_key=o.circuit_key;
  END IF;
  -- F11 (4/4): none in the grant itself; explore attempts are recorded exactly like scan attempts.
  UPDATE probe_observations SET state='leased',attempt_count=attempt_count+1,lease_token=token,
    lease_until=at_time+make_interval(secs=>p_lease_seconds),reason=NULL,unknown_cost_calls=unknown_cost_calls+1 WHERE id=o.id;
  INSERT INTO probe_attempts(observation_id,attempt_no,lease_token,reserved_usd,started_at)
    VALUES(o.id,o.attempt_count+1,token,p_reserve,at_time);
  RETURN jsonb_build_object('granted',true,'lease_token',token,'attempt_no',o.attempt_count+1,
    'lease_until',at_time+make_interval(secs=>p_lease_seconds));
END $$;

REVOKE ALL ON FUNCTION public.seed_explore_observations(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.seed_explore_observations(jsonb) TO service_role;
REVOKE ALL ON FUNCTION claim_probe_dispatch(text,numeric,numeric,numeric,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION claim_probe_dispatch(text,numeric,numeric,numeric,integer) TO service_role;
NOTIFY pgrst, 'reload schema';
```

The P0 rules hold: pause still blocks every explore row whose brand is not the one allow-listed workspace; nothing in this migration or in F11 code calls `set_probe_rollout` or writes `probe_dispatch_control` (conventions §6.3).

#### `supabase/migrations/091_f11_explore_runs.sql`

```sql
-- F11: one row per Prompt Explorer question asked, plus its ledger settlement.
CREATE TABLE IF NOT EXISTS public.explore_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  job_id uuid,                                   -- F01 jobs.id; no FK because jobs are pruned after 30 days
  prompt text NOT NULL CHECK (length(btrim(prompt)) BETWEEN 1 AND 500),
  prompt_hash text NOT NULL CHECK (prompt_hash ~ '^[0-9a-f]{64}$'),
  models text[] NOT NULL CHECK (cardinality(models) BETWEEN 1 AND 4
    AND models <@ ARRAY['chatgpt','gemini','perplexity']::text[]),
  web_search boolean NOT NULL DEFAULT true,
  country text CHECK (country IS NULL OR country ~ '^[A-Z]{2}$'),
  highlight_brand text CHECK (highlight_brand IS NULL OR length(btrim(highlight_brand)) BETWEEN 1 AND 100),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','completed','partial','failed','cancelled')),
  plan jsonb NOT NULL,                           -- ExplorePlan (§6.2), one entry per selected model
  quote jsonb NOT NULL,                          -- F09 PriceQuote the customer approved
  approved_max_usd numeric(12,6) NOT NULL CHECK (approved_max_usd >= 0),
  hold_id uuid REFERENCES public.spend_holds(id),
  question_id uuid REFERENCES public.workspace_questions(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
COMMENT ON COLUMN public.explore_runs.prompt_hash IS
  'sha256 of the prompt trimmed with internal whitespace collapsed (case kept), as OpenSEO normalizePromptForCache.';
CREATE INDEX IF NOT EXISTS explore_runs_brand_idx ON public.explore_runs (brand_key, created_at DESC);
CREATE INDEX IF NOT EXISTS explore_runs_user_idx ON public.explore_runs (created_by, created_at DESC);
CREATE INDEX IF NOT EXISTS explore_runs_active_idx ON public.explore_runs (brand_key, created_by)
  WHERE status IN ('queued','running');
ALTER TABLE public.explore_runs ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.explore_runs TO authenticated;
GRANT ALL ON public.explore_runs TO service_role;
DROP POLICY IF EXISTS explore_runs_read ON public.explore_runs;
CREATE POLICY explore_runs_read ON public.explore_runs FOR SELECT TO authenticated
  USING (public.customer_can_access_brand(brand_key));

-- Ledger rows for one run's attempts. Same mapping as F03's f03_upsert_attempt_rows, scoped to
-- explore observations (which F03's sync cannot see: it joins scan_jobs).
CREATE OR REPLACE FUNCTION public.f11_upsert_explore_attempt_rows(p_run uuid, p_hold uuid)
RETURNS integer LANGUAGE plpgsql SET search_path = public AS $$
DECLARE r record; v integer := 0; v_src text; v_actual numeric; v_accounted numeric;
BEGIN
  FOR r IN
    SELECT a.observation_id, a.attempt_no, a.reserved_usd, a.charged_usd, a.cost_state, a.dispatch_state,
           a.result->>'cost_source' AS reported_source, a.started_at, a.finished_at,
           coalesce(a.result->'provenance'->>'gateway', 'unknown') AS gateway, o.engine, o.brand_key
      FROM probe_attempts a JOIN probe_observations o ON o.id = a.observation_id
     WHERE o.purpose = 'explore' AND o.context->>'explore_run_id' = p_run::text
     ORDER BY a.started_at
  LOOP
    IF r.cost_state = 'confirmed_not_dispatched' THEN v_src := 'none'; v_actual := 0; v_accounted := 0;
    ELSIF r.charged_usd IS NULL THEN v_src := 'reservation'; v_actual := NULL; v_accounted := r.reserved_usd;
    ELSE v_src := CASE WHEN r.reported_source = 'gateway' THEN 'provider_reported' ELSE 'price_table' END;
         v_actual := r.charged_usd; v_accounted := r.charged_usd;
    END IF;
    INSERT INTO spend_ledger(brand_key, feature, hold_id, job_id, source_ref, provider, endpoint, units,
                             estimate_usd, actual_usd, accounted_usd, cost_source, occurred_at, meta,
                             subject_kind, subject_id, answer_ref)
    VALUES (r.brand_key, 'ai_visibility.explore', p_hold, NULL,
            'probe_attempt:' || r.observation_id || ':' || r.attempt_no,
            r.gateway, 'probe:' || r.engine, 1, r.reserved_usd, v_actual, v_accounted, v_src,
            coalesce(r.finished_at, r.started_at),
            jsonb_build_object('engine', r.engine, 'attempt_no', r.attempt_no, 'cost_state', r.cost_state,
                               'reported_source', r.reported_source),
            'explore_run', p_run::text, r.observation_id)
    ON CONFLICT (source_ref) DO UPDATE SET actual_usd = excluded.actual_usd, accounted_usd = excluded.accounted_usd,
      cost_source = excluded.cost_source, meta = excluded.meta, hold_id = coalesce(excluded.hold_id, spend_ledger.hold_id);
    v := v + 1;
  END LOOP;
  RETURN v;
END $$;

CREATE OR REPLACE FUNCTION public.settle_explore_hold(p_run uuid)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE run explore_runs; h spend_holds; v_rows integer; v_sum numeric; v_unknown boolean;
BEGIN
  SELECT * INTO run FROM explore_runs WHERE id = p_run FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('settled', false, 'reason', 'run_missing'); END IF;
  IF run.status NOT IN ('completed','partial','failed','cancelled') THEN
    RETURN jsonb_build_object('settled', false, 'reason', 'run_active'); END IF;
  IF run.hold_id IS NULL THEN
    v_rows := f11_upsert_explore_attempt_rows(p_run, NULL);
    RETURN jsonb_build_object('settled', false, 'reason', 'no_hold', 'rows', v_rows); END IF;
  SELECT * INTO h FROM spend_holds WHERE id = run.hold_id FOR UPDATE;
  IF h.status NOT IN ('held','expired') THEN RETURN jsonb_build_object('settled', false, 'reason', h.status); END IF;
  IF h.status = 'expired' THEN
    DELETE FROM spend_ledger WHERE source_ref = 'hold:' || h.id AND cost_source = 'reservation';
  END IF;
  v_rows := f11_upsert_explore_attempt_rows(p_run, h.id);
  SELECT coalesce(sum(actual_usd), 0), bool_or(cost_source = 'reservation') INTO v_sum, v_unknown
    FROM spend_ledger WHERE subject_kind = 'explore_run' AND subject_id = p_run::text
     AND source_ref LIKE 'probe_attempt:%';
  UPDATE spend_holds SET status = 'settled', actual_usd = CASE WHEN coalesce(v_unknown,false) THEN NULL ELSE v_sum END,
         closed_at = now() WHERE id = h.id;
  RETURN jsonb_build_object('settled', true, 'rows', v_rows, 'actual_usd', v_sum, 'unknown', coalesce(v_unknown,false));
END $$;

CREATE OR REPLACE FUNCTION public.settle_finished_explore_holds(p_limit integer DEFAULT 50)
RETURNS integer LANGUAGE plpgsql SET search_path = public AS $$
DECLARE r record; v integer := 0;
BEGIN
  FOR r IN SELECT e.id FROM explore_runs e JOIN spend_holds h ON h.id = e.hold_id
            WHERE e.status IN ('completed','partial','failed','cancelled') AND h.status IN ('held','expired')
            ORDER BY e.created_at LIMIT p_limit LOOP
    PERFORM settle_explore_hold(r.id); v := v + 1;
  END LOOP;
  RETURN v;
END $$;

CREATE OR REPLACE FUNCTION public.prune_explore_runs(p_before timestamptz, p_limit integer DEFAULT 1000)
RETURNS integer LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v integer;
BEGIN
  WITH old AS (SELECT id FROM explore_runs WHERE created_at < p_before ORDER BY created_at LIMIT p_limit)
  DELETE FROM explore_runs e USING old WHERE e.id = old.id;
  GET DIAGNOSTICS v = ROW_COUNT; RETURN v;
END $$;

REVOKE ALL ON FUNCTION public.f11_upsert_explore_attempt_rows(uuid,uuid), public.settle_explore_hold(uuid),
  public.settle_finished_explore_holds(integer), public.prune_explore_runs(timestamptz,integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.f11_upsert_explore_attempt_rows(uuid,uuid), public.settle_explore_hold(uuid),
  public.settle_finished_explore_holds(integer), public.prune_explore_runs(timestamptz,integer) TO service_role;
NOTIFY pgrst, 'reload schema';
```

`scripts/setup-supabase.mjs` registers `explore_runs` and the six new functions; the CI tenant RLS test (`.github/workflows/ci.yml` customer-database job) adds `explore_runs` to its customer-table list (conventions §8). Explore observations themselves follow the same retention as scan observations (none beyond the 90-day evidence expiry today); `explore_runs` is pruned after 395 days (13 months, as OpenSEO keeps AI runs).

### 6.2 Server modules

All under `src/lib/explore/` (TypeScript, relative imports with extensions) plus shared schemas in `src/shared/explore.ts`.

#### `src/shared/explore.ts` (PORT of `ai-search.ts:156-243`, `prompt-explorer-labels.ts`)

```ts
export const EXPLORE_MAX_PROMPT_LENGTH = 500;
export const EXPLORE_MAX_BRAND_LENGTH = 100;
export const EXPLORE_MODELS = ["chatgpt", "gemini", "perplexity"] as const;   // our engine names
export type ExploreModel = (typeof EXPLORE_MODELS)[number];
export const EXPLORE_MODEL_LABELS: Record<ExploreModel, string> = { chatgpt: "ChatGPT", gemini: "Gemini", perplexity: "Perplexity" };
export const EXPLORE_MODEL_SLUG: Record<ExploreModel, "chat_gpt" | "gemini" | "perplexity"> =
  { chatgpt: "chat_gpt", gemini: "gemini", perplexity: "perplexity" };
export const exploreModelSchema = z.enum(EXPLORE_MODELS);
export const exploreCountrySchema = z.enum(WEB_SEARCH_COUNTRY_CODES);          // src/shared/web-search-countries.ts (F02)
export const exploreRunInputSchema = z.strictObject({
  prompt: z.string().trim().min(1).max(EXPLORE_MAX_PROMPT_LENGTH),
  models: z.array(exploreModelSchema).min(1).max(3).transform((m) => [...new Set(m)]),
  webSearch: z.boolean().default(true),
  country: exploreCountrySchema.nullable().default(null),
  highlightBrand: z.string().trim().min(1).max(EXPLORE_MAX_BRAND_LENGTH).nullable().default(null),
  fresh: z.boolean().default(false),
});
export const exploreCitationSchema = z.looseObject({ url: z.string(), domain: z.string().nullable(), title: z.string().nullable(), matchedBrand: z.boolean() });
export const exploreModelResultSchema = z.discriminatedUnion("status", [
  z.looseObject({ status: z.literal("success"), model: exploreModelSchema, label: z.string(), route: z.enum(["dataforseo","openrouter"]),
    modelName: z.string().nullable(), text: z.string(), truncated: z.boolean(), citations: z.array(exploreCitationSchema),
    fanOutQueries: z.array(z.string()), fanOutReported: z.boolean(), brandMentioned: z.boolean().nullable(),
    workspaceBrandMentioned: z.boolean().nullable(), outputTokens: z.int().min(0).nullable(), webSearch: z.boolean().nullable(),
    countryHint: exploreCountrySchema.nullable(), costUsd: z.number().min(0).nullable(), costState: z.enum(["measured","unknown","reused"]),
    reusedFrom: z.looseObject({ runId: z.uuid(), observedAt: z.iso.datetime() }).nullable(), observationId: z.string(), observedAt: z.iso.datetime() }),
  z.looseObject({ status: z.literal("pending"), model: exploreModelSchema, label: z.string() }),
  z.looseObject({ status: z.literal("error"), model: exploreModelSchema, label: z.string(),
    errorCode: z.enum(["UNSUPPORTED_COUNTRY","UPSTREAM_ERROR","NOT_AVAILABLE","BLOCKED","UNKNOWN_COST"]),
    message: z.string(), costUsd: z.number().min(0).nullable() }),
]);
export function exploreModelLabel(m: ExploreModel): string;
export function countryLabel(iso: string): string;           // Intl.DisplayNames(["en"],{type:"region"}) as OpenSEO
export function normalizePromptForHash(p: string): string;   // trim + collapse whitespace; case kept (promptExplorer.ts:330-332)
```

#### `src/lib/explore/routes.ts`

```ts
export type ExploreRoute = { model: ExploreModel; route: "dataforseo" | "openrouter" | null; modelName: string | null;
  reserveUsd: number; skipped: null | "UNSUPPORTED_COUNTRY" | "NOT_AVAILABLE" };
export async function resolveExploreRoutes(i: { models: ExploreModel[]; webSearch: boolean; country: string | null },
  deps: { env; isFeatureEnabled; openCircuitKeys: Set<string>; resolveModel?: typeof resolveLatestLlmModelName }): Promise<ExploreRoute[]>;
```

For each model, in order:
1. If `webSearch && country` and `!supportsWebSearchCountry(EXPLORE_MODEL_SLUG[m], country)` → `skipped: "UNSUPPORTED_COUNTRY"`, `reserveUsd: 0` (no spend, as `promptExplorer.ts:107-122`).
2. `dataforseo` when `isFeatureEnabled("dataforseo_engines")`, `DATAFORSEO_API_KEY` set and the DataForSEO circuit (`circuitIdentity(engine, env, { route: "dataforseo" })`, F02) is not open. `modelName = await resolveLatestLlmModelName(slug)` (free, F02). `reserveUsd = llmResponseUsd(slug, webSearch)` (F03).
3. Else `openrouter` when `isOpenRouterEngineConfigured(m)` and its circuit is closed. `modelName = getOpenRouterEngineModel(m)`. `reserveUsd = Number(env.EXPLORE_OPENROUTER_RESERVE_USD ?? 0.10)` (must be finite, > 0, ≤ 1, else `AppError(500,"explore_config_invalid")`).
4. Else `route: null`, `skipped: "NOT_AVAILABLE"`.

The explorer always uses the **model API** route. Consumer-app scrapers (F02 scan routes) are not used here because they do not report tokens, search use or fan-out (§5).

#### `src/lib/pricing/actions/exploreRun.ts` (F09 registry, §6.2.5 of F09)

```ts
export const exploreRunAction = definePricedAction({
  key: "ai_visibility.explore.run", feature: "ai_visibility.explore", input: exploreQuoteInput, requireApproval: true,
  estimate: estimateExploreRun });
export const exploreQuoteInput = z.strictObject({ prompt: z.string().trim().min(1).max(500),
  models: z.array(exploreModelSchema).min(1).max(3), webSearch: z.boolean(), country: exploreCountrySchema.nullable(),
  fresh: z.boolean().default(false) });
export async function estimateExploreRun(ctx: PricingContext, input, deps?: ExploreQuoteDeps): Promise<…>;
```

`src/lib/pricing/actions/index.ts` gains `import "./exploreRun.ts";`.

`estimateExploreRun` steps:
1. `routes = await resolveExploreRoutes({ models, webSearch, country }, { env: ctx.env, isFeatureEnabled, openCircuitKeys })`; `reuse = fresh ? new Map() : findReusable(ctx.admin, brandKey, promptHash, routes, webSearch, country, reuseDays)` (§6.2 service).
2. Lines, one per selected model, in the selected order:
   - reused: `{ label: "{Model} · reused answer from {date}", quantity: 1, unitUsd: 0, totalUsd: 0 }` (date `d MMM yyyy`, workspace-local formatting done by the client; the server sends ISO in `units`).
   - skipped: `{ label: "{Model} · skipped ({reason text})", quantity: 0, unitUsd: 0, totalUsd: 0 }` with reason text "not available for {Country}" or "not available yet".
   - to ask: `{ label: "{Model} · up to {formatUsd(reserveUsd)}", quantity: 1, unitUsd: reserveUsd, totalUsd: reserveUsd }`.
3. `totalUsd = fromMicros(Σ toMicros(line.totalUsd))`; `expectedUsd = null` (no history-based typical cost in v1); `units = [{ key: "models", label: "models", count: toAsk }, { key: "reused", label: "reused answers", count: reused }]`.
4. Blocked:
   - `no_models_available` when no model can be asked or reused: "None of the selected models can answer right now. Choose another model or try again later."
   - `collection_paused` when `probe_dispatch_control.paused` and `brandKey` is not in `brand_allowlist` and at least one model must be asked: "Answer collection is paused for maintenance, so this question cannot be asked now." recovery "Try again later."
5. Warnings: `cost_note` (always when asking): "You pay only the provider's charge for each answer, up to this amount." `no_search_note` when `webSearch` is false: "Models will answer from memory and will not cite sources."

#### `src/lib/explore/shape.ts` (PORT of `promptExplorer.ts:198-332`)

`extractText(result)`, `extractCitations(result)` (≤ 25, safe URLs), `mentionRegex(brand)`, `computeBrandMentioned(text, citations, brand)`, `matchesBrand(url, title, brand)`, `toModelResult(observation, run, workspace)` → `ExploreModelResult`:
- `text` = `observation.result.answer_markdown ?? observation.result.text` (DataForSEO keeps markdown separately; OpenRouter text is already markdown) sliced to 24,000 chars (`truncated` when longer, OpenSEO `aiVisibilityResults.ts:205` limit).
- `citations` from `observation.result.references` (`href`, `title`), `matchedBrand` = `matchesBrand(url, title, highlight)`.
- `fanOutQueries` = `result.fan_out_queries` (≤ 20); `fanOutReported` = `route === "dataforseo"` (OpenRouter does not report them).
- `brandMentioned` = `computeBrandMentioned(result.text, citations, brand)` on the plain `result.text` (never the markdown) with `brand = run.highlight_brand ?? workspace.display_name`; `workspaceBrandMentioned` = `result.brand_mentioned_in_text || result.brand_cited` (our entity resolution with aliases, from `probeTextEngine`).
- `outputTokens` = `round(result.output_tokens)` (DataForSEO) or `result.usage.completion_tokens` (OpenRouter), else `null`.
- `webSearch` = `result.web_search` (DataForSEO) or `result.search_requests > 0` (OpenRouter; `null` when unknown).
- `costUsd` = `observation.total_cost` when `unknown_cost_calls = 0`; `costState` `measured`, or `unknown` with `costUsd: null`.
- Failed observation → `{ status: "error", errorCode: "UPSTREAM_ERROR", message: "This model could not answer. Please try again.", costUsd }` with `costUsd` = charged cost (0 when unbilled). Blocked → `BLOCKED` "This model is temporarily unavailable. You were not charged.". Ambiguous or leased past expiry → `UNKNOWN_COST` "This answer did not arrive, and the provider may have charged for it. Perceev will reconcile it."

#### `src/lib/explore/service.ts`

```ts
export async function startExploreRun(ws: Workspace, body: StartExploreBody, deps?: ExploreDeps): Promise<{ runId: string; jobId: string | null; status: "queued" | "completed"; pollAfterSeconds: number | null }>;
export async function getExploreRun(ws: Workspace, runId: string, deps?): Promise<ExploreRunView>;
export async function listExploreRuns(ws: Workspace, q: { limit: number; cursor?: string }, deps?): Promise<{ runs: ExploreRunSummary[]; nextCursor: string | null }>;
export async function trackExploreQuestion(ws: Workspace, runId: string, deps?): Promise<{ questionId: string; created: boolean; status: string }>;
export function findReusable(admin, brandKey: string, promptHash: string, routes: ExploreRoute[], webSearch: boolean, country: string | null, days: number): Promise<Map<ExploreModel, { observationId: string; runId: string; observedAt: string }>>;
export function explorePromptHash(prompt: string): string;   // sha256 hex of normalizePromptForHash
```

`startExploreRun` order (each step refuses before anything is written):
1. `isFeatureEnabled("prompt_explorer", brandKey)` false → `AppError(403,"feature_disabled","Prompt Explorer is not enabled for this workspace.")`.
2. Body validated (`exploreRunInputSchema` plus `maxUsd: z.number().positive().max(1000).optional()`).
3. `checkExploreRateLimits(admin, { brandKey, userId, now, env })` (`src/lib/explore/rateLimit.ts`): count `explore_runs` for the user in the last 3,600 s and for the workspace since UTC midnight. Over limit → `AppError(429,"explore_rate_limited","You have asked a lot of questions recently. Try again in {n} minutes.", { recovery: "Wait, then ask again.", details: { retryAfterSeconds } })` (workspace-day message: "This workspace has reached today's limit of {n} questions. Try again tomorrow."). An active run for the same user (`status IN ('queued','running')`) → `AppError(409,"explore_already_running","Your previous question is still being answered.", { details: { activeRunId } })`.
4. `q = await quote("ai_visibility.explore.run", ctx, quoteInput)`. If `q.blocked` → `AppError(409, q.blocked.code, …)`. If `q.totalUsd === 0` (every model reused or skipped) → no approval and no hold. Else `requireApprovedPrice("ai_visibility.explore.run", ctx, quoteInput, body.maxUsd)` (F09) → `approvedMaxUsd`.
5. `runId = crypto.randomUUID()`. If `totalUsd > 0`: `reserveSpend({ brandKey, feature: "ai_visibility.explore", estimateUsd: q.totalUsd, maxUsd: approvedMaxUsd, idempotencyKey: "explore:" + runId, ttlSeconds: 1800, subject: { kind: "explore_run", id: runId } })`.
6. Insert `explore_runs` (`plan` = `ExplorePlan[]`: `{ model, route, modelName, reserveUsd, skipped, reusedFrom: { observationId, runId, observedAt } | null, observationId }`, where `observationId = hashIdentity({ exploreRunId: runId, model })` from `src/lib/db/probeDispatch.js:30-34`). If no model needs asking, insert with `status = 'completed'`, `finished_at = now()` and return `{ status: "completed", jobId: null, pollAfterSeconds: null }`.
7. `enqueueJob("explore.run", { runId }, { brandKey, trigger: "manual", singleActiveKey: "explore:" + brandKey + ":" + userId, createdBy: userId })`; on `job_already_running` → release the hold (`releaseSpend(hold, "explore_already_running")`), delete the run row, rethrow as 409. Update `explore_runs.job_id`.
8. `recordApproval(admin, { brandKey, action: "ai_visibility.explore.run", approvedMaxUsd, quote: q, source, subject: { kind: "explore_run", id: runId }, approvedBy: userId })` (F09; a failure is logged `[explore] approval record failed {runId}` and does not fail the run).
9. Telemetry `prompt_explorer:run_started { models: n, reused: r, web_search: bool, has_country: bool }`.

`findReusable`: `select id, context->>'explore_run_id', observed_at, config_version from probe_observations where purpose='explore' and brand_key=$1 and engine=$2 and context->>'prompt_hash'=$3 and state='answered' and observed_at > now() - $days and context->>'web_search'=$4 and coalesce(context->>'country','')=$5 and context->>'model_name'=$6 and context->>'route'=$7 order by observed_at desc limit 1` per model (one query per model; at most 4).

`getExploreRun`: run by `id` and `brand_key` (else 404); observations by `context->>'explore_run_id'` and `brand_key`; reused observations by id **and** the same `brand_key`; results in `models` order via `toModelResult`; `status` from the run; `pollAfterSeconds = status in ('queued','running') ? 3 : null`; `costUsd = { known: Σ measured, unknownModels: n }`.

`trackExploreQuestion`: requires the run; calls F08's `addWorkspaceQuestion(admin, { brandKey, text: run.prompt, origin: "manual", createdBy: userId, sourceRef: { kind: "explore_run", id: runId } })` imported from `src/lib/questions/workspaceQuestions.ts` (conventions §5.3; never a local copy) (F08 owns de-duplication by `text_normalized` and revival of archived questions); stores `explore_runs.question_id`; telemetry `prompt_explorer:question_tracked {}`; returns `{ questionId, created, status }`. F08 errors pass through (for example its question-limit code).

#### `src/lib/explore/job.ts`

```ts
defineJob<{ runId: string }>("explore.run", runExploreJob,
  { payloadSchema: z.strictObject({ runId: z.uuid() }), pollAfterSeconds: 3, deadlineSeconds: 900, maxInvocations: 6 });
export async function runExploreJob(ctx: JobContext<{ runId: string }>, deps?: ExploreJobDeps): Promise<JobResult>;
```

Steps (step configs from F01 `stepConfigs.ts`):

| Step | Config | Does |
|---|---|---|
| `prepare` | `DB_STEP` | Load run (status `queued`/`running`, else finish as is). Set `running`. `seed_explore_observations` for every plan entry with `route !== null && !skipped && !reusedFrom`: `{ id: observationId, purpose: "explore", engine: model, query: run.prompt, brand_key, context: { explore_run_id, brand_key, prompt_hash, route, model_name, web_search, country, max_output_tokens: 4096 }, ...dispatchIdentity(model, env, { route, model: modelName }), deadline_at: now + 15 min }`. Returns the list of observation ids to ask. |
| `ask` | `{ retries: 0, timeoutMs: 220_000, billed: true }` (F01 `LONG_PAID_STEP`) | For all ids concurrently (`Promise.allSettled`): `store.claim(id, { reserve: entry.reserveUsd, scanCap: run.approved_max_usd, dayCap: dispatchBudget(env).dayCap, leaseSeconds: 180 })`. Not granted → nothing else (the row is `blocked`/`failed` by SQL). Granted → F02's `withLeaseRenewal(store, id, token, 180, () => askModel(entry, run, ws, { deadlineAt: now + 150_000, captureEvidence }))` → `probeTextEngine`-style post-processing (brand aliases from `getBrandAliases(display_name, website)`, competitors from F07 `project_competitors` names when present, else `[]`) → `store.finish(id, token, result, decision)` where `decision.state` is `answered` when the result has an answer, else `failed` (**never `retry`**; F11-AC-10). Returns `[{ model, state }]`. |
| `finalize` | `DB_STEP` | Rows still `leased` with `lease_until < now` are touched with one `store.claim(id, {...})` call, which converts them to `ambiguous` (`035:19-23`); no request is made. Run status: `completed` when every plan entry is answered, reused or skipped for country; `failed` when none answered and none reused; else `partial`. Update `explore_runs.status`, `finished_at`. |
| `settle` | `DB_STEP` | `settle_explore_hold(runId)`. |

`askModel` adapters: `route === "dataforseo"` → F02 `probeDataforseoModel(model, prompt, { model: modelName, webSearch, countryIso: webSearch ? country : null, maxOutputTokens: 4096, measurementContext: { country: (country ?? "in").toLowerCase(), language: "en" }, deadlineAt, captureEvidence })`; `route === "openrouter"` → `probeOpenRouterEngine({ engine: model, query: prompt, model: modelName, durableDispatch: true, deadlineAt, measurementContext: { country: (country ?? "in").toLowerCase() }, captureEvidence, webSearch })`. `openRouterProbe.js` gains an option `webSearch = true`; when false it omits `tools` and `max_tool_calls` (one condition at `:164-174`).

Telemetry at the end: `prompt_explorer:run_finished { status, answered, failed, reused }`.

#### `src/lib/explore/jobs.ts` (periodics, imported from `src/lib/jobs/kinds.ts`)

- `definePeriodic({ name: "explore.settle", everySeconds: 300, run })` → system job `explore.settle` → `settle_finished_explore_holds(50)` (DB_STEP). Covers runs whose job died before its `settle` step.
- `definePeriodic({ name: "explore.retention", everySeconds: 86400, run })` → system job `explore.retention` → `prune_explore_runs(now − 395 days, 1000)` looped up to 20 times while 1,000 rows were deleted.

#### Registrations

- `src/lib/features/names.ts`: `prompt_explorer: { spend: ["ai_visibility.explore"] as const }`.
- `src/shared/spend-features.ts`: `ai_visibility.explore` already present (F03); `SPEND_FEATURES` in the spend union gains `"ai_visibility.explore"` if F03 has not added it.
- Event names use F26's `area:action` form. F26 adds the calls directly (F26 §6.2.7, no sink module).
- `src/lib/telemetry/events.ts` (F26): `prompt_explorer:run_started`, `prompt_explorer:run_finished`, `prompt_explorer:question_tracked` with the properties above.
- `src/lib/query/keys.ts`: `exploreKeys = { runs: (brandKey) => ["explore", brandKey, "runs"], run: (brandKey, runId) => ["explore", brandKey, "run", runId] }`.
- `src/components/app/navigation/items.ts`: AI Visibility → "Prompt Explorer", path `/portal/explore`, icon `MessagesSquare`, `visibleWhen: (features) => features.prompt_explorer === true`.
- `src/app/api/customer/overview/route.js`: `features.prompt_explorer = await isFeatureEnabled("prompt_explorer", brandKey)` (additive, next to F09's `price_review`).

### 6.3 Jobs

| Kind | Trigger | Steps | Retries / billed | Completion |
|---|---|---|---|---|
| `explore.run` | manual (route) | `prepare` → `ask` → `finalize` → `settle` | `ask` billed, retries 0; others DB_STEP | `completed` with `{ runId, status }`; `ask` interrupted by a crash → `billed_step_interrupted`, the handler catches `StepFailedError`, runs `finalize` and `settle`, and returns `partial` |
| `explore.settle` | periodic 300 s (system) | `settle` | DB_STEP | `completed` `{ settled }` |
| `explore.retention` | periodic daily (system) | `prune-1`…`prune-20` | DB_STEP | `completed` |

`deadlineSeconds: 900` and `maxInvocations: 6`; the F01 watchdog fails a stuck run (`deadline_exceeded`), and `explore.settle` then settles its hold.

### 6.4 Provider calls and cost

| Route | Endpoint | Body | Fields used | Reservation per model | Spend accounting |
|---|---|---|---|---|---|
| DataForSEO | `POST /v3/ai_optimization/{slug}/llm_responses/live` (F02 `fetchLlmResponse`) | `{ user_prompt, model_name, web_search, force_web_search (claude, when web search), max_output_tokens: 4096, web_search_country_iso_code (when web search and country, not gemini) }` | `model_name, output_tokens, web_search, items[].sections[].text/annotations, fan_out_queries`, task `cost` | F03 `llmResponseUsd(slug, webSearch)`: chat_gpt 0.09/0.05, claude 0.18/0.08, gemini 0.11/0.05, perplexity 0.04/0.04 | `probe_attempts.charged_usd` = task cost (`cost_source: "gateway"`) → ledger `provider_reported` |
| OpenRouter | `POST {LLM_BASE_URL}/chat/completions` (existing `probeOpenRouterEngine`) | existing body; `tools` omitted when web search is off | text, annotations, `usage.cost`, `usage.completion_tokens`, `server_tool_use.web_search_requests` | `EXPLORE_OPENROUTER_RESERVE_USD` (default 0.10) | `usage.cost` (gateway) → `provider_reported`; unpriced → unknown |
| Model catalogue | `GET /v3/ai_optimization/{slug}/llm_responses/models` | — | names | free | — |

No answer is cached in `provider_cache`: the reuse rule reads earlier explore observations of the same workspace (§6.2), so reused answers keep their evidence and privacy rules. Fixtures: `tests/fixtures/f11/llm-responses-chatgpt.json`, `llm-responses-claude-no-search.json` (`web_search: false`, no annotations), `openrouter-claude.json` (text, annotations, usage with cost), `annotations-dupes-unsafe.json` (port of `promptExplorer.test.ts:68-100` input), all text neutral.

### 6.5 API routes

All routes: `requireWorkspace` (F01), `toErrorResponse`, `Cache-Control: no-store`, contracts in `src/lib/explore/explore.contract.ts` (`z.strictObject` requests, `z.looseObject` responses).

**Price:** `POST /api/customer/price/estimate` (F09) with `{ "action": "ai_visibility.explore.run", "input": { "prompt": "best oversized t-shirts in india", "models": ["chatgpt","gemini"], "webSearch": true, "country": "IN", "fresh": false } }` → 200:

```json
{ "action": "ai_visibility.explore.run", "currency": "USD", "totalUsd": 0.09, "expectedUsd": null,
  "units": [ { "key": "models", "label": "models", "count": 2 }, { "key": "reused", "label": "reused answers", "count": 0 } ],
  "lines": [ { "label": "ChatGPT · up to $0.09", "quantity": 1, "unitUsd": 0.09, "totalUsd": 0.09 },
             { "label": "Gemini · skipped (not available for India)", "quantity": 0, "unitUsd": 0, "totalUsd": 0 } ],
  "monthly": null,
  "warnings": [ { "code": "cost_note", "message": "You pay only the provider's charge for each answer, up to this amount." } ],
  "blocked": null, "priceVersion": "2026-10-21.1", "quotedAt": "2026-10-22T09:30:00.000Z", "inputsHash": "<64 hex>" }
```

**`POST /api/customer/explore`** (auth: workspace; members and owners). File `src/app/api/customer/explore/route.ts`.

```ts
const body = z.strictObject({
  brand_key: z.string().min(1).max(200).optional(),
  prompt: z.string().trim().min(1).max(500),
  models: z.array(z.enum(["chatgpt","gemini","perplexity"])).min(1).max(3),
  webSearch: z.boolean().default(true),
  country: z.string().regex(/^[A-Z]{2}$/).nullable().default(null),
  highlightBrand: z.string().trim().min(1).max(100).nullable().default(null),
  fresh: z.boolean().default(false),
  maxUsd: z.number().positive().max(1000).optional(),
});
const response = z.looseObject({ runId: z.uuid(), jobId: z.uuid().nullable(),
  status: z.enum(["queued","completed"]), pollAfterSeconds: z.int().min(1).max(60).nullable() });
```

202 example: `{ "runId": "8d0c3f9e-2b1a-4c5d-9e8f-1a2b3c4d5e6f", "jobId": "5b0d6f6e-9a8b-4a45-9a51-0e7e8f1c2d3a", "status": "queued", "pollAfterSeconds": 3 }`. 200 when every model was reused: `{ "runId": "…", "jobId": null, "status": "completed", "pollAfterSeconds": null }`.

Errors:

| Status | Code | Message |
|---|---|---|
| 400 | `invalid_request` / `invalid_json` | F01 copy |
| 400 | `approval_required` | F09 copy ("Review and approve the price before running this.") |
| 401/403/404/503 | from `requireWorkspace` | F01 copy |
| 403 | `feature_disabled` | "Prompt Explorer is not enabled for this workspace." |
| 409 | `price_changed` | F09 copy, `details.quote`, `details.approvedMaxUsd` |
| 409 | `collection_paused` | "Answer collection is paused for maintenance, so this question cannot be asked now." |
| 409 | `no_models_available` | "None of the selected models can answer right now. Choose another model or try again later." |
| 409 | `explore_already_running` | "Your previous question is still being answered." (`details.activeRunId`) |
| 429 | `explore_rate_limited` | as §6.2 (`details.retryAfterSeconds`) |
| 402 | `daily_cap` / `workspace_cap` | F01 copy |
| 503 | `spend_unavailable` | F01 copy |

Idempotency: one active run per user (single-active key); a double click gets 409 `explore_already_running` and creates nothing.

**`GET /api/customer/explore?brand_key=&limit=20&cursor=`** → `{ runs: [{ runId, prompt, models, status, createdAt, questionId }], nextCursor }`. `limit` 1–50 (default 20), newest first; `cursor` = ISO `created_at` of the last row. Errors: workspace errors; 400 `invalid_request`.

**`GET /api/customer/explore/[runId]?brand_key=`** → `ExploreRunView`:

```json
{ "runId": "8d0c3f9e-2b1a-4c5d-9e8f-1a2b3c4d5e6f", "status": "completed", "pollAfterSeconds": null,
  "prompt": "best oversized t-shirts in india", "highlightBrand": "Offcult", "webSearch": true, "country": "IN",
  "createdAt": "2026-10-22T09:30:05.000Z", "finishedAt": "2026-10-22T09:30:41.000Z",
  "approvedMaxUsd": 0.27, "cost": { "knownUsd": 0.1031, "unknownModels": 0 }, "questionId": null,
  "results": [
    { "status": "success", "model": "chatgpt", "label": "ChatGPT", "route": "dataforseo", "modelName": "gpt-5.6-luna",
      "text": "Popular choices include …", "truncated": false,
      "citations": [ { "url": "https://www.example.in/oversized", "domain": "www.example.in", "title": "Oversized tees", "matchedBrand": false } ],
      "fanOutQueries": [ "oversized t-shirt brands india", "heavyweight tee india price" ], "fanOutReported": true,
      "brandMentioned": false, "workspaceBrandMentioned": false, "outputTokens": 812, "webSearch": true, "countryHint": "IN",
      "costUsd": 0.0611, "costState": "measured", "reusedFrom": null, "observationId": "3f1e…", "observedAt": "2026-10-22T09:30:29.000Z" },
    { "status": "error", "model": "gemini", "label": "Gemini", "errorCode": "UNSUPPORTED_COUNTRY",
      "message": "Gemini doesn’t support country selection. Select “No country preference” above, then run again to include Gemini.", "costUsd": 0 }
  ] }
```

Errors: 404 `explore_run_not_found` "This question does not exist in this workspace." (also for other workspaces); workspace errors. Poll: clients refetch only while `status` is `queued`/`running`, every `pollAfterSeconds`.

**`POST /api/customer/explore/[runId]/track`** body `z.strictObject({ brand_key: z.string().min(1).max(200).optional() })` → 200 `{ "questionId": "c4a1…", "created": true, "status": "active" }`. Errors: 404 `explore_run_not_found`; F08 errors pass through; 403 `cross_site`.

### 6.6 UI

Route `src/app/portal/explore/page.tsx` (client component inside the F04 shell). Components under `src/components/portal/explore/`: `ExplorePage.tsx`, `ExploreForm.tsx` (PORT `PromptExplorerForm.tsx`), `ExploreResults.tsx` (PORT `PromptExplorerResults.tsx`), `ExploreLoadingState.tsx` (PORT), `RecentQuestions.tsx`, `TrackQuestionButton.tsx`, `engineAccents.ts` (COPY of `platformLabels.ts:13-35` accents for our four model names), `hooks/useExplore.ts`. Shared: `src/components/app/markdown/MarkdownAnswer.tsx` (PORT `MarkdownAnswer.tsx`; F12 reuses it). Primitives from F04: `PageHeader`, `Card`, `Field`/`FieldLabel`/`FieldDescription`, `Textarea`, `Input`, `Checkbox`, `Label`, `Combobox`, `Tooltip`, `Button`, `Badge`, `Alert`, `Skeleton`, `EmptyState`, `Collapsible`. Price dialog: F09 `CostReviewDialog` with `usePriceQuote`.

**Layout:** `PageHeader` title "Prompt Explorer", description "Ask one question across ChatGPT, Gemini and Perplexity and compare their answers, sources and searches." Below: form card; then either the active run's results or "Recent questions".

**URL state:** `/portal/explore?run=<runId>`. Loading a URL with `run` shows that run and prefills the form from it; it **never** starts a run. No other query parameters. "New question" (ghost button above results) clears `run` and the form.

**Form (exact copy):**
- "Question" textarea, 3 rows, counter `{n}/500` (destructive colour over 500), helper "What your buyers might ask AI."
- "Highlight brand (optional)" input, placeholder = workspace display name, helper "We flag whether each answer names this brand. Your own brand and its aliases are always checked."
- "Models": three checkboxes (ChatGPT, Gemini, Perplexity). Under a model that is skipped for the chosen country: "Skipped for {Country}". Under a model with no route: "Not available yet".
- Row: checkbox "Allow web search"; combobox (aria-label "Web search country", placeholder "Search countries", first item "No country preference", default = the workspace panel's country in ISO upper case when present, else "No country preference"; disabled when web search is off; empty text "No supported countries match."); info tooltip "A country guides web search when a model supports it. Models may answer without searching. Leave it unset to run all selected models."
- Submit button "Ask {n} model" / "Ask {n} models" (n = selected models that are not skipped), disabled when n = 0.
- Validation (role="alert"): "Enter a question", "Keep questions under 500 characters", "Keep the brand under 100 characters", "Select at least one model".

**Price first:** submit opens `CostReviewDialog` (title "Ask {n} models", confirm "Ask now", pending "Asking…", detail = the quote lines). If the quote's `totalUsd` is 0 (all reused), no dialog opens and the run starts immediately. On `409 price_changed` the dialog shows F09's "The price changed" state.

**States:**

| State | What renders |
|---|---|
| Feature disabled | `EmptyState` title "Prompt Explorer is not enabled for this workspace", body "Ask your Perceev contact to turn it on." No form. |
| Idle, no run | Form; `RecentQuestions` card "Recent questions": rows with question (one line, ellipsis), model labels, local date-time, status badge; click → `?run=`. Empty: `EmptyState` icon `MessageSquare`, title "Ask a question to compare model answers", three bullets: "Four models side by side — Ask ChatGPT, Claude, Gemini and Perplexity at once and compare their answers." · "See what the models cite — Every answer lists the sources it used." · "Check your brand — See whether each answer names your brand." |
| Recent list loading | `Skeleton` × 3 rows |
| Recent list error | `Alert` destructive "Could not load recent questions." + "Retry" |
| Starting | Dialog in F09 "Starting" state |
| Running | Meta line "Asking {n} models… This usually takes under a minute." with `aria-live="polite"`; one `ExploreLoadingState` card per asked model (named, `aria-busy="true"`); reused models render their card immediately with a "Reused" badge |
| Completed | Results header: the question (`whitespace-pre-wrap`), meta "Asked {date time} · Web search {on/off} · Country hint: {Country or 'none'} · Cost {formatUsd(known)}{ ' + unknown' when unknownModels > 0 }"; `TrackQuestionButton` at the right; one card per selected model in selection order |
| Partial | as Completed, failed cards in error style; banner `Alert` warning "{k} of {n} models could not answer." |
| Failed run | `Alert` destructive "None of the models could answer this question." + "Ask again" (re-opens the dialog with `fresh: true`) |
| Rate limited (429) | `Alert` warning with the API message; submit disabled until `retryAfterSeconds` passes (countdown "Try again in {m}:{ss}") |
| Load error (GET run) | `Alert` destructive "Could not load this question." + "Retry"; stale data stays visible on refresh failures |

**Model card (PORT `ModelResultCard`):** `article` with left border accent (ChatGPT emerald, Gemini sky, Perplexity violet) and header row: accent dot, model label (h3), model name in `code`, badges:
- `Error` (destructive) / `Skipped` (secondary) / `Reused` (secondary, tooltip "Reused answer from {date}. Ask again to get a new one.")
- brand badge: success "{brand}" with check icon, or secondary "no {brand}" with x icon (brand = highlight or workspace name)
- search indicator: globe icon + "web search" / "no web search" (muted); nothing when unknown
- right side: "{n} tokens" (tabular) and cost "{formatUsd(costUsd)}" or "Cost unknown"
Body: country line ("Country hint sent: {Country}. This is not a verified search location." / "No country hint sent. Any search uses the provider’s default location."); `MarkdownAnswer` (collapsed at 240 px, "Read more"/"Show less", "Model Thinking" blocks, "Model returned an empty response."); `truncated` → muted "This answer was shortened for display."; "Cited sources ({n})" with the first 3 and "+{n} more" / "Show less"; each source a link (`target="_blank" rel="noreferrer"`, http/https only) showing title or URL, with a brand badge when `matchedBrand`; "Related queries the model considered" outline badges; when `fanOutReported` is false: muted "This provider does not report the searches the model ran." Footer (muted, small): "Answered by {label} through {DataForSEO|OpenRouter} (model API)". Error card body: the `message`, plus for `UPSTREAM_ERROR` the cost line "You were charged {formatUsd(costUsd)} for this attempt." when `costUsd > 0`, else "You were not charged for this model."

**Track button:** idle "Track this question" (outline, icon `Plus`); pending "Tracking…" (spinner); success "Tracked" (disabled, icon `Check`) with link "View history" → `/portal/questions/{questionId}` (F12) and toast (`sonner`) "Added to your questions. Review them before your next scan."; when `questionId` is already set on load: "Tracked" + "View history"; error: toast destructive with the API message.

**Data fetching:** `useQuery({ queryKey: exploreKeys.run(brandKey, runId), refetchInterval: (q) => q.state.data?.pollAfterSeconds ? q.state.data.pollAfterSeconds * 1000 : false, staleTime: (q) => (q.state.data?.pollAfterSeconds ? 0 : Infinity), retry: false, refetchOnWindowFocus: false })`. Recent runs: `staleTime: 30_000`. Start: `useMutation` → on success `navigate("?run=" + runId)` and invalidate `exploreKeys.runs`. Track: `useMutation` → invalidate the run.

**Accessibility:** form fields have labels; validation in `role="alert"`; result cards are `article` with the model name as heading; loading cards `aria-busy`; badges contain text, not colour alone; external links announce "(opens in a new tab)" via visually hidden text.

**Phone (< 640 px):** form fields stack; model checkboxes wrap in two columns; country combobox full width; cards full width with header badges wrapping; the price dialog uses F04's full-screen sheet; `RecentQuestions` rows show question and date only.

### 6.7 Permissions, privacy, observability

- Members and owners can ask, read their workspace's runs, and track. Every run records `created_by`; one active run per user; limits per user and per workspace.
- Paid feature: `FEATURE_PROMPT_EXPLORER` plus an enabled `paid_feature_controls('ai_visibility.explore')` row (F01); both off in production by default.
- Prompts and answers are workspace data: readable only through service-role routes after `requireWorkspace`, filtered by `brand_key`. `explore_runs` has a tenant read policy. Evidence captures (raw provider JSON) follow the 90-day private rule; F11 shows no raw-capture link (F12 does).
- Never logged: prompt, highlight brand, answer text, citations, fan-out queries, provider bodies. Allowed log lines: `[explore] approval record failed {runId}`, `[explore] ask failed {runId, model, code}`, `[explore] settle failed {runId}`.
- Telemetry (F26): `prompt_explorer:run_started { models, reused, web_search, has_country }`, `prompt_explorer:run_finished { status, answered, failed, reused }`, `prompt_explorer:question_tracked {}`. No text properties.

## 7. Code reuse map

| OpenSEO source | Perceev target | Mode | Adaptation notes |
|---|---|---|---|
| `openseo:src/server/features/ai-search/services/promptExplorer.ts:53-94` | `src/lib/explore/job.ts` (`ask` step) | PORT | `allSettled` per model and de-duplication kept; each model is a claimed explore observation, not a direct metered call; no in-request execution (F01 job). |
| `openseo:src/server/features/ai-search/services/promptExplorer.ts:104-182` | `src/lib/explore/routes.ts`, `service.ts` (`findReusable`) | PORT | Country skip copy kept. 7-day cache becomes reuse of the workspace's own explore observations (keeps evidence/privacy rules); key fields kept (model name, normalised prompt, web search, country). **Paid "no search" retry dropped** (conventions §6.4). |
| `openseo:src/server/features/ai-search/services/promptExplorer.ts:198-359` (+ `promptExplorer.test.ts:52-100`) | `src/lib/explore/shape.ts` (+ `shape.test.ts`) | PORT | Same extraction and brand-match logic; adds our alias-based `workspaceBrandMentioned`; error mapping uses our P0 states. |
| `openseo:src/server/features/ai-search/services/access.ts` | `src/lib/explore/service.ts` step 1 | PATTERN | Paid-plan gate → feature flag + `paid_feature_controls`. |
| `openseo:src/serverFunctions/ai-search.ts:19-24` | `src/app/api/customer/explore/route.ts` | PORT | Server function → JSON route with `requireWorkspace`; async job instead of a synchronous call. |
| `openseo:src/types/schemas/ai-search.ts:156-243` | `src/shared/explore.ts` | PORT | Model names are our engine names; `pending` and extra error codes added; country `null` instead of `"default"`. |
| `openseo:src/types/schemas/ai-search.ts:270-303` | `/portal/explore?run=` | PATTERN | URL keeps only the run id, so a shared link never triggers a paid call. |
| `openseo:src/shared/prompt-explorer-labels.ts` | `src/shared/explore.ts` (`exploreModelLabel`, `countryLabel`) | COPY | — |
| `openseo:src/client/features/ai-search/PromptExplorerPage.tsx` | `src/components/portal/explore/ExplorePage.tsx` | PORT | Plan gate → feature state; search tabs and localStorage history → server "Recent questions"; price dialog added. |
| `openseo:src/client/features/ai-search/components/PromptExplorerForm.tsx` | `src/components/portal/explore/ExploreForm.tsx` | PORT | Copy adapted (question, buyers); default country from the panel. |
| `openseo:src/client/features/ai-search/components/PromptExplorerResults.tsx` | `src/components/portal/explore/ExploreResults.tsx` | PORT | Adds cost, reused badge, unreported fan-out note, route footer. |
| `openseo:src/client/features/ai-search/components/PromptExplorerLoadingState.tsx` | `src/components/portal/explore/ExploreLoadingState.tsx` | COPY | — |
| `openseo:src/client/features/ai-search/components/MarkdownAnswer.tsx` | `src/components/app/markdown/MarkdownAnswer.tsx` | COPY | Uses F04's markdown component map; shared with F12. |
| `openseo:src/client/features/ai-search/platformLabels.ts:13-35` | `src/components/portal/explore/engineAccents.ts` | COPY | Keys renamed to our engine names. |
| `openseo:src/client/components/ExpandableList.tsx` | `src/components/app/ExpandableList.tsx` | COPY | Unless F04 already ships it; then reuse F04's. |
| `openseo:src/client/features/ai-search/promptExplorerQuery.ts` | `src/components/portal/explore/hooks/useExplore.ts` | PATTERN | `retry: false`, no focus refetch; polling by `pollAfterSeconds`. |
| `openseo:src/routes/_app/p/$projectId/prompt-explorer.tsx` | `src/app/portal/explore/page.tsx` | PATTERN | Next.js page. |

## 8. Implementation plan

### Phase 1 — Fence and storage

**Goal:** explore observations can be seeded, claimed, finished and accounted inside the P0 fence.

- [ ] **P1.T1 Migrations**
  - [ ] **P1.T1.S1** *Files:* `supabase/migrations/090_f11_explore_dispatch.sql` (§6.1). *Verify:* CI `customer-database` applies all migrations; `node scripts/qa/check-probe-dispatch.mjs` → unchanged pass.
  - [ ] **P1.T1.S2** *Files:* `supabase/migrations/091_f11_explore_runs.sql`, `scripts/setup-supabase.mjs` (required objects), `.github/workflows/ci.yml` (tenant RLS list adds `explore_runs`). *Verify:* CI job green.
- [ ] **P1.T2 DB tests**
  - [ ] **P1.T2.S1** *Files:* `scripts/qa/check-f11-db.mjs` (loopback `_qa` database, pattern `scripts/qa/check-repair-workflows.mjs:13-18`). Groups: `explore-shape` (AC-01, 06), `explore-fence` (AC-02, 03, 05: paused + allowlisted brand granted; paused + other brand blocked; canaries_allowed does not admit explore; run cap counts only same run; missing cap raises; open circuit blocks), `claim-regression` (AC-04: a 12-case matrix executed against a copy of 035's function created as `claim_probe_dispatch_035` inside the test database, comparing JSON results and resulting row states with the new function), `explore-isolation` (AC-11: finish on an explore row writes no `prompt_results`), `explore-ledger` (AC-12), `explore-retention` (AC-20). *Verify:* `node scripts/qa/check-f11-db.mjs` → "ok 6 groups".
- [x] **P1.T3 Store**
  - [x] **P1.T3.S1** *Files:* `src/lib/explore/store.ts` (RPC wrappers `seedExplore`, `listRunObservations`, `findReusable` query, run CRUD), `src/lib/explore/memoryStore.ts` (same semantics for unit tests). *Verify:* `node --test src/lib/explore/store.test.ts` → pass.

**Checkpoint:** CI database job and `check-f11-db.mjs` green; full suite and build green. Completes F11-AC-01…06, 11, 12, 20.

### Phase 2 — Server

**Goal:** the API can quote, start, run, read and list explore questions.

- [ ] **P2.T1 Shared and shaping**
  - [ ] **P2.T1.S1** *Files:* `src/shared/explore.ts`, `src/shared/explore.test.ts`. *Verify:* `node --test src/shared/explore.test.ts` → pass (schema edges: 500/501 chars, 4/5 models, duplicate models collapsed).
  - [ ] **P2.T1.S2** *Files:* `src/lib/explore/shape.ts`, `shape.test.ts`, fixtures `tests/fixtures/f11/*.json`. *Verify:* pass (F11-AC-14).
- [ ] **P2.T2 Routing and price**
  - [ ] **P2.T2.S1** *Files:* `src/lib/explore/routes.ts`, `routes.test.ts`. Cases: DataForSEO chosen when flag on/key set/circuit closed; OpenRouter fallback; country skip for Gemini and for Claude with an unsupported country; `NOT_AVAILABLE`; invalid reserve env. *Verify:* pass.
  - [ ] **P2.T2.S2** *Files:* `src/lib/pricing/actions/exploreRun.ts`, `exploreRun.test.ts`, `src/lib/pricing/actions/index.ts` (one import). *Verify:* `node --test src/lib/pricing/actions/exploreRun.test.ts` → pass (F11-AC-07; 0.09 + 0.18 = 0.27 exactly via micros; reused line $0; blocked copy exact).
- [ ] **P2.T3 Service, job, limits**
  - [ ] **P2.T3.S1** *Files:* `src/lib/explore/rateLimit.ts`, `rateLimit.test.ts`. *Verify:* pass (F11-AC-09).
  - [ ] **P2.T3.S2** *Files:* `src/lib/explore/service.ts`, `service.test.ts` (memory stores for spend, jobs, explore). Cases: order of refusals with nothing created; all-reused run completes without hold or job; single-active conflict releases the hold and deletes the run; reuse keyed exactly; `fresh` bypasses reuse; no text in logs/telemetry. *Verify:* pass (F11-AC-13, 18).
  - [ ] **P2.T3.S3** *Files:* `src/lib/explore/job.ts`, `job.test.ts`, `src/lib/explore/jobs.ts`, `src/lib/jobs/kinds.ts` (one import line), `src/lib/engines/openRouterProbe.js` (`webSearch` option). Cases: one claim and one call per model; a transient failure is finished `failed`, not retried; claim refusal makes no call; crash during `ask` → `partial` after finalize/settle; expired lease touched to `ambiguous`; `ask` step declared billed with retries 0. *Verify:* `node --test src/lib/explore/job.test.ts` → pass (F11-AC-10).
- [ ] **P2.T4 Routes**
  - [ ] **P2.T4.S1** *Files:* `src/app/api/customer/explore/route.ts` (POST, GET), `src/app/api/customer/explore/[runId]/route.ts` (GET), `src/app/api/customer/explore/[runId]/track/route.ts` (POST, returns 501 `not_available` until phase 3), `src/lib/explore/explore.contract.ts`, `src/lib/explore/explore.route.test.mjs` (hook pattern `src/lib/customerRoutes.test.hooks.mjs`). *Verify:* `node --test src/lib/explore/explore.route.test.mjs src/lib/http/routeContract.test.ts` → pass (F11-AC-08, 15, 19 API half).
  - [ ] **P2.T4.S2** *Files:* `src/lib/features/names.ts`, `.env.example` (`FEATURE_PROMPT_EXPLORER=off`, `EXPLORE_MAX_RUNS_PER_USER_HOUR=10`, `EXPLORE_MAX_RUNS_PER_WORKSPACE_DAY=30`, `EXPLORE_OPENROUTER_RESERVE_USD=0.10`, `EXPLORE_REUSE_DAYS=7`), `src/lib/telemetry/events.ts`, `THIRD_PARTY_NOTICES.md`. *Verify:* `node --test src/lib/features/flags.test.ts src/lib/platform/thirdPartyNotices.test.mjs` → pass.

**Checkpoint:** full suite, typecheck, build, contract test. Completes F11-AC-07…10, 13–15, 18.

### Phase 3 — Page and tracking (requires F04, F05, F08, F09 phase 3 merged)

**Goal:** customers use Prompt Explorer in the portal and can track a question.

- [ ] **P3.T1 Track**
  - [ ] **P3.T1.S1** *Files:* `src/app/api/customer/explore/[runId]/track/route.ts` (calls `trackExploreQuestion`), `service.ts`. *Verify:* route test cases: created true then false on repeat; `question_id` stored; F08 error passthrough (F11-AC-16).
- [ ] **P3.T2 UI**
  - [ ] **P3.T2.S1** *Files:* `src/components/app/markdown/MarkdownAnswer.tsx`, `src/components/app/ExpandableList.tsx` (if F04 lacks it). *Verify:* `npm run build` → exit 0.
  - [ ] **P3.T2.S2** *Files:* `src/components/portal/explore/*` (§6.6), `src/app/portal/explore/page.tsx`, `src/lib/query/keys.ts`, `src/components/app/navigation/items.ts`, `src/app/api/customer/overview/route.js` (`features.prompt_explorer`). *Verify:* `npm run build` → exit 0.
  - [ ] **P3.T2.S3** *Files:* `scripts/qa/check-f11-browser.mjs` (Playwright from `worker/node_modules/playwright`; local app with fixture API responses for estimate, start, run polling, list, track). Scenarios: disabled state; empty state copy; validation messages; price dialog before any POST to `/api/customer/explore` (network log asserts order); running skeletons named per model; completed cards with tokens, web search, brand badges, "+N more" citations, fan-out, unreported fan-out note, skipped Gemini card copy, error card charge copy; partial banner; 429 countdown; track → "Tracked" + "View history" link; loading `?run=` makes no POST; phone viewport 390 px has no horizontal scroll. *Verify:* `node scripts/qa/check-f11-browser.mjs` → "14 passed" (F11-AC-17, 19 UI half).

**Checkpoint:** full suite, build, browser check. Completes F11-AC-16, 17, 19.

## 9. Test plan

| Test file | Cases | ACs |
|---|---|---|
| `scripts/qa/check-f11-db.mjs` | explore-shape, explore-fence, claim-regression, explore-isolation, explore-ledger, explore-retention | 01–06, 11, 12, 20 |
| `src/shared/explore.test.ts` | input schema limits | 08 |
| `src/lib/explore/shape.test.ts` | OpenSEO extraction cases, brand regex, aliases | 14 |
| `src/lib/explore/routes.test.ts` | route choice, skips | 07 |
| `src/lib/pricing/actions/exploreRun.test.ts` | quote lines, totals, blocked | 07 |
| `src/lib/explore/rateLimit.test.ts` | per-user hour, per-workspace day, retryAfter | 09 |
| `src/lib/explore/service.test.ts` | start order, reuse, fresh, no-text logs | 08, 13, 18 |
| `src/lib/explore/job.test.ts` | one claim per model, no retries, crash path | 10, 18 |
| `src/lib/explore/explore.route.test.mjs` | status codes, tenant 404, polling, feature off, track | 08, 15, 16, 19 |
| `src/lib/http/routeContract.test.ts` (F01) | explore contracts open/closed rules | — |
| `scripts/qa/check-f11-browser.mjs` | all UI states | 17, 19 |

Fixtures: `tests/fixtures/f11/` synthetic provider shapes (no live recording). Browser fixtures are JSON API responses built from the §6.5 examples.

## 10. Rollout and rollback

- **Env vars (names only):** `FEATURE_PROMPT_EXPLORER`, `EXPLORE_MAX_RUNS_PER_USER_HOUR`, `EXPLORE_MAX_RUNS_PER_WORKSPACE_DAY`, `EXPLORE_OPENROUTER_RESERVE_USD`, `EXPLORE_REUSE_DAYS`. Reused: `FEATURE_DATAFORSEO_ENGINES`, `DATAFORSEO_API_KEY`, `LLM_API_KEY`, `SCAN_MAX_COST_PER_DAY`, `FEATURE_JOBS_TICK` (jobs must run).
- **Defaults:** feature off; no `paid_feature_controls` row for `ai_visibility.explore` (F01 ships none enabled).
- **Migration order:** 090 then 091 (phase 1). Both additive. 090 replaces `claim_probe_dispatch` with a body that is 035's plus explore-only branches.
- **Owner enabling:** (1) `PUT /api/ops/spend/controls/ai_visibility.explore` with `{ enabled: true, mode: "allowlist", brandAllowlist: ["<brand>"], dailyCapUsd: 5, maxCallUsd: 1, note: "Prompt Explorer pilot", confirm: "ai_visibility.explore" }`; (2) set `FEATURE_PROMPT_EXPLORER=allowlist` and `FEATURE_PROMPT_EXPLORER_BRANDS=<brand>`; (3) while P0 ordinary dispatch is paused, explore works only for the one allow-listed workspace (same rule as scans); (4) ask one question with one model and check the ledger row (`select feature, cost_source, accounted_usd from spend_ledger where subject_kind='explore_run' order by occurred_at desc limit 1;`).
- **Turn off:** `FEATURE_PROMPT_EXPLORER=off` or disable the paid control. Running jobs finish their current step and settle.
- **Rollback:** revert code. Migration 090 stays; its function behaves exactly as 035 for scan and canary rows (claim-regression group). Explore rows remain as history.
- **Data cleanup:** `explore.retention` prunes runs after 395 days.

## 11. Risks and open questions

| # | Risk / question | Default chosen |
|---|---|---|
| 1 | F08's add-question service name and signature are not fixed yet. | F11 calls `addWorkspaceQuestion(admin, { brandKey, text, origin, createdBy }) → { question: { id, status }, created }` from `src/lib/questions/service.ts`; phase 3 adapts to F08's final export (requested from F08). |
| 2 | `workspace_questions.origin` has no explorer value. | Use `manual` (the customer typed the question). An `explore` origin would need F08's agreement. |
| 3 | Answers from the explorer use the model API, which differs from consumer-app answers used in scans. | Card footer says "(model API)"; F12 lists explore answers separately from tracked rates. |
| 4 | OpenSEO retries once (paid) when the model skipped web search. | Not adopted (billed calls never retry). The card shows "no web search" and "Ask again" is a deliberate, priced action. |
| 5 | Up to four parallel provider calls in one F01 step (220 s). A crash mid-step leaves leases to become `ambiguous`. | `finalize` converts expired leases; ledger counts them at reservation; operator reconciliation as for scans. |
| 6 | `EXPLORE_OPENROUTER_RESERVE_USD` default 0.10 may undershoot Claude via OpenRouter with long answers. | F03's undershoot queue flags it; the owner raises the env value. |
| 7 | While P0 dispatch is paused, explore works only for the single allow-listed brand. | Accepted: same rule as scans; the quote blocks with `collection_paused` for every other workspace. |
| 8 | F03's periodic sync does not see explore attempts (it joins `scan_jobs`). | F11 writes them via `settle_explore_hold` with the same `source_ref` format, so a later broader F03 sync cannot duplicate them (`ON CONFLICT (source_ref)`). |

**Deviations from conventions:** `probe_observations.brand_key` is nullable and has no `ON DELETE CASCADE` (it is a P0 table shared with scan rows whose workspace lives on `scan_jobs`; attempts reference observations without cascade). `explore_runs` follows §6.8 fully.

## 12. Definition of done

- [ ] Phases 1–3 merged with their checkpoints green.
- [ ] F11-AC-01 … F11-AC-20 covered by passing tests in §9.
- [ ] `npm test`, `npm run typecheck`, `npm run build` green; CI `customer-database` green including `check-probe-dispatch.mjs` and the new DB groups.
- [ ] `THIRD_PARTY_NOTICES.md` lists every ported file.
- [ ] `features/README.md` F11 status updated.
- [ ] Owner pilot recorded in the last PR: one question, one model, ledger row `cost_source` and `accounted_usd` (no prompt or answer text).
