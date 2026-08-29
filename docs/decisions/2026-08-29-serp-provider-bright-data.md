# ADR — Bright Data is the SERP provider for Google AI Overview

> <!-- doc-status -->
> **Status: LIVE.** Supersedes
> [serp-provider.md](./serp-provider.md), which chose SerpAPI.

**Date:** 2026-08-29
**Supersedes:** [`docs/decisions/serp-provider.md`](./serp-provider.md) (SerpAPI vs DataForSEO)
**Status:** accepted, and already shipped — this ADR is being written *after* the
fact, which is the reason it exists.
**Evidence corrected:** 2026-08-29, task R0.2.4, in **two rounds** — the first
correction was itself wrong in the opposite direction. The decision below is
unchanged and has not been in question in either round. The evidence offered for
it was; see *[Correction log](#correction-log)*.

---

## Context

Before this document, the one ADR in this repository said SerpAPI won.
Production has been on Bright Data for some time — a claim this ADR repeats
because it is the reason the ADR exists, but which is *not* verifiable from the
repository; see *NOT verified* below. Nobody wrote the second decision down, so
the only document a new reader could find described a provider the code does not
use, in enough detail to be convincing. That is a worse failure than having no
ADR at all: an absent document invites you to go and read the code, and a
confidently wrong one does not.

This ADR records the decision that actually holds, and marks the old one
superseded rather than deleting it — the SerpAPI comparison is still the best
write-up of what the AI Overview probing problem requires.

## Decision

**Bright Data's SERP API is the provider for Google AI Overview probing.**

- Integration: [`src/lib/engines/brightdata.js`](../../src/lib/engines/brightdata.js)
- Credential: `BRIGHTDATA_API_KEY` — read at `src/lib/engines/brightdata.js:6`
- Zone: `BRIGHTDATA_SERP_ZONE` if set (`brightdata.js:10-11`), otherwise
  discovered by picking the first `type: "serp"` zone with `status: "active"`
  from `GET https://api.brightdata.com/zone/get_all_zones`
  (`brightdata.js:15`, `:24-25`), throwing if none is found (`brightdata.js:29`)
- Request path: `POST https://api.brightdata.com/request` (`brightdata.js:153-154`)

## What is genuinely verified about this decision

Being precise about the evidence, because the document being superseded was
persuasive on numbers that no longer describe anything we run — and because the
first draft of this section then made the mirror-image mistake, asserting that
code was dead when it was live and billable.

**Every source line cited below was read at commit `6308cb7` and re-read at
`0c2c094`;** `git diff 6308cb7 0c2c094 -- src/ scripts/ package.json` is empty.
If you are reading this at a later commit, re-read before you act on it — and
re-check *liveness* as well as text. A citation proves a line exists and says
what is claimed of it; it does not prove anything calls it. That distinction is
the subject of the second correction round logged at the end of this document.

### 1. Bright Data is what runs when `BRIGHTDATA_API_KEY` is set

- `src/lib/engines/serp.js:13` — `if (getBrightDataApiKey()) return "brightdata";`
  is evaluated *before* the SerpAPI fallback in `getSerpProvider()`, so a
  deployment holding both credentials uses Bright Data.
- `src/lib/engines/serp.js:164-165` — `probeGoogleAiOverview` returns
  `probeGoogleAiOverviewBrightData(...)` as soon as the provider is `brightdata`,
  before any SerpAPI request is built. True of the function's contents, but this
  is **not** the route a scan takes: `probeGoogleAiOverview` has no live caller
  at HEAD (§3b).
- `src/lib/engines/serp.js:323-325` — the People-Also-Ask path takes the Bright
  Data branch and `continue`s, never reaching `serpFetch`. This branch *is* live:
  `fetchPeopleAlsoAsk` is reached from `promptGen` on the scan path (§3a).
- `src/lib/engines/types.js:47` — `getEnabledEngines()` enables
  `google_ai_overview` on `BRIGHTDATA_API_KEY` alone. Its only non-test caller in
  the tree is `src/lib/scoring/probe.js:70`, which cannot be imported (§3b). Live
  engine selection is a different function reading a different variable:
  `resolveEnabledEngines()` at `src/lib/scoring/enginePipeline.js:488`, on
  `ENGINES` (`:489`).

**Where Bright Data is actually invoked — not through `serp.js`.** The probe
route a scan takes is `runScanChunk` (`src/lib/workers/scanWorker.js:1028`) →
`runProbingPhase` (called at `scanWorker.js:1088`, defined at `:460`) →
`resolveEnabledEngines()` (`enginePipeline.js:488`, default `ENGINES="aio"` at
`:489`) → the `aio` registry entry at `enginePipeline.js:446-453` → `probeAio`
(`enginePipeline.js:28`) → `brightDataSearch` (`enginePipeline.js:52`, defined at
`src/lib/engines/brightdata.js:137`), with the per-query cost applied at
`enginePipeline.js:62`. The decision is unaffected — Bright Data is the provider
and `brightdata.js` is the integration named under *Decision* — but the module
that drives it for probing is `enginePipeline.js`. `serp.js`'s own Bright Data
code (`:164-165`, `:283-309`) is reachable only through the dead pair in §3b.

This is the correct form of a claim the first draft over-stated as "Bright Data
is the only SERP provider actually invoked for AIO probing". It is the only one
invoked *when its key is present*. That is not the same sentence, and the
difference is the rest of this section.

### 2. The SerpAPI path is live code that spends money

`SERPAPI_KEY` is not vestigial. It selects a provider, and that provider issues
live, billed HTTP requests:

| Step | Location | What it does |
|---|---|---|
| Provider selection | `src/lib/engines/serp.js:14` | `if (resolveSerpCredentials()) return "serpapi";` — with no Bright Data key and a `SERPAPI_KEY` present, the provider *is* SerpAPI |
| Explicit selection | `src/lib/engines/serp.js:12` | `SERP_PROVIDER=serpapi` selects it by name, even if a Bright Data key exists |
| Credential read | `src/lib/engines/serp.js:23` | `const raw = (process.env.SERPAPI_KEY \|\| "").trim();` |
| Credential required | `src/lib/engines/serp.js:49` | `serpFetch` throws `"SERPAPI_KEY is not configured."` if absent — a guard on a path that is expected to run |
| The network call | `src/lib/engines/serp.js:62` | ``return fetch(`https://serpapi.com/search?${params.toString()}`, {`` — a real request to serpapi.com |
| AIO probe → SerpAPI | `src/lib/engines/serp.js:189` | `const res = await serpFetch(searchParams, ...)` — inside `probeGoogleAiOverview`; **no live caller**, see the note below |
| Second billed call | `src/lib/engines/serp.js:224` | deferred `page_token` follow-up, a second `serpFetch` — same function, same caveat |
| PAA → SerpAPI | `src/lib/engines/serp.js:335` | `const res = await serpFetch(searchParams);` — **the one that is live and billable today** (§3a) |
| Cost is charged | `src/lib/engines/serp.js:212`, `:230` | `let cost = 0.01;` then `cost += 0.01;` for the deferred fetch — both inside `probeGoogleAiOverview` |

**"Live and billable" is not the same as "billable if it were reachable".** Of
the three `serpFetch` call sites above, one has a live caller and two do not, and
R1.7.3 should not be planned as though all three were the same.

- **Live.** `serp.js:335` is inside `fetchPeopleAlsoAsk` (`serp.js:311`), which
  `promptGen.js:127` calls by default, on the scan path (§3a). A
  `SERPAPI_KEY`-only deployment is charged for this one today.
- **Dormant.** `serp.js:189` and `:224`, and the `$0.01` charges at `:212` and
  `:230`, are inside `probeGoogleAiOverview` (`serp.js:157`), whose only
  non-test caller in the tree is `src/lib/engines/adapter.js:24` — a module that
  cannot be imported (§3b, ledger task **R6.5.3**). Nothing that runs reaches
  them.

The guard at `:49` and the `fetch` at `:62` are real, and the dormant sites would
start spending the moment a caller is restored — which is why R1.7.3 still deletes
them. But no deployment is being charged for `:189`/`:224` at HEAD, and no
incident, cost line or dashboard figure should be attributed to them.

### 3. Two paths are written against that code; only one of them can run

**a. Prompt generation — ungated, and this is the live spend risk.**
`src/lib/scoring/promptGen.js:2` imports `fetchPeopleAlsoAsk` from
`../engines/serp.js`, and `promptGen.js:127` uses it as the default when the
caller passes no `deps` override. `fetchPeopleAlsoAsk` gates only on
`isSerpConfigured()` (`serp.js:312`) → `getSerpProvider()` (`serp.js:317`), which
returns `"serpapi"` on a stale key. **It never consults `getEnabledEngines()`.**
A deployment holding only `SERPAPI_KEY` therefore makes a live `serpapi.com`
request at prompt-generation time and spends money the capability check says it
cannot. This is ledger task **R1.7.4**.

**b. The AIO probe — the gate has a real bypass, and nothing live is behind it.**

*The bypass is real.* `types.js:32-37` returns an explicit `ENGINES_ENABLED` list
*without any credential check*, so `ENGINES_ENABLED=google_ai_overview` with only
`SERPAPI_KEY` set puts `google_ai_overview` into the returned list, bypassing the
`BRIGHTDATA_API_KEY` requirement R0.1.9 added at `types.js:47`.
`src/lib/engines/types.test.mjs:90-97` asserts exactly that env combination and
records that the branch was left alone deliberately: an operator naming an engine
is a different claim from a key being present.

*Nothing consumes it, and the chain it would feed cannot execute.* Two
independent reasons, both checked by running the code rather than reading it:

1. **No live consumer.** `getEnabledEngines()` has exactly one non-test caller in
   the tree — `src/lib/scoring/probe.js:70`. Live engine selection is a different
   function reading a different variable: `resolveEnabledEngines()`
   (`enginePipeline.js:488`) on `ENGINES` (`:489`), which never consults
   `ENGINES_ENABLED`. Setting `ENGINES_ENABLED` changes nothing a scan does.
2. **The module does not load.** `src/lib/engines/adapter.js:3` imports
   `probeOpenAI` from `./openai.js`, which exports only `isChatGptConfigured`
   (`openai.js:8`) and `probeChatGpt` (`openai.js:16`). Importing `adapter.js`,
   or `src/lib/scoring/probe.js` (whose line 1 imports it), throws
   `SyntaxError: The requested module './openai.js' does not provide an export named 'probeOpenAI'`.
   Nothing imports `probe.js` anywhere in the tree — no static import, no dynamic
   import, not even a test — and `adapter.js:24` is the only non-test caller of
   `probeGoogleAiOverview`.

So the chain an earlier version of this section drew — `probe.js:99-101` →
`probePromptOnce` → `probe.js:30` `probeEngine(...)` → `adapter.js:24` →
`probeGoogleAiOverview` → `serpFetch` at `serp.js:189` — is dead. Every line in
it exists and says what is claimed of it; no runtime path reaches any of them.
The break dates to `a1ed0e0` (2026-07-23), which replaced `openai.js`'s
`probeOpenAI` export with `probeChatGpt` and did not update `adapter.js`
(`git show 5f6dbd9:src/lib/engines/openai.js` still exports `probeOpenAI`); no
test noticed, because no test imports either file.

The dead `adapter.js`/`probe.js` pair is ledger task **R6.5.3**. Read it together
with R1.7.3: if R6.5.3 is closed by *repairing* the import rather than deleting
the pair, this bypass becomes billable and `serp.js:189`/`:224` become live.

### 4. What R0.1.9 closed, and what it did not

This distinction matters, because the previous version of this section let a
reader conclude the whole `SERPAPI_KEY` question was closed.

- **Closed.** R0.1.9 (commit `6308cb7`) removed the `SERPAPI_KEY` branch from the
  **capability check**. `src/lib/engines/types.js:47` now reads
  `BRIGHTDATA_API_KEY` only, with a comment at `:43-46` naming this ADR.
  Covered by `src/lib/engines/types.test.mjs:55`, `:65`, `:71`. Scope that
  honestly, though: `getEnabledEngines()` has no live caller at HEAD — its only
  non-test caller is `src/lib/scoring/probe.js:70`, which cannot be imported
  (§3b) — and the operator-facing surfaces that answer "is this deployment
  configured" (`src/lib/health.js:19-29`, `scripts/check-secrets.mjs`) never read
  `SERPAPI_KEY` at all. R0.1.9 corrected a capability check that no running code
  consults. Its value is that the stale-key branch cannot come back into a
  revived probe path; it did not change what a scan does today.
- **Not closed.** R0.1.9 did not touch `src/lib/engines/serp.js` at all. The
  **spend path** in the table above is unchanged by it. Do not read
  "types.js is fixed" as "SerpAPI is gone".

### 5. Where `SERPAPI_KEY` appears at HEAD

Every occurrence outside `docs/` and `.claude/orchestration/tasks.json`, from
`grep -rn SERPAPI_KEY` at `6308cb7`, in four groups:

**Non-test code — one file.**
`src/lib/engines/serp.js` at `:23` (the read), `:49` (the `serpFetch` guard) and
`:205`, `:269` (operator warnings). This is the path in §2 — but only `:23` and
`:49` are reached by a live caller, both via `fetchPeopleAlsoAsk`. `:205` and
`:269` are inside `probeGoogleAiOverview`, so at HEAD those two warnings cannot
print: an operator on a `SERPAPI_KEY`-only deployment is never told the key was
rejected, because the code that would say so never runs (§3b).

**Comments that explain the absence — no branch.**
`src/lib/engines/types.js:43`, `:45`.

**A test fixture on the live branch.**
`src/lib/engines/serp.test.mjs:65`, `:109`, `:137`. This half of the original
claim was correct, but its framing was not: the fixture is not leftover, it is
the *only remaining coverage* of the live SerpAPI branch, exercised against a
stubbed `globalThis.fetch` (`serp.test.mjs:47`, `:83`, `:125`). Deleting the
credential means deleting those tests together with the path they cover — which
is why R1.7.3's acceptance says "removed **with their tests**".

**Tests that assert it is *not* a credential — the R0.1.9 guards.**
`src/lib/engines/types.test.mjs` (`:55`, `:71`, `:100`),
`src/lib/health.test.mjs` (`:78`, `:93`, `:110`, `:124`) and
`src/lib/checkSecrets.test.mjs` (`:119`, `:133`, `:140`).
Note the boundary precisely: the drift guard at `types.test.mjs:113-132` reads
only `src/lib/engines/types.js`, `src/lib/health.js` and
`scripts/check-secrets.mjs` (`types.test.mjs:114-118`). **`serp.js` is not in
its source list**, so nothing in the suite would fail if the request path in §2
grew back. The guard protects the capability check, not the spend path.

Note what is *not* in any of those groups: `.env.example`, `README.md`,
`src/lib/health.js` and `scripts/check-secrets.mjs` contain no `SERPAPI_KEY`
reference at all. So the credential is undeclared by every operator-facing
surface while still being honoured by code — a deployment can carry it, and
spend on it, with nothing telling the operator it is live.

**NOT verified here, and deliberately not asserted:**

- **Cost per query, coverage rate, and latency against SerpAPI.** No live
  comparison was run for this document, and none is available in the repository.
  The superseded ADR's `$0.01/query` and `$0.15/scan` figures
  ([`serp-provider.md:25`](./serp-provider.md), `:36`) describe SerpAPI, not
  Bright Data, and must not be read across.
- **The Bright Data per-query cost the product reports is an assumption, not a
  measurement.** `0.0015` is hard-coded in three places and only one of them is
  on a live path. `src/lib/scoring/enginePipeline.js:62`, inside `probeAio`, is
  the copy that flows into every scan's cost total (`:63` adds it to
  `stats.cost`). The other two are dormant: `src/lib/scoring/aioPipeline.js:110`
  sits in `probeQueryOnce`, reachable only from `runAioScan`
  (`aioPipeline.js:171`), which has no caller in the tree; and
  `src/lib/engines/serp.js:287` sits in `probeGoogleAiOverviewBrightData`,
  reachable only through the unreachable `probeGoogleAiOverview` (§3b). Nothing
  in the repository measures the number. Treat any Bright Data spend figure on a
  dashboard as `enginePipeline.js:62` multiplied by a query count — and treat
  three unsynchronised copies of a billing constant as a defect in its own
  right.
- **Whether the zone-discovery fallback behaves correctly against a live
  account.** `npm run check:secrets` (`package.json:15`) is the script that
  answers this, and it has not yet been run against real credentials — rebuild
  task R0.1.6 is `blocked` for exactly that reason, and its own note records
  that the outbound proxy in the build environment refuses the vendor hosts, so
  the endpoint choices are unvalidated.
- **That production has run on Bright Data "for some time."** This is stated in
  *Context* because it is the reason the ADR exists, but deployment history is
  not verifiable from the repository. The only in-repo corroboration is
  `docs/BUILD_JOURNAL.md:37-38`, which reports a real Bright Data answer yield
  of 93.3% on the Italica scan.

## Alternatives

| Option | Why not |
|---|---|
| **SerpAPI** | The prior choice. Demoted in *preference order*, not removed: `serp.js:13-14` still falls through to it when no Bright Data key is present, so it remains reachable and billable (see evidence §2). The reasons for the switch were not recorded at the time and are not reconstructible from the repository. State that plainly rather than invent a rationale. |
| **DataForSEO** | Assessed in the superseded ADR and rejected there for task post-and-get complexity and weaker citation link maps ([`serp-provider.md:23`](./serp-provider.md), `:27`). Nothing has changed that assessment. |

## What would reverse this

- A measured coverage rate for AI Overview blocks materially below what SerpAPI
  achieves on the same prompt set. That comparison needs the R0.4.1 baseline
  corpus to exist first, and it does not: `test_reports/baseline-2026-08/`
  contains its protocol documents and **zero archived scans**, and R0.4.1 is
  `blocked` on credentials.
- Bright Data zone management becoming an operational burden — in particular if
  the "no active serp zone" failure mode recurs. That mode is silent by
  construction: `brightdata.js:29` throws `"No active Bright Data SERP zone found
  on this account."`, and `serp.js:301-307` catches it, warns, and returns
  `google_ai_overview-skipped` with `cost: 0.0`. Every AIO probe then yields
  nothing while the credential still looks valid.
  `scripts/check-secrets.mjs:79` is what surfaces it, reporting
  `FAIL — key works, but no ACTIVE serp zone`.
  **Caveat on that check:** it always calls `get_all_zones` and never reads
  `BRIGHTDATA_SERP_ZONE`, whereas `brightdata.js:10-11` returns that variable
  without any discovery call. So the check can FAIL on an account whose scans
  work, and can PASS while a misconfigured `BRIGHTDATA_SERP_ZONE` fails every
  probe. It answers "does this account have an active serp zone", not "will this
  deployment probe successfully".

## Follow-ups

1. **R1.7.3 — delete the SerpAPI probe path.** Plan it from evidence §2, §3a and
   §3b, not from the superseded text, and do not scope the three `serpFetch` call
   sites as if they were alike. `serp.js:335` (PAA, reached from
   `promptGen.js:127`) is called by live code and spends money today — that is
   the one with a behaviour change behind it, and it is R1.7.4's subject.
   `serp.js:189` and `:224` are inside `probeGoogleAiOverview`, whose only
   non-test caller is the unimportable `adapter.js:24` (§3b); deleting them
   removes dormant code, so do not plan a rollout, a cost saving or a regression
   watch around them. The change also removes the `fetch` at `serp.js:62`, the
   provider-selection branches at `:12` and `:14`, and the tests at
   `serp.test.mjs:44`, `:79`, `:122` that are the only coverage of any of it.
   Sequence it against **R6.5.3**: if R6.5.3 repairs the `adapter.js`/`probe.js`
   pair instead of deleting it, `:189` and `:224` become live before R1.7.3
   lands.
   Worth doing in the same change: add `src/lib/engines/serp.js` to the source
   list of the drift guard at `src/lib/engines/types.test.mjs:114-118`, so that
   the request path cannot grow back unnoticed the way the capability check
   could have (evidence §5).
2. **R1.7.4 — close the prompt-generation spend path.** Evidence §3a. This is the
   half R0.1.9 did not reach, and it is the one that can actually spend money on
   a stale credential. Its acceptance is that a `SERPAPI_KEY`-only deployment
   makes no `serpapi.com` request from `promptGen`. It depends on R1.7.3.
3. ~~Remove the `SERPAPI_KEY` branch from `src/lib/engines/types.js:43`.~~
   **Done — R0.1.9, commit `6308cb7`.** Kept here struck through rather than
   deleted so that a reader arriving from an older link can see it closed rather
   than wonder whether it was dropped.
4. **Replace the "not verified" section with measurements** once R0.4.1's
   baseline corpus exists and `check:secrets` has been run against real
   credentials (R0.1.6). Start with the `$0.0015` constant — the live copy at
   `enginePipeline.js:62`, and its dormant duplicates at `aioPipeline.js:110` and
   `serp.js:287`.

## Correction log

**2026-08-29 — task R0.2.4.** The evidence section as first written asserted:

> `SERPAPI_KEY` survives in exactly two places: `src/lib/engines/types.js:43` […]
> and `src/lib/engines/serp.test.mjs`, which still sets it as a fixture. Neither
> makes a SerpAPI call.

Both halves were false, but not equally so.

- **The `types.js` half was true when written and went stale in 37 minutes.**
  `git show b6e3610:src/lib/engines/types.js` line 43 reads
  `const serpConfigured = process.env.BRIGHTDATA_API_KEY || process.env.SERPAPI_KEY;`
  — exactly what the ADR described, at the commit that added the ADR
  (`b6e3610`, 2026-08-29 16:01:49). R0.1.9 removed it at `6308cb7`, 16:39:04 the
  same day. The citation was honest; it simply outlived its line.
- **"Neither makes a SerpAPI call" was never true at any commit.** `serp.js:62`
  issues a live request to `serpapi.com`, called from three sites in the file
  (`:189`, `:224`, `:335`), and charges `$0.01` a query at `:212`. *Read this
  with the second-round entry below: only `:335` has a live caller, so the
  spend that disproves the original claim is the PAA one.*
  `git diff b6e3610 HEAD -- src/lib/engines/serp.js` is empty: the file has not
  changed since the ADR was written. The related claim that Bright Data
  "is the only SERP provider actually invoked for AIO probing" was false for the
  same reason.

**Why it matters, and how it was found.** R1.7.3 was scoped from this section, so
the error was on its way into an implementation plan that would have treated a
billable code path as dead weight. It was caught by the R0.1.9 implementer, who
declined to delete `serp.js` on the ADR's authority and read the file instead
(their submission note in `.claude/orchestration/tasks.json` records: *"the
SerpAPI request path there is genuinely LIVE ... the ADR's claim that it is dead
is wrong as written"*), and confirmed by the R0.1.9 verifier, who filed R1.7.4
for the spend path.

**The lesson, stated as a rule rather than a diagnosis.** How the original author
arrived at the claim is not recorded anywhere in the repository, so this ADR does
not assert a cause. What is checkable is the trap: `SERPAPI_KEY` is absent from
`.env.example`, `README.md`, `src/lib/health.js` and `scripts/check-secrets.mjs`,
so a credential search across the operator-facing surfaces returns a picture of a
retired provider. The surviving reference lives inside a provider-resolution
function whose *return value* — not its name — is what routes the request. Grep
finds candidates; only reading the call graph confirms semantics.

---

**2026-08-29, second round — task R0.2.4, §3b, and the same error found in four
more places.** The correction above turned "this code is dead" into "this code
is live" and over-shot. §3b as first rewritten said that with
`ENGINES_ENABLED=google_ai_overview` set, in the default `hybrid` mode:

> the chain runs unimpeded: `probe.js:99-101` → `probePromptOnce` → `probe.js:30`
> `probeEngine(...)` → `adapter.js:24` → `probeGoogleAiOverview` → `serpFetch` at
> `serp.js:189`

and §3 was headed "Two distinct paths still reach that code at HEAD".

Every `file:line` in that chain was correct. The chain cannot execute:
`adapter.js:3` imports a name `openai.js` does not export, so both `adapter.js`
and `probe.js` throw at link time; nothing imports `probe.js` in any case; and
the function the bypass lives in, `getEnabledEngines()`, has no live caller. One
path reaches the SerpAPI code, not two.

**That is the mirror image of the error this task was filed to fix, made inside
the section written to fix it.** First the document said code was dead when it
was live and billable; then it said code was live when it was dead. The
mechanism was identical both times, and is worth stating as a rule rather than an
apology: *every line was verified, and the arrows between the lines were not.* A
citation proves a line exists and says what is claimed of it. It does not prove
that anything calls it. Liveness is a second, separate check — walk backwards
from `scanWorker.js` to the line, or import the module and see whether it loads.
Both were done this round, by execution rather than by reading.

Corrected in this round:

- **§3's heading**, which asserted two live paths where there is one.
- **§3b.** The `ENGINES_ENABLED` bypass at `types.js:32-37` is real and is kept;
  what is now stated is that it has no live consumer (`getEnabledEngines()`'s
  only non-test caller is `probe.js:70`; live selection is
  `resolveEnabledEngines()` on `ENGINES`) and that the chain it would feed is
  unreachable. Cross-referenced to **R6.5.3**, the ledger task for the dead pair.
- **§2's table, plus a note under it**, separating the one live billable
  `serpFetch` (`serp.js:335`, via `promptGen`) from the two dormant ones
  (`:189`, `:224`) and the `$0.01` charges at `:212`/`:230` that sit with them.
- **Follow-up #1**, so R1.7.3 is not scoped as though all three call sites were
  live.

Four further claims of the same class surfaced while re-checking, and are
corrected in the same pass rather than left for a third round:

- **§1's Bright Data bullet at `serp.js:164-165`** — true of the function's
  contents, but not the route a scan takes. The live route is
  `scanWorker.js:1088` → `runProbingPhase` (`:460`) → `resolveEnabledEngines()`
  (`enginePipeline.js:488`) → `probeAio` (`:28`) → `brightDataSearch` (`:52`).
- **§4's "a stale key no longer makes an unconfigured deployment look configured
  at boot"** — overstated. `getEnabledEngines()` has no live caller, and the
  boot-facing surfaces (`health.js:19-29`, `scripts/check-secrets.mjs`) never
  read `SERPAPI_KEY`. R0.1.9's fix is real but preventive.
- **The `$0.0015` cost claim**, which attributed to `serp.js:287` a number that
  actually reaches every scan total from `enginePipeline.js:62`, with a third
  dormant copy at `aioPipeline.js:110`. Follow-up #4 now names all three.
- **§5's "live code" group**, which listed the operator warnings at
  `serp.js:205` and `:269` alongside the genuinely reached `:23` and `:49`. Those
  two warnings are inside `probeGoogleAiOverview` and cannot print at HEAD — a
  detail that matters at 2am, because it means a rejected `SERPAPI_KEY` produces
  no message from the AIO path at all.

**How the break happened, and what is still not verified.** `a1ed0e0`
(2026-07-23, *feat(engines): ChatGPT + Perplexity probe adapters*) replaced
`openai.js`'s `probeOpenAI` export with `probeChatGpt` and did not update
`adapter.js`; `git show 5f6dbd9:src/lib/engines/openai.js` still exports
`probeOpenAI`. No test failed, because no test imports `adapter.js` or
`probe.js`. Whether that pair was ever exercised in production *before*
`a1ed0e0` — and therefore whether `serp.js:189`/`:224` ever billed anyone — is
not answerable from this repository, for the same reason the *Context* claim
about deployment history is not: no deployment record is checked in here.
