# Visibility Score Accuracy Roadmap

> <!-- doc-status -->
> **Status: HISTORICAL.** A record of work done at the time, not an authority for current decisions. It predates the 2026-08-29 honesty audit, so any claim it makes about what is finished must be checked against [docs/BUILD_JOURNAL.md](../BUILD_JOURNAL.md) and [2026-08-29-rebuild-roadmap.md](./2026-08-29-rebuild-roadmap.md).

**Created**: 2026-07-06  
**Status**: Planning  
**Goal**: Make the AI Visibility Score dramatically more accurate, trustworthy, and defensible — moving from a binary mention rate to a multi-signal, multi-engine, statistically rigorous measurement system.

**Related files**:
- `src/app/api/scan/route.js` — current scan + scoring logic
- `src/server/prompts.js` — dynamic prompt generation
- `src/shared/gemini.js` — LLM probing + extraction
- `src/shared/api.js` — result normalization for dashboard
- `src/app/dashboard/page.js` — score display
- `docs/aeo-visibility-tracker-mvp-implementation-document-v1.md` — original MVP spec

---

## Current State (Diagnosis)

The headline **Visibility Score** today is:

```
Visibility Score = (prompts where mentioned = true) / (total prompts) × 100
```

**Known gaps**:
- Binary mention only — ignores `position`, `sentiment`, `citations` already collected
- Single engine (Gemini only)
- Single run per prompt (high variance)
- Same model probes and judges (circular)
- Prompt set may change every scan (trends not comparable)
- All prompts weighted equally regardless of buyer intent
- No confidence interval or error detection
- README claims scoring uses "co-mentions, sentiment, and rank position" — not true in code

---

## How to Use This Document

Steps are ordered **smallest → largest**. Each step is atomic: one clear change, one verifiable outcome.  
Complete steps in order within each phase. Phases can overlap only where noted.

**Step format**:
- **ID**: `P{phase}-S{number}` (e.g. `P1-S03`)
- **What**: exact change
- **Where**: file(s)
- **Done when**: acceptance criteria

---

## Phase 0: Foundations & Instrumentation

*No scoring changes yet. Make the system observable and testable.*

### P0-S01 — Create scoring constants file
- **What**: Add `src/shared/scoring/constants.js` with exported weight placeholders (all `1.0` for now)
- **Where**: new file
- **Done when**: File exists, imported nowhere yet, weights documented in comments

### P0-S02 — Add `computeVisibilityScore()` stub
- **What**: Add `src/shared/scoring/computeVisibilityScore.js` that accepts `results[]` and returns current binary formula (extract logic from `route.js`)
- **Where**: new file + update `src/app/api/scan/route.js` to call it
- **Done when**: Scan output unchanged; formula lives in one place

### P0-S03 — Add unit test file for scoring
- **What**: Add `src/lib/scoring/computeVisibilityScore.test.js` (or `__tests__/`) with 3 cases: 0%, 50%, 100%
- **Where**: new test file
- **Done when**: Tests pass locally

### P0-S04 — Log per-prompt analysis metadata
- **What**: In `analyzeResponseWithLLM`, log (server-side) when LLM judge vs fallback is used
- **Where**: `src/app/api/scan/route.js`
- **Done when**: Console shows `judge: llm | fallback` per prompt

### P0-S05 — Store raw response on each result
- **What**: Add `raw_response` field (truncated to 8KB) on each result object in scan output
- **Where**: `src/app/api/scan/route.js`
- **Done when**: API response includes `raw_response` per result; DB insert still works

### P0-S06 — Store model name used per probe
- **What**: Return `model_used` from `generateContent()` and attach to each result
- **Where**: `src/shared/gemini.js`, `src/app/api/scan/route.js`
- **Done when**: Each result has `model_used` string

### P0-S07 — Store probe temperature in result
- **What**: Pass explicit `temperature: 0.4` to answer-generation calls; save as `probe_temperature` on result
- **Where**: `src/app/api/scan/route.js`
- **Done when**: Field present on all results

### P0-S08 — Add `scoring_version` to scan record
- **What**: Add `scoring_version: "v1-binary"` to `scanRecord` in `/api/scan`
- **Where**: `src/app/api/scan/route.js`
- **Done when**: API + DB row include `scoring_version`

### P0-S09 — Extend `normalizeResult` to pass through new fields
- **What**: Map `raw_response`, `model_used`, `scoring_version` in `normalizeResult()`
- **Where**: `src/shared/api.js`
- **Done when**: Dashboard can read fields from normalized result (even if not displayed yet)

### P0-S10 — Add Supabase column for `scoring_version` (optional)
- **What**: Document migration SQL for `scoring_version text` on `scans` table
- **Where**: comment in `src/server/db.js` or README
- **Done when**: SQL snippet documented; insert doesn't break if column missing

---

## Phase 1: Composite Weighted Score (Quick Wins)

*Use data you already collect. Biggest perceived accuracy jump for least effort.*

### P1-S01 — Define position numeric weights
- **What**: In `constants.js`, set `POSITION_WEIGHTS`: `recommended: 1.0`, `compared: 0.6`, `cited: 0.3`, `omitted: 0`
- **Where**: `src/shared/scoring/constants.js`
- **Done when**: Constants exported and documented

### P1-S02 — Define sentiment numeric weights
- **What**: Set `SENTIMENT_WEIGHTS`: `positive: 1.0`, `neutral: 0.5`, `negative: 0`
- **Where**: `src/shared/scoring/constants.js`
- **Done when**: Constants exported

### P1-S03 — Add `scorePromptResult()` function
- **What**: Function that takes one result object, returns 0–1 float using mention × position × sentiment
- **Where**: `src/shared/scoring/computeVisibilityScore.js`
- **Done when**: Unit tests for: mentioned+recommended+positive ≈ 1.0, omitted = 0

### P1-S04 — Add citation bonus to per-prompt score
- **What**: If `citations` includes brand's domain (from scan `url`), add `CITATION_BONUS` (e.g. 0.15) capped at 1.0
- **Where**: `src/shared/scoring/computeVisibilityScore.js`
- **Done when**: Test: mentioned + brand domain cited scores higher than mentioned alone

### P1-S05 — Add `prompt_score` field on each result
- **What**: After analysis, compute and attach `prompt_score` (0–100) per result in scan route
- **Where**: `src/app/api/scan/route.js`
- **Done when**: Each result in API has `prompt_score`

### P1-S06 — Switch aggregate score to average of `prompt_score`
- **What**: `visibility_pct` = mean of all `prompt_score` values (not binary mention count)
- **Where**: `computeVisibilityScore.js` + `route.js`
- **Done when**: Score changes for brands with "compared" or "cited" mentions vs old binary

### P1-S07 — Keep legacy binary score as `mention_rate_pct`
- **What**: Also return `mention_rate_pct` (old formula) alongside new `visibility_pct`
- **Where**: `scanRecord` in `route.js`, `normalizeResult` in `api.js`
- **Done when**: Both fields in API response

### P1-S08 — Bump `scoring_version` to `v2-composite`
- **What**: Update version string when composite scoring is active
- **Where**: `route.js`
- **Done when**: New scans show `v2-composite`

### P1-S09 — Update `generateSummary()` thresholds
- **What**: Tune copy thresholds in `api.js` if composite scores skew differently
- **Where**: `src/shared/api.js`
- **Done when**: Summary text still reads naturally for low/mid/high scores

### P1-S10 — Show score breakdown tooltip on KPI card
- **What**: Add small "How is this calculated?" tooltip on `KpiCard` listing mention, position, sentiment, citations
- **Where**: `src/components/dashboard/KpiCard.jsx`
- **Done when**: Tooltip visible on dashboard

### P1-S11 — Add per-prompt score column to Top Prompts table
- **What**: Show `prompt_score` column (or replace rank with composite score)
- **Where**: `src/components/dashboard/TopPromptsTable.jsx`
- **Done when**: Table shows per-prompt score

### P1-S12 — Update README scoring description
- **What**: Align README with actual composite formula
- **Where**: `README.md`
- **Done when**: README matches code

---

## Phase 2: Multi-Run Stability & Confidence

*Reduce variance. One Gemini answer per prompt is statistically noisy.*

### P2-S01 — Add `PROBE_RUNS` constant (default: 3)
- **What**: Config constant for number of probe runs per prompt
- **Where**: `src/shared/scoring/constants.js`
- **Done when**: Constant exported

### P2-S02 — Refactor single-prompt probe into `probePromptOnce()`
- **What**: Extract one probe + analyze into isolated async function
- **Where**: `src/app/api/scan/route.js` (or `src/lib/scoring/probe.js`)
- **Done when**: Single run behavior unchanged

### P2-S03 — Add `probePromptMultiple()` wrapper
- **What**: Call `probePromptOnce()` N times in parallel; collect N results
- **Where**: `src/lib/scoring/probe.js`
- **Done when**: Returns array of N analysis results per prompt

### P2-S04 — Compute per-prompt median `prompt_score`
- **What**: Aggregate N runs: median score, majority-vote `mentioned`, most common `position`
- **Where**: `src/shared/scoring/aggregate.js`
- **Done when**: One merged result per prompt from N runs

### P2-S05 — Store `run_details` array on each result
- **What**: Keep all N individual run outcomes under `result.run_details[]`
- **Where**: scan result shape
- **Done when**: API includes nested run details (can collapse in UI later)

### P2-S06 — Compute `prompt_score_stddev` per prompt
- **What**: Standard deviation across N run scores
- **Where**: `aggregate.js`
- **Done when**: Field on each result

### P2-S07 — Compute scan-level `confidence_interval`
- **What**: Add `score_ci_low`, `score_ci_high` (e.g. ±1 stddev of prompt scores) on scan record
- **Where**: `computeVisibilityScore.js`, `scanRecord`
- **Done when**: API returns CI fields

### P2-S08 — Add `stability` flag on scan
- **What**: `stability: "high" | "medium" | "volatile"` based on average stddev
- **Where**: `computeVisibilityScore.js`
- **Done when**: Field on scan record

### P2-S09 — Display confidence range on KPI card
- **What**: Show "64% ± 6%" under main score when CI available
- **Where**: `KpiCard.jsx`
- **Done when**: UI shows range

### P2-S10 — Add volatile-scan warning in InsightPanel
- **What**: If `stability === "volatile"`, show note: "Score may vary — consider re-running"
- **Where**: `InsightPanel.jsx`
- **Done when**: Warning appears for high-variance scans

### P2-S11 — Add env flag to disable multi-run for dev
- **What**: `PROBE_RUNS=1` in `.env.local` skips extra runs
- **Where**: constants + docs
- **Done when**: Dev can run fast single-pass scans

### P2-S12 — Update progress UI for longer scans
- **What**: Adjust scan page progress steps / timing copy for 3× probe duration
- **Where**: `src/app/scan/page.js`
- **Done when**: User sees realistic wait estimate

---

## Phase 3: Persistent & Weighted Prompt Sets

*Same prompts every run = comparable trends. Intent weighting = commercially relevant score.*

### P3-S01 — Design DB schema: `brand_prompts` table
- **What**: Document table: `id`, `brand`, `text`, `intent_tier`, `topic`, `weight`, `enabled`, `created_at`
- **Where**: this doc + `src/server/db.js` comment
- **Done when**: SQL migration snippet written

### P3-S02 — Create `brand_prompts` table in Supabase
- **What**: Run migration
- **Where**: Supabase
- **Done when**: Table exists

### P3-S03 — Add `src/server/db/prompts.js` CRUD helpers
- **What**: `getPromptsForBrand()`, `upsertPrompts()`, `disablePrompt()`
- **Where**: new file
- **Done when**: Functions work against Supabase

### P3-S04 — Define intent tier enum
- **What**: `high_intent | comparison | problem_aware | branded | exploratory`
- **Where**: `src/shared/scoring/constants.js`
- **Done when**: Tiers + default weights documented (e.g. high_intent: 3.0, branded: 0.5)

### P3-S05 — Update prompt generator to tag intent tier
- **What**: Modify `generatePromptsForBrand` JSON schema to return `{ text, intent_tier, topic_suggestion }`
- **Where**: `src/server/prompts.js`
- **Done when**: Generator returns tagged prompts

### P3-S06 — Save generated prompts to `brand_prompts` on first scan
- **What**: After generation, upsert into DB keyed by brand
- **Where**: `src/app/api/scan/route.js`
- **Done when**: Second scan for same brand loads from DB

### P3-S07 — Load existing prompts before generating new ones
- **What**: If `brand_prompts` has ≥15 enabled rows, skip generation
- **Where**: `route.js`
- **Done when**: Re-scans reuse same prompts

### P3-S08 — Add `prompt_set_id` and `prompt_set_hash` to scan record
- **What**: Hash of enabled prompt texts; store on scan for comparability checks
- **Where**: `route.js`
- **Done when**: Fields on scan record

### P3-S09 — Weight aggregate score by intent tier
- **What**: `visibility_pct` = weighted mean of `prompt_score × intent_weight`
- **Where**: `computeVisibilityScore.js`
- **Done when**: High-intent prompts move the needle more

### P3-S10 — Add `intent_breakdown` to scan record
- **What**: JSON: `{ high_intent: 41, comparison: 22, ... }` per-tier avg scores
- **Where**: `computeVisibilityScore.js`
- **Done when**: API returns breakdown

### P3-S11 — Show intent breakdown on dashboard
- **What**: Small bar chart or list under KPI card
- **Where**: new `ScoreBreakdown.jsx` or extend `KpiCard`
- **Done when**: User sees per-tier scores

### P3-S12 — Warn when prompt set changed between scans
- **What**: Compare `prompt_set_hash` vs previous scan; show delta badge on trend
- **Where**: `dashboard/page.js`
- **Done when**: "Prompt set changed" warning when hash differs

### P3-S13 — Add "Add custom prompt" API endpoint
- **What**: `POST /api/brands/[brand]/prompts`
- **Where**: new route
- **Done when**: Custom prompt saved and used on next scan

### P3-S14 — Add "Disable prompt" API endpoint
- **What**: `PATCH /api/prompts/[id]` set `enabled: false`
- **Where**: new route
- **Done when**: Disabled prompt excluded from scans

### P3-S15 — Add prompt management UI (minimal)
- **What**: List prompts on dashboard with enable/disable toggle
- **Where**: new component or tab
- **Done when**: User can disable a prompt before re-scan

---

## Phase 4: Topic Clustering

*One global number hides where you're strong vs weak.*

### P4-S01 — Define topic taxonomy helper
- **What**: `normalizeTopic(name)` — slugify, trim
- **Where**: `src/shared/scoring/topics.js`
- **Done when**: Helper exported

### P4-S02 — Assign topics during prompt generation
- **What**: Use `topic_suggestion` from generator; fallback `"General"`
- **Where**: `prompts.js`, `brand_prompts` table
- **Done when**: Every prompt has a topic

### P4-S03 — Compute `topic_scores` on scan
- **What**: Group results by topic; avg `prompt_score` per topic
- **Where**: `computeVisibilityScore.js`
- **Done when**: `topic_scores: { "Integrations": 72, "Pricing": 12 }` on scan

### P4-S04 — Store `topic_scores` on scan record
- **Where**: `route.js`, DB
- **Done when**: Persisted and returned in API

### P4-S05 — Add Topics grouped view to Top Prompts table
- **What**: Expandable topic rows with aggregate score
- **Where**: `TopPromptsTable.jsx`
- **Done when**: Group-by-topic toggle works

### P4-S06 — Add topic filter dropdown
- **What**: Filter table to one topic
- **Where**: `TopPromptsTable.jsx`
- **Done when**: Filter works client-side

### P4-S07 — Show strongest/weakest topic in InsightPanel
- **What**: "Strongest: Integrations (72%). Weakest: Pricing (12%)."
- **Where**: `InsightPanel.jsx`
- **Done when**: Copy auto-generated from `topic_scores`

---

## Phase 5: Decouple Probe from Judge

*Stop using the same model to answer and grade.*

### P5-S01 — Create `src/shared/scoring/judge.js`
- **What**: New module for mention detection
- **Where**: new file
- **Done when**: File exists

### P5-S02 — Add brand alias extractor
- **What**: `getBrandAliases(brand, website)` — brand name, domain slug, common variants
- **Where**: `judge.js`
- **Done when**: Returns `["Acme", "acme.io", "Acme Corp"]`

### P5-S03 — Implement deterministic `detectMention()`
- **What**: Case-insensitive match for aliases; word-boundary check
- **Where**: `judge.js`
- **Done when**: Tests: "ACME is great" → true; "acmeist philosophy" → false

### P5-S04 — Implement deterministic `detectPosition()`
- **What**: Based on index of first alias match relative to text length
- **Where**: `judge.js`
- **Done when**: Replaces fallback position logic

### P5-S05 — Implement deterministic `detectSentiment()`
- **What**: Window around mention; positive/negative word lists (reuse existing)
- **Where**: `judge.js`
- **Done when**: Matches or improves on current fallback

### P5-S06 — Implement `extractCitations()` regex parser
- **What**: Pull URLs from response text via regex
- **Where**: `judge.js`
- **Done when**: URLs returned without LLM call

### P5-S07 — Add `judgeDeterministic()` orchestrator
- **What**: Runs all deterministic extractors; returns structured result
- **Where**: `judge.js`
- **Done when**: Output shape matches current analysis result

### P5-S08 — Add `judgeWithLLM()` for edge cases only
- **What**: LLM judge called only when deterministic is ambiguous (e.g. partial match)
- **Where**: `judge.js`
- **Done when**: `judge_method: "deterministic" | "llm"` on result

### P5-S09 — Wire judge into scan route
- **What**: Replace direct `analyzeResponseWithLLM` with `judgeDeterministic` first
- **Where**: `route.js`
- **Done when**: Most prompts use deterministic path

### P5-S10 — Log judge method ratio per scan
- **What**: `judge_stats: { deterministic: 18, llm: 2 }` on scan record
- **Where**: `route.js`
- **Done when**: Stats persisted

### P5-S11 — Create calibration fixture file
- **What**: `src/shared/scoring/fixtures/calibration.json` — 20 `{ response, brand, expected: { mentioned, position } }`
- **Where**: new file
- **Done when**: Fixture exists with hand-labeled cases

### P5-S12 — Add calibration test script
- **What**: `npm run test:calibration` runs judge against fixture; reports precision/recall
- **Where**: package.json script + test file
- **Done when**: Script runs and prints metrics

### P5-S13 — Tune alias matching from calibration failures
- **What**: Iteratively fix false positives/negatives
- **Where**: `judge.js`
- **Done when**: ≥90% accuracy on fixture set

---

## Phase 6: Share of Voice & Competitor-Normalized Scoring

*Raw visibility means little without competitive context.*

### P6-S01 — Add `share_of_voice_pct` per scan
- **What**: `brand_mentions / (brand_mentions + competitor_mentions)` across all prompts
- **Where**: `computeVisibilityScore.js`
- **Done when**: Field on scan record

### P6-S02 — Compute per-competitor visibility score
- **What**: Already partially in `extractCompetitors`; align with new composite per-prompt scoring
- **Where**: `api.js`
- **Done when**: Competitor scores use same composite logic

### P6-S03 — Add `win_rate` on comparison prompts
- **What**: On prompts tagged `comparison`, % where brand mentioned and competitor not
- **Where**: `computeVisibilityScore.js`
- **Done when**: `win_rate_pct` on scan record

### P6-S04 — Add `gap_score` per prompt vs top competitor
- **What**: `competitor_prompt_score - brand_prompt_score`
- **Where**: per-result field
- **Done when**: Stored on results where competitors found

### P6-S05 — Show Share of Voice on dashboard
- **What**: Second KPI or sub-metric under main score
- **Where**: `KpiCard.jsx` or new `SovCard.jsx`
- **Done when**: SOV visible

### P6-S06 — Update CompetitorTable with SOV and win rate
- **Where**: `CompetitorTable.jsx`
- **Done when**: Columns added

### P6-S07 — Update OpportunitiesPanel to sort by gap_score
- **What**: Prioritize prompts where competitor visible and brand not
- **Where**: `OpportunitiesPanel.jsx`, `/api/opportunities`
- **Done when**: Biggest gaps surface first

---

## Phase 7: Citation Share as First-Class Metric

*Citations drive traffic; mentions don't always.*

### P7-S01 — Add `extractBrandDomain(url)` helper
- **What**: Parse hostname from brand website URL
- **Where**: `src/shared/scoring/citations.js`
- **Done when**: `acme.io` from `https://www.acme.io/pricing`

### P7-S02 — Normalize citation URLs
- **What**: Strip query params, trailing slash, lowercase hostname
- **Where**: `citations.js`
- **Done when**: `normalizeUrl()` tested

### P7-S03 — Classify each citation: brand | competitor | third_party
- **What**: Match hostname against brand domain + competitor domains (if known)
- **Where**: `citations.js`
- **Done when**: Classification enum returned

### P7-S04 — Add `citation_share_pct` on scan
- **What**: % of prompts where brand domain appears in citations
- **Where**: `computeVisibilityScore.js`
- **Done when**: Field on scan record

### P7-S05 — Add `competitor_citation_share` breakdown
- **What**: Per-competitor citation share
- **Where**: scan record `citation_breakdown`
- **Done when**: JSON on scan

### P7-S06 — Aggregate top cited domains across prompts
- **What**: `top_domains: [{ domain, count, type }]` on scan
- **Where**: `citations.js`
- **Done when**: Top 10 domains returned

### P7-S07 — Wire CitationsPanel to real data
- **What**: Replace any mock/stub with `top_domains` from scan
- **Where**: `CitationsPanel.jsx`
- **Done when**: Panel shows real cited domains

### P7-S08 — Add citation share to KPI area
- **What**: Display "Citation Share: 18%" sub-metric
- **Where**: dashboard
- **Done when**: Visible alongside visibility score

### P7-S09 — Factor citation share into composite score (optional weight)
- **What**: Add `CITATION_SHARE_WEIGHT` to overall formula (e.g. 15% of headline score)
- **Where**: `constants.js`, `computeVisibilityScore.js`
- **Done when**: Headline score blends mention + citation

---

## Phase 8: Multi-Engine Probing

*Real buyers use ChatGPT, Perplexity, Gemini — not just one.*

### P8-S01 — Define `Engine` enum
- **What**: `gemini | openai | perplexity` (extensible; Phase 8b adds `google_ai_overview`)
- **Where**: `src/shared/engines/types.js`
- **Done when**: Types exported

### P8-S02 — Create engine adapter interface
- **What**: `probe(engine, prompt, options) → responseText`
- **Where**: `src/lib/engines/adapter.js`
- **Done when**: Interface documented

### P8-S03 — Refactor Gemini into adapter
- **What**: `src/shared/engines/gemini.js` wraps existing `generateContent`
- **Where**: new file
- **Done when**: Gemini scans work through adapter

### P8-S04 — Add OpenAI adapter stub
- **What**: `src/shared/engines/openai.js` — requires `OPENAI_API_KEY`
- **Where**: new file
- **Done when**: Returns response or graceful skip if no key

### P8-S05 — Add Perplexity adapter stub
- **What**: `src/shared/engines/perplexity.js` — requires `PERPLEXITY_API_KEY`
- **Where**: new file
- **Done when**: Returns response with citations if available

### P8-S06 — Add `ENGINES_ENABLED` env config
- **What**: Comma-separated list; default `gemini` only
- **Where**: `.env.local` docs
- **Done when**: Scan probes only enabled engines

### P8-S07 — Run each prompt against all enabled engines
- **What**: Nested loop: prompts × engines × runs
- **Where**: `src/lib/scoring/probe.js`
- **Done when**: Results tagged with `engine` field

### P8-S08 — Store per-engine scores on scan
- **What**: `engine_scores: { gemini: 71, perplexity: 12, openai: 45 }`
- **Where**: scan record
- **Done when**: API returns per-engine breakdown

### P8-S09 — Compute headline score as weighted cross-engine average
- **What**: Default LLM-only weights: Perplexity 0.4, OpenAI 0.35, Gemini 0.25 (tunable). **Phase 8b replaces with hybrid weights** when `google_ai_overview` is enabled.
- **Where**: `constants.js`, `computeVisibilityScore.js`
- **Done when**: Single headline number reflects multi-engine

### P8-S10 — Display per-engine breakdown on dashboard
- **What**: Horizontal bars: Gemini / ChatGPT / Perplexity
- **Where**: new `EngineBreakdown.jsx`
- **Done when**: UI shows per-engine scores

### P8-S11 — Handle partial engine failure gracefully
- **What**: If one engine fails, score others; flag `engines_partial: true`
- **Where**: `probe.js`, `route.js`
- **Done when**: Scan completes with 2/3 engines

### P8-S12 — Add engine-specific citation handling
- **What**: Perplexity returns structured citations — parse those first
- **Where**: `perplexity.js`, `citations.js`
- **Done when**: Perplexity citations classified correctly

### P8-S13 — Add cost tracking per engine
- **What**: `cost_by_engine` on scan record
- **Where**: probe layer
- **Done when**: Token/cost estimates logged per engine

**Note**: Complete Phase 8 (adapter interface + at least Gemini adapter) before starting Phase 8b. Phase 8b adds SERP/AI Overview as the **primary production probe** in a hybrid stack.

---

## Phase 8b: Hybrid Probing (SERP / AI Overview + LLM Engines)

*Buyers see Google's AI Overview and other answer engines — not an isolated Gemini API call. Reuse the Phase 1–7 scoring pipeline; swap and extend the **probe layer** only.*

### Architecture

```
Prompt set (same 15 queries every run)
        │
        ├─ google_ai_overview (SERP API)     ← primary prod probe (~50% headline weight)
        ├─ perplexity                        ← answer engine (~25%)
        ├─ openai                            ← answer engine (~15%)
        └─ gemini                              ← dev / fallback / cheap (~10%, or dev-only)
        │
        ▼
  Same judge + scoring (Phases 1–7)
  → visibility, SOV, citations, topics, gap_score, etc.
        │
        ▼
  Headline score = weighted cross-source blend (tunable in constants)
```

**Prerequisite**: Phase 8 adapter interface (`probe(engine, prompt, options) → ProbeResult`).

### P8b-S01 — Extend `Engine` enum with `google_ai_overview`
- **What**: Add `google_ai_overview` to `src/shared/engines/types.js`; document hybrid probe roles in comments
- **Where**: `types.js`
- **Done when**: Enum includes `gemini | openai | perplexity | google_ai_overview`

### P8b-S02 — Research SerpAPI vs DataForSEO for AI Overview
- **What**: Compare pricing, AI Overview availability, citation fields, geo/device params; document go/no-go + chosen provider
- **Where**: this doc (decision note below P8b-S02) or `docs/decisions/serp-provider.md`
- **Done when**: One provider selected; cost-per-scan estimate for 15 prompts documented

### P8b-S03 — Create `src/shared/engines/serp.js` adapter
- **What**: `probeGoogleAiOverview(query, options) → { text, citations, engine: "google_ai_overview", raw }`
- **Where**: new file; implements Phase 8 adapter interface
- **Done when**: Returns parsed overview text + citation URLs when `SERPAPI_KEY` set; graceful empty result when key missing

### P8b-S04 — Parse AI Overview text and citations from SERP response
- **What**: Extract overview snippet/blocks and linked domains; normalize URLs via `normalizeUrl()` from `citations.js`
- **Where**: `serp.js`
- **Done when**: Unit tests with fixture JSON; citations passed to existing `classifyCitation()` pipeline

### P8b-S05 — Add `SERPAPI_KEY`, `SERP_GEO`, `SERP_DEVICE` env config
- **What**: Document in README + `.env.local` example; default geo `us`, device `desktop`
- **Where**: env docs, `constants.js` or `engines/serp.js`
- **Done when**: Scan respects locale params; missing key skips SERP without failing scan

### P8b-S06 — Add `PROBE_MODE` env: `hybrid | llm_only | serp_primary`
- **What**: `hybrid` (default prod): SERP + enabled LLMs. `llm_only`: current behavior (fast dev). `serp_primary`: SERP only, LLMs as fallback on SERP miss
- **Where**: `probe.js`, `constants.js`
- **Done when**: Dev can run `PROBE_MODE=llm_only` without SERP costs

### P8b-S07 — Wire hybrid probe loop in `probe.js`
- **What**: For each prompt × enabled engines: call adapter; tag every result with `engine` field; SERP runs first when `PROBE_MODE` is hybrid/serp_primary
- **Where**: `probe.js`, `scan/route.js`
- **Done when**: Scan results include mixed-engine `run_details`; existing judge/scoring unchanged

### P8b-S08 — Add default hybrid engine weights
- **What**: `ENGINE_WEIGHTS`: `google_ai_overview: 0.50`, `perplexity: 0.25`, `openai: 0.15`, `gemini: 0.10` (tunable; gemini optional 0 in prod)
- **Where**: `constants.js`, `computeVisibilityScore.js`
- **Done when**: Headline `visibility_pct` blends per-engine sub-scores when multiple engines present

### P8b-S09 — Store `engine_scores` and `probe_sources` on scan record
- **What**: `engine_scores: { google_ai_overview: 64, perplexity: 58, ... }`; `probe_sources: ["google_ai_overview","perplexity"]` for transparency
- **Where**: `route.js`, `db.js` `raw_results`
- **Done when**: API + `normalizeResult()` expose breakdown; persisted across reloads

### P8b-S10 — Update `EngineBreakdown` UI for hybrid sources
- **What**: Show Google AI Overview bar first (labeled clearly), then Perplexity / ChatGPT / Gemini; badge when `engines_partial: true`
- **Where**: `EngineBreakdown.jsx` (Phase 8) or extend `ScoreBreakdown.jsx`
- **Done when**: Dashboard distinguishes SERP-sourced vs LLM-sourced scores

### P8b-S11 — Citation handling for SERP-sourced results
- **What**: Prefer structured citations from SERP response over regex `extractCitations()` on overview text
- **Where**: `serp.js`, `citations.js`
- **Done when**: `brand_citation_share_pct` and `top_domains` reflect real overview links in hybrid scans

### P8b-S12 — Handle SERP misses and partial coverage
- **What**: If no AI Overview for a query, fall back to enabled LLM engines for that prompt only; flag `serp_coverage_pct` on scan
- **Where**: `probe.js`, `route.js`
- **Done when**: Scan completes when 40% of queries lack an overview; UI shows coverage %

### P8b-S13 — Cost tracking for SERP probes
- **What**: `cost_by_engine.google_ai_overview` — estimated $ per scan based on queries × SERP price
- **Where**: probe layer, scan record
- **Done when**: Logged alongside LLM token costs from P8-S13

### P8b-S14 — Bump `scoring_version` to `v5-hybrid`
- **What**: Version string when hybrid weights active; dashboard warns on trend compare across `v4-multi-run` vs `v5-hybrid`
- **Where**: `constants.js`, `KpiCard` / dashboard trend logic
- **Done when**: Mixed-version trends show existing `isMixedTrend` warning

### P8b-S15 — Update README and hero tooltip for hybrid methodology
- **What**: Copy explains: "We probe Google AI Overview + major answer engines using the same tracked queries every run"
- **Where**: `README.md`, `KpiCard.jsx` tooltip, landing page (Phase 12 can fully polish)
- **Done when**: Marketing matches hybrid implementation

**Phase guidance**: Ship 8b before treating scores as "production AEO." Phases 1–7 scoring is engine-agnostic — 8b changes *data source*, not measurement math. Gemini remains valuable for dev (`PROBE_MODE=llm_only`) and prompt generation (`prompts.js`).

---

## Phase 9: Quality Gates & Artifact Detection

*Discard or flag bad runs before they become misleading scores.*

### P9-S01 — Add control prompts to every scan
- **What**: Append 2–3 prompts with known answers (e.g. "Who makes the iPhone?")
- **Where**: `src/shared/scoring/controlPrompts.js`
- **Done when**: Controls included in every scan

### P9-S02 — Validate control prompt responses
- **What**: If control fails (expected mention not found), set `quality_gate_failed: true`
- **Where**: `route.js`
- **Done when**: Flag on scan record

### P9-S03 — Detect empty/timed-out responses
- **What**: Track `failed_probes` count; if >20% of probes, flag scan
- **Where**: `route.js`
- **Done when**: `probe_failure_rate` on scan

### P9-S04 — Detect brand injection in prompt
- **What**: Warn if prompt text contains brand name (except branded tier)
- **Where**: pre-probe validation
- **Done when**: `brand_in_prompt_warning` on affected results

### P9-S05 — Detect judge disagreement
- **What**: If deterministic and LLM judge disagree on `mentioned`, log and use conservative (false)
- **Where**: `judge.js`
- **Done when**: `judge_disagreement` count on scan

### P9-S06 — Block score display on quality gate failure
- **What**: Dashboard shows "Scan unreliable — please re-run" instead of score
- **Where**: `dashboard/page.js`
- **Done when**: UI handles failed gate

### P9-S07 — Add scan retry button for failed gates
- **Where**: dashboard
- **Done when**: One-click re-run available

---

## Phase 10: Bayesian Scoring & Statistical Rigor

*Move from point estimates to credible ranges.*

### P10-S01 — Add category prior constants
- **What**: `CATEGORY_PRIORS: { saas: 0.35, agency: 0.25, ... }` — default mention rate
- **Where**: `constants.js`
- **Done when**: Priors documented per industry

### P10-S02 — Implement Beta-Binomial posterior
- **What**: `posteriorMean`, `credibleIntervalLow`, `credibleIntervalHigh` given prior + observed mentions
- **Where**: `src/shared/scoring/bayesian.js`
- **Done when**: Unit tests with known inputs

### P10-S03 — Replace CI fields with Bayesian credible interval
- **What**: Use 90% credible interval instead of stddev-based CI
- **Where**: `computeVisibilityScore.js`
- **Done when**: `score_ci_low/high` use Bayesian method

### P10-S04 — Show "likely range" language in UI
- **What**: "64% (likely range 55–73%)" instead of "±"
- **Where**: `KpiCard.jsx`
- **Done when**: Copy updated

### P10-S05 — Add `sample_size_adequacy` flag
- **What**: Warn if <30 prompts: "Score based on small sample"
- **Where**: `computeVisibilityScore.js`, dashboard
- **Done when**: Warning shown when applicable

---

## Phase 11: Async Scan Pipeline

*Enables multi-engine, multi-run, long scans without Vercel timeouts.*

### P11-S01 — Design scan job states
- **What**: `pending → generating_prompts → probing → analyzing → scoring → complete | failed`
- **Where**: this doc
- **Done when**: State machine documented

### P11-S02 — Add `scan_jobs` table
- **What**: `id`, `brand`, `status`, `progress_pct`, `created_at`, `result_id`
- **Where**: Supabase migration
- **Done when**: Table exists

### P11-S03 — Change `POST /api/scan` to enqueue job
- **What**: Return `{ job_id }` immediately; worker processes async
- **Where**: `route.js`
- **Done when**: API returns in <2s

### P11-S04 — Add `GET /api/scan/[job_id]/status`
- **What**: Return status + progress_pct
- **Where**: new route
- **Done when**: Poll endpoint works

### P11-S05 — Implement worker function
- **What**: Background processor runs probe pipeline; updates job status
- **Where**: `src/server/workers/scanWorker.js`
- **Done when**: Job completes end-to-end

### P11-S06 — Wire scan page to poll job status
- **What**: Replace single fetch with poll loop until complete
- **Where**: `scan/page.js`, `api.js`
- **Done when**: Progress bar reflects real progress

### P11-S07 — Add Vercel Cron or Inngest trigger for worker
- **Where**: deployment config
- **Done when**: Jobs process in production without blocking request

### P11-S08 — Store immutable run record
- **What**: Full snapshot: prompts, engines, models, temps, raw responses, judge outputs, scoring_version
- **Where**: `scan_jobs` or `scans.raw_results`
- **Done when**: Any historical run is reproducible

---

## Phase 12: Score Decomposition UI

*Users trust broken-down scores more than one number.*

### P12-S01 — Create `ScoreBreakdown` component
- **What**: Card showing: composite score, mention rate, SOV, citation share, CI
- **Where**: `src/components/dashboard/ScoreBreakdown.jsx`
- **Done when**: Component renders with mock data

### P12-S02 — Wire to real scan data
- **Where**: `dashboard/page.js`
- **Done when**: Live data displayed

### P12-S03 — Create `EngineBreakdown` component
- **Where**: new component
- **Done when**: Per-engine bars shown

### P12-S04 — Create `IntentBreakdown` component
- **Where**: new component
- **Done when**: Per-intent-tier bars shown

### P12-S05 — Create `TopicBreakdown` component
- **Where**: new component
- **Done when**: Per-topic scores shown

### P12-S06 — Add "How we calculate this" modal
- **What**: Full methodology explanation for users
- **Where**: dashboard modal
- **Done when**: Modal accessible from KPI card

### P12-S07 — Update landing page copy to match real methodology
- **Where**: `src/app/page.js`
- **Done when**: Marketing matches implementation

---

## Phase 13: External Query Data (Optional, High Value)

*LLM-generated prompts alone don't reflect real search demand. **Probing** via SERP/AI Overview is Phase 8b; this phase is **prompt sourcing** only (PAA, autocomplete, GSC).*

### P13-S01 — Reuse SERP provider from Phase 8b for PAA + autocomplete
- **What**: Extend `src/shared/engines/serp.js` (or `src/lib/queryData/serp.js`) with PAA/autocomplete endpoints
- **Done when**: Same API key as 8b; no second provider decision needed

### P13-S02 — Add `fetchPeopleAlsoAsk(industry, seedTerms)` stub
- **Where**: `src/lib/queryData/serp.js` (imports shared SERP client from 8b)
- **Done when**: Returns [] without API key; real data with key

### P13-S03 — Merge PAA queries into prompt generation pool
- **Where**: `prompts.js`
- **Done when**: Generated set includes 5–10 PAA-sourced prompts

### P13-S04 — Tag PAA-sourced prompts with `source: "paa"`
- **Where**: `brand_prompts` table
- **Done when**: Source tracked

### P13-S05 — (Stretch) Google Search Console OAuth integration
- **Done when**: User can import top queries as tracked prompts

---

## Phase 14: Content Lift Tracking (Optional, Moat)

*Tie visibility changes to content actions.*

### P14-S01 — Store `content_events` table (publish URL, date, brand)
- **Done when**: Table + CRUD exist

### P14-S02 — On re-scan, tag prompts semantically similar to new content
- **Done when**: `related_content_url` on matching prompts

### P14-S03 — Compute lift: score on related prompts vs previous scan
- **Done when**: `content_lift` report per URL

### P14-S04 — Show content lift card on dashboard
- **Done when**: "After publishing /blog/x: +12% on 4 related prompts"

---

## Environment Variables (Cumulative)

```env
# Existing
GEMINI_API_KEY=
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=

# Phase 2
PROBE_RUNS=3                    # Set to 1 for fast dev scans

# Phase 8
OPENAI_API_KEY=                 # Optional
PERPLEXITY_API_KEY=             # Optional
ENGINES_ENABLED=gemini          # gemini,openai,perplexity,google_ai_overview

# Phase 8b (hybrid probing — primary prod path)
SERPAPI_KEY=                    # Required for google_ai_overview in prod
SERP_GEO=us                     # Optional: gl/hl country
SERP_DEVICE=desktop             # Optional: desktop | mobile
PROBE_MODE=hybrid               # hybrid | llm_only | serp_primary
ENGINE_WEIGHTS=                 # Optional override; default 0.50/0.25/0.15/0.10

# Phase 13 (prompt sourcing only — reuses SERPAPI_KEY from 8b)
```

---

## Scoring Version Changelog

| Version | Description |
|---------|-------------|
| `v1-binary` | Mention count / total prompts |
| `v2-composite` | Weighted: mention × position × sentiment + citation bonus |
| `v3-weighted` | v2 + intent-tier prompt weights |
| `v4-multi-run` | v3 + median across N probe runs |
| `v5-multi-engine` | v4 + cross-engine weighted average (LLM engines only) |
| `v5-hybrid` | v4 + SERP AI Overview + LLM engines with hybrid weights (Phase 8b) |
| `v6-bayesian` | v5-hybrid + credible intervals with category priors |

Bump `scoring_version` on every formula change. Never rewrite historical scores silently.

---

## Suggested Sprint Order

| Sprint | Phases | Outcome |
|--------|--------|---------|
| **Sprint 1** | P0 + P1 | Composite score live; formula in one place; tests |
| **Sprint 2** | P2 + P3 (S01–S11) | Multi-run stability + persistent prompts |
| **Sprint 3** | P4 + P5 + P6 | Topics, deterministic judge, share of voice |
| **Sprint 4** | P7 + P9 | Citation share + quality gates |
| **Sprint 5** | P8 (adapter + Gemini + Perplexity stubs) | Multi-engine LLM probing |
| **Sprint 5b** | P8b (SERP / AI Overview hybrid) | **Production-grade probes; Google AI Overview primary** |
| **Sprint 6** | P10 + P11 + P12 | Bayesian CI, async pipeline, full decomposition UI |
| **Sprint 7+** | P13 + P14 | PAA/autocomplete prompt sourcing, content lift |

---

## Definition of Done (Overall)

The visibility score overhaul is complete when:

1. Headline score uses composite, intent-weighted, multi-run, **hybrid** signals (Google AI Overview + LLM engines per Phase 8b)
2. User sees credible interval, stability flag, and score decomposition
3. Prompt sets persist across scans; trend comparison warns on prompt set changes
4. Share of voice and citation share are visible and factor into insights
5. Quality gates prevent displaying garbage scores
6. Judge is calibrated against fixture set (≥90% accuracy)
7. Every scan stores immutable, reproducible run data with `scoring_version`
8. README and landing page copy match actual methodology

---

**End of roadmap**