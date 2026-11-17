# Prompt-Set Contract & Multi-Engine Scoring — Implementation Plan

> <!-- doc-status -->
> **Status: HISTORICAL.** A record of work done at the time, not an authority for current decisions. It predates the 2026-08-29 honesty audit, so any claim it makes about what is finished must be checked against [docs/BUILD_JOURNAL.md](../BUILD_JOURNAL.md) and [2026-08-29-rebuild-roadmap.md](./2026-08-29-rebuild-roadmap.md).

**Date:** 2026-07-20
**Problem:** Prompt sets silently change between scans, destroying score comparability — the core value of the product ("track the same prompts over time"). Multi-engine (v9) scoring is half-integrated: the index exists but counts distort and weights are hardcoded.

## Locked product decisions (from design session)

1. **Prompt sets are keyed by domain** (e.g. `sleepyowl.co`), not the typed brand name. Brand name is display-only.
2. **Fail-loud:** if the saved prompt set can't be loaded at scan start, the scan FAILS with a clear error. Never silently regenerate.
3. **Headline = weighted mean of per-engine share-of-AI** (50/50 AIO/Perplexity today), weights in config — changeable without rework.
4. **Prompt edits → marker on the trend chart** ("prompt list changed here"). No dual shared-subset UI.
5. **Sets are frozen + versioned by hash:** scans consume the active set, never mutate it (already true for reuse path; generation only for onboarding/top-up).
6. **Tier upgrades are additive-only:** raising the target appends new prompts, never regenerates. Prompt count = plan limit = billing lever.

## Why prompts currently change between runs (diagnosed)

| # | Leak | Fix |
|---|------|-----|
| 1 | Prompt pool keyed by exact typed brand string (`.eq("brand", brand)`) — "Sleepy Owl" ≠ "sleepy owl coffee" | Domain-first `resolveBrandKey()` |
| 2 | DB fetch failure returns `[]` → worker regenerates 30 fresh prompts silently | Strict fetch (throw ≠ empty) + fail the scan |
| 3 | `slice(0, 30)` over `created_at`-ordered rows; batch inserts share timestamps → tie order unstable | Secondary `id` sort key |
| 4 | Queries-tab edits hit a possibly-different pool than scans read | Same brand key everywhere |

## Already built (no work needed)

- Multi-engine pipeline (`enginePipeline.js`): per-engine summaries, eligibility gates, equal-weight index
- `ENGINES=aio,perplexity` active; Perplexity probe already sends India geo (`user_location: IN`)
- `insertScan` persists `engines`, `visibility_index_pct`, `engines_counted` in raw_results
- Dashboard hero already prefers `visibilityIndexPct` for multi-engine; ScoreBand engine chips; AnswersView engine filters
- `prompt_set_hash`/`prompt_set_id` computed + stored per scan (unbranded set only)
- Dashboard already computes `deltaSamePromptSet`

## Implementation

### Phase 1 — Identity & stability (the contract)

1. **`src/shared/scoring/brandKey.js`** — `resolveBrandKey(brand, url)`:
   domain of `url` (via `extractBrandDomain`, strips www/protocol, lowercased) if present, else `brand.trim().toLowerCase()`. Pure, shared client+server. Tests.
2. **`src/server/db/prompts.js`**:
   - `getPromptsForBrand(key, includeDisabled, { strict })` — strict mode throws on DB error instead of returning `[]` (callers must distinguish "no set yet" from "couldn't load").
   - Order: `created_at ASC, id ASC` (deterministic slice).
3. **`scanWorker.sourceUnbrandedQueries`**:
   - Read/write prompts under `resolveBrandKey(brand, url)`.
   - **Legacy migration:** if key-pool is empty, read pool under raw brand name; if found, re-upsert under key (one-time re-home, keeps enabled/weight).
   - **Fail-loud:** strict fetch; on DB error → throw `"Couldn't load your tracked prompts — scan aborted to protect score comparability. Please retry."` Generation runs ONLY when the pool is genuinely empty (onboarding) or short of target (additive top-up).
   - `UNBRANDED_TARGET` → `resolvePromptTarget()`: `PROMPT_TARGET` env override, default 30. Raising it = additive expansion (existing top-up already appends + persists delta).
4. **`/api/brands/[brand]/prompts` + QueryManager:** client passes `resolveBrandKey(brand, website)` via `?key=` (or as the path param) so the Queries tab edits the exact pool scans consume.

### Phase 2 — Scoring contract

5. **`enginePipeline.js`**: `ENGINE_WEIGHTS = { aio: 1, chatgpt: 1, perplexity: 1 }` (relative weights; renormalized over eligible engines). `computeHeadline` uses weighted mean. Env override optional later.
6. **`normalizeResult` multi-engine counts** (rows = prompts × engines):
   - Prompt-denominated fields count **unique prompts**: `promptsAnalyzed`, `queriesTracked`, `brandedPromptsCount`, `brandPresencePromptsCount`.
   - Brand-presence KPIs in multi-engine mode use "answered/visible on ≥1 engine" semantics.
   - `generateSummary` gets a multi-engine variant naming both engines.
7. **Trend marker:** dashboard shows a small "prompt list changed" annotation when previous scan's `prompt_set_id` differs from current (data already available via `deltaSamePromptSet` groundwork).

### Phase 3 — Verification

- New tests: `brandKey.test.mjs`, sourcing fail-loud (dependency-injected), weight math in `enginePipeline.test.mjs`, multi-engine counts in `api.test.mjs`.
- `npm run test:scoring` green, `npm run build` green.

## Out of scope (explicitly deferred)

- `prompt_sets` DB table with formal version rows (hash-based versioning suffices for now)
- Billing/plan enforcement UI for prompt limits (PROMPT_TARGET is the mechanism; pricing UI later)
- Scan-history keying by domain (`/api/scans/[brand]` stays name-based with ilike)
- Real-query grounding of prompt generation (PAA/keyword-DB seeding — separate initiative)
