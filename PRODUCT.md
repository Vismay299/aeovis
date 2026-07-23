# Product

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

- 30 unbranded prompts per scan; engines: Google AI Overview, ChatGPT, Perplexity.
- Free scan, no signup, ~60 seconds to verdict.
- Next.js 14 app; token-driven CSS design system in `src/app/globals.css` consumed by
  landing, dashboard, scan flow, and Studio; shadcn/ui HSL variable compatibility
  must be maintained.
- Playwright tests rely on data-testids: `home-dashboard`, `home-brand-card`,
  `home-run-card`, `preview-sample-cta`, `footer`.

## Brand Commitments

- Name: Perceev; lowercase wordmark "perceev".
- USER-PINNED (binding): the interface is dark mode.
- Taste reference volunteered by user: impeccable.style (premium dark, restrained
  metallic accent, thin large display type). Reference, not a clone target.

## Evidence on Hand

- Sample report with real product data shapes (`src/data/mockData.js`).
- Live demo answer fragments use fictional brands (Brightwave, NorthPeak, Lumen IQ) —
  synthetic, and must stay recognizably synthetic.
- No real customer testimonials, logos, or case studies exist. Do not fabricate.
- Probe counter on the landing page is simulated. [flagged: replace with real telemetry]

## Product Principles

1. The verdict is the product: every surface leads to or from the share-of-AI score.
2. Show the evidence verbatim — real answers, marked up — never abstract claims.
3. Unbranded or it doesn't count: neutrality of the probe is the trust story.
4. Executive-legible: a CXO should grasp any screen in seconds without training.
