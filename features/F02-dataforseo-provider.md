# F02 — DataForSEO provider and bake-off

> <!-- doc-status -->
> **Status: LIVE.** Implementation spec. Not built yet. Phase 1 (the bake-off) may start when F01 and F03 phase 1 are merged. Phases 2–5 are gated on a recorded **go** in the decision record (§6.8).
>
> **Owner decision, 25 October 2026: Claude is not an answer engine for now.** Do not register a `claude` engine, route, adapter, readiness surface, vendor entry, OpenRouter model, marketing label or Prompt Explorer model. Ported OpenSEO code that only *knows* the `claude` slug (DataForSEO model catalogue, `llmResponseUsd` price rows, schemas) stays verbatim; nothing calls it. Every Claude item below is marked **(deferred)** and must be skipped.

| Field | Value |
|---|---|
| ID | F02 |
| Wave | 0 |
| Comparison rows covered | "Engines and capture"; "The provider question → What I could not verify" (India support, AI Overview presence, terms of use, real cost); the measurement half of "Cost per answer" (F03 owns the ledger) |
| Depends on | F01 (merged): `metered`, `settleSpendBatch`, `AppError`, `ChargedCallError`/`UnbilledCallError`/`AmbiguousCallError`, `isFeatureEnabled`, `definePeriodic`. F03 phase 1 (merged): `src/lib/pricing/dataforseo.ts`, `src/shared/ai-visibility-pricing.ts`. |
| Blocks | F08 (provider choice), F11 (answer fetchers and model catalogue), F13–F17 (reusable metered client), F15 (SERP fetchers), F20 (client conventions) |
| Reserved migrations | 045–049. **045** `045_f02_queued_dispatch.sql` (phase 4). 046–049 deliberately unused. |
| Feature flag | `FEATURE_DATAFORSEO_ENGINES` (feature name `dataforseo_engines`, no linked spend features: answer-engine spend is fenced by `claim_probe_dispatch`, not by `paid_feature_controls`). Off in production by default. |
| Spend features | `providers.dataforseo.selftest` (owner-run live check of the metered client only). Consumers of the client (F13–F17) register their own. |
| OpenSEO reference | `openseo:src/server/lib/dataforseo/{core,envelope,client,shared,ai-tracking,ai,llm-models,serp,appendix,pricing}.ts`, `openseo:src/server/lib/dataforseoLlmSchemas.ts`, `openseo:src/server/lib/dataforseoBillingClassification.ts`, `openseo:src/server/features/ai-visibility/services/aiVisibilityCollection.ts`, `openseo:src/server/workflows/AiVisibilityWorkflow.ts`, `openseo:src/server/features/ai-visibility/providers/dataforseoEvidence.ts`, `openseo:src/shared/{ai-visibility,prompt-search-countries,keyword-locations,safe-url}.ts` at `c5f8db1` |

## 1. Summary

DataForSEO sells ChatGPT and Gemini answers captured from the consumer apps, Google results with asynchronously loaded AI Overviews, and Claude/Perplexity model-API answers with web search, at roughly a tenth of a cent per scraped answer in OpenSEO's price table. If those numbers and India support hold, one provider fixes three open Perceev problems: consumer collection (R12), the empty Bright Data cookie pool for India AI Overviews, and a cost of about USD 7 per 120 answers. F02 first runs a bounded, owner-run bake-off on the real Offcult panel and records a go/no-go decision; only after a go does it ship the reusable DataForSEO client, the engine adapters (including Claude as a new engine) inside our P0 dispatch fence, queued collection for scans, and a fallback order to Bright Data and OpenRouter.

## 2. What OpenSEO does (observed)

**Transport and credentials**

1. One authenticated `fetch` for every call: `Authorization: Basic ${DATAFORSEO_API_KEY}` (`openseo:src/server/lib/dataforseo/core.ts:65-72`). The value is the base64 of `email:password` (`openseo:docs/DATAFORSEO_API_KEY.md:11`). Base URL `https://api.dataforseo.com` (`core.ts:12`); a request may target the sandbox host, which "validates requests like production at zero cost" (`core.ts:165-166`; sandbox host `https://sandbox.dataforseo.com` at `openseo:src/server/lib/dataforseo/serp-location-validate.ts:6`, used at `:14-37`).
2. Every call has a 60 s ceiling (`core.ts:14-15`). Timeouts are classified `UPSTREAM_UNAVAILABLE` and deliberately **not** retried because "a call that ran past the deadline may already be billed" (`core.ts:83-104`). HTTP 5xx is retried up to 2 times with 250 ms backoff by default (`core.ts:16-19`, `:109-115`); billed non-idempotent calls pass `maxServerErrorRetries: 0` (`core.ts:156-164`; used at `openseo:src/server/lib/dataforseo/ai-tracking.ts:114-115`, `:209-210`, `openseo:src/server/lib/dataforseo/ai.ts:331-333`). HTTP 429 → `RATE_LIMITED`, 401 → `DATAFORSEO_AUTH_FAILED` (`core.ts:122-129`). Error bodies are truncated to 1,600 characters (`core.ts:13`, `:33-48`).
3. POST bodies are an array of task objects (`core.ts:197-212`); GET is used for `task_get` and catalogues (`core.ts:238-246`).

**Billing envelope**

4. Every section fetcher returns `{ data, billing: { path, costUsd } }`; nothing else builds a billing object (`openseo:src/server/lib/dataforseo/envelope.ts:6-20`). `cost`/`path` are zod-validated (`envelope.ts:53-59`, `:93-113`).
5. `assertOk` ladder: top-level status ≠ 20000 → classified error; task status ≠ expected → no-results (40501 "No Search Results") may be an empty success; a failed task that carries cost → `DataforseoChargedTaskError` with its billing; DataForSEO's own backend codes `40101, 40103, 50000, 50301, 50302, 50303, 50304, 50401, 50402` → `UPSTREAM_UNAVAILABLE` (`envelope.ts:140-183`, `:256-322`). An "Invalid Field" rejection is flagged `isInvalidField` and is not charged when its cost is 0 (`envelope.ts:29-51`, `openseo:src/server/lib/dataforseo/client.ts:365-382`). Task lifecycle codes `20100, 40601, 40602` mean "pending" (`envelope.ts:224-233`).
6. Billing/balance failures (status 40200, 40210, 402 or billing words) map to a product "billing issue" error per API section (`openseo:src/server/lib/dataforseoBillingClassification.ts:4-48`).

**Metering**

7. Each client entry is `meter(customer, fetcher, estimator, feature)`; "`estimateRawUsd` is required … so an entry cannot be added without a price" (`client.ts:71-98`). Holds are reserved before calls and settled on the provider-reported cost; a batch shares one hold (`client.ts:321-414`). Settlement is registered with `waitUntil` so a disconnect cannot skip it (`client.ts:404-413`). Task collection (`task_get`) is free and deliberately unmetered, "so routing these through the metering seam would charge the customer twice" (`openseo:src/server/lib/dataforseo/index.ts:25-37`).
8. Prices are raw USD constants; estimators are upper bounds (`openseo:src/server/lib/dataforseo/pricing.ts:63-78`). AI answers: `AI_RECORD_COST_USD = 0.0012` queued and `AI_LIVE_RECORD_COST_USD = 0.004` live (`openseo:src/shared/ai-visibility.ts:31-40`). LLM responses at the 4,096-token cap: chat_gpt 0.09/0.05, claude 0.18/0.08, gemini 0.11/0.05, perplexity 0.04/0.04 USD with/without web search (`pricing.ts:122-145`).

**AI answer endpoints**

9. ChatGPT and Gemini come from `/v3/ai_optimization/{chat_gpt|gemini}/llm_scraper`; Google AI Overviews from `/v3/serp/google/organic` (`ai-tracking.ts:19-31`). Claude and Perplexity have no scraper and always use `/v3/ai_optimization/{slug}/llm_responses/live` (`openseo:src/shared/ai-visibility.ts:21-30`; `ai-tracking.ts:33-38`).
10. Task body: `keyword` (with literal `%` and `+` escaped), `location_code`, `language_code`, `tag`; Google adds `depth: 10, load_async_ai_overview: true`, and "DataForSEO refunds the extra charge when no overview loads" (`ai-tracking.ts:72-89`). Three market languages are renamed per engine (`ai-tracking.ts:59-70`).
11. Queued mode: one `task_post` carries ≤ 100 tasks for one engine, is billed at post, and its cost is summed over every entry, accepted or not; rejected entries come back without a task id (`ai-tracking.ts:91-142`; `MAX_TASKS_PER_POST = 100` at `openseo:src/shared/rank-tracking.ts:55`). Collection is `GET …/task_get/advanced/{id}`, free (`ai-tracking.ts:157-174`). A failed task is `retryable` only when DataForSEO's backend failed it (`ai-tracking.ts:176-192`).
12. Live mode: one prompt per `POST …/live/advanced`, billed per call, 150 s timeout because "live answers can take up to 120 seconds" (`ai-tracking.ts:51-52`, `:194-221`).
13. LLM responses: the model name is checked against DataForSEO's free catalogue first because "DataForSEO BILLS tasks that fail with `Invalid Field: 'model_name'`" (`openseo:src/server/lib/dataforseo/llm-models.ts:11-18`; `ai.ts:285-294`). `web_search: true` is permission, not an instruction; only Claude accepts `force_web_search`; a country hint is sent only with web search and Gemini rejects it; `max_output_tokens` is clamped to 256–4096 (`ai.ts:296-327`). The response carries `model_name`, `output_tokens`, `web_search`, `items[].sections[].text/annotations`, and `fan_out_queries` (`openseo:src/server/lib/dataforseoLlmSchemas.ts:116-154`).
14. Model catalogue: `GET /v3/ai_optimization/{slug}/llm_responses/models` (free), cached per process for 1 hour; failures are not cached and fall back to a dated snapshot (`llm-models.ts:101-131`). Pins: ChatGPT `gpt-5.6-luna`, Claude `claude-sonnet-5` (the catalogue's `claude-sonnet-5-5` failed live with 50000, verified 2026-10-07) (`llm-models.ts:41-54`); otherwise the highest plain alias wins (`llm-models.ts:56-99`).
15. Locations: the ChatGPT scraper cannot collect in location codes `2275, 2344, 2831, 2832, 2833, 2862`; Gemini and Google have no exclusions; Claude and Perplexity use their web-search country lists (`openseo:src/shared/ai-visibility.ts:297-318`). India is location 2356 (`openseo:src/shared/keyword-locations.ts:216`, languages `en`, `hi` at `:793`), is not in the ChatGPT exclusion list, and `IN` is in both the general and the Claude web-search lists (`openseo:src/shared/prompt-search-countries.ts:117`, `:264-301`). The file says these "are request capabilities, not proof of search use or observed location" (`prompt-search-countries.ts:1-11`). **(Inferred)** OpenSEO never measured India.

**Collection workflow**

16. Manual/baseline runs collect live; scheduled runs use the cheaper queue; Claude/Perplexity always use the model API (`openseo:src/server/features/ai-visibility/services/aiVisibilityCollection.ts:76-125`). Live answers run 6 per step (`aiVisibilityCollection.ts:54-58`). Each answer gets up to 3 attempts, but "a transport error or a timeout can hide a charge, so it is never retried"; a retry follows only when DataForSEO returned the task as failed by its own backend (`aiVisibilityCollection.ts:60-67`, `:182-219`, `:290-305`).
17. Paid steps run once (`SINGLE_ATTEMPT`, retries 0); `task_get` steps retry twice (`openseo:src/server/workflows/AiVisibilityWorkflow.ts:29-43`). Queued answers are polled after cumulative waits of 2/4/7/10/14/18/22/26/30 minutes; anything still missing then fails as not collected (`AiVisibilityWorkflow.ts:44-58`, `:160-176`). Each round reads up to 25 tasks concurrently (`aiVisibilityCollection.ts:313-357`). A failed answer is reposted in its own single-attempt step, never after the last round (`AiVisibilityWorkflow.ts:92-124`).

**Evidence parsing**

18. `parseDataforseoAnswer` reads scraper `markdown` + `sources`, or the SERP item of `type: "ai_overview"` with its `references` and nested item references; a results page without an Overview is a "no answer" (`openseo:src/server/features/ai-visibility/providers/dataforseoEvidence.ts:6-87`). `parseLlmResponseAnswer` joins `message` sections and reads annotations as citations (`dataforseoEvidence.ts:89-112`). Citation pills (`[1]`, `[example.com]`) are removed from prose before brand matching (`dataforseoEvidence.ts:120-149`). Citations keep only safe http(s) URLs, drop `utm_*`, `gclid`, `fbclid`, `msclkid` and the hash, de-duplicate and keep engine order (`dataforseoEvidence.ts:151-181`; `openseo:src/shared/safe-url.ts:13-25`). Tests: `dataforseoEvidence.test.ts:5-69`.
19. Account spend and balance are readable from the free `GET /v3/appendix/user_data` (`money.balance`, `money.total`, `money.statistics.day`) (`openseo:src/server/lib/dataforseo/appendix.ts:7-50`).

## 3. What Perceev has today

- **Engines.** Registry names `aio`, `chatgpt`, `gemini`, `perplexity` in `ENGINE_REGISTRY` (`src/lib/scoring/enginePipeline.js:2135-2195`), resolved from `ENGINES` by `resolveEnabledEngines` (`:2238-2277`). AIO goes through Bright Data (`probeAio`, `:97-218`; `src/lib/engines/brightdata.js:589`), Gemini through OpenRouter (`src/lib/engines/openRouterProbe.js:17-27`, `:127-237`), ChatGPT and Perplexity through their native APIs when a direct key is set, else OpenRouter (`src/lib/engines/openai.js:92`, `src/lib/engines/perplexity.js:222-224`). `probeTextEngine` normalises every text engine and hard-codes `gateway: "openrouter"` in provenance (`enginePipeline.js:237-302`). Headline weights `aio/chatgpt/gemini/perplexity = 1` (`enginePipeline.js:1509-1514`). **There is no Claude engine.**
- **P0 dispatch fence.** Every answer is a `probe_observations` row (`supabase/migrations/027_durable_probe_dispatch.sql:3-26`; purposes `scan`, `canary`; states `pending, leased, retry, answered, valid_no_aio, failed, ambiguous, blocked`) claimed one attempt at a time by `claim_probe_dispatch` (`supabase/migrations/035_scoped_provider_rollout.sql:6-100`): pause and one-brand allowlist (`:27-32`), due time, 3 attempts and deadline (`:33-44`), shared circuits (`:45-52`), canary budgets (`:53-59`, `:64-69`), per-scan and per-day caps (`:60-89`). Leases are 1–180 s (`:13-14`) and renewable (`027:316-328`). `finish_probe_dispatch` fences late results and projects into `prompt_results` (`027:210-269`, projection `:255-267`). Code side: `createProbeDispatchStore` (`src/lib/db/probeDispatch.js:82-176`, lease `PROBE_LEASE_SECONDS = 120`, request budget `PROBE_REQUEST_MS = 70_000` at `:15-17`), `runDurableProbing` (`src/lib/workers/durableProbing.js:62-329`; one serial lane per engine at `:265-277`; budget check before each claim at `:272`; frozen identities at `:76-96`). Scan chunks have a 150 s budget (`src/lib/workers/scanWorker.js:111`) and work due within 10 minutes is bridged (`scanWorker.js:1181-1187`, `:3047-3060`).
- **Readiness, circuits, canaries.** `ENGINE_SURFACES` (`src/lib/engines/providerReadiness.js:92-127`), route resolution native vs gateway (`:210-242`), `configVersion` (`:278-290`), `circuitIdentity` = provider + credential fingerprint (`:322-328`), `validateEngineConfig` (`:339-375`). Provider failure kinds and circuit policy (`src/lib/engines/providerFailure.js:52-143`; code allowlist `:155-217`). In-process circuit policy (`src/lib/providerCircuit.js:31-80`). Operator canaries seed `purpose='canary'` rows with a shared budget scope (`src/lib/ops/providerCanary.js:18-146`; request units `:59-65`). Credentials are described once in `src/lib/vendorRegistry.js:49-86`.
- **Evidence.** Adapters call `captureEvidence({payload, provider, surface, requestId})`; `evidenceDocument` redacts structurally, refuses unverifiable redaction and payloads over 2 MB, and stores a private JSON object for 90 days (`src/lib/db/measurementEvidence.js:7-55`, `:74-117`; `src/lib/evidenceRedaction.js:4-29`).
- **Marketing-copy engine guard.** `ENGINE_LABELS` and `deployedEngines()` (`src/lib/engines/deployedEngines.js:34-96`); landing `ENGINE_NOTE`/`RAIL_NOTES` (`src/app/page.js:142-148`); guard tests (`src/lib/landingHonesty.test.mjs`, for example "every engine label the page can render is a known engine" at `:916`); deploy check `checkEngineAdvertising` with `OPENROUTER_ENGINES = new Set(["chatgpt","gemini","perplexity"])` (`scripts/check-secrets.mjs:475-544`). The customer report already labels `claude` (`src/components/portal/scans/reportData.js:9-17`).
- **Measured state (20 October).** A real 30 + 2 question India panel for Offcult took 25 minutes and about USD 7: ChatGPT, Gemini and Perplexity 32/32 answered; Google 28 valid SERPs with **no** AI Overview and 4 challenge failures, because Bright Data's rendered mode has an empty India cookie pool (`docs/audits/2026-10-16/HANDOFF-2026-10-20-demo-and-consolidation.md:29-40`). The panel payload is at `~/.aeovis-private/demo/offcult-panel.json` and the run record at `~/.aeovis-private/demo/offcult-local-run.json` (same file, `:66-74`). Neither is opened by this spec.
- **Live QA pattern to reuse.** `scripts/qa/live-provider-repairs.mjs` refuses to run without exact pre-registered arguments (`:7-13`), a loopback `aeovis_live_qa` ledger (`:14-19`), deletes Supabase variables so production is never constructed (`:20-26`), and wraps `fetch` with a host allowlist and request ceiling (`:41-53`).
- **Must not break:** migrations 027–035 functions (F02 changes none of them), the frozen-identity check in `dispatchRow` (`durableProbing.js:157-168`), every existing `config_version` string for today's environments (a change blocks in-flight scans with `configuration_changed`), `landingHonesty.test.mjs`, `check-secrets.mjs`, the 3,558-test suite.

## 4. Target behaviour and acceptance criteria

| ID | Statement | Verified by |
|---|---|---|
| F02-AC-01 | Missing `DATAFORSEO_API_KEY` → `AppError(503,"dataforseo_not_configured")` before any `fetch`. The request carries `Authorization: Basic <value>`. `DATAFORSEO_BASE_URL` accepts only `https://api.dataforseo.com` (default) or `https://sandbox.dataforseo.com`; anything else → `AppError(500,"dataforseo_base_url_invalid")`. | unit `src/lib/providers/dataforseo/core.test.ts` |
| F02-AC-02 | POST requests are never retried (5xx, 429, timeout: one fetch). GET requests (task_get, catalogue, user_data) retry 5xx up to 2 times with 250/500 ms backoff. A POST timeout throws `AmbiguousCallError`. | unit `core.test.ts` |
| F02-AC-03 | `assertOk` parity with OpenSEO's cases: charged task failure → `ChargedCallError` with `actualUsd = cost`; top-level 50000 → upstream (transient); classifier precedence for balance failures; 40501 "No Search Results" → empty success when allowed; charged 40501 "Invalid Field" still surfaces; "Invalid Field" with cost 0 → `UnbilledCallError`. | unit `src/lib/providers/dataforseo/envelope.test.ts` (port of `envelope.test.ts:12-152`) |
| F02-AC-04 | Error classification table §6.2.2 holds for every row (HTTP status × task status × cost present). | unit `envelope.test.ts` |
| F02-AC-05 | `postAiTrackingTasks` sends the exact body of §6.4 (escaped `%`/`+`, `location_code`, provider language, `depth:10` + `load_async_ai_overview:true` for Google, `tag`), refuses 0 or > 100 tasks, sums `cost` over all entries, returns accepted `{tag, taskId}` and rejected tags. `fetchAiTrackingTaskResult` maps 20100/40601/40602 to `pending`. | unit `src/lib/providers/dataforseo/ai-tracking.test.ts` |
| F02-AC-06 | `fetchLlmResponse` refuses an unknown model name before any POST; sends `force_web_search` only for Claude; sends `web_search_country_iso_code` only with web search and never for Gemini; clamps `max_output_tokens` to 256–4096; never retries. | unit `src/lib/providers/dataforseo/ai.test.ts` (ports `endpoints.test.ts:161-355`, `ai.test.ts:11-26`) |
| F02-AC-07 | Model resolution: ChatGPT pin honoured while listed; highest plain alias otherwise; listed snapshot when no alias; static snapshot when the catalogue is unreachable; failures are not cached; `DATAFORSEO_LLM_MODEL_<SLUG>` overrides only when the catalogue lists it. | unit `src/lib/providers/dataforseo/llm-models.test.ts` (port of `llm-models.test.ts:45-97`) |
| F02-AC-08 | Answer parsing parity: OpenSEO's three evidence cases pass unchanged, plus an `llm_responses` case extracting text, annotations and `fan_out_queries`. | unit `src/lib/providers/dataforseo/dataforseoEvidence.test.ts` |
| F02-AC-09 | The bake-off script refuses to start without the exact flag set, without a loopback `*_live_qa` database, or with any Supabase variable present; refuses network calls to hosts outside its allowlist; stops at `--max-requests`; `--dry-run` makes zero paid calls (sandbox + free catalogue only). | unit `src/lib/providers/dataforseo/bakeoffLib.test.ts` |
| F02-AC-10 | Every paid bake-off call is a `purpose='canary'` observation claimed through `claim_probe_dispatch` under one budget scope; when the scope reaches `--max-spend-usd`, the next claim is refused and no request is sent. | DB `scripts/qa/check-dataforseo-db.mjs` group `bakeoff-ceiling` (stub providers) |
| F02-AC-11 | The bake-off report computes, per arm × engine, India acceptance, AI Overview presence, extraction metrics, latency percentiles, failure-mode counts and provider cost vs price table exactly as defined in §6.8, from a fixture run, and writes no answer text into the repository. | unit `src/lib/providers/dataforseo/bakeoffLib.test.ts` (fixture `tests/fixtures/f02/bakeoff-run/`) |
| F02-AC-12 | The decision record exists at `docs/decisions/<date>-dataforseo-answer-provider.md`, follows the §6.8 template, and its approved-engine list equals `DATAFORSEO_APPROVED_ENGINES` in code. | unit `src/lib/engines/dataforseoGate.test.mjs` (added in phase 3) |
| F02-AC-13 | `meter()` estimates with the bound F03 estimator, reserves through F01 `metered`, settles on DataForSEO's reported cost, releases on `UnbilledCallError`, settles at actual on `ChargedCallError`, and counts `AmbiguousCallError` at the estimate. | unit `src/lib/providers/dataforseo/client.test.ts` (port of `client.test.ts:185-296`) |
| F02-AC-14 | `meterBatch()` holds once for the summed estimate and settles each call with `settleSpendBatch`; calls refused before dispatch are never sent. | unit `client.test.ts` |
| F02-AC-15 | Every entry of `createDataforseoClient` is built with `meter`/`meterBatch` and an F03 estimator; no price constant appears under `src/lib/providers/dataforseo/`. | unit `client.test.ts` "every entry is priced"; guard `src/lib/providers/dataforseo/noPrices.test.mjs` |
| F02-AC-16 | Answer fetchers (`postAiTrackingTasks`, `fetchAiTrackingLiveAnswer`, `fetchLlmResponse`) are importable only from `src/lib/engines/dataforseo.ts`, `src/lib/providers/dataforseo/*`, `scripts/qa/check-dataforseo-bakeoff.mjs` and `scripts/qa/check-dataforseo-live.mjs`; they are not reachable from `createDataforseoClient`. | guard `src/lib/providers/dataforseo/answerImportGuard.test.mjs` |
| F02-AC-17 | `fetchLiveSerp` and the SERP task queue behave as OpenSEO's tests (no-results empty, tags map ids, cost summed, pending/completed). | unit `src/lib/providers/dataforseo/serp.test.ts` (port of `serp.test.ts:24-215`) |
| F02-AC-18 | DataForSEO adapters return the `probeTextEngine`/`probeAio` result shape with `gateway: "dataforseo"`, `measurement_method` `consumer_capture` (scrapers), `model_api` (llm_responses) or `google_serp` (organic), `cost` = task cost, `cost_source: "gateway"`, `cost_state: "measured"`, `requested_model`/`returned_model`, `provider_request_id` = task id. | unit `src/lib/engines/dataforseo.test.ts` |
| F02-AC-19 | Every engine result from every adapter carries `provenance.gateway` naming the provider that served it (`brightdata`, `openai`, `perplexity`, `openrouter`, `dataforseo`). | unit `src/lib/engines/gatewayProvenance.test.mjs` |
| F02-AC-20 | **(deferred — owner decision 25 Oct 2026; not built, not tested)** Claude is a registered engine end to end: `resolveEnabledEngines({engines:"claude"})` returns it when its route is configured; `ENGINE_LABELS.claude = "Claude"`; `ENGINE_WEIGHTS.claude = 1`; the landing guard tests pass with `NEXT_PUBLIC_ENGINES` including and excluding `claude`; `check-secrets` reports an unfunded Claude as MISMATCH. | unit `src/lib/engines/claudeEngine.test.mjs`; existing `src/lib/landingHonesty.test.mjs` |
| F02-AC-21 | With no `ANSWER_ENGINE_ROUTES` set, `configVersion` and `circuitIdentity` for `aio`, `chatgpt`, `gemini`, `perplexity` equal today's strings for the same env (recorded fixture). A `dataforseo` route produces `v1:dataforseo:direct:n/a:<model>:DATAFORSEO_API_KEY#<digest>`. | unit `src/lib/engines/engineRoutes.test.ts` |
| F02-AC-22 | Route resolution at freeze picks the first route in the engine's order that is configured, allowed (`FEATURE_DATAFORSEO_ENGINES` on and engine in `DATAFORSEO_APPROVED_ENGINES` for `dataforseo`), scan-capable, and whose circuit is closed; the frozen route never changes within a scan. | unit `engineRoutes.test.ts`; unit `src/lib/workers/durableProbing.routes.test.mjs` |
| F02-AC-23 | DataForSEO failures map to provider-failure kinds (§6.2.6): balance → `spend_limit` (opens the shared `dataforseo` circuit), 401 → `authentication`, backend codes → `transient`, 429 → `rate_limit`, invalid field → `request`, timeout → `timeout`. | unit `src/lib/engines/providerFailure.dataforseo.test.mjs` |
| F02-AC-24 | DataForSEO canaries run through `dispatchCanaries` with 1 request unit per observation and produce readiness for each dataforseo-routed engine. | unit `src/lib/ops/providerCanary.dataforseo.test.mjs` |
| F02-AC-25 | Each DataForSEO answer stores one evidence capture (`provider: "dataforseo"`, the task JSON only, no headers) that passes `evidenceRedactionStatus`. | unit `src/lib/engines/dataforseo.test.ts` |
| F02-AC-26 | Live DataForSEO calls inside scans use a 180 s lease, a request timeout of 140 s (scraper/SERP) or 100 s (llm_responses), renew the lease every 60 s while waiting, and are never started when the chunk cannot fit the request budget. | unit `durableProbing.routes.test.mjs` |
| F02-AC-27 | Migration 045: `posted` is a legal observation state and attempt dispatch state; `post_probe_dispatch` fences a stale lease; `claim_probe_dispatch` on a posted row returns `{granted:false, reason:"posted"}`; `collect_probe_dispatch` writes the same `prompt_results` projection as `finish_probe_dispatch` for the same payload, adjusts cost down to a settled refund only, and is idempotent. | DB `check-dataforseo-db.mjs` groups `posted-states`, `collect-projection` |
| F02-AC-28 | Queued scan collection: up to 100 observations of one engine are claimed, posted in one `task_post`, each accepted entry is `posted` with its own task id and cost, each rejected entry finishes `failed` with its cost, an ambiguous post leaves leases to expire into `ambiguous`; posted rows are polled on OpenSEO's schedule with free retried reads; a backend-failed task becomes `retry` (a new claimed attempt); anything uncollected after 30 minutes fails `not_collected` at its posted cost. | unit `src/lib/workers/queuedCollection.test.mjs`; DB group `queued-flow` |
| F02-AC-29 | A scan with posted rows does not finalize; `resumeAt` equals the earliest next poll; the posted-row sweep fails expired posted rows of abandoned jobs. | unit `queuedCollection.test.mjs`; DB group `posted-sweep` |
| F02-AC-30 | The customer report shows a "Consumer app" badge for `consumer_capture` answers and keeps "Model API" for `model_api`. | browser `scripts/qa/check-dataforseo-browser.mjs` |
| F02-AC-31 | No F02 code calls `set_probe_rollout` or writes `probe_dispatch_control`; `scripts/qa/check-probe-dispatch.mjs` still passes. | guard `answerImportGuard.test.mjs` (string scan); CI `customer-database` |

## 5. Scope

**In scope**
- Phase 1: DataForSEO transport/envelope/answer fetchers/parsers needed for the bake-off; `scripts/qa/check-dataforseo-bakeoff.mjs`; the decision record template; the terms-of-use checklist.
- Phase 2: the reusable metered client (`createDataforseoClient`, `meter`, `meterBatch`), SERP fetchers, LLM-mentions fetchers, appendix, bound to F03 estimators.
- Phase 3: engine routing (`ANSWER_ENGINE_ROUTES`, freeze-time fallback), DataForSEO adapters (live), readiness/circuit/canary/evidence/provenance integration, marketing-copy guard updates. (Claude as a new engine is deferred.)
- Phase 4: queued (`task_post`/`task_get`) collection inside the P0 fence (migration 045).
- Phase 5: owner cutover kit: live check script, vendor doc, runbook.

**Out of scope**
- Price tables and the ledger (F03). Section fetchers for Labs/Google Ads (F13, F14), backlinks (F16), business data and local SERP (F17), Lighthouse (F18): those specs port their own section files and build them with F02's `meter`.
- Prompt Explorer (F11) and question history (F12); F02 only supplies the fetchers they use.
- Changing `claim_probe_dispatch`, `finish_probe_dispatch` or any dispatch control (F11 alone changes the claim fence, for `purpose='explore'`).
- Changing `SCAN_PROBE_RESERVATION_USD` or scan caps (owner config; F09 reads them).
- DataForSEO invoice reconciliation automation via `id_list` (F03 follow-up).
- Deferred Mixed rows (Citations and sources, Trend comparability, Competitors): preserved. Answers from a new route are a new measurement context; existing comparability rules (`visibilitySeries.js`) already refuse deltas across a context change, and F02 does not alter them.

## 6. Design

### 6.1 Data model

Phases 1–3 need no migration. Phase 4 adds one.

#### `supabase/migrations/045_f02_queued_dispatch.sql`

```sql
-- F02 phase 4: queued (task_post / task_get) answer collection inside the P0 fence.
-- Adds one non-terminal state, 'posted': the claimed attempt was sent and billed at post,
-- and its answer is collected later by free reads. claim_probe_dispatch,
-- finish_probe_dispatch and every other 027/035 function are NOT modified.

DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'public.probe_observations'::regclass AND contype = 'c'
              AND pg_get_constraintdef(oid) LIKE '%valid_no_aio%' LOOP
    EXECUTE format('ALTER TABLE public.probe_observations DROP CONSTRAINT %I', c.conname);
  END LOOP;
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'public.probe_attempts'::regclass AND contype = 'c'
              AND pg_get_constraintdef(oid) LIKE '%historical%' LOOP
    EXECUTE format('ALTER TABLE public.probe_attempts DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE public.probe_observations ADD CONSTRAINT probe_observations_state_check CHECK (state IN
  ('pending','leased','retry','posted','answered','valid_no_aio','failed','ambiguous','blocked'));
ALTER TABLE public.probe_attempts ADD CONSTRAINT probe_attempts_dispatch_state_check CHECK (dispatch_state IN
  ('intent','posted','recorded','unknown','historical'));

ALTER TABLE public.probe_attempts ADD COLUMN IF NOT EXISTS provider_task_id text
  CHECK (provider_task_id IS NULL OR length(provider_task_id) BETWEEN 1 AND 200);
ALTER TABLE public.probe_attempts ADD COLUMN IF NOT EXISTS posted_at timestamptz;
ALTER TABLE public.probe_attempts ADD COLUMN IF NOT EXISTS collect_until timestamptz;
COMMENT ON COLUMN public.probe_attempts.provider_task_id IS
  'Provider task id of a queued (posted) attempt, e.g. a DataForSEO task_post id. Billed at post.';
COMMENT ON COLUMN public.probe_attempts.collect_until IS
  'After this time a still-posted attempt is failed as not_collected, keeping its posted cost.';
CREATE UNIQUE INDEX IF NOT EXISTS probe_attempts_provider_task_idx
  ON public.probe_attempts (provider_task_id) WHERE provider_task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS probe_observations_posted_idx
  ON public.probe_observations (next_attempt_at) WHERE state = 'posted';

-- A granted, still-leased attempt was accepted by the provider's queue.
-- The post cost is known now (DataForSEO bills task_post), so the attempt is charged now.
CREATE OR REPLACE FUNCTION public.post_probe_dispatch(p_id text, p_token uuid, p_task_id text,
  p_post_cost numeric, p_next_at timestamptz, p_collect_until timestamptz) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE o probe_observations; a probe_attempts; at_time timestamptz; n integer;
BEGIN
  IF p_task_id IS NULL OR length(p_task_id) NOT BETWEEN 1 AND 200 OR p_post_cost IS NULL OR p_post_cost < 0
     OR p_next_at IS NULL OR p_collect_until IS NULL OR p_collect_until <= p_next_at THEN
    RAISE EXCEPTION 'invalid posted task'; END IF;
  PERFORM pg_advisory_xact_lock(270027);
  at_time := clock_timestamp();
  SELECT * INTO o FROM probe_observations WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'observation not found'; END IF;
  SELECT * INTO a FROM probe_attempts WHERE observation_id = p_id AND lease_token = p_token;
  IF NOT FOUND THEN RAISE EXCEPTION 'attempt token not found'; END IF;
  IF a.dispatch_state = 'posted' AND a.provider_task_id = p_task_id THEN
    RETURN jsonb_build_object('accepted', true, 'duplicate', true); END IF;
  IF o.state <> 'leased' OR o.lease_token <> p_token OR o.lease_until <= at_time OR a.dispatch_state <> 'intent' THEN
    -- Same fence as finish_probe_dispatch: a post recorded after its lease is a late receipt.
    INSERT INTO probe_late_receipts(observation_id, lease_token, result)
    VALUES (p_id, p_token, jsonb_build_object('provider_task_id', p_task_id, 'post_cost_usd', p_post_cost))
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS n = ROW_COUNT;
    UPDATE probe_attempts SET dispatch_state = 'unknown'
     WHERE observation_id = p_id AND lease_token = p_token AND dispatch_state = 'intent';
    IF o.lease_token = p_token AND o.state = 'leased' THEN
      UPDATE probe_observations SET state = 'ambiguous', reason = 'late_post', lease_until = NULL WHERE id = p_id;
    END IF;
    RETURN jsonb_build_object('accepted', false, 'reason', 'stale_lease', 'late_receipt', n = 1);
  END IF;
  UPDATE probe_attempts SET dispatch_state = 'posted', provider_task_id = p_task_id, posted_at = at_time,
         collect_until = least(p_collect_until, o.deadline_at), charged_usd = p_post_cost, cost_state = 'measured'
   WHERE observation_id = p_id AND lease_token = p_token;
  UPDATE probe_observations SET state = 'posted', lease_until = NULL, next_attempt_at = p_next_at, reason = NULL,
         total_cost = total_cost + p_post_cost, unknown_cost_calls = unknown_cost_calls - 1
   WHERE id = p_id;
  RETURN jsonb_build_object('accepted', true, 'duplicate', false);
END $$;

-- Move a posted row's next free read. No cost, no attempt change.
CREATE OR REPLACE FUNCTION public.reschedule_probe_collection(p_id text, p_token uuid, p_next_at timestamptz)
RETURNS boolean LANGUAGE sql SET search_path = public AS $$
  UPDATE probe_observations SET next_attempt_at = p_next_at
   WHERE id = p_id AND state = 'posted' AND lease_token = p_token AND p_next_at IS NOT NULL
  RETURNING true;
$$;

-- Record a collected (or finally uncollectable) posted attempt. Mirrors finish_probe_dispatch
-- (027:237-267) for a posted attempt: circuit handling and the prompt_results projection are
-- copied verbatim and covered by the collect-projection DB test.
CREATE OR REPLACE FUNCTION public.collect_probe_dispatch(p_id text, p_token uuid, p_result jsonb, p_state text,
  p_failure jsonb DEFAULT NULL, p_next_at timestamptz DEFAULT NULL, p_settled_cost numeric DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE o probe_observations; a probe_attempts; at_time timestamptz; v_cost numeric; v_result jsonb;
BEGIN
  IF p_state NOT IN ('answered','valid_no_aio','failed','retry') THEN RAISE EXCEPTION 'invalid result state'; END IF;
  IF p_state = 'retry' AND p_next_at IS NULL THEN RAISE EXCEPTION 'retry requires a due time'; END IF;
  PERFORM pg_advisory_xact_lock(270027);
  at_time := clock_timestamp();
  SELECT * INTO o FROM probe_observations WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'observation not found'; END IF;
  SELECT * INTO a FROM probe_attempts WHERE observation_id = p_id AND lease_token = p_token;
  IF NOT FOUND THEN RAISE EXCEPTION 'attempt token not found'; END IF;
  IF a.dispatch_state = 'recorded' THEN RETURN jsonb_build_object('accepted', true, 'duplicate', true); END IF;
  IF o.state <> 'posted' OR o.lease_token <> p_token OR a.dispatch_state <> 'posted' THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'not_posted');
  END IF;
  -- A provider refund (e.g. no async AI Overview loaded) may only lower the charge.
  v_cost := CASE WHEN p_settled_cost IS NOT NULL AND p_settled_cost >= 0 AND p_settled_cost <= a.charged_usd
                 THEN p_settled_cost ELSE a.charged_usd END;
  v_result := coalesce(p_result, '{}'::jsonb) || jsonb_build_object('cost', v_cost);
  UPDATE probe_attempts SET dispatch_state = 'recorded', finished_at = at_time, result = v_result,
         failure = p_failure, charged_usd = v_cost
   WHERE observation_id = p_id AND lease_token = p_token;
  UPDATE probe_observations SET state = p_state, next_attempt_at = coalesce(p_next_at, at_time), result = v_result,
         reason = p_failure->>'kind', observed_at = at_time, total_cost = total_cost + (v_cost - a.charged_usd)
   WHERE id = p_id;
  IF coalesce((p_failure->>'opens_circuit')::boolean, false) THEN
    UPDATE provider_dispatch_circuits SET open_until = at_time + interval '15 minutes', failure = p_failure,
           recovery_token = NULL, recovery_until = NULL WHERE circuit_key = o.circuit_key;
  ELSIF o.purpose = 'canary' AND p_state IN ('answered','valid_no_aio') THEN
    UPDATE provider_dispatch_circuits SET open_until = NULL, failure = NULL, recovery_token = NULL, recovery_until = NULL
     WHERE circuit_key = o.circuit_key AND (recovery_token IS NULL OR recovery_token = p_token);
  ELSIF o.purpose = 'canary' THEN
    UPDATE provider_dispatch_circuits SET open_until = at_time + interval '15 minutes', recovery_token = NULL,
           recovery_until = NULL WHERE circuit_key = o.circuit_key AND recovery_token = p_token;
  END IF;
  IF o.job_id IS NOT NULL THEN
    INSERT INTO prompt_results(job_id,brand,query,engine,answered,mentioned,brand_cited,intent,is_branded_query,answer_text,raw,position,sentiment)
    SELECT o.job_id, j.checkpoint->>'prompt_key', o.query, o.engine,
      (v_result->>'answer_present')::boolean, (v_result->>'brand_mentioned_in_text')::boolean,
      (v_result->>'brand_cited')::boolean, v_result->>'intent_tier', (v_result->>'is_branded_query')::boolean,
      v_result->>'text', v_result, (b->>'position')::numeric, (b->>'sentiment')::integer
    FROM scan_jobs j LEFT JOIN LATERAL (
      SELECT value AS b FROM jsonb_array_elements(coalesce(v_result->'brands','[]'::jsonb)) WHERE (value->>'is_self')::boolean LIMIT 1
    ) labels ON true WHERE j.id = o.job_id
    ON CONFLICT(job_id,engine,query) DO UPDATE SET answered=excluded.answered, mentioned=excluded.mentioned,
      brand_cited=excluded.brand_cited, intent=excluded.intent, is_branded_query=excluded.is_branded_query,
      answer_text=excluded.answer_text, raw=excluded.raw, position=excluded.position, sentiment=excluded.sentiment;
  END IF;
  RETURN jsonb_build_object('accepted', true, 'duplicate', false);
END $$;

-- Fail posted attempts whose collection window closed (abandoned or cancelled jobs).
CREATE OR REPLACE FUNCTION public.expire_posted_probe_dispatch(p_limit integer DEFAULT 200)
RETURNS integer LANGUAGE plpgsql SET search_path = public AS $$
DECLARE r record; v integer := 0;
BEGIN
  FOR r IN SELECT o.id, a.lease_token FROM probe_observations o
             JOIN probe_attempts a ON a.observation_id = o.id AND a.lease_token = o.lease_token
            WHERE o.state = 'posted' AND a.dispatch_state = 'posted' AND a.collect_until <= clock_timestamp()
            ORDER BY a.collect_until LIMIT p_limit LOOP
    PERFORM collect_probe_dispatch(r.id, r.lease_token,
      jsonb_build_object('answer_present', false, 'error', 'Answer was paid for but not collected in time',
                         'provider_failure', jsonb_build_object('kind','provider_capacity','retryable',false,
                           'opens_circuit',false,'message','Queued answer was not collected before its window closed')),
      'failed', jsonb_build_object('kind','not_collected','opens_circuit',false), NULL, NULL);
    v := v + 1;
  END LOOP;
  RETURN v;
END $$;

REVOKE ALL ON FUNCTION public.post_probe_dispatch(text,uuid,text,numeric,timestamptz,timestamptz),
  public.reschedule_probe_collection(text,uuid,timestamptz),
  public.collect_probe_dispatch(text,uuid,jsonb,text,jsonb,timestamptz,numeric),
  public.expire_posted_probe_dispatch(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.post_probe_dispatch(text,uuid,text,numeric,timestamptz,timestamptz),
  public.reschedule_probe_collection(text,uuid,timestamptz),
  public.collect_probe_dispatch(text,uuid,jsonb,text,jsonb,timestamptz,numeric),
  public.expire_posted_probe_dispatch(integer) TO service_role;
NOTIFY pgrst, 'reload schema';
```

Notes. `claim_probe_dispatch` already returns `{granted:false, reason:o.state}` for any state other than `pending`/`retry` (`035:24-26`), so a posted row is never re-claimed. A posted row has `lease_until = NULL`, so the expired-lease ambiguity branch (`035:19-23`) cannot fire for it. No new table is created, so `scripts/setup-supabase.mjs` gains only the four function names in its required-objects list, and the tenant RLS test needs no change.

### 6.2 Server modules

All new server code is TypeScript under `src/lib/**` with relative imports and explicit extensions (conventions §5.1). Every COPY/PORT file starts with the licence header (conventions §2).

#### 6.2.1 `src/lib/providers/dataforseo/` (the provider library)

| File | Mode | Exports and behaviour |
|---|---|---|
| `core.ts` | PORT `core.ts` | `export const DATAFORSEO_API_BASE = "https://api.dataforseo.com"; export const DATAFORSEO_SANDBOX_BASE = "https://sandbox.dataforseo.com";` `export type DataforseoRequestOptions = { classify?: DataforseoErrorClassifier; baseUrl?: string; signal?: AbortSignal; timeoutMs?: number; env?: Record<string,string\|undefined>; fetchImpl?: typeof fetch }`. `export function dataforseoPost<T>(path: string, tasks: unknown[], o?): Promise<DataforseoResponseLike<T> \| null>`; `export function dataforseoGet<T>(path: string, o?): Promise<DataforseoResponseLike<T> \| null>`. Credential `env.DATAFORSEO_API_KEY` (trimmed; never logged), header `Authorization: Basic <value>`. Base URL: `o.baseUrl ?? env.DATAFORSEO_BASE_URL ?? DATAFORSEO_API_BASE`, must equal one of the two constants. Timeout default 60,000 ms, max 170,000. **POST: zero retries on any status** (stricter than OpenSEO's default of 2, conventions §6.4). GET: 2 retries on 5xx with `250 × (attempt+1)` ms. Errors: §6.2.2. Body text over 1,600 chars is truncated in error details; the details never contain request bodies or headers. |
| `envelope.ts` | PORT `envelope.ts` | Types `DataforseoApiCallCost`, `DataforseoApiResponse<T>`, `DataforseoTaskLike`, `DataforseoResponseLike<T>`, `DataforseoItemsResult`, `DataforseoItemsTask`; functions `buildTaskBilling`, `invalidFieldName`, `isNoResultsTask`, `isUpstreamFailureStatus`, `isTaskInProgress`, `assertOk`, `parseTaskTotalCount`, `parseTaskItems`, `isRecord` with identical names and semantics, except that `DataforseoChargedTaskError` is replaced by F01's `ChargedCallError` (`actualUsd`, `provider: "dataforseo"`, `endpoint`, plus `details.statusCode`, `details.invalidField`, `details.upstream`) and plain failures throw the classes in §6.2.2. New: `export function dataforseoEndpoint(path: string[] \| string): string` → `/v3/serp/google/organic/live/advanced` form. |
| `billingClassification.ts` | COPY `dataforseoBillingClassification.ts` | `createDataforseoBillingClassifier({ pathPrefix, billingIssueCode, billingIssueMessage })`; returns `UnbilledCallError(402, "dataforseo_balance", "The DataForSEO account has a billing or balance issue.")` with `details.providerCode = "dataforseo_" + status`. |
| `shared.ts` | COPY `shared.ts` | `CHATGPT_LOCATION_CODE`, `CHATGPT_LANGUAGE_CODE`, `LlmPlatform`, `LlmTarget`, `buildLlmTarget`, `MAX_TASKS_PER_POST = 100`. |
| `llmSchemas.ts` | COPY `dataforseoLlmSchemas.ts` | All schemas; zod v4 `.passthrough()` becomes `z.looseObject`. |
| `llm-models.ts` | PORT `llm-models.ts` | `LlmResponseModelSlug`, `resolveLatestLlmModelName(slug, deps?)`, `isKnownLlmModelName(slug, name, deps?)`, `FALLBACK_MODEL_NAMES`, `PINNED_MODEL_NAMES` (values copied from `llm-models.ts:27-54`). Per-process cache 1 h, failures not cached (as theirs). Env override `DATAFORSEO_LLM_MODEL_CHAT_GPT` / `_CLAUDE` / `_GEMINI` / `_PERPLEXITY` wins only when the catalogue lists it; otherwise the rule applies and `console.warn("[dataforseo] model override not in catalogue", { slug })`. |
| `ai-tracking.ts` | PORT `ai-tracking.ts` | `AI_TRACKING_ENDPOINTS`, `providerLanguageCode`, `aiTrackingTaskBody`, `postAiTrackingTasks(input)` → `DataforseoApiResponse<{ posted: PostedAiTrackingTask[]; rejected: { tag: string; statusCode: number; message: string; costUsd: number }[] }>` (adds the rejected list; theirs only logs), `fetchAiTrackingTaskResult({ engine, taskId })` → `{status:"pending"} \| AiTrackingAnswer & { costUsd?: number }` (reads `task.cost` when present, for refunds), `fetchAiTrackingLiveAnswer(input)`. Engine names are DataForSEO-side `AiEngine` from F03's `src/shared/ai-visibility-pricing.ts` (`chatgpt`, `gemini`, `google_ai_overview`, `claude`, `perplexity`). Live timeout 140,000 ms (ours, below the 180 s lease; theirs is 150,000). |
| `ai.ts` | PORT `ai.ts` | `resolveLlmMentionsLimit`, `LLM_RESPONSE_WEB_SEARCH_DEFAULT = true`, `fetchLlmMentionsSearch`, `fetchLlmAggregatedMetrics`, `fetchLlmTopPages`, `fetchLlmCrossAggregatedMetrics`, `fetchLlmResponse(input & { timeoutMs?: number })`. Country support from `src/shared/web-search-countries.ts`. |
| `serp.ts` | PORT `serp.ts` | `SERP_ANALYSIS_DEPTH`, `clampSerpDepth` (re-exported from F03's `src/lib/pricing/dataforseo.ts`, not redefined), `fetchLiveSerp`, `fetchRankCheckSerp`, `postRankCheckTasks`, `fetchRankCheckTaskResult`, `fetchLocalSerp`, `postLocalSerpTasks`, `fetchLocalSerpTaskResult`, types `SerpLiveItem`, `RankCheckResult`, `RankCheckTaskInput`, `PostedRankCheckTask`, `LocalSerpTaskOutcome`. POSTs never retry. |
| `appendix.ts` | COPY `appendix.ts` | `fetchUserData()` (free GET `/v3/appendix/user_data`) → `{ login, timezone, money: { total, balance, statistics } }`. Callers may log only `balance` deltas, never `login`. |
| `dataforseoEvidence.ts` | PORT `providers/dataforseoEvidence.ts` | `parseDataforseoAnswer(raw, engine)`, `parseLlmResponseAnswer(result)` (adds `fanOutQueries: string[]` ≤ 20, `outputTokens: number \| null`, `webSearch: boolean`, `modelName: string \| null`), `markdownToText`, `ParsedAiAnswer`, `AiCitation`. Uses `src/shared/safe-url.ts`. |
| `locations.ts` | PORT subset of `keyword-locations.ts:79,132,216,436,493-504` and `ai-visibility.ts:297-318` | `export const DATAFORSEO_LOCATION_BY_COUNTRY = { in: 2356, us: 2840, uk: 2826, sg: 2702, ae: 2784, ca: 2124, au: 2036 } as const` (our `SUPPORTED_COUNTRIES`, `src/lib/engines/serpGeo.js:16`); `export const ISO_BY_COUNTRY = { in: "IN", us: "US", uk: "GB", sg: "SG", ae: "AE", ca: "CA", au: "AU" }`; `export const AI_UNSUPPORTED_LOCATIONS` (their values); `export function dataforseoMarket(ctx: { country: string; language: string }): { locationCode: number; languageCode: string; isoCountry: string }` (throws `AppError(422,"dataforseo_location_unsupported")` for a country outside the map). |
| `answers.ts` | new | The only export surface for answer-engine calls: re-exports `postAiTrackingTasks`, `fetchAiTrackingTaskResult`, `fetchAiTrackingLiveAnswer`, `fetchLlmResponse`, `resolveLatestLlmModelName`, `isKnownLlmModelName`, parsers. Header comment: "Answer-engine calls. Callers must hold a claim from claim_probe_dispatch (conventions §6.1). Do not wrap in metered()." |
| `client.ts` | PORT `client.ts:71-319` structure; metering is F01's | §6.2.3 |
| `index.ts` | PORT `index.ts` | Public surface: `createDataforseoClient`, `meter`, `meterBatch`, types; **not** the answer fetchers. |

Shared (client-safe) files:

| File | Mode | Exports |
|---|---|---|
| `src/shared/web-search-countries.ts` | COPY `prompt-search-countries.ts` | `WEB_SEARCH_COUNTRY_CODES`, `supportsWebSearchCountry(model, iso)` |
| `src/shared/safe-url.ts` | COPY `safe-url.ts` | `safeHttpUrl`, `safeHostname`. F04 copies the same file; whichever PR lands second keeps it unchanged (no fork, no re-copy). |

#### 6.2.1a Section files added by later specs

F02 owns the client shape; later specs add section files next to it under `src/lib/providers/dataforseo/` and register their entries in `createDataforseoClient()` with `meter`/`meterBatch` exactly as typed in §6.2.3. Those signatures are frozen: `meter(fetcher, estimate, defaultFeature, deps?)` and `DataforseoCallContext = { brandKey, idempotencyKey, maxUsd?, jobId?, ttlSeconds?, feature? }`. A later spec that needs another field adds it as optional and updates this table.

| File | Added by | Client namespace |
|---|---|---|
| `labs.ts`, `google-ads.ts`, `keyword-metrics.ts`, `filters.ts`, `researchScopeFilters.ts`, `serp-locations.ts` | F13 (F14 reuses `labs.ts`) | `labs.*`, `googleAds.*`, `keywordMetrics.*` |
| `backlinks.ts`, `backlinksTarget.ts` | F16 (phase 1 research kit is F13's) | `backlinks.*` |
| `business.ts` | F17 | `business.*` |
| `lighthouse.ts` | F18 | `lighthouse.*` |

Every entry's estimator lives in F03's `src/lib/pricing/dataforseo.ts`; `noPrices.test.mjs` (P2.T1.S3) covers the new files automatically. None of these files may import `answers.ts` or `ai-tracking.ts`.

#### 6.2.2 Error classification (F01 classes)

`core.ts` and `envelope.ts` throw only the classes below. The call-outcome classes (`ChargedCallError`, `UnbilledCallError`, `AmbiguousCallError`) extend plain `Error`, not `AppError` (conventions §5.1), and carry the status/code shown for `toErrorResponse`; the other rows throw `AppError`. `endpoint` is the request path without query.

| Situation | Thrown | status / code |
|---|---|---|
| `DATAFORSEO_API_KEY` missing | `AppError` | 503 `dataforseo_not_configured` |
| HTTP 401 | `UnbilledCallError` | 502 `dataforseo_auth_failed`, `details.providerCode = "dataforseo_http_401"` |
| HTTP 402, or top-level/task status 40200/40210, or billing words (classifier) | `UnbilledCallError` | 402 `dataforseo_balance` |
| HTTP 429 | `UnbilledCallError` | 429 `dataforseo_rate_limited` |
| HTTP 400/403/404 | `UnbilledCallError` | 502 `dataforseo_request_refused` |
| HTTP 5xx on POST | `AmbiguousCallError` | 503 `dataforseo_unavailable` (a 5xx does not prove the call was not billed, `core.ts:160-162`) |
| Timeout/abort on POST | `AmbiguousCallError` | 504 `dataforseo_timeout` |
| HTTP 5xx or timeout on GET after retries | `AppError` | 503 `dataforseo_unavailable` (free, nothing billed) |
| Top-level status ≠ 20000 (not balance) | `UnbilledCallError` | 502 `dataforseo_request_failed`, `details.statusCode` |
| Task failed, billing metadata present (any cost ≥ 0), not "Invalid Field with cost 0" | `ChargedCallError` | 502 `dataforseo_task_failed`, `actualUsd = cost`, `details.upstream = isUpstreamFailureStatus(code)` |
| Task failed "Invalid Field" with cost 0 | `UnbilledCallError` | 422 `dataforseo_invalid_field`, `details.field` |
| Task failed, no billing metadata | `AmbiguousCallError` | 502 `dataforseo_task_failed` |
| 40501 "No Search Results" where allowed | none | empty success |
| Response not JSON | `AmbiguousCallError` for POST, `AppError(502,"dataforseo_bad_response")` for GET | — |

Every error sets `details.providerCode = "dataforseo_" + (taskStatus ?? "http_" + httpStatus)` so the engine adapters can hand it to `classifyProviderFailure` (§6.2.6).

#### 6.2.3 Reusable metered client (`client.ts`)

```ts
import type { SpendFeature } from "../../../shared/spend-features.ts";
export type DataforseoCallContext = {
  brandKey: string; idempotencyKey: string; maxUsd?: number; jobId?: string; ttlSeconds?: number;
  feature?: SpendFeature;                 // overrides the entry's default feature (OpenSEO creditFeature)
};
export function meter<I, T>(
  fetcher: (input: I) => Promise<DataforseoApiResponse<T>>,
  estimate: (input: I) => number,         // must come from src/lib/pricing/dataforseo.ts
  defaultFeature: SpendFeature | null,    // null = caller must pass ctx.feature
  deps?: { metered?: typeof metered },
): (ctx: DataforseoCallContext, input: I) => Promise<T>;
export function meterBatch<I, T>(
  fetcher: (input: I) => Promise<DataforseoApiResponse<T>>, estimate: (input: I) => number,
  defaultFeature: SpendFeature | null, deps?: { reserveSpend?; settleSpendBatch?; releaseSpend?; keepAlive? },
): (ctx: DataforseoCallContext, inputs: I[]) => Promise<PromiseSettledResult<T>[]>;
export function createDataforseoClient(): {
  serp: { live: Metered<FetchLiveSerpInput, SerpLiveItem[]>;
          rankCheckBatch: MeteredBatch<RankCheckInput, RankCheckResult>;
          rankCheckTaskPost: Metered<PostRankCheckInput, PostedRankCheckTask[]>;
          local: Metered<LocalSerpInput, Record<string, unknown>[]>;
          localTaskPost: Metered<PostLocalSerpInput, Array<string|null>> };
  aiSearch: { mentionsSearch; aggregatedMetrics; topPages; crossAggregatedMetrics };   // LLM-mentions database, NOT answer engines
};
```

- `meter` calls F01 `metered({ brandKey, feature: ctx.feature ?? defaultFeature, estimateUsd: usd6(estimate(input)), maxUsd, idempotencyKey, jobId, ttlSeconds }, async () => { const r = await fetcher(input); return { value: r.data, actualUsd: r.billing.costUsd, provider: "dataforseo", endpoint: dataforseoEndpoint(r.billing.path), billed: true, units: 1 }; })`. A missing feature → `AppError(500,"spend_feature_required")` before any reservation.
- `meterBatch` (PORT of `meterDataforseoCalls`, `client.ts:333-414`): `reserveSpend` once for the summed estimate with `idempotencyKey`; runs the calls with `Promise.allSettled`; collects per-call costs (`ChargedCallError.actualUsd`; resolved `billing.costUsd`; `AmbiguousCallError` → `actualUsd: null`; `UnbilledCallError` → omitted); `settleSpendBatch(holdId, costs)` (or `releaseSpend(holdId,"not_billed")` when no call was billed); the post-reserve work is registered with `keepAlive` and awaited (`client.ts:404-413`).
- Estimators are bound here from F03: `dataforseoPricing.serp.live`, `.serp.rankCheck`, `.serp.rankCheckTaskPost`, `.serp.local`, `.serp.localTaskPost`, `.aiSearch.mentionsSearch`, `.aiSearch.aggregatedMetrics`, `.aiSearch.topPages`, `.aiSearch.crossAggregatedMetrics`. Each binding maps the fetcher input to F03's local input type in one arrow function (for example `(i) => dataforseoPricing.serp.live({ depth: i.depth ?? SERP_ANALYSIS_DEPTH, keyword: i.keyword })`).
- **Sections owned by other specs are not added to `client.ts`.** F13/F14 (Labs, Google Ads), F16 (backlinks), F17 (business, local grid), F18 (Lighthouse) each port their section file to `src/lib/providers/dataforseo/<section>.ts` and export `create<Section>Client()` built with `meter`/`meterBatch` and their F03 estimator. This keeps parallel PRs conflict-free.
- Default features: none of the `serp.*` or `aiSearch.*` entries has a default; consumers pass `ctx.feature` (for example F15 `rank_tracking.check`).

#### 6.2.4 Engine adapters (`src/lib/engines/dataforseo.ts`, new, TS)

```ts
export type DataforseoRouteMode = "scraper_live" | "scraper_queued" | "serp_live" | "serp_queued" | "model_live";
export type DfsProbeOptions = { stats?: object; deadlineAt?: number; measurementContext: { country: string; language: string };
  captureEvidence?: (i: { payload: unknown; provider: "dataforseo"; surface: string; requestId: string | null }) => Promise<void>;
  model?: string | null;   // frozen llm_responses model name
  webSearch?: boolean;     // llm_responses only; default true (scans always true; F11 may pass false)
  countryIso?: string | null; // llm_responses web_search_country_iso_code; default ISO_BY_COUNTRY[measurementContext.country]; null = none
  maxOutputTokens?: number;   // llm_responses only; default 4096 (clamped 256-4096)
  env?: Record<string, string | undefined>; fetchImpl?: typeof fetch };
export async function probeDataforseoScraper(engine: "chatgpt" | "gemini", query: string, o: DfsProbeOptions): Promise<TextProbeResult>;
export async function probeDataforseoModel(engine: "perplexity" | "chatgpt" | "gemini", query: string, o: DfsProbeOptions): Promise<TextProbeResult>;
export async function fetchDataforseoAioSerp(query: string, o: DfsProbeOptions): Promise<AioSerpData>;   // consumed by probeAioDataforseo in enginePipeline.js
export function dataforseoTextResult(engine: string, answer: ParsedAiAnswer, task: { id: string; cost: number; data?: unknown },
  meta: { method: "consumer_capture" | "model_api"; requestedModel: string | null; returnedModel: string | null;
          webSearch: boolean | null; fanOut: string[]; outputTokens: number | null }): TextProbeResult;
export async function postDataforseoBatch(engine: "chatgpt" | "gemini" | "google_ai_overview",
  rows: { observationId: string; query: string }[], market: DataforseoMarket, o): Promise<PostOutcome>;     // phase 4
export async function collectDataforseoTask(engine, taskId: string, o): Promise<CollectOutcome>;           // phase 4
```

`TextProbeResult` is the object `probeTextEngine` consumes (`enginePipeline.js:279-350`): `{ text, answer_markdown, citations, references: [{href,title,source}], model, requested_model, returned_model, provider_request_id, search_requests, cost, cost_source, cost_state, cost_state_detail, error, error_kind, provider_failure, citations_state, citations_state_reason, citations_state_detail, gateway, measurement_method, fan_out_queries, output_tokens, web_search, location_code, provider_task_id }`.

Mapping rules:
- `text` = `answer.answerText` (plain prose with citation pills removed, `dataforseoEvidence.ts:120-135`) when present, else `""`. Mention detection, entity evidence and every stored span offset index into this plain `text`, so a pill like `[offcult.com](https://offcult.com/…)` is never counted as a textual mention. `answer_markdown` = `answer.answerMarkdown` (the engine's markdown, for display only; F11 and F12 render it). `references` from `answer.citations` (`href = url`, `title = title ?? ""`, `source = domain`); `citations` = normalised urls (`normalizeUrl`, `src/lib/scoring/citations.js`).
- `cost` = `task.cost` (provider-reported), `cost_source: "gateway"` (F03 maps `gateway` → `provider_reported`), `cost_state: "measured"`. A failure with billing metadata keeps its cost; a failure without one has `cost: null`, `cost_state: "unknown_billed"`.
- `search_requests`: llm_responses → `web_search === true ? 1 : 0`; scraper → `null` (unknown; the consumer app decides). `citations_state` = `"verified"` when references exist, else `"unverified"` with reason `"web_search_not_used"` for llm_responses with `web_search === false` and `"none_returned"` otherwise.
- `gateway: "dataforseo"`; `measurement_method`: scraper `consumer_capture`, llm_responses `model_api`, organic `google_serp` (`src/lib/provenance.js` `MEASUREMENT_METHOD`).
- `requested_model`: scraper `"dataforseo:llm_scraper:<engine>"`; llm_responses the frozen model name. `returned_model`: `result.model_name ?? null` (never the requested name, `provenance.js` rule).
- No answer text, prompt, or task payload is logged. `captureEvidence({ payload: task, provider: "dataforseo", surface: engine, requestId: task.id })` runs once per answer before parsing.
- AIO: `probeAio` (`enginePipeline.js:97-218`) gains a sibling `probeAioDataforseo(query, brand, aliases, domain, competitors, stats, options)` in `enginePipeline.js` with the same output shape: `serp_state: "valid_serp"` when the task returned an items list (even without an Overview), `aio_present` from `parseDataforseoAnswer(taskResult, "google_ai_overview").answerMarkdown !== null`, `aio_capture_mode: "dataforseo_async"`, `organic` from `type === "organic"` items (`rank_group`, `domain`, `url`), `cost` from task cost, `gateway: "dataforseo"`. An empty task result (no SERP) is `serp_state: "unknown_schema"` and an error, never `valid_no_aio`.

#### 6.2.5 Routing and fallback (`src/lib/engines/engineRoutes.ts`, new)

```ts
export type EngineName = "aio" | "chatgpt" | "gemini" | "perplexity";   // claude deferred
export type RouteId = "dataforseo" | "brightdata" | "openrouter" | "vendor_api";
export const DEFAULT_ROUTE_ORDER: Record<EngineName, RouteId[]> = {
  aio: ["brightdata"], chatgpt: ["vendor_api", "openrouter"], gemini: ["openrouter"],
  perplexity: ["vendor_api", "openrouter"] };
export const DATAFORSEO_APPROVED_ENGINES: readonly EngineName[] = [];          // set from the decision record (§6.8)
export const DATAFORSEO_SCAN_MODES: Record<EngineName, DataforseoRouteMode> = {
  aio: "serp_queued", chatgpt: "scraper_queued", gemini: "scraper_queued", perplexity: "model_live" };
export function parseAnswerEngineRoutes(raw: string | undefined): Partial<Record<EngineName, RouteId[]>>;
export function routeOrder(engine: EngineName, env): RouteId[];
export function isRouteConfigured(engine: EngineName, route: RouteId, env): boolean;
export function isRouteScanCapable(engine: EngineName, route: RouteId): boolean;
export async function resolveFrozenRoutes(engines: EngineName[], deps: { env; isFeatureEnabled; openCircuitKeys: Set<string> }):
  Promise<Record<EngineName, { route: RouteId; model: string | null; fallbackFrom: RouteId | null }>>;
export function requestBudgetMs(engine: EngineName, route: RouteId | undefined): number;   // 70_000 default; 140_000 dataforseo scraper/serp live; 100_000 dataforseo model
export function leaseSecondsFor(engine: EngineName, route: RouteId | undefined): number;    // 120 default; 180 for dataforseo live
export function laneConcurrency(engine: EngineName, route: RouteId | undefined, env): number; // 1 default; DATAFORSEO_SCAN_MODEL_CONCURRENCY (default 3, max 6) for dataforseo model_live
```

- `ANSWER_ENGINE_ROUTES` (server-only) format: `engine=route>route;engine=route`, for example `aio=dataforseo>brightdata;chatgpt=dataforseo>openrouter;gemini=dataforseo>openrouter;perplexity=dataforseo>openrouter`. Unknown engines or routes → `AppError(500,"answer_engine_routes_invalid")` at parse. Engines missing from the variable use `DEFAULT_ROUTE_ORDER`, which reproduces today's selection exactly (`providerReadiness.js:210-242`: direct key present → `vendor_api`, else gateway).
- `isRouteConfigured`: `dataforseo` → `DATAFORSEO_API_KEY` set; `brightdata` → `BRIGHTDATA_API_KEY`; `openrouter` → `isOpenRouterEngineConfigured(engine)` (`openRouterProbe.js:41-47`); `vendor_api` → the engine's direct variable (`OPENAI_API_KEY`, `PERPLEXITY_API_KEY`).
- `isRouteScanCapable`: `dataforseo` for `chatgpt`, `gemini`, `aio` is scan-capable only after phase 4 (`QUEUED_COLLECTION_READY = true` exported from `src/lib/workers/queuedCollection.js`); before that only canaries and F11 may use those routes.
- `resolveFrozenRoutes` (called once per scan inside `runDurableProbing` when `cp.dispatch.routes` is absent): for each engine, the first route in order that is configured, allowed (`dataforseo` requires `await isFeatureEnabled("dataforseo_engines")` **and** the engine in `DATAFORSEO_APPROVED_ENGINES`), scan-capable, and whose circuit key (`hashIdentity(circuitIdentity(engine, env, { route }))`) is not in `openCircuitKeys` (from `store.circuits()`, `probeDispatch.js:124-131`). For a `dataforseo` model route it resolves the model name once (`resolveLatestLlmModelName`, free) and freezes it. `fallbackFrom` records the skipped first choice. If no route qualifies, the engine resolves to its first configured route, so the existing claim path blocks it with `provider_circuit_open` exactly as today.
- **Fallback never happens mid-scan.** `dispatchRow` compares `dispatchIdentity(engine, env, { route: cp.dispatch.routes[engine].route, model })` with the frozen `config_version` (`durableProbing.js:157-168`). A circuit that opens during a scan blocks the remaining rows of that engine; the next scan freezes the fallback. This keeps one engine slice of one scan on one provider, which the comparability rules need.
- The scan report already shows the measurement method; the frozen route and `fallbackFrom` are added to `cp.dispatch.routes` and therefore to the finalized `raw_results.engines[engine].route` (one property in `runFinalizePhase`'s engine slice, `scanWorker.js` finalize).

#### 6.2.6 Changes to existing modules

| File | Change |
|---|---|
| `src/lib/vendorRegistry.js` | Add `{ key: "dataforseo", env: ["DATAFORSEO_API_KEY"], required: false }` (Claude entry deferred: `{ key: "claude", env: [LLM_ENV.apiKey.canonical], legacy: { [LLM_ENV.apiKey.canonical]: [LLM_ENV.apiKey.legacy] }, required: false }` (mirrors `gemini`, `:78`). |
| `src/lib/engines/providerReadiness.js` | **(Claude surface deferred)** `ENGINE_SURFACES.claude = { label: "Claude", provider: "anthropic", required_groups: [{ registry: "claude" }], direct_variables: [], gateway: "openrouter" }`. `resolveRoute(engine, env, opts = {})`, `credentialFingerprint(engine, env, opts)`, `configVersion(engine, env, opts)`, `circuitIdentity(engine, env, opts)`, `validateEngineConfig(engine, env, opts)`, `planEngineCanary(engine, env, opts)` gain `opts.route` and `opts.model`. `opts.route === "dataforseo"` → `{ adapter: "vendor_api", provider: "dataforseo", gateway: null, model: opts.model ?? dataforseoModelLabel(engine), credential_names: ["DATAFORSEO_API_KEY"] when set }` where `dataforseoModelLabel` is `llm_scraper:chatgpt`, `llm_scraper:gemini`, `serp:google_organic:async_aio`, or `llm_responses:<slug>:catalogue`. `opts.route === "openrouter"` forces the shared-gateway branch; `"vendor_api"`/`"brightdata"` force the native branch; `undefined` keeps today's branch, so existing strings do not change (F02-AC-21). All DataForSEO routes share one circuit identity `{ provider: "dataforseo", account: <fingerprint> }`: one balance failure stops every DataForSEO engine. |
| `src/lib/db/probeDispatch.js` | `dispatchIdentity(engine, env, opts)` passes `opts` through. `store.claim(id, { reserve, scanCap, dayCap, leaseSeconds })` sends `p_lease_seconds: leaseSeconds ?? PROBE_LEASE_SECONDS`. New `store.renew(id, token, seconds)` → `renew_probe_dispatch`. New export `withLeaseRenewal(store, id, token, seconds, fn)`: runs `fn()`, calls `store.renew(id, token, seconds)` every 60 s until `fn` settles, never throws from a failed renewal (logs `[dispatch] lease renewal failed {id}`), and returns `fn`'s result (used by scans, the bake-off and F11). Phase 4: `store.post`, `store.collect`, `store.reschedule`, `store.listPosted(jobId)`. |
| `src/lib/workers/durableProbing.js` | `freezeDispatch`/`runDurableProbing` add `cp.dispatch.routes` (from `resolveFrozenRoutes`) on first freeze; identities use `{ route, model }`. `dispatchRow` passes `{ route, model }` to `engine.probe` options, uses `leaseSecondsFor`, `requestBudgetMs` (deadline and the lane budget check at `:272`), wraps the probe in `withLeaseRenewal(store, row.id, token, leaseSeconds)` (renew every 60 s, stop on settle). Lanes run `laneConcurrency` claims at a time; a lane stops starting new claims after a result whose `provider_failure.opens_circuit` is true. Phase 4 routes `*_queued` engines through `runQueuedLane` (§6.3). A checkpoint without `routes` (a scan frozen before this change) resolves every engine to `undefined`, i.e. today's behaviour. |
| `src/lib/scoring/enginePipeline.js` | `probeTextEngine` sets `gateway: probeResult.gateway ?? "openrouter"`, `method: probeResult.measurement_method ?? "model_api"`, and copies `answer_markdown`, `fan_out_queries`, `output_tokens`, `web_search`, `location_code`, `provider_task_id` onto the result (`probeAioDataforseo` sets `answer_markdown` from the AI Overview markdown the same way). Registry probes select the adapter from `options.route` (table below). Adds the `claude` entry and `probeAioDataforseo`. `ENGINE_WEIGHTS.claude = 1`. |
| `src/lib/engines/openRouterProbe.js` | Result gains `gateway: "openrouter"`. (The `claude` default model and `OPENROUTER_CLAUDE_MODEL` are deferred.) |
| `src/lib/engines/openai.js`, `perplexity.js` | Results gain `gateway: "openai"` / `gateway: "perplexity"` on the native path and `"openrouter"` on the gateway path. `brightdata.js`-backed `probeAio` sets `provenance.gateway: "brightdata"`. |
| `src/lib/engines/providerFailure.js` | `PROVIDER_CODE_KINDS` adds `dataforseo_http_401: AUTHENTICATION`, `dataforseo_40100: AUTHENTICATION`, `dataforseo_40200: SPEND_LIMIT`, `dataforseo_40210: SPEND_LIMIT`, `dataforseo_http_402: SPEND_LIMIT`, `dataforseo_http_429: RATE_LIMIT`, `dataforseo_40101`/`40103`/`50000`/`50301`/`50302`/`50303`/`50304`/`50401`/`50402: TRANSIENT`, `dataforseo_40501: REQUEST`, `dataforseo_50100: REQUEST`, `dataforseo_timeout: TIMEOUT`. Adapters build `provider_failure = classifyProviderFailure({ provider: "dataforseo", error })` from the thrown error (its `details.providerCode` is read via `error.providerCode`). |
| `src/lib/engines/serpGeo.js` | `ADAPTER_CAPABILITIES` adds `chatgpt_dataforseo`, `gemini_dataforseo`, `aio_dataforseo` (`countryControl: true`, `languageControl: true`, `observedLocationAttested: false`) and `claude_dataforseo`, `perplexity_dataforseo` (`countryControl: true`, `languageControl: false`), `gemini_dataforseo_model` (`countryControl: false`). `buildAdapterContextParams(engine, ctx, "dataforseo")` returns `{ location_code, language_code }` (scraper/SERP) or `{ web_search_country_iso_code }` (model), from `dataforseoMarket`. |
| `src/lib/engines/deployedEngines.js` | No change (Claude label deferred). |
| `src/app/page.js` | No change (Claude note deferred). |
| `scripts/check-secrets.mjs` | New function `checkRouteFunding()` used inside `checkEngineAdvertising`: an advertised engine is unfunded when none of its configured routes (`routeOrder` + `isRouteConfigured`) is available; message "MISMATCH: the page advertises Claude, but no answer route for it is configured (routes: dataforseo>openrouter). Configure one, or drop it from ENGINES and NEXT_PUBLIC_ENGINES." Adds a vendor check for `dataforseo` that calls the free `fetchUserData()` and prints PASS/FAIL only (never `login` or balance). |
| `src/lib/engines/types.js` | No change (Claude deferred). |
| `src/components/portal/scans/ReportCards.jsx` | `AnswerBlock` (`:102-119`): `row.raw?.measurement_method === "consumer_capture" ? <Badge>Consumer app</Badge>` beside the existing `Model API` badge. |
| `.env.example` | Names only: `DATAFORSEO_API_KEY=`, `DATAFORSEO_BASE_URL=`, `ANSWER_ENGINE_ROUTES=`, `FEATURE_DATAFORSEO_ENGINES=off`, `DATAFORSEO_LLM_MODEL_CHAT_GPT=`, `DATAFORSEO_LLM_MODEL_GEMINI=`, `DATAFORSEO_LLM_MODEL_PERPLEXITY=`, `DATAFORSEO_SCAN_MODEL_CONCURRENCY=3`, each with a one-line comment. |
| `src/lib/features/names.ts` | `dataforseo_engines: { spend: [] as const }`. |
| `src/shared/spend-features.ts` | `"providers.dataforseo.selftest": "DataForSEO check"`. |

Registry adapter selection (`enginePipeline.js` `ENGINE_REGISTRY`):

| Engine | `options.route` | Adapter |
|---|---|---|
| `aio` | `undefined`/`brightdata` | `probeAio` (today) |
| `aio` | `dataforseo` | `probeAioDataforseo` (live in canaries; queued in scans via §6.3) |
| `chatgpt` | `undefined` | today (`probeChatGpt`) |
| `chatgpt` | `vendor_api` / `openrouter` | `probeChatGpt` native / `probeOpenRouterEngine({engine:"chatgpt"})` |
| `chatgpt`, `gemini` | `dataforseo` | `probeDataforseoScraper` (live) or queued (§6.3) |
| `gemini` | `undefined`/`openrouter` | today |
| `perplexity` | `undefined`/`vendor_api`/`openrouter` | today (`probePerplexity` picks native vs gateway) |
| `perplexity` | `dataforseo` | `probeDataforseoModel` |

`isConfigured` for each entry becomes `routeOrder(name, env).some((r) => isRouteConfigured(name, r, env))`.

### 6.3 Jobs

F02 adds no customer job kinds. Scans stay on the scan worker (F01 §6.3.8).

**Queued collection inside the scan worker (phase 4), `src/lib/workers/queuedCollection.js` (new, JS like its caller):**

```js
export const QUEUED_COLLECTION_READY = true;
export const POLL_OFFSETS_MIN = [2, 4, 7, 10, 14, 18, 22, 26, 30];   // cumulative, OpenSEO AiVisibilityWorkflow.ts:44-58
export const COLLECT_WINDOW_MIN = 30;
export const TASK_GET_CONCURRENCY = 25;                               // aiVisibilityCollection.ts:313-314
export function nextPollAt(postedAtMs, nowMs) { /* first postedAt+offset > now, else null */ }
export async function runQueuedLane({ engine, rows, cp, store, budget, now, env, chunkStartMs, budgetMs, tally });
```

`runQueuedLane` for one engine, per chunk:
1. **Collect pass** (free). `store.listPosted(jobId)` rows of this engine with `next_attempt_at <= now`, in chunks of 25 concurrently: `collectDataforseoTask(engine, taskId)` (GET; READ retries 2).
   - `pending` → `nextPollAt(posted_at, now)`; non-null → `store.reschedule(id, token, next)`; null → `store.collect(id, token, notCollectedResult, "failed", {kind:"not_collected", opens_circuit:false})`.
   - `completed` → `captureEvidence` with the attempt token, parse (`parseDataforseoAnswer`), build the full engine result through the same `probeTextEngine`/`probeAioDataforseo` post-processing (mention detection, competitors, entity evidence) with a `prefetched` adapter result, then `decision = resultDecision(result, attempt_no, deadline, now)` and `store.collect(id, token, result, decision.state, decision.failure, decision.next_at, task.costUsd ?? null)`.
   - `failed` → result with `provider_failure` from `details.providerCode`; `resultDecision` yields `retry` for transient backend codes (a new claimed, billed attempt later) or `failed` otherwise; `store.collect(id, token, result, decision.state, decision.failure, decision.next_at, null)`.
   - A thrown GET error leaves the row posted (next round).
2. **Post pass** (billed). While budget allows: take up to 100 due `pending`/`retry` rows of this engine; `store.claim` each with `leaseSeconds: 120`; stop claiming at the first refusal whose reason is `provider_circuit_open`, `spend_reservation_refused` or `dispatch_paused` (sets `cp.blocked` as today). For the granted set: `postDataforseoBatch(engine, rows, market)` → one `task_post`.
   - Accepted entry → `store.post(id, token, taskId, entry.cost, now + 120 s, now + 30 min)`. A `stale_lease` answer is recorded as ambiguous by SQL.
   - Rejected entry → `store.finish(id, token, failedResult({ cost: entry.cost, providerCode: "dataforseo_" + entry.status_code }), resultDecision(result, claim.attempt_no, Date.parse(cp.dispatch.deadline_at), now()))`.
   - `UnbilledCallError` for the whole post → each granted row `store.finish` with `cost: 0` (measured zero) and its decision.
   - `AmbiguousCallError` or any other error → no finish; the leases expire and the next claim marks them `ambiguous` with `dispatch_unknown` (`035:19-23`), so an operator reconciles them. `cp.blocked = { reason: "dispatch_unknown", … }` as `durableProbing.js:300-305` does.
3. Return; `runDurableProbing` computes `resumeAt` from `next_attempt_at` of posted rows (posted is non-terminal, `durableProbing.js:19-25` unchanged), and the scan worker bridges waits under 10 minutes (`scanWorker.js:1181-1187`).

**Periodic sweep (phase 4):** `src/lib/workers/queuedCollection.jobs.ts` registers `definePeriodic({ name: "dataforseo.posted_sweep", everySeconds: 300, run: () => enqueueSystemJob("dataforseo.posted_sweep", {}, { dedupeKey: "dataforseo.posted-sweep:" + slot5m }) })` and `defineJob("dataforseo.posted_sweep", ctx => ctx.step.do("expire", DB_STEP, () => rpc("expire_posted_probe_dispatch", { p_limit: 200 })))`. Imported from `src/lib/jobs/kinds.ts`. Retention: rows live in P0 tables; no new retention.

### 6.4 Provider calls and cost

| Use | Endpoint | Request body (per task) | Response fields used | Unit price source | Retries |
|---|---|---|---|---|---|
| ChatGPT/Gemini queued | `POST /v3/ai_optimization/{chat_gpt\|gemini}/llm_scraper/task_post` (≤ 100 tasks) | `{ keyword: escape(q), location_code, language_code: providerLanguageCode(engine, lang), tag: observationId }` | `tasks[].id, status_code, status_message, cost, data.tag` | F03 `aiAnswerUsd(engine,"queued")` = 0.0012 | 0 |
| … collection | `GET …/llm_scraper/task_get/advanced/{id}` | — | `tasks[0].status_code`, `result[0].markdown, sources, datetime`, `cost` | free | 2 |
| ChatGPT/Gemini live | `POST …/llm_scraper/live/advanced` | same, one task | as above | `aiAnswerUsd(engine,"live")` = 0.004 | 0 |
| Google AIO queued/live | `POST /v3/serp/google/organic/task_post` or `/live/advanced` | `{ keyword, location_code, language_code, depth: 10, load_async_ai_overview: true, tag }` | `result[0].items[]` (`type`, `ai_overview.markdown/references/items`, `organic.rank_group/domain/url`), `cost` | 0.0012 queued / 0.004 live | 0 |
| Claude/Perplexity (and ChatGPT/Gemini model for F11) | `POST /v3/ai_optimization/{slug}/llm_responses/live` | `{ user_prompt, model_name, web_search: true, force_web_search: true (claude only), max_output_tokens: 4096, web_search_country_iso_code (not gemini) }` | `model_name, output_tokens, web_search, items[].sections[].text/annotations, fan_out_queries`, `cost` | F03 `llmResponseUsd(slug, true)`: 0.18 claude, 0.04 perplexity | 0 |
| Model catalogue | `GET /v3/ai_optimization/{slug}/llm_responses/models` | — | `result[].model_name` | free | 2 |
| Account | `GET /v3/appendix/user_data` | — | `money.balance` | free | 2 |
| Sandbox validation (bake-off dry run) | `https://sandbox.dataforseo.com` same paths | same | status codes only | free | 0 |

Escaping: `keyword.replace(/%/g,"%25").replace(/\+/g,"%2B")` (`ai-tracking.ts:78-79`).

**Reservation for answers.** Answer-engine attempts are reserved by `claim_probe_dispatch` with `dispatchBudget().reserve` (`SCAN_PROBE_RESERVATION_USD`, `durableProbing.js:26-41`), unchanged. F03's ledger sync records the actual task cost per attempt. The bake-off reserves `--reserve-usd` per observation (default 0.20).

**Cache.** `llm-models.ts` caches the catalogue in process (1 h). No `provider_cache` namespaces are used by F02 (answers are never cached; they are measurements).

**Fixtures** (`tests/fixtures/f02/`, synthetic or hand-trimmed from DataForSEO's public documentation shapes; answer text replaced by short neutral sentences; no account ids):
`scraper-task-post.json` (3 accepted, 1 rejected 40501 Invalid Field cost 0, 1 rejected cost 0.0012), `scraper-task-get-pending.json` (20100), `scraper-task-get-done.json` (markdown with `[openseo.so](…utm_source…)` pill, sources incl. `javascript:`), `scraper-task-get-backend-failed.json` (40101 with cost), `serp-aio-task-get.json` (ai_overview + organic), `serp-no-aio-task-get.json` (organic only, cost 0.0006), `serp-no-results.json` (40501 No Search Results), `llm-responses-claude.json` (sections, annotations, `fan_out_queries`, `output_tokens: 812`, `web_search: true`), `llm-responses-no-search.json`, `llm-models-catalogue.json`, `user-data.json` (`money.balance` only), `http-401.json`, `balance-40200.json`, `top-level-50000.json`, and `bakeoff-run/` (§6.8).

### 6.5 API routes

None. F02 adds no customer or operator route. Readiness keeps flowing through the existing `GET /api/health` and `GET /api/measurement/operations` (`src/app/api/measurement/operations/route.js`), which already call `readProviderReadiness` and therefore list `claude` and DataForSEO-routed engines once `ENGINE_SURFACES` includes them.

### 6.6 UI

No new screens. Two visible changes, both phase 3:

1. Customer scan report answer block (`src/components/portal/scans/ReportCards.jsx:102-119`): a neutral badge **"Consumer app"** when `raw.measurement_method === "consumer_capture"`, next to the existing **"Model API"** badge. Tooltip (`title`): "Captured from the consumer app through DataForSEO." Engine label "Claude" comes from `reportData.js:16`.
2. Landing engine rail: unchanged (Claude deferred).

### 6.7 Permissions, privacy, observability

- No customer can trigger DataForSEO directly. Scans and canaries run as today (service role, P0 fence). The metered client is called only by later specs' routes after `requireWorkspace()` and with their paid feature enabled.
- **Never logged:** `DATAFORSEO_API_KEY`, Authorization headers, request bodies (prompts), answer markdown, task payloads, `user_data.login`. Allowed log lines: `[dataforseo] model override not in catalogue {slug}`, `[dataforseo] task_post rejected {engine, statusCode, count}`, `[dataforseo] upstream failure {endpoint, statusCode}`.
- Evidence: one private capture per answer under the existing 90-day policy; DataForSEO task JSON contains the echoed request (`data.keyword`), which is the customer's own question and is already stored in `probe_observations.query`.
- PostHog: none (F26 owns telemetry).
- `CLAUDE.md` secrets hygiene applies to every phase; `src/lib/agentSecretsGuard.test.mjs` and `src/lib/checkSecrets.test.mjs` must stay green.

### 6.8 Bake-off (phase 1) and decision record

**Script:** `scripts/qa/check-dataforseo-bakeoff.mjs` (owner-run only). Pure helpers live in `src/lib/providers/dataforseo/bakeoffLib.ts` (collected by the suite glob) so they are unit-testable; the script only wires them to the database and network.

Invocation (refuses unless every flag is present and well-formed; order free):

```sh
PGHOST=127.0.0.1 PGDATABASE=aeovis_live_qa node --env-file=<owner's env file outside Drive> \
  scripts/qa/check-dataforseo-bakeoff.mjs \
  --panel ~/.aeovis-private/demo/offcult-panel.json \
  --run-id offcult-2026-10-22-v1 \
  --arms dfs_queued,dfs_live,dfs_model,current \
  --competitors "Bewakoof,The Souled Store,Uniqlo,Bonkers Corner" \
  --reserve-usd 0.20 --max-requests 400 --max-spend-usd 12 \
  --out ~/.aeovis-private/bakeoff/offcult-2026-10-22-v1 \
  [--dry-run] [--confirm-spend 12]
```

Refusals (exit code 2, one line, no secrets): missing/extra flag; `--max-spend-usd` not in (0, 25]; `--max-requests` not in [1, 600]; `--confirm-spend` absent or ≠ `--max-spend-usd` without `--dry-run`; `PGHOST` not `127.0.0.1`/`localhost` or `PGDATABASE` not ending `_live_qa`; any of `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL` set (deleted is not enough: the script refuses so the owner notices); `--out` inside the repository or Google Drive (`/My Drive/` in the resolved path); `--run-id` not matching `^[a-z0-9-]{8,60}$` or already present under `--out`; the panel file not parseable as `{ context: { country, language }, prompts: [{ text, purpose? }] }` with 1–60 prompts.

Arms (each engine × question is one `purpose='canary'` observation, `context.budget_scope = "bakeoff:" + runId`, `context.max_requests = --max-requests`, `context.request_units` as listed, `deadline_at = now + 60 min`):

| Arm | Engines | Mode | Questions | Request units | Price-table estimate (32 q) |
|---|---|---|---|---|---|
| `dfs_queued` | chatgpt, gemini, google_ai_overview | task_post + task_get, lease held and renewed while polling | all | 1 | 96 × 0.0012 = 0.1152 |
| `dfs_live` | chatgpt, gemini, google_ai_overview | live/advanced, 3 concurrent per engine | all | 1 | 96 × 0.004 = 0.384 |
| `dfs_model` | perplexity (`--perplexity-questions N`, default all; optional arm) | llm_responses, web search on, country `IN` | as stated | 1 | 32 × 0.04 = 1.28 (5 q = 0.20) |
| `current` | aio (Bright Data), chatgpt, gemini, perplexity via today's routes | today's adapters (`resolveEnabledEngines({engines:"aio,chatgpt,gemini,perplexity", allowFallback:false})`) | all | aio 2, perplexity native 2, others 1 | about 7 (20 October run) |

Ceilings enforced three ways: the SQL canary budget (`claim_probe_dispatch` refuses at `--max-spend-usd`, `035:53-69`, `:85-89`), a request counter in the wrapped `fetch` (refuses past `--max-requests` real requests), and a host allowlist (`api.dataforseo.com`, `sandbox.dataforseo.com`, the `LLM_BASE_URL` host, `api.brightdata.com`, `api.openai.com` and `api.perplexity.ai` only if their direct keys are set). The queued arm holds each lease by `store.renew(id, token, 180)` every 60 s while polling on `POLL_OFFSETS_MIN`, then `finish`es; this needs no migration.

`--dry-run`: validates the panel, prints the plan table and the price-table estimate, calls the **sandbox** once per DataForSEO endpoint with the first question and India, calls the free model catalogue for each slug, and exits. Zero paid requests (asserted by the request counter: only sandbox/catalogue hosts and paths are allowed).

Run order: `fetchUserData()` balance before; arms in the order `dfs_queued` (post first, poll while the others run), `dfs_live`, `dfs_model`, `current`; balance after (after a 5-minute settle wait). Then the report.

Outputs (directory mode 0700, files 0600, outside the repository):
- `manifest.json`: run id, timestamps, flags, ceilings, request count, per-observation metadata (engine, arm, question index, state, reason, attempt count, cost, cost source, latency, status codes, provenance without answer text).
- `answers.jsonl`: one line per observation with answer text, citations and extracted brands. **Private; never committed.**
- `review-sample.md`: 10 random answered observations per arm × engine with the extraction beside the text, for the owner's manual fidelity check.
- `summary.json` and `summary.md`: the metrics below, with no answer text. `summary.md` is what the owner pastes into the decision record.

Metrics (per arm × engine unless stated; every rate shows "x of y"):

1. **India location support.** `accepted` = tasks DataForSEO accepted with `location_code 2356` / tasks posted; rejected status codes histogram; `echoed_location` = share of results whose `location_code` equals 2356; heuristic locality = share of answers citing at least one `.in` domain (labelled "heuristic, not location proof").
2. **AI Overview presence.** `aio_present` / `valid_serps` for `dfs_queued`, `dfs_live`, and `current` (Bright Data, with `aio_capture_mode` split). Plus `async_refund_observed` = queued Google tasks whose `cost` < 0.0012 (DataForSEO refunds the async charge when no Overview loads, `ai-tracking.ts:82-83`).
3. **Answer fidelity (extraction parity).** Our extractor (`detectMention`, `findCompetitorsInText` via `probeTextEngine` post-processing, `judgeBrandsSymmetric`, `applyEntityEvidence`) runs on every arm's answers with the same roster (Offcult + `--competitors`). Reported: answered rate; empty-answer rate; Offcult mention rate (non-branded and branded separately); mean competitors named per answer; share of answers with ≥ 1 citation; mean citations; median answer length; parser agreement = share of answers where our `brand_mentioned_in_text` equals the ported OpenSEO matcher (`aiMentionSpans`/`matchAiBrand`, `aiVisibilityMatching.ts:12-98`) for Offcult; cross-arm per-question agreement for the same engine (`dfs_queued` vs `current`, `dfs_live` vs `current`): Offcult-mentioned agreement and citation-domain Jaccard mean. Manual: owner marks each of the `review-sample.md` items correct/incorrect in the decision record.
4. **Latency.** Live: request wall time p50/p90/max (ms). Queued: post → result minutes p50/p90/max, share collected by 10 / 30 minutes.
5. **Failure modes.** Counts by observation state, `provider_failure.kind`, DataForSEO status code, rejected task_post entries, no-results, ambiguous dispatches.
6. **Cost vs price table.** Sum and mean of provider-reported task `cost`; price-table expectation (`aiAnswerUsd`, `llmResponseUsd`); ratio; DataForSEO balance delta (before − after) vs the sum of task costs; OpenRouter `usage.cost` sums and Bright Data price-table cost for `current`; projected cost of one 30-question × 4-engine scan per arm, and of a daily schedule for a month (× 30).

**Terms-of-use check** (owner completes; recorded in the decision record with URL, date read, verbatim quote of at most two lines, and answer):
1. Does DataForSEO's terms of service allow showing LLM Scraper and LLM Responses outputs (answer text, citations) to our customers inside a paid product?
2. May we store those outputs (90-day private evidence; results kept 13 months) and show them later?
3. Is reselling or redistributing DataForSEO data restricted (for example a public share page, F23)?
4. Where is data processed, and is a DPA available? Customer questions are sent to DataForSEO.
5. Are there account rate or concurrency limits for `task_post`, `live` and `llm_responses` that our scan sizes could hit?
6. What are the refund rules for async AI Overview and for failed tasks?
7. Does DataForSEO state any restriction or risk statement about consumer-app capture of ChatGPT and Gemini (third-party platform terms)? Owner records the risk acceptance explicitly.

**Decision record:** `docs/decisions/<YYYY-MM-DD>-dataforseo-answer-provider.md` (date = the run date). Template (the phase 1 PR adds it as `docs/decisions/_template-provider-bakeoff.md`; the owner copies it after the run):

```md
# ADR — DataForSEO as an answer-engine provider

> <!-- doc-status -->
> **Status: LIVE.** Decision record for F02 phase 1.

**Date:** YYYY-MM-DD · **Run id:** <run-id> · **Owner:** <name> · **Decision:** go | partial-go | no-go
**Approved engines:** <comma list of: aio, chatgpt, gemini, perplexity, or "none">

## Context
One paragraph: why the bake-off ran (F02 §1) and what it compared.

## Method
Panel (questions, branded diagnostics, market), arms, ceilings, dates, code commit, request count, total spend.

## Results
Paste `summary.md`: India support, AI Overview presence, extraction parity, latency, failure modes, cost vs price table.

## Manual fidelity review
Per arm × engine: N reviewed, N correct, notes.

## Terms of use
The seven questions from F02 §6.8, each with URL, date read, quote (≤ 2 lines), answer.

## Decision per engine
| Engine | Verdict (go/no-go) | Mode for scans (queued/live/model) | Reason |

## Decision rules applied
The F02 defaults or the owner's overrides (state which).

## Consequences
What phases 2–5 will enable; fallback order; reservation change, if any (SCAN_PROBE_RESERVATION_USD).

## What is NOT verified
Anything the run could not establish.
```

**Default decision rules** (the owner may override in the record): an engine is **go** when (a) India acceptance ≥ 95 %, (b) answered rate ≥ 90 % of valid tasks, (c) failure rate ≤ 5 %, (d) provider cost per answer ≤ 2 × the price table, (e) no terms-of-use item is blocking, (f) manual review ≥ 9 of 10 correct extractions; for `aio` additionally (g) valid SERP rate ≥ Bright Data's on the same run. Decision **go** = all engines go; **partial-go** = at least one; **no-go** = none.

The phase 3 PR sets `DATAFORSEO_APPROVED_ENGINES` to the record's approved list; `dataforseoGate.test.mjs` parses the newest `docs/decisions/*-dataforseo-answer-provider.md` and asserts the lists match (F02-AC-12). No phase 2–5 PR may merge without that record.

## 7. Code reuse map

| OpenSEO source | Perceev target | Mode | Adaptation notes |
|---|---|---|---|
| `openseo:src/server/lib/dataforseo/core.ts` | `src/lib/providers/dataforseo/core.ts` | PORT | Env via injected `env`, not Worker env. POST never retries (theirs retries 5xx by default). Errors are F01 classes (§6.2.2). Base URL limited to prod/sandbox. |
| `openseo:src/server/lib/dataforseo/envelope.ts` (+ `envelope.test.ts`) | `src/lib/providers/dataforseo/envelope.ts` (+ `.test.ts`) | PORT | `DataforseoChargedTaskError` → `ChargedCallError`; non-charged failures → `UnbilledCallError`/`AmbiguousCallError`; `providerCode` detail added. Test cases ported verbatim. |
| `openseo:src/server/lib/dataforseoBillingClassification.ts` | `src/lib/providers/dataforseo/billingClassification.ts` | COPY | Returns `UnbilledCallError(402,"dataforseo_balance")`. |
| `openseo:src/server/lib/dataforseo/shared.ts` | `src/lib/providers/dataforseo/shared.ts` | COPY | `MAX_TASKS_PER_POST` inlined (100). |
| `openseo:src/server/lib/dataforseoLlmSchemas.ts` | `src/lib/providers/dataforseo/llmSchemas.ts` | COPY | zod v4 `z.looseObject`. |
| `openseo:src/server/lib/dataforseo/llm-models.ts` (+ test) | `src/lib/providers/dataforseo/llm-models.ts` (+ `.test.ts`) | PORT | Injectable fetch/clock; env pin overrides; same fallback and pin tables. |
| `openseo:src/server/lib/dataforseo/ai-tracking.ts` | `src/lib/providers/dataforseo/ai-tracking.ts` | PORT | Returns rejected entries; reads `cost` on task_get; live timeout 140 s. |
| `openseo:src/server/lib/dataforseo/ai.ts` (+ `ai.test.ts`, `endpoints.test.ts:88-355`) | `src/lib/providers/dataforseo/ai.ts` (+ `ai.test.ts`) | PORT | `timeoutMs` input; classifier returns F01 classes. |
| `openseo:src/server/lib/dataforseo/serp.ts` (+ `serp.test.ts`) | `src/lib/providers/dataforseo/serp.ts` (+ `.test.ts`) | PORT | `clampSerpDepth`/`SERP_ANALYSIS_DEPTH` imported from F03. POST retries 0. |
| `openseo:src/server/lib/dataforseo/appendix.ts` | `src/lib/providers/dataforseo/appendix.ts` | COPY | — |
| `openseo:src/server/lib/dataforseo/client.ts` (+ `client.test.ts:185-400`) | `src/lib/providers/dataforseo/client.ts` (+ `.test.ts`) | PORT | Metering via F01 `metered`/`reserveSpend`/`settleSpendBatch` instead of Autumn credits; estimators from F03; sections owned by other specs live in their own files; answer endpoints removed from the client. |
| `openseo:src/server/lib/dataforseo/pricing.ts` | (F03 `src/lib/pricing/dataforseo.ts`) | PATTERN | F02 binds F03's estimators; defines no prices. |
| `openseo:src/server/lib/dataforseo/index.ts` | `src/lib/providers/dataforseo/index.ts`, `answers.ts` | PORT | Split public surface: metered client vs claim-only answer fetchers. |
| `openseo:src/server/lib/dataforseo/serp-location-validate.ts:6-37` | bake-off `--dry-run` sandbox calls | PATTERN | Same sandbox host idea. |
| `openseo:src/server/features/ai-visibility/providers/dataforseoEvidence.ts` (+ test) | `src/lib/providers/dataforseo/dataforseoEvidence.ts` (+ `.test.ts`) | PORT | Adds fan-out, tokens, web_search, model name to the llm_responses parse. |
| `openseo:src/server/features/ai-visibility/services/aiVisibilityCollection.ts` (+ test) | `src/lib/workers/queuedCollection.js`, `src/lib/engines/dataforseo.ts` | PORT | Batching by engine, 100 per post, 25 concurrent reads, attempt rules. Retries become new **claimed** attempts (P0) instead of in-step reposts; live batches run in lanes. |
| `openseo:src/server/workflows/AiVisibilityWorkflow.ts` (+ test) | `src/lib/workers/queuedCollection.js` | PORT | Poll offsets and 30-minute window; Cloudflare steps → scan chunks with `posted` rows and `resumeAt`; billed posts single-attempt (claims). |
| `openseo:src/server/features/ai-visibility/services/aiVisibilityMatching.ts:12-98` | `src/lib/providers/dataforseo/bakeoffLib.ts` (`aiMentionSpans`, `matchAiBrand`) | PORT | Used only as the bake-off's second parser for agreement; production matching stays ours. |
| `openseo:src/shared/ai-visibility.ts:297-318` | `src/lib/providers/dataforseo/locations.ts` | PORT | Unsupported-location table. |
| `openseo:src/shared/keyword-locations.ts:79,132,216,436,493-504` | `src/lib/providers/dataforseo/locations.ts` | PORT | Our seven countries only. |
| `openseo:src/shared/prompt-search-countries.ts` | `src/shared/web-search-countries.ts` | COPY | — |
| `openseo:src/shared/safe-url.ts` | `src/shared/safe-url.ts` | COPY | — |

## 8. Implementation plan

### Phase 1 — Bake-off (no production wiring)

**Goal:** run the Offcult panel through DataForSEO and our current providers under hard ceilings and record a decision.

- [x] **P1.T1 Provider core**
  - [x] **P1.T1.S1** *Files:* `src/lib/providers/dataforseo/core.ts`, `core.test.ts`. *Do:* §6.2.1 row and §6.2.2 table; inject `fetchImpl`/`env`. Tests: missing key (no fetch), Basic header, base URL refusal, POST 503 → one call + `AmbiguousCallError`, POST 429 → `UnbilledCallError`, POST timeout → `AmbiguousCallError` (fake timer), GET 503 twice then 200 → three calls. *Verify:* `node --test src/lib/providers/dataforseo/core.test.ts` → pass (F02-AC-01, 02).
  - [x] **P1.T1.S2** *Files:* `envelope.ts`, `envelope.test.ts`, `billingClassification.ts`, `shared.ts`, `llmSchemas.ts`. *Do:* port; translate the five `envelope.test.ts` cases and add a row-by-row test of §6.2.2. *Verify:* `node --test src/lib/providers/dataforseo/envelope.test.ts` → pass (F02-AC-03, 04).
- [x] **P1.T2 Answer fetchers and parsers**
  - [x] **P1.T2.S1** *Files:* `ai-tracking.ts`, `ai-tracking.test.ts`, fixtures `scraper-task-post.json`, `scraper-task-get-*.json`, `serp-*-task-get.json`. *Verify:* `node --test src/lib/providers/dataforseo/ai-tracking.test.ts` → pass (F02-AC-05).
  - [x] **P1.T2.S2** *Files:* `ai.ts`, `ai.test.ts`, `llm-models.ts`, `llm-models.test.ts`, `src/shared/web-search-countries.ts`, fixtures `llm-responses-*.json`, `llm-models-catalogue.json`. *Verify:* `node --test src/lib/providers/dataforseo/ai.test.ts src/lib/providers/dataforseo/llm-models.test.ts` → pass (F02-AC-06, 07).
  - [x] **P1.T2.S3** *Files:* `dataforseoEvidence.ts`, `dataforseoEvidence.test.ts`, `src/shared/safe-url.ts`, `locations.ts`, `appendix.ts`, `answers.ts`. *Verify:* `node --test src/lib/providers/dataforseo/dataforseoEvidence.test.ts` → pass (F02-AC-08).
- [x] **P1.T3 Bake-off script**
  - [x] **P1.T3.S1** *Files:* `src/lib/providers/dataforseo/bakeoffLib.ts`. *Do:* `parseArgs(argv)`, `assertEnvironment(env, cwd)`, `loadPanel(path)` (validates shape; never prints prompts), `planArms(panel, args)`, `estimatePlan(plan)` (F03 `aiAnswerUsd`, `llmResponseUsd`), `createGuardedFetch({ allowHosts, maxRequests, dryRun })`, `computeMetrics(observations, answers, roster)` (§6.8 metrics 1–6), `renderSummaryMarkdown(metrics)`, OpenSEO matcher port. *Verify:* `node --test src/lib/providers/dataforseo/bakeoffLib.test.ts` → pass.
  - [x] **P1.T3.S2** *Files:* `src/lib/providers/dataforseo/bakeoffLib.test.ts`, fixtures `tests/fixtures/f02/bakeoff-run/{observations.json,answers.jsonl,expected-summary.json}` (synthetic, 3 engines × 4 questions × 4 arms). Cases: every refusal in §6.8; dry run allows only sandbox/catalogue URLs; request ceiling throws at N+1; metrics equal `expected-summary.json`; `renderSummaryMarkdown` output contains no string from `answers.jsonl` text fields. *Verify:* pass (F02-AC-09, 11).
  - [x] **P1.T3.S3** *Files:* `scripts/qa/check-dataforseo-bakeoff.mjs`. *Do:* main: guards → loopback `pg.Pool` → store built like `scripts/qa/live-provider-repairs.mjs:56-112` (rpc over pg, evidence to a private local directory under `--out`) → seed canary rows → arms → balance → outputs. Uses `createProbeDispatchStore` (`renew` added in P1.T3.S4), never `set_probe_rollout`. *Verify:* `node scripts/qa/check-dataforseo-bakeoff.mjs` with no args → exit 2 with "Missing --panel"; with all flags and `--dry-run` against a stub server (`DATAFORSEO_BASE_URL` cannot point at it, so the test injects `fetchImpl` through `--self-test` mode used only by the unit test) → exit 0 and zero paid requests.
  - [x] **P1.T3.S4** *Files:* `src/lib/db/probeDispatch.js`. *Do:* add `store.renew(id, token, seconds)` → `renew_probe_dispatch` and `claim(..., { leaseSeconds })`. *Verify:* `node --test src/lib/db/*.test.mjs` → pass; new case in `src/lib/db/probeDispatchRenew.test.mjs` asserts the RPC arguments.
  - [x] **P1.T3.S5** *Files:* `scripts/qa/check-dataforseo-db.mjs` (group `bakeoff-ceiling`). *Do:* disposable loopback `_qa` database with migrations applied (pattern `scripts/qa/check-repair-workflows.mjs:13-18`); seed 10 canary rows in one scope with `max_spend_usd 0.05`, reserve 0.01, stub provider finishing at cost 0.01 → exactly 5 granted, the 6th refused `spend_reservation_refused`, stub call count 5. *Verify:* `node scripts/qa/check-dataforseo-db.mjs --group bakeoff-ceiling` → "ok 1 bakeoff-ceiling" (F02-AC-10).
- [x] **P1.T4 Decision record template and runbook**
  - [x] **P1.T4.S1** *Files:* `docs/decisions/_template-provider-bakeoff.md` (§6.8 template), `docs/runbooks/dataforseo-bakeoff.md` (owner steps: create a loopback `aeovis_live_qa` DB and apply migrations; set `DATAFORSEO_API_KEY` in an env file outside Drive without printing it; run `--dry-run`; run with `--confirm-spend`; copy `summary.md`; complete terms check; commit the record). *Verify:* `node --test src/lib/docStatus.test.mjs` (existing doc-status guard, if it covers `docs/`) → pass; otherwise `grep -c "doc-status" docs/decisions/_template-provider-bakeoff.md docs/runbooks/dataforseo-bakeoff.md` → 1 each.
  - [x] **P1.T4.S2** *Files:* `THIRD_PARTY_NOTICES.md`. *Do:* append every phase 1 COPY/PORT path. *Verify:* `node --test src/lib/platform/thirdPartyNotices.test.mjs` → pass.

**Checkpoint:** `node --import ./src/lib/liveWriteGuardAuto.mjs --test 'src/**/*.test.mjs' 'src/**/*.test.ts'` and `node --test src/lib/providers/dataforseo/bakeoffLib.test.ts` pass; `npm run typecheck` and `npm run build` pass; `node scripts/qa/check-dataforseo-db.mjs --group bakeoff-ceiling` passes. Completes F02-AC-01…11. **Owner action after merge:** run the bake-off per the runbook and commit the decision record (no agent runs it).

### Phase 2 — Reusable metered client (requires a recorded go or partial-go)

**Goal:** one metered DataForSEO client that F13–F20 build on.

- [x] **P2.T1 Client**
  - [x] **P2.T1.S1** *Files:* `src/lib/providers/dataforseo/client.ts`, `client.test.ts`, `index.ts`. *Do:* §6.2.3. Port `client.test.ts:185-296` cases with F01's `memoryStore` spend deps: estimate held, settle at billed cost, charged failure settled, unbilled invalid field released, transport failure before billing released (Unbilled) vs ambiguous counted; batch: one hold, per-call costs. *Verify:* `node --test src/lib/providers/dataforseo/client.test.ts` → pass (F02-AC-13, 14).
  - [x] **P2.T1.S2** *Files:* `serp.ts`, `serp.test.ts`, fixtures. *Verify:* `node --test src/lib/providers/dataforseo/serp.test.ts` → pass (F02-AC-17).
  - [x] **P2.T1.S3** *Files:* `client.test.ts` ("every entry is priced": walk the client object, call each entry with a stub fetcher, assert `metered` received an `estimateUsd > 0`), `noPrices.test.mjs` (scan `src/lib/providers/dataforseo/*.ts` excluding tests for numeric literals assigned to names ending `_USD`). *Verify:* pass (F02-AC-15).
  - [x] **P2.T1.S4** *Files:* `answerImportGuard.test.mjs`. *Do:* walk `src/` and `scripts/` (excluding `node_modules`, `.next`, `.env*`), parse import specifiers; fail when `ai-tracking.ts`, `answers.ts` or `fetchLlmResponse` is imported outside the allowed list; fail if any F02 file contains `set_probe_rollout` or `probe_dispatch_control`. *Verify:* pass (F02-AC-16, 31).
  - [x] **P2.T1.S5** *Files:* `src/shared/spend-features.ts`, `src/lib/features/names.ts`, `.env.example`. *Do:* add `providers.dataforseo.selftest` and `dataforseo_engines`; env names. *Verify:* `node --test src/lib/features/flags.test.ts` → pass; `grep -c "^DATAFORSEO_API_KEY=$" .env.example` → 1.
- [x] **P2.T2 Owner live check of the client**
  - [x] **P2.T2.S1** *Files:* `scripts/qa/check-dataforseo-live.mjs` (`--mode client`). *Do:* refuses unless `--brand <key> --max-spend-usd 0.01` and `paid_feature_controls('providers.dataforseo.selftest')` enabled for the brand; one `serp.live` (depth 10, keyword "readiness canary", India) through the metered client; prints ledger `cost_source` and `accounted_usd` only. *Verify:* without flags → exit 2 "Missing --brand".
  - [x] **P2.T2.S2** *Files:* `THIRD_PARTY_NOTICES.md`. *Verify:* `thirdPartyNotices.test.mjs` → pass.

**Checkpoint:** full suite, typecheck, build. Completes F02-AC-13…17.

### Phase 3 — Engine routing and adapters

**Goal:** answer engines can run on DataForSEO inside the P0 fence and every result names its gateway. (Claude as an engine is deferred.)

- [x] **P3.T1 Routes**
  - [x] **P3.T1.S1** *Files:* `src/lib/engines/engineRoutes.ts`, `engineRoutes.test.ts`, fixture `tests/fixtures/f02/config-versions-today.json` (recorded by running `configVersion`/`circuitIdentity` for the four engines on `main` before this PR with a synthetic env: `LLM_API_KEY=k1`, `LLM_BASE_URL=https://openrouter.ai/api/v1`, `BRIGHTDATA_API_KEY=k2`, `OPENROUTER_GEMINI_MODEL=google/gemini-3.8-flash`). *Verify:* `node --test src/lib/engines/engineRoutes.test.ts` → pass (F02-AC-21, 22).
  - [x] **P3.T1.S2** *Files:* `src/lib/engines/providerReadiness.js`, `src/lib/vendorRegistry.js`. *Do:* §6.2.6 rows. *Verify:* `node --test src/lib/engines/*.test.mjs src/lib/vendorRegistry*.test.mjs` → pass (existing readiness tests unchanged).
- [x] **P3.T2 Adapters**
  - [x] **P3.T2.S1** *Files:* `src/lib/engines/dataforseo.ts`, `dataforseo.test.ts`. *Do:* §6.2.4 with fixtures; evidence capture asserted (`evidenceDocument` succeeds, payload has no `headers` key). *Verify:* `node --test src/lib/engines/dataforseo.test.ts` → pass (F02-AC-18, 25).
  - [x] **P3.T2.S2** *Files:* `src/lib/engines/providerFailure.js`, `providerFailure.dataforseo.test.mjs`. *Verify:* pass (F02-AC-23).
  - [x] **P3.T2.S3** *Files:* `src/lib/scoring/enginePipeline.js` (`probeTextEngine` gateway/method, registry selection, `probeAioDataforseo`), `src/lib/engines/openRouterProbe.js`, `openai.js`, `perplexity.js`, `serpGeo.js`, `gatewayProvenance.test.mjs`. *Verify:* `node --test src/lib/engines/gatewayProvenance.test.mjs src/lib/scoring/enginePipeline.test.mjs` → pass (F02-AC-19).
- [x] **P3.T3 Durable dispatch wiring**
  - [x] **P3.T3.S1** *Files:* `src/lib/db/probeDispatch.js` (`dispatchIdentity` opts), `src/lib/workers/durableProbing.js` (routes freeze, lease/budget per route, `withLeaseRenewal`, lane concurrency), `src/lib/workers/durableProbing.routes.test.mjs`. Cases: checkpoint without `routes` behaves exactly as before (snapshot of claim calls); frozen route reused across chunks; circuit open at freeze → fallback frozen with `fallbackFrom`; circuit opening mid-scan → remaining rows of that engine blocked, no switch; dataforseo live claim uses lease 180 and deadline 140 s; renewal every 60 s (fake timers); lane stops new claims after an `opens_circuit` result; `dataforseo` scraper route refused for scans while `QUEUED_COLLECTION_READY` is absent. *Verify:* `node --test src/lib/workers/durableProbing.routes.test.mjs src/lib/workers/*.test.mjs` → pass (F02-AC-22, 26). **Deferred (owner, 2026-11-11):** the two live-lease cases (lease 180 / deadline, renewal every 60 s) remain skipped because no approved DataForSEO engine has a live scan mode. P4.T2.S2 repeats an incompatible request to un-skip these cases; see the phase 4 SPEC GAP.
  - [x] **P3.T3.S2** *Files:* `src/lib/ops/providerCanary.js` (request units 1 for dataforseo routes; passes `{ route }` from `routeOrder(engine, env)[0]` or a `--route` override in `scripts/ops/provider-canary.mjs`), `src/lib/ops/providerCanary.dataforseo.test.mjs`. *Verify:* pass (F02-AC-24).
- [x] **P3.T4 Marketing guard and report badge** (Claude parts deferred) — S2–S4 done; S1 deferred by owner decision (Claude not offered)
  - [ ] **P3.T4.S1 (deferred — skip)** *Files:* `src/lib/engines/deployedEngines.js`, `src/app/page.js`, `src/lib/scoring/enginePipeline.js` (`claude` registry entry, `ENGINE_WEIGHTS.claude`), `src/lib/engines/types.js`, `src/lib/engines/claudeEngine.test.mjs`. *Verify:* `node --test src/lib/engines/claudeEngine.test.mjs src/lib/landingHonesty.test.mjs src/lib/landingProbeCounter.test.mjs` → pass (F02-AC-20).
  - [x] **P3.T4.S2** *Files:* `scripts/check-secrets.mjs`, `src/lib/checkSecretsEngines.test.mjs` (new; imports the exported `checkEngineAdvertising` after it is exported). Cases: `ENGINES=perplexity` without a route → MISMATCH line; `perplexity=dataforseo>openrouter` with only `LLM_API_KEY` → ok (fallback funds it); DataForSEO vendor check prints only PASS/FAIL. *Verify:* `node --test src/lib/checkSecretsEngines.test.mjs` → pass.
  - [x] **P3.T4.S3** *Files:* `src/components/portal/scans/ReportCards.jsx`, `scripts/qa/check-dataforseo-browser.mjs` (local app with the existing report fixture plus one `consumer_capture` row; asserts badge text "Consumer app" and "Model API"). *Verify:* `node scripts/qa/check-dataforseo-browser.mjs` → "2 passed" (F02-AC-30).
  - [x] **P3.T4.S4** *Do:* confirm `src/lib/scoring/aggregate.js` ignores engines missing from `ENGINE_DEFAULT_WEIGHTS`: `git grep -n "ENGINE_DEFAULT_WEIGHTS\|ENGINE_HYBRID_WEIGHTS" src/lib/scoring/aggregate.js`; if it indexes weights without a guard, add `?? 0` there and a case in its test. *Verify:* `node --test src/lib/scoring/*.test.mjs` → pass.
- [x] **P3.T5 Gate**
  - [x] **P3.T5.S1** *Files:* `src/lib/engines/engineRoutes.ts` (`DATAFORSEO_APPROVED_ENGINES` from the decision record), `src/lib/engines/dataforseoGate.test.mjs`. *Verify:* pass (F02-AC-12).

**Checkpoint:** full suite, typecheck, build, `node scripts/check-secrets.mjs` (owner, optional), CI `customer-database` (`check-probe-dispatch.mjs` unchanged). Completes F02-AC-12, 18–26, 30. Production behaviour is unchanged until the owner sets `ANSWER_ENGINE_ROUTES` and `FEATURE_DATAFORSEO_ENGINES`.

**Checkpoint passed:** merged in #74 (3840a57) with CI green. P3.T4.S1 is deferred, not outstanding; it does not block phase 4.

### Phase 4 — Queued collection in scans

**Goal:** ChatGPT, Gemini and Google AI Overviews collect through DataForSEO's queue inside scans.

- [x] **P4.T1 Migration**
  - [x] **P4.T1.S1** *Files:* `supabase/migrations/045_f02_queued_dispatch.sql` (§6.1), `scripts/setup-supabase.mjs` (required objects: the four functions). *Verify:* CI `customer-database` applies all migrations; `node scripts/qa/check-dataforseo-db.mjs --group posted-states,collect-projection` → "ok" for: posted constraint accepts `posted`; post on stale lease → ambiguous + late receipt; claim on posted → `reason:"posted"`; collect writes the same `prompt_results` row as finish for the same payload (column-by-column); refund lowers cost, a higher settled cost is ignored; duplicate collect is a no-op (F02-AC-27).
- [ ] **P4.T2 Queued lane**
  - [x] **P4.T2.S1** *Files:* `src/lib/engines/dataforseo.ts` (`postDataforseoBatch`, `collectDataforseoTask`), `src/lib/db/probeDispatch.js` (`post`, `collect`, `reschedule`, `listPosted`), `src/lib/workers/queuedCollection.js`, `queuedCollection.test.mjs` (in-memory store implementing the SQL contract, as the 20 October replay did). Cases: F02-AC-28 list; one `task_post` for 32 rows; rejected entries finished with their cost; ambiguous post → no finish; poll offsets; backend failure → `retry`; 30-minute expiry. *Verify:* `node --test src/lib/workers/queuedCollection.test.mjs` → pass (F02-AC-28).
  - [ ] **P4.T2.S2** *Files:* `src/lib/workers/durableProbing.js` (route `*_queued` engines to `runQueuedLane`; `resumeAt` from posted rows), `engineRoutes.ts` (`isRouteScanCapable` reads `QUEUED_COLLECTION_READY`). *Verify:* `node --test src/lib/workers/*.test.mjs` → pass; new case: a scan with 2 posted rows returns `budgetHit: true` and `resumeAt` = earliest poll (F02-AC-29) Also un-skip `durableProbing.routes.test.mjs` Cases 5–6 using an approved engine (F02-AC-26, deferred from P3.T3.S1).
  - [x] **P4.T2.S3** *Files:* `src/lib/workers/queuedCollection.jobs.ts`, `src/lib/jobs/kinds.ts` (one import line). *Verify:* `node scripts/qa/check-dataforseo-db.mjs --group posted-sweep,queued-flow` → "ok" (F02-AC-29).

**Checkpoint:** full suite, typecheck, build, DB groups. Completes F02-AC-27…29.

**SPEC GAP (2026-11-11):** P4.T2.S2 says to un-skip P3.T3.S1 live-lease cases 5–6 using an approved engine, but every approved engine (`aio`, `chatgpt`, `gemini`) has a queued scan mode and uses the 120-second queued lease; the only live DataForSEO scan mode is `perplexity`, which is not approved. Keep cases 5–6 deferred until an approved engine has a live scan mode or the spec explicitly removes that requirement. Do not add a live route or approve another engine as part of phase 4.

**SPEC GAP (2026-11-11):** §6.3 specified the periodic/job kind `dataforseo.posted-sweep`, but the shared F01 `KIND_PATTERN` allows lowercase letters, digits, and underscores inside each dot-separated segment and rejects hyphens. Phase 4 uses `dataforseo.posted_sweep`, which satisfies the existing validator. Proposed correction: update the §6.3 spelling to `dataforseo.posted_sweep`; do not widen the shared validator for this feature.

### Phase 5 — Owner cutover kit

**Goal:** the owner can switch engines to DataForSEO safely and switch back.

- [ ] **P5.T1** *Files:* `scripts/qa/check-dataforseo-live.mjs` (`--mode engines`): bounded canaries for the approved engines through `dispatchCanaries` on a loopback `aeovis_live_qa` ledger (same refusals as the bake-off; default `--max-spend-usd 0.10`, `--max-requests 10`). *Verify:* without flags → exit 2.
- [ ] **P5.T2** *Files:* `docs/vendors/dataforseo.md` (endpoints, credential name, sandbox, error codes, price source = F03, India support = decision record), `docs/runbooks/dataforseo-cutover.md` (§10 steps). *Verify:* doc-status header present.
- [ ] **P5.T3** *Files:* `features/README.md` (F02 status). *Verify:* status column updated in the same PR.

**Checkpoint:** docs merged; owner-run results (canary outcomes, no answer text) recorded in the PR description.

## 9. Test plan

| Test file | Cases | ACs |
|---|---|---|
| `src/lib/providers/dataforseo/core.test.ts` | key, header, base URL, POST no-retry, GET retry, timeout classes | 01, 02 |
| `src/lib/providers/dataforseo/envelope.test.ts` | ported assertOk cases; §6.2.2 table | 03, 04 |
| `src/lib/providers/dataforseo/ai-tracking.test.ts` | body, limits, cost sum, rejected, pending, live | 05 |
| `src/lib/providers/dataforseo/ai.test.ts` | model check, force_web_search, country, clamp, no retry | 06 |
| `src/lib/providers/dataforseo/llm-models.test.ts` | pin, alias, snapshot, unreachable, env override | 07 |
| `src/lib/providers/dataforseo/dataforseoEvidence.test.ts` | OpenSEO's three cases; llm_responses parse | 08 |
| `src/lib/providers/dataforseo/bakeoffLib.test.ts` | refusals, dry run, ceilings, metrics, no answer text | 09, 11 |
| `scripts/qa/check-dataforseo-db.mjs` | `bakeoff-ceiling`, `posted-states`, `collect-projection`, `queued-flow`, `posted-sweep` | 10, 27–29 |
| `src/lib/providers/dataforseo/client.test.ts`, `noPrices.test.mjs` | meter outcomes, batch, every entry priced, no constants | 13–15 |
| `src/lib/providers/dataforseo/answerImportGuard.test.mjs` | import boundary; no dispatch-control writes | 16, 31 |
| `src/lib/providers/dataforseo/serp.test.ts` | ported serp cases | 17 |
| `src/lib/engines/dataforseo.test.ts` | result shape, evidence capture | 18, 25 |
| `src/lib/engines/gatewayProvenance.test.mjs` | gateway on every adapter | 19 |
| `src/lib/landingHonesty.test.mjs` | marketing guard (Claude end-to-end test deferred) | — |
| `src/lib/engines/engineRoutes.test.ts` | config_version stability, route resolution | 21, 22 |
| `src/lib/engines/providerFailure.dataforseo.test.mjs` | code → kind | 23 |
| `src/lib/ops/providerCanary.dataforseo.test.mjs` | canaries | 24 |
| `src/lib/workers/durableProbing.routes.test.mjs` | frozen routes, leases, budgets, concurrency | 22, 26 |
| `src/lib/workers/queuedCollection.test.mjs` | queued flow | 28, 29 |
| `src/lib/engines/dataforseoGate.test.mjs` | decision record ↔ constant | 12 |
| `scripts/qa/check-dataforseo-browser.mjs` | report badges | 30 |
| CI `customer-database` | migrations + `check-probe-dispatch.mjs` | 27, 31 |

Fixtures are synthetic or trimmed from DataForSEO's public documentation examples with all answer text replaced. Recording from the live API is not needed. If the owner wants real-shape fixtures after the bake-off, they are derived from `answers.jsonl` by a script that replaces every `markdown`, `text`, `title` and `keyword` value with `"redacted"` before the file enters the repository.

## 10. Rollout and rollback

- **Env vars (names only):** `DATAFORSEO_API_KEY` (base64 of `login:password`), `DATAFORSEO_BASE_URL` (optional), `ANSWER_ENGINE_ROUTES`, `FEATURE_DATAFORSEO_ENGINES`, `OPENROUTER_CLAUDE_MODEL`, `DATAFORSEO_LLM_MODEL_CHAT_GPT`, `DATAFORSEO_LLM_MODEL_CLAUDE`, `DATAFORSEO_LLM_MODEL_GEMINI`, `DATAFORSEO_LLM_MODEL_PERPLEXITY`, `DATAFORSEO_SCAN_MODEL_CONCURRENCY`. Existing, reused: `ENGINES`, `NEXT_PUBLIC_ENGINES`, `SCAN_PROBE_RESERVATION_USD`, `SCAN_MAX_COST_PER_SCAN`, `SCAN_MAX_COST_PER_DAY`, `LLM_API_KEY`, `BRIGHTDATA_API_KEY`.
- **Defaults:** `FEATURE_DATAFORSEO_ENGINES` unset → off in production; `ANSWER_ENGINE_ROUTES` unset → today's routes; `DATAFORSEO_APPROVED_ENGINES = []` until the decision record lands. Claude is not in `ENGINES` by default, so nothing changes for customers.
- **Migration order:** 045 in phase 4 only. Additive; old code ignores the new state because it never creates it.
- **Owner cutover (after phase 4, production):** (1) add `DATAFORSEO_API_KEY` to Vercel by piping it from the private file (`vercel env add DATAFORSEO_API_KEY production < <file>`), never printing it; (2) run `scripts/qa/check-dataforseo-live.mjs --mode engines` on the loopback ledger; (3) set `ANSWER_ENGINE_ROUTES` to the approved engines' `dataforseo>…` orders; (4) set `FEATURE_DATAFORSEO_ENGINES=on`; (5) to add Claude, append `claude` to both `ENGINES` and `NEXT_PUBLIC_ENGINES` and run `node scripts/check-secrets.mjs` (must print "in step"); (6) redeploy; (7) run the existing owner-authorised Offcult scan flow (handoff step 3–5) and compare its report with the bake-off.
- **Turn off:** set `FEATURE_DATAFORSEO_ENGINES=off` (next scans freeze the fallback routes; running scans finish on their frozen route) or remove engines from `ANSWER_ENGINE_ROUTES`. A DataForSEO balance failure opens the shared circuit automatically and the next scan freezes the fallback.
- **Rollback:** revert the code; posted rows (phase 4) are collected or expired by the sweep before reverting, which the runbook checks with `select count(*) from probe_observations where state='posted';` → 0. Migration 045 stays (additive).
- **Data cleanup:** none; bake-off outputs live in the owner's private directory.

## 11. Risks and open questions

| # | Risk / question | Default chosen |
|---|---|---|
| 1 | India support, AI Overview presence and real cost are unverified (teardown "What I could not verify"). | Phase 1 measures them; phases 2–5 wait for the record. |
| 2 | Whether DataForSEO `llm_responses` offers a queued `task_post` could not be verified from OpenSEO's code (it only calls `/live`). | Model-API engines stay live in scans with lane concurrency 3. Revisit if DataForSEO documents a queue. |
| 3 | Live scraper calls take up to 120 s, longer than our 70 s request budget, and do not fit a 150 s chunk more than once. | Scans use the queue for scraper and SERP engines (phase 4); live scraper mode is used only by canaries, the bake-off and F11. |
| 4 | Per-entry `cost` on `task_post` is assumed to be the billed amount per task (OpenSEO sums it, `ai-tracking.ts:120-134`). | Bake-off compares the sum with the balance delta; the record notes any gap. |
| 5 | `money.balance` field naming in `user_data` comes from OpenSEO's type (`appendix.ts:12-26`), not verified. | The script records "balance unavailable" if absent and asks the owner to read the dashboard. |
| 6 | `SCAN_PROBE_RESERVATION_USD` (owner states 0.20; code default 1) is far above DataForSEO's per-answer price, so P0 caps fill early relative to real spend. | Unchanged by F02. The decision record may recommend a new value; the owner changes it outside a PR. |
| 7 | Changing an engine's provider changes its measurement context; trends across the switch are not comparable. | Existing comparability rules refuse deltas; the route is recorded per scan; the report shows the method badge. |
| 8 | Consumer-app scraping may carry third-party terms risk. | Terms check item 7; owner records acceptance or no-go. |
| 9 | DataForSEO model pins (`gpt-5.6-luna`, `claude-sonnet-5`) come from OpenSEO's 2026-08/10 verification. | Catalogue check before every paid call; env overrides; the bake-off records the model actually used. |
| 10 | A single provider for all engines is a single point of failure. | Shared `dataforseo` circuit plus freeze-time fallback to Bright Data/OpenRouter. |
| 11 | Holding leases while polling queued tasks in the bake-off depends on `renew_probe_dispatch` never exceeding `deadline_at`. | Bake-off observations get a 60-minute deadline; collection window is 30 minutes. |

**Deviations from conventions:** none. Answer-engine calls do not use `metered()` because conventions §6.1 requires them to go through `claim_probe_dispatch` instead; the client enforces the split (F02-AC-16).

**Requested changes to `00-CONVENTIONS.md` (for the coordinator; not edited here):** §5.1 could note that answer-engine fetchers live in `src/lib/providers/dataforseo/answers.ts` and are claim-only, and that `dispatchIdentity`/`configVersion`/`circuitIdentity` take an optional `{ route, model }`.

## 12. Definition of done

- [ ] Phase 1 merged; owner bake-off run; decision record committed with a decision.
- [ ] If go or partial-go: phases 2–5 merged, each with its checkpoint green.
- [ ] F02-AC-01 … F02-AC-31 covered by passing tests listed in §9 (AC-12 onward only after a go).
- [ ] `npm test`, `npm run typecheck`, `npm run build` green; CI `customer-database` green with `check-probe-dispatch.mjs` unchanged.
- [ ] `THIRD_PARTY_NOTICES.md` lists every ported file.
- [ ] `features/README.md` F02 status updated.
- [ ] Owner-run records in PR descriptions: bake-off summary (no answer text), phase 2 client check ledger row, phase 5 canary outcomes.
