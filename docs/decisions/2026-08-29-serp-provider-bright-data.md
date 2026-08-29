# ADR — Bright Data is the SERP provider for Google AI Overview

> <!-- doc-status -->
> **Status: LIVE.** Supersedes
> [serp-provider.md](./serp-provider.md), which chose SerpAPI.

**Date:** 2026-08-29
**Supersedes:** [`docs/decisions/serp-provider.md`](./serp-provider.md) (SerpAPI vs DataForSEO)
**Status:** accepted, and already shipped — this ADR is being written *after* the
fact, which is the reason it exists.
**Evidence corrected:** 2026-08-29, task R0.2.4. The decision below is unchanged
and not in question. The evidence offered for it was wrong; see
*[Correction log](#correction-log)*.

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

**Every line cited below was read at commit `6308cb7`.** If you are reading this
at a later commit, re-read before you act on it.

### 1. Bright Data is what runs when `BRIGHTDATA_API_KEY` is set

- `src/lib/engines/serp.js:13` — `if (getBrightDataApiKey()) return "brightdata";`
  is evaluated *before* the SerpAPI fallback in `getSerpProvider()`, so a
  deployment holding both credentials uses Bright Data.
- `src/lib/engines/serp.js:164-165` — `probeGoogleAiOverview` returns
  `probeGoogleAiOverviewBrightData(...)` as soon as the provider is `brightdata`,
  before any SerpAPI request is built.
- `src/lib/engines/serp.js:323-325` — the People-Also-Ask path takes the Bright
  Data branch and `continue`s, never reaching `serpFetch`.
- `src/lib/engines/types.js:47` — `getEnabledEngines()` enables
  `google_ai_overview` on `BRIGHTDATA_API_KEY` alone.

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
| AIO probe → SerpAPI | `src/lib/engines/serp.js:189` | `const res = await serpFetch(searchParams, ...)` |
| Second billed call | `src/lib/engines/serp.js:224` | deferred `page_token` follow-up, a second `serpFetch` |
| PAA → SerpAPI | `src/lib/engines/serp.js:335` | `const res = await serpFetch(searchParams);` |
| Cost is charged | `src/lib/engines/serp.js:212`, `:230` | `let cost = 0.01;` then `cost += 0.01;` for the deferred fetch |

### 3. Two distinct paths still reach that code at HEAD

**a. Prompt generation — ungated, and this is the live spend risk.**
`src/lib/scoring/promptGen.js:2` imports `fetchPeopleAlsoAsk` from
`../engines/serp.js`, and `promptGen.js:127` uses it as the default when the
caller passes no `deps` override. `fetchPeopleAlsoAsk` gates only on
`isSerpConfigured()` (`serp.js:312`) → `getSerpProvider()` (`serp.js:317`), which
returns `"serpapi"` on a stale key. **It never consults `getEnabledEngines()`.**
A deployment holding only `SERPAPI_KEY` therefore makes a live `serpapi.com`
request at prompt-generation time and spends money the capability check says it
cannot. This is ledger task **R1.7.4**.

**b. The AIO probe — gated, but the gate has a documented bypass.**
`src/lib/scoring/probe.js:70` calls `getEnabledEngines()`, which since R0.1.9
requires `BRIGHTDATA_API_KEY` (`types.js:47`). But `types.js:32-37` returns an
explicit `ENGINES_ENABLED` list *without any credential check*, so
`ENGINES_ENABLED=google_ai_overview` with only `SERPAPI_KEY` set puts
`google_ai_overview` into `activeEngines`, and in the default `hybrid` mode the
chain runs unimpeded: `probe.js:99-101` → `probePromptOnce` → `probe.js:30`
`probeEngine(...)` → `adapter.js:24` → `probeGoogleAiOverview` → `serpFetch` at
`serp.js:189`. `src/lib/engines/types.test.mjs:90-97` asserts exactly this env
combination and records that the branch was left alone deliberately: an operator
naming an engine is a different claim from a key being present.

### 4. What R0.1.9 closed, and what it did not

This distinction matters, because the previous version of this section let a
reader conclude the whole `SERPAPI_KEY` question was closed.

- **Closed.** R0.1.9 (commit `6308cb7`) removed the `SERPAPI_KEY` branch from the
  **capability check**. `src/lib/engines/types.js:47` now reads
  `BRIGHTDATA_API_KEY` only, with a comment at `:43-46` naming this ADR.
  Covered by `src/lib/engines/types.test.mjs:55`, `:65`, `:71`. A stale key no
  longer makes an unconfigured deployment look configured at boot.
- **Not closed.** R0.1.9 did not touch `src/lib/engines/serp.js` at all. The
  **spend path** in the table above is unchanged by it. Do not read
  "types.js is fixed" as "SerpAPI is gone".

### 5. Where `SERPAPI_KEY` appears at HEAD

Every occurrence outside `docs/` and `.claude/orchestration/tasks.json`, from
`grep -rn SERPAPI_KEY` at `6308cb7`, in four groups:

**Live code — one file.**
`src/lib/engines/serp.js` at `:23` (the read), `:49`, `:205` and `:269`
(operator messages). This is the path in §2.

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
  measurement.** `src/lib/engines/serp.js:287` hard-codes `const cost = 0.0015;`
  and that number flows into every scan's cost total. Nothing in the repository
  measures it. Treat any Bright Data spend figure on a dashboard as this
  constant multiplied by a query count.
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

1. **R1.7.3 — delete the SerpAPI probe path.** Plan it from evidence §2 and §3,
   not from the superseded text: the deletion removes a *live* `fetch` to
   `serpapi.com` at `serp.js:62` reached from `:189`, `:224` and `:335`, plus its
   provider-selection branches at `:12` and `:14`, plus the tests at
   `serp.test.mjs:44`, `:79`, `:122` that are the only coverage of it.
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
   credentials (R0.1.6). Start with the `$0.0015` constant at `serp.js:287`.

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
  issues a live request to `serpapi.com`, reached from three call sites
  (`:189`, `:224`, `:335`), and charges `$0.01` a query at `:212`.
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
