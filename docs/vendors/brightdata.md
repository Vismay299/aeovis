# Vendor notes — Bright Data SERP (`api.brightdata.com`)

> <!-- doc-status -->
> **Status: LIVE.** Implemented in
> [`src/lib/engines/brightdata.js`](../../src/lib/engines/brightdata.js);
> parser fixtures in
> [`src/lib/engines/brightdataParser.test.mjs`](../../src/lib/engines/brightdataParser.test.mjs).

**Date:** 2026-09-02 · **Task:** R6.3.1
**Applies to:** the Google AI Overview engine (`aio`) — the only paid engine on
the live scan path.

## Contract

| | |
|---|---|
| Credential | `BRIGHTDATA_API_KEY` (`brightdata.js:6`) |
| Zone | `BRIGHTDATA_SERP_ZONE` if set, else the first **active** SERP zone from `GET /zone/get_all_zones` |
| Request | `POST https://api.brightdata.com/request` |
| Body | `{ zone, url, format: "json", country }` |
| Search URL | `https://www.google.com/search?q=…&hl=en&gl=<geo>&brd_json=1&brd_ai_overview=2` |
| Geo | `resolveSerpGeo()` — one default, `in` ([`serpGeo.js`](../../src/lib/engines/serpGeo.js)) |
| Cost | `0.0015` per query, applied at `enginePipeline.js` |

## Response shape

The SERP payload is **wrapped**: the outer JSON carries the real payload in a
`body` field, as a *string*. `innerBody()` (`brightdata.js:112`) parses it, and
falls back to treating the object itself as the payload for legacy zone
configurations that do not wrap.

`ai_overview` arrives in more than one shape. In priority order:

1. `ai_overview.texts` — array of blocks (the shape observed in production)
2. `ai_overview.text_blocks` — fallback
3. `ai_overview.paragraphs` — fallback
4. `ai_overview.text` / `.snippet` — bare strings
5. `ai_overview` itself as a string

References arrive under **any of** `references`, `sources` or `citations`, and
an entry's URL under any of `href`, `link` or `url`. All three reference keys
are read and merged; an entry with no usable URL is dropped rather than
rendered as a blank link.

## Quirks that have cost us

- **A wrong zone fails silently.** `brightdata.js:10` short-circuits on
  `BRIGHTDATA_SERP_ZONE`, but `check-secrets.mjs` asserts only that *an* active
  SERP zone exists. A wrong zone therefore passes the health check and is then
  swallowed into a skipped result with `cost: 0.0`. Tracked as `R0.1.10`.
- **HTML instead of JSON is transient.** A proxy error page starting with `<`
  is retried once; two in a row throws.
- **Truncated AIO bodies are retried** with a backoff of `3000 × attempt × 3` —
  nine seconds on the first retry. A test fixture with an empty body pays that
  cost before asserting anything, so give mocks a realistic payload.
- **`no_ready_cookies`** is a proxy session-pool failure, not a query failure.
  It is retried, and never allowed to reach the parser as an empty answer.
- **Rate-limit and quota errors are not retried** — they throw immediately,
  because backing off into the same wall only spends wall clock.

## What is NOT measured

Cost, coverage and latency versus SerpAPI were never measured. The superseded
SerpAPI note's per-query figures describe SerpAPI only. See
[`docs/decisions/2026-08-29-serp-provider-bright-data.md`](../decisions/2026-08-29-serp-provider-bright-data.md).
