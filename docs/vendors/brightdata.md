# Vendor notes — Bright Data SERP (`api.brightdata.com`)

> <!-- doc-status -->
> **Status: LIVE.** Implemented in
> [`src/shared/engines/brightdata.js`](../../src/shared/engines/brightdata.js);
> parser fixtures in
> [`src/shared/engines/brightdataParser.test.mjs`](../../src/shared/engines/brightdataParser.test.mjs).

**Date:** 2026-09-04 · **Task:** R1.2.9 (the zone cache), R6.3.1 (the rest) · **Verified at:** `bf332fe`
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
| Geo | `resolveSerpGeo()` — one default, `in` ([`serpGeo.js`](../../src/shared/engines/serpGeo.js)) |
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

**This section was itself rejected once, on 2026-09-04, and corrected.** Every
individual `file:line` in it resolved and landed on the code described; what was
false was a claim *composed* from two true ones — that `aioPipeline.js:99` was
"the other" importer of `brightDataSearch`, when there is a third and it is live.
The correction is in
["The three non-test importers"](#the-three-non-test-importers-of-brightdatasearch)
below. It is left visible rather than quietly overwritten, because a section that
bolds *"existence is not liveness in either direction"* and then under-counts the
live consumers is the most useful worked example this file has.

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
- **`0` means "re-check on every resolve"** — the source's own wording
  (`brightdata.js:69-70`), and **not** the same as "never cache", which is what an
  earlier revision of this line said after dropping the parenthetical. The entry
  is still **written**: `brightdata.js:192` assigns `cachedZone` unconditionally,
  and what `0` changes is only the freshness test at `:145`, which can then never
  pass. Executed with `BRIGHTDATA_ZONE_TTL_MS=0` and a stubbed `fetch`:
  `peekBrightDataZoneCache()` returns `{ name: "serp_api1", ageMs: 0 }`
  immediately after a resolve, and two resolves make two `get_all_zones` calls.
  The distinction matters to anyone reading `peek` for diagnostics — under TTL 0
  a live entry is exactly what they will see.
- A **malformed TTL throws** a `BrightDataZoneError`
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

Driven against a stubbed `fetch`. **No live vendor call was made.**

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

The suite's own pins, all of which resolve at `bf332fe`:
`brightdataZone.test.mjs:101-165` (cached within the TTL, re-checked once it
expires — the old assertions kept verbatim as the within-TTL half rather than
deleted), `:167-196` (the TTL as a wall clock, not just the `0` special case),
`:198-230` (the invalidator, including the `null` return), `:232-247` (the
malformed TTL), `:249-300` (probe-time rejection, then self-heal to the new zone
without a restart), `:302-332` (a typed zone error is never retried even when its
text mentions a 5xx), `:334-378` (a rejected probe is an **error row**, never a
`cost: 0.0` skip).

### Two things this does not yet prove

1. **`invalidateBrightDataZoneCache()` has no production consumer.** Swept for
   the symbol across `src`, `scripts`, `worker` and `supabase`. Outside
   `brightdata.js` itself it appears in three files, and **exactly one of them
   calls it**: `src/shared/engines/brightdataZone.test.mjs` (`:206`, `:218`, `:223`,
   `:253`), a test. The other two only *mention* it in prose —
   `src/server/checkSecretsBrightdataNoZone.test.mjs:21`, in the file comment
   explaining why that file stays split from `checkSecretsBrightdata.test.mjs`,
   and `scripts/check-secrets.mjs`, in the comment above the `PASS` string.
   An earlier revision of this list counted the first of those as a caller:
   grepping a symbol finds mentions, and **a mention is not a call site**. The
   conclusion is unaffected and the correction narrows it — no production
   consumer, and one test consumer rather than two. The fleet that
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
`worker/` cannot import `src/` at all — `src/server/workerIsolation.test.mjs:72`
fails any relative import that climbs out of `worker/` — and a sweep of
`worker/src` for `brightdata` and `engines/` returns nothing.

The live holder is the Next.js process, and **two phases of a scan can touch this
cache**: prompt sourcing (conditionally — see below), and then probing, on every
scan. `POST /api/scan`
(`src/app/api/scan/route.js:62`) and the daily cron `/api/scan/worker`
(`vercel.json:4`; that route is cited by anchor, grep `runScanChunk(directJobId)`
and `[cron-worker] Error resuming job`, one hit each) both call `runScanChunk`.

#### The three non-test importers of `brightDataSearch`

Swept across `src`, `scripts`, `worker` and `supabase` for files that **import**
the symbol, not merely mention it. There are five importers besides
`brightdata.js` itself; **three are non-test**, and the other two are
`brightdataZone.test.mjs:6` and `serpGeo.test.mjs:5`.

| Importer | Call site | Live? |
|---|---|---|
| `src/shared/scoring/enginePipeline.js:1` | in `probeAio` — grep `brightDataSearch(query.text` | **live** — the probing phase, every scan |
| `src/shared/engines/serp.js:5` | `:325`, in `fetchPeopleAlsoAsk` | **live** — the sourcing phase, conditionally |
| ” | `:286`, in `probeGoogleAiOverviewBrightData` | dead |
| `src/shared/scoring/aioPipeline.js:1` | `:99`, in `probeQueryOnce` | dead |

**Probing — live.** `runScanChunk` resolves engines through `enginePipeline.js`
(grep `resolveEnabledEngines`), whose `aio` entry (grep `probe: probeAio`, one hit
repo-wide) calls `brightDataSearch` (grep `brightDataSearch(query.text` — two
hits, this one inside `probeAio` and `aioPipeline.js:99`'s dead path) and
therefore `resolveBrightDataSerpZone`, via `getBrightDataConfig`
(`brightdata.js:356` → `:209`). `ENGINES` defaults to `"aio"` and that engine's
`isConfigured` is `() => true`, so this is the default path, not an opt-in one.
(`enginePipeline.js` is cited by anchor, not by line: it moved during this
revision.)

**Sourcing — also live, and an earlier revision of this section missed it.** That
revision called `aioPipeline.js:99` "*the other* importer of `brightDataSearch`".
Both of its endpoints were individually true; the exhaustiveness gate in "the
other" was false. The chain, with the volatile file cited by anchor:

    api/scan/route.js:62 → runScanChunk → runSourcingPhase → sourceUnbrandedQueries
      (all three in scanWorker.js — grep `deps.sourceUnbrandedQueries`,
       `deps.generateUnbrandedPrompts`)
      → generateUnbrandedPrompts → promptGen.js:129 `paaFn`
      → serp.js:312 fetchPeopleAlsoAsk → :325 brightDataSearch
      → getBrightDataConfig → resolveBrightDataSerpZone

`serp.js:14` makes `brightdata` the SERP provider whenever `BRIGHTDATA_API_KEY` is
set, with no `SERP_PROVIDER` needed — the same default-path argument made for
`aio` just above.

**But not on every scan.** A draft of this correction said "every scan"; that is
also wrong. `sourceUnbrandedQueries` returns early when the stored prompt pool
already meets the target (grep `if (existing.length >= target)`), so a repeat scan
of a brand whose frozen set is full never reaches `paaFn` and never touches this
cache. Sourcing touches it on the **first** scan for a brand key, and on any later
scan whose pool is short of the target.

**Within `serp.js`, one of the two call sites is dead.** `:286` sits in
`probeGoogleAiOverviewBrightData`, which is reachable only from
`probeGoogleAiOverview` (declared `:158`, dispatching at `:166`) — and
`probeGoogleAiOverview` has **no non-test caller**: outside `serp.js` the only
hits are `serp.test.mjs` and `serpGeo.test.mjs`. `:325` is the live one.

**`aioPipeline.js:99` is dead**, as previously stated. Its only caller is
`probeQueryOnce` (`:73`), whose only caller is `runAioScan` (declared `:171`,
calling at `:177`), which nothing under `src`, `scripts` or `worker` calls. What
is live in that module is its pure summarizers, `summarizeAioResults` and
`aggregateAioTopDomains`, imported by `scanWorker.js` (grep
`from "../scoring/aioPipeline.js"`). Existence is not liveness in either
direction — Rule 2 of [`README.md`](./README.md).

#### The sourcing path swallows a `zone_rejected` — twice

This is why the omission above mattered rather than being bookkeeping: **of the
three importers, the one that was missed is the one that fail-softs.** Probing
turns a rejected zone into a counted error row — `brightdataZone.test.mjs:334-378`
holds it at `errored_queries: 1`, `error_rate_pct: 100`. Sourcing turns it into
nothing.

Executed against a stubbed `fetch`, with the zone refused by an HTTP 200 envelope.
**No live vendor call was made.**

| Driven | Result |
|---|---|
| `brightDataSearch` directly | throws `BrightDataZoneError`, `reason: "zone_rejected"`; cache dropped to `null` |
| `fetchPeopleAlsoAsk` around it | **returns `[]` and does not throw**; 1 SERP call; cache still `null`; one `console.warn` is the only trace from `serp.js` |
| `generateUnbrandedPrompts` around that | **no throw**; a full 30-prompt set; two `[serp] PAA fetch failed` warns |
| same, but with the typed error reaching `promptGen` itself | **no throw, and no log line at all** |

Two catches do this, and the outer one is the worse of them:

- `serp.js:352-354` catches per seed term and logs `[serp] PAA fetch failed for
  term "…"`. A typed `BrightDataZoneError` is not distinguished from a timeout.
- `promptGen.js:222-224` is a **bare `catch {}`** — comment `// best-effort per
  term` — around the `paaFn(term)` / `autoFn(term)` race at `:212`. It emits
  nothing, which is why the last row above is silent. The `console.warn` at
  `promptGen.js:266-268` belongs to the *conditional* realism-blend call at
  `:264`, which runs only when the LLM came up short of `count` (`:259`). In both
  runs above the LLM met the count, so that warn never fired.

So a dead or suspended zone during sourcing degrades to "PAA found nothing". The
prompt set is still produced — from the LLM alone, with its Google grounding
silently missing — the scan reports success, and nothing in the scan record says
the seeding was refused. The engine's own `[brightdata] SERP zone cache
invalidated` line (`brightdata.js:120-122`) is the only evidence, and a log line
is not a counted failure.

**This is recorded, not fixed.** The fail-soft is pre-existing — it predates
R1.2.7 and is not a consequence of the zone cache — and `serp.js` and
`promptGen.js` are outside R1.2.9's file boundary. It is filed as its own task.
What R1.2.9 owed here was an accurate enumeration, and the table above is the
correction.

### What `check:secrets` now tells the operator

`npm run check:secrets` used to end its Bright Data `PASS` line with "and will
cache it for the process lifetime". Corrected under R1.2.9. Executed with a
stubbed `fetch` and a one-zone account, the line now reads:

    1 active serp zone(s); no BRIGHTDATA_SERP_ZONE set, so probes AUTO-DISCOVERED "serp_api1" and will cache it for BRIGHTDATA_ZONE_TTL_MS (default 5 min) before re-checking it

It names the **variable** rather than the resolved number on purpose:
`brightDataZoneTtlMs()` throws on a malformed value, and reading the number there
would put that call outside the entry's local `try`/`catch`, so a TTL typo would
surface as a bare `err.message` on the `brightdata` row instead of a zone verdict.
The comment above that string carries the same correction. (Line numbers are
omitted for this file on purpose; see
[`README.md`](./README.md#a-note-on-citing-check-secretsmjs).)

---

*Revised 2026-09-04 under R1.2.9 (second round), over its own 2026-09-03 revision
and the R6.3.1 revision before that. Every `file:line` above was re-derived from
`git show HEAD:<file>` rather than from the working tree, which several concurrent
tasks had dirty — Rule 4 of [`README.md`](./README.md). The behaviour in "Executed,
not read" and in the fail-soft table was produced by driving
`resolveBrightDataSerpZone`, `brightDataZoneTtlMs`, `brightDataSearch`,
`peekBrightDataZoneCache`, `fetchPeopleAlsoAsk` and `generateUnbrandedPrompts`
against a stubbed `fetch`, and the `check:secrets` line by calling that vendor
entry's own `check()` the same way. The scripts were throwaway and were not kept,
for the reason given at the end of `README.md`.*

*`HEAD` moved twice during this revision (`d845e97` → `bf332fe`), which is why the
stamp above is a commit and not a date alone. Between the first revision's
`967bda6` and `bf332fe`, every file cited here **by line** is byte-identical
except `src/shared/scoring/promptGen.js`, which is newly cited in this round and was
read at `bf332fe`; the rest carry forward by blob identity, checked with
`git rev-parse <commit>:<file>` rather than assumed.*

*One citation did drift and is repaired here. The first revision cited the cron
route at `src/app/api/scan/worker/route.js:60,94`; R3.1.3 rewrote that file, and
at `bf332fe` those lines are a doc comment and an unrelated helper while the two
`runScanChunk` calls have moved to `:138` and `:215`. The stale citation still
**resolved** — the file is long enough that `:60` and `:94` both exist — it just
no longer pointed at anything relevant, which is Rule 2's point exactly. The route
is cited by anchor from here on.
`scripts/check-secrets.mjs`, `src/server/workers/scanWorker.js` (which moved again
mid-revision), `src/shared/scoring/enginePipeline.js` and that cron route are all
cited by name and greppable string rather than by line; each anchor was grepped at
`bf332fe` and its hit count checked — see
[the note in `README.md`](./README.md#a-note-on-citing-check-secretsmjs).*

*[`README.md`](./README.md) cites this file at `brightdata.md:62`,
`brightdata.md:63-64`, `brightdata.md:65`, `brightdata.md:91-95`, `brightdata.md:97`
and `brightdata.md:101`. All still resolve, and were re-read after the last edit
here. That was a constraint on both revisions, not a coincidence: every correction
above line 72 was made **in place**, at identical line counts, the quirk list was
rewritten at its original length, and **every edit in this second round is below
`brightdata.md:101`**, so none of those citations moved. The constraint was
accepted deliberately — R1.2.9 may not edit `README.md`, and moving a citation it
is not allowed to repair would be the same defect this revision exists to remove.
**If a later task rewrites this file without that constraint, those citations in
`README.md` must move with it.** (`README.md:32` lists `:91-95` while
`README.md:523-525` records that same range as a wrong citation from an earlier
revision. That inconsistency is inside `README.md` and is not R1.2.9's to fix; it
is noted here so the next editor of `README.md` sees it.)*
