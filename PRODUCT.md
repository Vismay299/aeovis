# Product

> <!-- doc-status -->
> **Status: LIVE.** The authority for product scope and positioning. Claims marked `[inferred ...]` inside it are exactly that — not user-confirmed.

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Marketing leaders, founders, and CXOs at B2B companies — initial vertical: healthcare
CXOs in India — who need to know whether AI assistants recommend their brand when
buyers ask. They are not developers; they evaluate tools like analysts and buy like
executives. [inferred from repo strategy docs; not user-confirmed]

## Product Purpose

Perceev is answer-engine intelligence. It probes Google's AI Overview, ChatGPT, and
Perplexity with 30 unbranded buyer prompts per scan and returns a share-of-AI score:
how often the engines mention you, cite you, and which rivals they name instead. A
free 60-second scan with no signup is the hook; the dashboard, rival benchmarking,
sources view, and the agent-driven Content Studio (human-in-the-loop content ops to
close visibility gaps) are the product.

## Positioning

Probe-first and unbranded: prompts never lead with the brand, so the verdict reflects
what buyers actually hear, not what vanity queries return. The share-of-AI score plus
a 5-agent human-in-loop content OS positions Perceev against enterprise tools like
Profound at an Indian mid-market price point. [pricing/vertical inferred from
docs/strategy; not user-confirmed]

## Operating Context

Marketing teams run recurring scans per brand, review verdicts and rival gaps, then
commission agent content runs from Studio → Opportunities. Returning operators land
on the homepage with existing case history.

## Capabilities and Constraints

- Unbranded prompts per scan: 30 by default, now a per-brand tracked-set size
  (`scan_schedules.prompt_target`, 10–100) that only ever grows additively so
  score history stays comparable.
- Engines are configured per deployment (`ENGINES`). Supported: Google AI
  Overview, ChatGPT, Perplexity. Currently enabled in this deployment:
  AI Overview + Perplexity (ChatGPT needs `OPENAI_API_KEY`). Every engine-facing
  surface renders whatever engines actually reported — never a hardcoded count.
- Free scan, no signup. A scan now runs as resumable checkpointed chunks rather
  than one long request, so wall-clock varies with engine count and is no longer
  a fixed ~60 seconds; progress is reported live and a killed run self-resumes.
- Recurring scans: per-brand cadence (72h default / daily / weekly) drives trend
  history; analytics are stored normalized (per prompt, per citation, per day).
- Next.js 14 app; token-driven CSS design system in `src/app/globals.css` consumed by
  landing, dashboard, scan flow, and Studio; shadcn/ui HSL variable compatibility
  must be maintained.
- Playwright tests rely on data-testids: `home-dashboard`, `home-brand-card`,
  `home-run-card`, `preview-sample-cta`, `footer`.

## Brand Commitments

- Name: Perceev; lowercase wordmark "perceev".
- USER-PINNED (binding, 13 October 2026): the website, scans, reports, Studio,
  customer portal and demos share one light design system. No dark/system toggle.
- Taste reference volunteered by user: impeccable.style (premium dark, restrained
  metallic accent, thin large display type). Reference, not a clone target.

## Evidence on Hand

- Sample report with real product data shapes (`src/data/mockData.js`).
- Live demo answer fragments use fictional brands (Brightwave, NorthPeak, Lumen IQ) —
  synthetic, and must stay recognizably synthetic.
- No real customer testimonials, logos, or case studies exist. Do not fabricate.
- The landing page makes no aggregate claim about the product's lifetime work — no
  probe total, no run count, no visitor tally. Two guards in
  `src/lib/landingProbeCounter.test.mjs` hold that line, and neither is a proof of
  honesty. Find them by name, not line number — both moved within a day of being
  cited.
  - `GUARD — the landing surface manufactures no number` scans `src/app/page.js`
    and every component in `src/components/landing/`, and fails on the shapes a
    fabricated total is built from: `Math.random`, a timer, a self-incrementing
    state updater, and a typed total that is five digits or longer or grouped by
    commas. Its own header states the floor rather than implying there is none — a
    small typed figure ("412 probes this week") trips no rule, and it reads source,
    never the rendered DOM.
  - `GUARD — the landing page renders no counter component, and the simulated one
    is gone` is the cheap hop that catches the exact historical shape:
    `ProbeCounter.jsx` must not exist, the page must name no
    `*Counter`/`*Ticker`/`*Tally`/`*Odometer`, and `Probes run` must not survive
    comment-stripping. It is a name check, and a rename evades it.
  `src/lib/landingHonesty.test.mjs` ties the figures that do remain to the sample
  report rather than letting the page type its own.
  - **Correction, 2026-09-09 (R6.3.5).** From `e70d21e` (2026-07-23) until this
    edit, this bullet read *"Probe counter on the landing page is simulated.
    [flagged: replace with real telemetry]"*. **It was born stale**, in the same
    commit. `e70d21e` wrote the flag into this file and rewrote `src/app/page.js` in
    one change, and that rewrite deleted the `lp-stats` strip the counter lived in:
    `git show e70d21e^:src/app/page.js` holds the section, the `<ProbeCounter />`
    element and the `Probes run` label at lines 116–121, and `git show
    e70d21e:src/app/page.js` contains no `ProbeCounter`, no `lp-stat` and no
    `Probes run` at all. "On the landing page" was false on the day it was written.
  - The simulation itself was real, and outlived its render site as orphaned
    source. `src/components/landing/ProbeCounter.jsx` (19 lines) seeded a typed
    37,720 and added a random 1–3 to itself every 2.2 seconds. After `e70d21e` its
    only caller was `DossierLeftPanel.jsx`, which nothing imported — `git grep -l
    DossierLeftPanel 5111219^` returns that file's own definition and two plan docs,
    and nothing else under `src/`. `5111219` (2026-08-16, the design-system port)
    deleted both, 162 lines that no route rendered; the wrapper held a bare
    `<ProbeCounter />` in a `div`, with no strip and no label. `5111219` did not
    delete a stats strip. That had been gone three and a half weeks.
  - So the flag outlived the rendered counter by seven weeks and the dead source by
    three, and for its entire life it pointed readers at repair work that was either
    already done by deletion or never needed. Recorded rather than removed, because
    a flag that rotted silently is the thing this section exists to catch.
  - **The source comments upstream of this correction carry the same error** and are
    out of scope to edit here: the R2.10.2 note in `src/app/page.js` (`git grep -n
    "THE PROBE COUNTER, AND WHY THERE ISN'T ONE" src/app/page.js`) says "that module
    and the strip around it were deleted on 2026-08-16 in `5111219`", and the header
    of `src/lib/landingProbeCounter.test.mjs` says the module went "along with the
    whole stats strip". Only the module did. A first draft of this correction
    repeated that claim because it was copied forward from those comments on trust
    instead of re-derived from `git show` — which is precisely the failure this
    bullet is here to stop. A follow-up should correct both comments; until then,
    trust the two `git show` commands above over either.
  - No real counter is planned; there is no aggregate figure in this deployment
    worth quoting. The standing condition on one ever returning is written at the
    surface it governs — `git grep -n "THE PROBE COUNTER, AND WHY THERE ISN'T ONE"
    src/app/page.js` — and is that it must read a real count query and render an em
    dash with a state chip when that query cannot answer: never a zero, which is a
    reading, and never a seed, which is a lie.

## Product Principles

1. The verdict is the product: every surface leads to or from the share-of-AI score.
2. Show the evidence verbatim — real answers, marked up — never abstract claims.
3. Unbranded or it doesn't count: neutrality of the probe is the trust story.
4. Executive-legible: a CXO should grasp any screen in seconds without training.
