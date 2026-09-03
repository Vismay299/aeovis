# `docs/vendors/` — scope and index

> <!-- doc-status -->
> **Status: LIVE.** This file defines what belongs in this directory and
> records, with reasons, the integrations that deliberately have no file here.

**Date:** 2026-09-03 · **Task:** R6.3.1, with the GSC entry under R0.1.6 and
Rule 4 + ["The R6.5.6 drift"](#the-r656-drift-and-the-guard-that-was-not-built)
under R6.3.2 · **Verified at:** `ef9909b`

## What this directory is for

One file per vendor we make a network call to, each carrying **the response
shape the code actually reads** and **the quirks that have cost us time**. Not
a copy of the vendor's documentation — a record of what this repo observed,
where the two differ, and which of our assumptions turned out to be wrong.

Four rules, because each exists to prevent a specific failure that has already
happened here:

1. **Every `file:line` must resolve at the commit the doc is written on, and
   must be read before it is written down.** Two citations in
   [`mimo.md`](./mimo.md) drifted onto unrelated code and had to be repointed
   under R6.3.1; a citation that resolves to the wrong line teaches the reader
   to distrust the whole file.
2. **Existence is not liveness.** Before describing a call site as live, trace
   it to a route file or a `vercel.json` cron entry. Before calling one dead,
   grep for importers **static *and* dynamic**, and grep `scripts/` and
   `worker/` as well as `src/`. [`gemini.md`](./gemini.md) has a worked example
   in both directions: a live route whose only shipped UI caller is orphaned,
   and three importers of the same client that nothing reaches. The GSC entry
   under "Deliberate omissions" below is the counter-example — this file
   claimed "exactly one importer" while an `await import()` in
   `scripts/check-secrets.mjs` was the second.
3. **A quirk that has been fixed must be rewritten as fixed, with the commit or
   the current line range.** A doc asserting a resolved bug as current is worse
   than no doc. See the R0.1.10 entry in [`brightdata.md`](./brightdata.md), and
   quirk 3 of [`gemini.md`](./gemini.md), which asserted a bug fixed in
   `ee5504e` as current for one commit —
   ["The R6.5.6 drift"](#the-r656-drift-and-the-guard-that-was-not-built) below.
4. **Verify against the committed blob, not the working tree.** `grep`, `sed`
   and your editor all read the working tree. With several implementers on one
   branch, a cited file can be two different files at once. Use
   `git show HEAD:<file>`. This rule was added after a citation in `gemini.md`
   was "corrected" from `:94` to `:95` on the strength of a dirty worktree, when
   `:94` was right at HEAD — and then `:95` became right three commits later,
   before the doc was submitted. Both numbers were true somewhere. Neither was
   a citation.

Every file here carries a `<!-- doc-status -->` header. The guard is
`src/lib/docStatus.test.mjs`, which walks `docs/` and fails on an unheadered
file.

### A note on citing `check-secrets.mjs`

Rule 1 above says a `file:line` must resolve. Some files these docs cite carry
**no** line numbers, on purpose. The first was `scripts/check-secrets.mjs`;
R6.3.2 added three more, listed at the end of this section.

It drifted three times during the R6.3.1 revision — once between reading it and
writing the doc, twice more between writing and submitting — because a
concurrent task was editing it (then R2.10.1's engine-advertising check; at the
time of writing, a fix to the `brightdata` entry). Each drift silently
repointed roughly a dozen citations onto neighbouring code: the
`max_completion_tokens` branch became a comment, the Perplexity token cap became
a different comment, and `name: "gsc"` became a closing brace. A wrong line
number is worse than no line number, so these docs name **the vendor entry and a
greppable string** instead — "the `perplexity` entry", "grep `max_tokens: 16`".
The churn is real and ongoing: between two greps taken minutes apart during this
revision, `await import("../src/lib/engines/gsc.js")` moved from `:299` to
`:305`.

**A greppable string only survives the churn if it exists.** An earlier
revision asserted that it does, without checking. All eight such citations in
this directory were then grepped one by one, and **two returned zero hits**:

| Citation | Resolves? |
|---|---|
| `brightdata.md:62` — `does not exist on this account` | yes |
| `brightdata.md:63-64` — `not an active serp zone` | yes |
| `brightdata.md:65` — ~~`so probes will use`~~ → `AUTO-DISCOVERED` | **no** — the old string was split across a template concatenation and matched nothing repo-wide; repointed |
| `gemini.md:79` — `generativelanguage` | yes (was `:56`; R6.3.2 rewrote that file) |
| `mimo.md:48` — `const cap =` | yes |
| `mimo.md:124` — `name: "llm"` | yes |
| `perplexity.md:172` — `max_tokens: 16` | yes |
| GSC omission below — ~~`offline check only`~~ → `listGscSites` | **no** — the old string existed only in a test asserting its absence; repointed |

The rule this leaves behind: **grep the string before you write it down**, the
same way Rule 1 requires reading the line.

Three more files joined that list under R6.3.2, for the same reason and with
the same remedy: `src/middleware.js`, `src/lib/operatorPerimeter.js` and
`src/lib/operatorPerimeter.test.mjs` are all being edited by concurrent tasks
as this is written. Every other file cited in this directory is pinned by line
and was asserted to contain the code described.

## The R6.5.6 drift, and the guard that was not built

**Decision, 2026-09-03 (R6.3.2). A test that parses `file:line` citations out of
`docs/vendors/*.md` and asserts they resolve will NOT be built. A doc-staleness
tripwire is recommended in its place, and is filed rather than built here.**

An ADR under `docs/decisions/` is the right long-term home for this; it is
recorded here because R6.3.2's blast radius is `docs/vendors/` only.

### What happened

`ee5504e` (R6.5.6) fixed the inert abort signal in `src/lib/gemini.js`, adding
thirty lines. [`gemini.md`](./gemini.md) had described that bug as current the
day before. The fix did not touch the doc, so for one commit the file asserted a
resolved bug as live, its quirk-3 heading was false, and **thirteen**
`gemini.js` citations pointed at unrelated code — one of them at the comment
block the fix itself added. Nothing failed.

### Why the suite did not catch it

`src/lib/docStatus.test.mjs` is the only guard over `docs/`. Its ten `test(`
blocks cover status headers, the three permitted header values, `SUPERSEDED-BY`
targets, the single-live-design-authority rule, the close rule, three ADR rules
and the README migration table. Its walker (`docStatus.test.mjs:19-30`) collects
`.md` files and reads them **as text**; it never opens a cited source file. No
other test does either.

### Why the obvious guard was rejected

Measured with a throwaway prototype over all nine files in this directory as
they stood at `18fa380` — that is, **including the broken `gemini.md`**, which
is the corpus the argument needs:

| Question | Measured |
|---|---|
| citations of the form `path/file.ext:N` or `:N-M` | **161** |
| bare `` `:312` ``-style citations that inherit their file from surrounding prose | **41** |
| of the 13 broken `gemini.md` citations, how many an **existence** check would catch | **0** |
| named citations that give only a bare filename (`route.js`, `scanWorker.js`, `StudioView.jsx`) | **15** |

Those four numbers are the whole argument:

- **Existence is not the failure mode.** `gemini.js` is 108 lines. Every one of
  the thirteen stale numbers was under 108, so "the file has that many lines"
  passes on all thirteen. A guard that is green on the exact defect that
  prompted it is worse than none — it converts an open question into a false
  assurance.
- **Resolution is a guess.** 15 citations name a file that is ambiguous
  repo-wide. The prototype needed a hand-tuned search path and still left those
  15 unresolved; a stricter resolver fails *correct* citations, and a looser one
  silently checks the wrong file.
- **Content matching needs 202 new hand-written claims.** To assert a line
  *contains* something, the expectation has to be authored per citation. Each
  annotation then rots in a nastier way than the citation it guards: when the
  expected substring moves, the guard goes looking for it, finds it at the new
  line, and passes — while the doc still prints the old number. That is a silent
  false negative, which is precisely the class of failure this directory exists
  to remove.
- **The bare-`:N` third of the corpus is not machine-readable at all.** Those 41
  inherit their file from English prose.

### What is recommended instead

A **staleness tripwire**: record the set of source files each doc cites, and
fail when one of those files changes in a commit that does not also touch the
doc. It proves nothing about correctness — it says only *"a file this doc cites
moved; re-derive."* That is the correct strength, because re-derivation by a
human is the only thing that has ever actually worked here.

Measured on the same corpus:

| Question | Measured |
|---|---|
| distinct doc → source-file edges to maintain (vs 202 citations) | **34** |
| times it would have fired over the last 40 commits | **7** |
| would it have fired on `ee5504e`, the commit that caused this | **yes** |

One firing per ~6 commits, against a manifest a fifth the size of the citation
set, catching the actual incident. **This is a recommendation, not a result: the
tripwire has not been built and has never run in CI.** Two known costs are
unmeasured — the noise from whitespace- or comment-only edits to a cited file,
and the "reviewed-at" bump ritual it forces on every doc author.

It cannot be built from here. `npm run test:scoring` runs `src/**/*.test.mjs`
(`package.json:11`), so any guard must live under `src/`, and R6.3.2 may only
write to `docs/vendors/`. **It needs its own ledger item, owning `src/`.**

### The mitigation that is in place today

[`gemini.md`](./gemini.md) now carries a **`Verified at:` commit** next to its
date (`gemini.md:9`). It is currently the **only** file in this directory that
does; the other eight carry a date alone, which does not identify a tree. That
one line reduces the check to a single command a reader can run by hand:

```
git log --oneline <verified-at-commit>..HEAD -- <the files that doc cites>
```

Non-empty output means re-derive before trusting the file. This is manual and
fires only when someone thinks to run it. Saying so is the point: the gap is
open, and it is written down rather than papered over.

## Index

| File | Vendor | Status |
|---|---|---|
| [`brightdata.md`](./brightdata.md) | Bright Data SERP — the Google AI Overview engine | LIVE |
| [`perplexity.md`](./perplexity.md) | Perplexity — API path only; the UI path is R1.3 | LIVE (API) |
| [`chatgpt.md`](./chatgpt.md) | OpenAI Responses API | LIVE, but **not deployed** — `OPENAI_API_KEY` unconfigured |
| [`gemini.md`](./gemini.md) | Google Gemini — one operator route, not a probed engine | LIVE |
| [`firecrawl.md`](./firecrawl.md) | Firecrawl — page scraping for prompt generation and research | LIVE |
| [`mimo.md`](./mimo.md) | Xiaomi MiMo — the utility LLM gateway | LIVE |
| [`suggestqueries.md`](./suggestqueries.md) | Google Autocomplete — ungated, uncredentialed prompt seeding | LIVE |
| [`gateway-catalog.md`](./gateway-catalog.md) | Cross-vendor rule, not a vendor | LIVE |

## Deliberate omissions

Absence with a stated reason is a decision. Absence without one is a gap. These
two are decisions.

### Google Search Console — no doc, because nothing *served* reads it

`src/lib/engines/gsc.js` signs a service-account JWT with node's own `crypto`
(`gsc.js:78`), exchanges it at `https://oauth2.googleapis.com/token`
(`gsc.js:15`) and reads `https://searchconsole.googleapis.com/webmasters/v3`
(`gsc.js:16`).

It has **two importers, and one of them is dynamic** — the reason an earlier
revision of this paragraph got it wrong:

- `scripts/test-gsc.mjs:17` — a static import, run by `npm run test:gsc`
  (`package.json:13`).
- `scripts/check-secrets.mjs`, the `gsc` entry — an `await import()` of
  `gsc.js` followed by `await listGscSites()`. Grep `listGscSites`. Run by
  `npm run check:secrets` (`package.json:15`).

**That second one makes a live authenticated Search Console call.** Until
2026-09-03 this paragraph said the opposite — that the `gsc` entry "validates
the key's shape offline… explicitly making no live call — grep `offline check
only`". That string occurs nowhere in the script. Its only occurrence **in
code** is `src/lib/checkSecrets.test.mjs:206`, a **guard asserting it must not
appear** ("the offline-only disclaimer is obsolete — the check is live"). Scoped
to *code* on purpose: the retired string also survives as quotation in this
directory's own prose — in the table above, and in the sentence you just read —
so "nowhere in the tree" would be false by self-reference. The doc cited, as
evidence of offline-ness, a string a passing test exists to keep absent.
Recorded here rather than quietly deleted, because it is the failure Rule 2
above is about.

Re-verified at HEAD by sweeping `src`, `scripts`, `worker` and `supabase` for
`engines/gsc`, `GSC_SERVICE_ACCOUNT_KEY` and every symbol `gsc.js` actually
exports (`getGscServiceAccount`, `listGscSites`, `candidateSiteUrls`,
`fetchSearchQueries`, `fetchSearchQueriesForUrl`). Outside the module that
sweep returns exactly **four** files: the two scripts above; the test of one of
them, `src/lib/checkSecrets.test.mjs` (`test-gsc.mjs` has no test); and one
non-call, `src/lib/health.js:31`, which reports only whether the credential is
*configured*. `src/lib/db.js:37,425` is deliberately **not** in that list: those
lines are the `gsc_queries jsonb` column written as `[]`, they match none of the
seven terms, and they surface only under a looser case-insensitive grep for
`gsc` — alongside that column's migration
(`supabase/migrations/001_initial_schema.sql:65,99`) and the test that pins it
empty (`src/lib/scoring/asyncJob.test.mjs:24`). The only write to that column
anywhere in the tree is the `[]` at `db.js:425`. No route file imports
`gsc.js`, and neither `vercel.json` cron path (`/api/scan/worker`,
`/api/content/worker`) reaches it.

**The rationale, restated, because the old one is now false.** It used to read
"nothing running depends on this one". Something running does: `check:secrets`
depends on `listGscSites()`'s **response shape** — `sites.length` drives the
operator-facing text, including the "the key works but is not yet a user on any
property" qualifier. The narrower claim that survives is that **no served path
reads a GSC response**: no route, no cron, no worker, so no scan result and no
score is derived from one.

So that the one shape an operator surface now depends on is written down
somewhere: `listGscSites()` reads `GET /webmasters/v3/sites` and maps
`data.siteEntry` to `{ siteUrl, permissionLevel }` (`gsc.js:132-138`).
`siteEntry` is **optional** — its absence is normalised to `[]` at `gsc.js:134`,
which is why a service account that authenticates but is a user on no property
reports zero rather than failing.

**This decision reverses on either of two triggers**, not one:

1. A route, a cron or a worker imports `gsc.js` — then it needs a file here
   before it ships, not after.
2. `check:secrets` starts reading more of the response than `sites.length` — at
   that point an operator surface depends on a shape nobody has recorded, and
   the four lines above stop being enough.

### SerpAPI — no standalone doc, because it is superseded

SerpAPI is still **reachable**, not dead. `getSerpProvider()`
(`src/lib/engines/serp.js:10-17`) selects it when either
`SERP_PROVIDER=serpapi` with a resolvable `SERPAPI_KEY` (`:13`), or
`BRIGHTDATA_API_KEY` is absent and `SERPAPI_KEY` is present (`:15`). On that
branch `fetchPeopleAlsoAsk` (`:312`) hits `https://serpapi.com/search` (`:63`),
and that path is cron-**reachable**: `/api/scan/worker` → `runScanChunk`
(`scanWorker.js:1110`) → `runSourcingPhase` (`:1164`, defined `:374`) →
`sourceUnbrandedQueries` (`:398` → `:129`) → `generateUnbrandedPrompts`
(`:132`, `promptGen.js:2,128-129`) → `paaFn` (`promptGen.js:199`, and `:251` on
the top-up path).

Reachable is not the same as taken. The same early return described in the
callout below (`scanWorker.js:197-205`) sits in the middle of that chain, so on
a domain whose frozen prompt set is already at target the chain stops at
`sourceUnbrandedQueries` and SerpAPI is never called either.

> **`fetchAutocomplete` is NOT on that branch and does not touch SerpAPI.**
> `serp.js:372` calls `https://suggestqueries.google.com/complete/search`
> with no provider gate and no credential — contrast `fetchPeopleAlsoAsk`,
> which returns `[]` behind `isSerpConfigured()` at `serp.js:313`. An earlier
> version of this section grouped the two, which would have hidden an outbound
> call to a *different* vendor inside the "SerpAPI is superseded" bucket. It is
> no longer undocumented: it has its own file,
> [`suggestqueries.md`](./suggestqueries.md), carrying the `data[1]` response
> shape and the fact that **every** failure mode of that call returns `[]`
> without throwing.
>
> **But it is not called on every scan, and an earlier draft of this callout
> said it was.** That draft claimed deleting the SerpAPI adapter under
> **R1.7.3** would leave `fetchAutocomplete` "calling Google on every
> prompt-sourcing run". It would not. `sourceUnbrandedQueries` early-returns
> the stored frozen set when `existing.length >= target`
> (`scanWorker.js:197-205`), so `generateUnbrandedPrompts` — autocomplete's
> only non-test caller (`promptGen.js:2,128-129`) — is never entered. Under
> the locked frozen-prompt-set contract that is the steady state. Executed
> with injected deps: 30 stored prompts against a target of 30 →
> `generateUnbrandedPrompts` called **0 times**; 29 stored → called **once**.
> Autocomplete fires on a **first scan for a domain**, or when the stored set
> is short of target. The R1.7.3 point still stands on its own terms —
> deleting the SerpAPI adapter does not remove this call, because it shares no
> gate and no client with it — so it needs its own decision, not inheritance
> from SerpAPI's.

It gets no file here for two reasons:

- **The decision is already written down, as an ADR**, which is the right
  artifact for a supersession:
  [`docs/decisions/2026-08-29-serp-provider-bright-data.md`](../decisions/2026-08-29-serp-provider-bright-data.md),
  superseding [`docs/decisions/serp-provider.md`](../decisions/serp-provider.md).
  `brightdata.md`'s "What is NOT measured" section points at it — heading at
  `brightdata.md:97`, ADR link at `:101`. (An earlier revision cited
  `brightdata.md:91-95`, a range containing no ADR reference at all; and the
  correction to `:94-98` went stale within the same edit session, because
  repointing the `AUTO-DISCOVERED` grep string three sections above added lines.
  Both numbers above were re-derived after the last edit to that file.)
  `src/lib/docStatus.test.mjs:103-135` enforces the supersession marker and the
  absence of unmeasured cost claims.
- **A response-shape doc would be a liability here**, because it would read as
  an invitation to keep the path alive. The plan is the opposite: `R1.7.3`
  ("Demote API adapters to explicit fallback; delete dead paths").

The live risk on this branch is filed, not documented here: `R1.7.4`
("fetchPeopleAlsoAsk bypasses the engine capability gate and can spend on a
stale SERPAPI_KEY"), status `todo`. **If SerpAPI is ever promoted back to a
primary provider, it needs a file in this directory first** — the superseded
ADR's per-query cost and coverage figures were never measured against this
system and must not be reused.

## Not covered here

Supabase and Vercel are platform dependencies rather than answer-engine
vendors, not sources of answers whose response shape a scan reads. What exists
for them today is the Database section of the **root** `README.md` (`:142`) and
its Setup section (`:74`) — not this directory's `README.md`. `docs/RUNBOOK.md` does **not** exist yet — it is `R6.2.2` ("seeded with
10 symptom rows"), `todo` — so do not follow a link to it from anywhere.

---

*Every `file:line` above was read and asserted to contain the code it
describes. The citations added under R6.3.2 (`docStatus.test.mjs:19-30`,
`package.json:11`, `gemini.md:9`) were checked against the **committed blob**
via `git show HEAD:<file>`, per Rule 4 — at `18fa380`, and again at `ef9909b`
after HEAD moved mid-revision — not against the working
tree, which several concurrent tasks had dirty as this was written. The R6.3.1 citations
above were re-checked the same way, including
`docs/RUNBOOK.md` still being absent and `R6.2.2` still `todo`.*

*`scripts/check-secrets.mjs`, `src/middleware.js`,
`src/lib/operatorPerimeter.js` and `src/lib/operatorPerimeter.test.mjs` are
cited by name and greppable string rather than by line, because concurrent
tasks are editing all four — see
[the note above](#a-note-on-citing-check-secretsmjs).*

*The counts in ["The R6.5.6 drift"](#the-r656-drift-and-the-guard-that-was-not-built)
— 161, 41, 15, 0, 34 and 7 — were produced by running two throwaway prototypes
over this directory and over `git log -40`. The prototypes were not kept: they
are evidence for a decision, not a shipped guard, and leaving a parser in the
tree that nothing runs would be its own finding.*
