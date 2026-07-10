# AnswerRank — Product Requirements

## Problem statement
The original AEO scoring app produced 0% visibility for every brand because:
1. The BrightData AI-Overview parser was reading the wrong JSON path (`text`/`text_blocks`) while BrightData actually returns `ai_overview.texts` with nested list/paragraph blocks and `ai_overview.references` (using `href`).
2. The scoring pipeline blended four LLM engines (Gemini, OpenAI, Perplexity, Google AIO) with intent weights, sentiment multipliers, Bayesian intervals, multi-run stddev — noise upon noise.
3. Branded queries (searches for the brand's own name) were inflating headline visibility.
4. When the SERP data source errored out, the app happily returned a false 0%.

The user needs a lean, credible AIO-only visibility tracker before Sunday's VC pitch.

## Locked spec (Feb 10, 2026)
1. **Single source of truth** — Google AI Overview only, fetched via BrightData SERP API. No LLM probing.
2. **Real Google queries** — Seed the query set from People-Also-Ask + Autocomplete using
   category terms derived from the brand's website (not from ChatGPT-style hypothetical prompts).
3. **Simple scoring** — Visibility = % of non-branded queries with an AIO where the brand is either mentioned in the AIO text OR its domain is cited in the references.
4. **Branded-query guardrail** — Queries containing the brand name are excluded from the headline score. They are tracked separately in a "Brand Presence" panel.
5. **Fail loudly** — If BrightData errors on more than 50% of queries or Google returns an AIO for fewer than 30% of non-branded queries, the scan is flagged as a "data source issue" and no score is shown.
6. **Store evidence** — The full AIO text and citations for every tracked query are stored and displayed per row so the user can verify claims.

## User personas
- **Founder / marketer** — Wants to know if their brand shows up in Google AI Overviews and what to do about it.
- **VC / investor** — Evaluating the founder's demo; needs numbers to be defensible.
- **Competitor analyst** — Wants to see who Google is recommending in their category and whether they can displace them.

## Architecture (Feb 10, 2026)
```
Next.js 14 App Router
├── src/app/api/scan/route.js               # POST /api/scan — creates job, launches async worker
├── src/app/api/scan/[job_id]/status/route.js  # GET status + full run_record (no-cache)
├── src/lib/workers/scanWorker.js           # AIO-only scan pipeline entry point
├── src/lib/scoring/aioPipeline.js          # Probe each query via BrightData AIO + score
├── src/lib/scoring/aioPrompts.js           # Category seeds -> PAA + Autocomplete
├── src/lib/engines/brightdata.js           # BrightData SERP client + AIO extractor (FIXED)
├── src/lib/scoring/aliases.js              # Brand alias detection (branded-query guardrail)
├── src/lib/scoring/citations.js            # Domain normalisation & classification
├── src/services/api.js                     # Frontend normalizeResult / runScan
└── src/components/dashboard/
    ├── KpiCard.jsx                         # Hero score + KPI cards
    ├── AioEvidence.jsx                     # Per-query AIO text + citations viewer (NEW)
    ├── CompetitorTable.jsx                 # AIO share per competitor
    ├── CitationsPanel.jsx                  # Top cited domains
    └── ...
```

Key data model (per query result):
```
{
  prompt, is_branded_query, aio_present,
  aio_text, aio_citations, aio_references,
  brand_mentioned_in_text, brand_cited, visible,
  competitors_found_in_text, competitors_cited,
  source, error
}
```

Summary stats returned per scan:
```
{
  visibility_pct, mention_rate_pct, citation_share_pct,
  branded_visibility_pct, aio_coverage_pct, error_rate_pct,
  data_source_issue, insufficient_sample,
  non_branded_queries, branded_queries, queries_with_aio, ...
}
```

## Third-party integrations
- **BrightData SERP** (required) — Google AI Overview + PAA. API key in `.env.local`.
- **Gemini** — Used only to derive short category seed keywords from the brand's website scrape.
- **Firecrawl** — Used only to fetch the website snippet for seed generation.
- **Supabase** — Persists `scan_jobs`, `scans`, `brand_prompts`, `content_events`. Falls back to in-memory when unavailable.

## Completed (Feb 10, 2026)
- [x] Fix BrightData AIO parser (`ai_overview.texts` array, `href` in references)
- [x] Simplify scan worker to AIO-only (no Gemini/OpenAI/Perplexity probing)
- [x] Query sourcing from PAA + Autocomplete seeded by category terms
- [x] Simple visibility scoring (% of non-branded queries with visible AIO)
- [x] Branded-query guardrail (`is_branded_query` flag + separate Brand Presence panel)
- [x] Fail loudly (data-source issue banner when errors > 50% or coverage < 30%)
- [x] Store AIO text + citations per query and display in expandable evidence rows
- [x] Dashboard refactor with new KPI layout (Visibility, AIO Coverage, Brand Presence, Queries, Competitors)
- [x] Retries + concurrency tuning for BrightData resilience
- [x] Live smoke-test scan on Wrike → 30% visibility, 54.5% coverage, competitors correctly identified

## Backlog
- [ ] P1 — Persist branded queries as their own DB rows (currently persisted as exploratory)
- [ ] P1 — Small-sample warning when fewer than 5 non-branded queries return AIOs
- [ ] P2 — "Content lift" panel (compare visibility before/after publishing new content)
- [ ] P2 — Open-denominator Share-of-Voice against every entity found in AIOs, not just tracked competitors
- [ ] P2 — Export the current scan as a PDF report

## Preview
- App runs on Next.js on `http://localhost:3000` (supervised by `nextjs` program).
- A `socat` proxy on port 8001 forwards all traffic to `3000` so the ingress `/api` routing works.
