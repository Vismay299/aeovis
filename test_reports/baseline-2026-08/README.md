# Baseline corpus — August 2026

> <!-- doc-status -->
> **Status: LIVE.** The protocol is live and **the corpus is populated**: three
> brands archived on 2026-08-30 — `italicatiles.com`, `snitch.com`,
> `zouk.co.in` — each with 68 raw and 68 normalized per-prompt results and its
> own `prompt_set_id`. Frozen: do not regenerate, a baseline that moves is not
> a baseline.

> **The three archive files are no longer in the working tree.** They were removed
> ahead of making the repository public, because they hold raw scan results for
> real third-party brands. They are unchanged in git history: restore any of them
> with `git show 02a1d55d:test_reports/baseline-2026-08/<file>.json`. Keep restored
> copies out of commits. Everything below describes the corpus as archived.

## Why this exists

The R0–R6 rebuild changes how scores are computed. Without a frozen record of
what the pipeline produced *before*, "the numbers improved" is an opinion, and
so is "nothing regressed". This directory is the before-picture that makes those
claims checkable.

It is a **before** corpus, not a golden one. Nothing here is asserted to be
correct — several of the numbers in it are expected to be wrong, which is the
point. Its job is to make a change visible, not to bless a value.

## Current state — read this first

**Three brands are archived**, captured 2026-08-30 from the live database:

| File | Brand | Scan | Raw | Normalized | visibility_pct |
|---|---|---|---|---|---|
| `italicatiles.com.json` | Italica | `f1ef17a5` | 68 | 68 | 0% |
| `snitch.com.json` | Snitch | `224d4e35` | 68 | 68 | 6.7% |
| `zouk.co.in.json` | zouk | `00f6c4d2` | 68 | 68 | 29.6% |

The scans themselves date from 22–30 July 2026; nothing was re-run to produce
this corpus, which is the point — a baseline captured from scans run under
observation is not a baseline of production behaviour.

One caveat worth carrying forward: these were archived while the LLM gateway
was returning 402, so Italica's 0% and the null `share_of_ai_pct` on all three
record what the pipeline produced *with a degraded LLM*. That is a faithful
before-picture, not a clean one, and a later comparison must not read those
zeros as a scoring regression it fixed.

`archive-reference-scan.mjs` takes the scan's **URL host**, not the brand name
its own `--list` prints — `zouk.co.in`, not `zouk`.

## Capturing it

Three brands, chosen for contrast rather than convenience — ideally one with a
healthy prompt set, one with a thin one, and one with a known data-source
problem, so the corpus covers the failure shapes and not just the happy path.

```bash
npm run baseline:archive -- --list                 # what scans exist
npm run baseline:archive -- <brand-key>            # archive the latest
npm run baseline:archive -- <brand-key> --scan-id <id>
```

The script (`scripts/archive-reference-scan.mjs`) is **read-only**. It never
starts a scan: a corpus captured from scans run under observation is a baseline
of observed behaviour, not of production behaviour.

It refuses rather than degrades in three cases, each deliberate:

- Supabase unconfigured — it cannot fabricate a baseline.
- A scan with no per-prompt results — a summary-only archive cannot be compared
  prompt-by-prompt, which is the only comparison worth having.
- An output file that already exists — a baseline that moves is not a baseline.

## What each file holds

One JSON file per brand, `<brand-key>.json`:

| Field | Why it is frozen |
|---|---|
| `prompt_set_id`, `prompt_set_hash` | So a score change cannot be explained away by the questions having changed. This is the single most important field here. |
| `results` | Raw per-prompt results as persisted — not a summary. |
| `prompt_results` | The normalized per-prompt×engine rows, which carry per-engine detail `results` does not. |
| `headline` | The published metrics, so a regression is visible without re-deriving anything. |
| `competitors` | The roster the scan actually used. |
| `roster_source`, `prompt_source` | Provenance added by R0.3.3/R0.3.4. Expect `null` on genuinely pre-rebuild scans — that null is itself the baseline fact. |

## Rules

1. **Frozen.** Never regenerate a file to make a comparison look better. If a
   baseline is wrong, add a note beside it saying why; do not overwrite it.
2. **Committed.** A baseline living on one laptop is not a baseline.
3. **Cited by id.** Any claim of the form "improved against baseline" names the
   `scan_id` and `prompt_set_id` it compared against.
4. **An empty corpus is an empty corpus.** It is never evidence of no
   regression.
