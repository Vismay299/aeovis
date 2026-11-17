# `docs/vendors/` — scope and index

> <!-- doc-status -->
> **Status: LIVE.** This file defines what belongs in this directory and
> records, with reasons, the integrations that deliberately have no file here.

**Date:** 2026-09-04 · **Task:** R6.3.1, with the GSC entry under R0.1.6 and
Rule 4 + ["The R6.5.6 drift"](#the-r656-drift-and-the-guard-that-was-not-built)
under R6.3.2 · **Verified at:** `b35e387`

> **How to tell whether this file has gone stale.** Every live line citation
> below points into one of **ten** tracked source files, and the most recently
> touched of them was last changed by `6c8193b`:
>
> ```
> git log --oneline 6c8193b..HEAD -- src/shared/engines/serp.js src/shared/engines/gsc.js \
>   src/server/health.js src/server/db.js src/server/docStatus.test.mjs \
>   src/server/checkSecrets.test.mjs src/shared/scoring/asyncJob.test.mjs \
>   scripts/test-gsc.mjs package.json supabase/migrations/001_initial_schema.sql
> ```
>
> Empty means every line number below is still the one that was read; it was
> empty at `b35e387`. Non-empty means **re-derive before trusting this file.**
>
> Two sets are deliberately off that list. Six churning files are cited by
> greppable anchor instead of by line — `src/server/workers/scanWorker.js`,
> `src/shared/scoring/promptGen.js`, `scripts/check-secrets.mjs`,
> `src/middleware.js`, `src/server/operatorPerimeter.js` and
> `src/server/operatorPerimeter.test.mjs`; see
> ["A note on citing `check-secrets.mjs`"](#a-note-on-citing-check-secretsmjs).
> And four **sibling docs in this directory** carry ten line citations between
> them — `brightdata.md` (`:62`, `:63-64`, `:65`, `:91-95`, `:97`), `mimo.md`
> (`:48`, `:124`), `perplexity.md` (`:172`) and `gemini.md` (`:9`, plus `:79`
> which is [recorded as wrong](#a-note-on-citing-check-secretsmjs), not cited).
> They are excluded because this file and `gemini.md` are revised in the same
> commits, so a tripwire over them would fire on itself. Re-derive those by
> opening them; all ten were resolved by hand at `b35e387`.
>
> This command is the same manual control `gemini.md` carries. It was added
> here after [a second drift](#a-second-drift-98df5c8-2026-09-04) broke six of
> this file's own citations with nothing noticing.

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
`src/server/docStatus.test.mjs`, which walks `docs/` and fails on an unheadered
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
revision, `await import("../src/shared/engines/gsc.js")` moved from `:299` to
`:305`.

**A greppable string only survives the churn if it exists.** An earlier
revision asserted that it does, without checking. All eight such citations in
this directory were then grepped one by one, and **two returned zero hits**:

| Citation | Resolves? |
|---|---|
| `brightdata.md:62` — `does not exist on this account` | yes |
| `brightdata.md:63-64` — `not an active serp zone` | yes |
| `brightdata.md:65` — ~~`so probes will use`~~ → `AUTO-DISCOVERED` | **no** — the old string was split across a template concatenation and matched nothing repo-wide; repointed |
| `gemini.md`, the **Auth** row of its Contract table — `generativelanguage` | yes, the string is in `check-secrets.mjs`. **But the pointer to it was fiction**, see below |
| `mimo.md:48` — `const cap =` | yes |
| `mimo.md:124` — `name: "llm"` | yes |
| `perplexity.md:172` — `max_tokens: 16` | yes |
| GSC omission below — ~~`offline check only`~~ → `listGscSites` | **no** — the old string existed only in a test asserting its absence; repointed |

The rule this leaves behind: **grep the string before you write it down**, the
same way Rule 1 requires reading the line.

**The `gemini.md` row above was itself wrong, in the row that audits wrongness.**
It read `` `gemini.md:79` — `generativelanguage` ``, annotated "(was `:56`;
R6.3.2 rewrote that file)". The *grep string* resolved, which is what the table
was auditing, so the row was scored `yes` — but `:79` was never the line it sat
on. Checked at all four commits R6.3.2 touched:

| Commit | `gemini.md:79` actually says | `generativelanguage` is at |
|---|---|---|
| `18fa380`, `ef9909b`, `86c1f07` | the `response.text()` row of the response-shape table | `:1`, `:21`, `:55`, `:56` |
| `b35e387` | a sentence about the `:94`/`:95` perimeter row | `:1`, `:61`, `:109`, `:110` |

`:56` was right before the rewrite, and `:79` was right at no commit at all: it
was a number adjusted by estimate for a rewrite that had already happened,
which is Rule 4's failure in its purest form. It is repointed above to the
**Auth row of `gemini.md`'s Contract table**, by name, and this row is the
reason the four sibling-doc citations are excluded from this file's staleness
command — two docs revised in the same commit cannot pin each other by line.

Three more files joined the anchor list under R6.3.2 and two more under this
revision, for the same reason and with the same remedy: `src/middleware.js`,
`src/server/operatorPerimeter.js` and `src/server/operatorPerimeter.test.mjs` are
being edited by concurrent tasks as this is written, and
`src/server/workers/scanWorker.js` and `src/shared/scoring/promptGen.js` joined them
after [the second drift](#a-second-drift-98df5c8-2026-09-04). Every other file
cited in this directory is pinned by line and was asserted, at `b35e387`, to
contain the code described.

## The R6.5.6 drift, and the guard that was not built

**Decision, 2026-09-03 (R6.3.2). A test that parses `file:line` citations out of
`docs/vendors/*.md` and asserts they resolve will NOT be built. A doc-staleness
tripwire is recommended in its place, and is filed rather than built here.**

An ADR under `docs/decisions/` is the right long-term home for this; it is
recorded here because R6.3.2's blast radius is `docs/vendors/` only.

### What happened

`ee5504e` (R6.5.6) fixed the inert abort signal in `src/shared/gemini.js`, adding
thirty lines. [`gemini.md`](./gemini.md) had described that bug as current the
day before. The fix did not touch the doc, so for one commit the file asserted a
resolved bug as live, its quirk-3 heading was false, and **thirteen**
`gemini.js` citations pointed at unrelated code — one of them at the comment
block the fix itself added. Nothing failed.

### Why the suite did not catch it

`src/server/docStatus.test.mjs` is the only guard over `docs/`. Its ten `test(`
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
| distinct **bare source filenames** used in those named citations (`route.js`, `scanWorker.js`, `StudioView.jsx`, …) | **15** |
| named citations carried by those 15 filenames | **111** |

Those numbers are the whole argument:

- **Existence is not the failure mode.** `gemini.js` is 108 lines. Every one of
  the thirteen stale numbers was under 108, so "the file has that many lines"
  passes on all thirteen. A guard that is green on the exact defect that
  prompted it is worse than none — it converts an open question into a false
  assurance.
- **Resolution needs a hand-tuned search path, and it is 111 citations wide,
  not 15.** An earlier revision of this section wrote the 15 as though it were a
  citation count and called resolution "a guess". Both were overstated in one
  direction and understated in the other. The 15 is a count of **distinct bare
  filenames**; between them they carry **111 of the 161** named citations, so
  more than two-thirds of the corpus reaches its file through a resolver the
  prototype had to be told how to build. That is the stronger version of the
  argument and it is why it is corrected here rather than dropped.

  "A guess" is too strong for the individual cases. Of the 15, **four** have
  more than one file of that basename in the tree: `route.js` (34 files),
  `gemini.js` (2 — `src/shared/gemini.js` and `src/shared/engines/gemini.js`, which
  this directory discusses in the same paragraph), `prompts.js` (2) and
  `package.json` (2, the second being `worker/`'s own sub-package manifest,
  which nothing here cites — so **three** are genuine source-code
  ambiguities). The other eleven resolve uniquely today. The cost is not that
  resolution is impossible; it is that a resolver correct today becomes wrong
  silently the first time someone adds a second `firecrawl.js`, and nothing
  tells you.
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
| distinct doc → source-file edges to maintain (vs 202 citations) | **34** — but see the [reconciliation note](#a-second-drift-98df5c8-2026-09-04); an independent re-derivation got 42 |
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

### A second drift: `98df5c8`, 2026-09-04

**It happened again while this section was being revised, to this file, and
this file did not notice.** `98df5c8` ("one scan_runs row per chunk execution")
grew `src/server/workers/scanWorker.js` from 1264 lines to 1726 and moved every
symbol in the SerpAPI reachability chain further down. **Six** citations in the
"Deliberate omissions" section below went stale in one commit:

**The left column is a record of numbers that no longer resolve.** Do not read
it as a citation; every entry in it is wrong at `b35e387` and is printed only
so the drift is measurable. The right column was derived from the `b35e387`
blob and does resolve.

| Was cited as (WRONG at `b35e387`) | Actually at `b35e387` | Symbol grepped |
|---|---|---|
| `scanWorker.js:1110` | `:1506` | `export async function runScanChunk` |
| `scanWorker.js:1164` | `:1610` | `checkpoint = await runSourcingPhase` |
| `scanWorker.js:374` | `:701` | `export async function runSourcingPhase` |
| `scanWorker.js:398` | `:730` | `await sourceQueries(brand, url` |
| `scanWorker.js:129` | `:456` | `export async function sourceUnbrandedQueries` |
| `scanWorker.js:197-205` | `:524-532` | `if (existing.length >= target)` |

Three things follow, and none of them is a guess:

1. **The existence-check finding reproduces on a fresh incident.** All six
   stale numbers are below 1726, so "the file has that many lines" is green on
   all six — **0 of 6**, matching the **0 of 13** measured on `ee5504e`. Two
   independent incidents, the same result.
2. **The tripwire would have fired.** `98df5c8` touched
   `src/server/workers/scanWorker.js` and its two test files
   (`scanChunkLedger.test.mjs`, `scanChunkLedgerLive.test.mjs`) and **not**
   `docs/vendors/README.md` — `git show --name-only 98df5c8`. The
   `docs/vendors/README.md → src/server/workers/scanWorker.js` edge was confirmed
   present in the manifest at `18fa380`. That is a firing outside the
   40-commit window the **7** was measured over, and a true positive on the
   document that recommends the tripwire.

   **One number in the table above is unreconciled and is flagged rather than
   quietly restated.** Re-deriving the edge set with an independently written
   parser gave **42** doc → source-file edges at `18fa380`, not 34. The
   difference is normalisation — which bare filenames get resolved, whether
   `package.json` and sibling `.md` files count as edges — and it was not
   chased down. It does **not** touch the 7-firing replay, which was
   reproduced independently, nor this firing, which was checked directly
   against `98df5c8`'s file list. It does mean **the manifest is somewhere
   between 34 and 42 edges depending on how you define one**, and whoever
   builds the tripwire under its own ledger item has to make that definition
   explicit before the number means anything.
3. **The manual mitigation did not help, because nobody ran it.** This file's
   `Verified at:` said `ef9909b`, and unlike `gemini.md` it carried no
   staleness command to run. A control that fires only when someone
   remembers it did not fire. That is not evidence the control is wrong; it is
   evidence it is insufficient — which is exactly what
   ["the mitigation that is in place today"](#the-mitigation-that-is-in-place-today)
   already claims about itself. This revision adds the missing command to this
   file's header; it does not make the control automatic.

The six citations were **not renumbered**. They were converted to greppable
anchors, per [the note above](#a-note-on-citing-check-secretsmjs), because a
file that moved 462 lines in a day is exactly the case that rule exists for.
`src/shared/scoring/promptGen.js` was converted with them: it is dirty in the
working tree as this is written, by a concurrent task, so any line number taken
from it would be a number that is two things at once.

**That decision was vindicated before this paragraph was finished.** The
"Actually at `b35e387`" column above was derived from the committed blob. Some
minutes later, with a concurrent task's edits sitting uncommitted in the same
file, the six symbols were re-grepped in the **working tree**:

| Symbol | at `b35e387` | in the working tree, same session |
|---|---|---|
| `export async function runScanChunk` | `:1506` | `:1666` |
| `checkpoint = await runSourcingPhase` | `:1610` | `:1770` |
| `export async function runSourcingPhase` | `:701` | `:804` |
| `await sourceQueries(brand, url` | `:730` | `:837` |
| `export async function sourceUnbrandedQueries` | `:456` | `:559` |
| `if (existing.length >= target)` | `:524` | `:627` |

Six correct, freshly derived numbers, stale within one sitting. **All six
anchors stayed unique in both trees.** The line number is the part that rots;
the string is not. That is the whole case for Rule 4 and for the anchor rule,
and it is why this section repoints rather than renumbers.

### The mitigation that is in place today

[`gemini.md`](./gemini.md) carries a **`Verified at:` commit** next to its date
(`gemini.md:9`). **Three of the nine files here carry one**, checked by grepping
`Verified at` across the directory at `b35e387`:

| File | `Verified at` | Added by |
|---|---|---|
| [`gemini.md`](./gemini.md) | `b35e387` | R6.3.2 |
| [`brightdata.md`](./brightdata.md) | `967bda6` | R1.2.9 / R6.3.1, a different task |
| this file | `b35e387` | R6.3.2 |

The other six — `chatgpt.md`, `firecrawl.md`, `gateway-catalog.md`, `mimo.md`,
`perplexity.md`, `suggestqueries.md` — carry a date alone, which does not
identify a tree.

An earlier revision of this paragraph said `gemini.md` was the **only** file
that carried one, "the other eight" a date alone. Both counts were wrong when
written: `brightdata.md` already had one from another task, and **the same diff
that made the claim added a `Verified at` to line 9 of this very file**. It is
recorded rather than quietly corrected because it is a self-refuting sentence
sitting inside the compensating control the decision above leans on — the one
place in this directory where an unchecked count does the most damage.

That one line reduces the check to a single command a reader can run by hand:

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

`src/shared/engines/gsc.js` signs a service-account JWT with node's own `crypto`
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
code** is `src/server/checkSecrets.test.mjs:206`, a **guard asserting it must not
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
them, `src/server/checkSecrets.test.mjs` (`test-gsc.mjs` has no test); and one
non-call, `src/server/health.js:31`, which reports only whether the credential is
*configured*. `src/server/db.js:37,425` is deliberately **not** in that list: those
lines are the `gsc_queries jsonb` column written as `[]`, they match none of the
seven terms, and they surface only under a looser case-insensitive grep for
`gsc` — alongside that column's migration
(`supabase/migrations/001_initial_schema.sql:65,99`) and the test that pins it
empty (`src/shared/scoring/asyncJob.test.mjs:24`). The only write to that column
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
(`src/shared/engines/serp.js:10-17`) selects it when either
`SERP_PROVIDER=serpapi` with a resolvable `SERPAPI_KEY` (`:13`), or
`BRIGHTDATA_API_KEY` is absent and `SERPAPI_KEY` is present (`:15`). On that
branch `fetchPeopleAlsoAsk` (`:312`) hits `https://serpapi.com/search` (`:63`),
and that path is cron-**reachable**. The chain below is given by **greppable
anchor rather than by line**, because `src/server/workers/scanWorker.js` and
`src/shared/scoring/promptGen.js` are both moving — see
["A second drift"](#a-second-drift-98df5c8-2026-09-04) below; every string was
grepped in the `b35e387` blob and each is unique in its file:

`/api/scan/worker` → `runScanChunk` (`scanWorker.js`, grep
`export async function runScanChunk`) → `runSourcingPhase` (grep
`checkpoint = await runSourcingPhase`; defined at
`export async function runSourcingPhase`) → `sourceUnbrandedQueries` (grep
`const sourceQueries = deps.sourceUnbrandedQueries ||`, invoked at
`await sourceQueries(brand, url`; defined at
`export async function sourceUnbrandedQueries`) → `generateUnbrandedPrompts`
(grep `const generate = deps.generateUnbrandedPrompts ||`; in `promptGen.js`,
grep `import { fetchPeopleAlsoAsk, fetchAutocomplete }` and
`deps.fetchPeopleAlsoAsk ||`) → `paaFn` (`promptGen.js`, grep
`Promise.all([paaFn(term), autoFn(term)])`, and `await paaFn(topic)` on the
top-up path).

Reachable is not the same as taken. The same early return described in the
callout below (`scanWorker.js`, grep `if (existing.length >= target)`) sits in
the middle of that chain, so on a domain whose frozen prompt set is already at
target the chain stops at `sourceUnbrandedQueries` and SerpAPI is never called
either.

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
> the stored frozen set when `existing.length >= target` (`scanWorker.js`, grep
> that condition), so `generateUnbrandedPrompts` — autocomplete's only
> non-test caller (`promptGen.js`, grep `deps.fetchPeopleAlsoAsk ||`) — is
> never entered. Under
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
  `src/server/docStatus.test.mjs:103-135` enforces the supersession marker and the
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
describes, against the **committed blob** via `git show HEAD:<file>` per Rule 4
— not against the working tree, which several concurrent tasks had dirty as
this was written. The previous revision checked at `18fa380` and `ef9909b`;
this one re-checked every citation in the file at `b35e387`, which is how the
six drifted `scanWorker.js` numbers and the invented `gemini.md:79` were found.
`docs/RUNBOOK.md` is still absent at `b35e387` and `R6.2.2` is still `todo`;
root `README.md:74` is still `## Setup` and `:142` still `## Database`.*

*Six files are cited by name and greppable string rather than by line —
`scripts/check-secrets.mjs`, `src/middleware.js`, `src/server/operatorPerimeter.js`,
`src/server/operatorPerimeter.test.mjs`, `src/server/workers/scanWorker.js` and
`src/shared/scoring/promptGen.js`. See
[the note above](#a-note-on-citing-check-secretsmjs). Each anchor string was
grepped in the `b35e387` blob and each is unique in its file. The four
`scanWorker.js`/`promptGen.js`-shaped numbers that appear in the
["second drift"](#a-second-drift-98df5c8-2026-09-04) table are a record of
numbers that do **not** resolve, labelled as such, and are not citations.*

*The counts in ["The R6.5.6 drift"](#the-r656-drift-and-the-guard-that-was-not-built)
— 161, 41, 15, 111, 0, 34 and 7 — were produced by running two throwaway
prototypes over this directory as it stood at `18fa380` and over `git log -40`.
The 161, the 41 and the 15 were re-derived from scratch under this revision by
an independently written parser and reproduced **exactly**; the 111 and the
four-of-fifteen ambiguity breakdown are new from the same run. **The 34 did
not reproduce — the same parser gives 42** — and that is flagged in place
rather than papered over. The 7 and the 0-of-13 were not re-run here; they were
reproduced by the verifier of the previous revision. The prototypes were not
kept: they are evidence for a decision, not a shipped guard, and leaving a
parser in the tree that nothing runs would be its own finding.*

*The 0-of-6 and the eighth tripwire firing in
["A second drift"](#a-second-drift-98df5c8-2026-09-04) were derived at
`b35e387` from `git show 98df5c8 --name-only` and from the line counts of
`src/server/workers/scanWorker.js` at `18fa380` (1264) and `b35e387` (1726).
**Neither the tripwire nor any citation guard has been built or has ever run in
CI**; every claim about what one "would have" caught is a replay over git
history, not a test result.*
