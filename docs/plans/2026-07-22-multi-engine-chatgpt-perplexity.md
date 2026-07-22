# Multi-Engine Visibility — ChatGPT + Perplexity (+ AIO upgrades)

**Date:** 2026-07-22
**Scope:** Add ChatGPT and Perplexity as visibility engines alongside Google AI Overviews; ship four small AIO-side upgrades in the same push.
**Verified baseline:** v8.1 pipeline green — two clean E2E scans today (italica 34/34, Snitch 34/34, 0% errors), merged to `main` at `1a65301`.
**Execution model:** phases are sequential; each phase ends with a verification gate. No phase may break `npm run test:scoring`, `lint`, or `build`.

---

## 0. Locked design decisions

1. **One scan probes N engines.** A scan stays ONE record. Every query is probed on every enabled engine. Per-result rows gain an `engine` field; the scan record gains per-engine summaries. No schema migration needed — everything rides in `raw_results` JSONB.
2. **Engine set via env:** `ENGINES=aio,chatgpt,perplexity` (default `aio` so nothing breaks if keys are missing). An engine with a missing API key is skipped with a console warning, never a crash.
3. **ChatGPT = OpenAI Responses API with the `web_search` tool** — NOT the dormant `engines/openai.js` chat-completions path (that reflects model memory, not ChatGPT-with-search). Model: `gpt-4o-mini` via Responses API. `user_location: { country: "IN" }` on the web_search tool.
4. **Perplexity = `sonar`** via their OpenAI-compatible chat completions. Citations come back natively (`citations` / `search_results` field). Add `web_search_options: { user_location: { country: "IN" } }` where supported.
5. **Scoring contract per engine (unchanged philosophy — never mix denominators):**
   - `answer_present` replaces `aio_present` semantically: for AIO it means "an AI Overview appeared"; for ChatGPT/Perplexity it is true unless the API errored (they always answer).
   - Per engine: `share_of_ai = visible ÷ answers_present (non-branded)`, `coverage = answers_present ÷ 30`, `presence = visible ÷ 30`.
   - **Headline** = equal-weight mean of per-engine `share_of_ai` across engines that produced ≥5 non-branded answers, labeled "AI Visibility Index". Per-engine scores always shown beside it. (Reversible decision — isolated in one function.)
6. **Visibility detection is engine-agnostic and reused as-is:** `detectMention(text, aliases)` for text; brand-domain match over citations. No changes to `judge.js` / `citations.js`.
7. **Free-model rule is untouched:** prompt-gen + competitor extraction stay on OpenRouter free. OpenAI/Perplexity keys are ONLY for probing. Cost per 34-query scan ≈ AIO $0.05 + ChatGPT ~$0.40 + Perplexity ~$0.35 (two calls/query, verified pricing) → **≈ $0.80/scan**; track real costs in `stats.cost`.

**New env (add to `.env.example`):**
```
OPENAI_API_KEY=          # ChatGPT engine (Responses API + web_search)
PERPLEXITY_API_KEY=      # Perplexity engine (sonar)
ENGINES=aio,chatgpt,perplexity
```

---

## Phase 1 — ChatGPT engine adapter

**COST RULE (locked): cheapest configuration only while testing.** Model is
`gpt-4o-mini` — env-overridable via `OPENAI_MODEL` (default `gpt-4o-mini`) so
upgrading later is config, not code. Do not use larger models or extra tool calls.

**Rewrite `src/lib/engines/openai.js`** (the current chat-completions probe is dead code — replace it):

- `export async function probeChatGpt(query, options = {})`
  - POST `https://api.openai.com/v1/responses` with:
    ```json
    {
      "model": "gpt-4o-mini",
      "tools": [{ "type": "web_search", "user_location": { "type": "approximate", "country": "IN" } }],
      "input": "<query text>"
    }
    ```
  - Parse: answer text from `output` items of type `message` (concatenate `output_text` content); citations from annotations of type `url_citation` (collect `url`, `title`).
  - Return the SAME shape the AIO extractor produces: `{ text, citations: [normalizedUrl], references: [{ href, title, source }], cost, error: null }`.
  - Timeout 45s, 2 attempts, backoff — mirror `brightDataSearch`'s retry discipline (429/5xx retry, hard errors throw).
  - Cost: estimate `$0.01` per call + usage tokens if present in response; add to `options.stats`.
- Config guard: `export function isChatGptConfigured()` → `!!process.env.OPENAI_API_KEY`.

**Tests (`src/lib/engines/openai.test.mjs`):** parse fixtures for (a) response with citations, (b) response with no annotations, (c) API error shape → `{ error }`. Use dependency-injected `fetch` like existing tests do for other modules.

**Gate:** `node --test src/lib/engines/openai.test.mjs` green; no other file touched.

---

## Phase 2 — Perplexity engine adapter

**VERIFIED 2026-07-22 with a live key:** the current chat-completions API returns NO
citations — not in `citations`, not in `search_results`, not with `return_citations`,
not on `sonar-pro` (all empirically tested). Sources now come from the separate
**Search API** (`POST /search` → `{ results: [{ url, title, ... }] }`, verified
working). The adapter therefore makes TWO calls per query.

**Rewrite `src/lib/engines/perplexity.js`:**

**COST RULE (locked): cheapest configuration only while testing.** Model is `sonar`
— NEVER `sonar-pro` (4x the request rate, 15x output tokens). Do not set
`search_context_size` (defaults to `low`, $0.005 vs $0.008 on `medium`).
Make the model env-overridable (`PERPLEXITY_MODEL`, default `sonar`) so upgrading
later is config, not code.

- `export async function probePerplexity(query, options = {})` — two calls, run in parallel (`Promise.all`):
  1. **Answer:** POST `https://api.perplexity.ai/chat/completions`
     `{ "model": "sonar", "messages": [{ "role": "user", "content": "<query>" }], "web_search_options": { "user_location": { "country": "IN" } } }`
     → text from `choices[0].message.content`. Real cost is in `usage.cost.total_cost` (~$0.005) — use it for stats when present.
  2. **Sources:** POST `https://api.perplexity.ai/search`
     `{ "query": "<query>", "max_results": 10 }`
     → `results[].url` / `results[].title` become `references`/`citations`.
  - If the search call fails but the answer succeeds, return the answer with empty citations (mention-detection still works) — do NOT fail the whole probe.
  - Same return shape, retry discipline, and stats accounting as Phase 1. Cost ≈ `$0.01`/query total.
- `isPerplexityConfigured()` guard.
- **Honest-methodology note (also add to the scoring docs/UI tooltip):** `/search`
  results are Perplexity's retrieval layer for the query — a close proxy for, but not
  guaranteed identical to, the exact sources grounding that specific answer.
  Mention-in-answer-text is the primary visibility signal; search-result citation is
  the secondary signal.

**Tests:** fixtures for (a) answer + search results both OK, (b) search fails → answer-only with empty citations, (c) answer fails → `{ error }`.

**Gate:** engine tests green.

---

## Phase 3 — Multi-engine pipeline + worker

**New `src/lib/scoring/enginePipeline.js`** (generalizes, does NOT replace, `aioPipeline.js`):

- `ENGINE_REGISTRY = { aio: <wraps brightDataSearch+extract>, chatgpt: probeChatGpt, perplexity: probePerplexity }` with per-engine `{ probe, isConfigured, label }`.
- `resolveEnabledEngines()` — parse `ENGINES` env, drop unconfigured ones with a `console.warn`.
- `probeQueryOnEngine(engine, query, brand, brandAliases, brandDomain, competitors, stats)` — identical logic to today's `probeQueryOnce` but sourcing `{ text, citations, references, error }` from the engine's probe. Result rows carry `engine: "chatgpt"` etc. and `answer_present` (write BOTH `answer_present` and legacy `aio_present` keys on AIO rows for backward compat).
- `runMultiEngineScan({ engines, queries, ... })` — flat work list of (engine × query) pairs through the existing `runWithConcurrency`. **Per-engine concurrency caps:** aio 6, chatgpt 4, perplexity 4 (simplest: run engines sequentially, each with its own cap; wall-clock ≈ AIO 5min + ChatGPT ~1min + Perplexity ~1min — acceptable).
- `summarizeEngineResults(results)` — reuse `summarizeAioResults` logic per engine slice (it's already pure); returns `{ engines: { aio: {results, summary}, chatgpt: {...} }, headline }` where `headline = { visibility_index_pct, engines_counted }` per decision #5.
- Reliability gates apply PER ENGINE (AIO keeps its coverage gate; chatgpt/perplexity gate only on error rate).

**`src/lib/workers/scanWorker.js` changes (keep diffs surgical):**

- After sourcing queries, call `runMultiEngineScan` instead of `runAioScan` when >1 engine enabled (single-engine path stays on `runAioScan` — zero regression risk).
- Competitor extraction: feed it the union of all engines' non-branded answer text + citations (one batched OpenRouter call, same as today).
- `aggregateAioTopDomains` → run over the union too; add per-row `engine` so the Sources view can filter later.
- Scan record additions (all inside the JSONB payload):
  - `platform: "multi"` when >1 engine, else unchanged.
  - `engines: { aio: summary, chatgpt: summary, perplexity: summary }`
  - `visibility_index_pct`, `engines_counted`
  - Existing top-level v8.1 fields keep their AIO values (so old dashboard code and history rows stay coherent).
  - `scoring_version: "v9-multi-engine"`.

**Tests:** `enginePipeline.test.mjs` — fixture rows across 3 engines → per-engine summaries correct, headline mean correct, engine with <5 answers excluded from headline, branded rows never in denominators.

**Gate:** `npm run test:scoring` fully green (67 existing + new); a live single-engine scan (`ENGINES=aio`) produces a byte-compatible v8.1-style record.

---

## Phase 4 — normalizeResult + dashboard

**`src/services/api.js` → `normalizeResult`:** detect `engines` key → new shape `{ engines, visibilityIndex, ... }` while keeping every existing field the views already read (AIO values remain the defaults for legacy fields). Old records (v7/v8/v8.1) must render exactly as today — extend the dual-mode transformer, don't fork it.

**Dashboard (minimal, no redesign):**
1. `ScoreBand` — big numeral becomes `visibility_index_pct` when present; add small per-engine chips: `AIO 3.4% · ChatGPT 12% · PPLX 8%`.
2. `AnswersView` — add an engine filter chip row (All / Google AIO / ChatGPT / Perplexity) above the existing status chips; transcript panel labels the engine.
3. `OverviewView` — KPI card "AI Overview coverage" becomes per-engine aware (AIO value + tooltip); add "Engines probed" count.
4. `SourcesView` — optional engine filter (defer if time-boxed).
5. Header badge: `SOURCE: GOOGLE AIO` → `SOURCES: AIO + CHATGPT + PPLX` from the engines present.

**Gate:** `npm run build` + manual click-through of a fresh multi-engine scan AND an old v8.1 history record (both must render).

---

## Phase 5 — AIO-side upgrades (independent, small; do in order)

**5a. Organic-rank extraction (highest value).**
- `brightdata.js`: `export function extractBrightDataOrganic(data)` → top 10 of `body.organic` as `{ position, href, domain, title }`.
- `probeQueryOnce` (AIO path): record `organic: [...]`, `brand_organic_position` (first position whose domain matches brand), `competitor_organic: { name: position }`.
- Summary: `rank_not_cited_count` = non-branded rows where `brand_organic_position <= 10` && `!visible` && `answer_present`.
- Dashboard: in AnswersView meta line show `ORGANIC #4` when known; in OverviewView "Where you're losing" prioritize rank-not-cited rows with the label "You rank #N on Google for this — but the AI answer skips you."
- Tests: extractor fixture + summary count.

**5b. PAA-seeding flip in `promptGen.js`.**
- Before LLM pass 1: derive 3-5 seed terms (industry label + top words from scraped title/h1), fetch PAA + autocomplete for them (existing `serp.js` fns, best-effort, 10s budget).
- Inject into `buildGenPrompt` as: `Real queries observed on Google for this category (use as grounding, vary and expand): ...` (cap 30 lines).
- Keep the existing shortfall blend + industry fallback untouched. Prompts sourced directly from PAA/autocomplete keep their `source` tags; LLM output stays `llm_generated`.
- Tests: dependency-injected paa/auto fns → assert they're called before the LLM and their text lands in the gen prompt.

**5c. History-delta comparability fix.**
- Dashboard sidebar/history: compute delta ONLY vs the most recent previous scan with the same `prompt_set_id` (and same `scoring_version` major). Otherwise render a neutral `NEW PROMPT SET` badge instead of a delta.
- Pure UI/normalize change; no backend.

**5d. Competitor dedup + junk filter in `competitorExtract.js`.**
- Post-process LLM output: normalize names (lowercase, strip suffixes `tiles|ceramics|india|ltd|pvt`), merge entries where one normalized name contains the other (keep higher-visibility name's stats, sum prompt hit-sets via union not addition).
- Prompt tweak: add "Exclude tools, marketplaces-as-tools, media sites, and software products; only direct competitors that sell what {brand} sells."
- Tests: fixture with `Kajaria` + `Kajaria Tiles` → merged; junk names dropped.

**5e. (stretch) End-of-scan retry pass** — after the main run, re-probe rows with `error` once (sequential, small backoff). Skip if error rate is 0.

---

## Phase 6 — E2E verification

1. `npm run test:scoring && npm run lint && npm run build` — all green.
2. `ENGINES=aio` scan for italica → record shape backward-compatible, dashboard renders, deltas vs this morning's scan show correctly per 5c.
3. `ENGINES=aio,chatgpt,perplexity` scan for Snitch → three engine summaries, visibility index, engine filter works, per-engine chips render, cost logged ≈ $0.70.
4. Old history records (v7 13-prompt, v8 30-prompt) still render untouched.
5. Commit in 3 logical commits: `feat(engines): chatgpt + perplexity probes`, `feat(scan): multi-engine pipeline v9 + dashboard`, `feat(aio): organic ranks, seeded prompts, history/competitor fixes`.

## Out of scope (explicitly)

Google AI Mode engine (needs DataForSEO — separate plan), GSC prompt sourcing (built, parked until client #1), keyword volumes, auth/billing, the GEO OS agents, any UI redesign.

## Prerequisites the user must provide

- `OPENAI_API_KEY` with billing enabled (Responses API + web_search access).
- `PERPLEXITY_API_KEY` (needs a small credit purchase at perplexity.ai/settings/api).
