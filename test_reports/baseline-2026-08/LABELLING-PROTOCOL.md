# Calibration labelling protocol

> <!-- doc-status -->
> **Status: LIVE.** The protocol is live. **No labels have been produced yet** —
> see *Current state*. An absent label set is not a passing one.

## What these labels are for

They are the ground truth the R2.5 judge is calibrated against. That makes their
integrity more important than the judge's: a quietly-wrong label set makes a
judge look accurate against nothing, which is the same failure this rebuild
exists to close, one level up.

Target: **60–100 labelled answers**, drawn from the persisted `prompt_results`
rows (674+ at the time of the audit).

## Current state

**No labels have been produced.** Rebuild task **R0.4.2 is BLOCKED**: labelling
requires reading real persisted answers out of the production database, and no
credentials exist in the environment where R0 ran. Its dependency **R0.4.1**
(the baseline corpus) is blocked for the same reason.

What *does* exist, and is exercised by tests:

- the fixture schema and its validator — `src/lib/scoring/calibrationFixture.js`
- 15 tests over that validator — `src/lib/scoring/calibrationFixture.test.mjs`

So when labelling happens, a malformed set fails immediately rather than
silently calibrating the judge against nonsense.

## Sampling

Sample **stratified, not random**. A random sample of real answers is dominated
by easy negatives, and a judge that always answers "not mentioned" would score
well on it. Aim for roughly:

| Stratum | Share | Why |
|---|---|---|
| Clear mentions | ~30% | The base case. |
| Clear non-mentions | ~30% | The base case. |
| Brand named only in a citation URL, not in prose | ~15% | The disagreement that matters most: is a cited domain a mention? |
| Near-miss names (`Italica` vs `Italica Ceramics` vs `italicatiles.com`) | ~15% | Where alias matching breaks. |
| Answers naming many brands in a list | ~10% | Where position labelling is hardest. |

The validator **rejects** a set that is less than 15% or more than 85%
`mentioned`, precisely because a one-sided set cannot distinguish a good judge
from a constant one.

## Labelling each answer

One row per (answer, roster brand). Read the whole answer before labelling.

| Field | Rule |
|---|---|
| `mentioned` | Explicit `true`/`false`. **Never leave it out.** A missing label is not a negative — the validator refuses the row. |
| `position` | 1-based order of first appearance among brands, integer, **only** when `mentioned` is true. `null` otherwise. |
| `sentiment` | `-1` / `0` / `1`, or `null` if the answer expresses none. Neutral mention is `0`; absence of an opinion is `null`. These are different. |
| `uncertain` | `true` when you genuinely could not decide. |
| `note` | **Required** when `uncertain` — say what made it hard. Without it, a later reader cannot tell a hard case from a careless one. |
| `labelled_by`, `labelled_at` | Required. An unattributed label cannot be audited. |

### Conventions, decided once so labellers agree

1. **A citation-only appearance is a mention** — the brand's domain in the
   sources list counts, and the answer text does not have to name it. Set
   `uncertain: true` with a note if the citation is incidental.
2. **A brand named as a negative example is still `mentioned: true`**, with
   `sentiment: -1`. Visibility is visibility.
3. **Alias forms count**: `Italica`, `Italica Ceramics` and `italicatiles.com`
   are the same brand.
4. **A truncated or error answer is not labelled at all.** Do not label it as a
   non-mention — drop the row. A failed probe is not evidence of absence, and
   this is the single most damaging labelling mistake available.
5. **When two labellers disagree**, keep both rows in a scratch file, decide,
   and add the resolution here as a new convention. The protocol is the memory.

## File format

`test_reports/baseline-2026-08/<name>.labels.json`:

```json
{
  "schema_version": 1,
  "protocol": "test_reports/baseline-2026-08/LABELLING-PROTOCOL.md",
  "labels": [
    {
      "result_id": "…",
      "prompt_text": "best vitrified tile brands in india",
      "answer_text": "…",
      "brand": "Italica",
      "mentioned": true,
      "position": 3,
      "sentiment": 0,
      "uncertain": false,
      "labelled_by": "…",
      "labelled_at": "2026-08-29T10:00:00.000Z"
    }
  ]
}
```

Validate before committing:

```js
import { validateCalibrationFixture } from "../../src/lib/scoring/calibrationFixture.js";
```

`src/lib/scoring/calibrationFixture.test.mjs` carries a guard that fails as soon
as the first `*.labels.json` lands, so that a test validating the real fixture
is written at the same time.
