# aeovis — AIO Unbranded 30-Prompt Rebuild (Google AI Overview)

> <!-- doc-status -->
> **Status: HISTORICAL.** A record of work done at the time, not an authority for current decisions. It predates the 2026-08-29 honesty audit, so any claim it makes about what is finished must be checked against [docs/BUILD_JOURNAL.md](../BUILD_JOURNAL.md) and [2026-08-29-rebuild-roadmap.md](./2026-08-29-rebuild-roadmap.md).

## Context

`aeovis` measures how visible a brand is inside **Google AI Overviews (AIO)**. The
pipeline works but three things make it unusable:

1. **Prompt collapse.** `src/lib/scoring/aioPrompts.js` derives category seeds from Gemini,
   filters them hard (`>=2 words && >=8 chars`), runs PAA/autocomplete (needs a SERP key),
   and falls back to 3 static industry prompts. `MAX_NON_BRANDED = 18` caps it, nothing
   guarantees a floor, so real scans degrade to ~7 prompts.
2. **Wrong market.** `brightDataSearch` defaults `SERP_GEO || "us"` (`brightdata.js:77`) and
   `buildGoogleSearchUrl` defaults `geo = "us"` (`brightdata.js:58`). Target is India.
3. **Bad competitor detection.** `coMentions.js` uses regex NER + a hardcoded `STOPWORDS`
   list tuned for a tiles/ceramics client (`morbi`, `vitrified`, `gujarat`…). It misses real
   competitors and injects noise.

**Goal:** for a company (test case `quiller.io`), generate **exactly 30 unbranded prompts**,
probe each against Google AIO in **India (`gl=in`)**, detect competitors via **one batched
LLM call**, and surface **one honest score with three consistently-defined numbers**.
Branded prompts are out of scope this pass (all 30 are unbranded); leave the branded helpers
in place for later re-enable. Design the prompt/probe layer so a second engine (Perplexity/
ChatGPT) can slot in later, but implement only Google AIO now.

### Locked decisions (product owner)
- **LLM = OpenRouter free model only.** `OPENROUTER_MODEL` default `google/gemma-4-31b-it:free`
  (env-overridable — executor must confirm the exact slug exists on OpenRouter). **No Gemini /
  paid fallback for gen or extraction.** `:free` JSON mode is unreliable → resilience is
  **defensive JSON parsing + retry on the same free model**.
- **Hero = Share of AI answers** = `visible ÷ (prompts where an AIO appeared)`. Always shown
  with two sub-metrics: **AIO coverage** (`withAio ÷ 30`) and **raw presence** (`visible ÷ 30`).
  Never mix denominators.
- **Geo = India:** `gl=in`, `hl=en`, `country=in`.
- **Competitors:** one batched OpenRouter call over all non-branded AIO text + cited domains;
  extract, normalize, match back for counts. Retire the regex/stopword path.

### What already works (do NOT rebuild)
- `summarizeAioResults` (`aioPipeline.js:173`) **already** computes the hero and coverage on a
  consistent non-branded denominator: `visibility_pct = visibleNonBranded / nonBrandedWithAio`
  (hero) and `aio_coverage_pct = nonBrandedWithAio / nonBranded` (coverage). It is only missing
  `presence_rate_pct` and a `share_of_ai_pct` alias. The visible denominator confusion is in the
  **client** (`api.js` recompute + `dashboard/page.js`), not the pipeline.

---

## Architecture (target flow)

```
POST /api/scan → createScanJob → startScanJob(jobId, brand, url, industry, competitorsRaw)
  [src/lib/workers/scanWorker.js]

  generating_prompts (10%)
     getPromptsForBrand(brand,false) → reuse if ≥30 enabled, else top-up
     generateUnbrandedPrompts(brand,url,industry,stats,30)   ← NEW promptGen.js
        scrapeForSummary(url) ─ firecrawl.js
        llmJson(...) ─ NEW llm.js → NEW openrouter.js   (1–2 calls)
        guards: isBrandedQuery / dedupe / word-count / intent-tier spread
        top-up: PAA+autocomplete (serp.js), then INDUSTRY_PROMPTS (never < 30)
     upsertPrompts(brand, 30)  ─ db/prompts.js

  probing (25→85%)
     runAioScan({queries:30, competitors:[]})  ─ aioPipeline.js
        per query: brightDataSearch(gl=in) + extractBrightDataAiOverview
        → aio_present / brand_mentioned_in_text / brand_cited / visible

  scoring (90%)
     extractCompetitors({results,brand,brandUrl,userCompetitors})  ← NEW competitorExtract.js
        1 batched llmJson call → normalized names → matchCompetitorsBack() counts
     summarizeAioResults(results) → hero + coverage + presence  (aioPipeline.js, extend)
     aggregateAioTopDomains(results, url, competitorNames)

  insertScan + updateScanJob(complete, run_record) → client polls /api/scan/[job_id]/status
```

---

## Phase 1 — OpenRouter client + unified JSON helper

**New `src/lib/openrouter.js`** — mirror `gemini.js`'s `generateContent(prompt, options, retries)`
returning `{ text, model_used, tokens, cost }` so callers stay swappable. Details:
- `getOpenRouterModel()` → `process.env.OPENROUTER_MODEL || "google/gemma-4-31b-it:free"`.
- POST to `https://openrouter.ai/api/v1/chat/completions` with `Authorization: Bearer $OPENROUTER_API_KEY`,
  plus `HTTP-Referer` and `X-Title` headers. Body: `{ model, messages:[system?,user], temperature, max_tokens }`.
  Send `response_format:{type:"json_object"}` when `options.jsonMode` (harmless if the free model ignores it).
- Retry `429`/`5xx` with exponential backoff (`1500 * 2^attempt`), `AbortController` timeout
  (`options.timeout || 30000`). On success accumulate `options.stats.tokens`. `:free` → `cost: 0`.
  On total failure log and return `{ text:"", model_used:"" }` (same failure contract as gemini.js).
- Export `robustJsonParse(text)`: strip ```` ```json ```` fences, `JSON.parse`; on failure scan for the
  first balanced `[`/`{` … matching close and parse that slice; else `null`.

**New `src/lib/llm.js`** — the single choke-point for all gen/extraction:
```js
import { generateContent, robustJsonParse } from "./openrouter.js";
export async function llmJson(prompt, options = {}, jsonRetries = 2) {
  for (let i = 0; i <= jsonRetries; i++) {
    const p = i === 0 ? prompt : prompt + "\n\nReturn ONLY valid JSON. No prose, no code fences.";
    const { text } = await generateContent(p, { ...options, jsonMode: true, temperature: 0.2 + i * 0.1 });
    const parsed = robustJsonParse(text);
    if (parsed) return parsed;
  }
  return null;
}
```
`promptGen.js` and `competitorExtract.js` must call **only** `llmJson` — never a provider directly.

---

## Phase 2 — Guarantee exactly 30 unbranded prompts

**New `src/lib/scoring/promptGen.js`** exporting
`generateUnbrandedPrompts(brand, website, industry, stats, count = 30)` → returns **exactly
`count`** unbranded query objects `{ text, topic, intent_tier, source }` or **throws** a clear error.

Reuse existing utilities (do not reinvent): `scrapeForSummary` (firecrawl.js), `getBrandAliases`
(aliases.js), `isBrandedQuery` (aioQueryClassify.js), `fetchPeopleAlsoAsk`/`fetchAutocomplete`
(engines/serp.js), `INDUSTRY_PROMPTS` (data/industries.js — keys: `saas`, `ecommerce`,
`finance`, `agency`).

Passes, in order, with a shared `add()` that dedupes (lowercase), drops branded leaks
(`isBrandedQuery(text, aliases)`), and drops `< 2` word noise:
1. **LLM pass 1** — `llmJson(buildGenPrompt(..., need = count + 10))`. Prompt: unbranded Google
   queries an India buyer types about this *category*; never the brand/domain/alias; spread across
   intent tiers `informational | commercial | comparison | problem_aware`; 3–9 words; each item
   `{text, topic, intent_tier}`.
2. **LLM pass 2** (only if short) — same prompt with `need = count - collected + 6` and an
   "avoid repeating: …" suffix listing what's collected.
3. **Realism blend** (only if still short) — for the top ~5 collected topics, best-effort
   `fetchPeopleAlsoAsk(topic)` + `fetchAutocomplete(topic)` (wrapped in try/catch; these need a
   SERP key and may return `[]`).
4. **Industry-pack top-up** (last resort) — push `INDUSTRY_PROMPTS[key].prompts` (normalize
   `industry`; fall back to first pack) so we never return `< count`.

Throw if still `< count` after all passes (message names `OPENROUTER_API_KEY` / model availability).
Return `collected.slice(0, count)`. Expected OpenRouter calls per scan: **1–2**.

Deprecate (stop importing in the worker; leave files on disk): `deriveCategorySeeds`,
`fetchCategoryQueries`, `buildAioQueries`, `MAX_NON_BRANDED` in `aioPrompts.js`. The branded
helpers in `aioQueryClassify.js` stay for later re-enable.

---

## Phase 3 — Geo = India + extraction robustness

**`src/lib/engines/brightdata.js`**
- `buildGoogleSearchUrl` (line 58): default `geo = "in"`.
- `brightDataSearch` (line 77): `const geo = process.env.SERP_GEO || "in";`. `hl:"en"`, `gl:geo`,
  and `country: geo` in the POST body are already wired (lines 63, 100) — just confirm.
- **Optional** hardening of `extractBrightDataAiOverview`: also harvest `ao.links[]` / inline
  `{ href }` on text blocks into `references` before the dedupe at line 215. Existing
  `references/sources/citations` parsing stays. Low risk; skip if it complicates the diff.

**Environment** (set on the remote environment / `.env.local` locally — `.env.local` is gitignored;
`.env.example` IS tracked, so update it):
```
SERP_GEO=in
OPENROUTER_API_KEY=sk-or-v1-...            # never commit
OPENROUTER_MODEL=google/gemma-4-31b-it:free
```

---

## Phase 4 — Competitor extraction via one batched LLM call

**New `src/lib/scoring/competitorExtract.js`**:
- `extractCompetitors({ results, brand, brandUrl, userCompetitors = [], stats, max = 10 })`:
  filter to `!is_branded_query && aio_present`; join `aio_text` (cap ~12k chars) + unique cited
  domains from `aio_references[].domain`; one `llmJson` call asking for competitor/alternative
  **company/product names** (exclude the tracked brand; no generic words; infer domain if possible)
  → `[{name, domain}]`. Merge `userCompetitors` first (`source:"user"`), then discovered
  (`source:"discovered"`), dedupe by lowercased name, then call `matchCompetitorsBack`.
- `matchCompetitorsBack(nonBrandedWithAio, competitors, brand)` → for each competitor build aliases
  via `getBrandAliases(name, domain)`; text hit via a **local pure `detectMention`** (copy the
  regex helper from `coMentions.js`/`judge.js` — do not import `judge.js`, it pulls `gemini.js`
  into the graph); citation hit via **`citationMatchesCompetitor`-style alias matching** (reuse the
  helper in `coMentions.js`, which handles domain + brand-word matches and tolerates a missing
  competitor domain — the draft's strict `x.domain === comp.domain` misses discovered names with
  no domain). Return `{ name, source, mentions, citations, prompts, userAbsent, visibilityScore,
  citationShare }` (denominator = `nonBrandedWithAio.length`), keep `prompts > 0 || source==="user"`,
  sort by `visibilityScore` desc. This is shape-compatible with the existing
  `computeCompetitorAioMetrics` output that `CompetitorTable.jsx` already consumes.

Retire from the live path (keep files on disk): `buildCompetitorLeaderboard` /
`enrichResultsWithCompetitors` in `coMentions.js`, and `computeCompetitorAioMetrics` in
`aioPipeline.js`. `runAioScan` is called with `competitors: []`, so `probeQueryOnce`'s per-query
competitor matching becomes a no-op (leave the param).

---

## Phase 5 — Scoring: add the two sub-metrics (small change)

**`summarizeAioResults` (`aioPipeline.js:173`)** — the hero and coverage are already correct.
Add only:
```js
const presenceRatePct = nonBranded.length
  ? Math.round((visibleNonBranded / nonBranded.length) * 1000) / 10 : 0;   // visible / 30
// share_of_ai_pct is an explicit alias of the existing hero
```
Add to the returned `summary`: `presence_rate_pct` and `share_of_ai_pct` (= `visibilityPct`).
Keep `visibility_pct` as-is (client reads that key). Add a comment block stating the contract:
- `visibility_pct` / `share_of_ai_pct` (HERO) = `visible ÷ queries_with_aio`
- `aio_coverage_pct` = `queries_with_aio ÷ 30`
- `presence_rate_pct` = `visible ÷ 30`

**`src/lib/scoring/aioConstants.js`** — India AIO coverage is lower/volatile:
```
AIO_MIN_NON_BRANDED_COVERAGE = 0.15   // was 0.30
AIO_COVERAGE_WARNING_PCT     = 30     // was 50
AIO_ERROR_RATE_LIMIT_PCT = 50, AIO_MIN_NON_BRANDED_WITH_AIO = 5, AIO_CONCURRENCY = 3  // unchanged
```
`data_source_issue`/`insufficient_sample` logic in `summarizeAioResults` (lines 218-223) already
reads these constants — no code change beyond the values. When either flag is true the UI shows the
numbers flagged "treat with caution" rather than hiding them.

---

## Phase 6 — Rewire the worker (`src/lib/workers/scanWorker.js`)

Collapse to the unbranded-only flow:
1. Delete the branded-injection block (lines ~108-149) and the `mergeQueryLists` / branded-reduce
   block (lines ~187-208). Drop imports of `buildAioQueries`, `buildBrandedQueries`,
   `buildCompetitorLeaderboard`, `enrichResultsWithCompetitors`.
2. **Query sourcing:** `getPromptsForBrand(brand, false)` → if it returns ≥30 enabled prompts, use
   30; if it returns 1–29, call `generateUnbrandedPrompts` for the shortfall and `upsertPrompts` the
   new ones; if 0, call `generateUnbrandedPrompts(brand, url, industry, stats, 30)` and
   `upsertPrompts` all 30 (persist each with its `source`, `intent_tier`, `topic`).
3. **Probe:** `runAioScan({ brand, url, competitors: [], queries: the30, stats, onProgress })`.
4. **Scoring:** `const { results, summary } = scanOutput;` then
   `const competitorObjects = await extractCompetitors({ results, brand, brandUrl: url,
   userCompetitors: competitors, stats, max: 10 });`
   `const topDomains = aggregateAioTopDomains(results, url, competitorObjects.map(c => c.name));`
5. **scanRecord:** set `visibility_pct: summary.visibility_pct`; add `share_of_ai_pct`,
   `aio_coverage_pct`, `presence_rate_pct`; `prompts_tracked: 30`;
   `prompts_mentioned: summary.visible_non_branded`; `used_dynamic_prompts: true`;
   `query_source: "openrouter_unbranded"`; keep `summary_stats: summary`. Keep the `insertScan` +
   `updateScanJob(complete, run_record)` tail unchanged. `competitorsRaw` stays an optional user
   input (comma-split, default empty).

---

## Phase 7 — Frontend contract (labels + fields, no redesign)

**`src/services/api.js` `normalizeResult`** — surface `shareOfAiPct` (= `visibility_pct`, the hero),
`aioCoveragePct`, `presenceRatePct`, `queriesWithAio` (`summary.non_branded_with_aio`),
`promptsTracked` (30), `visibleCount` (`summary.visible_non_branded`). Because the pipeline now
emits all three consistent metrics, prefer `summary_stats` values and **stop** the client-side
recompute/disagreement path (`fieldsDisagree`, `recomputeFromResults` around lines 335-339) from
inventing a different denominator — trust the summary.

**`src/app/dashboard/page.js` + `src/components/dashboard/KpiCard.jsx`** (there is **no**
`HeroScoreCard`; the hero is `KpiCard` fed `score={result.visibilityScore}` at page.js:330):
- Hero label: **"Share of AI answers — you appear in N of M AI Overviews"** (N = `visibleCount`,
  M = `queriesWithAio`).
- Two sub-KPIs: "AI Overview coverage — M of 30 prompts" and "Presence — N of 30 prompts".
- Fix stale copy: error-gate text must say **50%** (matches `AIO_ERROR_RATE_LIMIT_PCT`); the
  coverage threshold copy in `KpiCard.jsx` reads `AIO_MIN_NON_BRANDED_COVERAGE` (now 15%)
  automatically; small-sample banner reads from `queriesWithAio`, not total.
- `CompetitorTable.jsx` already binds `{name, source, mentions, citations, prompts, userAbsent,
  visibilityScore, citationShare}` — no change needed.

---

## Phase 8 — Tests (offline, `node --test`, `*.test.mjs`)

**Placement matters:** the `test:scoring` script globs only `src/lib/scoring/**` and
`src/lib/engines/**`. Put **all** new tests under `src/lib/scoring/` (or widen the npm glob to
include `src/lib/*.test.mjs`). Mock the network by stubbing the provider modules — no live keys.

1. `openrouter.test.mjs` — `robustJsonParse`: clean JSON, code-fenced, JSON-in-prose,
   truncated/garbage → `null`.
2. `promptGen.test.mjs` — stub `llmJson` returning 12 items → top-up reaches exactly 30, drops
   branded/dupes/single-word; stub returning 30 clean → exactly 30, no PAA calls.
3. `summarize.test.mjs` — fixed 30-result array (14 with AIO, 6 visible) → assert
   `visibility_pct === 42.9`, `aio_coverage_pct` from 14/30, `presence_rate_pct` from 6/30, plus the
   gate booleans against the new constants.
4. `competitorExtract.test.mjs` — stub `llmJson` competitor list + fixed results → assert
   `matchCompetitorsBack` counts and `userAbsent`.
5. Extend existing `citations.test.mjs` if needed — exact / subdomain / mismatch domain match.

---

## Verification (before calling it done)

1. **Env:** `OPENROUTER_API_KEY`, `OPENROUTER_MODEL=google/gemma-4-31b-it:free`, `SERP_GEO=in`,
   plus existing `BRIGHTDATA_API_KEY`, `FIRECRAWL_API_KEY`, Supabase vars.
2. **Unit:** `npm run test:scoring` — all Phase 8 tests green.
3. **Prompt-gen smoke:** scratch script calling
   `generateUnbrandedPrompts("Quiller","https://quiller.io","",{})` → prints **exactly 30**
   unbranded prompts, none containing "quiller", spread across intent tiers; log ≤2 OpenRouter calls.
4. **Full scan (real):** `POST /api/scan` `{ brand:"Quiller", url:"https://quiller.io" }`; poll
   `/api/scan/[job_id]/status` to `complete`. In `run_record`: `results.length === 30`, all
   `is_branded_query === false`; `summary.non_branded_with_aio` ~3–25 (low India coverage is
   expected); `visibility_pct === visible ÷ queries_with_aio`, `aio_coverage_pct ===
   queries_with_aio/30`, `presence_rate_pct === visible/30` (mutually consistent);
   `competitors[]` real names (no "Software"/"Platform"/ceramics-stopword artifacts);
   `top_domains[]` typed brand/competitor/third_party.
5. **Dashboard:** hero shows "N of M AI Overviews", two /30 sub-KPIs, competitor table renders,
   no contradictory percentages.
6. **No-fallback check:** grep confirms only `openrouter.js`/`llm.js` are used by `promptGen.js` and
   `competitorExtract.js` — no `gemini.js` in that path.

**Definition of done:** a Quiller scan yields exactly 30 unbranded prompts, one internally-consistent
score triple, and a clean LLM-derived competitor list — reproducibly, in India geo, using the free
OpenRouter model with **no** paid/Gemini fallback.

---

## Out of scope
Branded prompts / Brand Presence panel (helpers retained). Perplexity/ChatGPT/Grok engines (probe
layer left pluggable). Auth / multi-tenancy. Deleting dead legacy (`engines/openai.js`,
`perplexity.js`, `bayesian.js`, `computeVisibilityScore.js`, `coMentions.js`) — safe to leave.

## Key files
- **New:** `src/lib/openrouter.js`, `src/lib/llm.js`, `src/lib/scoring/promptGen.js`,
  `src/lib/scoring/competitorExtract.js`, Phase-8 `*.test.mjs` (under `src/lib/scoring/`).
- **Edit:** `src/lib/engines/brightdata.js` (geo), `src/lib/scoring/aioPipeline.js`
  (summarize sub-metrics), `src/lib/scoring/aioConstants.js` (gates),
  `src/lib/workers/scanWorker.js` (rewire), `src/services/api.js` + `src/app/dashboard/page.js` +
  `src/components/dashboard/KpiCard.jsx` (labels/fields), `.env.example`.
- **Retire from live path (keep on disk):** `coMentions.js`, `buildAioQueries`/`deriveCategorySeeds`
  in `aioPrompts.js`, `computeCompetitorAioMetrics` in `aioPipeline.js`.
