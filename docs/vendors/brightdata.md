# Vendor notes — Bright Data SERP (`api.brightdata.com`)

> <!-- doc-status -->
> **Status: LIVE.** Implemented in
> [`src/lib/engines/brightdata.js`](../../src/lib/engines/brightdata.js);
> parser fixtures in
> [`src/lib/engines/brightdataParser.test.mjs`](../../src/lib/engines/brightdataParser.test.mjs).

**Date:** 2026-09-03 · **Task:** R1.2.9 (the zone cache), R6.3.1 (the rest) · **Verified at:** `967bda6`
**Applies to:** the Google AI Overview engine (`aio`) — the only paid engine on
the live scan path.

## Contract

| | |
|---|---|
| Credential | `BRIGHTDATA_API_KEY` (`brightdata.js:137`) |
| Zone | `BRIGHTDATA_SERP_ZONE` if set (`brightdata.js:141-142`), else the first **active** SERP zone from `GET /zone/get_all_zones` (`:156`, picked at `:175-177`) — then cached **with a timestamp** (`:81`, written `:192`) and re-checked once `BRIGHTDATA_ZONE_TTL_MS` has elapsed, default 5 min (`:72`). See ["The zone cache"](#the-zone-cache-r127). |
| Request | `POST https://api.brightdata.com/request` (`brightdata.js:371`) |
| Body | `{ zone, url, format: "json", country }` (`brightdata.js:378-386`) |
| Search URL | `https://www.google.com/search?q=…&hl=en&gl=<geo>&brd_json=1&brd_ai_overview=2` (`buildGoogleSearchUrl`, `brightdata.js:250-261`) |
| Geo | `resolveSerpGeo()` — one default, `in` ([`serpGeo.js`](../../src/lib/engines/serpGeo.js)) |
| Cost | `0.0015` per query, applied in `enginePipeline.js` — grep `result.cost = 0.0015`, which matches there and in `aioPipeline.js`'s dead probe path, and nowhere else (no line: that file is being edited concurrently) |

## Response shape

The SERP payload is **wrapped**: the outer JSON carries the real payload in a
`body` field, as a *string*. It needs a **second `JSON.parse`** — skip it and the
extractors see nothing and return an empty result rather than an error. Two
functions do this, and both must keep doing it: `innerBody()`
(`brightdata.js:329-340`), which feeds the truncation check, and
`normalizeBrightDataResponse()` (`brightdata.js:215-232`), which feeds the
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
  short-circuits on `BRIGHTDATA_SERP_ZONE` (`brightdata.js:141-142`), so when that
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
  probes will actually use — grep `AUTO-DISCOVERED`. (An earlier revision cited
  `so probes will use`, which matched nothing: the real text is split across a
  template concatenation, `` `…so probes ` + `AUTO-DISCOVERED "${zone}"…` ``.)
  (Line numbers are omitted for this file on purpose; see the note in
  [`README.md`](./README.md#a-note-on-citing-check-secretsmjs).)

  The ledger item `R0.1.10` is now `done`; this paragraph said `in_verification`
  when it was written. Re-read in the ledger at `967bda6`.
- **The auto-discovered zone used to be cached forever — fixed, R1.2.7.** The old
  cache was a bare module-level string with no invalidator, so a zone suspended
  mid-run kept being used until the process restarted. It is now `{ name, at }`
  (`brightdata.js:81`), served only while it is fresh (`:145`), and dropped when
  Bright Data refuses it at probe time (`:313-327`) — **recovery is one failed
  probe, not one TTL.** The mechanism, the executed evidence, and the two things
  it does not yet prove: ["The zone cache"](#the-zone-cache-r127) below.
- **Zone classification is asymmetric across the two transports — `R1.2.10`
  (`todo`).** A snake_case wording such as `zone_suspended` is typed as a plain
  `Error` and **leaves the cache in place**. And on the not-ok path
  `zoneRejectionDetail` runs *before* the 429 retry branch (`brightdata.js:397`
  before `:399`), so an HTTP 429 whose body mentions a zone is typed
  `zone_rejected` and not retried; on the 200 path the rate-limit check comes
  first (`:435` before `:441`). Executed, not read — see the table below.
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

## The zone cache (R1.2.7)

**Corrected 2026-09-03 under R1.2.9.** Until this revision the quirk above read
*"The auto-discovered zone is cached with no way to invalidate it"*, and pinned
that claim to `brightdataZone.test.mjs:71-82`. Both halves were a true reading of
the pre-R1.2.7 code and both are false of what ships. Neither was found by a
guard: R1.2.7's implementer listed both this file and the `check:secrets` wording
in the ledger note on their own task, as work they were not allowed to do, which
is why R1.2.9 exists at all.

The citation is worth dwelling on, because it is the argument in
["The R6.5.6 drift"](./README.md#the-r656-drift-and-the-guard-that-was-not-built)
made concrete rather than measured on a prototype. `:71-82` still **resolves** —
that file is 386 lines — but it no longer points at a cache test at all. It now
lands inside *"the configured zone short-circuits the lookup"*
(`brightdataZone.test.mjs:66-82`), a test about `BRIGHTDATA_SERP_ZONE`. An
existence check would be green on it, and a content check would have been written
against the deleted assertion. Only re-derivation catches this.

### What ships

Three levers, deliberately **combined** rather than chosen between; the policy is
stated in the source at `brightdata.js:37-72`.

| Lever | Where | What it bounds |
|---|---|---|
| TTL over a `{ name, at }` entry | `brightdata.js:81`, read `:145`, written `:192` | staleness by the clock, needing no cooperation from any caller |
| `invalidateBrightDataZoneCache()` | `brightdata.js:116-124` | staleness on a caller's own schedule |
| Probe-time rejection | `zoneRejectionDetail` `:291-303` then `zoneRejectedError` `:313-327` | staleness the moment Bright Data itself says the zone is gone |

- The cache is **`{ name, at }`, never a bare string** (`brightdata.js:81`). A name
  with no age attached cannot be expired, which is exactly how the old one went
  stale invisibly. `peekBrightDataZoneCache()` (`:132-134`) reads it without
  touching it, returning `{ name, ageMs }` or `null`.
- The default TTL is **five minutes** — `DEFAULT_BRIGHTDATA_ZONE_TTL_MS`
  (`brightdata.js:72`) — overridable with `BRIGHTDATA_ZONE_TTL_MS`
  (`brightDataZoneTtlMs`, `:91-103`).
- **`0` means never cache.** A **malformed value throws** a `BrightDataZoneError`
  with `reason: "bad_ttl_config"` rather than falling back to the default,
  because a silent fallback would tell an operator who wrote `30s` that they had
  a 30-second re-check while a dead zone lived on for five minutes.
- **`invalidateBrightDataZoneCache()` returns the name it dropped, or `null`**
  when nothing was cached (`brightdata.js:116-124`). A cleared cache and an
  already-empty one are different events, and a caller counting invalidations has
  to be able to tell them apart.
- A refusal is read from **both** transports: the HTTP error body
  (`brightdata.js:397-398`) and the **HTTP 200 envelope** (`:441-447`). Either one
  drops the cache, raises a typed `BrightDataZoneError` with
  `reason: "zone_rejected"`, and is **refused a retry** (`:478`) — retrying a zone
  the account has already refused only spends the attempt budget for the same
  answer. **Recovery is one failed probe, not one TTL.**
- The row still **errors and is still counted**. A rejected probe must never
  become a skip with `cost: 0.0`; that is the R0.1.10 failure, and
  `brightdataZone.test.mjs:334-378` holds it at `errored_queries: 1`,
  `error_rate_pct: 100`.
- A re-check that cannot be **completed** — `get_all_zones` itself failing —
  throws `reason: "lookup_failed"` and **does not refresh the timestamp**
  (`brightdata.js:160-172`). This is deliberate. The rejected alternative was a
  grace window that keeps serving the stale name through a control-plane outage,
  which would hide a dead zone for as long as the control plane stayed
  unreachable. What it produces instead is loud, counted error rows.
- With the TTL expired and **no API key** available to re-verify with, the stale
  name is dropped and `null` returned rather than served (`brightdata.js:149-154`).
  A name that can no longer be re-verified is not an answer.

### Executed, not read

Driven at `967bda6` against a stubbed `fetch`. **No live vendor call was made.**

| Scenario | Result |
|---|---|
| HTTP 200 envelope, `{"error":"zone not found: …"}` | `BrightDataZoneError` / `zone_rejected`; cache dropped to `null`; 1 SERP call |
| HTTP 200 envelope, `{"status":"error","message":"unknown zone …"}` | same |
| HTTP 400, `{"error":"zone_suspended"}` | plain `Error`; **cache retained** — the `R1.2.10` false negative |
| HTTP 429, `{"error":"zone disabled: quota exceeded"}` | `zone_rejected`, not retried — the `R1.2.10` precedence asymmetry |
| HTTP 200 envelope, `{"error":"rate limit hit, unknown zone"}` | rate-limit `Error`; cache retained — precedence runs the other way on this path (`brightdata.js:435` before `:441`) |
| `BRIGHTDATA_ZONE_TTL_MS` unset, or empty | `300000` |
| `"0"` / `"40"` | `0` / `40` |
| `"30s"` / `"-1"` / `"1.5"` | throws, `reason: "bad_ttl_config"` |
| TTL `40`, a real 60 ms wait, then `get_all_zones` returns HTTP 503 | throws `lookup_failed`; the entry **survives** at `ageMs 71`; the very next resolve re-lists immediately rather than buying another TTL |
| a stale entry, then `resolveBrightDataSerpZone(null)` | entry invalidated, `null` returned |

The suite's own pins, all of which resolve at `967bda6`:
`brightdataZone.test.mjs:101-165` (cached within the TTL, re-checked once it
expires — the old assertions kept verbatim as the within-TTL half rather than
deleted), `:167-196` (the TTL as a wall clock, not just the `0` special case),
`:198-230` (the invalidator, including the `null` return), `:232-247` (the
malformed TTL), `:249-300` (probe-time rejection, then self-heal to the new zone
without a restart), `:302-332` (a typed zone error is never retried even when its
text mentions a 5xx), `:334-378` (a rejected probe is an **error row**, never a
`cost: 0.0` skip).

### Two things this does not yet prove

1. **`invalidateBrightDataZoneCache()` has no production consumer.** Swept at
   `967bda6` for the symbol across `src`, `scripts`, `worker` and `supabase`:
   outside `brightdata.js` itself the only callers are
   `src/lib/engines/brightdataZone.test.mjs` and
   `src/lib/checkSecretsBrightdataNoZone.test.mjs` — both tests. The fleet that
   would call it once per poll cycle is not built: `probeBatch` in
   `worker/src/lib/probe.js:28` still throws "no adapter is built yet (R1.3)",
   and `R1.3.1` through `R1.3.5` are all `todo`. **The TTL, not the invalidator,
   is what satisfies R1.2.7's accept today.**
2. **The 200-envelope branch works but nothing pins it.** Both zone-rejection
   tests drive `ok: false`, so deleting `brightdata.js:444-445` leaves the suite
   fully green. The branch was proven by hand — rows 1 and 2 of the table above —
   and is unprotected against the next editor. Filed as `R1.2.10` (`todo`),
   together with the two classifier asymmetries.

### Which process actually holds this cache

**Not the worker container, and an earlier revision of this file said it was.**
`worker/` cannot import `src/` at all — `src/lib/workerIsolation.test.mjs:72`
fails any relative import that climbs out of `worker/` — and a sweep of
`worker/src` for `brightdata` and `engines/` returns nothing.

The live holder is the Next.js process. `POST /api/scan`
(`src/app/api/scan/route.js:62`) and the daily cron `/api/scan/worker`
(`vercel.json:4`, route at `src/app/api/scan/worker/route.js:60,94`) both call
`runScanChunk`, which resolves engines through `enginePipeline.js` (grep
`resolveEnabledEngines`), whose `aio` entry (grep `probe: probeAio`, which matches
only that file) calls `brightDataSearch` (grep `brightDataSearch(query.text` — two
hits, this one and `aioPipeline.js`'s dead probe path, below) and therefore
`resolveBrightDataSerpZone`. `ENGINES` defaults to `"aio"` and that engine's
`isConfigured` is `() => true`, so this is the default path, not an opt-in one.

**`src/lib/scoring/aioPipeline.js:99` is the other importer of `brightDataSearch`,
and it is dead.** Its only caller is `probeQueryOnce` (`:73`), whose only caller is
`runAioScan` (`:171`), which nothing under `src`, `scripts` or `worker` calls. What
is live in that module is its pure summarizers, `summarizeAioResults` and
`aggregateAioTopDomains`. Existence is not liveness in either direction — Rule 2
of [`README.md`](./README.md).

### What `check:secrets` now tells the operator

`npm run check:secrets` used to end its Bright Data `PASS` line with "and will
cache it for the process lifetime". Corrected under R1.2.9. Executed at `967bda6`
with a stubbed `fetch` and a one-zone account, the line now reads:

    1 active serp zone(s); no BRIGHTDATA_SERP_ZONE set, so probes AUTO-DISCOVERED "serp_api1" and will cache it for BRIGHTDATA_ZONE_TTL_MS (default 5 min) before re-checking it

It names the **variable** rather than the resolved number on purpose:
`brightDataZoneTtlMs()` throws on a malformed value, and reading the number there
would put that call outside the entry's local `try`/`catch`, so a TTL typo would
surface as a bare `err.message` on the `brightdata` row instead of a zone verdict.
The comment above that string carries the same correction. (Line numbers are
omitted for this file on purpose; see
[`README.md`](./README.md#a-note-on-citing-check-secretsmjs).)

---

*Revised 2026-09-03 under R1.2.9, over the R6.3.1 revision of the same date. Every
`file:line` above was re-derived at `967bda6` from `git show HEAD:<file>` rather
than from the working tree, which several concurrent tasks had dirty — Rule 4 of
[`README.md`](./README.md). The behaviour in "Executed, not read" was produced by
driving `resolveBrightDataSerpZone`, `brightDataZoneTtlMs` and `brightDataSearch`
against a stubbed `fetch`, and the `check:secrets` line by calling that vendor
entry's own `check()` the same way. The scripts were throwaway and were not kept,
for the reason given at the end of `README.md`.*

*`scripts/check-secrets.mjs`, `src/lib/workers/scanWorker.js` and
`src/lib/scoring/enginePipeline.js` are cited by name and greppable string rather
than by line, because concurrent tasks are editing all three as this is written —
see [the note in `README.md`](./README.md#a-note-on-citing-check-secretsmjs). Every
other file cited here is pinned by line and was read at `967bda6`.*

*[`README.md`](./README.md) cites this file at `brightdata.md:62`,
`brightdata.md:63-64`, `brightdata.md:65`, `brightdata.md:97` and
`brightdata.md:101`. All five still resolve, and were re-read after the last edit
here. That was a constraint on this revision, not a coincidence: every correction
above line 72 was made **in place**, at identical line counts, the quirk list was
rewritten at its original length, and every new section was appended after
`brightdata.md:101`. The constraint was accepted deliberately — R1.2.9 may not
edit `README.md`, and moving a citation it is not allowed to repair would be the
same defect this revision exists to remove. **If a later task rewrites this file
without that constraint, those five citations in `README.md` must move with it.***
