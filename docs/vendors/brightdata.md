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
| Zone | `BRIGHTDATA_SERP_ZONE` if set, else the first **active** SERP zone from `GET /zone/get_all_zones` — **and then cached for the life of the process** (`brightdata.js:4,13,33`) |
| Request | `POST https://api.brightdata.com/request` |
| Body | `{ zone, url, format: "json", country }` |
| Search URL | `https://www.google.com/search?q=…&hl=en&gl=<geo>&brd_json=1&brd_ai_overview=2` |
| Geo | `resolveSerpGeo()` — one default, `in` ([`serpGeo.js`](../../src/lib/engines/serpGeo.js)) |
| Cost | `0.0015` per query, applied at `enginePipeline.js` |

## Response shape

The SERP payload is **wrapped**: the outer JSON carries the real payload in a
`body` field, as a *string*. It needs a **second `JSON.parse`** — skip it and the
extractors see nothing and return an empty result rather than an error. Two
functions do this, and both must keep doing it: `innerBody()`
(`brightdata.js:112-123`), which feeds the truncation check, and
`normalizeBrightDataResponse()` (`brightdata.js:48-65`), which feeds the
extractors. Both fall back to treating the object itself as the payload for
legacy zone configurations that do not wrap, so the code is shape-tolerant —
which is also why a regression here is silent rather than loud.

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

- **A wrong zone used to fail silently — fixed, R0.1.10.** `resolveBrightDataSerpZone`
  short-circuits on `BRIGHTDATA_SERP_ZONE` (`brightdata.js:11-12`), so when that
  variable is set it is the *only* zone any probe uses. `check-secrets.mjs` used to
  assert merely that *an* active SERP zone existed on the account, so a typo'd zone
  reported `PASS` and the failure then arrived per-query as a `cost: 0.0` error row
  on all thirty prompts.

  **This no longer reproduces.** The `brightdata` entry in `scripts/check-secrets.mjs`
  now resolves the zone the way the client does and asserts *that* zone. A configured
  zone missing from the account returns `FAIL` naming it and listing the active SERP
  zones — grep `does not exist on this account`. A zone that exists but is not
  `type=serp status=active` returns `FAIL` naming its real type and status — grep
  `not an active serp zone`. With no zone configured, the `PASS` line names the zone
  probes will actually use — grep `so probes will use`. (Line numbers are omitted for
  this file on purpose; see the note in [`README.md`](./README.md#a-note-on-citing-check-secretsmjs).)

  The ledger item `R0.1.10` is `in_verification`, not yet closed — the code is what is being
  verified, not the claim above.
- **The auto-discovered zone is cached with no way to invalidate it.**
  `cachedZoneName` is module-level (`brightdata.js:4`), read before the API is asked
  (`:13`), written on first success (`:33`), and **never cleared** — the module
  exports no invalidator. Reproduced here: with `BRIGHTDATA_SERP_ZONE` unset, two
  calls to `resolveBrightDataSerpZone()` with the zone flipped from `active` to
  `suspended` in between both returned `serp_api1`, from a single
  `get_all_zones` fetch.

  In a request-scoped Vercel function that is a fair optimisation. In the long-lived
  worker shipped by R1.2.1 (`worker/src/index.js`) it means a zone that dies mid-run
  keeps being used until the process restarts, and `check:secrets` — a separate
  process — will keep reporting the truth while the worker acts on a stale answer.
  Pinned by `src/lib/engines/brightdataZone.test.mjs:71-82`; filed as `R1.2.7`
  (`todo`).
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

---

*Revised 2026-09-03 under R6.3.1. The zone-cache behaviour was reproduced by
executing `resolveBrightDataSerpZone` against a stubbed `fetch`; the R0.1.10
fix was read in `scripts/check-secrets.mjs`. Every `file:line` above was
asserted to contain the code it describes. `scripts/check-secrets.mjs` is cited by vendor-entry name and
greppable string rather than by line, because a concurrent task is rewriting it
and its line numbers drifted three times during this revision — see
[the note in `README.md`](./README.md#a-note-on-citing-check-secretsmjs).*
