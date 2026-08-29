# Baseline corpus — August 2026

> <!-- doc-status -->
> **Status: LIVE.** The protocol is live. **The corpus itself is EMPTY** — see
> *Current state* below. Do not read an absent baseline as a passing one.

## Why this exists

The R0–R6 rebuild changes how scores are computed. Without a frozen record of
what the pipeline produced *before*, "the numbers improved" is an opinion, and
so is "nothing regressed". This directory is the before-picture that makes those
claims checkable.

It is a **before** corpus, not a golden one. Nothing here is asserted to be
correct — several of the numbers in it are expected to be wrong, which is the
point. Its job is to make a change visible, not to bless a value.

## Current state — read this first

**Zero brands are archived.** The corpus is empty.

Capturing it requires live Supabase credentials and real persisted scans,
neither of which exists in the environment where the rebuild's R0 phase ran.
Rebuild task **R0.4.1 is BLOCKED** on exactly this, and the accompanying
labelling task **R0.4.2** is blocked behind it.

Nothing downstream may treat this directory as satisfied. In particular, a
scoring change that claims "no regression against baseline" while this directory
is empty is claiming a comparison it did not make.

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
