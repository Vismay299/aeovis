# Visibility score — why it was wrong, and the fix

**Date:** 2026-07-29
**Branch:** `fix/visibility-score-prompt-set`
**Trigger:** "the score is still coming out to be really shit... 10 different platforms have way better scoring"

---

## 1. What was actually wrong

Three hypotheses were tested against live data. Two were wrong.

**Hypothesis A — the scoring weights are too harsh. WRONG.**
`computeVisibilityScore.js` multiplies `POSITION_WEIGHTS × SENTIMENT_WEIGHTS`, so a
mentioned-but-neutral brand scores 0.5 and a negative one scores 0. That would indeed
crush scores — but the module is **dead code**. Only `probe.js` imports it. The live
headline comes from `enginePipeline.summarizeEngineSlice`.

**Hypothesis B — Bright Data isn't returning answers. WRONG.**
Answer yield on the Italica scan: Perplexity 34/34, AIO 29/34 = **93.3%**.

**Hypothesis C — the prompt set can't measure brand visibility. CORRECT.**

Measured on scan `36a91fbb` (Italica, tiles) against the 17-vendor roster the scan
itself extracted (Kajaria, Somany, Orientbell, NITCO, CERA, H&R Johnson, …):

| | |
|---|---|
| answered unbranded prompts | 56 |
| ...that named **any** vendor | **16 (28.6%)** |
| ...that named nobody at all | **40 (71.4%)** |

The 40 dead prompts are questions like `how to calculate tiles needed for room`,
`how much do vitrified tiles cost per sqft`, `can i install tiles over old tiles`.
They return arithmetic, price ranges, and how-tos. **A brand cannot be mentioned in an
answer that names nobody** — so each one was a guaranteed zero sitting in the
denominator, capping the achievable score at 16/56 before the brand's real visibility
was ever measured.

### Root cause

[promptGen.js:40](../../src/lib/scoring/promptGen.js) instructed the model:

> "You are a market researcher reconstructing the REAL Google Search Console query
> report..."

We were generating **SEO keywords** and scoring them as **AEO probes**. The next rule
told it to mix intent tiers *"roughly evenly"*, so ~70% dead weight was by design.

Search Console queries optimise for *traffic* — informational long-tail is valuable
there. AEO measures *whether a model names you*, which only happens on
recommendation-shaped questions. The two corpora barely overlap.

### Control: is our detection broken too?

No. Of 68 answers, exactly 4 contain the string "italica" and exactly 4 rows are
flagged `mentioned=true` — **zero detection misses**. On 60 unbranded answers Italica
appears 0 times while rivals appear 29 times.

**Italica's score of 0 is correct.** The fix does not and should not inflate it. What
was broken is that we spent 71% of the scan budget on questions that could not move
the number in either direction, then reported a bare `0` with no explanation.

---

## 2. Why other platforms show a better number

Not verifiable from here, but the likely methodology differences, in order:

1. **They include branded queries in the denominator.** Italica is mentioned on 4/4
   branded prompts ("what is Italica"). Including those turns 0% into ~12% instantly.
   It is also tautological — asking about a brand mentions the brand.
2. **They score citation/domain presence**, not just name mentions.
3. **Their prompt sets are almost entirely vendor-selection**, so their denominator is
   all live probes.

(3) is the legitimate one, and is what this change adopts.

---

## 3. The fix

### F3 — `src/lib/scoring/promptQuality.js` (new)

Two deliberately separate signals:

- **Shape** (a priori, from query text): `classifyPromptShape` → `eliciting |
  diagnostic`. Cheap, deterministic, available before spending anything.
- **Elicitation** (a posteriori, from the answer): `countBrandsElicited(brandRows)`
  counts roster vendors the answer actually named, reading `result_brands` /
  `judgeBrandsSymmetric` output that every scan already computes.

Signal 2 is the one competitors don't have — it makes prompt quality an *observed*
property rather than a guess about wording, and `isDudPrompt()` retires a prompt that
has been answered ≥3 times and never named a single vendor.

> An earlier draft guessed at brands by counting capitalised tokens in the answer text.
> Validated against real data it scored a local-shop query at 27 "brands" by counting
> ordinary prose nouns. It was deleted rather than tuned — roster counting is exact and
> free.

### F1 — the denominator (`enginePipeline.summarizeEngineSlice`)

`visibility_pct` is now `visible / elicitingPool`, where the eliciting pool is
answered unbranded prompts whose answer named ≥1 roster vendor. Adds
`eliciting_queries`, `dead_prompts`, `elicitation_rate_pct`. `insufficient_sample` now
judges the eliciting pool, not every answered prompt.

**Fallback:** a slice with no roster data anywhere (older scans, pre-P1.2 fixtures)
keeps the previous denominator. Absence of judging is not evidence that nothing was
elicited.

### F4 — Share of Voice

`share_of_voice_pct` = self mentions / all brand mentions across the eliciting pool,
plus `top_rivals[]`. Presence answers "how often do they name me"; SOV answers "when
they name someone, how often is it me" — the question a brand on a low score actually
needs answered.

### F2 — the generator

Rewritten from "reconstruct the Search Console report" to "you are building a
measurement instrument; a query is only useful if an assistant would answer it by
naming brands", with the real failing prompts as worked negative examples. Plus an
accept gate: we over-generate (`count + 10`), so the trim to `count` now ranks
eliciting prompts first — free leverage. Sets below 75% log loudly rather than failing
(a thin category may genuinely not support 75%).

---

## 4. Verification

| | before | after |
|---|---|---|
| Generated prompt set elicitation | **37%** | **100%** (30/30) |
| Perplexity slice sample adequacy | silently scored 30 prompts | `insufficient_sample: true` (only 3 usable) |
| AIO elicitation rate | not measured | 50% surfaced as `elicitation_rate_pct` |
| Rival attribution | none | Orientbell 25%, MyTyles 16.7%, Kajaria 8.3% |

Live generator run for italicatiles.com produced `top tile brands in india for
flooring`, `compare somany vs kajaria vs orientbell`, `who are the biggest tile
manufacturers in india` — 30/30 eliciting, $0.0000 (free model).

A newly surfaced defect: **Perplexity's elicitation rate on the old set was 10%** (3
usable probes of 30). It was contributing a falsely-confident 0 to the 50/50 headline
index. It is now correctly excluded as an insufficient sample.

602 tests pass (587 existing + 15 new).

---

## 5. Known-open, deliberately not in this change

| Item | Note |
|---|---|
| `scans.competitors` is `null` on every recent scan | The roster IS extracted (952 `result_brands` rows, 17 vendors) but never persisted to the scan column. Separate bug. |
| Existing brands keep their frozen prompt sets | Changing a live set breaks week-over-week comparability, which the prompt-set contract exists to protect. New sets get the new generator; migrating an existing brand needs a version bump. |
| `computeVisibilityScore.js` is dead code | Left in place; deleting it is its own change with its own test churn. |
| Proxy browsers | Will not move the score — yield is already 85–100%. They buy engine *coverage* (ChatGPT/Gemini/Copilot have no SERP-scrape path), cost, and geo control. Sequence after this. |
