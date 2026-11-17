# ADR — Bright Data is the SERP provider for Google AI Overview

> <!-- doc-status -->
> **Status: LIVE.** Supersedes
> [serp-provider.md](./serp-provider.md), which chose SerpAPI.

**Date:** 2026-08-29 — the date the decision was written down, not the date it
was taken; see *Context*.
**Supersedes:** [`docs/decisions/serp-provider.md`](./serp-provider.md) (SerpAPI vs DataForSEO)
**Status:** accepted, and already shipped — this ADR is being written *after* the
fact, which is the reason it exists.
**Revised:** 2026-09-05, task **R0.2.3**, fifth round. Every `file:line` below was
re-derived against the tree at `49fe39e` via `git show <ref>:<file>`, never from
the working tree. **That is the whole of the stamp's claim, and a stamp cannot
honestly make a larger one** — the author of a document does not choose which
files share its commit, so the fourth round's promise that this revision "edits no
file other than this one" was not the author's to make, and it was false. Whether
the citations still hold at *your* HEAD is therefore handed to you as a check
rather than asserted: run `git diff 49fe39e HEAD --stat` and cross-reference it
against the fifteen files this document cites by line. The recipe, the list, and
the last time it was run are in the *[Correction log](#correction-log)*. Four
files are cited by greppable anchor rather than by
line, per [the anchor rule](../vendors/README.md#a-note-on-citing-check-secretsmjs).
The decision itself is unchanged and has never been in question; the *evidence*
has been wrong twice and stale twice. See *[Correction log](#correction-log)*.

---

## Context

Before this document, the one ADR in this repository said SerpAPI won.
Production has been on Bright Data for some time — a claim this ADR repeats
because it is the reason the ADR exists, but which is *not* verifiable from the
repository; see *[What is NOT verified](#what-is-not-verified)*. Nobody wrote the
second decision down, so the only document a new reader could find described a
provider the code does not use, in enough detail to be convincing. That is a
worse failure than having no ADR at all: an absent document invites you to go and
read the code, and a confidently wrong one does not.

This ADR records the decision that actually holds, and marks the old one
superseded rather than deleting it — the SerpAPI comparison is still the best
write-up of what the AI Overview probing problem requires.

## Decision

**Bright Data's SERP API is the provider for Google AI Overview probing.**

| | |
|---|---|
| Integration | [`src/shared/engines/brightdata.js`](../../src/shared/engines/brightdata.js) |
| Credential | `BRIGHTDATA_API_KEY` — read at `brightdata.js:137` |
| Zone | `BRIGHTDATA_SERP_ZONE` if set (`brightdata.js:141-142`), else auto-discovered |
| Discovery | `GET https://api.brightdata.com/zone/get_all_zones` (`brightdata.js:156`), first `type: "serp"` **and** `status: "active"` zone (`:175-177`) |
| Request | `POST https://api.brightdata.com/request` (`brightdata.js:371`), body `{ zone, url, format: "json", country }` (`:378-386`) |
| Cost booked | `0.0015` per query — anchor, not line: grep `result.cost = 0.0015`, two hits, `enginePipeline.js` (live) and `aioPipeline.js` (dead) |

Response shapes, parser quirks and the retry ladder are the vendor doc's subject,
not this one: [`docs/vendors/brightdata.md`](../vendors/brightdata.md).

## What was actually built

This section exists because the *decision* is one line and the *thing that ships*
is not. A reader who acts on "we use Bright Data" without reading the zone
lifecycle will mis-diagnose the failure mode this integration actually has.

### Zone resolution, in order

`resolveBrightDataSerpZone` (`brightdata.js:140-203`) runs five steps, and each
one is a deliberate refusal to guess:

1. **Configured wins outright.** A non-empty `BRIGHTDATA_SERP_ZONE` returns
   immediately (`:141-142`), with no discovery call and **no caching** — that
   path never populates the cache at all.
2. **A fresh cache entry is served** (`:144-145`): `cachedZone` is `{ name, at }`
   (`:81`), and it is used only while `Date.now() - at < ttlMs`.
3. **No API key, expired entry → the entry is dropped and `null` returned**
   (`:149-154`). A name that can no longer be re-verified is not an answer.
4. **The listing call** (`:156-158`). A lookup that could not be *completed* —
   `get_all_zones` returning non-`ok` — throws `reason: "lookup_failed"` and
   **does not refresh the timestamp** (`:160-172`), so the very next resolve
   retries instead of buying another full TTL on an unverified name. The rejected
   alternative was a grace window, which would hide a dead zone for as long as
   the control plane stayed unreachable.
5. **No active SERP zone → a typed configuration error** (`:179-190`), message
   beginning `"No active Bright Data SERP zone found on this account."` (`:184`).
   Any stale cached name is dropped first (`:182`), and the message names it.

On success the entry is written with a fresh timestamp (`:192`) and one of three
log lines is emitted (`:194`, `:198`, `:200`) — first discovery, unchanged
re-check, or a zone *change*. The unchanged-re-check line exists so that "the TTL
never fired" and "the TTL fired and the zone is fine" are not indistinguishable
in a log.

### The cache is bounded, by three levers that are combined and not chosen between

The policy is stated in the source at `brightdata.js:37-72` and is worth reading
there. Summarised:

| Lever | Where | What it bounds |
|---|---|---|
| TTL over a `{ name, at }` entry | `brightdata.js:81`, read `:145`, written `:192` | staleness by the clock, needing no cooperation from any caller |
| `invalidateBrightDataZoneCache()` | `brightdata.js:116-124` | staleness on a caller's own schedule |
| Probe-time rejection | `zoneRejectionDetail` `:291-303` → `zoneRejectedError` `:313-327` | staleness the moment Bright Data itself says the zone is gone |

- The default TTL is **five minutes**: `DEFAULT_BRIGHTDATA_ZONE_TTL_MS`
  (`brightdata.js:72`), overridable with `BRIGHTDATA_ZONE_TTL_MS`
  (`brightDataZoneTtlMs`, `:91-103`).
- **A malformed TTL throws** rather than falling back to the default
  (`:95-101`, `reason: "bad_ttl_config"`). An operator who wrote `30s` would
  otherwise believe they had a 30-second re-check while a dead zone lived on for
  five minutes.
- **`0` means "re-check on every resolve"** (`brightdata.js:69-70`), which is
  *not* the same as "never cache": `:192` still writes the entry, and what `0`
  changes is only the freshness test at `:145`, which can then never pass.
  `peekBrightDataZoneCache()` (`:132-134`) therefore shows a live entry even
  under TTL `0`.
- **The invalidator returns the name it dropped, or `null`** (`:116-124`), because
  a cleared cache and an already-empty one are different events.
- **A probe-time rejection drops the cache and is refused a retry** (`:478`), so
  **recovery is one failed probe, not one TTL**. Both transports are read: the
  HTTP error body (`:397-398`) and the HTTP **200** envelope (`:441-447`).
- **A rejected probe stays an error row.** It must never become a skip with
  `cost: 0.0` — that is the R0.1.10 failure —
  and `src/shared/engines/brightdataZone.test.mjs:334` pins it at
  `errored_queries: 1`, `error_rate_pct: 100`.

**This replaced a cache that was a bare module-level string with no invalidator**
(R1.2.7). Do not describe the current behaviour as "cached for the process
lifetime": that was true of the old code, it is false of what ships, and two
documents that still said it were corrected under R1.2.9 — one of them the
`check:secrets` operator string itself.

Behavioural pins, all resolving at `49fe39e`, in
`src/shared/engines/brightdataZone.test.mjs`: `:66` (configured zone
short-circuits), `:84` (fallback to the first active zone), `:101` (cached within
the TTL, re-checked once it expires), `:167` (the TTL as a wall clock, not just
the `0` case), `:198` (the invalidator and its `null` return), `:232` (malformed
TTL fails loud), `:249` (probe-time rejection, then self-heal without a restart),
`:302` (a typed zone error is never retried), `:334` (a rejected probe is an
error row), `:380` (`getBrightDataConfig` returns `null` rather than a
half-config).

### What `check:secrets` tells the operator

`npm run check:secrets` (`package.json:15`) resolves the zone **the way the
client does** — it calls `resolveBrightDataSerpZone` itself — and then asserts
*that* zone against the account listing. Four verdicts, cited by greppable string
because this file is on the anchor list: `no SERP zone could be resolved`,
`does not exist on this account`, `not an active serp zone`, and a `PASS` naming
the auto-discovered zone (grep `AUTO-DISCOVERED`). Each string was grepped at
`49fe39e` and returns exactly one hit in `scripts/check-secrets.mjs`.

The `PASS` line names the **variable** `BRIGHTDATA_ZONE_TTL_MS` rather than the
resolved number, on purpose: `brightDataZoneTtlMs()` throws on a malformed value,
and calling it there would put the throw outside the entry's local `try`/`catch`,
turning a TTL typo into a bare `err.message` on the `brightdata` row instead of a
zone verdict.

## Consequences

Both directions. An ADR that lists only benefits is not an ADR.

### What we get

- One provider, one credential, and a `0.0015`-per-query booking instead of
  SerpAPI's `0.01` — a 6.7× difference in the *booked* number. See the caveat in
  *What is NOT verified*: `0.0015` is an assumption, not a measurement.
- An AI Overview payload obtained from a real Google SERP
  (`brd_json=1&brd_ai_overview=2`), rather than a provider's re-rendering of one.
- Zone faults are now typed (`BrightDataZoneError`, `brightdata.js:17-31`) and
  distinguishable from probe faults by `name`/`reason` rather than by message
  text (`isBrightDataZoneError`, `:33-35`).

### What it costs

- **A second configuration surface.** SerpAPI needed one key. Bright Data needs a
  key *and* a zone, and the zone can be absent, suspended, of the wrong `type`,
  or simply mis-typed — four distinct failure modes that did not exist before,
  each with its own `check:secrets` verdict.
- **A control-plane round trip per process.** Auto-discovery calls
  `get_all_zones` (`brightdata.js:156`) before any probe can run. Five minutes of
  TTL costs at most 12 such calls/hour per long-lived container; re-listing per
  probe would be roughly 30 extra calls per scan.
- **A stateful client.** `cachedZone` (`brightdata.js:81`) is module-level mutable
  state. Behaviour now depends on process age, which it did not with SerpAPI, and
  tests that touch zone resolution have to manage that state
  (`brightdataZone.test.mjs` does).
- **Two undeclared environment variables.** `.env.example:75` lists
  `BRIGHTDATA_API_KEY` and nothing else; `README.md:93` documents
  `BRIGHTDATA_SERP_ZONE`; and **`BRIGHTDATA_ZONE_TTL_MS` appears in neither** —
  at `49fe39e` it exists only in `scripts/check-secrets.mjs`,
  `src/shared/engines/brightdata.js` and `src/shared/engines/brightdataZone.test.mjs`.
  An operator can change how long a dead zone is reused, using a variable no
  operator-facing surface names.

### What it makes harder

- **Diagnosis at 2am.** A dead zone does not look like a credential problem. It
  looks like N identical probe failures (finding C4), or — on the sourcing path —
  like nothing at all (below).
- **Cost attribution.** The per-query figure is hard-coded in two places
  (grep `result.cost = 0.0015`, two hits) and only one is on a live path. Three
  copies existed before R6.5.3 deleted the dead `probe.js`/`adapter.js` pair; two
  is still one too many.
- **Comparison with the superseded choice.** Nothing in the repository measures
  Bright Data against SerpAPI on cost, coverage or latency, and the superseded
  ADR's numbers describe SerpAPI only.

### What is now load-bearing that was not before

- **`resolveBrightDataSerpZone` is on the critical path of every probing phase.**
  If it throws, the AIO engine — the only paid engine on the live scan path —
  produces nothing.
- **The TTL constant is a correctness parameter, not a tuning knob.** It is the
  upper bound on how long a suspended zone keeps being used by a process that
  never calls the invalidator. Every process that runs today is such a process:
  at `49fe39e` the exported `invalidateBrightDataZoneCache` has **no consumer
  outside `brightdata.js` itself** — the only external call sites are in
  `src/shared/engines/brightdataZone.test.mjs` (`:206`, `:218`, `:223`, `:253`), and
  the two other files that name the symbol
  (`scripts/check-secrets.mjs:178`, `src/server/checkSecretsBrightdataNoZone.test.mjs:21`)
  only mention it in prose. The R1.2 fleet that would call it once per poll cycle
  is not built: `worker/src/lib/probe.js:26-30` still throws *"probeBatch: no
  adapter is built yet (R1.3)"*. **The TTL, not the invalidator, is what bounds
  staleness in production today.**
- **The sourcing path swallows a zone rejection.** `fetchPeopleAlsoAsk`
  (`src/shared/engines/serp.js:312`) calls `brightDataSearch` at `:325` and catches
  everything at `:352-354` with a `console.warn`, returning `[]`. A typed
  `BrightDataZoneError` is not distinguished from a timeout. So a dead zone
  during prompt sourcing degrades silently to "PAA found nothing": the prompt set
  is still produced, from the LLM alone, and the scan reports success. Probing
  turns the same fault into a counted error row; sourcing turns it into nothing.
  Recorded here, not fixed — the fail-soft predates the zone cache.

## What is genuinely verified about this decision

Being precise about the evidence, because the document being superseded was
persuasive on numbers that no longer describe anything we run — and because the
first two drafts of this section then made the mirror-image mistakes of each
other.

**Re-read this at your own commit before acting on it, and re-check *liveness* as
well as text.** A citation proves a line exists and says what is claimed of it;
it does not prove anything calls it. That distinction is the subject of two of
the three entries in the correction log.

### 1. Bright Data is what runs when `BRIGHTDATA_API_KEY` is set

- `src/shared/engines/serp.js:14` — `if (getBrightDataApiKey()) return "brightdata";`
  is evaluated *before* the SerpAPI fallback at `:15`, so a deployment holding
  both credentials uses Bright Data with no `SERP_PROVIDER` set.
- `src/shared/engines/serp.js:165-166` — `probeGoogleAiOverview` returns
  `probeGoogleAiOverviewBrightData(...)` as soon as the provider is `brightdata`.
  True of the function's contents; **not** the route a scan takes —
  `probeGoogleAiOverview` has no non-test caller at `49fe39e` (§3b).
- `src/shared/engines/serp.js:324-327` — the People-Also-Ask path takes the Bright
  Data branch and `continue`s, never reaching `serpFetch`. This branch **is**
  live (§3a).
- `src/shared/engines/types.js:47` — `getEnabledEngines()` enables
  `google_ai_overview` on `BRIGHTDATA_API_KEY` alone, with a comment at `:43-46`
  naming this ADR. It has **no caller at all** outside its own tests at
  `49fe39e` (§3b); live engine selection is a different function reading a
  different variable, `resolveEnabledEngines()` on `ENGINES` in
  `enginePipeline.js`.

**Where Bright Data is actually invoked — not through `serp.js`.** The probing
route a scan takes runs through `src/shared/scoring/enginePipeline.js`, cited by
anchor because a concurrent task has it dirty: `resolveEnabledEngines()` reads
`ENGINES` (default `"aio"`), resolves the `aio` registry entry (grep
`probe: probeAio`, one hit repo-wide) whose `isConfigured` is `() => true`, and
`probeAio` calls `brightDataSearch` (grep `brightDataSearch(query.text` — two
hits, this one and `aioPipeline.js:99`'s dead path) with the cost booked at grep
`result.cost = 0.0015`. `brightDataSearch` (`brightdata.js:355`) reaches
`getBrightDataConfig` at `:356`, which resolves the zone at `:209`. The decision
is unaffected — Bright Data is the provider and `brightdata.js` is the
integration — but the module that drives it for probing is `enginePipeline.js`,
not `serp.js`.

### 2. The SerpAPI path is live code that spends money

`SERPAPI_KEY` is not vestigial. It selects a provider, and that provider issues
live, billed HTTP requests:

| Step | Location | What it does |
|---|---|---|
| Provider selection | `serp.js:15` | `if (resolveSerpCredentials()) return "serpapi";` — with no Bright Data key and a `SERPAPI_KEY` present, the provider *is* SerpAPI |
| Explicit selection | `serp.js:13` | `SERP_PROVIDER=serpapi` selects it by name, even if a Bright Data key exists |
| Credential read | `serp.js:24` | `const raw = (process.env.SERPAPI_KEY \|\| "").trim();` |
| Credential required | `serp.js:50` | `serpFetch` throws `"SERPAPI_KEY is not configured."` |
| The network call | `serp.js:63` | a real `fetch` to `https://serpapi.com/search?...` |
| AIO probe → SerpAPI | `serp.js:190` | `serpFetch` inside `probeGoogleAiOverview`; **no non-test caller**, see below |
| Second billed call | `serp.js:225` | deferred `page_token` follow-up — same function, same caveat |
| PAA → SerpAPI | `serp.js:342` | `const res = await serpFetch(searchParams);` — **the one that is live and billable today** (§3a) |
| Cost is charged | `serp.js:213`, `:231` | `let cost = 0.01;` then `cost += 0.01;` — both inside `probeGoogleAiOverview` |

**"Live and billable" is not the same as "billable if it were reachable".** Of
the three `serpFetch` call sites, one has a live caller and two do not.

- **Live.** `serp.js:342` is inside `fetchPeopleAlsoAsk` (`:312`), reached from
  `promptGen` on the scan path (§3a). A `SERPAPI_KEY`-only deployment is charged
  for this one today.
- **Dormant.** `serp.js:190` and `:225`, and the `$0.01` charges at `:213` and
  `:231`, are inside `probeGoogleAiOverview` (`:158`), which at `49fe39e` has
  **no non-test caller anywhere in the tree**. Its former caller,
  `src/lib/engines/adapter.js`, was deleted with `src/lib/scoring/probe.js` by
  R6.5.3 (commit `75e9ca5`); neither file exists at HEAD. Sweeping
  `probeGoogleAiOverview` across `src`, `scripts`, `worker` and `supabase`
  returns `serp.js` itself (`:158`, `:166`), `serp.test.mjs` and
  `serpGeo.test.mjs`, and nothing else.

No deployment is being charged for `:190`/`:225`, and no incident, cost line or
dashboard figure should be attributed to them.

### 3. Two paths are written against that code; only one of them can run

**a. Prompt generation — ungated, and this is the live spend risk.**
`src/shared/scoring/promptGen.js` imports `fetchPeopleAlsoAsk` from
`../engines/serp.js` and uses it as the default when the caller passes no `deps`
override (anchor, not line — that file is on the anchor list and is dirty in the
working tree: grep `deps.fetchPeopleAlsoAsk`, one hit).
`fetchPeopleAlsoAsk` gates only on `isSerpConfigured()` (`serp.js:313`) →
`getSerpProvider()` (`:318`), which returns `"serpapi"` on a stale key. **It never
consults `getEnabledEngines()`.** A deployment holding only `SERPAPI_KEY`
therefore makes a live `serpapi.com` request at prompt-generation time and spends
money the capability check says it cannot. This is ledger task **R1.7.4**
(`todo`).

The reverse also holds and is the honest consequence recorded above: with a
Bright Data key set, this same path calls `brightDataSearch` (`serp.js:325`) and
swallows a `BrightDataZoneError` at `:352-354`.

It does not run on *every* scan. Sourcing returns early when the stored prompt
pool already meets the target, so a repeat scan of a brand whose frozen set is
full never reaches the PAA function. The chain is `runScanChunk` →
`runSourcingPhase` → `sourceUnbrandedQueries` → `generateUnbrandedPrompts`, all
in `src/server/workers/scanWorker.js` (anchor list; grep
`deps.sourceUnbrandedQueries`, one hit).

**b. The AIO probe — the gate has a real bypass, and nothing is behind it.**

*The bypass is real.* `types.js:32-37` returns an explicit `ENGINES_ENABLED` list
*without any credential check*, so `ENGINES_ENABLED=google_ai_overview` with only
`SERPAPI_KEY` set puts `google_ai_overview` into the returned list, bypassing the
`BRIGHTDATA_API_KEY` requirement R0.1.9 added at `types.js:47`.
`src/shared/engines/types.test.mjs:90-97` asserts exactly that env combination and
records that the branch was left alone deliberately: an operator naming an engine
is a different claim from a key being present.

*Nothing consumes it.* `getEnabledEngines()` (`types.js:28`) has **zero** callers
outside `src/shared/engines/types.test.mjs` at `49fe39e`. Its last non-test caller
was `src/lib/scoring/probe.js`, deleted by R6.5.3 at `75e9ca5`. Live engine
selection is `resolveEnabledEngines()` in `enginePipeline.js`, reading `ENGINES`,
which never consults `ENGINES_ENABLED`. **Setting `ENGINES_ENABLED` changes
nothing a scan does.**

This is a stronger statement than the second round could make. At that time the
chain was unreachable *because a module failed to link* — `adapter.js` imported a
name `openai.js` does not export, a break dating to `a1ed0e0` (2026-07-23) that
no test noticed because no test imported either file. R6.5.3 has since deleted
both files, so the chain is now absent rather than merely broken, and the
sequencing warning the second round attached to R1.7.3 no longer applies.

### 4. What R0.1.9 closed, and what it did not

- **Closed.** R0.1.9 (commit `6308cb7`) removed the `SERPAPI_KEY` branch from the
  **capability check**. `types.js:47` reads `BRIGHTDATA_API_KEY` only. Covered by
  `types.test.mjs:55`, `:65`, `:71`, `:80`. Scope that honestly: with `probe.js`
  deleted, `getEnabledEngines()` has no caller at all, and the operator-facing
  surfaces that answer "is this deployment configured" —
  `src/server/health.js:19-33` (the `brightdata` vendor at `:26`) and
  `scripts/check-secrets.mjs` — never read `SERPAPI_KEY`. R0.1.9 corrected a
  capability check that no running code consults. Its value is preventive: the
  stale-key branch cannot come back into a revived probe path.
- **Not closed.** R0.1.9 did not touch `src/shared/engines/serp.js` at all. The
  **spend path** in §2 is unchanged by it. Do not read "types.js is fixed" as
  "SerpAPI is gone".

### 5. Where `SERPAPI_KEY` appears at `49fe39e`

`git grep -c SERPAPI_KEY HEAD -- src scripts worker supabase .env.example README.md`
returns seven files, in four groups.

**Non-test code — one file.** `src/shared/engines/serp.js` at `:24` (the read),
`:50` (the `serpFetch` guard) and `:206`, `:270` (operator warnings). Only `:24`
and `:50` are reached by a live caller, both via `fetchPeopleAlsoAsk`. `:206` and
`:270` are inside `probeGoogleAiOverview`, so **those two warnings cannot print
at HEAD**: an operator on a `SERPAPI_KEY`-only deployment is never told the key
was rejected, because the code that would say so never runs.

**Comments that explain the absence — no branch.** `types.js:43`, `:45`.

**Test fixtures on the live branch.** `src/shared/engines/serp.test.mjs:65`, `:143`,
`:186`, `:213`, driving a stubbed `globalThis.fetch`; and
`src/shared/engines/serpGeo.test.mjs` (six occurrences). These are not leftovers —
they are the *only remaining coverage* of the live SerpAPI branch, which is why
R1.7.3's acceptance says "removed **with their tests**".

**Tests that assert it is *not* a credential — the R0.1.9 guards.**
`types.test.mjs` (`:55`, `:71`, `:100`), `src/server/health.test.mjs` (`:111`,
`:126`, `:143`, `:157`) and `src/server/checkSecrets.test.mjs` (`:119`, `:133`,
`:140`). Note the boundary precisely: the drift guard at `types.test.mjs:113-134`
reads only `src/shared/engines/types.js`, `src/server/health.js` and
`scripts/check-secrets.mjs` (`types.test.mjs:114-118`). **`serp.js` is not in its
source list**, so nothing in the suite would fail if the request path in §2 grew
back. The guard protects the capability check, not the spend path.

Note what is *not* in any group: `.env.example` and `README.md` contain no
`SERPAPI_KEY` reference, and neither do `src/server/health.js` or
`scripts/check-secrets.mjs`. The credential is undeclared by every
operator-facing surface while still being honoured by code.

## What is NOT verified

- **Cost per query, coverage rate, and latency against SerpAPI.** No comparison
  was ever run, and none is available in the repository. The superseded ADR's
  `$0.01/query` and `$0.15/scan` figures
  ([`serp-provider.md:31`](./serp-provider.md), `:42`) describe SerpAPI and must
  not be read across.
- **The Bright Data per-query cost the product reports is an assumption, not a
  measurement.** `0.0015` is hard-coded twice — grep `result.cost = 0.0015`, one
  hit in `enginePipeline.js` (live, inside `probeAio`) and one in
  `src/shared/scoring/aioPipeline.js:110` (dead: its caller `probeQueryOnce` at
  `:73` is reached only from `runAioScan` at `:171`, which nothing calls). A
  third copy at `serp.js:288` sits in `probeGoogleAiOverviewBrightData`, dormant
  for the reason in §2. Nothing in the repository measures the number. Treat any
  Bright Data spend figure on a dashboard as that constant multiplied by a query
  count.
- **Zone rejection inside a 200 envelope has no test.** The branch
  (`brightdata.js:441-447`) was proven by hand against a stubbed `fetch`; both
  zone-rejection tests drive `ok: false`, so deleting those lines leaves the
  suite green. Filed as **R1.2.10** (`todo`), together with two classifier
  asymmetries: a snake_case `zone_suspended` is typed as a plain `Error` and
  leaves the cache in place, and on the not-ok path `zoneRejectionDetail` runs
  *before* the retry branch (`:397` before `:399`) while on the 200 path the
  rate-limit check runs first (`:435` before `:441`).
- **The invalidator has no production consumer.** See *Consequences*.
- **That production has run on Bright Data "for some time."** Deployment history
  is not verifiable from this repository. The only in-repo corroboration is
  [`docs/BUILD_JOURNAL.md:37-38`](../BUILD_JOURNAL.md), which reports a Bright
  Data answer yield of 93.3% on the Italica scan.

**What *has* since been verified, and was listed here as unverified in the
previous revision:**

- **`check:secrets` has now been run against live credentials.** R0.1.6 is
  `done`; its closing note records `brightdata PASS (1 active serp zone)` on a
  run against a real account, alongside 5 other passing vendors, 1 fail and 2
  unconfigured, exit code 1. The endpoint choice is no longer unvalidated.
- **The R0.4.1 baseline corpus exists.** `test_reports/baseline-2026-08/` holds
  `italicatiles.com.json`, `snitch.com.json` and `zouk.co.in.json`, three brands
  with distinct `prompt_set_id`s, archived read-only from scans that already
  existed. It is a corpus of *current* behaviour, not a SerpAPI-vs-Bright-Data
  comparison — it cannot settle the first bullet above.

## Alternatives

| Option | Why not |
|---|---|
| **SerpAPI** | The prior choice. Demoted in *preference order*, not removed: `serp.js:14-15` still falls through to it when no Bright Data key is present, so it remains reachable and billable (§2). The reasons for the switch were not recorded at the time and are not reconstructible from the repository. State that plainly rather than invent a rationale. |
| **DataForSEO** | Assessed in the superseded ADR and rejected there for task post-and-get complexity and weaker citation link maps ([`serp-provider.md:29`](./serp-provider.md), `:33`). Nothing has changed that assessment. |
| **Keep the bare-string zone cache** | Rejected under R1.2.7. Nearly free in a Vercel function that reloads every few minutes; unacceptable in a container that runs for days, where a zone suspended at 09:00 was still being sent to `/request` at 17:00. |
| **Re-list zones before every probe** | Rejected: ~30 extra control-plane calls per scan, and a Bright Data API blip would then take out probes a cached name would have served. Probe-time rejection is what makes a five-minute TTL safe. |
| **A grace window on a failed re-check** | Rejected explicitly in the source comment at `brightdata.js:161-167`: it would keep serving a stale name for as long as the control plane stayed unreachable, which is the fail-soft this design removes. |

## What would reverse this

- A measured coverage rate for AI Overview blocks materially below what SerpAPI
  achieves on the same prompt set. The R0.4.1 corpus now exists, so this is
  runnable for the first time — but the corpus is a Bright Data baseline, so the
  comparison still requires a SerpAPI arm that has never been run.
- Bright Data zone management becoming an operational burden — in particular if
  the "no active serp zone" failure mode recurs. On the **probing** path that
  mode is now loud: a typed `BrightDataZoneError` produces a counted error row
  (`brightdataZone.test.mjs:334`). On the **sourcing** path it is still silent
  (`serp.js:352-354`), and on the legacy `serp.js` AIO path it would return
  `google_ai_overview-skipped` with `cost: 0.0` (`:302-308`) — that path is
  dormant, but the pattern is the one to watch for.
- The `0.0015` assumption turning out to be materially wrong once a real invoice
  is reconciled against a scan's booked cost.

## Follow-ups

1. **R1.7.3 (`todo`) — delete the SerpAPI probe path.** Plan it from §2, §3a and
   §3b, not from the superseded text, and do not scope the three `serpFetch` call
   sites as if they were alike. `serp.js:342` (PAA, reached from `promptGen`) is
   called by live code and spends money today — that is the one with a behaviour
   change behind it, and it is R1.7.4's subject. `serp.js:190` and `:225` are
   inside `probeGoogleAiOverview`, which now has no non-test caller at all;
   deleting them removes dormant code, so do not plan a rollout, a cost saving or
   a regression watch around them. The change also removes the `fetch` at
   `serp.js:63`, the provider-selection branches at `:13` and `:15`, and the
   tests that are the only coverage of any of it (`serp.test.mjs`,
   `serpGeo.test.mjs`).
   *The second round of this ADR told R1.7.3 to sequence against R6.5.3 in case
   that task repaired the dead pair instead of deleting it. It deleted it
   (`75e9ca5`), so that constraint is discharged.*
   Worth doing in the same change: add `src/shared/engines/serp.js` to the source
   list of the drift guard at `types.test.mjs:114-118`, so the request path
   cannot grow back unnoticed the way the capability check could have (§5).
2. **R1.7.4 (`todo`) — close the prompt-generation spend path.** §3a. The half
   R0.1.9 did not reach, and the one that can actually spend money on a stale
   credential. Acceptance: a `SERPAPI_KEY`-only deployment makes no `serpapi.com`
   request from `promptGen`. Depends on R1.7.3.
3. **R1.2.10 (`todo`) — pin the 200-envelope zone rejection, and fix the two
   classifier asymmetries.** See *What is NOT verified*.
4. **Declare `BRIGHTDATA_ZONE_TTL_MS` to operators.** It changes how long a dead
   zone is reused and appears in no `.env.example`, no `README.md` and no health
   output. Not yet filed as a task; recorded here so it is not lost.
5. **Give the sourcing path a counted failure for a rejected zone.** `serp.js`
   and `promptGen.js` catch a typed `BrightDataZoneError` and return an empty
   list, so a scan seeded without its Google grounding reports success. Not this
   ADR's to fix; recorded because it is the consequence of the decision that
   costs the most and is the least visible.
6. ~~Remove the `SERPAPI_KEY` branch from `src/shared/engines/types.js`.~~
   **Done — R0.1.9, commit `6308cb7`.** Struck through rather than deleted so a
   reader arriving from an older link can see it closed rather than wonder
   whether it was dropped.

## Correction log

**2026-08-29 — task R0.2.4, first round.** The evidence section as first written
asserted:

> `SERPAPI_KEY` survives in exactly two places: `src/shared/engines/types.js:43` […]
> and `src/shared/engines/serp.test.mjs`, which still sets it as a fixture. Neither
> makes a SerpAPI call.

Both halves were false, but not equally so.

- **The `types.js` half was true when written and went stale in 37 minutes.**
  `git show b6e3610:src/shared/engines/types.js` line 43 reads
  `const serpConfigured = process.env.BRIGHTDATA_API_KEY || process.env.SERPAPI_KEY;`
  — exactly what the ADR described, at the commit that added the ADR
  (`b6e3610`, 2026-08-29 16:01:49). R0.1.9 removed it at `6308cb7`, 16:39:04 the
  same day. The citation was honest; it simply outlived its line.
- **"Neither makes a SerpAPI call" was never true at any commit.** `serp.js`
  issues a live request to `serpapi.com`, called from three sites in the file,
  and charges `$0.01` a query. *Read this with the second-round entry below: only
  the PAA site has a live caller.* The related claim that Bright Data "is the
  only SERP provider actually invoked for AIO probing" was false for the same
  reason.

**Why it matters, and how it was found.** R1.7.3 was scoped from this section, so
the error was on its way into an implementation plan that would have treated a
billable code path as dead weight. It was caught by the R0.1.9 implementer, who
declined to delete `serp.js` on the ADR's authority and read the file instead
(their submission note in `.claude/orchestration/tasks.json` records: *"the
SerpAPI request path there is genuinely LIVE ... the ADR's claim that it is dead
is wrong as written"*), and confirmed by the R0.1.9 verifier, who filed R1.7.4
for the spend path.

**The lesson, stated as a rule rather than a diagnosis.** How the original author
arrived at the claim is not recorded anywhere, so this ADR does not assert a
cause. What is checkable is the trap: `SERPAPI_KEY` is absent from
`.env.example`, `README.md`, `src/server/health.js` and `scripts/check-secrets.mjs`,
so a credential search across the operator-facing surfaces returns a picture of a
retired provider. The surviving reference lives inside a provider-resolution
function whose *return value* — not its name — is what routes the request. Grep
finds candidates; only reading the call graph confirms semantics.

---

**2026-08-29, second round — task R0.2.4.** The first correction turned "this code
is dead" into "this code is live" and over-shot. §3b as first rewritten said that
with `ENGINES_ENABLED=google_ai_overview` set, in the default `hybrid` mode:

> the chain runs unimpeded: `probe.js:99-101` → `probePromptOnce` → `probe.js:30`
> `probeEngine(...)` → `adapter.js:24` → `probeGoogleAiOverview` → `serpFetch`

and §3 was headed "Two distinct paths still reach that code at HEAD".

**Editorial note, outside the quotation on purpose — the three `file:line`
citations *inside* it are quoted, not asserted.** `src/lib/scoring/probe.js` and
`src/lib/engines/adapter.js` were deleted by R6.5.3 at `75e9ca5` and do not exist
at `49fe39e`; the `probe.js` in the tree today is `worker/src/lib/probe.js`, an
unrelated 31-line stub. So `probe.js:99-101`, `probe.js:30` and `adapter.js:24`
**must not be resolved against HEAD** — and that exemption covers those three and
nothing else. Every other `file:line` in this document, above and below, is meant
to be resolved against HEAD and was.

Every `file:line` in that chain was correct. The chain could not execute:
`adapter.js` imported a name `openai.js` does not export, so both `adapter.js`
and `probe.js` threw at link time; nothing imported `probe.js` in any case; and
the function the bypass lives in, `getEnabledEngines()`, had one caller and it
was inside that unimportable pair.

**That is the mirror image of the error the task was filed to fix, made inside
the section written to fix it.** First the document said code was dead when it
was live and billable; then it said code was live when it was dead. The mechanism
was identical both times: *every line was verified, and the arrows between the
lines were not.* Liveness is a second, separate check — walk backwards from
`scanWorker.js` to the line, or import the module and see whether it loads.

Corrected in that round: §3's heading; §3b; §2's table, separating the one live
billable `serpFetch` from the two dormant ones; follow-up #1; §1's Bright Data
bullet (the live route is `enginePipeline.js`, not `serp.js`); §4's overstated
claim about boot-time configuration; the `$0.0015` attribution, which named a
dormant copy instead of the live one; and §5's "live code" group, which listed
two operator warnings that cannot print.

---

**2026-09-05, third round — task R0.2.3.** No claim in this round was *wrong*.
Nearly every citation had **moved**, and the document did not describe what had
since been built. Both are the same failure with different causes, and the second
is the one an existence check cannot catch.

*Citations repointed.* `src/shared/engines/serp.js` gained a line early in the file,
shifting every one of its ~20 citations by one to eighteen lines. The previous
revision's own assurance — "`git diff b6e3610 HEAD -- src/shared/engines/serp.js` is
empty" — was true when written and is now false, which is exactly why that
sentence was replaced with a commit stamp rather than repeated. `serp.js:335`,
the load-bearing "the one live billable `serpFetch`", is now `:342`; at the old
number it lands on a **comment line** inside the `R1.6.2` note about `SERP_GEO`,
seven lines above the call it used to name. It still **resolves**, which is the
whole point: an existence check would have scored it green.
`src/server/workers/scanWorker.js` and
`src/shared/scoring/enginePipeline.js` moved by hundreds of lines and are now cited
by greppable anchor instead.

*Two claims stopped reproducing, and are recorded rather than deleted.*
`src/lib/engines/adapter.js` and `src/lib/scoring/probe.js` no longer exist —
R6.5.3 deleted them at `75e9ca5`. The second round's careful argument that the
`ENGINES_ENABLED` bypass feeds an unreachable chain is now simpler and stronger:
there is no chain. `getEnabledEngines()` has zero callers outside its own tests,
and `probeGoogleAiOverview` has none either. Consequently the sequencing warning
attached to follow-up #1 — that if R6.5.3 repaired the import instead of deleting
the pair, the two dormant `serpFetch` sites inside `probeGoogleAiOverview` would
become live — is discharged, and follow-up #1 says so rather than silently
dropping it.

Likewise, two items that sat under *NOT verified* because their tasks were
`blocked` have since been closed: `check:secrets` has been run against live
credentials (R0.1.6, `brightdata PASS`), and the R0.4.1 baseline corpus contains
three archived brands rather than zero. Both are now recorded as verified, with
the limit stated: the corpus is a Bright Data baseline and cannot by itself
settle a comparison against SerpAPI.

*What the document did not say at all.* The zone cache was replaced under R1.2.7
— bounded TTL, explicit invalidator, probe-time rejection — and this ADR still
described only "discovered by picking the first active serp zone", with no cache
policy of any kind. A reader would have had no reason to look for
`BRIGHTDATA_ZONE_TTL_MS`. Two sibling documents that *did* describe the cache
described the **old** one, as a bare string held "for the process lifetime", and
were corrected under R1.2.9. This revision adds *[What was actually
built](#what-was-actually-built)* and a *[Consequences](#consequences)* section,
because an ADR that records only the upside of a provider switch is a marketing
page.

---

**2026-09-05, fourth round — task R0.2.3.** The third round claimed "58 distinct
citations all resolve." That claim was false, and it was false by the exact
mechanism the entry above congratulates itself for catching: **the line resolves,
the content is wrong.** Five citations landed on the wrong text. An independent
verifier opened 105 lookups, found 100 correct, and failed the document on the
other five.

*Four of the five were self-inflicted, and that is the lesson.* The third round
stamped the header "re-derived at `8502166`" and, **in that same commit**, added
the six-line `SUPERSEDED-BY` header to `docs/decisions/serp-provider.md` — a file
this ADR cites four times. Every one of those four citations shifted by exactly
six lines: `:23`→`:29`, `:25`→`:31`, `:27`→`:33`, `:36`→`:42`. Two of them are
load-bearing. `:31` and `:42` are the *sole* evidence for the *[What is NOT
verified](#what-is-not-verified)* claim that the superseded `$0.01/query` and
`$0.15/scan` figures describe SerpAPI only; at the stale numbers they landed on a
section heading and a blank line. This was not drift caused by someone else's
commit. It was a failure to re-derive after the document's own edit.

*The fifth was ordinary drift, and is recorded to keep the two apart.*
`.env.example:64` was correct at `8502166` and was displaced to `:75` by sibling
commit `a36edcd`. Nothing the author did caused it; only re-deriving at the
landing commit catches it.

**The rule this adds, stated so it can be executed.** A derivation stamp is a
claim about a commit, so it must be re-derived *after the last edit in that
commit* — including edits to files this document itself cites. That rule is sound
and still stands. The *mechanism* this round proposed for keeping it — "make the
correcting commit touch no cited file, and this revision does that: it edits this
file only," checkable with `git show --stat` on the landing commit — was not the
author's to promise, and it was false in the event. The fifth-round entry at the
end of this log records what it cost and what replaces it.

*Also corrected, both found while fixing the paragraph they sit in.* The
editorial note under the second-round quotation said "four citations" where the
quotation contains three (`probe.js:99-101`, `probe.js:30`, `adapter.js:24`), and
called `worker/src/lib/probe.js` a "32-line stub" where it is 31 lines. Its last
sentence read "Nothing above this line should be resolved against HEAD," which is
unbounded enough to exempt the entire document from its own evidence standard; it
now names the three exempt citations and says everything else must resolve. It
has also been moved out of the `>` block, because editorial commentary formatted
as a quotation reads as part of the material being quoted.

*Re-verified at `25e7727`, not merely re-pointed.* Every `file:line` in this
document was opened and its content compared with what the document says of it.
The greppable anchors were re-run and still return their claimed hit counts —
`probe: probeAio` one hit, `brightDataSearch(query.text` two, `result.cost =
0.0015` two, `deps.fetchPeopleAlsoAsk` one, `deps.sourceUnbrandedQueries` one —
which matters here because `25e7727` changed both `enginePipeline.js` and
`scanWorker.js`, the two files the third round moved to anchors for this reason.
The count claims were re-run too: `SERPAPI_KEY` in seven files with none in
`.env.example` or `README.md`, `BRIGHTDATA_ZONE_TTL_MS` in three,
`getEnabledEngines()` with no caller outside its own tests, and
`probeGoogleAiOverview` sweeping to `serp.js`, `serp.test.mjs` and
`serpGeo.test.mjs` and nothing else.

---

**2026-09-05, fifth round — task R0.2.3.** No claim about Bright Data changed.
One sentence about *this document* was false, and it was precisely the sentence
the document told the reader to check.

*What was checked, and what it returned.* The fourth-round header promised the
revision "edits no file other than this one, so nothing cited below moves
underneath it," and this log told the reader to confirm it with `git show --stat`
on the landing commit. A verifier ran it. The revision landed in `0b2e68b`, which
touches **seven** files: this ADR, `docs/contracts/probe-result.md`,
`docs/vendors/mimo.md`, `src/shared/llmPricing.js`, `src/shared/llmPricing.test.mjs`,
`src/server/openrouter.js` and `src/server/openrouter.test.mjs`. The prescribed check
returns 7, not 1. The stamp also read `25e7727` while the revision landed one
commit later at `0b2e68b` — the same stamp/landing mismatch that failed the third
round, repeated by the very rule written to prevent it.

*It was harmless by luck, not by construction, and that is the finding.* None of
the other six files is cited here, so no citation actually moved. The property a
reader cares about held; the property the document asserted did not. Those are
different things, and the gap between them is the whole subject of this log. A
document that is right by accident teaches its next reader nothing, and the
reader who runs the check and gets `7` has no way to tell which of the other 100
claims are also true by accident.

*Why the claim was unkeepable, which matters more than the fix.* "This commit
touches only this file" asserts control the author does not have. In this tree a
scribe writes a file and a controller decides which files share a commit, batching
by session rather than by document; several agents are editing at once. The fourth
round could have re-derived flawlessly and still shipped a false sentence — which
is what happened. So the replacement is deliberately *not* another promise about
the future.

**What replaces it, stated so it can be executed.** The stamp now claims only what
the author actually did: every `file:line` was re-derived against the tree at
`49fe39e`. The property a reader wants — that nothing cited has moved since — is
handed over as a check:

```sh
git diff 49fe39e HEAD --stat
```

Cross-reference the output against the fifteen files this document cites **by
line**: `src/shared/engines/serp.js`, `src/shared/engines/brightdata.js`,
`src/shared/engines/types.js`, `src/shared/engines/types.test.mjs`,
`src/shared/engines/serp.test.mjs`, `src/shared/engines/brightdataZone.test.mjs`,
`src/server/checkSecretsBrightdataNoZone.test.mjs`, `src/server/health.js`,
`src/shared/scoring/aioPipeline.js`, `scripts/check-secrets.mjs`, `package.json`,
`README.md`, `.env.example`, `docs/decisions/serp-provider.md` and
`docs/BUILD_JOURNAL.md`. If none of the fifteen appears, every line citation above
still points where it did. If one appears, treat *every* citation into that file as
suspect until re-derived — a file can change anywhere above a cited line.

Three limits on that check, stated so it is not over-trusted. It does not cover the
four files on the anchor list — `src/shared/scoring/enginePipeline.js`,
`src/server/workers/scanWorker.js`, `src/shared/scoring/promptGen.js` and
`scripts/check-secrets.mjs` — which are exempt by design and must be re-grepped
instead. (`check-secrets.mjs` is on both lists: anchor-cited for its four verdict
strings, and line-cited once at `:178`.) It catches *movement*, not an in-place
rewrite that leaves line numbers intact — the failure this log records at
`serp.js:335`. And it reads commits, not
the working tree: at the time of writing, `.env.example`,
`src/shared/scoring/enginePipeline.js` and `src/server/workers/scanWorker.js` were dirty
with other agents' uncommitted work, and this stamp deliberately describes
`49fe39e` rather than what was on disk.

*The check, actually run against the round it replaces.* `git diff 25e7727 49fe39e
--stat` lists fourteen files. Exactly two are cited by this ADR as evidence —
`src/shared/scoring/promptGen.js` and `src/server/workers/scanWorker.js` — and both are
cited **by anchor rather than by line**, precisely because the third round watched
them move by hundreds of lines. Both anchors still return one hit at `49fe39e`.
None of the fifteen line-cited files appears in the diff. So the fourth round's
citations did survive four commits of drift — but by the anchor rule, not by the
sentence that took credit for it.

*Re-derived at `49fe39e`, not assumed.* Every `file:line` above was re-opened with
`git show 49fe39e:<file>` and its content compared with what this document says of
it; none had drifted. The five anchors were re-run: `probe: probeAio` one hit in
`enginePipeline.js`; `brightDataSearch(query.text` two, `enginePipeline.js` (live)
and `aioPipeline.js` (dead); `result.cost = 0.0015` two, the same pair;
`deps.fetchPeopleAlsoAsk` one in `promptGen.js`; `deps.sourceUnbrandedQueries` one
in `scanWorker.js`. The count claims were re-run: `SERPAPI_KEY` in seven source
files with none in `.env.example` or `README.md`; `BRIGHTDATA_ZONE_TTL_MS` in
three; `getEnabledEngines()` with no caller outside its own tests; and
`probeGoogleAiOverview` in `serp.js`, `serp.test.mjs` and `serpGeo.test.mjs` and
nothing else. `.env.example:75` was **not** opened — the file is absent from `git
diff 25e7727 49fe39e --stat`, and that absence is the whole of the evidence
offered for that one citation. It is recorded here rather than glossed.

*Ten stamps inside the body were moved too, and only after re-running what they
claim.* §5's heading, the `brightdataZone.test.mjs` behavioural pins, the four
`check:secrets` verdict strings, the `BRIGHTDATA_ZONE_TTL_MS` three-file sweep, the
`invalidateBrightDataZoneCache` call-site list, the two `probeGoogleAiOverview`
no-caller claims, the `getEnabledEngines()` no-caller claim and the note that
`adapter.js`/`src/lib/scoring/probe.js` do not exist all read "at `25e7727`" and now
read "at `49fe39e`". Each was re-executed at `49fe39e` first and each reproduced
unchanged; the `worker/src/lib/probe.js` stub is still 31 lines. A body stamp left
behind a header stamp is the same defect as a header stamp left behind its commit,
one scope smaller.
